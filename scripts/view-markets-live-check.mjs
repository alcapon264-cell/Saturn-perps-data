#!/usr/bin/env node
/* r120 pre-implementation check for the VIEW-ONLY markets. READ-ONLY: three kinds of GET/info reads, nothing is written anywhere.
 * Run it ON THE BACKEND HOST (so it tests that host's region):
 *     COINGECKO_DEMO_KEY=<your free demo key> node scripts/view-markets-live-check.mjs
 * It checks, for HYPE, ZEC, JUP, NEAR, BNB:
 *   1. this host can reach Hyperliquid's public API (meta + allMids), and how long it takes
 *   2. Hyperliquid lists the exact coin name and it is not delisted; allMids has a valid price for it
 *   3. the CoinGecko id returns the expected symbol and name, and its price agrees with Hyperliquid's within 2 %
 * It uses the SAME clients the service uses (src/viewsources.js). The key is sent as a header and never printed.
 * Exit code 0 = every market passed; 1 = at least one failed (the service then simply keeps that market hidden). */
import { VIEW_MARKET_TABLE } from '../src/config.js';
import { createHyperliquidClient, createCoinGeckoClient } from '../src/viewsources.js';

export async function runCheck({ fetchImpl = globalThis.fetch, key = '', markets = Object.keys(VIEW_MARKET_TABLE), mismatchPct = 2 } = {}) {
  const hl = createHyperliquidClient({ fetchImpl });
  const dexes = [...new Set(markets.map(m => VIEW_MARKET_TABLE[m].dex))];
  const ctx = {}, mids = {}, reach = {};
  for (const d of dexes) {
    const label = d || 'main';
    const t0 = Date.now(); const c = await hl.metaAndAssetCtxs(d); reach['hyperliquid_' + label + '_contexts'] = c.ok ? 'ok (' + (Date.now() - t0) + ' ms)' : 'FAILED: ' + c.outcome + (c.status ? ' ' + c.status : '');
    const t1 = Date.now(); const r = await hl.allMids(d); reach['hyperliquid_' + label + '_allMids'] = r.ok ? 'ok (' + (Date.now() - t1) + ' ms)' : 'FAILED: ' + r.outcome + (r.status ? ' ' + r.status : '');
    ctx[d] = c; mids[d] = r;
  }
  let cgRows = null, cgNote = 'skipped (COINGECKO_DEMO_KEY not set)';
  const cgMarkets = markets.filter(m => VIEW_MARKET_TABLE[m].check === 'coingecko');
  if (key && cgMarkets.length) { const cg = createCoinGeckoClient({ fetchImpl, key }); const r = await cg.markets(cgMarkets.map(m => VIEW_MARKET_TABLE[m].coingeckoId)); cgRows = r.ok ? r.rows : null; cgNote = r.ok ? 'ok' : 'FAILED: ' + r.outcome + (r.status ? ' ' + r.status : ''); }
  reach.coingecko = cgNote;
  const rows = markets.map(m => {
    const d = VIEW_MARKET_TABLE[m]; const why = []; const c = ctx[d.dex], md = mids[d.dex];
    const coin = c.ok ? (d.venueCoins.find(n => c.coins.has(n) && !c.coins.get(n).delisted) || d.venueCoins.find(n => c.coins.has(n)) || null) : null;
    const info = coin ? c.coins.get(coin) : null;
    if (!c.ok) why.push('hyperliquid unreachable'); else if (!info) why.push('not listed on Hyperliquid as ' + d.venueCoins.join(' or ')); else if (info.delisted) why.push('delisted on Hyperliquid');
    const raw = md.ok && coin ? md.mids[coin] : undefined;
    const hp = typeof raw === 'string' && /^\d{1,15}(\.\d{1,18})?$/.test(raw) ? Number(raw) : null;
    if (md.ok && info && !(hp > 0)) why.push('no valid allMids price');
    let check = null, diffPct = null;
    if (d.check === 'oracle') {
      check = { source: 'hyperliquid-oracle', oraclePx: info ? info.oraclePx : null, prevDayPx: info ? info.prevDayPx : null };
      if (info && hp > 0 && info.oraclePx > 0) { diffPct = +(Math.abs(hp - info.oraclePx) / info.oraclePx * 100).toFixed(3); if (diffPct > mismatchPct) why.push('mid differs from oracle by ' + diffPct + '%'); }
      else if (info) why.push('no oracle price to check against');
    } else if (cgRows) {
      const x = cgRows.get(d.coingeckoId);
      if (!x) why.push('CoinGecko id ' + d.coingeckoId + ' not found');
      else { check = { source: 'coingecko', symbol: x.symbol, name: x.name, price: x.price };
        if (x.symbol !== d.cgSymbol || x.name !== d.cgName) why.push('CoinGecko id resolves to ' + x.name + ' (' + x.symbol + '), expected ' + d.cgName + ' (' + d.cgSymbol + ')');
        if (hp > 0 && x.price > 0) { diffPct = +(Math.abs(hp - x.price) / x.price * 100).toFixed(3); if (diffPct > mismatchPct) why.push('prices differ by ' + diffPct + '%'); } }
    } else if (key) why.push('CoinGecko unreachable'); else why.push('CoinGecko not checked (no key): the service will list this market as Price unavailable');
    return { market: m, name: d.name, category: d.category, venueCoin: coin, hyperliquidPrice: hp, check, diffPct, result: why.length ? 'PRICE UNAVAILABLE' : 'PASS', reasons: why };
  });
  return { checkedAt: new Date().toISOString(), reach, markets: rows, allPassed: rows.every(r => r.result === 'PASS') };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const out = await runCheck({ key: process.env.COINGECKO_DEMO_KEY || '' });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.allPassed ? 0 : 1);
}
