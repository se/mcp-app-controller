import { exec } from 'node:child_process';
import net from 'node:net';
import { bus } from './events.js';
import type { AppDef, ConfigStore, ProcessDef } from './config.js';
import type { ProcessManager } from './process-manager.js';

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function hasHealthCheck(p: ProcessDef): boolean {
  return !!(p.healthUrl || p.healthPort || p.healthCommand);
}

const COMMAND_TIMEOUT_MS = 5000;

export class HealthMonitor {
  private map = new Map<string, HealthStatus>();
  private timer?: NodeJS.Timeout;
  /** First-healthy moment per process for its CURRENT run (keyed to startedAt). */
  private readyAt = new Map<string, { since: number; at: number }>();
  /** Consecutive failed checks per process (only counted once the run was healthy). */
  private unhealthyStreak = new Map<string, number>();
  /** Processes whose unhealthy-restart is in flight — don't fire a second one. */
  private restarting = new Set<string>();
  /** Called when a process with `restartOnUnhealthy` has failed that many checks in a
   * row. Wired by the daemon to the controller's restart path (queue, dependsOn, audit). */
  onUnhealthy?: (app: string, proc: string, streak: number) => Promise<void>;

  constructor(private config: ConfigStore, private pm: ProcessManager) {}

  /** Record the first healthy observation for the process's current run. */
  private markHealthy(app: string, proc: string): void {
    const st = this.pm.getState(app, proc);
    if (st.status !== 'running' || !st.startedAt) return;
    const key = `${app}/${proc}`;
    const cur = this.readyAt.get(key);
    if (!cur || cur.since !== st.startedAt) this.readyAt.set(key, { since: st.startedAt, at: Date.now() });
  }

  /** Adopted processes were already up before this daemon started — mark them ready
   * immediately so the UI doesn't show a "starting…" pulse or a bogus ready time. */
  assumeReady(app: string, proc: string): void {
    const st = this.pm.getState(app, proc);
    if (st.status !== 'running' || !st.startedAt) return;
    this.readyAt.set(`${app}/${proc}`, { since: st.startedAt, at: st.startedAt });
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
          this.unhealthyStreak.delete(key);
          continue;
        }
        const ok = await this.check(p, app);
        const next: HealthStatus = ok ? 'healthy' : 'unhealthy';
        if (ok) this.markHealthy(app.name, p.name);
        if (this.map.get(key) !== next) {
          this.map.set(key, next);
          bus.emit('state');
        }
        this.trackUnhealthy(app, p, ok);
      }
    }
  }

  /**
   * Count consecutive failures and hand the process to `onUnhealthy` when the
   * configured threshold is reached. Failures only count after the current run has
   * been healthy once (readyAt matches startedAt): a slow startup is never killed,
   * and right after a restart the streak stays at zero until the new run is up.
   */
  private trackUnhealthy(app: AppDef, def: ProcessDef, ok: boolean): void {
    const key = `${app.name}/${def.name}`;
    if (ok || !def.restartOnUnhealthy) {
      this.unhealthyStreak.delete(key);
      return;
    }
    const st = this.pm.getState(app.name, def.name);
    const ready = this.readyAt.get(key);
    if (!ready || ready.since !== st.startedAt) return; // never healthy in this run
    const n = (this.unhealthyStreak.get(key) ?? 0) + 1;
    this.unhealthyStreak.set(key, n);
    if (n < def.restartOnUnhealthy || this.restarting.has(key) || !this.onUnhealthy) return;
    this.unhealthyStreak.delete(key);
    this.restarting.add(key);
    void this.onUnhealthy(app.name, def.name, n).finally(() => this.restarting.delete(key));
  }

  private async check(def: ProcessDef, app?: AppDef): Promise<boolean> {
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
    if (def.healthCommand && app) {
      // Same cwd/env as the process itself, so the probe sees the same PATH and vars.
      return new Promise((resolve) => {
        exec(
          def.healthCommand!,
          { cwd: this.pm.cwdFor(app, def), env: this.pm.envFor(app, def), timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' },
          (err) => resolve(!err)
        );
      });
    }
    return false;
  }

  /** Returns true when healthy (or no check configured), false on timeout / process death. */
  async waitHealthy(app: string, proc: string, timeoutMs = 30000): Promise<boolean> {
    const appDef = this.config.getApp(app);
    const def = appDef?.processes.find((x) => x.name === proc);
    if (!appDef || !def || !hasHealthCheck(def)) return true;
    const key = `${app}/${proc}`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.pm.isRunning(app, proc)) return false;
      if (await this.check(def, appDef)) {
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
