// Typed identifiers and the bus-cost estimate.

import { describe, it, expect } from 'vitest';
import { addTyped, costText, WATCH_MAX, fillFrom } from './picker.js';

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

describe('fillFrom', () => {
  const hits = ['E1000', 'E1001', 'E1002', 'E1003', 'E1004',
                'E1005', 'E1006', 'E1007', 'E1008', 'E1009'];

  it('fills up to the cap and no further', () => {
    // The point of the whole function. A sweep finds hundreds - this board has 214 -
    // and the board watches eight. Anything that ticks more than the cap is a set
    // the user did not choose.
    const { next, added } = fillFrom(new Set(), hits, WATCH_MAX);
    expect(next.size).toBe(WATCH_MAX);
    expect(added).toBe(WATCH_MAX);
  });

  it('takes them in the order they are offered', () => {
    // Not sorted, not arbitrary: the order on screen. If the caller has to explain
    // which eight of 214 it picked, "the first eight of the ones you can see" is the
    // only answer anybody can check.
    const { next } = fillFrom(new Set(), hits, 3);
    expect([...next]).toEqual(['E1000', 'E1001', 'E1002']);
  });

  it('keeps what is already chosen', () => {
    // An identifier already being watched may be the one holding a correlation.
    // Losing it to a convenience button would be the most annoying possible bug.
    const { next } = fillFrom(new Set(['E2FFF']), hits, 3);
    expect(next.has('E2FFF')).toBe(true);
    expect(next.size).toBe(3);
  });

  it('fills the gaps left by unticking, rather than starting over', () => {
    // The motion this exists for: work through a long hit list eight at a time.
    const first = fillFrom(new Set(), hits, 4).next;
    first.delete('E1001');
    const { next, added } = fillFrom(first, hits, 4);
    expect(added).toBe(1);
    expect(next.size).toBe(4);
    expect(next.has('E1001')).toBe(true);
  });

  it('reports how much room there was, so the caller can say what it did', () => {
    // A button that silently does nothing is the same failure as one that silently
    // truncates. room === 0 is what lets the page say "already full".
    expect(fillFrom(new Set(), hits, 8).room).toBe(8);
    expect(fillFrom(new Set(hits.slice(0, 8)), hits, 8).room).toBe(0);
    expect(fillFrom(new Set(hits.slice(0, 8)), hits, 8).added).toBe(0);
  });

  it('does not mutate the set it was given', () => {
    const sel = new Set(['E1000']);
    fillFrom(sel, hits, 8);
    expect(sel.size).toBe(1);
  });

  it('survives nothing to fill from', () => {
    expect(fillFrom(new Set(), [], 8).added).toBe(0);
    expect(fillFrom(new Set(), null, 8).added).toBe(0);
    expect(fillFrom(null, hits, 8).next.size).toBe(8);
  });
});
