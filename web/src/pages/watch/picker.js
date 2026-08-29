// Choosing what to watch: the typed-identifier parser and the bus-cost estimate.
// Ported from the Apply handler and cost() in watch_html.h.

/** The board's own cap (WATCH_MAX in didwatch.h), until /watch/list says otherwise. */
export const WATCH_MAX = 8;

/**
 * Fold a typed list into the selection.
 *
 * The separator is "anything that is not part of an identifier", so `1002, 1003`,
 * `1002 1003` and `1002;1003` all work — at a kerbside with one thumb, insisting on
 * a particular delimiter is a way of not being used. An identifier with no ECU
 * letter is assumed to be on the ECM, which is where all but a handful live.
 *
 * The cap is checked as the list is walked, not after: typing nine identifiers
 * takes the first eight rather than being rejected wholesale.
 *
 * @returns {Set<string>} a new Set — the input is left alone
 */
export function addTyped(sel, text, max = WATCH_MAX) {
  const out = new Set(sel || []);
  const typed = String(text == null ? '' : text).split(/[^0-9A-Fa-fTtEe]+/).filter(Boolean);
  for (const t of typed) {
    if (out.size < max) {
      const u = t.toUpperCase();
      out.add(u.match(/^[ET]/) ? u : 'E' + u);
    }
  }
  return out;
}

/**
 * Fill the selection from a list of sweep hits, up to the cap.
 *
 * Deliberately not "select all". The board watches at most WATCH_MAX identifiers,
 * and a sweep routinely finds hundreds — this board has 214 — so a control labelled
 * "select all" would tick 214 boxes, silently drop 206 of them, and leave whichever
 * eight happened to sort first. Truncation dressed as a bulk action is worse than no
 * bulk action: the set you end up watching is not the set you asked for, and nothing
 * on screen says which one you got.
 *
 * So this takes the next unselected hits in the order they are offered, stops at the
 * cap, and the caller says how many it actually added. Pressing it again after
 * unticking a few fills the gaps, which is the motion this is actually for: work
 * through a long hit list eight at a time.
 *
 * Existing choices are kept. Nothing already ticked is dropped to make room — the
 * one already-watched identifier that is holding a correlation is not worth losing
 * to a convenience button.
 *
 * @param {Set<string>} sel   current selection
 * @param {string[]} keys     hit keys in display order, e.g. ['E1002', 'E1003']
 * @param {number} max        the board's cap
 * @returns {{ next: Set<string>, added: number, room: number }}
 */
export function fillFrom(sel, keys, max = WATCH_MAX) {
  const next = new Set(sel || []);
  const before = next.size;
  for (const k of keys || []) {
    if (next.size >= max) break;
    next.add(k);
  }
  return { next, added: next.size - before, room: Math.max(0, max - before) };
}

/**
 * What the chosen set costs the bus, in the transport actually in use.
 *
 * A BLE exchange is roughly 165 ms on this adapter, so the budget is about six
 * requests a second; direct CAN is far cheaper. The estimate quotes BLE because
 * that is the one where watching four identifiers can visibly slow the live gauges,
 * and a number that flatters the good case is a number nobody checks against.
 *
 * The refresh figure is the one that surprises people: identifiers share a single
 * round robin, so eight of them at one per second means each is a second old *at
 * best* and eight seconds old at worst.
 *
 * @returns {string} the hint text, or '' when nothing is selected
 */
export function costText(period, count) {
  const p = +period, n = count;
  if (!n) return '';
  const perRead = 1000 / p, budget = 6.0;
  return `${n} identifier${n > 1 ? 's' : ''} at one per ${p < 1000 ? p + ' ms' : (p / 1000) + ' s'}`
    + ` — about ${(100 * perRead / budget).toFixed(0)}% of the bus over BLE, and each one`
    + ` refreshes every ${((n * p) / 1000).toFixed(1)} s.`;
}
