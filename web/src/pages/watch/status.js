// What the Watch page's header pill says. Ported from the last two lines of
// render() and the catch in poll() in watch_html.h.

/**
 * @param {Object|null} j    the last /watch/list payload, or null before the first
 * @param {boolean} err      the last poll did not come back
 * @returns {{dot: string, text: string}}
 */
export function watchStatus(j, err) {
  if (err) return { dot: 'dot dead', text: 'ESP32 unreachable' };
  if (!j) return { dot: 'dot', text: 'reading…' };
  const c = (j.dids || []).length;
  // Watching stops dead while a sweep has the bus, so an amber dot rather than a
  // green one: the values on screen are the last ones read, not current ones, and
  // they can sit there for the hours a full sweep takes.
  return {
    dot: c ? (j.scanning ? 'dot stale' : 'dot live') : 'dot',
    text: j.scanning ? 'paused — scanning' : (c ? `${c} watched` : 'idle'),
  };
}
