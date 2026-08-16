// Typed identifiers and the bus-cost estimate.

import { describe, it, expect } from 'vitest';
import { addTyped, costText, WATCH_MAX } from './picker.js';

const keys = (s) => [...s];

describe('typed identifiers', () => {
  it('assumes the ECM when no responder is given', () => {
    // Where all but a handful live, and the ECM prefix is the one nobody types.
    expect(keys(addTyped(new Set(), '1002'))).toEqual(['E1002']);
  });

  it('keeps an explicit responder, in either case', () => {
    expect(keys(addTyped(new Set(), 'T0140'))).toEqual(['T0140']);
    expect(keys(addTyped(new Set(), 't0140'))).toEqual(['T0140']);
    expect(keys(addTyped(new Set(), 'e1002'))).toEqual(['E1002']);
  });

  it('accepts whatever separator came out of one thumb at a kerbside', () => {
    const want = ['E1002', 'E1003', 'T0140'];
    expect(keys(addTyped(new Set(), '1002, 1003, T0140'))).toEqual(want);
    expect(keys(addTyped(new Set(), '1002 1003 T0140'))).toEqual(want);
    expect(keys(addTyped(new Set(), '1002;1003;T0140'))).toEqual(want);
    expect(keys(addTyped(new Set(), '  1002 , ,1003  T0140 '))).toEqual(want);
  });

  it('adds to the existing selection rather than replacing it', () => {
    expect(keys(addTyped(new Set(['E1002']), '1003'))).toEqual(['E1002', 'E1003']);
  });

  it('does not duplicate one already ticked in the picker', () => {
    expect(keys(addTyped(new Set(['E1002']), '1002'))).toEqual(['E1002']);
  });

  it('takes what fits rather than rejecting the lot', () => {
    // Typing nine identifiers should watch eight, not none.
    const out = addTyped(new Set(), '1001 1002 1003 1004 1005 1006 1007 1008 1009');
    expect(out.size).toBe(WATCH_MAX);
    expect(out.has('E1008')).toBe(true);
    expect(out.has('E1009')).toBe(false);
  });

  it('honours a cap the board reports rather than the default', () => {
    expect(addTyped(new Set(), '1001 1002 1003', 2).size).toBe(2);
  });

  it('leaves its input Set alone', () => {
    const sel = new Set(['E1002']);
    addTyped(sel, '1003');
    expect(keys(sel)).toEqual(['E1002']);
  });

  it('is empty text as a no-op', () => {
    expect(keys(addTyped(new Set(['E1002']), ''))).toEqual(['E1002']);
    expect(keys(addTyped(new Set(['E1002']), null))).toEqual(['E1002']);
  });
});

describe('bus cost', () => {
  it('says nothing when nothing is selected', () => {
    expect(costText(1000, 0)).toBe('');
  });

  it('quotes the transport in use and the real refresh interval', () => {
    // The refresh figure is the one that surprises people: identifiers share a
    // single round robin, so four at one per second is four seconds a lap.
    expect(costText(1000, 4)).toBe(
      '4 identifiers at one per 1 s — about 17% of the bus over BLE, ' +
      'and each one refreshes every 4.0 s.'
    );
  });

  it('reads the period in the unit it was chosen in', () => {
    expect(costText(250, 2)).toContain('at one per 250 ms');
    expect(costText(2000, 2)).toContain('at one per 2 s');
  });

  it('agrees with itself about one identifier', () => {
    expect(costText(1000, 1)).toBe(
      '1 identifier at one per 1 s — about 17% of the bus over BLE, ' +
      'and each one refreshes every 1.0 s.'
    );
  });

  it('grows the share of the bus as the period shortens', () => {
    // A BLE exchange is roughly 165 ms on this adapter — about six a second — so
    // four reads a second is most of what there is.
    expect(costText(250, 1)).toContain('about 67% of the bus');
    expect(costText(5000, 1)).toContain('about 3% of the bus');
  });
});
