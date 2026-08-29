// The centre-zero bar behind the boost reading.
//
// "+0.42 bar" on its own does not say which side of atmospheric you are on, and that
// is the only thing the number is for: on the overrun this engine sits at −0.6 and
// under load it pulls past +1.0, and those are opposite situations that read as the
// same kind of figure. So the bar grows from a fixed zero mark — right for boost,
// left for vacuum — and the direction is visible before the digits are.
//
// Geometry only. It takes a number and returns percentages; what a bar looks like is
// the stylesheet's business.

/**
 * The scale, in bar relative to atmospheric.
 *
 * The floor is a real physical limit, not a guess: boost is (MAP − barometric)/100,
 * so a manifold pulled to a perfect vacuum reads −1.0 at sea level and nothing can
 * go below it. The ceiling is this engine's, with headroom — the 1.2 petrol runs
 * about 1.0 bar peak, and a bar that pegs at the exact peak cannot show an overboost.
 */
export const BOOST_MIN = -1.0;
export const BOOST_MAX = 1.2;

/** Where zero sits along the track, 0..1. */
export const ZERO_AT = -BOOST_MIN / (BOOST_MAX - BOOST_MIN);

/**
 * Track position for a boost reading.
 *
 * Returns `null` for a missing reading rather than a zero-width bar at the zero
 * mark: absent and "exactly atmospheric" are different states, and drawing the
 * second for the first is the same class of bug as `null` coercing to 0 in flags.js.
 *
 * @param {number|null|undefined} bar
 * @returns {{left: number, width: number}|null} percentages
 */
export function boostBar(bar) {
  if (bar == null || Number.isNaN(bar)) return null;
  const k = Math.max(0, Math.min(1, (bar - BOOST_MIN) / (BOOST_MAX - BOOST_MIN)));
  const zero = ZERO_AT;
  // Drawn from whichever end is nearer zero, so the same code covers both
  // directions and the bar never has a negative width.
  return { left: Math.min(zero, k) * 100, width: Math.abs(k - zero) * 100 };
}
