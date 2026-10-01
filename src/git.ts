import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { bus } from './events.js';
import type { ConfigStore } from './config.js';
import type { ProcessManager } from './process-manager.js';

const execFileP = promisify(execFile);

/** Max changed paths listed per process (the count is always exact). */
const CHANGED_SAMPLE = 20;

/** How a running process's code relates to its repo's current HEAD and working tree. */
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
  /** Uncommitted files (relative to the repo root) edited, added, deleted or reverted since the spawn */
  changedFiles: number;
  changedSample: string[];
  /** Uncommitted files already present at spawn — the process runs code that isn't any commit */
  dirtyAtStart: number;
  dirtySample: string[];
}

interface StartRecord {
  pid: number;
  commit: string;
  /** Spawn time — a working-tree file modified after this is newer than the running code */
  at: number;
  /** `git status` at spawn: path → XY code */
  dirty: Record<string, string>;
}

interface RepoState {
  root: string;
  commit: string;
  branch: string | null;
  dirty: Record<string, string>;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    // --no-optional-locks: polling must never contend with the user's own git commands
    const { stdout } = await execFileP('git', ['--no-optional-locks', ...args], { cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return null; // not a repo, git missing, unknown commit…
  }
}

/** Parse `git status --porcelain -z` into path → XY code (renames keyed by the new path). */
function parseStatus(out: string): Record<string, string> {
  const dirty: Record<string, string> = {};
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    dirty[entry.slice(3)] = code;
    if (code[0] === 'R' || code[0] === 'C') i++; // next token is the original path
  }
  return dirty;
}

async function repoState(cwd: string): Promise<RepoState | null> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  const commit = (await git(cwd, ['rev-parse', 'HEAD']))?.trim();
  if (!root || !commit) return null;
  const branch = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null;
  const status = await git(cwd, ['status', '--porcelain', '-z']);
  return { root, commit, branch, dirty: status ? parseStatus(status) : {} };
}

/**
 * Paths whose working-tree content differs from what the process was spawned with.
 * A path counts when it exists and was modified after the spawn (edit, revert via
 * checkout, new untracked file), or when it vanished without already being deleted at
 * spawn. Committing a file without touching it doesn't count — HEAD movement covers it.
 */
function changedSince(rec: StartRecord, now: RepoState): string[] {
  const changed: string[] = [];
  for (const p of new Set([...Object.keys(rec.dirty), ...Object.keys(now.dirty)])) {
    let mtime: number | null = null;
    try {
      mtime = fs.statSync(path.join(now.root, p)).mtimeMs;
    } catch { /* gone */ }
    if (mtime !== null ? mtime > rec.at : !rec.dirty[p]?.includes('D')) changed.push(p);
  }
  return changed.sort();
}

/**
 * Tracks whether each running process is up to date with its repo: the commit and
 * working-tree status are captured at spawn, then polled and compared per process.
 * Keyed by pid so processes adopted after a daemon restart keep their start record.
 */
export class GitMonitor {
  private starts = new Map<string, StartRecord>();
  private repos = new Map<string, RepoState>();
  private counts = new Map<string, { ahead: number; behind: number }>();
  private changed = new Map<string, string[]>();
  private timer?: NodeJS.Timeout;

  constructor(private config: ConfigStore, private pm: ProcessManager) {}

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Called right after a spawn — records the commit and working tree the process starts from. */
  async recordStart(app: string, proc: string, pid: number, cwd: string): Promise<void> {
    const at = Date.now();
    const repo = await repoState(cwd);
    if (!repo) return;
    const key = `${app}/${proc}`;
    this.starts.set(key, { pid, commit: repo.commit, at, dirty: repo.dirty });
    this.changed.delete(key);
    bus.emit('state');
  }

  get(app: string, proc: string): GitInfo | null {
    const key = `${app}/${proc}`;
    const rec = this.starts.get(key);
    const st = this.pm.getState(app, proc);
    if (!rec || st.status !== 'running' || st.pid !== rec.pid) return null;
    const repo = this.repos.get(this.cwdOf(app, proc) ?? '');
    if (!repo) return null;
    const counts = rec.commit === repo.commit ? { ahead: 0, behind: 0 } : this.counts.get(`${rec.commit}..${repo.commit}`);
    if (!counts) return null;
    const changed = this.changed.get(key) ?? [];
    return {
      startCommit: rec.commit, headCommit: repo.commit, branch: repo.branch, ...counts,
      changedFiles: changed.length, changedSample: changed.slice(0, CHANGED_SAMPLE),
      dirtyAtStart: Object.keys(rec.dirty).length, dirtySample: Object.keys(rec.dirty).sort().slice(0, CHANGED_SAMPLE),
    };
  }

  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.starts));
  }

  hydrate(raw: string | null): void {
    if (!raw) return;
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, StartRecord>)) {
        // Records from before working-tree tracking: no baseline, so nothing counts as changed
        this.starts.set(k, { ...v, at: v.at ?? Date.now(), dirty: v.dirty ?? {} });
      }
    } catch { /* corrupt — start fresh */ }
  }

  private cwdOf(app: string, proc: string): string | null {
    const appDef = this.config.getApp(app);
    const procDef = appDef?.processes.find((p) => p.name === proc);
    return appDef && procDef ? this.pm.cwdFor(appDef, procDef) : null;
  }

  private async tick(): Promise<void> {
    const live = new Map<string, { cwd: string; rec: StartRecord }>();
    for (const app of this.config.apps) {
      for (const p of app.processes) {
        const key = `${app.name}/${p.name}`;
        const rec = this.starts.get(key);
        const st = this.pm.getState(app.name, p.name);
        if (!rec) continue;
        if (st.status !== 'running' || st.pid !== rec.pid) {
          this.starts.delete(key); // that run is over
          this.changed.delete(key);
          continue;
        }
        live.set(key, { cwd: this.pm.cwdFor(app, p), rec });
      }
    }

    let changed = false;
    const cwds = new Set([...live.values()].map((l) => l.cwd));
    for (const cwd of cwds) {
      const repo = await repoState(cwd);
      if (!repo) continue;
      const prev = this.repos.get(cwd);
      if (prev?.commit !== repo.commit || prev?.branch !== repo.branch) changed = true;
      this.repos.set(cwd, repo);
    }
    for (const cwd of [...this.repos.keys()]) if (!cwds.has(cwd)) this.repos.delete(cwd);

    for (const [key, { cwd, rec }] of live) {
      const repo = this.repos.get(cwd);
      if (!repo) continue;
      const files = changedSince(rec, repo);
      if (files.join('\0') !== (this.changed.get(key) ?? []).join('\0')) changed = true;
      this.changed.set(key, files);

      if (repo.commit === rec.commit) continue;
      const pair = `${rec.commit}..${repo.commit}`;
      if (this.counts.has(pair)) continue;
      const out = await git(cwd, ['rev-list', '--left-right', '--count', `${rec.commit}...${repo.commit}`]);
      const [ahead, behind] = (out ?? '').trim().split(/\s+/).map(Number);
      // Start commit gone (gc'd / shallow) — still out of date, count unknown
      this.counts.set(pair, Number.isFinite(behind) ? { ahead, behind } : { ahead: 0, behind: -1 });
      changed = true;
    }
    if (changed) bus.emit('state');
  }
}
