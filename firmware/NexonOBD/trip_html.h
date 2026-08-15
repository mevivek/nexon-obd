#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// Trip logs at http://192.168.4.1/trips
//
// The board records a CSV row a second to its own filesystem while the ECU is
// answering. This lists what it has, downloads it, and deletes what you are done
// with - the partition is 1.5 MB, which is a few hours of driving.
static const char TRIP_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Trips</title>
<link rel="stylesheet" href="/ui.css?v=)rawliteral" FW_VERSION R"rawliteral(">
<style>
.row2{display:flex;align-items:center;gap:10px}
.row2 .grow{flex:1;min-width:0}
.nm{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
.sz{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.act{display:flex;gap:6px;flex:none}
.act a,.act button{font-size:12px;padding:6px 10px;text-decoration:none;
border-radius:7px}
.act a{background:var(--blue);color:#04121f;font-weight:650}
.live{font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;
color:var(--good)}
</style></head><body>

<header>
<div class="bar"><h1>Trips</h1>
<span class="sub">v)rawliteral" FW_VERSION R"rawliteral( &middot; CSV logs</span>
<div class="status"><span class="dot" id="dot"></span><span id="state">reading&hellip;</span></div></div>
<nav><a href="/">Live</a><a href="/monitors">Monitors</a><a class="on" href="/trips">Trips</a><a href="/scan">Scanner</a><a href="/update">Firmware</a></nav>
</header>

<div class="wrap">

<div class="card">
<div class="row2"><div class="grow">
<div class="label" style="margin:0 0 4px">Storage</div>
<div class="bar2" style="margin:0"><i id="use"></i></div>
</div></div>
<div class="note" id="fs" style="margin-top:8px"></div>
<div class="hint">A row a second while the engine is answering, written to the
board's own filesystem. Roughly half a megabyte an hour, so the partition holds a
few hours &mdash; the oldest trip is deleted automatically when space runs short.
<br><br>
Rows carry both wall-clock time and uptime. The board learns the time from whichever
page you open, so a drive that starts before you open one has an unset clock for
those first rows &mdash; the header of each file records which.</div>
</div>

<div id="list"></div>

<div class="card" id="none" style="display:none">
<div style="color:var(--muted);font-size:14px">No trips recorded yet. One starts as
soon as the ECU answers.</div>
</div>

</div>

<script>
const $=i=>document.getElementById(i);
const kb=b=>b>=1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' KB';
async function poll(){
 try{
  const j=await(await fetch('/trips/list',{cache:'no-store'})).json();
  $('dot').className='dot '+(j.fs?'live':'dead');
  $('state').textContent=j.fs?(j.trips.length+' trips'):'no filesystem';
  $('use').style.width=(j.total?100*j.used/j.total:0).toFixed(1)+'%';
  $('fs').textContent=kb(j.used)+' of '+kb(j.total)+' used · '+kb(j.total-j.used)+' free';
  // Newest first: names are zero-padded and sequential, so a plain sort orders them.
  const t=j.trips.slice().sort((a,b)=>b.name.localeCompare(a.name));
  $('list').innerHTML=t.map(f=>`<div class="card"><div class="row2">
   <div class="grow"><div class="nm">${f.name.replace('/','')}
    ${f.name===j.live?'<span class="live">&middot; recording</span>':''}</div>
   <div class="sz">${kb(f.size)}</div></div>
   <div class="act"><a href="/trips/get?f=${encodeURIComponent(f.name)}">Download</a>
   <button class="ghost" onclick="del('${f.name}')">Delete</button></div>
  </div></div>`).join('');
  $('none').style.display=t.length?'none':'block';
 }catch(e){$('state').textContent='ESP32 unreachable';$('dot').className='dot dead'}
}
async function del(n){
 if(!confirm('Delete '+n.replace('/','')+'? This cannot be undone.'))return;
 await fetch('/trips/del?f='+encodeURIComponent(n));
 poll();
}
// The board has no clock of its own. Whichever page you open hands over the
// time, so anything it records carries a real timestamp.
fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
poll();setInterval(poll,4000);
</script></body></html>)rawliteral";
