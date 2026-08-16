# `web/` — the dashboard frontend

A Vite + Preact build of the pages the board currently serves from C++ raw string
literals. This directory is **scaffolding and the shared library only**: the shell,
the routing, the build and the ported logic are here and tested; the six pages
themselves are still the firmware's and get moved over one at a time.

```bash
npm install
npm run dev      # vite dev server, hot reload
npm run test     # vitest — the ported logic against the firmware's own assertions
npm run build    # dist/ + .gz copies, with a size report against the budget
```

## What is in `src/lib/`

The framework-free half of the dashboard, lifted out of
`firmware/NexonOBD/dashboard_html.h` and turned into pure ES modules. No DOM access
anywhere in here — the modules take a sample and return values and descriptors, and
the components decide what a `warn` looks like.

| Module | Ported from | What it holds |
|---|---|---|
| `hold.js` | `merge()`, `holdMs()` | Hold-last-value, and the hold window that scales with the observed sample rate |
| `rate.js` | `hz()` | The trailing-window Hz readout |
| `flags.js` | the threshold block in `render()` | Every warning threshold, each gated on staleness |
| `mileage.js` | the mileage block in `render()` | Trip average and instantaneous km/L, with the withholding thresholds |
| `format.js` | `n()`, `hhmmss()` | Number formatting, and what an absent value looks like |
| `derive.js` | the boost / N·m lines in `render()` | Values the ECU does not report |

### These are the load-bearing bits, not a rewrite

Every assertion in `suiteMerge`, `suiteFlags`, `suiteHold`, `suiteRate` and
`suiteMileage` from `firmware/test/test_dashboard.mjs` is ported into
`src/lib/*.test.js`, with the comments that explain **why** each check exists — they
document real bugs seen on the car, and an assertion without its reason is an
assertion someone will delete during a refactor. Two rules in particular are the
whole point of the library:

- **A missing value is not a zero.** JavaScript coerces `null` to `0`, so a missing
  lambda used to satisfy `<= 0.85` and light "running rich" underneath a blank gauge.
  Every threshold in `flags.js` is gated on the held-mark for exactly this reason.
- **A held reading never raises or sustains a warning.** A number from two seconds
  ago cannot tell you whether the engine is still overheating.

The firmware suite drove the shipped `render()` against a fake DOM. The lib has no
DOM, so those assertions are made against the descriptors the components render
*from* — same facts, one layer down. See "Not ported" below for the two that had no
lib-level equivalent.

## Build output

The board is a single-threaded `WebServer` on a XIAO ESP32S3 and every file is one
more request it has to serve in its own turn between bus exchanges — the same cost
the README's "Polling runs on the board" section is about. So the build is tuned for
**file count first**:

```
dist/index.html
dist/app.js
dist/app.css
```

plus a `.gz` beside each, written by `scripts/gzip.mjs` (node's `zlib`, so no build
plugin to licence-check). The firmware serves the pre-compressed copy when the client
sends `Accept-Encoding: gzip`.

Everything else is inlined: `cssCodeSplit: false`, `inlineDynamicImports: true`, an
effectively unlimited `assetsInlineLimit` so images and fonts become data URIs, and
`modulePreload: false` because with one chunk the polyfill is dead weight.

Names are fixed rather than content-hashed, because deploying means copying files
onto LittleFS by hand and hashed names would leave orphans behind on a 1.5 MB
partition shared with the trip logs. Cache-busting is the firmware's job, the same
way it version-stamps `/ui.css`.

`base` is `'./'`, so the bundle resolves from whatever prefix it is served under and
also opens straight off disk.

### Size budget

**300 KB gzipped for the whole bundle.** `npm run build` prints the per-file gzip
size and fails the build if the total goes over. Current usage is a few percent, but
uPlot is declared and not yet imported — expect the real number once the Live page
lands.

## Deploying

The bundle is uploaded to the board's LittleFS under **`/w/`**, which is the same
partition the trip logs live on. It is *not* compiled into the firmware image: that
is the point of the split — a CSS fix should not need a flash, and the 60 KB the six
current pages cost in flash comes back.

1. `npm run build`
2. Copy `dist/` (including the `.gz` files) to `/w/` on the board.
3. Open `http://192.168.4.1/w/`.

Routing is **hash-based** (`#/trips`, not `/trips`) on purpose: the board's server
has no SPA rewrite rule, so a path route would 404 on a reload while a hash route is
the same document every time.

## Versioning

`package.json` carries its own `version`, starting at **0.1.0**, and it is
**independent of the firmware's `FW_VERSION`** in
`firmware/NexonOBD/version.h`. The two ship on different cadences over different
channels — firmware over `/update`, this over LittleFS — and conflating them would
mean a frontend fix needed a firmware flash to be legible in the header. The header
shows `web v<version>`; the firmware pages keep showing `v<FW_VERSION>`.

Vite inlines the version at build time via `__WEB_VERSION__`, so there is one source
of truth.

## Dependencies

Deliberately short: **Preact**, **uPlot**, **Vite**, **Vitest**. All MIT.

Preact is used without `@preact/preset-vite` — esbuild's automatic JSX runtime does
the job and saves a Babel dependency chain. Routing is thirty lines in `router.js`
rather than a router package.

Licence policy: allowed are Apache-2.0, MIT, BSD, ISC, CDDL and EPL; GPL, AGPL, LGPL,
SSPL and Commons Clause are prohibited. The current tree is 53 packages, all
MIT / ISC / BSD-3-Clause / Apache-2.0, and `npm audit` is clean. Two notes for
whoever bumps these next:

- **Vite is pinned to `^6` on purpose.** Vite 7 and 8 declare `lightningcss`
  (MPL-2.0) as an *optional peer* dependency, which npm installs by default. MPL-2.0
  is not on the allowed list. `omit=optional` is not a fix — it also strips rollup's
  platform binary and the build stops working. Before moving to 7+, get MPL-2.0 ruled
  on, or find a supported way to exclude that peer.
- Re-run the sweep after any dependency change:

  ```bash
  npm audit
  npm ls --all --long 2>/dev/null | grep -i "license" | sort -u
  ```

## Not ported (yet)

The firmware suite covers more than the five suites named above. These stay in
`firmware/test/test_dashboard.mjs` against the firmware pages and are **not**
duplicated here:

- `suiteStatus`, `suiteVisibility`, `suiteScanBanner`, `suiteSeed` — poll-loop
  behaviour (`tick()`, the five-failure hysteresis, the scan banner, history
  seeding). The poll loop is not ported yet; these come with the Live page.
- The version-stamp, tab-switching, DID-watch and trip-column suites — they assert
  against firmware source (`NexonOBD.ino`, `triplog.h`, `version.h`) and are about the
  board, not the browser.
- The syntax suite — it exists because the firmware's JavaScript lives inside C++ raw
  string literals and nothing else in that build ever parses it. Vite parses this
  code on every build, so it has no job here.
