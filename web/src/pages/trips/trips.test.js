// Trip-log listing.
//
// Two things here are load-bearing rather than cosmetic: the order (which decides
// which file you tap when you want "the drive I just did") and the absence of any
// client-side filtering (which is now the firmware's job, in one place).

import { describe, it, expect } from 'vitest';
import { DASH } from '../../lib/format.js';
import {
  confirmText, kb, sortTrips, storageText, tripDelHref, tripHref, tripLabel,
  tripStatus, usedPct, TRIP_POLL_MS,
} from './trips.js';

describe('byte counts', () => {
  it('shows files in KB and the partition in MB', () => {
    expect(kb(0)).toBe('0 KB');
    expect(kb(2048)).toBe('2 KB');
    expect(kb(1048575)).toBe('1024 KB');
    expect(kb(1048576)).toBe('1.0 MB');
    expect(kb(1572864)).toBe('1.5 MB');       // the 1.5 MB partition
  });

  it('an absent figure is an em-dash, not a zero', () => {
    expect(kb(null)).toBe(DASH);
    expect(kb(undefined)).toBe(DASH);
  });
});

describe('order', () => {
  it('is newest first', () => {
    // Names are zero-padded and sequential — that is why tripPath() pads them — so a
    // plain lexicographic sort is chronological and nothing has to parse a number
    // out of a filename or trust a clock the board may never have been given.
    const trips = [
      { name: '/t0002.csv' }, { name: '/t0010.csv' }, { name: '/t0001.csv' },
    ];
    expect(sortTrips(trips).map((f) => f.name))
      .toEqual(['/t0010.csv', '/t0002.csv', '/t0001.csv']);
  });

  it('does not mutate the payload it was handed', () => {
    const trips = [{ name: '/t0001.csv' }, { name: '/t0009.csv' }];
    sortTrips(trips);
    expect(trips.map((f) => f.name)).toEqual(['/t0001.csv', '/t0009.csv']);
  });

  it('survives an empty or missing list', () => {
    expect(sortTrips([])).toEqual([]);
    expect(sortTrips(undefined)).toEqual([]);
  });

  it('lists everything the board sends, unfiltered', () => {
    // The firmware decides what a trip log is (trip_names.h) and computes the count
    // and the storage figures from that same test. A filter here could only
    // disagree with the board about what it is holding — and the old one, written
    // when /trips/list still returned /scanhits.csv, would now silently hide a
    // legitimately named log if the naming ever changed.
    const trips = [{ name: '/t0001.csv' }, { name: '/t0002.csv' }];
    expect(sortTrips(trips)).toHaveLength(2);
  });
});

describe('storage figures', () => {
  it('reports used, total and free', () => {
    expect(storageText({ used: 524288, total: 1572864 }))
      .toBe('512 KB of 1.5 MB used · 1.0 MB free');
  });

  it('is blank before anything has been read', () => {
    expect(storageText(null)).toBe('');
  });

  it('sizes the bar as a percentage, and never divides by an absent filesystem', () => {
    expect(usedPct({ used: 786432, total: 1572864 })).toBe('50.0%');
    expect(usedPct({ used: 0, total: 0 })).toBe('0.0%');
    expect(usedPct(null)).toBe('0.0%');
  });
});

describe('per-file actions', () => {
  it('drops the leading slash on screen', () => {
    expect(tripLabel('/t0007.csv')).toBe('t0007.csv');
  });

  it('escapes the name into the query string it travels in', () => {
    expect(tripHref('/t0007.csv')).toBe('/trips/get?f=%2Ft0007.csv');
    expect(tripDelHref('/t0007.csv')).toBe('/trips/del?f=%2Ft0007.csv');
  });

  it('names the drive in the confirmation, because deleting one is not undoable', () => {
    expect(confirmText('/t0007.csv')).toBe('Delete t0007.csv? This cannot be undone.');
  });
});

describe('status line', () => {
  it('reads before the first poll lands', () => {
    expect(tripStatus(null, false)).toEqual({ dot: 'dot', text: 'reading…' });
  });

  it('counts trips', () => {
    expect(tripStatus({ fs: true, trips: [{}, {}] }, false))
      .toEqual({ dot: 'dot live', text: '2 trips' });
    expect(tripStatus({ fs: true, trips: [] }, false).text).toBe('0 trips');
  });

  it('a mounted-but-empty filesystem is not the same as no filesystem', () => {
    // The board is answering, so this is not a connection problem — but nothing is
    // being recorded either, which is worse news than an empty list and reads red.
    expect(tripStatus({ fs: false, trips: [] }, false))
      .toEqual({ dot: 'dot dead', text: 'no filesystem' });
  });

  it('an unreachable board outranks whatever was last shown', () => {
    expect(tripStatus({ fs: true, trips: [{}] }, true))
      .toEqual({ dot: 'dot dead', text: 'ESP32 unreachable' });
  });
});

describe('polling', () => {
  it('re-reads on the firmware page\'s interval', () => {
    expect(TRIP_POLL_MS).toBe(4000);
  });
});
