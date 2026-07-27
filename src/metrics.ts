import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bus } from './events.js';
import type { ConfigStore } from './config.js';
import type { ProcessManager } from './process-manager.js';

const execFileP = promisify(execFile);

export interface ProcMetrics {
  cpu: number; // % across the whole process group (can exceed 100 on multicore)
  memMb: number; // RSS sum of the process group
  at: number;
}

const HISTORY_LIMIT = 120; // ~10 minutes at 5s interval

export class MetricsMonitor {
  latest = new Map<string, ProcMetrics>();
  history = new Map<string, ProcMetrics[]>();
  private timer?: NodeJS.Timeout;

  constructor(private config: ConfigStore, private pm: ProcessManager) {}

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getHistory(app: string, proc: string): ProcMetrics[] {
    return this.history.get(`${app}/${proc}`) ?? [];
  }

  /** Serialize history for persistence across daemon restarts. */
  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.history));
  }

  hydrate(json: string | null): void {
    if (!json) return;
    try {
      const data = JSON.parse(json) as Record<string, ProcMetrics[]>;
      const cutoff = Date.now() - 30 * 60_000; // ignore stale history
      for (const [key, h] of Object.entries(data)) {
        const recent = h.filter((m) => m.at > cutoff);
        if (recent.length > 0) this.history.set(key, recent.slice(-HISTORY_LIMIT));
      }
    } catch {
      // best effort
    }
  }

  private async tick(): Promise<void> {
    const roots: { key: string; pid: number }[] = [];
    for (const app of this.config.apps) {
      for (const p of app.processes) {
        const st = this.pm.getState(app.name, p.name);
        if (st.status === 'running' && st.pid) roots.push({ key: `${app.name}/${p.name}`, pid: st.pid });
      }
    }
    if (roots.length === 0) {
      if (this.latest.size > 0) {
        this.latest.clear();
        bus.emit('metrics', {});
      }
      return;
    }

    let rows: { pgid: number; rssKb: number; cpu: number }[];
    try {
      // One ps call for everything; children share the root's process group (detached spawn)
      const { stdout } = await execFileP('ps', ['-axo', 'pgid=,rss=,pcpu='], { maxBuffer: 8 * 1024 * 1024 });
      rows = stdout
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length === 3)
        .map((c) => ({ pgid: Number(c[0]), rssKb: Number(c[1]), cpu: Number(c[2]) }))
        .filter((r) => Number.isFinite(r.pgid));
    } catch {
      return;
    }

    const byGroup = new Map<number, { rssKb: number; cpu: number }>();
    for (const r of rows) {
      const g = byGroup.get(r.pgid) ?? { rssKb: 0, cpu: 0 };
      g.rssKb += r.rssKb || 0;
      g.cpu += r.cpu || 0;
      byGroup.set(r.pgid, g);
    }

    const now = Date.now();
    const seen = new Set<string>();
    for (const { key, pid } of roots) {
      const g = byGroup.get(pid);
      if (!g) continue;
      const m: ProcMetrics = { cpu: Math.round(g.cpu * 10) / 10, memMb: Math.round(g.rssKb / 1024), at: now };
      this.latest.set(key, m);
      const h = this.history.get(key) ?? [];
      h.push(m);
      if (h.length > HISTORY_LIMIT) h.shift();
      this.history.set(key, h);
      seen.add(key);
    }
    for (const key of [...this.latest.keys()]) {
      if (!seen.has(key)) {
        this.latest.delete(key);
        this.history.delete(key);
      }
    }
    bus.emit('metrics', Object.fromEntries(this.latest));
  }
}
