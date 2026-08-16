import { describe, it, expect } from 'vitest';
import { pushHist, seedHistory, emptyHistory, isFreshSlot, HSLOT, HP } from './hist.js';

describe('history buffers', () => {
  it('one hour at six seconds a slot', () => {
    expect((HSLOT * HP) / 1000 / 60).toBe(60);
  });

  it('overwrites within a slot and appends across one', () => {
    // Polling is ~8 Hz and a slot is 6 s, so all but the first sample in a slot
    // replace it — otherwise the chart is the last seventy seconds, not the hour.
    const a = [];
    pushHist(a, 800, true);
    pushHist(a, 900, false);
    pushHist(a, 1000, false);
    expect(a).toEqual([1000]);
    pushHist(a, 1500, true);
    expect(a).toEqual([1000, 1500]);
  });

  it('the first sample always lands, slot boundary or not', () => {
    const a = [];
    pushHist(a, 42, false);
    expect(a).toEqual([42]);
  });

  it('a held reading is never replayed into the chart', () => {
    // The caller passes null for held values. Repeating the last one would draw a
    // flat run the car never actually did, which is the one lie a trend line
    // must not tell.
    const a = [1, 2];
    pushHist(a, null, true);
    pushHist(a, undefined, true);
    pushHist(a, NaN, true);
    expect(a).toEqual([1, 2]);
  });

  it('a zero reading is a reading', () => {
    // Stationary is 0 km/h, not "no speed".
    const a = [];
    pushHist(a, 0, true);
    expect(a).toEqual([0]);
  });

  it('drops the oldest slot past an hour', () => {
    const a = Array.from({ length: HSLOT }, (_, i) => i);
    pushHist(a, 9999, true);
    expect(a.length).toBe(HSLOT);
    expect(a[0]).toBe(1);
    expect(a[a.length - 1]).toBe(9999);
  });

  it('seeds the four series the board records', () => {
    const h = seedHistory({ rpm: [800, 900], speed: [0, 5], boost: [-0.3], coolant: [88], extra: [1] });
    expect(h.rpm).toEqual([800, 900]);
    expect(h.speed).toEqual([0, 5]);
    expect(h.boost).toEqual([-0.3]);
    expect(h.coolant).toEqual([88]);
    expect(h.extra).toBeUndefined();
  });

  it('drops gaps rather than drawing through them', () => {
    // An empty slot comes back null; a null in a polyline is a hole in the line.
    expect(seedHistory({ rpm: [800, null, 900, NaN] }).rpm).toEqual([800, 900]);
  });

  it('survives a board with no history to give', () => {
    // A chart with no seed is cosmetic; a page that throws on load is not.
    expect(seedHistory({})).toEqual(emptyHistory());
    expect(seedHistory(null)).toEqual(emptyHistory());
    expect(seedHistory({ rpm: 'nope' })).toEqual(emptyHistory());
  });

  it('slot boundary is exactly the history period', () => {
    expect(isFreshSlot(HP, 0)).toBe(true);
    expect(isFreshSlot(HP - 1, 0)).toBe(false);
  });
});
