# Saturn Perps Data (independent service)

Records Jupiter Perps `GET /v1/market-stats` prices for SOL, ETH and BTC, builds **sampled** OHLC candles from the recorded observations only, and serves them through a read-only HTTP API and a **separate** Perps WebSocket. It holds no wallets or keys, never signs anything and does not touch any existing Saturn service. Since r115 it also hosts the Perps gateway: positions reads are on; the transaction-relay routes exist but are disabled unless explicitly enabled (they are not, and must not be, until execution is approved).

**Status: stage S1 accepted as an offline implementation (built and tested against mocks). NOT production-ready. Not deployed. Not connected to the Saturn frontend.**

## What it will and will not do
- Samples every `SAMPLE_INTERVAL_SEC` (default 15 s), staggered per market, capped at 0.25 requests/s, with automatic backoff on 429/5xx/timeouts.
- Stores every accepted price in PostgreSQL with a unique `(source, market, slot)` key. Invalid prices and unconfirmed jumps go to `perps_rejects`.
- Builds 1m/5m/15m/1h/4h candles from stored observations. Missing time stays missing. No interpolation, no back-fill, no volume.
- A candle is `valid` only if it is complete, has ≥ 80 % sample coverage, and no gap above `max(4 × interval, timeframe/6)`.
- r118: `/v1/perps/markets` also returns `symbol`, `mint`, `executable` (true only where the on-chain execution metadata exists) and `stats24h` (open/high/low/last/change from this service's own recorded 1h candles; `null` when fewer than 20 of the last 24 hours were recorded). `volume24h` and `openInterest` are always `null`: they are not recorded, and nothing is estimated.
- Candles are **sampled**: spikes between samples are invisible, so highs are understated and lows overstated compared with a venue's own candles. Every API response says `basis: "sampled"`.

## Layout
```
server.js              entry point (needs pg + ws installed)
src/config.js          env, fixed market table, thresholds
src/jupiter.js         the only outbound call: one GET to perps-api.jup.ag
src/validate.js        price parsing + 20 % jump filter (3 confirming samples)
src/recorder.js        scheduling, backoff, token bucket, queue, state machine
src/candles.js         pure candle maths + validity rule
src/engine.js          forming/finalise/recover runtime
src/store.js db.js     all SQL / driver adapter + forward-only migrations
src/http.js ws.js      read-only API / Perps WebSocket hub
src/app.js             wiring, leader lock, timers, retention, shutdown
migrations/001_init.sql
scripts/live-check.mjs, live-check.html   read-only Jupiter check (run by you, stage S2)
tests/                 105 automated tests (see docs/TEST-RESULTS.md)
docs/                  implementation report, security report, cost estimate, S2 live-check guide
```

## Endpoints (all GET, JSON)
`/healthz` (public, minimal: `{ok, service, ready}`) · `/internal/status` (detailed, only when `STATUS_TOKEN` is set; bearer token; never callable from a browser) · `/v1/perps/markets` · `/v1/perps/candles?market=SOL&tf=1h&limit=200[&before=<unix>][&includeForming=1]`
r118: the A.A.I.H. route `/v1/perps/readiness` was removed (now 404) together with `src/readiness.js`.
Perps gateway (r115, see `docs/R115-GATEWAY.md`): `GET /v1/perps/jup/positions?walletAddress=<base58>&includeClosedPositions=false` · `GET /v1/perps/jup/market-stats?mint=<SOL|ETH|BTC mint>` (served from this service's recorder) · `POST /v1/perps/jup/positions/increase|decrease` and `POST /v1/perps/jup/execute` — **off by default** (`403 execution_disabled`).
WebSocket: `wss://<host>/perps/live` (messages `perps_hello`, `perps_subscribed`, `perps_tick`, `perps_candle`, `perps_status`, `perps_error`, `pong`).
Full contracts: `docs/IMPLEMENTATION-REPORT.md`.

## Run locally
```
npm install
export DATABASE_URL=postgres://...      # a local PostgreSQL you control
export ALLOWED_ORIGINS=http://localhost:8000
npm start
```
Migrations run automatically at boot. Only one instance records at a time (PostgreSQL advisory lock).

## Tests
```
npm test      # needs PostgreSQL server binaries (initdb, pg_ctl); the tests start a throw-away local cluster
```
Unit tests need nothing. Database, recorder, HTTP and WebSocket tests run the service's real SQL against a real PostgreSQL through a psql-based harness, with a scripted fake Jupiter and a fake clock. See the honesty notes in `docs/TEST-RESULTS.md`.

## Live check (stage S2, run by you)
```
node scripts/live-check.mjs --samples 4 --interval 15 --out live-check.json
```
Read-only GETs only. Shows every response header (look for rate-limit headers), whether `price` is a number or string, and whether any timestamp field exists.

## Adding a market (r118, r119)
The frontend market list is dynamic: it shows whatever `/v1/perps/markets` returns. A market appears once it is added to `MARKETS` in `src/config.js` (token mint), the recorder has prices for it, and (r119) it has an entry in `MARKET_META` (`name`, `category`: `major` or `stock`, `maxLeverage`: Saturn's limit). The app's category chips (Majors, Stocks, Gainers, Losers) only appear when real markets fill them. It is only **tradeable** (`executable: true`) when its execution metadata (custody accounts) is added to `CUSTODY` in `src/perps-program.js`; otherwise Saturn lists it as **View only**. The current venue (Jupiter Perps, JLP pool) supports SOL, ETH and wBTC only. Its Beta markets (JUP, HYPE, ZEC, SPCX, SNDK, SKHYNIX) run on the separate GUM orderbook engine; Jupiter's docs publish no price/order API or program id for them, so the recorder cannot price them and Saturn cannot trade them. They are not listed until a documented, verifiable data source exists.
