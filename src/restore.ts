import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Controller } from './controller.js';
import type { Mode } from './process-manager.js';
import { isPidAlive } from './process-manager.js';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_ACTOR = { session: 'system', source: 'system' as const };

/** Kill an orphaned process group left over from a non-graceful daemon exit. */
async function reclaimOrphan(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
  }
  for (let i = 0; i < 10 && isPidAlive(pid); i++) await sleep(500);
  if (isPidAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(500);
  }
}

/**
 * Sanity-check that a recorded pid still belongs to the process we spawned, not to
 * an unrelated process that reused the pid (e.g. after an OS reboot). Two checks:
 * the pid must still be its own process-group leader (we spawn detached, so our
 * children lead their groups), and it must have started BEFORE the restore record
 * was last written (a reused pid starts later).
 */
async function adoptablePid(
  pid: number, recordUpdatedAt: number | null
): Promise<{ startedAt: number } | null> {
  try {
    const { stdout } = await execFileP('ps', ['-o', 'pgid=,lstart=,command=', '-p', String(pid)]);
    const line = stdout.trim();
    if (!line) return null;
    const m = line.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+[\d ]\d\s+[\d:]{8}\s+\d{4})\s+/);
    if (!m) return null;
    if (Number(m[1]) !== pid) return null; // not a group leader → not ours
    const startedAt = Date.parse(m[2]);
    if (Number.isFinite(startedAt) && recordUpdatedAt && startedAt > recordUpdatedAt + 60_000) {
      return null; // started after we recorded it → pid was reused
    }
    return { startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() };
  } catch {
    return null;
  }
}

/**
 * Bring back the processes that were running before the daemon went down.
 * Preferred path: ADOPT — if the recorded pid is still alive and verifiably ours
 * (processes now log to their own file fds, so they survive daemon restarts),
 * re-attach it without any downtime. Otherwise fall back to a fresh start,
 * reclaiming orphaned process groups first.
 */
export async function restoreOnBoot(controller: Controller): Promise<void> {
  const entries = controller.store.listRunning();
  if (entries.length === 0) return;

  console.log(`[restore] checking ${entries.length} process(es) from previous run...`);

  type Entry = (typeof entries)[number];
  const toStart: Entry[] = [];

  // Phase 1: adopt everything that is still alive and verifiably ours.
  for (const e of entries) {
    const app = controller.config.getApp(e.app);
    const procDef = app?.processes.find((p) => p.name === e.proc);
    if (!app || !procDef) {
      controller.store.clearRunning(e.app, e.proc);
      continue;
    }
    if (e.pid && isPidAlive(e.pid)) {
      const info = await adoptablePid(e.pid, e.updatedAt);
      if (info) {
        controller.pm.adopt(app, procDef, (e.mode as Mode) || 'start', e.pid, info.startedAt);
        controller.health?.assumeReady(e.app, e.proc);
        controller.store.audit({
          session: 'system', source: 'system', action: 'adopt',
          app: e.app, proc: e.proc, detail: `pid ${e.pid} survived daemon restart`, result: 'adopted',
        });
        console.log(`[restore] adopted ${e.app}/${e.proc} (pid ${e.pid}, still running)`);
        continue;
      }
      console.log(`[restore] pid ${e.pid} of ${e.app}/${e.proc} is not adoptable (pid reuse?) — reclaiming`);
      await reclaimOrphan(e.pid);
    }
    toStart.push(e);
  }

  if (toStart.length === 0) return;
  console.log(`[restore] starting ${toStart.length} process(es) that did not survive...`);

  // Build-once: when an app with a `prepare` command restores 2+ processes, run the
  // shared build first so the individual starts don't all compile the same projects
  // concurrently. Failure is non-fatal — processes fall back to building themselves.
  const perApp = new Map<string, number>();
  for (const e of toStart) perApp.set(e.app, (perApp.get(e.app) ?? 0) + 1);
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
    toStart.map(async (e) => {
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
