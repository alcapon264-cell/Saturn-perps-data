/* Separate Perps WebSocket over real sockets (ws client). [MOCK Jupiter, REAL database, REAL sockets, fake clock] */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, START, MARKETS } from './helpers/harness.js';
import { createHub } from '../src/ws.js';
import { loadConfig } from '../src/config.js';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const ORIGIN = 'https://app.example';

async function boot(extra = {}) {
  const e = await makeEnv({ ...extra, init: false });
  const port = await e.app.start({ port: 0, host: '127.0.0.1' });
  e.url = `ws://127.0.0.1:${port}/perps/live`; e.port = port; e.clients = [];
  e.client = (o = {}) => new Promise((res, rej) => {
    const ws = new WebSocket(o.url || e.url, { headers: o.origin === null ? {} : { origin: o.origin || ORIGIN }, autoPong: o.autoPong !== false });
    const c = { ws, msgs: [], closed: null, send: x => ws.send(typeof x === 'string' ? x : JSON.stringify(x)), of: t => c.msgs.filter(m => m.type === t),
      waitFor: async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = c.msgs.find(pred); if (hit) return hit; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout waiting for message; got ' + JSON.stringify(c.msgs.slice(-5))); },
      quiet: async (ms = 150) => { const n = c.msgs.length; await new Promise(r => setTimeout(r, ms)); return c.msgs.length === n; } };
    ws.on('message', d => c.msgs.push(JSON.parse(d.toString()))); ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; });
    ws.on('open', () => res(c)); ws.on('unexpected-response', (_, r) => rej(Object.assign(new Error('refused ' + r.statusCode), { status: r.statusCode }))); ws.on('error', er => { if (!c.closed) rej(er); });
    e.clients.push(c);
  });
  e.cleanup = async () => { for (const c of e.clients) try { c.ws.terminate(); } catch {} await e.drop(); };
  return e;
}
const sub = async (c, markets, tfs) => { c.send({ type: 'subscribe', markets, ...(tfs ? { tfs } : {}) }); return c.waitFor(m => m.type === 'perps_subscribed'); };

test('hello on connect: protocol fields, no raw data; path and origin enforced', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); const h = await c.waitFor(m => m.type === 'perps_hello');
    assert.equal(h.v, 1); assert.deepEqual(h.markets, ['SOL', 'ETH', 'BTC']); assert.equal(h.intervalSec, 15); assert.equal(h.source, 'jupiter-perps:market-stats'); assert.match(h.epoch, /^[0-9a-f]{12}$/); assert.deepEqual(h.timeframes, ['1m', '5m', '15m', '1h', '4h']);
    await assert.rejects(e.client({ origin: 'https://evil.example' }), e1 => e1.status === 403);
    await assert.rejects(e.client({ url: e.url.replace('/perps/live', '/live') }), e1 => e1.status === 403, 'the spot-style /live path does not exist here');
    await assert.rejects(e.client({ url: e.url + '?x=1' }), e1 => e1.status === 403);
    assert.ok(await e.client({ origin: null }), 'non-browser clients without Origin are allowed (and rate limited)');
  } finally { await e.cleanup(); }
});

test('ticks: sent only for NEW accepted observations of subscribed markets; seq monotonic; markets isolated', opts, async () => {
  const e = await boot(); try {
    const a = await e.client(), b = await e.client();
    const s = await sub(a, ['SOL']); assert.deepEqual(s.markets, ['SOL']); assert.equal(s.snapshot.SOL.state, 'no_data'); assert.equal(s.snapshot.SOL.price, null);
    await sub(b, ['ETH']);
    await e.clock.advance(61000);
    const ta = a.of('perps_tick'), tb = b.of('perps_tick');
    await a.waitFor(m => m.type === 'perps_tick' && m.seq >= 4);
    assert.ok(ta.length >= 4 && ta.every(t => t.market === 'SOL')); assert.ok(tb.every(t => t.market === 'ETH'));
    assert.deepEqual(ta.map(t => t.seq), ta.map((_, i) => i + 1), 'seq strictly increasing from 1');
    assert.ok(ta.every(t => t.price === 150 && t.source === 'jupiter-perps:market-stats' && Number.isInteger(t.observedAt) && !('persisted' in t)));
    assert.deepEqual(Object.keys(ta[0]).sort(), ['market', 'observedAt', 'price', 'seq', 'source', 'type']);
  } finally { await e.cleanup(); }
});

test('no message for rejected spikes, failed fetches or duplicate slots', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); await sub(c, ['SOL']); await e.clock.advance(31000); await c.waitFor(m => m.type === 'perps_tick'); const n0 = c.of('perps_tick').length;
    e.jup.prices[MARKETS.SOL] = 900;                                   /* 6x jump -> quarantined */
    await e.clock.advance(15000 * 2); assert.equal(await c.quiet(), true); assert.equal(c.of('perps_tick').length, n0, 'spike produced no tick');
    e.jup.prices[MARKETS.SOL] = 150; e.jup.mode[MARKETS.SOL] = 'http500'; await e.clock.advance(15000); assert.equal(await c.quiet(), true, 'failed fetch produced no tick');
    e.jup.mode[MARKETS.SOL] = 'ok'; e.app.parts.recorder._S.SOL.backoffUntil = 0; await e.clock.advance(15000);
    await c.waitFor(m => m.type === 'perps_tick' && m.seq > n0);
  } finally { await e.cleanup(); }
});

test('candle messages: forming updates, then a final complete candle with its validity flag; only subscribed timeframes', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); await sub(c, ['SOL'], ['1m']);
    await e.clock.advance(3 * 60000 + 30000);
    await c.waitFor(m => m.type === 'perps_candle' && m.final === true);
    const cs = c.of('perps_candle'); assert.ok(cs.every(m => m.tf === '1m' && m.market === 'SOL'), 'only 1m');
    const forming = cs.filter(m => !m.final), fin = cs.filter(m => m.final);
    assert.ok(forming.length >= 4 && fin.length >= 1 && forming.every(m => m.candle.status === 'forming' && !('valid' in m.candle)));
    assert.ok(fin.every(m => m.candle.status === 'complete' && typeof m.candle.valid === 'boolean'));
    for (const m of cs) { const k = m.candle; assert.ok(k.h >= k.o && k.h >= k.c && k.l <= k.o && k.l <= k.c && k.t % 60 === 0 && !('v' in k)); }
    assert.equal(fin[0].candle.valid, false, 'recording started mid-minute: first candle is kept but not valid');
  } finally { await e.cleanup(); }
});

test('staleness: a status message is sent, ticks stop (last price is NOT repeated as fresh), recovery announces live', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); await sub(c, ['SOL']); await e.clock.advance(61000); await c.waitFor(m => m.type === 'perps_tick');
    e.jup.mode[MARKETS.SOL] = 'network'; const ticksBefore = c.of('perps_tick').length;
    await e.clock.advance(60000);
    const st = await c.waitFor(m => m.type === 'perps_status' && m.state === 'stale'); assert.equal(st.market, 'SOL'); assert.ok(st.ageMs > 37500);
    await e.clock.advance(5 * 60000); await c.waitFor(m => m.type === 'perps_status' && m.state === 'down');
    assert.equal(c.of('perps_tick').length, ticksBefore, 'no ticks while stale/down');
    e.jup.mode[MARKETS.SOL] = 'ok'; e.app.parts.recorder._S.SOL.backoffUntil = 0; await e.clock.advance(30000);
    await c.waitFor(m => m.type === 'perps_status' && m.state === 'live'); await c.waitFor(m => m.type === 'perps_tick' && m.seq > ticksBefore);
  } finally { await e.cleanup(); }
});

test('protocol validation: every malformed client message gets a typed error and the socket survives', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); const err = async (payload, code) => { const n = c.of('perps_error').length; c.send(payload); await c.waitFor(m => m.type === 'perps_error' && c.of('perps_error').length > n); assert.equal(c.of('perps_error').pop().code, code, JSON.stringify(payload)); };
    await err('not json{', 'bad_json'); await err('[]', 'bad_message'); await err('5', 'bad_message'); await err('{"x":1}', 'bad_message'); await err({ type: 'nope' }, 'unknown_type');
    await err({ type: 'subscribe' }, 'bad_markets'); await err({ type: 'subscribe', markets: [] }, 'bad_markets'); await err({ type: 'subscribe', markets: 'SOL' }, 'bad_markets');
    await err({ type: 'subscribe', markets: ['SOL', 'ETH', 'BTC', 'SOL'] }, 'too_many_markets'); await err({ type: 'subscribe', markets: ['DOGE'] }, 'bad_market'); await err({ type: 'subscribe', markets: [5] }, 'bad_market'); await err({ type: 'subscribe', markets: ['__proto__'] }, 'bad_market');
    await err({ type: 'subscribe', markets: ['SOL'], tfs: ['2h'] }, 'bad_tf'); await err({ type: 'subscribe', markets: ['SOL'], tfs: 'all' }, 'bad_tf'); await err({ type: 'subscribe', markets: ['SOL'], tfs: ['1m', '5m', '15m', '1h', '4h', '1m'] }, 'bad_tf');
    await err({ type: 'unsubscribe' }, 'bad_markets');
    const s = await sub(c, ['sol']); assert.deepEqual(s.markets, ['SOL'], 'markets are case-normalised'); assert.deepEqual(s.tfs, ['1h']);
    c.send({ type: 'ping' }); await c.waitFor(m => m.type === 'pong');
  } finally { await e.cleanup(); }
});

test('subscribe limits are cumulative per connection; unsubscribe stops delivery', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); await sub(c, ['SOL', 'ETH']); c.send({ type: 'subscribe', markets: ['BTC', 'SOL'] }); await c.waitFor(m => m.type === 'perps_subscribed' && m.markets.length === 3);
    c.send({ type: 'unsubscribe', markets: ['ETH', 'BTC'] }); const u = await c.waitFor(m => m.type === 'perps_unsubscribed'); assert.deepEqual(u.markets, ['SOL']);
    await e.clock.advance(31000); await c.waitFor(m => m.type === 'perps_tick'); assert.ok(c.of('perps_tick').every(t => t.market === 'SOL'));
  } finally { await e.cleanup(); }
});

test('per-connection message rate limit and 1 KB payload cap', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); for (let i = 0; i < 40; i++) c.send({ type: 'ping' });
    await c.waitFor(m => m.type === 'perps_error' && m.code === 'rate_limited'); assert.ok(c.of('pong').length <= 30);
    const d = await e.client(); d.send(JSON.stringify({ type: 'subscribe', markets: ['SOL'], junk: 'x'.repeat(2000) }));
    await new Promise(r => setTimeout(r, 300)); assert.equal(d.closed && d.closed.code, 1009, 'oversize frame closes the connection (1009)');
  } finally { await e.cleanup(); }
});

test('per-IP connection cap; slot freed on close', opts, async () => {
  const e = await boot({ env: { WS_MAX_CONN_PER_IP: '2' } }); try {
    const a = await e.client(), b = await e.client();
    await assert.rejects(e.client(), e1 => e1.status === 403);
    a.ws.close(); await new Promise(r => setTimeout(r, 200)); assert.ok(await e.client());
  } finally { await e.cleanup(); }
});

test('heartbeat: a client that never answers pings is dropped; a normal client stays', opts, async () => {
  const e = await boot(); try {
    const good = await e.client(), dead = await e.client({ autoPong: false });
    await e.clock.advance(25000 * 3 + 100);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(dead.closed, 'unresponsive client terminated'); assert.equal(good.closed, null, 'responsive client kept');
  } finally { await e.cleanup(); }
});

test('shutdown closes sockets with 1001', opts, async () => {
  const e = await boot(); try {
    const c = await e.client(); await e.app.shutdown(); await new Promise(r => setTimeout(r, 200));
    assert.equal(c.closed && c.closed.code, 1001);
  } finally { await e.db.drop(); }
});

test('hub backpressure (fake sockets): droppable messages skipped over the soft limit, slow consumers terminated over the hard limit', () => {
  const cfg = loadConfig({}); const mk = () => { const ws = { readyState: 1, bufferedAmount: 0, sent: [], terminated: false, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, send(x) { this.sent.push(JSON.parse(x)); }, terminate() { this.terminated = true; this.readyState = 3; }, ping() {} }; return ws; };
  const hub = createHub({ cfg, epoch: 'e', snapshot: async () => ({}) }); const ws = mk(); hub.attach(ws, {});
  ws.handlers.message(JSON.stringify({ type: 'subscribe', markets: ['SOL'], tfs: ['1m'] }));
  return new Promise(r => setTimeout(r, 20)).then(() => {
    const base = ws.sent.length;
    hub.publishTick({ market: 'SOL', price: 1, observedAt: 1, seq: 1 }); assert.equal(ws.sent.length, base + 1);
    ws.bufferedAmount = cfg.ws.softBuffer + 1;
    hub.publishTick({ market: 'SOL', price: 2, observedAt: 2, seq: 2 }); assert.equal(ws.sent.length, base + 1, 'tick dropped under backpressure');
    hub.publishCandle('SOL', { tf: '1m', status: 'forming', startMs: 0, o: 1, h: 1, l: 1, c: 1, n: 1 }); assert.equal(ws.sent.length, base + 1, 'forming candle dropped');
    hub.publishCandle('SOL', { tf: '1m', status: 'complete', valid: true, startMs: 0, o: 1, h: 1, l: 1, c: 1, n: 1 }); assert.equal(ws.sent.length, base + 2, 'final candle still delivered');
    ws.bufferedAmount = cfg.ws.hardBuffer + 1; hub.publishStatus('SOL', 'stale', 1); assert.equal(ws.terminated, true, 'slow consumer terminated');
  });
});

test('hub: unsubscribed clients get nothing; closed clients are cleaned up', () => {
  const cfg = loadConfig({}); const ws = { readyState: 1, bufferedAmount: 0, sent: [], handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, send(x) { this.sent.push(JSON.parse(x)); }, ping() {}, terminate() {} };
  const hub = createHub({ cfg, epoch: 'e', snapshot: async () => ({}) }); hub.attach(ws, {}); assert.equal(hub.size, 1);
  hub.publishTick({ market: 'SOL', price: 1, observedAt: 1, seq: 1 }); assert.equal(ws.sent.filter(m => m.type === 'perps_tick').length, 0);
  ws.handlers.close(); assert.equal(hub.size, 0);
});
