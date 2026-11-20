/* Saturn Polymarket wallet infrastructure — READ-ONLY Polygon verifier.
 * No relayer calls, no signing, no transactions, no arbitrary RPC methods or user-supplied URLs.
 */
const RPC_DEFAULT = 'https://polygon-rpc.com';
export const POLY_WALLET_CONTRACTS = Object.freeze({
  pUSD: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  depositWalletFactory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
  protocolV2Exchange: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',
  standardExchange: '0xE111180000d2663C0091e4f400237545B87B996B',
  negRiskExchange: '0xe2222d279d744050d28e00520010520000310F59',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'
});
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const CODE = /^0x[0-9a-fA-F]+$/;
const SELECTORS = Object.freeze({ decimals: '0x313ce567', symbol: '0x95d89b41' });
export function createPmWalletVerifier({ fetchImpl = globalThis.fetch, rpcUrl = RPC_DEFAULT, timeoutMs = 8000 } = {}) {
  const url = String(rpcUrl || '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(url)) throw new Error('polygon_rpc_must_be_https');
  let nextId = 1;
  async function rpc(method, params) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: ac.signal
      });
      if (!res.ok) throw new Error('polygon_rpc_http_' + res.status);
      const body = await res.json();
      if (!body || body.error || body.result == null) throw new Error('polygon_rpc_invalid_response');
      return body.result;
    } finally { clearTimeout(timer); }
  }
  async function verify() {
    const result = {
      ok: false, network: 'polygon', expectedChainId: 137, chainId: null,
      contracts: {}, pUSD: { address: POLY_WALLET_CONTRACTS.pUSD, deployed: null, decimals: null, symbol: null },
      relayer: { configured: false, enabled: false },
      actions: { walletCreation: false, approvals: false, signing: false, orders: false },
      source: 'polygon-json-rpc-read-only'
    };
    try {
      const id = await rpc('eth_chainId', []);
      result.chainId = Number(BigInt(id));
      if (result.chainId !== 137) { result.reason = 'wrong_chain'; return result; }
      const entries = Object.entries(POLY_WALLET_CONTRACTS);
      const codes = await Promise.all(entries.map(async ([key, address]) => {
        const code = await rpc('eth_getCode', [address, 'latest']);
        return [key, typeof code === 'string' && CODE.test(code) && code !== '0x'];
      }));
      result.contracts = Object.fromEntries(codes);
      result.pUSD.deployed = !!result.contracts.pUSD;
      if (result.pUSD.deployed) {
        const [d, sym] = await Promise.all([
          rpc('eth_call', [{ to: POLY_WALLET_CONTRACTS.pUSD, data: SELECTORS.decimals }, 'latest']),
          rpc('eth_call', [{ to: POLY_WALLET_CONTRACTS.pUSD, data: SELECTORS.symbol }, 'latest'])
        ]);
        if (HEX32.test(d)) result.pUSD.decimals = Number(BigInt(d));
        if (typeof sym === 'string' && /^0x[0-9a-fA-F]+$/.test(sym) && sym.length >= 66) {
          const raw = sym.slice(2).replace(/00+$/, '');
          try { result.pUSD.symbol = Buffer.from(raw, 'hex').toString('utf8').replace(/\0/g, '') || null; } catch {}
        }
      }
      const allContracts = Object.values(result.contracts).every(Boolean);
      result.ok = result.pUSD.deployed === true && result.pUSD.decimals != null && allContracts;
      result.reason = result.ok ? 'read_only_checks_passed' : 'one_or_more_contract_checks_failed';
      return result;
    } catch (e) {
      result.reason = 'rpc_unavailable';
      result.error = String(e && e.message || 'rpc_error').slice(0, 120);
      return result;
    }
  }
  return Object.freeze({ verify });
}
