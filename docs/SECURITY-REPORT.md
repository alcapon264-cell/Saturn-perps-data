# S1 Security Report — Saturn Perps Data Engine

Status: S1 accepted as an offline stage; **not production-ready** (never run against Jupiter or Render). Revision 2 closes F2.

Method: design review of every module, static tests over the repository, and adversarial automated tests (fuzzed parameters, hostile origins, spoofed headers, oversize frames, SQL-injection strings, outage injection). Mutation checks confirmed the key controls are actually tested (14 deliberate breakages, all caught). **Not done:** external penetration test, dependency CVE scan (offline), review of the real Render network setup (nothing is deployed).

## 1. Attack surface

| Surface | Exposure | Controls |
|---|---|---|
| HTTP API (`/healthz` minimal, 3 `/v1/perps/*` GETs, optional token-protected `/internal/status`) | Public internet (when deployed) | Exact-origin CORS (fail-closed), GET/OPTIONS only, strict parameter grammar, per-IP/per-route limits, no body parsing, no stack traces, parametrised SQL, short caches |
| WebSocket `/perps/live` | Public internet | Exact path, origin allowlist, 1 KB frames, 30 msg/10 s, ≤ 3 markets, 20 conn/IP, 30 upgrades/min/IP, heartbeat, backpressure close |
| Outbound | Jupiter only | One module, fixed host/path/mints, HTTPS only, GET only, no redirects, no cookies, 64 KB cap, hard deadline |
| Database | Private (Render internal URL recommended) | Credentials only in env; CHECK/UNIQUE constraints; optional SELECT-only role for request paths |
| Secrets | `DATABASE_URL`, optional Jupiter key, optional `STATUS_TOKEN` | Server env only; never logged or returned; startup error messages contain no values |

## 2. Controls and the tests that prove them

| Threat | Control | Evidence |
|---|---|---|
| Forged CORS / hostile page reads data | Exact string match against `ALLOWED_ORIGINS`; empty list refuses all browser origins; `Origin: null` refused; look-alike suffix refused | `http.test.js` CORS ×2; mutation "CORS check removed" caught |
| Rate-limit bypass by spoofing `X-Forwarded-For` | Client-controlled first entry is ignored; the last entry (proxy-appended) is used; `TRUSTED_PROXY_HOPS` configurable | `unit.test.js` limits; `http.test.js` rate-limit (varying first entry does not create new budgets) |
| SQL injection | All values are bound parameters; table/column names for purge are an allow-list | `db.test.js` injection test; fuzz matrix in `http.test.js` (tables intact afterwards) |
| Parameter abuse (huge/negative/typed values, `__proto__`, NUL) | Regex grammar + enum membership via own-property check | 25-case fuzz matrix |
| SSRF / egress abuse | No user input reaches a URL host or path; mint is looked up server-side; client constructor rejects any base other than `https://perps-api.jup.ag` | `unit.test.js` (3 hostile bases, hostile mint string), `static.test.js` (only `src/jupiter.js` performs I/O) |
| Fake or poisoned prices | `price` must be a plain decimal > 0 and ≤ 1e9; hex/exponent/NaN/Infinity/arrays/objects rejected; 20 % jump filter with 3 mutually confirming samples | `unit.test.js`, `recorder.test.js` |
| Candle tampering after the fact | `complete` rows cannot be updated (SQL `WHERE status='forming'`); OHLC CHECK constraints; `valid ⇒ complete` | `db.test.js`; mutation "rewritable" caught |
| Request flooding / resource exhaustion (HTTP) | Rate limits; caches with in-flight de-duplication; bounded cache and limiter maps | `http.test.js` |
| WS flooding / slow-loris consumers | Message-rate window; 1 KB frames; connection caps; heartbeat; backpressure termination | `ws.test.js` |
| Jupiter rate-limit ban | Global token bucket ≤ 0.25 rps (hard ceiling 0.5), backoff ladder, `Retry-After`, no overlap, circuit state | `recorder.test.js` |
| Split-brain double recording | Advisory lock on a dedicated session; recorder stops if the session dies; unique slot constraint as a second barrier | `recorder.test.js`, `db.test.js` |
| Data fabrication | No interpolation code path; holes stay holes; no volume | `db.test.js` hole test; `recorder.test.js` restart test |
| Trading / key abuse | No wallet, signing, order, position or write code; no request-body reads; static scan for trading verbs and signing libraries | `static.test.js` |
| Secret leakage | Public health and protected status responses and logs contain no DB URL, API key or status token; startup errors name variables, not values; `.env` ignored; no credentialed URLs in the repo | `recorder.test.js` leak test; `pgdb.test.js` boot test; `static.test.js` |
| Supply chain | Two runtime dependencies (`ws`, `pg`), no install scripts, no dynamic `require/import`, no `eval`/`child_process` in service code | `static.test.js` |
| Destructive migrations | Forward-only, transactional, checksum-verified, no DROP/TRUNCATE | `db.test.js`, `static.test.js` |

## 3. Findings from my own review

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | Medium | `TRUSTED_PROXY_HOPS=1` is an assumption about Render's `X-Forwarded-For` behaviour. If wrong, all clients could share one IP (over-limiting) or be spoofable (under-limiting). | **Open — verify in S3** by sending a request with a forged header and reading the observed header chain. |
| F2 | Medium | `/healthz` disclosed operational state (market states, failure counts, queue length, rate-limit headers, thresholds). | **Closed in revision 2.** `/healthz` now returns only `{ok, service, ready}`. Detail lives at `/internal/status`: absent unless `STATUS_TOKEN` is set, bearer token in constant time, refused for any browser `Origin`, 10 attempts/min/IP. Tests: `http.test.js` (3 tests), `recorder.test.js` leak test; 4 mutations caught. New residual risk F10. |
| F3 | Low | `PGSSL=require` disables certificate verification (`rejectUnauthorized:false`). | **Documented.** Use Render's internal connection string (no TLS flag). |
| F4 | Low | One database role is used by the recorder and, unless `READER_DATABASE_URL` is set, by HTTP/WS paths. SQL injection is prevented, but least privilege is better. | **Optional control provided**; creating the SELECT-only role is a manual S3 step (Render does not allow it via the app). |
| F5 | Low | In-memory rate limiting resets on restart. | Accepted (single instance). |
| F6 | Low | Messages with unknown fields are ignored rather than rejected. | Accepted. |
| F7 | Info | Unauthenticated read access is intentional (public market data). Anyone can open up to 20 WS connections per IP. | By design. |
| F8 | Info | Dependency vulnerabilities were not scanned (offline). | **Open — run `npm audit` at S3** after install. |
| F10 | Low | `/internal/status` relies on a shared bearer token. If it leaks, an attacker can read operational state (no secrets, no write ability). Token travels in a header over TLS. | Open: set it only as a Render secret env var, use ≥ 32 random characters, rotate by changing the env var. Leave `STATUS_TOKEN` unset if you do not need the endpoint. |
| F9 | Info | No TLS or HTTP/2 handling in the app; Render terminates TLS. | By design. |

No critical or high findings. Two weaknesses found *during* the build were fixed before this report: (a) the Jupiter client could hang forever if a `fetch` implementation ignored `AbortSignal` — it now has a hard deadline over request and body read; (b) the data routes returned 500 instead of 503 when the database failed.

## 4. What this report does not cover
Live behaviour of Jupiter, Render networking and TLS, real `pg` driver behaviour, long-running memory behaviour, and the (future) frontend integration. Each is scheduled for S2–S4 and nothing here should be read as a claim about them.
