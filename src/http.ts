import express from 'express';
import { randomUUID } from 'node:crypto';
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

  api.get('/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(controller.store.recentAudit(limit, (req.query.app as string) || undefined));
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

  api.get('/apps/:app/logs/:proc', (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 200, 2000);
    try {
      res.json({ logs: controller.pm.readLogs(req.params.app, req.params.proc, lines) });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/apps', (req, res) => {
    try {
      const def = AppDefSchema.parse(req.body);
      controller.config.upsertApp(def);
      controller.store.audit({
        session: 'ui', source: 'ui', action: 'define_app', app: def.name,
        detail: `${def.processes.length} process(es)`, result: 'saved',
      });
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
    bus.on('state', onState);
    bus.on('log', onLog);
    bus.on('audit', onAudit);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('state', onState);
      bus.off('log', onLog);
      bus.off('audit', onAudit);
    });
  });

  app.use('/api', api);

  // ---------- Static UI ----------
  const publicDir = path.resolve(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  return app;
}
