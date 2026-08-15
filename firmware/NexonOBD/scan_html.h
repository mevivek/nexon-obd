#pragma once
#include <pgmspace.h>

// UDS DID scanner UI at http://192.168.4.1/scan
// Service 0x22 reads only - the page cannot issue any state-changing service.
static const char SCAN_HTML[] PROGMEM = R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DID Scanner</title>
<style>
:root{--plane:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
--grid:#2c2c2a;--base:#383835;--ring:rgba(255,255,255,.10);
--blue:#3987e5;--good:#0ca30c;--warning:#fab219;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);padding:16px;
font:400 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}
h1{font-size:17px;font-weight:600;margin:0}
nav a{color:var(--ink2);font-size:13px;text-decoration:none;border-bottom:1px solid var(--base)}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px}
select,input{background:#111;color:var(--ink);border:1px solid var(--base);border-radius:6px;padding:7px 9px;font:inherit;font-size:14px}
input{width:88px;font-variant-numeric:tabular-nums}
button{background:var(--blue);color:#fff;border:0;border-radius:6px;padding:8px 15px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--ink2);border:1px solid var(--base)}
.bar{height:6px;background:var(--base);border-radius:3px;overflow:hidden;margin-top:12px}
.bar>i{display:block;height:100%;background:var(--blue);width:0}
.meta{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--ink2);margin-top:10px;font-variant-numeric:tabular-nums}
.meta b{color:var(--ink);font-weight:600}
table{border-collapse:collapse;width:100%;font-size:13px}
caption{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding-bottom:8px}
th,td{text-align:left;padding:5px 10px 5px 0;border-bottom:1px solid var(--grid);vertical-align:top}
th{color:var(--muted);font-weight:500}
td.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
td.num{font-variant-numeric:tabular-nums;text-align:right}
.tw{overflow-x:auto}
.note{font-size:12px;color:var(--muted);margin-top:10px}
</style></head><body>
<header><h1>UDS DID Scanner</h1>
<nav><a href="/">&larr; Live dashboard</a></nav></header>

<div class="card">
<div class="row">
<div><label for="ecu">ECU</label><select id="ecu">
<option value="0">ECM &mdash; engine (7E0/7E8)</option>
<option value="1">TCM &mdash; transmission (7E1/7E9)</option></select></div>
<div><label for="from">From</label><input id="from" value="0000"></div>
<div><label for="to">To</label><input id="to" value="FFFF"></div>
<button id="go">Start scan</button>
<button id="stop" class="ghost">Stop</button>
<button id="csv" class="ghost">Download CSV</button>
</div>
<div class="bar"><i id="prog"></i></div>
<div class="meta">
<span>status <b id="state">idle</b></span>
<span>at <b id="cur">&mdash;</b></span>
<span>tried <b id="tried">0</b></span>
<span>hits <b id="nhits">0</b></span>
<span>negatives <b id="neg">0</b></span>
<span>elapsed <b id="el">0</b>s</span>
<span>rate <b id="rate">&mdash;</b>/s</span>
</div>
<div class="note">Service 0x22 is a read. This page never sends 0x2E (write), 0x31 (routine),
0x11 (reset) or 0x10 (session change). A full 0000&ndash;FFFF pass is 65,536 requests.</div>
</div>

<div class="card tw">
<table><caption>Responding identifiers</caption>
<thead><tr><th>ECU</th><th>DID</th><th class="num">Bytes</th><th>Hex</th><th>ASCII</th></tr></thead>
<tbody id="tb"><tr><td colspan="5" style="color:var(--muted)">No scan run yet.</td></tr></tbody>
</table></div>

<script>
let timer=null,last=[];
const $=i=>document.getElementById(i);
async function poll(){
 try{
  const j=await(await fetch('/scan/status',{cache:'no-store'})).json();
  last=j.hits||[];
  $('state').textContent=j.running?'scanning':'idle';
  $('cur').textContent=j.cur;$('tried').textContent=j.tried;
  $('nhits').textContent=last.length;$('neg').textContent=j.negatives;
  $('el').textContent=j.elapsed;
  $('rate').textContent=j.elapsed>0?(j.tried/j.elapsed).toFixed(0):'—';
  $('prog').style.width=(j.total?100*j.tried/j.total:0).toFixed(1)+'%';
  $('tb').innerHTML=last.length?last.map(h=>
   `<tr><td>${h.ecu}</td><td class="mono">${h.did}</td><td class="num">${h.len}</td>
    <td class="mono">${h.hex.replace(/(..)/g,'$1 ').trim()}</td><td class="mono">${h.ascii}</td></tr>`).join('')
   :'<tr><td colspan="5" style="color:var(--muted)">Nothing yet.</td></tr>';
  if(!j.running&&timer){clearInterval(timer);timer=null}
 }catch(e){$('state').textContent='ESP32 unreachable'}
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
