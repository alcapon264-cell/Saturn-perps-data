/* Scripted Hyperliquid (main + xyz), CoinGecko, logo CDN and Jupiter for tests. NOT production code; never touches the network. */
import { fakeJupiter, MARKETS } from './harness.js';
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
export const J = (o, status = 200) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
export function fakeSources() {
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
      if (body.type === 'perpDexs') return J([null, { name: 'flx' }, { name: 'xyz' }]);   /* r132 */
      if (body.type === 'candleSnapshot') { S.candleReqs = (S.candleReqs || []).concat([body.req]); return J(S.candles ? S.candles(body.req) : []); }   /* r132 */
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

