# R118 — Jupiter Perps REST request mapping correction

## Scope

This patch corrects only the request-field mapping sent from Saturn's gateway to Jupiter's documented Perps REST endpoints. It does not enable execution, alter transaction signing, change wallet handling, or change Render configuration.

## Files changed

- `src/perps-program.js`
  - `mapIncrease()` now forwards the documented increase request fields: `asset`, `inputToken`, `inputTokenAmount`, `leverage`, `maxSlippageBps`, `side`, and `walletAddress`.
  - `mapDecrease()` now forwards `positionPubkey`, `receiveToken`, and only the selected close/withdrawal fields.
  - Removed guessed REST aliases `marketMint`, `inputMint`, `collateralMint`, `collateralTokenDelta`, and `desiredMint` from the REST request mapping.
  - Updated contract blockers: the REST request schema is no longer listed as unknown, but the on-chain Borsh layout, PDA seeds, and live transaction/keeper response semantics remain unverified.
- `src/gateway.js`
  - Calls the corrected increase mapper without an unverified `transactionType` argument.
- `src/config.js`
  - Removed the unused `GATEWAY_JUP_TRANSACTION_TYPE` setting.
- `tests/gateway.test.js`
  - Updated mocked request-body expectations to the documented REST field names.

## Safety status

`EXECUTE_CONTRACT_VERIFIED` remains `false`. The backend still refuses all transaction preparation/execution routes in a normal deployment, even if `PERPS_EXECUTION_ENABLED=1` is set. Do not enable execution or deploy this as a live trading release based on this mapping correction alone.

## Verification performed

- `node --check` passed for the changed JavaScript files.
- Direct assertions passed for increase/decrease request mapping and the execution lock.
- `node --test tests/static.test.js tests/unit.test.js`: 28/28 passed.
- Full `npm test` could not complete in this environment: PostgreSQL is unavailable and the `ws` dependency is not installed. An attempted dependency install timed out. The gateway integration tests therefore remain unverified in this environment.
- No live Jupiter transaction was requested, signed, submitted, or executed. No Render service or environment variable was changed.
