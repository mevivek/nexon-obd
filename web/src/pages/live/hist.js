// The four sparkline buffers, ported from hist/push()/seed() in dashboard_html.h.
//
// HSLOT/HP mirror the firmware's history buffer: 600 slots at 6 s is one hour. The
// board keeps that across restarts and serves it at /history, so the charts have
// shape the moment the page loads instead of starting flat.

/** Slots kept per series. 600 × 6 s = one hour. */
export const HSLOT = 600;
/** Milliseconds per slot. Between slot boundaries the newest value is overwritten. */
export const HP = 6000;
/** The series the board records and this page draws. */
export const HIST_KEYS = ['rpm', 'boost', 'speed', 'coolant'];

/** A fresh set of empty buffers. */
export function emptyHistory() {
  return { rpm: [], boost: [], speed: [], coolant: [] };
}

/**
 * Append or overwrite one sample.
 *
 * Polling runs at ~8 Hz but a slot is 6 s, so all but the first sample in a slot
 * replace it: the chart is a one-hour trace, not the last seventy seconds.
 *
 * Only *fresh* readings are ever passed in — the caller sends null for a held one.
 * Replaying a held value would draw a flat run in the sparkline that the car never
 * actually did, which is the one thing a trend line must not do.
 *
 * @param {number[]} a mutated in place
 * @param {number|null} v
 * @param {boolean} fresh true on the first sample of a new slot
 */
export function pushHist(a, v, fresh) {
  if (v == null || isNaN(v)) return a;
  if (fresh || !a.length) a.push(v);
  else a[a.length - 1] = v;
  if (a.length > HSLOT) a.shift();
  return a;
}

/**
 * Buffers seeded from the board's stored hour, as served by /history.
 *
 * Gaps come back as nulls — the board records an empty slot when a PID did not
 * answer — and a null in a polyline is a hole in the line, so they are dropped here
 * rather than drawn. A missing or malformed series seeds empty instead of throwing:
 * a chart with no history is a cosmetic loss, and the page still has to poll.
 */
export function seedHistory(h) {
  const out = emptyHistory();
  if (!h || typeof h !== 'object') return out;
  for (const k of HIST_KEYS) {
    if (Array.isArray(h[k])) out[k] = h[k].filter((x) => x != null && !isNaN(x)).slice(-HSLOT);
  }
  return out;
}

/**
 * Has the 6 s slot boundary passed?
 * @param {number} now
 * @param {number} hb timestamp of the current slot
 */
export function isFreshSlot(now, hb) {
  return now - hb >= HP;
}
