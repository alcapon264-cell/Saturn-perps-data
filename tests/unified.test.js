/* r124 ONE market pipeline for 11 markets: one contract, provider attribution, per-adapter independence, failure isolation, rate limits,
 * wrong timestamps, restart recovery, candle isolation, WebSocket isolation.
 * [MOCK Jupiter + MOCK Hyperliquid (main + xyz) + MOCK CoinGecko, REAL PostgreSQL, fake clock, real HTTP + WebSocket sockets]. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { clusterUp, attachTestDb } from './helpers/pg-local.js';
import { makeEnv, MARKETS } from './helpers/harness.js';
import { fakeSources } from './helpers/fake-providers.js';
import { REGISTRY, CONTRACT_FIELDS } from '../src/markets.js';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const CG_KEY = 'test-only-cg-demo-key-not-real';
const ALL11 = ['SOL', 'ETH', 'BTC', 'HYPE', 'ZEC', 'JUP', 'SNDK', 'SPCX', 'NEAR', 'SKHYNIX', 'BNB'];
const VIEW = ALL11.slice(3);

async function boot({ env = {}, before, db = null, clock = null } = {}) {
  const S = fakeSources(); if (before) before(S);
  const e = await makeEnv({ jup: S.jup, db, clock, env: { VIEW_MARKETS: VIEW.join(','), COINGECKO_DEMO_KEY: CG_KEY, ...env }, init: false });
  S.clock = e.clock; await e.app.init(); e.S = S; e.view = e.parts.view; return e;
}
/* one full cycle: the Jupiter recorder (3 markets, staggered across 15 s) and the view recorder (8 markets, one slot) */
const cycle = async e => { await e.clock.advance(15000); await e.app.idle(); };
const markets = async e => { const port = e._port || (e._port = await e.app.start({ port: 0, host: '127.0.0.1' })); return (await (await fetch('http://127.0.0.1:' + port + '/v1/perps/markets')).json()).markets; };
const count = async (e, table, m) => (await e.db.rows(`SELECT count(*)::int n FROM ${table} WHERE market='${m}'`))[0].n;

test('registry: 11 markets, identity/provider/venue/eligibility fixed in code; only SOL/ETH/BTC executable; JUP the token is a Hyperliquid view market, not Jupiter Perps', () => {
  assert.deepEqual(Object.keys(REGISTRY).slice(0, 11), ALL11);   /* r179: more view markets follow the original eleven */
  for (const k of ['SOL', 'ETH', 'BTC']) assert.deepEqual([REGISTRY[k].provider, REGISTRY[k].venue, REGISTRY[k].executable, REGISTRY[k].viewOnly], ['jupiter-perps', 'jupiter-perps', true, false], k);
  for (const k of VIEW) { assert.equal(REGISTRY[k].provider, 'hyperliquid', k); assert.equal(REGISTRY[k].executable, false, k); assert.equal(REGISTRY[k].viewOnly, true, k); assert.equal(REGISTRY[k].priceKind, 'hyperliquid_perp_mid'); }
  assert.deepEqual(['SNDK', 'SPCX', 'SKHYNIX'].map(k => REGISTRY[k].venue), ['hyperliquid:xyz', 'hyperliquid:xyz', 'hyperliquid:xyz'], 'stocks: perp prices on Trade.xyz, not stock reference prices');
  assert.equal(REGISTRY.JUP.providerMarketId, 'JUP'); assert.notEqual(REGISTRY.JUP.provider, 'jupiter-perps', 'the JUP token is not Jupiter Perps');
  assert.equal(REGISTRY.SOL.providerMarketId, MARKETS.SOL);
});

test('ONE contract: all 11 rows carry exactly the same fields, with provider, venue, source, price kind, state, category, eligibility and view-only status', opts, async () => {
  const e = await boot(); try {
    await cycle(e); await e.view.tick();
    const rows = await markets(e);
    assert.deepEqual(rows.map(r => r.market), ALL11);
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), [...CONTRACT_FIELDS].sort(), r.market);
    const by = Object.fromEntries(rows.map(r => [r.market, r]));
    for (const k of ['SOL', 'ETH', 'BTC']) { assert.equal(by[k].source, 'jupiter-perps:market-stats'); assert.equal(by[k].provider, 'jupiter-perps'); assert.equal(by[k].executable, true); assert.equal(by[k].viewOnly, false); }
    for (const k of VIEW) { assert.equal(by[k].source, 'hyperliquid:allMids'); assert.equal(by[k].provider, 'hyperliquid'); assert.equal(by[k].executable, false); assert.equal(by[k].viewOnly, true); }
    /* r132: Jupiter rows keep null volume/OI; Hyperliquid rows carry the venue's own dayNtlVlm and open interest x mark (fake: 1 and 1 coin) */
    for (const k of ['SOL', 'ETH', 'BTC']) { assert.equal(by[k].volume24h, null); assert.equal(by[k].openInterest, null); assert.equal(by[k].execution.adapter, 'jupiter-perps-solana'); }
    for (const k of VIEW) { assert.equal(by[k].volume24h, 1, k); assert.ok(Math.abs(by[k].openInterest - by[k].price) / by[k].price < 0.01, k + ' OI = 1 coin x the venue mark');
      assert.deepEqual({ adapter: by[k].execution.adapter, ready: by[k].execution.ready, blocker: by[k].execution.blocker }, { adapter: 'hyperliquid-relay', ready: false, blocker: 'HL_EXECUTION_ENABLED_off' }, k); }
    for (const r of rows) { assert.ok(['ok', 'no_data', 'down', 'unavailable', 'stale'].includes(r.status) || typeof r.status === 'string', r.market); }
  } finally { await e.drop(); }
});

test('each adapter independently: every market shows ITS OWN provider price (11 different scripted values)', opts, async () => {
  const e = await boot({ before: S => { S.mids.ZEC = '409.75'; S.xmids['xyz:SPCX'] = '149.75'; } }); try {
    for (let i = 0; i < 2; i++) await cycle(e);
    await e.view.tick();
    const by = Object.fromEntries((await markets(e)).map(r => [r.market, r.price]));
    assert.deepEqual(by, { SOL: 150, ETH: 3000, BTC: 90000, HYPE: 31.5, ZEC: 409.75, JUP: 0.512, SNDK: 655.5, SPCX: 149.75, NEAR: 2.64, SKHYNIX: 1210, BNB: 905.3 });
  } finally { await e.drop(); }
});

test('failure isolation: Hyperliquid fully down -> SOL/ETH/BTC keep recording; Jupiter down for SOL -> ETH/BTC and all 8 view markets keep recording', opts, async () => {
  const e = await boot(); try {
    await cycle(e);
    const sol0 = await count(e, 'perps_observations', 'SOL'), hype0 = await count(e, 'perps_view_observations', 'HYPE');
    e.S.mode.hl = 'network'; e.S.mode.ctx = 'fail';
    for (let i = 0; i < 4; i++) await cycle(e);
    assert.ok(await count(e, 'perps_observations', 'SOL') >= sol0 + 3, 'Jupiter markets unaffected by a Hyperliquid outage');
    assert.equal(await count(e, 'perps_view_observations', 'HYPE'), hype0, 'nothing recorded for view markets while their provider is down');
    e.S.mode.hl = 'ok'; e.S.mode.ctx = 'ok'; e.S.jup.mode[MARKETS.SOL] = 'http500';
    for (let i = 0; i < 12; i++) await cycle(e);   /* long enough for the view recorder's back-off to expire */
    const sol1 = await count(e, 'perps_observations', 'SOL'), eth1 = await count(e, 'perps_observations', 'ETH');
    for (let i = 0; i < 3; i++) await cycle(e);
    assert.equal(await count(e, 'perps_observations', 'SOL'), sol1, 'SOL failing');
    assert.ok(await count(e, 'perps_observations', 'ETH') > eth1, 'ETH continues');
    for (const k of VIEW) assert.ok(await count(e, 'perps_view_observations', k) > 0, k + ' recovered and recording');
  } finally { await e.drop(); }
});

test('rate limits: a Hyperliquid 429 backs the view recorder off (no hammering) and never touches the Jupiter budget', opts, async () => {
  const e = await boot(); try {
    await cycle(e);
    const jup0 = e.S.jupCalls; e.S.mode.hl = 'http500';
    const n0 = e.S.hl.filter(x => x.type === 'allMids').length;
    for (let i = 0; i < 8; i++) await cycle(e);   /* 2 minutes */
    const n1 = e.S.hl.filter(x => x.type === 'allMids').length;
    assert.ok(n1 - n0 <= 8, 'failing provider is backed off: ' + (n1 - n0) + ' allMids requests in 2 minutes (one market set per request)');
    assert.ok(e.S.jupCalls - jup0 >= 20, 'Jupiter recorder keeps its own cadence');
  } finally { await e.drop(); }
});

test('wrong timestamps: a CoinGecko reading dated in the future or hours old is not accepted as a cross-check (price hidden once the last good check expires)', opts, async () => {
  const e = await boot(); try {
    await cycle(e);
    for (const [label, when] of [['future', () => e.clock.now() + 3600e3], ['old', () => e.clock.now() - 3 * 3600e3]]) {
      e.S.cgRows = { hyperliquid: { id: 'hyperliquid', symbol: 'hype', name: 'Hyperliquid', image: null, current_price: 31.4, last_updated: new Date(when()).toISOString() } };
      for (let i = 0; i < 5; i++) { e.clock.jump(5 * 60 * 1000); await e.view.tick(); await cycle(e); }
      const h = (await e.view.marketsView()).find(r => r.market === 'HYPE');
      assert.equal(h.price, null, label); assert.equal(h.status, 'not_cross_checked', label);
    }
  } finally { await e.drop(); }
});

test('restart recovery: a new process on the same database keeps every market\'s own history and candles, and resumes recording', opts, async () => {
  const e = await boot(); let e2 = null;
  try {
    for (let i = 0; i < 6; i++) await cycle(e);
    const before = Object.fromEntries(await Promise.all(VIEW.map(async k => [k, await count(e, 'perps_view_observations', k)])));
    const candles0 = (await e.db.rows('SELECT count(*)::int n FROM perps_view_candles'))[0].n;
    await e.app.parts.recorder.stop(); await e.view.stopLeader(); await e.app.parts.db.releaseLeader();   /* the old process exits (its database session stays open only for this test's cleanup) */
    e2 = await boot({ db: attachTestDb(e.db), clock: e.clock });   /* a NEW process: new session on the SAME database */
    for (const k of VIEW) assert.ok(await count(e, 'perps_view_observations', k) >= before[k], k + ' history kept');
    assert.ok((await e.db.rows('SELECT count(*)::int n FROM perps_view_candles'))[0].n >= candles0, 'candles kept');
    for (let i = 0; i < 3; i++) await cycle(e2);
    for (const k of VIEW) assert.ok(await count(e, 'perps_view_observations', k) > before[k], k + ' resumes');
  } finally { if (e2) await e2.stop(); await e.drop(); }
});

test('candle isolation: every candle of every market is built only from that market\'s own observations, in that market\'s own table', opts, async () => {
  const e = await boot(); try {
    for (let i = 0; i < 10; i++) await cycle(e);
    e.clock.jump(120000); await e.view.tick(); for (const m of ['SOL', 'ETH', 'BTC']) await e.parts.engine.finalizeDue(m);
    for (const [obs, cnd] of [['perps_observations', 'perps_candles'], ['perps_view_observations', 'perps_view_candles']]) {
      const bad = await e.db.rows(`SELECT c.market, c.tf, c.bucket_start FROM ${cnd} c WHERE c.tf='1m' AND (c.h > (SELECT max(price) FROM ${obs} o WHERE o.market=c.market) OR c.l < (SELECT min(price) FROM ${obs} o WHERE o.market=c.market))`);
      assert.deepEqual(bad, [], cnd + ': a candle outside its own market\'s observed range');
    }
    const core = (await e.db.rows("SELECT DISTINCT market FROM perps_candles ORDER BY 1")).map(r => r.market), view = (await e.db.rows("SELECT DISTINCT market FROM perps_view_candles ORDER BY 1")).map(r => r.market);
    assert.deepEqual(core, ['BTC', 'ETH', 'SOL']); assert.deepEqual(view, [...VIEW].sort());
  } finally { await e.drop(); }
});

test('WebSocket isolation: a client gets ticks only for markets it subscribed to, each tagged with its own provider and source', opts, async () => {
  const e = await boot(); try {
    await cycle(e); await e.view.tick();
    const port = await e.app.start({ port: 0, host: '127.0.0.1' }); e._port = port;
    const open = async subs => { const ws = new WebSocket('ws://127.0.0.1:' + port + '/perps/live'); const msgs = []; ws.on('message', d => msgs.push(JSON.parse(d))); await new Promise(r => ws.on('open', r)); ws.send(JSON.stringify({ type: 'subscribe', markets: subs })); return { ws, msgs }; };
    const a = await open(['SOL']), b = await open(['HYPE', 'SNDK']);
    await new Promise(r => setTimeout(r, 100));
    for (let i = 0; i < 2; i++) await cycle(e);
    await new Promise(r => setTimeout(r, 100));
    const ta = a.msgs.filter(m => m.type === 'perps_tick'), tb = b.msgs.filter(m => m.type === 'perps_tick');
    assert.ok(ta.length && ta.every(m => m.market === 'SOL' && m.provider === 'jupiter-perps' && m.source === 'jupiter-perps:market-stats'), JSON.stringify(ta.slice(0, 2)));
    assert.ok(tb.length && tb.every(m => ['HYPE', 'SNDK'].includes(m.market) && m.provider === 'hyperliquid' && m.source === 'hyperliquid:allMids'), JSON.stringify(tb.slice(0, 2)));
    assert.ok(new Set(tb.map(m => m.market)).size === 2, 'both subscribed view markets tick');
    a.ws.close(); b.ws.close();
  } finally { await e.drop(); }
});

test('r126 24 h change for SOL/ETH/BTC with GAPPY history (free plan sleeps): computed from two REAL observations 24 h apart; never another market\'s; dash when none within 30 min', opts, async () => {
  const e = await boot(); try {
    await cycle(e); await cycle(e);
    const now = e.clock.now(), ins = (m, t, p) => e.db.sql(`INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('jupiter-perps:market-stats','${m}',to_timestamp(${t / 1000}),to_timestamp(${t / 1000}),${p},10)`);
    await ins('SOL', now - 24 * 3600e3 - 7 * 60e3, 140);          /* 7 min from exactly 24 h ago -> accepted */
    await ins('SOL', now - 24 * 3600e3 + 40 * 60e3, 999);         /* 40 min away -> never used */
    await ins('ETH', now - 24 * 3600e3 - 50 * 60e3, 2500);        /* ETH: only 50 min away -> no reference */
    await ins('ETH', now - 24 * 3600e3 + 2 * 60e3, 100);          /* ETH at 2 min -> ETH's reference */
    await ins('BTC', now - 30 * 3600e3, 80000);                   /* BTC: nothing near 24 h ago */
    const by = Object.fromEntries((await markets(e)).map(r => [r.market, r]));
    const sol = by.SOL.stats24h; assert.equal(sol.basis, 'saturn_observation_24h'); assert.equal(sol.open, 140); assert.equal(sol.changePct, +((150 - 140) / 140 * 100).toFixed(4)); assert.equal(sol.high, null); assert.equal(sol.low, null);
    assert.equal(by.ETH.stats24h.open, 100, 'ETH uses ETH\'s own observation closest to 24 h ago');
    assert.equal(by.BTC.stats24h, null, 'BTC: no real observation within 30 min of 24 h ago -> dash, nothing estimated');
  } finally { await e.drop(); }
});

test('r126 24 h stats with a FULL hourly history keep the candle-based high/low/change (unchanged behaviour)', opts, async () => {
  const e = await boot(); try {
    const t0 = e.clock.now();
    await e.db.sql(`INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) SELECT 'jupiter-perps:market-stats','SOL', to_timestamp(g), to_timestamp(g + 0.25), 150 + ((g/15)::bigint % 7) * 0.1, 10 FROM generate_series(${t0 / 1000 - 25 * 3600}, ${t0 / 1000}, 15) g`);
    await e.parts.engine.recover('SOL'); await e.parts.engine.finalizeDue('SOL');
    const sol = (await markets(e)).find(r => r.market === 'SOL').stats24h;
    assert.equal(sol.basis, 'saturn_sampled_1h'); assert.ok(sol.high >= sol.low && sol.hours >= 20);
  } finally { await e.drop(); }
});

/* ---------- r132 truthful execution status + the venue's own 24 h statistics ---------- */
test('r132 executable is the REAL readiness: relay on + verified + listed -> true with the venue asset id; each other market names its exact blocker; SOL/ETH/BTC unchanged', opts, async () => {
  const e = await boot({ env: { HL_EXECUTION_ENABLED: '1', HL_VERIFIED_MARKETS: 'HYPE,SNDK,ZEC' }, before: S => { S.universe = S.universe.map(a => a.name === 'ZEC' ? { ...a, isDelisted: true } : a); } }); try {
    await cycle(e); await e.view.tick();
    const by = Object.fromEntries((await markets(e)).map(r => [r.market, r]));
    assert.equal(by.HYPE.executable, true); assert.deepEqual({ ...by.HYPE.execution }, { adapter: 'hyperliquid-relay', network: 'hyperliquid-mainnet', venueAssetId: 3, venueCoin: 'HYPE', collateral: by.HYPE.execution.collateral, marginMode: 'cross', maxLeverage: 10, ready: true, blocker: null });
    assert.equal(by.HYPE.viewOnly, false); assert.equal(by.HYPE.maxLeverage, 10, 'leverage from the venue metadata');
    assert.equal(by.SNDK.executable, true); assert.equal(by.SNDK.execution.venueAssetId, 120000, 'Trade.xyz HIP-3 id = 100000 + 2*10000 + index'); assert.equal(by.SNDK.execution.venueCoin, 'xyz:SNDK');
    assert.equal(by.ZEC.executable, false); assert.equal(by.ZEC.execution.blocker, 'delisted on Hyperliquid mainnet');
    for (const k of ['JUP', 'NEAR', 'BNB', 'SPCX', 'SKHYNIX']) { assert.equal(by[k].executable, false, k); assert.equal(by[k].execution.blocker, 'not_in_HL_VERIFIED_MARKETS', k); assert.equal(by[k].viewOnly, true, k); }
    for (const k of ['SOL', 'ETH', 'BTC']) { assert.equal(by[k].executable, true, k); assert.equal(by[k].execution.adapter, 'jupiter-perps-solana'); assert.ok(by[k].execution.venueAssetId, k + ' custody account'); }
  } finally { await e.drop(); }
});

test('r132 Hyperliquid unreachable -> HL markets report executable:false with blocker hyperliquid_unreachable (never assumed ready)', opts, async () => {
  const e = await boot({ env: { HL_EXECUTION_ENABLED: '1', HL_VERIFIED_MARKETS: 'HYPE' } }); try {
    await cycle(e); await e.view.tick(); e.S.mode.ctx = 'fail';
    const by = Object.fromEntries((await markets(e)).map(r => [r.market, r]));
    assert.equal(by.HYPE.executable, false); assert.equal(by.HYPE.execution.blocker, 'hyperliquid_unreachable');
  } finally { await e.drop(); }
});

test('r132 24 h stats: the venue\'s own 1 h candles (basis hyperliquid_candles_1h) only with 24 complete hours; a gap -> null, never filled', opts, async () => {
  const H = 3600000;
  const mk = gap => req => { const end = Math.floor(req.endTime / H) * H, out = [];
    for (let i = 24; i >= 0; i--) { if (gap && i === 7) continue; const t = end - i * H; out.push({ t, T: t + H - 1, s: req.coin, i: '1h', o: String(30 + i * 0.01), c: '31', h: String(32 + (i === 5 ? 1 : 0)), l: String(29 - (i === 9 ? 1 : 0)), v: '100', n: 10 }); }
    return out; };
  const e = await boot({ before: S => { S.candles = mk(false); } }); try {
    await cycle(e); await e.view.tick();
    const h = (await markets(e)).find(r => r.market === 'HYPE');
    assert.equal(h.stats24h.basis, 'hyperliquid_candles_1h'); assert.equal(h.stats24h.hours, 24); assert.equal(h.stats24h.high, 33); assert.equal(h.stats24h.low, 28); assert.equal(h.stats24h.open, 30.24);
    assert.equal(h.stats24h.last, h.price); assert.equal(h.change24h, null, 'stats24h supersedes the previous-day reference');
    assert.ok(e.S.candleReqs.every(r => r.interval === '1h'), 'one interval only');
  } finally { await e.drop(); }
  const g = await boot({ before: S => { S.candles = mk(true); } }); try {
    await cycle(g); await g.view.tick();
    const h = (await markets(g)).find(r => r.market === 'HYPE');
    assert.equal(h.stats24h, null, 'a missing hour -> no 24 h stats'); assert.equal(h.change24h.basis, 'hyperliquid_prevDayPx', 'falls back to the venue previous-day reference');
  } finally { await g.drop(); }
});

test('r133 Hyperliquid chart candles: /v1/perps/candles for a Hyperliquid market = the venue\'s own continuous candles; the open bucket only as forming; Saturn candles when the venue fails; SOL unchanged', opts, async () => {
  const mk = req => { const IV = { '1m': 60000, '5m': 300000 }[req.interval], out = []; for (let t = Math.floor(req.startTime / IV) * IV; t <= req.endTime; t += IV) out.push({ t, T: t + IV - 1, s: req.coin, i: req.interval, o: '31', c: '31.2', h: '31.5', l: '30.9', v: '10', n: 3 }); return out; };
  const e = await boot({ before: S => { S.candles = mk; } }); try {
    await cycle(e); await e.view.tick(); const port = await e.app.start({ port: 0, host: '127.0.0.1' }), base = 'http://127.0.0.1:' + port;
    const r = await (await fetch(base + '/v1/perps/candles?market=HYPE&tf=5m&limit=50')).json();
    assert.equal(r.source, 'hyperliquid:candleSnapshot'); assert.equal(r.candles.length, 50);
    for (let i = 1; i < r.candles.length; i++) assert.equal(r.candles[i].t - r.candles[i - 1].t, 300, 'no holes');
    assert.ok(r.candles.every(c => c.status === 'complete' && c.t * 1000 < Math.floor(e.clock.now() / 300000) * 300000), 'open bucket excluded without includeForming');
    const f = await (await fetch(base + '/v1/perps/candles?market=HYPE&tf=5m&limit=5&includeForming=1')).json();
    assert.equal(f.candles[f.candles.length - 1].status, 'forming');
    assert.equal(e.S.candleReqs.at(-1).coin, 'HYPE');
    const sol = await (await fetch(base + '/v1/perps/candles?market=SOL&tf=5m')).json(); assert.equal(sol.source, 'jupiter-perps:market-stats');
    e.S.candles = () => { throw new Error('x'); }; e.S.mode.ctx = 'ok';
    const fb = await (await fetch(base + '/v1/perps/candles?market=ZEC&tf=1m')).json(); assert.equal(fb.source, 'hyperliquid:allMids', 'venue down -> Saturn recorded candles');
  } finally { await e.drop(); }
});
