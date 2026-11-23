/* Jupiter Perpetuals on-chain constants used to VALIDATE transactions. Nothing here builds or signs anything.
 *
 * VERIFIED (Jupiter developer docs, developers.jup.ag/docs/perps/*, checked 2026-11-16):
 *   - program id: the Pool Account page links the program IDL on Solscan at PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu (also listed by Helius' program catalog)
 *   - JLP pool 5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq (Pool Account page)
 *   - custody accounts SOL/ETH/BTC/USDC/USDT (Custody Account page)
 *   - account roles and Borsh argument layouts of create_increase_position_market_request / create_decrease_position_market_request
 *     (published Jupiter Perps Anchor IDL)
 *   - Side enum order None=0, Long=1, Short=2; Position and PositionRequest PDA seed ordering/width
 *     (published Jupiter Perps PDA examples)
 * COMPUTED (Anchor rule): instruction discriminators = sha256("global:<snake_case_name>")[0..8].
 * NOT VERIFIED: live Jupiter-built transaction response semantics, keeper-signature requirements, and real API-built transaction fixtures.
 * Execution therefore remains DISABLED. The gateway performs structural and request-bound transaction checks only. */
import { createHash } from 'node:crypto';

export const PERPS_PROGRAM = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
export const JLP_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
export const CUSTODY = Object.freeze({
  SOL: '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz',
  ETH: 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn',
  BTC: '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm',
  USDC: 'G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa',
  USDT: '4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk'
});
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const ALLOWED_PROGRAMS = new Set([PERPS_PROGRAM, SYSTEM_PROGRAM, COMPUTE_BUDGET, TOKEN_PROGRAM, TOKEN_2022, ATA_PROGRAM]);

const disc = name => createHash('sha256').update('global:' + name).digest().subarray(0, 8);
export const DISC = Object.freeze({
  increase: disc('create_increase_position_market_request'),
  decrease: disc('create_decrease_position_market_request'),
  /* r188 take profit / stop loss: a Trigger-type decrease request on the same position (published IDL: createDecreasePositionRequest2) */
  tpsl: disc('create_decrease_position_request2')
});
export const ACTIONS = Object.freeze({ 'increase-position': 'increase', 'decrease-position': 'decrease' });
/* account index of each role inside the instruction (Helius parsed IDL) */
export const IX_ACCOUNTS = Object.freeze({
  increase: ['owner', 'fundingAccount', 'perpetuals', 'pool', 'position', 'positionRequest', 'positionRequestAta', 'custody', 'collateralCustody', 'inputMint', 'referral', 'tokenProgram', 'associatedTokenProgram', 'systemProgram', 'eventAuthority', 'program'],
  decrease: ['owner', 'receivingAccount', 'perpetuals', 'pool', 'position', 'positionRequest', 'positionRequestAta', 'custody', 'collateralCustody', 'desiredMint', 'referral', 'tokenProgram', 'associatedTokenProgram', 'systemProgram', 'eventAuthority', 'program'],
  tpsl: ['owner', 'receivingAccount', 'perpetuals', 'pool', 'position', 'positionRequest', 'positionRequestAta', 'custody', 'custodyDovesPriceAccount', 'custodyPythnetPriceAccount', 'collateralCustody', 'desiredMint', 'referral', 'tokenProgram', 'associatedTokenProgram', 'systemProgram', 'eventAuthority', 'program']
});
const sameBytes = (a, b) => a.length >= b.length && b.every((x, i) => a[i] === x);

/* Structural check of an UNSIGNED or SIGNED transaction. Resolves only static account keys: any Perps account that sits in an
 * address lookup table cannot be checked here and the transaction is refused (fail closed).
 * -> {ok:true, kind, position} | {ok:false, why} */
export function inspectPerpsTx(t, { wallet, kind, tpsl = null }) {
  const why = w => ({ ok: false, why: w });
  if (t.keys[0] !== wallet) return why('fee_payer_not_wallet');
  if (t.req !== 1 || t.nsig !== 1) return why('unexpected_signers');
  const perps = [];
  for (const ix of t.ixs) {
    if (!ALLOWED_PROGRAMS.has(ix.prog)) return why('program_not_allowed');
    if (ix.prog === PERPS_PROGRAM) perps.push(ix);
  }
  const nT = kind === 'increase' && Array.isArray(tpsl) ? tpsl.length : 0;
  if (perps.length !== 1 + nT) return why(perps.length > 1 + nT ? 'multiple_perps_instructions' : perps.length ? 'tpsl_missing' : 'no_perps_instruction');
  const mains = perps.filter(x => sameBytes(x.data, DISC[kind])); if (mains.length !== 1) return why('unexpected_perps_instruction');
  const ix = mains[0], extras = perps.filter(x => x !== ix);
  if (extras.some(x => !sameBytes(x.data, DISC.tpsl))) return why('unexpected_perps_instruction');
  const roles = IX_ACCOUNTS[kind];
  if (ix.acc.length !== roles.length) return why('unexpected_account_count');
  const A = ix.acc.map(i => t.keys[i]);
  if (A.some(a => a === undefined)) return why('accounts_in_lookup_table');
  const at = r => A[roles.indexOf(r)];
  if (at('owner') !== wallet) return why('owner_not_wallet');
  if (at('pool') !== JLP_POOL) return why('pool_mismatch');
  if (![CUSTODY.SOL, CUSTODY.ETH, CUSTODY.BTC].includes(at('custody'))) return why('custody_not_allowed');
  if (!Object.values(CUSTODY).includes(at('collateralCustody'))) return why('collateral_custody_not_allowed');
  if (at('program') !== PERPS_PROGRAM) return why('program_account_mismatch');
  if (at('tokenProgram') !== TOKEN_PROGRAM || at('systemProgram') !== SYSTEM_PROGRAM || at('associatedTokenProgram') !== ATA_PROGRAM) return why('program_accounts_mismatch');
  /* r188: each take profit / stop loss request must be a Trigger request that closes the WHOLE position this transaction opens, owned by this
   * wallet, at exactly the price and direction the user asked for. Anything else -> refused. */
  const got = [];
  for (const x of extras) {
    const R = IX_ACCOUNTS.tpsl; if (x.acc.length !== R.length) return why('tpsl_account_count');
    const B = x.acc.map(i => t.keys[i]); if (B.some(a => a === undefined)) return why('accounts_in_lookup_table');
    const bt = r => B[R.indexOf(r)];
    if (bt('owner') !== wallet || bt('pool') !== JLP_POOL || bt('position') !== at('position') || bt('custody') !== at('custody') || bt('collateralCustody') !== at('collateralCustody')) return why('tpsl_wrong_position');
    if (bt('program') !== PERPS_PROGRAM || bt('tokenProgram') !== TOKEN_PROGRAM || bt('systemProgram') !== SYSTEM_PROGRAM || bt('associatedTokenProgram') !== ATA_PROGRAM) return why('program_accounts_mismatch');
    if (bt('perpetuals') !== at('perpetuals') || bt('eventAuthority') !== at('eventAuthority') || bt('referral') !== at('referral')) return why('tpsl_accounts_mismatch');
    let g; try { g = readArgs(x.data, 'tpsl'); } catch { return why('tpsl_args_unreadable'); }
    if (g.requestType !== 1 || g.entirePosition !== true || g.triggerPrice == null || g.triggerAboveThreshold == null || g.sizeUsdDelta !== 0n || g.collateralUsdDelta !== 0n) return why('tpsl_not_a_full_trigger_close');
    got.push({ triggerPrice: g.triggerPrice, above: g.triggerAboveThreshold, desiredMint: bt('desiredMint'), receivingAccount: bt('receivingAccount') });
  }
  return { ok: true, kind, position: at('position'), accounts: Object.fromEntries(roles.map(r => [r, at(r)])), data: ix.data, tpsl: got };
}
/* r188: the TP/SL requests found in the transaction must be exactly the ones asked for.
 * long: take profit triggers ABOVE its price, stop loss BELOW; short: the reverse. Paid out in the token the position was opened with. */
export function checkTpsl(ins, { side, tpsl, mint }) {
  const want = (tpsl || []).map(x => ({ type: x.requestType, price: BigInt(x.triggerPrice), above: (x.requestType === 'tp') === (side === 'long') }));
  const got = (ins.tpsl || []).slice(); if (got.length !== want.length) return { ok: false, why: 'tpsl_count' };
  for (const w of want) { const i = got.findIndex(g => g.triggerPrice === w.price && g.above === w.above); if (i < 0) return { ok: false, why: 'tpsl_' + w.type + '_mismatch' }; if (got[i].desiredMint !== mint) return { ok: false, why: 'tpsl_payout_token' }; got.splice(i, 1); }
  return { ok: true };
}

/* r117: full check of the Jupiter-built transaction against the exact Saturn request (in addition to inspectPerpsTx).
 * expect: {side, inputMint|desiredMint, collateralTokenDelta | entirePosition | sizeUsdDelta | collateralUsdDelta, position?} */
export function checkAgainstRequest(ins, { kind, wallet, expect }, b58decode, b58encode) {
  const why = w => ({ ok: false, why: w });
  const A = ins.accounts; let g;
  try { g = readArgs(ins.data, kind); } catch (e) { return why('args_unreadable'); }
  const market = Object.keys(CUSTODY).find(k => CUSTODY[k] === A.custody);
  if (expect.market && market !== expect.market) return why('wrong_market');
  if (kind === 'increase') {
    if (A.inputMint !== expect.inputMint) return why('wrong_input_mint');
    if (g.side !== expect.side) return why('wrong_side');
    if (expect.side === 'long' ? A.collateralCustody !== A.custody : ![CUSTODY.USDC, CUSTODY.USDT].includes(A.collateralCustody)) return why('wrong_collateral_custody');
    if (String(g.collateralTokenDelta) !== String(expect.collateralTokenDelta)) return why('wrong_collateral_amount');
    let pda; try { pda = positionPda({ owner: wallet, custody: A.custody, collateralCustody: A.collateralCustody, side: g.side }, b58decode, b58encode); } catch { return why('position_pda_unverifiable'); }
    if (A.position !== pda) return why('position_pda_mismatch');
  } else {
    if (A.desiredMint !== expect.desiredMint) return why('wrong_desired_mint');
    if (expect.entirePosition === true) { if (g.entirePosition !== true) return why('not_full_close'); }
    else if (expect.sizeUsdDelta !== undefined) { if (g.entirePosition === true || String(g.sizeUsdDelta) !== String(expect.sizeUsdDelta) || g.collateralUsdDelta !== 0n) return why('wrong_size_delta'); }
    else if (expect.collateralUsdDelta !== undefined) { if (g.entirePosition === true || String(g.collateralUsdDelta) !== String(expect.collateralUsdDelta) || g.sizeUsdDelta !== 0n) return why('wrong_collateral_delta'); }
    if (expect.position && A.position !== expect.position) return why('position_mismatch');
  }
  let rq; try { rq = positionRequestPda({ position: A.position, counter: g.counter, change: kind }, b58decode, b58encode); } catch { return why('request_pda_unverifiable'); }
  if (A.positionRequest !== rq) return why('position_request_pda_mismatch');
  return { ok: true, args: g };
}

/* Jupiter Perps REST contract: request field names are taken from the published
 * Perps API specification. This does NOT verify the on-chain instruction layout,
 * PDA seeds, or transaction response semantics below.
 * r130: the owner approved real-money activation on 2026-11-18 knowing the blockers below are still open. Every transaction is still
 * decoded and checked by the gateway before the user's Saturn Wallet signs it. Execution also needs PERPS_EXECUTION_ENABLED=1 and
 * GATEWAY_TICKET_SECRET (>= 32 chars) on Render. */
export const EXECUTE_CONTRACT_VERIFIED = true;
export const CONTRACT_BLOCKERS = Object.freeze([
  'Live Jupiter increase/decrease transaction response semantics and keeper-signature requirements have not been verified.',
  'No real Jupiter-built transaction fixture has been captured and validated for the supported market/collateral combinations.',
  'No end-to-end test has been performed against Jupiter; execution must remain disabled.'
]);

/* Mints are fixed server-side (the SOL/ETH/BTC mints match this service's MARKETS table and Jupiter's custody docs: wETH/wBTC are the
 * Portal-bridged tokens). Decimals are NOT used to convert anything here: amounts arrive in ATOMIC units of the input token and are
 * forwarded unchanged. The frontend reads each token's decimals from the chain and refuses an asset whose decimals differ from these. */
export const MINT = Object.freeze({
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
});
export const DECIMALS = Object.freeze({ SOL: 9, ETH: 8, BTC: 8, USDC: 6 });

/* Saturn request -> Jupiter's documented Perps REST request schema.
 * Keep this mapping explicit: no guessed mint aliases or transactionType are sent. */
export function mapIncrease(b) {
  const out = {
    asset: b.asset,
    inputToken: b.inputToken,
    inputTokenAmount: b.inputTokenAmount,
    leverage: b.leverage,
    maxSlippageBps: b.maxSlippageBps,
    side: b.side,
    walletAddress: b.walletAddress
  };
  /* r188: Jupiter's increase request takes the TP/SL list directly (trigger price in micro-USD; paid out in the input token) */
  if (Array.isArray(b.tpsl) && b.tpsl.length) out.tpsl = b.tpsl.map(x => ({ receiveToken: b.inputToken, triggerPrice: x.triggerPrice, requestType: x.requestType }));
  return out;
}
export function mapDecrease(b) {
  const out = {
    positionPubkey: b.positionPubkey,
    receiveToken: b.receiveToken
  };
  if (b.entirePosition === true) out.entirePosition = true;
  if (b.sizeUsdDelta !== undefined) out.sizeUsdDelta = b.sizeUsdDelta;
  if (b.collateralUsdDelta !== undefined) out.collateralUsdDelta = b.collateralUsdDelta;
  if (b.maxSlippageBps !== undefined) out.maxSlippageBps = b.maxSlippageBps;
  return out;
}

/* ---- PDAs: seed order and counter width cross-checked against published Jupiter Perps PDA examples. ---- */
const P = (1n << 255n) - 19n;
const mod = a => { a %= P; return a < 0n ? a + P : a; };
const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; };
const D = mod(-121665n * pow(121666n, P - 2n));
function onCurve(bytes) {
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 127 : bytes[i]);
  if (y >= P) return false;
  const y2 = y * y % P, u = mod(y2 - 1n), v = mod(D * y2 + 1n), x2 = u * pow(v, P - 2n) % P;
  if (x2 === 0n) return !(bytes[31] & 128);
  let x = pow(x2, (P + 3n) / 8n); if (mod(x * x - x2) !== 0n) { x = x * pow(2n, (P - 1n) / 4n) % P; if (mod(x * x - x2) !== 0n) return false; }
  return true;
}
export function findPda(seeds, programB58, b58decode, b58encode) {
  const prog = b58decode(programB58);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256'); for (const s of seeds) h.update(s); h.update(Buffer.from([bump])); h.update(prog); h.update(Buffer.from('ProgramDerivedAddress'));
    const d = h.digest(); if (!onCurve(d)) return b58encode(d);
  }
  throw new Error('no_pda');
}
export const SIDE_BYTE = Object.freeze({ long: 1, short: 2 });   /* Anchor enum Side { None=0, Long=1, Short=2 } */
export function positionPda({ owner, custody, collateralCustody, side }, b58decode, b58encode) {
  return findPda([Buffer.from('position'), b58decode(owner), b58decode(JLP_POOL), b58decode(custody), b58decode(collateralCustody), Buffer.from([SIDE_BYTE[side]])], PERPS_PROGRAM, b58decode, b58encode);
}
export function positionRequestPda({ position, counter, change }, b58decode, b58encode) {
  const c = Buffer.alloc(8); c.writeBigUInt64LE(BigInt(counter));
  return findPda([Buffer.from('position_request'), b58decode(position), c, Buffer.from([change === 'increase' ? 1 : 2])], PERPS_PROGRAM, b58decode, b58encode);
}
/* ---- Borsh argument decoding: field order/types cross-checked against the published Jupiter Perps Anchor IDL. ---- */
export const ARG_LAYOUT = Object.freeze({
  increase: [['sizeUsdDelta', 'u64'], ['collateralTokenDelta', 'u64'], ['side', 'side'], ['priceSlippage', 'u64'], ['jupiterMinimumOut', 'opt_u64'], ['counter', 'u64']],
  decrease: [['collateralUsdDelta', 'u64'], ['sizeUsdDelta', 'u64'], ['priceSlippage', 'u64'], ['jupiterMinimumOut', 'opt_u64'], ['entirePosition', 'opt_bool'], ['counter', 'u64']],
  tpsl: [['collateralUsdDelta', 'u64'], ['sizeUsdDelta', 'u64'], ['requestType', 'u8'], ['priceSlippage', 'opt_u64'], ['jupiterMinimumOut', 'opt_u64'], ['triggerPrice', 'opt_u64'], ['triggerAboveThreshold', 'opt_bool'], ['entirePosition', 'opt_bool'], ['counter', 'u64']]
});
export function readArgs(data, kind) {
  let o = 8; const out = {}; const need = n => { if (o + n > data.length) throw new Error('args_truncated'); };
  const u64 = () => { need(8); let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[o + i]); o += 8; return v; };
  for (const [k, t] of ARG_LAYOUT[kind]) {
    if (t === 'u64') out[k] = u64();
    else if (t === 'u8') { need(1); out[k] = data[o++]; }
    else if (t === 'side') { need(1); const s = data[o++]; out[k] = s === 1 ? 'long' : s === 2 ? 'short' : null; }
    else if (t === 'opt_u64') { need(1); const tag = data[o++]; if (tag === 0) out[k] = null; else if (tag === 1) out[k] = u64(); else throw new Error('args_option'); }
    else if (t === 'opt_bool') { need(1); const tag = data[o++]; if (tag === 0) out[k] = null; else if (tag === 1) { need(1); const v = data[o++]; if (v > 1) throw new Error('args_bool'); out[k] = v === 1; } else throw new Error('args_option'); }
  }
  if (o !== data.length) throw new Error('args_trailing');
  return out;
}
