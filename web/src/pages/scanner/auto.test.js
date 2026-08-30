// A pipeline measured in drives must not look like a broken one.
//
// Every one of these is really the same check: does the panel say something true
// when nothing is moving. Two of the three phases spend most of their time waiting
// for an ignition that is off, and a percentage on its own cannot distinguish that
// from a crash.

import { describe, it, expect } from 'vitest';
import {
  PHASES, phaseInfo, phaseIndex, autoStatus, autoText, autoCounts,
  drivesLeft, fitText, FIT_NOTE,
} from './auto.js';

const SWEEP  = { phase: 'sweep', pct: 31, records: 0, triaged: 0, varying: 0, fitted: 0, watching: 0, rounds: 0, held: '' };
const TRIAGE = { phase: 'triage', pct: 47, records: 214, triaged: 100, varying: 40, fitted: 0, watching: 0, rounds: 0, held: '' };
const WATCH  = { phase: 'watch', pct: 18, records: 214, triaged: 214, varying: 66, fitted: 12, watching: 8, rounds: 2, held: '' };

describe('phases', () => {
  it('are the three the firmware walks, in order', () => {
    expect(PHASES.map((p) => p.id)).toEqual(['sweep', 'triage', 'watch']);
    expect(phaseIndex('triage')).toBe(2);
    expect(phaseIndex('off')).toBe(0);
    expect(phaseInfo('nonsense')).toBe(null);
  });

  it('each say what they cost, because none of them is quick', () => {
    for (const p of PHASES) {
      expect(p.cost.length).toBeGreaterThan(0);
      expect(p.what.length).toBeGreaterThan(0);
    }
    // The one people will not believe unless it is written down.
    expect(phaseInfo('watch').cost).toContain('drive');
    expect(phaseInfo('sweep').cost).toContain('30 minutes');
  });
});

describe('autoStatus', () => {
  it('shows the running phase and how far in', () => {
    expect(autoStatus(SWEEP)).toMatchObject({ text: 'sweep', extra: '31%' });
  });

  it('distinguishes held from running', () => {
    // This is the whole point. A run waiting for the ignition is working exactly as
    // designed; a run in the wrong car is something to go and fix. Neither is a
    // spinner.
    const s = autoStatus({ ...TRIAGE, held: 'the ECU is not answering - waiting for the ignition' });
    expect(s.text).toBe('holding');
    expect(s.dot).toBe('dot stale');
  });

  it('separates not-running from finished from unreachable', () => {
    expect(autoStatus({ phase: 'off' }).text).toBe('not running');
    expect(autoStatus({ phase: 'done' }).text).toBe('finished');
    expect(autoStatus(null, 'boom').text).toBe('no answer');
    expect(autoStatus(null).text).toBe('reading');
  });
});

describe('autoText', () => {
  it('prefers the board\'s own reason over a description of the phase', () => {
    // The board knows things the page does not - whether the ECU is answering,
    // whether this is even the right car.
    const held = autoText({ ...WATCH, held: 'a different car - nothing is being recorded' });
    expect(held).toBe('a different car - nothing is being recorded.');
    expect(held).not.toContain('Logging eight');
  });

  it('describes the phase when nothing is holding it', () => {
    expect(autoText(TRIAGE)).toContain('Re-reading every hit');
    expect(autoText(TRIAGE)).toContain('twenty passes');
  });

  it('says what starting it would commit to', () => {
    expect(autoText({ phase: 'off' })).toContain('as many drives as it takes');
  });

  it('reports the result rather than a percentage when finished', () => {
    expect(autoText({ phase: 'done', fitted: 61, varying: 66 }))
      .toContain('61 of 66 moving identifiers have been fitted');
  });
});

describe('autoCounts', () => {
  it('puts numbers behind the bar', () => {
    expect(autoCounts(SWEEP)).toContain('31% of the identifier space');
    expect(autoCounts(TRIAGE)).toContain('100 of 214');
    expect(autoCounts(WATCH)).toContain('12 of 66');
    expect(autoCounts(WATCH)).toContain('round 2');
  });

  it('says nothing when there is nothing running', () => {
    expect(autoCounts({ phase: 'off' })).toBe('');
    expect(autoCounts(null)).toBe('');
  });
});

describe('drivesLeft', () => {
  it('is a floor, and says so', () => {
    // 54 left over 8 slots is 7 drives, and only if every one of them fits.
    const t = drivesLeft(WATCH);
    expect(t).toContain('At least 7 more drives');
    expect(t).toContain('more if some of them turn out not to correlate');
  });

  it('is silent outside the watch phase, and when there is nothing left', () => {
    expect(drivesLeft(SWEEP)).toBe('');
    expect(drivesLeft({ ...WATCH, fitted: 66 })).toBe('');
    expect(drivesLeft(null)).toBe('');
  });

  it('gets the singular right', () => {
    expect(drivesLeft({ ...WATCH, varying: 66, fitted: 60 })).toContain('At least 1 more drive');
  });
});

describe('fitText', () => {
  it('says tracks, never is', () => {
    const t = fitText({ tracks: 'coolant', r: 0.97, samples: 4200 });
    expect(t).toBe('tracks with coolant (r 0.97, 4200 samples)');
    expect(t).not.toMatch(/\bis coolant\b/);
  });

  it('keeps the direction of an inverse relationship', () => {
    // A value that falls as coolant rises is just as identified by that
    // relationship, and losing the sign would lose which one it is.
    expect(fitText({ tracks: 'rpm', r: -0.93, samples: 900 })).toContain('inversely with rpm');
  });

  it('says nothing about an identifier that has not been fitted', () => {
    expect(fitText({ tracks: '' })).toBe('');
    expect(fitText(null)).toBe('');
  });

  it('carries the caveat the table would otherwise imply away', () => {
    expect(FIT_NOTE).toContain('not an identification');
    expect(FIT_NOTE).toContain('offset and scale');
    expect(FIT_NOTE).toContain('human act');
  });
});
