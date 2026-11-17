# Saturn Perps R121: complete Markets (11 markets, real logos, individual profiles)

Status: implemented and tested locally. **Not deployed.** No GitHub change, no production database change, nothing purchased.
Monthly API cost: **$0** (Hyperliquid public API with no key; CoinGecko Demo with a free key).
R121 supersedes R120. R120's migration 003 was never applied anywhere. If it was, run `ops/003_rollback.sql` before deploying R121, because R121's 003 differs and the checksum guard will refuse the old one.

## 1. The 11 markets: data and trading status

| # | Market | Asset (verified identity) | Price source (free) | Check | 24 h change | Trading in Saturn |
|---|---|---|---|---|---|---|
| 1 | SOL | Solana | Saturn recorder (Jupiter Perps) | unchanged | Saturn's own recorded history | **Tradable** (existing execution path and locks unchanged) |
| 2 | ETH | Ethereum | Saturn recorder (Jupiter Perps) | unchanged | Saturn's own recorded history | **Tradable** (unchanged) |
| 3 | BTC | Bitcoin | Saturn recorder (Jupiter Perps) | unchanged | Saturn's own recorded history | **Tradable** (unchanged) |
| 4 | HYPE | Hyperliquid | Hyperliquid `HYPE` | CoinGecko `hyperliquid` | Venue previous-day price, then Saturn history | View only |
| 5 | ZEC | Zcash | Hyperliquid `ZEC` | CoinGecko `zcash` | as above | View only |
| 6 | JUP | Jupiter | Hyperliquid `JUP` | CoinGecko `jupiter-exchange-solana` | as above | View only |
| 7 | SNDK | Sandisk Corporation (Nasdaq: SNDK) | Hyperliquid HIP-3 `xyz:SNDK` (deployed and operated by Trade.xyz) | Market's own oracle price | as above | View only |
| 8 | SPCX | SpaceX common stock (Nasdaq: SPCX, listed 12 June 2026) | Hyperliquid HIP-3 `xyz:SPCX` (Trade.xyz) | Market's own oracle price | as above | View only |
| 9 | NEAR | NEAR Protocol | Hyperliquid `NEAR` | CoinGecko `near` | as above | View only |
| 10 | SKHYNIX | SK hynix Inc. (KRX: 000660; USD value of one share) | Hyperliquid HIP-3 `xyz:SKHYNIX` (alias `xyz:SKHX` also accepted) (Trade.xyz) | Market's own oracle price | as above | View only |
| 11 | BNB | BNB | Hyperliquid `BNB` | CoinGecko `binancecoin` | as above | View only |

**Why view only:** Saturn's execution path is Jupiter Perps on Solana, which has custody accounts only for SOL, ETH and BTC. Jupiter's newer markets run on Jupnet, which has no public API. Executing on Hyperliquid would need a different wallet type (EVM) and a new signing integration, so it was not added.

**Honest status:** every market is always listed with its symbol, name, logo and category. Its price shows only while all of these hold:
1. It is listed on Hyperliquid.
2. For crypto, its CoinGecko ID matches the expected symbol and name.
3. A check within the last 20 minutes found the sources within 2 % of each other.
4. Its price is live and not frozen.

Otherwise the row and the profile say **"Price unavailable"**, no chart is drawn, and nothing is recorded.

**Equity check:** CoinGecko does not cover stocks, and no free equity price feed suitable for this was found. Equities are therefore checked against their own market's oracle price, read from `metaAndAssetCtxs`. That check is from the same venue, not an independent source. It does catch bad prints like the July 2026 SK hynix incident, where the order book and the oracle diverged.

## 2. Verification performed

| Check | Result |
|---|---|
| Hyperliquid lists each coin under the expected name | **Not verified live from this workspace** (no internet; its proxy refuses every host). Public reporting confirms `xyz:SNDK`, `xyz:SPCX` and `xyz:SKHYNIX` on Trade.xyz, and HYPE, ZEC, JUP, NEAR and BNB as main perps. The service re-checks the listing every 60 s. |
| Backend region can reach Hyperliquid | **Not verified** (same reason). Run the check script on the server. |
| CoinGecko IDs | `hyperliquid` and `binancecoin` were confirmed on CoinGecko's own pages; the others come from public references. Each ID is re-checked on every cross-check by symbol and name. |
| Real-service run of `scripts/view-markets-live-check.mjs` here | All four Hyperliquid requests failed with "network" (sandbox). The full output is in the test results. |

Run this once on the Render host (no Postman needed):

```
COINGECKO_DEMO_KEY=<free demo key> npm run view-check
```

## 3. Data architecture (all free)

- **Prices:** `allMids` once per market set (`main` and `xyz`) per 15 s slot. That is 2 requests per slot for all 8 view markets, weight 4 out of a limit of 1,200 per minute per IP.
- **Listing, oracle and previous-day price:** `metaAndAssetCtxs` once per market set every 60 s (weight 40 per minute).
- **CoinGecko:** one batched call every 5 minutes, for the 5 crypto markets plus the SOL/ETH/BTC logos.
  - Monthly cap of 9,500 calls, enforced before each request.
  - The key travels in a header only and is never logged.
- **Separate pipeline and tables:** an independent recorder (`src/view.js`) writes to the four `perps_view_*` tables. Migration 003 is additive.
  - SOL/ETH/BTC recording, candles, the WebSocket path and the gateway are unchanged; their defaults are identical and the original tests pass.
- **24 h change:** when Saturn has a full 24 h of its own valid hourly candles, it uses those. Before that it uses the venue's own previous-day reference price (`prevDayPx`), and only when that reading is under 3 minutes old. The basis is shown in Market details, and nothing is estimated.
- **Not shown for view markets:** volume, open interest and leverage are always `null`.

## 4. Logos

All 11 markets show their real logo, served from Saturn's backend (`GET /v1/perps/logos/<KEY>`).
- The files ship in `assets/logos/*.png` (128×128, round), so no runtime download is needed.
- Every image is verified as a real PNG by magic bytes and capped at 256 KB.
- The app never loads a logo from anywhere else. A foreign URL is ignored and falls back to a plain disc (tested).

**Where the files came from:** this workspace cannot download files, because its network is blocked. The 11 logos were cut, unaltered, from the Jupiter "Select Perps Market" reference screenshot you supplied, at its native resolution of about 60 px per logo, then masked round and saved at 128 px. They are the genuine logos (not redrawn and not AI-generated), but they are lower resolution than official files.

**Before production, swap in official files under the same names** (`assets/logos/<KEY>.png`):

| Market | Official source |
|---|---|
| SOL | solana.com/branding |
| ETH | ethereum.org/assets |
| BTC | bitcoin.design (public domain) |
| HYPE | Hyperliquid brand kit |
| ZEC | z.cash / ZecHub brand assets |
| JUP | Jupiter brand kit |
| SNDK | Sandisk newsroom / brand assets |
| SPCX | SpaceX media resources |
| NEAR | pages.near.org/about/brand |
| SKHYNIX | SK hynix PR / CI resources |
| BNB | bnbchain.org brand guidelines |

**Trademark note:** each logo is used only to identify its market next to its price (nominative use). BNB Chain's brand guidelines say the BNB logo is for projects building on BNB Chain. If you want the strict reading, delete `assets/logos/BNB.png` and BNB will show a plain disc. The SpaceX, Sandisk and SK hynix logos are corporate trademarks shown the same way; none of these companies endorses Saturn.

## 5. App changes (inside the Perps blocks only; everything else is byte-identical)

- **Markets screen:**
  - All, Majors, Stocks, Gainers and Losers, each shown only when the data supports it.
  - The search icon is removed.
  - Rows show logo, symbol, a "20x" or "View only" badge, full name, price and 24 h change.
  - The Hyperliquid/CoinGecko banner is removed from this screen.
- **Categories:**
  - Majors: the 8 crypto markets.
  - Stocks: SNDK, SPCX, SKHYNIX.
  - Gainers and Losers: only markets with a real 24 h change, sorted.
- **Profiles:**
  - Every market opens its own profile, with its own symbol, name, logo, price, change, chart (its own candles only), timeframes and stats.
  - Switching markets clears the previous market's state.
  - A market without a verified price shows "Price unavailable" with no chart.
  - The data source sits as one small line at the foot of the profile, with details under Market details.
- **View-only markets:** there is no order form, and a disabled "Trading not available" button is shown. Core and provider guards refuse to prepare an order or call the gateway for them.

## 6. Tests

| Suite | Kind | Result |
|---|---|---|
| Backend `npm test` | Real PostgreSQL 16; **mocked** Jupiter, Hyperliquid and CoinGecko | 126 / 126 |
| UI flow `perps_flow_test.py` | **All mocked** (data service, RPC, wallet) | see test results |
| UI R121 `r121_view_test.py` (11 markets, real logo images, switching, isolation, 360/390/430 px) | **All mocked** | see test results |
| Real services from this workspace | **Real** | Unreachable (sandbox). Not verified live. |

The prices in the screenshots are mock values. The logos in the screenshots are the real bundled files.

## 7. GitHub replacement instructions

**Backend repo (`Saturn-perps-data`):** copy everything in the changed-files ZIP, keeping its paths.
- **New:**
  - `assets/logos/*.png` (11 files)
  - `migrations/003_view_only_markets.sql`
  - `ops/003_rollback.sql`
  - `scripts/view-markets-live-check.mjs`
  - `src/view.js`, `src/viewsources.js`
  - `tests/view.test.js`, `tests/migration003.test.js`, `tests/tokens.test.js`
  - `docs/R121-MARKETS.md`, `docs/test-output-r121.tap`
- **Replaced:**
  - `src/app.js`, `src/config.js`, `src/engine.js`, `src/gateway.js`, `src/http.js`, `src/jupiter.js`, `src/recorder.js`, `src/store.js`, `src/ws.js`
  - `tests/helpers/harness.js`, `tests/http.test.js`, `tests/static.test.js`
  - `package.json`, `.env.example`
- **Delete if present:** `docs/R120-VIEW-ONLY-MARKETS.md`.

**Frontend:** replace `index.html` with the R121 file.

**Deploy order (when you decide to):**
1. Back up the database.
2. Deploy to staging. Migration 003 applies automatically and is additive.
3. In the Render shell, run `COINGECKO_DEMO_KEY=… npm run view-check`.
4. Set `VIEW_MARKETS=HYPE,ZEC,JUP,SNDK,SPCX,NEAR,SKHYNIX,BNB` and `COINGECKO_DEMO_KEY` (as a secret), then restart.
5. After about 5 minutes, open `/v1/perps/markets`: verified markets show prices and the rest show `status`.
6. Point the staging frontend at it and check the Markets screen.
7. Promote to production.

**Instant rollback:** unset `VIEW_MARKETS`.
