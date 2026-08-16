#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include "ui_paths.h"

// Serving a built frontend bundle off LittleFS.
//
// Files live under /w. The build emits content-hashed names and a gzipped copy of
// each, so a request for /app-a1b2c3.js is answered from /w/app-a1b2c3.js.gz with
// Content-Encoding: gzip - which is most of why a real bundle fits at all, and why
// it can be cached forever.
//
// The bundle is deliberately not required. If it is missing, half-uploaded, or
// corrupt, the firmware still serves its own pages and a recovery page: a board in
// a car must not become unreachable because an upload was interrupted.

// Prefix a bundle-relative path with the bundle directory. Returns false rather
// than truncating, since a truncated path could name a different file.
static bool uiFsPath(char *out, size_t cap, const char *path, bool gz) {
  if (!uiPathOk(path)) return false;
  int n = snprintf(out, cap, "%s%s%s", UI_DIR, path, gz ? ".gz" : "");
  return n > 0 && (size_t)n < cap;
}

// Total bytes the bundle occupies, so an upload can be refused before it eats the
// space trip logging needs.
static size_t uiBytesUsed() {
  size_t total = 0;
  File dir = LittleFS.open(UI_DIR);
  if (!dir || !dir.isDirectory()) return 0;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    if (!f.isDirectory()) total += f.size();
  dir.close();
  return total;
}

static uint16_t uiFileCount() {
  uint16_t n = 0;
  File dir = LittleFS.open(UI_DIR);
  if (!dir || !dir.isDirectory()) return 0;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    if (!f.isDirectory()) n++;
  dir.close();
  return n;
}

// A bundle is only usable if it has an entry point, so that is what "installed"
// means - not merely that the directory exists.
static bool uiInstalled() {
  char p[64];
  if (uiFsPath(p, sizeof(p), "/index.html", false) && LittleFS.exists(p)) return true;
  if (uiFsPath(p, sizeof(p), "/index.html", true)  && LittleFS.exists(p)) return true;
  return false;
}

static void uiClear() {
  File dir = LittleFS.open(UI_DIR);
  if (!dir || !dir.isDirectory()) return;
  // Collect first, then delete: removing entries while walking the directory is
  // not something LittleFS's iterator promises to survive.
  String doomed[48];
  uint8_t n = 0;
  for (File f = dir.openNextFile(); f && n < 48; f = dir.openNextFile()) {
    if (f.isDirectory()) continue;
    doomed[n] = String(UI_DIR) + "/" + f.name();
    // Some core versions hand back a full path already.
    if (String(f.name()).startsWith("/")) doomed[n] = String(f.name());
    n++;
  }
  dir.close();
  for (uint8_t i = 0; i < n; i++) LittleFS.remove(doomed[i]);
  Serial.printf("[ui] cleared %u files\n", n);
}
