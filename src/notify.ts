import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bus } from './events.js';
import type { ConfigStore } from './config.js';

const execFileP = promisify(execFile);

export interface CrashEvent {
  app: string;
  proc: string;
  code: number | null;
  summary?: string;
}

/** Sends crash notifications (macOS notification center + optional Slack webhook). */
export function startNotifier(config: ConfigStore): void {
  const lastNotified = new Map<string, number>();

  bus.on('crash', (e: CrashEvent) => {
    void (async () => {
      const key = `${e.app}/${e.proc}`;
      const now = Date.now();
      if ((lastNotified.get(key) ?? 0) > now - 5 * 60_000) return; // throttle per process
      lastNotified.set(key, now);

      const title = `${key} crashed (exit ${e.code ?? '?'})`;
      const body = (e.summary || 'see logs in the dashboard').slice(0, 160);

      if (config.notify.macos) {
        try {
          await execFileP('osascript', [
            '-e',
            `display notification ${JSON.stringify(body)} with title "App Controller" subtitle ${JSON.stringify(title)}`,
          ]);
        } catch {
          // notification center unavailable — ignore
        }
      }
      if (config.notify.slackWebhook) {
        try {
          await fetch(config.notify.slackWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `:rotating_light: *${title}*\n${body}` }),
          });
        } catch {
          // webhook failure is non-fatal
        }
      }
    })();
  });
}
