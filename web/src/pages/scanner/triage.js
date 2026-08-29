// The triage panel's arithmetic, kept out of the component so it can be asserted.
//
// Triage re-reads every identifier a sweep found, to see which of them actually
// move. The page's job is to answer three questions while it runs: how far through
// is it, how long has it been going, and how much of the list has a verdict yet.
//
// The one thing this must not do is imply more certainty than the run has earned.
// A "constant" verdict needs `needed` successful reads of the same value, and a
// value that only moves under load looks constant at idle - so the panel reports
// what was observed and how long it has been observing, and leaves the conclusion
// to the person who knows whether the car was idling or being driven.

import { hms } from './scan.js';

/** Reads per second, or 0 before there is an interval to divide by. */
export function readRate(reads, elapsed) {
  const r = +reads, e = +elapsed;
  if (!Number.isFinite(r) || !Number.isFinite(e) || e <= 0) return 0;
  return r / e;
}

/**
 * How far through the run is, as a fraction of the reads it needs.
 *
 * The target is `needed` successful reads of every identifier - not one pass, not
 * ten passes. Passes are a poor measure because roughly half the identifiers fail
 * to answer on any given pass: this adapter drops replies, and a pass that read 90
 * of 214 has done far less than a tenth of the work its number suggests.
 */
export function readProgress(reads, total, needed) {
  const want = (+total || 0) * (+needed || 0);
  if (!want) return 0;
  const p = (+reads || 0) / want;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * Estimated time to a full set of reads, as text.
 *
 * Deliberately hedged, because the estimate has a known bias: it assumes every
 * identifier keeps answering at the average rate, and the ones that answer rarely
 * are exactly the ones that will still be short when the average says done. It is
 * a floor on the remaining time, and the wording says so.
 */
export function readsEta(reads, total, needed, elapsed) {
  const rate = readRate(reads, elapsed);
  const want = (+total || 0) * (+needed || 0);
  const left = want - (+reads || 0);
  if (!rate || left <= 0) return '';
  return 'at least ' + hms(Math.round(left / rate)) + ' more';
}

/**
 * The counts line: what is settled and what is not.
 *
 * `varies` is stated plainly because one observed change is proof. `constant` is
 * always qualified - it is the absence of an observed change, which is a weaker
 * claim, and the number of reads behind it is what makes it worth anything.
 */
export function tallyText(j) {
  if (!j) return '';
  const t = +j.total || 0;
  if (!t) return 'nothing to triage - run a sweep first';
  const parts = [`${j.varies || 0} vary`];
  if (j.constant) parts.push(`${j.constant} unchanged so far`);
  if (j.identified) parts.push(`${j.identified} identified`);
  parts.push(`${j.unknown || 0} undecided`);
  return parts.join(' · ') + ` of ${t}`;
}

/**
 * The header status pill for a triage run.
 *
 * Armed and running are different states and both are ordinary - starting it before
 * turning the key is reasonable and it begins when the ECU answers - but they have
 * to look different, or a run that is doing nothing is indistinguishable from one
 * that is working.
 */
export function triageStatus(j, err) {
  if (err) return { dot: 'dot dead', text: 'no answer from the board' };
  if (!j) return null;
  if (!j.on) return { dot: 'dot', text: 'triage idle' };
  if (!j.reads) return { dot: 'dot stale', text: 'armed · waiting for the ECU' };
  return { dot: 'dot live', text: `triage · pass ${j.passes || 0}` };
}

/**
 * A one-line caveat naming what the run cannot conclude.
 *
 * Shown while a run is going, because the conditions during the run decide what the
 * result is worth and there is no way to recover that afterwards from the numbers.
 */
export const CONDITIONS_NOTE =
  'A value only shows as varying if it moves while this runs. Idling alone will '
  + 'leave anything that responds to load, speed or throttle looking unchanged.';
