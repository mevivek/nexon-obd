// The watched-identifier traces: what goes into a sparkline, and where the line
// is drawn. Ported from the history block and `spark()` in watch_html.h.

/** Points kept per identifier. At one reading a second that is two and a half minutes. */
export const MAX_PTS = 150;

/**
 * Push one point per *reading*, not per poll.
 *
 * The page polls at 700 ms while an identifier in a set of four is read once every
 * four periods, so pushing on every poll would draw each value four or five times
 * over. The trace that comes out is a staircase, and every step in it is a fact
 * about the polling interval rather than about the car — which is the opposite of
 * what the page is for.
 *
 * A reading is new when its `age` has *dropped*: age counts up from the moment the
 * reply landed, so it only ever falls when a fresh reply has replaced it. The first
 * point for an identifier has no previous age to compare against, hence the
 * empty-series case (`d.age < undefined` is false, and would otherwise never let a
 * trace start).
 *
 * Mutates `hist` and `age` in place — they live in refs across polls, and copying
 * 150-point arrays every 700 ms to no end would be the only allocation on this page
 * that scales with time.
 *
 * @param {Object} hist  name -> array of values, mutated
 * @param {Object} age   name -> last seen age in ms, mutated
 * @param {Array}  dids  the `dids` array from /watch/list
 */
export function pushReadings(hist, age, dids, maxPts = MAX_PTS) {
  for (const d of dids || []) {
    if (d.len && d.fresh) {
      const a = hist[d.name] || (hist[d.name] = []);
      if (!a.length || d.age < age[d.name]) {
        a.push(d.val);
        if (a.length > maxPts) a.shift();
      }
    }
    age[d.name] = d.age;
  }
  return hist;
}

/**
 * The polyline for one trace, auto-scaled to its own range.
 *
 * Auto-scaled because the whole point of watching an unknown identifier is that
 * nobody knows what range it lives in — a fixed axis would flatten most of them to
 * a straight line. A flat series would divide by zero, so it is given an artificial
 * span of 1 and drawn along the bottom, which is the honest picture of a value that
 * is not moving.
 *
 * The firmware measured the element and set a matching viewBox so the geometry was
 * 1:1. Here the width is nominal and `preserveAspectRatio="none"` stretches it:
 * the points are evenly spaced in x, so a uniform horizontal scale is the same
 * shape, and the page does not have to read layout back out of the DOM to draw.
 *
 * @returns {string} a `points` attribute, or '' when there is nothing to draw yet
 */
export function sparkPoints(d, w = 220, h = 26, p = 3) {
  if (!d || d.length < 2) return '';
  let lo = Math.min(...d), hi = Math.max(...d);
  if (hi - lo < 1e-6) hi = lo + 1;
  const dx = w / (d.length - 1);
  return d
    .map((v, i) => `${(i * dx).toFixed(1)},${(p + (h - 2 * p) * (1 - (v - lo) / (hi - lo))).toFixed(1)}`)
    .join(' ');
}
