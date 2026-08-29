#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// Over-the-air firmware upload at http://192.168.4.1/update
// Browser-based on purpose: no tooling needed, so a phone can flash the board
// while it is wedged under the dashboard.
static const char OTA_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Firmware Update</title>
<link rel="stylesheet" href="/ui.css?v=)rawliteral" FW_VERSION R"rawliteral(">
<style>
#go{width:100%;margin-top:10px}
</style></head><body>

<header>
<div class="bar"><div class="id"><h1>Firmware Update</h1>
<span class="sub">running v)rawliteral" FW_VERSION R"rawliteral(</span></div></div>
</header>

<div class="wrap">

<div class="card">
<div class="drop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/></svg>
<div><b>Upload a compiled .bin</b>The board reboots automatically once the write verifies.</div></div>
<input type="file" id="f" accept=".bin">
<button id="go" disabled>Upload &amp; flash</button>
<div class="bar2"><i id="p"></i></div>
<div class="msg" id="m"></div>
</div>

<div class="card">
<div class="hint" style="margin-top:0">
Build it with:<br>
<code>firmware/build.sh</code><br>
then upload <code>firmware/build/Obdurate-v&lt;version&gt;.bin</code>.<br><br>
That is the app image. <code>Obdurate.ino.merged.bin</code> sitting next to it is a
full-flash image for USB recovery and will not work here.<br><br>
The version above updates when the new image boots, so it doubles as confirmation
that the flash took.
</div>
<div class="caution"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
<div>Stay on this page and on the NexonOBD network until it finishes. A failed write
leaves the previous firmware intact &mdash; the ESP32 only switches over after the new
image verifies &mdash; but an interrupted upload means starting again.</div></div>
</div>

</div>

<nav>
<a href="/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 17a9 9 0 1 1 15.6 0"/><path d="M12 13.5 16 9"/></svg><span>Live</span></a>
<a href="/monitors"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3,13 7,13 9.5,6.5 14,18 16.5,13 21,13"/></svg><span>Monitors</span></a>
<a href="/trips"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.4 18h5.1a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h.5"/></svg><span>Trips</span></a>
<a href="/watch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4"/></svg><span>Watch</span></a>
<a href="/scan"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.2 16.2 21 21"/></svg><span>Scanner</span></a>
<a class="on" href="/update"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.2"/><path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/></svg><span>Firmware</span></a>
</nav>

<script>
// The board has no clock of its own. Whichever page you open hands over the
// time, so anything it records carries a real timestamp.
fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
const f=document.getElementById('f'),go=document.getElementById('go'),
      p=document.getElementById('p'),m=document.getElementById('m');
f.onchange=()=>{go.disabled=!f.files.length;m.textContent='';m.className='msg';p.style.width='0'};
go.onclick=()=>{
  const file=f.files[0];
  if(!file)return;
  go.disabled=true;m.className='msg warn';m.textContent='Uploading '+(file.size/1024|0)+' KB...';
  const fd=new FormData();fd.append('firmware',file,file.name);
  const x=new XMLHttpRequest();
  x.open('POST','/update');
  x.upload.onprogress=e=>{if(e.lengthComputable)p.style.width=(100*e.loaded/e.total).toFixed(0)+'%'};
  x.onload=()=>{
    let ok=false;
    try{ok=JSON.parse(x.responseText).ok}catch(e){}
    if(ok){m.className='msg ok';m.textContent='Flashed. Rebooting - reconnect to Obdurate in a few seconds.';p.style.width='100%'}
    else{m.className='msg err';m.textContent='Update failed: '+x.responseText;go.disabled=false}
  };
  x.onerror=()=>{m.className='msg err';m.textContent='Connection lost during upload.';go.disabled=false};
  x.send(fd);
};
</script></body></html>)rawliteral";
