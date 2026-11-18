/* r124 ONE market registry and ONE market contract for all 11 markets.
 * The registry is composed from the two existing tables (MARKETS/MARKET_META for the Jupiter Perps markets, VIEW_MARKET_TABLE for the
 * view-only markets); it adds no new identifiers. Every row the API or the WebSocket snapshot returns goes through toContract(), so the app
 * always receives exactly the same fields for every market, whichever provider priced it.
 *
 * provider     who supplied the price            'jupiter-perps' | 'hyperliquid'
 * venue        where that price is formed        'jupiter-perps' (Solana) | 'hyperliquid' (main perps) | 'hyperliquid:xyz' (Trade.xyz HIP-3)
 * priceKind    what the number is                'jupiter_perps_market_price' | 'hyperliquid_perp_mid'
 * executable   true ONLY for SOL/ETH/BTC (Jupiter custody exists); a published price never makes a market tradable
 * source       the observation source tag stored with every row ('jupiter-perps:market-stats' | 'hyperliquid:allMids') */
import { MARKETS, MARKET_KEYS, MARKET_META, SOURCE, VIEW_MARKET_TABLE, VIEW_SOURCE } from './config.js';
import { CUSTODY } from './perps-program.js';

export const REGISTRY = Object.freeze(Object.fromEntries([
  ...MARKET_KEYS.map(k => [k, Object.freeze({
    market: k, name: (MARKET_META[k] || {}).name || null, category: (MARKET_META[k] || {}).category || 'major',
    provider: 'jupiter-perps', venue: 'jupiter-perps', providerMarketId: MARKETS[k], priceKind: 'jupiter_perps_market_price',
    source: SOURCE, check: null, executable: !!CUSTODY[k], viewOnly: false
  })]),
  ...Object.entries(VIEW_MARKET_TABLE).map(([k, d]) => [k, Object.freeze({
    market: k, name: d.name, category: d.category,
    provider: 'hyperliquid', venue: d.dex ? 'hyperliquid:' + d.dex : 'hyperliquid', providerMarketId: d.venueCoins[0], priceKind: 'hyperliquid_perp_mid',
    source: VIEW_SOURCE, check: d.check, executable: false, viewOnly: true
  })])
]));
for (const [k, r] of Object.entries(REGISTRY)) if (r.viewOnly && (r.executable || k in MARKETS || k in CUSTODY)) throw new Error('view-only market ' + k + ' must never be executable');

/* the contract: every market row has exactly these keys (absent values are null; nothing is invented) */
export const CONTRACT_FIELDS = Object.freeze(['ageMs', 'category', 'change24h', 'crossCheck', 'executable', 'history', 'icon', 'market', 'maxLeverage', 'mint', 'name', 'observedAt',
  'openInterest', 'price', 'priceKind', 'provider', 'source', 'state', 'stats24h', 'status', 'symbol', 'venue', 'venueCoin', 'viewOnly', 'volume24h']);

export function toContract(row) {
  const r = REGISTRY[row && row.market]; if (!r) return null;
  const out = {};
  for (const f of CONTRACT_FIELDS) out[f] = row[f] === undefined ? null : row[f];
  /* identity, provider and eligibility always come from the registry, never from a provider response */
  Object.assign(out, { market: r.market, symbol: r.market + '-PERP', name: r.name, category: r.category, provider: r.provider, venue: r.venue, priceKind: r.priceKind, source: r.source,
    executable: r.executable, viewOnly: r.viewOnly, volume24h: null, openInterest: null });
  if (!out.status) out.status = out.price != null ? 'ok' : (out.state === 'down' ? 'down' : out.state === 'no_data' ? 'no_data' : 'unavailable');
  return out;
}
