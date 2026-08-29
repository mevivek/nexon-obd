#pragma once
#include <Arduino.h>
#include "trip_names.h"

// Which files a backup may read and a restore may write, and what a reset erases.
//
// The board accumulates things that took real time to produce and cannot be
// regenerated on demand: a sweep of the identifier space is over half an hour on
// CAN and the better part of a day over BLE, the register behind it takes drives to
// build, and the trip logs are the drives themselves. All of it lives on a 1.5 MB
// partition inside a device that gets unplugged, reflashed and left in a hot car.
//
// So: a backup that takes the lot off the board, a restore that puts it back, and a
// reset that clears it - in that order, because a reset button without a backup
// button beside it is a way to lose a week.
//
// WHAT IS DELIBERATELY NOT IN THE SET
//
// /w - the dashboard bundle. It is not data, it is the page you are standing on
// while you press these buttons, and a "download everything" that hauls 27 KB of
// gzipped JavaScript into a backup is answering a question nobody asked. It has its
// own endpoints at /ui, and the erase-data reset leaves it alone precisely so the
// page survives the button it just served.

// A data file: at the root, and one of the three kinds this board produces.
//
// Strict rather than clever. Anything reachable from a URL argument that opens a
// file is a path-traversal question, and the honest answer to "which names are
// allowed" is a list, not a pattern with escapes to reason about.
static bool dataIsFileName(const char *n) {
  if (!n || n[0] != '/') return false;
  if (strchr(n, '\\') || strstr(n, "..")) return false;   // never, whatever else matches
  // Exactly one slash: no directories, so /w/index.html.gz cannot be reached here.
  if (strchr(n + 1, '/')) return false;
  if (tripIsLogName(n)) return true;
  return strcmp(n, "/scanhits.csv") == 0 || strcmp(n, "/didmap.csv") == 0;
}

// What a reset clears, and what it leaves.
//
// Two levels, because they have very different consequences and a single button
// would have to be labelled for the worse one:
//
//   DATA - trips, the sweep's hits, the register, and the NVS behind them. The
//          dashboard bundle stays, so the page that pressed the button still works
//          and the board is immediately usable again.
//   ALL  - the above plus the bundle, which leaves the built-in fallback page and
//          needs web/deploy.sh or /ui to get the dashboard back. Recoverable, but
//          not from a phone at the roadside.
//
// Neither touches the firmware, and neither writes to the car.
enum ResetScope : uint8_t { RESET_DATA = 0, RESET_ALL = 1 };

// The NVS namespaces a reset clears. Every one of them is state the board rebuilds
// on its own, and all of them keep their pre-rename names - see the note in the
// sketch about why those did not follow Obdurate.
//
// "nexonveh" is the newest and the only one that was never named before the
// rename; it keeps the prefix anyway so the list reads as one thing rather than as
// five legacy names and an exception. It holds the discovered VIN and calibration
// id, and a reset clears it for the same reason it clears the register: both are
// conclusions about a particular car, and the board is about to stop being that
// board. The next drive rediscovers it in about ten seconds.
static const char *RESET_NVS[] = {"nexonscan", "nexonwatch", "nexontrip",
                                  "nexonhist", "nexontriage", "nexonveh"};
static const uint8_t RESET_NVS_N = sizeof(RESET_NVS) / sizeof(RESET_NVS[0]);
