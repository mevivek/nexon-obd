# Obdurate — working notes

A read-only OBD-II black box on a Seeed XIAO ESP32S3. Firmware in `firmware/Obdurate/`,
host tests in `firmware/test/`, a Preact frontend in `web/` that deploys separately onto
the board's filesystem.

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

Expected as of v1.15.0: **343** host C++ checks, **234** firmware-source checks,
**285** frontend checks. All must be 0 failed. (The laptop-dashboard suite was
retired with `tools/dashboard.html` in v1.15.0.)

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
[fw] Obdurate 1.15.0
[can] TWAI up @500k
[ap] Obdurate -> http://192.168.4.1
[boot] reset=usb wakes=0
[mem] psram present, scan hits cap 4000 (psram)
[trip] fs 106496/1572864 bytes used, next trip 6
[scan] 214 hits restored from flash
[didmap] 214 records loaded
[hist] 600 samples restored from flash
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

**A periodic task must have a call site.** `tripTick()` was written, documented, given CSV
columns and a rotation policy — and never called, on any board, for the project's whole
life. `test_dashboard.mjs` now asserts every `*Tick`/`*Step` is called. Recorders belong in
`samplerStep()`'s `if (any)` branch, **not `loop()`**: `g_live` keeps its last good sample
with `ok` still set after the ECU goes quiet, so a caller in `loop()` records held values as
measurements.

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

---

## Where things stand (v1.15.0)

Recent work, newest first. `git log` has the reasoning; this is the map.

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

1. **Backup/restore UI** — a ZIP built client-side from `/files` + `/file`,
   restored through `/file/put`. Use STORED (uncompressed) entries so unzip needs
   no inflate. The backup should carry a manifest (ECU calibration id or VIN hash)
   and restore should REFUSE on mismatch: a `didmap.csv` from another car would
   silently attach 214 verdicts to the wrong engine.
2. **Reset UI** — buttons for the two scopes the firmware already implements.
3. **Onboarding / capability discovery** — walk the mode 01 support masks, read
   mode 09 VIN and calibration, enumerate responding ECUs, and report which
   dashboard tiles this car can fill. Approved as *discovery and honest reporting
   only*: the dashboard keeps polling the Nexon PID set and unsupported tiles read
   blank. Adapting the batches at runtime was explicitly deferred - `PID_B1..B4`
   are compiled verbatim into the host tests, and a vehicle-profile format would be
   designed blind until a second car exists.

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
