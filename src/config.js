/* Configuration. Everything comes from environment variables or explicit injection; nothing secret is ever hard-coded or logged. */
import { EXECUTE_CONTRACT_VERIFIED } from './perps-program.js';

export const SOURCE = 'jupiter-perps:market-stats';

/* Fixed server-side market table. Users can never supply a mint, host or path. (Same mints as the Saturn R115 adapter.) */
export const MARKETS = Object.freeze({
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'
});
export const MARKET_KEYS = Object.freeze(Object.keys(MARKETS));
/* r119 market metadata, one entry per market this service actually records and the venue lists.
   category: 'major' (crypto majors) or 'stock' (tracks a share price). maxLeverage is SATURN's limit for the market (the venue may allow more).
   To add a market: add its mint to MARKETS (so the recorder prices it) and an entry here; it then appears in the app automatically.
   It is only tradeable when its execution metadata exists in src/perps-program.js (CUSTODY). */
export const MARKET_META = Object.freeze({
  SOL: Object.freeze({ name: 'Solana', category: 'major', maxLeverage: 20 }),
  ETH: Object.freeze({ name: 'Ethereum', category: 'major', maxLeverage: 20 }),
  BTC: Object.freeze({ name: 'Bitcoin', category: 'major', maxLeverage: 20 })
});

/* Magnitude guard (S2 finding). Deliberately wide (about 100x either way around the prices seen live on 2026-11-16: SOL 70.8, ETH 1,807, BTC 64,423).
 * It exists to stop a unit/scale change (e.g. an x1e6 or x1e-6 price) from being accepted as the first observation, before the jump filter has a baseline.
 * Override per market with PRICE_RANGE_SOL="min,max" etc. */
export const DEFAULT_PRICE_RANGE = Object.freeze({ SOL: [0.5, 50000], ETH: [20, 500000], BTC: [1000, 5000000] });

/* r120 VIEW-ONLY markets. Fixed server-side table: users can never supply a coin, id or host.
 * Price: Hyperliquid public allMids (free, no key). Cross-check: CoinGecko Demo (free key, backend only). Never executable:
 * none of these keys exists in MARKETS or in perps-program.js CUSTODY, and the gateway refuses anything outside SOL/ETH/BTC.
 * coingecko.symbol / coingecko.name are what CoinGecko must return for that id; a mismatch means the id is wrong and the market stays hidden.
 * logo: 'coingecko' = the image URL CoinGecko returns for the verified id; null = no logo is used (see BNB below). */
export const VIEW_SOURCE = 'hyperliquid:allMids';
/* dex: '' = Hyperliquid's main perps; 'xyz' = the HIP-3 market set deployed and operated by Trade.xyz (equities).
 * venueCoins: the exact Hyperliquid names to look for, first listed one wins (verified at run time from metaAndAssetCtxs, every 60 s).
 * check: 'coingecko' = price cross-checked against CoinGecko (crypto); 'oracle' = mid price checked against the market's own oracle price
 *        (CoinGecko does not cover equities, and no free equity feed was found).
 * category: 'major' | 'stock'. Nothing here is executable. */
export const VIEW_MARKET_TABLE = Object.freeze({
  HYPE:    Object.freeze({ name: 'Hyperliquid', dex: '', venueCoins: ['HYPE'], check: 'coingecko', coingeckoId: 'hyperliquid', cgSymbol: 'hype', cgName: 'Hyperliquid', category: 'major', range: [0.01, 100000] }),
  ZEC:     Object.freeze({ name: 'Zcash', dex: '', venueCoins: ['ZEC'], check: 'coingecko', coingeckoId: 'zcash', cgSymbol: 'zec', cgName: 'Zcash', category: 'major', range: [0.1, 1000000] }),
  JUP:     Object.freeze({ name: 'Jupiter', dex: '', venueCoins: ['JUP'], check: 'coingecko', coingeckoId: 'jupiter-exchange-solana', cgSymbol: 'jup', cgName: 'Jupiter', category: 'major', range: [0.0001, 10000] }),
  SNDK:    Object.freeze({ name: 'Sandisk', dex: 'xyz', venueCoins: ['xyz:SNDK'], check: 'oracle', category: 'stock', range: [1, 1000000] }),
  SPCX:    Object.freeze({ name: 'SpaceX', dex: 'xyz', venueCoins: ['xyz:SPCX', 'xyz:SPACEX'], check: 'oracle', category: 'stock', range: [1, 1000000] }),
  NEAR:    Object.freeze({ name: 'NEAR Protocol', dex: '', venueCoins: ['NEAR'], check: 'coingecko', coingeckoId: 'near', cgSymbol: 'near', cgName: 'NEAR Protocol', category: 'major', range: [0.001, 100000] }),
  SKHYNIX: Object.freeze({ name: 'SK hynix', dex: 'xyz', venueCoins: ['xyz:SKHYNIX', 'xyz:SKHX'], check: 'oracle', category: 'stock', range: [1, 10000000] }),
  BNB:     Object.freeze({ name: 'BNB', dex: '', venueCoins: ['BNB'], check: 'coingecko', coingeckoId: 'binancecoin', cgSymbol: 'bnb', cgName: 'BNB', category: 'major', range: [1, 10000000] }),
  /* r179 more markets. A market appears only once Hyperliquid lists that exact coin right now and (crypto) CoinGecko confirms the id's symbol;
   * cgName: null = the symbol check alone (names change, e.g. rebrands). Unlisted names simply stay hidden. */
  DOGE:    Object.freeze({ name: 'Dogecoin', dex: '', venueCoins: ['DOGE'], check: 'coingecko', coingeckoId: 'dogecoin', cgSymbol: 'doge', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  XRP:     Object.freeze({ name: 'XRP', dex: '', venueCoins: ['XRP'], check: 'coingecko', coingeckoId: 'ripple', cgSymbol: 'xrp', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  SUI:     Object.freeze({ name: 'Sui', dex: '', venueCoins: ['SUI'], check: 'coingecko', coingeckoId: 'sui', cgSymbol: 'sui', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  AVAX:    Object.freeze({ name: 'Avalanche', dex: '', venueCoins: ['AVAX'], check: 'coingecko', coingeckoId: 'avalanche-2', cgSymbol: 'avax', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  LINK:    Object.freeze({ name: 'Chainlink', dex: '', venueCoins: ['LINK'], check: 'coingecko', coingeckoId: 'chainlink', cgSymbol: 'link', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  LTC:     Object.freeze({ name: 'Litecoin', dex: '', venueCoins: ['LTC'], check: 'coingecko', coingeckoId: 'litecoin', cgSymbol: 'ltc', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  ADA:     Object.freeze({ name: 'Cardano', dex: '', venueCoins: ['ADA'], check: 'coingecko', coingeckoId: 'cardano', cgSymbol: 'ada', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  TRX:     Object.freeze({ name: 'TRON', dex: '', venueCoins: ['TRX'], check: 'coingecko', coingeckoId: 'tron', cgSymbol: 'trx', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  AAVE:    Object.freeze({ name: 'Aave', dex: '', venueCoins: ['AAVE'], check: 'coingecko', coingeckoId: 'aave', cgSymbol: 'aave', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  ENA:     Object.freeze({ name: 'Ethena', dex: '', venueCoins: ['ENA'], check: 'coingecko', coingeckoId: 'ethena', cgSymbol: 'ena', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  WIF:     Object.freeze({ name: 'dogwifhat', dex: '', venueCoins: ['WIF'], check: 'coingecko', coingeckoId: 'dogwifcoin', cgSymbol: 'wif', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  FARTCOIN:Object.freeze({ name: 'Fartcoin', dex: '', venueCoins: ['FARTCOIN'], check: 'coingecko', coingeckoId: 'fartcoin', cgSymbol: 'fartcoin', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  PUMP:    Object.freeze({ name: 'Pump.fun', dex: '', venueCoins: ['PUMP'], check: 'coingecko', coingeckoId: 'pump-fun', cgSymbol: 'pump', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  TRUMP:   Object.freeze({ name: 'Official Trump', dex: '', venueCoins: ['TRUMP'], check: 'coingecko', coingeckoId: 'official-trump', cgSymbol: 'trump', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  PENGU:   Object.freeze({ name: 'Pudgy Penguins', dex: '', venueCoins: ['PENGU'], check: 'coingecko', coingeckoId: 'pudgy-penguins', cgSymbol: 'pengu', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  ARB:     Object.freeze({ name: 'Arbitrum', dex: '', venueCoins: ['ARB'], check: 'coingecko', coingeckoId: 'arbitrum', cgSymbol: 'arb', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  APT:     Object.freeze({ name: 'Aptos', dex: '', venueCoins: ['APT'], check: 'coingecko', coingeckoId: 'aptos', cgSymbol: 'apt', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  TON:     Object.freeze({ name: 'Toncoin', dex: '', venueCoins: ['TON'], check: 'coingecko', coingeckoId: 'the-open-network', cgSymbol: 'ton', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  DOT:     Object.freeze({ name: 'Polkadot', dex: '', venueCoins: ['DOT'], check: 'coingecko', coingeckoId: 'polkadot', cgSymbol: 'dot', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  BCH:     Object.freeze({ name: 'Bitcoin Cash', dex: '', venueCoins: ['BCH'], check: 'coingecko', coingeckoId: 'bitcoin-cash', cgSymbol: 'bch', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  ONDO:    Object.freeze({ name: 'Ondo', dex: '', venueCoins: ['ONDO'], check: 'coingecko', coingeckoId: 'ondo-finance', cgSymbol: 'ondo', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  TIA:     Object.freeze({ name: 'Celestia', dex: '', venueCoins: ['TIA'], check: 'coingecko', coingeckoId: 'celestia', cgSymbol: 'tia', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  WLD:     Object.freeze({ name: 'Worldcoin', dex: '', venueCoins: ['WLD'], check: 'coingecko', coingeckoId: 'worldcoin-wld', cgSymbol: 'wld', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  UNI:     Object.freeze({ name: 'Uniswap', dex: '', venueCoins: ['UNI'], check: 'coingecko', coingeckoId: 'uniswap', cgSymbol: 'uni', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  OP:      Object.freeze({ name: 'Optimism', dex: '', venueCoins: ['OP'], check: 'coingecko', coingeckoId: 'optimism', cgSymbol: 'op', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  INJ:     Object.freeze({ name: 'Injective', dex: '', venueCoins: ['INJ'], check: 'coingecko', coingeckoId: 'injective-protocol', cgSymbol: 'inj', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  SEI:     Object.freeze({ name: 'Sei', dex: '', venueCoins: ['SEI'], check: 'coingecko', coingeckoId: 'sei-network', cgSymbol: 'sei', cgName: null, category: 'major', range: [0.000001, 10000000] }),
  TSLA:    Object.freeze({ name: 'Tesla', dex: 'xyz', venueCoins: ['xyz:TSLA'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  NVDA:    Object.freeze({ name: 'NVIDIA', dex: 'xyz', venueCoins: ['xyz:NVDA'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  AAPL:    Object.freeze({ name: 'Apple', dex: 'xyz', venueCoins: ['xyz:AAPL'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  MSFT:    Object.freeze({ name: 'Microsoft', dex: 'xyz', venueCoins: ['xyz:MSFT'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  GOOGL:   Object.freeze({ name: 'Alphabet', dex: 'xyz', venueCoins: ['xyz:GOOGL'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  AMZN:    Object.freeze({ name: 'Amazon', dex: 'xyz', venueCoins: ['xyz:AMZN'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  META:    Object.freeze({ name: 'Meta', dex: 'xyz', venueCoins: ['xyz:META'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  COIN:    Object.freeze({ name: 'Coinbase', dex: 'xyz', venueCoins: ['xyz:COIN'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  HOOD:    Object.freeze({ name: 'Robinhood', dex: 'xyz', venueCoins: ['xyz:HOOD'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  PLTR:    Object.freeze({ name: 'Palantir', dex: 'xyz', venueCoins: ['xyz:PLTR'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  MSTR:    Object.freeze({ name: 'Strategy', dex: 'xyz', venueCoins: ['xyz:MSTR'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  AMD:     Object.freeze({ name: 'AMD', dex: 'xyz', venueCoins: ['xyz:AMD'], check: 'oracle', category: 'stock', range: [0.01, 10000000] }),
  NFLX:    Object.freeze({ name: 'Netflix', dex: 'xyz', venueCoins: ['xyz:NFLX'], check: 'oracle', category: 'stock', range: [0.01, 10000000] })
});
export const VIEW_KEYS_ALL = Object.freeze(Object.keys(VIEW_MARKET_TABLE));
function viewList(v) { const t = String(v == null ? '' : v).trim(); if (t === '') return [...VIEW_KEYS_ALL]; if (/^(off|none|false|0)$/i.test(t)) return []; return t.split(',').map(x => x.trim().toUpperCase()).filter(Boolean); }

export const JUPITER_HOST = 'perps-api.jup.ag';
export const JUPITER_BASE = 'https://perps-api.jup.ag/v1';

const num = (v, d, { min = -Infinity, max = Infinity } = {}) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

import { hlConfig } from './hl-exec.js';
export function loadConfig(env = process.env) {
  const intervalSec = num(env.SAMPLE_INTERVAL_SEC, 15, { min: 5, max: 300 });
  const priceRange = {};
  for (const m of Object.keys(MARKETS)) {
    const v = env['PRICE_RANGE_' + m]; const [lo, hi] = v ? String(v).split(',').map(Number) : DEFAULT_PRICE_RANGE[m];
    priceRange[m] = Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > lo ? [lo, hi] : null;   /* null = invalid override, reported by validateConfig */
  }
  return Object.freeze({
    priceRange,
    /* r122 deploy audit: the commit Render built (Render sets RENDER_GIT_COMMIT automatically). Public repo hash only; nothing secret. */
    buildCommit: /^[0-9a-f]{7,40}$/.test(String(env.RENDER_GIT_COMMIT || '')) ? String(env.RENDER_GIT_COMMIT).slice(0, 12) : null,
    recorderEnabled: !/^(0|false|off|no)$/i.test(String(env.RECORDER_ENABLED || '1')), /* false = API/WS-only instance that never takes the single-writer lock */
    statusToken: env.STATUS_TOKEN || '', /* protects GET /internal/status; empty = that endpoint does not exist */
    port: num(env.PORT, 8080, { min: 1, max: 65535 }),
    databaseUrl: env.DATABASE_URL || '',
    readerDatabaseUrl: env.READER_DATABASE_URL || '',
    allowedOrigins: new Set(list(env.ALLOWED_ORIGINS)),
    intervalSec,
    timeoutMs: Math.min(num(env.FETCH_TIMEOUT_MS, 8000, { min: 1000, max: 30000 }), Math.max(1000, intervalSec * 1000 - 1000)),
    maxRps: num(env.MAX_REQUESTS_PER_SEC, 0.25, { min: 0.01, max: 0.5 }), /* hard ceiling 0.5 = the portal's stated keyless limit */
    backoffMaxMs: num(env.BACKOFF_MAX_MS, 10 * 60 * 1000, { min: 1000 }),
    staleMult: 2.5, downSec: 300,
    coverageMin: num(env.COVERAGE_MIN, 0.8, { min: 0.5, max: 1 }),
    jumpPct: num(env.JUMP_PCT, 20, { min: 1, max: 100 }),
    jumpConfirm: Math.round(num(env.JUMP_CONFIRM, 3, { min: 2, max: 10 })),
    confirmTolPct: num(env.CONFIRM_TOL_PCT, 5, { min: 0.1, max: 20 }),
    maxPrice: 1e9,
    /* r121 view-only markets. Off unless VIEW_MARKETS lists them. Crypto markets need COINGECKO_DEMO_KEY for their cross-check; without it they stay listed as 'Price unavailable'. */
    view: Object.freeze({
      /* r125: the catalogue needs NO Render setting. VIEW_MARKETS unset/empty = all eight; 'off' = none; a list = that subset (unknown names are a config error). */
      markets: Object.freeze(viewList(env.VIEW_MARKETS).filter((x, i, a) => VIEW_KEYS_ALL.includes(x) && a.indexOf(x) === i)),
      unknownMarkets: Object.freeze(viewList(env.VIEW_MARKETS).filter(x => !VIEW_KEYS_ALL.includes(x))),
      coingeckoKey: env.COINGECKO_DEMO_KEY || '',
      hyperliquidBase: env.HYPERLIQUID_INFO_BASE || 'https://api.hyperliquid.xyz',
      crossCheckMs: 5 * 60 * 1000,                       /* one CoinGecko request per 5 minutes at most */
      crossCheckMaxAgeMs: 20 * 60 * 1000,                /* no successful check for 20 min -> not shown as reliable */
      mismatchPct: num(env.VIEW_MISMATCH_PCT, 2, { min: 0.5, max: 10 }),
      coingeckoMonthlyCap: num(env.COINGECKO_MONTHLY_CAP, 9500, { min: 100, max: 10000 }),   /* Demo plan: 10,000 calls / month */
      ctxMs: 60 * 1000,                                   /* listing + oracle + previous-day price, re-read every 60 s (metaAndAssetCtxs, weight 20 per market set) */
      ctxMaxAgeMs: 3 * 60 * 1000,                          /* oracle check / 24 h reference older than this is not used */
      frozenMs: 10 * 60 * 1000,                          /* price unchanged for 10 min -> treated as stale */
      minMidsGapMs: 10000                                /* at most one allMids request per 10 s (weight 2; limit is 1200 weight / min / IP) */
    }),
    retention: { observationsDays: num(env.RETAIN_OBS_DAYS, 35, { min: 8 }), logDays: num(env.RETAIN_LOG_DAYS, 7, { min: 1 }) },
    http: { ipLimitPerMin: num(env.HTTP_LIMIT_PER_MIN, 60, { min: 1 }), trustedProxyHops: Math.round(num(env.TRUSTED_PROXY_HOPS, 1, { min: 0, max: 5 })) },
    ws: { maxConnPerIp: num(env.WS_MAX_CONN_PER_IP, 20, { min: 1 }), maxMarkets: 3, maxMsgPerWindow: 30, windowMs: 10000, maxPayload: 1024, heartbeatMs: 25000, softBuffer: 256 * 1024, hardBuffer: 1024 * 1024 },
    /* Optional Jupiter API key. The header NAME is deliberately not assumed: set both vars from Jupiter's docs, or neither. */
    jupiterKeyHeader: env.JUPITER_API_KEY_HEADER || '', jupiterKey: env.JUPITER_API_KEY || '',
    /* Polymarket wallet verifier: read-only Polygon RPC. Optional server-side override; default is public Polygon RPC. */
    polygonRpcUrl: env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    /* Perps gateway (/v1/perps/jup/*). Reads are on. The three transaction routes exist but answer 403 execution_disabled unless
     * PERPS_EXECUTION_ENABLED=1 AND a ticket secret is set. Real-money execution is NOT approved: leave this unset. */
    /* r128 Hyperliquid mainnet relay (/v1/perps/hl/*). Real-money execution needs HL_EXECUTION_ENABLED=1 AND HL_EXECUTE_VERIFIED in src/hl-exec.js. */
    hl: hlConfig(env),
    gateway: {
      /* r117: the environment can only REQUEST execution. It runs only if the Jupiter contract is also marked verified in code (perps-program.js). */
      executionRequested: /^1$/.test(String(env.PERPS_EXECUTION_ENABLED || '')) && String(env.GATEWAY_TICKET_SECRET || '').length >= 32,
      executionEnabled: EXECUTE_CONTRACT_VERIFIED && /^1$/.test(String(env.PERPS_EXECUTION_ENABLED || '')) && String(env.GATEWAY_TICKET_SECRET || '').length >= 32,
      transactionType: /^[a-z][a-z0-9_-]{0,31}$/.test(String(env.GATEWAY_JUP_TRANSACTION_TYPE || '')) ? String(env.GATEWAY_JUP_TRANSACTION_TYPE) : '',   /* unverified; omitted when unset */
      ticketSecret: env.GATEWAY_TICKET_SECRET || '',
      ticketTtlMs: 60000,
      upstreamPerMin: num(env.GATEWAY_UPSTREAM_PER_MIN, 12, { min: 1, max: 30 }),   /* shared budget for ALL gateway calls to Jupiter (keyless limit is shared with the recorder) */
      positionsPerMinIp: num(env.GATEWAY_POSITIONS_PER_MIN, 20, { min: 1 }), positionsPerMinWallet: 10,
      preparePerMinIp: 6, preparePerMinWallet: 4, executePerMinIp: 10, executePerMinWallet: 6,
      maxBody: 8 * 1024
    }
  });
}

export function validateConfig(cfg) {
  const errs = [];
  if (!cfg.databaseUrl) errs.push('DATABASE_URL is required');
  for (const [m, r] of Object.entries(cfg.priceRange)) if (!r) errs.push('PRICE_RANGE_' + m + ' must be "min,max" with 0 < min < max');
  if (cfg.statusToken && (cfg.statusToken.length < 24 || !/^[\x21-\x7e]+$/.test(cfg.statusToken))) errs.push('STATUS_TOKEN must be at least 24 printable characters');
  if ((cfg.jupiterKeyHeader && !cfg.jupiterKey) || (!cfg.jupiterKeyHeader && cfg.jupiterKey)) errs.push('JUPITER_API_KEY and JUPITER_API_KEY_HEADER must be set together');
  if (cfg.jupiterKeyHeader && !/^[A-Za-z0-9-]{1,64}$/.test(cfg.jupiterKeyHeader)) errs.push('JUPITER_API_KEY_HEADER has invalid characters');
  if (cfg.polygonRpcUrl && !/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(cfg.polygonRpcUrl)) errs.push('POLYGON_RPC_URL must be HTTPS');
  if (cfg.view && cfg.view.unknownMarkets.length) errs.push('VIEW_MARKETS has unknown markets: ' + cfg.view.unknownMarkets.join(',') + ' (allowed: ' + VIEW_KEYS_ALL.join(',') + ')');
  if (cfg.view && cfg.view.markets.length && !/^https:\/\/api\.hyperliquid\.xyz$/.test(cfg.view.hyperliquidBase)) errs.push('HYPERLIQUID_INFO_BASE must be https://api.hyperliquid.xyz');
  if (cfg.gateway && cfg.gateway.ticketSecret && cfg.gateway.ticketSecret.length < 32) errs.push('GATEWAY_TICKET_SECRET must be at least 32 characters');
  return errs;
}
