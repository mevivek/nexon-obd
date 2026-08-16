// Warning thresholds, ported from render() in dashboard_html.h.
//
// The rule that every function here exists to enforce, from the firmware suite:
//
//   Every threshold compared a raw value, and JS coerces null to 0 — so a *missing*
//   lambda satisfied `v.lambda <= 0.85` and lit "running rich" underneath a blank
//   reading.
//
// So: q[k] marks a field as held rather than freshly read, and every threshold below
// is gated on it. A held reading must never raise a warning, and must never keep one
// lit either, because a stale number cannot tell you whether the engine is still
// overheating.
//
// These functions take (v, q) exactly as merge() returns them and return plain
// descriptors. No DOM: the caller decides what a 'warn' looks like.

/** Every threshold in one place, so a number can be argued with without grepping. */
export const T = {
  RPM_REDLINE: 5500,
  COOLANT_WARN: 103,
  COOLANT_CRIT: 110,
  OIL_WARN: 115,
  OIL_CRIT: 125,
  LAMBDA_LEAN: 1.10,
  LAMBDA_RICH: 0.85,
  TRIM_TOTAL: 20,
  CAT_WARN: 800,
  CAT_CRIT: 900,
  VOLT_LOW: 12.2,
  VOLT_HIGH: 15.2,
};

/** A flag descriptor. `level` is '' | 'warn' | 'crit'. */
const flag = (on, level, text) => ({ on: !!on, level: on ? level : '', text: on ? text : '' });

/** ▲ approaching redline */
export function rpmFlag(v, q) {
  return flag(!q.rpm && v.rpm >= T.RPM_REDLINE, 'warn', '▲ approaching redline');
}

/**
 * Coolant. Two levels: the warning says the engine is running hot, the critical one
 * says stop. Note the value colour is gated on !q too — a dimmed number must not be
 * red as well, or a held reading looks like a live emergency.
 */
export function coolantFlag(v, q) {
  const crit = !q.coolant && v.coolant >= T.COOLANT_CRIT;
  const warn = !q.coolant && v.coolant >= T.COOLANT_WARN;
  return {
    ...flag(warn, crit ? 'crit' : 'warn',
      crit ? '⚠ overheating — stop safely' : '⚠ running hot'),
    valueLevel: crit ? 'crit' : warn ? 'warn' : '',
  };
}

/**
 * Oil temperature. The firmware gates the flag on !q.oil but computes the *value*
 * colour as `q.oil ? '' : ...`, which is the same gate written the other way round.
 * Ported as written rather than tidied, so the two stay comparable line by line.
 */
export function oilFlag(v, q) {
  const on = !q.oil && v.oil >= T.OIL_WARN;
  return {
    ...flag(on, v.oil >= T.OIL_CRIT ? 'crit' : 'warn', '⚠ oil temperature high'),
    valueLevel: q.oil ? '' : v.oil >= T.OIL_CRIT ? 'crit' : v.oil >= T.OIL_WARN ? 'warn' : '',
  };
}

/**
 * Mixture. Lean is the one that damages things, so it colours the value; rich is
 * reported but not escalated. Both are gated on !q.lambda — this is the exact case
 * in the screenshot that started the whole rebuild, where a missing lambda coerced
 * to 0, satisfied `<= 0.85`, and lit "running rich" under a blank gauge.
 */
export function lambdaFlag(v, q) {
  const lean = !q.lambda && v.lambda >= T.LAMBDA_LEAN;
  const rich = !q.lambda && v.lambda <= T.LAMBDA_RICH;
  return {
    ...flag(lean || rich, 'warn', lean ? '⚠ running lean' : '● running rich'),
    valueLevel: lean ? 'warn' : '',
  };
}

/**
 * Fuel trims. Short and long term are summed, because it is the *total* correction
 * the ECU is applying that indicates a leak — a big short-term trim with an opposite
 * long-term one is the system working. Both must be fresh: adding a held trim to a
 * live one produces a total the car never ran.
 */
export function trimFlag(v, q) {
  const on = !q.stft && !q.ltft && Math.abs(v.stft + v.ltft) > T.TRIM_TOTAL;
  return flag(on, 'warn', '⚠ total trim beyond ±20% — check for a leak');
}

/** Catalyst B1S1. */
export function catFlag(v, q) {
  const on = !q.cat && v.cat >= T.CAT_WARN;
  return {
    ...flag(on, v.cat >= T.CAT_CRIT ? 'crit' : 'warn', '⚠ catalyst very hot'),
    valueLevel: q.cat ? '' : v.cat >= T.CAT_CRIT ? 'crit' : v.cat >= T.CAT_WARN ? 'warn' : '',
  };
}

/**
 * Module voltage. Both ends matter: under 12.2 V the alternator is not charging,
 * over 15.2 V it is cooking the battery.
 *
 * The !q gate is load-bearing here in the most literal way — `null < 12.2` is true
 * in JavaScript, so an absent voltage would otherwise permanently report "not
 * charging" on a car whose charging system is fine.
 */
export function voltFlag(v, q) {
  const low = !q.volt && v.volt < T.VOLT_LOW;
  const high = !q.volt && v.volt > T.VOLT_HIGH;
  return {
    ...flag(low || high, 'warn', low ? '⚠ not charging' : '⚠ overcharging'),
    valueLevel: (low || high) ? 'warn' : '',
  };
}

/** Every flag for one sample, keyed the way the firmware ids them. */
export function computeFlags(v, q) {
  return {
    rpm: rpmFlag(v, q),
    coolant: coolantFlag(v, q),
    oil: oilFlag(v, q),
    lambda: lambdaFlag(v, q),
    trim: trimFlag(v, q),
    cat: catFlag(v, q),
    volt: voltFlag(v, q),
  };
}
