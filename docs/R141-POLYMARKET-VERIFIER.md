# Saturn R141 — Polymarket Polygon verification backend

## Scope
This is a targeted backend addition on top of the supplied `Saturn-perps-data-main` repository and the R140 `index.html`.

Added:
- `src/pm-wallet.js`: fixed-method, read-only Polygon JSON-RPC verifier.
- `GET /v1/pm/wallet/status`: rate-limited, no-store status endpoint.
- Optional backend-only `POLYGON_RPC_URL` setting (HTTPS required); defaults to `https://polygon-rpc.com`.
- `tests/pm-wallet.test.js`: mocked unit tests.

The verifier checks:
- Polygon `eth_chainId` equals 137.
- Bytecode exists at the R140 fixed pUSD, Deposit Wallet factory, and spender addresses.
- pUSD `decimals()` and `symbol()` are readable.
- It reports wallet creation, approvals, signing and order placement as disabled.

## Important limits
- No live Polygon request was made in this environment. All four new tests use mocked JSON-RPC.
- Bytecode existence does not prove a contract's source/ABI identity or confirm the user's Deposit Wallet ownership.
- The endpoint does not derive or deploy a Deposit Wallet.
- No Polymarket Relayer request, Builder API credential handling, ClobAuth signing, approvals, bridge, transfer, or order code was added.
- No new wallet is created. Existing Privy EVM wallet code is untouched.
- The existing R140 frontend remains included unchanged; it is not yet wired to display the new backend status endpoint.

## Test results
- New verifier tests: 4/4 passed.
- `npm test` attempted: incomplete in this environment because dependencies were not installed; Node reported missing package `ws` in existing `tests/view.test.js` and `tests/ws.test.js`. This is an environment/dependency issue, not a passing full-suite result.
- Syntax checks: run on changed JavaScript files.

## Deployment
Not deployed. Do not deploy until the owner reviews the diff and confirms the Polygon RPC setting. Prediction remains read-only.
