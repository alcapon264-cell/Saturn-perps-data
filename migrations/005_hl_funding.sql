-- r129 Saturn Perps: pending Saturn Wallet -> Hyperliquid funding transfers (Arbitrum USDC -> Hyperliquid Bridge2). Forward-only, additive.
-- One row per Arbitrum transaction the user's own Saturn Wallet sent (verified on-chain by the relay before it is recorded).
-- pending  = sent, not yet credited by Hyperliquid (counted as NEITHER wallet nor venue balance, so nothing is counted twice)
-- credited = Hyperliquid's own ledger shows the deposit (ledger_hash is unique: one ledger entry settles one transfer)
CREATE TABLE perps_hl_funding (
  tx_hash      text        PRIMARY KEY CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  user_addr    text        NOT NULL CHECK (user_addr ~ '^0x[0-9a-f]{40}$'),
  amount_usd   numeric     NOT NULL CHECK (amount_usd >= 5),
  state        text        NOT NULL CHECK (state IN ('pending','credited','failed')),
  ledger_hash  text        NULL UNIQUE CHECK (ledger_hash IS NULL OR length(ledger_hash) <= 80),
  created_at   timestamptz NOT NULL DEFAULT now(),
  credited_at  timestamptz NULL
);
CREATE INDEX perps_hl_funding_user ON perps_hl_funding (user_addr, state, created_at);
