/**
 * Per-key serial operation queue with last-request-wins coalescing.
 *
 * - Operations for the same key run strictly one at a time (no interleaved
 *   stop/start sequences on the same process).
 * - While an operation is running, at most ONE operation waits per key. A newer
 *   request replaces the waiting one — the replaced caller resolves immediately
 *   with { superseded: true, by: <newer label> } instead of executing.
 */
export type QueueOutcome<T> = { superseded: true; by: string } | { superseded: false; value: T };

interface PendingEntry {
  label: string;
  run: () => Promise<void>;
  supersede: (byLabel: string) => void;
}

export class KeyedQueue {
  private running = new Set<string>();
  private pending = new Map<string, PendingEntry>();

  enqueue<T>(key: string, label: string, fn: () => Promise<T>): Promise<QueueOutcome<T>> {
    return new Promise<QueueOutcome<T>>((resolve) => {
      const entry: PendingEntry = {
        label,
        run: async () => {
          try {
            resolve({ superseded: false, value: await fn() });
          } catch {
            // fn is expected to handle its own errors; resolve defensively
            resolve({ superseded: false, value: undefined as T });
          }
        },
        supersede: (byLabel) => resolve({ superseded: true, by: byLabel }),
      };

      this.pending.get(key)?.supersede(label);
      if (this.running.has(key)) {
        this.pending.set(key, entry);
      } else {
        this.runNow(key, entry);
      }
    });
  }

  private runNow(key: string, entry: PendingEntry): void {
    this.running.add(key);
    void entry.run().finally(() => {
      this.running.delete(key);
      const next = this.pending.get(key);
      if (next) {
        this.pending.delete(key);
        this.runNow(key, next);
      }
    });
  }
}
