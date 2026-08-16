#pragma once
#include <pgmspace.h>
#include "ui_css.h"
#include "version.h"

// Bundle management and recovery, at http://192.168.4.1/ui
//
// This page is compiled into flash rather than served from the filesystem, on
// purpose: it is what you reach when the bundle is missing, half-uploaded or
// broken. A board in a car must not become unreachable because a deploy was
// interrupted, so the one page that can fix a bad deploy cannot itself depend on
// the deploy having worked. Same reasoning as the firmware update page.
static const char UI_ADMIN_HTML[] PROGMEM =
R"rawliteral(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Frontend</title>
<link rel="stylesheet" href="/ui.css?v=)rawliteral" FW_VERSION R"rawliteral(">
<style>
.f{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
table.files td:last-child{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>

<header>
<div class="bar"><h1>Frontend</h1>
<span class="sub">v)rawliteral" FW_VERSION R"rawliteral( &middot; bundle</span>
<div class="status"><span class="dot" id="dot"></span><span id="state">reading&hellip;</span></div></div>
<nav><a href="/">Live</a><a href="/monitors">Monitors</a><a href="/trips">Trips</a><a href="/watch">Watch</a><a href="/scan">Scanner</a><a href="/update">Firmware</a></nav>
</header>

<div class="wrap">

<div class="card">
<div class="label" style="margin:0 0 4px">Bundle storage</div>
<div class="bar2" style="margin:0"><i id="use"></i></div>
<div class="note" id="sz" style="margin-top:8px"></div>
<div class="hint">The dashboard can be served from a bundle built with an ordinary
frontend toolchain and uploaded here, instead of being compiled into the firmware.
Uploading one does not touch the firmware, and this page keeps working whatever
state the bundle is in &mdash; it is in flash, not in the bundle.
<br><br>
The filesystem is shared with trip logs, so the bundle is capped. Space it takes is
recording time you do not have.</div>
</div>

<div class="card">
<div class="label">Installed files</div>
<div class="tw"><table class="files"><tbody id="tb"></tbody></table></div>
<div id="none" class="note" style="display:none">No bundle installed &mdash; the
firmware is serving its own pages.</div>
</div>

<div class="card">
<div class="label" for="f">Upload bundle files</div>
<input type="file" id="f" multiple>
<div class="row" style="margin-top:10px">
<button id="go" disabled>Upload</button>
<button class="ghost" id="clr">Remove bundle</button>
</div>
<div class="bar2"><i id="prog"></i></div>
<div class="msg" id="msg"></div>
<div class="hint">The build emits one file, <code>index.html.gz</code>. Pick it and
upload &mdash; that is the whole frontend. Removing the bundle reverts to the page
built into the firmware, so this never leaves the board without a dashboard.</div>
</div>

</div>

<script>
const $=i=>document.getElementById(i);
const kb=b=>b>=1048576?(b/1048576).toFixed(2)+' MB':Math.round(b/1024)+' KB';

async function poll(){
 try{
  const j=await(await fetch('/ui/manifest',{cache:'no-store'})).json();
  $('dot').className='dot '+(j.installed?'live':'stale');
  $('state').textContent=j.installed?'bundle installed':'firmware pages';
  $('use').style.width=(j.max?Math.min(100,100*j.bytes/j.max):0).toFixed(1)+'%';
  $('sz').textContent=kb(j.bytes)+' of '+kb(j.max)+' budget · '+kb(j.free)+' free on the filesystem';
  $('tb').innerHTML=(j.files||[]).map(f=>
    `<tr><td class="f">${f.name}</td><td class="f">${kb(f.size)}</td></tr>`).join('');
  $('none').style.display=(j.files||[]).length?'none':'block';
 }catch(e){$('state').textContent='ESP32 unreachable';$('dot').className='dot dead'}
}

$('f').onchange=()=>{$('go').disabled=!$('f').files.length};

// One file per request. The board has a single-threaded web server and a modest
// heap; streaming several multipart uploads at once is how you get a failed deploy.
$('go').onclick=async()=>{
 const files=[...$('f').files];
 if(!files.length)return;
 $('go').disabled=true;$('msg').className='msg';
 for(let i=0;i<files.length;i++){
  $('msg').textContent=`Uploading ${files[i].name} (${i+1}/${files.length})…`;
  $('prog').style.width=(100*i/files.length).toFixed(0)+'%';
  const fd=new FormData();fd.append('f',files[i],files[i].name);
  try{
   const r=await fetch('/ui/upload',{method:'POST',body:fd});
   const j=await r.json();
   if(!j.ok){$('msg').className='msg err';
    $('msg').textContent=`${files[i].name}: ${j.error||'upload failed'}`;
    $('go').disabled=false;poll();return}
  }catch(e){$('msg').className='msg err';
   $('msg').textContent=`${files[i].name}: connection lost`;
   $('go').disabled=false;poll();return}
 }
 $('prog').style.width='100%';
 $('msg').className='msg ok';
 $('msg').textContent=`Uploaded ${files.length} file${files.length>1?'s':''}.`;
 $('go').disabled=false;poll();
};

$('clr').onclick=async()=>{
 if(!confirm('Remove the installed bundle? The firmware will serve its own pages.'))return;
 await fetch('/ui/clear',{cache:'no-store'});
 $('msg').className='msg';$('msg').textContent='Bundle removed.';
 $('prog').style.width='0';poll();
};

fetch('/time?ms='+Date.now(),{cache:'no-store'}).catch(()=>{});
poll();setInterval(poll,5000);
</script></body></html>)rawliteral";
