import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Controller, ActorCtx, ConflictInfo, ProcResult } from './controller.js';
import { AppDefSchema } from './config.js';
import { stripAnsiCodes } from './process-manager.js';
import { bus } from './events.js';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function fmtState(results: ConflictInfo | ProcResult[], appName: string): ReturnType<typeof text> {
  if (!Array.isArray(results)) {
    return text(results.message);
  }
  const lines = results.map((r) => {
    const s = r.state;
    let line = `${appName}/${r.proc}: ${s.status}`;
    if (s.pid) line += ` (pid ${s.pid}, mode ${s.mode})`;
    if (r.superseded) line += ` — NOT EXECUTED: superseded by a newer queued request (${r.superseded}); the shown state is the current one`;
    if (r.ready === true) line += ` — health check passed, ready`;
    if (r.ready === false) line += ` — WARNING: did not become healthy within 30s (check app_logs)`;
    if (r.error) line += ` — ERROR: ${r.error}`;
    if (s.status === 'crashed' && s.lastExit) {
      line += ` — exit code ${s.lastExit.code}${s.lastExit.summary ? ` (${s.lastExit.summary})` : ''}`;
    }
    return line;
  });
  return text(lines.join('\n'));
}

const modeSchema = z.enum(['start', 'dev']).describe("Run mode: 'start' = normal, 'dev' = development mode");

export function buildMcpServer(controller: Controller, sessionId: string): McpServer {
  const actor: ActorCtx = { session: sessionId.slice(0, 8), source: 'mcp' };
  const server = new McpServer({ name: 'app-controller', version: '0.1.0' });

  server.registerTool(
    'identify',
    {
      title: 'Identify session',
      description:
        'Set a STABLE name for this session (e.g. "webapp-refactor"). Call this once at the start of your work. ' +
        'Leases, claims and audit entries are recorded under this name instead of a random connection id — so your ownership survives daemon restarts and reconnections. ' +
        'If you ever get a CONFLICT naming an identity that is actually you (after a reconnect), call identify with that name again and retry.',
      inputSchema: {
        name: z.string().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/, 'use letters, digits, dot, dash, underscore').describe('Short stable name for this agent/task, e.g. "checkout-fix"'),
      },
    },
    async ({ name }) => {
      const prev = actor.session;
      actor.session = name;
      return text(`Session identified as '${name}' (was '${prev}'). Leases and audit entries now use this identity; it survives reconnects as long as you re-identify with the same name.`);
    }
  );

  server.registerTool(
    'list_apps',
    {
      title: 'List apps',
      description:
        'List all registered applications with their processes, current status (running/stopped/crashed), pids, run mode, and active session leases. Always call this first to discover app and process names.',
      inputSchema: {},
    },
    async () => {
      const state = controller.fullState();
      if (state.apps.length === 0) return text('No apps registered yet. Use define_app to register one.');
      const lines: string[] = [];
      const profNames = Object.keys(state.profiles);
      if (profNames.length > 0) {
        lines.push(`Profiles: ${profNames.map((n) => `${n} → [${state.profiles[n].join(', ')}]`).join('; ')}`);
      }
      for (const app of state.apps) {
        lines.push(`# ${app.name}${app.description ? ` — ${app.description}` : ''} (cwd: ${app.cwd})`);
        if (app.lease) {
          const left = Math.round((app.lease.expires_at - Date.now()) / 1000);
          lines.push(`  LEASE: held by session '${app.lease.session}' for "${app.lease.reason}" (expires in ${left}s)`);
        }
        for (const p of app.processes) {
          let line = `  - ${p.name}: ${p.status}`;
          if (p.pid) line += ` (pid ${p.pid}, mode ${p.mode}, up since ${new Date(p.startedAt!).toISOString()})`;
          if (p.metrics) line += ` [cpu ${p.metrics.cpu}%, mem ${p.metrics.memMb}MB]`;
          if (p.health) line += ` [${p.health}]`;
          if (p.status === 'crashed' && p.lastExit) {
            line += ` (exit code ${p.lastExit.code}${p.lastExit.summary ? ` — ${p.lastExit.summary}` : ''})`;
          }
          lines.push(line);
        }
      }
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'start_app',
    {
      title: 'Start app',
      description:
        'Start an app (all its processes) or a single process. Use mode=dev to run the dev command. Requires a reason (shown to other sessions and in the audit log). If another Claude session holds a lease on the app you will get a CONFLICT response instead — read it and only retry with force=true if you are certain.',
      inputSchema: {
        app: z.string().describe('App name (see list_apps)'),
        process: z.string().optional().describe('Optional: start only this process of the app'),
        mode: modeSchema.default('start'),
        reason: z.string().describe('Why you are starting it, e.g. "testing auth fix on login page"'),
        force: z.boolean().default(false).describe('Override another session\'s lease. Use only when certain.'),
        wait_ready: z.boolean().default(true).describe('If the process has a health check defined, wait (max 30s) until it reports healthy before returning.'),
        takeover: z.boolean().default(false).describe('If a declared port is held by a process NOT started by the controller (e.g. started manually in a terminal), stop that process and run this one under controller management instead. Use only after a port-in-use error, when taking ownership is intended.'),
      },
    },
    async ({ app, process: proc, mode, reason, force, wait_ready, takeover }) => {
      const res = await controller.start(app, proc, mode, reason, actor, force, wait_ready, takeover);
      return fmtState(res, app);
    }
  );

  server.registerTool(
    'stop_app',
    {
      title: 'Stop app',
      description:
        'Stop an app (all processes) or a single process. Sends SIGTERM to the process group, escalates to SIGKILL after 6s. Same lease/conflict rules as start_app.',
      inputSchema: {
        app: z.string(),
        process: z.string().optional(),
        reason: z.string().describe('Why you are stopping it'),
        force: z.boolean().default(false),
      },
    },
    async ({ app, process: proc, reason, force }) => {
      const res = await controller.stop(app, proc, reason, actor, force);
      return fmtState(res, app);
    }
  );

  server.registerTool(
    'restart_app',
    {
      title: 'Restart app',
      description:
        'Restart an app or a single process. Keeps the previous run mode unless mode is given. IMPORTANT: never restart apps by killing pids or re-running commands yourself — always use this tool so other Claude sessions stay coordinated. Same lease/conflict rules as start_app.',
      inputSchema: {
        app: z.string(),
        process: z.string().optional(),
        mode: modeSchema.optional(),
        reason: z.string().describe('Why you are restarting it'),
        force: z.boolean().default(false),
        wait_ready: z.boolean().default(true).describe('If the process has a health check defined, wait (max 30s) until it reports healthy before returning.'),
        takeover: z.boolean().default(false).describe('If a declared port is held by a process NOT started by the controller, stop it and run this process under controller management instead.'),
      },
    },
    async ({ app, process: proc, mode, reason, force, wait_ready, takeover }) => {
      const res = await controller.restart(app, proc, mode, reason, actor, force, wait_ready, takeover);
      return fmtState(res, app);
    }
  );

  server.registerTool(
    'app_logs',
    {
      title: 'Get app logs',
      description:
        'Return the last N log lines of a process (stdout+stderr combined, timestamped). If the app has multiple processes and none is specified, returns logs of each.',
      inputSchema: {
        app: z.string(),
        process: z.string().optional(),
        lines: z.number().int().min(1).max(2000).default(100),
      },
    },
    async ({ app, process: proc, lines }) => {
      const appDef = controller.requireApp(app);
      const procs = controller.selectProcesses(appDef, proc);
      const out = procs.map((p) => {
        const logs = controller.pm.readLogs(app, p.name, lines, true);
        return `=== ${app}/${p.name} (last ${lines} lines) ===\n${logs || '(no logs yet)'}`;
      });
      return text(out.join('\n\n'));
    }
  );

  server.registerTool(
    'app_errors',
    {
      title: 'Recent errors',
      description:
        'Scan a process\'s recent logs and return ONLY the error/warning lines (with adjacent stack-trace lines grouped), deduplicated with counts and timestamps. ' +
        'Much cheaper than reading full app_logs when you just need to know what is failing.',
      inputSchema: {
        app: z.string(),
        process: z.string().optional().describe('Omit to scan every process of the app'),
        minutes: z.number().int().min(1).max(1440).default(30).describe('Only consider lines from the last N minutes'),
        lines: z.number().int().min(50).max(2000).default(600).describe('How many tail lines to scan per process'),
      },
    },
    async ({ app, process: proc, minutes, lines }) => {
      const appDef = controller.requireApp(app);
      const procs = controller.selectProcesses(appDef, proc);
      const cutoff = Date.now() - minutes * 60_000;
      const errRe = /error|exception|fatal|unhandled|panic|EADDRINUSE|address already in use|failed|warn/i;
      const contRe = /^\s+at |^\s{3,}|^Caused by|^\s*---/;
      const out: string[] = [];

      for (const p of procs) {
        const raw = controller.pm.readLogs(app, p.name, lines, true).split('\n');
        type Group = { text: string; count: number; first: string; last: string };
        const groups = new Map<string, Group>();
        let current: string[] | null = null;
        let currentTs = '';

        const flush = () => {
          if (!current) return;
          const text = current.slice(0, 6).join('\n');
          const dedupKey = current[0].replace(/\d+/g, '#').slice(0, 160);
          const g = groups.get(dedupKey);
          if (g) {
            g.count++;
            g.last = currentTs;
          } else {
            groups.set(dedupKey, { text, count: 1, first: currentTs, last: currentTs });
          }
          current = null;
        };

        for (const rawLine of raw) {
          const m = rawLine.match(/^\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]\s?(.*)$/);
          const ts = m ? m[1] : '';
          const body = m ? m[2] : rawLine;
          if (ts && Date.parse(ts) < cutoff) continue;
          if (body.startsWith('--- [controller]')) { flush(); continue; }
          if (current && contRe.test(body)) {
            current.push(body);
            continue;
          }
          flush();
          if (errRe.test(body) && body.trim()) {
            current = [body.trim()];
            currentTs = ts;
          }
        }
        flush();

        if (groups.size > 0) {
          out.push(`=== ${app}/${p.name} — ${groups.size} distinct error(s) in last ${minutes}m ===`);
          for (const g of groups.values()) {
            const when = g.count > 1 ? `${g.count}x, first ${g.first}, last ${g.last}` : g.last || 'unknown time';
            out.push(`[${when}]\n${g.text}`);
          }
        }
      }
      return text(out.length > 0 ? out.join('\n\n') : `No error/warning lines found in the last ${minutes} minutes.`);
    }
  );

  server.registerTool(
    'wait_for_log',
    {
      title: 'Wait for log line',
      description:
        'Wait until a process emits a log line matching a regex (case-insensitive), then return that line. ' +
        'Use this after start/restart to wait for readiness ("Compiled successfully", "Now listening on"), or to catch the next error ("error|exception"). ' +
        'Much better than polling app_logs in a loop. Optionally scans the last N existing lines first (lookback_lines).',
      inputSchema: {
        app: z.string(),
        process: z.string().optional().describe('Required if the app has more than one process'),
        pattern: z.string().describe('JavaScript regex, case-insensitive, e.g. "compiled successfully|ready in" or "error|exception"'),
        timeout_seconds: z.number().int().min(1).max(300).default(60),
        lookback_lines: z.number().int().min(0).max(500).default(0).describe('Also check this many existing tail lines before waiting (0 = only new lines)'),
      },
    },
    async ({ app, process: proc, pattern, timeout_seconds, lookback_lines }) => {
      const appDef = controller.requireApp(app);
      const procs = controller.selectProcesses(appDef, proc);
      if (procs.length !== 1) {
        return text(`App '${app}' has multiple processes (${procs.map((p) => p.name).join(', ')}) — specify one with the 'process' parameter.`);
      }
      const procName = procs[0].name;
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'i');
      } catch (err: any) {
        return text(`Invalid regex: ${err.message}`);
      }

      if (lookback_lines > 0) {
        const tail = controller.pm.readLogs(app, procName, lookback_lines, true).split('\n');
        const hit = [...tail].reverse().find((l) => re.test(l));
        if (hit) return text(`MATCHED (in existing logs): ${hit.trim()}`);
      }

      const started = Date.now();
      const result = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          bus.off('log', onLog);
          resolve(null);
        }, timeout_seconds * 1000);
        const onLog = (e: { app: string; proc: string; line: string }) => {
          if (e.app !== app || e.proc !== procName) return;
          const clean = stripAnsiCodes(e.line);
          if (re.test(clean)) {
            clearTimeout(timer);
            bus.off('log', onLog);
            resolve(clean);
          }
        };
        bus.on('log', onLog);
      });

      if (result) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        return text(`MATCHED after ${secs}s: ${result.trim()}`);
      }
      const context = controller.pm.readLogs(app, procName, 5, true);
      return text(
        `TIMEOUT: no line matching /${pattern}/i appeared within ${timeout_seconds}s.\nLast 5 log lines:\n${context || '(no logs)'}`
      );
    }
  );

  server.registerTool(
    'start_profile',
    {
      title: 'Start profile',
      description:
        'Start every target of a named profile (profiles are defined in apps.yaml, e.g. "dev: [monosign, monopam/app-vue]"). Targets start with dependency ordering; lease conflicts are reported per app.',
      inputSchema: {
        profile: z.string(),
        mode: modeSchema.default('start'),
        reason: z.string(),
        wait_ready: z.boolean().default(true),
      },
    },
    async ({ profile, mode, reason, wait_ready }) => {
      const targets = controller.resolveProfile(profile);
      const lines: string[] = [];
      for (const t of targets) {
        const res = await controller.start(t.app, t.proc, mode, reason, actor, false, wait_ready);
        lines.push((fmtState(res, t.app).content[0] as { text: string }).text);
      }
      return text(lines.join('\n') || `Profile '${profile}' has no valid targets.`);
    }
  );

  server.registerTool(
    'stop_profile',
    {
      title: 'Stop profile',
      description: 'Stop every target of a named profile.',
      inputSchema: { profile: z.string(), reason: z.string() },
    },
    async ({ profile, reason }) => {
      const targets = controller.resolveProfile(profile);
      const lines: string[] = [];
      for (const t of [...targets].reverse()) {
        const res = await controller.stop(t.app, t.proc, reason, actor, false);
        lines.push((fmtState(res, t.app).content[0] as { text: string }).text);
      }
      return text(lines.join('\n') || `Profile '${profile}' has no valid targets.`);
    }
  );

  server.registerTool(
    'claim_app',
    {
      title: 'Claim app',
      description:
        'Claim an app for a longer working session (default 30 min) so other Claude sessions see you are actively working on it and their start/stop/restart calls get a CONFLICT warning. Use when you begin a multi-step task on an app. Release with release_app when done.',
      inputSchema: {
        app: z.string(),
        minutes: z.number().int().min(1).max(480).default(30),
        reason: z.string().describe('What you are working on'),
      },
    },
    async ({ app, minutes, reason }) => {
      controller.requireApp(app);
      const existing = controller.checkConflict(app, actor, false);
      if (existing) return text(existing.message);
      const lease = controller.store.setLease(app, actor.session, reason, minutes * 60 * 1000);
      controller.store.audit({
        session: actor.session, source: 'mcp', action: 'claim', app,
        detail: reason, result: `claimed for ${minutes}m`,
      });
      return text(`Claimed '${app}' until ${new Date(lease.expires_at).toISOString()} (session ${actor.session}).`);
    }
  );

  server.registerTool(
    'release_app',
    {
      title: 'Release app',
      description: 'Release your claim/lease on an app so other sessions can manage it freely.',
      inputSchema: { app: z.string() },
    },
    async ({ app }) => {
      const ok = controller.store.releaseLease(app, actor.session);
      if (ok) {
        controller.store.audit({
          session: actor.session, source: 'mcp', action: 'release', app, detail: null, result: 'released',
        });
      }
      return text(ok ? `Released lease on '${app}'.` : `No lease held by this session on '${app}'.`);
    }
  );

  server.registerTool(
    'define_app',
    {
      title: 'Define app',
      description:
        'Register a new app or update an existing one (matched by name). An app has a working directory and one or more processes, each with a start command and optionally a dev command.',
      inputSchema: {
        name: z.string(),
        description: z.string().default(''),
        cwd: z.string().describe('Absolute path to the app root directory'),
        processes: z
          .array(
            z.object({
              name: z.string(),
              command: z.string().describe('Shell command for normal mode, e.g. "npm run start"'),
              devCommand: z.string().optional().describe('Shell command for dev mode, e.g. "npm run dev"'),
              cwd: z.string().optional().describe('Optional subdirectory relative to app cwd'),
              env: z.record(z.string()).default({}),
              autoRestart: z.boolean().default(false),
              healthUrl: z.string().optional().describe('Optional readiness URL, e.g. http://127.0.0.1:3000/ — any HTTP response < 500 counts as healthy'),
              healthPort: z.number().int().optional().describe('Optional readiness TCP port on 127.0.0.1 (used when no healthUrl)'),
              ownLogTimestamps: z.boolean().default(false).describe('Set true if the app\'s log lines already contain timestamps (UI then hides the controller prefix)'),
              ports: z.array(z.number().int()).default([]).describe('TCP ports the process binds — checked before start to fail fast on conflicts'),
              dependsOn: z.array(z.string()).default([]).describe('Sibling process names that must be running (and healthy if they have a check) before this one starts; missing deps auto-start first'),
            })
          )
          .min(1),
      },
    },
    async (input) => {
      const def = AppDefSchema.parse(input);
      controller.config.upsertApp(def);
      controller.store.audit({
        session: actor.session, source: 'mcp', action: 'define_app', app: def.name,
        detail: `${def.processes.length} process(es)`, result: 'saved',
      });
      return text(`App '${def.name}' saved with processes: ${def.processes.map((p) => p.name).join(', ')}.`);
    }
  );

  server.registerTool(
    'remove_app',
    {
      title: 'Remove app',
      description: 'Remove an app definition. Running processes of the app are stopped first.',
      inputSchema: { app: z.string(), reason: z.string() },
    },
    async ({ app, reason }) => {
      const appDef = controller.requireApp(app);
      const conflict = controller.checkConflict(app, actor, false);
      if (conflict) return text(conflict.message);
      for (const p of appDef.processes) await controller.pm.stop(app, p.name);
      controller.config.removeApp(app);
      controller.store.releaseLease(app);
      controller.store.audit({
        session: actor.session, source: 'mcp', action: 'remove_app', app, detail: reason, result: 'removed',
      });
      return text(`App '${app}' removed.`);
    }
  );

  server.registerTool(
    'recent_activity',
    {
      title: 'Recent activity',
      description:
        'Show the recent audit trail: which sessions (and the web UI) started/stopped/restarted which apps, when, and why. Useful before touching an app another session may be using.',
      inputSchema: {
        app: z.string().optional().describe('Filter to one app'),
        limit: z.number().int().min(1).max(200).default(30),
      },
    },
    async ({ app, limit }) => {
      const rows = controller.store.recentAudit(limit, app);
      if (rows.length === 0) return text('No activity recorded yet.');
      const lines = rows.map((r) => {
        const t = new Date(r.ts).toISOString();
        const target = r.proc ? `${r.app}/${r.proc}` : r.app;
        return `${t} [${r.source}:${r.session}] ${r.action} ${target} → ${r.result}${r.detail ? ` (${r.detail})` : ''}`;
      });
      return text(lines.join('\n'));
    }
  );

  // Logs as MCP resources: readable/attachable via logs://<app>/<process>
  server.registerResource(
    'process-logs',
    new ResourceTemplate('logs://{app}/{proc}', {
      list: async () => ({
        resources: controller.config.apps.flatMap((a) =>
          a.processes.map((p) => ({
            uri: `logs://${a.name}/${p.name}`,
            name: `${a.name}/${p.name} logs`,
            description: `Last log lines of ${a.name}/${p.name}`,
            mimeType: 'text/plain',
          }))
        ),
      }),
    }),
    { description: 'Recent log output of a managed process (ANSI-stripped)' },
    async (uri, vars) => {
      const app = String(vars.app);
      const proc = String(vars.proc);
      controller.requireApp(app);
      const logs = controller.pm.readLogs(app, proc, 300, true);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: logs || '(no logs yet)' }] };
    }
  );

  return server;
}
