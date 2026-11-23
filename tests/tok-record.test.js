import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { createTokLive } from '../src/tok-live.js';
import { createTokMeta } from '../src/tok-meta.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const id = (s, n = 44) => (s + A.repeat(3)).replace(/[^1-9A-HJ-NP-Za-km-z]/g, '').slice(0, n);
const W1 = id('Walla'), W2 = id('Wallb'), M1 = id('Snow'), M2 = id('Fire'), SIG = k => id('Sig' + k, 88);
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await wait(20); } return false; };
async function upstream() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => wss.on('listening', r));
  const st = { conns: [] }; wss.on('connection', c => st.conns.push(c));
  st.url = 'ws://127.0.0.1:' + wss.address().port + '/';
  st.send = o => st.conns.filter(c => c.readyState === 1).forEach(c => c.send(JSON.stringify(o)));
  st.close = () => new Promise(r => { st.conns.forEach(c => c.terminate()); wss.close(r); });
  return st;
}

test('tok-live record: every stream trade is kept per wallet with token names, even when nobody watches; bounded', async () => {
  const pa = await upstream();
  const T = createTokLive({ WebSocketImpl: WebSocket, urls: { pumpapi: pa.url }, upstreams: ['pumpapi'], statsMs: 3600000, record: true, recPerWallet: 3, recWallets: 2 });
  T.start(); T._beat();
  /* r171d: recording rides along while the stream is open for someone; it no longer keeps the stream open by itself (CPU) */
  await wait(300); assert.equal(pa.conns.length, 0, 'no browser -> no upstream');
  const cs = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => cs.on('listening', r)); cs.on('connection', ws => T.attach(ws, {}));
  const cl = new WebSocket('ws://127.0.0.1:' + cs.address().port); await new Promise(r => cl.on('open', r)); cl.send(JSON.stringify({ type: 'sub', mints: [], wallets: [], trades: true, bigMin: 5 }));
  T._beat(); assert.ok(await until(() => pa.conns.length === 1), 'a Pulse browser opens the upstream');
  pa.send({ mint: M1, action: 'buy', txSigner: W1, signature: SIG('a'), quoteAmount: 1.5, baseAmount: 1e6, price: 1.5e-6, timestamp: 1700000000, name: 'Snow Coin', symbol: 'SNOW', uri: 'https://ipfs.io/ipfs/abc' });
  pa.send({ mint: M2, action: 'sell', txSigner: W1, signature: SIG('b'), quoteAmount: 0.4, baseAmount: 2e5, price: 2e-6, timestamp: 1700000100 });
  pa.send({ mint: M2, action: 'sell', txSigner: W1, signature: SIG('b'), quoteAmount: 0.4, baseAmount: 2e5, price: 2e-6, timestamp: 1700000100 });   /* duplicate */
  pa.send({ mint: M1, action: 'buy', txSigner: W2, signature: SIG('c'), quoteAmount: 0.1, baseAmount: 1e5, price: 1e-6, timestamp: 1700000200, quoteMint: 'NotSoL1111111111111111111111111111111111111' });   /* not a SOL pair */
  assert.ok(await until(() => T.walletTrades(W1).length === 2));
  const tr = T.walletTrades(W1);
  assert.deepEqual(tr.map(x => [x.sig, x.mint, x.side, x.sol, x.tok, x.at]), [[SIG('b'), M2, 'sell', 0.4, 2e5, 1700000100], [SIG('a'), M1, 'buy', 1.5, 1e6, 1700000000]]);
  assert.equal(tr[1].name, 'Snow Coin'); assert.equal(tr[1].symbol, 'SNOW');
  assert.equal(T.walletTrades(W2).length, 0);
  assert.deepEqual(T.meta([M1]), { [M1]: { name: 'Snow Coin', symbol: 'SNOW', uri: 'https://ipfs.io/ipfs/abc' } });
  for (let i = 0; i < 5; i++) pa.send({ mint: M1, action: 'buy', txSigner: W1, signature: SIG('x' + A[i]), quoteAmount: 1, baseAmount: 1, price: 1, timestamp: 1700000300 + i });
  assert.ok(await until(() => T.walletTrades(W1)[0].at === 1700000304));
  assert.equal(T.walletTrades(W1).length, 3, 'per-wallet cap');
  pa.send({ mint: M1, action: 'buy', txSigner: id('Wallc'), signature: SIG('y'), quoteAmount: 1, baseAmount: 1, price: 1 });
  pa.send({ mint: M1, action: 'buy', txSigner: id('Walld'), signature: SIG('z'), quoteAmount: 1, baseAmount: 1, price: 1 });
  assert.ok(await until(() => T.stats().recWallets === 2 && T.walletTrades(W1).length === 0), 'oldest wallets dropped beyond the cap');
  T.stop(); cl.close(); cs.close(); await pa.close();
});

test('tok-meta: picture from the metadata uri, Pump.fun fallback, unsafe hosts refused, cached', async () => {
  const calls = [];
  const fetchImpl = async url => { calls.push(url);
    if (url === 'https://ipfs.io/ipfs/abc') return { ok: true, text: async () => JSON.stringify({ name: 'Snow Coin', symbol: 'SNOW', image: 'https://ipfs.io/ipfs/img1' }) };
    if (url === 'https://frontend-api-v3.pump.fun/coins/' + M2) return { ok: true, text: async () => JSON.stringify({ mint: M2, name: 'Fire', symbol: 'FIRE', image_uri: 'ipfs://img2' }) };
    return { ok: false, text: async () => '' }; };
  const live = { meta: ms => { const o = {}; ms.forEach(m => { if (m === M1) o[m] = { name: 'Snow Coin', symbol: 'SNOW', uri: 'https://ipfs.io/ipfs/abc' }; if (m === id('Evil')) o[m] = { name: 'E', symbol: 'E', uri: 'https://127.0.0.1/x' }; }); return o; } };
  const TM = createTokMeta({ fetchImpl, tok: () => live });
  const r = await TM.resolve([M1, M2, id('Evil'), 'bad']);
  assert.deepEqual(r.meta[M1], { name: 'Snow Coin', symbol: 'SNOW', image: 'https://ipfs.io/ipfs/img1' });
  assert.deepEqual(r.meta[M2], { name: 'Fire', symbol: 'FIRE', image: 'https://ipfs.io/ipfs/img2' });
  assert.equal(r.meta[id('Evil')].image, null);
  assert.ok(!calls.some(u => u.includes('127.0.0.1')), 'never fetches a private address');
  const n = calls.length; await TM.resolve([M1, M2]); assert.equal(calls.length, n, 'cached');
});

test('r177 price history: 1-second SOL candles per token from the stream, aggregated on request, bounded', async () => {
  const pa = await upstream(); let t0 = 1800000020000;
  const T = createTokLive({ WebSocketImpl: WebSocket, urls: { pumpapi: pa.url }, upstreams: ['pumpapi'], statsMs: 3600000, record: true, now: () => t0, pxPerMint: 4, pxTotal: 6 });
  T.start();
  const cs = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => cs.on('listening', r)); cs.on('connection', ws => T.attach(ws, {}));
  const cl = new WebSocket('ws://127.0.0.1:' + cs.address().port); await new Promise(r => cl.on('open', r)); cl.send(JSON.stringify({ type: 'sub', mints: [M1], trades: true }));
  T._beat(); assert.ok(await until(() => pa.conns.length === 1));
  const ts = 1800000000;
  const tr = (m, p, t, q = 0.01, qm) => pa.send({ mint: m, action: 'buy', txSigner: W1, signature: SIG('p' + p + t), quoteAmount: q, price: p, timestamp: t * 1000, ...(qm ? { quoteMint: qm } : {}) });
  tr(M1, 2, ts); tr(M1, 3, ts); tr(M1, 1, ts); tr(M1, 2.5, ts + 1); tr(M1, 9, ts + 1, 1, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.ok(await until(() => T.candles(M1).length === 2));
  const c = T.candles(M1); assert.deepEqual(c[0].slice(0, 5), [ts, 2, 3, 1, 1]); assert.deepEqual(c[1].slice(0, 5), [ts + 1, 2.5, 2.5, 2.5, 2.5], 'non-SOL quote ignored');
  assert.ok(Math.abs(c[0][5] - 0.03) < 1e-9);
  for (let k = 2; k < 8; k++) tr(M1, 1 + k, ts + k);
  assert.ok(await until(() => T.candles(M1).at(-1)[0] === ts + 7));
  assert.equal(T.candles(M1).length, 4, 'pxPerMint cap'); assert.deepEqual(T.candles(M1, 5).map(x => x[0]), [ts, ts + 5].filter(b => T.candles(M1).some(x => Math.floor(x[0] / 5) * 5 === b)));
  tr(M2, 1, ts + 8); tr(M2, 1, ts + 9); tr(M2, 1, ts + 10);
  assert.ok(await until(() => T.candles(M2).length === 3)); assert.ok(T.stats().pxCandles <= 6, 'pxTotal cap');
  cl.close(); T.stop(); cs.close(); await pa.close();
});

test('r199 discover feed: New = created / fresh-curve tokens of the last minute; Hot = many distinct buyers, real buy volume, rising market cap', async () => {
  const pa = await upstream(); let t0 = 1800000000000;
  const T = createTokLive({ WebSocketImpl: WebSocket, urls: { pumpapi: pa.url }, upstreams: ['pumpapi'], statsMs: 3600000, record: true, now: () => t0 });
  T.start();
  const cs = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => cs.on('listening', r)); cs.on('connection', ws => T.attach(ws, {}));
  const cl = new WebSocket('ws://127.0.0.1:' + cs.address().port); await new Promise(r => cl.on('open', r)); cl.send(JSON.stringify({ type: 'sub', mints: [M1], trades: true }));
  T._beat(); assert.ok(await until(() => pa.conns.length === 1));
  const NEW = id('Newc'), HOT = id('Hotc'), OLD = id('Oldc');
  pa.send({ mint: NEW, action: 'create', txSigner: W1, signature: SIG('c'), name: 'Fresh', symbol: 'FRS', marketCapSol: 28, marketCapUsd: 3900, priceUsd: 0.0000039, timestamp: 1 });
  pa.send({ mint: OLD, action: 'buy', txSigner: W1, signature: SIG('o'), quoteAmount: 1, marketCapSol: 900, marketCapUsd: 126000, priceUsd: 0.000126, timestamp: 1 });
  for (let i = 0; i < 12; i++) pa.send({ mint: HOT, action: 'buy', txSigner: id('Wx' + 'abcdefghjkmnpqrstuvw'[i]), signature: SIG('h' + i), quoteAmount: 0.5, marketCapSol: 100 + i * 5, marketCapUsd: 14000 + i * 700, priceUsd: 0.000014, timestamp: 1 });
  assert.ok(await until(() => T.feed('hot').length === 1 && T.feed('new').length >= 1));
  const nw = T.feed('new').map(x => x.mint); assert.ok(nw.includes(NEW), 'created token is new'); assert.ok(!nw.includes(OLD), 'an old token waking up is not new (server just started)');
  const h = T.feed('hot')[0]; assert.equal(h.mint, HOT); assert.equal(h.traders, 12); assert.ok(h.chg > 5);
  t0 += 61000; assert.ok(!T.feed('new').some(x => x.mint === NEW), 'after a minute it is no longer new');
  cl.close(); T.stop(); cs.close(); await pa.close();
});

test('r200 launches are pushed to New-tab clients the moment they happen; a New-tab client alone keeps the stream open', async () => {
  const pa = await upstream();
  const T = createTokLive({ WebSocketImpl: WebSocket, urls: { pumpapi: pa.url }, upstreams: ['pumpapi'], statsMs: 3600000, record: true });
  T.start(); const metaSeen = []; T.onNew(t => metaSeen.push(...t.map(x => x.mint)));
  const cs = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => cs.on('listening', r)); cs.on('connection', ws => T.attach(ws, {}));
  const cl = new WebSocket('ws://127.0.0.1:' + cs.address().port); const got = []; cl.on('message', d => got.push(JSON.parse(String(d))));
  await new Promise(r => cl.on('open', r)); cl.send(JSON.stringify({ type: 'sub', mints: [], newFeed: true }));
  assert.ok(await until(() => pa.conns.length === 1), 'the New tab alone opens the upstream');
  assert.ok(await until(() => got.some(m => m.type === 'newtoks')), 'snapshot first');
  const NEW = id('Pushc'); pa.send({ mint: NEW, action: 'create', txSigner: W1, signature: SIG('pc'), name: 'Pushy', symbol: 'PSH', marketCapSol: 28, marketCapUsd: 3900, priceUsd: 0.0000039 });
  assert.ok(await until(() => got.some(m => m.type === 'newtok' && m.tokens.some(x => x.mint === NEW))), 'pushed');
  assert.deepEqual(metaSeen, [NEW], 'picture lookup hook called');
  T.pushMeta([{ mint: NEW, image: 'https://x.example/a.png' }]); assert.ok(await until(() => got.some(m => m.type === 'newmeta')));
  cl.close(); T.stop(); cs.close(); await pa.close();
});
