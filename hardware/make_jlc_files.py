"""Emit JLCPCB / PCBWay style BOM and CPL files for one variant.

  python3 make_jlc_files.py xiao 2   ->  writes into gerbers/<variant>-jlc/

Those houses want two files in their own shape, different from the one an Indian
assembler asked for:

  BOM  Comment, Designator, Footprint, LCSC Part #
       Identical parts grouped onto one line - "C1,C2" - because they charge per
       unique part as well as per placement.
  CPL  Designator, Mid X, Mid Y, Layer, Rotation
       Origin at the board's LOWER-LEFT corner with Y increasing upward, which is
       not what KiCad uses internally. placement.csv is already board-local with
       +Y toward the rear, so the conversion is a +20 shift on both axes for a
       40 x 40 board centred on its own origin.

DNP parts are omitted from both files. These houses place what is listed, so an
unpopulated footprint is expressed by absence rather than by a flag - which is
exactly the opposite of what LionCircuits wanted, and the reason this is a
separate script rather than another column.
"""
import csv, io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
HALF = 20.0                      # board is 40 x 40 centred on its own origin


def rows(name):
    src = [l for l in io.open(os.path.join(HERE, name), encoding='utf-8')
           if l.strip() and not l.startswith('#')]
    return list(csv.DictReader(src))


def main(variant, layers):
    keep = ('common', variant)
    bom = [r for r in rows('bom.csv') if r['variant'] in keep]
    plc = [r for r in rows('placement.csv') if r['variant'] in keep]

    fitted = {}
    for r in bom:
        if r['asm'].strip() != 'y':
            continue
        if r['dnp'].strip() == 'y':
            continue
        fitted[r['designator']] = r

    out = os.path.join(HERE, 'gerbers', '%s-%dL-jlc' % (variant, layers))
    os.makedirs(out, exist_ok=True)

    # --- CPL, one line per placed part ---
    placed = []
    with io.open(os.path.join(out, 'cpl.csv'), 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'])
        for r in plc:
            ref = r['designator']
            if ref not in fitted:
                continue
            x = float(r['x_mm']) + HALF
            y = float(r['y_mm']) + HALF
            w.writerow([ref, '%.4f' % x, '%.4f' % y,
                        'top' if r['side'] == 'top' else 'bottom',
                        '%.0f' % float(r['rotation_deg'])])
            placed.append(ref)

    # --- BOM, identical parts grouped ---
    groups = {}
    for ref in placed:
        r = fitted[ref]
        key = (r['mpn'].strip(), r['value_or_mpn'].strip(), r['package'].strip())
        groups.setdefault(key, []).append(ref)

    def sortkey(ref):
        head = ref.rstrip('0123456789')
        tail = ref[len(head):]
        return (head, int(tail) if tail else 0)

    with io.open(os.path.join(out, 'bom.csv'), 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(['Comment', 'Designator', 'Footprint', 'LCSC Part #'])
        for (mpn, value, package), refs in sorted(
                groups.items(), key=lambda kv: sortkey(sorted(kv[1], key=sortkey)[0])):
            w.writerow([value or mpn, ','.join(sorted(refs, key=sortkey)),
                        package, ''])

    sys.stderr.write('%s %dL: %d placements, %d unique parts -> %s\n'
                     % (variant, layers, len(placed), len(groups),
                        os.path.relpath(out, HERE)))
    sys.stderr.write('  LCSC Part # is left blank on purpose - fill it from their\n'
                     '  parts search, or upload as-is and let their matcher try.\n')
    dnp = [r['designator'] for r in bom if r['dnp'].strip() == 'y']
    if dnp:
        sys.stderr.write('  omitted as DNP: %s\n' % ', '.join(dnp))
    return 0


if __name__ == '__main__':
    v = sys.argv[1] if len(sys.argv) > 1 else 'xiao'
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    sys.exit(main(v, n))
