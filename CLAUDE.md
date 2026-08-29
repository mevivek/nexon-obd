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

Expected as of v1.12.0: **293** host C++ checks, **162** firmware-source checks,
**34** laptop-dashboard checks, **225** frontend checks. All must be 0 failed.

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
[fw] Obdurate 1.12.0
[can] TWAI up @500k
[ap] Obdurate -> http://192.168.4.1
[boot] reset=usb wakes=0
[mem] psram present, scan hits cap 4000 (psram)
[trip] fs 69632/1572864 bytes used, next trip 1
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

**The frontend budget is 300 KB gz** (currently ~22 KB), shared with trip logs on a 1.5 MB
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
- **Nothing since v1.12.0 has been driven.** The board has been flashed and its boot verified
  with no car attached. Trip logging, the `q` block under load, mode 06 margins and the
  torque scalings all need a drive.
