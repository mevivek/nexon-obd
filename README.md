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
4. Open **`http://192.168.4.1`**.

| Page | What it does |
|---|---|
| `/` | Live gauges — RPM, boost, temps, trims, lambda, catalyst |
| `/scan` | UDS service `0x22` identifier sweep, with CSV export |
| `/update` | Upload a new `.bin` over Wi-Fi |
| `/dtc` | Stored + pending fault codes as JSON |
| `/data` | Current sample as JSON, plus firmware version and active transport |
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
and `/data` returns the newest cached sample. Nothing waits on the bus to serve a
page, so switching between Live, the scanner and Firmware is immediate. It also
means polling does not stop when you close the browser.

One batch per turn matters: the web server is single threaded, so any time spent on
the bus is time the board cannot answer a request. Polling all three batches inline
could leave a tap on a nav link sitting behind seconds of BLE timeouts.

A sample is published after **every** batch, not after all three. The other two are
carried forward from cache while they are still fresh (3 s), so the page updates at
the bus transaction rate rather than a third of it. Batches are not polled equally
either — `b1` carries everything with a sparkline (rpm, speed, MAP, throttle, load,
coolant) and gets half the turns, because oil temperature and battery voltage do not
move fast enough to deserve equal billing:

| | Refresh |
|---|---|
| `b1` — rpm, speed, MAP, throttle, load, coolant | every 2 batches |
| `b2` — oil, IAT, voltage, trims, fuel rate | every 4 batches |
| `b3` — lambda, catalyst, timing, run time, ambient, fuel | every 4 batches |

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

### Trend history

The board keeps one hour of RPM, speed, boost and coolant at 6-second resolution and
serves it at `/history`, so the sparklines have shape the moment the page loads
instead of starting flat.

It survives restarts, which matters more than it sounds: OBD pin 16 is permanently
live, so the board never really power-cycles — it deep-sleeps after 10 minutes idle
and wakes every 30 s, running `setup()` each time. History in ordinary RAM would be
wiped every time you got back in the car.

| Store | Survives | Written |
|---|---|---|
| RTC slow memory (4.8 KB) | deep sleep | every 6 s, free |
| NVS (flash) | power loss | before sleeping, and every 10 min |

Flash is deliberately written rarely — a 4.8 KB blob every few seconds would burn
endurance to save data nobody misses. An unexpected power cut costs the last few
minutes, nothing more.

The onboard LED encodes state, which matters when the board is hidden under the dash:

- **slow blink (1 Hz)** — alive, Wi-Fi up, ECU not answering
- **fast blink (5 Hz)** — talking to the ECU
- **double-blink** — DID scan running

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

> **OBD pin 16 is permanently live.** The firmware deep-sleeps after 10 minutes with no
> ECU response, but unplug it if the car is parked for days.

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

Current size: **1.22 MB flash (36 %)**, 48 KB RAM (14 %), plus 4.8 KB of RTC
slow memory for the trend buffer.

The default `default_8MB` partition already provides `ota_0` + `ota_1` at 3.19 MB each,
so OTA works without changing the partition scheme.

### Tests

```bash
firmware/test/run.sh          # needs g++, python3 and node — no ESP32 core, no board
```

The ISO-TP layer and the mode-01 batch poller are extracted straight out of
`NexonOBD.ino` and compiled against fake TWAI and ELM327 shims, so frame sequences
that are impractical to stage against a real car — a dropped consecutive frame, a
reordered sequence number, a reply that stops halfway — are covered. The dashboard's
hold-last-value logic is pulled out of the served pages and run under node, which
also parse-checks every page script; they are JavaScript inside C++ raw string
literals, so nothing else in the build ever compiles them.

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
                    │   dashboard / scan / OTA  │
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

`chooseTransport()` prefers CAN when the transceiver answers, else falls back to BLE, and
re-evaluates every 20 s while the ECU is silent.

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
