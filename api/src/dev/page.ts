// The /dev/owner and /dev/customer chat screens (development only), styled after the WhatsApp
// mobile app. Plain HTML + JS, no build step. The client script avoids template literals and
// backslashes so it can live inside this template string.
// commands: the "/" list (name + hint) WhatsApp shows for this number; iceBreakers: the starter
// questions on a brand-new chat. Both come from the owner action registry (bots/actions.ts).
export interface ChatPageConfig { role: 'owner' | 'customer'; botNumber: string; title: string; subtitle: string; defaultPhone: string; boot?: string; photoUrl?: string; commands?: { name: string; hint: string }[]; iceBreakers?: string[] }

const ICON = {
  back: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 4l1.4 1.4L7.8 11H20v2H7.8l5.6 5.6L12 20l-8-8z"/></svg>',
  video: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
  call: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
  emoji: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 17.5a5.5 5.5 0 0 0 5.1-3.5H6.9a5.5 5.5 0 0 0 5.1 3.5z"/></svg>',
  clip: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 9a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8-3h-3.2l-1.8-2H9L7.2 6H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.9V22h2v-3.1a7 7 0 0 0 6-6.9z"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 13h2v-2H3zm0 4h2v-2H3zm0-8h2V7H3zm4 4h14v-2H7zm0 4h14v-2H7zM7 7v2h14V7z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
};

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export function chatPage(cfg: ChatPageConfig) {
  const initial = cfg.title.charAt(0).toUpperCase();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b141a" media="(prefers-color-scheme: dark)">
<title>${cfg.role === 'owner' ? 'Owner chat' : 'Customer chat'}</title>
<style>
:root {
  --bar: #ffffff; --bar-ink: #111b21; --bar-sub: #667781; --wall: #efeae2; --doodle: rgba(0,0,0,.035);
  --in: #ffffff; --out: #d9fdd3; --ink: #111b21; --meta: #667781; --tick: #53bdeb; --link: #027eb5;
  --btn: #0b8de0; --sep: rgba(0,0,0,.08); --chip: #ffffff; --chip-ink: #54656f; --field: #ffffff;
  --green: #25d366; --green-ink: #ffffff; --sheet: #ffffff; --shadow: 0 1px .5px rgba(11,20,26,.13); --menu: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root { --bar: #1f2c34; --bar-ink: #e9edef; --bar-sub: #8696a0; --wall: #0b141a; --doodle: rgba(255,255,255,.025);
    --in: #1f2c34; --out: #005c4b; --ink: #e9edef; --meta: #8696a0; --link: #53bdeb; --btn: #53bdeb; --sep: rgba(255,255,255,.08);
    --chip: #1f2c34; --chip-ink: #8696a0; --field: #1f2c34; --green: #00a884; --green-ink: #0b141a; --sheet: #1f2c34; --menu: #233138; }
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; margin: 0; }
body { font: 15.5px/1.35 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--ink); background: var(--wall); overflow: hidden; }
.screen { height: 100dvh; display: flex; flex-direction: column; max-width: 560px; margin: 0 auto; position: relative; overflow: clip; background: var(--wall);
  background-image: radial-gradient(var(--doodle) 1.2px, transparent 1.3px), radial-gradient(var(--doodle) 1.2px, transparent 1.3px);
  background-size: 22px 22px; background-position: 0 0, 11px 11px; }
header { display: flex; align-items: center; gap: 6px; padding: 8px 4px 8px 4px; padding-top: max(8px, env(safe-area-inset-top)); background: var(--bar); color: var(--bar-ink); box-shadow: 0 1px 0 var(--sep); z-index: 2; }
header button { background: none; border: 0; color: inherit; padding: 8px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; }
.avatar { width: 38px; height: 38px; border-radius: 50%; background: #00a884; color: #fff; display: grid; place-items: center; font-weight: 600; font-size: 17px; flex: none; }
.peer { flex: 1; min-width: 0; padding-left: 4px; }
.peer b { display: block; font-weight: 500; font-size: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.peer small { display: block; color: var(--bar-sub); font-size: 13px; }
.peer small.typing { color: var(--green); }
#log { flex: 1; overflow-y: auto; padding: 8px 4% 10px; display: flex; flex-direction: column; }
.day { align-self: center; background: var(--chip); color: var(--chip-ink); font-size: 12.5px; padding: 5px 12px; border-radius: 8px; margin: 6px 0 10px; box-shadow: var(--shadow); text-transform: uppercase; }
.notice { align-self: center; max-width: 88%; text-align: center; background: var(--chip); color: var(--chip-ink); font-size: 12.5px; padding: 6px 12px; border-radius: 8px; margin-bottom: 10px; box-shadow: var(--shadow); }
.group { display: flex; flex-direction: column; max-width: 82%; margin-top: 2px; }
.group.me { align-self: flex-end; }
.group.them { align-self: flex-start; }
.group.first { margin-top: 8px; }
.bubble { position: relative; padding: 6px 8px 7px 9px; border-radius: 8px; box-shadow: var(--shadow); white-space: pre-wrap; overflow-wrap: anywhere; }
.me .bubble { background: var(--out); }
.them .bubble { background: var(--in); }
.first.me .bubble { border-top-right-radius: 0; }
.first.them .bubble { border-top-left-radius: 0; }
.first.me .bubble::before, .first.them .bubble::before { content: ""; position: absolute; top: 0; width: 8px; height: 13px; }
.first.me .bubble::before { right: -8px; background: linear-gradient(to bottom left, var(--out) 50%, transparent 50%); }
.first.them .bubble::before { left: -8px; background: linear-gradient(to bottom right, var(--in) 50%, transparent 50%); }
.bubble a { color: var(--link); }
.bubble .react { position: absolute; right: 6px; bottom: -14px; background: var(--sheet, #fff); border-radius: 12px; padding: 1px 5px; font-size: 14px; line-height: 18px; box-shadow: var(--shadow); }
.group.reacted { margin-bottom: 14px; }
.bubble img { display: block; max-width: 100%; border-radius: 6px; margin: -2px -4px 4px; }
.meta { float: right; margin: 6px 0 -4px 10px; font-size: 11px; color: var(--meta); display: inline-flex; align-items: center; gap: 3px; position: relative; top: 4px; }
.meta svg { color: var(--tick); }
.quick { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.quick button, .listbtn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; border: 0; background: var(--in); color: var(--btn); font: inherit; font-size: 15px; font-weight: 500; padding: 10px; border-radius: 8px; box-shadow: var(--shadow); cursor: pointer; }
.group.wide { max-width: 100%; }
.group.wide .bubble { max-width: 82%; align-self: flex-start; }
.carousel { display: flex; gap: 8px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 6px 2px 8px; margin-top: 2px; scrollbar-width: none; }
.carousel::-webkit-scrollbar { display: none; }
.card { flex: 0 0 68%; max-width: 250px; scroll-snap-align: start; background: var(--in); border-radius: 10px; box-shadow: var(--shadow); overflow: hidden; display: flex; flex-direction: column; }
.card img { display: block; width: 100%; aspect-ratio: 1 / 1; object-fit: cover; background: var(--chip); }
.card .t { padding: 8px 10px 6px; white-space: pre-wrap; overflow-wrap: anywhere; flex: 1; font-size: 14.5px; }
.cbtns { display: flex; flex-direction: column; border-top: 1px solid var(--sep); }
.cbtns button { display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; background: transparent; color: var(--btn); font: inherit; font-size: 14.5px; font-weight: 500; padding: 9px; cursor: pointer; }
.cbtns button + button { border-top: 1px solid var(--sep); }
.avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
a.listbtn { text-decoration: none; }
.listbtn { border-top: 1px solid var(--sep); border-radius: 0 0 8px 8px; box-shadow: none; margin: 7px -8px -7px -9px; width: calc(100% + 17px); background: transparent; }
footer { display: flex; align-items: flex-end; gap: 6px; padding: 6px 6px 8px; padding-bottom: max(8px, env(safe-area-inset-bottom)); }
.field { flex: 1; display: flex; align-items: center; gap: 2px; background: var(--field); border-radius: 24px; padding: 4px 6px; box-shadow: var(--shadow); min-height: 48px; }
.field svg { color: var(--meta); flex: none; }
.field .ic { background: none; border: 0; padding: 6px; display: grid; place-items: center; cursor: default; color: var(--meta); }
.field button.ic { cursor: pointer; }
.doc { display: flex; align-items: center; gap: 10px; background: rgba(0,0,0,.06); border-radius: 6px; padding: 10px; margin: -2px -4px 4px; min-width: 220px; }
.doc .badge { width: 34px; height: 40px; border-radius: 4px; background: #e5534b; color: #fff; font-size: 10px; font-weight: 700; display: grid; place-items: center; flex: none; }
.doc a { color: var(--ink); text-decoration: none; word-break: break-all; }
#text { flex: 1; border: 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 16.5px; padding: 8px 4px; min-width: 0; }
#text::placeholder { color: var(--meta); }
#fab { width: 48px; height: 48px; border-radius: 50%; border: 0; background: var(--green); color: var(--green-ink); display: grid; place-items: center; box-shadow: var(--shadow); cursor: pointer; flex: none; }
.cmds { position: absolute; left: 8px; right: 8px; bottom: 64px; max-height: 50%; overflow-y: auto; background: var(--menu); border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.25); z-index: 5; display: none; }
.cmds.open { display: block; }
.cmds button { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--ink); padding: 10px 16px; font: inherit; cursor: pointer; border-bottom: 1px solid var(--sep); }
.cmds button b { color: var(--green); font-weight: 500; }
.cmds button small { display: block; color: var(--meta); font-size: 13px; margin-top: 2px; }
.cmds button.on, .cmds button:hover { background: var(--sep); }
.debug { align-self: center; max-width: 92%; margin: 6px 0; padding: 6px 10px; border-radius: 8px; background: rgba(120,120,120,.12); color: #667; font: 11px/1.4 ui-monospace, monospace; white-space: pre-wrap; }
.ice { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 12px; }
.ice button { border: 1px solid var(--green); color: var(--green); background: var(--sheet); border-radius: 18px; padding: 8px 16px; font: inherit; font-size: 14px; cursor: pointer; }
.doc { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border-radius: 8px; background: var(--sep); color: var(--ink); text-decoration: none; font-size: 14px; }
.empty { margin: auto 0; align-self: center; text-align: center; color: var(--meta); font-size: 14px; max-width: 280px; }
.scrim { position: absolute; inset: 0; background: rgba(0,0,0,.4); display: none; z-index: 5; }
.scrim.open { display: block; }
.sheet { position: absolute; left: 0; right: 0; bottom: 0; max-height: 80%; display: flex; flex-direction: column; background: var(--sheet); border-radius: 16px 16px 0 0; transform: translateY(105%); visibility: hidden; transition: transform .22s ease, visibility 0s .22s; z-index: 6; }
.sheet.open { transform: none; visibility: visible; transition: transform .22s ease; }
.sheet header { box-shadow: none; background: transparent; border-bottom: 1px solid var(--sep); }
.sheet h2 { flex: 1; text-align: center; margin: 0 40px 0 0; font-size: 16px; font-weight: 500; }
.sheet .section { padding: 14px 20px 6px; color: var(--green); font-size: 14px; }
.rows { overflow-y: auto; padding-bottom: 80px; }
.row { display: flex; align-items: center; gap: 12px; padding: 12px 20px; cursor: pointer; }
.row .txt { flex: 1; }
.row .txt small { display: block; color: var(--meta); font-size: 13.5px; margin-top: 2px; }
.radio { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--meta); flex: none; }
.row.sel .radio { border-color: var(--green); box-shadow: inset 0 0 0 4px var(--sheet); background: var(--green); }
.sheet #sheetSend { position: absolute; right: 18px; bottom: 18px; display: none; }
.sheet #sheetSend.show { display: grid; }
.menu { position: absolute; top: 52px; right: 8px; background: var(--menu); border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.2); padding: 6px 0; z-index: 7; display: none; min-width: 230px; }
.menu.open { display: block; }
.menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--ink); font: inherit; padding: 12px 20px; cursor: pointer; }
.menu label.name { display: block; padding: 10px 20px; color: var(--meta); font-size: 13px; border-bottom: 1px solid var(--sep); }
.menu label.name input { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; border: 1px solid var(--sep); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; box-sizing: border-box; }
.menu .info { padding: 8px 20px 10px; color: var(--meta); font-size: 13px; border-bottom: 1px solid var(--sep); margin-bottom: 4px; }
</style>
</head>
<body>
<div class="screen">
  <header>
    <button aria-label="Back" tabindex="-1">${ICON.back}</button>
    <div class="avatar" id="avatar">${cfg.photoUrl ? `<img src="${cfg.photoUrl}" alt="">` : initial}</div>
    <div class="peer"><b id="title">${cfg.title}</b><small id="sub">${cfg.subtitle}</small></div>
    <button aria-label="Video call" tabindex="-1">${ICON.video}</button>
    <button aria-label="Voice call" tabindex="-1">${ICON.call}</button>
    <button aria-label="Menu" id="menuBtn">${ICON.more}</button>
  </header>
  <div class="menu" id="menu">
    <div class="info" id="me"></div>
    <label class="name">Your WhatsApp profile name<input id="pname" maxlength="40" placeholder="e.g. your first name" autocomplete="off"></label>
    <button id="clear">Clear chat</button>
    <button id="fresh">${cfg.role === 'owner' ? 'Start as a new business owner' : 'Start as a new customer'}</button>
  </div>
  <div id="log"></div>
  <div class="cmds" id="cmds" role="listbox" aria-label="Commands"></div>
  <footer>
    <div class="field">
      <span class="ic">${ICON.emoji}</span>
      <input id="text" placeholder="Message" autocomplete="off" enterkeyhint="send">
      <button class="ic" id="clip" type="button" aria-label="Attach a file">${ICON.clip}</button>
      <button class="ic" id="cam" type="button" aria-label="Send a photo">${ICON.camera}</button>
      <input type="file" id="fileIn" accept="application/pdf,image/*,text/plain,text/csv,.csv,.txt" hidden>
      <input type="file" id="photoIn" accept="image/*" hidden>
    </div>
    <button id="fab" aria-label="Send">${ICON.mic}</button>
  </footer>
  <div class="scrim" id="scrim"></div>
  <div class="sheet" id="sheet">
    <header><button id="sheetClose" aria-label="Close">${ICON.close}</button><h2 id="sheetTitle"></h2></header>
    <div class="rows" id="rows"></div>
    <button id="sheetSend" class="fab-like" aria-label="Send" style="width:56px;height:56px;border-radius:50%;border:0;background:var(--green);color:var(--green-ink);place-items:center;box-shadow:0 2px 6px rgba(0,0,0,.25);cursor:pointer">${ICON.send}</button>
  </div>
</div>
<script>
(function () {
  var CFG = ${json(cfg)};
  var ICON = ${json({ ticks: '<svg viewBox="0 0 16 11" width="16" height="11"><path fill="currentColor" d="M11.1.3 4.8 7.5 2.3 5 1.2 6.1l3.7 3.6L12.2 1.4zm3.6 0L8.4 7.5l-.8-.8-1.1 1.1 1.9 1.9L15.8 1.4z"/></svg>', reply: ICON.reply, list: ICON.list, mic: ICON.mic, send: ICON.send, link: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3zm5 16H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2z"/></svg>' })};
  var KEY = 'relay.chat.' + CFG.role + '.phone';
  var $ = function (id) { return document.getElementById(id); };
  var state = { count: -1, waiting: false, waitTimer: null, sheet: null, selected: null, noShop: null };

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function store(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode: this tab only */ } }
  var NAME_KEY = 'relay.chat.' + CFG.role + '.name';
  function profile() { var v = read(NAME_KEY); return v ? v : undefined; }
  function newPhone() { var n = '23480'; for (var i = 0; i < 8; i++) n += Math.floor(Math.random() * 10); return n; }
  // The owner tab is always a new business owner until signup is done; the customer tab is a customer.
  var phone = read(KEY) || (CFG.role === 'owner' ? newPhone() : CFG.defaultPhone);
  store(phone);
  var bot = CFG.botNumber;   // the customer tab learns its shop from the owner tab (see findShop)
  var title = CFG.title;
  function showMe() { $('me').textContent = 'You are +' + phone + (CFG.role === 'owner' ? ' (business owner)' : ' (customer)'); }
  showMe();
  function setTitle(t, photo) {
    title = t; $('title').textContent = t;
    var av = $('avatar'); av.innerHTML = '';
    if (photo) { var im = el('img'); im.src = photo; im.alt = ''; av.appendChild(im); } else av.textContent = t.charAt(0).toUpperCase();
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function html(tag, cls, markup) { var e = el(tag, cls); e.innerHTML = markup; return e; }
  function hhmm(at) { return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase(); }

  // Text with clickable links and WhatsApp *bold*, built without innerHTML so bot text can never
  // inject markup.
  function linkify(parent, text) {
    String(text).split(/(https?:[^\\s<>"]+)/g).forEach(function (part, i) {
      if (i % 2) { var a = el('a', null, part); a.href = part; a.target = '_blank'; a.rel = 'noopener'; parent.appendChild(a); }
      else if (part) parent.appendChild(document.createTextNode(part));
    });
  }
  function richText(parent, text) {
    var parts = String(text).split('*');
    var paired = parts.length % 2 === 1 ? parts.length : parts.length - 1;
    parts.forEach(function (part, i) {
      if (i % 2 === 1 && i < paired - 1 && part && part.indexOf(String.fromCharCode(10)) < 0) { var b = el('b'); linkify(b, part); parent.appendChild(b); }
      else linkify(parent, (i % 2 === 1 ? '*' : '') + part + (i % 2 === 1 && !(i < paired - 1) ? '' : ''));
    });
  }

  function options(c) {
    var i = c.interactive || {}, a = i.action || {};
    if (i.type === 'button') return { kind: 'button', items: (a.buttons || []).map(function (b) { return { id: b.reply.id, title: b.reply.title }; }) };
    if (i.type === 'list') return { kind: 'list', label: a.button || 'Options', sections: (a.sections || []).map(function (s) { return { title: s.title, rows: s.rows || [] }; }) };
    return null;
  }

  function meta(m, mine) {
    var s = el('span', 'meta', hhmm(m.at));
    if (mine) s.appendChild(html('span', null, ICON.ticks));
    return s;
  }

  function bubble(m, first) {
    // The agent's debug note (development only): small and grey, between the messages.
    if (m.direction === 'debug') { var dbg = el('div', 'debug'); dbg.textContent = (m.content && m.content.text) || ''; return dbg; }
    var mine = m.direction === 'in', c = m.content || {};
    var g = el('div', 'group ' + (mine ? 'me' : 'them') + (first ? ' first' : ''));
    var b = el('div', 'bubble');
    var opts = c.type === 'interactive' ? options(c) : null;
    if (c.type === 'text') richText(b, c.text);
    else if (c.type === 'image') { var img = el('img'); img.src = c.link; img.alt = ''; b.appendChild(img); if (c.caption) richText(b, c.caption); }
    else if (c.type === 'document') {
      var d = el('div', 'doc'), ext = String(c.filename || '').split('.').pop().toUpperCase().slice(0, 4) || 'FILE';
      d.appendChild(el('span', 'badge', ext));
      var a = el('a', null, c.filename || 'File'); a.href = c.link; a.target = '_blank'; a.rel = 'noopener'; d.appendChild(a);
      b.appendChild(d); if (c.caption) richText(b, c.caption);
    }
    else if (c.type === 'template') richText(b, 'Template: ' + c.name);
    else if (c.type === 'interactive') {
      var i = c.interactive || {};
      if (i.header && i.header.type === 'image' && i.header.image) { var hi = el('img'); hi.src = i.header.image.link; hi.alt = ''; b.appendChild(hi); }
      if (i.header && i.header.type === 'document' && i.header.document) { var dl = el('a', 'doc', '📄 ' + (i.header.document.filename || 'Document')); dl.href = i.header.document.link; dl.target = '_blank'; dl.rel = 'noopener'; b.appendChild(dl); }
      if (i.header && i.header.text) { var h = el('b', null, i.header.text); b.appendChild(h); b.appendChild(document.createTextNode(String.fromCharCode(10))); }
      richText(b, (i.body && i.body.text) || '');
      if (i.footer && i.footer.text) { b.appendChild(document.createTextNode(String.fromCharCode(10))); b.appendChild(el('small', null, i.footer.text)); }
    }
    b.appendChild(meta(m, mine));
    // A link button ("Pay ₦3,030"): opens in the browser, like WhatsApp does.
    var cta = c.type === 'interactive' && c.interactive && c.interactive.type === 'cta_url' && c.interactive.action ? c.interactive.action.parameters : null;
    if (cta) {
      var ab = html('a', 'listbtn', ICON.link);
      ab.appendChild(document.createTextNode(cta.display_text || 'Open'));
      ab.href = cta.url; ab.target = '_blank'; ab.rel = 'noopener';
      b.appendChild(ab);
    }
    if (opts && opts.kind === 'list') {
      var lb = html('button', 'listbtn', ICON.list);
      lb.appendChild(document.createTextNode(opts.label));
      lb.onclick = function () { openSheet(opts); };
      b.appendChild(lb);
    }
    g.appendChild(b);
    // Carousel: the cards sit under the message and swipe sideways, like WhatsApp.
    var ci = c.type === 'interactive' && c.interactive && c.interactive.type === 'carousel' ? c.interactive : null;
    if (ci) {
      g.classList.add('wide');
      var row = el('div', 'carousel');
      ((ci.action && ci.action.cards) || []).forEach(function (card) {
        var cd = el('div', 'card');
        var im = el('img'); im.src = (card.header && card.header.image && card.header.image.link) || ''; im.alt = ''; im.loading = 'lazy'; cd.appendChild(im);
        var t = el('div', 't'); richText(t, (card.body && card.body.text) || ''); cd.appendChild(t);
        var bs = el('div', 'cbtns');
        ((card.action && card.action.buttons) || []).forEach(function (bt) {
          var r = bt.quick_reply || {};
          var cb = html('button', null, ICON.reply); cb.appendChild(document.createTextNode(r.title || ''));
          cb.onclick = function () { send(null, { id: r.id, title: r.title, kind: 'button' }); };
          bs.appendChild(cb);
        });
        cd.appendChild(bs);
        row.appendChild(cd);
      });
      // A mouse wheel scrolls the cards sideways (touch and trackpads already swipe).
      row.addEventListener('wheel', function (e) { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
      g.appendChild(row);
    }
    if (opts && opts.kind === 'button') {
      var q = el('div', 'quick');
      opts.items.forEach(function (o) {
        var qb = html('button', null, ICON.reply);
        qb.appendChild(document.createTextNode(o.title));
        qb.onclick = function () { send(null, { id: o.id, title: o.title, kind: 'button' }); };
        q.appendChild(qb);
      });
      g.appendChild(q);
    }
    return g;
  }

  function render(list) {
    var log = $('log'); log.innerHTML = '';
    log.appendChild(el('div', 'day', 'Today'));
    log.appendChild(el('div', 'notice', 'This business uses a secure service from Meta to manage this chat. Test mode: nothing is sent to a real phone.'));
    if (!list.length) {
      if (!bot && CFG.role === 'customer') { log.appendChild(el('p', 'empty', state.noShop || 'Looking for your shop…')); return; }
      log.appendChild(el('p', 'empty', 'Say "hi" to ' + title + '.'));
      // Ice breakers: tap one to start, like on a brand-new WhatsApp chat.
      if ((CFG.iceBreakers || []).length) {
        var ice = el('div', 'ice');
        CFG.iceBreakers.forEach(function (q) { var ib = el('button', null, q); ib.type = 'button'; ib.onclick = function () { send(q); }; ice.appendChild(ib); });
        log.appendChild(ice);
      }
      return;
    }
    var reactions = {}, lastTyping = null, lastOut = null, shown = [];
    list.forEach(function (m) {
      var t = m.content && m.content.type;
      if (t === 'reaction') reactions[m.content.messageId] = m.content.emoji;
      else if (t === 'typing') lastTyping = m;
      else { shown.push(m); if (m.direction === 'out') lastOut = m; }
    });
    var prev = null;
    shown.forEach(function (m) {
      var g = bubble(m, !prev || prev.direction !== m.direction);
      var emoji = m.messageId && reactions[m.messageId];
      if (emoji) { var b = g.querySelector('.bubble'); if (b) { b.appendChild(el('span', 'react', emoji)); g.classList.add('reacted'); } }
      log.appendChild(g); prev = m;
    });
    log.scrollTop = log.scrollHeight;
    // "typing…" from the server: after the latest reply, for up to 25 seconds (as on WhatsApp).
    var since = lastTyping ? Date.now() - new Date(lastTyping.at).getTime() : Infinity;
    if (lastTyping && (!lastOut || lastTyping.at > lastOut.at) && since < 25000) typing(true, 25000 - since);
    else if (lastOut && (!lastTyping || lastOut.at >= lastTyping.at)) typing(false);
  }

  function typing(on, ms) {
    state.waiting = on;
    clearTimeout(state.waitTimer);
    $('sub').textContent = on ? 'typing…' : CFG.subtitle;
    $('sub').className = on ? 'typing' : '';
    if (on) state.waitTimer = setTimeout(function () { typing(false); }, ms || 25000);
  }

  // Customer tab: the shop belongs to whoever is signing up in the owner tab (same browser).
  function findShop() {
    var owner = read('relay.chat.owner.phone');
    if (!owner) { noShop('No shop yet. Open the owner chat and sign up a business first.'); return; }
    fetch('/dev/shop?owner=' + owner).then(function (r) { return r.json(); }).then(function (res) {
      if (res.shop) {
        if (bot !== res.shop.botNumber || res.shop.photoUrl !== state.photo) { state.photo = res.shop.photoUrl; bot = res.shop.botNumber; state.count = -1; state.noShop = null; setTitle(res.shop.name, res.shop.photoUrl); $('text').disabled = false; render([]); poll(); }
        return;
      }
      bot = '';
      noShop(res.reason === 'not_connected'
        ? res.name + ' isn\\'t connected yet. In the owner chat, finish signup and open the connect link (it has a test-mode button).'
        : 'No shop yet. Open the owner chat and sign up a business first.');
    }).catch(function () {});
  }
  function noShop(msg) { if (state.noShop === msg) return; state.noShop = msg; setTitle('Shop'); $('text').disabled = true; state.count = -1; render([]); }

  function poll() {
    var p = phone;
    if (!bot) return;
    fetch('/dev/messages?phone=' + p + '&bot=' + encodeURIComponent(bot)).then(function (r) { return r.json(); }).then(function (list) {
      if (p !== phone) return;
      if (list.length !== state.count) {
        var grew = list.length > state.count && state.count >= 0;
        state.count = list.length; render(list);
      }
    }).catch(function () {});
  }

  function send(text, choice) {
    if ((!choice && !text) || !bot) return;
    fetch('/dev/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botNumber: bot, phone: phone, text: text, choice: choice, name: profile() }) })
      .then(function () { poll(); })
      .catch(function () { alertNote('Could not reach the local server. Is npm run dev running?'); });
    $('text').value = ''; fab();
  }

  function alertNote(t) { var log = $('log'); log.appendChild(el('div', 'notice', t)); log.scrollTop = log.scrollHeight; }

  function openSheet(opts) {
    state.sheet = opts; state.selected = null;
    $('sheetTitle').textContent = opts.label;
    var rows = $('rows'); rows.innerHTML = '';
    opts.sections.forEach(function (s) {
      if (s.title) rows.appendChild(el('div', 'section', s.title));
      s.rows.forEach(function (r) {
        var row = el('div', 'row'), txt = el('div', 'txt', r.title);
        if (r.description) txt.appendChild(el('small', null, r.description));
        row.appendChild(txt); row.appendChild(el('span', 'radio'));
        row.onclick = function () {
          Array.prototype.forEach.call(rows.querySelectorAll('.row'), function (x) { x.classList.remove('sel'); });
          row.classList.add('sel'); state.selected = r; $('sheetSend').classList.add('show');
        };
        rows.appendChild(row);
      });
    });
    $('sheetSend').classList.remove('show');
    $('scrim').classList.add('open'); $('sheet').classList.add('open');
  }
  function closeSheet() { $('scrim').classList.remove('open'); $('sheet').classList.remove('open'); }

  function fab() { $('fab').innerHTML = $('text').value.trim() ? ICON.send : ICON.mic; }
  function post(path, body) { return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); }); }
  function switchTo(p) { phone = p; store(p); showMe(); state.count = -1; typing(false); render([]); if (CFG.role === 'customer') findShop(); poll(); }

  // 📎 / 📷: the file goes up like a WhatsApp attachment; whatever is typed becomes its caption.
  function upload(file) {
    if (!file || !bot) return;
    if (file.size > 15000000) { alertNote('That file is over 15 MB.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var data = String(reader.result).split(',')[1] || '';
      var caption = $('text').value.trim();
      $('text').value = ''; fab();
      post('/dev/upload', { botNumber: bot, phone: phone, name: profile(), filename: file.name, mimeType: file.type || 'application/octet-stream', data: data, caption: caption })
        .then(function (res) { if (!res.success) alertNote('Upload failed: ' + ((res.error && res.error.message) || res.status)); poll(); })
        .catch(function () { alertNote('Could not reach the local server.'); });
    };
    reader.readAsDataURL(file);
  }
  $('clip').onclick = function () { $('fileIn').value = ''; $('fileIn').click(); };
  $('cam').onclick = function () { $('photoIn').value = ''; $('photoIn').click(); };
  $('fileIn').onchange = function () { upload($('fileIn').files[0]); };
  $('photoIn').onchange = function () { upload($('photoIn').files[0]); };
  // "/" opens the command list (name + hint), filtered as you type, like WhatsApp.
  var cmdSel = 0;
  function cmdMatches() {
    var v = $('text').value;
    if (v.charAt(0) !== '/' || v.indexOf(' ') >= 0) return [];
    var q = v.slice(1).toLowerCase();
    return (CFG.commands || []).filter(function (c) { return c.name.indexOf(q) === 0; });
  }
  function showCmds() {
    var list = cmdMatches(), box = $('cmds');
    box.innerHTML = '';
    if (!list.length) { box.classList.remove('open'); return; }
    if (cmdSel >= list.length) cmdSel = 0;
    list.forEach(function (c, n) {
      var row = el('button', n === cmdSel ? 'on' : null); row.type = 'button';
      row.appendChild(el('b', null, '/' + c.name)); row.appendChild(el('small', null, c.hint));
      row.onclick = function () { box.classList.remove('open'); send('/' + c.name); };
      box.appendChild(row);
    });
    box.classList.add('open');
  }
  $('text').oninput = function () { fab(); cmdSel = 0; showCmds(); };
  $('text').onkeydown = function (e) {
    var list = cmdMatches();
    if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); cmdSel = (cmdSel + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; showCmds(); return; }
    if (list.length && e.key === 'Enter') { e.preventDefault(); $('cmds').classList.remove('open'); send('/' + list[cmdSel].name); return; }
    if (e.key === 'Escape') { $('cmds').classList.remove('open'); return; }
    if (e.key === 'Enter') send($('text').value.trim());
  };
  $('fab').onclick = function () { var t = $('text').value.trim(); if (t) send(t); else $('text').focus(); };
  $('scrim').onclick = function () { closeSheet(); $('menu').classList.remove('open'); };
  $('sheetClose').onclick = closeSheet;
  $('sheetSend').onclick = function () { if (state.selected) { send(null, { id: state.selected.id, title: state.selected.title, kind: 'list' }); closeSheet(); } };
  $('menuBtn').onclick = function (e) { e.stopPropagation(); $('menu').classList.toggle('open'); };
  document.addEventListener('click', function (e) { if (!$('menu').contains(e.target)) $('menu').classList.remove('open'); });
  $('clear').onclick = function () { $('menu').classList.remove('open'); if (!bot) return; post('/dev/clear', { botNumber: bot, phone: phone }).then(function () { state.count = -1; render([]); poll(); }); };
  $('pname').value = read(NAME_KEY) || '';
  $('pname').onchange = function () { try { localStorage.setItem(NAME_KEY, $('pname').value.trim()); } catch (e) { /* private mode */ } };
  $('fresh').onclick = function () { $('menu').classList.remove('open'); switchTo(newPhone()); };

  render([]);
  if (CFG.role === 'customer') { findShop(); setInterval(findShop, 3000); }
  poll();
  setInterval(poll, 1000);
  // New code on the local server: reload so the screen always matches it (the chat itself is kept).
  setInterval(function () { fetch('/dev/version').then(function (r) { return r.json(); }).then(function (v) { if (CFG.boot && v.boot && v.boot !== CFG.boot) location.reload(); }).catch(function () {}); }, 3000);
})();
</script>
</body>
</html>`;
}
