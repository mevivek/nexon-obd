#pragma once
#include <Arduino.h>

// Where a built frontend bundle lives on the filesystem, and what may be served
// from it.
//
// The pages this firmware has served so far are C++ raw string literals compiled
// into flash, which costs a full 1.3 MB reflash to change a line of CSS and rules
// out every normal frontend tool - no bundler, no packages, no source maps, and
// nothing in the build that ever parses the JavaScript. A bundle on LittleFS is
// none of those things: it is built with an ordinary toolchain and uploaded on its
// own, and the firmware only has to hand out files.
//
// Everything here is pure, so the path handling is tested on the host. The parts
// that touch the filesystem live in ui_fs.h.

static const char  *UI_DIR       = "/w";
// The filesystem is shared with trip logs, so the bundle gets a fixed ceiling
// rather than whatever is free. At ~0.5 MB an hour of logging, 300 KB costs about
// thirty-five minutes of recording capacity.
static const size_t UI_MAX_BYTES = 300UL * 1024UL;

// A requested path arrives off the wire, so it is checked rather than trusted -
// the same discipline as the trip download handler. Rooted, no traversal, no
// wildcards, and short enough for the fixed buffers it is copied into.
static bool uiPathOk(const char *p) {
  if (!p || p[0] != '/') return false;
  size_t n = strlen(p);
  if (n < 2 || n > 48) return false;
  if (strstr(p, "..")) return false;
  if (strstr(p, "//")) return false;
  for (size_t i = 0; i < n; i++) {
    const char c = p[i];
    const bool allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                         (c >= '0' && c <= '9') ||
                         c == '/' || c == '.' || c == '-' || c == '_';
    if (!allowed) return false;
  }
  return true;
}

// Content type from the extension, ignoring a trailing .gz - a gzipped asset is
// still the type it decompresses to, and saying otherwise makes the browser
// download it instead of running it.
static const char *uiContentType(const char *p) {
  if (!p) return "application/octet-stream";
  size_t n = strlen(p);
  if (n > 3 && strcmp(p + n - 3, ".gz") == 0) n -= 3;

  struct { const char *ext; const char *type; } static const MAP[] = {
    {".html", "text/html"},
    {".js",   "text/javascript"},
    {".css",  "text/css"},
    {".json", "application/json"},
    {".svg",  "image/svg+xml"},
    {".png",  "image/png"},
    {".ico",  "image/x-icon"},
    {".woff2","font/woff2"},
    {".map",  "application/json"},
    {".txt",  "text/plain"},
  };
  for (size_t i = 0; i < sizeof(MAP) / sizeof(MAP[0]); i++) {
    size_t e = strlen(MAP[i].ext);
    if (n >= e && strncmp(p + n - e, MAP[i].ext, e) == 0) return MAP[i].type;
  }
  return "application/octet-stream";
}

// Bundle assets are content-hashed by the build, so they can be cached forever.
// index.html is the one that must not be, or a deployed update would never be
// picked up - it is the file that names all the others.
static bool uiImmutable(const char *p) {
  if (!p) return false;
  size_t n = strlen(p);
  if (n > 3 && strcmp(p + n - 3, ".gz") == 0) n -= 3;
  return !(n >= 5 && strncmp(p + n - 5, ".html", 5) == 0);
}

// Paths the firmware answers itself. A request for one of these must never fall
// through to the bundle's single-page fallback, or a mistyped API call would come
// back as an HTML document with status 200 and be parsed as JSON.
static bool uiIsApiPath(const char *p) {
  if (!p) return false;
  static const char *API[] = {"/data", "/dtc", "/history", "/mon", "/time",
                              "/trips", "/scan", "/watch", "/update", "/ui"};
  for (size_t i = 0; i < sizeof(API) / sizeof(API[0]); i++) {
    size_t n = strlen(API[i]);
    if (strncmp(p, API[i], n) == 0 && (p[n] == 0 || p[n] == '/' || p[n] == '?'))
      return true;
  }
  return false;
}
