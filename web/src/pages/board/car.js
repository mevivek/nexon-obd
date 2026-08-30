// The one-car rule, as something a person can act on.
//
// The board records for exactly one vehicle. Plugged into a different one it keeps
// showing live readings and writes nothing down, because two cars' sweeps, registers
// and trip logs in one set of files is wrong in a way nothing afterwards can detect
// - a hit is a DID and some bytes, with no vehicle in the record to separate them by.
//
// That leaves a choice only the owner can make, and it has to be put to them in
// terms of what it costs rather than in terms of what the firmware calls it:
//
//   Onboard this car   - erase everything about the old one and start again here.
//   Keep the old car   - stay bound to it; this car gets live readings only.
//
// The second is the safe default and the first is irreversible, so the wording
// leads with what would be lost and the count comes from the board rather than
// from an adjective.

/** Is there a decision to put in front of somebody at all? */
export function needsChoice(car) {
  return !!car && car.state === 'foreign';
}

/**
 * What the board would throw away by adopting the car in front of it.
 *
 * Assembled from the board's own counts. "A sweep and 214 identifiers, 66 of them
 * moving, 12 already identified" is a sentence somebody can weigh; "your data" is
 * not, and this is the one button here that cannot be undone.
 */
export function holdsText(car) {
  const h = (car && car.holds) || {};
  const bits = [];
  if (h.records) {
    bits.push(`${h.records} identifier${h.records === 1 ? '' : 's'} in the register`);
    if (h.varies) bits.push(`${h.varies} of them known to move`);
    if (h.fitted) bits.push(`${h.fitted} already fitted to a reading`);
  } else if (h.hits) {
    bits.push(`${h.hits} sweep hit${h.hits === 1 ? '' : 's'}`);
  }
  if (h.trips) bits.push(`${h.trips} trip log${h.trips === 1 ? '' : 's'}`);
  if (!bits.length) return 'This board holds no data yet, so adopting this car costs nothing.';
  return 'Adopting this car erases ' + bits.join(', ') + '.';
}

/**
 * The pill, and whether the board is writing anything down.
 *
 * `foreign` is the only state that is a problem, and it is shown as a warning
 * rather than an error: nothing is broken, the board is doing exactly what it was
 * told to. `unknown` is deliberately quiet - it is the ordinary state of every car
 * that will not answer mode 09, and dressing it up as a fault would send people
 * hunting one.
 */
export function carStatus(car, err) {
  if (err) return { dot: 'dot dead', text: 'no answer' };
  if (!car) return { dot: 'dot', text: 'reading' };
  if (car.state === 'foreign') return { dot: 'dot stale', text: 'another car' };
  if (car.state === 'unknown') return { dot: 'dot', text: 'unidentified' };
  if (car.state === 'new') return { dot: 'dot', text: 'unbound' };
  return { dot: 'dot live', text: 'recording' };
}

/** One line for the banner headline. Short, because the detail is underneath it. */
export function headline(car) {
  if (!needsChoice(car)) return '';
  return 'This is a different car';
}

/**
 * Can the adopt button be pressed yet?
 *
 * Only once the new car has identified itself. Binding to an empty key would bind
 * to nothing at all, and the board would then treat every subsequent car as a match
 * - which is the rule inverted rather than merely absent. The firmware refuses this
 * too; this is so the button is disabled rather than the press returning an error.
 */
export function canAdopt(car) {
  return !!(car && car.seen);
}

export function adoptBlockedWhy(car) {
  if (canAdopt(car)) return '';
  return 'This car has not identified itself yet, so there is nothing to bind to. '
       + 'Start the engine and let discovery finish first.';
}
