// The live dashboard, ported from firmware/NexonOBD/dashboard_html.h.
//
// Ordered for a glance from the driver's seat rather than by PID number: speed and
// engine speed first, then the two that tell you to stop (boost, coolant), then the
// engine block, then mixture. Everything diagnostic is folded away below.
//
// This layout was iterated on in a moving car. Tiles are two-up at phone width and
// reflow wider on a tablet, which is what makes the whole set readable without
// scrolling — so the order, the wording and the thresholds are all carried over as
// they are, and the arithmetic behind them lives in ../lib where it is tested.

import { useEffect, useRef, useState } from 'preact/hooks';

import { createHold } from '../lib/hold.js';
import { hz, pushSample } from '../lib/rate.js';
import { computeFlags } from '../lib/flags.js';
import { computeMileage } from '../lib/mileage.js';
import { DASH, n, round, signed, boostText, hhmmss } from '../lib/format.js';
import { boost as deriveBoost, torqueNm } from '../lib/derive.js';

import { Spark } from './live/Spark.jsx';
import { dialPaths, rpmFraction } from './live/dial.js';
import { rowCells } from './live/rows.js';
import { emptyHistory, seedHistory, pushHist, isFreshSlot } from './live/hist.js';
import { nextStatus, scanInfo, POLL_MS, DATA_URL, HISTORY_URL } from './live/status.js';

// Page-local layout, carried over from the <style> block in dashboard_html.h. It
// stays with the page rather than moving into the shared stylesheet because it is
// this page's geometry — the hero/dial split and the dial itself exist nowhere else.
const LIVE_CSS = `
.glance{display:grid;grid-template-columns:1fr 140px;gap:8px}
@media(max-width:338px){.glance{grid-template-columns:1fr}}
.hero .value{font-size:46px;letter-spacing:-.035em}
/* The hero tile grows with the viewport while the dial beside it stays fixed, so
   the numeral has to scale or it floats in a widening void. */
@media(min-width:600px){.hero .value{font-size:68px}}
.dial{position:relative;width:116px;height:116px;margin:1px auto 0}
.dial svg{display:block}
.dial .gv{position:absolute;inset:0;display:flex;flex-direction:column;
align-items:center;justify-content:center;font-size:23px;font-weight:650;
letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.dial .gv .unit{margin-top:1px;font-size:10px;font-weight:400;color:var(--ink2)}
.vital{grid-template-columns:repeat(auto-fit,minmax(158px,1fr));margin-top:8px}
.value.sm{font-size:19px}
.sep{color:var(--muted);margin:0 3px;font-weight:400}
`;

/** A held reading is dimmed wherever it appears. */
const dim = (held) => (held ? 'stale' : undefined);

/** `.value`, plus the warning colour when a flag says so. */
const vcls = (level) => 'value' + (level ? ' ' + level : '');

/**
 * A warning line. It always occupies its row (see .flag in the stylesheet) so a
 * warning appearing cannot reflow the page and shuffle every tile under the
 * driver's eye.
 */
function Flag({ f }) {
  return <div class={'flag' + (f.on ? ' on ' + f.level : '')}>{f.text}</div>;
}

const INITIAL = {
  v: {},
  q: {},
  held: 0,
  status: { cls: '', text: 'connecting…' },
  hzText: '',
  scan: { on: false, ecu: 'ECM', pct: 0, counts: '' },
  tr: DASH,
  // Bumped when /history lands, to redraw charts that are otherwise only redrawn
  // by an incoming sample.
  seeded: 0,
};

export function Live() {
  const [s, setSnap] = useState(INITIAL);
  // The four sparkline buffers are a ref, not state: they are mutated in place at
  // 8 Hz and copying 2 400 numbers per poll to satisfy immutability would be the
  // most expensive thing this page does. Every mutation is followed by a setSnap in
  // the same tick, so the redraw still happens exactly when a sample arrives.
  const hist = useRef(emptyHistory());

  useEffect(() => {
    // One trailing window of sample timestamps, shared by reference: the Hz readout
    // and the hold window are both scaled from it (see hold.js).
    const rate = [];
    const hold = createHold({ rate });

    let mounted = true;
    // Stop polling while the page is not on screen. The board keeps sampling either
    // way, and a backgrounded tab hammering /data just costs battery and bus time.
    let alive = !document.hidden;
    let timer = 0, miss = 0, lastSeq = -1, hb = 0;

    const apply = (st, patch) => {
      if (st.clearRate) rate.length = 0;
      if (st.status) patch.status = st.status;
      if (st.clearHz) patch.hzText = '';
      setSnap((prev) => ({ ...prev, ...patch }));
    };

    async function tick() {
      try {
        const r = await fetch(DATA_URL, { cache: 'no-store' });
        const j = await r.json();
        if (!mounted) return;

        const patch = { scan: scanInfo(j) };
        // Only overwritten when the board names a transport, so a reply that omits
        // it leaves the last one standing rather than blanking the header.
        if (j.tr) patch.tr = j.tr;

        if (j.ok) {
          const [v, q, held] = hold.merge(j.v || {});
          // Boost is derived, and is only as fresh as the staler of MAP and
          // barometric. Written back into the sample so the all-values table and the
          // sparkline both read the same number as the tile.
          const b = deriveBoost(v, q);
          v.boost = b.bar;
          q.boost = b.stale ? 1 : 0;

          // Only fresh readings enter the history — replaying a held value would
          // draw a flat run in the sparkline that the car never actually did.
          const now = Date.now();
          const fresh = isFreshSlot(now, hb);
          if (fresh) hb = now;
          const h = hist.current;
          pushHist(h.rpm, q.rpm ? null : v.rpm, fresh);
          pushHist(h.boost, b.stale ? null : b.bar, fresh);
          pushHist(h.speed, q.speed ? null : v.speed, fresh);
          pushHist(h.coolant, q.coolant ? null : v.coolant, fresh);

          // Count published samples, not fetches: /data serves a cached sample, so
          // the same one can be fetched several times and must not inflate the rate.
          if (j.seq !== lastSeq) {
            lastSeq = j.seq;
            pushSample(rate, now);
          }

          patch.v = v;
          patch.q = q;
          patch.held = held;
          patch.hzText = hz(rate);
          const st = nextStatus(miss, { ok: true, scan: j.scan, held });
          miss = st.miss;
          apply(st, patch);
        } else {
          const st = nextStatus(miss, { scan: j.scan, error: j.error });
          miss = st.miss;
          apply(st, patch);
        }
      } catch (e) {
        // The board did not answer at all, or answered with something that is not
        // JSON. Either way it is one miss; MISS_MAX of them is a verdict.
        if (!mounted) return;
        const st = nextStatus(miss, { failed: true });
        miss = st.miss;
        apply(st, {});
      } finally {
        if (mounted && alive) timer = setTimeout(tick, POLL_MS);
      }
    }

    // Seed the charts from the board's stored hour before the first poll lands, so
    // they have shape immediately instead of drawing themselves over the next hour.
    async function seed() {
      try {
        const res = await fetch(HISTORY_URL, { cache: 'no-store' });
        const h = await res.json();
        if (!mounted) return;
        hist.current = seedHistory(h);
        hb = Date.now();
        setSnap((prev) => ({ ...prev, seeded: prev.seeded + 1 }));
      } catch (e) {
        // No seed is a cosmetic loss. The poll below still has to run.
      }
    }

    const onVis = () => {
      if (document.hidden) {
        alive = false;
        clearTimeout(timer);
      } else if (!alive) {
        alive = true;
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    // The board has no clock of its own. Whichever page you open hands over the
    // time, so anything it records carries a real timestamp.
    fetch('/time?ms=' + Date.now(), { cache: 'no-store' }).catch(() => {});

    seed().then(tick);

    return () => {
      mounted = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const { v, q } = s;
  const flags = computeFlags(v, q);
  const mil = computeMileage(v, q);
  const dial = dialPaths(rpmFraction(v.rpm));
  const rows = rowCells(v, q);
  const h = hist.current;

  return (
    <>
      <style>{LIVE_CSS}</style>

      {/* The firmware page puts the dot, the status text, the Hz readout and the
          transport in the sticky header. The shell owns that header here, so they
          ride at the top of the page instead — same classes, same wording. */}
      <div class="bar" style="margin:0 0 10px">
        <span class="sub">{s.tr}</span>
        <div class="status">
          <span class={'dot ' + s.status.cls} />
          <span>{s.status.text}</span>
          <span style="color:var(--muted)">{s.hzText}</span>
        </div>
      </div>

      {s.scan.on && (
        <div class="card" style="border-color:var(--blue)">
          <div class="label" style="margin:0 0 3px">DID scan running — <span>{s.scan.ecu}</span></div>
          <div style="font-size:13px;color:var(--ink2)">
            The scanner has most of the bus, so live values update slowly. It keeps
            going if you leave this page.
          </div>
          <div class="bar2"><i style={`width:${s.scan.pct}%`} /></div>
          <div class="note" style="margin-top:7px">{s.scan.counts}</div>
          <div style="margin-top:8px">
            <a href="#/scan" style="color:var(--blue);font-size:13px">Open the scanner →</a>
          </div>
        </div>
      )}

      <div class="glance">
        <div class="tile hero">
          <div class="label">Vehicle speed</div>
          <div class="value">
            <span class={dim(q.speed)}>{round(v.speed)}</span>
            <span class="unit">km/h</span>
          </div>
          <Spark data={h.speed} color="var(--aqua)" zero label="Vehicle speed, recent history" />
        </div>

        <div class="tile">
          <div class="label">Engine speed</div>
          <div class="dial">
            <svg width="116" height="116" viewBox="0 0 128 128" aria-hidden="true">
              <path d={dial.track} fill="none" stroke="var(--base)" stroke-width="9" stroke-linecap="round" />
              <path d={dial.value} fill="none" stroke="var(--blue)" stroke-width="9" stroke-linecap="round" />
            </svg>
            <div class="gv">
              <span class={dim(q.rpm)}>{round(v.rpm)}</span>
              <span class="unit">rpm</span>
            </div>
          </div>
          <Flag f={flags.rpm} />
          <Spark data={h.rpm} color="var(--blue)" zero label="Engine speed, recent history" />
        </div>
      </div>

      <div class="tiles vital">
        <div class="tile">
          <div class="label">Boost</div>
          <div class="value">
            <span class={dim(q.boost)}>{boostText(v.boost)}</span>
            <span class="unit">bar</span>
          </div>
          <div class="note">MAP <span class={dim(q.map)}>{round(v.map)}</span> kPa</div>
          <Spark data={h.boost} color="var(--orange)" label="Boost, recent history" />
        </div>

        <div class="tile">
          <div class="label">Coolant</div>
          <div class={vcls(flags.coolant.valueLevel)}>
            <span class={dim(q.coolant)}>{round(v.coolant)}</span>
            <span class="unit">°C</span>
          </div>
          <Flag f={flags.coolant} />
          <Spark data={h.coolant} color="var(--yellow)" label="Coolant temperature, recent history" />
        </div>
      </div>

      <div class="tiles vital">
        <div class="tile">
          <div class="label">Mileage</div>
          <div class="value">
            <span>{mil.avgText}</span>
            <span class="unit">km/L</span>
          </div>
          <div class="note">{mil.tripNote}</div>
        </div>

        <div class="tile">
          <div class="label">Right now</div>
          <div class="value">
            <span class={dim(mil.instStale)}>{mil.instText}</span>
            <span class="unit">km/L</span>
          </div>
          <div class="note">{mil.rateNote}</div>
        </div>
      </div>

      <h2 class="sec">Engine</h2>
      <div class="tiles">
        <div class="tile">
          <div class="label">Oil temp</div>
          <div class={vcls(flags.oil.valueLevel)}>
            <span class={dim(q.oil)}>{round(v.oil)}</span>
            <span class="unit">°C</span>
          </div>
          <Flag f={flags.oil} />
        </div>

        <div class="tile">
          <div class="label">Intake air</div>
          <div class="value">
            <span class={dim(q.iat)}>{round(v.iat)}</span>
            <span class="unit">°C</span>
          </div>
        </div>

        <div class="tile">
          <div class="label">Engine load</div>
          <div class="value">
            <span class={dim(q.load)}>{n(v.load)}</span>
            <span class="unit">%</span>
          </div>
        </div>

        <div class="tile">
          <div class="label">Throttle</div>
          <div class="value">
            <span class={dim(q.throttle)}>{n(v.throttle)}</span>
            <span class="unit">%</span>
          </div>
        </div>

        <div class="tile">
          <div class="label">Timing</div>
          <div class="value">
            <span class={dim(q.timing)}>{n(v.timing)}</span>
            <span class="unit">°</span>
          </div>
        </div>

        <div class="tile">
          <div class="label">Voltage</div>
          <div class={vcls(flags.volt.valueLevel)}>
            <span class={dim(q.volt)}>{n(v.volt, 2)}</span>
            <span class="unit">V</span>
          </div>
          <Flag f={flags.volt} />
        </div>
      </div>

      <h2 class="sec">Driver demand</h2>
      <div class="tiles">
        <div class="tile">
          <div class="label">Accelerator pedal</div>
          <div class="value">
            <span class={dim(q.pedalD)}>{n(v.pedalD)}</span>
            <span class="unit">%</span>
          </div>
          <div class="note">2nd track <span class={dim(q.pedalE)}>{n(v.pedalE)}</span> %</div>
        </div>

        <div class="tile">
          <div class="label">Commanded throttle</div>
          <div class="value">
            <span class={dim(q.cmdThrottle)}>{n(v.cmdThrottle)}</span>
            <span class="unit">%</span>
          </div>
          <div class="note">actual <span class={dim(q.throttle)}>{n(v.throttle)}</span> %</div>
        </div>

        <div class="tile">
          <div class="label">Torque demanded</div>
          <div class="value">
            <span class={dim(q.torqDem)}>{n(v.torqDem)}</span>
            <span class="unit">%</span>
          </div>
          <div class="note">{torqueNm(v.torqDem, v.torqRef, q.torqDem)}</div>
        </div>

        <div class="tile">
          <div class="label">Torque delivered</div>
          <div class="value">
            <span class={dim(q.torqAct)}>{n(v.torqAct)}</span>
            <span class="unit">%</span>
          </div>
          <div class="note">{torqueNm(v.torqAct, v.torqRef, q.torqAct)}</div>
        </div>

        <div class="tile">
          <div class="label">Absolute load</div>
          <div class="value">
            <span class={dim(q.absLoad)}>{n(v.absLoad)}</span>
            <span class="unit">%</span>
          </div>
        </div>

        <div class="tile">
          <div class="label">Reference torque</div>
          <div class="value sm">
            <span class={dim(q.torqRef)}>{round(v.torqRef)}</span>
            <span class="unit">N·m</span>
          </div>
          <div class="note">engine constant</div>
        </div>
      </div>

      <h2 class="sec">Mixture &amp; exhaust</h2>
      <div class="tiles">
        <div class="tile">
          <div class="label">Lambda</div>
          <div class={vcls(flags.lambda.valueLevel)}>
            <span class={dim(q.lambda)}>{n(v.lambda, 3)}</span>
          </div>
          <Flag f={flags.lambda} />
        </div>

        <div class="tile">
          <div class="label">Fuel trim S / L</div>
          <div class="value sm">
            <span class={dim(q.stft)}>{signed(v.stft)}</span>
            <span class="unit">%</span>
            <span class="sep">/</span>
            <span class={dim(q.ltft)}>{signed(v.ltft)}</span>
            <span class="unit">%</span>
          </div>
          <Flag f={flags.trim} />
        </div>

        <div class="tile">
          <div class="label">Fuel rate</div>
          <div class="value">
            <span class={dim(q.fuelRate)}>{n(v.fuelRate, 2)}</span>
            <span class="unit">L/h</span>
          </div>
        </div>

        <div class="tile">
          <div class="label">Catalyst B1S1</div>
          <div class={vcls(flags.cat.valueLevel)}>
            <span class={dim(q.cat)}>{n(v.cat)}</span>
            <span class="unit">°C</span>
          </div>
          <Flag f={flags.cat} />
        </div>
      </div>

      <details>
        <summary>Secondary readings</summary>
        <div class="tiles">
          <div class="tile">
            <div class="label">Ambient</div>
            <div class="value">
              <span class={dim(q.ambient)}>{round(v.ambient)}</span>
              <span class="unit">°C</span>
            </div>
            <div class="note">echoes the intake sensor</div>
          </div>

          <div class="tile">
            <div class="label">Barometric</div>
            <div class="value">
              <span class={dim(q.baro)}>{round(v.baro)}</span>
              <span class="unit">kPa</span>
            </div>
          </div>

          <div class="tile">
            <div class="label">Fuel level</div>
            <div class="value">
              <span class={dim(q.fuel)}>{n(v.fuel)}</span>
              <span class="unit">%</span>
            </div>
            <div class="note">not wired through on this car</div>
          </div>

          <div class="tile">
            <div class="label">Run time</div>
            <div class="value sm">
              <span class={dim(q.runtime)}>{hhmmss(v.runtime)}</span>
            </div>
          </div>
        </div>
      </details>

      <details>
        <summary>All values</summary>
        <div class="tw">
          <table>
            <caption>Every polled parameter, current sample</caption>
            <thead>
              <tr>
                <th>PID</th>
                <th>Parameter</th>
                <th style="text-align:right">Value</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.pid}</td>
                  <td>{r.name}</td>
                  <td class={r.cls}>{r.text}</td>
                  <td>{r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

export default Live;
