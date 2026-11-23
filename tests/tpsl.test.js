/* r188 Jupiter Perps take profit / stop loss attached to an open: request mapping, transaction checks (fail closed). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { b58encode, b58decode, parseTx } from '../src/solana.js';
import { PERPS_PROGRAM, JLP_POOL, CUSTODY, DISC, TOKEN_PROGRAM, SYSTEM_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET, MINT, positionPda, positionRequestPda, inspectPerpsTx, checkTpsl, mapIncrease } from '../src/perps-program.js';
const rnd = () => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256); return b58encode(b); };
const cu16 = n => n < 128 ? [n] : [(n & 127) | 128, n >> 7];
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return [...b]; };
const W = rnd(), PERP = rnd(), EVT = rnd();
function build({ side = 'long', tpsl = [], tweak = {} } = {}) {
  const custody = CUSTODY.SOL, coll = side === 'long' ? CUSTODY.SOL : CUSTODY.USDC;
  const position = positionPda({ owner: W, custody, collateralCustody: coll, side }, b58decode, b58encode);
  const req = positionRequestPda({ position, counter: 7, change: 'increase' }, b58decode, b58encode);
  const keys = [W]; const idx = k => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
  const inc = [W, rnd(), PERP, JLP_POOL, position, req, rnd(), custody, coll, MINT.USDC, PERPS_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM, EVT, PERPS_PROGRAM].map(idx);
  const ixs = [[idx(COMPUTE_BUDGET), [], [2, 0, 0, 0, 0]], [idx(PERPS_PROGRAM), inc, [...DISC.increase, ...u64(125000000), ...u64(25000000), side === 'long' ? 1 : 2, ...u64(151000000), 0, ...u64(7)]]];
  for (const x of tpsl) {
    const acc = [tweak.owner || W, rnd(), PERP, JLP_POOL, tweak.position || position, rnd(), rnd(), custody, rnd(), rnd(), coll, tweak.mint || MINT.USDC, PERPS_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM, EVT, PERPS_PROGRAM].map(idx);
    const d = [...DISC.tpsl, ...u64(0), ...u64(tweak.size || 0), tweak.reqType ?? 1, 0, 0, 1, ...u64(x.triggerPrice), 1, x.above ? 1 : 0, 1, tweak.entire === false ? 0 : 1, ...u64(8)];
    ixs.push([idx(PERPS_PROGRAM), acc, d]);
  }
  const msg = [1, 0, keys.length - 1, ...cu16(keys.length), ...keys.flatMap(k => [...b58decode(k)]), ...b58decode(rnd()), ...cu16(ixs.length)];
  for (const [p, a, d] of ixs) msg.push(p, ...cu16(a.length), ...a, ...cu16(d.length), ...d);
  return parseTx(Uint8Array.from([1, ...new Array(64).fill(0), ...msg]));
}
const REQ = [{ requestType: 'tp', triggerPrice: '180000000' }, { requestType: 'sl', triggerPrice: '120000000' }];
test('mapIncrease forwards TP/SL to Jupiter in its own field names, paid out in the input token', () => {
  const m = mapIncrease({ asset: 'SOL', inputToken: 'USDC', inputTokenAmount: '1', leverage: '5.0', maxSlippageBps: '100', side: 'long', walletAddress: W, tpsl: REQ });
  assert.deepEqual(m.tpsl, [{ receiveToken: 'USDC', triggerPrice: '180000000', requestType: 'tp' }, { receiveToken: 'USDC', triggerPrice: '120000000', requestType: 'sl' }]);
  assert.equal('tpsl' in mapIncrease({ asset: 'SOL', side: 'long' }), false);
});
test('a long with TP above / SL below, both full trigger closes of the new position: accepted', () => {
  const t = build({ tpsl: [{ triggerPrice: 180000000, above: true }, { triggerPrice: 120000000, above: false }] });
  const ins = inspectPerpsTx(t, { wallet: W, kind: 'increase', tpsl: REQ }); assert.equal(ins.ok, true, ins.why);
  assert.equal(checkTpsl(ins, { side: 'long', tpsl: REQ, mint: MINT.USDC }).ok, true);
});
test('short: TP triggers below, SL above', () => {
  const R = [{ requestType: 'tp', triggerPrice: '120000000' }, { requestType: 'sl', triggerPrice: '180000000' }];
  const ins = inspectPerpsTx(build({ side: 'short', tpsl: [{ triggerPrice: 120000000, above: false }, { triggerPrice: 180000000, above: true }] }), { wallet: W, kind: 'increase', tpsl: R });
  assert.equal(ins.ok, true, ins.why); assert.equal(checkTpsl(ins, { side: 'short', tpsl: R, mint: MINT.USDC }).ok, true);
});
test('refused: wrong price, wrong direction, missing request, extra request, other position, partial close, market type, other owner, other payout token', () => {
  const ok2 = [{ triggerPrice: 180000000, above: true }, { triggerPrice: 120000000, above: false }];
  const chk = (t, R = REQ) => { const ins = inspectPerpsTx(t, { wallet: W, kind: 'increase', tpsl: R }); return ins.ok ? checkTpsl(ins, { side: 'long', tpsl: R, mint: MINT.USDC }) : ins; };
  assert.equal(chk(build({ tpsl: [{ triggerPrice: 181000000, above: true }, ok2[1]] })).ok, false, 'price');
  assert.equal(chk(build({ tpsl: [{ triggerPrice: 180000000, above: false }, ok2[1]] })).ok, false, 'direction');
  assert.equal(chk(build({ tpsl: [ok2[0]] })).ok, false, 'missing');
  assert.equal(chk(build({ tpsl: ok2 }), [REQ[0]]).ok, false, 'extra');
  assert.equal(chk(build({ tpsl: ok2, tweak: { position: rnd() } })).ok, false, 'position');
  assert.equal(chk(build({ tpsl: ok2, tweak: { entire: false } })).ok, false, 'partial');
  assert.equal(chk(build({ tpsl: ok2, tweak: { size: 5 } })).ok, false, 'size');
  assert.equal(chk(build({ tpsl: ok2, tweak: { reqType: 0 } })).ok, false, 'market type');
  assert.equal(chk(build({ tpsl: ok2, tweak: { owner: rnd() } })).ok, false, 'owner');
  assert.equal(chk(build({ tpsl: ok2, tweak: { mint: MINT.SOL } })).ok, false, 'payout');
  assert.equal(inspectPerpsTx(build({ tpsl: ok2 }), { wallet: W, kind: 'increase' }).ok, false, 'TP/SL instructions the user did not ask for');
});
