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
  return { ok: true, kind, position: at('position') };
}
