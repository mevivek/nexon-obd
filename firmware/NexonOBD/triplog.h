#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include "obd_types.h"
#include "clock.h"
#include "didwatch.h"

// Per-drive CSV logs on the 1.5 MB filesystem partition.
//
// The trend history is a rolling hour at 6-second resolution, kept so the charts
// have shape. This is the other thing: a full record of a drive, at a resolution
// worth analysing, that outlives the drive.
//
// LittleFS rather than SPIFFS. The board loses power the instant the ignition goes
// off, mid-write as often as not, and LittleFS is copy-on-write with no in-place
// metadata updates - it is built to survive exactly that. SPIFFS is not.
//
// Space is the real constraint. A row is roughly 140 bytes, so at one per second a
// drive costs about half a megabyte an hour and the partition holds around three
// hours. Old trips are deleted oldest-first when space runs short, so the board
// keeps a rolling record rather than filling up and silently stopping.

static const uint32_t TRIP_PERIOD_MS = 1000;    // one row per second
static const uint32_t TRIP_FLUSH_MS  = 10000;   // how much a power cut can cost
static const size_t   TRIP_FREE_MIN  = 200UL * 1024UL;
static const size_t   TRIP_MAX_BYTES = 512UL * 1024UL;   // rotate within a long drive

// One column, named once and read once, so the header can never disagree with the
// rows underneath it.
struct TripCol { const char *name; float Live::*field; uint8_t dp; };

static const TripCol TRIP_COLS[] = {
  {"rpm",         &Live::rpm,         0},
  {"speed",       &Live::speed,       0},
  {"map_kpa",     &Live::map_,        0},
  {"baro_kpa",    &Live::baro,        0},
  {"throttle_pc", &Live::throttle,    1},
  {"load_pc",     &Live::load,        1},
  {"absload_pc",  &Live::absLoad,     1},
  {"coolant_c",   &Live::coolant,     0},
  {"oil_c",       &Live::oil,         0},
  {"iat_c",       &Live::iat,         0},
  {"volt",        &Live::volt,        2},
  {"stft_pc",     &Live::stft,        1},
  {"ltft_pc",     &Live::ltft,        1},
  {"lambda",      &Live::lambda,      3},
  {"cat_c",       &Live::cat,         1},
  {"timing_deg",  &Live::timing,      1},
  {"fuelrate_lph",&Live::fuelRate,    2},
  {"pedal_pc",    &Live::pedalD,      1},
  {"cmdthr_pc",   &Live::cmdThrottle, 1},
  {"torqdem_pc",  &Live::torqDem,     1},
  {"torqact_pc",  &Live::torqAct,     1},
  {"runtime_s",   &Live::runtime,     0},
  // Integrated on the board, not sampled - so a row carries the drive's totals and
  // km/L over any span of the file can be recovered by differencing two rows.
  {"trip_km",     &Live::tripKm,      3},
  {"trip_l",      &Live::tripL,       4},
};
static const uint8_t TRIP_NCOLS = sizeof(TRIP_COLS) / sizeof(TRIP_COLS[0]);

static bool       tripFsUp = false;
static File       tripFile;
static bool       tripOpen = false;
static uint32_t   tripLastRow = 0;
static uint32_t   tripLastFlush = 0;
static uint32_t   tripSeq = 0;
static uint32_t   tripWatchGen = 0;    // watch set this file's columns were built from
static char       tripName[24] = {0};
static Preferences tripPrefs;

static void tripPath(char *out, size_t n, uint32_t seq) {
  snprintf(out, n, "/t%04lu.csv", (unsigned long)seq);
}

// Oldest-first by sequence number, which is why the names are zero-padded.
static bool tripDeleteOldest() {
  File dir = LittleFS.open("/");
  if (!dir) return false;
  char oldest[24] = {0};
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    const char *nm = f.name();
    if (!nm || nm[0] == 0) continue;
    char full[24];
    snprintf(full, sizeof(full), "%s%s", nm[0] == '/' ? "" : "/", nm);
    if (strstr(full, ".csv") == nullptr) continue;
    if (tripName[0] && strcmp(full, tripName) == 0) continue;   // never the live one
    if (!oldest[0] || strcmp(full, oldest) < 0) strncpy(oldest, full, sizeof(oldest) - 1);
  }
  dir.close();
  if (!oldest[0]) return false;
  Serial.printf("[trip] space low, removing %s\n", oldest);
  return LittleFS.remove(oldest);
}

static void tripEnsureSpace() {
  // Leave headroom rather than filling the partition: LittleFS needs free blocks to
  // do its copy-on-write, and a full filesystem fails writes instead of rotating.
  for (int guard = 0; guard < 32; guard++) {
    size_t freeB = LittleFS.totalBytes() - LittleFS.usedBytes();
    if (freeB >= TRIP_FREE_MIN) return;
    if (!tripDeleteOldest()) return;
  }
}

static void tripClose() {
  if (tripOpen) { tripFile.close(); tripOpen = false; }
  tripName[0] = 0;
}

static void tripBegin() {
  tripFsUp = LittleFS.begin(true);            // format on first boot only
  if (!tripFsUp) { Serial.println("[trip] filesystem unavailable"); return; }
  if (tripPrefs.begin("nexontrip", false)) {
    tripSeq = tripPrefs.getULong("seq", 0);
    tripPrefs.end();
  }
  Serial.printf("[trip] fs %u/%u bytes used, next trip %lu\n",
                (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes(),
                (unsigned long)tripSeq + 1);
}

// A new file per run of the board, opened lazily on the first row so a key-on that
// never reaches the ECU does not litter the partition with empty logs.
static bool tripOpenNew() {
  tripEnsureSpace();
  tripSeq++;
  if (tripPrefs.begin("nexontrip", false)) {
    tripPrefs.putULong("seq", tripSeq);
    tripPrefs.end();
  }
  tripPath(tripName, sizeof(tripName), tripSeq);
  tripFile = LittleFS.open(tripName, FILE_WRITE);
  if (!tripFile) { tripName[0] = 0; return false; }
  tripOpen = true;

  // The clock comes from a browser, so a drive can begin before anyone opens a
  // page. Record whether it was known rather than writing a timestamp that is not
  // one, and record it per row too.
  tripFile.printf("# nexonobd " FW_VERSION " trip %lu started_epoch_ms=%lld clock=%s\n",
                  (unsigned long)tripSeq, (long long)clockNowMs(),
                  clockSet() ? "set" : "unset");
  tripFile.print("epoch_ms,uptime_ms");
  for (uint8_t i = 0; i < TRIP_NCOLS; i++) { tripFile.print(','); tripFile.print(TRIP_COLS[i].name); }

  // Watched identifiers, appended after the fixed columns: a decoded big-endian
  // unsigned and the raw bytes it came from. The set is chosen at runtime, so this
  // file is pinned to the set it was opened with - see tripTick, which rotates
  // rather than letting columns shift under rows already written.
  tripWatchGen = watchGen;
  for (uint8_t i = 0; i < watchN; i++) {
    char names[WATCH_COLS_PER_DID][12];
    uint8_t n = watchColNames(watch[i], names, WATCH_COLS_PER_DID);
    for (uint8_t c = 0; c < n; c++) { tripFile.print(','); tripFile.print(names[c]); }
  }
  tripFile.print('\n');
  Serial.printf("[trip] logging to %s (%u watched)\n", tripName, watchN);
  return true;
}

static uint8_t tripCount() {
  if (!tripFsUp) return 0;
  uint8_t n = 0;
  File dir = LittleFS.open("/");
  if (!dir) return 0;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    if (f.name() && strstr(f.name(), ".csv")) n++;
  dir.close();
  return n;
}

static void tripTick(const Live &L) {
  if (!tripFsUp || !L.ok) return;
  uint32_t now = millis();
  if (tripLastRow && now - tripLastRow < TRIP_PERIOD_MS) return;
  tripLastRow = now;

  // The watch set changed, so this file's columns no longer describe what is being
  // recorded. Start a new one rather than writing rows that do not match the header
  // above them - a CSV whose columns shift halfway down is worse than two files.
  if (tripOpen && tripWatchGen != watchGen) {
    Serial.println("[trip] watch set changed - rotating");
    tripClose();
  }

  if (!tripOpen && !tripOpenNew()) return;

  // Rotate within a long drive so one file cannot swallow the partition.
  if (tripFile.size() > TRIP_MAX_BYTES) { tripClose(); if (!tripOpenNew()) return; }

  tripFile.printf("%lld,%lu", (long long)clockNowMs(), (unsigned long)now);
  for (uint8_t i = 0; i < TRIP_NCOLS; i++) {
    float v = L.*(TRIP_COLS[i].field);
    tripFile.print(',');
    if (!isnan(v)) tripFile.print(v, TRIP_COLS[i].dp);   // absent stays empty, not zero
  }
  for (uint8_t i = 0; i < watchN; i++) {
    char cells[WATCH_COLS_PER_DID][20];
    uint8_t n = watchColCells(watch[i], now, cells, WATCH_COLS_PER_DID);
    for (uint8_t c = 0; c < n; c++) { tripFile.print(','); tripFile.print(cells[c]); }
  }
  tripFile.print('\n');

  if (now - tripLastFlush > TRIP_FLUSH_MS) { tripFile.flush(); tripLastFlush = now; }
}
