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

  constructor(private config: ConfigStore, private pm: ProcessManager) {}

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
