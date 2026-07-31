import net from 'node:net';
import { bus } from './events.js';
import type { ConfigStore, ProcessDef } from './config.js';
import type { ProcessManager } from './process-manager.js';

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function hasHealthCheck(p: ProcessDef): boolean {
  return !!(p.healthUrl || p.healthPort);
}

export class HealthMonitor {
  private map = new Map<string, HealthStatus>();
  private timer?: NodeJS.Timeout;
  /** First-healthy moment per process for its CURRENT run (keyed to startedAt). */
  private readyAt = new Map<string, { since: number; at: number }>();

  constructor(private config: ConfigStore, private pm: ProcessManager) {}

  /** Record the first healthy observation for the process's current run. */
  private markHealthy(app: string, proc: string): void {
    const st = this.pm.getState(app, proc);
    if (st.status !== 'running' || !st.startedAt) return;
    const key = `${app}/${proc}`;
    const cur = this.readyAt.get(key);
    if (!cur || cur.since !== st.startedAt) this.readyAt.set(key, { since: st.startedAt, at: Date.now() });
  }

  /** How long the current run took to become healthy (ms), or null if unknown/not applicable. */
  getReadyMs(app: string, proc: string): number | null {
    const st = this.pm.getState(app, proc);
    if (st.status !== 'running' || !st.startedAt) return null;
    const e = this.readyAt.get(`${app}/${proc}`);
    return e && e.since === st.startedAt ? Math.max(0, e.at - st.startedAt) : null;
  }

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** null = no health check configured or process not running */
  getHealth(app: string, proc: string): HealthStatus | null {
    const def = this.config.getApp(app)?.processes.find((x) => x.name === proc);
    if (!def || !hasHealthCheck(def)) return null;
    if (!this.pm.isRunning(app, proc)) return null;
    return this.map.get(`${app}/${proc}`) ?? 'unknown';
  }

  private async tick(): Promise<void> {
    for (const app of this.config.apps) {
      for (const p of app.processes) {
        if (!hasHealthCheck(p)) continue;
        const key = `${app.name}/${p.name}`;
        if (!this.pm.isRunning(app.name, p.name)) {
          if (this.map.delete(key)) bus.emit('state');
          continue;
        }
        const ok = await this.check(p);
        const next: HealthStatus = ok ? 'healthy' : 'unhealthy';
        if (ok) this.markHealthy(app.name, p.name);
        if (this.map.get(key) !== next) {
          this.map.set(key, next);
          bus.emit('state');
        }
      }
    }
  }

  private async check(def: ProcessDef): Promise<boolean> {
    if (def.healthUrl) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 3000);
        const res = await fetch(def.healthUrl, { signal: ctl.signal });
        clearTimeout(t);
        return res.status < 500;
      } catch {
        return false;
      }
    }
    if (def.healthPort) {
      return new Promise((resolve) => {
        const s = net.connect({ port: def.healthPort!, host: '127.0.0.1', timeout: 3000 });
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
      });
    }
    return false;
  }

  /** Returns true when healthy (or no check configured), false on timeout / process death. */
  async waitHealthy(app: string, proc: string, timeoutMs = 30000): Promise<boolean> {
    const def = this.config.getApp(app)?.processes.find((x) => x.name === proc);
    if (!def || !hasHealthCheck(def)) return true;
    const key = `${app}/${proc}`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.pm.isRunning(app, proc)) return false;
      if (await this.check(def)) {
        this.markHealthy(app, proc);
        if (this.map.get(key) !== 'healthy') {
          this.map.set(key, 'healthy');
          bus.emit('state');
        }
        return true;
      }
      await sleep(1000);
    }
    return false;
  }
}
