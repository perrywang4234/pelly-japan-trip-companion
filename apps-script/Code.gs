/**
 * Trip Companion sync — paste into the planner sheet (Extensions → Apps Script)
 * and deploy as a Web app (Execute as: Me · Who has access: Anyone).
 *
 * Storage: tab "AppSync"  →  key | value | updated (ms) | by | deleted
 * Passcode: tab "AppConfig", cell B1. Phones must send it with every request.
 * Merge rule: per key, the newest edit wins (by timestamp).
 *
 * Attachments (ticket photos, PDF pages): the picture itself is stored as a JPEG in a private
 * Drive folder "Trip Companion attachments" (file name = attachment id + ".jpg"). The AppSync
 * row att:<id> only describes it. Phones upload with action "upload" and download with "get".
 * Run setupAttachments() once from the editor to create the folder and approve Drive access.
 */
const SYNC_TAB = 'AppSync';
const CONFIG_TAB = 'AppConfig';
const ATT_FOLDER = 'Trip Companion attachments';
const ATT_ID = /^[A-Za-z0-9_-]{4,40}$/;
const ATT_MAX_B64 = 12 * 1024 * 1024;   // ~9 MB image; phones send ~0.5 MB

function doGet() {
  return json_({ ok: true, msg: 'Trip Companion sync is running.', attachments: true });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad request' }); }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const code = String(ss.getSheetByName(CONFIG_TAB).getRange('B1').getDisplayValue()).trim();
  if (!code || String(body.code || '').trim() !== code) return json_({ ok: false, error: 'wrong passcode' });

  if (body.action === 'upload') return json_(attUpload_(body));
  if (body.action === 'get') return json_(attGet_(body));

  const trash = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = ss.getSheetByName(SYNC_TAB);
    const last = sh.getLastRow();
    const n = Math.max(last - 1, 0);
    // Read: key/value as displayed text (keeps leading zeros), updated as a number.
    const rows = n ? sh.getRange(2, 1, n, 5).getDisplayValues() : [];
    const tsCol = n ? sh.getRange(2, 3, n, 1).getValues() : [];
    const idx = {};
    const data = rows.map((r, i) => {
      idx[r[0]] = i;
      return [r[0], r[1], Number(tsCol[i][0]) || 0, r[3], r[4] === 'TRUE' || r[4] === 'true' ? 'TRUE' : ''];
    });

    let changed = false;
    (body.changes || []).forEach(c => {
      if (!c || typeof c.k !== 'string' || !c.k) return;
      const ts = Number(c.ts) || Date.now();
      const row = [c.k, c.v == null ? '' : String(c.v), ts, String(c.by || ''), c.del ? 'TRUE' : ''];
      let applied = false;
      if (c.k in idx) {
        if (ts > data[idx[c.k]][2]) { data[idx[c.k]] = row; applied = true; }
      } else {
        idx[c.k] = data.length; data.push(row); applied = true;
      }
      if (applied) {
        changed = true;
        if (c.del && c.k.indexOf('att:') === 0) trash.push(c.k.slice(4));   // attachment removed on a phone
      }
    });

    if (changed && data.length) {
      const rng = sh.getRange(2, 1, data.length, 5);
      sh.getRange(2, 2, data.length, 1).setNumberFormat('@'); // value column stays text
      rng.setValues(data);
    }

    return json_({
      ok: true,
      now: Date.now(),
      rows: data.map(r => ({ k: r[0], v: r[4] ? null : r[1], ts: r[2], by: r[3], del: !!r[4] }))
    });
  } finally {
    lock.releaseLock();
    trash.forEach(id => { try { attFiles_(id).forEach(f => f.setTrashed(true)); } catch (err) {} });
  }
}

// ---------- attachments ----------

/** Run once from the Apps Script editor (select it, click Run) to create the folder and approve Drive access. */
function setupAttachments() {
  const f = attFolder_();
  Logger.log('Attachments folder ready: ' + f.getUrl());
}

function attFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ATT_FOLDER_ID');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (err) {}
  }
  const f = DriveApp.createFolder(ATT_FOLDER);
  f.setDescription('Ticket photos and PDF pages attached in the Trip Companion app. Managed by the sync script.');
  props.setProperty('ATT_FOLDER_ID', f.getId());
  return f;
}

function attFiles_(id) {
  const out = [], it = attFolder_().getFilesByName(id + '.jpg');
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) out.push(f); }
  return out;
}

function attUpload_(b) {
  const id = String(b.id || '');
  if (!ATT_ID.test(id)) return { ok: false, error: 'bad attachment id' };
  const data = String(b.data || '');
  if (!data || data.length > ATT_MAX_B64) return { ok: false, error: 'attachment missing or too large' };
  if (attFiles_(id).length) return { ok: true, id: id, existed: true };   // already uploaded (retry)
  let bytes;
  try { bytes = Utilities.base64Decode(data); } catch (err) { return { ok: false, error: 'bad attachment data' }; }
  if (!(bytes.length > 3 && (bytes[0] & 255) === 0xFF && (bytes[1] & 255) === 0xD8)) return { ok: false, error: 'not a JPEG' };
  attFolder_().createFile(Utilities.newBlob(bytes, 'image/jpeg', id + '.jpg'));
  return { ok: true, id: id };
}

function attGet_(b) {
  const id = String(b.id || '');
  if (!ATT_ID.test(id)) return { ok: false, error: 'bad attachment id' };
  const files = attFiles_(id);
  if (!files.length) return { ok: false, missing: true, error: 'not uploaded yet' };
  return { ok: true, id: id, mime: 'image/jpeg', data: Utilities.base64Encode(files[0].getBlob().getBytes()) };
}

// ---------- sheet edits ----------

/** Edits typed directly into the AppSync tab get a fresh timestamp so they reach both phones. */
function onEdit(e) {
  const sh = e.range.getSheet();
  if (sh.getName() !== SYNC_TAB || e.range.getRow() < 2) return;
  const col = e.range.getColumn();
  if (col === 2 || col === 5) {
    for (let r = e.range.getRow(); r <= e.range.getLastRow(); r++) {
      sh.getRange(r, 3).setValue(Date.now());
      sh.getRange(r, 4).setValue('sheet');
    }
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
