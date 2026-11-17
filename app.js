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
    syncing = false; renderAll(); attPump();
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
// Per-item fields that can be edited on a phone (stored as f:<id>:<field>).
// go = how to get there, cat = travel | food | hotel | do (used by the Bookings filter).
// ja = Japanese name(s) shown under the title.
const FIELDS = ["t", "title", "note", "go", "ref", "st", "cat", "ja"];
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
const DIR = q => "https://www.google.com/maps/dir/?api=1&travelmode=transit&destination=" + encodeURIComponent(q);
// Trip content lives in the private sheet (keys "base:*"), cached on the phone after the first sync.
let META = {}, HOTELS = {}, DAYS = [], PLATFORMS = [], ARRIVAL = [], GUIDES = [], TODO = [], INFO = [], BASE = {};
function loadBase() {
  META = jval("base:meta") || {};
  HOTELS = jval("base:hotels") || {};
  PLATFORMS = jval("base:platforms") || [];
  ARRIVAL = jval("base:arrival") || [];
  // Travel-day guides: [{id, date, title, sub, steps:[[head, text]], links:[[label, url]]}].
  // Older sheets only have base:arrival, which becomes a single guide.
  GUIDES = jval("base:guides") || (ARRIVAL.length ? [{ id: "arrival", title: META.arrivalTitle || "Arrival", steps: ARRIVAL }] : []);
  TODO = jval("base:todo") || [];
  INFO = jval("base:info") || [];
  buildJa(jval("base:ja") || {});
  DAYS = Object.keys(S).filter(k => k.startsWith("base:day:") && !S[k].del).sort().map(k => jval(k)).filter(Boolean);
  BASE = {}; DAYS.forEach(d => (d.items || []).forEach((it, i) => { BASE[it.id] = Object.assign({ date: d.date, _i: i }, it); }));
  if (selected >= DAYS.length) selected = Math.max(DAYS.length - 1, 0);
}
// Japanese names for places mentioned in notes, getting-there text and guides.
// base:ja = {"Kyoto Stn": "京都駅", ...}. The first mention of each name in a block gets its Japanese
// added after it (longest name wins; skipped when the text already has Japanese in brackets right after).
let JA = {}, JA_RE = null;
function buildJa(map) {
  JA = map && typeof map === "object" ? map : {};
  const keys = Object.keys(JA).filter(k => k && JA[k]).sort((a, b) => b.length - a.length);
  JA_RE = keys.length ? new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
}
const WORDC = /[A-Za-z0-9\u00C0-\u024F'’]/;
const JA_AFTER = /^\s*[(（]?\s*[\u3040-\u30ff\u3400-\u9fff]/;
function escJa(text) {
  text = String(text == null ? "" : text);
  if (!JA_RE) return esc(text);
  let out = "", last = 0, m;
  const seen = new Set();
  JA_RE.lastIndex = 0;
  while ((m = JA_RE.exec(text))) {
    const a = m.index, b = a + m[0].length;
    if ((a > 0 && WORDC.test(text[a - 1])) || (b < text.length && WORDC.test(text[b]))) { JA_RE.lastIndex = a + 1; continue; }
    if (seen.has(JA[m[0]]) || JA_AFTER.test(text.slice(b, b + 4))) continue;
    seen.add(JA[m[0]]);
    out += esc(text.slice(last, b)) + `<span class="jx" lang="ja">${esc(JA[m[0]])}</span>`;
    last = b;
  }
  return out + esc(text.slice(last));
}
// Japanese for a city name ("Kyoto" → "京都"), from the same base:ja glossary.
const cityJa = c => (c && JA[c]) || "";
const cityHTML = c => esc(c) + (cityJa(c) ? ` <span class="jx" lang="ja">${esc(cityJa(c))}</span>` : "");
const jaLine = s => s ? `<div class="ja-name" lang="ja">${esc(s)}</div>` : "";

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
// QR codes (e.g. Visit Japan Web) live in the private sheet as qr:<id> = JSON {group, title, sub, who, name, ord, img (data:image/png;base64,…)}.
const safeImg = u => /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(String(u || "")) ? u : "";
function qrs(group) {
  return collection("qr:").filter(q => safeImg(q.img) && (!group || q.group === group)).sort((a, b) => (a.ord || 0) - (b.ord || 0));
}
function collection(prefix) {
  return Object.keys(S).filter(k => k.startsWith(prefix) && !S[k].del)
    .map(k => Object.assign({ key: k, ts: S[k].ts, by: S[k].by }, jval(k) || {}))
    .sort((a, b) => (b.created || b.ts) - (a.created || a.ts));
}

// ---------- attachments (ticket photos, PDF pages) ----------
// Row att:<id> = JSON {item, n, w, h, name, created} syncs like everything else. The JPEG itself is kept in
// IndexedDB on each phone (so it opens offline) and in a private Drive folder via the sync script.
const IDB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("tc", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("att");
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const tx = db.transaction("att", mode), rq = fn(tx.objectStore("att"));
    tx.oncomplete = () => res(rq && rq.result); tx.onerror = tx.onabort = () => rej(tx.error);
  }));
  return {
    get: k => run("readonly", s => s.get(k)),
    put: (k, v) => run("readwrite", s => s.put(v, k)),
    del: k => run("readwrite", s => s.delete(k)),
    all: () => run("readonly", s => s.getAll())
  };
})();
const ATT = { have: new Map(), urls: new Map(), miss: new Map(), busy: false, ready: false };   // have: id -> {up}
const attId = k => k.slice(4);
function attsFor(item) {
  return collection("att:").filter(a => a.item === item).map(a => Object.assign(a, { id: attId(a.key) }))
    .sort((a, b) => (a.created || 0) - (b.created || 0) || (a.n || 0) - (b.n || 0));
}
async function attInit() {
  try { (await IDB.all()).forEach(r => { if (r && r.id) ATT.have.set(r.id, { up: !!r.up }); }); } catch (e) {}
  ATT.ready = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
}
async function attUrl(id) {
  if (ATT.urls.has(id)) return ATT.urls.get(id);
  let r; try { r = await IDB.get(id); } catch (e) { return ""; }
  if (!r || !r.buf) return "";
  const u = URL.createObjectURL(new Blob([r.buf], { type: "image/jpeg" }));
  ATT.urls.set(id, u); return u;
}
// Fill in <img data-att="id"> elements once their picture is read from the phone's storage.
function hydrate(root = document) {
  root.querySelectorAll("img[data-att]:not([src])").forEach(img => attUrl(img.dataset.att).then(u => { if (u) img.src = u; }));
}
const attCounts = () => {
  const rows = collection("att:");
  return { local: rows.filter(a => ATT.have.has(attId(a.key))).length, down: rows.filter(a => !ATT.have.has(attId(a.key))).length,
    up: [...ATT.have.values()].filter(h => !h.up).length };
};
function b64(buf) {
  const u = new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
async function attCall(body, ms = 60000) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(cfg.url, { method: "POST", body: JSON.stringify(Object.assign({ code: cfg.code }, body)), signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(to); }
}
// Upload this phone's new pictures, download the other phone's, drop pictures deleted elsewhere.
async function attPump() {
  if (ATT.busy || !ATT.ready || !cfg.url || !navigator.onLine) return;
  ATT.busy = true; let changed = false; const hadErr = ATT.err; ATT.err = "";
  try {
    for (const [id, h] of [...ATT.have]) {
      const e = S["att:" + id];
      if (e && e.del) { await IDB.del(id); ATT.have.delete(id); changed = true; continue; }
      if (h.up || !e) continue;
      const r = await IDB.get(id); if (!r) { ATT.have.delete(id); continue; }
      const j = await attCall({ action: "upload", id, data: b64(r.buf) });
      if (!j.ok || j.id !== id) throw new Error(j.error || "sync script not updated for attachments yet");   // an older script answers ok without storing
      r.up = true; await IDB.put(id, r); h.up = true; changed = true;
    }
    for (const a of collection("att:")) {
      const id = attId(a.key);
      if (ATT.have.has(id) || Date.now() - (ATT.miss.get(id) || 0) < 120000) continue;
      const j = await attCall({ action: "get", id });
      if (!j.ok || !j.data) { ATT.miss.set(id, Date.now()); if (j.missing || (j.ok && !j.data)) continue; throw new Error(j.error || "download failed"); }
      await IDB.put(id, { id, buf: unb64(j.data), up: true }); ATT.have.set(id, { up: true }); changed = true;
    }
  } catch (e) {
    ATT.err = e && e.message ? e.message : "couldn't reach the sheet"; changed = true;
    console.warn("attachments:", e);
  } finally {
    ATT.busy = false;
    if (changed || hadErr !== ATT.err) renderAll(); else renderSync();
  }
}

// Photos are shrunk to a sharp-screenshot size; PDF pages are drawn to the same kind of JPEG.
const ATT_MAX = 1800;
function canvasJpeg(src, w, h) {
  const s = Math.min(1, ATT_MAX / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res({ blob: b, w: c.width, h: c.height }) : rej(new Error("couldn't save the picture")), "image/jpeg", 0.85));
}
async function imageToJpeg(file) {
  const u = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = u;
    await (img.decode ? img.decode() : new Promise((res, rej) => { img.onload = res; img.onerror = rej; }));
    return await canvasJpeg(img, img.naturalWidth, img.naturalHeight);
  } finally { URL.revokeObjectURL(u); }
}
let pdfLib = null;
function loadPdf() {
  return pdfLib || (pdfLib = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = "vendor/pdfjs/pdf.min.js";
    s.onload = () => { const L = window.pdfjsLib; if (!L) { pdfLib = null; rej(new Error("PDF reader didn't load")); return; } L.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js"; res(L); };
    s.onerror = () => { pdfLib = null; s.remove(); rej(new Error("PDF reader didn't load (needs signal the first time)")); };
    document.head.appendChild(s);
  }));
}
const PDF_MAX_PAGES = 12;
async function pdfToJpegs(file) {
  const L = await loadPdf();
  const doc = await L.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false,
    // absolute URLs: pdf.js resolves these from its worker's location, not the page's
    cMapUrl: new URL("vendor/pdfjs/cmaps/", location.href).href, cMapPacked: true,
    standardFontDataUrl: new URL("vendor/pdfjs/standard_fonts/", location.href).href }).promise;
  const out = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
      const pg = await doc.getPage(i), v1 = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: Math.min(4, ATT_MAX / Math.max(v1.width, v1.height)) });
      const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: vp }).promise;
      out.push(await canvasJpeg(c, c.width, c.height));
      pg.cleanup();
    }
    if (doc.numPages > PDF_MAX_PAGES) toast(`Kept the first ${PDF_MAX_PAGES} of ${doc.numPages} pages`);
  } finally { doc.destroy(); }
  return out;
}

// Category for the Bookings filter. Base items carry `cat`; for items added on a phone without one, guess from the title.
const CATS = [["all", "All"], ["travel", "Travel"], ["food", "Food"], ["hotel", "Hotel"]];
function catOf(it) {
  if (it.cat) return it.cat;
  const s = (it.title || "") + " " + (it.note || "");
  if (/\b(UA\d|JAL|AIRDO|flight|fly|train|shinkansen|nozomi|express|bus|limousine|keikyu|JR |taxi|airport|haneda|itami|chitose|ferry|locker|takky)/i.test(s)) return "travel";
  if (/\b(lunch|dinner|breakfast|brunch|curry|crab|sushi|ramen|yakiniku|kaiseki|izakaya|caf[eé]|coffee|bar|market|tea|restaurant|eat|food)/i.test(s)) return "food";
  if (/\b(hotel|ryokan|inn|check[- ]?in|check[- ]?out)\b/i.test(s)) return "hotel";
  return "do";
}

// ---------- rendering ----------
let selected = 0, view = "days", logTab = "bags";
let bkFilter = LS.get("tc.bkf", "all");
const openGuides = new Set(LS.get("tc.open", []));   // which travel-day guides are unfolded (per phone)

const ICON_GO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M9 21l-2 0 1.5-4M15 21h2l-1.5-4"/><circle cx="9" cy="14" r=".6"/><circle cx="15" cy="14" r=".6"/></svg>`;
const goBlock = it => it.go ? `<div class="go">${ICON_GO}<span>${escJa(it.go)}</span></div>` : "";

function guideHTML(g) {
  const open = openGuides.has(g.id);
  return `<details class="card guide" data-gid="${esc(g.id)}"${open ? " open" : ""}>
    <summary><div><div class="item-title">${esc(g.title)}</div>${g.sub ? `<div class="sub">${escJa(g.sub)}</div>` : ""}</div><span class="chev" aria-hidden="true"></span></summary>
    <ol class="steps">${(g.steps || []).map(s => `<li><b>${escJa(s[0])}</b>${escJa(s[1])}</li>`).join("")}</ol>
    ${(g.links || []).length ? `<div class="row">${g.links.map(l => `<a class="tag link" href="${esc(l[1])}" target="_blank" rel="noopener">${esc(l[0])}</a>`).join("")}</div>` : ""}
  </details>`;
}
function openGuide(id) {
  openGuides.add(id); LS.set("tc.open", [...openGuides]);
  let el = document.querySelector(`.view.on [data-gid="${CSS.escape(id)}"]`);
  if (!el) { show("more"); el = document.querySelector(`.view.on [data-gid="${CSS.escape(id)}"]`); }
  if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }); }
}

function renderSync() {
  const el = $("#sync"); if (!el) return;
  let cls = "", txt;
  const pending = dirty.size + [...ATT.have.values()].filter(h => !h.up).length;
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
  if (it.guide && GUIDES.some(g => g.id === it.guide)) h += `<button class="tag guide-tag" data-guide="${esc(it.guide)}">Step by step</button>`;
  if (it.dir) h += `<a class="tag link" href="${esc(DIR(it.dir))}" target="_blank" rel="noopener">Directions</a>`;
  (it.links || []).forEach(l => { h += linkTag(l); });
  if (it.taxi) h += `<button class="tag" data-taxi="${it.taxi}">Taxi card</button>`;
  if (it.qr && qrs(it.qr).length) h += `<button class="tag" data-qr="${esc(it.qr)}">QR codes</button>`;
  return h ? `<div class="row">${h}</div>` : "";
}

function attStrip(id) {
  const list = attsFor(id); if (!list.length) return "";
  return `<div class="thumbs">${list.slice(0, 4).map(a => ATT.have.has(a.id)
      ? `<button class="thumb" data-view="${esc(id)}" data-vat="${esc(a.id)}" aria-label="Open ticket"><img data-att="${esc(a.id)}" alt=""></button>`
      : `<button class="thumb wait" data-view="${esc(id)}" data-vat="${esc(a.id)}" aria-label="Not downloaded yet">⇣</button>`).join("")}${list.length > 4 ? `<button class="thumb more" data-view="${esc(id)}">+${list.length - 4}</button>` : ""}</div>`;
}

function renderStrip() {
  const today = tokyoToday();
  $("#strip").innerHTML = DAYS.map((d, i) => `<button class="chip${d.date === today ? " today" : ""}${i === selected ? " sel" : ""}" data-day="${i}">
    <div class="d">${fmt(d.date, { weekday: "short" })}</div><div class="n">${fmt(d.date, { day: "numeric" })}</div><div class="c">${esc(d.city)}</div>${cityJa(d.city) ? `<div class="c" lang="ja">${esc(cityJa(d.city))}</div>` : ""}</button>`).join("");
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
    <div class="dayhead"><div class="city">${cityHTML(d.city)}</div><div class="sub">${esc(fmt(d.date, { month: "short", day: "numeric" }))}</div></div>
    ${h ? `<div class="sleep"><div><b>${esc(h.name)}</b>${jaLine(h.jp)}<div class="sub">${esc(h.times)}${val("conf:" + d.sleep) ? " · " + esc(val("conf:" + d.sleep)) : ""}</div></div>
      <button class="btn" data-taxi="${d.sleep}">Taxi card</button></div>` : ""}
  </div>
  ${GUIDES.filter(g => g.date === d.date).map(guideHTML).join("")}
  <div class="card"><ul class="tl">${items.map(it => `<li class="${it.key ? "key" : ""}" data-edit="${it.id}">
    <div class="time">${esc(it.t || "")}</div>
    <div><div class="item-title">${esc(it.title || "(untitled)")}</div>${jaLine(it.ja)}${it.note ? `<div class="note">${escJa(it.note)}</div>` : ""}${goBlock(it)}${tags(it)}${attStrip(it.id)}
    ${it.editedBy ? `<div class="by">edited by ${esc(it.editedBy)} · ${ago(it.editedAt)}</div>` : ""}</div></li>`).join("")}</ul>
    <button class="btn wide" data-add="${d.date}">+ Add to this day</button></div>
  <div class="card"><h3>Notes for ${esc(fmt(d.date, { month: "short", day: "numeric" }))}</h3>
    <textarea id="daynote" rows="3" placeholder="Anything: changes, where we parked bags, a place to try…">${esc(val("dn:" + d.date) || "")}</textarea></div>`;
}

function renderBookings() {
  if (!CATS.some(c => c[0] === bkFilter)) bkFilter = "all";
  const pass = it => bkFilter === "all" || catOf(it) === bkFilter;
  const groups = DAYS.map(d => ({ d, items: itemsFor(d.date).filter(it => (it.ref || it.st === "todo" || it.st === "ok") && pass(it)) })).filter(g => g.items.length);
  const todo = groups.flatMap(g => g.items.filter(it => it.st === "todo").map(it => ({ it, d: g.d })));
  const showHotels = (bkFilter === "all" || bkFilter === "hotel") && Object.keys(HOTELS).length;
  const short = iso => fmt(iso, { month: "short", day: "numeric" });
  const hotelRows = Object.entries(HOTELS).map(([k, h]) => { const c = val("conf:" + k); return `<li data-hedit="${k}"><div class="time">${esc((h.dates || "").split("·")[0].trim())}</div>
    <div><div class="item-title">${esc(h.name)}</div><div class="note">${cityHTML(h.city)}${h.via ? " · " + esc(h.via) : ""}</div>
    <div class="row">${c ? `<span class="tag ok">Booked</span><button class="tag copy" data-copy="${esc(c)}">${esc(c)}</button>` : `<span class="tag todo">No conf. #</span>`}<button class="tag" data-taxi="${k}">Taxi card</button></div></div></li>`; }).join("");
  $("#bk").innerHTML =
    `<div class="segs" id="bkf">${CATS.map(([v, l]) => `<button data-bkf="${v}" class="${bkFilter === v ? "on" : ""}">${l}</button>`).join("")}</div>`
    + (todo.length ? `<h2>Still to book or do</h2><div class="card"><ul class="tl">${todo.map(({ it, d }) => `<li data-edit="${it.id}"><div class="time">${short(d.date)}</div><div><div class="item-title">${esc(it.title)}</div>${jaLine(it.ja)}${tags(it)}${attStrip(it.id)}</div></li>`).join("")}</ul></div>` : "")
    + (groups.length ? `<h2>By day</h2>` + groups.map(g => `<div class="card"><div class="dayhead"><h3>${fmt(g.d.date, { weekday: "short", month: "short", day: "numeric" })}</h3><span class="sub">${cityHTML(g.d.city)}</span></div>
      <ul class="tl">${g.items.map(it => `<li data-edit="${it.id}"><div class="time">${esc(it.t)}</div><div><div class="item-title">${esc(it.title)}</div>${jaLine(it.ja)}${tags(it)}${attStrip(it.id)}</div></li>`).join("")}</ul></div>`).join("") : "")
    + (showHotels ? `<h2>Hotels</h2><div class="card"><ul class="tl">${hotelRows}</ul></div>` : "")
    + (!groups.length && !showHotels ? `<div class="card sub">Nothing in this category yet.</div>` : "")
    + (bkFilter === "all" || bkFilter === "travel" ? `<h2>Book online</h2><div class="card"><div class="row" style="margin:0">${PLATFORMS.map(p => `<a class="tag link" href="${esc(p[1])}" target="_blank" rel="noopener">${esc(p[0])}</a>`).join("")}</div></div>` : "");
}

function renderHotels() {
  $("#ht").innerHTML = Object.entries(HOTELS).map(([k, h]) => `<div class="card">
    <div class="dayhead"><h3>${esc(h.name)}</h3><span class="sub">${cityHTML(h.city)}</span></div>${jaLine(h.jp)}
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
  ["todo-wrap", "arrival-wrap", "info-wrap"].forEach(id => { document.getElementById(id).style.display = DAYS.length ? "" : "none"; });
  const qg = {}; qrs().forEach(q => { (qg[q.group] = qg[q.group] || []).push(q); });
  const qw = $("#qr-wrap"); qw.style.display = Object.keys(qg).length ? "" : "none";
  qw.innerHTML = Object.entries(qg).map(([g, list]) => `<h2>${esc(list[0].title || "QR codes")}</h2><div class="card">
    ${list[0].sub ? `<p class="sub" style="margin-top:0">${esc(list[0].sub)}</p>` : ""}
    <div class="row" style="margin:0">${list.map(q => `<button class="btn primary" data-qr="${esc(g)}" data-qrwho="${esc(q.key)}">${esc(q.who || q.name || "QR")}</button>`).join("")}</div></div>`).join("");
  $("#info").innerHTML = INFO.map(i => `<dt>${esc(i[0])}</dt><dd>${esc(i[1])}</dd>`).join("");
  const allOpen = GUIDES.length && GUIDES.every(g => openGuides.has(g.id));
  $("#guides-toggle").textContent = allOpen ? "Fold all" : "Unfold all";
  $("#guides").innerHTML = GUIDES.map(g => g.date ? Object.assign({}, g, { title: `${fmt(g.date, { month: "short", day: "numeric" })} · ${g.title}` }) : g).map(guideHTML).join("");
  $("#todo").innerHTML = TODO.map(([id, t]) => { const on = val("td:" + id) === "1"; return `<li class="${on ? "done" : ""}"><input type="checkbox" id="td-${id}" data-td="${id}" ${on ? "checked" : ""}><label for="td-${id}"><span>${esc(t)}</span></label></li>`; }).join("");
  $("#conn").innerHTML = cfg.url ? `<dl class="kv" style="margin:0"><dt>You are</dt><dd>${esc(cfg.name || "—")}</dd><dt>Status</dt><dd id="sync2"></dd><dt>Last sync</dt><dd>${ago(lastSync)}</dd>${attLine()}</dl>
      <div class="row"><button class="btn primary" data-syncnow>Sync now</button><button class="btn" data-share>Setup code for the other phone</button><button class="btn" data-disconnect>Disconnect</button></div>`
    : `<p class="sub" style="margin-top:0">Paste the setup code (or the web-app URL and passcode) to sync with the Google Sheet and the other phone.</p>${connectForm()}`;
  const s2 = $("#sync2"); if (s2) s2.textContent = $("#sync").textContent;
}
function attLine() {
  const c = attCounts(); if (!c.local && !c.down && !c.up) return "";
  return `<dt>Tickets</dt><dd>${c.local} saved on this phone${c.down ? ` · <b>${c.down} still to download</b>` : ""}${c.up ? ` · ${c.up} to upload` : ""}${ATT.err ? `<br><span class="sub">Upload problem: ${esc(ATT.err)}</span>` : ""}</dd>`;
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
  hydrate();
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
function closeSheet() {
  $("#sheet").classList.remove("on");
  if (EA) { EA.add.forEach(a => URL.revokeObjectURL(a.url)); EA = null; }
}
// Attachments being edited in the open item editor: staged until Save.
let EA = null;   // {item, add:[{tid, blob, url, w, h, n, name}], del:Set, busy}
function renderEA() {
  const box = $("#e-atts"); if (!box || !EA) return;
  const ex = EA.item ? attsFor(EA.item).filter(a => !EA.del.has(a.id)) : [];
  box.innerHTML = ex.map(a => `<div class="thumb">${ATT.have.has(a.id) ? `<img data-att="${esc(a.id)}" alt="">` : "⇣"}<button class="x" data-attdel="${esc(a.id)}" aria-label="Remove">✕</button></div>`).join("")
    + EA.add.map(a => `<div class="thumb"><img src="${a.url}" alt=""><button class="x" data-attdel="${a.tid}" aria-label="Remove">✕</button></div>`).join("")
    + (EA.busy ? `<div class="thumb wait">Preparing…</div>` : "");
  hydrate(box);
}
async function addFiles(files) {
  const ea = EA; if (!ea || !files.length) return;
  ea.busy++; renderEA();
  for (const f of files) {
    try {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
      const pics = isPdf ? await pdfToJpegs(f) : [await imageToJpeg(f)];
      pics.forEach((p, i) => ea.add.push(Object.assign(p, { tid: "tmp_" + uid(), name: f.name || "", n: i, url: URL.createObjectURL(p.blob) })));
    } catch (e) { toast((f.name || "File") + ": " + (e && e.message ? e.message : "couldn't read it")); }
  }
  ea.busy--; if (EA === ea) renderEA(); else ea.add.forEach(a => URL.revokeObjectURL(a.url));
}
function saveAtts(ea, item) {
  ea.del.forEach(id => { put("att:" + id, null); IDB.del(id).catch(() => {}); ATT.have.delete(id); const u = ATT.urls.get(id); if (u) { URL.revokeObjectURL(u); ATT.urls.delete(id); } });
  if (!ea.add.length) return;
  (async () => {
    const base = Date.now();
    for (let i = 0; i < ea.add.length; i++) {
      const a = ea.add[i], id = "a" + uid();
      try { await IDB.put(id, { id, buf: await a.blob.arrayBuffer(), up: false }); }
      catch (e) { toast("Couldn't store a picture on this phone"); URL.revokeObjectURL(a.url); continue; }
      ATT.have.set(id, { up: false }); ATT.urls.set(id, a.url);
      put("att:" + id, JSON.stringify({ item, n: a.n, w: a.w, h: a.h, name: a.name, created: base + i }));
    }
    renderAll(); attPump();
  })();
}

// ---------- full-screen viewer ----------
function openViewer(item, at) {
  const it = resolveItem(item, BASE[item]), list = attsFor(item);
  if (!list.length) return;
  $("#vw-t").textContent = it.title || "Tickets & photos";
  $("#vw-list").innerHTML = list.map(a => ATT.have.has(a.id)
    ? `<img data-att="${esc(a.id)}" id="vw-${esc(a.id)}" alt="" style="aspect-ratio:${+a.w || 3}/${+a.h || 4}">`
    : `<div class="vw-miss" id="vw-${esc(a.id)}">This one isn't on this phone yet. It downloads the next time there's signal.</div>`).join("");
  $("#vw").classList.add("on"); hydrate($("#vw"));
  const el = at && document.getElementById("vw-" + at);
  $("#vw-list").scrollTop = 0; if (el) el.scrollIntoView({ block: "start" });
}
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
    ${field("e-ja", "Japanese name", it.ja, { ph: "e.g. 伏見稲荷大社 (shown under the title)" })}
    ${field("e-note", "Details", it.note, { area: 1 })}
    ${field("e-go", "Getting there", it.go, { area: 1, rows: 2, ph: "e.g. Walk from hotel ~10 min · Keihan Line → Fushimi-Inari" })}
    ${field("e-ref", "Confirmation / reference", it.ref, { ph: "Booking #, locker #, PIN…" })}
    ${statusPick(it.st)}
    <label class="lbl">Type (for the Bookings filter)<div class="row seg" id="e-cat">${[["travel", "Travel"], ["food", "Food"], ["hotel", "Hotel"], ["do", "Other"]].map(([v, l]) => `<button class="tag${catOf(it) === v ? " sel" : ""}" data-st="${v}">${l}</button>`).join("")}</div></label>
    <label class="lbl">Links: tickets, emails, files, apps</label>
    <div id="e-links">${(it.links || []).map(linkRow).join("")}</div>
    <div class="row"><button class="tag" data-linkadd>+ Add link</button><button class="tag" data-linkadd="wallet">+ Apple Wallet</button></div>
    <p class="sub hint">Paste any link: a ticket PDF in Drive or iCloud, a confirmation email, a booking page. Links open when you have signal; keep a Wallet pass or screenshot as the offline backup.</p>
    <label class="lbl">Tickets &amp; photos</label>
    <div class="thumbs edit" id="e-atts"></div>
    <div class="row"><label class="tag attach">+ Attach photo or PDF<input type="file" id="e-file" accept="image/*,application/pdf,.pdf" multiple></label></div>
    <p class="sub hint">Saved on both phones and opens without signal. PDFs are turned into one picture per page.</p>`,
    () => {
      if (EA && EA.busy) { toast("Still preparing the picture…"); return false; }
      const nid = id || "u" + uid();
      if (isNew) put("c:" + nid, date);
      const nv = { t: $("#e-t").value.trim(), title: $("#e-title").value.trim(), note: $("#e-note").value.trim(), go: $("#e-go").value.trim(), ja: $("#e-ja").value.trim(), ref: $("#e-ref").value.trim(), st: $("#e-st .sel") ? $("#e-st .sel").dataset.st : "",
        cat: $("#e-cat .sel") ? $("#e-cat .sel").dataset.st : (it.cat || "") };
      if (!isNew && !it.cat && nv.cat === catOf(it)) nv.cat = "";   // don't pin a guessed type unless it was changed
      FIELDS.forEach(f => { if ((nv[f] || "") !== (it[f] || "")) put(`f:${nid}:${f}`, nv[f]); });
      const links = [...document.querySelectorAll("#e-links .lrow")].map(r => {
        const u = cleanUrl(r.querySelector(".l-url").value); return u ? [r.querySelector(".l-lab").value.trim() || guessLabel(u), u] : null;
      }).filter(Boolean);
      if (JSON.stringify(links) !== JSON.stringify(it.links || [])) put(`f:${nid}:links`, JSON.stringify(links));
      const ea = EA; EA = null; if (ea) saveAtts(ea, nid);
      renderAll(); toast("Saved");
    },
    isNew ? null : () => { attsFor(id).forEach(a => put("att:" + a.id, null)); if (it.custom) put("c:" + id, null); else put(`f:${id}:hide`, "1"); renderAll(); toast("Deleted"); });
  EA = { item: id || null, add: [], del: new Set(), busy: 0 }; renderEA();
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

// ---------- QR codes ----------
function openQr(group, key) {
  const list = qrs(group); if (!list.length) return;
  const me = (cfg.name || "").toLowerCase();
  const q = list.find(x => x.key === key) || list.find(x => (x.who || "").toLowerCase() === me) || list[0];
  $("#qr-t").textContent = q.title || "QR code";
  $("#qr-s").textContent = q.sub || "";
  $("#qr-img").src = safeImg(q.img);
  $("#qr-n").textContent = q.name || q.who || "";
  $("#qr-who").innerHTML = list.length > 1 ? list.map(x => `<button class="tag${x.key === q.key ? " sel" : ""}" data-qr="${esc(group)}" data-qrwho="${esc(x.key)}">${esc(x.who || x.name)}</button>`).join("") : "";
  $("#qr").classList.add("on");
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
  if (t.closest("summary")) return;   // native fold/unfold of a travel-day guide
  const tx = t.closest("[data-taxi]"); if (tx) { openTaxi(tx.dataset.taxi); return; }
  const qb = t.closest("[data-qr]"); if (qb) { e.stopPropagation(); openQr(qb.dataset.qr, qb.dataset.qrwho); return; }
  const gd = t.closest("[data-guide]"); if (gd) { openGuide(gd.dataset.guide); return; }
  const bf = t.closest("[data-bkf]"); if (bf) { bkFilter = bf.dataset.bkf; LS.set("tc.bkf", bkFilter); renderBookings(); return; }
  if (t.closest("#guides-toggle")) {
    const all = GUIDES.length && GUIDES.every(g => openGuides.has(g.id));
    GUIDES.forEach(g => { if (all) openGuides.delete(g.id); else openGuides.add(g.id); });
    LS.set("tc.open", [...openGuides]); renderMore(); return;
  }
  const ch = t.closest("[data-day]"); if (ch) { selected = +ch.dataset.day; LS.set("tc.sel", selected); renderStrip(); renderDay(); return; }
  const nb = t.closest("nav button"); if (nb) { show(nb.dataset.v); return; }
  const go = t.closest("[data-goto]"); if (go) { if (go.dataset.goto === "log") logTab = "bags"; show(go.dataset.goto); return; }
  const la = t.closest("[data-linkadd]");
  if (la) {
    const box = $("#e-links"); box.insertAdjacentHTML("beforeend", linkRow(la.dataset.linkadd === "wallet" ? ["Wallet", WALLET] : undefined));
    if (la.dataset.linkadd !== "wallet") box.lastElementChild.querySelector(".l-url").focus();
    return;
  }
  const vw = t.closest("[data-view]"); if (vw) { e.stopPropagation(); openViewer(vw.dataset.view, vw.dataset.vat); return; }
  const ad2 = t.closest("[data-attdel]");
  if (ad2 && EA) {
    const k = ad2.dataset.attdel, i = EA.add.findIndex(a => a.tid === k);
    if (i >= 0) { URL.revokeObjectURL(EA.add[i].url); EA.add.splice(i, 1); } else EA.del.add(k);
    renderEA(); return;
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
  if (e.target.id === "e-file") { const fs = [...e.target.files]; e.target.value = ""; addFiles(fs); return; }
  const td = e.target.dataset && e.target.dataset.td;
  if (td) { put("td:" + td, e.target.checked ? "1" : "0"); e.target.closest("li").classList.toggle("done", e.target.checked); }
});
// Remember which guides are unfolded so a background sync/re-render doesn't fold them back up.
// ("toggle" doesn't bubble, so listen in the capture phase.)
document.addEventListener("toggle", e => {
  const g = e.target && e.target.dataset && e.target.dataset.gid; if (!g) return;
  if (e.target.open) openGuides.add(g); else openGuides.delete(g);
  LS.set("tc.open", [...openGuides]);
  if (view === "more") { const all = GUIDES.length && GUIDES.every(x => openGuides.has(x.id)); $("#guides-toggle").textContent = all ? "Fold all" : "Unfold all"; }
}, true);
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
$("#qr-close").onclick = () => $("#qr").classList.remove("on");
$("#vw-close").onclick = () => $("#vw").classList.remove("on");

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
  attInit().then(() => { renderAll(); attPump(); });
  setInterval(renderSync, 30000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
