# Laptop tools

> The standalone laptop dashboard (`tools/dashboard.html`, served by
> `obd_dashboard.ps1`) has been retired. It was a second implementation of the
> gauges, with its own copy of the merge, hold and warning logic and its own test
> suite, kept in step with the board's by hand - and the board now ships that
> dashboard compiled into its own firmware, reachable from any phone without a
> laptop in the car at all. Two implementations of one screen is a maintenance
> cost with nothing on the other side of it.
>
> The scripts below are exploration tools, not a dashboard, and they stay: they
> answer questions about a car that the board is not the right shape to ask.

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
