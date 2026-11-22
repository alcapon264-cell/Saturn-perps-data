import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStocks, createStocks } from '../src/stocks.js';
const real = (sym, id, extra = {}) => ({ id, symbol: sym, name: sym.replace(/x$/, '') + ' xStock', isVerified: true, usdPrice: 100, liquidity: 5000, icon: 'https://xstocks-metadata.backed.fi/logos/' + sym + '.png', stats24h: { priceChange: 1.5 }, ...extra });
test('pickStocks keeps only verified Xs-mint xStocks, best liquidity per ticker, in list order', () => {
  const arr = [
    real('AAPLx', 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', { name: 'Apple xStock', usdPrice: 350.9, stats24h: { priceChange: -0.57 } }),
    { ...real('AAPLx', '2qAq8FC9B2yHQv4u58ozKpm6oVBA4iGV3c61NVkpnnKA'), name: 'Apple xStock' },          /* look-alike: not an Xs mint */
    { ...real('AAPLx', 'XsFakeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1'), isVerified: false },               /* not verified */
    real('NVDAx', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', { name: 'NVIDIA xStock', liquidity: 10 }),
    real('NVDAx', 'XsNVDAbetterLiquidityAAAAAAAAAAAAAAAAAAAAAA', { name: 'NVIDIA xStock', liquidity: 99999 }),
    real('SPYx', 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', { name: 'SP500 xStock' }),
    real('ZZZx', 'XsZZZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),                                         /* not on Saturn's list */
    real('MSFTx', 'XsMSFTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { usdPrice: 0 }),                         /* no price -> left out */
    real('TSLAx', 'XsTSLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { icon: 'javascript:alert(1)' })
  ];
  const r = pickStocks(arr);
  assert.deepEqual(r.map(x => x.ticker), ['NVDA', 'AAPL', 'TSLA', 'SPY']);
  const a = r.find(x => x.ticker === 'AAPL');
  assert.equal(a.mint, 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'); assert.equal(a.name, 'Apple'); assert.equal(a.price, 350.9); assert.equal(a.chg24, -0.57); assert.equal(a.kind, 'equity');
  assert.equal(r.find(x => x.ticker === 'NVDA').mint, 'XsNVDAbetterLiquidityAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(r.find(x => x.ticker === 'SPY').kind, 'etf');
  assert.equal(r.find(x => x.ticker === 'TSLA').icon, null);
});
test('createStocks: one GET to Jupiter with the server key, cached, last good list kept on failure', async () => {
  let calls = 0, fail = false, t = 1000;
  const fetchImpl = async (url, o) => { calls++; assert.match(url, /^https:\/\/api\.jup\.ag\/tokens\/v2\/search\?query=NVDAx%2CAAPLx/); assert.equal(o.headers['x-api-key'], 'k');
    if (fail) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, text: async () => JSON.stringify([{ id: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', symbol: 'AAPLx', name: 'Apple xStock', isVerified: true, usdPrice: 300, stats24h: { priceChange: 1 } }]) }; };
  const S = createStocks({ fetchImpl, keyHeader: 'x-api-key', key: 'k', now: () => t });
  const a = await S.get(); assert.equal(a.ok, true); assert.equal(a.stocks[0].ticker, 'AAPL'); assert.equal(calls, 1);
  await S.get(); assert.equal(calls, 1, 'cached');
  t += 25000; fail = true; const b = await S.get(); assert.equal(b.ok, true); assert.equal(b.stocks[0].price, 300);
  await new Promise(r => setTimeout(r, 10)); assert.equal(calls, 2);
});
