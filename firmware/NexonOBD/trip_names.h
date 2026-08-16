#pragma once
#include <Arduino.h>

// What counts as a trip log.
//
// The filesystem holds more than trip logs - the DID sweep's hits live in
// /scanhits.csv, and a served UI bundle will live alongside both. Everything that
// walks the root used to accept any name containing ".csv", which had three
// consequences, all of them quiet:
//
//   - Rotation deletes the lexicographically smallest CSV when space runs short,
//     and "/scanhits.csv" sorts before "/t0001.csv". A long drive would therefore
//     delete the sweep's results and its resume position - hours of work - to make
//     room for another minute of logging.
//   - /trips/list offered it as a trip, so it could be downloaded or deleted by
//     hand from a page that had no business showing it.
//   - The trip count and the storage figures counted it.
//
// So the name pattern is checked properly, in one place, by everything that walks
// the filesystem. Pure, so it is tested on the host rather than on the car.
//
// The shape is what tripPath() writes: /t, a zero-padded sequence number, .csv.
// The upper bound on digits is what a uint32 sequence can reach; the lower bound is
// the %04lu padding, which is what makes a lexicographic sort chronological.
static bool tripIsLogName(const char *n) {
  if (!n || n[0] != '/' || n[1] != 't') return false;
  size_t i = 2, digits = 0;
  while (n[i] >= '0' && n[i] <= '9') { i++; digits++; }
  if (digits < 4 || digits > 10) return false;
  return strcmp(n + i, ".csv") == 0;
}

// Same test for a name that may arrive without its leading slash, as
// File::name() does on some core versions.
static bool tripIsLogNameLoose(const char *n) {
  if (!n || !n[0]) return false;
  if (n[0] == '/') return tripIsLogName(n);
  char full[24];
  if (strlen(n) + 2 > sizeof(full)) return false;
  snprintf(full, sizeof(full), "/%s", n);
  return tripIsLogName(full);
}
