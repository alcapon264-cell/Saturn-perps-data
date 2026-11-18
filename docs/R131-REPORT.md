# R131 — Global Saturn Perps fee (0.06%)

One policy, one rate: **0.06% (6 bps) of filled notional, per filled side**, on every Perps market, chain and venue.

| Where | Single source of truth |
|---|---|
| Backend | `src/fee-policy.js` (`SATURN_PERPS_FEE`, `feeFor`, `feeForMarket`, `feeOnExecuted`, `hlBuilder`) |
| App | `<script id="saturn-fee-policy">` → `window.SaturnPerpsFee` (same constants; checked against the backend by the test suite) |

Adapters never define a Saturn rate. A venue not registered (any future integration) still resolves to 0.06% and reports "cannot collect yet".

## Collection per venue
| Venue | Markets | Mechanism | Status |
|---|---|---|---|
| Hyperliquid | HYPE, ZEC, JUP, NEAR, BNB | Hyperliquid builder code `{b: fee wallet, f: 60}` on every order (opens, closes, TP/SL group) | Collected once `SATURN_PERPS_FEE_WALLET_EVM` is set and that wallet holds ≥ 100 USDC on Hyperliquid |
| Trade.xyz (HIP-3) | SNDK, SPCX, SKHYNIX | same builder code | same |
| Solana Perps | SOL, ETH, BTC | **none** | **Not collected — limitation.** The Solana Perps program has no integrator-fee mechanism, and orders are filled later by a keeper, so a fee taken at signing could be charged on an order that never fills. The app shows "Saturn fee (0.06%) · Not charged" with this reason. |

Hyperliquid charges builder fees on each fill, so partial fills pay proportionally and unfilled/cancelled orders pay nothing.
Each user approves the fee once (`approveBuilderFee`, maxFeeRate exactly "0.06%", Saturn's fee wallet only), signed by their Saturn Wallet inside Confirm and sign.

## Relay enforcement (`src/hl-exec.js`)
- Fee collectable → every order must carry exactly `{b: fee wallet, f: 60}`; missing → `saturn_fee_required`, different → `saturn_fee_mismatch`.
- `approveBuilderFee` accepted only for Saturn's fee wallet at exactly "0.06%".
- No fee wallet → no builder field accepted at all (no fee to anyone).
- Fee wallet below 100 USDC → opening orders refused (`fee_wallet_unfunded`), reduce-only closes still allowed.
- Audit: `perps_hl_requests.saturn_fee_tenths_bp` (migration 006, additive; rollback in docs/rollback).

## Tests
- `tests/fee-policy.test.js` — the acceptance suite: every market/venue (backend and app) = 0.06%, future venues inherit, filled-only maths, no adapter defines its own rate.
- `tests/hl-exec.test.js` — relay enforcement (3 new tests).
- App browser suite `r131_test.py` (mocked exchange): 24/24.
