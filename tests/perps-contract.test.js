import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapIncrease, mapDecrease, SIDE_BYTE, ARG_LAYOUT, readArgs,
  EXECUTE_CONTRACT_VERIFIED, CONTRACT_BLOCKERS
} from '../src/perps-program.js';

const u64 = n => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return [...b];
};

test('Jupiter REST increase mapping forwards documented fields only', () => {
  const body = {
    asset: 'SOL', side: 'long', inputToken: 'USDC',
    inputTokenAmount: '25000000', leverage: '5.0',
    maxSlippageBps: '100', walletAddress: 'wallet'
  };
  assert.deepEqual(mapIncrease(body), body);
});

test('Jupiter REST decrease mapping forwards only selected close fields', () => {
  assert.deepEqual(mapDecrease({
    positionPubkey: 'position', receiveToken: 'USDC',
    entirePosition: true, maxSlippageBps: '100'
  }), {
    positionPubkey: 'position', receiveToken: 'USDC',
    entirePosition: true, maxSlippageBps: '100'
  });
  assert.deepEqual(mapDecrease({
    positionPubkey: 'position', receiveToken: 'SOL',
    sizeUsdDelta: '500000000'
  }), {
    positionPubkey: 'position', receiveToken: 'SOL',
    sizeUsdDelta: '500000000'
  });
});

test('Jupiter Side enum encoding and Borsh field order match the published IDL', () => {
  assert.deepEqual(SIDE_BYTE, { long: 1, short: 2 });
  assert.deepEqual(ARG_LAYOUT.increase.map(x => x[0]), [
    'sizeUsdDelta', 'collateralTokenDelta', 'side',
    'priceSlippage', 'jupiterMinimumOut', 'counter'
  ]);
  assert.deepEqual(ARG_LAYOUT.decrease.map(x => x[0]), [
    'collateralUsdDelta', 'sizeUsdDelta', 'priceSlippage',
    'jupiterMinimumOut', 'entirePosition', 'counter'
  ]);

  const increase = Uint8Array.from([
    ...new Array(8).fill(0), ...u64(125), ...u64(25), 1,
    ...u64(100), 0, ...u64(7)
  ]);
  assert.deepEqual(readArgs(increase, 'increase'), {
    sizeUsdDelta: 125n, collateralTokenDelta: 25n, side: 'long',
    priceSlippage: 100n, jupiterMinimumOut: null, counter: 7n
  });

  const decrease = Uint8Array.from([
    ...new Array(8).fill(0), ...u64(0), ...u64(500),
    ...u64(100), 0, 1, 1, ...u64(8)
  ]);
  assert.deepEqual(readArgs(decrease, 'decrease'), {
    collateralUsdDelta: 0n, sizeUsdDelta: 500n,
    priceSlippage: 100n, jupiterMinimumOut: null,
    entirePosition: true, counter: 8n
  });
});

test('r130: owner approved the code switch; the open blockers stay documented', () => {
  assert.equal(EXECUTE_CONTRACT_VERIFIED, true);
  assert.ok(CONTRACT_BLOCKERS.length >= 2);
});
