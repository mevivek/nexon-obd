// The rpm dial, ported from arc()/gauge() in dashboard_html.h.
//
// A 270° arc starting at 135° (bottom-left) and ending at 405° (bottom-right), drawn
// twice: a full-sweep track in --base and the filled part in --blue over it. Round
// caps, 9px wide, in a 128-unit box rendered at 116px.

/** Full-scale reading. The car's redline flag lights at 5500 (flags.js). */
export const RPM_FULL = 6500;

/** Geometry, in the 0 0 128 128 user space of the dial's viewBox. */
export const DIAL = { cx: 64, cy: 64, r: 52, start: 135, sweep: 270 };

/**
 * SVG path for a circular arc between two angles in degrees, clockwise.
 *
 * Angles are the usual SVG/canvas convention: 0° points right, and y grows
 * downwards, so 135° is bottom-left and the sweep runs under the dial.
 */
export function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  // The large-arc flag has to be computed rather than fixed: below half sweep the
  // short way round is the correct one, above it the long way. Getting this wrong
  // draws the complement of the reading, which looks plausible and is backwards.
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Track and value paths for a fill fraction.
 *
 * `f || 0` before the clamp, exactly as the firmware has it, and it is load-bearing:
 * a missing rpm divided by RPM_FULL is NaN, `Math.min(1, NaN)` is NaN, and a NaN in a
 * path attribute makes the browser drop the whole path — the dial would empty its
 * *track* as well as its value, which reads as a broken gauge rather than a missing
 * reading.
 *
 * @param {number|null} f 0..1
 * @returns {{track: string, value: string}} value is '' when there is nothing to draw
 */
export function dialPaths(f) {
  const k = Math.max(0, Math.min(1, f || 0));
  const { cx, cy, r, start, sweep } = DIAL;
  return {
    track: arc(cx, cy, r, start, start + sweep),
    // Below a thousandth of full scale the round line-cap alone is a visible blob at
    // the bottom-left of a dial that is reading zero, so draw nothing at all.
    value: k <= 0.001 ? '' : arc(cx, cy, r, start, start + sweep * k),
  };
}

/** Dial fill for an rpm reading. */
export function rpmFraction(rpm) {
  return rpm == null ? 0 : rpm / RPM_FULL;
}
