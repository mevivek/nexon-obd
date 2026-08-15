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
#go{width:100%;margin-top:4px}
.drop{border:1px dashed var(--base);border-radius:10px;padding:14px;text-align:center;
color:var(--ink2);font-size:14px}
.drop b{display:block;color:var(--ink);font-weight:650;margin-bottom:3px}
</style></head><body>

<header>
<div class="bar"><h1>Firmware Update</h1>
<span class="sub">running v)rawliteral" FW_VERSION R"rawliteral(</span></div>
<nav><a href="/">Live</a><a href="/monitors">Monitors</a><a href="/trips">Trips</a><a href="/scan">Scanner</a><a class="on" href="/update">Firmware</a></nav>
</header>

<div class="wrap">

<div class="card">
<div class="drop"><b>Upload a compiled .bin</b>
The board reboots automatically once the write verifies.</div>
<input type="file" id="f" accept=".bin">
<button id="go" disabled>Upload &amp; flash</button>
<div class="bar2"><i id="p"></i></div>
<div class="msg" id="m"></div>
</div>

<div class="card">
<div class="hint" style="margin-top:0">
Build it with:<br>
<code>firmware/build.sh</code><br>
then upload <code>firmware/build/NexonOBD-v&lt;version&gt;.bin</code>.<br><br>
That is the app image. <code>NexonOBD.ino.merged.bin</code> sitting next to it is a
full-flash image for USB recovery and will not work here.<br><br>
The version above updates when the new image boots, so it doubles as confirmation
that the flash took.<br><br>
<b style="color:var(--ink2)">Do not close this page or leave the Wi-Fi network while it uploads.</b>
A failed write leaves the previous firmware intact &mdash; the ESP32 only switches over
after the new image verifies &mdash; but an interrupted upload means starting again.
</div>
</div>

</div>

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
    if(ok){m.className='msg ok';m.textContent='Flashed. Rebooting - reconnect to NexonOBD in a few seconds.';p.style.width='100%'}
    else{m.className='msg err';m.textContent='Update failed: '+x.responseText;go.disabled=false}
  };
  x.onerror=()=>{m.className='msg err';m.textContent='Connection lost during upload.';go.disabled=false};
  x.send(fd);
};
</script></body></html>)rawliteral";
