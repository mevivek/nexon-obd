# Ordering Rev A

**Order the `-xiao` variant.** Same board outline and the same fab settings as
`-wroom`, so everything below applies to either — but the XIAO variant's finest
pitch is 1.27 mm rather than 0.5 mm, which is the difference between a board you
can hand-assemble with hot air and one you would rather not.

Fabrication only — none of these vendors' PCB pages include assembly. Bare
boards cover the ~$0.60 PCB line in the plan's BOM, not the ~$2.60 assembly
line. Five `-xiao` prototypes are genuinely hand-solderable: SOIC-8, 0603, 1210
and a castellated module are all within reach of hot air, and the XIAO removes
the USB-C, the LDO and the LED from the job. For 300 units you need turnkey PCBA
with component sourcing, and [`bom.csv`](bom.csv) is the file they will ask for —
filter it to `common` plus the variant you are building.

## Quantity

**Order 5, not 1–2.** Robu's minimum is 5 anyway, and 5 is the right number
regardless: hand-assembling a first four-layer board with a castellated module
teaches you something, and what it teaches you may cost you that board. You want
one you are willing to destroy. Gate 1 in the plan is *five units surviving a
week in a car* — one working board says the design can work, five say it
reliably does, and only the second claim justifies taking anyone's money.

Bare boards are the cheapest line in the whole BOM. Ordering two to save money
is a false economy when the parts and your evenings dominate.

**For the first spin, send the same Gerbers to two fabs.** For a few hundred
rupees you learn who gives real DFM feedback, whose silkscreen holds 1.2 mm
text, and whose quoted lead time is honest. At this stage that is worth more
than the boards.

## Settings

Taken from Robu's order form. The reasoning generalises to any fab.

| Setting | Choose | Why |
|---|---|---|
| Layers | **4** | Ground plane plus routing |
| Dimensions | **40 × 40 mm** | Set by the case's 43 × 21 mm cap interface |
| Quantity | **5** | See above |
| Product type | Industrial / consumer | Not aerospace or medical |
| Thickness | **1.6 mm** | The case rails assume it |
| Delivery format | **Single PCB** for protos, **panel** for production | Assembly houses want rails and fiducials; hand-building five does not |
| Material | **S1141 TG140** or **S1000H TG155** | Not the default TG135. This lives in a footwell through an Indian summer — higher glass-transition temperature is cheap margin |
| Colour | Green for protos | Behind a clear case this becomes a product decision, not an internal one. Black with white silkscreen reads better in the box |
| Silkscreen | White | |
| Surface finish | **ENIG-RoHS** | Three reasons, below |
| Copper weight | 1 oz | Peak draw is ~0.5 A. 2 oz buys nothing |
| Via covering | Tented | Keeps solder off the ground-stitching vias |
| Remove order number | **Yes** | Through clear polycarbonate the fab's order number is a visible blemish |
| Electrical test | Flying probe, full | Take it |
| Appearance quality | IPC Class 2 | Class 3 is for high-reliability hardware. This is a read-only diagnostic accessory, not a safety system |
| Gold fingers / castellated / edge plating | No | The castellations belong to U3, which is a bought part |

### Why ENIG is worth the upcharge

1. The six pogo test pads need a flat, oxidation-resistant surface to make
   reliable contact across 300 units. HASL's uneven blobs are the wrong surface
   for a probe to land on, and the plan commits to testing every unit.
2. The board is visible through a clear case.
3. **HASL with lead is not RoHS compliant**, which forecloses the EU and UK
   entirely — and it is the option preselected by default on that form.

## Design rules to route to

| | |
|---|---|
| Minimum via | 0.30 mm drill / 0.60 mm pad |
| Board outline tolerance | ±0.2 mm — comfortable against 1.5 mm case clearance per side |
| Minimum silkscreen text | **1.2 mm.** The concept model used 1.05 mm for `TP1`–`TP6`, which is at the fab floor — raise it before exporting |
| Minimum trace / clearance | 0.15 mm is available; nothing here needs finer than 0.25 mm |
| Finest pitch on the board | **`-xiao`: 1.27 mm** at U1/U2's SOIC-8. `-wroom`: 0.5 mm at J2's USB-C, which is what would set that variant's fab class |
| Copper | 1 oz outer |

## Lead time

Robu quotes **15–20 business days**, which is three to four weeks and slower
than a Chinese fab direct — the price and the wait both include import into
India. Budget for it: at that cadence a rev A → rev B loop is two months, which
is most of Phase 1.

## The one thing that changes the plan

If the boards are fabbed *and* assembled in India and exported to Crowd Supply's
warehouse, that is a plain **export of goods** — an IEC plus an LUT for
zero-rated GST — rather than the merchanting-trade transaction the plan assumes
when manufacturing in Shenzhen and shipping straight to Portland. Probably a
higher unit cost, definitely simpler paperwork, and merchanting trade is the
fiddliest item in the plan's compliance section.
