import express from 'express';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Controller } from './controller.js';
import { buildMcpServer } from './mcp.js';
import { bus } from './events.js';
import { AppDefSchema } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UI_ACTOR = { session: 'ui', source: 'ui' as const };

export function createHttpServer(controller: Controller) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ---------- MCP (Streamable HTTP) ----------
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    try {
      if (sid && transports.has(sid)) {
        await transports.get(sid)!.handleRequest(req, res, req.body);
        return;
      }
      // Unknown/expired session id (e.g. after a daemon restart): per MCP spec return
      // 404 so the client transparently re-initializes a fresh session. A 400 here
      // makes clients retry forever with the dead session id.
      if (sid && !transports.has(sid)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found — re-initialize' },
          id: null,
        });
        return;
      }
      if (!sid && isInitializeRequest(req.body)) {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = buildMcpServer(controller, randomUUID());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session' },
        id: null,
      });
    } catch (err) {
      console.error('[mcp] request error:', err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  const handleSessionReq = async (req: express.Request, res: express.Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      // 404 (not 400) so clients re-initialize after a daemon restart
      res.status(sid ? 404 : 400).send(sid ? 'Session not found — re-initialize' : 'Missing session ID');
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', handleSessionReq);
  app.delete('/mcp', handleSessionReq);

  // ---------- REST API for the web UI ----------
  const api = express.Router();

  api.get('/state', (_req, res) => {
    res.json(controller.fullState());
  });

  api.get('/version', (_req, res) => {
    res.json(controller.versionInfo ?? { commit: 'unknown', builtAt: null, startedAt: Date.now() });
  });

  api.get('/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(controller.store.recentAudit(limit, (req.query.app as string) || undefined));
  });

  api.delete('/audit', (req, res) => {
    const days = Number(req.query.olderThanDays);
    const olderThanMs = Number.isFinite(days) && days > 0 ? days * 86400_000 : undefined;
    const removed = controller.store.clearAudit(olderThanMs);
    controller.store.audit({
      session: 'ui', source: 'ui', action: 'clear_activity', app: '*',
      detail: olderThanMs ? `entries older than ${days}d` : 'all entries',
      result: `${removed} removed`,
    });
    res.json({ removed });
  });

  api.post('/apps/:app/start', async (req, res) => {
    const { process: proc, mode = 'start', reason = 'manual start from UI', waitReady = false, takeover = false } = req.body ?? {};
    const r = await controller.start(req.params.app, proc, mode, reason, UI_ACTOR, true, waitReady, takeover);
    res.json(r);
  });

  api.post('/apps/:app/stop', async (req, res) => {
    const { process: proc, reason = 'manual stop from UI' } = req.body ?? {};
    const r = await controller.stop(req.params.app, proc, reason, UI_ACTOR, true);
    res.json(r);
  });

  api.post('/apps/:app/restart', async (req, res) => {
    const { process: proc, mode, reason = 'manual restart from UI', waitReady = false, takeover = false } = req.body ?? {};
    const r = await controller.restart(req.params.app, proc, mode, reason, UI_ACTOR, true, waitReady, takeover);
    res.json(r);
  });

  api.post('/apps/:app/clean', async (req, res) => {
    const { reason = 'manual clean from UI' } = req.body ?? {};
    try {
      const msg = await controller.runClean(req.params.app, reason, UI_ACTOR);
      res.json({ ok: true, message: msg });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  api.get('/settings', (_req, res) => {
    res.json({
      envShell: controller.config.envShell ?? '',
      notify: controller.config.notify,
      profiles: controller.config.profiles,
      triggers: controller.config.triggers,
      envVarCount: Object.keys(controller.pm.baseEnv).length,
    });
  });

  api.put('/settings', (req, res) => {
    const { envShell, notify } = req.body ?? {};
    const shell = typeof envShell === 'string' ? envShell.trim() : '';
    if (shell && !fs.existsSync(shell)) {
      res.status(400).json({ error: `Shell not found at '${shell}' — use an absolute path (e.g. /opt/homebrew/bin/fish)` });
      return;
    }
    controller.config.envShell = shell || undefined;
    if (notify && typeof notify === 'object') {
      controller.config.notify = {
        macos: notify.macos !== false,
        slackWebhook: typeof notify.slackWebhook === 'string' && notify.slackWebhook.trim() ? notify.slackWebhook.trim() : undefined,
      };
    }
    controller.config.save();
    controller.config.onReload?.(); // re-capture environment with the new shell
    controller.store.audit({
      session: 'ui', source: 'ui', action: 'settings-updated', app: '*',
      detail: `envShell=${shell || '(none)'}, notify.macos=${controller.config.notify.macos}, slack=${controller.config.notify.slackWebhook ? 'set' : 'off'}`,
      result: 'saved',
    });
    res.json({ ok: true });
  });

  api.put('/profiles/:name', (req, res) => {
    const name = req.params.name.trim();
    const targets: unknown = req.body?.targets;
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      res.status(400).json({ error: 'Profile name: letters, digits, dot, dash, underscore only' });
      return;
    }
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string')) {
      res.status(400).json({ error: 'targets must be a non-empty array of "app" or "app/process" strings' });
      return;
    }
    for (const t of targets as string[]) {
      const [app, proc] = t.split('/');
      const appDef = controller.config.getApp(app);
      if (!appDef) {
        res.status(400).json({ error: `Unknown app '${app}' in target '${t}'` });
        return;
      }
      if (proc && !appDef.processes.some((p) => p.name === proc)) {
        res.status(400).json({ error: `App '${app}' has no process '${proc}' (target '${t}')` });
        return;
      }
    }
    controller.config.profiles[name] = targets as string[];
    controller.config.save();
    controller.store.audit({
      session: 'ui', source: 'ui', action: 'profile-saved', app: '*',
      detail: `${name} → [${(targets as string[]).join(', ')}]`, result: 'saved',
    });
    res.json({ ok: true });
  });

  api.delete('/profiles/:name', (req, res) => {
    if (!(req.params.name in controller.config.profiles)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    delete controller.config.profiles[req.params.name];
    controller.config.save();
    controller.store.audit({
      session: 'ui', source: 'ui', action: 'profile-removed', app: '*',
      detail: req.params.name, result: 'removed',
    });
    res.json({ ok: true });
  });

  api.post('/profiles/:name/:action(start|stop)', async (req, res) => {
    try {
      const targets = controller.resolveProfile(req.params.name);
      const results = [];
      const list = req.params.action === 'stop' ? [...targets].reverse() : targets;
      for (const t of list) {
        const r =
          req.params.action === 'start'
            ? await controller.start(t.app, t.proc, 'start', `profile '${req.params.name}' start from UI`, UI_ACTOR, true)
            : await controller.stop(t.app, t.proc, `profile '${req.params.name}' stop from UI`, UI_ACTOR, true);
        results.push({ target: t, result: r });
      }
      res.json(results);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Open an app's (or a single process's) working directory in the OS file manager.
  // Only configured cwds can be revealed — no arbitrary paths.
  api.post('/apps/:app/reveal', (req, res) => {
    try {
      const appDef = controller.requireApp(req.params.app);
      const proc = typeof req.body?.process === 'string' && req.body.process ? req.body.process : undefined;
      let dir = appDef.cwd;
      if (proc) {
        const p = appDef.processes.find((x) => x.name === proc);
        if (!p) throw new Error(`Unknown process '${proc}'`);
        if (p.cwd) dir = path.resolve(appDef.cwd, p.cwd);
      }
      if (!fs.existsSync(dir)) throw new Error(`Directory does not exist: ${dir}`);
      const [bin, args] =
        process.platform === 'darwin'
          ? ['open', [dir]]
          : process.platform === 'win32'
            ? ['explorer', [dir]]
            : ['xdg-open', [dir]];
      execFile(bin, args, () => { /* fire and forget */ });
      res.json({ ok: true, dir });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/apps/:app/release-lease', (req, res) => {
    const ok = controller.store.releaseLease(req.params.app);
    if (ok) {
      controller.store.audit({
        session: 'ui', source: 'ui', action: 'release', app: req.params.app,
        detail: 'lease released from UI', result: 'released',
      });
    }
    res.json({ ok });
  });

  api.get('/apps/:app/metrics/:proc', (req, res) => {
    res.json(controller.metrics?.getHistory(req.params.app, req.params.proc) ?? []);
  });

  // Environment captured from the login shell at daemon startup — what every managed
  // process inherits below app/process env. Sensitive values are masked unless ?reveal=1.
  api.get('/daemon/env', (req, res) => {
    const reveal = req.query.reveal === '1';
    const sensitive = /key|secret|password|token|pgp|auth|credential|_cs\b|connectionstring/i;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(controller.pm.baseEnv)) {
      vars[k] = !reveal && sensitive.test(k) ? '••••••••' : v;
    }
    res.json({ shell: controller.config.envShell ?? null, effectiveShell: controller.pm.baseEnvShell ?? null, vars });
  });

  // Re-run the login shell and swap in its current environment — no daemon restart
  // needed after editing shell config. Applies to processes started AFTER this call.
  api.post('/daemon/env/recapture', async (_req, res) => {
    if (controller.config.envShell === 'none') {
      res.status(400).json({ error: 'envShell is set to "none" in apps.yaml — capture is disabled.' });
      return;
    }
    try {
      const { captureShellEnv, defaultShell } = await import('./env.js');
      const shell = controller.config.envShell || defaultShell();
      controller.pm.baseEnv = await captureShellEnv(shell);
      controller.pm.baseEnvShell = shell;
      controller.store.audit({
        session: 'ui', source: 'ui', action: 'env-recapture', app: '*',
        detail: `re-captured login environment from ${shell}`, result: `${Object.keys(controller.pm.baseEnv).length} vars`,
      });
      res.json({ ok: true, count: Object.keys(controller.pm.baseEnv).length });
    } catch (err: any) {
      res.status(500).json({ error: `Shell env capture failed: ${err.message}` });
    }
  });

  api.get('/apps/:app/logs/:proc', (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 200, 2000);
    try {
      if (typeof req.query.around === 'string' && req.query.around) {
        res.json({ logs: controller.pm.readLogsAround(req.params.app, req.params.proc, req.query.around, 250) });
        return;
      }
      res.json({ logs: controller.pm.readLogs(req.params.app, req.params.proc, lines) });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- Alarms & triggers ----------
  api.get('/alarms', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(controller.store.listAlarms(limit, req.query.active === '1'));
  });
  api.post('/alarms/:id/ack', (req, res) => {
    res.json({ acked: controller.store.ackAlarm(Number(req.params.id)) });
  });
  api.post('/alarms/ack-all', (_req, res) => {
    res.json({ acked: controller.store.ackAlarm() });
  });
  api.delete('/alarms', (_req, res) => {
    res.json({ removed: controller.store.clearAlarms() });
  });

  api.put('/triggers/:name', (req, res) => {
    const name = req.params.name.trim();
    const { target = '*', pattern, severity = 'warning', notify = true, cooldownSeconds = 60 } = req.body ?? {};
    if (!/^[a-zA-Z0-9._ -]+$/.test(name)) {
      res.status(400).json({ error: 'Trigger name: letters, digits, space, dot, dash, underscore only' });
      return;
    }
    if (typeof pattern !== 'string' || !pattern) {
      res.status(400).json({ error: 'pattern is required' });
      return;
    }
    try {
      new RegExp(pattern, 'i');
    } catch (err: any) {
      res.status(400).json({ error: `Invalid regex: ${err.message}` });
      return;
    }
    if (target !== '*') {
      const [app, proc] = String(target).split('/');
      const appDef = controller.config.getApp(app);
      if (!appDef) {
        res.status(400).json({ error: `Unknown app '${app}' in target` });
        return;
      }
      if (proc && !appDef.processes.some((p) => p.name === proc)) {
        res.status(400).json({ error: `App '${app}' has no process '${proc}'` });
        return;
      }
    }
    if (!['info', 'warning', 'critical'].includes(severity)) {
      res.status(400).json({ error: 'severity must be info | warning | critical' });
      return;
    }
    const trigger = { name, target: String(target), pattern, severity, notify: notify !== false, cooldownSeconds: Math.max(0, Number(cooldownSeconds) || 0) };
    const idx = controller.config.triggers.findIndex((t) => t.name === name);
    if (idx >= 0) controller.config.triggers[idx] = trigger;
    else controller.config.triggers.push(trigger);
    controller.config.save();
    controller.config.onReload?.();
    controller.store.audit({
      session: 'ui', source: 'ui', action: 'trigger-saved', app: '*',
      detail: `${name}: /${pattern}/i on ${trigger.target} (${severity})`, result: 'saved',
    });
    res.json({ ok: true });
  });

  api.delete('/triggers/:name', (req, res) => {
    const before = controller.config.triggers.length;
    controller.config.triggers = controller.config.triggers.filter((t) => t.name !== req.params.name);
    if (controller.config.triggers.length === before) {
      res.status(404).json({ error: 'Trigger not found' });
      return;
    }
    controller.config.save();
    controller.config.onReload?.();
    controller.store.audit({
      session: 'ui', source: 'ui', action: 'trigger-removed', app: '*', detail: req.params.name, result: 'removed',
    });
    res.json({ ok: true });
  });

  // ---------- App environment layers ----------
  api.put('/apps/:app/env', (req, res) => {
    try {
      controller.requireApp(req.params.app);
      // Include-provided app + per-var origins → split-write: 'shared' vars into the
      // shared include file, 'local' vars (and activeEnvironment) into X.local.yaml.
      // No fork — the app stays shared.
      if (controller.config.sourceOf(req.params.app) !== undefined && req.body?.origins) {
        const { env = {}, environments = {}, activeEnvironment, processEnv = {}, origins } = req.body;
        const result = controller.config.saveIncludedAppEnv(req.params.app, {
          env, environments, activeEnvironment: activeEnvironment || undefined, processEnv, origins,
        });
        controller.store.audit({
          session: 'ui', source: 'ui', action: 'env-updated', app: req.params.app,
          detail: `split-write: shared=${result.sharedChanged ? path.basename(result.sharedFile) : 'unchanged'}, local=${path.basename(result.localFile)}`,
          result: 'saved',
        });
        res.json({ ok: true, restartRequired: true, sharedFile: result.sharedFile, localFile: result.localFile, sharedChanged: result.sharedChanged });
        return;
      }
      // Copy-on-write: editing an include-provided app forks a personal copy into apps.yaml
      const appDef = controller.config.materialize(req.params.app)!;
      const { env, environments, activeEnvironment, processEnv } = req.body ?? {};
      const rec = (v: unknown): Record<string, string> | null =>
        v && typeof v === 'object' && Object.values(v as object).every((x) => typeof x === 'string')
          ? (v as Record<string, string>)
          : null;
      if (env !== undefined) {
        const r = rec(env);
        if (!r) throw new Error('env must be a string map');
        appDef.env = r;
      }
      if (environments !== undefined) {
        if (!environments || typeof environments !== 'object') throw new Error('environments must be a map of string maps');
        const out: Record<string, Record<string, string>> = {};
        for (const [k, v] of Object.entries(environments as object)) {
          const r = rec(v);
          if (!r) throw new Error(`environment '${k}' must be a string map`);
          out[k] = r;
        }
        appDef.environments = out;
      }
      if (activeEnvironment !== undefined) {
        const active = typeof activeEnvironment === 'string' && activeEnvironment ? activeEnvironment : undefined;
        if (active && !(active in appDef.environments)) throw new Error(`environment '${active}' is not defined`);
        appDef.activeEnvironment = active;
      }
      if (processEnv !== undefined && processEnv && typeof processEnv === 'object') {
        for (const [procName, v] of Object.entries(processEnv as object)) {
          const p = appDef.processes.find((x) => x.name === procName);
          if (!p) throw new Error(`Unknown process '${procName}'`);
          const r = rec(v);
          if (!r) throw new Error(`processEnv['${procName}'] must be a string map`);
          p.env = r;
        }
      }
      controller.config.save();
      controller.store.audit({
        session: 'ui', source: 'ui', action: 'env-updated', app: req.params.app,
        detail: `activeEnvironment=${appDef.activeEnvironment ?? '(none)'}; envs=[${Object.keys(appDef.environments).join(', ')}]`,
        result: 'saved',
      });
      res.json({ ok: true, restartRequired: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/apps', (req, res) => {
    try {
      const { saveTo, ...body } = (req.body ?? {}) as Record<string, unknown>;
      const def = AppDefSchema.parse(body);
      if (saveTo === 'source') {
        const file = controller.config.upsertAppInSource(def.name, def);
        controller.store.audit({
          session: 'ui', source: 'ui', action: 'define_app', app: def.name,
          detail: `${def.processes.length} process(es) → shared config ${file}`, result: 'saved',
        });
      } else {
        controller.config.upsertApp(def);
        controller.store.audit({
          session: 'ui', source: 'ui', action: 'define_app', app: def.name,
          detail: `${def.processes.length} process(es)`, result: 'saved',
        });
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/apps/:app', async (req, res) => {
    try {
      const appDef = controller.requireApp(req.params.app);
      for (const p of appDef.processes) await controller.pm.stop(req.params.app, p.name);
      controller.config.removeApp(req.params.app);
      controller.store.releaseLease(req.params.app);
      controller.store.audit({
        session: 'ui', source: 'ui', action: 'remove_app', app: req.params.app, detail: null, result: 'removed',
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Server-sent events for live UI updates
  api.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (type: string, data: unknown) => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };
    const onState = () => send('state', null);
    const onLog = (payload: unknown) => send('log', payload);
    const onAudit = (payload: unknown) => send('audit', payload);
    const onMetrics = (payload: unknown) => send('metrics', payload);
    const onAlarm = (payload: unknown) => send('alarm', payload);
    bus.on('state', onState);
    bus.on('log', onLog);
    bus.on('audit', onAudit);
    bus.on('metrics', onMetrics);
    bus.on('alarm', onAlarm);
    // Real event (not an SSE comment) so the client can use it as a liveness heartbeat
    const ping = setInterval(() => send('ping', null), 25000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('state', onState);
      bus.off('log', onLog);
      bus.off('audit', onAudit);
      bus.off('metrics', onMetrics);
      bus.off('alarm', onAlarm);
    });
  });

  app.use('/api', api);

  // ---------- Static UI ----------
  const publicDir = path.resolve(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  return app;
}
