# Laptop tools

PowerShell scripts that drive an ELM327 over **Bluetooth Classic SPP** from Windows. These
predate the ESP32 firmware and remain useful for bench work — they need no extra hardware
beyond the adapter, and they were how every finding in [FINDINGS.md](FINDINGS.md) was made.

They use `System.IO.Ports.SerialPort` only, so **nothing needs installing** — no Python,
no `pyserial`.

## Pairing the adapter

The adapter pairs as a standard Bluetooth device with PIN `1234`, appearing as an outgoing
COM port. Windows PowerShell cannot subscribe to WinRT events, so scripted pairing needs a
small compiled helper; pairing through Windows Settings is simpler and equivalent.

Confirm the port with:

```powershell
[System.IO.Ports.SerialPort]::GetPortNames()
Get-PnpDevice -Class Ports | Where-Object FriendlyName -match 'Bluetooth'
```

All scripts assume **COM5**. Change the literal at the top of each if yours differs.

---

## `obd_dashboard.ps1`

Serves the live dashboard at `http://localhost:8787/` and appends every sample to
`obd_log.csv` (20 columns, timestamped).

```powershell
powershell -ExecutionPolicy Bypass -File tools\obd_dashboard.ps1
```

Polls in 3 batched requests of 6 PIDs (~2 Hz). Reconnects on its own and re-initialises the
ELM protocol every 4th failure, so switching the ignition off and on recovers without a
restart. Ctrl+C to stop.

Renders `dashboard.html`. Its polling and hold-last-value logic began as a copy of the
firmware dashboard's, but that page no longer exists: the frontend moved out to the
Vite/Preact bundle in `web/`, where the same logic lives as modules in `web/src/lib`
with its own Vitest suite (`npm --prefix web test`). `dashboard.html` keeps its own
standalone copy — nothing keeps the two in step automatically, so treat a change to
one as needing the same change here by hand.

What still checks this page: `firmware/test/test_table.mjs` renders it in a real
browser and asserts its all-values table against the row definitions the page itself
declares, and `firmware/test/test_dashboard.mjs` parses its script block. Its layout
was never shared — the firmware pages were rebuilt around a phone viewport, while
this one is still the original single-column desktop design.

## `obd_enum2.ps1`

Header-aware enumeration of everything the car exposes: supported-PID walk per ECU, live
values with decoded units, mode 03/07 fault codes, and mode 09 vehicle info.

Uses `ATH1` and demultiplexes by responder ID, because `ATCRA` filtering does not work on
this adapter — see FINDINGS. An earlier version that trusted `ATCRA` silently reported the
transmission's PID list as the engine's.

## `uds_ecm_sweep.ps1`

Brute-forces UDS service `0x22` across selected ranges on the ECM, printing every DID that
returns a positive `0x62` response and exporting `ecm_did_hits.csv`.

Read-only: service `0x22` only. Never sends `0x2E`, `0x31`, `0x11`, `0x10` or `0x27`.

Timing is the tricky part — `ATST` too short truncates `responsePending` (`0x78`) replies and
silently loses DIDs; too long makes a full sweep take hours. Run it **parked**.

## `obd_capability.ps1`

Answers "would better hardware help?" empirically:

1. Monitors the bus passively (`ATMA`) to see whether any free-running CAN traffic exists.
2. Probes UDS `0x22` with standard ISO 14229 identification DIDs.
3. Checks which standard modes respond at all.

On this car, test 1 captures nothing — which is how the gateway isolation was established,
and why a CAN sniffer at the OBD port is not worth buying.

---

## Output files (gitignored)

`obd_log.csv`, `did_hits.csv` and `ecm_did_hits.csv` contain the **VIN** (`0902`, `22 F190`,
`22 F1A0` all return it). They are excluded from version control deliberately — keep them
off GitHub, forums and issue trackers.
