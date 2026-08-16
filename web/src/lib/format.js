// Number formatting, ported verbatim from dashboard_html.h.
//
// Every one of these has to answer the same question the same way the firmware
// dashboard does: what does a *missing* value look like? The answer is an em-dash,
// never a zero — README, "Trip logs": "empty cells rather than zeros where a value
// was not read — so a gap is a gap, not a reading of nought."

/** What every gauge shows when there is nothing to show. */
export const DASH = '—';

/**
 * Fixed-decimal formatter. `const n=(v,d=1)=>(v==null||isNaN(v))?'—':Number(v).toFixed(d)`
 *
 * The isNaN check is not redundant with the null check: a batch that timed out can
 * publish NaN as readily as null, and NaN.toFixed(1) is the string "NaN" on a gauge.
 */
export function n(v, d = 1) {
  return (v == null || isNaN(v)) ? DASH : Number(v).toFixed(d);
}

/**
 * Whole numbers — rpm, speed, temperatures. `v==null?'—':Math.round(v)`
 *
 * The firmware wrote the *number* into textContent and let the DOM stringify it;
 * here it is stringified up front so the lib has no DOM-shaped edges.
 */
export function round(v) {
  return (v == null || isNaN(v)) ? DASH : String(Math.round(v));
}

/**
 * Fuel trims. A trim is only meaningful with its sign, and a positive one has to
 * carry the plus explicitly or +8 % and -8 % differ by one glyph at arm's length.
 * Note the firmware gates on `!= null` only and lets n() catch NaN; kept as-is.
 */
export function signed(v, d = 1) {
  return v == null ? DASH : (v > 0 ? '+' : '') + n(v, d);
}

/**
 * Boost, in bar. Zero and above get an explicit plus, because the interesting fact
 * about this gauge is which side of atmospheric the manifold is on.
 */
export function boostText(b) {
  return b == null ? DASH : (b >= 0 ? '+' : '') + b.toFixed(2);
}

/** Engine run time (PID 1F), seconds to `1h 4m 07s`. */
export function hhmmss(s) {
  if (s == null || isNaN(s)) return DASH;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), q = Math.floor(s % 60);
  return (h ? h + 'h ' : '') + m + 'm ' + String(q).padStart(2, '0') + 's';
}
