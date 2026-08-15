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
<style>)rawliteral"
UI_CSS
R"rawliteral(
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
<nav><a href="/">Live</a><a class="on" href="/scan">DID scanner</a><a href="/update">Firmware</a></nav>
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
<div class="meta">
<span>at <b id="cur">&mdash;</b></span>
<span>tried <b id="tried">0</b></span>
<span>hits <b id="nhits">0</b></span>
<span>negatives <b id="neg">0</b></span>
<span>elapsed <b id="el">0</b>s</span>
<span>rate <b id="rate">&mdash;</b>/s</span>
</div>
<div class="hint">Service 0x22 is a read. This page never sends 0x2E (write), 0x31 (routine),
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
let timer=null,last=[];
const $=i=>document.getElementById(i);
function dot(c){$('dot').className='dot '+c}
async function poll(){
 try{
  const j=await(await fetch('/scan/status',{cache:'no-store'})).json();
  last=j.hits||[];
  $('state').textContent=j.running?'scanning':'idle';
  dot(j.running?'live':'');
  $('cur').textContent=j.cur;$('tried').textContent=j.tried;
  $('nhits').textContent=last.length;$('neg').textContent=j.negatives;
  $('el').textContent=j.elapsed;
  $('rate').textContent=j.elapsed>0?(j.tried/j.elapsed).toFixed(0):'—';
  $('prog').style.width=(j.total?100*j.tried/j.total:0).toFixed(1)+'%';
  $('tb').innerHTML=last.length?last.map(h=>
   `<tr><td>${h.ecu}</td><td class="mono">${h.did}</td><td class="num">${h.len}</td>
    <td class="mono brk">${h.ascii}</td><td class="mono brk">${h.hex.replace(/(..)/g,'$1 ').trim()}</td></tr>`).join('')
   :'<tr><td colspan="5" style="color:var(--muted)">Nothing yet.</td></tr>';
  if(!j.running&&timer){clearInterval(timer);timer=null}
 }catch(e){$('state').textContent='ESP32 unreachable';dot('dead')}
}
$('go').onclick=async()=>{
 const q=`?ecu=${$('ecu').value}&from=${$('from').value}&to=${$('to').value}`;
 await fetch('/scan/start'+q);
 if(timer)clearInterval(timer);
 timer=setInterval(poll,1000);poll();
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
poll();
</script></body></html>)rawliteral";
