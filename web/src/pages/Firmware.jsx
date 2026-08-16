// Over-the-air firmware upload. Ported from firmware/NexonOBD/ota_html.h.
//
// Browser-based on purpose: no tooling needed, so a phone can flash the board while
// it is wedged under the dashboard.
//
// XMLHttpRequest rather than fetch, and not for nostalgia: fetch cannot report
// *upload* progress, and this is the one page where the progress bar is the whole
// point — the warning below says not to close the page or leave the Wi-Fi network
// while it uploads, which is only actionable if you can see how far along it is.

import { useState, useRef, useEffect } from 'preact/hooks';
import { useClockSync } from './useClockSync.js';
import { OTA_MSG, otaFailText, otaOk, progressPct, uploadingText } from './firmware/ota.js';

// .drop
const DROP = 'border:1px dashed var(--base);border-radius:10px;padding:14px;'
  + 'text-align:center;color:var(--ink2);font-size:14px';
const DROP_B = 'display:block;color:var(--ink);font-weight:650;margin-bottom:3px';
// #go
const GO = 'width:100%;margin-top:4px';

export function Firmware() {
  useClockSync();

  const [file, setFile] = useState(null);
  // 'idle' | 'uploading' | 'done'. The firmware page had one flag (go.disabled) and
  // three meanings for it; the third — flashed, board rebooting, do not offer the
  // button again — is the one that has to survive picking another file.
  const [phase, setPhase] = useState('idle');
  const [pct, setPct] = useState('0');
  const [msg, setMsg] = useState({ cls: '', text: '' });

  // ota_html.h put the running FW_VERSION in its own header, and the hint below
  // leans on it: "the version above updates when the new image boots, so it doubles
  // as confirmation that the flash took". The shell's header carries the *web*
  // bundle's version, which is a different number on a different release cadence —
  // so the firmware's is read once from /data and shown here, or that sentence would
  // point at something that never changes when you flash.
  const [fw, setFw] = useState(null);
  useEffect(() => {
    let live = true;
    fetch('/data', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (live && j && j.fw) setFw(j.fw); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // An upload in flight is writing to the board's inactive OTA partition. Navigating
  // away must not abort it — an interrupted write means starting again — so the XHR
  // is deliberately not cancelled on unmount. This flag only stops the callbacks
  // from setting state on a page that is no longer mounted.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  function pick(e) {
    const f = e.currentTarget.files;
    setFile(f && f.length ? f[0] : null);
    setMsg({ cls: '', text: '' });
    setPct('0');
    // Firmware: f.onchange re-enabled the button. Not mid-upload, though — that page
    // got away with it only because there was nothing left to click, whereas here a
    // second POST would be a second Update.begin() on a partition already being
    // written.
    if (phase !== 'uploading') setPhase('idle');
  }

  function upload() {
    if (!file) return;
    setPhase('uploading');
    setMsg({ cls: 'warn', text: uploadingText(file.size) });

    const fd = new FormData();
    fd.append('firmware', file, file.name);

    const x = new XMLHttpRequest();
    x.open('POST', '/update');
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && mounted.current) setPct(progressPct(e.loaded, e.total));
    };
    x.onload = () => {
      if (!mounted.current) return;
      if (otaOk(x.responseText)) {
        setMsg({ cls: 'ok', text: OTA_MSG.ok });
        setPct('100%');
        // Stays disabled: the board is rebooting, and a second POST at this point
        // goes nowhere.
        setPhase('done');
      } else {
        setMsg({ cls: 'err', text: otaFailText(x.responseText) });
        setPhase('idle');
      }
    };
    x.onerror = () => {
      if (!mounted.current) return;
      setMsg({ cls: 'err', text: OTA_MSG.lost });
      setPhase('idle');
    };
    x.send(fd);
  }

  return (
    <>
      <h2 class="sec">Firmware Update{fw ? ' · running v' + fw : ''}</h2>

      <div class="card">
        <div style={DROP}>
          <b style={DROP_B}>Upload a compiled .bin</b>
          The board reboots automatically once the write verifies.
        </div>
        <input type="file" accept=".bin" onChange={pick} />
        <button style={GO} disabled={!file || phase !== 'idle'} onClick={upload}>
          Upload &amp; flash
        </button>
        <div class="bar2"><i style={'width:' + pct} /></div>
        <div class={'msg ' + msg.cls}>{msg.text}</div>
      </div>

      <div class="card">
        <div class="hint" style="margin-top:0">
          Build it with:<br />
          <code>firmware/build.sh</code><br />
          then upload <code>firmware/build/NexonOBD-v&lt;version&gt;.bin</code>.<br /><br />
          That is the app image. <code>NexonOBD.ino.merged.bin</code> sitting next to
          it is a full-flash image for USB recovery and will not work here.<br /><br />
          The version above updates when the new image boots, so it doubles as
          confirmation that the flash took.<br /><br />
          <b style="color:var(--ink2)">Do not close this page or leave the Wi-Fi network while it uploads.</b>{' '}
          A failed write leaves the previous firmware intact &mdash; the ESP32 only
          switches over after the new image verifies &mdash; but an interrupted upload
          means starting again.
        </div>
      </div>
    </>
  );
}
