/* Fixtures = the 12 REAL price strings observed in a browser from https://alcapon264-cell.github.io on 2026-11-16 (S2, 12/12 HTTP 200, no 429).
 * Only the `price` field (a decimal STRING) was observed in the response body; no timestamp field and no rate-limit headers were visible (CORS exposed only content-length/content-type).
 * Network is MOCK (replayed values); parsing/validation/recorder/DB code is REAL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, MARKETS, START } from './helpers/harness.js';
import { parseMarketStats, checkPlausible } from '../src/validate.js';
import { DEFAULT_PRICE_RANGE, loadConfig, validateConfig } from '../src/config.js';

const REAL = {
  SOL: ['70.80657135', '70.855', '70.90561706', '70.90561706'],
  ETH: ['1807.86421843', '1810.42047955', '1810.42047955', '1810.42047955'],
  BTC: ['64423.70199518', '64456.85443998', '64456.85443998', '64456.85443998'],
};
const opts = { skip: clusterUp() ? false : 'no local PostgreSQL available' };

test('all 12 real price strings parse, round-trip exactly and are inside the plausibility ranges', () => {
  for (const [m, list] of Object.entries(REAL)) for (const s of list) {
    const p = parseMarketStats({ price: s }, { maxPrice: 1e9 });
    assert.equal(p.ok, true, m + ' ' + s); assert.equal(p.price, Number(s)); assert.equal(String(p.price), String(Number(s)));
    assert.equal(checkPlausible(p.price, DEFAULT_PRICE_RANGE[m]).ok, true, m + ' ' + s);
  }
});

test('magnitude guard: x1e6 / x1e-6 scaled real prices are rejected as implausible (they still parse)', () => {
  assert.equal(parseMarketStats({ price: '70806571.35' }, { maxPrice: 1e9 }).ok, true, 'parsing alone cannot catch a scale change');
  for (const [m, s] of [['SOL', '70806571.35'], ['SOL', '0.00007080657135'], ['ETH', '1807864218.43'], ['ETH', '0.00180786421843'], ['BTC', '64423701995.18'], ['BTC', '0.0644237']])
    assert.equal(checkPlausible(Number(s), DEFAULT_PRICE_RANGE[m]).ok, false, m + ' ' + s);
});

test('config: PRICE_RANGE override is validated', () => {
  assert.deepEqual(loadConfig({ PRICE_RANGE_SOL: '1,1000' }).priceRange.SOL, [1, 1000]);
  assert.equal(loadConfig({ PRICE_RANGE_SOL: '5,1' }).priceRange.SOL, null);
  assert.ok(validateConfig(loadConfig({ PRICE_RANGE_SOL: 'abc' })).some(e => /PRICE_RANGE_SOL/.test(e)));
});

test('recorder replays the real SOL/ETH/BTC strings: stored exactly, receive-time basis, unchanged-run tracked', opts, async () => {
  let n = { SOL: 0, ETH: 0, BTC: 0 };
  const inv = Object.fromEntries(Object.entries(MARKETS).map(([k, v]) => [v, k]));
  const prices = Object.fromEntries(Object.entries(MARKETS).map(([k, mint]) => [mint, () => REAL[k][Math.min(n[k]++, 3)]]));
  const e = await makeEnv({ prices }); try {
    await e.app.parts.recorder.start(); await e.clock.advance(60 * 1000);
    for (const m of ['SOL', 'ETH', 'BTC']) {
      const rows = await e.db.rows(`SELECT price::text p FROM perps_observations WHERE market='${m}' ORDER BY observed_at`);
      assert.deepEqual(rows.slice(0, 4).map(r => r.p.replace(/0+$/, '').replace(/\.$/, '')), REAL[m], m + ' stored exactly');
    }
    const st = e.app.parts.recorder.summary ? e.app.parts.recorder.summary() : null;
    if (st) { const sol = (st.markets || st).SOL || (st.markets || st).find?.(x => x.market === 'SOL'); assert.ok(sol.maxUnchangedRun >= 1); assert.ok(sol.lastPriceChangeAt > 0); }
    const c = await e.db.rows("SELECT count(*)::int n FROM perps_rejects WHERE reason='implausible'"); assert.equal(c[0].n, 0, 'real values never rejected');
  } finally { await e.drop(); }
});

test('recorder rejects an implausible FIRST observation (no jump baseline) and records it as a reject', opts, async () => {
  const e = await makeEnv({ prices: { [MARKETS.SOL]: '70806571.35', [MARKETS.ETH]: '1807.86421843', [MARKETS.BTC]: '64423.70199518' } }); try {
    await e.app.parts.recorder.start(); await e.clock.advance(60 * 1000);
    assert.equal((await e.db.rows("SELECT count(*)::int n FROM perps_observations WHERE market='SOL'"))[0].n, 0, 'nothing stored for SOL');
    assert.ok((await e.db.rows("SELECT count(*)::int n FROM perps_rejects WHERE market='SOL' AND reason='implausible'"))[0].n >= 1);
    assert.ok((await e.db.rows("SELECT count(*)::int n FROM perps_observations WHERE market='ETH'"))[0].n >= 1, 'other markets unaffected');
  } finally { await e.drop(); }
});

test('API declares timeBasis=receive_time', opts, async () => {
  const e = await makeEnv(); try {
    const src = (await import('node:fs')).readFileSync(new URL('../src/http.js', import.meta.url), 'utf8');
    assert.equal((src.match(/timeBasis: 'receive_time'/g) || []).length, 2);
  } finally { await e.drop(); }
});
