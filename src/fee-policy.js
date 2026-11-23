/* r131 GLOBAL SATURN PERPS FEE POLICY — the single source of truth for Saturn's platform fee.
 *
 *   0.06% (6 basis points) of FILLED notional, per filled side, on every Perps market, chain and venue.
 *
 * No adapter, venue, market, leverage or order type may define its own Saturn rate: they all call resolve()/feeFor().
 * A venue that is not in VENUE_MECHANISMS (any future integration) still resolves to exactly 6 bps; it only reports that it has
 * no collection mechanism yet, so the fee is shown as "not collected" and is never pretended.
 * Venue-native fees, funding, borrow, price impact and network costs are separate and are NOT part of this number.
 * The frontend (index.html, script #saturn-fee-policy) carries the same constants; tests/fee-policy.test.js checks both. */

export const SATURN_PERPS_FEE_BPS = 6;
export const SATURN_PERPS_FEE = Object.freeze({
  bps: SATURN_PERPS_FEE_BPS,
  rate: SATURN_PERPS_FEE_BPS / 10000,          /* 0.0006 */
  percent: '0.06%',                             /* Hyperliquid approveBuilderFee maxFeeRate string */
  hlBuilderTenthsBp: SATURN_PERPS_FEE_BPS * 10  /* Hyperliquid builder "f" is in tenths of a basis point -> 60 */
});

/* how each venue can collect the SAME Saturn fee (never a different rate) */
export const VENUE_MECHANISMS = Object.freeze({
  'hyperliquid': Object.freeze({ mechanism: 'hyperliquid-builder-code', cap: 0.001 }),       /* protocol cap 0.1% on perps */
  'hyperliquid:xyz': Object.freeze({ mechanism: 'hyperliquid-builder-code', cap: 0.001 }),   /* Trade.xyz HIP-3 orders carry the same builder field */
  'solana': Object.freeze({ mechanism: null, limitation: 'The Solana Perps program has no integrator-fee mechanism, and its orders are filled later by a keeper, so a fee taken when the order is signed could be charged on an order that never fills.' })
});

/* every Perps market Saturn lists today -> its venue (new markets must be added here; the test fails if one is missing) */
export const MARKET_VENUES = Object.freeze({
  SOL: 'solana', ETH: 'solana', BTC: 'solana',
  HYPE: 'hyperliquid', ZEC: 'hyperliquid', JUP: 'hyperliquid', NEAR: 'hyperliquid', BNB: 'hyperliquid',
  SNDK: 'hyperliquid:xyz', SPCX: 'hyperliquid:xyz', SKHYNIX: 'hyperliquid:xyz',
  /* r179 */
  DOGE: 'hyperliquid', XRP: 'hyperliquid', SUI: 'hyperliquid', AVAX: 'hyperliquid', LINK: 'hyperliquid', LTC: 'hyperliquid', ADA: 'hyperliquid', TRX: 'hyperliquid', AAVE: 'hyperliquid', ENA: 'hyperliquid', WIF: 'hyperliquid', FARTCOIN: 'hyperliquid', PUMP: 'hyperliquid', TRUMP: 'hyperliquid', PENGU: 'hyperliquid', ARB: 'hyperliquid', APT: 'hyperliquid', DOT: 'hyperliquid', BCH: 'hyperliquid', ONDO: 'hyperliquid', TIA: 'hyperliquid', WLD: 'hyperliquid', UNI: 'hyperliquid', OP: 'hyperliquid', INJ: 'hyperliquid', SEI: 'hyperliquid',
  TSLA: 'hyperliquid:xyz', NVDA: 'hyperliquid:xyz', AAPL: 'hyperliquid:xyz', MSFT: 'hyperliquid:xyz', GOOGL: 'hyperliquid:xyz', AMZN: 'hyperliquid:xyz', META: 'hyperliquid:xyz', COIN: 'hyperliquid:xyz', HOOD: 'hyperliquid:xyz', PLTR: 'hyperliquid:xyz', MSTR: 'hyperliquid:xyz', AMD: 'hyperliquid:xyz', NFLX: 'hyperliquid:xyz'
});

/* The rate never depends on the venue. Only the collection mechanism does. */
export function feeFor(venue) {
  const v = VENUE_MECHANISMS[venue] || null;
  const mechanism = v ? v.mechanism : null;
  return Object.freeze({ venue: String(venue), bps: SATURN_PERPS_FEE.bps, rate: SATURN_PERPS_FEE.rate, percent: SATURN_PERPS_FEE.percent, mechanism,
    supported: !!mechanism && (!v.cap || SATURN_PERPS_FEE.rate <= v.cap),
    limitation: mechanism ? null : (v && v.limitation) || 'No Saturn fee collection mechanism is registered for this venue yet.' });
}
export const feeForMarket = market => feeFor(MARKET_VENUES[String(market || '').toUpperCase()] || 'unknown:' + market);

/* fee on FILLED notional only: unfilled / cancelled = 0, partial fills pay proportionally */
export function feeOnExecuted(filledNotionalUsd) {
  const n = Number(filledNotionalUsd);
  return Number.isFinite(n) && n > 0 ? n * SATURN_PERPS_FEE.rate : 0;
}

/* Hyperliquid builder object for an order, or null when no fee wallet is configured */
export function hlBuilder(feeWallet) {
  return /^0x[0-9a-f]{40}$/.test(String(feeWallet || '')) ? Object.freeze({ b: String(feeWallet), f: SATURN_PERPS_FEE.hlBuilderTenthsBp }) : null;
}
