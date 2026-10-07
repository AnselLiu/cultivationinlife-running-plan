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
//   - 身分與分團身分（role.change、role.handover、bootstrap.chair、team.role）：照時間順序重設成最後一次的身分，
//     降級的人不會在重新登入後拿回原本的權限；detail 結尾有 ｜role=代碼（新紀錄）就照代碼，舊紀錄照中文名稱，看不懂的列出人數請人工確認
//   - 退出分團 team.leave、被移出或婉拒 team.remove／team.reject：刪掉 team_members 那一列（不然那個分團的幹部又看得到他分享的訓練）；
//     detail 結尾有 ｜team=分團 id 就照 id，舊紀錄照分團名稱。之後又重新加入的，還原後要再加入一次（隱私優先）
//   - 停用或重新產生行事曆訂閱 calendar.off／calendar.on：清掉 cal_token_hash（倒回來的舊網址可能外流過；本人重新產生一個）
//   - 刪掉自己的訓練紀錄 log.delete、路線 route.delete、分團公告 team.post_delete：照 id 再刪一次
//   - 關掉「讓推薦的跑友用 Gmail 找到我」privacy.email_lookup：最後一次是「關閉」就關掉並刪掉查詢碼（同一秒有開有關，以關閉為準）
//   - 移除推薦人 referrer.clear（本人）、referrer.admin_clear（幹部）：清掉推薦人
//   - 推薦人按「不是我」referrer.deny（actor＝推薦人、target＝被推薦的人）：只清掉推薦人還是這位的那一筆，並補回 180 天的冷卻（rate_limits）
//   members 用 INSERT … ON CONFLICT(id) DO UPDATE（不是 INSERT OR REPLACE）：REPLACE 會先刪掉舊的那一列，
//     觸發 referrer_id 的 ON DELETE SET NULL（已經還原的人推薦關係不見）與子表的 ON DELETE CASCADE
//   最後把抓到的稽核紀錄原樣補回 audit_log（INSERT OR IGNORE，簽章照原本的，驗得過）：Time Travel 會連稽核紀錄一起倒回，
//   補回來之後，下次再從更舊的備份還原時也查得到這些撤回
import { ERASE_MEMBER, ERASE_ACTIONS } from '../src/erase.js';
import { MUTABLE } from '../public/notif-cats.js';

const ID = /^[\w-]{1,64}$/, AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, PK = /^[\w-]{8,64}$/;
export const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export const sqlTime = (at) => String(at || '').replace('T', ' ').slice(0, 19);
export const AUDIT_COLS = ['id', 'at', 'actor_id', 'actor_name', 'actor_role', 'action', 'target_type', 'target_id', 'detail', 'ip_hash', 'mac'];
// 本人的撤回
export const WITHDRAW_ACTIONS = ['privacy.race_profile_delete', 'privacy.share_logs', 'privacy.show_rank', 'notif.prefs', 'push.unsubscribe', 'session.revoke_all', 'passkey.remove',
  'team.leave', 'team.remove', 'team.reject', 'calendar.off', 'calendar.on', 'log.delete', 'route.delete', 'team.post_delete',
  'privacy.email_lookup', 'referrer.clear', 'referrer.deny', 'referrer.admin_clear'];
// 身分：照時間順序重設成最後一次（跟 team.leave／remove 一起照順序做）
export const ROLE_ACTIONS = ['role.change', 'role.handover', 'bootstrap.chair', 'team.role'];
// 中文名稱 → 代碼（跟 src/worker.js 的 ROLES、TEAM_ROLES 一樣；tests/restore.test.mjs 會比對）
export const ROLE_LABELS = { 理事長: 'chair', 理事: 'director', 監事: 'supervisor', 行政人員: 'staff', 教練: 'coach', 團員: 'member' };
export const TEAM_ROLE_LABELS = { 團長: 'lead', 幹部: 'officer', 團員: 'member' };
const ROLE_OF = Object.fromEntries(Object.entries(ROLE_LABELS).map(([k, v]) => [v, k])), TEAM_ROLE_OF = Object.fromEntries(Object.entries(TEAM_ROLE_LABELS).map(([k, v]) => [v, k]));
// 一定要有做這件事的人（actor_id）才能重做
const NEED_ACTOR = ['team.leave', 'log.delete', 'referrer.deny'];
// 讓某人的登入失效的動作（target_id；理事長移交另外連 actor_id）
export const REVOKE_ACTIONS = ['role.change', 'role.handover', 'bootstrap.chair', 'session.revoke_all'];
export const REPLAY_ACTIONS = [...new Set([...ERASE_ACTIONS, ...WITHDRAW_ACTIONS, ...REVOKE_ACTIONS, ...ROLE_ACTIONS])];

// 到正式資料庫查「這個時間之後」的撤回（唯讀）：整列抓下來，重做之後原樣補回 audit_log
export const replayQuery = (at) => `SELECT ${AUDIT_COLS.join(', ')} FROM audit_log WHERE action IN (${REPLAY_ACTIONS.map(lit).join(', ')}) AND at >= ${lit(sqlTime(at))} ORDER BY at, id`;
// 同一個條件的筆數（唯讀）：跟抓下來的檔案比對，確認沒有抓漏
export const replayCountQuery = (at) => `SELECT COUNT(*) AS n FROM audit_log WHERE action IN (${REPLAY_ACTIONS.map(lit).join(', ')}) AND at >= ${lit(sqlTime(at))}`;
// 舊版只查刪除帳號（相容用）
export const erasedQuery = (at) => `SELECT target_id FROM audit_log WHERE action IN (${ERASE_ACTIONS.map(lit).join(', ')}) AND at >= ${lit(sqlTime(at))}`;

// 撤回紀錄，來源可以是：
//   wrangler d1 execute --json 的輸出（[{ results: [...], success: true }]；只有 target_id 的舊格式當成刪除帳號）
//     每一段都要 success: true 而且有 results 陣列，不然當成「抓取失敗」整份擋下（wrangler 出錯時印的 {"error":…} 不能當成「沒有撤回」）
//   比這份新的備份解出來的 JSON（讀它的 audit_log，只取 at 之後）｜一行一個或逗號分隔的帳號 id（刪除帳號）
//   不在 REPLAY_ACTIONS 的動作略過；欄位看不懂（可能被改過）就整份擋下
export function auditRowsFrom(text, at) {
  let j = null;
  try { j = JSON.parse(text); } catch {}
  let rows;
  if (j?.format === 'cil-backup') rows = j.tables?.audit_log || [];
  else if (j != null && typeof j === 'object') {
    const parts = [j].flat();
    if (!parts.length || parts.some((x) => !x || typeof x !== 'object' || x.success !== true || !Array.isArray(x.results))) {
      throw new Error('抓取撤回紀錄失敗（不是 wrangler 成功的輸出）：請檢查 withdrawals.json，重新執行查詢，不要繼續還原');
    }
    rows = parts.flatMap((x) => x.results);
  }
  else rows = String(text).split(/[\s,]+/).filter(Boolean).map((target_id) => ({ action: ERASE_ACTIONS[0], target_id }));
  rows = rows.map((r) => (r && typeof r === 'object' && !('action' in r) ? { ...r, action: ERASE_ACTIONS[0] } : r));
  const since = at ? sqlTime(at) : null;
  const bad = (r) => !r || typeof r !== 'object' || typeof r.target_id !== 'string' || !ID.test(r.target_id)
    || (r.actor_id != null && (typeof r.actor_id !== 'string' || !ID.test(r.actor_id)))
    || (r.at != null && !AT.test(String(r.at))) || (r.detail != null && (typeof r.detail !== 'string' || r.detail.length > 300))
    || (NEED_ACTOR.includes(r.action) && !r.actor_id);
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
  // 身分與分團成員：照時間順序（同一秒照 id）一步一步做，結果等於最後一次
  const steps = [], unresolved = [];
  for (const r of [...rows].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? '')))) {
    if (!ROLE_ACTIONS.includes(r.action) && !['team.leave', 'team.remove', 'team.reject'].includes(r.action)) continue;
    const s = teamStep(r) || roleStep(r);
    if (s) steps.push(s); else unresolved.push(r);
  }
  return {
    erased: ids((r) => ERASE_ACTIONS.includes(r.action)),
    raceDelete: ids((r) => r.action === 'privacy.race_profile_delete'),
    shareOff: offAtLast(rows, 'privacy.share_logs'),
    rankOff: offAtLast(rows, 'privacy.show_rank'),
    mute,
    pushOff: ids((r) => r.action === 'push.unsubscribe' || r.action === 'session.revoke_all'),
    passkeys, passkeyUnknown,
    revoke: [...revoke],
    steps, unresolved,
    calOff: ids((r) => r.action === 'calendar.off' || r.action === 'calendar.on'),
    logs: rows.filter((r) => r.action === 'log.delete').map((r) => [r.target_id, r.actor_id]),
    routes: ids((r) => r.action === 'route.delete'),
    posts: rows.filter((r) => r.action === 'team.post_delete' && ID.test(r.detail || '')).map((r) => [r.target_id, r.detail]),
    emailOff: offAtLast(rows, 'privacy.email_lookup'),
    refClear: ids((r) => r.action === 'referrer.clear' || r.action === 'referrer.admin_clear'),
    refDeny: rows.filter((r) => r.action === 'referrer.deny').map((r) => [r.target_id, r.actor_id, sqlTime(r.at)]),
  };
}
// 分團：team.leave（actor 退出 target 這個分團）、team.remove／reject（target 被移出，分團看 detail）、team.role（分團身分）
//   新紀錄 detail 結尾有 ｜team=分團 id（team.role 再加 ｜role=代碼）；舊紀錄只有分團名稱，照名稱找
const TEAM_TAIL = /｜team=([\w-]{1,32})$/, TEAM_ROLE_TAIL = /｜team=([\w-]{1,32})｜role=(lead|officer|member)$/;
function teamStep(r) {
  const d = r.detail || '';
  if (r.action === 'team.leave') return { kind: 'leave', member: r.actor_id, team: { id: r.target_id } };
  if (r.action === 'team.remove' || r.action === 'team.reject') {
    const m = TEAM_TAIL.exec(d);
    if (m) return { kind: 'leave', member: r.target_id, team: { id: m[1] } };
    return d && !d.includes('｜') ? { kind: 'leave', member: r.target_id, team: { name: d } } : null;
  }
  if (r.action === 'team.role') {
    const m = TEAM_ROLE_TAIL.exec(d);
    if (m && d.includes(`／${TEAM_ROLE_OF[m[2]]}`)) return { kind: 'teamRole', member: r.target_id, team: { id: m[1] }, role: m[2] };
    const o = /^(.+)／(團長|幹部|團員)(?:／(.*))?$/.exec(d);
    return o && !d.includes('｜') ? { kind: 'teamRole', member: r.target_id, team: { name: o[1] }, role: TEAM_ROLE_LABELS[o[2]] } : null;
  }
  return null;
}
// 協會身分：role.change（detail＝名稱[／職稱][｜role=代碼]）、role.handover（target 成為理事長，actor 改為 ｜role= 或「原理事長改為名稱」）、bootstrap.chair
const ROLE_TAIL = /｜role=(\w+)$/, ROLE_OLD = new RegExp(`^(${Object.keys(ROLE_LABELS).join('|')})(?:／(.*))?$`);
function roleStep(r) {
  const d = r.detail || '', tail = ROLE_TAIL.exec(d);
  if (r.action === 'bootstrap.chair') return { kind: 'role', member: r.target_id, role: 'chair', keepTitle: true };
  if (r.action === 'role.change') {
    if (tail && ROLE_OF[tail[1]] && (d.startsWith(`${ROLE_OF[tail[1]]}／`) || d.startsWith(`${ROLE_OF[tail[1]]}｜`))) {
      const head = d.slice(0, tail.index), title = head.startsWith(`${ROLE_OF[tail[1]]}／`) ? head.slice(ROLE_OF[tail[1]].length + 1) : null;
      return { kind: 'role', member: r.target_id, role: tail[1], title };
    }
    const o = ROLE_OLD.exec(d);
    return o && !d.includes('｜') ? { kind: 'role', member: r.target_id, role: ROLE_LABELS[o[1]], title: o[2] ?? null } : null;
  }
  if (r.action === 'role.handover') {
    if (!r.actor_id) return null;
    const key = tail && ROLE_OF[tail[1]] && tail[1] !== 'chair' && d.slice(0, tail.index).endsWith(`原理事長改為${ROLE_OF[tail[1]]}`) ? tail[1]
      : !d.includes('｜') ? ROLE_LABELS[new RegExp(`原理事長改為(${Object.keys(ROLE_LABELS).join('|')})$`).exec(d)?.[1]] : null;
    return key && key !== 'chair' ? { kind: 'handover', member: r.target_id, from: r.actor_id, role: key } : null;
  }
  return null;
}
const teamWhere = (t) => (t.id ? `team_id = ${lit(t.id)}` : `team_id IN (SELECT id FROM teams WHERE name = ${lit(t.name)})`);
function stepSql(s) {
  for (const id of [s.member, s.from, s.team?.id].filter((x) => x != null)) if (!ID.test(id)) throw new Error(`看不懂的 id：${id}`);
  if (s.kind === 'leave') return [`DELETE FROM team_members WHERE member_id = ${lit(s.member)} AND ${teamWhere(s.team)};`];
  // 分團身分：降為團員時職稱一起清掉（跟後台指派一樣；其他身分的職稱保留還原時的）
  if (s.kind === 'teamRole') return [`UPDATE team_members SET role = ${lit(s.role)}, status = 'active'${s.role === 'member' ? ', title = NULL' : ''} WHERE member_id = ${lit(s.member)} AND ${teamWhere(s.team)};`];
  if (s.kind === 'role') return [`UPDATE members SET role = ${lit(s.role)}${s.keepTitle ? '' : `, title = ${lit(s.title ? s.title.slice(0, 20) : null)}`} WHERE id = ${lit(s.member)};`];
  if (s.kind === 'handover') return [`UPDATE members SET role = 'chair', title = NULL WHERE id = ${lit(s.member)};`, `UPDATE members SET role = ${lit(s.role)} WHERE id = ${lit(s.from)};`];
  return [];
}
// 給人看的摘要（只有人數，不印帳號 id）
export const planSummary = (p) => [
  ['刪除帳號', p.erased.length], ['刪除賽事報名資料', p.raceDelete.length], ['停止分享訓練', p.shareOff.length], ['退出排行榜', p.rankOff.length],
  ['通知分類設定', p.mute.size], ['推播訂閱刪除', p.pushOff.length], ['通行金鑰刪除', p.passkeys.length], ['登入失效', p.revoke.length],
  ['身分與分團成員', p.steps.length], ['行事曆訂閱停用', p.calOff.length], ['訓練紀錄刪除', p.logs.length], ['路線刪除', p.routes.length], ['分團公告刪除', p.posts.length],
  ['Gmail 查詢關閉', p.emailOff.length], ['推薦人移除', p.refClear.length], ['推薦人「不是我」', p.refDeny.length],
  ['看不懂、要人工確認的身分或分團紀錄', p.unresolved.length],
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
  for (const s of p.steps) L.push(...stepSql(s));
  each(p.calOff, ['UPDATE members SET cal_token_hash = NULL WHERE id = ?1']);
  each(p.emailOff, ['UPDATE members SET email_findable = 0, email_h = NULL WHERE id = ?1']);
  each(p.refClear, ['UPDATE members SET referrer_id = NULL, referrer_name = NULL, referrer_at = NULL, referrer_by = NULL, referrer_ack = NULL, referrer_gone = 0 WHERE id = ?1']);
  for (const [child, by, at] of p.refDeny) {
    if (!ID.test(child) || !ID.test(by) || !AT.test(at)) throw new Error(`看不懂的 id：${child}`);
    L.push(`UPDATE members SET referrer_id = NULL, referrer_name = NULL, referrer_ack = 'denied', referrer_by = NULL WHERE id = ${lit(child)} AND referrer_id = ${lit(by)};`);
    L.push(`INSERT INTO rate_limits (key, count, window_end) VALUES (${lit(`refno:${child}:${by}`)}, 1000000, datetime(${lit(at)}, '+180 days')) ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_end = MAX(window_end, excluded.window_end);`);
  }
  for (const [id, by] of p.logs) { if (!ID.test(id) || !ID.test(by)) throw new Error(`看不懂的 id：${id}`); L.push(`DELETE FROM training_logs WHERE id = ${lit(id)} AND member_id = ${lit(by)};`); }
  each(p.routes, ['DELETE FROM routes WHERE id = ?1', 'UPDATE events SET route_id = NULL WHERE route_id = ?1']);
  for (const [tid, pid] of p.posts) L.push(`DELETE FROM team_posts WHERE id = ${lit(pid)} AND team_id = ${lit(tid)};`);
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
    for (const r of rows) {
      const cols = Object.keys(r), head = `INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')})`;
      // members：更新原本那一列（REPLACE 會先刪除，觸發推薦人的 ON DELETE SET NULL 與子表的 CASCADE）
      const set = cols.filter((c) => c !== 'id');
      lines.push(t === 'members' && cols.includes('id') ? `INSERT ${head} ON CONFLICT(id) DO ${set.length ? `UPDATE SET ${set.map((c) => `"${c}" = excluded."${c}"`).join(', ')}` : 'NOTHING'};` : `INSERT OR REPLACE ${head};`);
    }
  }
  // 跑者休息站：備份只有幹部整理、新增、修正、隱藏或補充說明過的列；把來源的版本標記清掉，下次同步（維護工具與排程）才會整份重寫官方資料
  if (data.tables.rest_sources && (!only || only === 'rest_sources' || only === 'rest_stops')) lines.push('UPDATE rest_sources SET etag = NULL, cursor = NULL;');
  // 重做備份之後的撤回（放在最後，蓋過剛匯入的舊資料）
  for (const id of erased) if (typeof id !== 'string' || !ID.test(id)) throw new Error(`看不懂的帳號 id：${id}`);
  lines.push(...replaySql([...erased.map((target_id) => ({ action: ERASE_ACTIONS[0], target_id })), ...audit]).lines);
  return lines;
}
