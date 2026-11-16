/* Pure Solana helpers for the Perps gateway: base58, transaction wire-format parsing, message hash, ed25519 signature check.
 * No network, no keys, nothing is ever signed here. Used only to VALIDATE transactions the user's wallet has already signed. */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHA].map((c, i) => [c, BigInt(i)]));
export const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function b58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ''; while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  return '1'.repeat(zeros) + s;
}
export function b58decode(str) {
  if (typeof str !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]*$/.test(str)) throw new Error('bad_base58');
  let n = 0n; for (const c of str) n = n * 58n + MAP[c];
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  let zeros = 0; while (zeros < str.length && str[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...out]);
}
export const isPubkey = s => typeof s === 'string' && B58.test(s) && (() => { try { return b58decode(s).length === 32; } catch { return false; } })();

/* Solana wire format (legacy or v0). Throws on anything malformed, truncated, or with trailing bytes. */
export function parseTx(b) {
  if (!(b instanceof Uint8Array)) throw new Error('tx_bytes');
  let o = 0;
  const u8 = () => { if (o >= b.length) throw new Error('tx_truncated'); return b[o++]; };
  const cu16 = () => { let v = 0, s = 0; for (let i = 0; i < 3; i++) { const x = u8(); v |= (x & 127) << s; if (!(x & 128)) return v; s += 7; } throw new Error('tx_len'); };
  const take = n => { if (n < 0 || o + n > b.length) throw new Error('tx_truncated'); const x = b.subarray(o, o + n); o += n; return x; };
  const nsig = cu16(); if (nsig < 1 || nsig > 8) throw new Error('tx_sig_count');
  const sigs = []; for (let i = 0; i < nsig; i++) sigs.push(take(64));
  const msgStart = o; let version = 'legacy';
  if (b[o] & 128) { const v = b[o] & 127; if (v !== 0) throw new Error('tx_version'); version = 0; o++; }
  const req = u8(), roSigned = u8(), roUnsigned = u8();
  const nk = cu16(); if (nk < 1 || nk > 64) throw new Error('tx_keys');
  const keys = []; for (let i = 0; i < nk; i++) keys.push(b58encode(take(32)));
  const blockhash = b58encode(take(32));
  const ni = cu16(); if (ni > 64) throw new Error('tx_ix_count');
  const ixs = [];
  for (let i = 0; i < ni; i++) { const pi = u8(), na = cu16(), acc = Array.from(take(na)), dl = cu16(), data = take(dl); if (pi >= nk) throw new Error('tx_prog_index'); ixs.push({ prog: keys[pi], acc, data }); }
  const luts = [];
  if (version === 0) { const n = cu16(); for (let i = 0; i < n; i++) { const key = b58encode(take(32)); const w = Array.from(take(cu16())); const r = Array.from(take(cu16())); luts.push({ key, w, r }); } }
  if (o !== b.length) throw new Error('tx_trailing');
  return { version, nsig, sigs, req, roSigned, roUnsigned, keys, blockhash, ixs, luts, msg: b.subarray(msgStart) };
}
export const msgHash = msg => createHash('sha256').update(msg).digest('hex');

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
/* true only when sig is a valid ed25519 signature of msg by the 32-byte public key */
export function verifyEd25519(pubkeyB58, msg, sig) {
  try {
    const pk = b58decode(pubkeyB58); if (pk.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pk)]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(msg), key, Buffer.from(sig));
  } catch { return false; }
}
export function b64ToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4) throw new Error('bad_base64');
  return new Uint8Array(Buffer.from(s, 'base64'));
}
