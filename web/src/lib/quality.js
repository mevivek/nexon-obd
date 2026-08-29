// The board's own account of how well it is reading the car — the `q` block in
// /data, decoded for display.
//
// Why this exists at all. Every other readout on this page is a number the ECU
// sent; these are numbers about the reading itself, and until the firmware started
// emitting them they only ever went to the serial log, where nobody sitting in a
// car can see them. The gap that leaves is the one every OBD tool in this category
// has: a page renders values at whatever rate it polls, and nothing anywhere says
// how fast they are genuinely arriving. Set a tenth-of-a-second logging interval
// against a link managing two samples a second and the log looks the same — every
// row full, every value plausible, most of them the previous row repeated.
//
// So the rate is stated. Two numbers make it honest rather than decorative:
//
//   - The board's achieved rate, not the page's. The page's fetch loop is capped by
//     POLL_MS and can only ever observe a rate at or below the one the board is
//     actually publishing, so quoting the page's would understate a healthy link and
//     could never overstate a sick one.
//   - The stalest batch. A published sample carries whichever batches are still
//     fresh, so an overall rate can look fine while one batch is minutes behind —
//     which is exactly the BLE case the firmware's own staleness window was written
//     for. The average hides it; the worst batch does not.
//
// Nothing here invents a value. An unknown rate is null and renders as nothing,
// never as 0.0 Hz — a rate of zero is a claim about the link, and "not measured
// yet" is not that claim.

/** Batch names in the order the firmware emits `bAge`, matching SAMPLE_ORDER's ids. */
export const BATCHES = ['b1', 'b2', 'b3', 'b4'];

/** What each batch carries, for a readout that names it. Kept short: this is a chip. */
export const BATCH_CARRIES = {
  b1: 'rpm, speed, boost',
  b2: 'oil, volts, trims',
  b3: 'lambda, catalyst',
  b4: 'pedal, torque',
};

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * The board's achieved published-sample rate, or null before a pass has been timed.
 *
 * Null and zero are kept apart deliberately. The firmware sends null until it has
 * measured a full SAMPLE_ORDER pass, and a rate that is not yet known must not
 * render as a rate of nothing — that would read as a dead bus during the first
 * second of every drive.
 */
export function boardHz(q) {
  return q ? num(q.hz) : null;
}

/**
 * The batch furthest behind.
 *
 * Returns `{ name, ageMs, expired, never }`, or null when there is nothing to say.
 * `never` marks a batch that has not answered once since boot, which is a different
 * thing from one that answered and went quiet — the first is usually a PID the ECU
 * does not support, the second is a link going bad, and collapsing them into a
 * large age would present the first as the second.
 */
export function stalest(q) {
  const ages = q && Array.isArray(q.bAge) ? q.bAge : null;
  if (!ages || !ages.length) return null;

  // A batch that has never answered outranks any age: it is the stronger statement.
  const neverIdx = ages.findIndex((a) => a === null || a === undefined);
  if (neverIdx >= 0) {
    return { name: BATCHES[neverIdx] || 'b?', ageMs: null, expired: true, never: true };
  }

  let worst = -1, worstAge = -1;
  ages.forEach((a, i) => {
    const v = num(a);
    if (v !== null && v > worstAge) { worstAge = v; worst = i; }
  });
  if (worst < 0) return null;

  // Expired against the board's own window, not a constant. That window is derived
  // from the measured cycle time, so on BLE it is legitimately much wider than on
  // CAN and a fixed threshold here would flag a healthy slow link as broken.
  const window = num(q.staleMs);
  return {
    name: BATCHES[worst] || 'b?',
    ageMs: worstAge,
    expired: window !== null && worstAge > window,
    never: false,
  };
}

/** `1.6 s`, `840 ms` — an age at the precision it deserves and no more. */
export function ageText(ms) {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
}

/**
 * The status line's quality half: `1.56 Hz · b2 1.3 s`.
 *
 * The stalest batch is named only when it has actually expired. Every batch is
 * always somewhat behind — b2 and b3 come round once every four turns by design —
 * so reporting the worst one unconditionally would put a permanent complaint on a
 * page where nothing is wrong.
 */
export function qualityText(q) {
  const parts = [];
  const rate = boardHz(q);
  if (rate !== null) parts.push(rate.toFixed(2) + ' Hz');

  const worst = stalest(q);
  if (worst && worst.expired) {
    parts.push(worst.never ? worst.name + ' silent' : worst.name + ' ' + ageText(worst.ageMs));
  }

  if (q && q.share) parts.push('sharing with scan');
  return parts.join(' · ');
}

/**
 * Is the page observing fewer samples than the board is publishing?
 *
 * Worth knowing because the two have different causes and different fixes: the board
 * being slow is the car or the link, the page being slow is POLL_MS or a browser
 * throttling a backgrounded tab. Only reported past a margin, since the page's own
 * measurement is a trailing window over a handful of samples and will not sit
 * exactly on the board's figure even when nothing is wrong.
 */
export function pageIsBehind(board, page, margin = 0.75) {
  if (board === null || page === null) return false;
  if (board <= 0 || page <= 0) return false;
  return page < board * margin;
}
