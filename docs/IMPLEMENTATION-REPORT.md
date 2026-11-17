> **r118 note:** this is a historical stage report. The A.A.I.H. readiness gate (`src/readiness.js`, `/v1/perps/readiness`) described below was removed in r118.

# S1 Implementation Report — Saturn Perps Data Engine

**Review outcome:** S1 accepted as an *offline implementation stage*. **This is not production-ready**: it has never run against Jupiter, on Render, or with the real `pg` driver (see section 6). Revision 2 applies the review's `/healthz` adjustment (section 3).

Scope of this report: stage **S1 only**. Nothing is deployed, no paid Render resource exists, nothing is connected to the Saturn frontend, and no existing Saturn file was touched. Labels: **VERIFIED** (an automated test in this repo proves it), **BY DESIGN** (true by construction, covered by a static test), **UNVERIFIED** (could not be tested here).

## 1. S0 approval conditions: status

| # | Condition | Status |
|---|---|---|
| 1 | Separate repository `Saturn-perps-data` | **Done.** This folder is the whole repository; it shares no file, env var or secret with `Saturn-fun`. Static test: no reference to `SATURN_LIVE_WS_URL` or any existing host. |
| 2 | Separate Render service and database | **Designed, not created.** Single Node process + PostgreSQL. No Render resource exists. |
| 3 | Existing Vercel backend, Firestore, EVM relay, Solana WebSocket untouched | **Done.** None was modified. The backend zip was read only. |
| 4 | `/market-stats` as source | **Done.** One GET, fixed host `perps-api.jup.ag` (a test rejects any other host/scheme), fixed mint table. |
| 5 | 15 s default, configurable, automatic backoff | **Done, VERIFIED.** `SAMPLE_INTERVAL_SEC` 5–300, token bucket ≤ 0.25 rps (hard ceiling 0.5), ladder 2x/4x/8x interval, `Retry-After` honoured. |
| 6 | Sampled OHLC only from recorded observations | **Done, VERIFIED** against an independent SQL/JS oracle for all five timeframes. |
| 7 | Preserve missing intervals, never fabricate | **Done, VERIFIED.** A deleted block of observations yields absent candle rows; no filler candles; no `volume`. |
| 8 | 80 % coverage + max-gap validation | **Done, VERIFIED** at exact boundaries (0.80 vs 0.79; gap limit vs limit+1). |
| 9 | 20 % jump filter, 3 consecutive confirming samples | **Done, VERIFIED** (unit + end-to-end with real DB). |
| 10 | 60 contiguous valid hourly candles before A.A.I.H. | **Done, VERIFIED** server-side (`/readiness`); the client must still re-validate. |
| 11 | Completely separate Perps WebSocket | **Done.** Path `/perps/live` on this service only; static test proves the `/live` spot path is not served. |
| 12 | Trading/execution disabled | **BY DESIGN, VERIFIED statically.** No wallet, signing, order, position or write code exists; outbound traffic is one GET; no request bodies are read. |

Additional conditions: secrets stay server-side (**VERIFIED**: health/log output contains no DB URL or key; nothing here is frontend code). Render cost estimate: see `COST-ESTIMATE.md`. The read-only Jupiter live-check is **written and tested against a stub only** — running it against Jupiter is stage S2 and is yours to do. `SATURN_LIVE_WS_URL`, production backend and frontend: untouched.

## 2. What was built
Node 22, ESM, two runtime dependencies (`ws`, `pg`). ~930 lines of service code (src + server.js), ~1,450 lines of tests, 92 tests. Module map is in `README.md`.

Processes in the single service: recorder (per-market timers), candle engine (update on each accepted observation + finalise timer), HTTP server, WebSocket hub, leader-lock supervisor, daily retention job, heartbeat.

## 3. Implemented contracts

### HTTP (GET only; CORS = exact-origin allowlist, fail-closed when the list is empty)
- `GET /healthz` (public, minimal) → `{ok, service:"saturn-perps-data", ready}` and nothing else. HTTP 200 even when the database is down (`ok:false`) so a platform health check does not restart-loop the process. Rate limit 120/min per IP.
- `GET /internal/status` (protected) → the detailed operational view that `/healthz` used to return: `{ok, service, version, epoch, serverTime, uptimeSec, source, ready, leader, db:{ok}, lastInitError, recorder:{running, intervalSec, dbDegraded, queued, rateHeaders, markets:{SOL:{state, lastObservationAt, ageMs, price, consecutiveFailures, consecutiveRejects, circuitOpen, suspectFlat, lastOutcome, lastHttpStatus, backoffMs, seq, jumpPending}}}, ws:{clients}, thresholds, metrics}`. Controls: **does not exist (404) unless the server env var `STATUS_TOKEN` is set** (≥ 24 printable characters); requires `Authorization: Bearer <token>` compared in constant time (401 otherwise); any request carrying an `Origin` header is refused (403) and no CORS headers are ever sent, so a web page cannot call it; 10 attempts/min per IP (429, correct tokens included, so brute force is throttled); GET only; `no-store`. The token is never logged or returned. It is meant for you / an uptime tool / Render's shell, not for the Saturn frontend.
- `GET /v1/perps/markets` → `{ok, source, serverTime, markets:[{market, price, observedAt, ageMs, state}]}`; `state ∈ live|stale|down|no_data`; price is `null` when `down` or `no_data`.
- `GET /v1/perps/candles?market&tf[&limit 1–500, default 200][&before unix][&includeForming=1]` → `{ok, market, tf, source, basis:"sampled", sampleIntervalSec, serverTime, candles:[{t, o, h, l, c, n, coverage, maxGapSec, status, valid}], meta:{firstObservationAt, validCount, returned}}`. Candles ascend by `t` (unix s, UTC); the newest `limit` are returned; no `v` field. Completed candles only unless `includeForming=1`. Invalid-but-complete candles are returned with `valid:false` (the consumer must filter).
- `GET /v1/perps/readiness?market` → `{ok, serverTime, market, tf:"1h", required:60, validConsecutiveCandles, ready, reason, latestCandleAgeSec, earliestReadyAt, earliestReadyIsEstimate:true}`; `reason ∈ ready|insufficient_history|has_gaps|stale|recorder_down|no_data`.
- Errors: `{ok:false, error}` with `bad_market|bad_tf|bad_limit|bad_before|not_found|method_not_allowed|origin_not_allowed|rate_limited|db_unavailable|shutting_down|server_error`.
- Limits (per client IP, per route, 60 s window): 60 requests (`HTTP_LIMIT_PER_MIN`), readiness 10, healthz 120. Short in-process caches: markets 1 s, readiness 5 s, candles 2 s, with in-flight de-duplication.

### WebSocket `wss://<host>/perps/live`
Client → server: `{type:"subscribe", markets:[…≤3], tfs:[…] (default ["1h"])}`, `{type:"unsubscribe", markets:[…]}`, `{type:"ping"}`.
Server → client: `perps_hello {v, epoch, serverTime, markets, intervalSec, source, timeframes}`, `perps_subscribed {markets, tfs, snapshot}`, `perps_unsubscribed`, `perps_tick {market, price, observedAt, seq, source[, persisted:false]}`, `perps_candle {market, tf, final, candle:{t,o,h,l,c,n,status[,valid]}}`, `perps_status {market, state, ageMs}`, `perps_error {code}`, `pong`.
Rules (all **VERIFIED**): a message is sent only for a NEW accepted observation or a state *change*; rejected spikes, failed fetches and duplicate slots send nothing; when a market is stale/down ticks stop (the last price is never repeated as fresh); `seq` is per market and monotonic *within one `epoch`* (a restart changes `epoch`; clients should refetch candles when it changes); forming candle messages are droppable under backpressure, final ones are not; limits: 3 markets, 30 messages / 10 s, 1 KB frames (closes 1009), 20 connections per IP, 30 upgrades/min per IP, origin allowlist, exact path; ping every 25 s and an unresponsive client is dropped after two missed intervals; soft buffer 256 KB (drop), hard 1 MB (terminate); sockets close 1001 on shutdown.
`persisted:false` marks a tick that was published while the database was unavailable.

### Schema (`migrations/001_init.sql`)
`perps_markets`, `perps_observations` (unique `(source,market,slot_ts)`, `price > 0`), `perps_rejects`, `perps_candles` (CHECK constraints: positive prices, `h ≥ o,c,l`, `l ≤ o,c,h`, `complete ⇔ finalized_at`, `valid ⇒ complete`), `perps_fetch_log`, `perps_meta`, `perps_migrations`. Forward-only; checksum-verified; each migration runs in a transaction and a failing one leaves nothing behind (**VERIFIED**). A static test forbids DROP/TRUNCATE in migrations.

## 4. Behaviour summary

**Recorder.** Per-market timers aligned to the UTC interval grid and staggered `idx × interval/3` (0/5/10 s). A slot is skipped (never queued) if the previous fetch is still running, if the market is in backoff, or if the global token bucket is empty. A hard client deadline covers request *and* body read even if the HTTP layer ignores the abort. Recording pauses if the clock moves backwards by more than 2 s. At boot it seeds state from the last stored observation (so `ageMs` is truthful) and trusts it as a jump-filter baseline only if it is ≤ 10 min old. State: `live` ≤ 2.5 × interval, `stale` ≤ 5 min, `down` beyond.

**Candles.** Bucket = epoch-aligned UTC window; `o/c` first/last by receive time, `h/l` extremes; computed from raw observations for every timeframe (never chained). Forming until `bucket end + 1 interval`, then finalised once and immutable (also enforced in SQL). Coverage = observations ÷ `tf/interval`. Bucket-edge gaps count: a candle whose recording began mid-bucket is kept but `valid:false`.

**Single writer.** A PostgreSQL session-level advisory lock on a dedicated connection. A second instance serves reads but does not record; if the lock connection dies, the recorder stops within one supervisor cycle (≤ 15 s), and the lock is re-acquired automatically.

**Database outage.** Accepted observations go to a bounded in-memory queue (240); ticks are still published, flagged `persisted:false`; the queue is flushed in order on recovery, and items whose 1-minute bucket has already been finalised are dropped (counted) so candles remain a pure function of stored rows. HTTP data routes answer `503 db_unavailable`.

## 5. Deviations from the S0 plan (all stricter or additive; please confirm)
1. **Jump filter always applies** (the plan said "within 60 s"). After a long outage a >20 % move also needs 3 confirming samples (≈ 45 s of delay at most).
2. **Only the 3rd confirming sample is stored.** The first two stay in `perps_rejects` as `jump_pending`, so those two slots are gaps (they are never back-filled, even though they were real prices).
3. **Max-gap rule is `max(4 × interval, tf/6)`**, identical to the approved 60/60/150/600/2400 s at 15 s sampling, but it scales if the interval is changed (the plan's fixed 60 s floor would invalidate everything at 30 s).
4. **Readiness reason `incomplete` was dropped** (a forming candle is never part of the window, so it cannot be the reason).
5. Added: `RECORDER_ENABLED` switch (API-only instances), `epoch` in `perps_hello`, `perps_unsubscribed`, `persisted:false`, `suspectFlat`, `/healthz` 200-with-`ok:false` policy.
6. Invalid-but-complete candles are returned by the API with `valid:false` rather than hidden, so a gap is visible to the UI.

## 6. Known limitations (honest list)
- **Nothing was run against Jupiter.** Unknown until S2: whether `price` is a number or string (both are parsed), whether a timestamp field exists (`source_ts` is stored only if one is added in code later; today it is always NULL), the real rate limit and its headers, `Retry-After` behaviour.
- **The `pg` driver was not run.** The offline sandbox cannot install it. The SQL ran on a real PostgreSQL 16 through a psql-based harness; the `createPgDb` adapter was tested against fake Pool/Client classes. A real-driver smoke test is required at S3 (the CI workflow is written but has not run).
- **Sampled OHLC understates ranges** (see README). The first candle after any outage is partial and invalid.
- **60 valid hourly candles need ≥ 60 h of recording** (4h analysis would need 10 days). There is no back-fill path by design.
- Non-leader instances serve HTTP reads but publish no WebSocket ticks (only the leader samples). Irrelevant with one instance.
- `TRUSTED_PROXY_HOPS=1` assumes the platform appends the client IP as the last `X-Forwarded-For` entry. **Unverified for Render**; confirm in S3 or rate limits may key on the proxy.
- `PGSSL=require` sets `rejectUnauthorized:false` (needed for some managed external URLs). Prefer Render's internal URL, which needs no TLS flag.
- Retention runs inside the leader process once per UTC day; it has only run against test data.
- No soak test: behaviour over days (memory, table growth, connection churn) is unmeasured until S4.

## 7. Revision 2 (review adjustments)
- `/healthz` reduced to `{ok, service, ready}`; detail moved to the token-protected `/internal/status` (new env var `STATUS_TOKEN`). No recorder, candle, database or WebSocket behaviour changed; all 89 earlier tests still pass unmodified in meaning (the old health tests were rewritten to the new contract) and 3 new tests were added (92 total). Four deliberate breakages of the new protection were each caught.
- Wording: S1 is an offline implementation stage; no production-readiness claim is made anywhere.

## 8. Not done (by instruction)
No deployment, no Render resources, no frontend change, no S2/S3+, no order functionality, no Chaos Labs dependency.

## Revision 3 — S2 live-browser review (2026-11-16)

Real data: 12/12 HTTP 200 from `https://perps-api.jup.ag/v1/market-stats`, no 429. `price` is a **decimal string**; no timestamp field and no rate-limit headers were visible (browser CORS exposes only `content-length`, `content-type`).

| Area | Finding | Change |
|---|---|---|
| Price parsing | All 12 real strings parse and round-trip exactly (`DEC` regex). | none |
| Magnitude | A x1e6 or x1e-6 scaled price was **accepted** as a first observation (jump filter has no baseline). | Per-market plausibility range (SOL 0.5–50000, ETH 20–500000, BTC 1000–5e6, env `PRICE_RANGE_<M>="min,max"`); out-of-range -> `perps_rejects` reason `implausible`, nothing stored. Migration 001 amended in place (never applied anywhere). |
| Timestamps | The source gives none. All times are **receive time**; staleness is measured on our own age-of-last-accepted-observation, not source freshness. | API now declares `timeBasis: "receive_time"` (`/markets`, candles `meta`). |
| Frozen source | Real data shows identical consecutive prices (e.g. ETH x3) — normal at 15 s, but a stuck upstream would look the same. | Recorder summary adds `unchangedRun`, `maxUnchangedRun`, `lastPriceChangeAt` (`suspectFlat` kept). Detection only; no data is altered. |
| Backoff / Retry-After | Logic unchanged and unit-tested with MOCK 429/Retry-After. Real Jupiter headers are **unknown**. | none; needs a Node live-check run. |
| Recorder | Replayed the 12 real values through the real recorder + PostgreSQL: stored exactly, no rejects. | `tests/live-fixtures.test.js` (6 tests; network MOCK). |

Tests: 98/98 (was 92). Mutants: disabling the recorder range check, and dropping the upper bound, are both caught.

### Remaining before S2 can be fully accepted
1. Run `scripts/live-check.mjs` under Node (not a browser) to capture full response headers and any Retry-After/ratelimit headers.
2. Longer sampling at the real 15 s cadence (S4 soak) — 4 samples/market prove nothing about sustained rate limits.
3. Behaviour from a server/datacenter origin (Render egress IPs may be shared); first check from the service container with `RECORDER_ENABLED=0` in S3 staging.
4. Decision on whether a Jupiter API key is needed.
Not claimed: production readiness, any live integration beyond the 12 browser requests. S3 not started.
