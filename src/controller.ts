import type { ConfigStore, AppDef, ProcessDef } from './config.js';
import type { Store, Lease } from './db.js';
import type { ProcessManager, Mode, ProcState } from './process-manager.js';
import { hasHealthCheck, type HealthMonitor } from './health.js';
import type { MetricsMonitor } from './metrics.js';
import { KeyedQueue } from './queue.js';

export const ACTION_LEASE_MS = 5 * 60 * 1000;

export interface ActorCtx {
  session: string; // short session id, 'ui', or 'system'
  source: 'mcp' | 'ui' | 'system';
}

export interface ConflictInfo {
  blocked: true;
  lease: Lease;
  message: string;
}

export interface ProcResult {
  proc: string;
  state: ProcState;
  error?: string;
  /** set when waitReady was requested and the process has a health check */
  ready?: boolean;
  /** set when this request was coalesced away by a newer request for the same process */
  superseded?: string;
}

export class Controller {
  public health?: HealthMonitor;
  public metrics?: MetricsMonitor;
  private queue = new KeyedQueue();

  constructor(
    public config: ConfigStore,
    public store: Store,
    public pm: ProcessManager
  ) {}

  /** Waits (in parallel) for started processes with health checks to report healthy. */
  private async awaitReady(appName: string, results: ProcResult[], app: AppDef): Promise<void> {
    if (!this.health) return;
    await Promise.all(
      results.map(async (r) => {
        if (r.error || r.state.status !== 'running') return;
        const def = app.processes.find((p) => p.name === r.proc);
        if (!def || !hasHealthCheck(def)) return;
        r.ready = await this.health!.waitHealthy(appName, r.proc, 30000);
      })
    );
  }

  requireApp(name: string): AppDef {
    const app = this.config.getApp(name);
    if (!app) {
      const known = this.config.apps.map((a) => a.name).join(', ') || '(none)';
      throw new Error(`Unknown app '${name}'. Known apps: ${known}`);
    }
    return app;
  }

  selectProcesses(app: AppDef, proc?: string): ProcessDef[] {
    if (!proc) return app.processes;
    const p = app.processes.find((x) => x.name === proc);
    if (!p) {
      throw new Error(
        `App '${app.name}' has no process '${proc}'. Processes: ${app.processes.map((x) => x.name).join(', ')}`
      );
    }
    return [p];
  }

  /** Returns conflict info if another actor holds an active lease and force is not set. */
  checkConflict(appName: string, actor: ActorCtx, force: boolean): ConflictInfo | null {
    const lease = this.store.getLease(appName);
    if (!lease || lease.session === actor.session || force) return null;
    const ago = Math.round((Date.now() - lease.acquired_at) / 1000);
    const left = Math.round((lease.expires_at - Date.now()) / 1000);
    return {
      blocked: true,
      lease,
      message:
        `CONFLICT: app '${appName}' is currently held by session '${lease.session}' ` +
        `(reason: "${lease.reason}", acquired ${ago}s ago, lease expires in ${left}s). ` +
        `Another session is actively working on this app. If you are sure your action will not disrupt it, retry with force=true.`,
    };
  }

  private touchLease(appName: string, actor: ActorCtx, reason: string): void {
    if (actor.source === 'system') return; // boot-restore should not block sessions
    this.store.setLease(appName, actor.session, reason, ACTION_LEASE_MS);
  }

  async start(
    appName: string,
    proc: string | undefined,
    mode: Mode,
    reason: string,
    actor: ActorCtx,
    force = false,
    waitReady = false,
    takeover = false
  ): Promise<ConflictInfo | ProcResult[]> {
    const app = this.requireApp(appName);
    const conflict = this.checkConflict(appName, actor, force);
    if (conflict) return conflict;
    const results: ProcResult[] = [];
    for (const p of this.selectProcesses(app, proc)) {
      const outcome = await this.queue.enqueue(
        `${appName}/${p.name}`,
        `start(${mode}) by ${actor.session}`,
        async (): Promise<ProcResult> => {
          try {
            const state = await this.pm.start(app, p, mode, actor.session, actor.source, takeover);
            this.store.audit({
              session: actor.session, source: actor.source, action: `start(${mode})`,
              app: appName, proc: p.name, detail: reason, result: state.status,
            });
            return { proc: p.name, state };
          } catch (err: any) {
            this.store.audit({
              session: actor.session, source: actor.source, action: `start(${mode})`,
              app: appName, proc: p.name, detail: reason, result: `error: ${err.message}`,
            });
            return { proc: p.name, state: this.pm.getState(appName, p.name), error: err.message };
          }
        }
      );
      results.push(this.resolveOutcome(outcome, appName, p.name, actor, reason));
    }
    this.touchLease(appName, actor, reason);
    if (waitReady) await this.awaitReady(appName, results, app);
    return results;
  }

  private resolveOutcome(
    outcome: { superseded: true; by: string } | { superseded: false; value: ProcResult },
    appName: string,
    proc: string,
    actor: ActorCtx,
    reason: string
  ): ProcResult {
    if (!outcome.superseded) return outcome.value;
    this.store.audit({
      session: actor.session, source: actor.source, action: 'superseded',
      app: appName, proc, detail: reason, result: `replaced by newer request: ${outcome.by}`,
    });
    return { proc, state: this.pm.getState(appName, proc), superseded: outcome.by };
  }

  async stop(
    appName: string,
    proc: string | undefined,
    reason: string,
    actor: ActorCtx,
    force = false
  ): Promise<ConflictInfo | ProcResult[]> {
    const app = this.requireApp(appName);
    const conflict = this.checkConflict(appName, actor, force);
    if (conflict) return conflict;
    const results: ProcResult[] = [];
    for (const p of this.selectProcesses(app, proc)) {
      const outcome = await this.queue.enqueue(
        `${appName}/${p.name}`,
        `stop by ${actor.session}`,
        async (): Promise<ProcResult> => {
          const state = await this.pm.stop(appName, p.name);
          this.store.audit({
            session: actor.session, source: actor.source, action: 'stop',
            app: appName, proc: p.name, detail: reason, result: state.status,
          });
          return { proc: p.name, state };
        }
      );
      results.push(this.resolveOutcome(outcome, appName, p.name, actor, reason));
    }
    this.touchLease(appName, actor, reason);
    return results;
  }

  async restart(
    appName: string,
    proc: string | undefined,
    mode: Mode | undefined,
    reason: string,
    actor: ActorCtx,
    force = false,
    waitReady = false,
    takeover = false
  ): Promise<ConflictInfo | ProcResult[]> {
    const app = this.requireApp(appName);
    const conflict = this.checkConflict(appName, actor, force);
    if (conflict) return conflict;
    const results: ProcResult[] = [];
    for (const p of this.selectProcesses(app, proc)) {
      const outcome = await this.queue.enqueue(
        `${appName}/${p.name}`,
        `restart by ${actor.session}`,
        async (): Promise<ProcResult> => {
          const prev = this.pm.getState(appName, p.name);
          const nextMode: Mode = mode ?? prev.mode ?? 'start';
          try {
            await this.pm.stop(appName, p.name);
            const state = await this.pm.start(app, p, nextMode, actor.session, actor.source, takeover);
            this.store.audit({
              session: actor.session, source: actor.source, action: `restart(${nextMode})`,
              app: appName, proc: p.name, detail: reason, result: state.status,
            });
            return { proc: p.name, state };
          } catch (err: any) {
            this.store.audit({
              session: actor.session, source: actor.source, action: `restart(${nextMode})`,
              app: appName, proc: p.name, detail: reason, result: `error: ${err.message}`,
            });
            return { proc: p.name, state: this.pm.getState(appName, p.name), error: err.message };
          }
        }
      );
      results.push(this.resolveOutcome(outcome, appName, p.name, actor, reason));
    }
    this.touchLease(appName, actor, reason);
    if (waitReady) await this.awaitReady(appName, results, app);
    return results;
  }

  fullState() {
    const leases = this.store.allLeases();
    return {
      apps: this.config.apps.map((app) => ({
        name: app.name,
        description: app.description,
        cwd: app.cwd,
        lease: leases.find((l) => l.app === app.name) ?? null,
        processes: app.processes.map((p) => ({
          name: p.name,
          command: p.command,
          devCommand: p.devCommand ?? null,
          cwd: p.cwd ?? null,
          env: p.env,
          autoRestart: p.autoRestart,
          healthUrl: p.healthUrl ?? null,
          healthPort: p.healthPort ?? null,
          ownLogTimestamps: p.ownLogTimestamps,
          ports: p.ports,
          health: this.health?.getHealth(app.name, p.name) ?? null,
          metrics: this.metrics?.latest.get(`${app.name}/${p.name}`) ?? null,
          ...this.pm.getState(app.name, p.name),
        })),
      })),
    };
  }
}
