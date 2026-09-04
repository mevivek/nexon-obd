# Obdurate — working notes

A read-only OBD-II black box on a Seeed XIAO ESP32S3. Firmware in `firmware/Obdurate/`,
host tests in `firmware/test/`, a Preact frontend in `web/` that deploys separately onto
the board's filesystem, and a custom-board design in `hardware/` that has never been
fabricated.

Read this before building. Everything below was learned the hard way at least once.

---

## Build, test, flash

```bash
firmware/test/run.sh            # host tests only — needs g++, python3, node
firmware/build.sh               # host tests, then compile
firmware/build.sh --upload      # …then flash over USB
npm --prefix web test           # frontend suite
npm --prefix web run build      # frontend build + 300 KB budget gate
web/deploy.sh                   # build, then upload the bundle to 192.168.4.1
```

Expected as of v1.18.0: **482** host C++ checks, **308** firmware-source checks,
**382** frontend checks. All must be 0 failed. (The laptop-dashboard suite was
retired with `tools/dashboard.html` in v1.15.0. The firmware-source count went
287 → 308 when the `hardware/` checks landed; no firmware changed.)

`npm --prefix web run build` also regenerates `firmware/Obdurate/ui_bundle.h` — the
dashboard is compiled into the firmware, so **a UI change needs a reflash unless you
deploy it to LittleFS**. `web/deploy.sh` still overrides the compiled-in copy, which
is the cheap edit loop.

### This machine (Windows)

Everything needed is already installed. Nothing has to be downloaded.

| | |
|---|---|
| `arduino-cli` | `C:\Program Files\Arduino CLI\arduino-cli` (v1.5.1) |
| ESP32 core | `~/AppData/Local/Arduino15/packages/esp32/hardware/esp32/3.3.11` |
| `g++` | WinLibs, **not on PATH** — see below |
| Board | **COM3** (`VID_303A&PID_1001`, ESP32-S3 USB-Serial/JTAG) |

`g++` exists but is not on PATH, so `run.sh` and therefore `build.sh` fail without this:

```bash
export PATH="/c/Users/meviv/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin:$PATH"
```

**`build.sh` reuses the arduino-cli already on the machine** when it has the ESP32 core,
and only falls back to downloading a private one into `firmware/.toolchain/` (~6 GB) when
there is none. If you see it start that download on this machine, something is wrong with
the detection — do not wait for it. `OBDURATE_ISOLATED=1` forces the private toolchain;
that is for CI, where depending on whatever is on the runner is not reproducible.

### Reading the serial log

The board announces itself every 3 s. There is no Unix serial tool here; use PowerShell:

```powershell
$sp = New-Object System.IO.Ports.SerialPort 'COM3',115200,'None',8,'One'
$sp.DtrEnable = $true; $sp.RtsEnable = $false; $sp.Open()
Start-Sleep 8; $sp.ReadExisting(); $sp.Close()
```

A healthy boot with no car attached:

```
[fw] Obdurate 1.18.0
[can] TWAI up @500k
[ap] Obdurate -> http://192.168.4.1
[boot] reset=usb wakes=0
[mem] psram present, scan hits cap 4000 (psram)
[trip] fs 106496/1572864 bytes used, next trip 6
[scan] 214 hits restored from flash
[didmap] 214 records loaded
[hist] 600 samples restored from flash
[veh] done vin=yes cal=SW1234 key=1f3c9a20
[alive] up=19s tr=ble ... ecu=silent ... batch=178ms cycle=840ms stale=3000ms
```

`ecu=silent` with no car is correct. `scan hits cap 4000 (psram)` confirms `PSRAM=opi`
took effect — `400 (heap)` means the FQBN lost its PSRAM flag.

### Wi-Fi

`Obdurate` / `changeme1234`, at `http://192.168.4.1`. `/update` has **no authentication**,
so that password is the only thing protecting the board from anyone who can join.

---

## Landmines

**Do not rename the NVS namespaces.** They are still `nexonscan`, `nexonwatch`,
`nexontrip`, `nexonhist` after the rename to Obdurate, deliberately. Renaming one orphans
what a board already holds — including `scanSaveState()`'s position, which is the resume
point of a sweep that takes half an hour on CAN and the better part of a day over BLE. NVS
caps a namespace at 15 characters, so there is no room to migrate cleverly. Pinned by a
test in `test_dashboard.mjs`.

**Never write source containing backslash escapes through a shell heredoc.** This
cost more time in one session than any real bug. Generating a `Serial.printf` line
from a Python or bash heredoc repeatedly converted its newline escape into an actual
line break, splitting the string literal across two lines. It happened five times,
including once inside the note documenting it, and once it reached `origin/main` —
because the host suite reads the sketch as text and never parses it as C++.

Use the Edit tool for any source containing a backslash escape. If a generator is
genuinely needed, build the escape with `chr(92)` rather than writing it literally.
`firmware/test/quotes.mjs` now lints every firmware source for unbalanced quotes and
names the file and line, which catches the whole class in milliseconds instead of at
`arduino-cli`.

**The working tree is CRLF; the blob in git is LF.** Firmware source is sliced with
`indexOf('\n}\n')` to find where a function ends, and that marker never matches CRLF —
`indexOf` returns `-1`, `slice` does not fail, and a check meant for one function silently
reads the entire sketch. Always read firmware source through `readSrc()` in
`test_dashboard.mjs`, never `readFileSync` directly. Same reason: prefer the Edit tool over
`sed`/Python string replacement on these files.

**`/data` is a contract.** `contract/data.json` declares it and both ends are checked
against it. Adding a field means adding it there too, deliberately. `v` is what the car
reported; `q` (sampling quality) and `boot` (reset reason, uptime, wakes) are **siblings of
`v`, never members** — a number inside `v` goes through the hold-last-value merge and the
warning gating with the real readings.

**`hardware/` is pinned to three GPIO numbers.** `hardware/netlist.csv` says the CAN
transceiver hangs off `U3.GPIO2`/`U3.GPIO3` and the LED off `U3.GPIO21`, because that
is what `PIN_CAN_TX`, `PIN_CAN_RX` and `LED_PIN` already are — which is why a custom
board runs the existing image unmodified. `test_dashboard.mjs` reads the number out of
the sketch and checks the netlist against *that*, so moving a pin fails the build
instead of failing a fab run. The LED check is the sharp one: the firmware drives it
**active low**, so the anode is on 3V3 through R1; flipping that in firmware makes the
board wrong in a way reflashing cannot fix. Same shape as the `/data` contract, same
reason — a claim in two places with a check in neither is a claim that drifts.

**A periodic task must have a call site.** `tripTick()` was written, documented, given CSV
columns and a rotation policy — and never called, on any board, for the project's whole
life. `test_dashboard.mjs` now asserts every `*Tick`/`*Step` is called. Recorders belong in
`samplerStep()`'s `if (any)` branch, **not `loop()`**: `g_live` keeps its last good sample
with `ok` still set after the ECU goes quiet, so a caller in `loop()` records held values as
measurements.

**The Arduino core has already taken `HEX`.** `Print.h` does `#define HEX 16`, so a
local named `HEX` compiles clean under `g++` — the host shims do not define it — and
fails only at `arduino-cli`, which is the slowest place in this project to find a
typo. Pinned by a check in `test_dashboard.mjs`. The same trap exists for `DEC`,
`OCT`, `BIN`, `B1`..`B11111111` and `min`/`max`.

**`AutoPhase` numbers are stored in NVS, so they are assigned, not positional.** A
new phase goes on the END of the enum whatever order it runs in - `AUTO_SWEEP2 = 5`
runs second. Inserting one in pipeline order renumbers every phase after it, and a
board that lost power mid-run comes back in a different phase than it left. Pinned
by checks in both suites.

**One board, one car - and absence is not a mismatch.** `carbind.h` stops every
recorder when the discovered `vehKey()` differs from the bound one, because two cars'
hits in one `scanhits.csv` produce no detectable error, only a file that is quietly
wrong forever. The trap is the other direction: reading "no key" as "wrong car" would
switch off recording on every ECU that declines mode 09, and the symptom - a board
that runs, shows live data and never writes a trip log - is one nobody would
diagnose. Only `CAR_FOREIGN` blocks. Pinned by checks in both suites.

**Never act on absent data.** `NAN`/`null` must break a rule, not satisfy it. The frontend
learned this when `null < 12.2` reported healthy charging systems as broken; the firmware's
battery cutoff follows the same rule, where the equivalent mistake switches the board off
mid-drive.

**Read-only is enforced, not promised.** The build finds every request buffer from its call
sites and fails if a service byte is outside `{01, 02, 03, 06, 07, 09, 0A, 22}`. Do not add
a write service. Requests are capped at 7 payload bytes — one ISO-TP single frame.

**The frontend budget is 300 KB gz** (currently ~27 KB), shared with trip logs on a 1.5 MB
partition. `uplot` is a dependency and is unused — do not start using it; the 14-line pure
geometry in `web/src/pages/live/spark.js` is deliberate.

---

## Known-unverified

Say so rather than implying otherwise — the README's whole convention is that untested
claims are labelled.

- **`docs/flash/`** (esp-web-tools) has never been exercised end to end. It needs the GitHub
  repo renamed to `obdurate`, a tagged release with `Obdurate-merged.bin` attached, and Pages
  enabled. Whether GitHub's release-asset CORS satisfies esp-web-tools is untested; if not,
  commit the image beside the page instead of linking to a release.
- **`ci/build.yml` has never run.** It is parked outside `.github/workflows/` because pushing
  there needs a `workflow` OAuth scope this repo's token lacks. Moving it breaks `git push`.
  Enable with `gh auth refresh -h github.com -s workflow`, then `git mv`.
- **No OTA rollback.** `esp_ota_mark_app_valid_cancel_rollback()` needs a bootloader config
  the stock Arduino ESP32 core does not set, so adding the call would be theatre. A corrupt
  upload still cannot brick the board (`otadata` only flips after `Update.end()` verifies),
  but a *successfully flashed and broken* image has no automatic recovery.
- **Driven once, at idle, for 15 minutes.** That run produced the first trip logs the
  project has ever recorded and the triage numbers below. Still unexercised on a moving
  car: the `q` block under load, mode 06 margins, the torque scalings, the battery floor,
  and anything in the register that only moves with road speed.
- **`docs/flash/` and `ci/build.yml` have still never run.** See above.
- **Vehicle discovery has never run against an ECU.** The parsers are covered by 50
  host checks against synthetic replies, and the walk is covered by 15 source
  checks, but no real `41 00` or `49 02` has ever reached them. Everything the
  Board page reports about this car is therefore untested end to end - including
  whether the Nexon's ECU answers mode 09 at all, which is the thing `vehKey()`
  and so the whole backup check depends on. If it does not, every backup keys to
  the calibration id alone, or to nothing.
- **No backup has been restored onto a board.** The ZIP is checked against the
  format's own bytes rather than only round-tripped, but `/file/put` has never
  been fed one.
- **The autopilot has never completed a phase.** The transitions are a pure function
  with 20 host checks and the wiring has 14 source checks, but no sweep has been
  started by it, no phase has advanced on a real bus, and no watch set has rotated
  at a real `tripBegin()`. The whole pipeline is days of driving, so the first real
  test is a long one.
- **No correlation has ever been computed from a car.** `corrTick` has never had a
  fresh sample; every r in the suite comes from a synthetic straight line. In
  particular it is unknown whether a drive produces enough paired samples past
  `CORR_MIN_N` for the watched identifiers, or whether the 5-minute commit interval
  is the right trade against flash churn.
- **The one-car rule has never seen two cars.** `carBindState` is tested exhaustively
  as a pure function, but no board has been moved between vehicles, so the path where
  a real mismatch stops the recorders has never run.

---

## Where things stand (v1.18.0)

Recent work, newest first. `git log` has the reasoning; this is the map.

- **`hardware/` — a board design, not a board.** One 40 × 40 mm four-layer PCB
  carrying the ESP32-S3 module, an SN65HVD230 and a 100 V-tolerant power chain,
  in a clear Minitools case whose OBD-II connector is a matched module. The
  netlist, placement, BOM, outline DXF and fab settings are there; **there is no
  schematic, no layout and no Gerbers**, and nothing has been fabricated. The
  case's 43 × 21 mm cap interface is what fixes the board at 40 mm across. Open
  questions are listed in `hardware/README.md` and are real: whether the case
  ships in clear polycarbonate at this size, and whether GPIO3 being an ESP32-S3
  strapping pin matters when a CAN transceiver drives it.

- **Five tabs, not six.** Sweep and Watch merged into **Discover** (`Discover.jsx`,
  still at `/scan`): they are two halves of one pipeline the autopilot runs end to
  end. `/watch` redirects to `/#/scan` and stays, because it is in bookmarks and in
  the nav of any older bundle on a LittleFS. One pill between three pollers, chosen
  by precedence in `discover/pill.js` - never last-writer, or it flickers between
  three unrelated sentences.
- **The pipeline sweeps the TCM too**, but only when discovery's probe at 0x7E9
  actually answered. This is the one place that gates on a POSITIVE rather than on
  the absence of a negative, and deliberately: a sweep of an ECU that is not there
  does not fail, it *stalls* - 25 consecutive timeouts hold position rather than
  concluding an unswept range is empty. Right for a sweep, fatal for a pipeline.
- **Autopilot** (`autopilot.h`, `/auto`, Discover's top card) - sweep,
  triage and watch chained, advancing on their own, surviving the ignition in NVS.
  The watch set rotates eight at a time at `tripBegin()` - never mid-drive, because
  that bumps `watchGen` and rotates the trip CSV.
- **On-board correlation** (`correlate.h`) - running Pearson of each watched
  identifier against rpm, coolant, speed, load, throttle and volts. The best fit
  lands in the register as three new CSV columns (`tracks,r,samples`), appended so
  an older `didmap.csv` still loads. It is "tracks", never "is": oil temperature
  tracks coolant almost perfectly, and r is blind to offset and scale.
- **One car per board** (`carbind.h`, `/car`, the banner in `App.jsx`) - a foreign
  car gets live readings and records nothing, with a choice of adopting it (erases
  the previous car) or keeping the old binding.
- **Vehicle discovery** (`vehicle.h`, `/vehicle`, the Board page's top card) —
  the mode 01 support bitmaps, mode 09 VIN/calibration/CVN, and one probe at the
  transmission's responder id, walked once per boot while the ECU is answering.
  Reports which polled PIDs this car supports; changes nothing about what is
  polled. `vehKey()` is the FNV-1a hash a backup is checked against.
- **Backup / restore / erase** — the Firmware tab is now the **Board** page and
  carries all three. The ZIP is built in the browser (`web/src/lib/zip.js`, STORED
  entries only), keyed on `vehKey()`, and a restore from a different car is refused
  with no override. Two erase scopes, each armed by a second press.
- **The dashboard is compiled into the firmware** (`ui_bundle.h`, generated by
  `web/scripts/embed.mjs`, committed). Flashing is the whole install. A LittleFS
  bundle still overrides it.
- **Triage** — re-reads every identifier a sweep found to see which actually move,
  so watch slots are not spent on constants. `didmap.h`, `/triage/start|stop`,
  `/didmap`, and a panel on the Scanner page. Survives the ignition.
- **The register** — `/didmap.csv`, one record per identifier: state, reads,
  changes, first and last value.
- **Data endpoints** — `/files`, `/file`, `/file/put`, `/reset`. Backup is meant to
  be assembled in the BROWSER; these are the surface for it.
- Earlier: the trip recorder was switched on (it had never run), a battery floor,
  the `q` sampling receipt, mode 06 no longer concluding from silence, the rename,
  and the web flasher.

### Still to build

The three items that stood here - backup/restore, the erase buttons and capability
discovery - all landed in v1.16.0. What is left is what was deliberately deferred:

1. **Adapting the polling to the car.** Discovery reports what a car supports; the
   sampler still asks for the Nexon set regardless. Doing better needs a
   vehicle-profile format, and `PID_B1..B4` are compiled verbatim into the host
   tests. Designing that against a sample of one car would be designing it blind -
   wait for a second car.
2. **Nothing in v1.16.0 or v1.17.0 has been near a car.** See below.

### What the car actually said

One 15-minute run at idle, 6 passes, on 214 identifiers:

- **66 vary, 148 undecided, 0 constant.** Zero constant is correct - nothing
  reached the 10 reads a constant verdict needs.
- By block: `11xx` 44%, `10xx` 41%, `12xx` 25% vary. `13xx`, `16xx`, `70xx`,
  `72xx`, `F1xx` were **0%** - whole blocks are static, which is what triage is for.
- **Treat 66 as a floor.** It was idling, so anything responding to road speed or
  load had no chance to move. A cold start plus real driving is the run that matters.
- ~40-58% of identifiers answer per pass; the adapter drops the rest. Ten clean
  reads on everything needs ~20 passes, so budget ~15 minutes, not 6.

> An earlier run reported 140 varying. That was a parser bug, not the car - the
> register loader dropped the state field and fabricated a change count. Fixed in
> v1.14.1, and the `changes < reads` invariant is now enforced on load. If a result
> ever looks too good, check that invariant first.
