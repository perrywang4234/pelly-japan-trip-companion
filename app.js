/* Trip Companion — offline-first, syncs through a Google Sheet (Apps Script web app). */
"use strict";

// ---------- storage ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let cfg = LS.get("tc.cfg", {});                 // {url, code, name}
let S = LS.get("tc.state", {});                 // key -> {v, ts, by, del}
let dirty = new Set(LS.get("tc.dirty", []));    // keys changed locally, not yet on the sheet
let lastSync = LS.get("tc.last", 0);
let syncing = false, syncErr = "";

const val = k => { const e = S[k]; return e && !e.del ? e.v : undefined; };
const jval = k => { const v = val(k); if (v == null || v === "") return null; try { return JSON.parse(v); } catch (e) { return null; } };
function persist() { LS.set("tc.state", S); LS.set("tc.dirty", [...dirty]); }
function put(k, v) {
  const del = v == null;
  S[k] = { v: del ? null : String(v), ts: Date.now(), by: cfg.name || "", del };
  dirty.add(k); persist(); queueSync(); renderSync();
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- sync ----------
let syncTimer;
function queueSync(ms = 1500) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync() {
  if (!cfg.url || !cfg.code || syncing) { renderSync(); return; }
  if (!navigator.onLine) { renderSync(); return; }
  syncing = true; renderSync();
  const sent = [...dirty].filter(k => S[k]).map(k => ({ k, v: S[k].v, ts: S[k].ts, by: S[k].by, del: !!S[k].del }));
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(cfg.url, { method: "POST", body: JSON.stringify({ code: cfg.code, changes: sent }), signal: ctl.signal });
    clearTimeout(to);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "sync failed");
    sent.forEach(c => { if (S[c.k] && S[c.k].ts === c.ts) dirty.delete(c.k); });
    (j.rows || []).forEach(row => {
      const cur = S[row.k];
      if (cur && dirty.has(row.k) && cur.ts >= row.ts) return;   // a newer local edit is still waiting
      if (!cur || row.ts >= cur.ts) S[row.k] = { v: row.v, ts: Number(row.ts) || 0, by: row.by || "", del: !!row.del };
    });
    lastSync = Date.now(); syncErr = ""; LS.set("tc.last", lastSync); persist();
    syncing = false; renderAll();
    return true;
  } catch (e) {
    syncErr = e.name === "AbortError" ? "timed out" : (e.message || "couldn't reach the sheet");
    syncing = false; renderSync();
    return false;
  }
}
window.addEventListener("online", () => sync());
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) sync(); }, 60000);

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (iso, opt) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", Object.assign({ timeZone: "UTC" }, opt));
const tokyoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: (typeof META !== "undefined" && META.tz) || "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ago = t => { if (!t) return "never"; const s = (Date.now() - t) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; };
const yen = n => "¥" + Math.round(n).toLocaleString("en-US");
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 1500); }
function copy(text) {
  const ok = () => toast("Copied");
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text));
  else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast(text); } ta.remove();
}

// time string → minutes, for ordering ("~3:45p", "11:25", "PM", "Eve")
function rank(t) {
  if (!t) return null;
  const s = t.trim().toLowerCase().replace(/^~/, "");
  const words = { am: 540, morning: 540, midday: 720, noon: 720, pm: 840, afternoon: 840, eve: 1140, evening: 1140, night: 1260 };
  if (words[s] != null) return words[s];
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p|am|pm)?$/);
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0); const ap = m[3];
  if (ap && ap[0] === "p" && h < 12) h += 12;
  if (ap && ap[0] === "a" && h === 12) h = 0;
  return h * 60 + mi;
}

// ---------- model ----------
const FIELDS = ["t", "title", "note", "ref", "st"];
const MAPS = q => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);

// ---------- links (tickets, emails, files, apps) ----------
// Stored per item as f:<id>:links = JSON [[label, url], ...]; once set it replaces the item's base links.
const WALLET = "shoebox://";   // opens Apple Wallet (can't target one pass)
function cleanUrl(u) {
  u = String(u || "").trim();
  if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  if (/^(javascript|data|vbscript|file|blob):/i.test(u)) return "";
  return u;
}
const isWeb = u => /^https?:/i.test(u);
function guessLabel(u) {
  u = cleanUrl(u); if (!u) return "";
  if (/^shoebox:/i.test(u)) return "Wallet";
  if (/^photos-redirect:/i.test(u)) return "Photos";
  if (/^mailto:/i.test(u)) return "Email";
  if (/^tel:/i.test(u)) return "Call";
  if (!isWeb(u)) return "Open app";
  let h = ""; try { h = new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "Link"; }
  const known = [[/mail\.google\./, "Email"], [/(drive|docs)\.google\./, "Ticket (Drive)"], [/icloud\.com/, "Ticket (iCloud)"],
    [/dropbox\.com/, "Ticket (Dropbox)"], [/maps\.google\.|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/, "Map"],
    [/united\.com/, "United"], [/jal\.co(m|\.jp)/, "JAL"], [/airdo\.jp/, "AIRDO"], [/smart-ex\.jp/, "smartEX"],
    [/jr-odekake\.net|jr-west|jrwest/, "JR West"], [/tabelog/, "Tabelog"], [/tablecheck/, "TableCheck"], [/omakase/, "Omakase"],
    [/booking\.com/, "Booking.com"], [/agoda/, "Agoda"], [/expedia/, "Expedia"], [/hyatt/, "Hyatt"], [/ihg|kimpton/, "IHG"]];
  const hit = known.find(([re]) => re.test(h + new URL(u).pathname));
  return hit ? hit[1] : h.split(".").slice(-2, -1)[0] || "Link";
}
const linkTag = l => {
  const u = cleanUrl(l[1]); if (!u) return "";
  return `<a class="tag link" href="${esc(u)}"${isWeb(u) ? ` target="_blank" rel="noopener"` : ""}>${esc(l[0] || guessLabel(u))}</a>`;
};
const linkRow = (l = ["", ""]) => `<div class="lrow"><input class="l-url" value="${esc(l[1])}" placeholder="Paste a link" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url">
  <input class="l-lab" value="${esc(l[0])}" placeholder="Label, e.g. Ticket"><button class="tag" data-linkdel aria-label="Remove link">✕</button></div>`;
// Trip content lives in the private sheet (keys "base:*"), cached on the phone after the first sync.
let META = {}, HOTELS = {}, DAYS = [], PLATFORMS = [], ARRIVAL = [], TODO = [], INFO = [], BASE = {};
function loadBase() {
  META = jval("base:meta") || {};
  HOTELS = jval("base:hotels") || {};
  PLATFORMS = jval("base:platforms") || [];
  ARRIVAL = jval("base:arrival") || [];
  TODO = jval("base:todo") || [];
  INFO = jval("base:info") || [];
  DAYS = Object.keys(S).filter(k => k.startsWith("base:day:") && !S[k].del).sort().map(k => jval(k)).filter(Boolean);
  BASE = {}; DAYS.forEach(d => (d.items || []).forEach((it, i) => { BASE[it.id] = Object.assign({ date: d.date, _i: i }, it); }));
  if (selected >= DAYS.length) selected = Math.max(DAYS.length - 1, 0);
}
const people = () => (META.people && META.people.length ? META.people : [cfg.name || "Me"]);

function resolveItem(id, base) {
  const it = Object.assign({}, base || { id, custom: true });
  it.id = id;
  FIELDS.forEach(f => { const v = val(`f:${id}:${f}`); if (v !== undefined) it[f] = v; });
  it.hidden = val(`f:${id}:hide`) === "1";
  const lv = val(`f:${id}:links`);
  if (lv !== undefined) { try { it.links = JSON.parse(lv || "[]") || []; } catch (e) {} }
  let newest = 0, by = "";
  FIELDS.concat("links").forEach(f => { const e = S[`f:${id}:${f}`]; if (e && e.ts > newest && e.by !== "setup") { newest = e.ts; by = e.by; } });
  it.editedBy = by; it.editedAt = newest;
  return it;
}
function itemsFor(date) {
  const day = DAYS.find(d => d.date === date);
  const list = (day ? day.items : []).map(b => resolveItem(b.id, BASE[b.id]));
  Object.keys(S).forEach(k => {
    if (k.startsWith("c:") && !S[k].del && S[k].v === date) {
      const it = resolveItem(k.slice(2)); it.date = date; it._i = 999; list.push(it);
    }
  });
  // stable sort by time; untimed items keep their place after the previous item
  let prev = -1;
  list.forEach((it, i) => { const r = rank(it.t); it._r = r == null ? prev + 0.001 : r; prev = it._r; it._o = i; });
  list.sort((a, b) => a._r - b._r || a._o - b._o);
  return list.filter(it => !it.hidden);
}
function collection(prefix) {
  return Object.keys(S).filter(k => k.startsWith(prefix) && !S[k].del)
    .map(k => Object.assign({ key: k, ts: S[k].ts, by: S[k].by }, jval(k) || {}))
    .sort((a, b) => (b.created || b.ts) - (a.created || a.ts));
}

// ---------- rendering ----------
let selected = 0, view = "days", logTab = "bags";

function renderSync() {
  const el = $("#sync"); if (!el) return;
  let cls = "", txt;
  const pending = dirty.size;
  if (!cfg.url) { cls = "warn"; txt = "Not connected · edits stay on this phone"; }
  else if (syncing) { txt = "Syncing…"; }
  else if (!navigator.onLine) { cls = "warn"; txt = `Offline${pending ? ` · ${pending} change${pending > 1 ? "s" : ""} waiting` : ""}`; }
  else if (syncErr) { cls = "err"; txt = `Sync problem: ${syncErr}${pending ? ` · ${pending} waiting` : ""}`; }
  else { cls = "ok"; txt = `Synced ${ago(lastSync)}${pending ? ` · ${pending} waiting` : ""}`; }
  el.className = "sync " + cls; el.textContent = txt;
}

function tags(it) {
  let h = "";
  if (it.st === "ok") h += `<span class="tag ok">Booked</span>`;
  else if (it.st === "todo") h += `<span class="tag todo">To do</span>`;
  else if (it.st === "done") h += `<span class="tag ok">Done</span>`;
  if (it.ref) h += `<button class="tag copy" data-copy="${esc(it.ref)}">${esc(it.ref)}</button>`;
  (it.links || []).forEach(l => { h += linkTag(l); });
  if (it.taxi) h += `<button class="tag" data-taxi="${it.taxi}">Taxi card</button>`;
  return h ? `<div class="row">${h}</div>` : "";
}

function renderStrip() {
  const today = tokyoToday();
  $("#strip").innerHTML = DAYS.map((d, i) => `<button class="chip${d.date === today ? " today" : ""}${i === selected ? " sel" : ""}" data-day="${i}">
    <div class="d">${fmt(d.date, { weekday: "short" })}</div><div class="n">${fmt(d.date, { day: "numeric" })}</div><div class="c">${esc(d.city)}</div></button>`).join("");
  const el = $("#strip").children[selected]; if (el) el.scrollIntoView({ inline: "center", block: "nearest" });
}

function renderDay() {
  if (!DAYS.length) {
    $("#title").textContent = "Trip Companion"; $("#subtitle").textContent = "";
    $("#day").innerHTML = `<div class="card"><h3>Nothing here yet</h3><p class="sub">The itinerary loads from your private sheet. Go to <b>More</b>, connect with the setup code or passcode, and it'll appear here and stay on this phone for offline use.</p><button class="btn primary wide" data-goto="more">Connect</button></div>`;
    return;
  }
  const d = DAYS[selected], h = d.sleep && HOTELS[d.sleep];
  $("#title").textContent = fmt(d.date, { weekday: "long", month: "short", day: "numeric" });
  $("#subtitle").textContent = `Day ${selected + 1} of ${DAYS.length} · ${d.theme}`;
  const items = itemsFor(d.date);
  const today = tokyoToday();
  let banner = "";
  if (today < DAYS[0].date) {
    const n = Math.round((new Date(DAYS[0].date + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 864e5);
    const open = TODO.filter(t => val("td:" + t[0]) !== "1").length;
    banner = `<div class="status"><b>${n} day${n === 1 ? "" : "s"} to go.</b> ${open} prep item${open === 1 ? "" : "s"} left under More.</div>`;
  }
  const bags = collection("bag:").filter(b => !b.done);
  const bagNote = bags.length ? `<div class="status amber" data-goto="log"><b>${bags.length} bag item${bags.length > 1 ? "s" : ""} to collect:</b> ${esc(bags.map(b => b.what).join(", "))}</div>` : "";
  $("#day").innerHTML = banner + bagNote + `<div class="card">
    <div class="dayhead"><div class="city">${esc(d.city)}</div><div class="sub">${esc(fmt(d.date, { month: "short", day: "numeric" }))}</div></div>
    ${h ? `<div class="sleep"><div><b>${esc(h.name)}</b><div class="sub">${esc(h.times)}${val("conf:" + d.sleep) ? " · " + esc(val("conf:" + d.sleep)) : ""}</div></div>
      <button class="btn" data-taxi="${d.sleep}">Taxi card</button></div>` : ""}
  </div>
  <div class="card"><ul class="tl">${items.map(it => `<li class="${it.key ? "key" : ""}" data-edit="${it.id}">
    <div class="time">${esc(it.t || "")}</div>
    <div><div class="item-title">${esc(it.title || "(untitled)")}</div>${it.note ? `<div class="note">${esc(it.note)}</div>` : ""}${tags(it)}
    ${it.editedBy ? `<div class="by">edited by ${esc(it.editedBy)} · ${ago(it.editedAt)}</div>` : ""}</div></li>`).join("")}</ul>
    <button class="btn wide" data-add="${d.date}">+ Add to this day</button></div>
  <div class="card"><h3>Notes for ${esc(fmt(d.date, { month: "short", day: "numeric" }))}</h3>
    <textarea id="daynote" rows="3" placeholder="Anything: changes, where we parked bags, a place to try…">${esc(val("dn:" + d.date) || "")}</textarea></div>`;
}

function renderBookings() {
  const groups = DAYS.map(d => ({ d, items: itemsFor(d.date).filter(it => it.ref || it.st === "todo" || it.st === "ok") })).filter(g => g.items.length);
  const todo = groups.flatMap(g => g.items.filter(it => it.st === "todo").map(it => ({ it, d: g.d })));
  $("#bk").innerHTML =
    (todo.length ? `<h2>Still to book or do</h2><div class="card"><ul class="tl">${todo.map(({ it, d }) => `<li data-edit="${it.id}"><div class="time">${fmt(d.date, { month: "short", day: "numeric" })}</div><div><div class="item-title">${esc(it.title)}</div>${tags(it)}</div></li>`).join("")}</ul></div>` : "")
    + `<h2>By day</h2>` + groups.map(g => `<div class="card"><div class="dayhead"><h3>${fmt(g.d.date, { weekday: "short", month: "short", day: "numeric" })}</h3><span class="sub">${esc(g.d.city)}</span></div>
      <ul class="tl">${g.items.map(it => `<li data-edit="${it.id}"><div class="time">${esc(it.t)}</div><div><div class="item-title">${esc(it.title)}</div>${tags(it)}</div></li>`).join("")}</ul></div>`).join("")
    + `<h2>Book online</h2><div class="card"><div class="row" style="margin:0">${PLATFORMS.map(p => `<a class="tag link" href="${esc(p[1])}" target="_blank" rel="noopener">${esc(p[0])}</a>`).join("")}</div></div>`;
}

function renderHotels() {
  $("#ht").innerHTML = Object.entries(HOTELS).map(([k, h]) => `<div class="card">
    <div class="dayhead"><h3>${esc(h.name)}</h3><span class="sub">${esc(h.city)}</span></div>
    <div class="note">${esc(h.dates)}</div>
    <dl class="kv"><dt>Times</dt><dd>${esc(h.times)}</dd>
      <dt>Address</dt><dd>${esc(h.addr)}<br><span class="jp">${esc(h.addrJp)}</span></dd>
      <dt>Booked</dt><dd>${esc(h.via)}</dd>${h.phone ? `<dt>Phone</dt><dd>${esc(h.phone)}</dd>` : ""}
      <dt>Conf.</dt><dd>${val("conf:" + k) ? `<button class="tag copy" data-copy="${esc(val("conf:" + k))}">${esc(val("conf:" + k))}</button>` : `<span class="sub">—</span>`}</dd>
      <dt>Notes</dt><dd>${esc(val("hn:" + k) || "—")}</dd></dl>
    <div class="row"><a class="tag link" href="${MAPS(h.map)}" target="_blank" rel="noopener">Map</a>
      <button class="tag" data-hedit="${k}">Edit</button>
      <button class="btn primary" data-taxi="${k}" style="margin-left:auto">Taxi card</button></div></div>`).join("");
}

function renderLog() {
  document.querySelectorAll("#logtabs button").forEach(b => b.classList.toggle("on", b.dataset.lt === logTab));
  if (logTab === "bags") {
    const bags = collection("bag:");
    const open = bags.filter(b => !b.done), done = bags.filter(b => b.done);
    const row = b => `<li data-bag="${b.key}" class="${b.done ? "done" : ""}"><div class="time">${esc(b.date ? fmt(b.date, { month: "short", day: "numeric" }) : "")}</div>
      <div><div class="item-title">${esc(b.what || "Bag")}</div><div class="note">${esc([b.where, b.note].filter(Boolean).join(" · "))}</div>
      ${b.code ? `<div class="row"><button class="tag copy" data-copy="${esc(b.code)}">${esc(b.code)}</button></div>` : ""}
      <div class="by">${b.done ? "collected" : "logged"} by ${esc(b.by || "?")}</div></div></li>`;
    $("#lg").innerHTML = `<p class="sub">Coin lockers, luggage forwarding, anything you'll need to find again. Tap to edit or mark collected.</p>
      <button class="btn primary wide" data-addbag>+ Log a locker / bag</button>
      ${open.length ? `<div class="card"><h3>To collect</h3><ul class="tl">${open.map(row).join("")}</ul></div>` : `<div class="card sub">Nothing stashed right now.</div>`}
      ${done.length ? `<div class="card"><h3>Collected</h3><ul class="tl">${done.map(row).join("")}</ul></div>` : ""}`;
  } else {
    const ex = collection("exp:");
    const rate = parseFloat(val("cfg:rate")) || 150;
    const total = ex.reduce((s, e) => s + (+e.yen || 0), 0);
    const per = {}; ex.forEach(e => { per[e.who || "?"] = (per[e.who || "?"] || 0) + (+e.yen || 0); });
    $("#lg").innerHTML = `<div class="card"><div class="dayhead"><h3>Total</h3><span class="sub">at ¥${rate}/$ <button class="tag" data-rate>change</button></span></div>
      <div class="city">${yen(total)} <span class="sub">≈ $${(total / rate).toFixed(0)}</span></div>
      <div class="row">${Object.entries(per).map(([w, v]) => `<span class="tag">${esc(w)}: ${yen(v)}</span>`).join("")}</div></div>
      <button class="btn primary wide" data-addexp>+ Add expense</button>
      <div class="card"><ul class="tl">${ex.length ? ex.map(e => `<li data-exp="${e.key}"><div class="time">${esc(e.date ? fmt(e.date, { month: "short", day: "numeric" }) : "")}</div>
        <div><div class="item-title">${yen(+e.yen || 0)} · ${esc(e.desc || "")}</div><div class="by">${esc(e.who || "")}${e.cat ? " · " + esc(e.cat) : ""}</div></div></li>`).join("") : `<li><div></div><div class="sub">No expenses yet.</div></li>`}</ul></div>`;
  }
}

function renderMore() {
  $("#h-todo").textContent = META.todoTitle || "Before you go";
  $("#h-arrival").textContent = META.arrivalTitle || "Arrival";
  ["todo-wrap", "arrival-wrap", "info-wrap"].forEach(id => { document.getElementById(id).style.display = DAYS.length ? "" : "none"; });
  $("#info").innerHTML = INFO.map(i => `<dt>${esc(i[0])}</dt><dd>${esc(i[1])}</dd>`).join("");
  $("#arrival").innerHTML = ARRIVAL.map(a => `<li><b>${esc(a[0])}</b>${esc(a[1])}</li>`).join("");
  $("#todo").innerHTML = TODO.map(([id, t]) => { const on = val("td:" + id) === "1"; return `<li class="${on ? "done" : ""}"><input type="checkbox" id="td-${id}" data-td="${id}" ${on ? "checked" : ""}><label for="td-${id}"><span>${esc(t)}</span></label></li>`; }).join("");
  $("#conn").innerHTML = cfg.url ? `<dl class="kv" style="margin:0"><dt>You are</dt><dd>${esc(cfg.name || "—")}</dd><dt>Status</dt><dd id="sync2"></dd><dt>Last sync</dt><dd>${ago(lastSync)}</dd></dl>
      <div class="row"><button class="btn primary" data-syncnow>Sync now</button><button class="btn" data-share>Setup code for the other phone</button><button class="btn" data-disconnect>Disconnect</button></div>`
    : `<p class="sub" style="margin-top:0">Paste the setup code (or the web-app URL and passcode) to sync with the Google Sheet and the other phone.</p>${connectForm()}`;
  const s2 = $("#sync2"); if (s2) s2.textContent = $("#sync").textContent;
}
function connectForm() {
  return `<label class="lbl">Setup code<textarea id="c-code" rows="2" placeholder="Paste the setup code"></textarea></label>
    <div class="sub" style="margin:4px 0 8px">— or —</div>
    <label class="lbl">Web-app URL<input id="c-url" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <label class="lbl">Passcode<input id="c-pass" autocomplete="off"></label>
    <label class="lbl">Your name (shown on your edits)<input id="c-name" value="${esc(cfg.name || "")}" placeholder="First name" autocomplete="given-name"></label>
    <button class="btn primary wide" data-connect>Connect &amp; sync</button>`;
}

function renderAll() {
  loadBase();
  document.getElementById("kicker").textContent = META.kicker || "Trip Companion";
  renderSync();
  if (view === "days") { renderStrip(); renderDay(); }
  if (view === "book") renderBookings();
  if (view === "hotels") renderHotels();
  if (view === "log") renderLog();
  if (view === "more") renderMore();
}

const VIEWS = { days: "Days", book: "Bookings", hotels: "Hotels", log: "Log", more: "More" };
function show(v) {
  if (!VIEWS[v]) v = "days";
  view = v;
  document.querySelectorAll(".view").forEach(s => s.classList.toggle("on", s.id === "v-" + v));
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  if (v !== "days") { $("#title").textContent = VIEWS[v]; $("#subtitle").textContent = META.title || ""; }
  renderAll(); window.scrollTo(0, 0);
}

// ---------- sheet (modal) ----------
function openSheet(html, onSave, onDelete) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").classList.add("on");
  $("#sheet-save").onclick = () => { if (onSave() !== false) closeSheet(); };
  const del = $("#sheet-del");
  del.style.display = onDelete ? "" : "none"; del.textContent = "Delete"; del.dataset.armed = "";
  del.onclick = () => { if (del.dataset.armed) { onDelete(); closeSheet(); } else { del.dataset.armed = "1"; del.textContent = "Tap again to delete"; } };
  const first = $("#sheet-body input, #sheet-body textarea"); if (first && !("ontouchstart" in window)) first.focus();
}
function closeSheet() { $("#sheet").classList.remove("on"); }
const field = (id, label, value, opts = {}) => opts.area
  ? `<label class="lbl">${label}<textarea id="${id}" rows="${opts.rows || 3}" placeholder="${esc(opts.ph || "")}">${esc(value || "")}</textarea></label>`
  : `<label class="lbl">${label}<input id="${id}" value="${esc(value || "")}" placeholder="${esc(opts.ph || "")}" ${opts.type ? `type="${opts.type}"` : ""} ${opts.mode ? `inputmode="${opts.mode}"` : ""}></label>`;
const statusPick = cur => `<label class="lbl">Status<div class="row seg" id="e-st">${[["", "None"], ["todo", "To do"], ["ok", "Booked"], ["done", "Done"]].map(([v, l]) => `<button class="tag${(cur || "") === v ? " sel" : ""}" data-st="${v}">${l}</button>`).join("")}</div></label>`;

function editItem(id, date) {
  const isNew = !id;
  const it = isNew ? { st: "" } : resolveItem(id, BASE[id]);
  openSheet(`<h3>${isNew ? "Add to " + fmt(date, { month: "short", day: "numeric" }) : "Edit"}</h3>
    ${field("e-t", "Time", it.t, { ph: "e.g. 2:15p, ~11:00, PM" })}
    ${field("e-title", "What", it.title)}
    ${field("e-note", "Details", it.note, { area: 1 })}
    ${field("e-ref", "Confirmation / reference", it.ref, { ph: "Booking #, locker #, PIN…" })}
    ${statusPick(it.st)}
    <label class="lbl">Links: tickets, emails, files, apps</label>
    <div id="e-links">${(it.links || []).map(linkRow).join("")}</div>
    <div class="row"><button class="tag" data-linkadd>+ Add link</button><button class="tag" data-linkadd="wallet">+ Apple Wallet</button></div>
    <p class="sub hint">Paste any link: a ticket PDF in Drive or iCloud, a confirmation email, a booking page. Links open when you have signal; keep a Wallet pass or screenshot as the offline backup.</p>`,
    () => {
      const nid = id || "u" + uid();
      if (isNew) put("c:" + nid, date);
      const nv = { t: $("#e-t").value.trim(), title: $("#e-title").value.trim(), note: $("#e-note").value.trim(), ref: $("#e-ref").value.trim(), st: $("#e-st .sel") ? $("#e-st .sel").dataset.st : "" };
      FIELDS.forEach(f => { if ((nv[f] || "") !== (it[f] || "")) put(`f:${nid}:${f}`, nv[f]); });
      const links = [...document.querySelectorAll("#e-links .lrow")].map(r => {
        const u = cleanUrl(r.querySelector(".l-url").value); return u ? [r.querySelector(".l-lab").value.trim() || guessLabel(u), u] : null;
      }).filter(Boolean);
      if (JSON.stringify(links) !== JSON.stringify(it.links || [])) put(`f:${nid}:links`, JSON.stringify(links));
      renderAll(); toast("Saved");
    },
    isNew ? null : () => { if (it.custom) put("c:" + id, null); else put(`f:${id}:hide`, "1"); renderAll(); toast("Deleted"); });
}
function editHotel(k) {
  const h = HOTELS[k];
  openSheet(`<h3>${esc(h.name)}</h3>${field("h-conf", "Confirmation", val("conf:" + k))}${field("h-note", "Notes", val("hn:" + k), { area: 1 })}`,
    () => { const c = $("#h-conf").value.trim(), n = $("#h-note").value.trim();
      if (c !== (val("conf:" + k) || "")) put("conf:" + k, c); if (n !== (val("hn:" + k) || "")) put("hn:" + k, n); renderAll(); toast("Saved"); });
}
function editBag(key) {
  const b = key ? jval(key) || {} : { date: defaultDate() };
  openSheet(`<h3>${key ? "Edit" : "Log a locker / bag"}</h3>
    ${field("b-what", "What", b.what, { ph: "e.g. 2 carry-ons, checked suitcase" })}
    ${field("b-where", "Where", b.where, { ph: "e.g. JR Ōsaka Central Gate, locker room B" })}
    ${field("b-code", "Locker # / PIN / receipt", b.code)}
    ${field("b-note", "Note", b.note, { ph: "Hours, cost, which exit…" })}
    ${field("b-date", "Date", b.date, { type: "date" })}
    ${key ? `<label class="lbl"><span><input type="checkbox" id="b-done" ${b.done ? "checked" : ""}> Collected</span></label>` : ""}`,
    () => { const nb = Object.assign({}, b, { what: $("#b-what").value.trim(), where: $("#b-where").value.trim(), code: $("#b-code").value.trim(), note: $("#b-note").value.trim(), date: $("#b-date").value, done: key ? $("#b-done").checked : false, created: b.created || Date.now() });
      put(key || "bag:" + uid(), JSON.stringify(nb)); renderAll(); toast("Saved"); },
    key ? () => { put(key, null); renderAll(); } : null);
}
function editExp(key) {
  const e = key ? jval(key) || {} : { date: defaultDate(), who: cfg.name || "" };
  openSheet(`<h3>${key ? "Edit expense" : "Add expense"}</h3>
    ${field("x-yen", "Amount (¥)", e.yen, { mode: "numeric", ph: "e.g. 3500" })}
    ${field("x-desc", "What", e.desc, { ph: "e.g. Okesho crab lunch" })}
    <label class="lbl">Category<div class="row seg" id="x-cat">${["Food", "Transport", "Lodging", "Shopping", "Sights", "Other"].map(c => `<button class="tag${e.cat === c ? " sel" : ""}" data-st="${c}">${c}</button>`).join("")}</div></label>
    <label class="lbl">Paid by<div class="row seg" id="x-who">${people().concat(["Shared"]).map(c => `<button class="tag${e.who === c ? " sel" : ""}" data-st="${c}">${c}</button>`).join("")}</div></label>
    ${field("x-date", "Date", e.date, { type: "date" })}`,
    () => { const y = parseFloat(String($("#x-yen").value).replace(/[^\d.]/g, "")); if (!y) { toast("Enter an amount"); return false; }
      const ne = Object.assign({}, e, { yen: y, desc: $("#x-desc").value.trim(), cat: $("#x-cat .sel") ? $("#x-cat .sel").dataset.st : "", who: $("#x-who .sel") ? $("#x-who .sel").dataset.st : "", date: $("#x-date").value, created: e.created || Date.now() });
      put(key || "exp:" + uid(), JSON.stringify(ne)); renderAll(); toast("Saved"); },
    key ? () => { put(key, null); renderAll(); } : null);
}
function defaultDate() { const t = tokyoToday(); return DAYS.some(d => d.date === t) ? t : DAYS[selected].date; }

// ---------- taxi card ----------
function openTaxi(k) {
  const h = HOTELS[k]; if (!h) return;
  $("#taxi-en").textContent = "Please take us to: " + h.name;
  $("#taxi-jp").innerHTML = `${esc(h.jp)}${esc(META.taxiPhrase || "までお願いします。")}<small>${esc(h.addrJp)}</small>${h.phone ? `<small>☎ ${esc(h.phone)}</small>` : ""}`;
  $("#taxi").classList.add("on");
}

// ---------- connect ----------
// Tolerant of whatever comes along with a paste: surrounding text, line breaks, zero-width characters, lower-case prefix, missing padding.
function decodeSetup(s) {
  const clean = String(s || "").replace(/[\s\u200B-\u200D\uFEFF]/g, "");
  const m = clean.match(/TC1:([A-Za-z0-9+/_-]+=*)/i) || clean.match(/^([A-Za-z0-9+/_-]{40,}=*)$/);
  if (!m) return null;
  let b = m[1].replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (b.length % 4) b += "=";
  try { const j = JSON.parse(decodeURIComponent(escape(atob(b)))); return j && j.u && j.c ? j : null; } catch (e) { return null; }
}
const encodeSetup = () => "TC1:" + btoa(unescape(encodeURIComponent(JSON.stringify({ u: cfg.url, c: cfg.code }))));
async function connect() {
  const code = $("#c-code").value; let url = $("#c-url").value.trim(), pass = $("#c-pass").value.trim();
  if (code.trim()) { const d = decodeSetup(code); if (!d) { toast("That setup code doesn't look right"); return; } url = d.u; pass = d.c; }
  const nm = $("#c-name").value.trim();
  if (!url || !pass) { toast("Need a setup code, or URL + passcode"); return; }
  if (!nm) { toast("Enter your name"); return; }
  cfg = { url, code: pass, name: nm }; LS.set("tc.cfg", cfg);
  // stamp anything edited before connecting with this phone's name
  Object.keys(S).forEach(k => { if (dirty.has(k) && !S[k].by) S[k].by = cfg.name; }); persist();
  toast("Connecting…");
  const ok = await sync();
  if (ok) { loadBase(); pickDay(); show("days"); toast("Connected — trip loaded"); } else toast("Saved, but sync failed: " + syncErr);
  renderAll();
}

// ---------- events ----------
document.addEventListener("click", e => {
  const t = e.target;
  const c = t.closest("[data-copy]"); if (c) { e.stopPropagation(); copy(c.dataset.copy); return; }
  if (t.closest("a")) return;
  const tx = t.closest("[data-taxi]"); if (tx) { openTaxi(tx.dataset.taxi); return; }
  const ch = t.closest("[data-day]"); if (ch) { selected = +ch.dataset.day; LS.set("tc.sel", selected); renderStrip(); renderDay(); return; }
  const nb = t.closest("nav button"); if (nb) { show(nb.dataset.v); return; }
  const go = t.closest("[data-goto]"); if (go) { if (go.dataset.goto === "log") logTab = "bags"; show(go.dataset.goto); return; }
  const la = t.closest("[data-linkadd]");
  if (la) {
    const box = $("#e-links"); box.insertAdjacentHTML("beforeend", linkRow(la.dataset.linkadd === "wallet" ? ["Wallet", WALLET] : undefined));
    if (la.dataset.linkadd !== "wallet") box.lastElementChild.querySelector(".l-url").focus();
    return;
  }
  const ld = t.closest("[data-linkdel]"); if (ld) { ld.closest(".lrow").remove(); return; }
  const seg = t.closest(".seg .tag"); if (seg) { seg.parentElement.querySelectorAll(".tag").forEach(x => x.classList.toggle("sel", x === seg)); return; }
  const ed = t.closest("[data-edit]"); if (ed) { editItem(ed.dataset.edit); return; }
  const ad = t.closest("[data-add]"); if (ad) { editItem(null, ad.dataset.add); return; }
  const he = t.closest("[data-hedit]"); if (he) { editHotel(he.dataset.hedit); return; }
  const lt = t.closest("[data-lt]"); if (lt) { logTab = lt.dataset.lt; renderLog(); return; }
  if (t.closest("[data-addbag]")) { editBag(); return; }
  const bg = t.closest("[data-bag]"); if (bg) { editBag(bg.dataset.bag); return; }
  if (t.closest("[data-addexp]")) { editExp(); return; }
  const ex = t.closest("[data-exp]"); if (ex) { editExp(ex.dataset.exp); return; }
  if (t.closest("[data-rate]")) { openSheet(`<h3>Exchange rate</h3>${field("r-rate", "Yen per US dollar", val("cfg:rate") || "150", { mode: "decimal" })}`, () => { const r = parseFloat($("#r-rate").value); if (r > 0) { put("cfg:rate", r); renderAll(); } }); return; }
  if (t.closest("[data-connect]")) { connect(); return; }
  if (t.closest("[data-syncnow]")) { sync().then(ok => toast(ok ? "Synced" : "Sync failed: " + syncErr)); return; }
  if (t.closest("[data-share]")) { openSheet(`<h3>Set up the other phone</h3><p class="sub">On the other phone: open the app → More → paste this code → pick a name → Connect. Send it by iMessage; it contains the passcode.</p><textarea rows="4" readonly id="share-code">${esc(encodeSetup())}</textarea><button class="btn wide" data-copy="${esc(encodeSetup())}">Copy setup code</button>`, () => {}); $("#sheet-save").textContent = "Done"; return; }
  if (t.closest("[data-disconnect]")) { cfg = {}; LS.set("tc.cfg", cfg); renderAll(); toast("Disconnected (data kept on this phone)"); return; }
  if (t.closest("#sync")) { if (cfg.url) sync(); else show("more"); return; }
});
document.addEventListener("change", e => {
  const td = e.target.dataset && e.target.dataset.td;
  if (td) { put("td:" + td, e.target.checked ? "1" : "0"); e.target.closest("li").classList.toggle("done", e.target.checked); }
});
let noteTimer;
document.addEventListener("input", e => {
  const tg = e.target;
  // fill in a label from the pasted link until the label is typed by hand
  if (tg.classList.contains("l-lab")) tg.dataset.auto = "";
  if (tg.classList.contains("l-url")) { const lab = tg.closest(".lrow").querySelector(".l-lab"); if (!lab.value || lab.dataset.auto) { lab.value = guessLabel(tg.value); lab.dataset.auto = "1"; } }
  if (e.target.id === "daynote") { const d = DAYS[selected].date, v = e.target.value; clearTimeout(noteTimer); noteTimer = setTimeout(() => put("dn:" + d, v), 700); }
});
$("#sheet-cancel").onclick = closeSheet;
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
$("#taxi-close").onclick = () => $("#taxi").classList.remove("on");

// ---------- start ----------
function pickDay() {
  if (!DAYS.length) { selected = 0; return; }
  const today = tokyoToday();
  let idx = DAYS.findIndex(d => d.date === today);
  if (idx < 0) idx = today < DAYS[0].date ? LS.get("tc.sel", 0) : DAYS.length - 1;
  selected = Math.min(Math.max(idx, 0), DAYS.length - 1);
}
(function init() {
  loadBase(); pickDay();
  // setup code in the URL hash (#setup=TC1:…) pre-fills the connect form
  const m = location.hash.match(/^#setup=(.+)$/);
  show(m ? "more" : "days");
  if (m && !cfg.url) { const el = $("#c-code"); if (el) el.value = decodeURIComponent(m[1]); try { history.replaceState(null, "", location.pathname); } catch (e) {} }
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) $("#install").style.display = "";
  sync();
  setInterval(renderSync, 30000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
