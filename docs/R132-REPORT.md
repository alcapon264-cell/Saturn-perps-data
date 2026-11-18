# R132 — Market executability & live data repair: audit report

## 1. Diagnosis (traced in the code, not assumed)

### Why 8 markets reported `executable: false`
None of the 8 Hyperliquid / Trade.xyz markets had a broken execution path. The API flag was **defined** to mean "the Jupiter/Solana path exists":

- `src/markets.js` REGISTRY: `executable: !!CUSTODY[k]`, which is only true for SOL/ETH/BTC (Solana custody accounts). The 8 markets were hard-coded `executable: false`.
- `toContract()` then forced `executable` from that registry on every row.
- `src/app.js` (r128) only flipped `viewOnly` to false when the Hyperliquid relay was enabled. Its comment says it on purpose: "executable stays false: that flag means the Jupiter/Solana path".

The real Hyperliquid path (relay `src/hl-exec.js`, the app's Hyperliquid adapter, the Saturn Wallet's EVM key, the 4 switches) has been live since R130. The API just never reported it.

The app itself was not affected. It computes its own `executable` from the Solana custody table and routes the 8 markets to the Hyperliquid adapter by symbol. That is why trading those markets in the app worked while the API said `false`.

### Why `volume24h` / `openInterest` were null
`toContract()` forced `volume24h: null, openInterest: null` for every market. The view recorder also discarded Hyperliquid's `dayNtlVlm` and `openInterest` from the `metaAndAssetCtxs` response it already fetches every 60 s.

### Why `stats24h` was null and history said "collecting (7 h)"
- `stats24h` comes only from **Saturn's own** recorded 1 h candles, and only when all 24 of the last hourly candles are valid. History counts hours since the market's first recorded observation.
- 7 hours means Saturn started recording these markets about 7 hours earlier, most likely when the `VIEW_MARKETS` setting was fixed. It needs 24 continuous hours.
- On the free Render plan the server sleeps when idle. That leaves holes in the hourly candles, so Saturn's own 24 h stats can stay null even after 24 hours. This is correct behaviour: gaps are never filled.

## 2. Fixes (no rebuild; SOL/ETH/BTC paths untouched)

| Change | File |
|---|---|
| Every market row gets a server-computed `execution` object: `{adapter, network, venueAssetId, venueCoin, collateral, marginMode, maxLeverage, ready, blocker}` | `src/app.js`, `src/markets.js` |
| Hyperliquid/Trade.xyz `executable` = `execution.ready`. It is true only when the relay is on (`HL_EXECUTE_VERIFIED` and `HL_EXECUTION_ENABLED=1`), the market is in `HL_VERIFIED_MARKETS`, **and** Hyperliquid mainnet lists it right now (live `perpDexs` + `metaAndAssetCtxs` discovery, cached 60 s). Otherwise the exact blocker is named. | `src/app.js`, `src/markets.js` |
| SOL/ETH/BTC `executable` keeps its R124 rule (custody exists). `execution.ready` additionally reflects the Jupiter gateway switches. | `src/app.js` |
| `maxLeverage` for the 8 markets is taken from Hyperliquid's own metadata | `src/app.js` |
| `volume24h` = Hyperliquid `dayNtlVlm` (24 h notional, USD). `openInterest` = Hyperliquid `openInterest` (coins) × the venue mark price. Both only from a context read under 3 minutes old. | `src/viewsources.js`, `src/view.js`, `src/markets.js` |
| `stats24h` fallback: until Saturn's own 24 h exists, the 24 h open/high/low are taken from **the same venue that prices the market** (Hyperliquid `candleSnapshot`, 1 h). It needs 24 complete hours; a missing hour gives null. Attributed with `basis: 'hyperliquid_candles_1h'`. Saturn's own candles always win once they are ready, and Saturn's recorder is never back-filled. | `src/viewsources.js`, `src/view.js` |

## 3. Market-by-market

Asset ids and leverage are read **live from Hyperliquid at runtime** and published in `execution.venueAssetId` / `execution.maxLeverage`. The workspace that built this release cannot reach Hyperliquid mainnet (proxy 403), so no live id is quoted here. Check them in the deployed `/v1/perps/markets`.

| Market | Venue | Venue asset id | Price source | 24 h stats | History | Adapter | Collateral | Executes | If locked, why |
|---|---|---|---|---|---|---|---|---|---|
| SOL | Solana Perps | custody account (`CUSTODY.SOL`) | Saturn recorder of the Solana Perps market price | Saturn's own 1 h candles | Saturn recorder | `jupiter-perps-solana` | USDC/SOL/ETH/BTC on Solana | yes (unchanged) | — |
| ETH | Solana Perps | `CUSTODY.ETH` | same | same | same | same | same | yes (unchanged) | — |
| BTC | Solana Perps | `CUSTODY.BTC` | same | same | same | same | same | yes (unchanged) | — |
| HYPE | Hyperliquid main | meta index of `HYPE` | Hyperliquid `allMids` (+ CoinGecko / oracle check) | Saturn 1 h, else Hyperliquid 1 h candles; volume `dayNtlVlm`; OI | collecting until 24 h | `hyperliquid-relay` | USDC on Hyperliquid (funded from Saturn Wallet, Arbitrum One) | yes when relay on + listed | `HL_EXECUTION_ENABLED_off` / `not_in_HL_VERIFIED_MARKETS` / `hyperliquid_unreachable` / delisting reason |
| ZEC | Hyperliquid main | meta index of `ZEC` | same | same | same | same | same | same | same |
| JUP | Hyperliquid main | meta index of `JUP` | same | same | same | same | same | same | same |
| NEAR | Hyperliquid main | meta index of `NEAR` | same | same | same | same | same | same | same |
| BNB | Hyperliquid main | meta index of `BNB` | same | same | same | same | same | same | same |
| SNDK | Trade.xyz (HIP-3 dex `xyz`) | 100000 + dexIndex×10000 + index of `xyz:SNDK` | Hyperliquid `allMids` dex xyz (+ oracle check) | same | same | `hyperliquid-relay` | USDC on the Trade.xyz balance (moved from main by the user's own signed `sendAsset`) | same; isolated margin | same |
| SPCX | Trade.xyz | as above, `xyz:SPCX` (or `xyz:SPACEX`) | same | same | same | same | same | same | same |
| SKHYNIX | Trade.xyz | as above, `xyz:SKHYNIX` (or `xyz:SKHX`) | same | same | same | same | same | same | same; also price-quality gate: oracle disagreement makes the price unavailable |

With the current Render settings (`HL_EXECUTION_ENABLED=1`, `HL_VERIFIED_MARKETS` = all 8), all 8 should report `executable: true` once deployed. The exception is any market Hyperliquid does not list at that moment, which reports its exact blocker.

## 4. Tests (all offline mocks unless stated)

- Backend: **185/185** (`npm test`; real PostgreSQL, scripted Hyperliquid/Jupiter).
- New: truthful executability (ready, not verified, delisted, Hyperliquid unreachable). Venue asset ids incl. HIP-3 = 100000 + 2·10000 + index. Volume/OI from the venue. Venue 24 h candles (24 complete hours required; a gap gives null).
- Official signing-vector tests: unchanged this release (no signing code touched).
- **Real mainnet API verification: NOT done from this workspace (no network access to Hyperliquid).** Verify after deploy by opening `/v1/perps/markets`.

## 5. Protected code
No change to `index.html` (frontend), the Saturn Wallet, auth, the You page, the Solana Perps gateway, the recorder/candle engine/WebSocket, or any signing code. The frontend ignores the API's `executable` for routing (it uses its own custody table), so this release cannot change which adapter the app uses.

## 6. Configuration
No new Render variables. Existing: `HL_EXECUTION_ENABLED=1`, `HL_VERIFIED_MARKETS=HYPE,ZEC,JUP,NEAR,BNB,SNDK,SPCX,SKHYNIX`, `VIEW_MARKETS` (unchanged).
