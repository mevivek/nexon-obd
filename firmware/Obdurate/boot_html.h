#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// What / serves when no frontend bundle is installed.
//
// The full dashboard now lives in the bundle, built with an ordinary toolchain and
// uploaded to the filesystem. This is not a second copy of it - keeping one would
// mean two dashboards drifting apart, which is the duplication the move was meant
// to end. It is a floor: enough to tell you the board is alive and the ECU is
// answering, and to get you to the two pages that can fix things.
//
// It exists because a board in a car must not depend on a deploy having worked. A
// blank filesystem, an interrupted upload or a first flash all land here, and all
// of them should still show you a reading and a way forward.
static const char BOOT_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Nexon OBD</title>
<link rel="stylesheet" href="/ui.css?v=)rawliteral" FW_VERSION R"rawliteral(">
</head><body>

<header>
<div class="bar"><div class="id"><h1>Nexon OBD</h1>
<span class="sub">v)rawliteral" FW_VERSION R"rawliteral( &middot; <span id="tr">&mdash;</span></span></div>
<div class="status"><span class="dot" id="dot"></span><span id="st">connecting&hellip;</span></div></div>
</header>

<div class="wrap">

<div class="card" style="border-color:var(--blue)">
<div class="label" style="margin:0 0 3px">No frontend installed</div>
<div style="font-size:13px;color:var(--ink2)">The board is running, and this is the
minimum it can show on its own. The full dashboard &mdash; charts, the scanner, trip
logs, the DID watch &mdash; is a bundle you upload once.</div>
<div style="margin-top:9px"><a href="/ui" style="color:var(--blue);font-size:13px">Install it &rarr;</a></div>
</div>

<div class="tiles">
<div class="tile"><div class="label">Vehicle speed</div>
<div class="value"><span id="speed">&mdash;</span><span class="unit">km/h</span></div></div>
<div class="tile"><div class="label">Engine speed</div>
<div class="value"><span id="rpm">&mdash;</span><span class="unit">rpm</span></div></div>
<div class="tile"><div class="label">Coolant</div>
<div class="value"><span id="coolant">&mdash;</span><span class="unit">&deg;C</span></div></div>
<div class="tile"><div class="label">Battery</div>
<div class="value"><span id="volt">&mdash;</span><span class="unit">V</span></div></div>
</div>

<div class="hint">Trip logging, the DID sweep and the history buffer all keep running
without a frontend &mdash; they are the board's work, not the page's. Nothing recorded
is lost while this page is the one you can see.</div>

</div>

<!-- Fixed to the bottom, within reach of the thumb holding the phone. Only the
     three pages that live in flash are reachable from here: the rest of the tabs
     are in the bundle, and this page is what you get when there isn't one. -->
<nav>
<a class="on" href="/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 17a9 9 0 1 1 15.6 0"/><path d="M12 13.5 16 9"/></svg><span>Live</span></a>
<a href="/ui"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/></svg><span>Frontend</span></a>
<a href="/update"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.2"/><path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/></svg><span>Firmware</span></a>
</nav>

<script>
const $=i=>document.getElementById(i);
// Deliberately not the dashboard's hold-last-value logic. That belongs in one place,
// and this page's job is only to say whether the ECU is answering at all.
const n=(v,d)=>(v==null||isNaN(v))?'—':Number(v).toFixed(d);
let miss=0;
async function tick(){
 try{
  const j=await(await fetch('/data',{cache:'no-store'})).json();
  if(j.tr)$('tr').textContent=j.tr;
  if(j.ok){
   miss=0;
   $('dot').className='dot live';$('st').textContent='live';
   $('speed').textContent=n(j.v.speed,0);$('rpm').textContent=n(j.v.rpm,0);
   $('coolant').textContent=n(j.v.coolant,0);$('volt').textContent=n(j.v.volt,2);
  }else if(++miss>=5){
   // Same rule as the dashboard: one dropped reply is not a dead ECU.
   $('dot').className='dot stale';$('st').textContent=j.error||'no data';
  }
 }catch(e){if(++miss>=5){$('dot').className='dot dead';$('st').textContent='ESP32 unreachable'}}
 finally{setTimeout(tick,500)}
}
// The board has no clock of its own; whichever page you open is its only chance.
fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
tick();
</script></body></html>)rawliteral";
