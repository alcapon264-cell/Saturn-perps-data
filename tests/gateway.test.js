/* Perps gateway (/v1/perps/jup/*): reads, execution switch, schemas, tickets, signatures, durable idempotency, ambiguous upstream results.
 * [MOCK Jupiter (scripted), REAL PostgreSQL, real HTTP socket, real ed25519 signatures made with a throw-away TEST key] */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, fakeJupiter, MARKETS } from './helpers/harness.js';
import { b58encode, b58decode, parseTx } from '../src/solana.js';
import { PERPS_PROGRAM, JLP_POOL, CUSTODY, DISC, TOKEN_PROGRAM, SYSTEM_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET, MINT, positionPda, positionRequestPda, EXECUTE_CONTRACT_VERIFIED } from '../src/perps-program.js';
import { loadConfig } from '../src/config.js';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const TKT = 'test-only-ticket-secret-0123456789abcdef';
const rnd = () => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256); return b58encode(b); };
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pub: b58encode(raw), signMsg: m => new Uint8Array(edSign(null, Buffer.from(m), privateKey)) };
}
const cu16 = n => n < 128 ? [n] : [(n & 127) | 128, n >> 7];
/* builds a legacy transaction with one Jupiter Perps market-request instruction (16 accounts, real PDAs, real argument bytes) */
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return [...b]; };
function buildTx({ wallet, kind = 'increase', side = 'long', market = 'SOL', input = 'USDC', amount = '25000000', position = null, custody = null, collateral = null, extraProgram = null, payer = null, owner = null, pool = JLP_POOL,
  argKind = null, argSide = null, counter = 7, request = null, swapOwnerFunding = false, entire = false, sizeDelta = '0', collDelta = '0' }) {
  custody = custody || CUSTODY[market]; collateral = collateral || (side === 'long' ? CUSTODY[market] : CUSTODY.USDC);
  position = position || positionPda({ owner: wallet, custody, collateralCustody: collateral, side }, b58decode, b58encode);
  const req = request || positionRequestPda({ position, counter, change: kind }, b58decode, b58encode);
  const mint = MINT[input], funding = rnd();
  const roles = [owner || wallet, funding, rnd(), pool, position, req, rnd(), custody, collateral, mint, PERPS_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM, rnd(), PERPS_PROGRAM];
  if (swapOwnerFunding) [roles[0], roles[1]] = [roles[1], roles[0]];
  const keys = [payer || wallet]; const idx = k => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
  const accIdx = roles.map(idx); const progIdx = idx(PERPS_PROGRAM); const cbIdx = idx(COMPUTE_BUDGET); const exIdx = extraProgram ? idx(extraProgram) : -1;
  const args = kind === 'increase' ? [...u64(125000000), ...u64(amount), (argSide || side) === 'long' ? 1 : 2, ...u64(151000000), 0, ...u64(counter)]
    : [...u64(collDelta), ...u64(sizeDelta), ...u64(147000000), 0, ...(entire ? [1, 1] : [0]), ...u64(counter)];
  const data = [...DISC[argKind || kind], ...args];
  const ixs = [[cbIdx, [], [2, 0, 0, 0, 0]], [progIdx, accIdx, data]]; if (exIdx >= 0) ixs.push([exIdx, [], [9]]);
  const msg = [1, 0, keys.length - 1, ...cu16(keys.length), ...keys.flatMap(k => [...b58decode(k)]), ...b58decode(rnd()), ...cu16(ixs.length)];
  for (const [p, a, d] of ixs) msg.push(p, ...cu16(a.length), ...a, ...cu16(d.length), ...d);
  const m = Uint8Array.from(msg);
  return { msg: m, position, unsigned: Uint8Array.from([1, ...new Array(64).fill(0), ...m]), signedBy: kp => Uint8Array.from([1, ...kp.signMsg(m), ...m]) };
}
const b64 = u => Buffer.from(u).toString('base64');

function gwJupiter() {
  const base = fakeJupiter({ prices: { [MARKETS.SOL]: 150, [MARKETS.ETH]: 3000, [MARKETS.BTC]: 90000 } });
  const g = { calls: [], script: {} };
  const inner = base.fetch;
  base.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/market-stats')) return inner(url, init);
    const body = init.body ? JSON.parse(init.body) : null; g.calls.push({ path: u.pathname, method: init.method, body, query: Object.fromEntries(u.searchParams), headers: init.headers, redirect: init.redirect });
    const fn = g.script[u.pathname]; if (!fn) return new Response('{"error":"nf"}', { status: 404 });
    return fn({ body, query: Object.fromEntries(u.searchParams), init });
  };
  base.g = g; return base;
}
const J = (status, o) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

async function boot({ exec = false, env = {} } = {}) {
  const jup = gwJupiter();
  const envv = { RECORDER_ENABLED: '0', ...(exec ? { PERPS_EXECUTION_ENABLED: '1', GATEWAY_TICKET_SECRET: TKT } : {}), ...env };
  /* TEST ONLY: the code lock (EXECUTE_CONTRACT_VERIFIED=false) is bypassed by injecting the config, so the safety machinery can be exercised against MOCKED Jupiter */
  const cfgOverrides = exec ? { gateway: { ...loadConfig({ DATABASE_URL: 'x', ...envv }).gateway, executionEnabled: true } } : {};
  const e = await makeEnv({ jup, env: envv, cfgOverrides, init: false });
  const port = await e.app.start({ port: 0, host: '127.0.0.1' }); e.base = 'http://127.0.0.1:' + port; e.g = jup.g;
  e.get = (p, h = {}) => fetch(e.base + p, { headers: h });
  e.post = (p, body, h = {}) => fetch(e.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return e;
}
const json = async r => ({ status: r.status, body: await r.json() });
const W = keypair();
const incBody = (w = W.pub, extra = {}) => ({ asset: 'SOL', side: 'long', inputToken: 'USDC', inputTokenAmount: '25000000', leverage: '5.0', maxSlippageBps: '100', walletAddress: w, ...extra });

test('execution routes are OFF by default: 403 execution_disabled, body never read, Jupiter never called', opts, async () => {
  const e = await boot(); try {
    for (const p of ['/v1/perps/jup/positions/increase', '/v1/perps/jup/positions/decrease', '/v1/perps/jup/execute']) {
      const r = await json(await e.post(p, incBody())); assert.equal(r.status, 403, p); assert.equal(r.body.error, 'execution_disabled');
      const r2 = await json(await e.post(p, 'x'.repeat(100000))); assert.equal(r2.status, 403, 'refused before reading the body');
    }
    assert.equal(e.g.calls.length, 0);
    assert.equal((await e.get('/v1/perps/jup/positions/increase')).status, 405);
    assert.equal((await e.get('/v1/perps/jup/anything')).status, 404);
  } finally { await e.drop(); }
});

test('positions: strict wallet + params, sanitized pass-through, cached, per-IP limited, upstream shape errors are honest', opts, async () => {
  const e = await boot(); try {
    e.g.script['/v1/positions'] = () => J(200, { count: 1, dataList: [{ asset: 'SOL', side: 'long', sizeUsd: '1000000000', collateralUsd: '200000000', entryPriceUsd: '150000000', markPriceUsd: '151000000', leverage: '5', positionPubkey: rnd(), assetMint: MARKETS.SOL, injected: '<script>', createdTime: 1763250000 }] });
    for (const p of ['/v1/perps/jup/positions', '/v1/perps/jup/positions?walletAddress=abc&includeClosedPositions=false', '/v1/perps/jup/positions?walletAddress=' + W.pub, '/v1/perps/jup/positions?walletAddress=' + W.pub + '&includeClosedPositions=true', '/v1/perps/jup/positions?walletAddress=' + W.pub + '&includeClosedPositions=false&x=1'])
      assert.equal((await e.get(p)).status, 400, p);
    const q = '/v1/perps/jup/positions?walletAddress=' + W.pub + '&includeClosedPositions=false';
    const r = await json(await e.get(q)); assert.equal(r.status, 200); assert.equal(r.body.dataList.length, 1); assert.ok(!('injected' in r.body.dataList[0]), 'unknown fields are dropped');
    assert.equal(e.g.calls[0].query.walletAddress, W.pub); assert.equal(e.g.calls[0].method, 'GET'); assert.equal(e.g.calls[0].redirect, 'error');
    await e.get(q); assert.equal(e.g.calls.length, 1, 'second call within 4 s is served from cache');
    const w2 = keypair().pub; e.g.script['/v1/positions'] = () => J(200, { dataList: [{ asset: { evil: 1 } }] });
    const bad = await json(await e.get('/v1/perps/jup/positions?walletAddress=' + w2 + '&includeClosedPositions=false')); assert.equal(bad.status, 502); assert.equal(bad.body.error, 'upstream_malformed');
    const w3 = keypair().pub; e.g.script['/v1/positions'] = () => J(500, { error: 'x' });
    assert.equal((await e.get('/v1/perps/jup/positions?walletAddress=' + w3 + '&includeClosedPositions=false')).status, 504);
    let limited = 0; for (let i = 0; i < 30; i++) { const s = (await e.get('/v1/perps/jup/positions?walletAddress=' + keypair().pub + '&includeClosedPositions=false')).status; if (s === 429) limited++; }
    assert.ok(limited > 0, 'per-IP limit applies');
  } finally { await e.drop(); }
});

test('market-stats: served from the recorder only (no upstream call), fixed mints, no price when not live', opts, async () => {
  const e = await boot(); try {
    assert.equal((await e.get('/v1/perps/jup/market-stats?mint=' + rnd())).status, 400);
    const r = await json(await e.get('/v1/perps/jup/market-stats?mint=' + MARKETS.SOL)); assert.equal(r.status, 503); assert.equal(r.body.error, 'no_live_price');
    const t = e.clock.now(); await e.db.sql(`INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('jupiter-perps:market-stats','SOL',to_timestamp(${t / 1000 - 5}),to_timestamp(${t / 1000 - 5}),151.25,40)`);
    const ok = await json(await e.get('/v1/perps/jup/market-stats?mint=' + MARKETS.SOL)); assert.equal(ok.status, 200); assert.equal(Number(ok.body.price), 151.25);
    assert.equal(e.g.calls.length, 0);
  } finally { await e.drop(); }
});

test('prepare (execution enabled in TEST only): strict schema, size/type limits, Jupiter tx inspected, ticket issued', opts, async () => {
  const e = await boot({ exec: true }); try {
    let tx = buildTx({ wallet: W.pub });
    e.g.script['/v1/positions/increase'] = () => J(200, { serializedTxBase64: b64(tx.unsigned), positionPubkey: tx.position, quote: { sizeUsdDelta: '125000000', leverage: '5', evil: { x: 1 } }, txMetadata: { blockhash: 'x', transactionFeeLamports: '5000' } });
    const P = '/v1/perps/jup/positions/increase';
    for (const b of [incBody(W.pub, { extra: 1 }), incBody(W.pub, { leverage: '500' }), incBody(W.pub, { inputTokenAmount: '-1' }), incBody(W.pub, { asset: 'DOGE' }), incBody('nope'), incBody(W.pub, { maxSlippageBps: '9999' })])
      assert.equal((await e.post(P, b)).status, 400, JSON.stringify(b));
    assert.equal((await e.post(P, JSON.stringify(incBody()), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await e.post(P, JSON.stringify({ ...incBody(), pad: 'x'.repeat(9000) }))).status, 413);
    assert.equal(e.g.calls.length, 0, 'invalid requests never reach Jupiter');
    const ok = await json(await e.post(P, incBody())); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.match(ok.body.saturnTicket, /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/); assert.ok(!('evil' in ok.body.quote));
    assert.deepEqual(e.g.calls[0].body, { asset: 'SOL', inputToken: 'USDC', inputTokenAmount: '25000000', leverage: '5.0', maxSlippageBps: '100', side: 'long', walletAddress: W.pub }, 'Saturn fields are MAPPED to Jupiter names; nothing Saturn-internal is forwarded');
    const refuse = async (t, reason) => { e.clock.t += 61000; tx = t; e.g.script['/v1/positions/increase'] = () => J(200, { serializedTxBase64: b64(tx.unsigned), positionPubkey: tx.position, quote: {} }); const r = await json(await e.post(P, incBody(W.pub))); assert.equal(r.status, 502, reason); assert.equal(r.body.reason, reason); };
    await refuse(buildTx({ wallet: W.pub, extraProgram: rnd() }), 'program_not_allowed');
    await refuse(buildTx({ wallet: W.pub, payer: keypair().pub }), 'fee_payer_not_wallet');
    await refuse(buildTx({ wallet: W.pub, kind: 'decrease' }), 'unexpected_perps_instruction');
    await refuse(buildTx({ wallet: W.pub, owner: keypair().pub }), 'owner_not_wallet');
    await refuse(buildTx({ wallet: W.pub, pool: rnd() }), 'pool_mismatch');
    await refuse(buildTx({ wallet: W.pub, custody: CUSTODY.USDC }), 'custody_not_allowed');
    await refuse(buildTx({ wallet: W.pub, swapOwnerFunding: true }), 'owner_not_wallet');                    /* invalid account ordering */
    await refuse(buildTx({ wallet: W.pub, market: 'ETH' }), 'wrong_market');
    await refuse(buildTx({ wallet: W.pub, argSide: 'short' }), 'wrong_side');
    await refuse(buildTx({ wallet: W.pub, amount: '25000001' }), 'wrong_collateral_amount');
    await refuse(buildTx({ wallet: W.pub, input: 'SOL' }), 'wrong_input_mint');
    await refuse(buildTx({ wallet: W.pub, position: rnd() }), 'position_pda_mismatch');
    await refuse(buildTx({ wallet: W.pub, request: rnd() }), 'position_request_pda_mismatch');
    await refuse(buildTx({ wallet: W.pub, argKind: 'decrease' }), 'unexpected_perps_instruction');            /* invalid discriminator */
  } finally { await e.drop(); }
});

async function prepared(e, kp = W) {
  e.clock.t += 61000;   /* new rate-limit window for each prepared transaction */
  const tx = buildTx({ wallet: kp.pub });
  e.g.script['/v1/positions/increase'] = () => J(200, { serializedTxBase64: b64(tx.unsigned), positionPubkey: tx.position, quote: {} });
  const r = await json(await e.post('/v1/perps/jup/positions/increase', incBody(kp.pub)));
  assert.equal(r.status, 200, JSON.stringify(r.body)); return { tx, ticket: r.body.saturnTicket };
}
const EX = '/v1/perps/jup/execute';
const execBody = (signed, ticket, action = 'increase-position') => ({ action, serializedTxBase64: b64(signed), ticket });

test('execute: ticket + exact message + valid wallet signature required; an allowed Origin is NOT authentication', opts, async () => {
  const e = await boot({ exec: true }); try {
    e.g.script['/v1/transaction/execute'] = ({ body }) => J(200, { txid: b58encode(parseTx(Buffer.from(body.serializedTxBase64, 'base64')).sigs[0]) });
    const { tx, ticket } = await prepared(e); const signed = tx.signedBy(W); const before = e.g.calls.length;
    const no = await json(await e.post(EX, { action: 'increase-position', serializedTxBase64: b64(signed) }, { origin: 'https://app.example' })); assert.equal(no.status, 403, 'missing ticket is refused'); assert.equal(no.body.error, 'bad_ticket');
    assert.equal((await e.post(EX, execBody(signed, 'abc.' + '0'.repeat(64)), { origin: 'https://app.example' })).status, 403, 'forged ticket refused even from an allowed Origin');
    const other = buildTx({ wallet: W.pub }).signedBy(W);
    assert.equal((await json(await e.post(EX, execBody(other, ticket)))).body.error, 'ticket_mismatch', 'a different transaction cannot use this ticket');
    const badSig = Uint8Array.from(signed); badSig[5] ^= 1;
    assert.equal((await json(await e.post(EX, execBody(badSig, ticket)))).body.error, 'bad_signature');
    assert.equal((await json(await e.post(EX, execBody(tx.signedBy(keypair()), ticket)))).body.error, 'bad_signature', 'signed by someone other than the fee payer');
    assert.equal((await json(await e.post(EX, execBody(signed, ticket, 'decrease-position')))).body.error, 'ticket_mismatch');
    assert.equal(e.g.calls.length, before, 'nothing was relayed so far');
    const ok = await json(await e.post(EX, execBody(signed, ticket))); assert.equal(ok.status, 200); assert.equal(ok.body.state, 'submitted'); assert.equal(ok.body.txid, b58encode(signed.subarray(1, 65)));
    assert.equal(e.g.calls.filter(c => c.path.endsWith('/execute')).length, 1);
  } finally { await e.drop(); }
});

test('execute: durable idempotency - duplicate taps / repeated submissions relay ONCE; state survives a restart', opts, async () => {
  const e = await boot({ exec: true }); let e2 = null; try {
    let n = 0; e.g.script['/v1/transaction/execute'] = async ({ body }) => { n++; await new Promise(r => setTimeout(r, 30)); return J(200, { txid: b58encode(parseTx(Buffer.from(body.serializedTxBase64, 'base64')).sigs[0]) }); };
    const { tx, ticket } = await prepared(e); const signed = tx.signedBy(W);
    const rs = await Promise.all([1, 2, 3, 4].map(() => e.post(EX, execBody(signed, ticket)).then(json)));
    assert.equal(n, 1, 'four concurrent submissions -> one upstream call');
    assert.equal(rs.filter(r => r.body.duplicate === true).length, 3);
    const again = await json(await e.post(EX, execBody(signed, ticket))); assert.equal(again.body.duplicate, true); assert.equal(again.body.state, 'submitted');
    const row = (await e.db.rows("SELECT state FROM perps_exec_requests"))[0]; assert.equal(row.state, 'submitted');
    /* a second, fresh instance (empty memory) on the same database, as after a restart or on another instance */
    e2 = await makeEnv({ db: e.db, jup: gwJupiter(), env: { RECORDER_ENABLED: '0', PERPS_EXECUTION_ENABLED: '1', GATEWAY_TICKET_SECRET: TKT }, cfgOverrides: { gateway: { ...loadConfig({ DATABASE_URL: 'x', PERPS_EXECUTION_ENABLED: '1', GATEWAY_TICKET_SECRET: TKT }).gateway, executionEnabled: true } }, init: false });
    const port = await e2.app.start({ port: 0, host: '127.0.0.1' });
    const r2 = await json(await fetch('http://127.0.0.1:' + port + EX, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(execBody(signed, ticket)) }));
    assert.equal(r2.body.duplicate, true, 'a fresh instance still knows the signature'); assert.equal(e2.jup.g.calls.length, 0, 'and Jupiter is not called');
  } finally { await e.drop(); if (e2) await e2.stop(); }
});

test('execute: ambiguous upstream (timeout / 5xx / malformed) -> state unknown, 202, NEVER retried; 4xx -> rejected; DB down -> not submitted', opts, async () => {
  const e = await boot({ exec: true }); try {
    let n = 0;
    for (const [mode, expect] of [['500', 'unknown'], ['badjson', 'unknown'], ['network', 'unknown'], ['400', 'rejected']]) {
      e.g.script['/v1/transaction/execute'] = () => { n++; if (mode === 'network') throw new TypeError('fetch failed'); if (mode === 'badjson') return new Response('nope', { status: 200 }); return J(Number(mode), { message: 'upstream says no' }); };
      const { tx, ticket } = await prepared(e); const signed = tx.signedBy(W); const before = n;
      const r = await json(await e.post(EX, execBody(signed, ticket))); assert.equal(r.body.state, expect, mode); assert.equal(r.status, expect === 'unknown' ? 202 : 422, mode);
      const r2 = await json(await e.post(EX, execBody(signed, ticket))); assert.equal(r2.body.duplicate, true, mode); assert.equal(r2.body.state, expect, mode);
      assert.equal(n - before, 1, mode + ': exactly one upstream attempt, no blind retry');
    }
    const { tx, ticket } = await prepared(e); const signed = tx.signedBy(W);
    await e.db.sql('ALTER TABLE perps_exec_requests RENAME TO perps_exec_requests_gone');
    const before = n; const r = await json(await e.post(EX, execBody(signed, ticket))); assert.equal(r.status, 503); assert.equal(r.body.error, 'db_unavailable'); assert.equal(n, before, 'no durable record -> nothing relayed');
    await e.db.sql('ALTER TABLE perps_exec_requests_gone RENAME TO perps_exec_requests');
  } finally { await e.drop(); }
});

test('execute: an expired ticket is refused before anything is relayed', opts, async () => {
  const e = await boot({ exec: true }); try {
    let n = 0; e.g.script['/v1/transaction/execute'] = () => { n++; return J(200, {}); };
    const { tx, ticket } = await prepared(e); e.clock.t += 61000;
    assert.equal((await json(await e.post(EX, execBody(tx.signedBy(W), ticket)))).body.error, 'ticket_expired'); assert.equal(n, 0);
  } finally { await e.drop(); }
});

test('request mapping: long/short collateral mint, input amount stays in INPUT token atomic units, decrease full/partial/withdraw', opts, async () => {
  const e = await boot({ exec: true }); try {
    let tx = null; e.g.script['/v1/positions/increase'] = () => J(200, { serializedTxBase64: b64(tx.unsigned), positionPubkey: tx.position, quote: {} });
    /* short ETH paid with 0.5 SOL (500000000 lamports, 9 decimals): collateral is USDC, input is SOL, the amount is forwarded unchanged */
    tx = buildTx({ wallet: W.pub, side: 'short', market: 'ETH', input: 'SOL', amount: '500000000' });
    const r = await json(await e.post('/v1/perps/jup/positions/increase', incBody(W.pub, { asset: 'ETH', side: 'short', inputToken: 'SOL', inputTokenAmount: '500000000', leverage: '3.0' })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(e.g.calls.at(-1).body, { asset: 'ETH', inputToken: 'SOL', inputTokenAmount: '500000000', leverage: '3.0', maxSlippageBps: '100', side: 'short', walletAddress: W.pub });
    /* decrease */
    const pos = positionPda({ owner: W.pub, custody: CUSTODY.SOL, collateralCustody: CUSTODY.SOL, side: 'long' }, b58decode, b58encode);
    let dtx = null; e.g.script['/v1/positions/decrease'] = () => J(200, { serializedTxBase64: b64(dtx.unsigned), quote: {} });
    const D = '/v1/perps/jup/positions/decrease';
    for (const [body, build, want] of [
      [{ positionPubkey: pos, receiveToken: 'USDC', entirePosition: true }, { entire: true }, { positionPubkey: pos, receiveToken: 'USDC', entirePosition: true }],
      [{ positionPubkey: pos, receiveToken: 'SOL', sizeUsdDelta: '500000000', maxSlippageBps: '200' }, { sizeDelta: '500000000', input: 'SOL' }, { positionPubkey: pos, receiveToken: 'SOL', sizeUsdDelta: '500000000', maxSlippageBps: '200' }],
      [{ positionPubkey: pos, receiveToken: 'USDC', collateralUsdDelta: '25000000', maxSlippageBps: '200' }, { collDelta: '25000000' }, { positionPubkey: pos, receiveToken: 'USDC', collateralUsdDelta: '25000000', maxSlippageBps: '200' }]]) {
      e.clock.t += 61000; dtx = buildTx({ wallet: W.pub, kind: 'decrease', position: pos, ...build });
      const d = await json(await e.post(D, body)); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.deepEqual(e.g.calls.at(-1).body, want);
    }
    /* partial close for a different amount than asked, or a full close disguised as partial -> refused */
    e.clock.t += 61000; dtx = buildTx({ wallet: W.pub, kind: 'decrease', position: pos, sizeDelta: '900000000' });
    assert.equal((await json(await e.post(D, { positionPubkey: pos, receiveToken: 'USDC', sizeUsdDelta: '500000000' }))).body.reason, 'wrong_size_delta');
    e.clock.t += 61000; dtx = buildTx({ wallet: W.pub, kind: 'decrease', position: pos, entire: true });
    assert.equal((await json(await e.post(D, { positionPubkey: pos, receiveToken: 'USDC', collateralUsdDelta: '25000000' }))).body.reason, 'wrong_collateral_delta');
    e.clock.t += 61000; dtx = buildTx({ wallet: W.pub, kind: 'decrease', position: rnd(), entire: true });
    assert.equal((await json(await e.post(D, { positionPubkey: pos, receiveToken: 'USDC', entirePosition: true }))).body.reason, 'position_mismatch');
  } finally { await e.drop(); }
});

test('code lock: environment flags alone cannot enable execution while the Jupiter contract is unverified', opts, async () => {
  assert.equal(EXECUTE_CONTRACT_VERIFIED, false, 'the shipped build keeps the execution contract unverified');
  const jup = gwJupiter();
  const e = await makeEnv({ jup, env: { RECORDER_ENABLED: '0', PERPS_EXECUTION_ENABLED: '1', GATEWAY_TICKET_SECRET: TKT }, init: false });
  const port = await e.app.start({ port: 0, host: '127.0.0.1' });
  try {
    for (const p of ['/v1/perps/jup/positions/increase', '/v1/perps/jup/positions/decrease', '/v1/perps/jup/execute']) {
      const r = await (await fetch('http://127.0.0.1:' + port + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(incBody()) })).json();
      assert.equal(r.error, 'execution_contract_unverified', p); assert.ok(Array.isArray(r.blockers) && r.blockers.length >= 3);
    }
    assert.equal(jup.g.calls.length, 0);
  } finally { await e.drop(); }
});
