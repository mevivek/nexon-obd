// The board's sampling receipt, decoded.
//
// The rule under most of these: a number that is not known must not render as a
// number. This module exists to make the page honest about how fast it is really
// reading the car, and a readout that says 0.0 Hz while the first pass is still
// being timed, or names a batch as stale because it is merely waiting its turn,
// would be worse than saying nothing at all.

import { describe, it, expect } from 'vitest';
import {
  boardHz, stalest, ageText, qualityText, pageIsBehind, BATCHES,
} from './quality.js';

/** A plausible fresh sample over direct CAN. */
const CAN = { cycleMs: 300, batchMs: 48, staleMs: 3000, hz: 20, bAge: [12, 140, 220, 60], share: false };
/** BLE: slower, wider window, b3 legitimately behind but inside it. */
const BLE = { cycleMs: 3200, batchMs: 540, staleMs: 9600, hz: 1.87, bAge: [180, 2400, 6800, 900], share: false };

describe('boardHz', () => {
  it('reports the board figure', () => {
    expect(boardHz(CAN)).toBe(20);
    expect(boardHz(BLE)).toBeCloseTo(1.87);
  });

  it('keeps "not measured yet" apart from "zero"', () => {
    // The firmware sends null until a full SAMPLE_ORDER pass has been timed. A rate
    // of zero is a claim that the bus is dead; not having measured one is not that
    // claim, and the first second of every drive is spent in this state.
    expect(boardHz({ ...CAN, hz: null })).toBe(null);
    expect(boardHz({})).toBe(null);
    expect(boardHz(null)).toBe(null);
    expect(boardHz(undefined)).toBe(null);
    // But a real zero survives, because a genuinely stalled sampler should say so.
    expect(boardHz({ ...CAN, hz: 0 })).toBe(0);
  });

  it('refuses anything that is not a finite number', () => {
    for (const bad of ['1.5', NaN, Infinity, -Infinity, {}, []]) {
      expect(boardHz({ ...CAN, hz: bad })).toBe(null);
    }
  });
});

describe('stalest', () => {
  it('finds the batch furthest behind', () => {
    const w = stalest(CAN);
    expect(w.name).toBe('b3');
    expect(w.ageMs).toBe(220);
  });

  it('judges expiry against the board\'s own window, not a constant', () => {
    // b3 at 6.8 s is far past CAN's 3 s window and comfortably inside BLE's 9.6 s
    // one. The window is derived from the measured cycle time precisely so a slow
    // link is not reported as a broken one, and a fixed threshold here would undo
    // that on the page.
    expect(stalest(BLE).name).toBe('b3');
    expect(stalest(BLE).expired).toBe(false);
    expect(stalest({ ...BLE, staleMs: 3000 }).expired).toBe(true);
  });

  it('ranks a batch that has never answered above any age', () => {
    // Never-answered and long-ago-answered have different causes: the first is
    // usually a PID this ECU does not support, the second is a link going bad.
    // Reporting the first as a very large age would present one as the other.
    const w = stalest({ ...CAN, bAge: [12, null, 999999, 60] });
    expect(w.name).toBe('b2');
    expect(w.never).toBe(true);
    expect(w.ageMs).toBe(null);
    expect(w.expired).toBe(true);
  });

  it('says nothing when there is nothing to say', () => {
    expect(stalest(null)).toBe(null);
    expect(stalest({})).toBe(null);
    expect(stalest({ bAge: [] })).toBe(null);
  });

  it('names batches by the order the firmware emits them', () => {
    expect(BATCHES).toEqual(['b1', 'b2', 'b3', 'b4']);
    for (let i = 0; i < BATCHES.length; i++) {
      const bAge = [0, 0, 0, 0];
      bAge[i] = 5000;
      expect(stalest({ ...CAN, bAge }).name).toBe(BATCHES[i]);
    }
  });
});

describe('ageText', () => {
  it('picks the precision the number deserves', () => {
    expect(ageText(840)).toBe('840 ms');
    expect(ageText(1300)).toBe('1.3 s');
    expect(ageText(0)).toBe('0 ms');
  });

  it('renders an absent age as nothing', () => {
    expect(ageText(null)).toBe('');
    expect(ageText(undefined)).toBe('');
  });
});

describe('qualityText', () => {
  it('states the rate', () => {
    expect(qualityText(CAN)).toBe('20.00 Hz');
  });

  it('does not complain about a batch that is merely waiting its turn', () => {
    // b2 and b3 come round once every four turns by design, so every batch is
    // always somewhat behind. Naming the worst one unconditionally would put a
    // permanent warning on a page where nothing is wrong.
    expect(qualityText(BLE)).toBe('1.87 Hz');
  });

  it('names the stalest batch once it is genuinely past the window', () => {
    expect(qualityText({ ...BLE, staleMs: 3000 })).toBe('1.87 Hz · b3 6.8 s');
  });

  it('says a batch is silent rather than giving it an age it does not have', () => {
    expect(qualityText({ ...CAN, bAge: [12, null, 220, 60] })).toBe('20.00 Hz · b2 silent');
  });

  it('says when the scanner is taking the bus', () => {
    // Otherwise a rate that has dropped by a factor of ten reads as a fault, when
    // it is the sampler deliberately running on its slow share.
    expect(qualityText({ ...CAN, hz: 0.5, share: true })).toBe('0.50 Hz · sharing with scan');
  });

  it('renders as empty rather than as a fabricated rate', () => {
    expect(qualityText(null)).toBe('');
    expect(qualityText({})).toBe('');
    expect(qualityText({ hz: null, bAge: [null, null, null, null] })).toBe('b1 silent');
  });
});

describe('pageIsBehind', () => {
  it('spots the page seeing fewer samples than the board publishes', () => {
    expect(pageIsBehind(2.0, 1.0)).toBe(true);
  });

  it('tolerates the ordinary wobble of a trailing window', () => {
    // The page measures over a handful of samples and will not sit exactly on the
    // board's figure even when both are healthy.
    expect(pageIsBehind(2.0, 1.9)).toBe(false);
    expect(pageIsBehind(2.0, 1.6)).toBe(false);
  });

  it('never reports on numbers it does not have', () => {
    expect(pageIsBehind(null, 1.0)).toBe(false);
    expect(pageIsBehind(2.0, null)).toBe(false);
    expect(pageIsBehind(0, 0)).toBe(false);
  });
});
