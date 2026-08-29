// Trip-log list arithmetic, ported from the <script> in firmware/Obdurate/trip_html.h.
//
// The board records a CSV row a second to its own filesystem while the ECU is
// answering. This is the display side of listing what it has.
//
// One thing deliberately *not* here: any filtering of the list. /trips/list used to
// hand back every .csv on the root, including the DID sweep's /scanhits.csv, and
// pages worked around it client-side. The firmware now decides what a trip log is,
// in one place (trip_names.h, tripIsLogNameLoose), and the storage figures and the
// count are computed from that same test — so a filter here would only be able to
// disagree with the board about what it is holding.

import { n, round, DASH } from '../../lib/format.js';

/** How often /trips/list is re-read while the page is open. Firmware: 4000. */
export const TRIP_POLL_MS = 4000;

/**
 * Byte counts at the scale a driver reads them: MB for the partition, KB for a file.
 * `const kb=b=>b>=1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' KB'`
 */
export function kb(b) {
  if (b == null || isNaN(b)) return DASH;
  return b >= 1048576 ? n(b / 1048576, 1) + ' MB' : round(b / 1024) + ' KB';
}

/**
 * Newest first.
 *
 * Names are zero-padded and sequential — /t0001.csv, /t0002.csv — which is exactly
 * why tripPath() pads them (trip_names.h): a plain lexicographic sort is
 * chronological, so nothing has to parse a number out of a filename or trust a
 * timestamp from a board that may not have known the time.
 *
 * Copies rather than sorting in place: the array belongs to the last poll's payload.
 */
export function sortTrips(trips) {
  return (trips || []).slice().sort((a, b) => b.name.localeCompare(a.name));
}

/** Fraction of the partition in use, as a CSS width. Zero when there is no filesystem. */
export function usedPct(j) {
  return n(j && j.total ? 100 * j.used / j.total : 0, 1) + '%';
}

/** The line under the storage bar: used, total, and what is left. */
export function storageText(j) {
  if (!j) return '';
  return kb(j.used) + ' of ' + kb(j.total) + ' used · ' + kb(j.total - j.used) + ' free';
}

/** Filenames arrive rooted; the leading slash is noise on screen. */
export function tripLabel(name) {
  return String(name).replace('/', '');
}

/** Download URL for one trip. The name goes through a query string, so it is escaped. */
export function tripHref(name) {
  return '/trips/get?f=' + encodeURIComponent(name);
}

/** Delete URL. Same escaping; the firmware re-checks the name before removing anything. */
export function tripDelHref(name) {
  return '/trips/del?f=' + encodeURIComponent(name);
}

/**
 * Hash path for one trip's detail view.
 *
 * A sub-route of /trips rather than a seventh entry in ROUTES: the detail view is a
 * screen you arrive at from the list, not a tab you switch to, and the tab bar is
 * asserted to be exactly six wide. The name rides in a query string for the same
 * reason it does on the two URLs above — it is a filename, and escaping it once,
 * the same way, everywhere, is how it stays one thing.
 */
export const TRIP_DETAIL = '/trips/detail';

export function tripDetailPath(name) {
  return TRIP_DETAIL + '?f=' + encodeURIComponent(name);
}

/**
 * The trip a detail path names, or null if the path is not one.
 *
 * Returns null rather than throwing on a malformed hash: these arrive from the
 * address bar and from stale bookmarks as often as from the list, and an unreadable
 * one should land you back on the trips list, not on a blank screen.
 */
export function tripFromPath(path) {
  const s = String(path || '');
  if (s !== TRIP_DETAIL && !s.startsWith(TRIP_DETAIL + '?')) return null;
  const q = s.slice(TRIP_DETAIL.length + 1);
  for (const part of q.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === 'f') {
      const name = decodeURIComponent(part.slice(eq + 1));
      return name || null;
    }
  }
  return null;
}

/** Deleting a drive is not undoable, and the prompt says which drive. */
export function confirmText(name) {
  return 'Delete ' + tripLabel(name) + '? This cannot be undone.';
}

/**
 * Header dot and wording.
 *
 * "no filesystem" is its own state, and red: the board is answering, so it is not a
 * connection problem, but nothing is being recorded either — which is worse news
 * than an empty list and has to read differently.
 */
export function tripStatus(j, err) {
  if (err) return { dot: 'dot dead', text: 'ESP32 unreachable' };
  if (!j) return { dot: 'dot', text: 'reading…' };
  return {
    dot: j.fs ? 'dot live' : 'dot dead',
    text: j.fs ? (j.trips || []).length + ' trips' : 'no filesystem',
  };
}
