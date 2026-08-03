import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { bus } from './events.js';
import type { AppDef, ProcessDef } from './config.js';
import type { Store } from './db.js';

export type Mode = 'start' | 'dev';
export type ProcStatus = 'running' | 'stopped' | 'crashed';

interface RuntimeEntry {
  /** Present for processes spawned by THIS daemon; absent for adopted ones. */
  child?: ChildProcess;
  pid: number;
  mode: Mode;
  startedAt: number;
  stopRequested: boolean;
  restartCount: number;
  exited: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  /** Process survived a daemon restart and was re-attached (no child handle —
   * exit is detected by the pid watchdog, exit codes are unknown). */
  adopted?: boolean;
  appDef: AppDef;
  procDef: ProcessDef;
}

export interface ProcState {
  status: ProcStatus;
  pid?: number;
  mode?: Mode;
  startedAt?: number;
  lastExit?: { code: number | null; signal: string | null; at: number; summary?: string };
}

const procKey = (app: string, proc: string) => `${app}/${proc}`;

// CSI sequences (colors, cursor movement) + other escapes
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;
export const stripAnsiCodes = (s: string) => s.replace(ANSI_RE, '');

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STAMPED_RE = /^\[\d{4}-\d{2}-\d{2}T/;

const ERROR_LINE_RE = /error|exception|fatal|panic|unhandled|EADDRINUSE|address already in use|failed/i;

/** Ports a process is declared to bind: explicit list + health port + health URL port. */
export function declaredPorts(def: ProcessDef): number[] {
  const ports = new Set<number>(def.ports);
  if (def.healthPort) ports.add(def.healthPort);
  if (def.healthUrl) {
    try {
      const u = new URL(def.healthUrl);
      if (u.port) ports.add(Number(u.port));
    } catch { /* ignore malformed URL */ }
  }
  return [...ports];
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1', timeout: 400 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function portHolder(port: number): Promise<{ pid: number; pgid: number; command: string } | null> {
  try {
    const { stdout } = await execFileP('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']);
    const pid = Number(stdout.trim().split('\n')[0]);
    if (!pid) return null;
    const { stdout: psOut } = await execFileP('ps', ['-o', 'pgid=,command=', '-p', String(pid)]);
    const m = psOut.trim().match(/^(\d+)\s+(.*)$/);
    return { pid, pgid: m ? Number(m[1]) : pid, command: m ? m[2].slice(0, 120) : '?' };
  } catch {
    return null;
  }
}

export class ProcessManager {
  private runtime = new Map<string, RuntimeEntry>();
  private lastExit = new Map<string, { code: number | null; signal: string | null; at: number; summary?: string }>();
  /** Environment captured from the configured envShell, injected into every managed process. */
  baseEnv: Record<string, string> = {};

  constructor(private logsDir: string, private store: Store) {}

  /** Last plausible error line from the log tail — shown as the crash summary. */
  private extractErrorSummary(app: string, proc: string): string | undefined {
    try {
      const tail = stripAnsiCodes(this.readLogs(app, proc, 30))
        .split('\n')
        .map((l) => l.replace(/^\[[^\]]+\]\s?/, ''))
        .filter((l) => l.trim() && !l.startsWith('--- [controller]'));
      const errLine = [...tail].reverse().find((l) => ERROR_LINE_RE.test(l));
      const line = errLine ?? tail[tail.length - 1];
      return line ? line.trim().slice(0, 200) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Kill a process group holding a port and wait for the port to free up. */
  private async killPortHolder(
    holder: { pid: number; pgid: number }, port: number
  ): Promise<boolean> {
    try { process.kill(-holder.pgid, 'SIGTERM'); } catch { try { process.kill(holder.pid, 'SIGTERM'); } catch { /* gone */ } }
    for (let i = 0; i < 12 && (await isPortInUse(port)); i++) await sleep(500);
    if (await isPortInUse(port)) {
      try { process.kill(-holder.pgid, 'SIGKILL'); } catch { try { process.kill(holder.pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(500);
    }
    return !(await isPortInUse(port));
  }

  /**
   * Group leaders (pgid = spawn pid) of processes this daemon currently manages,
   * mapped to their "app/proc" key. Anything in here is a live SIBLING, never an
   * orphan — no reclaim/sweep logic may touch these groups.
   */
  private managedGroups(): Map<number, string> {
    const map = new Map<number, string>();
    for (const [key, entry] of this.runtime) {
      if (entry.pid > 0 && !entry.exited) map.set(entry.pid, key);
    }
    return map;
  }

  /**
   * True if a command line's paths plausibly belong to THIS process rather than a
   * sibling sharing (part of) the same cwd. Two disambiguators:
   *  - a path under a sibling's MORE SPECIFIC cwd belongs to that sibling (e.g. a
   *    vite dev server under <cwd>/app-vue while this proc runs from <cwd>);
   *  - a dotnet build output <cwd>/<project>/bin/(Debug|Release)/… is ours only if
   *    <project> is referenced by our own command/devCommand (src/MonoPam.App vs a
   *    sibling's src/MonoPam.Gateway binary under the same monorepo root).
   * Unknown → false is the safe direction: the process is left alone, and a real
   * port conflict still surfaces as an explicit error instead of a silent kill.
   */
  private ownsCommandPath(cmdline: string, appDef: AppDef, procDef: ProcessDef, procCwd: string): boolean {
    for (const sib of appDef.processes) {
      if (sib.name === procDef.name) continue;
      const sibCwd = sib.cwd ? path.resolve(appDef.cwd, sib.cwd) : appDef.cwd;
      if (sibCwd !== procCwd && sibCwd.startsWith(`${procCwd}/`) && cmdline.includes(`${sibCwd}/`)) return false;
    }
    const m = cmdline.match(new RegExp(`${escapeRe(procCwd)}/(?:(.+?)/)?bin/(?:Debug|Release)/`));
    if (!m) return true; // not a build output — plain path under our own cwd
    const relProject = m[1];
    if (!relProject) return true; // procCwd itself is the project
    const own = `${procDef.command}\n${procDef.devCommand ?? ''}`;
    return own.includes(relProject) || own.includes(path.basename(relProject));
  }

  /**
   * Kill leftover processes of previous generations of THIS process: anything running
   * the process's own build output (<procCwd>/…/bin/(Debug|Release)/…), in either
   * dotnet shape — apphost (argv0 is the built binary) or dll host (argv0 is `dotnet`,
   * the bin path only appears in the args). Catches zombies that are still BOOTING
   * (not yet listening), which a port check cannot see — they would otherwise win the
   * bind race against the new instance. Vue/node dev servers never match (no
   * bin/Debug|Release path); they bind immediately and are handled by port reclaim.
   * NEVER touched: currently-managed groups (live siblings, e.g. monorepo dotnet
   * projects under one root) and unmanaged processes running a DIFFERENT project's
   * binary under the shared cwd (e.g. a sibling started by hand in a terminal).
   */
  private async killBinOrphans(
    procCwd: string, key: string, managed: Map<number, string>, appDef: AppDef, procDef: ProcessDef
  ): Promise<void> {
    try {
      const { stdout } = await execFileP('ps', ['-axo', 'pid=,pgid=,args=']);
      const binRe = new RegExp(`${escapeRe(procCwd)}/(?:.+?/)?bin/(?:Debug|Release)/`);
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const args = m[3];
        const exe = args.split(' ')[0];
        const isApphost = exe.startsWith(`${procCwd}/`) && binRe.test(exe);
        const isDllHost = !isApphost && /(^|\/)(dotnet|mono)$/.test(exe) && binRe.test(args);
        if (!isApphost && !isDllHost) continue;
        const pid = Number(m[1]);
        const pgid = Number(m[2]);
        if (pid === process.pid) continue;
        const owner = managed.get(pgid) ?? managed.get(pid);
        if (owner) {
          if (owner !== key) this.appendLog(key, `--- [controller] pid ${pid} belongs to managed sibling '${owner}' — leaving it alone`);
          continue;
        }
        if (!this.ownsCommandPath(args, appDef, procDef, procCwd)) {
          this.appendLog(key, `--- [controller] pid ${pid} runs another project's binary under the shared cwd (not '${key}') — leaving it alone`);
          continue;
        }
        this.appendLog(key, `--- [controller] killing orphaned previous-generation process ${pid} (${args.slice(0, 120)})`);
        try { process.kill(-pgid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    } catch {
      // best effort — ps may be unavailable
    }
  }

  /**
   * Fail fast if a declared port is already bound. If the holder is an orphan of a
   * previous run of THIS process — matched by recorded pid/pgid, OR by its command
   * path living under the process's working directory (an unrecorded orphan, e.g.
   * one that survived a daemon crash) — reclaim it and continue.
   * With takeover=true, a FOREIGN holder (started outside the controller) is also
   * stopped so the process can run under controller management instead.
   */
  private async ensurePortsFree(
    appDef: AppDef, procDef: ProcessDef, key: string, takeover: boolean, session: string, source: string
  ): Promise<void> {
    const app = appDef.name;
    const recorded = this.store.listRunning().find((r) => r.app === app && r.proc === procDef.name);
    const procCwd = procDef.cwd ? path.resolve(appDef.cwd, procDef.cwd) : appDef.cwd;
    const managed = this.managedGroups();
    // Sweep booting zombies of previous generations before the port checks.
    await this.killBinOrphans(procCwd, key, managed, appDef, procDef);
    for (const port of declaredPorts(procDef)) {
      if (!(await isPortInUse(port))) continue;
      const holder = await portHolder(port);
      // A currently-managed sibling is never an orphan and never a takeover target:
      // killing it here is exactly the "start A kills B" bug. Surface a config error.
      const ownedBy = holder ? managed.get(holder.pgid) ?? managed.get(holder.pid) : undefined;
      if (ownedBy && ownedBy !== key) {
        throw new Error(
          `Port ${port} is bound by managed process '${ownedBy}' — refusing to touch it. ` +
          `If both processes really declare port ${port}, fix the port lists; otherwise stop '${ownedBy}' first.`
        );
      }
      const isRecordedOrphan = holder && recorded?.pid && (holder.pid === recorded.pid || holder.pgid === recorded.pid);
      // Unrecorded orphan: the holder's command runs a binary/script inside this
      // process's own working directory — clearly a leftover of this process. A path
      // under a shared cwd that belongs to a DIFFERENT project (sibling started by
      // hand, vite server under <cwd>/app-vue, …) is NOT ours: fall through to the
      // explicit foreign-holder error instead of silently killing it.
      const isPathOrphan = holder && !isRecordedOrphan && holder.command.includes(`${procCwd}/`)
        && this.ownsCommandPath(holder.command, appDef, procDef, procCwd);
      if (isRecordedOrphan || isPathOrphan) {
        this.appendLog(key, `--- [controller] port ${port} held by orphaned previous run (pid ${holder!.pid}${isPathOrphan ? ', matched by path' : ''}) — reclaiming`);
        if (await this.killPortHolder(holder!, port)) continue;
      } else if (holder && takeover) {
        this.appendLog(key, `--- [controller] taking over port ${port}: stopping pid ${holder.pid} (${holder.command})`);
        this.store.audit({
          session, source: source as 'mcp' | 'ui' | 'system', action: 'takeover',
          app, proc: procDef.name, detail: `stopped pid ${holder.pid} (${holder.command}) holding port ${port}`,
          result: 'taken over',
        });
        if (await this.killPortHolder(holder, port)) continue;
        throw new Error(`Takeover of port ${port} failed: pid ${holder.pid} (${holder.command}) survived SIGTERM/SIGKILL (insufficient permissions?).`);
      }
      const who = holder ? `pid ${holder.pid} (${holder.command})` : 'an unknown process';
      throw new Error(
        `Port ${port} is already in use by ${who} — it was not started by the controller. ` +
        `Retry with takeover=true to stop it and run '${key}' under controller management instead, ` +
        `or remove ${port} from the port list if it's wrong.`
      );
    }
  }

  private logFile(app: string, proc: string): string {
    return path.join(this.logsDir, `${app}__${proc}.log`.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }

  private stopped = new Set<string>();

  getState(app: string, proc: string): ProcState {
    const key = procKey(app, proc);
    const rt = this.runtime.get(key);
    if (rt && rt.pid > 0 && !rt.exited) {
      return { status: 'running', pid: rt.pid, mode: rt.mode, startedAt: rt.startedAt };
    }
    const exit = this.lastExit.get(key);
    if (exit && !this.stopped.has(key)) {
      return { status: 'crashed', lastExit: exit };
    }
    return { status: 'stopped', lastExit: exit };
  }

  isRunning(app: string, proc: string): boolean {
    return this.getState(app, proc).status === 'running';
  }

  async start(
    appDef: AppDef, procDef: ProcessDef, mode: Mode,
    session: string, source: 'mcp' | 'ui' | 'system', takeover = false
  ): Promise<ProcState> {
    const key = procKey(appDef.name, procDef.name);
    if (this.isRunning(appDef.name, procDef.name)) {
      return this.getState(appDef.name, procDef.name);
    }
    const command = mode === 'dev' ? procDef.devCommand : procDef.command;
    if (!command) {
      throw new Error(`Process '${key}' has no ${mode === 'dev' ? 'devCommand' : 'command'} defined`);
    }
    const cwd = procDef.cwd ? path.resolve(appDef.cwd, procDef.cwd) : appDef.cwd;
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    await this.ensurePortsFree(appDef, procDef, key, takeover, session, source);

    // Children write their output STRAIGHT to the log file (own fd, O_APPEND) instead
    // of a pipe into the daemon. This is what lets them survive a daemon restart: a
    // pipe's read end dies with the daemon (SIGPIPE / blocked writes), a file doesn't.
    // The daemon tails the file to feed the live UI, triggers, and wait_for_log.
    // Attach the tail BEFORE the first marker line so it becomes the single emitter.
    this.attachTail(key);
    this.appendLog(key, `--- [controller] starting (mode=${mode}, by=${session}): ${command}`);
    const logFd = fs.openSync(this.logFile(appDef.name, procDef.name), 'a');
    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        // Layering: daemon env < captured shell env < app-wide env < active environment < process env
        env: {
          ...process.env,
          ...this.baseEnv,
          ...appDef.env,
          ...(appDef.activeEnvironment ? appDef.environments[appDef.activeEnvironment] ?? {} : {}),
          ...procDef.env,
          FORCE_COLOR: '1',
          CLICOLOR_FORCE: '1',
        },
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      fs.closeSync(logFd); // the child holds its own duplicate
    }

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => (resolveExit = r));
    const entry: RuntimeEntry = {
      child,
      pid: child.pid ?? -1,
      mode,
      startedAt: Date.now(),
      stopRequested: false,
      restartCount: this.runtime.get(key)?.restartCount ?? 0,
      exited: false,
      exitPromise,
      resolveExit,
      appDef,
      procDef,
    };
    this.runtime.set(key, entry);
    this.stopped.delete(key);
    this.store.setRunning(appDef.name, procDef.name, mode, child.pid);

    child.on('error', (err) => {
      this.appendLog(key, `--- [controller] spawn error: ${err.message}`);
    });

    child.on('exit', (code, signal) => this.handleExit(key, entry, code, signal ?? null));

    // Fail-fast window: give the process up to 400ms to die instantly (bad command,
    // missing dir, port bind crash) so the caller sees 'crashed' instead of a false
    // 'running'. Racing against the exit means an instant failure resolves immediately.
    await Promise.race([exitPromise, sleep(400)]);
    bus.emit('state');
    return this.getState(appDef.name, procDef.name);
  }

  /**
   * Re-attach a process that survived a daemon restart. No child handle exists, so
   * exit codes are unknowable — the pid watchdog detects death (≤1s) and drives the
   * same crash pipeline (audit, notification, auto-restart) as a normal exit.
   */
  adopt(appDef: AppDef, procDef: ProcessDef, mode: Mode, pid: number, startedAt: number): ProcState {
    const key = procKey(appDef.name, procDef.name);
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => (resolveExit = r));
    const entry: RuntimeEntry = {
      pid,
      mode,
      startedAt,
      stopRequested: false,
      restartCount: 0,
      exited: false,
      exitPromise,
      resolveExit,
      adopted: true,
      appDef,
      procDef,
    };
    this.runtime.set(key, entry);
    this.stopped.delete(key);
    this.store.setRunning(appDef.name, procDef.name, mode, pid);
    this.attachTail(key);
    this.appendLog(key, `--- [controller] adopted running process (pid ${pid}) after daemon restart`);
    this.ensureWatchdog();
    bus.emit('state');
    return this.getState(appDef.name, procDef.name);
  }

  /** Detects death of adopted processes (no child handle → no 'exit' event). */
  private watchdog?: NodeJS.Timeout;

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      for (const [key, e] of this.runtime) {
        if (!e.adopted || e.exited) continue;
        if (!isPidAlive(e.pid)) this.handleExit(key, e, null, null, true);
      }
    }, 1000);
  }

  /** Common exit pipeline for spawned ('exit' event) and adopted (watchdog) processes. */
  private handleExit(
    key: string, entry: RuntimeEntry, code: number | null, signal: string | null, adopted = false
  ): void {
    if (entry.exited) return;
    entry.exited = true;
    const { appDef, procDef, mode } = entry;
    const exit: { code: number | null; signal: string | null; at: number; summary?: string } = {
      code, signal, at: Date.now(),
    };
    if (!entry.stopRequested) {
      exit.summary = this.extractErrorSummary(appDef.name, procDef.name);
    }
    this.lastExit.set(key, exit);
    this.appendLog(
      key,
      adopted
        ? `--- [controller] exited (adopted process — exit code unknown)`
        : `--- [controller] exited (code=${code}, signal=${signal ?? 'none'})`
    );
    const wasRequested = entry.stopRequested;
    if (wasRequested) this.stopped.add(key);
    entry.resolveExit();
    bus.emit('state');
    // Keep tailing briefly to flush the process's final log lines, then detach —
    // unless an auto-restart already brought it back.
    setTimeout(() => {
      const cur = this.runtime.get(key);
      if (!cur || cur.exited) this.detachTail(key);
    }, 1500);

    if (!wasRequested) {
      this.store.audit({
        session: 'system',
        source: 'system',
        action: 'crash-detected',
        app: appDef.name,
        proc: procDef.name,
        detail: adopted ? 'process died (adopted — exit code unknown)' : `exit code=${code} signal=${signal ?? 'none'}`,
        result: 'crashed',
      });
      bus.emit('crash', { app: appDef.name, proc: procDef.name, code, summary: exit.summary });
      if (procDef.autoRestart && entry.restartCount < 3) {
        const delay = 2000 * (entry.restartCount + 1);
        this.appendLog(key, `--- [controller] auto-restarting in ${delay}ms (attempt ${entry.restartCount + 1}/3)`);
        setTimeout(() => {
          if (this.isRunning(appDef.name, procDef.name)) return;
          this.start(appDef, procDef, mode, 'system', 'system')
            .then(() => {
              const rt = this.runtime.get(key);
              if (rt) rt.restartCount = entry.restartCount + 1;
            })
            .catch((err) => this.appendLog(key, `--- [controller] auto-restart failed: ${err.message}`));
        }, delay);
      }
    }
  }

  /**
   * Run a one-shot command (e.g. an app's `prepare` build) to completion in the app
   * cwd with the same env layering as managed processes. Output goes to the log of
   * pseudo-process '<app>/<name>' (viewable via app_logs). Throws on non-zero exit
   * or timeout (the whole process group is killed on timeout).
   */
  async runToCompletion(appDef: AppDef, name: string, command: string, timeoutMs: number): Promise<void> {
    const key = procKey(appDef.name, name);
    this.appendLog(key, `--- [controller] running (one-shot): ${command}`);
    const child = spawn(command, {
      shell: true,
      cwd: appDef.cwd,
      env: {
        ...process.env,
        ...this.baseEnv,
        ...appDef.env,
        ...(appDef.activeEnvironment ? appDef.environments[appDef.activeEnvironment] ?? {} : {}),
        FORCE_COLOR: '1',
        CLICOLOR_FORCE: '1',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => this.appendLog(key, line));
    }
    const exit = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        this.appendLog(key, `--- [controller] one-shot timed out after ${timeoutMs}ms — killing`);
        const pid = child.pid;
        if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
        resolve({ code: null, timedOut: true });
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        this.appendLog(key, `--- [controller] one-shot spawn error: ${err.message}`);
        resolve({ code: -1, timedOut: false });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut: false });
      });
    });
    this.appendLog(key, `--- [controller] one-shot finished (code=${exit.code}${exit.timedOut ? ', timed out' : ''})`);
    if (exit.timedOut) throw new Error(`'${name}' command timed out after ${Math.round(timeoutMs / 1000)}s`);
    if (exit.code !== 0) throw new Error(`'${name}' command failed with exit code ${exit.code} (see logs of '${key}')`);
  }

  async stop(app: string, proc: string, gracefulMs = 6000, clearRestore = true): Promise<ProcState> {
    const key = procKey(app, proc);
    // Deliberate stops remove the process from boot-restore state; the daemon's own
    // shutdown (stopAll) keeps it so processes come back after a daemon restart.
    if (clearRestore) this.store.clearRunning(app, proc);
    const entry = this.runtime.get(key);
    if (!entry || !this.isRunning(app, proc)) {
      this.stopped.add(key);
      return this.getState(app, proc);
    }
    entry.stopRequested = true;
    const pid = entry.pid;
    this.appendLog(key, `--- [controller] stopping (SIGTERM to process group ${pid})`);
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Adopted processes have no 'exit' event — the watchdog resolves exitPromise (≤1s lag).
    const killed = await Promise.race([
      entry.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), gracefulMs)),
    ]);
    if (!killed) {
      this.appendLog(key, `--- [controller] escalating to SIGKILL`);
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await Promise.race([entry.exitPromise, new Promise((r) => setTimeout(r, 3000))]);
    }
    bus.emit('state');
    return this.getState(app, proc);
  }

  async stopAll(): Promise<void> {
    const keys = [...this.runtime.keys()];
    await Promise.all(
      keys.map((key) => {
        const [app, proc] = key.split('/');
        return this.stop(app, proc, 6000, false);
      })
    );
    this.detachAll();
  }

  /**
   * Daemon shutdown WITHOUT stopping children (the default): flush our side of the
   * logs and stop timers. Children write to their own log fds, so they keep running
   * unaffected and are adopted by the next daemon via the persisted restore state.
   * Returns how many processes were left running.
   */
  detachAll(): number {
    let left = 0;
    for (const [key, e] of this.runtime) {
      if (e.exited) continue;
      left++;
      this.appendLog(key, `--- [controller] daemon stopping — leaving process running (pid ${e.pid}); it will be adopted on the next daemon start`);
    }
    for (const t of this.tailers.values()) clearInterval(t.timer);
    this.tailers.clear();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    for (const ws of this.logStreams.values()) {
      try { ws.end(); } catch { /* already closed */ }
    }
    this.logStreams.clear();
    return left;
  }

  // ---------------------------------------------------------------------------
  // Log tailing: children write raw lines to the log file themselves; the daemon
  // tails each running process's file to feed SSE, triggers, and wait_for_log.
  // ---------------------------------------------------------------------------

  private tailers = new Map<string, { file: string; offset: number; buf: string; timer: NodeJS.Timeout }>();

  private attachTail(key: string): void {
    if (this.tailers.has(key)) return;
    const [app, proc] = key.split('/');
    const file = this.logFile(app, proc);
    let offset = 0;
    try { offset = fs.statSync(file).size; } catch { /* not created yet */ }
    const t = { file, offset, buf: '', timer: setInterval(() => this.pollTail(key), 250) };
    this.tailers.set(key, t);
  }

  private detachTail(key: string): void {
    const t = this.tailers.get(key);
    if (!t) return;
    this.pollTail(key); // final flush
    clearInterval(t.timer);
    this.tailers.delete(key);
  }

  private pollTail(key: string): void {
    const t = this.tailers.get(key);
    if (!t) return;
    const [app, proc] = key.split('/');
    let size = 0;
    try { size = fs.statSync(t.file).size; } catch { return; }
    if (size < t.offset) { t.offset = 0; t.buf = ''; } // file truncated (rotation)
    if (size > t.offset) {
      try {
        const fd = fs.openSync(t.file, 'r');
        try {
          const toRead = Math.min(size - t.offset, 256 * 1024);
          const buf = Buffer.alloc(toRead);
          const n = fs.readSync(fd, buf, 0, toRead, t.offset);
          t.offset += n;
          t.buf += buf.toString('utf8', 0, n);
        } finally {
          fs.closeSync(fd);
        }
      } catch { return; }
      const parts = t.buf.split('\n');
      t.buf = parts.pop() ?? '';
      const stamp = `[${new Date().toISOString()}]`;
      for (const line of parts) {
        if (!line.trim()) continue;
        // Controller marker lines are stamped at write time; raw child lines get a
        // read-time stamp for the live views (the file itself keeps them raw).
        bus.emit('log', { app, proc, line: STAMPED_RE.test(line) ? line : `${stamp} ${line}` });
      }
    }
    this.maybeRotate(key, t.file);
  }

  private lastRotateCheck = new Map<string, number>();

  /** Copy+truncate rotation (checked every 10s per process): children hold O_APPEND
   * fds to this exact file, so the classic rename would leave them writing into the
   * rotated file forever. Truncating in place keeps every open fd valid. */
  private maybeRotate(key: string, file: string): void {
    const now = Date.now();
    if ((this.lastRotateCheck.get(key) ?? 0) > now - 10_000) return;
    this.lastRotateCheck.set(key, now);
    const maxBytes = (Number(process.env.APPCTRL_LOG_MAX_MB) || 20) * 1024 * 1024;
    try {
      if (fs.statSync(file).size < maxBytes) return;
      if (fs.existsSync(`${file}.2`)) fs.unlinkSync(`${file}.2`);
      if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`);
      fs.copyFileSync(file, `${file}.1`);
      fs.truncateSync(file, 0);
      const t = this.tailers.get(key);
      if (t) { t.offset = 0; t.buf = ''; }
    } catch {
      // best effort
    }
  }

  private appendCounts = new Map<string, number>();

  /** Open append streams per process — async buffered writes instead of a sync
   * open/write/close per line (build bursts of 10k+ lines used to stall the event
   * loop and made the HTTP server unresponsive). */
  private logStreams = new Map<string, fs.WriteStream>();

  private appendLog(key: string, line: string): void {
    const [app, proc] = key.split('/');
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    try {
      const file = this.logFile(app, proc);
      let ws = this.logStreams.get(key);
      if (!ws) {
        // flags 'a' → O_APPEND: stays valid across copy+truncate rotation.
        ws = fs.createWriteStream(file, { flags: 'a' });
        ws.on('error', () => this.logStreams.delete(key));
        this.logStreams.set(key, ws);
      }
      ws.write(stamped);
      // Rotation for keys WITHOUT a tailer (one-shot prepare/clean logs) — tailed
      // files are rotated by the tailer itself. Checked every 500 appends.
      const n = (this.appendCounts.get(key) ?? 0) + 1;
      this.appendCounts.set(key, n);
      if (n % 500 === 0 && !this.tailers.has(key)) this.maybeRotate(key, file);
    } catch {
      // best effort
    }
    // Tailed keys: the tailer is the single SSE source (it reads this line from the
    // file), so don't emit here — that would duplicate every controller marker line.
    if (!this.tailers.has(key)) bus.emit('log', { app, proc, line: stamped.trimEnd() });
  }

  /**
   * Find the log region around a timestamped line (searches current + rotated file).
   * Returns up to `context` lines before/after the line whose prefix matches `[ts]`.
   */
  readLogsAround(app: string, proc: string, ts: string, context = 250): string {
    const file = this.logFile(app, proc);
    for (const f of [file, `${file}.1`]) {
      if (!fs.existsSync(f)) continue;
      const stat = fs.statSync(f);
      const readBytes = Math.min(stat.size, 5 * 1024 * 1024);
      const fd = fs.openSync(f, 'r');
      let all: string[];
      try {
        const buf = Buffer.alloc(readBytes);
        fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
        all = buf.toString('utf8').split('\n');
      } finally {
        fs.closeSync(fd);
      }
      const idx = all.findIndex((l) => l.startsWith(`[${ts}]`));
      if (idx >= 0) {
        return all.slice(Math.max(0, idx - context), idx + context).join('\n');
      }
    }
    return '';
  }

  readLogs(app: string, proc: string, lines = 100, stripAnsi = false): string {
    const file = this.logFile(app, proc);
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    const readBytes = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
      const all = buf.toString('utf8').split('\n').filter(Boolean);
      const tail = all.slice(-lines).join('\n');
      return stripAnsi ? stripAnsiCodes(tail) : tail;
    } finally {
      fs.closeSync(fd);
    }
  }
}
