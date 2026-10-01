import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Status = 'queued' | 'processing' | 'succeeded' | 'dead';
export interface Job {
  id: string; type: string; payload: string; hash: string; status: Status;
  attempts: number; max_attempts: number; next_at: number; lease_until: number | null;
  lease_token: string | null; error: string | null; created_at: number; updated_at: number;
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','processing','succeeded','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
        next_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, next_at);
      CREATE TABLE IF NOT EXISTS history (
        sequence INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
        action TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS history_job ON history(job_id, sequence);
    `);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  record(id: string, action: string, detail: string, now: number) {
    this.db.prepare('INSERT INTO history(job_id,action,detail,at) VALUES(?,?,?,?)')
      .run(id, action, detail, now);
  }

  get(id: string): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job | undefined;
  }

  enqueue(id: string, type: string, payload: string, now = Date.now()): 'accepted' | 'duplicate' | 'conflict' {
    const hash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      const existing = this.get(id);
      if (existing) return existing.hash === hash ? 'duplicate' : 'conflict';
      this.db.prepare(`INSERT INTO jobs(id,type,payload,hash,status,next_at,created_at,updated_at)
        VALUES(?,?,?,?,'queued',?,?,?)`).run(id, type, payload, hash, now, now, now);
      this.record(id, 'accepted', 'Signature verified; persisted before acknowledgement', now);
      return 'accepted';
    });
  }

  claim(now = Date.now(), leaseMs = 30_000): Job | undefined {
    return this.transaction(() => {
      // A crash consumes an attempt too. Never leave the final expired lease stuck forever.
      const exhausted = this.db.prepare(`SELECT id FROM jobs WHERE status='processing'
        AND lease_until<=? AND attempts>=max_attempts`).all(now);
      for (const row of exhausted) {
        this.db.prepare(`UPDATE jobs SET status='dead',error='Worker lease expired on final attempt',
          lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?`).run(now, row.id);
        this.record(String(row.id), 'dead', 'Worker lease expired on final attempt', now);
      }
      const job = this.db.prepare(`SELECT * FROM jobs WHERE attempts<max_attempts AND
        ((status='queued' AND next_at<=?) OR (status='processing' AND lease_until<=?))
        ORDER BY next_at,created_at,id LIMIT 1`).get(now, now) as unknown as Job | undefined;
      if (!job) return undefined;
      const token = randomUUID();
      this.db.prepare(`UPDATE jobs SET status='processing', attempts=attempts+1,
        lease_token=?,lease_until=?,updated_at=? WHERE id=?`).run(token, now + leaseMs, now, job.id);
      this.record(job.id, job.status === 'processing' ? 'reclaimed' : 'claimed',
        `Attempt ${job.attempts + 1}/${job.max_attempts}`, now);
      return this.get(job.id);
    });
  }

  finish(id: string, token: string, error?: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const job = this.get(id);
      if (!job || job.status !== 'processing' || job.lease_token !== token || job.lease_until! <= now) return false;
      const status = error === undefined ? 'succeeded' : job.attempts >= job.max_attempts ? 'dead' : 'queued';
      const delay = Math.min(60_000, 1000 * 2 ** (job.attempts - 1));
      this.db.prepare(`UPDATE jobs SET status=?,error=?,next_at=?,lease_token=NULL,
        lease_until=NULL,updated_at=? WHERE id=?`).run(status, error?.slice(0, 500) ?? null, now + delay, now, id);
      this.record(id, status === 'queued' ? 'retry_scheduled' : status,
        error?.slice(0, 500) ?? 'Handler completed', now);
      return true;
    });
  }

  retry(id: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE jobs SET status='queued',attempts=0,error=NULL,
        next_at=?,updated_at=? WHERE id=? AND status='dead'`).run(now, now, id);
      if (!result.changes) return false;
      this.record(id, 'redriven', 'Operator started a new attempt cycle', now);
      return true;
    });
  }

  list() {
    return this.db.prepare(`SELECT id,type,status,attempts,max_attempts,error,created_at,updated_at,next_at
      FROM jobs ORDER BY created_at DESC,id LIMIT 100`).all();
  }
  history(id: string) {
    return this.db.prepare('SELECT action,detail,at FROM history WHERE job_id=? ORDER BY sequence DESC LIMIT 100').all(id);
  }
  stats() {
    const counts = { queued: 0, processing: 0, succeeded: 0, dead: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status').all()) {
      counts[row.status as Status] = Number(row.count);
    }
    return counts;
  }
  close() { this.db.close(); }
}
