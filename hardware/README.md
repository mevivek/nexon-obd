# Obdurate Rev A — hardware

One carrier board, 40 × 40 mm, four layers, in a clear Minitools case whose
OBD-II connector is a matched module from the same family. It carries the CAN
transceiver, the 12 V power chain and the test points; the MCU arrives as a
module, and there are **two variants of which module**.

**There is no schematic or layout here yet, and no Gerbers.** What is here is
everything a schematic would carry, in formats that can be checked: the netlist,
the placement, the board outline, the bill of materials and the fab settings.

Everything is a *design*, not a *measurement*. Nothing has been fabricated. The
prototype that proved the firmware is a XIAO ESP32S3 on flying leads to an
SN65HVD230 breakout — which is exactly what the `-xiao` variant turns into a board.

---

## Two variants, one circuit

| | `-xiao` | `-wroom` |
|---|---|---|
| Module | Seeed XIAO ESP32S3, 21 × 17.5 mm | ESP32-S3-WROOM-1-N8R8, 18 × 25.5 mm |
| Buck output | **5 V** into the XIAO's 5V pad; its LDO makes 3.3 V | **3.3 V** directly |
| USB | on the module | J2 on the board, **0.5 mm pitch** |
| 3.3 V regulator | on the module | U4 + D3 OR diode on the board |
| Status LED | **on the module** — its onboard LED *is* GPIO21 | LED1 + R1 on the board |
| Boot / reset | buttons on the module | R3, R4, C7 on the board |
| Antenna | U.FL flying part, positioned in the case | PCB antenna, needs a board keepout |
| Finest pitch | 1.27 mm (SOIC-8) | 0.5 mm (USB-C) |
| Parts | ~25 | ~38 |
| Module cost | ~$7.00 | $3.20 |

**Rev A is `-xiao`.** Rev A's job is Gate 1 — five units surviving a week in a
car — not hitting a cost target, and the XIAO removes twelve parts, the finest
pitch on the board, the antenna keepout and two open questions. It is also what
the firmware already runs on, so nothing about the software is new.

**`-wroom` is the volume answer.** Roughly $2.70 a unit cheaper once the twelve
parts it adds back are counted, more integrated, and it looks like a product
rather than a dev board on a carrier — which matters behind a clear case at $119.
Move to it for Rev B if the volume justifies the extra layout.

The shared 90% is written once. Every CSV carries a `variant` column of `common`,
`xiao` or `wroom`, and the effective design is the common rows plus one variant's.
Both are checked independently by the build, because a shared circuit with one
checked half has an unchecked half.

## Files

| | |
|---|---|
| [`netlist.csv`](netlist.csv) | Every net and its member pins, per variant. **Checked against the firmware** |
| [`placement.csv`](placement.csv) | X/Y/rotation for every part, board-local mm, with the reason it sits there |
| [`bom.csv`](bom.csv) | Per-variant, each line tagged `spec`, `class` or `estimate`, each with a KiCad footprint |
| [`xiao-pinmap.csv`](xiao-pinmap.csv) | XIAO pad → GPIO, with a source and a confirmed/unverified flag per row |
| [`outline.dxf`](outline.dxf) | 40 × 40 mm, 2 mm corner radii, mm units. Import as `Edge.Cuts` |
| [`fab.md`](fab.md) | What to select when ordering, and why |

`spec` means a real part number whose datasheet outline is settled. `class` means
the envelope is right and the SKU is still open. Same convention the project's
README uses for measurements: an unverified claim says so.

## The build checks this against the firmware

| Net | `-xiao` | `-wroom` | Firmware |
|---|---|---|---|
| `CTX` | `U3.D1` | `U3.IO2` | `PIN_CAN_TX = GPIO_NUM_2` |
| `CRX` | `U3.D2` | `U3.IO3` | `PIN_CAN_RX = GPIO_NUM_3` |
| LED | *none — the module's* | `LED_K` → `U3.IO21` | `LED_PIN`, **active low** |

`firmware/test/hardware.mjs` reads the pin number out of the sketch and checks
the netlist against **that**, translating through `xiao-pinmap.csv` on the XIAO
variant where the pad is called `D1` rather than `IO2`. Asserting "the netlist
says IO2" and "the firmware says GPIO2" as two independent facts would pass
happily after someone changed both to different values.

The bus is **500 kbit** ISO 15765-4, CAN 11-bit — what the firmware configures,
and what picks both the transceiver and the common-mode choke. The build checks
that number against the sketch too.

Two things this catches that are easy to get wrong. The LED is driven **active
low**, so on `-wroom` its anode sits on the rail through R1; flip the firmware and
that board is wrong in a way reflashing cannot fix. And on `-xiao` there must be
**no** board LED, because GPIO21 is not on a XIAO pad at all — it is the module's
own onboard LED, which is what `LED_BUILTIN 21` has always referred to. Adding one
would put two things on one pin.

## Two rules decided the layout

1. **The 12 V chain owns the left half and never crosses the CAN pair.** Power
   enters front-left and stays there; CAN H and CAN L enter front-right and reach
   U1 in about 9 mm. The switching node between U2 and L1 is the shortest, widest
   trace on the board. This is also what makes the board routable without
   crossings.
2. **The module sits at the rear with nothing underneath it.** The common parts
   are positioned to clear *both* module footprints, so the power and CAN sections
   do not move between variants.

The case picked the board size: every end cap and connector in the Minitools
modular OBD family is a **43 × 21 mm module**, so that interface is the hard
constraint and the board can be at most about 41 mm across.

## Open questions

Unresolved, not overlooked.

- **Does the case ship in clear polycarbonate at this size?** The PC variants
  verifiable in stock listings are the narrower `-N-PC` and `-L-PC` boxes, not the
  48 mm-wide `-M` this board needs. The answer changes the outline, so it comes
  before the layout.
### Answered

- **Is the XIAO's 5V pad diode-isolated from VBUS? No — it is not.** Seeed's own
  expansion-board guidance is explicit that an external supply into the 5V pad
  needs a series Schottky, anode to the supply. Without it, plugging USB in
  back-powers whatever is feeding that pad. **D5 exists because of this**, and it
  is not optional. It costs ~0.3 V, leaving ~4.7 V into the module, which its
  regulator handles comfortably.
- **Does the XIAO's regulator have headroom for U1's ~70 mA?** Not published for
  the S3. The C3's 3V3 pad is rated 700 mA and the S3 schematic names the part
  `SGM6029CYG`, but I will not plan against a rating I cannot source. Resolved by
  design instead: **R13** links the module's 3V3 to U1 on Rev A, and **U5** is an
  unpopulated local LDO on the same net. Fit one or the other, never both. Then
  measure it in Phase 1, which is already the first hardware action. An
  unpopulated footprint costs nothing next to a board spin.
- **GPIO3 is an ESP32-S3 strapping pin** (JTAG source select), driven here by
  U1's receive output, which idles high because recessive is the bus's resting
  state. Almost certainly fine, and exactly the kind of "almost certainly" that
  costs a board spin. Affects both variants.
- **L1's value** is 33–47 µH pending the LM5164 application circuit, and its
  height sets the minimum internal clearance — the part most likely to force the
  case taller.
- **R10/R11 and R12 values** — the feedback divider ratio differs by variant
  because the output does, and R12 sets the switching frequency. Both come off the
  datasheet.
- **`-wroom` only: the USB-only rail sits near 3.05 V** after D3's drop, just
  inside the ESP32-S3's 3.0–3.6 V range. Matters for bench flashing with no car
  attached; a power-mux IC is the better answer than a bigger diode.
- **Most of `xiao-pinmap.csv` is `unverified`** — the pad order comes from the
  XIAO form factor, and only D1, D2, 3V3 and GND are corroborated by this repo.
  Getting it wrong swaps pins, so check it against Seeed's own footprint before
  sending Gerbers.

## Building the board

[`build_board.py`](build_board.py) turns these CSVs into a real `.kicad_pcb`:
footprints loaded from the stock libraries, placed per `placement.csv`, nets
assigned per `netlist.csv`, and the 40 × 40 mm outline drawn on `Edge.Cuts`. Run
it with KiCad's own Python, which is the one that has `pcbnew`:

```
"%LOCALAPPDATA%\Programs\KiCad\10.0\bin\python.exe" build_board.py xiao wroom
```

Current state — both variants build with **every pad resolved**:

| | `-xiao` | `-wroom` |
|---|---|---|
| Footprints placed | 36 | 46 |
| Pads connected | 83 | 137 |
| Nets | 23 | 30 |
| Unresolved | 0 | 0 |
| Copper past the outline | none | none |

The script holds no design data of its own except the **pin name → pad number**
maps, which cannot live in the CSVs: the CSVs name pins, footprints number pads.
Those maps come from KiCad's own symbol libraries, read out by `pinout.py`, plus
`xiao-pinmap.csv` for the XIAO row order and the USB-C Type-C contact
designations for J2.

Then to look at it or export it:

```
kicad-cli pcb export glb    --output revA-xiao.glb obdurate-revA-xiao.kicad_pcb
kicad-cli pcb render        --output iso.png --quality high --perspective \
                            --zoom 0.75 --rotate "-32,0,22" obdurate-revA-xiao.kicad_pcb
kicad-cli pcb export gerbers --output gerbers/ obdurate-revA-xiao.kicad_pcb
```

GLB and PNG outputs are gitignored — they regenerate in about a second and a
quarter respectively, and there is no reason to carry megabytes of binary that a
command reproduces.

**Two things the render exposed that nothing else would have.** Stock footprints
ship their 3D models with `(hide yes)`, so the first render came out as bare pads
with no parts on it at all. And KiCad ships **no 3D model for any XIAO board** —
`MCU_Seeed_ESP32C3.step` is referenced but absent — so the `-xiao` render shows
the land pattern with nothing standing on it. The WROOM's model does exist.

**What still needs doing:** the silkscreen designators collide in the power
section, which is cosmetic but ugly and worth fixing before Gerbers. Netclasses,
the ground pour and the `-wroom` keepout zone are not created yet. And nothing is
routed — the board has a correct netlist and a ratsnest, which is the input to
routing rather than its output.

## Getting from here to Gerbers

1. Netclasses per `netlist.csv`, ground pour on an inner layer, keepout on `-wroom`.
2. Route. The layout was designed so the nets do not need to cross.
3. DRC, then `kicad-cli pcb export gerbers`.

DRC checks geometry, not whether the circuit is right. The netlist is checked
against the firmware for the CAN pins and the LED, and against itself for
completeness — but nothing checks that R8/R9 are on the correct side of U2's
EN/UVLO pin. That comes off the datasheet, which is why U2's pins are named here
rather than numbered.
