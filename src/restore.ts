import type { Controller } from './controller.js';
import type { Mode } from './process-manager.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_ACTOR = { session: 'system', source: 'system' as const };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill an orphaned process group left over from a non-graceful daemon exit. */
async function reclaimOrphan(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
  }
  for (let i = 0; i < 10 && isAlive(pid); i++) await sleep(500);
  if (isAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(500);
  }
}

/**
 * Restore the processes that were running before the daemon went down.
 * If the previous daemon died non-gracefully (SIGKILL), its children are still
 * alive as orphans holding their ports — reclaim those first, then start fresh.
 */
export async function restoreOnBoot(controller: Controller): Promise<void> {
  const entries = controller.store.listRunning();
  if (entries.length === 0) return;

  console.log(`[restore] restoring ${entries.length} process(es) from previous run...`);

  // Build-once: when an app with a `prepare` command restores 2+ processes, run the
  // shared build first so the individual starts don't all compile the same projects
  // concurrently. Failure is non-fatal — processes fall back to building themselves.
  const perApp = new Map<string, number>();
  for (const e of entries) perApp.set(e.app, (perApp.get(e.app) ?? 0) + 1);
  const t0 = Date.now();
  const prepareMsByApp = new Map<string, number>();
  for (const [appName, count] of perApp) {
    const app = controller.config.getApp(appName);
    if (!app?.prepare || count < 2) continue;
    console.log(`[restore] running prepare for '${appName}' (${count} processes)...`);
    const tPrep = Date.now();
    try {
      await controller.ensurePrepared(app, SYSTEM_ACTOR);
    } catch (err: any) {
      console.error(`[restore] prepare for '${appName}' failed (continuing): ${err.message}`);
    }
    prepareMsByApp.set(appName, Date.now() - tPrep);
  }

  // Start everything IN PARALLEL: processes without dependsOn spawn immediately,
  // dependent ones wait for their dependency inside ensureDeps without blocking others.
  await Promise.all(
    entries.map(async (e) => {
      const app = controller.config.getApp(e.app);
      const procDef = app?.processes.find((p) => p.name === e.proc);
      if (!app || !procDef) {
        controller.store.clearRunning(e.app, e.proc);
        return;
      }
      if (e.pid && isAlive(e.pid)) {
        console.log(`[restore] reclaiming orphaned ${e.app}/${e.proc} (pid ${e.pid})`);
        await reclaimOrphan(e.pid);
      }
      try {
        // force=true: restore is authoritative — a leftover session/UI lease must not
        // prevent the daemon from bringing processes back after its own restart
        const res = await controller.start(
          e.app,
          e.proc,
          (e.mode as Mode) || 'start',
          'auto-restore after daemon startup',
          SYSTEM_ACTOR,
          true
        );
        const status = Array.isArray(res) ? res[0]?.state.status : 'conflict';
        console.log(`[restore] ${e.app}/${e.proc} (mode ${e.mode}) -> ${status}`);
      } catch (err: any) {
        console.error(`[restore] ${e.app}/${e.proc} failed: ${err.message}`);
      }
    })
  );

  // Record whole-app timing for restored apps (total = prepare + until healthy).
  for (const [appName, count] of perApp) {
    if (count >= 2) controller.trackAppStart(appName, t0, prepareMsByApp.get(appName) ?? 0, count);
  }
}
