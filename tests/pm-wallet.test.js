import test from 'node:test';
import assert from 'node:assert/strict';
import { createPmWalletVerifier, POLY_WALLET_CONTRACTS } from '../src/pm-wallet.js';

function mockFetch(results, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    const result = typeof results === 'function' ? results(body) : results[body.method + ':' + (body.params?.[0]?.to || body.params?.[0] || '')];
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: result ?? '0x' }) };
  };
}

test('Polygon verifier confirms chain 137 and fixed Polymarket contract bytecode', async () => {
  const fetchImpl = mockFetch(body => {
    if (body.method === 'eth_chainId') return '0x89';
    if (body.method === 'eth_getCode') return '0x60016000';
    if (body.method === 'eth_call' && body.params[0].data === '0x313ce567') return '0x' + (6).toString(16).padStart(64, '0');
    if (body.method === 'eth_call' && body.params[0].data === '0x95d89b41') return '0x' + Buffer.from('pUSD').toString('hex').padEnd(64, '0');
    throw new Error('unexpected_method');
  });
  const result = await createPmWalletVerifier({ fetchImpl }).verify();
  assert.equal(result.ok, true);
  assert.equal(result.chainId, 137);
  assert.equal(result.pUSD.deployed, true);
  assert.equal(result.pUSD.decimals, 6);
  assert.equal(result.pUSD.symbol, 'pUSD');
  assert.equal(Object.keys(result.contracts).length, Object.keys(POLY_WALLET_CONTRACTS).length);
  assert.equal(result.actions.walletCreation, false);
});

test('wrong chain fails closed and does not inspect contracts', async () => {
  const calls = [];
  const result = await createPmWalletVerifier({ fetchImpl: mockFetch(() => '0x1', calls) }).verify();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_chain');
  assert.equal(calls.length, 1);
});

test('RPC errors return an unavailable status without throwing', async () => {
  const result = await createPmWalletVerifier({ fetchImpl: async () => ({ ok: false, status: 503 }) }).verify();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rpc_unavailable');
});

test('RPC endpoint must use HTTPS', () => {
  assert.throws(() => createPmWalletVerifier({ rpcUrl: 'http://127.0.0.1:8545' }), /polygon_rpc_must_be_https/);
});
