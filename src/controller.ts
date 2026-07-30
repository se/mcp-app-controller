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

  /** Dependencies first (stable topological order; cycles broken silently). */
  private topoSort(procs: ProcessDef[]): ProcessDef[] {
    const byName = new Map(procs.map((p) => [p.name, p]));
    const done = new Set<string>();
    const visiting = new Set<string>();
    const out: ProcessDef[] = [];
    const visit = (p: ProcessDef) => {
      if (done.has(p.name) || visiting.has(p.name)) return;
      visiting.add(p.name);
      for (const d of p.dependsOn) {
        const dep = byName.get(d);
        if (dep) visit(dep);
      }
      visiting.delete(p.name);
      done.add(p.name);
      out.push(p);
    };
    procs.forEach(visit);
    return out;
  }

  /** Wait until a dependency is usable: healthy if it has a check, else just running. */
  private async waitDepReady(appName: string, depName: string, timeoutMs = 60000): Promise<boolean> {
    const dep = this.config.getApp(appName)?.processes.find((p) => p.name === depName);
    if (!dep) return true;
    if (hasHealthCheck(dep) && this.health) return this.health.waitHealthy(appName, depName, timeoutMs);
    const startT = Date.now();
    while (Date.now() - startT < timeoutMs) {
      if (this.pm.isRunning(appName, depName)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.pm.isRunning(appName, depName);
  }

  /**
   * Make sure a process's dependencies are running and ready, auto-starting missing
   * ones (recursively). Returns an error message on failure, null when ready.
   */
  private async ensureDeps(
    app: AppDef, procDef: ProcessDef, mode: Mode, actor: ActorCtx, takeover: boolean,
    chain: Set<string> = new Set()
  ): Promise<string | null> {
    for (const depName of procDef.dependsOn) {
      if (chain.has(depName)) continue; // cycle guard
      const dep = app.processes.find((p) => p.name === depName);
      if (!dep) continue;
      if (!this.pm.isRunning(app.name, depName)) {
        chain.add(depName);
        const nested = await this.ensureDeps(app, dep, mode, actor, takeover, chain);
        if (nested) return nested;
        const outcome = await this.queue.enqueue(
          `${app.name}/${depName}`,
          `start(dep) by ${actor.session}`,
          async (): Promise<string | null> => {
            if (this.pm.isRunning(app.name, depName)) return null;
            try {
              const depMode: Mode = dep.devCommand && mode === 'dev' ? 'dev' : 'start';
              await this.pm.start(app, dep, depMode, actor.session, actor.source, takeover);
              this.store.audit({
                session: actor.session, source: actor.source, action: `start(${depMode})`,
                app: app.name, proc: depName, detail: `auto-started as dependency of '${procDef.name}'`,
                result: 'running',
              });
              return null;
            } catch (err: any) {
              return err.message;
            }
          }
        );
        if (!outcome.superseded && outcome.value) {
          return `dependency '${depName}' failed to start: ${outcome.value}`;
        }
      }
      if (!(await this.waitDepReady(app.name, depName))) {
        return `dependency '${depName}' did not become ready within 60s — start it manually or check its health`;
      }
    }
    return null;
  }

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
        `Another session is actively working on this app. If you are sure your action will not disrupt it, retry with force=true. ` +
        `(If '${lease.session}' is actually YOU — e.g. after a daemon restart or reconnect — call identify with that name and retry.)`,
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
    for (const p of this.topoSort(this.selectProcesses(app, proc))) {
      const outcome = await this.queue.enqueue(
        `${appName}/${p.name}`,
        `start(${mode}) by ${actor.session}`,
        async (): Promise<ProcResult> => {
          try {
            const depErr = await this.ensureDeps(app, p, mode, actor, takeover);
            if (depErr) {
              this.store.audit({
                session: actor.session, source: actor.source, action: `start(${mode})`,
                app: appName, proc: p.name, detail: reason, result: `error: ${depErr}`,
              });
              return { proc: p.name, state: this.pm.getState(appName, p.name), error: depErr };
            }
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
            const depErr = await this.ensureDeps(app, p, nextMode, actor, takeover);
            if (depErr) {
              this.store.audit({
                session: actor.session, source: actor.source, action: `restart(${nextMode})`,
                app: appName, proc: p.name, detail: reason, result: `error: ${depErr}`,
              });
              return { proc: p.name, state: this.pm.getState(appName, p.name), error: depErr };
            }
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

  /** Expand a profile name into concrete (app, proc?) targets. */
  resolveProfile(name: string): { app: string; proc?: string }[] {
    const targets = this.config.profiles[name];
    if (!targets) {
      const known = Object.keys(this.config.profiles).join(', ') || '(none)';
      throw new Error(`Unknown profile '${name}'. Known profiles: ${known}`);
    }
    return targets
      .map((t) => {
        const [app, proc] = t.split('/');
        return { app, proc: proc || undefined };
      })
      .filter((t) => this.config.getApp(t.app));
  }

  fullState() {
    const leases = this.store.allLeases();
    return {
      profiles: this.config.profiles,
      apps: this.config.apps.map((app) => ({
        name: app.name,
        description: app.description,
        cwd: app.cwd,
        env: app.env,
        environments: app.environments,
        activeEnvironment: app.activeEnvironment ?? null,
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
          dependsOn: p.dependsOn,
          health: this.health?.getHealth(app.name, p.name) ?? null,
          metrics: this.metrics?.latest.get(`${app.name}/${p.name}`) ?? null,
          ...this.pm.getState(app.name, p.name),
        })),
      })),
    };
  }
}
