import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFromSearch, pricesFrom, createStocks, SEED } from '../src/stocks.js';
const AAPL = SEED.AAPL, NV = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', FAKE = '2qAq8FC9B2yHQv4u58ozKpm6oVBA4iGV3c61NVkpnnKA';
test('pickFromSearch keeps only Xs mints named "<T>x … xStock", deepest pool', () => {
  const j = { pairs: [
    { chainId: 'solana', baseToken: { address: FAKE, symbol: 'AAPLx', name: 'Apple xStock' }, liquidity: { usd: 9e9 } },
    { chainId: 'solana', baseToken: { address: AAPL, symbol: 'AAPLx', name: 'Apple xStock' }, liquidity: { usd: 5000 } },
    { chainId: 'solana', quoteToken: { address: AAPL, symbol: 'AAPLx', name: 'Apple xStock' }, baseToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL' }, liquidity: { usd: 9000 } },
    { chainId: 'ethereum', baseToken: { address: 'XsEthAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', symbol: 'AAPLx', name: 'Apple xStock' }, liquidity: { usd: 1e9 } }] };
  assert.deepEqual(pickFromSearch(j, 'AAPL'), { mint: AAPL, name: 'Apple', liq: 9000 });
  assert.equal(pickFromSearch(j, 'MSFT'), null);
});
test('pricesFrom: deepest pool, base token only, https images only', () => {
  const m = pricesFrom([
    { chainId: 'solana', baseToken: { address: AAPL }, priceUsd: '250.1', priceChange: { h24: -1.2 }, liquidity: { usd: 100 }, info: { imageUrl: 'https://cdn.dexscreener.com/a.png' } },
    { chainId: 'solana', baseToken: { address: AAPL }, priceUsd: '251.5', priceChange: { h24: -1.0 }, liquidity: { usd: 900 }, info: { imageUrl: 'javascript:x' } },
    { chainId: 'solana', baseToken: { address: FAKE }, priceUsd: '1', liquidity: { usd: 1e9 } }]);
  assert.equal(m.size, 1); assert.deepEqual({ ...m.get(AAPL), vol24: undefined }, { price: 251.5, chg24: -1.0, icon: null, liq: 900, vol24: undefined });
});
test('createStocks: discovery verifies with ONE Jupiter call, prices from DexScreener, unverified look-alikes dropped, live socket pushes changes', async () => {
  const calls = []; let price = 178;
  const fetchImpl = async url => { calls.push(url); const ok = b => ({ ok: true, text: async () => JSON.stringify(b) });
    if (url.includes('/latest/dex/search?q=NVDAx')) return ok({ pairs: [{ chainId: 'solana', baseToken: { address: NV, symbol: 'NVDAx', name: 'NVIDIA xStock' }, liquidity: { usd: 1 } }] });
    if (url.includes('/latest/dex/search?q=MSFTx')) return ok({ pairs: [{ chainId: 'solana', baseToken: { address: 'XsUnverifiedAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', symbol: 'MSFTx', name: 'Microsoft xStock' }, liquidity: { usd: 1 } }] });
    if (url.includes('/latest/dex/search')) return ok({ pairs: [] });
    if (url.startsWith('https://api.jup.ag/tokens/v2/search')) return ok([{ id: NV, isVerified: true }, { id: 'XsUnverifiedAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', isVerified: false }]);
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) return ok(url.split('/solana/')[1].split(',').map(m => ({ chainId: 'solana', baseToken: { address: m }, priceUsd: String(m === NV ? price : 300), priceChange: { h24: 1 }, liquidity: { usd: 10 } })));
    return { ok: false, status: 404, text: async () => '' }; };
  const fast = fn => setTimeout(fn, 0);
  const S = createStocks({ fetchImpl, keyHeader: 'x-api-key', key: 'k', setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms, 1)), livePriceMs: 20 });
  await S._discover();
  assert.equal(calls.filter(u => u.startsWith('https://api.jup.ag/')).length, 1, 'one Jupiter call');
  const r = await S.get(); assert.equal(r.ok, true);
  assert.deepEqual(r.stocks.map(x => x.ticker), ['NVDA', 'AAPL', 'GOOGL', 'SPY']);
  assert.equal(r.stocks[0].price, 178); assert.equal(r.stocks[0].name, 'NVIDIA');
  const sent = []; const ws = { readyState: 1, bufferedAmount: 0, send: m => sent.push(JSON.parse(m)), on: () => {}, close: () => {} };
  S.attach(ws); await new Promise(r => setTimeout(r, 30)); assert.equal(sent[0].type, 'snap');
  price = 180; await new Promise(r => setTimeout(r, 80));
  const px = sent.find(m => m.type === 'px'); assert.ok(px); assert.deepEqual(px.rows.map(x => [x.mint, x.price]), [[NV, 180]]);
  S.stop(); void fast;
});
