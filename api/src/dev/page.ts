// The /dev chat page (development only). Plain HTML + JS, no build step. The client script avoids
// template literals so this file can stay one template string.
export const DEV_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay Test Chat</title>
<style>
:root {
  --bg: #eef1ee; --panel: #ffffff; --chat: #efeae2; --ink: #111b21; --muted: #667781; --line: #e2e6e3;
  --in: #ffffff; --out: #d9fdd3; --accent: #128c7e; --accent-ink: #ffffff; --chip: #f0f2f5; --warn: #b54708;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b141a; --panel: #111b21; --chat: #0b141a; --ink: #e9edef; --muted: #8696a0; --line: #222d34;
    --in: #202c33; --out: #005c4b; --accent: #00a884; --accent-ink: #0b141a; --chip: #202c33; --warn: #f79009; }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.app { display: grid; grid-template-columns: 320px 1fr; height: 100vh; max-width: 1200px; margin: 0 auto; }
aside { background: var(--panel); border-right: 1px solid var(--line); padding: 20px 16px; overflow-y: auto; }
h1 { font-size: 18px; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 16px 0 6px; }
select, input[type=text] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); font: inherit; }
.row { display: flex; gap: 8px; }
button { font: inherit; border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; background: var(--chip); color: var(--ink); }
button.primary { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
.hint { color: var(--muted); font-size: 13px; margin-top: 8px; }
.note { margin-top: 24px; padding: 12px; border-radius: 8px; background: var(--chip); color: var(--muted); font-size: 13px; }
main { display: flex; flex-direction: column; min-height: 0; background: var(--chat); }
header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
.avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-weight: 700; }
.who { font-weight: 600; }
.who small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
#log { flex: 1; overflow-y: auto; padding: 16px 6%; display: flex; flex-direction: column; gap: 6px; }
.msg { max-width: min(520px, 85%); padding: 8px 10px 6px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; box-shadow: 0 1px 0.5px rgba(0,0,0,.13); }
.msg.in { align-self: flex-end; background: var(--out); }
.msg.out { align-self: flex-start; background: var(--in); }
.msg time { display: block; text-align: right; color: var(--muted); font-size: 11px; margin-top: 2px; }
.msg img { max-width: 100%; border-radius: 6px; display: block; margin-bottom: 4px; }
.choices { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; border-top: 1px solid var(--line); padding-top: 6px; }
.choices button { background: transparent; color: var(--accent); padding: 6px; text-align: center; font-weight: 600; }
.choices button small { display: block; color: var(--muted); font-weight: 400; font-size: 12px; }
.empty { margin: auto; color: var(--muted); text-align: center; max-width: 360px; }
footer { display: flex; gap: 8px; padding: 10px 12px; background: var(--panel); border-top: 1px solid var(--line); }
footer input { flex: 1; border-radius: 20px; }
.status { color: var(--warn); font-size: 13px; padding: 0 16px 8px; background: var(--panel); min-height: 0; }
@media (max-width: 760px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: auto; min-height: 100vh; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); }
  main { height: 80vh; }
  #log { padding: 12px 16px; }
}
</style>
</head>
<body>
<div class="app">
  <aside>
    <h1>Relay test chat</h1>
    <p class="sub">Chat with the bots here instead of WhatsApp. Replies are never sent to a real phone.</p>

    <label for="role">I am</label>
    <select id="role">
      <option value="admin">A business owner (Admin Bot)</option>
      <option value="shop">A customer (Shop Bot)</option>
    </select>

    <div id="shopBox" hidden>
      <label for="shop">Shop</label>
      <select id="shop"></select>
      <p class="hint" id="noShops" hidden>No shops yet. Create the demo shop below.</p>
    </div>

    <label for="phone">My phone number</label>
    <div class="row">
      <input type="text" id="phone" inputmode="numeric" autocomplete="off">
      <button id="newPhone" title="Start fresh with a new number">New</button>
    </div>
    <p class="hint" id="phoneHint">A new number starts from the beginning, like a brand-new user.</p>

    <label>Demo shop</label>
    <button id="seed">Create / reset "Mama Put Kitchen"</button>
    <p class="hint">Its owner's number is <b>2348030000009</b>. Use it as a business owner to manage that shop.</p>

    <div class="note">The bots run exactly as on WhatsApp: same code, same database rules. Only the last step is different: instead of going to Meta, replies appear here.</div>
  </aside>

  <main>
    <header>
      <div class="avatar" id="avatar">R</div>
      <div class="who" id="who">Relay Admin Bot<small id="whoSub">Business owners set up their shop here</small></div>
    </header>
    <div id="log"><p class="empty">Say "hi" to start.</p></div>
    <div class="status" id="status"></div>
    <footer>
      <input type="text" id="text" placeholder="Type a message" autocomplete="off">
      <button class="primary" id="send">Send</button>
    </footer>
  </main>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = { admin: null, shops: [], count: -1 };
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function randomPhone() { var n = '23480'; for (var i = 0; i < 8; i++) n += Math.floor(Math.random() * 10); return n; }

  function botNumber() { return $('role').value === 'admin' ? state.admin : $('shop').value; }
  function phone() { return $('phone').value.replace(/\\D/g, ''); }

  function setHeader() {
    var admin = $('role').value === 'admin';
    $('shopBox').hidden = admin;
    if (admin) { $('who').firstChild.nodeValue = 'Relay Admin Bot'; $('whoSub').textContent = 'Business owners set up and run their shop here'; $('avatar').textContent = 'R'; }
    else {
      var s = state.shops.filter(function (x) { return x.botNumber === $('shop').value; })[0];
      $('who').firstChild.nodeValue = s ? s.name : 'No shop selected';
      $('whoSub').textContent = 'Customers order here';
      $('avatar').textContent = s ? s.name.charAt(0) : '?';
    }
    state.count = -1; render([]); poll();
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function time(at) { var d = new Date(at); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  function choicesOf(content) {
    if (content.type !== 'interactive') return [];
    var i = content.interactive || {}, a = i.action || {};
    if (i.type === 'button') return (a.buttons || []).map(function (b) { return { id: b.reply.id, title: b.reply.title, kind: 'button' }; });
    if (i.type === 'list') return [].concat.apply([], (a.sections || []).map(function (s) { return s.rows.map(function (r) { return { id: r.id, title: r.title, description: r.description, kind: 'list' }; }); }));
    return [];
  }

  function bubble(m) {
    var b = el('div', 'msg ' + m.direction), c = m.content || {};
    if (c.type === 'text') b.appendChild(document.createTextNode(c.text));
    else if (c.type === 'image') { var img = el('img'); img.src = c.link; img.alt = ''; b.appendChild(img); if (c.caption) b.appendChild(document.createTextNode(c.caption)); }
    else if (c.type === 'template') b.appendChild(document.createTextNode('[Template message: ' + c.name + ']'));
    else if (c.type === 'interactive') {
      var i = c.interactive || {};
      b.appendChild(document.createTextNode((i.body && i.body.text) || ''));
      var opts = choicesOf(c);
      if (opts.length) {
        var box = el('div', 'choices');
        opts.forEach(function (o) {
          var btn = el('button', null, o.title);
          if (o.description) btn.appendChild(el('small', null, o.description));
          btn.onclick = function () { send(null, o); };
          box.appendChild(btn);
        });
        b.appendChild(box);
      }
    }
    b.appendChild(el('time', null, time(m.at)));
    return b;
  }

  function render(list) {
    var log = $('log'); log.innerHTML = '';
    if (!list.length) { log.appendChild(el('p', 'empty', 'Say "hi" to start.')); return; }
    list.forEach(function (m) { log.appendChild(bubble(m)); });
    log.scrollTop = log.scrollHeight;
  }

  function poll() {
    var bot = botNumber(), p = phone();
    if (!bot || p.length < 8) return;
    fetch('/dev/messages?phone=' + p + '&bot=' + encodeURIComponent(bot)).then(function (r) { return r.json(); }).then(function (list) {
      if (bot !== botNumber() || p !== phone()) return;
      if (list.length !== state.count) { state.count = list.length; render(list); }
    }).catch(function () {});
  }

  function send(text, choice) {
    var bot = botNumber(), p = phone();
    if (!bot) { $('status').textContent = $('role').value === 'admin' ? 'The Admin Bot number is not configured (ADMIN_BOT_PHONE_NUMBER_ID).' : 'Pick a shop first, or create the demo shop.'; return; }
    if (p.length < 8) { $('status').textContent = 'Enter a phone number (digits only, e.g. 2348012345678).'; return; }
    if (!choice && !text) return;
    $('status').textContent = '';
    $('send').disabled = true;
    fetch('/dev/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botNumber: bot, phone: p, text: text, choice: choice ? { id: choice.id, title: choice.title, kind: choice.kind } : undefined }) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (!res.success) $('status').textContent = 'The bot did not accept that message (status ' + (res.status || '?') + ').'; poll(); })
      .catch(function () { $('status').textContent = 'Could not reach the local server. Is npm run dev running?'; })
      .then(function () { $('send').disabled = false; });
    if (text) $('text').value = '';
  }

  function loadBots(selectBot) {
    return fetch('/dev/bots').then(function (r) { return r.json(); }).then(function (b) {
      state.admin = b.admin; state.shops = b.shops;
      var sel = $('shop'), keep = selectBot || sel.value || store('relay.shop');
      sel.innerHTML = '';
      b.shops.forEach(function (s) { var o = el('option', null, s.name); o.value = s.botNumber; sel.appendChild(o); });
      if (keep && b.shops.some(function (s) { return s.botNumber === keep; })) sel.value = keep;
      $('noShops').hidden = b.shops.length > 0;
      setHeader();
    });
  }

  $('role').onchange = function () { store('relay.role', $('role').value); setHeader(); };
  $('shop').onchange = function () { store('relay.shop', $('shop').value); setHeader(); };
  $('phone').onchange = function () { store('relay.phone', phone()); state.count = -1; poll(); };
  $('newPhone').onclick = function () { $('phone').value = randomPhone(); store('relay.phone', phone()); state.count = -1; render([]); };
  $('seed').onclick = function () {
    $('seed').disabled = true;
    fetch('/dev/seed', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (s) { $('status').textContent = 'Demo shop ready: ' + s.name + '.'; return loadBots(s.phoneNumberId); })
      .catch(function () { $('status').textContent = 'Could not create the demo shop.'; })
      .then(function () { $('seed').disabled = false; });
  };
  $('send').onclick = function () { send($('text').value.trim()); };
  $('text').onkeydown = function (e) { if (e.key === 'Enter') send($('text').value.trim()); };

  $('role').value = store('relay.role') || 'admin';
  $('phone').value = store('relay.phone') || randomPhone();
  loadBots();
  setInterval(poll, 1200);
})();
</script>
</body>
</html>`;
