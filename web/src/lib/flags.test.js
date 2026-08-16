// Ported from suiteFlags in firmware/test/test_dashboard.mjs.
//
// From that file's preamble, the bug this whole suite exists for:
//
//   Every threshold compared a raw value, and JS coerces null to 0 - so a *missing*
//   lambda satisfied `v.lambda <= 0.85` and lit "running rich" underneath a blank
//   reading.
//
// The firmware suite asserted against a fake DOM (`className.includes('on')`); the
// lib is DOM-free, so the same facts are asserted against the flag descriptors that
// the DOM binding is a thin function of.

import { describe, it, expect } from 'vitest';
import { createHold } from './hold.js';
import { computeFlags } from './flags.js';
import { n, round } from './format.js';

// What the firmware's T() helper does with a value and its held-mark. Asserting on
// this keeps the ported checks the same shape as the originals.
const readout = (text, held) => ({ text, stale: !!held });

describe('warnings never fire on data that is not there', () => {
  // One merger for the whole suite, as in the original: several checks below depend
  // on what the previous sample left behind.
  const m = createHold();

  it('a blank sample lights nothing at all', () => {
    // The screenshot case: lambda missing entirely.
    const [v, q] = m.merge({
      lambda: null, coolant: null, volt: null, oil: null,
      stft: null, ltft: null, cat: null, rpm: null,
    });
    const f = computeFlags(v, q);
    expect(f.lambda.on, 'blank lambda does not light "running rich"').toBe(false);
    expect(f.coolant.on, 'blank coolant does not light an overheat warning').toBe(false);
    expect(f.volt.on, 'blank voltage does not light "not charging"').toBe(false);
    expect(f.oil.on, 'blank oil temperature does not light a warning').toBe(false);
    expect(f.trim.on, 'blank fuel trims do not light a leak warning').toBe(false);
  });

  it('a genuinely lean lambda still warns', () => {
    const [v, q] = m.merge({ lambda: 1.25, coolant: 90, volt: 14.0 });
    const f = computeFlags(v, q);
    expect(f.lambda.on).toBe(true);
    expect(f.lambda.text).toBe('⚠ running lean');
    // 'and the value is shown'
    expect(n(v.lambda, 3)).toBe('1.250');
  });

  it('a genuine overheat still warns', () => {
    const [v, q] = m.merge({ coolant: 115, lambda: 1.0 });
    const f = computeFlags(v, q);
    expect(f.coolant.on).toBe(true);
    // 'a healthy lambda does not warn'
    expect(f.lambda.on).toBe(false);
  });

  it('a held reading does not sustain the warning it raised while fresh', () => {
    m.merge({ coolant: 115 });                    // fresh, warning on
    const [v, q] = m.merge({ coolant: null });    // now held
    const f = computeFlags(v, q);
    // 'the value is being held'
    expect(q.coolant).toBeTruthy();
    // 'the last reading is still shown' — blanking it was the original bug; the
    // driver still wants to know what it said.
    expect(round(v.coolant)).toBe('115');
    // 'but the overheat warning is not sustained on stale data' — a value from two
    // seconds ago cannot tell you whether the engine is still overheating.
    expect(f.coolant.on).toBe(false);
    expect(f.coolant.valueLevel).toBe('');
    // 'and it renders dimmed'
    expect(readout(round(v.coolant), q.coolant).stale).toBe(true);
  });

  it('a fresh reading clears the dim', () => {
    const [v, q] = m.merge({ coolant: 88 });
    expect(readout(round(v.coolant), q.coolant).stale).toBe(false);
  });
});

// Threshold coverage the firmware suite left to the on-car screenshots. Added here
// because a lib function is cheap to pin and a threshold silently drifting by ten
// degrees is not something the DOM tests would have caught either.
describe('thresholds', () => {
  const fresh = (o) => [o, {}];

  it('coolant escalates warn then crit', () => {
    expect(computeFlags(...fresh({ coolant: 102 })).coolant.on).toBe(false);
    expect(computeFlags(...fresh({ coolant: 103 })).coolant.level).toBe('warn');
    expect(computeFlags(...fresh({ coolant: 110 })).coolant.level).toBe('crit');
    expect(computeFlags(...fresh({ coolant: 110 })).coolant.text)
      .toBe('⚠ overheating — stop safely');
  });

  it('oil escalates warn then crit', () => {
    expect(computeFlags(...fresh({ oil: 114 })).oil.on).toBe(false);
    expect(computeFlags(...fresh({ oil: 115 })).oil.level).toBe('warn');
    expect(computeFlags(...fresh({ oil: 125 })).oil.level).toBe('crit');
  });

  it('lambda warns at both ends but only colours the lean one', () => {
    expect(computeFlags(...fresh({ lambda: 1.10 })).lambda.text).toBe('⚠ running lean');
    expect(computeFlags(...fresh({ lambda: 1.10 })).lambda.valueLevel).toBe('warn');
    expect(computeFlags(...fresh({ lambda: 0.85 })).lambda.text).toBe('● running rich');
    expect(computeFlags(...fresh({ lambda: 0.85 })).lambda.valueLevel).toBe('');
    expect(computeFlags(...fresh({ lambda: 1.0 })).lambda.on).toBe(false);
  });

  it('trims are judged on their total, not individually', () => {
    // +18 and -14 is a system correcting, not a leak.
    expect(computeFlags(...fresh({ stft: 18, ltft: -14 })).trim.on).toBe(false);
    expect(computeFlags(...fresh({ stft: 12, ltft: 9 })).trim.on).toBe(true);
    // ...and it is symmetric, because over-fuelling is a fault too.
    expect(computeFlags(...fresh({ stft: -12, ltft: -9 })).trim.on).toBe(true);
  });

  it('voltage warns at both ends', () => {
    expect(computeFlags(...fresh({ volt: 12.1 })).volt.text).toBe('⚠ not charging');
    expect(computeFlags(...fresh({ volt: 14.0 })).volt.on).toBe(false);
    expect(computeFlags(...fresh({ volt: 15.3 })).volt.text).toBe('⚠ overcharging');
  });

  it('rpm warns approaching redline', () => {
    expect(computeFlags(...fresh({ rpm: 5499 })).rpm.on).toBe(false);
    expect(computeFlags(...fresh({ rpm: 5500 })).rpm.text).toBe('▲ approaching redline');
  });

  it('catalyst escalates warn then crit', () => {
    expect(computeFlags(...fresh({ cat: 799 })).cat.on).toBe(false);
    expect(computeFlags(...fresh({ cat: 800 })).cat.level).toBe('warn');
    expect(computeFlags(...fresh({ cat: 900 })).cat.level).toBe('crit');
  });

  it('every flag stays dark when its field is held', () => {
    // The general form of the rule, rather than the five fields the screenshot
    // happened to contain.
    const v = { rpm: 6000, coolant: 120, oil: 130, lambda: 1.4, stft: 20, ltft: 20,
                cat: 950, volt: 10 };
    const q = { rpm: 1, coolant: 1, oil: 1, lambda: 1, stft: 1, ltft: 1, cat: 1, volt: 1 };
    for (const [name, f] of Object.entries(computeFlags(v, q))) {
      expect(f.on, `${name} must not warn on a held reading`).toBe(false);
    }
  });
});
