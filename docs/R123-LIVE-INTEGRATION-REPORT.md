# Saturn Perps R123: why the live site still shows 3 markets

**Nothing was deployed or overwritten.** The live site could not be verified from this workspace: Render, the staging API and the github.io site are all blocked by this workspace's network allowlist, and the frontend repository is private. Every finding below is labelled with its evidence.

## 1. Deployed state

| Question | Answer | Evidence |
|---|---|---|
| Frontend deployed | **R122** (the fix is live) | Your 01:25 screenshot shows SOL/ETH/BTC labelled "Perpetual" (not "View only"), the Majors chip, and the SOL logo coming from Saturn's token data. Only R122 behaves like that. |
| Frontend API URL | `https://saturn-perps-staging.onrender.com` | In the R122 `index.html` (Perps provider `API` constant). Hostnames are in the code, but no secrets. |
| Backend repo HEAD (GitHub) | `0235ff3` (alcapon264-cell/saturn-perps-data, main) | Cloned |
| Backend actually running on Render | **Older than 17 Nov 19:12** | Staging sends no `executable`, `icon` or `category` (no 20x badge, no backend logos, only 3 markets). `executable` was added in commit 7d428a6 on 17 Nov at 19:12, so any build from that commit onward would return it. |
| Render repo / branch / auto-deploy | **Not visible here** | Needs the Render connector, or the dashboard |
| `VIEW_MARKETS` / `COINGECKO_DEMO_KEY` set? | **Unknown.** Irrelevant until the new code runs, because old code ignores them. | — |
| Migration 003 applied? | **Unknown.** It is applied automatically at start-up by the new code. | — |
| Browser cache | **Not the cause** | The new frontend code is visibly running |

## 2. The real cause

The live site is the new frontend talking to an **old backend**. The backend code on GitHub is fine: 139/139 tests pass with the R123 files. Render simply isn't running it. The likely reasons, in order:

1. **Render auto-deploy waits for CI ("After CI checks pass"), and CI has been failing.** The repo's GitHub Actions workflow `test.yml` runs `npm test` on every push. GitHub HEAD currently fails 7 tests: my R121 upload overwrote the 17 Nov recorder and engine fixes, and R122/R123 repair that. A red CI blocks every deploy with this setting. I can't see the CI history to confirm.
2. **Auto-deploy is off,** or the service is linked to another repo, branch or fork.
3. **Deploys are failing at build or start.** Render then keeps the last good version. This shows as "Deploy failed" under Events.

R123 makes CI green. The new `build.commit` field in `/v1/perps/markets` proves which commit is running.

## 3. What R123 changes (backend only; frontend unchanged from R122)

| File | Change |
|---|---|
| src/recorder.js, src/engine.js | The 17 Nov upstream fixes are restored, plus the view-pipeline options (same as R122) |
| src/config.js, src/http.js, src/app.js | `build` object in the markets response (commit; whether VIEW_MARKETS and the CoinGecko key are configured, true/false only) (same as R122) |
| src/view.js | **New logo policy:** a shipped logo is served only if it's declared in `assets/official-logos/SOURCES.json` with its official source URL and a matching sha256. Screenshot cut-outs are never served. Crypto logos come from the verified CoinGecko image at run time. |
| assets/official-logos/README.md, SOURCES.json | New: where to put official files, and how |
| assets/logos/ | **Delete from GitHub.** These were the R121 cut-outs; the code no longer reads them |
| tests/view.test.js | Updated and new tests (logo policy, contract, deploy audit) |

**Logos after deploy:**
- SOL, ETH and BTC, plus the five crypto view markets, get the official images distributed by CoinGecko for the verified coin IDs. This needs `COINGECKO_DEMO_KEY`. SOL/ETH/BTC can also fall back to the Jupiter token icon.
- **SNDK, SPCX and SKHYNIX show a plain disc** until you add official PNGs. CoinGecko doesn't cover stocks, and this workspace can't download files. Get them from:
  - Sandisk's brand/press page
  - SpaceX media resources
  - SK hynix's PR/CI page

  Save each as `assets/official-logos/<KEY>.png` and add an entry to `SOURCES.json`. The README explains how.

## 4. Tests (separated)

| Kind | Result |
|---|---|
| Local unit tests + local PostgreSQL 16 (`npm test`, mocked Jupiter/Hyperliquid/CoinGecko) | **139 / 139** |
| Mocked frontend tests (R122 frontend, unchanged) | 187/187, 108/108, 42/42 (from R122; the R121/R122 mocks served the old cut-out logos) |
| Actual deployed staging API | **Not run.** Unreachable from here. |
| Actual deployed frontend | **Not run.** Unreachable from here. The only evidence is your screenshot. |
| Live external providers (Hyperliquid, CoinGecko) | **Not run.** Unreachable from here. |

## 5. Render: required changes (staging only)

1. Settings, Build & Deploy:
   - **Repository** `alcapon264-cell/saturn-perps-data`, branch `main`.
   - **Build command** `npm install`. The repo has no `package-lock.json`, so `npm ci` would fail.
   - **Start command** `node server.js` (or `npm start`).
   - **Auto-Deploy** "On Commit". Or keep "After CI checks pass", but only once CI is green.
   - **Node** 22+.
2. Environment:
   - `VIEW_MARKETS=HYPE,ZEC,JUP,SNDK,SPCX,NEAR,SKHYNIX,BNB`
   - `COINGECKO_DEMO_KEY` = your key (secret)
   - `ALLOWED_ORIGINS` must include `https://alcapon264-cell.github.io`
   - Keep `PERPS_EXECUTION_ENABLED` and `GATEWAY_TICKET_SECRET` **unset**.
3. Events: if there are "Deploy failed" entries, open one. Its log names the cause.

## 6. GitHub replacement (saturn-perps-data, branch main)

**Replace:**
- src/recorder.js
- src/engine.js
- src/config.js
- src/http.js
- src/app.js
- src/view.js
- tests/view.test.js

**Add:**
- assets/official-logos/README.md
- assets/official-logos/SOURCES.json
- docs/R123-LIVE-INTEGRATION-REPORT.md
- docs/test-output-r123.tap

**Delete:** the folder assets/logos/.

**Frontend:** no change. R122 `index.html` is already live.

## 7. Deployment checklist

| Step | Owner | Status |
|---|---|---|
| Upload the R123 backend files to GitHub | you | waiting for your approval |
| GitHub Actions "Saturn Perps Data tests" turns green | GitHub | expected (139/139 locally) |
| Render settings as in section 5 | you | waiting for your approval |
| Manual Deploy, then "Deploy latest commit" on staging | you | waiting for your approval |
| `/v1/perps/markets` shows `build.commit` = the new GitHub HEAD, 11 markets, SOL/ETH/BTC `executable: true` | you or me (see section 8) | not done |
| `npm run view-check` in the Render shell (with the key) | you | not done |
| Reload `alcapon264-cell.github.io`; check the 11 markets at 360/390/430 | you | not done |
| Official stock logo files added | you | not done (stocks show a plain disc until then) |
| Enable trading | — | **not approved; stays off** |

## 8. How I can verify the live site

Either works:
- **Connect the Render connector** in claude.ai. I can then read the service settings, deploys, failure logs and environment variable *names* myself.
- **Paste these two URLs in a message:** `https://saturn-perps-staging.onrender.com/v1/perps/markets` and `https://alcapon264-cell.github.io`. My web-fetch tool only opens URLs that appear in your own messages. Or paste the JSON that the first URL returns.
