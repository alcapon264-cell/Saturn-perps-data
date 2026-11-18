-- r128 Saturn Perps: Hyperliquid execution relay audit + idempotency. Forward-only, additive; touches no existing table.
-- One row per signed request (id = sha256(signer:nonce)). Holds NO signature, NO key, NO raw IP (ip_hash only).
-- state: pending -> submitted | rejected | unknown ; refused = Saturn refused it before contacting Hyperliquid.
-- 'unknown' (timeout / network / 5xx) is NEVER retried by the relay; the client checks the order by cloid instead.
CREATE TABLE perps_hl_requests (
  id              text        PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  user_addr       text        NOT NULL CHECK (user_addr ~ '^0x[0-9a-f]{40}$'),
  signer          text        NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),
  action_type     text        NOT NULL CHECK (action_type IN ('approveAgent','order','cancel','cancelByCloid','updateLeverage','sendAsset','withdraw3')),
  market          text        NULL CHECK (market IS NULL OR market ~ '^[A-Z0-9]{2,12}$'),
  asset           integer     NULL,
  is_buy          boolean     NULL,
  size            numeric     NULL,
  price           numeric     NULL,
  reduce_only     boolean     NULL,
  tif             text        NULL CHECK (tif IS NULL OR tif IN ('Gtc','Ioc','Alo')),
  cloid           text        NULL CHECK (cloid IS NULL OR cloid ~ '^0x[0-9a-f]{32}$'),
  notional_usd    numeric     NULL,
  amount_usd      numeric     NULL,
  state           text        NOT NULL CHECK (state IN ('pending','submitted','rejected','unknown','refused')),
  reason          text        NULL CHECK (reason IS NULL OR length(reason) <= 200),
  upstream_status integer     NULL,
  latency_ms      integer     NULL,
  response        jsonb       NULL CHECK (response IS NULL OR length(response::text) <= 4000),
  ip_hash         text        NULL CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{16}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX perps_hl_user_cloid ON perps_hl_requests (user_addr, cloid) WHERE cloid IS NOT NULL AND action_type = 'order' AND state <> 'refused';
CREATE INDEX perps_hl_user_time ON perps_hl_requests (user_addr, created_at);
CREATE INDEX perps_hl_time ON perps_hl_requests (created_at);
