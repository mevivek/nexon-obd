// The one decision the board cannot make for you.
//
// Adopting a car erases everything about the last one, and it is the only
// irreversible button on the board that somebody might press in a hurry at the
// roadside. So these are mostly about the wording: what it costs has to be a count
// the board supplied, not an adjective, and the state that is merely uncertain must
// not be dressed up as a fault.

import { describe, it, expect } from 'vitest';
import {
  needsChoice, holdsText, carStatus, headline, canAdopt, adoptBlockedWhy,
} from './car.js';

const FOREIGN = {
  state: 'foreign', bound: '1f3c9a20', seen: 'deadbeef', recording: false,
  holds: { records: 214, varies: 66, fitted: 12, hits: 214, trips: 3 },
};

describe('needsChoice', () => {
  it('is only asked in a car the board is not bound to', () => {
    expect(needsChoice(FOREIGN)).toBe(true);
    expect(needsChoice({ ...FOREIGN, state: 'match' })).toBe(false);
    expect(needsChoice({ ...FOREIGN, state: 'new' })).toBe(false);
    expect(needsChoice(null)).toBe(false);
  });

  it('is not asked of a car that simply has not identified itself', () => {
    // The common case on any ECU that declines mode 09. Recording continues, so
    // there is nothing to decide and a prompt would be noise on every drive.
    expect(needsChoice({ ...FOREIGN, state: 'unknown' })).toBe(false);
  });
});

describe('holdsText', () => {
  it('counts what would be lost', () => {
    const t = holdsText(FOREIGN);
    expect(t).toContain('214 identifiers in the register');
    expect(t).toContain('66 of them known to move');
    expect(t).toContain('12 already fitted');
    expect(t).toContain('3 trip logs');
  });

  it('says plainly when there is nothing to lose', () => {
    expect(holdsText({ holds: {} })).toContain('costs nothing');
    expect(holdsText(null)).toContain('costs nothing');
  });

  it('falls back to the sweep when the register has not been built', () => {
    expect(holdsText({ holds: { hits: 214 } })).toContain('214 sweep hits');
  });

  it('gets the singulars right', () => {
    const t = holdsText({ holds: { records: 1, trips: 1 } });
    expect(t).toContain('1 identifier in the register');
    expect(t).toContain('1 trip log');
    expect(t).not.toContain('1 identifiers');
  });
});

describe('carStatus', () => {
  it('reports recording when it is', () => {
    expect(carStatus({ state: 'match' }).text).toBe('recording');
  });

  it('warns rather than errors on another car', () => {
    // Nothing is broken - the board is doing exactly what it was told.
    const s = carStatus(FOREIGN);
    expect(s.text).toBe('another car');
    expect(s.dot).not.toContain('dead');
  });

  it('stays quiet about a car that will not identify itself', () => {
    const s = carStatus({ state: 'unknown' });
    expect(s.text).toBe('unidentified');
    expect(s.dot).toBe('dot');
  });

  it('separates no answer from no data', () => {
    expect(carStatus(null, 'boom').text).toBe('no answer');
    expect(carStatus(null).text).toBe('reading');
  });
});

describe('canAdopt', () => {
  it('needs the new car to have identified itself', () => {
    // Binding to an empty key would make every later car compare equal, which is
    // the rule inverted rather than merely missing.
    expect(canAdopt(FOREIGN)).toBe(true);
    expect(canAdopt({ ...FOREIGN, seen: '' })).toBe(false);
    expect(canAdopt(null)).toBe(false);
    expect(adoptBlockedWhy({ ...FOREIGN, seen: '' })).toContain('Start the engine');
    expect(adoptBlockedWhy(FOREIGN)).toBe('');
  });
});

describe('headline', () => {
  it('leads with the fact, not the fix', () => {
    expect(headline(FOREIGN)).toBe('This is a different car');
    expect(headline({ state: 'match' })).toBe('');
  });
});
