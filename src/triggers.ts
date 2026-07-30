import { bus } from './events.js';
import { sendNotification } from './notify.js';
import { stripAnsiCodes } from './process-manager.js';
import type { ConfigStore, Trigger } from './config.js';
import type { Store } from './db.js';

/**
 * Watches every log line and fires alarms when a trigger's regex matches.
 * Alarms are persisted, pushed over SSE ('alarm' event) and optionally notified.
 */
export class TriggerEngine {
  private compiled: { t: Trigger; re: RegExp }[] = [];
  private lastFire = new Map<string, number>();

  constructor(private config: ConfigStore, private store: Store) {}

  start(): void {
    this.rebuild();
    bus.on('log', (e: { app: string; proc: string; line: string }) => this.onLog(e));
  }

  rebuild(): void {
    this.compiled = [];
    for (const t of this.config.triggers) {
      try {
        this.compiled.push({ t, re: new RegExp(t.pattern, 'i') });
      } catch {
        console.error(`[triggers] invalid pattern in trigger '${t.name}' — skipped`);
      }
    }
  }

  private onLog(e: { app: string; proc: string; line: string }): void {
    if (this.compiled.length === 0) return;
    const clean = stripAnsiCodes(e.line).slice(0, 2000);
    if (clean.includes('--- [controller]')) return;
    for (const { t, re } of this.compiled) {
      if (t.target !== '*') {
        const [ta, tp] = t.target.split('/');
        if (ta !== e.app) continue;
        if (tp && tp !== e.proc) continue;
      }
      if (!re.test(clean)) continue;
      const now = Date.now();
      if ((this.lastFire.get(t.name) ?? 0) > now - t.cooldownSeconds * 1000) continue;
      this.lastFire.set(t.name, now);

      const alarm = this.store.addAlarm({
        trigger: t.name,
        severity: t.severity,
        app: e.app,
        proc: e.proc,
        line: clean.slice(0, 500),
      });
      bus.emit('alarm', alarm);
      this.store.audit({
        session: 'system', source: 'system', action: `trigger(${t.severity})`,
        app: e.app, proc: e.proc, detail: `'${t.name}' matched: ${clean.slice(0, 120)}`,
        result: 'alarm',
      });
      if (t.notify) {
        void sendNotification(
          this.config,
          `${t.severity === 'critical' ? '🔴 ' : t.severity === 'warning' ? '🟠 ' : ''}${t.name} — ${e.app}/${e.proc}`,
          clean
        );
      }
    }
  }
}
