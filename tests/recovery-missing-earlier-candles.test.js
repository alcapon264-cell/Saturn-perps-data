import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, START } from './helpers/harness.js';

const HAVE = clusterUp();
const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const count = (db, sql) => db.rows(sql).then(r => r[0].n);

test('recovery rebuilds an earlier missing bucket even when a later bucket is already complete', opts, async () => {
  const e = await makeEnv();
  try {
    const earlierMs = START + 5000;
    const laterMs = START + 125000; // a different 1-minute bucket

    // Simulate the crash window: both observations reached PostgreSQL, but the
    // candle write for the earlier observation never happened.
    await e.parts.store.insertObservation({ market: 'ETH', slotMs: START, observedMs: earlierMs, price: 3001, fetchMs: 10 });
    await e.parts.store.insertObservation({ market: 'ETH', slotMs: START + 120000, observedMs: laterMs, price: 3002, fetchMs: 10 });

    // Simulate normal operation later completing a newer candle first.
    e.clock.jump(10 * 60 * 1000);
    await e.parts.engine.onObservation('ETH', laterMs);
    assert.equal(await count(e.db, `SELECT count(*)::int n FROM perps_candles WHERE market='ETH' AND tf='1m' AND bucket_start=to_timestamp(${START / 1000})`), 0,
      'the earlier bucket is still missing before recovery');
    assert.equal(await count(e.db, `SELECT count(*)::int n FROM perps_candles WHERE market='ETH' AND tf='1m' AND bucket_start=to_timestamp(${(START + 120000) / 1000}) AND status='complete'`), 1,
      'the later bucket is already complete');

    await e.parts.engine.recover('ETH');

    assert.equal(await count(e.db, `SELECT count(*)::int n FROM perps_candles WHERE market='ETH' AND tf='1m' AND bucket_start=to_timestamp(${START / 1000}) AND status='complete'`), 1,
      'recovery reconstructs the earlier bucket from its stored observation');
    assert.equal(await count(e.db, `SELECT count(*)::int n FROM perps_candles WHERE market='ETH' AND tf='1m' AND bucket_start=to_timestamp(${(START + 120000) / 1000}) AND status='complete'`), 1,
      'the later completed candle remains present');
  } finally {
    await e.drop();
  }
});
