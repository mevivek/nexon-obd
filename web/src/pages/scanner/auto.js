// The autopilot, described honestly.
//
// The whole risk with this panel is that a pipeline measured in drives looks
// identical to a broken one. Sweep, triage and watching each take longer than
// anybody will sit and watch, and two of the three spend most of their time waiting
// for an ignition that is off - so a progress bar on its own reads as stuck, and
// the temptation is to show something moving instead of something true.
//
// So: every phase says what it is doing, roughly how long it takes, and - when it
// is doing nothing - which of the handful of reasons applies. "Waiting for the
// ignition" is a complete and useful answer. A spinner is not.

/** What each phase is, in one line, and what it costs. */
export const PHASES = [
  { id: 'sweep',  label: 'Sweep',
    what: 'Asking every identifier from 0000 to FFFF whether it exists.',
    cost: 'about 30 minutes on CAN, the better part of a day over BLE' },
  { id: 'sweep2', label: 'Sweep (TCM)',
    what: 'The same sweep again at the transmission controller, which is a separate identifier space at a separate address.',
    cost: 'another 30 minutes, and only when a second ECU actually answered the probe' },
  { id: 'triage', label: 'Triage',
    what: 'Re-reading every hit to find which ones actually move.',
    cost: 'about an hour of engine-on - this adapter answers roughly half of what it is asked, so ten clean reads needs about twenty passes' },
  { id: 'watch',  label: 'Watch',
    what: 'Logging eight identifiers at a time beside the live readings, and fitting them.',
    cost: 'one drive per eight, so eight or nine drives for a typical register' },
];

/**
 * Whether the second ECU is part of this run, said out loud.
 *
 * Left to be inferred from a phase that simply never appears, a skipped TCM reads
 * as a pipeline that quietly dropped something. And the reason matters: silence
 * from 0x7E9 is not proof there is no module there, it is the only evidence a CAN
 * bus can offer either way.
 */
export function tcmText(j) {
  if (!j || j.phase === 'off') return '';
  if (j.tcm === 'yes') return 'A second ECU answered, so the transmission is swept too.';
  if (j.tcm === 'silent')
    return 'Nothing answered at the transmission controller address (0x7E9), so it is not being swept - '
         + 'a sweep of an ECU that is not there stalls rather than finishing, and would hold '
         + 'the pipeline for good. Use the manual sweep below if you think the probe was wrong.';
  return 'The second ECU has not been probed yet - that happens once the engine is running.';
}

export function phaseInfo(id) {
  return PHASES.find((p) => p.id === id) || null;
}

/** Which step of the pipeline, 1-based, for "step 2 of 3". 0 when not running. */
export function phaseIndex(id) {
  const i = PHASES.findIndex((p) => p.id === id);
  return i < 0 ? 0 : i + 1;
}

/**
 * The pill.
 *
 * Held is not the same as running, and neither is the same as finished. A run that
 * is waiting for the ignition is working exactly as designed and must not look like
 * a fault; a run in the wrong car is a thing to go and fix.
 */
export function autoStatus(j, err) {
  if (err) return { dot: 'dot dead', text: 'no answer', extra: '' };
  if (!j) return { dot: 'dot', text: 'reading', extra: '' };
  if (j.phase === 'off') return { dot: 'dot', text: 'not running', extra: '' };
  if (j.phase === 'done') return { dot: 'dot live', text: 'finished', extra: '' };
  if (j.held) return { dot: 'dot stale', text: 'holding', extra: j.phase };
  return { dot: 'dot live', text: j.phase, extra: j.pct + '%' };
}

/**
 * The sentence under the bar.
 *
 * When the board has said why it is held, that is the answer - it knows things the
 * page does not, like whether the ECU is answering. Otherwise describe the phase.
 */
export function autoText(j) {
  if (!j) return '';
  if (j.phase === 'off')
    return 'Not running. Starting it sweeps the identifier space, triages what answers, '
         + 'then watches what moves - unattended, across as many drives as it takes.';
  if (j.phase === 'done')
    return `Finished. ${j.fitted} of ${j.varying} moving identifiers have been fitted to a reading.`;
  if (j.held) return j.held + '.';

  const p = phaseInfo(j.phase);
  return p ? `${p.what} Takes ${p.cost}.` : '';
}

/**
 * Progress in counts, not only a percentage.
 *
 * A bar at 31% says nothing about whether that is thirty seconds or three drives
 * from the end. The numbers behind it do.
 */
export function autoCounts(j) {
  if (!j) return '';
  switch (j.phase) {
    case 'sweep':
    case 'sweep2': return `${j.pct}% of the identifier space asked.`;
    case 'triage': return `${j.triaged} of ${j.records} identifiers have enough reads for a verdict.`;
    case 'watch':  return `${j.fitted} of ${j.varying} moving identifiers fitted; `
                        + `${j.watching} on watch now, round ${j.rounds}.`;
    default:       return '';
  }
}

/**
 * How many more drives the watch phase needs, as a range rather than a number.
 *
 * Eight slots a drive, and a drive only produces a fit for a slot whose identifier
 * moved enough to correlate with something - so the count is a floor, and it is
 * stated as one. An estimate quoted as a single number is read as a promise.
 */
export function drivesLeft(j) {
  if (!j || j.phase !== 'watch') return '';
  const left = Math.max(0, (j.varying || 0) - (j.fitted || 0));
  if (!left) return '';
  const n = Math.ceil(left / 8);
  return `At least ${n} more drive${n === 1 ? '' : 's'} - more if some of them turn out not to correlate with anything.`;
}

/**
 * How a fit is described. Never "is", always "tracks".
 *
 * Everything under a bonnet correlates with everything else: oil temperature tracks
 * coolant almost perfectly, and both track runtime after a cold start. A strong r
 * against coolant is equally consistent with three different answers, and r says
 * nothing about offset or scale either. The page has to carry that or the table
 * reads as a list of identifications.
 */
export function fitText(rec) {
  if (!rec || !rec.tracks) return '';
  const r = typeof rec.r === 'number' ? rec.r : 0;
  const dir = r < 0 ? 'inversely with' : 'with';
  return `tracks ${dir} ${rec.tracks} (r ${r.toFixed(2)}, ${rec.samples} samples)`;
}

export const FIT_NOTE =
  'A correlation is not an identification. Oil temperature tracks coolant almost '
  + 'perfectly and both track runtime after a cold start, so a strong fit narrows '
  + 'the field rather than settling it - and r is unchanged by offset and scale, so '
  + 'it says nothing about units. Naming an identifier is still a human act.';
