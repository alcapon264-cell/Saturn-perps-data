# Saturn Perps R125: why the live screen shows only SOL, ETH and BTC, and the fix

Nothing was deployed and no Render setting was changed. Render was **read**, with your permission, through the connected Render account.

## 1. Root cause, traced end to end

| Step | Finding | Evidence |
|---|---|---|
| Render service | `saturn-perps-staging`, repo `alcapon264-cell/Saturn-perps-data`, branch `main`, **auto-deploy OFF**, free plan, Singapore | Render: `list_services` |
| Live commit | `8307320` (R123), deployed **manually** at 00:55 on 18 Nov | Render: `list_deploys` |
| R124 | **Never reached GitHub** (no `src/markets.js` in the repo), so it was never deployed | GitHub clone |
| View-market pipeline on the live server | **Switched off.** The app logs show "leader: recorder started" and then no `view:` line at all. In R123 the eight markets run only when the `VIEW_MARKETS` environment variable is set, and it logs a `view:` line when they start. | Render: app logs, 00:55, 01:50 and 04:28 starts |
| **Where the 8 markets disappear** | **In the backend's market aggregation.** With `VIEW_MARKETS` unset, `view.marketsView()` returns nothing, so `/v1/perps/markets` returns only SOL/ETH/BTC, and the frontend correctly draws the 3 rows it receives. | Reproduced: the real R123 code with Render's current environment on a real PostgreSQL returns 3 markets, and the real frontend in Chromium renders 3 rows (BEFORE screenshot) |
| ETH "stale" | The free plan **spins the service down when idle** (restarts at 01:50 and 04:28 in the logs), so the recorder stops between visits. Prices after a wake-up are briefly old, and the app labels them honestly as **Stale**. | Render: logs |

## 2. The fix (works with Render as it is configured today)

| File | Change |
|---|---|
| `src/config.js` | `VIEW_MARKETS` **unset means all eight markets**. `VIEW_MARKETS=off` turns them off; a list still selects a subset. **No Render setting is needed.** |
| `src/view.js` | **The CoinGecko key is optional.** Without it, every market's price is checked against its own Hyperliquid oracle price (from `metaAndAssetCtxs`), and CoinGecko's public endpoint is used only every 6 hours, to confirm coin identity and get logo URLs, with no key sent. With a key, crypto prices are also cross-checked against CoinGecko every 5 minutes. |
| `src/viewsources.js` | CoinGecko client: the key header is sent only when a key exists |
| `src/markets.js`, `src/app.js`, `src/ws.js` | the R124 single registry and single contract (R124 had never been uploaded, so it is included here) |
| `index.html` (Perps blocks only) | A market whose price drops out **stays listed**. SOL/ETH/BTC without a live price now show "Price unavailable" and "Trading paused" instead of disappearing. The source wording covers the oracle check for crypto. |
| tests | the harness opts the SOL/ETH/BTC tests out of the view pipeline; new tests for "no key, no `VIEW_MARKETS`" |

## 3. Jupiter Perps: which markets it actually supports

- Saturn's Jupiter Perps integration (`perps-api.jup.ag` market-stats plus the Jupiter Perps program on Solana) has custody accounts for **SOL, ETH and BTC only**. Those three stay on Jupiter, with their execution path unchanged.
- **HYPE, ZEC, JUP, NEAR, BNB, SNDK, SPCX and SKHYNIX are not Jupiter Perps markets on that API.** JUP is the JUP *token*, not Jupiter Perps itself. Jupiter's newer markets run on its own network, which has no public API; earlier research in this project found none.
- So none of them is labelled as Jupiter data. Their prices come from Hyperliquid's public perpetual markets: main perps for the crypto, Trade.xyz HIP-3 for the stocks. Each is labelled "Hyperliquid perp", and the stocks also say "not the stock's exchange price".
- CoinGecko is **not** a replacement for anything. It is now optional: it supplies logos and an extra check.

## 4. Verification

| Check | Kind | Result |
|---|---|---|
| Real backend code (R123 = live, and R125) + **real local PostgreSQL** + Render's **current** environment; the **real frontend** in Chromium | Integration: real code, real database, real browser. **Scripted:** Jupiter, Hyperliquid and CoinGecko responses, Solana RPC, wallet. | **BEFORE (R123):** 3 markets, matching the live screen. **AFTER (R125):** 11 markets at 360, 390 and 430 px, 60/60 checks |
| Each row shows its own backend price; ETH (feed failing) shows **Stale**; SK hynix (sources disagree) stays listed as **Price unavailable**; only SOL/ETH/BTC have 20x | same | pass |
| Each of the 11 profiles: own symbol, price and stats; the chart requested **only its own candles** from the real backend; SOL/ETH/BTC keep the order form, the 8 others have none | same | pass |
| Backend `npm test` | real PostgreSQL, scripted providers | 148/148 |
| Frontend regression suites | all mocked | see the test results file |
| Live Hyperliquid / CoinGecko / Jupiter from Render's Singapore region | **NOT verified.** This workspace can't make internet calls. After deploy, the Render log line `view: recorder started; listed: …` proves it. | pending deploy |
| The live website | **NOT verified.** It can't be fetched from here. | pending deploy |

**Logos:** SOL/ETH/BTC and the 5 crypto markets get the verified CoinGecko images. In the screenshots these are stand-ins, because the CoinGecko image host can't be reached from here. SNDK, SPCX and SKHYNIX show a plain disc until official PNGs are added to `assets/logos/` and declared in `SOURCES.json`. There is no legitimate source for stock logos that the server can download automatically.

## 5. What still needs you, and why

1. **Upload to GitHub.** Neither I nor Render can do this for you; I have read-only access to the repo.
   - Backend `alcapon264-cell/Saturn-perps-data`, branch `main`, with these paths:
     - `src/app.js`, `src/config.js`, `src/markets.js` (new), `src/view.js`, `src/viewsources.js`, `src/ws.js`
     - `tests/helpers/harness.js`, `tests/helpers/fake-providers.js` (new), `tests/http.test.js`, `tests/unified.test.js` (new), `tests/view.test.js`, `tests/ws.test.js`
     - `docs/R125-MISSING-MARKETS-ROOT-CAUSE.md`
   - Frontend: `index.html` in the repository that serves `alcapon264-cell.github.io`.
2. **Deploy.** Auto-deploy is off, so a GitHub upload alone changes nothing on Render. With your approval, I can start "Deploy latest commit" through the connected Render account. That is a deploy, not a settings change. I would then read the logs to confirm the eight markets started, and I'd report only what the logs show.
3. **The free plan sleeping** is the reason prices go stale and history has gaps. Code can't fix it. The options are:
   - Accept it; the gaps and stale labels are shown honestly.
   - Move this service to a paid instance, which doesn't sleep.
   - A keep-alive ping is **not** recommended. The free hours are shared with `saturn-evm-ws`, so keeping this service awake all the time would use up the monthly allowance.
