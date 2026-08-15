#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// Live gauge dashboard served at http://192.168.4.1/
//
// Ordered for a glance from the driver's seat rather than by PID number: speed and
// engine speed first, then the two that tell you to stop (boost, coolant), then the
// engine block, then mixture. Everything diagnostic is folded away below.
//
// Tiles are two-up at phone width and reflow wider on a tablet, which is what makes
// the whole set readable without scrolling.
static const char DASHBOARD_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Nexon Live</title>
<style>)rawliteral"
UI_CSS
R"rawliteral(
.glance{display:grid;grid-template-columns:1fr 140px;gap:8px}
@media(max-width:338px){.glance{grid-template-columns:1fr}}
.hero .value{font-size:46px;letter-spacing:-.035em}
/* The hero tile grows with the viewport while the dial beside it stays fixed, so
   the numeral has to scale or it floats in a widening void. */
@media(min-width:600px){.hero .value{font-size:68px}}
.dial{position:relative;width:116px;height:116px;margin:1px auto 0}
.dial svg{display:block}
.dial .gv{position:absolute;inset:0;display:flex;flex-direction:column;
align-items:center;justify-content:center;font-size:23px;font-weight:650;
letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.dial .gv .unit{margin-top:1px;font-size:10px;font-weight:400;color:var(--ink2)}
.vital{grid-template-columns:repeat(auto-fit,minmax(158px,1fr));margin-top:8px}
.value.sm{font-size:19px}
#scanBar{margin-bottom:10px}
.sep{color:var(--muted);margin:0 3px;font-weight:400}
</style></head><body>

<header>
<div class="bar"><h1>Nexon Live</h1>
<span class="sub">v)rawliteral" FW_VERSION R"rawliteral( &middot; <span id="tr">&mdash;</span></span>
<div class="status"><span class="dot" id="dot"></span><span id="st">connecting&hellip;</span>
<span id="hz" style="color:var(--muted)"></span></div></div>
<nav><a class="on" href="/">Live</a><a href="/monitors">Monitors</a><a href="/scan">Scanner</a><a href="/update">Firmware</a></nav>
</header>

<div class="wrap">

<div class="card" id="scanBar" style="display:none;border-color:var(--blue)">
<div class="label" style="margin:0 0 3px">DID scan running &mdash; <span id="scanEcu">ECM</span></div>
<div style="font-size:13px;color:var(--ink2)">The scanner has most of the bus, so
live values update slowly. It keeps going if you leave this page.</div>
<div class="bar2"><i id="scanProg"></i></div>
<div class="note" id="scanNum" style="margin-top:7px"></div>
<div style="margin-top:8px"><a href="/scan" style="color:var(--blue);font-size:13px">Open the scanner &rarr;</a></div>
</div>

<div class="glance">
<div class="tile hero"><div class="label">Vehicle speed</div>
<div class="value"><span id="speed">&mdash;</span><span class="unit">km/h</span></div>
<svg class="spark" id="spSpeed" preserveAspectRatio="none" aria-label="Vehicle speed, recent history"></svg></div>

<div class="tile"><div class="label">Engine speed</div>
<div class="dial"><svg width="116" height="116" viewBox="0 0 128 128" aria-hidden="true">
<path id="rt" fill="none" stroke="var(--base)" stroke-width="9" stroke-linecap="round"/>
<path id="ra" fill="none" stroke="var(--blue)" stroke-width="9" stroke-linecap="round"/></svg>
<div class="gv"><span id="rpm">&mdash;</span><span class="unit">rpm</span></div></div>
<div class="flag" id="rpmF">&#9650; approaching redline</div>
<svg class="spark" id="spRpm" preserveAspectRatio="none" aria-label="Engine speed, recent history"></svg></div>
</div>

<div class="tiles vital">
<div class="tile"><div class="label">Boost</div>
<div class="value"><span id="boost">&mdash;</span><span class="unit">bar</span></div>
<div class="note">MAP <span id="map">&mdash;</span> kPa</div>
<svg class="spark" id="spBoost" preserveAspectRatio="none" aria-label="Boost, recent history"></svg></div>

<div class="tile"><div class="label">Coolant</div>
<div class="value" id="coolantV"><span id="coolant">&mdash;</span><span class="unit">&deg;C</span></div>
<div class="flag" id="coolantF"></div>
<svg class="spark" id="spCool" preserveAspectRatio="none" aria-label="Coolant temperature, recent history"></svg></div>
</div>

<h2 class="sec">Engine</h2>
<div class="tiles">
<div class="tile"><div class="label">Oil temp</div>
<div class="value" id="oilV"><span id="oil">&mdash;</span><span class="unit">&deg;C</span></div>
<div class="flag" id="oilF"></div></div>

<div class="tile"><div class="label">Intake air</div>
<div class="value"><span id="iat">&mdash;</span><span class="unit">&deg;C</span></div></div>

<div class="tile"><div class="label">Engine load</div>
<div class="value"><span id="load">&mdash;</span><span class="unit">%</span></div></div>

<div class="tile"><div class="label">Throttle</div>
<div class="value"><span id="throttle">&mdash;</span><span class="unit">%</span></div></div>

<div class="tile"><div class="label">Timing</div>
<div class="value"><span id="timing">&mdash;</span><span class="unit">&deg;</span></div></div>

<div class="tile"><div class="label">Voltage</div>
<div class="value" id="voltV"><span id="volt">&mdash;</span><span class="unit">V</span></div>
<div class="flag" id="voltF"></div></div>
</div>

<h2 class="sec">Driver demand</h2>
<div class="tiles">
<div class="tile"><div class="label">Accelerator pedal</div>
<div class="value"><span id="pedalD">&mdash;</span><span class="unit">%</span></div>
<div class="note">2nd track <span id="pedalE">&mdash;</span> %</div></div>

<div class="tile"><div class="label">Commanded throttle</div>
<div class="value"><span id="cmdThrottle">&mdash;</span><span class="unit">%</span></div>
<div class="note">actual <span id="thrEcho">&mdash;</span> %</div></div>

<div class="tile"><div class="label">Torque demanded</div>
<div class="value"><span id="torqDem">&mdash;</span><span class="unit">%</span></div>
<div class="note" id="torqDemNm"></div></div>

<div class="tile"><div class="label">Torque delivered</div>
<div class="value"><span id="torqAct">&mdash;</span><span class="unit">%</span></div>
<div class="note" id="torqActNm"></div></div>

<div class="tile"><div class="label">Absolute load</div>
<div class="value"><span id="absLoad">&mdash;</span><span class="unit">%</span></div></div>

<div class="tile"><div class="label">Reference torque</div>
<div class="value sm"><span id="torqRef">&mdash;</span><span class="unit">N&middot;m</span></div>
<div class="note">engine constant</div></div>
</div>

<h2 class="sec">Mixture &amp; exhaust</h2>
<div class="tiles">
<div class="tile"><div class="label">Lambda</div>
<div class="value" id="lambdaV"><span id="lambda">&mdash;</span></div>
<div class="flag" id="lambdaF"></div></div>

<div class="tile"><div class="label">Fuel trim S / L</div>
<div class="value sm"><span id="stft">&mdash;</span><span class="unit">%</span>
<span class="sep">/</span><span id="ltft">&mdash;</span><span class="unit">%</span></div>
<div class="flag" id="trimF"></div></div>

<div class="tile"><div class="label">Fuel rate</div>
<div class="value"><span id="fuelRate">&mdash;</span><span class="unit">L/h</span></div>
<div class="note" id="econ"></div></div>

<div class="tile"><div class="label">Catalyst B1S1</div>
<div class="value" id="catV"><span id="cat">&mdash;</span><span class="unit">&deg;C</span></div>
<div class="flag" id="catF"></div></div>
</div>

<details><summary>Secondary readings</summary>
<div class="tiles">
<div class="tile"><div class="label">Ambient</div>
<div class="value"><span id="ambient">&mdash;</span><span class="unit">&deg;C</span></div>
<div class="note">echoes the intake sensor</div></div>

<div class="tile"><div class="label">Barometric</div>
<div class="value"><span id="baro">&mdash;</span><span class="unit">kPa</span></div></div>

<div class="tile"><div class="label">Fuel level</div>
<div class="value"><span id="fuel">&mdash;</span><span class="unit">%</span></div>
<div class="note">not wired through on this car</div></div>

<div class="tile"><div class="label">Run time</div>
<div class="value sm"><span id="runtime">&mdash;</span></div></div>
</div></details>

<details><summary>All values</summary>
<div class="tw"><table><caption>Every polled parameter, current sample</caption>
<thead><tr><th>PID</th><th>Parameter</th><th style="text-align:right">Value</th><th>Unit</th></tr></thead>
<tbody id="tb"></tbody></table></div></details>

</div>

<script>
// HSLOT/HP mirror the firmware's history buffer: 600 slots at 6 s is one hour.
// The board keeps that across restarts and serves it at /history, so the charts
// have shape the moment the page loads instead of starting flat.
const HSLOT=600,HP=6000,HOLD=2500,hist={rpm:[],boost:[],speed:[],coolant:[]},keep={};
let rate=[],hb=0,miss=0,lastStatus='',lastSeq=-1,alive=true;
// A sample can arrive with only some fields filled in: /data reports ok as soon as
// any one of the three batched mode-01 requests answers, so a single batch timing
// out sends six nulls and used to blank six gauges at once. Re-show the last known
// value for HOLD ms instead, dimmed. After that it reverts to '—' rather than
// showing something indefinitely stale as though it were live.
// How long a value may be re-shown, scaled to how fast samples are actually
// arriving. A fixed window is wrong for the same reason it was wrong on the board:
// over BLE a sample can be seconds apart, and holding for less than a few samples
// means fields blink to an em-dash between updates that are working perfectly well.
function holdMs(){if(rate.length<3)return HOLD;
const d=(rate[rate.length-1]-rate[0])/(rate.length-1);
return Math.max(HOLD,Math.min(15000,d*4))}
function merge(j){const now=Date.now(),v={},q={},w=holdMs();let held=0;
for(const k in j){const x=j[k];
if(x!=null&&!isNaN(x)){keep[k]={v:x,t:now};v[k]=x;q[k]=0}
else if(keep[k]&&now-keep[k].t<=w){v[k]=keep[k].v;q[k]=1;held++}
else{v[k]=null;q[k]=1}}
return[v,q,held]}
// Rate over a trailing window. The old reading averaged over the whole page
// lifetime, so it sagged after any rough patch and never recovered - it looked
// like the refresh was degrading long after it had recovered.
function hz(){if(rate.length<2)return'';const d=(rate[rate.length-1]-rate[0])/1000;
return d>0?'· '+((rate.length-1)/d).toFixed(1)+' Hz':''}
function arc(cx,cy,r,a0,a1){const p=a=>[cx+r*Math.cos(a*Math.PI/180),cy+r*Math.sin(a*Math.PI/180)];
const[x0,y0]=p(a0),[x1,y1]=p(a1);return`M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${Math.abs(a1-a0)>180?1:0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
function gauge(t,a,f){const e=document.getElementById(t),g=document.getElementById(a);
if(!e||!g)return;f=Math.max(0,Math.min(1,f||0));
e.setAttribute('d',arc(64,64,52,135,405));
g.setAttribute('d',f<=.001?'':arc(64,64,52,135,135+270*f))}
function spark(id,d,c,z){const e=document.getElementById(id);if(!e||d.length<2)return;
const w=e.clientWidth||220,h=26,p=3;let lo=Math.min(...d),hi=Math.max(...d);if(z)lo=Math.min(0,lo);
if(hi-lo<1e-6)hi=lo+1;const dx=w/(d.length-1);
const pts=d.map((v,i)=>`${(i*dx).toFixed(1)},${(p+(h-2*p)*(1-(v-lo)/(hi-lo))).toFixed(1)}`).join(' ');
e.setAttribute('viewBox',`0 0 ${w} ${h}`);
e.innerHTML=`<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`}
function push(k,v,fresh){if(v==null||isNaN(v))return;const a=hist[k];
if(fresh||!a.length)a.push(v);else a[a.length-1]=v;
if(a.length>HSLOT)a.shift()}
const n=(v,d=1)=>(v==null||isNaN(v))?'—':Number(v).toFixed(d);
const T=(i,s,q)=>{const e=document.getElementById(i);if(!e)return;e.textContent=s;e.classList.toggle('stale',!!q)};
function F(i,on,c,m){const e=document.getElementById(i);if(!e)return;e.className='flag'+(on?' on '+c:'');if(on&&m)e.textContent=m}
function V(i,l){const e=document.getElementById(i);if(e)e.className='value'+(l?' '+l:'')}
const ROWS=[['0C','Engine RPM','rpm','rpm',0],['0D','Vehicle speed','speed','km/h',0],
['0B','Intake manifold pressure','map','kPa',0],['—','Boost (derived)','boost','bar',2],
['04','Calculated load','load','%',1],['11','Throttle position','throttle','%',1],
['05','Coolant temperature','coolant','°C',0],['5C','Oil temperature','oil','°C',0],
['0F','Intake air temperature','iat','°C',0],['46','Ambient air temperature','ambient','°C',0],
['06','Short term fuel trim B1','stft','%',1],['07','Long term fuel trim B1','ltft','%',1],
['34','Lambda','lambda','',3],['3C','Catalyst temp B1S1','cat','°C',1],
['0E','Timing advance','timing','° BTDC',1],['5E','Fuel rate','fuelRate','L/h',2],
['42','Module voltage','volt','V',2],['33','Barometric pressure','baro','kPa',0],
['2F','Fuel tank level','fuel','%',1],['1F','Engine run time','runtime','s',0],
['49','Accelerator pedal D','pedalD','%',1],['4A','Accelerator pedal E','pedalE','%',1],
['4C','Commanded throttle actuator','cmdThrottle','%',1],
['61','Driver demanded torque','torqDem','%',1],['62','Actual engine torque','torqAct','%',1],
['63','Engine reference torque','torqRef','N·m',0],
['43','Absolute load value','absLoad','%',1]];
function hhmmss(s){if(s==null||isNaN(s))return'—';const h=Math.floor(s/3600),m=Math.floor(s%3600/60),q=Math.floor(s%60);
return(h?h+'h ':'')+m+'m '+String(q).padStart(2,'0')+'s'}
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim()}
// q[k] marks a field as held rather than freshly read. Every threshold below is
// gated on it: a held reading must never raise a warning, and must never keep one
// lit either, because a stale number cannot tell you whether the engine is still
// overheating. Held values are dimmed and the header says how many are being held.
function render(v,q){
T('rpm',v.rpm==null?'—':Math.round(v.rpm),q.rpm);gauge('rt','ra',v.rpm/6500);
F('rpmF',!q.rpm&&v.rpm>=5500,'warn','▲ approaching redline');
const b=(v.map!=null&&v.baro!=null)?(v.map-v.baro)/100:null,qb=q.map||q.baro;v.boost=b;q.boost=qb;
T('boost',b==null?'—':(b>=0?'+':'')+b.toFixed(2),qb);
T('map',v.map==null?'—':Math.round(v.map),q.map);
T('speed',v.speed==null?'—':Math.round(v.speed),q.speed);
T('coolant',v.coolant==null?'—':Math.round(v.coolant),q.coolant);
const cc=!q.coolant&&v.coolant>=110,cw=!q.coolant&&v.coolant>=103;V('coolantV',cc?'crit':cw?'warn':'');
F('coolantF',cw,cc?'crit':'warn',cc?'⚠ overheating — stop safely':'⚠ running hot');
T('oil',v.oil==null?'—':Math.round(v.oil),q.oil);
V('oilV',q.oil?'':v.oil>=125?'crit':v.oil>=115?'warn':'');
F('oilF',!q.oil&&v.oil>=115,v.oil>=125?'crit':'warn','⚠ oil temperature high');
T('iat',v.iat==null?'—':Math.round(v.iat),q.iat);T('load',n(v.load),q.load);T('throttle',n(v.throttle),q.throttle);
T('ambient',v.ambient==null?'—':Math.round(v.ambient),q.ambient);
T('baro',v.baro==null?'—':Math.round(v.baro),q.baro);T('fuel',n(v.fuel),q.fuel);
T('lambda',n(v.lambda,3),q.lambda);const ln=!q.lambda&&v.lambda>=1.10,ri=!q.lambda&&v.lambda<=0.85;V('lambdaV',ln?'warn':'');
F('lambdaF',ln||ri,'warn',ln?'⚠ running lean':'● running rich');
T('stft',v.stft==null?'—':(v.stft>0?'+':'')+n(v.stft),q.stft);
T('ltft',v.ltft==null?'—':(v.ltft>0?'+':'')+n(v.ltft),q.ltft);
F('trimF',!q.stft&&!q.ltft&&Math.abs(v.stft+v.ltft)>20,'warn','⚠ total trim beyond ±20% — check for a leak');
T('cat',n(v.cat),q.cat);V('catV',q.cat?'':v.cat>=900?'crit':v.cat>=800?'warn':'');
F('catF',!q.cat&&v.cat>=800,v.cat>=900?'crit':'warn','⚠ catalyst very hot');
T('timing',n(v.timing),q.timing);T('fuelRate',n(v.fuelRate,2),q.fuelRate);
document.getElementById('econ').textContent=(!q.speed&&!q.fuelRate&&v.speed>0&&v.fuelRate>0)?(v.speed/v.fuelRate).toFixed(1)+' km/L instantaneous':(!q.fuelRate&&v.fuelRate>0?'idling':'');
T('volt',n(v.volt,2),q.volt);const vl=!q.volt&&v.volt<12.2,vh=!q.volt&&v.volt>15.2;V('voltV',(vl||vh)?'warn':'');
F('voltF',vl||vh,'warn',vl?'⚠ not charging':'⚠ overcharging');
T('runtime',hhmmss(v.runtime),q.runtime);
T('pedalD',n(v.pedalD),q.pedalD);T('pedalE',n(v.pedalE),q.pedalE);
T('cmdThrottle',n(v.cmdThrottle),q.cmdThrottle);
T('thrEcho',n(v.throttle),q.throttle);
T('torqDem',n(v.torqDem),q.torqDem);T('torqAct',n(v.torqAct),q.torqAct);
T('torqRef',v.torqRef==null?'—':Math.round(v.torqRef),q.torqRef);
T('absLoad',n(v.absLoad),q.absLoad);
// 61/62 are a percentage of the engine's reference torque, so the newton-metres are
// only meaningful once 63 has been read. Shown as a note rather than a headline
// because the J1979 scaling has not been checked against this car.
const nm=(x,q2)=>(x==null||v.torqRef==null||q2)?'':(v.torqRef*x/100).toFixed(0)+' N·m';
T('torqDemNm',nm(v.torqDem,q.torqDem));T('torqActNm',nm(v.torqAct,q.torqAct));
// Only fresh readings enter the history - replaying a held value would draw a flat
// run in the sparkline that the car never actually did.
const now=Date.now(),fresh=now-hb>=HP;if(fresh)hb=now;
push('rpm',q.rpm?null:v.rpm,fresh);push('boost',qb?null:b,fresh);
push('speed',q.speed?null:v.speed,fresh);push('coolant',q.coolant?null:v.coolant,fresh);
spark('spRpm',hist.rpm,css('--blue'),1);spark('spBoost',hist.boost,css('--orange'),0);
spark('spSpeed',hist.speed,css('--aqua'),1);spark('spCool',hist.coolant,css('--yellow'),0);
document.getElementById('tb').innerHTML=ROWS.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td><td class="num${q[r[2]]?' stale':''}">${n(v[r[2]],r[4])}</td><td>${r[3]}</td></tr>`).join('')}
function st(c,t){if(t===lastStatus)return;lastStatus=t;
document.getElementById('dot').className='dot '+c;document.getElementById('st').textContent=t}
// One failed poll is not "the ECU is gone". A dropped reply happens - the values are
// held through it anyway - so the status only changes after MISS_MAX consecutive
// failures. Without this the text flipped between live and "no response" about once
// a second, which reads as a fault when nothing is actually wrong.
const MISS_MAX=5;
async function tick(){try{const r=await fetch('/data',{cache:'no-store'});const j=await r.json();
if(j.tr)T('tr',j.tr);
scanBar(j);
if(j.ok){miss=0;const[v,q,held]=merge(j.v);render(v,q);
// Count published samples, not fetches: /data serves a cached sample now, so the
// same one can be fetched several times and must not inflate the rate.
if(j.seq!==lastSeq){lastSeq=j.seq;rate.push(Date.now());if(rate.length>20)rate.shift()}
st('live',j.scan?'live · scanning':(held?'live · holding '+held:'live'));
document.getElementById('hz').textContent=hz()}
else if(j.scan){miss=0;st('stale','waiting · scanning');
document.getElementById('hz').textContent=''}
else if(++miss>=MISS_MAX){rate.length=0;st('stale',j.error||'no data');
document.getElementById('hz').textContent=''}}
catch(e){if(++miss>=MISS_MAX)st('dead','ESP32 unreachable')}
finally{if(alive)setTimeout(tick,120)}}
function scanBar(j){const e=document.getElementById('scanBar');if(!e)return;
e.style.display=j.scan?'block':'none';
if(!j.scan)return;
document.getElementById('scanProg').style.width=(j.scanPct||0)+'%';
T('scanEcu',j.scanEcu||'ECM');
// A sweep of the whole identifier space is tens of thousands of requests, so a
// percentage alone rounds to zero for a long time and reads as "stuck".
const t=j.scanTried||0,n=j.scanTotal||0;
T('scanNum',n?t.toLocaleString()+' of '+n.toLocaleString()+' · '+(j.scanPct||0)+'%':'')}
// Stop polling while the page is not on screen. The board keeps sampling either
// way, and a backgrounded tab hammering /data just costs battery and bus time.
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){alive=false}
 else if(!alive){alive=true;lastStatus='';tick()}});
// Seed the charts from the board's stored hour before the first poll lands.
async function seed(){try{
 const h=await(await fetch('/history',{cache:'no-store'})).json();
 for(const k of ['rpm','speed','boost','coolant'])
  if(Array.isArray(h[k]))hist[k]=h[k].filter(x=>x!=null&&!isNaN(x));
 hb=Date.now();
 spark('spRpm',hist.rpm,css('--blue'),1);spark('spBoost',hist.boost,css('--orange'),0);
 spark('spSpeed',hist.speed,css('--aqua'),1);spark('spCool',hist.coolant,css('--yellow'),0);
}catch(e){}}
seed().then(tick);
</script></body></html>)rawliteral";
