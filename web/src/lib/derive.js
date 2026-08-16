// Values the ECU does not report, computed from ones it does.
// Ported from render() in dashboard_html.h.

/**
 * Boost, in bar: manifold pressure minus ambient, over 100.
 *
 * There is no boost PID. It is MAP (0B) against barometric (33), which means the
 * derived value is only as fresh as the *staler* of the two — hence the returned
 * `stale` mark ORs both, and everything downstream (the flag gate, the sparkline)
 * uses that rather than either input's own.
 *
 * @returns {{bar: number|null, stale: boolean}}
 */
export function boost(v, q) {
  const bar = (v.map != null && v.baro != null) ? (v.map - v.baro) / 100 : null;
  return { bar, stale: !!(q.map || q.baro) };
}

/**
 * Driver-demanded / actual torque as newton-metres.
 *
 * PIDs 61 and 62 are a percentage of the engine's reference torque, so the N·m are
 * only meaningful once 63 has been read. Shown as a note rather than a headline
 * because the J1979 scaling has not been checked against this car.
 *
 * @returns {string} '' when it cannot be computed — an absent note, not a zero.
 */
export function torqueNm(pct, torqRef, stale) {
  if (pct == null || torqRef == null || stale) return '';
  return (torqRef * pct / 100).toFixed(0) + ' N·m';
}
