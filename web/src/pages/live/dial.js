// The rpm gauge, ported from arc()/gauge() in dashboard_html.h and then reshaped.
//
// It was a 270° dial 116px across, sitting beside the speed in its own tile. It is
// now a 180° sweep spanning the full width of the plate with the speed numeral
// inside it: rpm is the arc, speed is the figure it arcs over. One instrument
// instead of two competing ones, and the numeral gets the whole width of the
// screen rather than a third of it.
//
// The drawing code did not change — `arc()` is the firmware's, unchanged, and the
// NaN guard in dialPaths() is the firmware's reason as well. Only DIAL moved.

import { T } from '../../lib/flags.js';

/** Full-scale reading. The car's redline flag lights at 5500 (flags.js). */
export const RPM_FULL = 6500;

/**
 * Geometry, in the user space of the gauge's viewBox.
 *
 * A half-turn from 180° (due left) clockwise to 360° (due right), passing through
 * 270°, which is straight up in SVG's y-down space. `cy` sits low in the box
 * because only the top half of the circle is drawn.
 */
export const DIAL = { cx: 157, cy: 152, r: 132, start: 180, sweep: 180 };

/** The viewBox the paths above are drawn for, so no caller has to restate it. */
export const VIEW = { w: 314, h: 166 };

/**
 * SVG path for a circular arc between two angles in degrees, clockwise.
 *
 * Angles are the usual SVG/canvas convention: 0° points right, and y grows
 * downwards, so 180° is due left and the sweep runs over the top.
 */
export function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  // The large-arc flag has to be computed rather than fixed: below half sweep the
  // short way round is the correct one, above it the long way. Getting this wrong
  // draws the complement of the reading, which looks plausible and is backwards.
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Where the redline band starts, as a fraction of full scale. */
export const REDLINE_FRACTION = T.RPM_REDLINE / RPM_FULL;

/**
 * Track, redline band and value paths for a fill fraction.
 *
 * `f || 0` before the clamp, exactly as the firmware has it, and it is load-bearing:
 * a missing rpm divided by RPM_FULL is NaN, `Math.min(1, NaN)` is NaN, and a NaN in a
 * path attribute makes the browser drop the whole path — the gauge would empty its
 * *track* as well as its value, which reads as a broken gauge rather than a missing
 * reading.
 *
 * `redline` is drawn over the track and under the value, so the band shows where the
 * reading is heading and the reading covers it once it gets there. It is constant —
 * returned per call only so a caller never has to know the geometry to place it.
 *
 * @param {number|null} f 0..1
 * @returns {{track: string, redline: string, value: string}} value is '' when there
 *   is nothing to draw
 */
export function dialPaths(f) {
  const k = Math.max(0, Math.min(1, f || 0));
  const { cx, cy, r, start, sweep } = DIAL;
  return {
    track: arc(cx, cy, r, start, start + sweep),
    redline: arc(cx, cy, r, start + sweep * REDLINE_FRACTION, start + sweep),
    // Below a thousandth of full scale the round line-cap alone is a visible blob at
    // the left-hand end of a gauge that is reading zero, so draw nothing at all.
    value: k <= 0.001 ? '' : arc(cx, cy, r, start, start + sweep * k),
  };
}

/** Gauge fill for an rpm reading. */
export function rpmFraction(rpm) {
  return rpm == null ? 0 : rpm / RPM_FULL;
}
