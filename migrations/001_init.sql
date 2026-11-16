-- Saturn Perps data engine: initial schema. Forward-only, additive.
-- Every price stored here was received from the configured source; there is no column for interpolated or back-filled values.

CREATE TABLE perps_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE perps_markets (
  market  text PRIMARY KEY CHECK (market IN ('SOL','ETH','BTC')),
  mint    text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE perps_observations (
  id          bigserial PRIMARY KEY,
  source      text           NOT NULL,
  market      text           NOT NULL REFERENCES perps_markets(market),
  slot_ts     timestamptz    NOT NULL,
  observed_at timestamptz    NOT NULL,
  price       numeric(30,10) NOT NULL CHECK (price > 0),
  fetch_ms    integer        NOT NULL CHECK (fetch_ms >= 0),
  source_ts   timestamptz    NULL,
  UNIQUE (source, market, slot_ts)
);
CREATE INDEX perps_obs_market_time ON perps_observations (market, observed_at);
CREATE INDEX perps_obs_time ON perps_observations (observed_at);

CREATE TABLE perps_rejects (
  id          bigserial PRIMARY KEY,
  source      text        NOT NULL,
  market      text        NOT NULL,
  observed_at timestamptz NOT NULL,
  reason      text        NOT NULL CHECK (reason IN ('non_finite','non_positive','malformed','wrong_market','jump_pending','jump_rejected','implausible')),
  detail      text        NULL CHECK (length(detail) <= 500)
);
CREATE INDEX perps_rejects_time ON perps_rejects (observed_at);

CREATE TABLE perps_candles (
  source       text           NOT NULL,
  market       text           NOT NULL,
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
  CONSTRAINT perps_candles_positive CHECK (o > 0 AND h > 0 AND l > 0 AND c > 0),
  CONSTRAINT perps_candles_ohlc CHECK (h >= o AND h >= c AND h >= l AND l <= o AND l <= c),
  CONSTRAINT perps_candles_final CHECK ((status = 'complete') = (finalized_at IS NOT NULL)),
  CONSTRAINT perps_candles_valid_needs_complete CHECK (NOT valid OR status = 'complete')
);
CREATE INDEX perps_candles_read ON perps_candles (market, tf, bucket_start DESC);

CREATE TABLE perps_fetch_log (
  id          bigserial PRIMARY KEY,
  market      text        NOT NULL,
  at          timestamptz NOT NULL,
  outcome     text        NOT NULL,
  http_status integer     NULL,
  ms          integer     NULL
);
CREATE INDEX perps_fetch_log_time ON perps_fetch_log (at);
