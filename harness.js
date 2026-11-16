/* Integration harness: real PostgreSQL (psql test driver) + fake clock + scripted fake Jupiter + the real service wiring. */
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { createTestDb } from './pg-local.js';
import { FakeClock, fakeJupiter, settle } from './fakes.js';
import { loadConfig, MARKETS } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { migrate } from '../../src/db.js';

export const MIG = [{ name: '001_init.sql', sql: readFileSync(new URL('../../migrations/001_init.sql', import.meta.url), 'utf8') }];
export const START = Date.UTC(2026, 10, 16, 0, 0, 0);      /* aligned to every timeframe */

export async function makeEnv({ taps = {}, env = {}, cfgOverrides = {}, prices, start = START, db = null, clock = null, jup = null, init = true } = {}) {
  db = db || await createTestDb(); if (!db) return null;
  clock = clock || new FakeClock(start);
  const cfg = { ...loadConfig({ DATABASE_URL: 'postgres://secret-user:secret-pass@db.internal/saturn', ALLOWED_ORIGINS: 'https://app.example', ...env }), ...cfgOverrides };
  jup = jup || fakeJupiter({ prices: prices || { [MARKETS.SOL]: 150, [MARKETS.ETH]: 3000, [MARKETS.BTC]: 90000 } });
  jup.clock = clock;
  const logs = [];
  const app = createApp({ cfg, db, fetchImpl: jup.fetch, WebSocketServer, migrationFiles: MIG, now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout, setIntervalImpl: clock.setInterval, clearIntervalImpl: clock.clearInterval, rand: () => 0.5, taps, log: (...a) => logs.push(a.join(' ')) });
  clock.idleFn = () => app.idle();
  if (init) await app.init();
  return { db, clock, cfg, jup, app, logs, parts: app.parts,
    async stop() { await app.shutdown().catch(() => {}); },
    async drop() { await app.shutdown().catch(() => {}); await db.drop(); } };
}

/* Invariant checker: every stored candle must equal what an independent computation over stored observations says. Returns number checked. */
export async function checkCandlesMatchObservations(db, { intervalSec = 15, coverageMin = 0.8, nowMs }) {
  const TF = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
  const rows = await db.rows(`SELECT market, tf, extract(epoch from bucket_start)*1000 AS s, o,h,l,c,n_obs,coverage,max_gap_sec,status,valid FROM perps_candles`);
  let checked = 0;
  for (const r of rows) {
    const w = TF[r.tf] * 1000, s = Math.round(r.s);
    const obs = (await db.rows(`SELECT extract(epoch from observed_at)*1000 AS t, price FROM perps_observations WHERE market='${r.market}' AND observed_at >= to_timestamp(${s / 1000}) AND observed_at < to_timestamp(${(s + w) / 1000}) ORDER BY observed_at`)).map(x => ({ t: Math.round(x.t), p: Number(x.price) }));
    if (r.status === 'complete' || obs.length) {
      if (!obs.length) throw new Error(`candle without observations ${r.market} ${r.tf} ${s}`);
      const o = obs[0].p, c = obs[obs.length - 1].p, h = Math.max(...obs.map(x => x.p)), l = Math.min(...obs.map(x => x.p));
      const same = Number(r.o) === o && Number(r.c) === c && Number(r.h) === h && Number(r.l) === l && r.n_obs === obs.length;
      if (!same && r.status === 'complete') throw new Error(`complete candle != observations ${r.market} ${r.tf} ${s}: ${JSON.stringify(r)} vs ${JSON.stringify({ o, h, l, c, n: obs.length })}`);
      if (!same && r.status === 'forming') { /* a forming row may lag by at most the newest observation until the next update */ if (r.n_obs > obs.length) throw new Error('forming candle has MORE obs than stored'); }
    }
    if (r.valid && r.status !== 'complete') throw new Error('valid non-complete candle');
    checked++;
  }
  return checked;
}

/* bulk-insert realistic observations straight into the table the recorder writes (SQL generate_series), then rebuild candles */
export async function seedHistory(env, market, fromMs, toMs, { offsetSec = 5 } = {}) {
  await env.db.sql(`INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) SELECT 'jupiter-perps:market-stats','${market}', to_timestamp(g), to_timestamp(g + 0.25), 100 + ((g/15)::bigint % 7), 40 FROM generate_series(${fromMs / 1000 + offsetSec}, ${toMs / 1000 - 1}, 15) g ON CONFLICT DO NOTHING`);
  env.clock.t = Math.max(env.clock.t, toMs + 20000);
  await env.parts.engine.recover(market); await env.parts.engine.finalizeDue(market);
}

export { FakeClock, fakeJupiter, settle, MARKETS };
