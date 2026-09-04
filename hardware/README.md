# Obdurate Rev A — hardware

One board. The ESP32-S3 module, the CAN transceiver and the whole 12 V power
chain on a single 40 × 40 mm four-layer PCB, sliding into a clear case whose
OBD-II connector is a matched module from the same family.

**There is no schematic or layout here yet, and no Gerbers.** What is here is
everything a schematic would carry, in formats that can be checked: the netlist,
the placement, the board outline, the bill of materials and the fab settings.
The layout is the next job and it needs KiCad.

Everything in this directory is a *design*, not a *measurement*. Nothing here
has been fabricated. The prototype that proved the firmware is a XIAO ESP32S3 on
flying leads to an SN65HVD230 breakout, and it does not resemble this.

---

## Files

| | |
|---|---|
| [`netlist.csv`](netlist.csv) | Every net and its member pins. **Checked against the firmware by the build** |
| [`placement.csv`](placement.csv) | X/Y/rotation for every part, board-local mm, with the reason it sits there |
| [`bom.csv`](bom.csv) | 35 lines, 38 placements, each tagged `spec` or `class` |
| [`outline.dxf`](outline.dxf) | 40 × 40 mm, 2 mm corner radii, mm units. Import as `Edge.Cuts` |
| [`fab.md`](fab.md) | What to select when ordering, and why |

`spec` means a real part number whose datasheet outline is settled. `class`
means the envelope is right and the SKU is still open. The same convention the
README uses for measurements: an unverified claim says so.

## The build checks this against the firmware

Three nets carry pins the firmware already drives:

| Net | Pin | Firmware |
|---|---|---|
| `CTX` | `U3.GPIO2` | `PIN_CAN_TX = GPIO_NUM_2` |
| `CRX` | `U3.GPIO3` | `PIN_CAN_RX = GPIO_NUM_3` |
| `LED_K` | `U3.GPIO21` | `LED_PIN`, driven **active low** |

`firmware/test/test_dashboard.mjs` reads both this directory and the sketch and
fails if they disagree. That is deliberate, and it is the same pattern as the
`/data` contract: a claim that lives in two places and is not checked in one
place will drift. The active-low check matters more than it looks — flip the
firmware to active-high and the LED's anode is on the wrong net, which is a
board respin rather than a one-line fix.

Keeping GPIO2, GPIO3 and GPIO21 is also why **this board runs the existing
firmware image unmodified**. That is worth more than a tidier pinout.

The bus is **500 kbit** ISO 15765-4, CAN 11-bit — which is what the firmware
configures and what picks both the transceiver and the common-mode choke. The
build checks that number against the sketch too, because a car that needs
250 kbit is a hardware note as much as a firmware one.

## Two rules decided the layout

1. **The 12 V chain owns the left half and never crosses the CAN pair.** Power
   enters at the front-left pad and stays there; CAN H and CAN L enter
   front-right and reach U1 in about 9 mm. The switching node between U2 and L1
   is the shortest, widest trace on the board.
2. **The antenna sits at the rear edge, in a keepout.** U3 overhangs the board's
   rear edge by 0.25 mm so its PCB antenna clears host copper. No copper on any
   layer, no parts and no ground pour in a 19.4 × 6.6 mm zone. Then remember
   where this lives — a steel footwell — and validate range from the driver's
   seat with the doors shut, not on a bench.

The case picked the board size, not the other way round: every end cap and
connector in the Minitools modular OBD family is a **43 × 21 mm module**, so
that interface is the hard constraint and the board can be at most about 41 mm
across. 40 × 40 mm uses it with 1.5 mm each side.

## Open questions

These are unresolved, not overlooked.

- **Does the case ship in clear polycarbonate?** The PC variants verifiable in
  stock listings are the narrower `-N-PC` and `-L-PC` boxes, not the 48 mm-wide
  `-M` this board needs. The answer changes the board outline, so it comes
  before the layout. If it does not, the options are an ABS `-M` with a clear
  lid, or a narrower board that fits `-N-PC`.
- **GPIO3 is an ESP32-S3 strapping pin** (JTAG source select) and here it is
  driven by U1's receive output, which idles high because recessive is the CAN
  bus's resting state. Almost certainly fine, and exactly the kind of "almost
  certainly" that costs a board spin. Confirm against the eFuse configuration,
  or accept a firmware change and move the pin.
- **The USB-only rail sits near 3.05 V.** D3's forward drop puts it just inside
  the ESP32-S3's 3.0–3.6 V range with little margin. It only matters for bench
  flashing with no car attached. If that proves flaky, a power-mux IC is the
  right answer rather than a bigger diode.
- **L1's value** is 33–47 µH pending the LM5164 datasheet's application circuit,
  and its height sets the minimum internal clearance — the part most likely to
  force the case taller.
- **U2's pin numbers** are named, not numbered, in the netlist. They come off
  the datasheet at layout time; a wrong number written here would look right.

## Getting from here to Gerbers

1. Schematic in KiCad from `netlist.csv`.
2. Footprints — all standard except U3, and Espressif publish an official KiCad
   library with the WROOM-1 and its keepout.
3. `outline.dxf` as `Edge.Cuts`; place from `placement.csv`.
4. Route to the constraints in [`fab.md`](fab.md), DRC, export.

Then the estimates in the launch plan become quotes, which is the point.
