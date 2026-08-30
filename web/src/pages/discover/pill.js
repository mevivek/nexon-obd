// One header, three things that could be talking.
//
// The sweep, triage and the watch used to be two tabs with a pill each. Merged onto
// one screen they have to share a single pill, and "share" cannot mean "whichever
// updated last" - that flickers between three unrelated sentences and is worse than
// any one of them alone.
//
// So the rule is: report the thing that is actually running, most specific first.
// Only one of these can have the bus at a time - watching stands down for triage,
// triage stands down for a sweep, and the autopilot drives all three - so at most
// one of them is ever genuinely active, and the ordering below is that same
// precedence written down.

/**
 * @param {Object|null} auto   /auto, via autoStatus()
 * @param {Object|null} scan   /scan/status, via scanStatus()
 * @param {Object|null} watch  /watch/list, via watchStatus()
 */
export function discoverPill(auto, scan, watch) {
  // A board that is not answering is the only thing worth saying, whichever poll
  // noticed it. Reporting "3 watched" from a cached payload beside a dead board is
  // the specific failure this is ordered to avoid.
  for (const s of [auto, scan, watch])
    if (s && /dead/.test(s.dot || '')) return s;

  // The autopilot subsumes the other two: while it runs, the sweep and the watch
  // set are things IT is doing, and reporting them separately would describe the
  // same activity twice in two different vocabularies.
  if (auto && auto.text && auto.text !== 'not running' && auto.text !== 'reading')
    return auto;

  // A manual sweep next. It owns the bus outright and stops the watch dead, so a
  // watch pill during one would be describing values that are minutes stale.
  if (scan && (scan.text === 'scanning' || scan.text === 'waiting for ECU')) return scan;

  // Then whatever is being watched, which is the page's resting state once a
  // register exists.
  if (watch && watch.text && watch.text !== 'idle' && watch.text !== 'reading…') return watch;

  return scan || watch || auto || null;
}
