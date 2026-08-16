// Sample-rate readout, ported from hz() in dashboard_html.h.
//
// Rate over a trailing window. The old reading averaged over the whole page
// lifetime, so it sagged after any rough patch and never recovered — it looked like
// the refresh was degrading long after it had.

/** How many sample timestamps the trailing window keeps. */
export const RATE_WINDOW = 20;

/**
 * Formatted rate, e.g. `· 8.3 Hz`, or '' when there is not enough to divide by.
 * @param {number[]} rate trailing sample timestamps in ms, oldest first
 */
export function hz(rate) {
  if (rate.length < 2) return '';
  const d = (rate[rate.length - 1] - rate[0]) / 1000;
  return d > 0 ? '· ' + ((rate.length - 1) / d).toFixed(1) + ' Hz' : '';
}

/** Numeric samples-per-second, or null. The display form is hz(). */
export function rateHz(rate) {
  if (rate.length < 2) return null;
  const d = (rate[rate.length - 1] - rate[0]) / 1000;
  return d > 0 ? (rate.length - 1) / d : null;
}

/**
 * Record a *published sample*, not a fetch.
 *
 * /data serves a cached sample, so the same one can be fetched several times and
 * must not inflate the rate — the caller gates this on `j.seq !== lastSeq`.
 * Mutates and returns `rate` so it stays the one array the hold window reads.
 */
export function pushSample(rate, t) {
  rate.push(t);
  if (rate.length > RATE_WINDOW) rate.shift();
  return rate;
}
