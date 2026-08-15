#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// DID watch at http://192.168.4.1/watch
//
// The scanner finds identifiers that answer; it cannot say what they hold. This
// reads a chosen handful continuously and puts them next to rpm, coolant and load,
// so a value that moves with one of them gives itself away. The same readings go
// into the trip CSV as extra columns for anything too subtle to see by eye.
static const char WATCH_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DID Watch</title>
<link rel="stylesheet" href="/ui.css?v=)rawliteral" FW_VERSION R"rawliteral(">
<style>
.ref{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.ref div{min-width:0}
.ref .value{font-size:19px}
.w{background:var(--surface);border:1px solid var(--ring);border-radius:12px;
padding:10px 12px;margin-bottom:8px;overflow:hidden}
.wh{display:flex;align-items:baseline;gap:8px}
.wn{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;
font-weight:650}
.wv{margin-left:auto;font-size:22px;font-weight:650;letter-spacing:-.02em;
font-variant-numeric:tabular-nums}
.wx{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;
color:var(--muted)}
.pick{display:flex;flex-wrap:wrap;gap:6px;max-height:210px;overflow-y:auto;
margin-top:9px;padding:2px}
.pick label{display:flex;align-items:center;gap:5px;margin:0;padding:5px 8px;
background:var(--raised);border:1px solid var(--base);border-radius:8px;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;
font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink2);cursor:pointer}
.pick label.on{border-color:var(--blue);color:var(--ink)}
.pick input{margin:0;width:auto;padding:0}
.full{width:100%!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
</style></head><body>

<header>
<div class="bar"><h1>DID Watch</h1>
<span class="sub">v)rawliteral" FW_VERSION R"rawliteral( &middot; service 0x22</span>
<div class="status"><span class="dot" id="dot"></span><span id="state">reading&hellip;</span></div></div>
<nav><a href="/">Live</a><a href="/monitors">Monitors</a><a href="/trips">Trips</a><a class="on" href="/watch">Watch</a><a href="/scan">Scanner</a><a href="/update">Firmware</a></nav>
</header>

<div class="wrap">

<div class="card" id="scanning" style="display:none">
<div class="msg warn">A sweep has the bus &mdash; watching is paused until it stops.</div>
</div>

<h2 class="sec">Reference</h2>
<div class="card"><div class="ref">
<div><div class="label">RPM</div><div class="value" id="rrpm">&mdash;</div></div>
<div><div class="label">Speed</div><div class="value" id="rspeed">&mdash;</div></div>
<div><div class="label">Coolant</div><div class="value" id="rcool">&mdash;</div></div>
<div><div class="label">Intake</div><div class="value" id="riat">&mdash;</div></div>
<div><div class="label">Load</div><div class="value" id="rload">&mdash;</div></div>
<div><div class="label">Throttle</div><div class="value" id="rthr">&mdash;</div></div>
</div></div>

<h2 class="sec">Watching</h2>
<div id="list"></div>
<div class="card" id="none">
<div style="color:var(--muted);font-size:14px">Nothing being watched. Pick identifiers
below &mdash; the ones the scanner found are listed for you.</div>
</div>

<h2 class="sec">Choose</h2>
<div class="card">
<div class="row">
<div><label for="per">Read one every</label>
<select id="per">
<option value="250">250 ms</option><option value="500">500 ms</option>
<option value="1000" selected>1 s</option><option value="2000">2 s</option>
<option value="5000">5 s</option></select></div>
<div style="flex:1;min-width:140px"><label for="man">Or type them</label>
<input type="text" id="man" class="full" placeholder="1002, 1003, T0140"></div>
</div>
<div class="pick" id="pick"></div>
<div class="row" style="margin-top:10px">
<button id="apply">Apply</button>
<button class="ghost" id="clear">Watch nothing</button>
</div>
<div class="msg" id="msg"></div>
<div class="hint" id="cost"></div>
<div class="hint">Each identifier is one more request on the bus, so watching costs
live refresh rate &mdash; the estimate above is for the transport in use. Readings
are appended to the trip CSV as two columns each: the bytes decoded big-endian, and
the raw bytes beside them, because two bytes might equally be one 16-bit value or
two 8-bit ones and nothing in the reply says which.
<br><br>
Changing the set starts a new CSV. The columns are fixed when a file is opened, and
shifting them halfway down a file would be worse than having two of them.</div>
</div>

</div>

<script>
const $=i=>document.getElementById(i);
const MAX_PTS=150;
let hist={}, age={}, sel=new Set(), hits=[], max=8, applied=false;

function spark(id,d,c){const e=$(id);if(!e||d.length<2)return;
const w=e.clientWidth||220,h=26,p=3;let lo=Math.min(...d),hi=Math.max(...d);
if(hi-lo<1e-6)hi=lo+1;const dx=w/(d.length-1);
const pts=d.map((v,i)=>`${(i*dx).toFixed(1)},${(p+(h-2*p)*(1-(v-lo)/(hi-lo))).toFixed(1)}`).join(' ');
e.setAttribute('viewBox',`0 0 ${w} ${h}`);
e.innerHTML=`<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`}

const num=(v,d,u)=>v==null||isNaN(v)?'&mdash;':(+v).toFixed(d)+(u?`<span class="unit">${u}</span>`:'');

function cost(){
 const p=+$('per').value, n=sel.size;
 if(!n){$('cost').textContent='';return}
 // A BLE exchange is roughly 165 ms on this adapter; direct CAN is far cheaper, so
 // quote the transport actually in use rather than a number that flatters one.
 const perRead=1000/p, budget=6.0;
 $('cost').textContent=`${n} identifier${n>1?'s':''} at one per ${p<1000?p+' ms':(p/1000)+' s'}`
  +` — about ${(100*perRead/budget).toFixed(0)}% of the bus over BLE, and each one`
  +` refreshes every ${((n*p)/1000).toFixed(1)} s.`}

function drawPick(){
 $('pick').innerHTML=hits.map(h=>{
  const k=(h.ecu==='TCM'?'T':'E')+h.did;
  return `<label class="${sel.has(k)?'on':''}"><input type="checkbox" data-k="${k}"
   ${sel.has(k)?'checked':''}>${k} <span style="color:var(--muted)">${h.hex.slice(0,8)}</span></label>`
 }).join('')||'<span style="color:var(--muted);font-size:13px">No scan results yet — run a sweep, or type identifiers above.</span>';
 for(const cb of $('pick').querySelectorAll('input')){
  cb.onchange=()=>{const k=cb.dataset.k;
   if(cb.checked){if(sel.size>=max){cb.checked=false;
     $('msg').className='msg err';$('msg').textContent=`At most ${max} at a time.`;return}
    sel.add(k)}else sel.delete(k);
   cb.parentElement.classList.toggle('on',cb.checked);cost()}}}

function render(j){
 max=j.max;
 $('scanning').style.display=j.scanning?'block':'none';
 const v=j.v||{};
 $('rrpm').innerHTML=num(v.rpm,0);          $('rspeed').innerHTML=num(v.speed,0,'km/h');
 $('rcool').innerHTML=num(v.coolant,0,'&deg;C'); $('riat').innerHTML=num(v.iat,0,'&deg;C');
 $('rload').innerHTML=num(v.load,1,'%');    $('rthr').innerHTML=num(v.throttle,1,'%');

 $('none').style.display=j.dids.length?'none':'block';
 // Rebuild only when the set changes; otherwise update in place, or the sparkline
 // elements are replaced every poll and never keep a history to draw.
 const key=j.dids.map(d=>d.name).join(',');
 if(key!==$('list').dataset.key){
  $('list').dataset.key=key;
  $('list').innerHTML=j.dids.map(d=>`<div class="w">
   <div class="wh"><span class="wn">${d.name}</span>
   <span class="wx">${d.ecu}</span>
   <span class="wv" id="v_${d.name}">&mdash;</span></div>
   <div class="wx" id="x_${d.name}">&nbsp;</div>
   <svg class="spark" id="s_${d.name}" preserveAspectRatio="none"></svg></div>`).join('');
  hist={};age={};
 }
 for(const d of j.dids){
  const ev=$('v_'+d.name), ex=$('x_'+d.name);
  if(!ev)continue;
  ev.textContent=d.len?d.val:'—';
  ev.classList.toggle('stale',!d.fresh);
  ex.textContent=d.len?`${d.hex} · ${d.len} byte${d.len>1?'s':''}${d.fresh?'':' · stale'}`
                      :'no reply yet';
  // One point per reading, not per poll. The page polls faster than an identifier
  // is read - it has to, since several share one round robin - so pushing on every
  // poll would draw each value four or five times over and turn a smooth trace into
  // a staircase that says more about the polling than about the car. A reading is
  // new when its age has dropped.
  if(d.len&&d.fresh){
   const a=hist[d.name]||(hist[d.name]=[]);
   if(!a.length||d.age<age[d.name]){a.push(d.val);if(a.length>MAX_PTS)a.shift()}
   spark('s_'+d.name,a,getComputedStyle(document.documentElement).getPropertyValue('--aqua').trim()||'#2ad3b3');
  }
  age[d.name]=d.age;
 }
 $('dot').className='dot '+(j.dids.length?(j.scanning?'stale':'live'):'');
 $('state').textContent=j.scanning?'paused — scanning'
   :(j.dids.length?`${j.dids.length} watched`:'idle');
}

async function poll(){
 try{
  const j=await(await fetch('/watch/list',{cache:'no-store'})).json();
  if(!applied){ // adopt what the board is already watching, once
   applied=true;
   sel=new Set(j.dids.map(d=>d.name));
   $('per').value=String(j.period);
   drawPick();cost();
  }
  render(j);
 }catch(e){$('state').textContent='ESP32 unreachable';$('dot').className='dot dead'}
}

async function apply(list){
 $('msg').className='msg';$('msg').textContent='applying…';
 try{
  const r=await(await fetch('/watch/set?period='+$('per').value+'&d='+encodeURIComponent(list),
                            {cache:'no-store'})).json();
  $('msg').className='msg ok';
  $('msg').textContent=r.changed?`Watching ${r.n}. A new trip CSV was started.`
                                :`Watching ${r.n}. Nothing changed.`;
  $('man').value='';
  hist={};age={};$('list').dataset.key='';
  poll();
 }catch(e){$('msg').className='msg err';$('msg').textContent='Could not reach the board.'}
}

$('apply').onclick=()=>{
 const typed=$('man').value.split(/[^0-9A-Fa-fTtEe]+/).filter(Boolean);
 for(const t of typed){if(sel.size<max)sel.add(t.toUpperCase().match(/^[ET]/)?t.toUpperCase():'E'+t.toUpperCase())}
 drawPick();cost();
 apply([...sel].join(','));
};
$('clear').onclick=()=>{sel.clear();drawPick();cost();apply('')};
$('per').onchange=cost;

// The scanner's results are the natural source of identifiers to watch, so they are
// offered as checkboxes rather than leaving you to copy hex off another page.
fetch('/scan/status',{cache:'no-store'}).then(r=>r.json()).then(j=>{
 hits=(j.hits||[]).slice(0,400);drawPick();
}).catch(()=>drawPick());

// The board has no clock of its own. Whichever page you open hands over the
// time, so anything it records carries a real timestamp.
fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
poll();setInterval(poll,700);
</script></body></html>)rawliteral";
