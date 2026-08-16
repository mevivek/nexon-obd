// Connection status and the scan banner, ported from tick()/st()/scanBar() in
// dashboard_html.h.
//
// The rule this module exists for:
//
//   One failed poll is not "the ECU is gone". A dropped reply happens — the values
//   are held through it anyway — so the status only changes after MISS_MAX
//   consecutive failures. Without this the text flipped between live and "no
//   response" about once a second, which reads as a fault when nothing is wrong.
//
// Kept as a pure step function over the miss counter so that rule can be asserted
// rather than watched for on a test drive.

/** Consecutive failures before the status is allowed to say so. */
export const MISS_MAX = 5;

/** Poll period, matching the firmware page's `setTimeout(tick,120)`. */
export const POLL_MS = 120;

/** Where the samples come from and where the seed comes from. */
export const DATA_URL = '/data';
export const HISTORY_URL = '/history';

/**
 * Advance the status machine by one poll.
 *
 * @param {number} miss consecutive failures so far
 * @param {{failed?: boolean, ok?: boolean, scan?: boolean, held?: number, error?: string}} ev
 *   `failed` is a fetch or parse that threw — the board did not answer at all.
 * @returns {{miss: number, status: {cls: string, text: string}|null,
 *            clearRate: boolean, clearHz: boolean}}
 *   `status: null` means leave the display alone: below the threshold a miss is not
 *   news, and the last good status is still the truest thing on screen.
 */
export function nextStatus(miss, ev = {}) {
  const idle = { status: null, clearRate: false, clearHz: false };

  if (ev.failed) {
    const m = miss + 1;
    // Note the asymmetry with the branch below, carried over as written: an
    // unreachable board leaves the Hz readout showing its last value rather than
    // blanking it. It is the rate the board *was* managing, next to a dot that now
    // says dead, which is more informative than an empty space.
    return m >= MISS_MAX
      ? { ...idle, miss: m, status: { cls: 'dead', text: 'ESP32 unreachable' } }
      : { ...idle, miss: m };
  }

  if (ev.ok) {
    const held = ev.held || 0;
    return {
      ...idle,
      miss: 0,
      status: {
        cls: 'live',
        // Saying how many fields are being held is the difference between a page
        // that looks fine and one that admits two of its gauges are memories.
        text: ev.scan ? 'live · scanning' : held ? 'live · holding ' + held : 'live',
      },
    };
  }

  // A scan owns most of the bus, so /data legitimately has nothing to report. That
  // is not a miss and must not count towards one.
  if (ev.scan) {
    return { ...idle, miss: 0, status: { cls: 'stale', text: 'waiting · scanning' }, clearHz: true };
  }

  const m = miss + 1;
  if (m < MISS_MAX) return { ...idle, miss: m };
  // The trailing window is dropped, not left to decay: whatever rate it held was
  // measured before the link stopped answering and would be quoted as current.
  return {
    ...idle,
    miss: m,
    status: { cls: 'stale', text: ev.error || 'no data' },
    clearRate: true,
    clearHz: true,
  };
}

/**
 * The DID-scan banner's contents.
 *
 * A sweep of the whole identifier space is tens of thousands of requests, so a
 * percentage alone rounds to zero for a long time and reads as "stuck". The counts
 * are what show it moving, so they lead and the percentage follows them.
 */
export function scanInfo(j = {}) {
  const tried = j.scanTried || 0, total = j.scanTotal || 0;
  return {
    on: !!j.scan,
    ecu: j.scanEcu || 'ECM',
    pct: j.scanPct || 0,
    counts: total
      ? tried.toLocaleString() + ' of ' + total.toLocaleString() + ' · ' + (j.scanPct || 0) + '%'
      : '',
  };
}
