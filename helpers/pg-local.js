/* TEST HARNESS (not production code). Runs the service's real SQL against a REAL local PostgreSQL through persistent psql sessions.
 * It is NOT the node-postgres driver (`pg` is not installable in the offline sandbox); CI uses TEST_DATABASE_URL + `pg` instead.
 * Parameters are inlined with proper literal escaping by this harness only. */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { readdirSync } from 'node:fs';
const findBin = () => { if (process.env.PGBIN) return process.env.PGBIN; try { const v = readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))[0]; return '/usr/lib/postgresql/' + v + '/bin'; } catch { return '/usr/lib/postgresql/16/bin'; } };
const PGBIN = findBin();
const DIR = process.env.PGT_DIR || '/tmp/pgt';
const LEADER_KEY = 7351001;

export function clusterUp() {
  try { execFileSync(PGBIN + '/pg_isready', ['-h', DIR, '-q']); return true; } catch { /* not running */ }
  const root = process.getuid && process.getuid() === 0;
  const as = cmd => root ? execFileSync('su', ['postgres', '-s', '/bin/bash', '-c', cmd]) : execFileSync('/bin/bash', ['-c', cmd]);   /* postgres refuses to run as root */
  try {
    if (!existsSync(DIR + '/data/PG_VERSION')) as(`mkdir -p ${DIR} && chmod 777 ${DIR} && ${PGBIN}/initdb -D ${DIR}/data -A trust -U postgres >/dev/null 2>&1`);
    as(`${PGBIN}/pg_ctl -D ${DIR}/data -o "-c listen_addresses='' -c unix_socket_directories=${DIR} -c fsync=off" -l ${DIR}/log -w start >/dev/null 2>&1`);
    return true;
  } catch { return false; }
}

const lit = v => v === null || v === undefined ? 'NULL' : typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : (() => { throw new Error('non_finite_param'); })()) : "'" + String(v).replace(/'/g, "''") + "'";
const inline = (sql, params) => sql.replace(/\$(\d+)/g, (_, i) => { if (!(i - 1 in params)) throw new Error('missing_param_' + i); return lit(params[i - 1]); });

class Session {
  constructor(dbName) {
    this.p = spawn(PGBIN + '/psql', ['-X', '-q', '-A', '-t', '-h', DIR, '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.out = ''; this.err = ''; this.dead = false; this.chain = Promise.resolve();
    this.p.stdout.on('data', d => { this.out += d; this.poke(); });
    this.p.stderr.on('data', d => { this.err += d; this.poke(); });
    this.p.on('exit', () => { this.dead = true; this.poke(); });
    this.waiter = null;
  }
  poke() { if (this.waiter) this.waiter(); }
  run(text) {
    const job = this.chain.then(() => new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('psql_session_dead'));
      this.out = ''; this.err = '';
      const check = () => {
        if (this.dead && !(this.out.includes('@@E@@') && this.err.includes('@@E@@'))) { this.waiter = null; return reject(new Error('psql_session_dead')); }
        if (this.out.includes('@@E@@\n') && this.err.includes('@@E@@\n')) {
          this.waiter = null;
          const o = this.out.replace('@@E@@\n', ''), e = this.err.replace('@@E@@\n', '').trim();
          if (/^ERROR:/m.test(e)) { const x = new Error(e.split('\n')[0]); x.pg = e; return reject(x); }
          resolve(o.trim());
        }
      };
      this.waiter = check;
      this.p.stdin.write(text + '\n\\echo @@E@@\n\\warn @@E@@\n');
    }));
    this.chain = job.catch(() => {});
    return job;
  }
  kill() { try { this.p.kill('SIGKILL'); } catch {} }
  end() { try { this.p.stdin.end(); this.p.kill(); } catch {} }
}

export async function createTestDb({ name } = {}) {
  if (!clusterUp()) return null;
  const dbName = name || ('t_' + Math.random().toString(36).slice(2, 10));
  execFileSync(PGBIN + '/psql', ['-X', '-q', '-h', DIR, '-U', 'postgres', '-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  const main = new Session(dbName); let lock = null;
  const db = {
    kind: 'psql-test-harness', dbName, fail: false, failWrites: false, calls: 0,
    async query(sql, params = []) {
      db.calls++;
      if (db.fail) throw new Error('injected_db_failure');
      if (db.failWrites && /^\s*(INSERT|UPDATE|DELETE|WITH)/i.test(sql)) throw new Error('injected_db_write_failure');
      const text = inline(sql, params).trim().replace(/;+\s*$/, '');
      const returning = /\bRETURNING\b/i.test(text), isSelect = /^\s*(SELECT|WITH)\b/i.test(text) && !/^\s*WITH\b[\s\S]*\b(INSERT|DELETE|UPDATE)\b/i.test(text) ;
      if (returning || isSelect) {
        const out = await main.run(`WITH q AS (${text}) SELECT coalesce(json_agg(q), '[]'::json) FROM q;`);
        return { rows: JSON.parse(out || '[]') };
      }
      await main.run(text + ';'); return { rows: [] };
    },
    async exec(sql) { if (db.fail) throw new Error('injected_db_failure'); await main.run(sql + '\n;'); },
    async tryLeaderLock() {
      if (lock && !lock.dead) return true;
      lock = new Session(dbName);
      const out = await lock.run(`SELECT pg_try_advisory_lock(${LEADER_KEY});`);
      if (out === 't') return true;
      lock.end(); lock = null; return false;
    },
    async leaderAlive() { if (!lock || lock.dead) return false; try { await lock.run('SELECT 1;'); return true; } catch { return false; } },
    async releaseLeader() { if (lock) { lock.end(); lock = null; } },
    killLeaderSession() { if (lock) lock.kill(); },
    async close() { await db.releaseLeader(); main.end(); },
    /* helpers for tests only */
    async sql(text) { return main.run(text + '\n;'); },
    async rows(text) { const o = await main.run(`SELECT coalesce(json_agg(q), '[]'::json) FROM (${text}) q;`); return JSON.parse(o || '[]'); },
    session() { return new Session(dbName); },
    async drop() { await db.close(); try { execFileSync(PGBIN + '/psql', ['-X', '-q', '-h', DIR, '-U', 'postgres', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`]); } catch {} }
  };
  return db;
}

/* A second service instance = a second connection to the SAME database (own leader-lock session). */
export function attachTestDb(base) {
  const dbName = base.dbName; let lock = null;
  const main = new Session(dbName);
  const db = Object.create(null);
  Object.assign(db, {
    kind: 'psql-test-harness', dbName,
    query: async (sql, params = []) => { const text = inline(sql, params).trim().replace(/;+\s*$/, ''); const returning = /\bRETURNING\b/i.test(text), isSelect = /^\s*(SELECT|WITH)\b/i.test(text) && !/^\s*WITH\b[\s\S]*\b(INSERT|DELETE|UPDATE)\b/i.test(text);
      if (returning || isSelect) { const out = await main.run(`WITH q AS (${text}) SELECT coalesce(json_agg(q), '[]'::json) FROM q;`); return { rows: JSON.parse(out || '[]') }; } await main.run(text + ';'); return { rows: [] }; },
    exec: async sql => { await main.run(sql + '\n;'); },
    tryLeaderLock: async () => { if (lock && !lock.dead) return true; lock = new Session(dbName); const out = await lock.run(`SELECT pg_try_advisory_lock(${LEADER_KEY});`); if (out === 't') return true; lock.end(); lock = null; return false; },
    leaderAlive: async () => { if (!lock || lock.dead) return false; try { await lock.run('SELECT 1;'); return true; } catch { return false; } },
    releaseLeader: async () => { if (lock) { lock.end(); lock = null; } },
    close: async () => { if (lock) { lock.end(); lock = null; } main.end(); }
  });
  return db;
}
