import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, resolveDataDir } from './config.js';
import { Store } from './db.js';
import { ProcessManager } from './process-manager.js';
import { Controller } from './controller.js';
import { HealthMonitor } from './health.js';
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

const app = createHttpServer(controller);
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`app-controller daemon listening on http://127.0.0.1:${PORT}`);
  console.log(`  MCP endpoint : http://127.0.0.1:${PORT}/mcp`);
  console.log(`  Web UI       : http://127.0.0.1:${PORT}/`);
  console.log(`  Config       : ${path.join(ROOT, 'apps.yaml')}`);
  if (process.env.APPCTRL_NO_RESTORE !== '1') {
    setTimeout(() => void restoreOnBoot(controller), 1000);
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[controller] ${signal} received — stopping managed processes...`);
  store.audit({
    session: 'system', source: 'system', action: 'daemon-shutdown', app: '*', detail: signal, result: 'ok',
  });
  await pm.stopAll();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
