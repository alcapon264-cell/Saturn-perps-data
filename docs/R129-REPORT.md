# R129: one Saturn Wallet, one balance, one Trade and one Review design for every venue

## Result
- **One wallet.** Perps uses the Saturn Wallet only (Privy embedded). SOL/ETH/BTC use its Solana key; the 8 Hyperliquid/Trade.xyz markets use its Ethereum key (`SaturnEVM.Wallet`, the same Saturn account, created in You). R128's MetaMask/Rabby connection is gone.
- **One balance per market.** The form shows a single "Available X USDC", computed and reconciled by the backend. Nothing is counted twice; pending, reserved and committed funds are excluded.
- **No user-managed Perps deposits and no withdrawal in Perps.** When a Hyperliquid order needs collateral at the venue, the move is a line in the Review and runs inside "Confirm and sign". There is no Deposit, Withdraw or Receive screen in Perps.
- **One Trade component and one Review component** for all 11 markets, following your two screenshots. Only data and the adapter differ.
- **Real money stays OFF** (Jupiter `EXEC_ENABLED=false`; Hyperliquid `HL_EXEC_ENABLED=false` + `HL_EXECUTE_VERIFIED=false` + env). The Review shows the real figures; "Confirm and sign" is disabled with the genuine reason.

## Wallet and collateral architecture
| Venue | Markets | Signs with | Collateral the venue needs | How Saturn funds it (inside Confirm and sign) |
|---|---|---|---|---|
| Jupiter Perps (Solana) | SOL, ETH, BTC | Saturn Wallet, Solana key | Collateral moves from the wallet in the open-position transaction itself | Nothing extra: the wallet balance *is* the collateral source (unchanged) |
| Hyperliquid | HYPE, ZEC, JUP, NEAR, BNB | Saturn Wallet, Ethereum key, plus a trade-only key it approves | USDC credited on Hyperliquid (native USDC on Arbitrum One sent to Bridge2; min 5 USDC; about 1 minute) | If short: a transfer of USDC from the Saturn Wallet on Arbitrum One to Bridge2. The Review shows amount, network and fee |
| Trade.xyz (HIP-3 on Hyperliquid) | SNDK, SPCX, SKHYNIX | same | USDC in the xyz balance (separate unless the account is "unified") | If short: move from the Hyperliquid main balance to Trade.xyz (`sendAsset` to the user's own address, no fee), then a Bridge2 transfer if still short |

**Unified available balance** (`GET /v1/perps/hl/balance`, backend):

`available = venue collateral usable now + Hyperliquid balance movable to this venue + Saturn Wallet USDC on Arbitrum (counted only if ≥ 5 and there is ETH for gas)`

- Margin committed to positions and open-order holds are already excluded by Hyperliquid's `withdrawable`.
- Pending transfers count in neither place: the wallet has already sent them and the venue has not yet credited them.
- A transfer is recorded only after the backend reads the Arbitrum receipt and checks it was a USDC transfer from this wallet to Bridge2 for this amount (migration 005).
- A transfer is marked **credited** only when Hyperliquid's own ledger shows the deposit. Each ledger entry can settle one transfer only.
- While a transfer is pending, a new order that would need funding is refused, so the same funds are never moved twice.
- Closing a position releases collateral back to the venue balance, so the one available number goes up. The mocked test shows 10.01 → 34.89.

**Unsupported funds are explained.** Example: "Add USDC on Arbitrum One to your Saturn Wallet in You first…", plus the gas and below-minimum reasons. Solana USDC is never shown as usable for Hyperliquid markets, and vice versa.

**One gap you should decide on.** Hyperliquid-held USDC (for example after a close) stays in your available Perps balance. Returning it to the Saturn Wallet is a Hyperliquid withdrawal, which belongs in **You**. The You page is outside what I may change (protected code), so I have not added it. With your OK I can add "Hyperliquid balance → Saturn Wallet" to You's existing withdrawal flow. The backend already supports `withdraw3` to the user's own address only.

## Provider adapters (one interface, three venues)
The core picks the adapter from the market on screen (`venueOf(m)`). Both adapters implement the same interface:

| Function | What it provides |
|---|---|
| `funds` | one available balance |
| `estimate` | size, liquidation and fee using the venue's own rules |
| `executionStatus` | whether execution is allowed, and why not |
| `prepareOrder` | the reviewed transaction data |
| `placeOrder` | signing and submission |
| `prepareClose` | close quote |
| `account` | exchange/chain-confirmed positions |
| `capabilities.tpsl` | whether TP/SL can be placed |

- **Jupiter adapter:** the existing provider, unchanged.
- **Hyperliquid / Trade.xyz adapter:** block `saturn-r129-hl`, no UI of its own.
  - Trade.xyz uses its own asset ids (`100000 + dexIndex×10000 + index`, e.g. SNDK 120001) and is never routed through crypto ids.
  - Liquidation uses Hyperliquid's published formula (maintenance leverage = 2 × max leverage).
  - TP/SL is sent as one `normalTpsl` group. On Jupiter the TP/SL inputs are present but disabled, with a note.
- **No invented limits:** if Hyperliquid's own metadata can't be read, the market shows **View only** with the reason, never "up to 20x".

## Security (kept from R128, plus)
- Every Hyperliquid write goes through the relay: signature recovered, mainnet only, action allowlist, fresh nonce, durable replay protection, one client order id per order, size, leverage, slippage and price-band caps, rate limits, and audit without secrets.
- **New in R129:**
  - TP/SL groups must be reduce-only, on the opposite side, the same size, and on the correct side of the price.
  - L1 actions may be signed by the user's own Saturn Wallet or by an approved, expiring, trade-only agent.
  - Arbitrum RPC use is read-only (`eth_call`, `eth_getBalance`, `eth_getTransactionReceipt`); the relay can never send a transaction.
- The trade-only key can never withdraw. It lives in this tab only and expires in 30 days or less.
- No private keys stored; no secrets exposed.

## Tests (mock and live kept separate)
| Category | Result |
|---|---|
| Official Hyperliquid signing vectors on the exact bundle in `index.html` (real crypto, offline) | 22/22 |
| Backend, real PostgreSQL + mocked Hyperliquid/Arbitrum (incl. 8 new R129 tests: TP/SL, self-signing, balance accounting, ledger reconciliation, funding verification) | 170/170 |
| Browser R129, real page + real relay code, mocked Hyperliquid/Arbitrum/Saturn Wallet EVM side, 360/390/430 + activated test build | 66/66 |
| Jupiter flow regression (copy updated to the new Review design: no checkbox, "Confirm and sign" is the explicit approval) | 187/187 |
| View-only / legacy regressions | 108/108 · 42/42 |
| Live Hyperliquid, Arbitrum, real Saturn Wallet signing, real money | **None.** Needs your approval |

The browser tests verify:
- **One wallet:** Saturn Wallet used for both venues.
- **One balance:** one available number, nothing double counted, pending excluded, closing releases collateral.
- **Funding:** funding happens only inside Confirm and sign, and a double tap still sends one transfer and one order.
- **One design:** the SOL, HYPE and SNDK forms are element-for-element identical, and so are their review sheets.
- **No withdrawal anywhere in Perps.**
- **Signing:** the correct signing path is used per venue.
- **Jupiter:** still routed to Jupiter.

## Deploy
Upload, then redeploy on Render. Migrations 004 and 005 run automatically on start; both only add new tables. Rollback scripts are in `docs/rollback/`. No env change. Optional: `ARB_RPC_URL` (defaults to the public Arbitrum RPC).

Activation later needs, with your approval:
- the Render paid plan, since the free database expires 2026-12-16;
- the four locks;
- one small live HYPE test.
