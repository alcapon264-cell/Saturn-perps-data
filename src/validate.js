/* Observation validation. A price is accepted only if it is a plain positive finite decimal received from the source. */

const DEC = /^\d{1,15}(\.\d{1,18})?$/;

/* -> {ok:true, price} | {ok:false, reason, detail} */
export function parseMarketStats(json, { maxPrice = 1e9 } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'malformed', detail: 'body_not_object' };
  const p = json.price;
  let n;
  if (typeof p === 'number') n = p;
  else if (typeof p === 'string') { if (!DEC.test(p.trim())) return { ok: false, reason: p.trim() === '' ? 'malformed' : (/^-/.test(p.trim()) ? 'non_positive' : 'non_finite'), detail: 'price_string_not_plain_decimal' }; n = Number(p.trim()); }
  else return { ok: false, reason: 'malformed', detail: 'price_missing_or_wrong_type' };
  if (!Number.isFinite(n)) return { ok: false, reason: 'non_finite', detail: 'price_not_finite' };
  if (!(n > 0)) return { ok: false, reason: 'non_positive', detail: 'price_not_positive' };
  if (n > maxPrice) return { ok: false, reason: 'non_finite', detail: 'price_above_sanity_ceiling' };
  return { ok: true, price: n };
}

/* Jump filter. Per market. A price that differs from the last accepted price by more than jumpPct is quarantined.
 * A sustained change is accepted only after `confirm` consecutive samples that agree with each other (within confirmTolPct of the first).
 * Only the confirming sample that completes the run is recorded; the earlier ones stay in perps_rejects as 'jump_pending'
 * (their slots are therefore gaps, never back-filled). */
export function createJumpFilter({ jumpPct = 20, confirm = 3, confirmTolPct = 5 } = {}) {
  let last = null;    /* {price, at} last accepted */
  let pending = [];   /* quarantined samples [{price, at}] */
  const pct = (a, b) => Math.abs(a - b) / b * 100;
  return {
    seed(price, at) { last = { price, at }; pending = []; },
    reset() { last = null; pending = []; },
    get last() { return last; },
    get pendingCount() { return pending.length; },
    /* -> {accept:true} | {accept:false, reason:'jump_pending'|'jump_rejected', pending:n} */
    check(price, at) {
      if (!last) { last = { price, at }; pending = []; return { accept: true, baseline: true }; }
      if (pct(price, last.price) <= jumpPct) { last = { price, at }; pending = []; return { accept: true }; }
      /* a jump beyond the threshold */
      if (pending.length && pct(price, pending[0].price) <= confirmTolPct) pending.push({ price, at });
      else pending = [{ price, at }];
      if (pending.length >= confirm) { last = { price, at }; pending = []; return { accept: true, confirmedJump: true }; }
      return { accept: false, reason: 'jump_pending', pending: pending.length };
    }
  };
}

/* Magnitude plausibility per market. -> {ok:true} | {ok:false, reason:'implausible', detail} */
export function checkPlausible(price, range) {
  if (!range) return { ok: true };
  if (price < range[0] || price > range[1]) return { ok: false, reason: 'implausible', detail: 'price_outside_market_range ' + range[0] + '..' + range[1] };
  return { ok: true };
}
