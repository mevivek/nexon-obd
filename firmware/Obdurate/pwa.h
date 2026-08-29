#pragma once
#include <Arduino.h>

// Home-screen install: the manifest and the app icon, compiled into flash.
//
// In flash rather than in the bundle, for the same reason boot_html.h and
// ota_html.h are: the bundle is deliberately a single index.html.gz, and a manifest
// has to be a real URL. A data: URI manifest would keep the one-file property and
// then break start_url, which resolves against the manifest's own URL - there is no
// sane base for "/" inside a data: URL. Serving it from flash costs about a
// kilobyte, keeps the bundle one file, and means the board still has a name and an
// icon when no bundle is installed at all.
//
// WHAT THIS DOES NOT DO, and cannot over plain HTTP:
//
// There is no service worker. Service workers require a secure context, and only
// localhost and 127.0.0.1 get the HTTP exemption - a private address like
// 192.168.4.1 does not, so navigator.serviceWorker is undefined on the board.
// Chrome's install prompt requires a service worker, so it never fires either; the
// manifest still shapes what Android's manual "Add to Home screen" produces, and on
// iOS the apple-* meta tags in index.html do the whole job on their own.
//
// The loss is smaller than it sounds. Offline caching is worth little here because
// the board IS the server: if it is not powered there is nothing to show, so a
// cached shell would buy a faster first paint and nothing else. The part that
// actually matters in a car - launching full screen off the home screen, without
// browser chrome eating the top of a phone wedged by the windscreen - needs neither.
//
// Serving TLS from the ESP32 would satisfy the letter of it, at the cost of a
// self-signed certificate warning on every launch and a large bite out of a
// single-threaded server already budgeted around a ~2 Hz bus. Not a trade worth
// making for a faster first paint.

// display:standalone drops the browser chrome. orientation is deliberately left
// unset: this is read in a cradle either way up, and pinning it would be a guess
// about someone else's mount.
//
// start_url is "/" rather than a route, so the launcher opens the live gauges - the
// only page anyone opens while moving.
static const char PWA_MANIFEST[] PROGMEM = R"JSON({
  "name": "Obdurate",
  "short_name": "Obdurate",
  "description": "A read-only black box for your car.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#07070b",
  "theme_color": "#07070b",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "maskable" }
  ]
})JSON";

// One SVG, used at every size. A raster set would be four or five more files on a
// partition shared with trip logs, and every launcher scales an SVG happily.
//
// Drawn to survive maskable cropping: a launcher may cut this to a circle and keep
// only the middle 80%, so everything that carries meaning stays well inside the
// safe zone and the background runs to the edges.
//
// The mark is a gauge sweep that stops short of full deflection, with the needle
// parked at rest - a instrument that reads rather than acts.
static const char PWA_ICON_SVG[] PROGMEM = R"SVG(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<rect width="512" height="512" fill="#07070b"/>
<circle cx="256" cy="256" r="150" fill="none" stroke="#1a1b24" stroke-width="26"/>
<path d="M 150 362 A 150 150 0 1 1 362 362" fill="none" stroke="#2a2c38" stroke-width="26" stroke-linecap="round"/>
<path d="M 150 362 A 150 150 0 0 1 150 150" fill="none" stroke="#8b95ff" stroke-width="26" stroke-linecap="round"/>
<circle cx="256" cy="256" r="30" fill="#8b95ff"/>
<path d="M 256 256 L 168 200" stroke="#f2f3f7" stroke-width="20" stroke-linecap="round"/>
</svg>)SVG";
