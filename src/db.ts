import Database from 'better-sqlite3';
import path from 'node:path';
import { bus } from './events.js';

export interface AuditEntry {
  id?: number;
  ts: number;
  session: string;
  source: 'mcp' | 'ui' | 'system';
  action: string;
  app: string;
  proc?: string | null;
  detail?: string | null;
  result: string;
}

export interface Lease {
  app: string;
  session: string;
  reason: string;
  acquired_at: number;
  expires_at: number;
}

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, 'controller.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        app TEXT NOT NULL,
        proc TEXT,
        detail TEXT,
        result TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
      CREATE TABLE IF NOT EXISTS leases (
        app TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        reason TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS restore_state (
        app TEXT NOT NULL,
        proc TEXT NOT NULL,
        mode TEXT NOT NULL,
        pid INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (app, proc)
      );
    `);
  }

  audit(entry: Omit<AuditEntry, 'id' | 'ts'> & { ts?: number }): AuditEntry {
    const full: AuditEntry = { ts: entry.ts ?? Date.now(), ...entry } as AuditEntry;
    const info = this.db
      .prepare(
        `INSERT INTO audit (ts, session, source, action, app, proc, detail, result)
         VALUES (@ts, @session, @source, @action, @app, @proc, @detail, @result)`
      )
      .run({ proc: null, detail: null, ...full });
    full.id = Number(info.lastInsertRowid);
    bus.emit('audit', full);
    return full;
  }

  recentAudit(limit = 50, app?: string): AuditEntry[] {
    if (app) {
      return this.db
        .prepare(`SELECT * FROM audit WHERE app = ? ORDER BY ts DESC LIMIT ?`)
        .all(app, limit) as AuditEntry[];
    }
    return this.db.prepare(`SELECT * FROM audit ORDER BY ts DESC LIMIT ?`).all(limit) as AuditEntry[];
  }

  getLease(app: string): Lease | undefined {
    const lease = this.db.prepare(`SELECT * FROM leases WHERE app = ?`).get(app) as Lease | undefined;
    if (lease && lease.expires_at <= Date.now()) {
      this.db.prepare(`DELETE FROM leases WHERE app = ?`).run(app);
      return undefined;
    }
    return lease;
  }

  allLeases(): Lease[] {
    this.db.prepare(`DELETE FROM leases WHERE expires_at <= ?`).run(Date.now());
    return this.db.prepare(`SELECT * FROM leases`).all() as Lease[];
  }

  setLease(app: string, session: string, reason: string, ttlMs: number): Lease {
    const now = Date.now();
    const existing = this.getLease(app);
    // A longer claim by the same session is not shortened by an action's short lease
    const expires_at = existing && existing.session === session
      ? Math.max(existing.expires_at, now + ttlMs)
      : now + ttlMs;
    const lease: Lease = { app, session, reason, acquired_at: now, expires_at };
    this.db
      .prepare(
        `INSERT INTO leases (app, session, reason, acquired_at, expires_at)
         VALUES (@app, @session, @reason, @acquired_at, @expires_at)
         ON CONFLICT(app) DO UPDATE SET session=@session, reason=@reason, acquired_at=@acquired_at, expires_at=@expires_at`
      )
      .run(lease);
    bus.emit('state');
    return lease;
  }

  /** Desired-state tracking: which processes should be running (for boot restore). */
  setRunning(app: string, proc: string, mode: string, pid?: number): void {
    this.db
      .prepare(
        `INSERT INTO restore_state (app, proc, mode, pid, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app, proc) DO UPDATE SET mode=excluded.mode, pid=excluded.pid, updated_at=excluded.updated_at`
      )
      .run(app, proc, mode, pid ?? null, Date.now());
  }

  clearRunning(app: string, proc?: string): void {
    if (proc) this.db.prepare(`DELETE FROM restore_state WHERE app = ? AND proc = ?`).run(app, proc);
    else this.db.prepare(`DELETE FROM restore_state WHERE app = ?`).run(app);
  }

  listRunning(): { app: string; proc: string; mode: string; pid: number | null }[] {
    return this.db.prepare(`SELECT app, proc, mode, pid FROM restore_state`).all() as {
      app: string; proc: string; mode: string; pid: number | null;
    }[];
  }

  releaseLease(app: string, session?: string): boolean {
    const lease = this.getLease(app);
    if (!lease) return false;
    if (session && lease.session !== session) return false;
    this.db.prepare(`DELETE FROM leases WHERE app = ?`).run(app);
    bus.emit('state');
    return true;
  }
}
