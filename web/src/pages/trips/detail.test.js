// Reading a drive back out of its own CSV.
//
// The assertions that matter here are about honesty, not arithmetic: an empty cell
// is not a zero, a half-written last row is not a reading, an unset clock is not a
// timestamp, and a spike must survive being drawn. Each of those is a way for this
// screen to state something the car never did.

import { describe, it, expect } from 'vitest';
import {
  parseTripCsv, series, tripSummary, downsample, durationText, boostSeries,
  TRACE_POINTS,
} from './detail.js';
import { boost } from '../../lib/derive.js';
import { TRIP_MIN_KM, TRIP_MIN_L, tripAverage } from '../../lib/mileage.js';

const HEAD = '# nexonobd 1.11.3 trip 29 started_epoch_ms=1756450000000 clock=set';
const COLS = 'epoch_ms,uptime_ms,rpm,speed,coolant_c,oil_c,trip_km,trip_l';

const csv = (...rows) => [HEAD, COLS, ...rows].join('\n');

describe('parsing', () => {
  it('reads the metadata comment', () => {
    const p = parseTripCsv(csv('1756450000000,1000,900,0,72,70,0.000,0.0000'));
    expect(p.meta.fw).toBe('1.11.3');
    expect(p.meta.seq).toBe(29);
    expect(p.meta.startedMs).toBe(1756450000000);
    expect(p.meta.clock).toBe('set');
  });

  it('reads columns by name, not by position', () => {
    // The trailing watch-set columns are variable and TRIP_COLS can grow. A series
    // pinned to an index would quietly start plotting its neighbour.
    const shifted = ['# nexonobd 1.11.3 trip 1 started_epoch_ms=0 clock=unset',
      'epoch_ms,uptime_ms,speed,rpm,trip_km,trip_l',
      '0,1000,42,1873,1.000,0.1000'].join('\n');
    const p = parseTripCsv(shifted);
    expect(series(p, 'speed')).toEqual([42]);
    expect(series(p, 'rpm')).toEqual([1873]);
  });

  it('keeps an empty cell absent rather than turning it into a zero', () => {
    // triplog.h writes an empty cell for a reading it did not have. A zero here
    // would put a number the ECU never sent into a trace and into a maximum — the
    // same trap every threshold in flags.js is gated against.
    const p = parseTripCsv(csv('0,1000,,0,72,,0.000,0.0000'));
    expect(series(p, 'rpm')).toEqual([null]);
    expect(series(p, 'oil_c')).toEqual([null]);
    expect(series(p, 'speed')).toEqual([0]);
  });

  it('drops a torn last row and says how many it dropped', () => {
    // The board flushes every ten seconds and the ignition cuts when it cuts, so a
    // half-written final line is the normal ending of a real file, not corruption.
    const p = parseTripCsv(csv(
      '0,1000,900,0,72,70,0.000,0.0000',
      '0,2000,1200,10,74,71,0.100,0.0100',
      '0,3000,1300,12',
    ));
    expect(p.rows).toHaveLength(2);
    expect(p.skipped).toBe(1);
  });

  it('survives a file with nothing in it', () => {
    for (const t of ['', '\n', HEAD, HEAD + '\n', null, undefined]) {
      const p = parseTripCsv(t);
      expect(p.rows).toEqual([]);
      expect(p.columns).toEqual([]);
    }
    expect(series(parseTripCsv(''), 'speed')).toEqual([]);
  });

  it('returns nothing for a column the file does not have', () => {
    // An older board, or a trip recorded before a column was added.
    expect(series(parseTripCsv(csv('0,1000,900,0,72,70,0,0')), 'lambda')).toEqual([]);
  });
});

describe('the summary', () => {
  const drive = parseTripCsv(csv(
    '1756450000000,60000,900,0,72,70,0.000,0.0000',
    '1756450060000,120000,2400,48,88,95,2.400,0.1900',
    '1756450120000,180000,1500,31,91,118,4.800,0.3600',
  ));

  it('differences the totals the board integrated, rather than re-integrating', () => {
    // triplog.h integrates trip_km and trip_l on the board precisely so any span
    // can be recovered by subtraction. Re-accumulating from speed and fuel rate
    // here would produce a second, slightly different answer to a question that
    // already has one — and the Live tile is the one it has to match.
    const s = tripSummary(drive);
    expect(s.km).toBeCloseTo(4.8, 6);
    expect(s.litres).toBeCloseTo(0.36, 6);
    expect(s.kmPerL).toBeCloseTo(4.8 / 0.36, 6);
    expect(s.kmPerL).toBe(tripAverage(4.8, 0.36));
  });

  it('takes duration from uptime, not from the wall clock', () => {
    // The board has no clock of its own and learns the time from whichever page you
    // open, so epoch_ms is unset for the first rows of a drive that started before
    // you opened one. Uptime is always real, which is why both columns exist.
    expect(tripSummary(drive).seconds).toBe(120);

    const noClock = parseTripCsv([
      '# nexonobd 1.11.3 trip 30 started_epoch_ms=0 clock=unset', COLS,
      '0,60000,900,0,72,70,0.000,0.0000',
      '0,240000,1500,31,91,118,4.800,0.3600',
    ].join('\n'));
    expect(tripSummary(noClock).seconds).toBe(180);
    expect(tripSummary(noClock).clockSet).toBe(false);
    expect(tripSummary(drive).clockSet).toBe(true);
  });

  it('withholds an average over too little of a drive', () => {
    // Same rule as the Live tile, from the same module: 0.4 km over 0.02 L is
    // arithmetic, not a mileage, and it swings by tens of km/L between rows.
    const tiny = parseTripCsv(csv(
      '0,1000,900,0,72,70,0.000,0.0000',
      '0,2000,900,3,72,70,' + (TRIP_MIN_KM / 2) + ',' + (TRIP_MIN_L / 2),
    ));
    const s = tripSummary(tiny);
    expect(s.km).toBeGreaterThan(0);
    expect(s.kmPerL).toBe(null);
  });

  it('reports the peaks a drive is judged on', () => {
    const s = tripSummary(drive);
    expect(s.maxSpeed).toBe(48);
    expect(s.maxRpm).toBe(2400);
    expect(s.peakCoolant).toBe(91);
    expect(s.peakOil).toBe(118);
  });

  it('says nothing rather than zero when the totals are missing', () => {
    // A file from a board that never got a distance reading has no distance, which
    // is not the same as a drive of no distance.
    const blank = parseTripCsv(csv('0,1000,900,0,72,70,,'));
    const s = tripSummary(blank);
    expect(s.km).toBe(null);
    expect(s.litres).toBe(null);
    expect(s.kmPerL).toBe(null);
  });
});

describe('downsampling a trace', () => {
  it('leaves a short drive alone', () => {
    const few = [1, 2, 3, 4, 5];
    expect(downsample(few)).toEqual(few);
  });

  it('drops absent readings rather than plotting them as zero', () => {
    expect(downsample([1, null, 3, null])).toEqual([1, 3]);
    expect(downsample([null, null])).toEqual([]);
  });

  it('keeps a spike that averaging would erase', () => {
    // The failure this exists to prevent: a four-second coolant excursion in an
    // hour-long drive, averaged against its neighbours, vanishes — and a trace that
    // hides an overheat is worse than no trace at all.
    const long = new Array(4000).fill(90);
    long[2000] = 121;
    const out = downsample(long);
    expect(Math.max(...out)).toBe(121);
    expect(out.length).toBeLessThanOrEqual(TRACE_POINTS * 2);
  });

  it('keeps the dip too, not just the peak', () => {
    const long = new Array(4000).fill(50);
    long[1234] = 0;
    expect(Math.min(...downsample(long))).toBe(0);
  });

  it('keeps each bucket in the order it happened', () => {
    // Within a bucket the min and max are emitted in time order, so the line does
    // not zigzag backwards through the drive.
    const rising = Array.from({ length: 4000 }, (_, i) => i);
    const out = downsample(rising);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
  });

  it('bounds the output whatever the file size', () => {
    // TRIP_MAX_BYTES is 512 KB at ~140 bytes a row: about 3 700 rows, and a rotated
    // drive can hand over several files' worth.
    for (const n of [1000, 4000, 20000]) {
      const out = downsample(Array.from({ length: n }, (_, i) => i % 97));
      expect(out.length).toBeLessThanOrEqual(TRACE_POINTS * 2);
    }
  });
});

describe('duration text', () => {
  it('drops the hour on a short drive and keeps it on a long one', () => {
    expect(durationText(0)).toBe('0:00');
    expect(durationText(65)).toBe('1:05');
    expect(durationText(1632)).toBe('27:12');
    expect(durationText(4327)).toBe('1:12:07');
  });

  it('stays null when there is no duration to state', () => {
    expect(durationText(null)).toBe(null);
  });
});

describe('boost, which is not a column', () => {
  const p = parseTripCsv([
    '# nexonobd 1.11.3 trip 31 started_epoch_ms=0 clock=set',
    'epoch_ms,uptime_ms,map_kpa,baro_kpa',
    '0,1000,141,99',
    '0,2000,40,99',
    '0,3000,,99',
  ].join('\n'));

  it('is derived through derive.js, not recomputed here', () => {
    // MAP against barometric is the same rule the Live tile uses. A second /100
    // living in this file would be a second definition of one derived value, and
    // the two would part company the first time either was corrected.
    const b = boostSeries(p);
    expect(b[0]).toBeCloseTo(0.42, 6);
    expect(b[1]).toBeCloseTo(-0.59, 6);
    expect(b[0]).toBeCloseTo(boost({ map: 141, baro: 99 }, {}).bar, 6);
  });

  it('stays absent where either input was', () => {
    expect(boostSeries(p)[2]).toBe(null);
  });

  it('is empty when the file predates either column', () => {
    expect(boostSeries(parseTripCsv(csv('0,1000,900,0,72,70,0,0')))).toEqual([]);
  });
});
