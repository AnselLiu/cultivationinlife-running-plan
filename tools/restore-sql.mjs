// 還原備份輸出的 SQL（restore-backup.mjs 用；拆出來方便測試）
//   erased：備份之後被刪除的帳號 id。匯入完再重做一次刪除（跟 DELETE /api/me 同一份 SQL，見 src/erase.js），
//   被刪掉的帳號、電話、訓練紀錄、報名等不會跟著舊備份回來（PDPA／A.5.34）
import { ERASE_MEMBER, ERASE_ACTIONS } from '../src/erase.js';

const ID = /^[\w-]{1,64}$/;
export const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const sqlTime = (at) => String(at || '').replace('T', ' ').slice(0, 19);
// 備份之後刪除的帳號 id，來源可以是：
//   wrangler d1 execute --json 的輸出（[{ results: [{ target_id }] }]）｜比這份新的備份解出來的 JSON（讀它的 audit_log，只取 at 之後）｜一行一個或逗號分隔的 id
export function erasedFrom(text, at) {
  let j = null;
  try { j = JSON.parse(text); } catch {}
  let ids;
  if (j?.format === 'cil-backup') ids = (j.tables?.audit_log || []).filter((r) => ERASE_ACTIONS.includes(r.action) && String(r.at) >= sqlTime(at)).map((r) => r.target_id);
  else if (j != null && typeof j === 'object') ids = [j].flat().flatMap((x) => x?.results || []).map((r) => r?.target_id);
  else ids = String(text).split(/[\s,]+/).filter(Boolean);
  const bad = ids.filter((x) => typeof x !== 'string' || !ID.test(x));
  if (bad.length) throw new Error(`看不懂的帳號 id：${bad.slice(0, 3).map(String).join('、')}`);
  return [...new Set(ids)];
}

// 到正式資料庫查「備份開始之後」刪除的帳號（唯讀）
export const erasedQuery = (at) => `SELECT target_id FROM audit_log WHERE action IN (${ERASE_ACTIONS.map(lit).join(', ')}) AND at >= ${lit(sqlTime(at))}`;

export function toSql(data, { only = null, erased = [] } = {}) {
  const lines = ['PRAGMA defer_foreign_keys = true;'];
  for (const [t, rows] of Object.entries(data.tables)) {
    if (only && t !== only) continue;
    for (const r of rows) { const cols = Object.keys(r); lines.push(`INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`); }
  }
  // 跑者休息站：備份只有幹部整理、新增、修正、隱藏或補充說明過的列；把來源的版本標記清掉，下次同步（維護工具與排程）才會整份重寫官方資料
  if (data.tables.rest_sources && (!only || only === 'rest_sources' || only === 'rest_stops')) lines.push('UPDATE rest_sources SET etag = NULL, cursor = NULL;');
  // 重做備份之後的刪除帳號（放在最後，蓋過剛匯入的舊資料）
  for (const id of erased) {
    if (!ID.test(id)) throw new Error(`看不懂的帳號 id：${id}`);
    for (const q of ERASE_MEMBER) lines.push(`${q.replaceAll('?1', lit(id))};`);
  }
  return lines;
}
