"""Build a .kicad_pcb for one variant from the CSVs in this directory.

Run with KiCad's bundled Python, which is the one that has pcbnew:

  "%LOCALAPPDATA%\\Programs\\KiCad\\10.0\\bin\\python.exe" build_board.py xiao

Footprints, placement and nets all come out of netlist.csv / bom.csv /
placement.csv, so this script holds no design data of its own except the pin
name -> pad number maps below, which cannot live in the CSVs because the CSVs
name pins and footprints number pads.

What this does NOT do: route. It produces a placed board with a correct netlist
and a ratsnest, which is the input to routing rather than its output.
"""
import csv, io, os, sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
KICAD_FP = os.path.join(os.environ['LOCALAPPDATA'],
                        r'Programs\KiCad\10.0\share\kicad\footprints')

# Pin NAME -> pad number(s). A name may map to several pads (module grounds).
# Sources: KiCad's own symbol libraries, read out with pinout.py; the XIAO row
# order is xiao-pinmap.csv. Anything not listed here is assumed to be a pad
# number already, which covers every passive.
PINMAP = {
    'U1': {'D': [1], 'GND': [2], 'VCC': [3], 'R': [4],
           'Vref': [5], 'CANL': [6], 'CANH': [7], 'Rs': [8]},
    'U2': {'GND': [1], 'VIN': [2], 'EN/UVLO': [3], 'RON': [4], 'FB': [5],
           'PGOOD': [6], 'BST': [7], 'SW': [8], 'EP': [9]},
    'U4': {'VIN': [1], 'GND': [2], 'EN': [3], 'NC': [4], 'VOUT': [5]},
    'U5': {'VIN': [1], 'GND': [2], 'EN': [3], 'NC': [4], 'VOUT': [5]},
    # diodes: KiCad's convention is pad 1 = cathode
    '_DIODE': {'K': [1], 'C': [1], 'A': [2]},
    # SOT-23 P-channel MOSFET, gate/source/drain on 1/2/3. Confirm against the
    # chosen part before Gerbers - orderings differ between manufacturers.
    'Q1': {'G': [1], 'S': [2], 'D': [3]},
    # USB-C receptacle. The footprint uses Type-C contact designations, and a
    # USB 2.0 device ties both halves of each differential pair so the cable
    # works either way up. A8/B8 are SBU1/SBU2 and stay unconnected.
    'J2': {'GND': ['A1', 'A12', 'B1', 'B12'],
           'VBUS': ['A4', 'A9', 'B4', 'B9'],
           'CC1': ['A5'], 'CC2': ['B5'],
           'D+': ['A6', 'B6'], 'D-': ['A7', 'B7'],
           'SHIELD': ['SH']},
}
DIODES = {'D1', 'D2', 'D3', 'D4', 'D5', 'LED1'}

XIAO_PADS = {'D0': [1], 'D1': [2], 'D2': [3], 'D3': [4], 'D4': [5], 'D5': [6],
             'D6': [7], 'D7': [8], 'D8': [9], 'D9': [10], 'D10': [11],
             '3V3': [12], 'GND': [13], '5V': [14]}
WROOM_PADS = {'GND': [1, 40, 41], '3V3': [2], 'EN': [3], 'IO0': [27],
              'IO2': [38], 'IO3': [15], 'IO21': [23],
              'USB_D-': [13], 'USB_D+': [14]}

OFFBOARD = {'J1', 'PCB', 'CASE'}
GROUPS = {'TP1-TP5': ['TP1', 'TP2', 'TP3', 'TP4', 'TP5'],
          'W1-W5': ['W1', 'W2', 'W3', 'W4', 'W5']}


def rows(name):
    src = [l for l in io.open(os.path.join(HERE, name), encoding='utf-8')
           if l.strip() and not l.startswith('#')]
    return list(csv.DictReader(src))


def mm(v):
    return pcbnew.FromMM(float(v))


def vec(x_mm, y_mm):
    """Board-local mm (+Y toward the rear) into KiCad nm (+Y downward)."""
    return pcbnew.VECTOR2I(mm(x_mm), mm(-float(y_mm)))


def pads_for(ref, pin, variant):
    if ref == 'U3':
        table = XIAO_PADS if variant == 'xiao' else WROOM_PADS
        if pin in table:
            return [str(p) for p in table[pin]]
    if ref in DIODES and pin in PINMAP['_DIODE']:
        return [str(p) for p in PINMAP['_DIODE'][pin]]
    if ref in PINMAP and pin in PINMAP[ref]:
        return [str(p) for p in PINMAP[ref][pin]]
    return [pin]                      # already a pad number


def outline(board):
    """40 x 40 mm with 2 mm corners, as four segments and four arcs."""
    a = b = 20.0
    r = 2.0
    d = r * 0.7071067811865476
    segs = [((-(a - r), b), (a - r, b)),
            ((a, b - r), (a, -(b - r))),
            ((a - r, -b), (-(a - r), -b)),
            ((-a, -(b - r)), (-a, b - r))]
    arcs = [((a - r, b), (a - d, b - r + d - r + r), (a, b - r)),
            ((a, -(b - r)), (a - r + d, -(b - r) - d), (a - r, -b)),
            ((-(a - r), -b), (-(a - r) - d, -(b - r) - d), (-a, -(b - r))),
            ((-a, b - r), (-(a - r) - d, b - r + d), (-(a - r), b))]
    # recompute arc midpoints properly from each corner centre
    corners = [((a - r), (b - r)), ((a - r), -(b - r)),
               (-(a - r), -(b - r)), (-(a - r), (b - r))]
    arcs = []
    for i, (cx, cy) in enumerate(corners):
        s = [(a - r, b), (a, -(b - r)), (-(a - r), -b), (-a, b - r)][i]
        e = [(a, b - r), (a - r, -b), (-a, -(b - r)), (-(a - r), b)][i]
        sx = 1 if cx > 0 else -1
        sy = 1 if cy > 0 else -1
        arcs.append((s, (cx + sx * d, cy + sy * d), e))

    for s, e in segs:
        sh = pcbnew.PCB_SHAPE(board)
        sh.SetShape(pcbnew.SHAPE_T_SEGMENT)
        sh.SetLayer(pcbnew.Edge_Cuts)
        sh.SetWidth(mm(0.1))
        sh.SetStart(vec(*s))
        sh.SetEnd(vec(*e))
        board.Add(sh)
    for s, m, e in arcs:
        sh = pcbnew.PCB_SHAPE(board)
        sh.SetShape(pcbnew.SHAPE_T_ARC)
        sh.SetLayer(pcbnew.Edge_Cuts)
        sh.SetWidth(mm(0.1))
        sh.SetArcGeometry(vec(*s), vec(*m), vec(*e))
        board.Add(sh)


def build(variant):
    keep = ('common', variant)
    bom = [r for r in rows('bom.csv') if r['variant'] in keep]
    plc = [r for r in rows('placement.csv') if r['variant'] in keep]
    net = [r for r in rows('netlist.csv') if r['variant'] in keep]

    fp_of = {}
    for r in bom:
        for ref in GROUPS.get(r['designator'], [r['designator']]):
            if r['footprint'].strip():
                fp_of[ref] = r['footprint'].strip()

    board = pcbnew.BOARD()
    board.SetCopperLayerCount(4)
    outline(board)

    placed = {}
    for r in plc:
        ref = r['designator']
        if ref in OFFBOARD or ref == 'KEEPOUT':
            continue
        spec = fp_of.get(ref)
        if not spec:
            print('  no footprint for', ref)
            continue
        lib, name = spec.split(':', 1)
        fp = pcbnew.FootprintLoad(os.path.join(KICAD_FP, lib + '.pretty'), name)
        if fp is None:
            print('  FAILED to load', spec, 'for', ref)
            continue
        # Many stock footprints ship their 3D model with (hide yes), so a render
        # comes out as bare pads with no parts on it. Un-hide them.
        for model in fp.Models():
            model.m_Show = True
        fp.SetPosition(vec(r['x_mm'], r['y_mm']))
        fp.SetOrientationDegrees(-float(r['rotation_deg']))
        fp.SetReference(ref)
        fp.SetValue(r['part'][:60])
        board.Add(fp)
        placed[ref] = fp
    print('  placed %d footprints' % len(placed))

    nets = {}
    connected = missed = 0
    for r in net:
        name = r['net']
        if name == 'NC_J1':
            continue
        if name not in nets:
            ni = pcbnew.NETINFO_ITEM(board, name)
            board.Add(ni)
            nets[name] = ni
        for member in (m.strip() for m in r['members'].split(';')):
            if not member or '.' not in member:
                continue
            ref, pin = member.split('.', 1)
            if ref in OFFBOARD:
                continue
            fp = placed.get(ref)
            if fp is None:
                print('  net %s: no such footprint %s' % (name, ref))
                missed += 1
                continue
            want = set(pads_for(ref, pin, variant))
            hit = False
            for pad in fp.Pads():
                if pad.GetNumber() in want:
                    pad.SetNet(nets[name])
                    connected += 1
                    hit = True
            if not hit:
                have = sorted(p.GetNumber() for p in fp.Pads())[:12]
                print('  net %s: %s has no pad %s (has %s)' % (name, ref, sorted(want), have))
                missed += 1
    print('  connected %d pads across %d nets, %d unresolved' % (connected, len(nets), missed))

    # Does anything hang off the board? The render makes this look obvious and
    # perspective makes it lie, so measure the courtyards against the 40 x 40
    # outline instead of squinting at a picture.
    # PADS only. A footprint's bounding box includes its silkscreen text and,
    # for the WROOM, the antenna keepout graphics that are SUPPOSED to extend
    # past the board - so a whole-footprint box reports overhang that is either
    # cosmetic or intended. Copper off the edge is the thing that is actually
    # unmanufacturable.
    over = []
    for ref, fp in sorted(placed.items()):
        for pad in fp.Pads():
            bb = pad.GetBoundingBox()
            for edge, val in (('left', pcbnew.ToMM(bb.GetLeft())),
                              ('right', pcbnew.ToMM(bb.GetRight())),
                              ('top', pcbnew.ToMM(bb.GetTop())),
                              ('bottom', pcbnew.ToMM(bb.GetBottom()))):
                if abs(val) > 20.0 + 0.01:
                    over.append((ref + '.' + pad.GetNumber(), edge,
                                 round(abs(val) - 20.0, 2)))
    if over:
        print('  %d footprint edge(s) past the outline:' % len(over))
        for ref, edge, by in over:
            print('    %-6s %-6s by %.2f mm' % (ref, edge, by))
    else:
        print('  nothing overhangs the board outline')

    out = os.path.join(HERE, 'obdurate-revA-%s.kicad_pcb' % variant)
    pcbnew.SaveBoard(out, board)
    print('  wrote', os.path.basename(out))
    return missed


if __name__ == '__main__':
    which = sys.argv[1:] or ['xiao']
    bad = 0
    for v in which:
        print(v + ':')
        bad += build(v)
    sys.exit(1 if bad else 0)
