# Saturn Perps R126: 24 h change for SOL/ETH/BTC, and the execution findings

Nothing was deployed. Render and the database were not modified.

## PART 2: missing 24 h change for SOL, ETH and BTC (FIXED)

**Cause.** The backend produced SOL/ETH/BTC's 24 h figure only when at least 20 of the last 24 hourly candles were complete. A candle counts as valid only with at least 80 % of its 15-second samples. The staging service is on Render's **free plan, which sleeps when idle**: the logs show restarts at 01:50, 04:28, 08:04, 08:27 and 09:00. Most hours were therefore only partly recorded, so the figure was never produced, and the app showed "—". The eight Hyperliquid markets were unaffected, because their change uses the venue's own previous-day price.

**Fix.** The existing hourly rule is kept, and when it can't apply, the backend uses your formula with two real observations:
- `current` = SOL/ETH/BTC's latest recorded Jupiter price.
- `price 24 h ago` = the **single real observation recorded closest to exactly 24 h before it**, accepted only if it is within 30 minutes of that moment.
- `change = (current − price 24 h ago) / price 24 h ago × 100`, returned as `stats24h` with `basis: "saturn_observation_24h"` and the reference time.
- High/low are returned only when the full hourly history exists; otherwise they are `null` and show "—".
- If there is no observation within 30 minutes of 24 h ago, `stats24h` is `null` and the app shows "—". Nothing is estimated, and no other market's price is ever used.

**No new table or migration** is needed: `perps_observations` already holds the data, and the Jupiter market-stats integration is unchanged.

**Database check:** the hosted Render connection cannot query `saturn-perps-staging-db`. Its IP allowlist only admits your address, so I could not count the stored history directly. With the free plan sleeping, some hours will still have no observation near "24 h ago". In those hours the dash is the honest result.

**Frontend:** the app now accepts a 24 h figure without high/low. Positive values are green and negative red, as before.

**Important, not code:** the database is on Render's free Postgres plan and **expires on 16 December 2026**. Render deletes free databases when they expire, which would remove all recorded history. Upgrading that database before then is the only way to keep the data.

## PART 1: execution for the eight View-only markets (findings; nothing enabled)

| Market | Underlying | Where a real perpetual trades | Network / signing | Collateral | Can Saturn execute it today? |
|---|---|---|---|---|---|
| HYPE | Hyperliquid token | Hyperliquid main perps (`HYPE`); also Jupiter's beta order-book markets on its GUM network | Hyperliquid L1, EIP-712 (EVM-style) signatures | USDC bridged from Arbitrum | **No.** Saturn has no EVM signer. Jupiter's GUM markets have no public execution API, and the beta requires a JUP stake |
| ZEC | Zcash | Hyperliquid main perps (`ZEC`); Jupiter GUM beta | same | same | **No**, same reasons |
| JUP | JUP token | Hyperliquid main perps (`JUP`); Jupiter GUM beta; Drift (being relaunched, see below) | same | same | **No** |
| NEAR | NEAR | Hyperliquid main perps (`NEAR`) | same | same | **No** |
| BNB | BNB | Hyperliquid main perps (`BNB`); Drift (being relaunched) | same | same | **No** |
| SNDK | Sandisk (Nasdaq) | Hyperliquid HIP-3 market `xyz:SNDK`, operated by Trade.xyz | same | USDC on the xyz market set | **No** |
| SPCX | SpaceX (Nasdaq) | Hyperliquid HIP-3 `xyz:SPCX` (Trade.xyz) | same | same | **No** |
| SKHYNIX | SK hynix (KRX) | Hyperliquid HIP-3 `xyz:SKHYNIX` (Trade.xyz) | same | same | **No** |

**Why none can be enabled today:**
- **Signing.** Hyperliquid orders must be signed with EIP-712 typed data by an Ethereum-style key: either the user's EVM wallet, or an "agent" key that wallet has approved. Saturn's wallet layer accepts **Solana wallets only**: `WalletService` rejects any wallet without a `solana:` chain, and the app contains no EIP-712 or `signTypedData` code. A Solana wallet cannot sign these orders, and pretending otherwise would be fake trading.
- **Funding.** Collateral is USDC sent to Hyperliquid's bridge contract on Arbitrum (minimum 5 USDC, credited in about a minute). Withdrawals go back to Arbitrum. A user would need USDC on Arbitrum, which is another network Saturn doesn't handle today.
- **Solana alternatives.**
  - Jupiter's newer markets (HYPE, ZEC, JUP) run on its GUM network in beta, with no public execution API.
  - Drift, a Solana perps venue that listed JUP and BNB, was exploited in April 2026 and is being rebuilt as "Velocity", settling in USDT. That rules it out for now.
- **Availability.** Hyperliquid's own front end is geo-blocked in some jurisdictions, and Trade.xyz's equity markets carry their own restrictions. Who may use these markets has to be decided by you before any execution is offered.

**The technically correct path (needs your decision; it changes Saturn's wallet layer):**
1. An **isolated Hyperliquid execution adapter**, entirely separate from the Jupiter/Solana path, covering:
   - discovery
   - account state (`clearinghouseState`)
   - order build and validation (asset index, size/price rules)
   - EIP-712 signing
   - submit, positions, close, margin and liquidation price
   - status and errors
2. An **EVM wallet connection inside Perps only** (for example injected EVM wallets or WalletConnect). It would never replace or switch the Solana wallet, and it would ask for explicit confirmation before any action on Hyperliquid.
3. A **deposit/withdraw flow** for Arbitrum USDC.
4. **Verification on Hyperliquid testnet** (free test USDC) before anything touches real funds, with the View-only labels removed only for markets that pass.

## Changes in R126

| File | Change |
|---|---|
| `src/store.js` | new read `observationNear(market, target, tolerance)`, same market and same source only |
| `src/app.js` | `stats24h` falls back to two real observations 24 h apart (±30 min), as described above |
| `tests/unified.test.js` | patchy-history 24 h tests (accepted, rejected, never another market's data); full-history behaviour unchanged |
| `tests/view.test.js` | logo expectations updated: all 11 declared official files are served with no network fetch |
| `index.html` (Perps blocks only) | accepts a 24 h figure without high/low |

**Unchanged** (byte-identical to GitHub `b616c11`):
- `src/recorder.js`, `src/engine.js`, `src/gateway.js`, `src/perps-program.js`, `src/jupiter.js`, `src/view.js`, `src/viewsources.js`, `src/ws.js`, `src/http.js`
- all migrations and all logos
- everything outside the Perps blocks of `index.html`

## Tests

| Kind | Result |
|---|---|
| Backend `npm test`: real PostgreSQL, scripted providers | 150 / 150 |
| **Real backend + real PostgreSQL + real frontend in Chromium**, patchy history like the free plan (scripted providers, RPC, wallet) | 16 / 16 at 360/390/430. SOL +3.09 %, ETH −2.44 % (red), BTC +2.04 %; ETH profile shows the change, high/low "—"; all 11 listed |
| Mocked frontend suites | 187 / 187, 108 / 108, 42 / 42 |
| Live: Render database contents | **Not verified** (database allowlist) |
| Live execution on any venue | **Not attempted.** Nothing is enabled. |

## GitHub replacement (Saturn-perps-data, main)

**Replace:**
- `src/app.js`
- `src/store.js`
- `tests/unified.test.js`
- `tests/view.test.js`

**Add:** `docs/R126-REPORT.md`

**Frontend:** replace `index.html` in the github.io repository.

**Render:** no settings to change. After uploading, redeploy (auto-deploy is off), or reply "deploy" and I'll start it.
