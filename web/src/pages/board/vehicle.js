// Reading /vehicle out loud.
//
// Discovery answers three questions - what car is this, which live readings can it
// produce, and is anything else on the bus - and the only useful way to present
// them is one where "not asked yet" is as visible as yes and no. The firmware keeps
// that distinction all the way through; losing it here would waste it.
//
// Nothing in this file decides anything. The verdicts are the board's; these turn
// them into sentences.

/** The pill: is the walk finished, running, or waiting for a car? */
export function discoveryStatus(j, err) {
  if (err) return { dot: 'dot dead', text: 'no answer', extra: '' };
  if (!j) return { dot: 'dot', text: 'reading', extra: '' };
  if (j.done) return { dot: 'dot live', text: 'discovered', extra: '' };
  if (j.ecu !== 'answering')
    return { dot: 'dot stale', text: 'waiting for the car', extra: `${j.step}/${j.steps}` };
  return { dot: 'dot live', text: 'asking', extra: `${j.step}/${j.steps}` };
}

/**
 * The identity, as rows.
 *
 * A refusal and a silence read differently on purpose. "The ECU said it does not
 * support this" is a fact about the car; "nothing came back" is a fact about the
 * last few seconds, and the fix for it is to go and start the engine.
 */
export function identityRows(j) {
  if (!j) return [];
  const said = (value, refused, what) => {
    if (value) return { value, note: '' };
    if (refused) return { value: '—', note: `this ECU does not report ${what}` };
    if (j.done) return { value: '—', note: 'asked, but nothing came back' };
    return { value: '—', note: 'not asked yet' };
  };

  const vin = said(j.vin, j.vinRefused, 'a VIN');
  const cal = said(j.cal, j.calRefused, 'a calibration id');
  return [
    { label: 'VIN', ...vin },
    { label: 'Calibration', ...cal },
    { label: 'CVN', ...said(j.cvn, j.calRefused, 'a checksum') },
    // The key is what a backup carries, so it is shown beside the things it is
    // made from rather than hidden inside the backup card.
    { label: 'Backup key', value: j.key || '—',
      note: j.key ? 'what a backup is checked against' : 'nothing identified this car, so a backup cannot be checked against it' },
  ];
}

/** How many of the polled PIDs this car supports, refuses, or has not said. */
export function pidTally(j) {
  const p = (j && j.polled) || [];
  return {
    yes: p.filter((x) => x.state === 'yes').length,
    no: p.filter((x) => x.state === 'no').length,
    unknown: p.filter((x) => x.state === 'unknown').length,
    total: p.length,
  };
}

/**
 * The sentence under the tally.
 *
 * The unsupported count is the one that matters and it is stated as what it means
 * for the dashboard, not as a number: somebody looking at four blank tiles wants to
 * know whether that is the car or the connection.
 */
export function pidText(t) {
  if (!t.total) return 'Nothing polled - this build asks for no PIDs at all, which cannot be right.';
  if (t.unknown === t.total) return 'The support bitmaps have not arrived yet, so nothing is known about what this car can produce.';

  const bits = [`${t.yes} of ${t.total} supported`];
  if (t.no) bits.push(`${t.no} not supported by this car - those tiles will stay blank, and that is the car, not a fault`);
  if (t.unknown) bits.push(`${t.unknown} still unknown`);
  return bits.join('; ') + '.';
}

/** Which PIDs are the blank ones, so the list is actionable rather than a count. */
export function unsupportedPids(j) {
  return ((j && j.polled) || []).filter((x) => x.state === 'no').map((x) => x.pid);
}

/**
 * The other ECU.
 *
 * Silence is not absence. A module that is not fitted and a module that is not
 * awake produce exactly the same nothing on a CAN bus, and there is no frame that
 * distinguishes them - so this never says "not fitted".
 */
export function tcmText(j) {
  if (!j) return '';
  if (j.tcm === 'answering') return 'A second ECU answers at 0x7E9 - a transmission controller, on this bus layout.';
  if (j.tcm === 'silent') return 'Nothing answered at 0x7E9. Either there is no second ECU or it was not awake when the walk ran - a CAN bus cannot tell those apart.';
  return 'The second ECU has not been asked yet.';
}

/** `4 of 8 support blocks read` - how far the mode 01 walk got. */
export function blocksText(j) {
  const b = (j && j.blocks) || [];
  const known = b.filter((x) => x.known).length;
  if (!known) return 'No support bitmaps read yet.';
  return `${known} of ${b.length} mode 01 support blocks read.`;
}
