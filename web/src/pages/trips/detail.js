// One recorded drive, read back out of its own CSV.
//
// The board already serves the file — /trips/get?f=<name> streams it — and
// triplog.h writes everything this needs, so nothing here asks the firmware for a
// new endpoint. In particular `trip_km` and `trip_l` are *integrated on the board*,
// which triplog.h says outright: "a row carries the drive's totals and km/L over
// any span of the file can be recovered by differencing two rows." So the summary
// is two rows subtracted, not thirty-six hundred rows accumulated, and it cannot
// drift from what the Live page showed while the drive was happening.
//
// No DOM in here, like every other pages/<x>/<y>.js: it takes text and returns
// numbers, and the component decides what a trace looks like.

import { tripAverage } from '../../lib/mileage.js';
import { boost } from '../../lib/derive.js';

/**
 * Parse a trip CSV.
 *
 * The shape, from triplog.h:
 *
 *   # nexonobd 1.11.3 trip 29 started_epoch_ms=... clock=set
 *   epoch_ms,uptime_ms,rpm,speed,map_kpa,...            <- 2 + TRIP_NCOLS + watched
 *   1756...,41000,1873,42,118,...
 *
 * Columns are read from the header rather than by position, because the trailing
 * watch-set columns are variable and TRIP_COLS itself can grow: a series pinned to
 * an index would silently start plotting the column next to the one it named.
 *
 * @param {string} text
 * @returns {{meta: object, columns: string[], rows: Array<Array<number|null>>,
 *            skipped: number}}
 */
export function parseTripCsv(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const meta = { fw: null, seq: null, startedMs: null, clock: null };
  let i = 0;

  // The metadata comment, if it is there. A file rotated mid-drive has one too.
  if (lines[i] != null && lines[i].startsWith('#')) {
    const h = lines[i];
    const fw = h.match(/nexonobd\s+(\S+)/);
    const seq = h.match(/trip\s+(\d+)/);
    const started = h.match(/started_epoch_ms=(-?\d+)/);
    const clock = h.match(/clock=(\S+)/);
    if (fw) meta.fw = fw[1];
    if (seq) meta.seq = Number(seq[1]);
    if (started) meta.startedMs = Number(started[1]);
    if (clock) meta.clock = clock[1];
    i++;
  }

  const head = lines[i];
  if (!head || !head.includes(',')) return { meta, columns: [], rows: [], skipped: 0 };
  const columns = head.split(',').map((c) => c.trim());
  i++;

  const rows = [];
  let skipped = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;                       // trailing newline, and blank lines
    const cells = line.split(',');
    // A torn row is expected, not exceptional: the board flushes every ten seconds
    // and the ignition can cut between one flush and the next, so the last line of
    // a real file is regularly half-written. Counting them and dropping them is
    // honest; padding them would invent readings at the exact moment power was lost.
    if (cells.length !== columns.length) { skipped++; continue; }
    rows.push(cells.map((c) => {
      const s = c.trim();
      // An absent reading stays absent. triplog.h writes an empty cell rather than
      // a zero for exactly this reason, and turning it into 0 here would undo that
      // — the same trap flags.js exists to avoid.
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }));
  }
  return { meta, columns, rows, skipped };
}

/** Read one column out of a parsed file, by name. Missing column -> all nulls. */
export function series(parsed, name) {
  const i = parsed.columns.indexOf(name);
  if (i < 0) return [];
  return parsed.rows.map((r) => r[i]);
}

/** First and last values in a column that are actually present. */
function ends(values) {
  let first = null, last = null;
  for (const v of values) {
    if (v == null) continue;
    if (first === null) first = v;
    last = v;
  }
  return [first, last];
}

const span = (values) => {
  const [a, b] = ends(values);
  return a == null || b == null ? null : b - a;
};

const maxOf = (values) => {
  let m = null;
  for (const v of values) if (v != null && (m === null || v > m)) m = v;
  return m;
};

/**
 * What the drive came to.
 *
 * Duration comes from `uptime_ms`, not `epoch_ms`, and that is the whole reason
 * both columns exist: the board has no clock of its own and learns the time from
 * whichever page you open, so a drive that starts before you open one carries an
 * unset wall clock for its first rows. Uptime is always real. The wall clock is
 * still reported, flagged, for the times it can be trusted.
 *
 * @returns {{km: number|null, litres: number|null, kmPerL: number|null,
 *            seconds: number|null, rows: number, maxSpeed: number|null,
 *            maxRpm: number|null, peakCoolant: number|null, peakOil: number|null,
 *            clockSet: boolean}}
 */
export function tripSummary(parsed) {
  const km = span(series(parsed, 'trip_km'));
  const litres = span(series(parsed, 'trip_l'));
  const ms = span(series(parsed, 'uptime_ms'));
  return {
    km,
    litres,
    // Reused rather than reimplemented: mileage.js already owns the rule about how
    // little of a drive is too little to divide, and the Live page's tile is the
    // number this has to agree with.
    kmPerL: tripAverage(km, litres),
    seconds: ms == null ? null : Math.round(ms / 1000),
    rows: parsed.rows.length,
    maxSpeed: maxOf(series(parsed, 'speed')),
    maxRpm: maxOf(series(parsed, 'rpm')),
    peakCoolant: maxOf(series(parsed, 'coolant_c')),
    peakOil: maxOf(series(parsed, 'oil_c')),
    clockSet: parsed.meta.clock === 'set',
  };
}

/**
 * Boost for every row, in bar.
 *
 * There is no boost column, and there is no boost PID either — it is MAP against
 * barometric, which is why derive.js owns the arithmetic. Recomputing it here with
 * a `/100` of its own would be a second definition of a derived value that already
 * has one, and the two would drift the first time either was corrected.
 */
export function boostSeries(parsed) {
  const map = series(parsed, 'map_kpa');
  const baro = series(parsed, 'baro_kpa');
  if (!map.length || !baro.length) return [];
  return map.map((m, i) => boost({ map: m, baro: baro[i] }, {}).bar);
}

/** How many points a trace is reduced to before it is drawn. */
export const TRACE_POINTS = 300;

/**
 * Bucket a column down to something a phone can draw.
 *
 * A file runs to TRIP_MAX_BYTES (512 KB) at roughly 140 bytes a row, so a long
 * drive is three or four thousand points going into a trace a few hundred pixels
 * wide. Averaging each bucket would be the obvious reduction and the wrong one: it
 * flattens exactly the events worth keeping. A four-second coolant spike averaged
 * against eleven ordinary samples disappears, and a trace that hides an overheat is
 * worse than no trace.
 *
 * So each bucket contributes its own minimum and maximum, in the order they
 * occurred, which preserves the envelope. The output is at most 2×TRACE_POINTS and
 * is drawn as a single line — the peaks stay, the sample count does not.
 *
 * @param {Array<number|null>} values
 * @param {number} target
 * @returns {number[]} nulls dropped; an all-null column returns []
 */
export function downsample(values, target = TRACE_POINTS) {
  const present = values.filter((v) => v != null);
  if (present.length <= target * 2) return present;

  const size = Math.ceil(present.length / target);
  const out = [];
  for (let i = 0; i < present.length; i += size) {
    let lo = Infinity, hi = -Infinity, loAt = i, hiAt = i;
    for (let j = i; j < i + size && j < present.length; j++) {
      const v = present[j];
      if (v < lo) { lo = v; loAt = j; }
      if (v > hi) { hi = v; hiAt = j; }
    }
    // In the order they happened, so the line does not zigzag backwards through
    // time inside a bucket.
    if (loAt <= hiAt) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}

/** hh:mm:ss for a drive, or mm:ss for a short one. Null stays null. */
export function durationText(seconds) {
  if (seconds == null) return null;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}
