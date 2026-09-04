// hardware/ describes two boards that do not exist yet, which is precisely when a
// design drifts away from the firmware that has to run on it. A handful of pins
// carry the whole risk: change PIN_CAN_TX in the sketch and both netlists are
// silently wrong, and nothing about a wrong netlist is observable until a fab has
// already made the boards.
//
// Same shape as the /data contract - a claim that lives in two places gets checked
// from one - and the same reason: the two ends have separate build steps, so a
// rename that once broke loudly would now break quietly.
//
// TWO VARIANTS, ONE CIRCUIT. Every file carries a `variant` column of common,
// xiao or wroom, and the effective design for a variant is the common rows plus
// that variant's. Both are checked independently, because a shared circuit with
// one checked half is a circuit with an unchecked half.
//
// The pin checks are deliberately RELATIONAL. Asserting "the netlist says IO2"
// and "the firmware says GPIO2" as two independent facts passes happily after
// someone changes both to different values. The firmware's number is read out and
// the netlist is checked against that - via xiao-pinmap.csv on the xiao variant,
// because there the pad is called D1 rather than IO2.

const VARIANTS = ['xiao', 'wroom'];

// Minimal CSV: quoted fields may contain commas, nothing else is special.
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function checkHardware({ ok, eq, readSrc, here, join }) {
  console.log('\nhardware');
  const hw = (f) => readSrc(join(here, '../../hardware/', f));
  const rows = (csv) => csv.split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .slice(1)
    .map(splitCsv);

  const ino = readSrc(join(here, '../Obdurate/Obdurate.ino'));
  const netAll = rows(hw('netlist.csv'));    // variant,net,netclass,members,notes
  const bomAll = rows(hw('bom.csv'));        // variant,designator,qty,mpn,mfr,pkg,footprint,status,usd,note
  const plcAll = rows(hw('placement.csv'));  // variant,designator,part,x,y,rot,side,why
  const pinmap = rows(hw('xiao-pinmap.csv'));// pad,name,gpio,status,source

  // --- the firmware's own numbers, read out of the sketch ---
  const fwNum = (re) => { const m = ino.match(re); return m ? m[1] : null; };
  const canTx = fwNum(/PIN_CAN_TX\s*=\s*GPIO_NUM_(\d+)/);
  const canRx = fwNum(/PIN_CAN_RX\s*=\s*GPIO_NUM_(\d+)/);
  const ledNo = fwNum(/#define\s+LED_BUILTIN\s+(\d+)/);
  const kbits = fwNum(/TWAI_TIMING_CONFIG_(\d+)KBITS/);

  ok(canTx !== null, 'firmware declares PIN_CAN_TX');
  ok(canRx !== null, 'firmware declares PIN_CAN_RX');
  ok(ledNo !== null, 'firmware declares the LED pin');
  ok(kbits !== null, 'firmware fixes a CAN bitrate');

  // Active low means the GPIO sinks, so wherever the LED lives its anode is the
  // pulled-up side. Flip this and the wroom board is wrong in a way no amount of
  // reflashing fixes - and the xiao board fights its own module.
  ok(/digitalWrite\(LED_PIN,\s*on\s*\?\s*LOW\s*:\s*HIGH\)/.test(ino),
     'firmware drives the LED active low');
  ok(hw('README.md').includes(`${kbits} kbit`),
     `hardware/README.md documents the ${kbits} kbit bus`);

  // --- the XIAO pad map, which the xiao variant's pin names depend on ---
  const padOf = new Map();     // GPIO number -> pad silkscreen name
  for (const r of pinmap) if (r[2]) padOf.set(r[2].replace(/^GPIO/, ''), r[1]);
  ok(padOf.get(canTx) !== undefined,
     `xiao-pinmap.csv maps the firmware's TX GPIO${canTx} to a pad`);
  ok(padOf.get(canRx) !== undefined,
     `xiao-pinmap.csv maps the firmware's RX GPIO${canRx} to a pad`);
  // The one that surprises people: GPIO21 is not on a XIAO pad at all.
  ok(padOf.get(ledNo) === undefined,
     `xiao-pinmap.csv does not expose GPIO${ledNo} - it is the module's own LED`);

  // Grouped BOM lines stand for several identical parts. They are placed
  // individually, so expand them before comparing designator sets.
  const GROUPS = {
    'TP1-TP5': ['TP1', 'TP2', 'TP3', 'TP4', 'TP5'],
    'W1-W5': ['W1', 'W2', 'W3', 'W4', 'W5'],
  };
  const NOT_PLACED = new Set(['PCB', 'CASE', ...Object.keys(GROUPS)]);
  const expand = (ref) => GROUPS[ref] || [ref];

  for (const V of VARIANTS) {
    const pick = (all) => all.filter(r => r[0] === 'common' || r[0] === V);
    const net = pick(netAll), bom = pick(bomAll), plc = pick(plcAll);

    // a net may be split across a common row and a variant row; union the members
    const members = (name) => net
      .filter(r => r[1] === name)
      .flatMap(r => r[3].split(';').map(s => s.trim()).filter(Boolean));

    const expectTx = V === 'xiao' ? `U3.${padOf.get(canTx)}` : `U3.IO${canTx}`;
    const expectRx = V === 'xiao' ? `U3.${padOf.get(canRx)}` : `U3.IO${canRx}`;
    ok(members('CTX').includes(expectTx),
       `${V}: CTX carries the pin the firmware transmits on (${expectTx})`);
    ok(members('CRX').includes(expectRx),
       `${V}: CRX carries the pin the firmware receives on (${expectRx})`);

    if (V === 'wroom') {
      ok(members('LED_K').includes(`U3.IO${ledNo}`),
         `wroom: LED_K carries the pin the firmware blinks (IO${ledNo})`);
      ok(members('LED_A').some(m => m.startsWith('R1.')),
         'wroom: R1 is on the LED anode net, as active low requires');
      ok(members('VOUT').some(m => m.startsWith('R1.')),
         'wroom: R1 pulls that anode up to the 3.3 V rail');
    } else {
      // The module's onboard LED already is GPIO21. A board LED here would be a
      // second thing on the same pin, fighting the first.
      const anyLed = net.some(r => /LED/.test(r[1]) || /LED1\./.test(r[3]));
      ok(!anyLed, 'xiao: no board LED net - GPIO21 is the module\'s own');
      ok(!bom.some(r => r[1] === 'LED1'), 'xiao: no board LED in the BOM either');
    }

    // --- the directory has to agree with itself, per variant ---
    const bomRefs = new Set(bom.flatMap(r => expand(r[1])));
    const plcRefs = new Set(plc.map(r => r[1]));

    const netRefs = [...new Set(net.flatMap(r =>
      r[3].split(';').map(s => s.trim().split('.')[0]).filter(Boolean)))];
    const stray = netRefs.filter(r => !bomRefs.has(r));
    ok(stray.length === 0,
       `${V}: every netlist designator is in the BOM${stray.length ? ` (stray: ${stray.join(', ')})` : ''}`);

    const unplaced = [...bomRefs].filter(r => !NOT_PLACED.has(r) && !plcRefs.has(r));
    ok(unplaced.length === 0,
       `${V}: every BOM part has a placement${unplaced.length ? ` (missing: ${unplaced.join(', ')})` : ''}`);

    const orphan = [...plcRefs].filter(r => r !== 'KEEPOUT' && !bomRefs.has(r));
    ok(orphan.length === 0,
       `${V}: every placement is in the BOM${orphan.length ? ` (orphan: ${orphan.join(', ')})` : ''}`);

    // Every part that gets placed needs a footprint to place. Checked as a
    // Lib:Name shape rather than against the installed libraries, so this passes
    // on a machine with no KiCad - CI included.
    const noFp = bom
      .filter(r => !['PCB', 'CASE', 'J1'].includes(r[1]))
      .filter(r => !/^[A-Za-z0-9_]+:[A-Za-z0-9_.\-+]+$/.test(r[6].trim()))
      .map(r => r[1]);
    ok(noFp.length === 0,
       `${V}: every placed part names a footprint${noFp.length ? ` (missing: ${noFp.join(', ')})` : ''}`);

    ok(bom.every(r => ['spec', 'class', 'estimate'].includes(r[7])),
       `${V}: every BOM row is tagged spec, class or estimate`);
    // The honesty convention, enforced rather than remembered.
    const thin = bom.filter(r => r[7] === 'spec' && (!r[3].trim() || !r[4].trim())).map(r => r[1]);
    ok(thin.length === 0,
       `${V}: every 'spec' line names a part and a maker${thin.length ? ` (thin: ${thin.join(', ')})` : ''}`);

    // --- everything inside the outline ---
    const half = outlineHalf(hw('outline.dxf'));
    if (V === VARIANTS[0]) {
      eq(half.x * 2, 40, 'outline.dxf is 40 mm wide');
      eq(half.y * 2, 40, 'outline.dxf is 40 mm tall');
    }
    const outside = plc
      .filter(r => r[6] !== 'offboard')
      .filter(r => Math.abs(parseFloat(r[3])) > half.x || Math.abs(parseFloat(r[4])) > half.y)
      .map(r => r[1]);
    ok(outside.length === 0,
       `${V}: every placement sits inside the outline${outside.length ? ` (outside: ${outside.join(', ')})` : ''}`);

    // The wroom variant has a PCB antenna and so a keepout; the xiao's antenna is
    // a flying U.FL part and needs none.
    const kz = plc.find(r => r[1] === 'KEEPOUT');
    if (V === 'wroom') {
      ok(!!kz, 'wroom: placement declares the antenna keepout');
      if (kz) {
        const kx = parseFloat(kz[3]), ky = parseFloat(kz[4]);
        const inZone = plc
          .filter(r => r[1] !== 'KEEPOUT' && r[6] !== 'offboard')
          .filter(r => Math.abs(parseFloat(r[3]) - kx) < 19.4 / 2 &&
                       Math.abs(parseFloat(r[4]) - ky) < 6.6 / 2)
          .map(r => r[1]);
        ok(inZone.length === 0,
           `wroom: nothing is placed in the antenna keepout${inZone.length ? ` (in zone: ${inZone.join(', ')})` : ''}`);
      }
    } else {
      ok(!kz, 'xiao: no keepout row - the U.FL antenna is not on the board');
    }
  }
}

// Board extents from the DXF, so the outline is read rather than restated.
function outlineHalf(dxf) {
  const lines = dxf.split('\n').map(s => s.trim());
  const xs = [], ys = [];
  let ent = null, cur = {};
  const flush = () => {
    if (ent === 'LINE') { xs.push(cur[10], cur[11]); ys.push(cur[20], cur[21]); }
    if (ent === 'ARC') {
      xs.push(cur[10] - cur[40], cur[10] + cur[40]);
      ys.push(cur[20] - cur[40], cur[20] + cur[40]);
    }
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i], val = lines[i + 1];
    if (code === '0') { flush(); ent = val; cur = {}; }
    else if (['10', '11', '20', '21', '40'].includes(code)) cur[+code] = parseFloat(val);
  }
  flush();
  return { x: Math.max(...xs.map(Math.abs)), y: Math.max(...ys.map(Math.abs)) };
}
