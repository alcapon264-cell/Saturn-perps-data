import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { createTokLive } from '../src/tok-live.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mint = s => (s + A.repeat(2)).replace(/[^1-9A-HJ-NP-Za-km-z]/g, '').slice(0, 44);
const M1 = mint('Snow'), M2 = mint('Fire'), M3 = mint('Goat');
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await wait(20); } return false; };

/* fake upstream servers on 127.0.0.1 */
async function upstream() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => wss.on('listening', r));
  const st = { conns: [], got: [] };
  wss.on('connection', c => { st.conns.push(c); c.on('message', d => st.got.push(JSON.parse(String(d)))); });
  st.url = 'ws://127.0.0.1:' + wss.address().port + '/';
  st.send = o => st.conns.filter(c => c.readyState === 1).forEach(c => c.send(typeof o === 'string' ? o : JSON.stringify(o)));
  st.close = () => new Promise(r => { st.conns.forEach(c => c.terminate()); wss.close(r); });
  return st;
}
/* fake browser socket */
function browser() { const b = new EventEmitter(); b.readyState = 1; b.out = []; b.send = d => b.out.push(JSON.parse(d)); b.close = () => b.emit('close'); b.msg = o => b.emit('message', Buffer.from(JSON.stringify(o))); return b; }

test('tok-live: forwards only the trades of the tokens a browser watches, coalesced, from both upstreams', async () => {
  const pa = await upstream(), pp = await upstream();
  const T = createTokLive({ WebSocketImpl: WebSocket, urls: { pumpapi: pa.url, pumpportal: pp.url }, coalesceMs: 60, statsMs: 3600000 });
  T.start();
  const b1 = browser(), b2 = browser(); T.attach(b1); T.attach(b2);
  assert.equal(b1.out[0].type, 'hello');
  assert.equal(pa.conns.length + pp.conns.length, 0, 'no upstream until someone watches a token');
  b1.msg({ type: 'sub', mints: [M1, M2, 'not-a-mint'] }); b2.msg({ type: 'sub', mints: [M3] });
  assert.ok(await until(() => pa.conns.length === 1 && pp.conns.length === 1), 'both upstreams opened');
  assert.ok(await until(() => pp.got.some(g => g.method === 'subscribeTokenTrade' && [M1, M2, M3].every(m => g.keys.includes(m)))), 'PumpPortal subscribed to the union');
  pa.send({ mint: M1, action: 'buy', price: 2e-6, marketCapQuote: 2000 });
  pa.send({ mint: mint('Other'), action: 'buy', price: 1 });
  pp.send({ mint: M3, txType: 'sell', solAmount: 1, tokenAmount: 500000, marketCapSol: 300 });
  assert.ok(await until(() => b1.out.some(x => x.type === 'tok') && b2.out.some(x => x.type === 'tok')));
  const t1 = b1.out.filter(x => x.type === 'tok'), t2 = b2.out.filter(x => x.type === 'tok');
  assert.deepEqual(t1.map(x => [x.mint, x.p, x.mc, x.side, x.src]), [[M1, 2e-6, 2000, 'buy', 'pumpapi']]);
  assert.deepEqual(t2.map(x => [x.mint, x.p, x.mc, x.side, x.src]), [[M3, 2e-6, 300, 'sell', 'pumpportal']]);
  /* a burst of trades of one token reaches the browser as one message carrying the newest price and the trade count */
  b1.out.length = 0; for (let i = 1; i <= 5; i++) pa.send({ mint: M2, action: 'buy', price: Number(i + 'e-6') });
  assert.ok(await until(() => b1.out.some(x => x.mint === M2))); await wait(120);
  const t3 = b1.out.filter(x => x.mint === M2); assert.equal(t3.length, 1); assert.equal(t3[0].p, 5e-6); assert.equal(t3[0].n, 5);
  /* unsubscribing: after the grace period PumpPortal is told to stop; when nobody watches anything upstreams close */
  b2.msg({ type: 'sub', mints: [] }); b1.close();
  assert.equal(T.stats().mints, 0);
  T.stop(); await pa.close(); await pp.close();
});

test('tok-live: browser input is bounded (40 mints, rate limit, ping/pong) and the URL cannot be pointed elsewhere', async () => {
  assert.throws(() => createTokLive({ WebSocketImpl: WebSocket, urls: { pumpapi: 'wss://evil.example/' } }), /tok_live_url_not_allowed/);
  const T = createTokLive({ WebSocketImpl: null });
  const b = browser(); T.attach(b);
  b.msg({ type: 'sub', mints: Array.from({ length: 60 }, (_, i) => mint('M' + A[i % 58] + A[(i * 7) % 58])) });
  assert.ok(T.stats().mints <= 40);
  b.msg({ type: 'ping' }); assert.equal(b.out.at(-1).type, 'pong');
  for (let i = 0; i < 40; i++) b.msg({ type: 'ping' });
  assert.ok(b.out.filter(x => x.type === 'pong').length <= 30);
  b.close(); assert.equal(T.stats().mints, 0); T.stop();
});

/* end to end through the real service: origin check, /tokens/live upgrade, trades forwarded */
import { makeEnv } from './helpers/harness.js';
test('tok-live: /tokens/live on the real server (origin checked) delivers watched trades; /perps/live is unchanged', { timeout: 60000 }, async t => {
  const pa = await upstream(), pp = await upstream();
  const e = await makeEnv({ extra: { WebSocketClient: WebSocket, tokLiveUrls: { pumpapi: pa.url, pumpportal: pp.url } } });
  if (!e) { t.skip('no test database'); await pa.close(); await pp.close(); return; }
  try {
    const port = await e.app.start({ port: 0, host: '127.0.0.1' });
    const bad = new WebSocket('ws://127.0.0.1:' + port + '/tokens/live', { headers: { origin: 'https://evil.example' } });
    assert.ok(await new Promise(r => { bad.on('error', () => r(true)); bad.on('open', () => r(false)); }), 'foreign origin refused');
    const c = new WebSocket('ws://127.0.0.1:' + port + '/tokens/live', { headers: { origin: 'https://app.example' } }); const got = [];
    c.on('message', b => got.push(JSON.parse(String(b)))); await new Promise(r => c.on('open', r));
    assert.ok(await until(() => got.some(m => m.type === 'hello')));
    c.send(JSON.stringify({ type: 'sub', mints: [M1] }));
    assert.ok(await until(async () => { await e.clock.advance(100); return pa.conns.length === 1; }), 'server opened the upstream');
    pa.send({ mint: M1, action: 'sell', price: 3e-6, marketCapQuote: 3000 });
    assert.ok(await until(async () => { await e.clock.advance(300); return got.some(m => m.type === 'tok'); }));
    const m = got.find(x => x.type === 'tok'); assert.equal(m.mint, M1); assert.equal(m.p, 3e-6); assert.equal(m.side, 'sell');
    const pc = new WebSocket('ws://127.0.0.1:' + port + '/perps/live', { headers: { origin: 'https://app.example' } });
    assert.ok(await new Promise(r => { pc.on('open', () => r(true)); pc.on('error', () => r(false)); }), '/perps/live still opens');
    pc.close(); c.close();
  } finally { await e.drop(); await pa.close(); await pp.close(); }
});

test('tok-live r162: Pulse clients get every trade (signature, wallet, amounts) for watched tokens AND followed wallets', async () => {
  const pa = await upstream();
  const T = createTokLive({ WebSocketImpl: WebSocket, upstreams: ['pumpapi'], urls: { pumpapi: pa.url }, coalesceMs: 40, statsMs: 3600000 });
  T.start();
  try {
    const W1 = mint('Walletone'), SIG = A.repeat(2).slice(0, 88);
    const pulse = browser(), disc = browser(); T.attach(pulse); T.attach(disc);
    pulse.msg({ type: 'sub', mints: [M1], wallets: [W1], trades: true }); disc.msg({ type: 'sub', mints: [M1] });
    assert.ok(await until(() => pa.conns.length === 1));
    pa.send({ mint: M1, action: 'buy', price: 2e-6, solAmount: 0.5, tokenAmount: 250000, signature: SIG, traderPublicKey: mint('Someone'), timestamp: 1763820000 });
    pa.send({ mint: M3, action: 'sell', price: 1e-6, solAmount: 0.2, tokenAmount: 200000, signature: SIG.replace(/^./, 'Z'), traderPublicKey: W1 });
    pa.send({ mint: M2, action: 'buy', price: 1e-6, signature: SIG.replace(/^./, 'Y'), traderPublicKey: mint('Nobody') });
    assert.ok(await until(() => pulse.out.filter(x => x.type === 'trade').length === 2));
    const tr = pulse.out.filter(x => x.type === 'trade');
    assert.deepEqual(tr.map(x => [x.mint, x.side, x.sol, x.tok, x.at]), [[M1, 'buy', 0.5, 250000, 1763820000], [M3, 'sell', 0.2, 200000, tr[1].at]]);
    assert.equal(tr[0].sig, SIG); assert.equal(tr[1].w, W1);
    await wait(150);
    assert.equal(disc.out.filter(x => x.type === 'trade').length, 0, 'Discover clients (no trades:true) never get per-trade messages');
    assert.ok(disc.out.some(x => x.type === 'tok' && x.mint === M1), 'but still get the coalesced price');
    assert.equal(T.stats().wallets, 1);
    pulse.close(); disc.close(); assert.equal(T.stats().wallets, 0);
  } finally { T.stop(); await pa.close(); }
});

test('tok-live r163: big buys on ANY token reach Pulse clients that asked (bigMin), replayed on subscribe, plus last prices', async () => {
  const pa = await upstream();
  const T = createTokLive({ WebSocketImpl: WebSocket, upstreams: ['pumpapi'], urls: { pumpapi: pa.url }, coalesceMs: 40, statsMs: 3600000 });
  T.start();
  try {
    const SIG = n => (A.repeat(2).slice(0, 87) + A[n]);
    const watcher = browser(); T.attach(watcher); watcher.msg({ type: 'sub', mints: [M1] });       /* keeps the upstream open */
    assert.ok(await until(() => pa.conns.length === 1));
    pa.send({ mint: M2, action: 'buy', price: 1e-6, quoteAmount: 2.5, tokenAmount: 2500000, signature: SIG(1), txSigner: mint('Whale'), name: 'Big<b>Coin', symbol: 'BIG' });
    pa.send({ mint: M3, action: 'buy', price: 1e-6, quoteAmount: 0.1, tokenAmount: 100000, signature: SIG(2), txSigner: mint('Small') });
    pa.send({ mint: M3, action: 'sell', price: 1e-6, quoteAmount: 9, tokenAmount: 100000, signature: SIG(3), txSigner: mint('Seller') });
    await wait(150);
    const pulse = browser(); T.attach(pulse); pulse.msg({ type: 'sub', mints: [M2], trades: true, bigMin: 1 });
    assert.ok(await until(() => pulse.out.some(x => x.type === 'trade')));
    const rep = pulse.out.filter(x => x.type === 'trade');
    assert.deepEqual(rep.map(x => [x.mint, x.side, x.sol, x.big, x.recent, x.name, x.symbol]), [[M2, 'buy', 2.5, true, true, 'BigbCoin', 'BIG']], 'only the big BUY is replayed (not the small buy, not the sell); text is cleaned');
    assert.ok(pulse.out.some(x => x.type === 'tok' && x.mint === M2 && x.src === 'last'), 'last known price of a newly watched token is sent at once');
    pulse.out.length = 0;
    pa.send({ mint: mint('Fresh'), action: 'buy', price: 2e-6, quoteAmount: 1.2, tokenAmount: 600000, signature: SIG(4), txSigner: mint('Buyer') });
    pa.send({ mint: mint('Fresh'), action: 'buy', price: 2e-6, quoteAmount: 0.7, tokenAmount: 350000, signature: SIG(5), txSigner: mint('Buyer') });
    assert.ok(await until(() => pulse.out.some(x => x.type === 'trade')));
    await wait(100);
    assert.deepEqual(pulse.out.filter(x => x.type === 'trade').map(x => x.sol), [1.2], 'live: only buys >= the client\'s bigMin (1 SOL), on a token nobody watches');
    assert.equal(watcher.out.filter(x => x.type === 'trade').length, 0);
  } finally { T.stop(); await pa.close(); }
});
