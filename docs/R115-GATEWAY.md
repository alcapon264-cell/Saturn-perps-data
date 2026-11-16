# r115 — Perps gateway (security notes)

The Saturn frontend's Positions and execution code has always called `/v1/perps/jup/*` on this service, but the supplied backend
did not contain those routes (so Positions could not work). r115 adds them in `src/gateway.js`, kept inside this separate Perps service.

## Routes
| Route | Default | Notes |
|---|---|---|
| `GET /v1/perps/jup/positions` | on | Strict wallet/params; per-IP 20/min, per-wallet 10/min; 4 s per-wallet cache + in-flight de-dup; response whitelisted to 13 known scalar fields; upstream errors are honest 502/504 |
| `GET /v1/perps/jup/market-stats` | on | Only the three fixed mints; served from this service's own recorder (no upstream call); 503 unless the price is `live` |
| `POST .../positions/increase`, `.../positions/decrease` | **off** | Strict schemas, unknown fields rejected, 8 KB JSON only; the transaction Jupiter returns is parsed and refused unless: fee payer = wallet, exactly 1 signer, only allow-listed programs, exactly one Jupiter Perps market-request instruction with the computed discriminator, owner = wallet, JLP pool, SOL/ETH/BTC custody, allow-listed collateral custody, fixed program accounts, unsigned. Returns a ticket. |
| `POST /v1/perps/jup/execute` | **off** | Requires the ticket for that exact message (HMAC over wallet, action, sha256(message), 60 s expiry), the same structural checks, and a valid ed25519 signature by the fee payer. Then durable idempotency. |

Enabled only when `PERPS_EXECUTION_ENABLED=1` **and** `GATEWAY_TICKET_SECRET` (≥ 32 chars) are set. Leave unset.

## Idempotency and ambiguous results (migration 002)
`perps_exec_requests(signature PK, wallet, action, msg_hash, state, upstream_status, ...)`.
* First request with a signature inserts `pending`; any later request (concurrent tap, retry, other instance, after restart) gets the stored state and **never reaches Jupiter**.
* 2xx with the same txid → `submitted`; 4xx → `rejected`; timeout / network / 5xx / malformed 2xx → `unknown` (HTTP 202). `unknown` is never retried by the gateway; the client checks the signature on-chain.
* If the row cannot be written, nothing is relayed (503).

## What is NOT authentication
The `Origin` header is used only for browser CORS hygiene. Every control above works without it, and a request with an allowed Origin but no valid ticket/signature is refused (tested).

## Open items
* The upstream paths (`/positions`, `/positions/increase`, `/positions/decrease`, `/transaction/execute` on perps-api.jup.ag/v1) are **not in Jupiter's official developer documentation** (it states the Perps API is a work in progress). Not verified live.
* Positions response shape was never seen live. The frontend cross-checks every position against its on-chain Position account, so a wrong shape or unit fails closed.
* `TRUSTED_PROXY_HOPS` on Render still unverified (F1).
* In-memory limits reset on restart (single instance). Idempotency is durable.
