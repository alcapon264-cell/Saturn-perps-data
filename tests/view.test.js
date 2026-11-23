/* r120 VIEW-ONLY markets: Hyperliquid discovery, one batched allMids per slot, CoinGecko id check + cross-check, monthly cap, stale / frozen /
 * malformed prices, separate tables, WebSocket, logo cache, and execution isolation.
 * [MOCK Hyperliquid + MOCK CoinGecko + MOCK Jupiter (all scripted, no network), REAL PostgreSQL, fake clock, real HTTP + WebSocket sockets]
 * Nothing in this file talks to a real service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, fakeJupiter, MARKETS } from './helpers/harness.js';
import { loadConfig, validateConfig, VIEW_MARKET_TABLE } from '../src/config.js';
import { createHyperliquidClient, createCoinGeckoClient, logoUrlAllowed } from '../src/viewsources.js';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const CG_KEY = 'test-only-cg-demo-key-not-real';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const ALL = ['HYPE', 'ZEC', 'JUP', 'SNDK', 'SPCX', 'NEAR', 'SKHYNIX', 'BNB'];
const CRYPTO = ['HYPE', 'ZEC', 'JUP', 'NEAR', 'BNB'], STOCKS = ['SNDK', 'SPCX', 'SKHYNIX'];
const J = (o, status = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/* scripted sources. mids: coin -> price string (or function); universe: list of {name,isDelisted}; cg: id -> row overrides */
function fakeSources() {
  const S = {
    hl: [], cg: [], logo: [], jupCalls: 0, mode: { hl: 'ok', cg: 'ok', ctx: 'ok' }, clock: null,
    mids: { HYPE: '31.50', ZEC: '412.10', JUP: '0.5120', NEAR: '2.640', BNB: '905.3', BTC: '90000', '@1': '1' },
    xmids: { 'xyz:SNDK': '655.50', 'xyz:SPCX': '151.20', 'xyz:SKHYNIX': '1210.00', 'xyz:NVDA': '180' },
    universe: ['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC', 'JUP', 'NEAR', 'BNB'].map(name => ({ name, szDecimals: 2, maxLeverage: 10 })),
    xuniverse: ['xyz:SNDK', 'xyz:SPCX', 'xyz:SKHYNIX', 'xyz:NVDA'].map(name => ({ name, szDecimals: 2, maxLeverage: 10 })),
    oracle: {}, prevDay: { HYPE: '30.00', 'xyz:SNDK': '640.00', 'xyz:SPCX': '160.00' }, cgRows: null
  };
  const cgDefault = () => {
    const t = new Date(S.clock.now()).toISOString(); const p = id => ({ hyperliquid: 31.4, zcash: 411, 'jupiter-exchange-solana': 0.513, near: 2.645, binancecoin: 904, solana: 150, ethereum: 3000, bitcoin: 90000 })[id];
    const names = { hyperliquid: ['hype', 'Hyperliquid'], zcash: ['zec', 'Zcash'], 'jupiter-exchange-solana': ['jup', 'Jupiter'], near: ['near', 'NEAR Protocol'], binancecoin: ['bnb', 'BNB'], solana: ['sol', 'Solana'], ethereum: ['eth', 'Ethereum'], bitcoin: ['btc', 'Bitcoin'] };
    return Object.fromEntries(Object.entries(names).map(([id, [symbol, name]]) => [id, { id, symbol, name, image: 'https://coin-images.coingecko.com/coins/images/1/large/' + id + '.png', current_price: p(id), last_updated: t }]));
  };
  const jup = fakeJupiter({ prices: { [MARKETS.SOL]: 150, [MARKETS.ETH]: 3000, [MARKETS.BTC]: 90000 } });
  const inner = jup.fetch;
  jup.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.hyperliquid.xyz') {
      const body = JSON.parse(init.body); const dex = body.dex || ''; S.hl.push({ type: body.type, dex, method: init.method, redirect: init.redirect, at: S.clock.now() });
      const U = dex ? S.xuniverse : S.universe, M = dex ? S.xmids : S.mids;
      if (body.type === 'metaAndAssetCtxs') {
        if (S.mode.ctx === 'fail') return J({ e: 1 }, 500);
        return J([{ universe: U }, U.map(a => { const mid = typeof M[a.name] === 'function' ? M[a.name](S.hl.length) : M[a.name]; return { midPx: mid || null, markPx: mid || null, oraclePx: S.oracle[a.name] || mid || null, prevDayPx: S.prevDay[a.name] || mid || null, funding: '0', openInterest: '1', dayNtlVlm: '1' }; })]);
      }
      if (body.type === 'meta') return J({ universe: U });
      if (S.mode.hl === 'http500') return J({ e: 1 }, 500);
      if (S.mode.hl === 'badjson') return J('not json{');
      if (S.mode.hl === 'network') throw new TypeError('fetch failed');
      return J(Object.fromEntries(Object.entries(M).map(([k, v]) => [k, typeof v === 'function' ? v(S.hl.length) : v])));
    }
    if (u.hostname === 'api.coingecko.com') {
      S.cg.push({ path: u.pathname, ids: u.searchParams.get('ids'), headers: init.headers, url, at: S.clock.now() });
      if (S.mode.cg === 'http429') return J({ status: { error_code: 429 } }, 429);
      const rows = { ...cgDefault(), ...(S.cgRows || {}) }; const want = u.searchParams.get('ids').split(',');
      return J(want.map(id => rows[id]).filter(Boolean));
    }
    if (u.hostname === 'coin-images.coingecko.com') { S.logo.push(url); return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }); }
    if (u.hostname === 'api.jup.ag') return J([]);
    S.jupCalls++; return inner(url, init);
  };
  S.jup = jup; return S;
}

async function boot({ env = {}, markets = ALL.join(','), key = CG_KEY, before } = {}) {
  const S = fakeSources(); if (before) before(S);
  const e = await makeEnv({ jup: S.jup, env: { VIEW_MARKETS: markets, COINGECKO_DEMO_KEY: key, ...env }, init: false });
  S.clock = e.clock; await e.app.init();
  e.S = S; e.view = e.parts.view; return e;
}
const slot = async e => { await e.clock.advance(15000); await e.app.idle(); };

test('config: unknown VIEW_MARKETS entries are reported, the Hyperliquid base and market sets are pinned, the table is never executable', async () => {
  const c = loadConfig({ DATABASE_URL: 'x', VIEW_MARKETS: 'HYPE,NOTACOIN,SNDK', COINGECKO_DEMO_KEY: CG_KEY });
  assert.deepEqual([...c.view.markets], ['HYPE', 'SNDK']); assert.ok(validateConfig(c).some(x => /NOTACOIN/.test(x)));
  assert.ok(validateConfig(loadConfig({ DATABASE_URL: 'x', VIEW_MARKETS: 'HYPE', HYPERLIQUID_INFO_BASE: 'https://evil.example' })).some(x => /HYPERLIQUID_INFO_BASE/.test(x)));
  assert.throws(() => createHyperliquidClient({ base: 'https://evil.example' })); assert.throws(() => createCoinGeckoClient({ base: 'https://evil.example', key: 'k' })); assert.doesNotThrow(() => createCoinGeckoClient({ key: '' }), 'r125: the key is optional (public endpoint)');
  assert.deepEqual([...loadConfig({ DATABASE_URL: 'x' }).view.markets].slice(0, 8), ['HYPE', 'ZEC', 'JUP', 'SNDK', 'SPCX', 'NEAR', 'SKHYNIX', 'BNB'], 'r125: VIEW_MARKETS unset -> all of the table (no Render setting needed)');
  assert.ok(loadConfig({ DATABASE_URL: 'x' }).view.markets.includes('DOGE'), 'r179: new markets are on by default');
  assert.deepEqual([...loadConfig({ DATABASE_URL: 'x', VIEW_MARKETS: 'off' }).view.markets], [], 'VIEW_MARKETS=off -> none');
  await assert.rejects(createHyperliquidClient({ fetchImpl: async () => J({}) }).allMids('evil'), /dex_not_allowed/, 'only the main and xyz market sets can be requested');
  for (const k of Object.keys(VIEW_MARKET_TABLE)) assert.ok(!(k in MARKETS), k + ' is not an executable market');
  assert.ok(['SKHYNIX', 'SNDK', 'SPCX'].every(k => VIEW_MARKET_TABLE[k].category === 'stock') && Object.values(VIEW_MARKET_TABLE).every(d => d.category !== 'stock' || d.dex === 'xyz'), 'stocks are Trade.xyz markets');
  assert.ok(logoUrlAllowed('https://coin-images.coingecko.com/x.png')); assert.ok(!logoUrlAllowed('http://coin-images.coingecko.com/x.png')); assert.ok(!logoUrlAllowed('https://evil.example/x.png'));
});

test('discovery: listing read from BOTH market sets; ONE allMids per market set per slot for all 8 markets; ONE CoinGecko call per 5 min; key in a header only', opts, async () => {
  const e = await boot(); try {
    assert.deepEqual(e.S.hl.map(x => x.type + ':' + x.dex), ['metaAndAssetCtxs:', 'metaAndAssetCtxs:xyz', 'allMids:', 'allMids:xyz']);
    assert.equal(e.S.cg.length, 1); assert.equal(e.S.cg[0].headers['x-cg-demo-api-key'], CG_KEY); assert.ok(!e.S.cg[0].url.includes(CG_KEY), 'key never in the URL');
    assert.deepEqual(e.S.cg[0].ids.split(',').sort(), ['binancecoin', 'bitcoin', 'ethereum', 'hyperliquid', 'jupiter-exchange-solana', 'near', 'solana', 'zcash'], 'equities are not sent to CoinGecko');
    for (const m of ALL) assert.equal(e.view.Q[m].listed, true, m);
    assert.equal(e.view.Q.SNDK.coin, 'xyz:SNDK'); assert.equal(e.view.Q.SKHYNIX.coin, 'xyz:SKHYNIX');
    const n0 = e.S.hl.filter(x => x.type === 'allMids').length; await slot(e); await slot(e); await slot(e);
    assert.equal(e.S.hl.filter(x => x.type === 'allMids').length - n0, 6, 'exactly one allMids per market set per 15 s slot');
    assert.ok(e.S.hl.every(x => x.method === 'POST' && x.redirect === 'error'));
    const rows = await e.db.rows("SELECT market, count(*)::int n, min(source) s FROM perps_view_observations GROUP BY market ORDER BY market");
    assert.deepEqual(rows.map(r => r.market), [...ALL].sort()); assert.ok(rows.every(r => r.n === 3 && r.s === 'hyperliquid:allMids'));
    assert.equal((await e.db.rows("SELECT 1 FROM perps_observations WHERE market NOT IN ('SOL','ETH','BTC')")).length, 0, 'no view price in the SOL/ETH/BTC table');
    for (let i = 0; i < 16; i++) await slot(e);
    await e.view.tick(); assert.equal(e.S.cg.length, 1, 'no second CoinGecko call before 5 minutes');
    await slot(e); await slot(e); await e.view.tick(); assert.equal(e.S.cg.length, 2, 'second call after 5 minutes');
    assert.equal((await e.db.rows("SELECT value FROM perps_meta WHERE key LIKE 'coingecko_calls:%'"))[0].value, '2', 'monthly counter');
    assert.ok(!e.logs.join('\n').includes(CG_KEY), 'the CoinGecko key never reaches a log line');
  } finally { await e.drop(); }
});

test('/v1/perps/markets: all 11 markets, view markets executable:false (relay off) with the venue own volume/OI, real 24 h change from the venue reference, stocks categorised', opts, async () => {
  const e = await boot(); try {
    await slot(e); await e.view.tick();
    const port = await e.app.start({ port: 0, host: '127.0.0.1' }); const base = 'http://127.0.0.1:' + port;
    const r = await (await fetch(base + '/v1/perps/markets')).json();
    assert.deepEqual(r.markets.map(x => x.market), ['SOL', 'ETH', 'BTC', ...ALL]);
    for (const x of r.markets.filter(x => x.viewOnly)) {
      assert.equal(x.executable, false); assert.equal(x.execution.ready, false); assert.equal(x.execution.blocker, 'HL_EXECUTION_ENABLED_off'); assert.equal(x.maxLeverage, null);
      assert.equal(x.volume24h, 1, 'r132: Hyperliquid dayNtlVlm'); assert.ok(Math.abs(x.openInterest - x.price) / x.price < 0.01, 'r132: open interest (1 coin) x mark'); assert.equal(x.mint, null);
      assert.equal(x.source, 'hyperliquid:allMids'); assert.equal(x.crossCheck.ok, true, x.market + ' ' + JSON.stringify(x.crossCheck)); assert.ok(x.price > 0, x.market); assert.equal(x.status, 'ok');
      assert.equal(x.icon, '/v1/perps/logos/' + x.market, 'r126: every market has a declared official logo file in assets/logos'); assert.equal(x.stats24h, null);
    }
    const by = Object.fromEntries(r.markets.map(x => [x.market, x]));
    assert.equal(by.HYPE.price, 31.5); assert.equal(by.SNDK.price, 655.5); assert.equal(by.SKHYNIX.venueCoin, 'xyz:SKHYNIX');
    assert.deepEqual(STOCKS.map(k => by[k].category), ['stock', 'stock', 'stock']); assert.deepEqual(CRYPTO.map(k => by[k].category), ['major', 'major', 'major', 'major', 'major']);
    assert.equal(by.HYPE.crossCheck.source, 'coingecko'); assert.equal(by.SNDK.crossCheck.source, 'hyperliquid-oracle');
    assert.deepEqual(by.HYPE.change24h, { changePct: 5, reference: 30, basis: 'hyperliquid_prevDayPx' }, '(31.5-30)/30 from the venue previous-day price');
    assert.equal(by.SPCX.change24h.changePct, -5.5);
    for (const x of r.markets.filter(x => !x.viewOnly)) { assert.equal(x.executable, true, x.market + ' unchanged'); assert.equal(x.icon, '/v1/perps/logos/' + x.market); }
    const c = await (await fetch(base + '/v1/perps/candles?market=SKHYNIX&tf=1m&includeForming=1')).json();
    assert.equal(c.ok, true); assert.equal(c.source, 'hyperliquid:allMids'); assert.equal(c.viewOnly, true); assert.equal(c.market, 'SKHYNIX');
    const sol = await (await fetch(base + '/v1/perps/candles?market=SOL&tf=1m&includeForming=1')).json(); assert.equal(sol.source, 'jupiter-perps:market-stats');
    assert.equal((await fetch(base + '/v1/perps/candles?market=DOGE&tf=1m')).status, 400);
  } finally { await e.drop(); }
});

test('Saturn 24 h statistics replace the venue reference only after a FULL 24 h of valid Saturn observations (no estimates, no filled gaps)', opts, async () => {
  const e = await boot({ markets: 'HYPE' }); try {
    const t0 = e.clock.now();
    await e.db.sql(`INSERT INTO perps_view_observations(source,market,slot_ts,observed_at,price,fetch_ms) SELECT 'hyperliquid:allMids','HYPE', to_timestamp(g), to_timestamp(g + 0.25), 30 + ((g/15)::bigint % 5) * 0.01, 20 FROM generate_series(${t0 / 1000 - 23 * 3600}, ${t0 / 1000}, 15) g`);
    await e.view.engine.recover('HYPE'); await e.view.engine.finalizeDue('HYPE');
    let rows = await e.view.marketsView(); assert.equal(rows[0].history.state, 'collecting'); assert.equal(rows[0].history.hours, 22); assert.equal(rows[0].stats24h, null); assert.equal(rows[0].change24h.basis, 'hyperliquid_prevDayPx');
    await e.db.sql(`INSERT INTO perps_view_observations(source,market,slot_ts,observed_at,price,fetch_ms) SELECT 'hyperliquid:allMids','HYPE', to_timestamp(g), to_timestamp(g + 0.25), 30.02, 20 FROM generate_series(${t0 / 1000 - 25 * 3600}, ${t0 / 1000 - 23 * 3600 - 15}, 15) g`);
    await e.db.sql('DELETE FROM perps_view_candles');   /* TEST: rebuild every candle from the stored observations */
    await e.view.engine.recover('HYPE'); await e.view.engine.finalizeDue('HYPE');
    rows = await e.view.marketsView(); assert.equal(rows[0].history.state, 'ready'); assert.ok(rows[0].stats24h && rows[0].stats24h.hours >= 24, JSON.stringify(rows[0].stats24h)); assert.equal(rows[0].change24h, null, 'Saturn\'s own 24 h statistics take over');
    assert.equal((await e.db.rows('SELECT 1 FROM perps_candles')).length, 0, 'view candles never enter perps_candles');
  } finally { await e.drop(); }
});

test('honest status: a coin missing or delisted on Hyperliquid, or a wrong CoinGecko id, stays LISTED with no price and a reason; it is never recorded', opts, async () => {
  const e = await boot({ before: S => {
    S.universe = S.universe.filter(x => x.name !== 'ZEC').map(x => x.name === 'NEAR' ? { ...x, isDelisted: true } : x);
    S.xuniverse = S.xuniverse.filter(x => x.name !== 'xyz:SKHYNIX');
    S.cgRows = { 'jupiter-exchange-solana': { id: 'jupiter-exchange-solana', symbol: 'jup', name: 'Jupiter Project', image: null, current_price: 0.5, last_updated: new Date(Date.UTC(2026, 10, 16)).toISOString() } };
  } }); try {
    await slot(e); await slot(e);
    const by = Object.fromEntries((await e.view.marketsView()).map(x => [x.market, x]));
    assert.deepEqual(Object.keys(by), ALL, 'every requested market is still listed');
    assert.deepEqual([by.ZEC.status, by.NEAR.status, by.JUP.status, by.SKHYNIX.status], ['not_listed_on_hyperliquid', 'delisted_on_hyperliquid', 'coingecko_id_mismatch', 'not_listed_on_hyperliquid']);
    for (const k of ['ZEC', 'NEAR', 'JUP', 'SKHYNIX']) { assert.equal(by[k].price, null, k); assert.equal(by[k].state, 'unavailable'); assert.equal(by[k].change24h, null); assert.equal(by[k].name, VIEW_MARKET_TABLE[k].name, 'identity kept'); }
    assert.equal(by.JUP.icon, '/v1/perps/logos/JUP', 'the declared official JUP file is used; a wrong CoinGecko id never supplies an image');
    assert.ok(by.HYPE.price > 0 && by.SNDK.price > 0);
    const rec = (await e.db.rows('SELECT DISTINCT market FROM perps_view_observations ORDER BY 1')).map(r => r.market); assert.deepEqual(rec, ['BNB', 'HYPE', 'SNDK', 'SPCX'], 'unavailable markets are not recorded');
    assert.deepEqual(await e.view.visibleKeys(), ['HYPE', 'SNDK', 'SPCX', 'BNB'], 'only verified markets can be streamed or charted');
  } finally { await e.drop(); }
});

test('r125 without a CoinGecko key (today\'s Render config): all 8 markets are listed AND priced; crypto checked against the Hyperliquid oracle; identity + logos from the public CoinGecko endpoint, no key sent', opts, async () => {
  const e = await boot({ key: '', env: { VIEW_MARKETS: ALL.join(',') } }); try {
    await slot(e);
    const by = Object.fromEntries((await e.view.marketsView()).map(x => [x.market, x]));
    assert.deepEqual(Object.keys(by), ALL);
    for (const k of ALL) { assert.ok(by[k].price > 0, k); assert.equal(by[k].crossCheck.source, 'hyperliquid-oracle', k); assert.equal(by[k].crossCheck.ok, true, k); }
    for (const k of CRYPTO) assert.equal(by[k].icon, '/v1/perps/logos/' + k, k + ' logo from the verified (keyless) CoinGecko image');
    assert.equal(e.S.cg.length, 1, 'one public call at start'); assert.ok(!e.S.cg[0].headers['x-cg-demo-api-key'], 'no key header');
    assert.deepEqual((await e.db.rows('SELECT DISTINCT market FROM perps_view_observations ORDER BY 1')).map(r => r.market), [...ALL].sort());
    for (let i = 0; i < 25; i++) { await slot(e); await e.view.tick(); }
    assert.equal(e.S.cg.length, 1, 'public endpoint used at most every 6 h');
    e.S.oracle.HYPE = '40.00'; e.clock.jump(60000); await e.view.tick();
    assert.equal((await e.view.marketsView()).find(x => x.market === 'HYPE').status, 'sources_disagree', 'a crypto market far from its oracle is hidden');
    assert.ok(e.S.jupCalls > 0, 'the SOL/ETH/BTC recorder keeps running');
  } finally { await e.drop(); }
});

test('cross-check: crypto >2% from CoinGecko, or an equity >2% from its own oracle, hides the price and pauses recording; both recover; an expired check hides prices', opts, async () => {
  const e = await boot(); try {
    await slot(e);
    e.S.cgRows = { hyperliquid: { id: 'hyperliquid', symbol: 'hype', name: 'Hyperliquid', image: null, current_price: 35, last_updated: new Date(e.clock.now()).toISOString() } };
    e.S.oracle['xyz:SKHYNIX'] = '1400.00';   /* the kind of disagreement seen in the July 2026 SK hynix bad print */
    e.clock.jump(5 * 60 * 1000); await e.view.tick();
    let by = Object.fromEntries((await e.view.marketsView()).map(x => [x.market, x]));
    for (const k of ['HYPE', 'SKHYNIX']) { assert.equal(by[k].price, null, k); assert.equal(by[k].status, 'sources_disagree'); assert.ok(by[k].crossCheck.diffPct > 2); }
    const n0 = (await e.db.rows("SELECT 1 FROM perps_view_observations WHERE market IN ('HYPE','SKHYNIX')")).length; await slot(e); await slot(e);
    assert.equal((await e.db.rows("SELECT 1 FROM perps_view_observations WHERE market IN ('HYPE','SKHYNIX')")).length, n0, 'nothing recorded while sources disagree');
    assert.ok(by.ZEC.price > 0 && by.SNDK.price > 0, 'other markets unaffected');
    e.S.cgRows = null; delete e.S.oracle['xyz:SKHYNIX']; e.clock.jump(5 * 60 * 1000); await e.view.tick(); await slot(e);
    by = Object.fromEntries((await e.view.marketsView()).map(x => [x.market, x])); assert.ok(by.HYPE.price > 0 && by.SKHYNIX.price > 0, 'recovers');
    e.S.mode.cg = 'http429'; e.S.mode.ctx = 'fail'; for (let i = 0; i < 5; i++) { e.clock.jump(5 * 60 * 1000); await e.view.tick(); await slot(e); }
    by = Object.fromEntries((await e.view.marketsView()).map(x => [x.market, x]));
    for (const k of ['HYPE', 'SNDK']) { assert.equal(by[k].price, null, k); assert.equal(by[k].status, 'not_cross_checked'); }
  } finally { await e.drop(); }
});

test('CoinGecko monthly cap: once reached, no further CoinGecko request is made that month', opts, async () => {
  const e = await boot({ env: { COINGECKO_MONTHLY_CAP: '100' } }); try {
    const k = (await e.db.rows("SELECT key FROM perps_meta WHERE key LIKE 'coingecko_calls:%'"))[0].key;
    await e.db.sql(`UPDATE perps_meta SET value='100' WHERE key='${k}'`);
    const n = e.S.cg.length; e.clock.jump(5 * 60 * 1000); await e.view.tick(); e.clock.jump(5 * 60 * 1000); await e.view.tick();
    assert.equal(e.S.cg.length, n, 'cap enforced before the request'); assert.ok(e.logs.some(l => /monthly cap reached/.test(l)));
  } finally { await e.drop(); }
});

test('malformed / invalid / stale / frozen prices are rejected or hidden; never shown, never turned into candles', opts, async () => {
  const e = await boot(); try {
    await slot(e);
    e.S.mids.HYPE = '-3'; e.S.mids.ZEC = 'NaN'; e.S.mids.JUP = '9999999'; delete e.S.mids.NEAR; e.S.xmids['xyz:SNDK'] = '0'; await slot(e);
    const rej = await e.db.rows('SELECT market, reason, detail FROM perps_view_rejects ORDER BY market');
    assert.deepEqual(rej.map(r => r.market + ':' + r.reason), ['HYPE:non_positive', 'JUP:implausible', 'NEAR:malformed', 'SNDK:non_positive', 'ZEC:non_finite']);
    assert.equal((await e.db.rows('SELECT 1 FROM perps_rejects')).length, 0, 'view rejects never enter the SOL/ETH/BTC reject log');
    e.S.mode.hl = 'badjson'; await slot(e); e.S.mode.hl = 'http500'; await slot(e);
    for (let i = 0; i < 25; i++) await slot(e);
    for (const x of await e.view.marketsView()) assert.equal(x.price, null, x.market + ' hidden when down');
    e.S.mode.hl = 'ok'; e.S.mids = { HYPE: '31.50', ZEC: '412.10', JUP: '0.5120', NEAR: '2.640', BNB: '905.3' }; e.S.xmids = { 'xyz:SNDK': '655.50', 'xyz:SPCX': '151.20', 'xyz:SKHYNIX': '1210.00' };
    for (let i = 0; i < 50; i++) { await slot(e); if (i % 4 === 0) await e.view.tick(); }
    const f = (await e.view.marketsView()).find(x => x.market === 'BNB'); assert.equal(f.price, null); assert.equal(f.status, 'price_frozen');
    assert.equal((await e.db.rows('SELECT 1 FROM perps_view_candles WHERE o <= 0 OR l <= 0')).length, 0);
  } finally { await e.drop(); }
});

test('WebSocket: verified view markets (crypto and equities) can be subscribed, ticks carry the Hyperliquid source; unlisted markets are refused', opts, async () => {
  const e = await boot({ before: S => { S.universe = S.universe.filter(x => x.name !== 'ZEC'); } }); try {
    await slot(e); await e.view.tick();
    const port = await e.app.start({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/perps/live'); const msgs = []; ws.on('message', d => msgs.push(JSON.parse(d)));
    await new Promise(r => ws.on('open', r));
    const until = async f => { for (let i = 0; i < 200 && !msgs.some(f); i++) await new Promise(r => setTimeout(r, 5)); return msgs.find(f); };
    const mk = await until(m => m.type === 'perps_markets'); assert.deepEqual(mk.viewOnly, ['HYPE', 'JUP', 'SNDK', 'SPCX', 'NEAR', 'SKHYNIX', 'BNB']);
    ws.send(JSON.stringify({ type: 'subscribe', markets: ['ZEC'] })); assert.equal((await until(m => m.type === 'perps_error')).code, 'bad_market');
    ws.send(JSON.stringify({ type: 'subscribe', markets: ['SOL', 'ETH', 'BTC', ...mk.viewOnly] }));
    const sub = await until(m => m.type === 'perps_subscribed'); assert.equal(sub.markets.length, 10); assert.ok(sub.snapshot.SNDK.price > 0);
    await e.clock.advance(15000); await e.app.idle();
    const tick = await until(m => m.type === 'perps_tick' && m.market === 'SKHYNIX'); assert.equal(tick.source, 'hyperliquid:allMids');
    ws.close();
  } finally { await e.drop(); }
});

test('logos (r126): all 11 markets are served from the declared official files in assets/logos, with no network fetch (works while CoinGecko answers 429)', opts, async () => {
  const e = await boot({ before: S => { S.mode.cg = 'http429'; } }); try {
    const port = await e.app.start({ port: 0, host: '127.0.0.1' }); const base = 'http://127.0.0.1:' + port;
    for (const k of ['SOL', 'ETH', 'BTC', ...ALL]) { const a = await fetch(base + '/v1/perps/logos/' + k); assert.equal(a.status, 200, k); assert.equal(a.headers.get('content-type'), 'image/png'); assert.match(a.headers.get('cache-control'), /max-age=86400/); }
    assert.equal(e.S.logo.length, 0, 'no image was downloaded from anywhere');
    assert.equal((await fetch(base + '/v1/perps/logos/DOGE')).status, 404);
    assert.equal((await fetch(base + '/v1/perps/logos/HYPE', { method: 'POST' })).status, 405);
  } finally { await e.drop(); }
});

test('logos (r123): a shipped file is used only when declared in SOURCES.json with its official source and matching sha256', async () => {
  const { loadBundledLogos } = await import('../src/view.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { createHash } = await import('node:crypto');
  const d = mkdtempSync(tmpdir() + '/logos-'); const png = Uint8Array.from([...PNG, ...new Array(64).fill(7)]);
  writeFileSync(d + '/SNDK.png', png); writeFileSync(d + '/SPCX.png', png); writeFileSync(d + '/SKHYNIX.png', png);
  const h = createHash('sha256').update(png).digest('hex');
  writeFileSync(d + '/SOURCES.json', JSON.stringify([{ market: 'SNDK', source: 'https://example-official.test/brand', sha256: h }, { market: 'SPCX', source: 'https://example-official.test/brand', sha256: '0'.repeat(64) }, { market: 'SKHYNIX', sha256: h }]));
  const m = loadBundledLogos(['SNDK', 'SPCX', 'SKHYNIX'], new URL('file://' + d + '/'));
  assert.deepEqual([...m.keys()], ['SNDK'], 'wrong hash and missing source are refused'); assert.equal(m.get('SNDK').source, 'https://example-official.test/brand');
  assert.equal(loadBundledLogos(['SNDK'], new URL('file://' + d + '/missing/')).size, 0, 'no manifest -> nothing');
  const shipped = loadBundledLogos(['SOL', 'ETH', 'BTC', ...ALL], new URL('../assets/logos/', import.meta.url)); assert.equal(shipped.size, 11, 'the repository ships 11 declared, hash-matching official logos');
});

test('logos: without a bundled file, only a verified image on an allow-listed host is fetched (once), never anything else', opts, async () => {
  const { createViewMarkets } = await import('../src/view.js');
  const S = fakeSources(); const e = await makeEnv({ jup: S.jup, env: { VIEW_MARKETS: 'HYPE,ZEC', COINGECKO_DEMO_KEY: CG_KEY }, init: false }); S.clock = e.clock;
  try {
    await e.app.init();
    const v = createViewMarkets({ cfg: e.cfg, db: e.db, fetchImpl: S.jup.fetch, now: e.clock.now, setTimeoutImpl: e.clock.setTimeout, clearTimeoutImpl: e.clock.clearTimeout, bundledLogos: new Map() });
    await v.startLeader();
    Object.assign(v.Q.ZEC, { idOk: true, logoUrl: 'https://evil.example/z.png' });
    const a = await v.logo('HYPE'); assert.ok(a && a.type === 'image/png'); await v.logo('HYPE'); assert.equal(S.logo.length, 1, 'fetched once');
    assert.equal(await v.logo('ZEC'), null, 'non-allow-listed host refused');
    await v.stopLeader();
  } finally { await e.drop(); }
});

test('ISOLATION: view-only markets can never reach trade preparation, the execution gateway, transaction building, signing or SOL/ETH/BTC accounts', opts, async () => {
  const TKT = 'test-only-ticket-secret-0123456789abcdef';
  const S = fakeSources();
  /* TEST ONLY: execution is force-enabled here (bypassing the code lock) so the refusal path itself can be exercised */
  const envv = { VIEW_MARKETS: ALL.join(','), COINGECKO_DEMO_KEY: CG_KEY, PERPS_EXECUTION_ENABLED: '1', GATEWAY_TICKET_SECRET: TKT };
  const e = await makeEnv({ jup: S.jup, env: envv, cfgOverrides: { gateway: { ...loadConfig({ DATABASE_URL: 'x', ...envv }).gateway, executionEnabled: true } }, init: false });
  S.clock = e.clock; await e.app.init(); try {
    const port = await e.app.start({ port: 0, host: '127.0.0.1' }); const base = 'http://127.0.0.1:' + port;
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const W = 'So11111111111111111111111111111111111111112';
    const n0 = S.jupCalls;
    for (const m of ALL) {
      const r = await post('/v1/perps/jup/positions/increase', { asset: m, side: 'long', inputToken: 'USDC', inputTokenAmount: '25000000', leverage: '5.0', maxSlippageBps: '100', walletAddress: W });
      assert.equal(r.status, 403, m); assert.equal((await r.json()).error, 'view_only_market');
      const d = await post('/v1/perps/jup/positions/decrease', { asset: m, positionPubkey: W, walletAddress: W }); assert.equal(d.status, 403, m + ' decrease');
      const x = await post('/v1/perps/jup/execute', { market: m + '-PERP', signedTxBase64: 'AA==', saturnTicket: 'x' }); assert.equal(x.status, 403, m + ' execute');
    }
    assert.equal(S.jupCalls, n0, 'not one upstream call was made for a view-only market');
    assert.equal((await e.db.rows('SELECT 1 FROM perps_exec_requests')).length, 0, 'nothing reached the execution ledger');
    assert.equal((await fetch(base + '/v1/perps/jup/market-stats?mint=HYPE')).status, 400, 'no trading price for view markets');
    const { CUSTODY } = await import('../src/perps-program.js'); for (const m of ALL) assert.ok(!(m in CUSTODY), m + ' has no execution account');
  } finally { await e.drop(); }
});

test('diagnostic script (scripts/view-markets-live-check.mjs) against MOCKED sources: passes good markets, reports the rest with a reason, never prints the key', async () => {
  const { runCheck } = await import('../scripts/view-markets-live-check.mjs');
  const S = fakeSources(); S.clock = { now: () => Date.now() }; S.universe = S.universe.filter(x => x.name !== 'ZEC'); S.oracle['xyz:SPCX'] = '170.00';
  S.cgRows = { near: { id: 'near', symbol: 'near', name: 'NEAR Protocol', image: null, current_price: 9, last_updated: new Date().toISOString() } };
  const out = await runCheck({ fetchImpl: S.jup.fetch, key: CG_KEY });
  const by = Object.fromEntries(out.markets.map(r => [r.market, r]));
  for (const k of ['HYPE', 'JUP', 'BNB', 'SNDK', 'SKHYNIX']) assert.equal(by[k].result, 'PASS', k + ' ' + by[k].reasons);
  assert.equal(by.SKHYNIX.venueCoin, 'xyz:SKHYNIX');
  assert.equal(by.ZEC.result, 'PRICE UNAVAILABLE'); assert.match(by.ZEC.reasons.join(), /not listed/);
  assert.match(by.NEAR.reasons.join(), /differ/); assert.match(by.SPCX.reasons.join(), /oracle/);
  assert.equal(out.allPassed, false); assert.ok(!JSON.stringify(out).includes(CG_KEY));
  const down = await runCheck({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, key: CG_KEY });
  assert.match(down.reach.hyperliquid_main_contexts, /FAILED: network/); assert.ok(down.markets.every(r => r.result !== 'PASS'));
});

test('r122 contract + deploy audit: SOL/ETH/BTC are never flagged view-only; the response says which commit is running and whether VIEW_MARKETS / the cross-check key are configured (never the key itself)', opts, async () => {
  const e = await boot({ env: { RENDER_GIT_COMMIT: '0235ff3abcdef0123456789' } }); try {
    const port = await e.app.start({ port: 0, host: '127.0.0.1' });
    const r = await (await fetch('http://127.0.0.1:' + port + '/v1/perps/markets')).json();
    assert.deepEqual(r.build, { commit: '0235ff3abcde', viewMarketsConfigured: true, crossCheckConfigured: true });
    assert.ok(!JSON.stringify(r).includes(CG_KEY), 'the key is never in the response');
    for (const x of r.markets.slice(0, 3)) { assert.equal(x.executable, true, x.market); assert.equal(x.viewOnly, false, x.market); assert.equal(x.provider, 'jupiter-perps'); assert.equal(x.category, 'major'); }
    for (const x of r.markets.slice(3)) assert.equal(x.viewOnly, true, x.market);
  } finally { await e.drop(); }
  const e2 = await boot({ markets: 'off', key: '' }); try {
    const port = await e2.app.start({ port: 0, host: '127.0.0.1' });
    const r = await (await fetch('http://127.0.0.1:' + port + '/v1/perps/markets')).json();
    assert.deepEqual(r.markets.map(x => x.market), ['SOL', 'ETH', 'BTC'], 'VIEW_MARKETS=off: exactly the three recorded markets');
    assert.deepEqual(r.build, { commit: null, viewMarketsConfigured: false, crossCheckConfigured: false });
  } finally { await e2.drop(); }
});
