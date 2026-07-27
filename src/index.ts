import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, resolveDataDir } from './config.js';
import { Store } from './db.js';
import { ProcessManager } from './process-manager.js';
import { Controller } from './controller.js';
import { HealthMonitor } from './health.js';
import { MetricsMonitor } from './metrics.js';
import { captureShellEnv } from './env.js';
import { startNotifier } from './notify.js';
import { restoreOnBoot } from './restore.js';
import { createHttpServer } from './http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.APPCTRL_PORT) || 4780;

const { dataDir } = resolveDataDir(ROOT);
const logsDir = path.join(dataDir, 'logs');

const config = new ConfigStore(path.join(ROOT, 'apps.yaml'));
const store = new Store(dataDir);
const pm = new ProcessManager(logsDir, store);
const controller = new Controller(config, store, pm);
const health = new HealthMonitor(config, pm);
controller.health = health;
health.start();
const metrics = new MetricsMonitor(config, pm);
controller.metrics = metrics;
metrics.hydrate(store.getKv('metrics_history'));
metrics.start();
setInterval(() => store.setKv('metrics_history', metrics.serialize()), 60_000);
startNotifier(config);

// Managed apps inherit the login environment of the configured shell (apps.yaml envShell),
// independent of the user's registered default shell.
async function refreshBaseEnv(): Promise<void> {
  if (!config.envShell) return;
  try {
    pm.baseEnv = await captureShellEnv(config.envShell);
    console.log(`[env] captured ${Object.keys(pm.baseEnv).length} variables from ${config.envShell} (login shell)`);
  } catch (err: any) {
    console.error(`[env] failed to capture environment from '${config.envShell}': ${err.message}`);
  }
}
config.onReload = () => void refreshBaseEnv();

const app = createHttpServer(controller);
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`app-controller daemon listening on http://127.0.0.1:${PORT}`);
  console.log(`  MCP endpoint : http://127.0.0.1:${PORT}/mcp`);
  console.log(`  Web UI       : http://127.0.0.1:${PORT}/`);
  console.log(`  Config       : ${path.join(ROOT, 'apps.yaml')}`);
  setTimeout(async () => {
    await refreshBaseEnv(); // env must be ready before restored processes spawn
    if (process.env.APPCTRL_NO_RESTORE !== '1') await restoreOnBoot(controller);
  }, 500);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[controller] ${signal} received — stopping managed processes...`);
  store.setKv('metrics_history', metrics.serialize());
  store.audit({
    session: 'system', source: 'system', action: 'daemon-shutdown', app: '*', detail: signal, result: 'ok',
  });
  await pm.stopAll();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
