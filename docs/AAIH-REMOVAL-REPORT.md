# A.A.I.H. Removal — Saturn Perps

## Decision
A.A.I.H. is removed from Saturn Perps for now. It may be reconsidered later as a separate project, but it is not a dependency of Perps.

## Removed
- `src/readiness.js` and the 60-consecutive-valid-hourly-candle gate.
- `/v1/perps/readiness` HTTP route and its route-specific rate limit/cache.
- Readiness-only application wiring and configuration (`readinessRequired`, `READINESS_LIMIT_PER_MIN`).
- Readiness-only database and HTTP tests.
- README and implementation documentation that described the gate as part of the live Perps API.

The old route now falls through to the normal `404 not_found` response.

## Preserved
- Recorder cadence, request budget, backoff, jump filter, queue and persistence behaviour.
- Jupiter market data source and `/v1/perps/markets`.
- Sampled OHLC candle generation and `/v1/perps/candles`.
- Candle validity: complete candles still require at least 80% sample coverage and must satisfy the existing maximum-gap rule.
- Missing intervals remain missing; no interpolation, synthetic candles, or backfill was added.
- PostgreSQL schema and migrations are unchanged.
- Perps gateway execution remains disabled by default. This patch does not enable signing, orders, or live execution.
- Existing Saturn frontend/WebSocket constants and other Saturn services are not edited by this patch.

## Important distinction
Removing A.A.I.H. removes the 60-hour readiness dependency. It does not make data more accurate, create missing history, or establish production/trading safety. Consumers must continue to inspect market state and each candle's `valid` flag.

## Verification
This ZIP is a source patch package based on the supplied repository snapshot. The test-results document is explicitly marked as a historical pre-removal baseline. Run the repository's normal CI test workflow after replacing the listed files; no deployment is performed by this package.
