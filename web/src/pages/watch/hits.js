// The identifier list the picker is built from: what a did_hits.csv contains, how
// a loaded file joins the board's own hits, and where the result is kept.
//
// Ported from parseCsv() / addHits() / the localStorage block in watch_html.h.
//
// Nothing here uploads anything. A file dropped on this page is read by the
// browser's own FileReader and stays in the browser; the board is never told about
// it, and never asked.

/** Where a loaded file is remembered, so a reload is not a trip back to the picker. */
export const HITS_KEY = 'nexonHits';

/** How many are kept in localStorage. A 65,536-identifier sweep must not fill it. */
export const HITS_STORE_MAX = 2000;

/** Identity of a hit: the same DID on two ECUs is two different identifiers. */
export function hitKey(h) {
  return h.ecu + h.did;
}

/** The key the board uses for a watched identifier — `E1002`, `T0140`. */
export function watchName(h) {
  return (h.ecu === 'TCM' ? 'T' : 'E') + h.did;
}

/**
 * Parse a did_hits.csv exported by the scanner page: `ecu,did,len,hex,ascii`, with
 * the ascii column quoted because it can contain a comma.
 *
 * Only the first four columns matter here, so the quoted tail is simply never read
 * — which is also why a payload quote being *dropped* rather than escaped on export
 * costs nothing. The file may well have come from an older firmware, so every field
 * is validated rather than trusted: a row whose ECU is not ECM or TCM, or whose DID
 * is not four hex digits, is skipped. That check disposes of the header row too,
 * with no special case for it.
 */
export function parseCsv(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const c = line.split(',');
    if (c.length < 4) continue;
    const ecu = c[0].trim().toUpperCase(), did = c[1].trim().toUpperCase();
    if (ecu !== 'ECM' && ecu !== 'TCM') continue;          // skips the header row too
    if (!/^[0-9A-F]{4}$/.test(did)) continue;
    out.push({ ecu, did, len: +c[2] || 0, hex: (c[3] || '').trim() });
  }
  return out;
}

/**
 * Merge rather than replace.
 *
 * A board that has found its own hits should not lose them because a file was
 * loaded, and a file's identifiers should not vanish because the board came back
 * with a fresh sweep. First writer wins on a collision — the entry already in the
 * list keeps its payload rather than being overwritten by a possibly older file.
 *
 * Returns a new array; the input is not touched, so it is safe to hand straight to
 * a state setter.
 */
export function mergeHits(hits, list) {
  const out = (hits || []).slice();
  const seen = new Set(out.map(hitKey));
  for (const h of list || []) {
    if (!seen.has(hitKey(h))) { seen.add(hitKey(h)); out.push(h); }
  }
  out.sort((a, b) => hitKey(a).localeCompare(hitKey(b)));
  return out;
}

/**
 * The remembered list. A convenience cache, never a source of truth: the board owns
 * the hits it found itself, and this is only here so a reload does not send you back
 * to the file picker.
 */
export function loadStoredHits() {
  try {
    const s = localStorage.getItem(HITS_KEY);
    return (s ? JSON.parse(s) : null) || [];
  } catch (_) {
    return [];
  }
}

/** Best-effort. A full or disabled localStorage costs the cache, never the page. */
export function saveStoredHits(hits) {
  try {
    localStorage.setItem(HITS_KEY, JSON.stringify((hits || []).slice(0, HITS_STORE_MAX)));
  } catch (_) { /* private mode, quota, disabled — none of it is worth an error */ }
}
