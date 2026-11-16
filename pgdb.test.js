/* The node-postgres adapter (src/db.js createPgDb) exercised against FAKE Pool/Client classes.
 * `pg` cannot be installed in the offline sandbox, so this proves the adapter's logic (rollback on failed scripts, single leader session,
 * error handlers), NOT the real driver. CI runs the full suite; a real-driver smoke test is part of stage S2/S3. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPgDb } from '../src/db.js';

function fakes({ lockFree = true } = {}) {
  const log = []; let clientErr = null;
  class Pool { constructor(c) { this.cfg = c; log.push(['pool', c]); this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    async query(sql, p) { log.push(['pool.query', sql, p]); return { rows: [{ ok: 1 }] }; }
    async connect() { const c = { async query(sql) { log.push(['conn.query', sql]); if (/BAD/.test(sql)) throw new Error('boom'); return { rows: [] }; }, release() { log.push(['release']); } }; return c; }
    async end() { log.push(['pool.end']); } }
  class Client { constructor(c) { this.cfg = c; log.push(['client', c]); this.h = {}; }
    on(ev, fn) { this.h[ev] = fn; clientErr = fn; }
    async connect() { log.push(['client.connect']); }
    async query(sql, p) { log.push(['client.query', sql, p]); if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: lockFree }] }; if (this.dead) throw new Error('gone'); return { rows: [] }; }
    async end() { log.push(['client.end']); } }
  return { Pool, Client, log, killClient: () => { clientErr && clientErr(new Error('conn lost')); } };
}

test('pg adapter: pool is configured with timeouts and a small max; query passes params through', async () => {
  const f = fakes(); const db = createPgDb({ Pool: f.Pool, Client: f.Client, connectionString: 'postgres://u:p@h/db' });
  const cfg = f.log.find(l => l[0] === 'pool')[1]; assert.equal(cfg.max, 5); assert.equal(cfg.statement_timeout, 10000); assert.equal(cfg.connectionTimeoutMillis, 5000); assert.equal(cfg.ssl, undefined);
  assert.deepEqual((await db.query('SELECT $1', [7])).rows, [{ ok: 1 }]); assert.deepEqual(f.log.find(l => l[0] === 'pool.query').slice(1), ['SELECT $1', [7]]);
  assert.equal(createPgDb({ Pool: f.Pool, Client: f.Client, connectionString: 'x', ssl: true }) && f.log.filter(l => l[0] === 'pool').pop()[1].ssl.rejectUnauthorized, false);
});

test('pg adapter: a failing script is rolled back and the connection is released', async () => {
  const f = fakes(); const db = createPgDb({ Pool: f.Pool, Client: f.Client, connectionString: 'x' });
  await db.exec('SELECT 1'); await assert.rejects(db.exec('BEGIN; BAD; COMMIT;'), /boom/);
  const ops = f.log.filter(l => l[0] === 'conn.query' || l[0] === 'release').map(l => l[0] === 'release' ? 'release' : l[1]);
  assert.deepEqual(ops, ['SELECT 1', 'release', 'BEGIN; BAD; COMMIT;', 'ROLLBACK', 'release']);
});

test('pg adapter: leader lock uses ONE dedicated connection, is idempotent, reports loss, and releases', async () => {
  const f = fakes(); const db = createPgDb({ Pool: f.Pool, Client: f.Client, connectionString: 'x' });
  assert.equal(await db.leaderAlive(), false);
  assert.equal(await db.tryLeaderLock(), true); assert.equal(await db.tryLeaderLock(), true); assert.equal(f.log.filter(l => l[0] === 'client').length, 1, 'second call reuses the lock session');
  assert.equal(await db.leaderAlive(), true);
  f.killClient(); assert.equal(await db.leaderAlive(), false, 'connection error drops the lock state');
  assert.equal(await db.tryLeaderLock(), true); await db.releaseLeader();
  assert.ok(f.log.some(l => l[0] === 'client.query' && /pg_advisory_unlock/.test(l[1])) && f.log.some(l => l[0] === 'client.end'));
  const busy = fakes({ lockFree: false }); const d2 = createPgDb({ Pool: busy.Pool, Client: busy.Client, connectionString: 'x' });
  assert.equal(await d2.tryLeaderLock(), false); assert.ok(busy.log.some(l => l[0] === 'client.end'), 'a refused lock connection is closed, not leaked'); assert.equal(await d2.leaderAlive(), false);
  await db.close(); assert.ok(f.log.some(l => l[0] === 'pool.end'));
});

test('server.js refuses to start without DATABASE_URL and never prints secrets', () => {
  const r = spawnSync(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH, JUPITER_API_KEY: 'SUPERSECRET' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /DATABASE_URL is required/); assert.match(r.stderr, /together/); assert.ok(!(r.stdout + r.stderr).includes('SUPERSECRET'));
});
