// Hold-last-value, ported from merge()/holdMs() in dashboard_html.h.
//
// Why this exists (from the firmware test suite's own preamble):
//
//   /data flags a sample ok as soon as any one of the batched mode-01 requests
//   answers, so a partial poll arrives with nulls in it. render() wrote every field
//   unconditionally and null became an em-dash, so gauges that had been reading fine
//   went blank.
//
// So a field that arrives empty is re-shown from the last known value for a while,
// dimmed, and marked held. After the window it reverts to '—' rather than showing
// something indefinitely stale as though it were live.

/**
 * Floor of the hold window. Below this, a field that simply has not come round yet
 * blinks to an em-dash between updates that are working perfectly well.
 */
export const HOLD_FLOOR_MS = 2500;

/**
 * Ceiling. Past this a genuinely dead field would look alive, which is worse than
 * a blank one.
 */
export const HOLD_CEIL_MS = 15000;

/** How many observed sample intervals a value may be held for. */
export const HOLD_SAMPLES = 4;

/** Minimum timestamps needed before the observed rate means anything. */
export const HOLD_MIN_SAMPLES = 3;

/**
 * How long a value may be re-shown, scaled to how fast samples are actually
 * arriving.
 *
 * A fixed window is wrong for the same reason it was wrong on the board: over BLE a
 * sample can be seconds apart, and holding for less than a few samples means fields
 * blink to an em-dash between updates that are fine. Over CAN they arrive ten times
 * a second and the floor is what applies.
 *
 * @param {number[]} rate trailing sample timestamps, oldest first
 */
export function holdWindowMs(rate) {
  if (rate.length < HOLD_MIN_SAMPLES) return HOLD_FLOOR_MS;
  const d = (rate[rate.length - 1] - rate[0]) / (rate.length - 1);
  return Math.max(HOLD_FLOOR_MS, Math.min(HOLD_CEIL_MS, d * HOLD_SAMPLES));
}

/**
 * Stateful merger. One per page: it remembers the last good value of every field it
 * has ever seen.
 *
 * @param {{now?: () => number, rate?: number[]}} opts
 *   `now` is injectable so tests can walk the clock past the hold window without
 *   sleeping; `rate` is the same array the Hz readout appends to, shared by
 *   reference so the hold window tracks the observed sample rate for free.
 */
export function createHold({ now = Date.now, rate = [] } = {}) {
  // Last known value and its arrival time, per field.
  const keep = Object.create(null);

  /**
   * @param {Record<string, number|null>} j the `v` object out of /data
   * @returns {[Record<string, number|null>, Record<string, 0|1>, number]}
   *   values, held-marks, and how many are being held (the header says so).
   */
  function merge(j) {
    const t = now(), v = {}, q = {}, w = holdWindowMs(rate);
    let held = 0;
    for (const k in j) {
      const x = j[k];
      // `x != null && !isNaN(x)` — note that this admits 0. A zero road speed is a
      // reading, not an absence, and treating it as absent was its own bug.
      if (x != null && !isNaN(x)) {
        keep[k] = { v: x, t };
        v[k] = x;
        q[k] = 0;
      } else if (keep[k] && t - keep[k].t <= w) {
        v[k] = keep[k].v;
        q[k] = 1;
        held++;
      } else {
        // Never seen, or held for long enough. Either way there is nothing honest
        // left to show.
        v[k] = null;
        q[k] = 1;
      }
    }
    return [v, q, held];
  }

  return { merge, holdMs: () => holdWindowMs(rate), rate, keep };
}
