/* UTC time math. All instants are integer milliseconds since the Unix epoch; APIs expose unix seconds. */
export const TF_SEC = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 });
export const TFS = Object.freeze(Object.keys(TF_SEC));
export const isTf = x => typeof x === 'string' && Object.prototype.hasOwnProperty.call(TF_SEC, x);
/* bucket start (ms) of the bucket containing tMs. Epoch-aligned, hence UTC-aligned (4h buckets start 00/04/08/12/16/20 UTC). */
export const bucketStartMs = (tMs, tf) => { const w = TF_SEC[tf] * 1000; return Math.floor(tMs / w) * w; };
export const bucketEndMs = (startMs, tf) => startMs + TF_SEC[tf] * 1000;
export const slotMs = (tMs, intervalSec) => { const w = intervalSec * 1000; return Math.floor(tMs / w) * w; };
