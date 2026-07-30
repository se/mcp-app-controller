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
  child: ChildProcess;
  mode: Mode;
  startedAt: number;
  stopRequested: boolean;
  restartCount: number;
  exited: boolean;
  exitPromise: Promise<void>;
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
   * Fail fast if a declared port is already bound. If the holder is an orphan of a
   * previous run of THIS process (recorded pid/pgid), reclaim it and continue.
   * With takeover=true, a FOREIGN holder (started outside the controller) is also
   * stopped so the process can run under controller management instead.
   */
  private async ensurePortsFree(
    app: string, procDef: ProcessDef, key: string, takeover: boolean, session: string, source: string
  ): Promise<void> {
    const recorded = this.store.listRunning().find((r) => r.app === app && r.proc === procDef.name);
    for (const port of declaredPorts(procDef)) {
      if (!(await isPortInUse(port))) continue;
      const holder = await portHolder(port);
      if (holder && recorded?.pid && (holder.pid === recorded.pid || holder.pgid === recorded.pid)) {
        this.appendLog(key, `--- [controller] port ${port} held by orphaned previous run (pid ${holder.pid}) — reclaiming`);
        if (await this.killPortHolder(holder, port)) continue;
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
    if (rt && rt.child.pid && !rt.exited) {
      return { status: 'running', pid: rt.child.pid, mode: rt.mode, startedAt: rt.startedAt };
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

    await this.ensurePortsFree(appDef.name, procDef, key, takeover, session, source);

    this.appendLog(key, `--- [controller] starting (mode=${mode}, by=${session}): ${command}`);
    const child = spawn(command, {
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => (resolveExit = r));
    const entry: RuntimeEntry = {
      child,
      mode,
      startedAt: Date.now(),
      stopRequested: false,
      restartCount: this.runtime.get(key)?.restartCount ?? 0,
      exited: false,
      exitPromise,
    };
    this.runtime.set(key, entry);
    this.stopped.delete(key);
    this.store.setRunning(appDef.name, procDef.name, mode, child.pid);

    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => this.appendLog(key, line));
    }

    child.on('error', (err) => {
      this.appendLog(key, `--- [controller] spawn error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      entry.exited = true;
      const exit: { code: number | null; signal: string | null; at: number; summary?: string } = {
        code, signal: signal ?? null, at: Date.now(),
      };
      if (!entry.stopRequested) {
        exit.summary = this.extractErrorSummary(appDef.name, procDef.name);
      }
      this.lastExit.set(key, exit);
      this.appendLog(key, `--- [controller] exited (code=${code}, signal=${signal ?? 'none'})`);
      const wasRequested = entry.stopRequested;
      if (wasRequested) this.stopped.add(key);
      resolveExit();
      bus.emit('state');

      if (!wasRequested) {
        this.store.audit({
          session: 'system',
          source: 'system',
          action: 'crash-detected',
          app: appDef.name,
          proc: procDef.name,
          detail: `exit code=${code} signal=${signal ?? 'none'}`,
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
    });

    // Give the process a beat to fail fast (bad command, missing dir, etc.)
    await new Promise((r) => setTimeout(r, 400));
    bus.emit('state');
    return this.getState(appDef.name, procDef.name);
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
    const pid = entry.child.pid!;
    this.appendLog(key, `--- [controller] stopping (SIGTERM to process group ${pid})`);
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    const killed = await Promise.race([
      entry.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), gracefulMs)),
    ]);
    if (!killed) {
      this.appendLog(key, `--- [controller] escalating to SIGKILL`);
      try { process.kill(-pid, 'SIGKILL'); } catch { try { entry.child.kill('SIGKILL'); } catch { /* gone */ } }
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
  }

  private appendCounts = new Map<string, number>();

  private appendLog(key: string, line: string): void {
    const [app, proc] = key.split('/');
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    try {
      const file = this.logFile(app, proc);
      fs.appendFileSync(file, stamped);
      // Rotation: check size every 500 appends per process
      const n = (this.appendCounts.get(key) ?? 0) + 1;
      this.appendCounts.set(key, n);
      if (n % 500 === 0) this.rotateIfNeeded(file);
    } catch {
      // best effort
    }
    bus.emit('log', { app, proc, line: stamped.trimEnd() });
  }

  /** Rotate <file> → <file>.1 → <file>.2 when it exceeds APPCTRL_LOG_MAX_MB (default 20). */
  private rotateIfNeeded(file: string): void {
    const maxBytes = (Number(process.env.APPCTRL_LOG_MAX_MB) || 20) * 1024 * 1024;
    try {
      if (fs.statSync(file).size < maxBytes) return;
      if (fs.existsSync(`${file}.2`)) fs.unlinkSync(`${file}.2`);
      if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`);
      fs.renameSync(file, `${file}.1`);
    } catch {
      // best effort
    }
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
