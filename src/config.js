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

/* Magnitude guard (S2 finding). Deliberately wide (about 100x either way around the prices seen live on 2026-11-16: SOL 70.8, ETH 1,807, BTC 64,423).
 * It exists to stop a unit/scale change (e.g. an x1e6 or x1e-6 price) from being accepted as the first observation, before the jump filter has a baseline.
 * Override per market with PRICE_RANGE_SOL="min,max" etc. */
export const DEFAULT_PRICE_RANGE = Object.freeze({ SOL: [0.5, 50000], ETH: [20, 500000], BTC: [1000, 5000000] });

export const JUPITER_HOST = 'perps-api.jup.ag';
export const JUPITER_BASE = 'https://perps-api.jup.ag/v1';

const num = (v, d, { min = -Infinity, max = Infinity } = {}) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const intervalSec = num(env.SAMPLE_INTERVAL_SEC, 15, { min: 5, max: 300 });
  const priceRange = {};
  for (const m of Object.keys(MARKETS)) {
    const v = env['PRICE_RANGE_' + m]; const [lo, hi] = v ? String(v).split(',').map(Number) : DEFAULT_PRICE_RANGE[m];
    priceRange[m] = Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > lo ? [lo, hi] : null;   /* null = invalid override, reported by validateConfig */
  }
  return Object.freeze({
    priceRange,
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
    readinessRequired: 60,
    retention: { observationsDays: num(env.RETAIN_OBS_DAYS, 35, { min: 8 }), logDays: num(env.RETAIN_LOG_DAYS, 7, { min: 1 }) },
    http: { ipLimitPerMin: num(env.HTTP_LIMIT_PER_MIN, 60, { min: 1 }), readinessLimitPerMin: num(env.READINESS_LIMIT_PER_MIN, 10, { min: 1 }), trustedProxyHops: Math.round(num(env.TRUSTED_PROXY_HOPS, 1, { min: 0, max: 5 })) },
    ws: { maxConnPerIp: num(env.WS_MAX_CONN_PER_IP, 20, { min: 1 }), maxMarkets: 3, maxMsgPerWindow: 30, windowMs: 10000, maxPayload: 1024, heartbeatMs: 25000, softBuffer: 256 * 1024, hardBuffer: 1024 * 1024 },
    /* Optional Jupiter API key. The header NAME is deliberately not assumed: set both vars from Jupiter's docs, or neither. */
    jupiterKeyHeader: env.JUPITER_API_KEY_HEADER || '', jupiterKey: env.JUPITER_API_KEY || '',
    /* Perps gateway (/v1/perps/jup/*). Reads are on. The three transaction routes exist but answer 403 execution_disabled unless
     * PERPS_EXECUTION_ENABLED=1 AND a ticket secret is set. Real-money execution is NOT approved: leave this unset. */
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
  if (cfg.gateway && cfg.gateway.ticketSecret && cfg.gateway.ticketSecret.length < 32) errs.push('GATEWAY_TICKET_SECRET must be at least 32 characters');
  return errs;
}
