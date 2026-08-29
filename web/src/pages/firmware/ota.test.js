// OTA verdicts.
//
// The only question this file really answers is "did it flash?", and the cost of
// getting it wrong is asymmetric: telling someone the board is rebooting when it is
// not sends them back to the car to find nothing changed, while a false failure
// costs one repeat upload. So anything that is not an explicit {"ok":true} is a
// failure.

import { describe, it, expect } from 'vitest';
import { OTA_MSG, otaFailText, otaOk, progressPct, uploadingText } from './ota.js';

describe('did it flash', () => {
  it('accepts only the board\'s explicit yes', () => {
    expect(otaOk('{"ok":true}')).toBe(true);
    expect(otaOk('{"ok":false}')).toBe(false);
  });

  it('treats anything that is not that JSON as a failure', () => {
    // Update.printError() answers in plain text, and a connection that dies between
    // the last byte and the reply answers with nothing at all. Neither may read as
    // a successful flash.
    expect(otaOk('')).toBe(false);
    expect(otaOk('ERROR: Bad Size')).toBe(false);
    expect(otaOk('<html>404</html>')).toBe(false);
    expect(otaOk('null')).toBe(false);
    expect(otaOk('{"ok":"true"')).toBe(false);   // truncated body
  });
});

describe('progress', () => {
  it('is a whole-percent CSS width', () => {
    expect(progressPct(0, 1000)).toBe('0%');
    expect(progressPct(500, 1000)).toBe('50%');
    expect(progressPct(1000, 1000)).toBe('100%');
  });

  it('does not divide by a zero-length upload', () => {
    expect(progressPct(0, 0)).toBe('0%');
  });

  it('states the size being sent, truncated to KB', () => {
    expect(uploadingText(1048576)).toBe('Uploading 1024 KB...');
    expect(uploadingText(1536)).toBe('Uploading 1 KB...');
    expect(uploadingText(0)).toBe('Uploading 0 KB...');
  });
});

describe('what the driver is told', () => {
  it('says what to do next on success', () => {
    // The board is about to disappear off the network on purpose; saying so is the
    // difference between a successful flash and an apparently dead board.
    expect(OTA_MSG.ok).toBe('Flashed. Rebooting - reconnect to Obdurate in a few seconds.');
  });

  it('carries the board\'s own words on failure', () => {
    // Which check refused is in the body — "Bad Size" and "Not Enough Space" send
    // you to different fixes.
    expect(otaFailText('ERROR: Bad Size')).toBe('Update failed: ERROR: Bad Size');
  });

  it('distinguishes a lost connection from a refused image', () => {
    expect(OTA_MSG.lost).toBe('Connection lost during upload.');
  });
});
