# NexonOBD

Live telemetry and UDS diagnostics for a **2022 Tata Nexon 1.2 petrol (BS6)**, built on a
**Seeed XIAO ESP32S3**. The board hosts its own Wi-Fi access point and serves a gauge
dashboard, a UDS identifier scanner, and browser-based OTA updates — no laptop, no app,
no cloud.

It reaches the car two ways and picks whichever works:

| Transport | Hardware | Speed | Notes |
|---|---|---|---|
| **BLE ELM327** | none — uses a dual-mode ELM327 already in the OBD port | ~2 Hz | Works today |
| **Direct CAN** | SN65HVD230 transceiver (~₹200) | 50–100 Hz | Preferred once wired |

Everything here was verified against the actual vehicle. Where a claim is untested,
it says so.

---

## Quick start

1. Flash the firmware (see [Building](#building)).
2. Power the board — USB, or from the OBD port via a 12 V→5 V buck.
3. Join Wi-Fi **`NexonOBD`** / **`nexon1234`**.
4. Install the frontend: **`web/deploy.sh`** (see [Frontend](#frontend)). Once only —
   it lives on the board's filesystem and survives reflashing.
5. Open **`http://192.168.4.1`**.

Without step 4 the board still works: `/` falls back to a built-in page with speed,
rpm, coolant and battery, and everything the board does on its own — trip logging,
the DID sweep, the history buffer — keeps running regardless.

| Page | What it does |
|---|---|
| `/` | Live gauges — RPM, boost, temps, trims, lambda, catalyst, driver demand |
| `/monitors` | Mode 06 on-board monitor test results, with the ECU's own limits |
| `/scan` | UDS service `0x22` identifier sweep, with CSV export |
| `/update` | Upload a new `.bin` over Wi-Fi |
| `/dtc` | Stored + pending fault codes as JSON |
| `/data` | Current sample as JSON, plus firmware version and active transport |
| `/trips` | Per-drive CSV logs — list, download, delete |
| `/history` | The stored trend buffer as JSON |

The header shows the running firmware version and which transport is actually live
(`can` or `ble`), so a flashed image can be confirmed at a glance.

A poll can come back with only some of its PIDs — the dashboard reads them in three
batched requests, and one batch can time out while the others answer. When that
happens the affected gauges keep showing their last reading, dimmed, and the header
reports `live · holding N`. After 2.5 s without a fresh value they fall back to `—`
rather than showing stale data indefinitely, and a held reading never raises or
sustains a warning — a value from two seconds ago cannot tell you whether the engine
is still overheating.

A single dropped poll is not reported as a fault either — the status only changes to
`no response from ECU` after five consecutive failures. Dropped replies happen, the
values are held through them, and flipping the status on each one reads as a problem
when nothing is wrong.

### Polling runs on the board, not on the page

The board samples the ECU continuously in `loop()`, one batched request per turn,
and `/data` returns the newest cached sample rather than going to the bus. Polling
therefore does not stop when you close the browser, and no request ever waits for a
poll of its own.

It did, however, wait for *someone else's*. The web server is single threaded, and
until v1.8.0 it got exactly one turn per bus exchange — up to 1.2 s on BLE, twice
that when a batch is retried. A tab switch is three requests (the document, `/time`,
and the new page's first poll), so switching pages could sit behind several seconds
of ELM327 timeouts and felt like a page load rather than a page swap.

Two things fix that, both in `bus_yield.h`:

- **The wait loops serve HTTP.** Waiting on the car is otherwise `delay(1)` on BLE
  and a 5 ms blocking receive on CAN. Both now call `webYield()` instead, which
  serves whatever is queued and reports how long it took — and the response deadline
  moves out by exactly that, because the reply is still waiting behind us either way
  (the TWAI RX queue, or the ELM notify buffer). Without the give-back, serving a
  page would eat the ECU's patience window and surface as a phantom timeout. The
  extension is capped at 3 s so one slow handler cannot hold an exchange open.
- **`loop()` drains the queue** instead of taking one request per turn, so a whole
  page load completes in a single turn.

Two guards keep that safe. `WebServer` tracks a single current client, so
`webYield()` refuses to re-enter it from inside a handler; and `obdIsoTp()` sets a
flag for the duration of an exchange so a handler reached from a yield cannot start
a second one underneath a half-finished reassembly. `/dtc` is the only handler that
touches the bus — it stands down when that flag is set, and because it runs inside
`handleClient()` and therefore cannot yield, its own timeouts are kept short.

The pages help too: the shared ~7 KB stylesheet used to be compiled into all five
documents and re-sent on every switch. It is now served once from `/ui.css` with a
version-stamped, immutable URL, and the pages carry an `ETag` so a re-visit is a
304 with no body. That is also worth ~26 KB of flash.

A sample is published after **every** batch, not after all three. The other two are
carried forward from cache while they are still fresh (3 s), so the page updates at
the bus transaction rate rather than a third of it. Batches are not polled equally
either — `b1` carries everything with a sparkline (rpm, speed, MAP, throttle, load,
coolant) and gets half the turns, because oil temperature and battery voltage do not
move fast enough to deserve equal billing:

| | Refresh |
|---|---|
| `b1` — rpm, speed, MAP, throttle, load, coolant | every 3 batches |
| `b4` — pedal, commanded throttle, torque, absolute load | every 3 batches |
| `b2` — oil, IAT, voltage, trims, fuel rate | every 6 batches |
| `b3` — lambda, catalyst, timing, run time, ambient, fuel | every 6 batches |

A batch that has not answered for three of its own polling cycles is dropped to
`null` rather than published as current, so carrying values forward can never
present a stale number as live. That window is measured, not fixed: `b2` and `b3`
come round once every four batches, so a flat timeout only holds if a batch
completes quickly. Over BLE it does not, and those two batches then expire before
their next turn — blanking twelve of the twenty rows in **All values** on every
cycle. The dashboard's own hold window scales the same way, off the observed sample
interval.

The `[alive]` serial line prints `batch=`, `cycle=` and `stale=` so all three are
visible rather than inferred.

**On BLE, the bus transaction rate is the limit**, and it is mostly round-trip
latency rather than the ECU. The connection interval is the floor: at a default of
40–50 ms a request and its reply cannot beat about a tenth of a second however fast
the car answers. The firmware asks for 7.5–15 ms and a 247-byte MTU, which collapses
a ~80-character reply from four or five notifications into one or two. The adapter
may refuse either, in which case nothing is worse than before. The serial log prints
`batch=NNNms` so the real cost is visible rather than guessed at.

The dashboard stops requesting while the page is off screen, and the Hz readout
counts *published samples* rather than fetches — the same cached sample can be
fetched several times and must not inflate the rate.

### Mileage

Two figures, in the glance area under boost and coolant:

- **Mileage** — the average over this drive, with the totals it came from
  (`23.6 km · 1.66 L`) underneath so the number can be checked rather than trusted.
- **Right now** — instantaneous km/L, which is what the pedal moves. Standing still
  it reads `—` and says `idling` instead, because speed ÷ nothing is not a mileage.

There is no PID for fuel economy, so it is integrated on the board from speed
(`0D`) and fuel rate (`5E`), both confirmed supported on this ECU. On the board and
not on the page, so locking the phone or closing the browser does not lose the drive.
Two rules keep it honest:

- **Both inputs or neither.** Fuel rate lives in the `b2` batch and refreshes half as
  often as speed, so it goes absent regularly. Counting the distance anyway would
  divide real kilometres by an understated litre count and report a mileage better
  than the car achieved.
- **Gaps are not driving.** An interval longer than 5 s — a BLE dropout, a scan taking
  the bus, a wake from sleep — is skipped rather than integrated at the last known
  speed. The clock still moves, so the interval after an outage is one interval, not
  the whole outage.

The average is withheld until roughly the first 0.5 km and 0.1 L. Before that it
swings by tens of km/L between polls and reads as a broken gauge.

Totals start at zero each time the board powers up, which — given the
accessory-socket supply — is exactly one drive. They also go into the trip CSV as
`trip_km` and `trip_l`, so economy over any stretch of a drive can be recovered by
differencing two rows.

One caveat worth knowing: `5E` is the ECU's injection model, not a flow meter. Trip
km/L from it typically reads a few percent optimistic against tank-to-tank. It is
excellent for comparing drives and weaker as an absolute.

### Driver demand vs. delivery

Six of the 55 PIDs the ECM supports trace one chain: **accelerator pedal (`49`/`4A`)
→ commanded throttle (`4C`) → actual throttle (`11`) → demanded torque (`61`) →
delivered torque (`62`)**, with absolute load (`43`) alongside. That is what you
asked the car for, what the ECU decided to do about it, and what the engine actually
produced — which on a small turbo is the interesting part.

Torque is reported as a percentage of the engine's reference torque (`63`), a
constant read once at startup like barometric pressure, so the newton-metre figures
are derived rather than read.

> The scalings are the J1979 ones and have **not been verified against this car** —
> `FINDINGS.md` lists the torque PID scaling as an open question precisely because it
> needs data under load. A wrong data *length* is caught (`mode01Walk` rejects the
> batch), but a wrong *scaling* would not be. Treat the numbers as provisional until
> they have been watched under load and found sane.

### On-board monitors (mode 06)

Mode 06 is the ECU's own test results: what each monitor measured, and the limits it
is judged against. `FINDINGS.md` recorded it as supported (`46 00 C0000001`) and
never explored — so `/monitors` reads it.

The value of it over `/dtc` is that a fault code only appears once a system has
already failed. Mode 06 shows how much room is left, so a catalyst drifting toward
its threshold is visible while it is still passing.

**Pass and headroom do not require knowing the units.** A test passes when its value
sits inside its own limits, and the headroom is a fraction of that window — both
unit-free. The unit-and-scaling table is long and only partly documented, so values
are shown raw with their scaling id, decoded only where the multiplier is
unambiguous. Monitor names likewise: only unambiguous J1979 ids are named, the rest
keep their raw id rather than being given a label that might be wrong.

Discovery walks the support masks (`00` → `20` → `40` …, each mask's last bit
pointing at the next), then each monitor is read one at a time. It runs only while
the page is open — monitors move over minutes, and polling them continuously would
take bus time from the values that move now.

### The DID scan runs in the background

A scan is driven by the board, so it continues if you navigate away, close the
browser, or lock the phone. Only **Stop** — or an OTA upload, which never flashes
mid-scan — ends it.

While it runs the scanner takes most of the bus, but not all of it — the sampler
still gets one batch every two seconds, so live values keep moving slowly rather
than freezing. That costs roughly 15 % of scan throughput, which is a good trade
against a dashboard that is dead for the length of a sweep.

The Live page shows the sweep's progress with counts as well as a percentage — a
full pass is 65,536 requests, so a percentage alone rounds to zero for a long time
and reads as stuck — and the scanner page estimates the time remaining.

Scanning is time-boxed to 250 ms per turn rather than a fixed identifier count. A
count behaves wildly differently per transport — 40 identifiers is about a second on
CAN but roughly 22 s over BLE, during which nothing answers the web server and the
board appears hung.

### Watching identifiers to find out what they hold

A sweep finds identifiers that answer. It cannot say what any of them contain — the
manufacturer-specific block (ISO 14229-1 hands `0100`–`A5FF` to the manufacturer)
comes back as one or two raw bytes with no name, unit or scaling, and that lives in
an ODX database nobody outside the supplier has.

What you can do is correlate. `/watch` reads up to **8** chosen identifiers
continuously and shows them next to rpm, speed, coolant, intake, load and throttle,
each with a sparkline. Blip the throttle and an rpm-linked value gives itself away.
The ones the scanner found are offered as checkboxes, so there is no copying hex
between pages.

**Coming from a build before 1.7.0:** those sweeps kept their hits in RAM only —
nothing was written to flash — so an updated board comes up with an empty picker
even though the sweep happened. The `did_hits.csv` you exported is the only copy,
and the picker loads it directly: choose the file and the identifiers appear as
checkboxes, merged with anything the board found itself. It is parsed in the
browser and kept in `localStorage`; nothing is uploaded, and there is no endpoint
that would make a browser a second source of truth for what the board found.

The same readings become extra columns on the trip CSV — two per identifier: the
bytes decoded big-endian, and the raw bytes beside them. Two bytes might equally be
one 16-bit value or two 8-bit ones and nothing in the reply says which, so the
decode is a convenience and the raw column is the record. An identifier that has
stopped answering writes **empty** cells rather than zeros, the same rule the PID
columns already follow: a missing reading must not correlate as a value of nought.

Changing the set **rotates the CSV**. Columns are fixed when a file is opened, and
shifting them halfway down one is worse than having two files. Re-applying an
identical set is not a change, so pressing Apply twice does not litter the partition.

The cost is real and the page states it. Every watched identifier is one more bus
exchange, and BLE affords about six a second in total — eight at the default one per
second is roughly a sixth of the budget. Watching **pauses entirely while a sweep is
running**; a sweep is already hours long and shares the bus with the sampler, and a
third claimant would do both jobs badly.

This gives correlation, not meaning. It will tell you `1002` tracks coolant; the
offset and scale come from fitting the logged column against the PID afterwards.
Service `0x22` is still a read — only the identifier varies, never the service.

### Trip logs

A CSV row a second while the ECU is answering, written to the 1.5 MB filesystem
partition. Twenty-two columns, wall-clock time and uptime on every row, and empty
cells rather than zeros where a value was not read — so a gap is a gap, not a
reading of nought.

Roughly half a megabyte an hour, so the partition holds a few hours and the oldest
trip is deleted automatically when space runs short. LittleFS rather than SPIFFS:
the board loses power the instant the ignition goes off, mid-write as often as not,
and LittleFS is built to survive exactly that.

The clock comes from whichever page you open, so a drive that starts before you open
one has an unset clock for its first rows. Each file's header records whether the
clock was set rather than implying a timestamp it does not have.

### Scans survive being switched off

A sweep is tens of thousands of requests — the better part of a day over BLE — so it
has to outlast the car being switched off. Position goes to NVS as it runs, hits are
appended to the filesystem the moment they are found, and an interrupted sweep
resumes on the next boot rather than starting over.

It also stops sweeping when the ECU stops answering. **A timeout and a negative
response mean opposite things:** a negative response is the ECU saying "no such
identifier", which is a result worth recording; a timeout is no answer at all. After
25 consecutive timeouts the sweep holds its position and probes every few seconds
until the car answers again.

Without that, switching the ignition off mid-sweep would record thousands of
identifiers as "no response" — turning an unswept range into one that looks swept
and empty. That is the same class of silent wrong answer as the `ATCRA` bug in
[FINDINGS](docs/FINDINGS.md), and it matters here because the whole value of the
sweep is its negative result.

### Trend history

The board keeps one hour of RPM, speed, boost and coolant at 6-second resolution and
serves it at `/history`, so the sparklines have shape the moment the page loads
instead of starting flat.

It survives restarts, which matters more than it sounds — the board restarts
constantly in normal use, so history in ordinary RAM would be wiped every time you
got back in the car. How it restarts depends on how it is powered: from the
accessory socket the power is simply cut when the car goes off; from the
permanently-live OBD pin 16 it deep-sleeps after 10 idle minutes and wakes every
30 s, running `setup()` each time.

| Store | Survives | Written |
|---|---|---|
| RTC slow memory (4.8 KB) | deep sleep | every 6 s, free |
| NVS (flash) | power loss | every 6 s (each new sample), and before sleeping |

Which store matters depends on how the board is powered. Wired to the ignition it
simply loses power when the car goes off — RTC memory does not survive that, and the
save on the way into deep sleep never runs, so the periodic flash write is the only
thing keeping a trip's history. It runs on every new sample, so switching off costs
at most 6 seconds. Wired to the permanently-live pin 16 the board deep-sleeps
instead, and RTC memory carries the buffer across for free.

Flushing that often is only affordable because a flush writes **the 400-byte chunk
that moved**, not the whole 4800-byte ring. Rewriting all of it — which is what it
did until v1.3.0 — costs somewhere over a flash sector erase per save, so shortening
the interval that way would have burned through NVS endurance in a couple of years.
Chunked, ten times the flush rate still churns less flash than the old
sixty-second full-buffer write did.

The onboard LED encodes state, which matters when the board is hidden under the dash:

- **slow blink (1 Hz)** — alive, Wi-Fi up, ECU not answering
- **fast blink (5 Hz)** — talking to the ECU
- **double-blink** — DID scan running

---

## Frontend

The dashboard is a Preact app under `web/`, built with Vite and served off the
board's filesystem. It is not compiled into the firmware.

```bash
npm --prefix web install
npm --prefix web test          # 206 checks
web/deploy.sh                  # build, then upload to 192.168.4.1
```

It was compiled in until v1.11.0, as JavaScript inside C++ raw string literals. That
cost a 1.3 MB reflash to change a line of CSS and ruled out every ordinary frontend
tool — no bundler, no packages, no source maps, and nothing in the build that ever
parsed the JavaScript, so a typo shipped and surfaced as a dead dashboard in the car.
Splitting it out fixed all of that and returned 47 KB of flash. It was never about
space: the whole UI was 4.6 % of the sketch, and the board had 2 MB of `app0` free.

**Why the board and not a web host.** The access point has no internet, so a phone
joined to it cannot load a page from anywhere else. Chrome 142 relaxed mixed-content
checks for literal private IPs behind a permission prompt, so an HTTPS page *can*
now reach `192.168.4.1` — but only on Chrome, only if the permission was granted
before you got in the car, and Android 17 adds a second prompt on top. Serving from
the board has none of those conditions: no mixed content, no CORS, no permissions, no
internet, any browser.

**Deploying cannot brick it.** `/ui` is compiled into flash, so the page that fixes a
bad deploy never depends on the deploy having worked. If no bundle is installed, or
the upload was interrupted, `/` falls back to a built-in page showing speed, rpm,
coolant and battery. Trip logging, the DID sweep and the history buffer are the
board's work and run regardless of what the browser can see.

| | |
|---|---|
| Bundle | 22 KB gzipped, **one file** |
| Budget | 300 KB, capped in the build and enforced by the firmware on upload |
| Shares with | trip logs — 300 KB is about 35 minutes of recording capacity |

The build inlines the script and stylesheet into `index.html`, so a deploy is a
single `index.html.gz`. That is not for the bytes — one gzip stream over the lot is
barely smaller than three — but for how it gets installed: the board is updated from
a phone standing next to a car, and a firmware update is one `.bin`, so the frontend
should cost no more than that.

The firmware serves it with `Content-Encoding: gzip` and `no-cache`, so a new deploy
is always picked up, and answers `/monitors`, `/trips`, `/watch` and `/scan` as
redirects into the app's routes so old bookmarks keep working.

**The `/data` contract** is declared in `contract/data.json` and checked from both
ends — the firmware test asserts it against `handleData()` in both directions, so a
field renamed on one side fails the build instead of blanking a gauge on the road.

---

## Hardware

### Option A — no extra parts

Uses a dual-mode ELM327 clone over **BLE GATT**. The ESP32-S3 has **no Bluetooth Classic
radio**, so it cannot use the usual SPP path — but many ELM327 clones also expose a BLE
interface, and this firmware drives that.

Check yours advertises service `FFF0`. On the unit this was built against:

```
BLE address 81:23:45:67:89:BA   name "OBDBLE"
  SERVICE 0000fff0
    CHAR 0000fff1  Read, Notify               <- responses
    CHAR 0000fff2  WriteWithoutResponse, Write <- commands
```

Note the BLE address is the Classic MAC with the top bit of octet 0 set
(`01:…` → `81:…`). Set `ELM_BLE_ADDR` in `elm_ble.h` to match your adapter.

### Option B — direct CAN (recommended)

| Part | Notes |
|---|---|
| **SN65HVD230** transceiver | **3.3 V part.** Do *not* use TJA1050 or MCP2551 — they are 5 V logic and will damage the ESP32's RX pin |
| 12 V→5 V buck (MP1584/LM2596) | Set output to 5 V *before* connecting the board |
| OBD-II male pigtail | |

**Wiring**

| XIAO ESP32S3 | SN65HVD230 |
|---|---|
| D1 (GPIO2) | CTX / D |
| D2 (GPIO3) | CRX / R |
| 3V3 | VCC |
| GND | GND |

| SN65HVD230 | OBD-II pin |
|---|---|
| CANH | 6 |
| CANL | 14 |

Power from OBD pin 16 (+12 V) and pin 4/5 (GND) into the buck, 5 V out to the XIAO's `5V` pad.

> **Remove the 120 Ω termination resistor** on the transceiver breakout. The vehicle bus
> is already terminated at both ends; a third terminator causes bus errors.

> **OBD pin 16 is permanently live**, so anything plugged into the OBD port draws
> from the battery whether the car is running or not. That includes a BLE ELM327
> adapter — clones typically pull 20–50 mA, roughly 0.5–1 Ah a day — so unplug the
> adapter if the car is parked for more than a few days. This applies to the adapter
> even when the board itself is powered from the accessory socket and switches off
> with the ignition; the two are independent.
>
> The board deep-sleeps after 10 minutes with no ECU response, which protects the
> battery only if the board is itself wired to a permanently-live supply.

---

## Building

```bash
firmware/build.sh              # tests, then compile
firmware/build.sh --upload     # …then flash over USB (PORT=… to pick the port)
```

First run installs `arduino-cli` and the ESP32 core into `firmware/.toolchain/`
(~6 GB unpacked, several minutes) and reuses them after that. Nothing lands outside
the repo, so deleting `firmware/.toolchain/` undoes the install completely.

The output you want is **`firmware/build/NexonOBD-v<version>.bin`** — the app image,
which is what `/update` takes. The version comes from
[`firmware/NexonOBD/version.h`](firmware/NexonOBD/version.h); bump it there and the
filename, the dashboard header and the serial banner all follow.
`NexonOBD.ino.merged.bin` in the same directory is a full-flash image for USB
recovery; feeding *that* to `/update` will not work.

By hand, if you would rather not use the script:

```bash
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32

arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3 --output-dir build firmware/NexonOBD
arduino-cli upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32S3 firmware/NexonOBD
```

Current size: **1.26 MB flash (37 % of `app0`)**, 49 KB RAM (15 %), plus 4.8 KB of
RTC slow memory for the trend buffer. The frontend is no longer part of that: it is
a 22 KB gzipped bundle on the filesystem, and moving it out returned 47 KB of flash.

The default `default_8MB` partition already provides `ota_0` + `ota_1` at 3.19 MB each,
so OTA works without changing the partition scheme.

### Tests

```bash
firmware/test/run.sh          # needs g++, python3 and node — no ESP32 core, no board
```

The ISO-TP layer and the mode-01 batch poller are extracted straight out of
`NexonOBD.ino` and compiled against fake TWAI and ELM327 shims, so frame sequences
that are impractical to stage against a real car — a dropped consecutive frame, a
reordered sequence number, a reply that stops halfway — are covered. The same shims
stand in for the web server, so the deadline give-back described above is tested for
the two properties that make it safe: a silent ECU is still reported silent, and the
extension is bounded. Everything else the sketch
can be asked about without a board — the `/data` contract, the routing, the caching
headers, the DID watch wiring, the trip columns, the history constants — is asserted
against the source under node.

The frontend has its own suite, `npm --prefix web test`: 206 checks over the
hold-last-value merge, the warning-flag gating, the rate tracker, the mileage
readouts and each page's logic, run against the modules that implement them. That is
the point of the split — those used to be JavaScript inside C++ raw string literals,
which nothing in the build ever parsed, so a typo shipped and surfaced as a dead
dashboard in the car.

The "All values" table is checked in a real browser instead, because the node
harness structurally cannot check it: its fake DOM creates any element asked for by
id, so a table whose cells are built once and then addressed by id passes whether or
not those ids line up with the rows — the whole suite goes green with every value
shown against the wrong PID. `test_table.mjs` renders the built bundle and
`tools/dashboard.html`, drives both through a full sample, a partial poll and a
recovery, and asserts that row *i* shows the value of the PID row *i* names. It skips itself, without failing, where
Playwright is not installed.

To look at the pages without flashing anything:

```bash
node firmware/test/shots.mjs out/     # needs playwright + chromium
```

It serves the real pages against a mock `/data` and screenshots them at phone and
tablet widths across four states — cruising, a partial poll, warnings, and ignition
off. The partial-poll shot is the one worth checking after any change to the polling
code, since that is the state that used to blank the dashboard.

### OTA

Run `firmware/build.sh`, join `NexonOBD`, and upload
`firmware/build/NexonOBD-v<version>.bin` at `http://192.168.4.1/update`. The header
shows the new version once it reboots, which is how you confirm the flash took.

The board runs from `app0`; an upload streams into `app1`; `otadata` only flips once
`Update.end()` verifies the image, then it reboots. An interrupted or corrupt upload never
touches `otadata`, so **a failed OTA cannot brick the board** — it reboots into the
firmware it was already running.

So the loop is: build locally → copy the `.bin` to your phone → join the board's Wi-Fi →
upload at `/update`. No dev machine needed at the car, only to produce the image.

> **CI is not in use.** [`ci/build.yml`](ci/build.yml) is kept current — it runs the host
> tests and compiles the firmware — but it is parked outside `.github/workflows/`, since
> pushing there needs the `workflow` OAuth scope this repo's token lacks. Build locally
> with `firmware/build.sh`. To enable CI later:
>
> ```bash
> gh auth refresh -h github.com -s workflow
> git mv ci/build.yml .github/workflows/build.yml
> git commit -m "Enable CI" && git push
> ```

---

## Before you use this

Change the access point credentials in `NexonOBD.ino` — they are placeholders, and the
board is an open target on any network it creates:

```cpp
static const char *AP_SSID = "NexonOBD";
static const char *AP_PASS = "nexon1234";   // >= 8 chars
```

`/update` has **no authentication**. Anyone who can join the AP can flash the board, so a
strong `AP_PASS` is the only thing protecting it.

Set `ELM_BLE_ADDR` in `elm_ble.h` to your own adapter's BLE address — the one committed
here is from the unit this was developed against.

---

## Architecture

```
                    ┌───────────────────────────┐
  phone ──Wi-Fi AP──┤  XIAO ESP32S3             │
                    │   WebServer :80           │
                    │   bundle (LittleFS) + API │
                    │                           │
                    │   obdIsoTp() dispatcher   │
                    │      ├── canIsoTp  (TWAI) ├──SN65HVD230──┐
                    │      └── bleIsoTp  (GATT) ├──BLE──ELM327─┤ OBD-II
                    └───────────────────────────┘              │  pins 6/14
                                                               ▼
                                                            vehicle CAN
```

Both transports implement the same contract — request bytes in, reassembled ISO-TP
payload out — so mode 01, mode 03 and UDS `0x22` are written once and work on either.

`chooseTransport()` prefers CAN when the transceiver answers, else falls back to BLE.
While the ECU is silent it re-evaluates on a backoff — 2 s, then 4, 8, 16, settling
at 20 — resetting to impatient as soon as data arrives.

That matters when the adapter outlives the board, which is the usual split: the OBD
port is always live but an accessory-socket supply is not. Every start then meets an
ELM327 that may still be holding the BLE link to a board that vanished without
disconnecting, so the first connect can fail for a reason that clears itself within
seconds. A flat retry interval meant a dead dashboard for that whole interval at
every ignition.

---

## Safety

This firmware is **read-only by design**. It sends mode 01 (live data), mode 03/07 (fault
codes), mode 09 (vehicle info), UDS `0x22` (ReadDataByIdentifier), and ISO-TP flow
control. It never sends:

| Service | Why not |
|---|---|
| `0x2E` WriteDataByIdentifier | writes ECU memory |
| `0x31` RoutineControl | triggers actuators |
| `0x11` ECUReset | resets a live ECU |
| `0x10` DiagnosticSessionControl | changes ECU state |
| `0x27` SecurityAccess | unlocks protected functions |

Run scans **parked**. Reading is safe; a stalled request while driving is not worth the risk.

---

## Documentation

- **[docs/FINDINGS.md](docs/FINDINGS.md)** — what this specific car exposes, and the
  adapter quirks that cost hours to discover
- **[docs/TOOLS.md](docs/TOOLS.md)** — the PowerShell scripts in `tools/`

## Licence

MIT — see [LICENSE](LICENSE).
