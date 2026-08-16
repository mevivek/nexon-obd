// Sparkline geometry, ported from spark() in dashboard_html.h.
//
// Twenty-six pixels of chart under a number that is already the point of the tile.
// It exists to answer one question — is this rising or falling — so it has no axes,
// no ticks, no legend and no interaction, and the whole of it is one polyline.
//
// The firmware measured the element (`e.clientWidth||220`) and wrote a viewBox to
// match, so the user-space scale was 1:1. Here the width is a constant and the SVG
// stretches to the tile with preserveAspectRatio="none". The drawn shape is
// identical — x is scaled uniformly either way — and the stroke stays 2px because
// vector-effect="non-scaling-stroke" is carried over with it. What it buys is a pure
// function: no layout read, nothing to measure, nothing to do on resize.

/** User-space width. Arbitrary — the viewBox is stretched to the tile. */
export const SPARK_W = 220;
/** Matches .spark's 26px height in the shared stylesheet. */
export const SPARK_H = 26;
/** Breathing room top and bottom, so a peak is not clipped by the tile edge. */
export const SPARK_PAD = 3;

/**
 * Points for one sparkline, or null when there is not enough to draw a line.
 *
 * @param {Array<number>} d oldest first
 * @param {boolean} zeroBase pin the floor at zero.
 *   Speed and rpm use it because a car idling between 780 and 810 rpm should read as
 *   flat, not as a mountain range; boost and coolant do not, because their whole
 *   interest is a few degrees or a tenth of a bar of movement.
 * @returns {{points: string, viewBox: string}|null}
 */
export function sparkPath(d, zeroBase) {
  if (!d || d.length < 2) return null;
  let lo = Math.min(...d), hi = Math.max(...d);
  if (zeroBase) lo = Math.min(0, lo);
  // A dead-flat run has no range to divide by; give it one and it draws a
  // centre line rather than a NaN.
  if (hi - lo < 1e-6) hi = lo + 1;
  const dx = SPARK_W / (d.length - 1);
  const span = SPARK_H - 2 * SPARK_PAD;
  const points = d
    .map((v, i) => `${(i * dx).toFixed(1)},${(SPARK_PAD + span * (1 - (v - lo) / (hi - lo))).toFixed(1)}`)
    .join(' ');
  return { points, viewBox: `0 0 ${SPARK_W} ${SPARK_H}` };
}
