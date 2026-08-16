// Ported from suiteMileage in firmware/test/test_dashboard.mjs.
//
// The board integrates the totals (covered in the C++ suite); this is the display
// side, where the risk is showing a number that is arithmetically correct and
// completely misleading - an average over the first four hundred metres swings by
// tens of km/L between polls and reads as a broken gauge.

import { describe, it, expect } from 'vitest';
import { createHold } from './hold.js';
import { computeMileage, TRIP_MIN_KM, TRIP_MIN_L } from './mileage.js';

describe('mileage', () => {
  // One merger for the suite, as in the original: the held-value behaviour of the
  // last two checks depends on what the earlier samples left behind.
  const m = createHold();
  const base = { rpm: 2000, speed: 60, fuelRate: 6, coolant: 88 };
  const at = (sample) => computeMileage(...m.merge({ ...base, ...sample }));

  it('no average until there is a drive to average over', () => {
    const r = at({ tripKm: 0.2, tripL: 0.02 });
    expect(r.avgText).toBe('—');
    // 'and it says why rather than sitting blank'
    expect(r.tripNote).toContain('too early');
  });

  it('average is distance over fuel', () => {
    const r = at({ tripKm: 23.6, tripL: 1.66 });
    expect(r.avgText).toBe('14.2');
    // 'with the totals it came from, so the figure can be checked'
    expect(r.tripNote).toContain('23.6 km');
    expect(r.tripNote).toContain('1.66 L');
  });

  it('instantaneous is speed over fuel rate', () => {
    // 60 km/h on 6 L/h is 10 km/L, and that is the number the pedal moves.
    const r = at({ speed: 60, fuelRate: 6, tripKm: 23.6, tripL: 1.66 });
    expect(r.instText).toBe('10.0');
    // 'with the raw rate beside it'
    expect(r.rateNote).toContain('6.00 L/h');
  });

  it('standing still has no instantaneous mileage', () => {
    // Stopped but burning: the division is meaningless, so it is not shown, and the
    // useful thing to say is that fuel is going nowhere.
    const r = at({ speed: 0, fuelRate: 0.8, tripKm: 23.6, tripL: 1.66 });
    expect(r.instText).toBe('—');
    // 'and says it is idling instead'
    expect(r.rateNote).toContain('idling');
    // 'while the drive average is unaffected by the stop'
    expect(r.avgText).toBe('14.2');
  });

  it('a held speed or rate does not present as a fresh instantaneous figure', () => {
    // The blanking bug this whole dashboard was rebuilt around: a missing value must
    // not be coerced to zero and rendered as a reading.
    const r = at({ speed: null, fuelRate: null, tripKm: 23.6, tripL: 1.66 });
    expect(r.instStale || r.instText === '—').toBe(true);
    // 'the average still stands - it is accumulated, not sampled'
    expect(r.avgText).toBe('14.2');
  });

  it('nothing received yet shows no average', () => {
    // A page that has only just loaded, against a board that has sent nothing.
    // Needs its own instance: merge() holds the last value it saw, and holding a
    // running total is right - the totals are monotonic and board-side, so a null in
    // one sample means "not in this reply", never "back to zero".
    const fresh = createHold();
    const r = computeMileage(...fresh.merge({
      rpm: null, speed: null, fuelRate: null, tripKm: null, tripL: null,
    }));
    expect(r.avgText).toBe('—');
    // 'and the note stays neutral'
    expect(r.tripNote).toBe('this drive');
  });
});

// The withholding thresholds are the whole reason the average is trustworthy, so
// they are pinned rather than left implicit in the 0.2 km case above.
describe('withholding thresholds', () => {
  it('are 0.5 km and 0.1 L', () => {
    expect(TRIP_MIN_KM).toBe(0.5);
    expect(TRIP_MIN_L).toBe(0.1);
  });

  it('needs both, not either', () => {
    // A long coast on almost no fuel is as misleading as four hundred metres.
    const r = (tripKm, tripL) => computeMileage({ tripKm, tripL }, {});
    expect(r(0.49, 5).avgText).toBe('—');
    expect(r(50, 0.09).avgText).toBe('—');
    expect(r(0.5, 0.1).avg).toBe(5);
  });

  it('a total that is absent is not a total of zero', () => {
    expect(computeMileage({ tripKm: 23.6, tripL: null }, {}).avgText).toBe('—');
    expect(computeMileage({ tripKm: null, tripL: 1.66 }, {}).tripNote).toBe('this drive');
  });

  it('the rate note disappears rather than reading zero when fuel rate is absent', () => {
    expect(computeMileage({ fuelRate: null }, {}).rateNote).toBe('');
  });
});
