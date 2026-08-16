// Mileage display, ported from render() in dashboard_html.h.
//
// The board integrates the totals so that closing the page does not lose the drive
// (README, "Mileage"). This module is the display side, where the risk is showing a
// number that is arithmetically correct and completely misleading: an average over
// the first four hundred metres swings by tens of km/L between polls and reads as a
// broken gauge.

import { DASH } from './format.js';

/**
 * How much of a drive there has to be before an average means anything.
 * 0.4 km over 0.02 L is arithmetic, not a mileage.
 */
export const TRIP_MIN_KM = 0.5;
export const TRIP_MIN_L = 0.1;

/**
 * Trip average, km/L, or null while it is still too early to divide.
 * Both thresholds have to pass — a long coast with almost no fuel burned is as
 * misleading as a short one.
 */
export function tripAverage(tripKm, tripL) {
  return (tripKm != null && tripL != null && tripKm >= TRIP_MIN_KM && tripL >= TRIP_MIN_L)
    ? tripKm / tripL
    : null;
}

/**
 * The line under the average: the totals it came from, so the figure can be checked
 * rather than trusted. Before there is enough drive it says *why* it is blank rather
 * than sitting empty, which is the difference between "too early" and "broken".
 */
export function tripNote(tripKm, tripL) {
  if (tripKm == null || tripL == null) return 'this drive';
  const avg = tripAverage(tripKm, tripL);
  return tripKm.toFixed(1) + ' km · ' + tripL.toFixed(2) + ' L'
    + (avg == null ? ' — too early to average' : '');
}

/**
 * Instantaneous km/L — the number the pedal moves.
 *
 * Only meaningful while moving: standing still it is a division by nothing. Both
 * inputs must be fresh, not held, because fuel rate lives in the b2 batch and
 * refreshes half as often as speed (README, "Mileage": "Both inputs or neither").
 */
export function instantMileage(v, q) {
  return (!q.speed && !q.fuelRate && v.speed > 0 && v.fuelRate > 0)
    ? v.speed / v.fuelRate
    : null;
}

/**
 * The line under "Right now". When stopped but still burning, the useful thing to
 * say is not a mileage but that fuel is going nowhere.
 */
export function rateNote(fuelRate, speed) {
  if (fuelRate == null) return '';
  return (fuelRate > 0 && !(speed > 0) ? 'idling · ' : '') + fuelRate.toFixed(2) + ' L/h';
}

/**
 * Both mileage tiles for one merged sample.
 *
 * The average is deliberately *not* gated on staleness: the totals are monotonic and
 * accumulated board-side, so a null in one sample means "not in this reply", never
 * "back to zero". The instantaneous figure is gated, because it is sampled.
 */
export function computeMileage(v, q) {
  const avg = tripAverage(v.tripKm, v.tripL);
  const inst = instantMileage(v, q);
  return {
    avg,
    avgText: avg == null ? DASH : avg.toFixed(1),
    tripNote: tripNote(v.tripKm, v.tripL),
    inst,
    instText: inst == null ? DASH : inst.toFixed(1),
    // Dimmed when either input was held — the figure below is not what the car is
    // doing right now, whatever the arithmetic says.
    instStale: !!(q.speed || q.fuelRate),
    rateNote: rateNote(v.fuelRate, v.speed),
  };
}
