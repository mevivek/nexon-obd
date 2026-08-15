#pragma once
#include <pgmspace.h>

// Live gauge dashboard served at http://192.168.4.1/
// Dark-committed instrument panel: surfaces painted explicitly, status colours
// always paired with an icon + text so nothing depends on colour alone.
static const char DASHBOARD_HTML[] PROGMEM = R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexon Live</title>
<style>
:root{--plane:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
--grid:#2c2c2a;--base:#383835;--ring:rgba(255,255,255,.10);
--blue:#3987e5;--orange:#d95926;--aqua:#199e70;--yellow:#c98500;
--good:#0ca30c;--warning:#fab219;--critical:#d03b3b;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);padding:16px;
font:400 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}
h1{font-size:17px;font-weight:600;margin:0}
.sub{color:var(--muted);font-size:13px}
nav a{color:var(--ink2);font-size:13px;text-decoration:none;border-bottom:1px solid var(--base)}
.status{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink2)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none}
.dot.live{background:var(--good)}.dot.stale{background:var(--warning)}.dot.dead{background:var(--critical)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:11px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:13px 15px;min-width:0}
.card.hero{grid-column:span 2}
@media(max-width:640px){.card.hero{grid-column:span 1}}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px}
.value{font-size:29px;font-weight:600;line-height:1.1}
.value .unit{font-size:14px;font-weight:400;color:var(--ink2);margin-left:4px}
.value.warn{color:var(--warning)}.value.crit{color:var(--critical)}
.flag{font-size:12px;margin-top:4px;display:none}
.flag.on{display:block}.flag.warn{color:var(--warning)}.flag.crit{color:var(--critical)}
.gw{display:flex;align-items:center;gap:13px}.gw svg{flex:none}
.gv{font-size:36px;font-weight:600;line-height:1}
.gv .unit{font-size:13px;font-weight:400;color:var(--ink2);display:block;margin-top:2px}
.spark{display:block;width:100%;height:32px;margin-top:8px}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:10px}
caption{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding-bottom:8px}
th,td{text-align:left;padding:5px 10px 5px 0;border-bottom:1px solid var(--grid)}
th{color:var(--muted);font-weight:500}
td.num{font-variant-numeric:tabular-nums;text-align:right}
.tw{margin-top:16px;overflow-x:auto}summary{cursor:pointer;color:var(--ink2);font-size:13px}
</style></head><body>
<header><h1>Nexon Live</h1>
<span class="sub">XIAO ESP32S3 &middot; CAN 11/500</span>
<nav><a href="/scan">DID scanner</a> &nbsp;<a href="/update">Firmware</a></nav>
<div class="status"><span class="dot" id="dot"></span><span id="st">connecting&hellip;</span>
<span id="hz" style="color:var(--muted)"></span></div></header>

<div class="grid">
<div class="card hero"><div class="label">Engine speed</div><div class="gw">
<svg width="120" height="120" viewBox="0 0 128 128" aria-hidden="true">
<path id="rt" fill="none" stroke="var(--base)" stroke-width="10" stroke-linecap="round"/>
<path id="ra" fill="none" stroke="var(--blue)" stroke-width="10" stroke-linecap="round"/></svg>
<div><div class="gv"><span id="rpm">&mdash;</span><span class="unit">rpm</span></div>
<div class="flag" id="rpmF">&#9650; approaching redline</div></div></div>
<svg class="spark" id="spRpm" preserveAspectRatio="none" aria-label="Engine speed, recent history"></svg></div>

<div class="card hero"><div class="label">Boost (MAP &minus; baro)</div><div class="gw">
<svg width="120" height="120" viewBox="0 0 128 128" aria-hidden="true">
<path id="bt" fill="none" stroke="var(--base)" stroke-width="10" stroke-linecap="round"/>
<path id="ba" fill="none" stroke="var(--orange)" stroke-width="10" stroke-linecap="round"/></svg>
<div><div class="gv"><span id="boost">&mdash;</span><span class="unit">bar</span></div>
<div class="sub" style="font-size:12px">MAP <span id="map">&mdash;</span> kPa</div></div></div>
<svg class="spark" id="spBoost" preserveAspectRatio="none" aria-label="Boost, recent history"></svg></div>

<div class="card"><div class="label">Vehicle speed</div>
<div class="value"><span id="speed">&mdash;</span><span class="unit">km/h</span></div>
<svg class="spark" id="spSpeed" preserveAspectRatio="none" aria-label="Speed, recent history"></svg></div>

<div class="card"><div class="label">Coolant temperature</div>
<div class="value" id="coolantV"><span id="coolant">&mdash;</span><span class="unit">&deg;C</span></div>
<div class="flag" id="coolantF"></div>
<svg class="spark" id="spCool" preserveAspectRatio="none" aria-label="Coolant, recent history"></svg></div>

<div class="card"><div class="label">Oil temperature</div>
<div class="value" id="oilV"><span id="oil">&mdash;</span><span class="unit">&deg;C</span></div>
<div class="flag" id="oilF"></div></div>

<div class="card"><div class="label">Intake air temperature</div>
<div class="value"><span id="iat">&mdash;</span><span class="unit">&deg;C</span></div></div>

<div class="card"><div class="label">Engine load</div>
<div class="value"><span id="load">&mdash;</span><span class="unit">%</span></div></div>

<div class="card"><div class="label">Throttle position</div>
<div class="value"><span id="throttle">&mdash;</span><span class="unit">%</span></div></div>

<div class="card"><div class="label">Lambda</div>
<div class="value" id="lambdaV"><span id="lambda">&mdash;</span></div>
<div class="flag" id="lambdaF"></div></div>

<div class="card"><div class="label">Fuel trim &mdash; short / long</div>
<div class="value" style="font-size:23px"><span id="stft">&mdash;</span><span class="unit">%</span>
<span style="color:var(--muted);margin:0 3px">/</span><span id="ltft">&mdash;</span><span class="unit">%</span></div>
<div class="flag" id="trimF"></div></div>

<div class="card"><div class="label">Catalyst temp B1S1</div>
<div class="value" id="catV"><span id="cat">&mdash;</span><span class="unit">&deg;C</span></div>
<div class="flag" id="catF"></div></div>

<div class="card"><div class="label">Timing advance</div>
<div class="value"><span id="timing">&mdash;</span><span class="unit">&deg;</span></div></div>

<div class="card"><div class="label">Fuel rate</div>
<div class="value"><span id="fuelRate">&mdash;</span><span class="unit">L/h</span></div>
<div class="sub" style="font-size:12px" id="econ"></div></div>

<div class="card"><div class="label">Module voltage</div>
<div class="value" id="voltV"><span id="volt">&mdash;</span><span class="unit">V</span></div>
<div class="flag" id="voltF"></div></div>

<div class="card"><div class="label">Engine run time</div>
<div class="value" style="font-size:23px"><span id="runtime">&mdash;</span></div></div>
</div>

<div class="tw"><details open><summary>Raw values (table view)</summary>
<table><caption>Every polled parameter, current sample</caption>
<thead><tr><th>PID</th><th>Parameter</th><th style="text-align:right">Value</th><th>Unit</th></tr></thead>
<tbody id="tb"></tbody></table></details></div>

<script>
const H=120,hist={rpm:[],boost:[],speed:[],coolant:[]};let samples=0,t0=Date.now();
function arc(cx,cy,r,a0,a1){const p=a=>[cx+r*Math.cos(a*Math.PI/180),cy+r*Math.sin(a*Math.PI/180)];
const[x0,y0]=p(a0),[x1,y1]=p(a1);return`M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${Math.abs(a1-a0)>180?1:0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
function gauge(t,a,f){f=Math.max(0,Math.min(1,f||0));document.getElementById(t).setAttribute('d',arc(64,64,52,135,405));
const e=document.getElementById(a);e.setAttribute('d',f<=.001?'':arc(64,64,52,135,135+270*f))}
function spark(id,d,c,z){const e=document.getElementById(id);if(!e||d.length<2)return;
const w=e.clientWidth||220,h=32,p=3;let lo=Math.min(...d),hi=Math.max(...d);if(z)lo=Math.min(0,lo);
if(hi-lo<1e-6)hi=lo+1;const dx=w/(H-1);
const pts=d.map((v,i)=>`${(i*dx).toFixed(1)},${(p+(h-2*p)*(1-(v-lo)/(hi-lo))).toFixed(1)}`).join(' ');
e.setAttribute('viewBox',`0 0 ${w} ${h}`);
e.innerHTML=`<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`}
function push(k,v){if(v==null||isNaN(v))return;const a=hist[k];a.push(v);if(a.length>H)a.shift()}
const n=(v,d=1)=>(v==null||isNaN(v))?'—':Number(v).toFixed(d);
const T=(i,s)=>{const e=document.getElementById(i);if(e)e.textContent=s};
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
['2F','Fuel tank level','fuel','%',1],['1F','Engine run time','runtime','s',0]];
function hhmmss(s){if(s==null||isNaN(s))return'—';const h=Math.floor(s/3600),m=Math.floor(s%3600/60),q=Math.floor(s%60);
return(h?h+'h ':'')+m+'m '+String(q).padStart(2,'0')+'s'}
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim()}
function render(v){
T('rpm',v.rpm==null?'—':Math.round(v.rpm));gauge('rt','ra',v.rpm/6500);
F('rpmF',v.rpm>=5500,'warn','▲ approaching redline');
const b=(v.map!=null&&v.baro!=null)?(v.map-v.baro)/100:null;v.boost=b;
T('boost',b==null?'—':(b>=0?'+':'')+b.toFixed(2));gauge('bt','ba',b/1.2);
T('map',v.map==null?'—':Math.round(v.map));
T('speed',v.speed==null?'—':Math.round(v.speed));
T('coolant',v.coolant==null?'—':Math.round(v.coolant));
const cc=v.coolant>=110,cw=v.coolant>=103;V('coolantV',cc?'crit':cw?'warn':'');
F('coolantF',cw,cc?'crit':'warn',cc?'⚠ overheating — stop safely':'⚠ running hot');
T('oil',v.oil==null?'—':Math.round(v.oil));V('oilV',v.oil>=125?'crit':v.oil>=115?'warn':'');
F('oilF',v.oil>=115,v.oil>=125?'crit':'warn','⚠ oil temperature high');
T('iat',v.iat==null?'—':Math.round(v.iat));T('load',n(v.load));T('throttle',n(v.throttle));
T('lambda',n(v.lambda,3));const ln=v.lambda>=1.10,ri=v.lambda<=0.85;V('lambdaV',ln?'warn':'');
F('lambdaF',ln||ri,'warn',ln?'⚠ running lean':'● running rich');
T('stft',v.stft==null?'—':(v.stft>0?'+':'')+n(v.stft));
T('ltft',v.ltft==null?'—':(v.ltft>0?'+':'')+n(v.ltft));
F('trimF',Math.abs(v.stft+v.ltft)>20,'warn','⚠ total trim beyond ±20% — check for a leak');
T('cat',n(v.cat));V('catV',v.cat>=900?'crit':v.cat>=800?'warn':'');
F('catF',v.cat>=800,v.cat>=900?'crit':'warn','⚠ catalyst very hot');
T('timing',n(v.timing));T('fuelRate',n(v.fuelRate,2));
document.getElementById('econ').textContent=(v.speed>0&&v.fuelRate>0)?(v.speed/v.fuelRate).toFixed(1)+' km/L instantaneous':(v.fuelRate>0?'idling':'');
T('volt',n(v.volt,2));const vl=v.volt<12.2,vh=v.volt>15.2;V('voltV',(vl||vh)?'warn':'');
F('voltF',vl||vh,'warn',vl?'⚠ not charging':'⚠ overcharging');
T('runtime',hhmmss(v.runtime));
push('rpm',v.rpm);push('boost',b);push('speed',v.speed);push('coolant',v.coolant);
spark('spRpm',hist.rpm,css('--blue'),1);spark('spBoost',hist.boost,css('--orange'),0);
spark('spSpeed',hist.speed,css('--aqua'),1);spark('spCool',hist.coolant,css('--yellow'),0);
document.getElementById('tb').innerHTML=ROWS.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td><td class="num">${n(v[r[2]],r[4])}</td><td>${r[3]}</td></tr>`).join('')}
function st(c,t){document.getElementById('dot').className='dot '+c;document.getElementById('st').textContent=t}
async function tick(){try{const r=await fetch('/data',{cache:'no-store'});const j=await r.json();
if(j.ok){samples++;render(j.v);st('live','live');
document.getElementById('hz').textContent='· '+(samples/((Date.now()-t0)/1000)).toFixed(1)+' Hz'}
else st('stale',j.error||'no data')}catch(e){st('dead','ESP32 unreachable')}
finally{setTimeout(tick,120)}}
tick();
</script></body></html>)rawliteral";
