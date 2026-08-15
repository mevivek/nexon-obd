#pragma once
#include <Arduino.h>
#include <Preferences.h>
#include "obd_types.h"

// One hour of trend data, held across restarts.
//
// The board restarts constantly in normal use, so history in ordinary RAM would be
// wiped every time you got back in the car and the graphs would always start flat.
// How it restarts depends on the wiring:
//
//   powered from the ignition - power is simply cut when the car goes off
//   powered from OBD pin 16   - always live, so it deep-sleeps after 10 idle
//                               minutes and wakes every 30 s, re-running setup()
//
// RTC slow memory survives deep sleep at no cost, so it is kept as a free fast path
// for the restarts that do not cut power: an OTA reboot, a crash, the idle sleep.
//
// It is NOT the store that matters on a board wired to switch off with the car,
// which is the common case. RTC contents do not survive power loss, and the save on
// the way into deep sleep never runs either - the power simply goes. That leaves the
// periodic NVS write as the only thing standing between a trip's history and
// nothing, so it runs about once a minute rather than the ten it began with. A power
// cut then costs at most the last minute.
//
// Roughly sixty writes per hour of driving is comfortably inside NVS endurance;
// writing every few seconds instead would not be, and would buy very little.
//
// 600 slots x 6 s = 3600 s exactly. Four int16 series is 4800 bytes, which fits the
// 8 KB of RTC slow memory with room to spare.

static const uint16_t HIST_SLOTS     = 600;
static const uint32_t HIST_PERIOD_MS = 6000;
static const uint32_t HIST_SAVE_MS   = 60UL * 1000UL;          // NVS heartbeat
static const int16_t  HIST_NONE      = INT16_MIN;              // nothing recorded

struct HistSlot {
  int16_t rpm;        // rpm
  int16_t speed;      // km/h
  int16_t boost;      // centibar, so -0.08 bar stores as -8
  int16_t coolant;    // deg C
};

// RTC_DATA_ATTR survives deep sleep but not a power cut, and is zeroed on a fresh
// boot - hence the magic, which also invalidates the buffer if the layout changes.
#define HIST_MAGIC 0x4E584802UL
RTC_DATA_ATTR static uint32_t histMagic;
RTC_DATA_ATTR static uint16_t histHead;      // next slot to write
RTC_DATA_ATTR static uint16_t histCount;     // slots filled, saturating at HIST_SLOTS
RTC_DATA_ATTR static HistSlot histBuf[HIST_SLOTS];

static Preferences histPrefs;
static uint32_t    histLastPush = 0;
static uint32_t    histLastSave = 0;
static bool        histDirty    = false;

static void histReset() {
  histMagic = HIST_MAGIC;
  histHead = 0;
  histCount = 0;
  for (uint16_t i = 0; i < HIST_SLOTS; i++)
    histBuf[i] = {HIST_NONE, HIST_NONE, HIST_NONE, HIST_NONE};
}

static void histSave() {
  if (!histDirty) return;
  if (!histPrefs.begin("nexonhist", false)) return;
  histPrefs.putUShort("head", histHead);
  histPrefs.putUShort("count", histCount);
  histPrefs.putBytes("buf", histBuf, sizeof(histBuf));
  histPrefs.end();
  histDirty = false;
  histLastSave = millis();
}

// RTC first - free, and correct whenever power was never lost. NVS second, which is
// what a car that switches the board off actually lands on. Empty last.
static void histBegin() {
  if (histMagic == HIST_MAGIC && histCount <= HIST_SLOTS && histHead < HIST_SLOTS) {
    Serial.printf("[hist] %u samples from RTC memory\n", histCount);
    return;
  }
  histReset();
  if (histPrefs.begin("nexonhist", true)) {
    size_t n = histPrefs.getBytesLength("buf");
    if (n == sizeof(histBuf)) {
      histPrefs.getBytes("buf", histBuf, sizeof(histBuf));
      histHead  = histPrefs.getUShort("head", 0);
      histCount = histPrefs.getUShort("count", 0);
      if (histCount > HIST_SLOTS || histHead >= HIST_SLOTS) histReset();
      else Serial.printf("[hist] %u samples restored from flash\n", histCount);
    }
    histPrefs.end();
  }
}

static int16_t histQuant(float v, float scale) {
  if (isnan(v)) return HIST_NONE;
  float s = v * scale;
  if (s > 32000) s = 32000;
  if (s < -32000) s = -32000;
  return (int16_t)lroundf(s);
}

// Called every loop; records at most one slot per HIST_PERIOD_MS.
static void histTick(const Live &L) {
  uint32_t now = millis();
  if (!L.ok) return;
  if (histLastPush && now - histLastPush < HIST_PERIOD_MS) return;
  histLastPush = now;

  float boostBar = (!isnan(L.map_) && !isnan(L.baro)) ? (L.map_ - L.baro) / 100.0f : NAN;

  histBuf[histHead] = {histQuant(L.rpm, 1.0f), histQuant(L.speed, 1.0f),
                       histQuant(boostBar, 100.0f), histQuant(L.coolant, 1.0f)};
  histHead = (uint16_t)((histHead + 1) % HIST_SLOTS);
  if (histCount < HIST_SLOTS) histCount++;
  histDirty = true;

  if (now - histLastSave > HIST_SAVE_MS) histSave();
}

// Oldest-first index walk, so the JSON reads left to right like the chart.
static uint16_t histIndex(uint16_t i) {
  uint16_t start = (histCount == HIST_SLOTS) ? histHead : 0;
  return (uint16_t)((start + i) % HIST_SLOTS);
}
