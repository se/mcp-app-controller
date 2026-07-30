import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { bus } from './events.js';

export const ProcessDefSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  devCommand: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  autoRestart: z.boolean().default(false),
  // Optional readiness check: HTTP GET (any response < 500 counts as healthy) or TCP connect
  healthUrl: z.string().optional(),
  healthPort: z.number().int().optional(),
  // The app's own log lines already carry timestamps — the UI hides the controller's prefix
  ownLogTimestamps: z.boolean().default(false),
  // TCP ports this process binds; checked before start (fail fast on conflicts, reclaim own orphans)
  ports: z.array(z.number().int()).default([]),
  // Sibling processes that must be running (and healthy, if they have a health check)
  // before this one starts. Missing deps are auto-started first.
  dependsOn: z.array(z.string()).default([]),
});

export const AppDefSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    cwd: z.string().min(1),
    // App-wide env vars, applied to every process (process env overrides these)
    env: z.record(z.string()).default({}),
    // Named environment sets (dev/test/staging/prod ...); the active one is layered
    // between app-wide env and process env
    environments: z.record(z.record(z.string())).default({}),
    activeEnvironment: z.string().optional(),
    processes: z.array(ProcessDefSchema).min(1),
  })
  .superRefine((app, ctx) => {
    const names = new Set(app.processes.map((p) => p.name));
    for (const p of app.processes) {
      for (const d of p.dependsOn) {
        if (d === p.name) ctx.addIssue({ code: 'custom', message: `process '${p.name}' cannot depend on itself` });
        else if (!names.has(d)) ctx.addIssue({ code: 'custom', message: `process '${p.name}' dependsOn unknown process '${d}'` });
      }
    }
    if (app.activeEnvironment && !(app.activeEnvironment in app.environments)) {
      ctx.addIssue({ code: 'custom', message: `activeEnvironment '${app.activeEnvironment}' is not defined in environments` });
    }
  });

export const TriggerSchema = z.object({
  name: z.string().min(1),
  target: z.string().min(1), // "*" | "app" | "app/process"
  pattern: z.string().min(1), // case-insensitive regex tested against each log line
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  notify: z.boolean().default(true),
  cooldownSeconds: z.number().int().min(0).default(60),
});
export type Trigger = z.infer<typeof TriggerSchema>;

const ConfigFileSchema = z.object({
  apps: z.array(AppDefSchema).default([]),
  // Shell whose LOGIN environment is captured at daemon startup and injected into
  // every managed process (e.g. /opt/homebrew/bin/fish). Decouples app env from the
  // user's registered default shell — works even if chsh was never run.
  envShell: z.string().optional(),
  // Crash notifications (throttled to one per process per 5 minutes)
  notify: z
    .object({
      macos: z.boolean().default(true),
      slackWebhook: z.string().optional(),
    })
    .default({ macos: true }),
  // Named groups of targets ("app" or "app/process") for one-shot start/stop
  profiles: z.record(z.array(z.string())).default({}),
  // Log triggers: fire alarms (and notifications) when a log line matches
  triggers: z.array(TriggerSchema).default([]),
});

export type ProcessDef = z.infer<typeof ProcessDefSchema>;
export type AppDef = z.infer<typeof AppDefSchema>;

export class ConfigStore {
  apps: AppDef[] = [];
  envShell?: string;
  notify: { macos: boolean; slackWebhook?: string } = { macos: true };
  profiles: Record<string, string[]> = {};
  triggers: Trigger[] = [];
  onReload?: () => void;
  private saving = false;

  constructor(public readonly filePath: string) {
    this.load();
    this.watch();
  }

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, YAML.stringify({ apps: [] }));
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = ConfigFileSchema.parse(YAML.parse(raw) ?? {});
    this.apps = parsed.apps;
    this.envShell = parsed.envShell;
    this.notify = parsed.notify;
    this.profiles = parsed.profiles;
    this.triggers = parsed.triggers;
  }

  private watch(): void {
    let timer: NodeJS.Timeout | null = null;
    try {
      fs.watch(this.filePath, () => {
        if (this.saving) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            this.load();
            bus.emit('state');
            console.log('[config] apps.yaml reloaded');
            this.onReload?.();
          } catch (err) {
            console.error('[config] apps.yaml reload failed, keeping previous config:', err);
          }
        }, 500);
      });
    } catch {
      // watching is best-effort
    }
  }

  save(): void {
    this.saving = true;
    try {
      const doc: Record<string, unknown> = { apps: this.apps };
      if (this.envShell) doc.envShell = this.envShell;
      if (Object.keys(this.profiles).length > 0) doc.profiles = this.profiles;
      if (this.triggers.length > 0) doc.triggers = this.triggers;
      if (!this.notify.macos || this.notify.slackWebhook) doc.notify = this.notify;
      fs.writeFileSync(this.filePath, YAML.stringify(doc));
    } finally {
      setTimeout(() => (this.saving = false), 1000);
    }
    bus.emit('state');
  }

  getApp(name: string): AppDef | undefined {
    return this.apps.find((a) => a.name === name);
  }

  upsertApp(def: AppDef): void {
    // Resolve relative cwd against the home of the config file's parent git dir
    const idx = this.apps.findIndex((a) => a.name === def.name);
    if (idx >= 0) this.apps[idx] = def;
    else this.apps.push(def);
    this.save();
  }

  removeApp(name: string): boolean {
    const before = this.apps.length;
    this.apps = this.apps.filter((a) => a.name !== name);
    if (this.apps.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}

export function resolveDataDir(root: string): { dataDir: string; logsDir: string } {
  const dataDir = path.join(root, 'data');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  return { dataDir, logsDir };
}
