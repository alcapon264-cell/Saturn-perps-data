-- Saturn Perps gateway: durable idempotency for relayed, USER-SIGNED transactions. Forward-only, additive.
-- One row per transaction signature. A signature is relayed to Jupiter at most once, ever: a second request with the same
-- signature returns the stored state and never contacts Jupiter again. 'unknown' = the upstream outcome was ambiguous
-- (timeout / network / 5xx); it is NEVER retried by the gateway; the client checks the signature on-chain instead.
CREATE TABLE perps_exec_requests (
  signature       text        PRIMARY KEY CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$'),
  wallet          text        NOT NULL CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  action          text        NOT NULL CHECK (action IN ('increase-position','decrease-position')),
  msg_hash        text        NOT NULL CHECK (msg_hash ~ '^[0-9a-f]{64}$'),
  state           text        NOT NULL CHECK (state IN ('pending','submitted','rejected','unknown')),
  upstream_status integer     NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX perps_exec_wallet_time ON perps_exec_requests (wallet, created_at);
CREATE INDEX perps_exec_time ON perps_exec_requests (created_at);
