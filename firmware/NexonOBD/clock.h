#pragma once
#include <Arduino.h>

// Wall-clock time, borrowed from whichever phone opens the dashboard.
//
// The board has no RTC crystal and no network to ask, so on its own it only knows
// how long it has been running. That is fine for a live gauge and useless for a
// log: "sample 412" says nothing about when you were driving.
//
// The browser already knows the time, so it hands it over on load and the board
// keeps the offset. Held in RTC memory so it survives deep sleep, and re-sent on
// every page load so drift never accumulates - the ESP32's internal oscillator is
// not good enough to trust over hours, and it costs nothing to correct.
//
// It does NOT survive a power cut. On a board wired to the ignition that means the
// clock is unknown from key-on until the first page load, which is why everything
// that records time also records whether the clock was set at the time.

#define CLK_MAGIC 0x4E58434BUL

RTC_DATA_ATTR static uint32_t clkMagic;
RTC_DATA_ATTR static int64_t  clkOffsetMs;     // epoch milliseconds - millis()

static bool clockSet() { return clkMagic == CLK_MAGIC; }

static void clockSetFrom(int64_t epochMs) {
  // Sanity floor: anything before 2020 is a broken client rather than a real clock.
  if (epochMs < 1577836800000LL) return;
  clkOffsetMs = epochMs - (int64_t)millis();
  clkMagic = CLK_MAGIC;
}

// Epoch milliseconds, or 0 when nobody has told us the time yet.
static int64_t clockNowMs() {
  return clockSet() ? clkOffsetMs + (int64_t)millis() : 0;
}

// Epoch milliseconds for a moment in the past, expressed as a millis() stamp.
static int64_t clockAtMs(uint32_t atMillis) {
  return clockSet() ? clkOffsetMs + (int64_t)atMillis : 0;
}
