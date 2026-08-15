# Findings — 2022 Tata Nexon 1.2 petrol (BS6)

Everything here was measured against the car, not taken from a datasheet. Dates: August 2026.

> No VIN, registration or other identifying data is committed to this repo. The scan tools
> write CSVs containing the VIN (`0902`, `22 F190`, `22 F1A0`) — those files are gitignored.

---

## Bus and modules

| | |
|---|---|
| Protocol | ISO 15765-4, CAN 11-bit, 500 kbit |
| ECM | request `7E0` / response `7E8` — supplier **`BOSCH LIMITED`** (`22 F18A`) |
| TCM | request `7E1` / response `7E9` — **`TCM-TransmisCtrl`** (AMT) |

### The OBD port is gateway-isolated

`ATMA` (monitor all) captures **zero frames** over 8 seconds. There is no free-running
broadcast traffic on pins 6/14 — only diagnostic request/response passes the gateway.

**Consequence:** a CAN sniffer at the OBD connector records nothing. SavvyCAN, cabana and
similar reverse-engineering workflows are useless here without tapping a bus behind the
gateway. Only polling works.

---

## Adapter quirks (ELM327 v1.5 clone)

These cost hours. All reproducible.

### `ATSP0` auto-detect fails

Auto-detect identifies the protocol correctly (`ATDP` reports `AUTO, ISO 15765-4 (CAN 11/500)`)
but every request returns `NO DATA`. Forcing the protocol works first time:

```
ATSP6      # CAN 11-bit 500k
ATAT2      # adaptive timing, aggressive
ATST 64    # 100 x 4 ms = 400 ms
```

### `ATST` must be shorter than the reader's own timeout

`ATST` is how long the *adapter* waits for the ECU, and it has to be comfortably
below however long the host waits for the adapter. Set the other way round — `ATST FF`
is 255 × 4 ms = 1020 ms — the host gives up first and reads a buffer with no `>`
prompt, which is a truncated reply by definition. Every such reply is then lost, even
though the ECU answered perfectly well a moment later.

On the firmware's BLE transport this showed up as a dashboard that was almost
entirely blank at **0.3 Hz**: a 900 ms read window against a 1020 ms adapter timeout,
so slow replies were cut off, discarded, and retried until the poll rate collapsed.
`ATST 64` (400 ms) against a 1200 ms read window leaves the adapter room to answer —
even if the answer is `NO DATA` — before the host stops listening.

### `ATCRA` does not filter

The receive-address filter is accepted but does nothing — replies from **both** ECUs come
back regardless. Parsing the first `41xx` in the buffer therefore reads whichever ECU
answered first.

This produced a real, silent error: the ECM's supported-PID mask was read as `88188001`
(the TCM's) instead of `FE3EA813`, reporting 11 PIDs where the ECM actually has 55.

**Fix:** enable headers (`ATH1`) and demultiplex by responder ID in software. This firmware
does that on both transports.

### The BLE interface exists, on a different address

The adapter is **dual-mode**. Its BLE address is the Classic MAC with the top bit of octet 0
set — `01:23:45:67:89:BA` → `81:23:45:67:89:BA` — and advertises as `OBDBLE`:

```
SERVICE 0000fff0
  CHAR 0000fff1  Read, Notify                <- responses
  CHAR 0000fff2  WriteWithoutResponse, Write <- commands
```

A passive scan filtered on the Classic MAC finds nothing and looks like proof there is no
BLE. An **active** scan capturing service UUIDs finds it immediately. This matters because
the ESP32-S3 has no Bluetooth Classic radio and BLE is its only route to the adapter.

### Bluetooth Classic SPP link drops when idle

`SerialPort.Open()` then throws *"The semaphore timeout period has expired"*. Retry-on-open
is mandatory; a single attempt will silently fail and every subsequent command returns
nothing while appearing to run.

### Batched PID requests are ~4× faster

Mode 01 accepts up to 6 PIDs in one message. Measured on this car:

| | |
|---|---|
| 6 separate requests | 672 ms |
| 1 batched request | **171 ms** |

---

## What the car exposes

### Mode 01 — ECM: 55 PIDs

```
01 02 03 04 05 06 07 0B 0C 0D 0E 0F 11 13 15 1C 1F 20 21 2E 2F 30 31 33 34 3C
40 41 42 43 44 45 46 47 49 4A 4C 4D 4E 4F 50 51 56 5A 5C 5E 60 61 62 63 67 70
80 87 9E
```

Notable: `70` boost pressure control, `3C` catalyst temp B1S1, `34` wide-range lambda,
`61`/`62`/`63` torque, `5C` oil temperature, `5E` fuel rate.

**`10` (MAF) is not supported** — this ECU is speed-density, so airflow derives from MAP (`0B`).

### Mode 01 — TCM: 11 PIDs

`01 05 0C 0D 11 20 21 30 31 40 42` — generic mirrors only. **No gear position, clutch state
or ATF temperature** over standard OBD.

### Values that are present but not trustworthy

| PID | Reads | Reality |
|---|---|---|
| `2F` fuel level | pegged 100.0 % | not wired through |
| `46` ambient temp | identical to IAT | echoes the intake sensor |
| `30` warm-ups | 255 | saturated at byte max |
| `13` O2 sensors present | `00` | not implemented |
| `51` fuel type | `00` | not implemented |

### Other modes

| Mode | Result |
|---|---|
| `03` / `07` | supported — `4300` / `4700`, no codes stored |
| `06` | **supported** — `46 00 C0000001` (catalyst/misfire monitors). Not yet explored |
| `09` | supported — VIN, calibration ID, ECU name |
| `02` freeze frame | `NO DATA` (nothing stored) |
| `08` control | `NO DATA` — not supported |
| `0A` permanent DTCs | supported — none stored |

---

## UDS service `0x22`

Service `0x22` **is supported** on both ECUs in the default session — no `0x27` security
access needed for these.

### Ranges swept, and what was found

| ECU | Ranges swept | Result |
|---|---|---|
| ECM | `F1xx` `F4xx` `01xx` `02xx` `03xx` `20xx` `D0xx` `F3xx` | identification only |
| ECM | full `0000`–`FFFF` pass (in progress) | **a dense `10xx` block** |
| TCM | `F1xx` `01xx` | identification only |

This section previously concluded **"no live-data DIDs found in any conventional range"**,
from 8 of 256 ranges on the ECM. The first full sweep contradicts it: by `233F` it had
found 190 identifiers, heavily concentrated from `1000` upward and answering with one or
two raw bytes each — not the ASCII strings the `F1xx` block returns. That is the shape of
manufacturer measurement blocks, and `10xx` was never among the ranges tried.

ISO 14229-1 puts `0100`–`A5FF` at the vehicle manufacturer's disposal, so nothing in the
standard names these. Identifying them means correlation, not lookup — see the DID watch
in the README.

Two cautions on that 190:

- **It is a floor.** The sweep ran over BLE at 6.0 identifiers/s, and this adapter drops
  responses (below). A DID that stayed silent may well answer next time.
- **Silence is not a refusal here.** 9023 tried produced exactly *one* negative response,
  so this ECU ignores unsupported identifiers rather than returning `0x7F`. "No reply" and
  "the adapter ate the reply" are therefore indistinguishable from the sweep alone.

### Identifiers that answer

| DID | ECU | Content |
|---|---|---|
| `F18A` | ECM | `BOSCH LIMITED` (system supplier) |
| `F189` | ECM | ECU software version |
| `F197` | ECM | system name |
| `F127` | ECM | `00` |
| `F190` | both | VIN |
| `F18C` | TCM | ECU serial number |
| `F192` | TCM | hardware number |
| `F194` | TCM | software number `285316301107` |
| `F187` | TCM | spare part number |
| `F180/81/82` | TCM | boot/app versions `06_N5_11`, `MA13`, `BB61` |
| `F183/84/85` | TCM | programming date `22 05 17` → **17 May 2022** |
| `1000`–`1008`… | ECM | manufacturer measurement block, 1–2 raw bytes each, meaning unknown |

Observed from the `10xx` block: `1000` = `91`, `1001` = `00 A3`, `1002` = `15 4F`,
`1003` = `14`, `1004` = `00 99`, `1005` = `00 D6`, `1006` = `61 8F`, `1007` = `00 20`.
Contiguous, and starting at a round address — a block, not scattered identifiers.

### The ELM327 clone drops UDS responses

Three sweeps of the same ECM range returned three different subsets:

| Run | ECM DIDs found |
|---|---|
| 1 | `F190` |
| 2 | `F127`, `F197` |
| 3 | `F127`, `F189`, `F18A` |

Union: 5. Best single run: 3. **The adapter loses responses**, so any single ELM327 sweep
undercounts. This is the strongest argument for the direct-CAN transport — not speed, but
*correctness*.

---

## Open questions

- What the `10xx` block holds. The DID watch logs a chosen handful beside the live PIDs;
  the work is fitting each column against a known value afterwards.
- Whether `10xx` is contiguous all the way up, and where it ends. The sweep was at `233F`.
- A repeat sweep over direct CAN, to find what the ELM327 dropped. ~30 min, versus 2h37m.
- Mode 06 monitor test results never read.
- Torque PIDs `61`/`62`/`63` scaling unverified — need data under load, not at idle.
- Bosch ME/MED17-family DID lists circulate publicly and may shortcut the brute-force.
