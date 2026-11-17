-- 003: VIEW-ONLY markets (R120). Additive only: four NEW tables; no existing table, column, constraint or row is touched.
-- SOL/ETH/BTC keep using perps_markets / perps_observations / perps_candles / perps_rejects exactly as before.
-- View-only prices come from Hyperliquid's public allMids (main perps and the HIP-3 'xyz' equity markets) and are stored ONLY in the perps_view_* tables below.

CREATE TABLE perps_view_markets (
  market       text        PRIMARY KEY CHECK (market ~ '^[A-Z0-9]{2,12}$' AND market NOT IN ('SOL','ETH','BTC')),
  source       text        NOT NULL DEFAULT 'hyperliquid:allMids' CHECK (source = 'hyperliquid:allMids'),
  venue_coin   text        NOT NULL UNIQUE CHECK (venue_coin ~ '^([a-z]{1,8}:)?[A-Z0-9]{2,16}$'),
  coingecko_id text        NULL UNIQUE CHECK (coingecko_id ~ '^[a-z0-9-]{2,64}$'),   -- NULL for equities (checked against their own oracle price instead)
  verified_at  timestamptz NOT NULL,
  enabled      boolean     NOT NULL DEFAULT true
);

CREATE TABLE perps_view_observations (
  id          bigserial PRIMARY KEY,
  source      text           NOT NULL CHECK (source = 'hyperliquid:allMids'),
  market      text           NOT NULL REFERENCES perps_view_markets(market),
  slot_ts     timestamptz    NOT NULL,
  observed_at timestamptz    NOT NULL,
  price       numeric(30,10) NOT NULL CHECK (price > 0),
  fetch_ms    integer        NOT NULL CHECK (fetch_ms >= 0),
  source_ts   timestamptz    NULL,
  UNIQUE (source, market, slot_ts)
);
CREATE INDEX perps_view_obs_market_time ON perps_view_observations (market, observed_at);
CREATE INDEX perps_view_obs_time ON perps_view_observations (observed_at);

CREATE TABLE perps_view_rejects (
  id          bigserial PRIMARY KEY,
  source      text        NOT NULL CHECK (source = 'hyperliquid:allMids'),
  market      text        NOT NULL,
  observed_at timestamptz NOT NULL,
  reason      text        NOT NULL CHECK (reason IN ('non_finite','non_positive','malformed','wrong_market','jump_pending','jump_rejected','implausible','source_stale','not_listed')),
  detail      text        NULL CHECK (length(detail) <= 500)
);
CREATE INDEX perps_view_rejects_time ON perps_view_rejects (observed_at);

CREATE TABLE perps_view_candles (
  source       text           NOT NULL CHECK (source = 'hyperliquid:allMids'),
  market       text           NOT NULL REFERENCES perps_view_markets(market),
  tf           text           NOT NULL CHECK (tf IN ('1m','5m','15m','1h','4h')),
  bucket_start timestamptz    NOT NULL,
  o numeric(30,10) NOT NULL, h numeric(30,10) NOT NULL, l numeric(30,10) NOT NULL, c numeric(30,10) NOT NULL,
  n_obs        integer        NOT NULL CHECK (n_obs >= 1),
  expected_obs integer        NOT NULL CHECK (expected_obs >= 1),
  coverage     real           NOT NULL CHECK (coverage > 0 AND coverage <= 1),
  max_gap_sec  integer        NOT NULL CHECK (max_gap_sec >= 0),
  first_obs_at timestamptz    NOT NULL,
  last_obs_at  timestamptz    NOT NULL,
  status       text           NOT NULL CHECK (status IN ('forming','complete')),
  valid        boolean        NOT NULL,
  finalized_at timestamptz    NULL,
  PRIMARY KEY (source, market, tf, bucket_start),
  CONSTRAINT perps_view_candles_positive CHECK (o > 0 AND h > 0 AND l > 0 AND c > 0),
  CONSTRAINT perps_view_candles_ohlc CHECK (h >= o AND h >= c AND h >= l AND l <= o AND l <= c),
  CONSTRAINT perps_view_candles_final CHECK ((status = 'complete') = (finalized_at IS NOT NULL)),
  CONSTRAINT perps_view_candles_valid_needs_complete CHECK (NOT valid OR status = 'complete')
);
CREATE INDEX perps_view_candles_read ON perps_view_candles (market, tf, bucket_start DESC);
