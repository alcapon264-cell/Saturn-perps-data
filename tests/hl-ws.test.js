/* r144 Hyperliquid WebSocket feed for the view markets.
 * [MOCK Hyperliquid WebSocket server on 127.0.0.1 (real sockets), MOCK Hyperliquid REST answering 429, REAL PostgreSQL, fake clock] — no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { createHlWsFeed, HL_WS_URL } from '../src/hl-ws.js';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, fakeJupiter, MARKETS } from './helpers/harness.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await wait(20); } return false; }
function fakeHl() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/ws' }); const S = { subs: [], pings: 0, conns: 0, sockets: [], silent: false };
  wss.on('connection', ws => { S.conns++; S.sockets.push(ws);
    ws.on('message', b => { const m = JSON.parse(String(b)); if (m.method === 'ping') { S.pings++; if (!S.silent) ws.send(JSON.stringify({ channel: 'pong' })); return; }
      if (m.method === 'subscribe') { S.subs.push(m.subscription); ws.send(JSON.stringify({ channel: 'subscriptionResponse', data: m }));
        const sb = m.subscription;
        if (sb.type === 'allMids' && !S.silent) ws.send(JSON.stringify({ channel: 'allMids', data: { mids: sb.dex === 'xyz' ? { 'xyz:SNDK': '655.5', 'xyz:SPCX': '151.2' } : { HYPE: '31.5', BNB: '905.3', 'bad key!': '1', ZEC: 'NaN' } } }));
        if (sb.type === 'activeAssetCtx' && !S.silent) ws.send(JSON.stringify({ channel: 'activeAssetCtx', data: { coin: sb.coin, ctx: { oraclePx: '31.4', prevDayPx: '30.0', midPx: '31.5', markPx: '31.5', dayNtlVlm: '1000000', openInterest: '5000', funding: '0.0001' } } })); } }); });
  return new Promise(r => wss.on('listening', () => r({ wss, S, url: 'ws://127.0.0.1:' + wss.address().port + '/ws' })));
}

test('hl-ws: only the Hyperliquid host (or a local test socket) is allowed', () => {
  assert.equal(HL_WS_URL, 'wss://api.hyperliquid.xyz/ws');
  assert.throws(() => createHlWsFeed({ url: 'wss://evil.example/ws' }), /hl_ws_url_not_allowed/);
  assert.doesNotThrow(() => createHlWsFeed({ url: HL_WS_URL }));
});

test('hl-ws: one socket per market set, subscribes allMids (+dex) and each coin context, parses and qualifies, ignores junk', async () => {
  const H = await fakeHl();
  const f = createHlWsFeed({ WebSocketImpl: WebSocket, url: H.url, sets: [{ dex: '', coins: ['HYPE', 'BNB'] }, { dex: 'xyz', coins: ['xyz:SNDK'] }] });
  try {
    f.start();
    assert.ok(await until(() => f.mids('') && f.mids('xyz') && f.ctx('HYPE') && f.ctx('xyz:SNDK')), 'data arrived');
    assert.equal(H.S.conns, 2);
    assert.deepEqual(H.S.subs.filter(s => s.type === 'allMids').map(s => s.dex || '').sort(), ['', 'xyz']);
    assert.deepEqual(H.S.subs.filter(s => s.type === 'activeAssetCtx').map(s => s.coin).sort(), ['BNB', 'HYPE', 'xyz:SNDK']);
    assert.deepEqual(f.mids('').mids, { HYPE: '31.5', BNB: '905.3' }, 'bad keys and non-decimal prices dropped');
    assert.deepEqual(f.mids('xyz').mids, { 'xyz:SNDK': '655.5', 'xyz:SPCX': '151.2' });
    const c = f.ctx('HYPE'); assert.equal(c.oraclePx, 31.4); assert.equal(c.prevDayPx, 30); assert.equal(c.dayNtlVlm, 1000000); assert.equal(c.openInterest, 5000);
    assert.equal(f.stats().length, 2); assert.ok(f.stats().every(x => x.open));
  } finally { f.stop(); H.wss.close(); }
});

test('hl-ws: reconnects after the server drops it, and drops + reopens a socket that goes silent', async () => {
  const H = await fakeHl();
  const f = createHlWsFeed({ WebSocketImpl: WebSocket, url: H.url, sets: [{ dex: '', coins: ['HYPE'] }], pingMs: 50, silentMs: 300 });
  try {
    f.start(); assert.ok(await until(() => f.mids('')));
    H.S.sockets[0].terminate();
    assert.ok(await until(() => H.S.conns === 2 && f.stats()[0].open, 5000), 'reconnected after a drop');
    H.S.silent = true; const n = H.S.conns;
    assert.ok(await until(() => H.S.conns > n, 5000), 'a silent socket is replaced');
    assert.ok(H.S.pings > 0, 'heartbeat pings sent');
  } finally { f.stop(); H.wss.close(); }
});

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
test('view markets: with Hyperliquid REST answering 429, prices + listing come from the WebSocket and no REST allMids is made', opts, async () => {
  const { createViewMarkets } = await import('../src/view.js');
  const calls = [], mine = []; const jup = fakeJupiter({ prices: { [MARKETS.SOL]: 150, [MARKETS.ETH]: 3000, [MARKETS.BTC]: 90000 } }); const inner = jup.fetch;
  jup.fetch = async (url, init = {}) => { const u = new URL(url); if (u.hostname === 'api.hyperliquid.xyz') { calls.push(JSON.parse(init.body).type); return new Response('{}', { status: 429 }); }
    if (u.hostname === 'api.coingecko.com') return new Response(JSON.stringify([{ id: 'hyperliquid', symbol: 'hype', name: 'Hyperliquid', image: 'https://coin-images.coingecko.com/coins/images/1/large/hyperliquid.png', current_price: 31.4, last_updated: new Date(e.clock.now()).toISOString() }]), { status: 200 }); return inner(url, init); };
  const e = await makeEnv({ jup, env: { VIEW_MARKETS: 'HYPE,SNDK', COINGECKO_DEMO_KEY: '' }, init: false });
  try {
    await e.app.init();
    const ws = { mids: d => ({ mids: d === 'xyz' ? { 'xyz:SNDK': '655.5' } : { HYPE: '31.5' }, at: e.clock.now() }),
      ctx: c => ({ HYPE: { oraclePx: 31.45, prevDayPx: 30, midPx: 31.5, markPx: 31.5, dayNtlVlm: 1e6, openInterest: 5e3 }, 'xyz:SNDK': { oraclePx: 655, prevDayPx: 640, midPx: 655.5, markPx: 655.5, dayNtlVlm: 2e6, openInterest: 9e3 } })[c] ? { ...({ HYPE: { oraclePx: 31.45, prevDayPx: 30, midPx: 31.5, markPx: 31.5, dayNtlVlm: 1e6, openInterest: 5e3 }, 'xyz:SNDK': { oraclePx: 655, prevDayPx: 640, midPx: 655.5, markPx: 655.5, dayNtlVlm: 2e6, openInterest: 9e3 } })[c], at: e.clock.now() } : null };
    const vFetch = (url, init = {}) => { const u = new URL(url); if (u.hostname === 'api.hyperliquid.xyz') mine.push(JSON.parse(init.body).type); return jup.fetch(url, init); };
    const v = createViewMarkets({ hlWs: ws, cfg: e.cfg, db: e.db, fetchImpl: vFetch, now: e.clock.now, setTimeoutImpl: e.clock.setTimeout, clearTimeoutImpl: e.clock.clearTimeout, bundledLogos: new Map() });
    await v.startLeader();
    assert.equal(v.Q.HYPE.listed, true, 'listed from the socket context'); assert.equal(v.Q.SNDK.coin, 'xyz:SNDK'); assert.equal(v.Q.HYPE.ctx.prevDayPx, 30);
    for (let i = 0; i < 3; i++) { await e.clock.advance(15000); await e.app.idle(); await v.recorder.idle?.(); }
    const sum = v.recorder.summary().markets;
    assert.equal(sum.HYPE.price, 31.5, 'HYPE price from the socket'); assert.equal(sum.SNDK.price, 655.5, 'SNDK price from the socket');
    assert.equal(mine.filter(t => t === 'allMids').length, 0, 'no REST allMids while the socket is fresh');
    const n = mine.length; await e.clock.advance(60000); await v.tick();
    assert.equal(mine.length, n, 'no REST context call within 10 min while the socket is fresh');
    await v.stopLeader();
  } finally { await e.drop(); }
});

test('r144.3 live prices: Hyperliquid pushes -> 1 s live ticks on /perps/live (newer than the 15 s samples), /v1/pm/px for Up/Down coins', opts, async () => {
  const H = await fakeHl(); const send = mids => H.S.sockets.forEach(s => s.send(JSON.stringify({ channel: 'allMids', data: { mids } })));
  const e = await makeEnv({ env: { VIEW_MARKETS: 'HYPE' }, extra: { WebSocketClient: WebSocket, hlWsUrl: H.url } });
  try {
    assert.ok(await until(() => H.S.conns >= 1), 'server opened the Hyperliquid socket');
    const port = await e.app.start({ port: 0, host: '127.0.0.1' }); const base = 'http://127.0.0.1:' + port;
    const c = new WebSocket('ws://127.0.0.1:' + port + '/perps/live', { headers: { origin: 'https://app.example' } }); const got = [];
    c.on('message', b => got.push(JSON.parse(String(b)))); await new Promise(r => c.on('open', r));
    c.send(JSON.stringify({ type: 'subscribe', markets: ['BTC'] })); assert.ok(await until(() => got.some(m => m.type === 'perps_subscribed')));
    send({ BTC: '90100.5', ETH: '3001', SOL: '150.2', HYPE: '31.5', XRP: '2.1', DOGE: '0.2', BNB: '905' }); await wait(80);
    await e.clock.advance(1000);
    assert.ok(await until(() => got.some(m => m.type === 'perps_tick' && m.live === true)), 'live tick arrived');
    const t1 = got.filter(m => m.type === 'perps_tick'); assert.equal(t1[t1.length - 1].price, 90100.5); assert.equal(t1[t1.length - 1].source, 'hyperliquid:allMids');
    send({ BTC: '90101', ETH: '3001', SOL: '150.2', HYPE: '31.5', XRP: '2.1', DOGE: '0.2', BNB: '905' }); await wait(60); await e.clock.advance(1000); assert.ok(await until(() => got.filter(m => m.type === 'perps_tick' && m.price === 90101).length === 1));
    const ticks = got.filter(m => m.type === 'perps_tick'); assert.deepEqual(ticks.map(m => m.seq), ticks.map((_, i) => (ticks[0].seq) + i), 'one rising seq');
    const n = ticks.length; await e.clock.advance(1000); await wait(50); assert.equal(got.filter(m => m.type === 'perps_tick').length, n, 'unchanged price is not re-sent');
    const px = await (await fetch(base + '/v1/pm/px')).json(); assert.equal(px.ok, true); assert.equal(px.prices.btc, 90101); assert.equal(px.prices.xrp, 2.1); assert.equal(px.prices.doge, 0.2);
    assert.equal((await fetch(base + '/v1/pm/px')).headers.get('cache-control'), 'no-store');
    await e.clock.advance(7000); assert.equal((await fetch(base + '/v1/pm/px')).status, 503, 'older than 5 s -> 503, never stale');
    c.close();
  } finally { await e.drop(); H.wss.close(); }
});
