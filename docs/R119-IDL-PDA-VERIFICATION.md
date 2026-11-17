# R119 — Jupiter IDL and PDA verification notes

## What was checked

The published Jupiter Perpetuals Anchor IDL and published PDA examples were compared with the Saturn R118 verifier.

- `Side` enum order is `None = 0`, `Long = 1`, `Short = 2`; Saturn's long/short bytes (`1`/`2`) match.
- Increase market-request arguments: `sizeUsdDelta:u64`, `collateralTokenDelta:u64`, `side`, `priceSlippage:u64`, `jupiterMinimumOut:option<u64>`, `counter:u64`.
- Decrease market-request arguments: `collateralUsdDelta:u64`, `sizeUsdDelta:u64`, `priceSlippage:u64`, `jupiterMinimumOut:option<u64>`, `entirePosition:option<bool>`, `counter:u64`.
- Position PDA seed ordering: `position`, owner, JLP pool, custody, collateral custody, side byte.
- Position-request PDA seed ordering: `position_request`, position, 8-byte little-endian counter, request-change byte (`1` increase, `2` decrease).

These match the current Saturn derivation and decoder. The REST request mapping in R118 is retained unchanged.

## Still unverified — do not unlock execution

- Real Jupiter-built increase/decrease transaction responses and their account-meta behavior.
- Keeper-signature requirements for the supported transaction paths.
- Real transaction fixtures across supported market/collateral combinations, including any address lookup table use.
- End-to-end validation against Jupiter.

`EXECUTE_CONTRACT_VERIFIED` remains `false`. `PERPS_EXECUTION_ENABLED=1` and a ticket secret cannot override this code-level lock. This patch does not enable trading, sign transactions, submit transactions, or change Render settings.

## Changes in this patch

- Corrected stale verification comments and blockers in `src/perps-program.js`.
- Added `tests/perps-contract.test.js` for the REST mappers, IDL argument layouts, enum values, decoder examples, and execution lock.
- No changes to `src/gateway.js`, `src/config.js`, REST mapping behavior, wallet/signing code, recorder, database, WebSocket, or production configuration.

## Local verification

- `node --check src/perps-program.js` — passed.
- `node --check tests/perps-contract.test.js` — passed.
- `node --test tests/perps-contract.test.js tests/unit.test.js tests/static.test.js` — 32/32 passed.
- Full PostgreSQL-backed gateway integration suite was not run as part of this patch.
- No live Jupiter request, wallet signature, transaction submission, Render deployment, or environment change was performed.
