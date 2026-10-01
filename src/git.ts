import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bus } from './events.js';
import type { ConfigStore } from './config.js';
import type { ProcessManager } from './process-manager.js';

const execFileP = promisify(execFile);

/** How a running process's code relates to its repo's current HEAD. */
export interface GitInfo {
  /** Commit HEAD pointed at when the process was spawned */
  startCommit: string;
  /** Commit HEAD points at now */
  headCommit: string;
  branch: string | null;
  /** Commits in HEAD that the running process doesn't have (start..HEAD) */
  behind: number;
  /** Commits the running process has that HEAD doesn't (branch switch / reset) */
  ahead: number;
}

interface StartRecord {
  pid: number;
  commit: string;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, timeout: 3000 });
    return stdout.trim();
  } catch {
    return null; // not a repo, git missing, unknown commit…
  }
}

/**
 * Tracks whether each running process is up to date with its repo's HEAD: the commit
 * is captured at spawn, HEAD is polled, and the difference is exposed per process.
 * Keyed by pid so processes adopted after a daemon restart keep their start commit.
 */
export class GitMonitor {
  private starts = new Map<string, StartRecord>();
  private heads = new Map<string, { commit: string; branch: string | null }>();
  private counts = new Map<string, { ahead: number; behind: number }>();
  private timer?: NodeJS.Timeout;

  constructor(private config: ConfigStore, private pm: ProcessManager) {}

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Called right after a spawn — records the commit the process starts from. */
  async recordStart(app: string, proc: string, pid: number, cwd: string): Promise<void> {
    const commit = await git(cwd, ['rev-parse', 'HEAD']);
    if (!commit) return;
    this.starts.set(`${app}/${proc}`, { pid, commit });
    bus.emit('state');
  }

  get(app: string, proc: string): GitInfo | null {
    const key = `${app}/${proc}`;
    const rec = this.starts.get(key);
    const st = this.pm.getState(app, proc);
    if (!rec || st.status !== 'running' || st.pid !== rec.pid) return null;
    const head = this.heads.get(this.cwdOf(app, proc) ?? '');
    if (!head) return null;
    const counts = rec.commit === head.commit ? { ahead: 0, behind: 0 } : this.counts.get(`${rec.commit}..${head.commit}`);
    if (!counts) return null;
    return { startCommit: rec.commit, headCommit: head.commit, branch: head.branch, ...counts };
  }

  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.starts));
  }

  hydrate(raw: string | null): void {
    if (!raw) return;
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, StartRecord>)) this.starts.set(k, v);
    } catch { /* corrupt — start fresh */ }
  }

  private cwdOf(app: string, proc: string): string | null {
    const appDef = this.config.getApp(app);
    const procDef = appDef?.processes.find((p) => p.name === proc);
    return appDef && procDef ? this.pm.cwdFor(appDef, procDef) : null;
  }

  private async tick(): Promise<void> {
    const live = new Map<string, { cwd: string; commit: string }>();
    for (const app of this.config.apps) {
      for (const p of app.processes) {
        const key = `${app.name}/${p.name}`;
        const rec = this.starts.get(key);
        const st = this.pm.getState(app.name, p.name);
        if (!rec) continue;
        if (st.status !== 'running' || st.pid !== rec.pid) {
          this.starts.delete(key); // that run is over
          continue;
        }
        live.set(key, { cwd: this.pm.cwdFor(app, p), commit: rec.commit });
      }
    }

    let changed = false;
    const cwds = new Set([...live.values()].map((l) => l.cwd));
    for (const cwd of cwds) {
      const commit = await git(cwd, ['rev-parse', 'HEAD']);
      if (!commit) continue;
      const branch = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
      const prev = this.heads.get(cwd);
      if (prev?.commit !== commit || prev?.branch !== branch) changed = true;
      this.heads.set(cwd, { commit, branch: branch || null });
    }
    for (const cwd of [...this.heads.keys()]) if (!cwds.has(cwd)) this.heads.delete(cwd);

    for (const { cwd, commit } of live.values()) {
      const head = this.heads.get(cwd);
      if (!head || head.commit === commit) continue;
      const pair = `${commit}..${head.commit}`;
      if (this.counts.has(pair)) continue;
      const out = await git(cwd, ['rev-list', '--left-right', '--count', `${commit}...${head.commit}`]);
      const [ahead, behind] = (out ?? '').split(/\s+/).map(Number);
      // Start commit gone (gc'd / shallow) — still out of date, count unknown
      this.counts.set(pair, Number.isFinite(behind) ? { ahead, behind } : { ahead: 0, behind: -1 });
      changed = true;
    }
    if (changed) bus.emit('state');
  }
}
