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
