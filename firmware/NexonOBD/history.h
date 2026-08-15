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
// The flush therefore runs as often as a slot is recorded, so a power cut costs at
// most one 6-second sample rather than a chunk of the drive.
//
// That is only affordable because a flush writes the slots that changed, not the
// whole ring. Rewriting all 4800 bytes every time - which is what it used to do -
// costs somewhere over a sector erase per save, and at these intervals would burn
// through NVS endurance in a couple of years. Writing one 400-byte chunk instead is
// about a tenth of that, so saving ten times more often still churns less flash
// than the old sixty-second full-buffer write did.
//
// 600 slots x 6 s = 3600 s exactly. Four int16 series is 4800 bytes, which fits the
// 8 KB of RTC slow memory with room to spare.

static const uint16_t HIST_SLOTS     = 600;
static const uint32_t HIST_PERIOD_MS = 6000;
static const uint32_t HIST_SAVE_MS   = 6000;                   // i.e. every new slot
static const int16_t  HIST_NONE      = INT16_MIN;              // nothing recorded

// The ring is persisted in chunks so a flush only rewrites what moved. 50 slots is
// five minutes of data, so any one flush touches a single chunk in normal running.
static const uint16_t HIST_CHUNK  = 50;
static const uint16_t HIST_CHUNKS = HIST_SLOTS / HIST_CHUNK;
static_assert(HIST_SLOTS % HIST_CHUNK == 0, "chunks must divide the ring evenly");
static_assert(HIST_CHUNKS <= 16, "the dirty mask is 16 bits");

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
static uint16_t    histDirtyMask = 0;      // one bit per chunk awaiting a flush

static void histReset() {
  histMagic = HIST_MAGIC;
  histHead = 0;
  histCount = 0;
  for (uint16_t i = 0; i < HIST_SLOTS; i++)
    histBuf[i] = {HIST_NONE, HIST_NONE, HIST_NONE, HIST_NONE};
}

static void histChunkKey(char *out, size_t n, uint16_t c) {
  snprintf(out, n, "c%u", (unsigned)c);
}

static void histSave() {
  if (!histDirtyMask) return;
  if (!histPrefs.begin("nexonhist", false)) return;
  char key[8];
  for (uint16_t c = 0; c < HIST_CHUNKS; c++) {
    if (!(histDirtyMask & (uint16_t)(1u << c))) continue;
    histChunkKey(key, sizeof(key), c);
    histPrefs.putBytes(key, &histBuf[c * HIST_CHUNK],
                       (size_t)HIST_CHUNK * sizeof(HistSlot));
  }
  histPrefs.putUShort("head", histHead);
  histPrefs.putUShort("count", histCount);
  histPrefs.end();
  histDirtyMask = 0;
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
  if (!histPrefs.begin("nexonhist", false)) return;   // read-write: may need to migrate

  // Firmware before 1.3.0 kept the whole ring under one 4800-byte key. Left in
  // place that would occupy most of the NVS partition and starve the chunked
  // writes, so it is read once, carried over, and removed.
  if (histPrefs.getBytesLength("buf") == sizeof(histBuf)) {
    histPrefs.getBytes("buf", histBuf, sizeof(histBuf));
    histHead  = histPrefs.getUShort("head", 0);
    histCount = histPrefs.getUShort("count", 0);
    histPrefs.remove("buf");
    histDirtyMask = (uint16_t)((1u << HIST_CHUNKS) - 1);   // rewrite it chunked
    if (histCount > HIST_SLOTS || histHead >= HIST_SLOTS) histReset();
    else Serial.printf("[hist] %u samples migrated from the old layout\n", histCount);
    histPrefs.end();
    return;
  }

  uint16_t head = histPrefs.getUShort("head", 0xFFFF);
  uint16_t count = histPrefs.getUShort("count", 0xFFFF);
  if (head < HIST_SLOTS && count <= HIST_SLOTS) {
    char key[8];
    for (uint16_t c = 0; c < HIST_CHUNKS; c++) {
      histChunkKey(key, sizeof(key), c);
      if (histPrefs.getBytesLength(key) == (size_t)HIST_CHUNK * sizeof(HistSlot))
        histPrefs.getBytes(key, &histBuf[c * HIST_CHUNK],
                           (size_t)HIST_CHUNK * sizeof(HistSlot));
    }
    histHead = head;
    histCount = count;
    Serial.printf("[hist] %u samples restored from flash\n", histCount);
  }
  histPrefs.end();
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
  histDirtyMask |= (uint16_t)(1u << (histHead / HIST_CHUNK));
  histHead = (uint16_t)((histHead + 1) % HIST_SLOTS);
  if (histCount < HIST_SLOTS) histCount++;

  if (now - histLastSave > HIST_SAVE_MS) histSave();
}

// Oldest-first index walk, so the JSON reads left to right like the chart.
static uint16_t histIndex(uint16_t i) {
  uint16_t start = (histCount == HIST_SLOTS) ? histHead : 0;
  return (uint16_t)((start + i) % HIST_SLOTS);
}
