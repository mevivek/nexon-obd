#pragma once

// The shell every page shares: palette, header, nav, tiles, tables, controls.
//
// A macro rather than a served stylesheet so the pages stay single-request and
// cannot drift apart - each page concatenates this into its own PROGMEM literal at
// compile time. Costs ~2.5 KB of flash per page, which is nothing at 35 % used.
//
// Dark-committed on purpose: this is an in-car display that is never viewed on a
// light background. Status colour is always paired with an icon or text, so nothing
// depends on colour alone.

#define UI_CSS R"css(
:root{
--plane:#0b0b0c;--surface:#151517;--raised:#1d1d21;
--ink:#f6f6f5;--ink2:#bab9b4;--muted:#86857f;
--grid:#26262a;--base:#34343b;--ring:rgba(255,255,255,.08);
--blue:#4b9bff;--orange:#ff7a45;--aqua:#2ad3b3;--yellow:#e0a020;
--good:#2fbf5f;--warning:#f5a623;--critical:#ef4b4b;
color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:0 0 32px;background:var(--plane);color:var(--ink);
-webkit-font-smoothing:antialiased;
font:400 15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:0 12px}

/* header ---------------------------------------------------------------- */
header{position:sticky;top:0;z-index:5;margin-bottom:12px;padding:9px 12px 0;
background:rgba(11,11,12,.94);border-bottom:1px solid var(--grid)}
@supports (backdrop-filter:blur(1px)){header{backdrop-filter:blur(10px)}}
.bar{display:flex;align-items:center;gap:9px;max-width:1100px;margin:0 auto}
h1{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em;white-space:nowrap}
.sub{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;
text-overflow:ellipsis;min-width:0}
/* The subtitle carries the firmware version on every page, so it stays visible at
   phone width and is dropped only when there is genuinely no room for it. */
@media(max-width:360px){.sub{display:none}}
.status{margin-left:auto;display:flex;align-items:center;gap:6px;flex:none;
font-size:12px;color:var(--ink2);background:var(--surface);
border:1px solid var(--ring);border-radius:999px;padding:4px 9px;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
.dot.live{background:var(--good)}
.dot.stale{background:var(--warning)}
.dot.dead{background:var(--critical)}
nav{display:flex;gap:3px;max-width:1100px;margin:7px auto 0;overflow-x:auto;
scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav a{color:var(--ink2);font-size:13px;text-decoration:none;white-space:nowrap;
padding:7px 11px;border-radius:8px 8px 0 0;border-bottom:2px solid transparent}
nav a.on{color:var(--ink);background:var(--surface);border-bottom-color:var(--blue)}

/* section headings ------------------------------------------------------ */
h2.sec{margin:16px 0 7px;font-size:11px;font-weight:650;text-transform:uppercase;
letter-spacing:.09em;color:var(--muted)}

/* tiles ----------------------------------------------------------------- */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));gap:8px}
.tile{display:flex;flex-direction:column;min-width:0;overflow:hidden;
background:var(--surface);border:1px solid var(--ring);border-radius:12px;
padding:10px 12px}
.label{margin-bottom:5px;font-size:10px;font-weight:600;text-transform:uppercase;
letter-spacing:.08em;color:var(--muted);white-space:nowrap;overflow:hidden;
text-overflow:ellipsis}
.value{font-size:26px;font-weight:650;line-height:1.05;letter-spacing:-.02em;
font-variant-numeric:tabular-nums}
.value .unit{margin-left:3px;font-size:12px;font-weight:400;letter-spacing:0;
color:var(--ink2)}
.value.warn{color:var(--warning)}
.value.crit{color:var(--critical)}
/* A held reading - shown because the poll that carries it came back empty. */
.stale{opacity:.4}
.note{margin-top:3px;font-size:11px;color:var(--muted);
font-variant-numeric:tabular-nums}
/* Always occupies its line, so a warning appearing cannot reflow the page and
   shuffle every tile under the driver's eye. */
.flag{margin-top:4px;min-height:14px;font-size:11px;line-height:1.25;
visibility:hidden}
.flag.on{visibility:visible}
.flag.warn{color:var(--warning)}
.flag.crit{color:var(--critical)}
/* Sinks to the bottom of the tile, so tiles sharing a grid row line their
   sparklines up on a common baseline instead of floating mid-card. */
.spark{display:block;width:calc(100% + 24px);height:26px;margin:7px -12px -10px;
margin-top:auto;padding-top:7px}

/* tables ---------------------------------------------------------------- */
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px}
caption{padding-bottom:7px;text-align:left;font-size:10px;font-weight:600;
text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
th,td{padding:6px 10px 6px 0;text-align:left;border-bottom:1px solid var(--grid);
vertical-align:top}
th{color:var(--muted);font-weight:500}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;
white-space:nowrap}
/* Only payload columns may break mid-token; an identifier split across two lines
   as "F18 / A" is unreadable. */
td.brk{white-space:normal;word-break:break-all}

/* disclosure ------------------------------------------------------------ */
details{margin-top:10px;background:var(--surface);border:1px solid var(--ring);
border-radius:12px;padding:10px 12px}
summary{cursor:pointer;font-size:12px;font-weight:600;text-transform:uppercase;
letter-spacing:.08em;color:var(--ink2);list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"\25B8";display:inline-block;margin-right:7px;
color:var(--muted);transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
details>.tiles,details>.tw{margin-top:10px}

/* controls -------------------------------------------------------------- */
.card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;
padding:13px 14px;margin-bottom:10px}
.row{display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap}
label{display:block;margin-bottom:4px;font-size:10px;font-weight:600;
text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
select,input{background:var(--raised);color:var(--ink);border:1px solid var(--base);
border-radius:8px;padding:8px 10px;font:inherit;font-size:14px}
input[type=text]{width:92px;font-variant-numeric:tabular-nums}
input[type=file]{width:100%;padding:10px 0;border:0;background:none;color:var(--ink2)}
button{background:var(--blue);color:#04121f;border:0;border-radius:8px;
padding:9px 16px;font:inherit;font-weight:650;cursor:pointer}
button.ghost{background:transparent;color:var(--ink2);border:1px solid var(--base)}
button:disabled{background:var(--base);color:var(--muted);cursor:not-allowed}
/* A locked control has to look locked, or it reads as unresponsive rather than
   deliberately unavailable. */
select:disabled,input:disabled{opacity:.45;cursor:not-allowed}
.bar2{height:6px;margin-top:12px;background:var(--base);border-radius:3px;
overflow:hidden}
.bar2>i{display:block;height:100%;width:0;background:var(--blue);transition:width .2s}
.meta{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:13px;
color:var(--ink2);font-variant-numeric:tabular-nums}
.meta b{color:var(--ink);font-weight:650}
.msg{margin-top:11px;font-size:14px}
.msg.ok{color:var(--good)}.msg.err{color:var(--critical)}.msg.warn{color:var(--warning)}
.hint{margin-top:10px;font-size:12px;line-height:1.6;color:var(--muted)}
code{background:var(--raised);border-radius:5px;padding:1px 5px;font-size:12px}
)css"
