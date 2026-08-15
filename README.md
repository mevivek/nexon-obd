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
| `/data` | Current sample as JSON |

A poll can come back with only some of its PIDs — the dashboard reads them in three
batched requests, and one batch can time out while the others answer. When that
happens the affected gauges keep showing their last reading, dimmed, and the header
reports `live · holding N`. After 2.5 s without a fresh value they fall back to `—`
rather than showing stale data indefinitely, and a held reading never raises or
sustains a warning — a value from two seconds ago cannot tell you whether the engine
is still overheating.

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

The output you want is **`firmware/build/NexonOBD.ino.bin`** — the app image, which is
what `/update` takes. `NexonOBD.ino.merged.bin` in the same directory is a full-flash
image for USB recovery; feeding *that* to `/update` will not work.

By hand, if you would rather not use the script:

```bash
arduino-cli config add board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32

arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3 --output-dir build firmware/NexonOBD
arduino-cli upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32S3 firmware/NexonOBD
```

Current size: **1.21 MB flash (36 %)**, 48 KB RAM (14 %).

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

Run `firmware/build.sh`, join `NexonOBD`, and upload `firmware/build/NexonOBD.ino.bin`
at `http://192.168.4.1/update`.

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
