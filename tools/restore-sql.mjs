// 還原備份輸出的 SQL（restore-backup.mjs 用；拆出來方便測試）
//   還原（每日備份或 D1 Time Travel）會把資料帶回某個時間點；那個時間點之後本人做的「撤回」要在匯入後重做，
//   不然會跟著舊資料回來（PDPA／A.5.34）。重做的依據是稽核紀錄（audit_log），一律在還原「之前」從正式資料庫抓（唯讀）：
//   - 刪除帳號 privacy.delete：跟 DELETE /api/me 同一份 SQL（src/erase.js）
//   - 刪除賽事報名資料 privacy.race_profile_delete：刪 member_private、清掉報名上的「同意代為報名」
//   - 停止分享訓練 privacy.share_logs、退出排行榜 privacy.show_rank：最後一次是「關閉」就關掉（同一秒有開有關，以關閉為準）
//   - 通知分類 notif.prefs：照最後一次的設定（同一秒有好幾筆，取關掉的聯集）
//   - 取消推播 push.unsubscribe、登出所有裝置 session.revoke_all：刪掉這個人的推播訂閱（之後在「通知設定」重新連上）
//   - 移除通行金鑰 passkey.remove：detail 有金鑰 id 前綴就刪那一把；舊紀錄沒有前綴時讓他的登入失效，並列出來請本人再刪一次
//   - 讓登入失效的動作（身分變更、理事長移交、初始理事長、登出所有裝置）：刪掉他的工作階段（Time Travel 會把撤銷的登入帶回來）
//   最後把抓到的稽核紀錄原樣補回 audit_log（INSERT OR IGNORE，簽章照原本的，驗得過）：Time Travel 會連稽核紀錄一起倒回，
//   補回來之後，下次再從更舊的備份還原時也查得到這些撤回
import { ERASE_MEMBER, ERASE_ACTIONS } from '../src/erase.js';
import { MUTABLE } from '../public/notif-cats.js';

const ID = /^[\w-]{1,64}$/, AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, PK = /^[\w-]{8,64}$/;
export const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export const sqlTime = (at) => String(at || '').replace('T', ' ').slice(0, 19);
export const AUDIT_COLS = ['id', 'at', 'actor_id', 'actor_name', 'actor_role', 'action', 'target_type', 'target_id', 'detail', 'ip_hash', 'mac'];
// 本人的撤回
export const WITHDRAW_ACTIONS = ['privacy.race_profile_delete', 'privacy.share_logs', 'privacy.show_rank', 'notif.prefs', 'push.unsubscribe', 'session.revoke_all', 'passkey.remove'];
// 讓某人的登入失效的動作（target_id；理事長移交另外連 actor_id）
export const REVOKE_ACTIONS = ['role.change', 'role.handover', 'bootstrap.chair', 'session.revoke_all'];
export const REPLAY_ACTIONS = [...new Set([...ERASE_ACTIONS, ...WITHDRAW_ACTIONS, ...REVOKE_ACTIONS])];

// 到正式資料庫查「這個時間之後」的撤回（唯讀）：整列抓下來，重做之後原樣補回 audit_log
export const replayQuery = (at) => `SELECT ${AUDIT_COLS.join(', ')} FROM audit_log WHERE action IN (${REPLAY_ACTIONS.map(lit).join(', ')}) AND at >= ${lit(sqlTime(at))} ORDER BY at, id`;
// 舊版只查刪除帳號（相容用）
export const erasedQuery = (at) => `SELECT target_id FROM audit_log WHERE action IN (${ERASE_ACTIONS.map(lit).join(', ')}) AND at >= ${lit(sqlTime(at))}`;

// 撤回紀錄，來源可以是：
//   wrangler d1 execute --json 的輸出（[{ results: [...] }]；只有 target_id 的舊格式當成刪除帳號）
//   比這份新的備份解出來的 JSON（讀它的 audit_log，只取 at 之後）｜一行一個或逗號分隔的帳號 id（刪除帳號）
//   不在 REPLAY_ACTIONS 的動作略過；欄位看不懂（可能被改過）就整份擋下
export function auditRowsFrom(text, at) {
  let j = null;
  try { j = JSON.parse(text); } catch {}
  let rows;
  if (j?.format === 'cil-backup') rows = j.tables?.audit_log || [];
  else if (j != null && typeof j === 'object') rows = [j].flat().flatMap((x) => x?.results || []);
  else rows = String(text).split(/[\s,]+/).filter(Boolean).map((target_id) => ({ action: ERASE_ACTIONS[0], target_id }));
  rows = rows.map((r) => (r && typeof r === 'object' && !('action' in r) ? { ...r, action: ERASE_ACTIONS[0] } : r));
  const since = at ? sqlTime(at) : null;
  const bad = (r) => !r || typeof r !== 'object' || typeof r.target_id !== 'string' || !ID.test(r.target_id)
    || (r.actor_id != null && (typeof r.actor_id !== 'string' || !ID.test(r.actor_id)))
    || (r.at != null && !AT.test(String(r.at))) || (r.detail != null && (typeof r.detail !== 'string' || r.detail.length > 300));
  const out = [];
  for (const r of rows) {
    if (!REPLAY_ACTIONS.includes(r?.action)) continue;
    if (bad(r)) throw new Error(`看不懂的稽核紀錄或帳號 id：${String(r?.target_id ?? '').slice(0, 40)}`);
    if (since && r.at != null && String(r.at) < since) continue;
    out.push(r);
  }
  return out;
}
// 相容：只要刪除帳號的 id
export const erasedFrom = (text, at) => [...new Set(auditRowsFrom(text, at).filter((r) => ERASE_ACTIONS.includes(r.action)).map((r) => r.target_id))];

// 每個人最後一次（同一秒的全部）的紀錄
function latest(rows, action) {
  const by = new Map();
  for (const r of rows.filter((x) => x.action === action)) {
    const cur = by.get(r.target_id), at = String(r.at ?? '');
    if (!cur || at > cur.at) by.set(r.target_id, { at, rows: [r] });
    else if (at === cur.at) cur.rows.push(r);
  }
  return by;
}
const offAtLast = (rows, action) => [...latest(rows, action)].filter(([, v]) => v.rows.some((r) => r.detail === '關閉')).map(([id]) => id);
const pkPrefix = (r) => { const m = /^id=([\w-]+)$/.exec(r.detail || ''); return m && PK.test(m[1]) ? m[1] : null; };

// 從稽核紀錄算出要重做什麼
export function planReplay(rows) {
  const ids = (pred) => [...new Set(rows.filter(pred).map((r) => r.target_id))];
  const mute = new Map();
  for (const [id, v] of latest(rows, 'notif.prefs')) {
    const cats = new Set();
    for (const r of v.rows) { const m = /^mute=([\w,]*)$/.exec(r.detail || 'mute='); for (const c of (m ? m[1] : '').split(',')) if (MUTABLE.includes(c)) cats.add(c); }
    mute.set(id, cats.size ? MUTABLE.filter((c) => cats.has(c)).join(',') : null);
  }
  const pk = rows.filter((r) => r.action === 'passkey.remove');
  const passkeys = pk.filter(pkPrefix).map((r) => [r.target_id, pkPrefix(r)]);
  const passkeyUnknown = [...new Set(pk.filter((r) => !pkPrefix(r)).map((r) => r.target_id))];
  const revoke = new Set([...ids((r) => REVOKE_ACTIONS.includes(r.action)), ...passkeyUnknown]);
  for (const r of rows) if (r.action === 'role.handover' && r.actor_id) revoke.add(r.actor_id);
  return {
    erased: ids((r) => ERASE_ACTIONS.includes(r.action)),
    raceDelete: ids((r) => r.action === 'privacy.race_profile_delete'),
    shareOff: offAtLast(rows, 'privacy.share_logs'),
    rankOff: offAtLast(rows, 'privacy.show_rank'),
    mute,
    pushOff: ids((r) => r.action === 'push.unsubscribe' || r.action === 'session.revoke_all'),
    passkeys, passkeyUnknown,
    revoke: [...revoke],
  };
}
// 給人看的摘要（只有人數，不印帳號 id）
export const planSummary = (p) => [
  ['刪除帳號', p.erased.length], ['刪除賽事報名資料', p.raceDelete.length], ['停止分享訓練', p.shareOff.length], ['退出排行榜', p.rankOff.length],
  ['通知分類設定', p.mute.size], ['推播訂閱刪除', p.pushOff.length], ['通行金鑰刪除', p.passkeys.length], ['登入失效', p.revoke.length],
].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join('、') || '沒有要重做的撤回';

// 重做撤回的 SQL（放在匯入的最後，蓋過剛匯入的舊資料）；timeTravel：Time Travel 之後用，另外清掉倒回來的推播佇列（不重送舊推播）
export function replaySql(rows, { timeTravel = false } = {}) {
  const p = planReplay(rows), L = [];
  const each = (list, sqls) => { for (const id of list) { if (!ID.test(id)) throw new Error(`看不懂的帳號 id：${id}`); for (const q of sqls) L.push(`${q.replaceAll('?1', lit(id))};`); } };
  each(p.erased, ERASE_MEMBER);
  each(p.raceDelete, ['DELETE FROM member_private WHERE member_id = ?1', 'UPDATE signups SET reg_consent_at = NULL WHERE member_id = ?1']);
  each(p.shareOff, ['UPDATE members SET share_logs = 0 WHERE id = ?1']);
  each(p.rankOff, ['UPDATE members SET show_rank = 0 WHERE id = ?1']);
  for (const [id, v] of p.mute) { if (!ID.test(id)) throw new Error(`看不懂的帳號 id：${id}`); L.push(`UPDATE members SET notif_mute = ${lit(v)} WHERE id = ${lit(id)};`); }
  each(p.pushOff, ['DELETE FROM push_subs WHERE member_id = ?1']);
  for (const [id, pre] of p.passkeys) L.push(`DELETE FROM passkeys WHERE member_id = ${lit(id)} AND substr(id, 1, ${pre.length}) = ${lit(pre)};`);
  each(p.revoke, ['DELETE FROM sessions WHERE member_id = ?1']);
  if (timeTravel) L.push('DELETE FROM push_queue;');
  // 原樣補回稽核紀錄（只補整列都有的；已經在的不動）
  for (const r of rows) if (r.id && r.at && r.mac) L.push(`INSERT OR IGNORE INTO audit_log (${AUDIT_COLS.join(', ')}) VALUES (${AUDIT_COLS.map((c) => lit(r[c])).join(', ')});`);
  return { lines: L, plan: p };
}

// erased：舊用法（只有帳號 id）；audit：auditRowsFrom 讀出來的撤回紀錄
export function toSql(data, { only = null, erased = [], audit = [] } = {}) {
  const lines = ['PRAGMA defer_foreign_keys = true;'];
  for (const [t, rows] of Object.entries(data.tables)) {
    if (only && t !== only) continue;
    for (const r of rows) { const cols = Object.keys(r); lines.push(`INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`); }
  }
  // 跑者休息站：備份只有幹部整理、新增、修正、隱藏或補充說明過的列；把來源的版本標記清掉，下次同步（維護工具與排程）才會整份重寫官方資料
  if (data.tables.rest_sources && (!only || only === 'rest_sources' || only === 'rest_stops')) lines.push('UPDATE rest_sources SET etag = NULL, cursor = NULL;');
  // 重做備份之後的撤回（放在最後，蓋過剛匯入的舊資料）
  for (const id of erased) if (typeof id !== 'string' || !ID.test(id)) throw new Error(`看不懂的帳號 id：${id}`);
  lines.push(...replaySql([...erased.map((target_id) => ({ action: ERASE_ACTIONS[0], target_id })), ...audit]).lines);
  return lines;
}
