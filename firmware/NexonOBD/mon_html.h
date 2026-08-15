#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// Mode 06 on-board monitor results at http://192.168.4.1/monitors
//
// Mode 06 is a read, like everything else here. The ECU reports what each of its
// own monitors measured and the limits it judges that against, so this page can say
// how close a system is to failing rather than only whether a fault has already
// been stored.
static const char MON_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Monitors</title>
<style>)rawliteral"
UI_CSS
R"rawliteral(
.mon{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px}
.badge{float:right;font-size:10px;font-weight:650;text-transform:uppercase;
letter-spacing:.07em;padding:2px 7px;border-radius:999px}
.badge.ok{background:rgba(47,191,95,.16);color:var(--good)}
.badge.bad{background:rgba(239,75,75,.16);color:var(--critical)}
.win{position:relative;height:8px;margin:11px 0 6px;background:var(--base);
border-radius:4px}
.win>i{position:absolute;top:-3px;width:3px;height:14px;border-radius:2px;
background:var(--ink)}
.win>u{position:absolute;top:0;height:8px;border-radius:4px;
background:rgba(75,155,255,.30)}
.lim{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);
font-variant-numeric:tabular-nums}
</style></head><body>

<header>
<div class="bar"><h1>Monitors</h1>
<span class="sub">v)rawliteral" FW_VERSION R"rawliteral( &middot; mode 06</span>
<div class="status"><span class="dot" id="dot"></span><span id="state">reading&hellip;</span></div></div>
<nav><a href="/">Live</a><a class="on" href="/monitors">Monitors</a><a href="/scan">Scanner</a><a href="/update">Firmware</a></nav>
</header>

<div class="wrap">

<div class="card">
<div class="hint" style="margin-top:0">The ECU's own test results, each with the
limits it is judged against &mdash; so a pass with almost no headroom is visible long
before it becomes a fault code.</div>
</div>

<details><summary>How to read this</summary>
<div class="hint">
<b style="color:var(--ink2)">Pass and headroom do not depend on knowing the units.</b>
A test passes when its value sits inside its own limits, and the bar shows where in
that window it sits. The raw numbers and the unit-and-scaling id are shown as
reported; that table is long and only partly documented, so nothing here pretends to
convert values it cannot.<br><br>
Monitor names come from J1979 and only the unambiguous ids are named &mdash; anything
else keeps its raw id rather than being given a label that might be wrong.<br><br>
Results only refresh while this page is open. Monitors move over minutes, and polling
them continuously would take bus time from the values that move now.</div></details>

<div class="mon" id="mon"></div>

<div class="card" id="empty">
<div style="color:var(--muted);font-size:14px">Nothing reported yet. The board
discovers which monitors exist, then reads them one at a time &mdash; give it a few
seconds with the ignition on.</div>
</div>

</div>

<script>
const $=i=>document.getElementById(i);
// Only the monitor ids that are unambiguous in J1979 are named. Anything else keeps
// its raw id rather than being given a label that might be wrong.
const NAMES={'01':'O2 sensor B1S1','02':'O2 sensor B1S2','03':'O2 sensor B1S3',
'04':'O2 sensor B1S4','05':'O2 sensor B2S1','06':'O2 sensor B2S2',
'07':'O2 sensor B2S3','08':'O2 sensor B2S4','21':'Catalyst bank 1',
'22':'Catalyst bank 2','A0':'Misfire general','A1':'Misfire cylinder 1',
'A2':'Misfire cylinder 2','A3':'Misfire cylinder 3','A4':'Misfire cylinder 4'};
// Only the plain decimal multipliers are decoded. The rest of the scaling table is
// not reproduced here, so those values stay raw and say so.
const UAS={'01':1,'02':0.1,'03':0.01,'04':0.001};
function fmt(raw,uas){const m=UAS[uas];
if(!m)return raw+' raw';
// Decimals follow the multiplier, so x0.01 shows two places rather than three.
return (raw*m).toFixed(m>=1?0:Math.round(-Math.log10(m)))}
function card(r){
 const lo=r.lo,hi=r.hi,v=r.v,span=hi-lo;
 const pass=v>=lo&&v<=hi;
 // Where in its own window the value sits - unit-free, so always meaningful.
 const pos=span>0?Math.max(0,Math.min(100,100*(v-lo)/span)):(pass?50:0);
 const head=span>0?Math.max(0,Math.min(v-lo,hi-v))/span*100:0;
 const name=NAMES[r.mid]||('Monitor '+r.mid);
 return `<div class="tile">
  <div class="label">${name} <span style="color:var(--base)">&middot;</span> test ${r.tid}
   <span class="badge ${pass?'ok':'bad'}">${pass?'pass':'fail'}</span></div>
  <div class="value sm">${fmt(v,r.uas)}</div>
  <div class="win"><u style="left:0;width:100%"></u><i style="left:calc(${pos.toFixed(1)}% - 1px)"></i></div>
  <div class="lim"><span>min ${fmt(lo,r.uas)}</span><span>max ${fmt(hi,r.uas)}</span></div>
  <div class="note">${span>0?head.toFixed(0)+'% of the window from the nearest limit':'no usable limits reported'}
   <span style="color:var(--base)">&middot;</span> uas ${r.uas}</div>
 </div>`}
async function poll(){
 try{
  const j=await(await fetch('/mon',{cache:'no-store'})).json();
  $('dot').className='dot '+(j.recs.length?'live':'');
  $('state').textContent=j.ready?(j.recs.length?j.recs.length+' results':'no monitors reported'):'discovering…';
  $('mon').innerHTML=j.recs.map(card).join('');
  $('empty').style.display=j.recs.length?'none':'block';
 }catch(e){$('state').textContent='ESP32 unreachable';$('dot').className='dot dead'}
}
// The board has no clock of its own. Whichever page you open hands over the
// time, so anything it records carries a real timestamp.
fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
poll();setInterval(poll,2000);
</script></body></html>)rawliteral";
