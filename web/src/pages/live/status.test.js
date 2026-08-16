// The MISS_MAX rule and the scan banner's counts.
//
// This is the logic that decides whether the page tells the driver the car has
// stopped answering, so the case that matters most is the one where it must keep
// quiet: a single dropped reply.

import { describe, it, expect } from 'vitest';
import { nextStatus, scanInfo, MISS_MAX, POLL_MS } from './status.js';

describe('status machine', () => {
  it('polls at the firmware page cadence', () => {
    expect(POLL_MS).toBe(120);
  });

  it('a good sample reads live', () => {
    const st = nextStatus(0, { ok: true, held: 0 });
    expect(st.status).toEqual({ cls: 'live', text: 'live' });
    expect(st.miss).toBe(0);
  });

  it('says how many fields are being held', () => {
    expect(nextStatus(0, { ok: true, held: 2 }).status.text).toBe('live · holding 2');
  });

  it('a scan is announced ahead of the hold count', () => {
    // Scanning explains the slow updates; the hold count would only repeat it.
    expect(nextStatus(0, { ok: true, held: 3, scan: true }).status.text).toBe('live · scanning');
  });

  it('one dropped reply changes nothing on screen', () => {
    // The whole point of the counter: the values are held through a miss anyway, and
    // flipping the text to "no data" once a second reads as a fault when nothing is
    // actually wrong.
    const st = nextStatus(0, { failed: true });
    expect(st.status).toBeNull();
    expect(st.miss).toBe(1);
  });

  it('stays quiet right up to the threshold', () => {
    let miss = 0;
    for (let i = 1; i < MISS_MAX; i++) {
      const st = nextStatus(miss, { failed: true });
      miss = st.miss;
      expect(st.status).toBeNull();
    }
    expect(miss).toBe(MISS_MAX - 1);
    expect(nextStatus(miss, { failed: true }).status).toEqual({
      cls: 'dead',
      text: 'ESP32 unreachable',
    });
  });

  it('an unreachable board leaves the Hz readout alone', () => {
    // Deliberate, and carried over from the firmware page: the last measured rate
    // next to a dead dot says more than an empty space.
    const st = nextStatus(MISS_MAX - 1, { failed: true });
    expect(st.clearHz).toBe(false);
    expect(st.clearRate).toBe(false);
  });

  it('a reply that is not ok reports the board error after MISS_MAX', () => {
    const st = nextStatus(MISS_MAX - 1, { error: 'bus off' });
    expect(st.status).toEqual({ cls: 'stale', text: 'bus off' });
    // The trailing window is dropped: it was measured before the link stopped
    // answering and would otherwise be quoted as the current rate.
    expect(st.clearRate).toBe(true);
    expect(st.clearHz).toBe(true);
  });

  it('falls back to "no data" when the board names no error', () => {
    expect(nextStatus(MISS_MAX - 1, {}).status.text).toBe('no data');
  });

  it('a scan is not a miss', () => {
    // The scanner owns most of the bus, so /data legitimately has nothing to report.
    // Counting that towards MISS_MAX would declare the ECU gone mid-scan.
    const st = nextStatus(4, { scan: true });
    expect(st.miss).toBe(0);
    expect(st.status).toEqual({ cls: 'stale', text: 'waiting · scanning' });
  });

  it('a good sample clears the miss counter', () => {
    expect(nextStatus(4, { ok: true }).miss).toBe(0);
  });
});

describe('scan banner', () => {
  it('is off when nothing is scanning', () => {
    expect(scanInfo({ ok: true }).on).toBe(false);
  });

  it('leads with the counts, because the percentage rounds to zero for ages', () => {
    const s = scanInfo({ scan: true, scanTried: 1234, scanTotal: 65535, scanPct: 1, scanEcu: 'TCM' });
    expect(s.on).toBe(true);
    expect(s.ecu).toBe('TCM');
    expect(s.pct).toBe(1);
    expect(s.counts).toBe([1234].map((x) => x.toLocaleString())[0] + ' of ' + (65535).toLocaleString() + ' · 1%');
  });

  it('shows no counts before a total is known', () => {
    // A bare "0 of 0" is worse than nothing while the sweep is still being sized.
    expect(scanInfo({ scan: true }).counts).toBe('');
    expect(scanInfo({ scan: true }).ecu).toBe('ECM');
  });
});
