#pragma once
#include <pgmspace.h>

// Over-the-air firmware upload at http://192.168.4.1/update
// Browser-based on purpose: no tooling needed, so a phone can flash the board
// while it is wedged under the dashboard.
static const char OTA_HTML[] PROGMEM = R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Firmware Update</title>
<style>
:root{--plane:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
--base:#383835;--ring:rgba(255,255,255,.10);--blue:#3987e5;--good:#0ca30c;
--warning:#fab219;--critical:#d03b3b;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);padding:16px;
font:400 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}
h1{font-size:17px;font-weight:600;margin:0}
nav a{color:var(--ink2);font-size:13px;text-decoration:none;border-bottom:1px solid var(--base)}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:16px;margin-bottom:12px}
input[type=file]{width:100%;color:var(--ink2);font:inherit;font-size:14px;padding:10px 0}
button{background:var(--blue);color:#fff;border:0;border-radius:6px;padding:10px 18px;
font:inherit;font-weight:600;cursor:pointer;width:100%}
button:disabled{background:var(--base);color:var(--muted);cursor:not-allowed}
.bar{height:8px;background:var(--base);border-radius:4px;overflow:hidden;margin-top:14px}
.bar>i{display:block;height:100%;background:var(--blue);width:0;transition:width .2s}
.msg{margin-top:12px;font-size:14px}
.msg.ok{color:var(--good)}.msg.err{color:var(--critical)}.msg.warn{color:var(--warning)}
.note{font-size:12px;color:var(--muted);margin-top:12px;line-height:1.6}
code{background:#111;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body>
<header><h1>Firmware Update</h1>
<nav><a href="/">&larr; Dashboard</a></nav></header>

<div class="card">
<p style="margin-top:0;color:var(--ink2);font-size:14px">
Upload a compiled <code>.bin</code>. The board reboots automatically when the write verifies.</p>
<input type="file" id="f" accept=".bin">
<button id="go" disabled>Upload &amp; flash</button>
<div class="bar"><i id="p"></i></div>
<div class="msg" id="m"></div>
<div class="note">
Build it with:<br>
<code>arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3 --output-dir build NexonOBD</code><br>
then upload <code>build/NexonOBD.ino.bin</code>.<br><br>
<b>Do not close this page or leave the Wi-Fi network while it uploads.</b>
A failed write leaves the previous firmware intact - the ESP32 only switches over
after the new image verifies - but an interrupted upload means starting again.
</div>
</div>

<script>
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
