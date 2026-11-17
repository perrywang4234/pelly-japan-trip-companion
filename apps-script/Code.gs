/**
 * Trip Companion sync — paste into the planner sheet (Extensions → Apps Script)
 * and deploy as a Web app (Execute as: Me · Who has access: Anyone).
 *
 * Storage: tab "AppSync"  →  key | value | updated (ms) | by | deleted
 * Passcode: tab "AppConfig", cell B1. Phones must send it with every sync.
 * Merge rule: per key, the newest edit wins (by timestamp).
 */
const SYNC_TAB = 'AppSync';
const CONFIG_TAB = 'AppConfig';

function doGet() {
  return json_({ ok: true, msg: 'Trip Companion sync is running.' });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad request' }); }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const code = String(ss.getSheetByName(CONFIG_TAB).getRange('B1').getDisplayValue()).trim();
  if (!code || String(body.code || '').trim() !== code) return json_({ ok: false, error: 'wrong passcode' });

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
      if (c.k in idx) {
        if (ts > data[idx[c.k]][2]) { data[idx[c.k]] = row; changed = true; }
      } else {
        idx[c.k] = data.length; data.push(row); changed = true;
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
  }
}

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
