> **r118 note:** this is a historical stage report. The A.A.I.H. readiness gate (`src/readiness.js`, `/v1/perps/readiness`) described below was removed in r118.

# S1 Test Results (revision 2)

Final run of `npm test` (`node --test --test-concurrency=1 tests/*.test.js`) on Node v22.23.4, PostgreSQL 16. S1 is an offline stage: **not production-ready**.

**Result: 98/98 passed, 0 skipped, 0 cancelled.**

## What these results do and do not prove
- **Real:** SQL, constraints, migrations, advisory locks, retention and candle maths ran against an actual PostgreSQL 16 server. The HTTP and WebSocket tests used real local TCP sockets (`fetch`, `ws`).
- **Mock:** every Jupiter response (scripted fake), and time (fake clock). **Jupiter was never contacted.**
- **Not the production driver:** the `pg` npm package cannot be installed in the offline sandbox. Database tests used a psql-backed harness that inlines parameters; the `createPgDb` adapter was tested against fake `Pool`/`Client` classes only.
- **Not covered:** Render networking/TLS/`X-Forwarded-For`, multi-day soak behaviour, the future frontend integration, dependency CVEs.
- **Mutation check:** 14 deliberate code breakages (coverage rule off, max-gap rule off, instant jump acceptance, rewritable complete candles, CORS check removed, readiness always ready, tick on duplicate slot, no clock guard, status spam, forming-valid, status token check removed, status reachable from a browser origin, /healthz returning detail again, status enabled with no token) were each caught by at least one test. One initial survivor (duplicate-slot tick) led to a strengthened test.

## unit.test.js — 21/21 pass
**What:** Pure logic: time, candles, validation, Jupiter client, config, limits  
**Kind:** MOCK (no network, no database)

- PASS — time: UTC alignment for every timeframe, incl. day/month/year boundaries
- PASS — candle: OHLC correct, first/last by time, high/low from extremes
- PASS — candle: zero observations -> no candle (never fabricated)
- PASS — candle: forming until bucket end + grace, complete after
- PASS — candle: validity thresholds at exact boundaries (coverage 0.80 and max gap)
- PASS — candle: bucket-edge gaps count (recording started mid-bucket -> invalid)
- PASS — candle: property test vs brute-force oracle (random sets, shuffled-insertion invariance)
- PASS — candle: ohlcOk rejects invalid candles
- PASS — validate: price parsing accepts plain positive decimals only
- PASS — jump filter: 20% rule, 3 consecutive confirming samples required
- PASS — jump filter: a lone spike never gets in; pending resets when price returns
- PASS — jump filter: non-agreeing jumps do not confirm each other; down moves handled symmetrically
- PASS — jump filter: seed() sets a baseline; reset() clears it
- PASS — jupiter client: fixed host only, GET only, no redirects, no credentials
- PASS — jupiter client: classifies every failure mode
- PASS — jupiter client: captures rate-limit headers generically; sends API key only when configured, with the configured header name
- PASS — jupiter client: retry-after parsing
- PASS — config: defaults, bounds, secrets handling
- PASS — config: STATUS_TOKEN must be long and printable; empty means the status endpoint is disabled
- PASS — limits: client IP ignores a spoofed first x-forwarded-for entry
- PASS — limits: sliding window limiter

## db.test.js — 14/14 pass
**What:** Schema, constraints, migrations, store SQL, candle runtime, A.A.I.H. readiness, leader lock  
**Kind:** REAL PostgreSQL 16 (psql harness, not the `pg` driver)

- PASS — migrations: apply once, idempotent, checksum-protected, all tables present
- PASS — schema: observation constraints (duplicate slot, non-positive price, unknown market)
- PASS — schema: candle CHECK constraints enforce OHLC integrity at the storage layer
- PASS — store: observations range query, last/first, candle upsert immutability
- PASS — store: purge is limited to allow-listed tables and deletes in batches
- PASS — store: SQL injection strings are inert (parameterised)
- PASS — engine: rebuild from observations == independent oracle, for every timeframe; idempotent; complete rows frozen
- PASS — engine: a hole in the data produces a hole in the candles (no fabrication)
- PASS — engine: onObservation keeps forming candles current; finalizeDue closes them after bucket end + grace
- PASS — readiness: 60 contiguous valid hourly candles -> ready; 59 -> insufficient_history (with a labelled estimate)
- PASS — readiness: one missing hour inside the window blocks readiness until it ages out
- PASS — readiness: stale newest candle, recorder_down, no_data
- PASS — readiness: 59 valid + 1 invalid is NOT ready (59/60 is not ready)
- PASS — leader lock: second session cannot take it; released/killed lock can be re-acquired

## recorder.test.js — 18/18 pass
**What:** Recorder + wiring: sampling, backoff, failures, jump filter, restart, outage, single writer, retention, secret leakage  
**Kind:** REAL PostgreSQL + MOCK Jupiter + fake clock

- PASS — samples every 15 s per market, staggered 0/5/10 s, never over the request budget
- PASS — duplicate slot: two fetches in one slot -> one stored row, exactly one tick, one candle update
- PASS — failure modes: nothing invalid is stored; each is logged; other markets keep recording
- PASS — invalid prices from a healthy HTTP 200 are rejected and recorded as rejects
- PASS — 429: backoff ladder 30/60/120 s (cap), Retry-After honoured, no tight loop, recovery resets
- PASS — rate-limit headers are captured and surfaced in health (never assumed)
- PASS — global request budget caps total calls even with a short interval
- PASS — no overlap: a hung fetch makes the next slot skip, not queue; the client deadline still frees it
- PASS — jump filter end-to-end: lone spike rejected, sustained move accepted on the 3rd confirming sample
- PASS — stale -> down transitions at 37.5 s and 5 min; recovery to live; status events published only on change
- PASS — restart recovery: gap preserved, state truthful, candles rebuilt, nothing back-filled
- PASS — crash between observation insert and candle write: recovery rebuilds the missing candle
- PASS — database outage: ticks still published (persisted:false), bounded queue flushed in order on recovery, late items dropped, candles stay consistent
- PASS — single writer: a second instance on the same database does not record; takes over when the leader goes away
- PASS — leader loss while running stops the recorder (no split-brain)
- PASS — clock moving backwards: recording pauses instead of writing out-of-order data
- PASS — retention: purges old observations/logs, keeps candles; runs once per UTC day
- PASS — config safety: neither the public health route nor the protected status route leaks the database URL, API key or status token; logs are clean

## http.test.js — 13/13 pass
**What:** Read-only HTTP API over a real socket, minimal /healthz, protected /internal/status  
**Kind:** REAL PostgreSQL + REAL local socket + MOCK data/clock

- PASS — healthz is PUBLIC and MINIMAL: only ok/service/ready, no operational detail, no secrets
- PASS — /internal/status: does not exist unless STATUS_TOKEN is configured
- PASS — /internal/status: token required (401), never browser-callable (403), attempts rate-limited (429), correct token returns detail without secrets
- PASS — markets: live / stale / down / no_data; price withheld when down
- PASS — candles: contract, ordering, completed-only default, includeForming, limit/before, valid flags, no volume field
- PASS — candles: parameter validation matrix (fuzz)
- PASS — readiness endpoint: not ready -> ready; labelled estimate; shape
- PASS — CORS: allowed origin, foreign origin, no origin, preflight; write methods refused
- PASS — CORS is fail-closed when ALLOWED_ORIGINS is empty
- PASS — rate limit: per-IP window; spoofed first x-forwarded-for entry cannot dodge it; limits are per route
- PASS — database outage: 503 db_unavailable on data routes, health stays 200 with ok:false, recovers
- PASS — shutdown: new data requests get 503 shutting_down
- PASS — responses never contain more than the documented fields (no raw upstream payload)

## ws.test.js — 13/13 pass
**What:** Perps WebSocket over real sockets, hub backpressure  
**Kind:** REAL PostgreSQL + REAL local sockets (ws) + MOCK Jupiter + fake clock

- PASS — hello on connect: protocol fields, no raw data; path and origin enforced
- PASS — ticks: sent only for NEW accepted observations of subscribed markets; seq monotonic; markets isolated
- PASS — no message for rejected spikes, failed fetches or duplicate slots
- PASS — candle messages: forming updates, then a final complete candle with its validity flag; only subscribed timeframes
- PASS — staleness: a status message is sent, ticks stop (last price is NOT repeated as fresh), recovery announces live
- PASS — protocol validation: every malformed client message gets a typed error and the socket survives
- PASS — subscribe limits are cumulative per connection; unsubscribe stops delivery
- PASS — per-connection message rate limit and 1 KB payload cap
- PASS — per-IP connection cap; slot freed on close
- PASS — heartbeat: a client that never answers pings is dropped; a normal client stays
- PASS — shutdown closes sockets with 1001
- PASS — hub backpressure (fake sockets): droppable messages skipped over the soft limit, slow consumers terminated over the hard limit
- PASS — hub: unsubscribed clients get nothing; closed clients are cleaned up

## static.test.js — 7/7 pass
**What:** Repository guarantees: isolation, read-only, secrets, dependencies, migrations  
**Kind:** Static analysis of the repo

- PASS — isolation: the existing Saturn WebSocket constant and hosts never appear in this repository
- PASS — read-only: the only outbound call is one GET to the fixed Jupiter host; no write verbs, no order/position endpoints
- PASS — HTTP surface: only GET/OPTIONS routes; no body parsing; no eval/child_process/dynamic require
- PASS — secrets: no keys, tokens, URLs with credentials or private hosts hard-coded; .env is ignored
- PASS — dependencies: exactly ws and pg, nothing else
- PASS — WebSocket is a separate path on this service; the spot path is not served
- PASS — migrations are additive and forward-only (no DROP/TRUNCATE/ALTER ... DROP)

## pgdb.test.js — 4/4 pass
**What:** node-postgres adapter logic; server.js refuses to boot without config  
**Kind:** FAKE Pool/Client classes (real `pg` NOT run)

- PASS — pg adapter: pool is configured with timeouts and a small max; query passes params through
- PASS — pg adapter: a failing script is rolled back and the connection is released
- PASS — pg adapter: leader lock uses ONE dedicated connection, is idempotent, reports loss, and releases
- PASS — server.js refuses to start without DATABASE_URL and never prints secrets

## livecheck.test.js — 2/2 pass
**What:** scripts/live-check.mjs read-only behaviour  
**Kind:** STUBBED fetch (Jupiter NOT contacted)

- PASS — live-check: GET-only to the Jupiter host, 3 requests per sample, reports headers / price type / timestamp-like keys
- PASS — live-check: caps requests (max 20 samples), exits non-zero on 429 or network failure, never sends credentials

## Revision 3
Added tests/live-fixtures.test.js (6 tests, real price strings as fixtures, MOCK network). Total 98/98.
