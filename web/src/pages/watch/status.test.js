import { describe, it, expect } from 'vitest';
import { watchStatus } from './status.js';

const list = (n, scanning) => ({
  dids: Array.from({ length: n }, (_, i) => ({ name: 'E100' + i })),
  scanning: !!scanning,
});

describe('the watch header', () => {
  it('counts what is being watched', () => {
    expect(watchStatus(list(3), false)).toEqual({ dot: 'dot live', text: '3 watched' });
    expect(watchStatus(list(1), false).text).toBe('1 watched');
  });

  it('says paused, not live, while a sweep has the bus', () => {
    // Watching stops dead during a sweep, and a full one takes hours. A green dot
    // over numbers that are hours old would be a lie told slowly.
    expect(watchStatus(list(3, true), false)).toEqual({
      dot: 'dot stale', text: 'paused — scanning',
    });
  });

  it('is idle with nothing watched, sweep or no sweep', () => {
    expect(watchStatus(list(0), false)).toEqual({ dot: 'dot', text: 'idle' });
    expect(watchStatus(list(0, true), false).dot).toBe('dot');
    expect(watchStatus(list(0, true), false).text).toBe('paused — scanning');
  });

  it('reports an unreachable board over anything it last knew', () => {
    expect(watchStatus(list(3), true)).toEqual({ dot: 'dot dead', text: 'ESP32 unreachable' });
  });

  it('is reading before the first poll comes back', () => {
    expect(watchStatus(null, false)).toEqual({ dot: 'dot', text: 'reading…' });
  });
});
