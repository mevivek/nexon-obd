// Mode 06 on-board monitor results. Ported from firmware/Obdurate/mon_html.h.
//
// Mode 06 is a read, like everything else here. The ECU reports what each of its
// own monitors measured and the limits it judges that against, so this page can say
// how close a system is to failing rather than only whether a fault has already
// been stored.
//
// mon_html.h's page-local .mon/.badge/.win/.lim rules now live in the page section
// of styles.css, so this page uses those class names directly. Only the two
// declarations the firmware itself writes inline — the window's extent and the
// marker's position — are still style attributes here.

import { useState, useEffect } from 'preact/hooks';
import { useClockSync } from './useClockSync.js';
import { useShellStatus } from '../shell.jsx';
import { MON_POLL_MS, monFmt, monName, monNote, monStatus, monWindow } from './monitors/monitors.js';

function MonitorTile({ r }) {
  const { pass, pos } = monWindow(r);
  return (
    <div class="tile">
      <div class="label">
        {monName(r.mid)} <span style="color:var(--base)">&middot;</span> test {r.tid}
        <span class={'badge ' + (pass ? 'ok' : 'bad')}>{pass ? 'pass' : 'fail'}</span>
      </div>
      <div class="value">{monFmt(r.v, r.uas)}</div>
      <div class="win">
        <u style="left:0;width:100%" />
        <i style={'left:calc(' + pos.toFixed(1) + '% - 1px)'} />
      </div>
      <div class="lim">
        <span>min {monFmt(r.lo, r.uas)}</span>
        <span>max {monFmt(r.hi, r.uas)}</span>
      </div>
      <div class="note">
        {monNote(r)} <span style="color:var(--base)">&middot;</span> uas {r.uas}
      </div>
    </div>
  );
}

export function Monitors() {
  useClockSync();

  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);

  // Results only refresh while this page is open — which is also what arms the
  // board: a request to /mon buys MON_WANTED_MS of discovery and reading (see
  // monStep() in Obdurate.ino). So the interval is the page's half of that
  // handshake, and stopping it on unmount is what lets the bus go back to the
  // values that move now.
  useEffect(() => {
    let live = true;
    async function poll() {
      try {
        const j = await (await fetch('/mon', { cache: 'no-store' })).json();
        if (!live) return;
        setData(j);
        setErr(false);
      } catch (e) {
        // The last results stay on screen; only the header changes. A dropped poll
        // does not mean the numbers it already showed became untrue.
        if (live) setErr(true);
      }
    }
    poll();
    const t = setInterval(poll, MON_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  const recs = (data && data.recs) || [];
  useShellStatus(monStatus(data, err));

  return (
    <>
      <div class="card">
        <div class="hint" style="margin-top:0">
          The ECU's own test results, each with the limits it is judged against
          &mdash; so a pass with almost no headroom is visible long before it becomes
          a fault code.
        </div>
      </div>

      <details>
        <summary>How to read this</summary>
        <div class="hint">
          <b style="color:var(--ink2)">Pass and headroom do not depend on knowing the units.</b>{' '}
          A test passes when its value sits inside its own limits, and the bar shows
          where in that window it sits. The raw numbers and the unit-and-scaling id
          are shown as reported; that table is long and only partly documented, so
          nothing here pretends to convert values it cannot.<br /><br />
          Monitor names come from J1979 and only the unambiguous ids are named
          &mdash; anything else keeps its raw id rather than being given a label that
          might be wrong.<br /><br />
          Results only refresh while this page is open. Monitors move over minutes,
          and polling them continuously would take bus time from the values that move
          now.
        </div>
      </details>

      <div class="mon">
        {recs.map((r) => <MonitorTile key={r.mid + r.tid} r={r} />)}
      </div>

      {!recs.length && (
        <div class="card" style="margin-top:10px">
          <div style="color:var(--muted);font-size:14px">
            Nothing reported yet. The board discovers which monitors exist, then reads
            them one at a time &mdash; give it a few seconds with the ignition on.
          </div>
        </div>
      )}
    </>
  );
}
