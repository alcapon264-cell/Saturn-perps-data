/* Jupiter Perpetuals on-chain constants used to VALIDATE transactions. Nothing here builds or signs anything.
 *
 * VERIFIED (Jupiter developer docs, developers.jup.ag/docs/perps/*, checked 2026-11-16):
 *   - program id: the Pool Account page links the program IDL on Solscan at PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu (also listed by Helius' program catalog)
 *   - JLP pool 5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq (Pool Account page)
 *   - custody accounts SOL/ETH/BTC/USDC/USDT (Custody Account page)
 *   - account roles of create_increase_position_market_request / create_decrease_position_market_request (Helius parsed IDL)
 * COMPUTED (Anchor rule, not remembered): instruction discriminators = sha256("global:<snake_case_name>")[0..8].
 * NOT VERIFIED in this build: the Borsh argument layout of the two instructions (the IDL file could not be fetched). It is used only by the
 * frontend decoder, which therefore keeps execution DISABLED. The gateway below checks structure only (programs, signer, discriminator, accounts). */
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
  decrease: disc('create_decrease_position_market_request')
});
export const ACTIONS = Object.freeze({ 'increase-position': 'increase', 'decrease-position': 'decrease' });
/* account index of each role inside the instruction (Helius parsed IDL) */
export const IX_ACCOUNTS = Object.freeze({
  increase: ['owner', 'fundingAccount', 'perpetuals', 'pool', 'position', 'positionRequest', 'positionRequestAta', 'custody', 'collateralCustody', 'inputMint', 'referral', 'tokenProgram', 'associatedTokenProgram', 'systemProgram', 'eventAuthority', 'program'],
  decrease: ['owner', 'receivingAccount', 'perpetuals', 'pool', 'position', 'positionRequest', 'positionRequestAta', 'custody', 'collateralCustody', 'desiredMint', 'referral', 'tokenProgram', 'associatedTokenProgram', 'systemProgram', 'eventAuthority', 'program']
});
const sameBytes = (a, b) => a.length >= b.length && b.every((x, i) => a[i] === x);

/* Structural check of an UNSIGNED or SIGNED transaction. Resolves only static account keys: any Perps account that sits in an
 * address lookup table cannot be checked here and the transaction is refused (fail closed).
 * -> {ok:true, kind, position} | {ok:false, why} */
export function inspectPerpsTx(t, { wallet, kind }) {
  const why = w => ({ ok: false, why: w });
  if (t.keys[0] !== wallet) return why('fee_payer_not_wallet');
  if (t.req !== 1 || t.nsig !== 1) return why('unexpected_signers');
  const perps = [];
  for (const ix of t.ixs) {
    if (!ALLOWED_PROGRAMS.has(ix.prog)) return why('program_not_allowed');
    if (ix.prog === PERPS_PROGRAM) perps.push(ix);
  }
  if (perps.length !== 1) return why(perps.length ? 'multiple_perps_instructions' : 'no_perps_instruction');
  const ix = perps[0];
  if (!sameBytes(ix.data, DISC[kind])) return why('unexpected_perps_instruction');
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
  return { ok: true, kind, position: at('position'), accounts: Object.fromEntries(roles.map(r => [r, at(r)])), data: ix.data };
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

/* ===================== r117: Jupiter request mapping, PDA checks, argument decoding =====================
 * STATUS OF THE JUPITER REST CONTRACT (checked 2026-11-16):
 *   - Jupiter's developer docs (developers.jup.ag/docs/perps) say the Perps API is "a work in progress" and document NO REST endpoints.
 *   - Jupiter's own integration skill (jup-ag/agent-skills, integrating-jupiter) says: "No REST endpoints yet. Interact on-chain via Anchor IDL."
 *   - Jupiter's user docs (Technical Reference) describe two paths: request + keeper fulfilment, and a "single transaction" path that a
 *     Jupiter keeper CO-SIGNS. The request/response contract of either path over REST is not published.
 * Therefore EXECUTE_CONTRACT_VERIFIED stays false. While it is false the transaction routes refuse to run even if the environment asks
 * for execution. Change it ONLY after the field names, units, transaction type and execute contract are confirmed by Jupiter. */
export const EXECUTE_CONTRACT_VERIFIED = false;
export const CONTRACT_BLOCKERS = Object.freeze([
  'Jupiter does not publish a Perps REST contract (build-transaction request fields, transaction types, POST /transaction/execute request and response).',
  'The Borsh argument layout and Side encoding of the market-request instructions, and the Position / PositionRequest PDA seeds, are not in Jupiter\'s official docs.',
  'No safe live test against Jupiter\'s API has been performed.'
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

/* Saturn request -> Jupiter request (field names as specified for r117; NOT confirmed by Jupiter, see above).
 * collateralMint: the POSITION's collateral token. Jupiter: long positions use the market token, short positions use USDC (or USDT).
 * inputMint + collateralTokenDelta: the token the user PAYS with and its amount in that token's atomic units (PositionRequest docs:
 *   "mint: input mint for opens and deposits"; the program swaps input -> collateral itself). It is never converted here. */
export function mapIncrease(b, { transactionType = '' } = {}) {
  const marketMint = MINT[b.asset];
  const out = {
    walletAddress: b.walletAddress,
    marketMint,
    inputMint: MINT[b.inputToken],
    collateralMint: b.side === 'long' ? marketMint : MINT.USDC,
    collateralTokenDelta: b.inputTokenAmount,
    side: b.side,
    leverage: b.leverage,
    maxSlippageBps: b.maxSlippageBps
  };
  if (transactionType) out.transactionType = transactionType;
  return out;
}
/* USD deltas are atomic USD with 6 decimals (Jupiter PositionRequest docs: "a position request to increase ... by 10 USDC will have a
 * sizeUsdDelta = 10000000"). desiredMint = the token the user wants to receive. */
export function mapDecrease(b) {
  const out = { positionPubkey: b.positionPubkey, desiredMint: MINT[b.receiveToken] };
  if (b.entirePosition === true) out.entirePosition = true;
  if (b.sizeUsdDelta !== undefined) { out.sizeUsdDelta = b.sizeUsdDelta; out.collateralUsdDelta = '0'; }
  if (b.collateralUsdDelta !== undefined) { out.collateralUsdDelta = b.collateralUsdDelta; out.sizeUsdDelta = '0'; }
  if (b.maxSlippageBps !== undefined) out.maxSlippageBps = b.maxSlippageBps;
  return out;
}

/* ---- PDAs (UNVERIFIED seeds, fail closed). Seeds follow the community Anchor IDL examples Jupiter's docs link to. ---- */
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
export const SIDE_BYTE = Object.freeze({ long: 1, short: 2 });   /* UNVERIFIED encoding (IDL enum Side { None, Long, Short }) */
export function positionPda({ owner, custody, collateralCustody, side }, b58decode, b58encode) {
  return findPda([Buffer.from('position'), b58decode(owner), b58decode(JLP_POOL), b58decode(custody), b58decode(collateralCustody), Buffer.from([SIDE_BYTE[side]])], PERPS_PROGRAM, b58decode, b58encode);
}
export function positionRequestPda({ position, counter, change }, b58decode, b58encode) {
  const c = Buffer.alloc(8); c.writeBigUInt64LE(BigInt(counter));
  return findPda([Buffer.from('position_request'), b58decode(position), c, Buffer.from([change === 'increase' ? 1 : 2])], PERPS_PROGRAM, b58decode, b58encode);
}
/* ---- argument decoding (UNVERIFIED layout, fail closed). Must match the frontend's ARG_LAYOUT exactly. ---- */
export const ARG_LAYOUT = Object.freeze({
  increase: [['sizeUsdDelta', 'u64'], ['collateralTokenDelta', 'u64'], ['side', 'side'], ['priceSlippage', 'u64'], ['jupiterMinimumOut', 'opt_u64'], ['counter', 'u64']],
  decrease: [['collateralUsdDelta', 'u64'], ['sizeUsdDelta', 'u64'], ['priceSlippage', 'u64'], ['jupiterMinimumOut', 'opt_u64'], ['entirePosition', 'opt_bool'], ['counter', 'u64']]
});
export function readArgs(data, kind) {
  let o = 8; const out = {}; const need = n => { if (o + n > data.length) throw new Error('args_truncated'); };
  const u64 = () => { need(8); let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[o + i]); o += 8; return v; };
  for (const [k, t] of ARG_LAYOUT[kind]) {
    if (t === 'u64') out[k] = u64();
    else if (t === 'side') { need(1); const s = data[o++]; out[k] = s === 1 ? 'long' : s === 2 ? 'short' : null; }
    else if (t === 'opt_u64') { need(1); const tag = data[o++]; if (tag === 0) out[k] = null; else if (tag === 1) out[k] = u64(); else throw new Error('args_option'); }
    else if (t === 'opt_bool') { need(1); const tag = data[o++]; if (tag === 0) out[k] = null; else if (tag === 1) { need(1); const v = data[o++]; if (v > 1) throw new Error('args_bool'); out[k] = v === 1; } else throw new Error('args_option'); }
  }
  if (o !== data.length) throw new Error('args_trailing');
  return out;
}
