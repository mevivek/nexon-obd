"""Emit a turnkey-assembler BOM for one variant from bom.csv.

  python3 make_assembly_bom.py xiao > gerbers/xiao-quote/assembly-bom.csv

bom.csv is a design document: it carries variants, prices, footprints, reasoning,
and rows for things that are not components at all. An automated BOM matcher
chokes on all of that - it cannot price "2.2 uF 100 V X7R" and it will go hunting
for a part called "test pad". This emits only what an assembler needs, in the
column order those tools expect.

Rows with asm=n are dropped: bare copper, the PCB, the case, the off-board
connector. Rows with dnp=y are kept and flagged, because an assembler needs to
know a footprint is deliberately empty rather than forgotten.
"""
import csv, io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Column set and order that turnkey BOM importers ask for. Item and Description
# are here because LionCircuits marks both REQUIRED and neither can be mapped
# from a design BOM that does not carry them - a file without them stalls at the
# field-mapping step with nothing to point the dropdown at.
COLS = ['Item', 'Designator', 'Quantity', 'Description', 'Value', 'MPN',
        'Manufacturer', 'Footprint', 'DNP', 'Note']
GROUPS = {'TP1-TP5': 5, 'W1-W5': 5}

# Longest prefix wins, so LED1 is an LED and not an inductor, and CH1 is a choke
# and not a capacitor.
TYPES = [('LED', 'LED'), ('CH', 'Choke'), ('TP', 'Test pad'),
         ('U', 'IC'), ('R', 'Resistor'), ('C', 'Capacitor'),
         ('L', 'Inductor'), ('D', 'Diode'), ('Q', 'Transistor'),
         ('F', 'Fuse'), ('J', 'Connector'), ('W', 'Pad')]


def describe(ref, value, package):
    """A human-readable Description. The MPN does the sourcing; this is for the
    person reading the pick list."""
    kind = next((name for pre, name in TYPES if ref.startswith(pre)), 'Part')
    if ref == 'U3':
        kind = 'Module'
    bits = [kind, value.strip()]
    if package.strip():
        bits.append(package.strip())
    return ', '.join(b for b in bits if b)


def main(variant):
    src = [l for l in io.open(os.path.join(HERE, 'bom.csv'), encoding='utf-8')
           if l.strip() and not l.startswith('#')]
    rows = [r for r in csv.DictReader(src)
            if r['variant'] in ('common', variant)]

    out = csv.writer(sys.stdout, lineterminator='\n')
    out.writerow(COLS)
    kept = dropped = flagged = 0
    missing = []
    for r in rows:
        if r['asm'].strip() != 'y':
            dropped += 1
            continue
        mpn = r['mpn'].strip()
        if not mpn:
            missing.append(r['designator'])
        dnp = 'DNP' if r['dnp'].strip() == 'y' else ''
        if dnp:
            flagged += 1
        note = r['note'].strip()
        # keep the warnings an assembler must not miss, drop the design prose
        keep = [k for k in ('NO SUBSTITUTION', 'DO NOT POPULATE', 'value_tbd',
                            'REQUIRED', 'consign') if k in note]
        kept += 1
        out.writerow([kept, r['designator'], r['qty'],
                      describe(r['designator'], r['value_or_mpn'], r['package']),
                      r['value_or_mpn'], mpn, r['manufacturer'],
                      r['package'], dnp, '; '.join(keep)])

    sys.stderr.write('%s: %d component lines, %d non-component rows dropped, '
                     '%d marked DNP\n' % (variant, kept, dropped, flagged))
    if missing:
        sys.stderr.write('  NO MPN, cannot be auto-quoted: %s\n'
                         % ', '.join(missing))
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'xiao'))
