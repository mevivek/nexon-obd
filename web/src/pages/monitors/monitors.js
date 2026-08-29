// Mode 06 monitor decoding, ported from the <script> in firmware/Obdurate/mon_html.h.
//
// The page's whole claim is that pass and headroom are readable *without* knowing
// the units: a test passes when its value sits inside its own limits, and the bar
// shows where in that window it sits. So the two things that must stay honest here
// are (a) never inventing a name for an id that J1979 does not pin down, and (b)
// never converting a value whose scaling this firmware does not decode.

import { n, DASH } from '../../lib/format.js';

/** How often /mon is re-read while the page is open. Firmware: setInterval(poll,2000). */
export const MON_POLL_MS = 2000;

// Only the monitor ids that are unambiguous in J1979 are named. Anything else keeps
// its raw id rather than being given a label that might be wrong.
export const NAMES = {
  '01': 'O2 sensor B1S1', '02': 'O2 sensor B1S2', '03': 'O2 sensor B1S3',
  '04': 'O2 sensor B1S4', '05': 'O2 sensor B2S1', '06': 'O2 sensor B2S2',
  '07': 'O2 sensor B2S3', '08': 'O2 sensor B2S4', '21': 'Catalyst bank 1',
  '22': 'Catalyst bank 2', 'A0': 'Misfire general', 'A1': 'Misfire cylinder 1',
  'A2': 'Misfire cylinder 2', 'A3': 'Misfire cylinder 3', 'A4': 'Misfire cylinder 4',
};

// Only the plain decimal multipliers are decoded. The rest of the scaling table is
// not reproduced here, so those values stay raw and say so.
export const UAS = { '01': 1, '02': 0.1, '03': 0.01, '04': 0.001 };

/** J1979 name for a monitor id, or the raw id — never a guess. */
export function monName(mid) {
  return NAMES[mid] || ('Monitor ' + mid);
}

/**
 * A monitor value in whatever terms the firmware can honestly state it.
 *
 * An undecoded unit-and-scaling id gets `<raw> raw` rather than a number in units
 * it cannot vouch for. Decimals follow the multiplier, so x0.01 shows two places
 * rather than three.
 *
 * Absent values are an em-dash, the house rule from lib/format.js — the firmware
 * would have printed "NaN raw" here, which reads as a reading rather than a gap.
 */
export function monFmt(raw, uas) {
  if (raw == null || isNaN(raw)) return DASH;
  const m = UAS[uas];
  if (!m) return raw + ' raw';
  return n(raw * m, m >= 1 ? 0 : Math.round(-Math.log10(m)));
}

/**
 * Where a value sits inside its own limits.
 *
 * `pos` is unit-free (percent across the window) and so is always meaningful, which
 * is the point of the bar. `head` is the distance to the *nearest* limit, because a
 * pass with almost no headroom is the thing this page exists to make visible long
 * before it becomes a fault code.
 *
 * A record with no usable window (hi <= lo) still reports pass/fail — the ECU's own
 * verdict on a degenerate window is all there is — but parks the marker rather than
 * dividing by zero.
 *
 * @returns {{span:number, pass:boolean, pos:number, head:number}}
 */
export function monWindow(r) {
  const lo = r.lo, hi = r.hi, v = r.v, span = hi - lo;
  const pass = v >= lo && v <= hi;
  const pos = span > 0 ? Math.max(0, Math.min(100, 100 * (v - lo) / span)) : (pass ? 50 : 0);
  const head = span > 0 ? Math.max(0, Math.min(v - lo, hi - v)) / span * 100 : 0;
  return { span, pass, pos, head };
}

/** The note under each tile: headroom, or why there is none to state. */
export function monNote(r) {
  const { span, head } = monWindow(r);
  return (span > 0 ? head.toFixed(0) + '% of the window from the nearest limit'
                   : 'no usable limits reported');
}

/**
 * Header dot and wording.
 *
 * "discovering…" is not an error state: the board finds which monitors exist before
 * it can read any, so an empty list with ready=false is the normal first few
 * seconds, not a failure. Only an unreachable board goes red.
 *
 * @param {object|null} j last /mon payload, or null before the first one lands
 * @param {boolean} err whether the last fetch threw
 */
export function monStatus(j, err) {
  if (err) return { dot: 'dot dead', text: 'ESP32 unreachable' };
  if (!j) return { dot: 'dot', text: 'reading…' };
  const c = (j.recs || []).length;
  return {
    dot: c ? 'dot live' : 'dot',
    text: j.ready ? (c ? c + ' results' : 'no monitors reported') : 'discovering…',
  };
}
