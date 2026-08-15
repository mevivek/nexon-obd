#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// UDS DID scanner UI at http://192.168.4.1/scan
// Service 0x22 reads only - the page cannot issue any state-changing service.
static const char SCAN_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DID Scanner</title>
<link rel="stylesheet" href="/ui.css?v=)rawliteral" FW_VERSION R"rawliteral(">
<style>
.row>div{flex:1 1 120px;min-width:0}
.row>div:first-child{flex:1 1 100%}
.row select,.row input{width:100%}
.btns{display:flex;gap:8px;margin-top:10px}
.btns button{flex:1;padding:10px 8px}
/* Results scroll sideways rather than wrapping hex into an unreadable block. */
#res{min-width:470px}
</style></head><body>

<header>
<div class="bar"><h1>DID Scanner</h1>
<span class="sub">v)rawliteral" FW_VERSION R"rawliteral( &middot; service 0x22</span>
<div class="status"><span class="dot" id="dot"></span><span id="state">idle</span></div></div>
<nav><a href="/">Live</a><a href="/monitors">Monitors</a><a href="/trips">Trips</a><a href="/watch">Watch</a><a class="on" href="/scan">Scanner</a><a href="/update">Firmware</a></nav>
</header>

<div class="wrap">

<div class="card">
<div class="row">
<div><label for="ecu">ECU</label><select id="ecu">
<option value="0">ECM &mdash; engine (7E0/7E8)</option>
<option value="1">TCM &mdash; transmission (7E1/7E9)</option></select></div>
<div><label for="from">From</label><input type="text" id="from" value="0000"></div>
<div><label for="to">To</label><input type="text" id="to" value="FFFF"></div>
</div>
<div class="btns">
<button id="go">Start scan</button>
<button id="stop" class="ghost">Stop</button>
<button id="csv" class="ghost">CSV</button>
</div>
<div class="bar2"><i id="prog"></i></div>
<div class="hint" id="stall" style="display:none;color:var(--warning)">
The ECU has stopped answering &mdash; ignition off, most likely. The sweep is holding
its place rather than recording identifiers it never really asked, and picks up again
on its own when the car answers. Progress is saved, so switching off is safe.</div>
<div class="meta">
<span>at <b id="cur">&mdash;</b></span>
<span>tried <b id="tried">0</b></span>
<span>hits <b id="nhits">0</b></span>
<span>negatives <b id="neg">0</b></span>
<span>elapsed <b id="el">0</b>s</span>
<span>rate <b id="rate">&mdash;</b>/s</span>
<span>left <b id="eta">&mdash;</b></span>
</div>
<div class="hint">A scan keeps running if you leave this page or close the browser &mdash;
it is driven by the board, not by this tab. The scanner takes most of the bus, so
live dashboard values keep updating but slowly. Use Stop to end it &mdash; starting a
new scan discards the identifiers found so far.<br><br>
Progress and hits are saved as the sweep runs, so it resumes where it left off after
the car is switched off or the board is reflashed &mdash; a full pass no longer has to
happen in one sitting.<br><br>
Service 0x22 is a read. This page never sends 0x2E (write), 0x31 (routine),
0x11 (reset) or 0x10 (session change). A full 0000&ndash;FFFF pass is 65,536 requests.
Run it parked.</div>
</div>

<div class="card tw">
<table id="res"><caption>Responding identifiers</caption>
<thead><tr><th>ECU</th><th>DID</th><th class="num">Bytes</th><th>ASCII</th><th>Hex</th></tr></thead>
<tbody id="tb"><tr><td colspan="5" style="color:var(--muted)">No scan run yet.</td></tr></tbody>
</table></div>

</div>

<script>
let timer=null,period=0,last=[];
const $=i=>document.getElementById(i);
// The page must be live however the scan was started - it may have been kicked off
// from another phone, or before this tab was opened, since the board runs it. The
// interval used to be created only inside the Start handler, so opening this page
// mid-sweep showed one frozen snapshot and the only way to get moving numbers was
// to press Start, which wipes the run.
function schedule(ms){if(timer&&period===ms)return;
 if(timer)clearInterval(timer);period=ms;timer=setInterval(poll,ms)}
// Start resets cur, tried, negatives and clears the hit list on the board, and none
// of that is persisted anywhere - so leaving the button live during a sweep put a
// stray tap between you and losing the whole thing.
function controls(running){
 $('go').disabled=running;
 $('go').textContent=running?'Scanning\u2026':'Start scan';
 $('stop').disabled=!running;
 $('csv').disabled=!last.length;
 for(const i of ['ecu','from','to'])$(i).disabled=running;
}
function hms(s){s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60);
return h>48?Math.round(h/24)+'d':h?h+'h '+m+'m':m?m+'m':s+'s'}
function dot(c){$('dot').className='dot '+c}
async function poll(){
 try{
  const j=await(await fetch('/scan/status',{cache:'no-store'})).json();
  last=j.hits||[];
  // Stalled is not idle and not scanning: the sweep is alive and holding position
  // because the ECU stopped answering. Saying "scanning" would imply progress that
  // is deliberately not happening.
  $('state').textContent=j.stalled?'waiting for ECU':(j.running?'scanning':'idle');
  dot(j.stalled?'stale':(j.running?'live':''));
  $('stall').style.display=j.stalled?'block':'none';
  $('cur').textContent=j.cur;$('tried').textContent=j.tried;
  $('nhits').textContent=last.length;$('neg').textContent=j.negatives;
  $('el').textContent=j.elapsed;
  const rps=j.elapsed>0?j.tried/j.elapsed:0;
  $('rate').textContent=rps?rps.toFixed(rps<10?1:0):'—';
  // A full sweep is 65,536 requests. On BLE that is the better part of a day, which
  // is worth knowing before walking away rather than after.
  $('eta').textContent=(rps>0&&j.total>j.tried)?hms((j.total-j.tried)/rps):'—';
  $('prog').style.width=(j.total?100*j.tried/j.total:0).toFixed(1)+'%';
  $('tb').innerHTML=last.length?last.map(h=>
   `<tr><td>${h.ecu}</td><td class="mono">${h.did}</td><td class="num">${h.len}</td>
    <td class="mono brk">${h.ascii}</td><td class="mono brk">${h.hex.replace(/(..)/g,'$1 ').trim()}</td></tr>`).join('')
   :'<tr><td colspan="5" style="color:var(--muted)">Nothing yet.</td></tr>';
  controls(j.running);
  schedule(j.running?1000:4000);
 }catch(e){$('state').textContent='ESP32 unreachable';dot('dead');schedule(4000)}
}
$('go').onclick=async()=>{
 controls(true);                       // reflect it now, not a round trip later
 const q=`?ecu=${$('ecu').value}&from=${$('from').value}&to=${$('to').value}`;
 await fetch('/scan/start'+q);
 poll();
};
$('stop').onclick=async()=>{await fetch('/scan/stop');poll()};
$('csv').onclick=()=>{
 if(!last.length)return;
 const rows=[['ecu','did','len','hex','ascii'].join(',')].concat(
  last.map(h=>[h.ecu,h.did,h.len,h.hex,'"'+h.ascii.replace(/"/g,'')+'"'].join(',')));
 const a=document.createElement('a');
 a.href=URL.createObjectURL(new Blob([rows.join('\n')],{type:'text/csv'}));
 a.download='did_hits.csv';a.click();
};
// The board has no clock of its own. Whichever page you open hands over the
// time, so anything it records carries a real timestamp.
fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
poll();
</script></body></html>)rawliteral";
