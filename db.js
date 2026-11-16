/* Database layer. The rest of the service talks to this small interface only:
 *   db.query(sql, params) -> {rows}
 *   db.exec(sql)          -> run a multi-statement script (migrations)
 *   db.tryLeaderLock()    -> boolean, holds a session-level advisory lock on a dedicated connection
 *   db.leaderAlive()      -> boolean, false if the lock connection is gone
 *   db.releaseLeader(), db.close()
 * Production uses node-postgres (createPgDb). Tests use the same SQL against a real PostgreSQL through a psql-backed driver. */

const LEADER_KEY = 7351001; /* arbitrary fixed int for pg_try_advisory_lock; unique to this service's database */

export function createPgDb({ Pool, Client, connectionString, ssl = false, max = 5 }) {
  const cfg = { connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined };
  const pool = new Pool({ ...cfg, max, statement_timeout: 10000, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  pool.on('error', () => { /* idle client errors must not crash the process */ });
  let lockClient = null;
  return {
    kind: 'pg',
    async query(sql, params = []) { const r = await pool.query(sql, params); return { rows: r.rows }; },
    async exec(sql) {
      const c = await pool.connect();
      try { await c.query(sql); } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async tryLeaderLock() {
      if (lockClient) return true;
      const c = new Client({ ...cfg, connectionTimeoutMillis: 5000 });
      c.on('error', () => { if (lockClient === c) lockClient = null; });
      await c.connect();
      const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_KEY]);
      if (r.rows[0].ok) { lockClient = c; return true; }
      await c.end().catch(() => {}); return false;
    },
    async leaderAlive() { if (!lockClient) return false; try { await lockClient.query('SELECT 1'); return true; } catch { lockClient = null; return false; } },
    async releaseLeader() { if (lockClient) { const c = lockClient; lockClient = null; try { await c.query('SELECT pg_advisory_unlock($1)', [LEADER_KEY]); } catch {} await c.end().catch(() => {}); } },
    async close() { await this.releaseLeader(); await pool.end().catch(() => {}); }
  };
}

import { createHash } from 'node:crypto';

/* Forward-only migrations. Applied in filename order inside a transaction under an advisory lock; checksums are recorded and verified. */
export async function migrate(db, files /* [{name, sql}] */, { sha = async s => createHash('sha256').update(s).digest('hex') } = {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS perps_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Map((await db.query('SELECT name, checksum FROM perps_migrations')).rows.map(r => [r.name, r.checksum]));
  const done = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const sum = await sha(f.sql);
    if (applied.has(f.name)) { if (applied.get(f.name) !== sum) throw new Error('migration_checksum_mismatch:' + f.name); continue; }
    await db.exec('BEGIN;\n' + f.sql + '\nINSERT INTO perps_migrations(name, checksum) VALUES (' + "'" + f.name.replace(/'/g, "''") + "'" + ", '" + sum.replace(/'/g, "''") + "');\nCOMMIT;");
    done.push(f.name);
  }
  return done;
}
