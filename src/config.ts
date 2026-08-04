import fs from 'node:fs';
import os from 'node:os';
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
    // One-shot build/preparation command (run in the app cwd, same env layering as
    // processes) executed before EVERY start/restart operation of this app (whole-app,
    // single process, profile start, boot restore). Concurrent operations share one
    // run; a success within the last 30s is reused. Serializes the expensive shared
    // build instead of N processes compiling the same projects concurrently, and makes
    // `--no-build` launch commands safe (the build is always fresh at spawn time).
    prepare: z.string().optional(),
    prepareTimeoutMs: z.number().int().min(1000).default(600000),
    // One-shot "clear build cache" command (run in the app cwd, same env layering).
    // Invoked on demand via the clear_build_cache MCP tool / UI — e.g. delete obj/bin
    // and clear the package manager's cache so the NEXT build restores fresh packages.
    clean: z.string().optional(),
    cleanTimeoutMs: z.number().int().min(1000).default(600000),
    // Optional pause between process starts in a multi-process operation (ms) —
    // spreads out CPU/RAM spikes of heavy dev servers (webpack etc.)
    staggerMs: z.number().int().min(0).default(0),
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
  // Additional config files to load (absolute, ~-prefixed, or relative to THIS file).
  // Meant for configs that live INSIDE a repo and are shared by every developer via
  // git (e.g. ~/workspace/sources/monosign/core/fastBuild/app-controller.yaml).
  // For each included file X.yaml, a sibling X.local.yaml (gitignored, per-developer)
  // is deep-merged on top: apps matched by name, processes by name, env maps merged.
  // A relative app cwd inside an included file resolves against that file's directory,
  // so committed files stay machine-independent. Opt-in and non-invasive: an app you
  // define HERE (apps.yaml) always wins over a same-named included app, and editing an
  // included app via define_app / the UI forks a personal copy into this file.
  include: z.array(z.string()).default([]),
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

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

type Raw = Record<string, unknown>;

function mergeEnv(base: unknown, over: unknown): Raw {
  return { ...((base as Raw) ?? {}), ...((over as Raw) ?? {}) };
}

function mergeProcessRaw(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base, ...over };
  if (base?.env || over?.env) out.env = mergeEnv(base?.env, over?.env);
  return out;
}

/** Deep-merge a raw (pre-validation) app override onto a base app definition:
 * scalars/arrays replace, env/environments merge per key, processes merge by name. */
export function mergeAppRaw(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base, ...over };
  if (base?.env || over?.env) out.env = mergeEnv(base?.env, over?.env);
  if (base?.environments || over?.environments) {
    const envs: Raw = { ...((base?.environments as Raw) ?? {}) };
    for (const [k, v] of Object.entries((over?.environments as Raw) ?? {})) envs[k] = mergeEnv(envs[k], v);
    out.environments = envs;
  }
  if (base?.processes || over?.processes) {
    const procs: Raw[] = (((base?.processes as Raw[]) ?? [])).map((p) => ({ ...p }));
    for (const op of ((over?.processes as Raw[]) ?? [])) {
      const idx = procs.findIndex((p) => p?.name === op?.name);
      if (idx >= 0) procs[idx] = mergeProcessRaw(procs[idx], op);
      else procs.push(op);
    }
    out.processes = procs;
  }
  return out;
}

/** Derive the per-developer override path: foo.yaml -> foo.local.yaml */
export function localOverridePath(file: string): string {
  const ext = path.extname(file);
  return ext ? file.slice(0, -ext.length) + '.local' + ext : file + '.local';
}

export class ConfigStore {
  /** Apps defined directly in the daemon's own apps.yaml (writable via define_app/UI). */
  private mainApps: AppDef[] = [];
  /** Apps contributed by `include:` files (read-only; edit the file to change them). */
  private includedApps: AppDef[] = [];
  /** app name -> include file it came from (with note when a .local.yaml was merged) */
  private appOrigins = new Map<string, string>();
  /** Pre-merge raw layers of included apps — needed to know, per env var, whether it
   * lives in the shared file or the developer's .local.yaml override. */
  private includedRaw = new Map<string, { file: string; localFile: string; shared: Raw | null; local: Raw | null }>();
  /** include entries exactly as written in apps.yaml (preserved on save) */
  include: string[] = [];
  private includeFiles: { file: string; localFile: string }[] = [];
  private extraWatchers: fs.FSWatcher[] = [];

  envShell?: string;
  notify: { macos: boolean; slackWebhook?: string } = { macos: true };
  profiles: Record<string, string[]> = {};
  triggers: Trigger[] = [];
  onReload?: () => void;
  private saving = false;
  private reloadTimer: NodeJS.Timeout | null = null;
  private lastFingerprint = '';

  constructor(public readonly filePath: string) {
    this.load();
    this.watch();
  }

  /** Merged view. Your own apps.yaml definitions WIN over same-named included apps —
   * shared repo configs never override a user's personal setup. */
  get apps(): AppDef[] {
    if (this.includedApps.length === 0) return this.mainApps;
    const own = new Set(this.mainApps.map((a) => a.name));
    return [...this.mainApps, ...this.includedApps.filter((a) => !own.has(a.name))];
  }

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, YAML.stringify({ apps: [] }));
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = ConfigFileSchema.parse(YAML.parse(raw) ?? {});
    this.mainApps = parsed.apps;
    this.include = parsed.include;
    this.envShell = parsed.envShell;
    this.notify = parsed.notify;
    this.profiles = parsed.profiles;
    this.triggers = parsed.triggers;
    this.loadIncludes();
    this.watchIncludes();
    this.lastFingerprint = this.fingerprint();
  }

  /** mtime+size of every config file involved — used to skip reloads triggered by
   * unrelated filesystem events (fs.watch on directories can fire with null filename). */
  private fingerprint(): string {
    const files = [this.filePath, ...this.includeFiles.flatMap((f) => [f.file, f.localFile])];
    return files
      .map((f) => {
        try {
          const st = fs.statSync(f);
          return `${f}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${f}:absent`;
        }
      })
      .join('|');
  }

  private loadIncludes(): void {
    this.includedApps = [];
    this.appOrigins.clear();
    this.includedRaw.clear();
    this.includeFiles = [];
    const baseDir = path.dirname(this.filePath);
    for (const entry of this.include) {
      const file = path.resolve(baseDir, expandHome(entry));
      const localFile = localOverridePath(file);
      this.includeFiles.push({ file, localFile });
      if (!fs.existsSync(file)) {
        console.warn(`[config] include not found (skipped): ${file}`);
        continue;
      }
      let rawMain: Raw;
      try {
        rawMain = (YAML.parse(fs.readFileSync(file, 'utf8')) as Raw) ?? {};
      } catch (err) {
        console.error(`[config] include parse failed (skipped): ${file}:`, err);
        continue;
      }
      let rawLocal: Raw | null = null;
      if (fs.existsSync(localFile)) {
        try {
          rawLocal = (YAML.parse(fs.readFileSync(localFile, 'utf8')) as Raw) ?? {};
        } catch (err) {
          console.error(`[config] local override parse failed (ignored): ${localFile}:`, err);
        }
      }
      const apps: Raw[] = (Array.isArray(rawMain.apps) ? (rawMain.apps as Raw[]) : []).map((a) => ({ ...a }));
      const localApps: Raw[] = rawLocal && Array.isArray(rawLocal.apps) ? (rawLocal.apps as Raw[]) : [];
      for (const oa of localApps) {
        const idx = apps.findIndex((a) => a?.name === oa?.name);
        if (idx >= 0) apps[idx] = mergeAppRaw(apps[idx], oa);
        else apps.push(oa);
      }
      const dir = path.dirname(file);
      for (const rawApp of apps) {
        try {
          // Committed repo configs must stay machine-independent: a relative cwd
          // resolves against the include file's own directory.
          if (rawApp && typeof rawApp.cwd === 'string' && !path.isAbsolute(rawApp.cwd)) {
            rawApp.cwd = path.resolve(dir, rawApp.cwd);
          }
          const def = AppDefSchema.parse(rawApp);
          if (this.appOrigins.has(def.name)) {
            console.warn(`[config] app '${def.name}' already defined by ${this.appOrigins.get(def.name)} — duplicate in ${file} skipped`);
            continue;
          }
          this.includedApps.push(def);
          this.appOrigins.set(def.name, rawLocal ? `${file} (+ ${path.basename(localFile)})` : file);
          this.includedRaw.set(def.name, {
            file,
            localFile,
            shared: ((Array.isArray(rawMain.apps) ? (rawMain.apps as Raw[]) : []).find((a) => a?.name === def.name) as Raw) ?? null,
            local: (localApps.find((a) => a?.name === def.name) as Raw) ?? null,
          });
        } catch (err) {
          console.error(`[config] invalid app definition in ${file} (skipped):`, err);
        }
      }
      if (apps.length > 0) console.log(`[config] include loaded: ${file} (${apps.length} app(s)${rawLocal ? ', local override merged' : ''})`);
    }
    for (const a of this.mainApps) {
      if (this.appOrigins.has(a.name)) {
        console.log(`[config] app '${a.name}': using your ${path.basename(this.filePath)} definition (personal copy overrides include ${this.appOrigins.get(a.name)})`);
      }
    }
  }

  private scheduleReload(): void {
    if (this.saving) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      try {
        if (this.fingerprint() === this.lastFingerprint) return; // spurious event — nothing changed
        this.load();
        bus.emit('state');
        console.log('[config] configuration reloaded');
        this.onReload?.();
      } catch (err) {
        console.error('[config] reload failed, keeping previous config:', err);
      }
    }, 500);
  }

  private watch(): void {
    try {
      fs.watch(this.filePath, () => this.scheduleReload());
    } catch {
      // watching is best-effort
    }
  }

  /** Watch include files AND their (possibly not-yet-existing) .local.yaml siblings
   * by watching their parent directories — re-armed on every reload. */
  private watchIncludes(): void {
    for (const w of this.extraWatchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    this.extraWatchers = [];
    const byDir = new Map<string, Set<string>>();
    for (const f of this.includeFiles) {
      for (const p of [f.file, f.localFile]) {
        const dir = path.dirname(p);
        if (!byDir.has(dir)) byDir.set(dir, new Set());
        byDir.get(dir)!.add(path.basename(p));
      }
    }
    for (const [dir, names] of byDir) {
      if (!fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, (_event, filename) => {
          if (filename && !names.has(filename.toString())) return;
          this.scheduleReload();
        });
        this.extraWatchers.push(w);
      } catch {
        // watching is best-effort
      }
    }
  }

  save(): void {
    this.saving = true;
    try {
      // Only daemon-owned apps are persisted — included apps live in their own files.
      const doc: Record<string, unknown> = { apps: this.mainApps };
      if (this.include.length > 0) doc.include = this.include;
      if (this.envShell) doc.envShell = this.envShell;
      if (Object.keys(this.profiles).length > 0) doc.profiles = this.profiles;
      if (this.triggers.length > 0) doc.triggers = this.triggers;
      if (!this.notify.macos || this.notify.slackWebhook) doc.notify = this.notify;
      fs.writeFileSync(this.filePath, YAML.stringify(doc));
      this.lastFingerprint = this.fingerprint();
    } finally {
      setTimeout(() => (this.saving = false), 1000);
    }
    bus.emit('state');
  }

  getApp(name: string): AppDef | undefined {
    return this.apps.find((a) => a.name === name);
  }

  /** Include file the ACTIVE definition of an app comes from, or undefined when the
   * app is defined in apps.yaml itself (a personal definition always wins). */
  sourceOf(name: string): string | undefined {
    if (this.mainApps.some((a) => a.name === name)) return undefined;
    return this.appOrigins.get(name);
  }

  /** Copy-on-write: return the writable (apps.yaml-owned) definition of an app.
   * When the active definition comes from an include, fork a personal copy into
   * apps.yaml first — shared repo configs are never modified by the daemon. */
  materialize(name: string): AppDef | undefined {
    const own = this.mainApps.find((a) => a.name === name);
    if (own) return own;
    const inc = this.includedApps.find((a) => a.name === name);
    if (!inc) return undefined;
    const copy: AppDef = structuredClone(inc);
    this.mainApps.push(copy);
    console.log(`[config] app '${name}' forked from ${this.appOrigins.get(name)} into ${path.basename(this.filePath)} (personal copy)`);
    return copy;
  }

  upsertApp(def: AppDef): void {
    // Always writes to apps.yaml. If the name matches an included app this creates
    // (or updates) a personal copy that overrides the shared definition.
    const idx = this.mainApps.findIndex((a) => a.name === def.name);
    if (idx >= 0) this.mainApps[idx] = def;
    else this.mainApps.push(def);
    this.save();
  }

  /** Origin include file of an app (plain path, without the local-override note). */
  sourceFileOf(name: string): string | undefined {
    const origin = this.appOrigins.get(name);
    return origin ? origin.split(' (+')[0] : undefined;
  }

  /**
   * Per-variable storage of an included app's env: 'local' when the key comes from
   * the developer's X.local.yaml override, 'shared' when it comes from the shared
   * include file. null for apps owned by apps.yaml (everything is local there).
   */
  envOriginsOf(name: string): {
    env: Record<string, 'shared' | 'local'>;
    environments: Record<string, Record<string, 'shared' | 'local'>>;
    processes: Record<string, Record<string, 'shared' | 'local'>>;
  } | null {
    if (this.sourceOf(name) === undefined) return null;
    const info = this.includedRaw.get(name);
    const def = this.getApp(name);
    if (!info || !def) return null;
    const local = info.local ?? {};
    const localEnv = (local.env as Record<string, string>) ?? {};
    const localEnvs = (local.environments as Record<string, Record<string, string>>) ?? {};
    const localProcs = (Array.isArray(local.processes) ? (local.processes as Raw[]) : []);
    const originFor = (key: string, localRec: Record<string, string> | undefined): 'shared' | 'local' =>
      localRec && key in localRec ? 'local' : 'shared';
    return {
      env: Object.fromEntries(Object.keys(def.env).map((k) => [k, originFor(k, localEnv)])),
      environments: Object.fromEntries(
        Object.entries(def.environments).map(([set, rec]) => [
          set,
          Object.fromEntries(Object.keys(rec).map((k) => [k, originFor(k, localEnvs[set])])),
        ])
      ),
      processes: Object.fromEntries(
        def.processes.map((p) => {
          const lp = localProcs.find((x) => x?.name === p.name);
          const lpEnv = (lp?.env as Record<string, string>) ?? undefined;
          return [p.name, Object.fromEntries(Object.keys(p.env).map((k) => [k, originFor(k, lpEnv)]))];
        })
      ),
    };
  }

  /**
   * Persist env changes of an INCLUDED app, split by ownership: 'shared'-marked vars
   * go into the shared include file (surgical YAML-document edit — comments and the
   * rest of the file are preserved), 'local'-marked vars and activeEnvironment go
   * into the sibling X.local.yaml (per-developer, gitignored). A key flipped from
   * shared to local keeps its original value in the shared file (the local value
   * merely overrides it on this machine).
   */
  saveIncludedAppEnv(
    name: string,
    payload: {
      env: Record<string, string>;
      environments: Record<string, Record<string, string>>;
      activeEnvironment?: string;
      processEnv: Record<string, Record<string, string>>;
      origins: {
        env: Record<string, string>;
        environments: Record<string, Record<string, string>>;
        processes: Record<string, Record<string, string>>;
      };
    }
  ): { sharedFile: string; localFile: string; sharedChanged: boolean } {
    const info = this.includedRaw.get(name);
    if (!info) throw new Error(`App '${name}' is not provided by an include file`);
    const sharedOrig = info.shared ?? {};

    const split = (
      merged: Record<string, string>,
      origins: Record<string, string>,
      sharedPrev: Record<string, string> | undefined
    ): { shared: Record<string, string>; local: Record<string, string> } => {
      const shared: Record<string, string> = {};
      const local: Record<string, string> = {};
      for (const [k, v] of Object.entries(merged)) {
        if ((origins[k] ?? 'local') === 'shared') shared[k] = v;
        else {
          local[k] = v;
          // flipped shared→local: keep the team's value in the shared file
          if (sharedPrev && k in sharedPrev) shared[k] = sharedPrev[k];
        }
      }
      return { shared, local };
    };

    const envSplit = split(payload.env, payload.origins.env, sharedOrig.env as Record<string, string>);
    const sharedEnvs: Record<string, Record<string, string>> = {};
    const localEnvs: Record<string, Record<string, string>> = {};
    const sharedOrigEnvs = (sharedOrig.environments as Record<string, Record<string, string>>) ?? {};
    for (const [set, rec] of Object.entries(payload.environments)) {
      const s = split(rec, payload.origins.environments[set] ?? {}, sharedOrigEnvs[set]);
      if (Object.keys(s.shared).length > 0 || set in sharedOrigEnvs) sharedEnvs[set] = s.shared;
      if (Object.keys(s.local).length > 0) localEnvs[set] = s.local;
    }
    const sharedProcs: Record<string, Record<string, string>> = {};
    const localProcs: Record<string, Record<string, string>> = {};
    const sharedOrigProcs = (Array.isArray(sharedOrig.processes) ? (sharedOrig.processes as Raw[]) : []);
    for (const [proc, rec] of Object.entries(payload.processEnv)) {
      const prev = (sharedOrigProcs.find((p) => p?.name === proc)?.env as Record<string, string>) ?? undefined;
      const s = split(rec, payload.origins.processes[proc] ?? {}, prev);
      sharedProcs[proc] = s.shared;
      localProcs[proc] = s.local;
    }

    // --- shared file (only when its content actually changes) ---
    const norm = (env: unknown, envs: unknown, procs: Record<string, unknown>) =>
      JSON.stringify({ env: env ?? {}, envs: envs ?? {}, procs });
    const prevProcEnvs = Object.fromEntries(sharedOrigProcs.map((p) => [p?.name as string, p?.env ?? {}]));
    const nextProcEnvs = Object.fromEntries(Object.entries(sharedProcs).filter(([, v]) => Object.keys(v).length > 0));
    const sharedChanged =
      norm(sharedOrig.env, sharedOrig.environments, prevProcEnvs) !==
      norm(envSplit.shared, sharedEnvs, nextProcEnvs);

    this.saving = true;
    try {
      if (sharedChanged) {
        const doc = YAML.parseDocument(fs.readFileSync(info.file, 'utf8'));
        const appsNode = doc.get('apps') as YAML.YAMLSeq | undefined;
        const appNode = appsNode?.items.find(
          (it) => (it as YAML.YAMLMap).get?.('name') === name
        ) as YAML.YAMLMap | undefined;
        if (!appNode) throw new Error(`App '${name}' not found in ${info.file}`);
        const setOrDelete = (node: YAML.YAMLMap, key: string, value: Record<string, unknown>) => {
          if (Object.keys(value).length > 0) node.set(key, doc.createNode(value));
          else if (node.has(key)) node.delete(key);
        };
        setOrDelete(appNode, 'env', envSplit.shared);
        setOrDelete(appNode, 'environments', Object.fromEntries(Object.entries(sharedEnvs).filter(([, v]) => Object.keys(v).length > 0)));
        const procsNode = appNode.get('processes') as YAML.YAMLSeq | undefined;
        for (const it of procsNode?.items ?? []) {
          const pNode = it as YAML.YAMLMap;
          const pName = pNode.get?.('name') as string;
          if (pName in sharedProcs) setOrDelete(pNode, 'env', sharedProcs[pName]);
        }
        fs.writeFileSync(info.file, doc.toString());
      }

      // --- local override file (developer-owned; plain stringify is fine) ---
      let localRaw: Raw = {};
      if (fs.existsSync(info.localFile)) {
        try { localRaw = (YAML.parse(fs.readFileSync(info.localFile, 'utf8')) as Raw) ?? {}; } catch { localRaw = {}; }
      }
      const localAppsArr: Raw[] = Array.isArray(localRaw.apps) ? (localRaw.apps as Raw[]) : [];
      let entry = localAppsArr.find((a) => a?.name === name);
      if (!entry) {
        entry = { name };
        localAppsArr.push(entry);
      }
      if (Object.keys(envSplit.local).length > 0) entry.env = envSplit.local; else delete entry.env;
      if (Object.keys(localEnvs).length > 0) entry.environments = localEnvs; else delete entry.environments;
      if (payload.activeEnvironment) entry.activeEnvironment = payload.activeEnvironment; else delete entry.activeEnvironment;
      const prevProcOverrides: Raw[] = Array.isArray(entry.processes) ? (entry.processes as Raw[]) : [];
      const nextProcOverrides: Raw[] = [];
      const procNames = new Set([...Object.keys(localProcs), ...prevProcOverrides.map((p) => p?.name as string)]);
      for (const pName of procNames) {
        const prev = prevProcOverrides.find((p) => p?.name === pName) ?? { name: pName };
        const pEntry: Raw = { ...prev };
        const localEnv = localProcs[pName] ?? {};
        if (Object.keys(localEnv).length > 0) pEntry.env = localEnv; else delete pEntry.env;
        if (Object.keys(pEntry).length > 1) nextProcOverrides.push(pEntry); // more than just {name}
      }
      if (nextProcOverrides.length > 0) entry.processes = nextProcOverrides; else delete entry.processes;
      const meaningful = Object.keys(entry).length > 1;
      localRaw.apps = meaningful ? localAppsArr : localAppsArr.filter((a) => a !== entry);
      fs.writeFileSync(info.localFile, YAML.stringify(localRaw));
      this.lastFingerprint = this.fingerprint();
      this.load();
    } finally {
      setTimeout(() => (this.saving = false), 1000);
    }
    bus.emit('state');
    return { sharedFile: info.file, localFile: info.localFile, sharedChanged };
  }

  /** Drop schema-default values so committed shared configs stay minimal and
   * git diffs only show what actually changed. */
  private pruneDefaults(def: AppDef): Raw {
    const out: Raw = { name: def.name, cwd: def.cwd };
    if (def.description) out.description = def.description;
    if (Object.keys(def.env).length > 0) out.env = def.env;
    if (Object.keys(def.environments).length > 0) out.environments = def.environments;
    if (def.activeEnvironment) out.activeEnvironment = def.activeEnvironment;
    if (def.prepare) out.prepare = def.prepare;
    if (def.prepareTimeoutMs !== 600000) out.prepareTimeoutMs = def.prepareTimeoutMs;
    if (def.clean) out.clean = def.clean;
    if (def.cleanTimeoutMs !== 600000) out.cleanTimeoutMs = def.cleanTimeoutMs;
    if (def.staggerMs > 0) out.staggerMs = def.staggerMs;
    out.processes = def.processes.map((p) => {
      const o: Raw = { name: p.name, command: p.command };
      if (p.devCommand) o.devCommand = p.devCommand;
      if (p.cwd) o.cwd = p.cwd;
      if (Object.keys(p.env).length > 0) o.env = p.env;
      if (p.autoRestart) o.autoRestart = true;
      if (p.healthUrl) o.healthUrl = p.healthUrl;
      if (p.healthPort != null) o.healthPort = p.healthPort;
      if (p.ownLogTimestamps) o.ownLogTimestamps = true;
      if (p.ports.length > 0) o.ports = p.ports;
      if (p.dependsOn.length > 0) o.dependsOn = p.dependsOn;
      return o;
    });
    return out;
  }

  /** Write an app definition into the shared include file it originates from.
   * The rest of the file (other apps, comments, key order) is preserved via the
   * YAML document API. Any personal fork in apps.yaml is removed afterwards so
   * the shared definition becomes the active one again. Returns the file path.
   * Note: an existing X.local.yaml override still merges on top after reload. */
  upsertAppInSource(name: string, def: AppDef): string {
    const file = this.sourceFileOf(name);
    if (!file) throw new Error(`App '${name}' does not come from a shared config file`);
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    const apps = doc.get('apps');
    if (!YAML.isSeq(apps)) throw new Error(`No 'apps' list found in ${file}`);
    const out = this.pruneDefaults(def);
    // Committed configs must stay machine-independent: relativize cwd when possible
    const dir = path.dirname(file);
    if (typeof out.cwd === 'string' && path.isAbsolute(out.cwd)) {
      const rel = path.relative(dir, out.cwd);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) out.cwd = rel;
      else if (rel === '') out.cwd = '.';
    }
    const idx = apps.items.findIndex((it) => YAML.isMap(it) && it.get('name') === def.name);
    const node = doc.createNode(out);
    if (idx >= 0) apps.items[idx] = node;
    else apps.items.push(node);
    this.saving = true;
    try {
      fs.writeFileSync(file, doc.toString());
      const hadFork = this.mainApps.some((a) => a.name === def.name);
      this.mainApps = this.mainApps.filter((a) => a.name !== def.name);
      if (hadFork) this.save();
      this.load();
      this.lastFingerprint = this.fingerprint();
    } finally {
      setTimeout(() => (this.saving = false), 1000);
    }
    bus.emit('state');
    return file;
  }

  removeApp(name: string): boolean {
    const before = this.mainApps.length;
    this.mainApps = this.mainApps.filter((a) => a.name !== name);
    if (this.mainApps.length !== before) {
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
