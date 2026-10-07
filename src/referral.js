// 推薦人（推薦族譜）：SQL 與小工具，Worker 與單元測試（tests/referral-sql.test.mjs、tests/email.test.mjs）共用
//   純模組（不 import cloudflare:）；每一句都在 node:sqlite（migrations 0001–0052、外鍵開啟）跑過
export const REF = {
  LOOKUP_DAY: 20, LOOKUP_BURST: 6, IP_DAY: 60, IP_BURST: 15, BURST_SEC: 600,   // 每次查詢＋每次用 Gmail 設定都算
  SET_DAY: 6,        // 每人每天改推薦人（帳號或名字）的次數
  IN_DAY: 10,        // 每位推薦人每天最多被新綁定幾次（防灌通知）
  ACK_HOUR: 60, HIDE_HOUR: 30, VIEW_HOUR: 120, ADMIN_HOUR: 60,
  DENY_DAYS: 180,    // 「不是我」之後同一對不能再綁
  MAX_DEPTH: 64, UP_SHOW: 10, DOWN_MAX: 3, DOWN_ROWS: 300, REFERRED_ROWS: 200, NAME_MAX: 20,
};
// 名字遮罩（查 Gmail 時給本人確認用）：王○明、王○、歐○○明；中間最多 3 個○
export function maskName(s) {
  const c = [...String(s || '').trim()];
  if (c.length <= 1) return c.join('');
  if (c.length === 2) return `${c[0]}○`;
  return c[0] + '○'.repeat(Math.min(c.length - 2, 3)) + c[c.length - 1];
}
// 只填名字：NFKC、去控制與零寬字元、1–20 字；不收 Email、電話（4 位以上連續數字）、網址
export function validRefName(s) {
  const n = String(s ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
  const len = [...n].length;
  if (!len || len > REF.NAME_MAX || /@|\d{4,}|https?:|www\./i.test(n)) return null;
  return n;
}
// Google 登入時要不要改 email_h：回傳 { set: false }（不動）或 { set: true, value: 查詢碼或 null }
export function nextEmailHash({ refOn, keyOk, findable, consentOk, hasClaim, hash }) {
  if (!refOn || !keyOk) return { set: false };           // 功能關閉、本機沒有 AUDIT_KEY：不動（不要把別人確認過的清掉）
  if (findable === 0) return { set: true, value: null };  // 關掉「用 Gmail 找到我」：一律清掉
  if (!consentOk) return { set: false };                  // 還沒同意新版政策：先不算，同意後用首頁卡片「用 Google 確認」
  if (!hasClaim) return { set: false };                   // 只用名稱與大頭貼登入（basic=1）：Google 沒給 Email，不動
  return { set: true, value: hash ?? null };              // Email 沒驗證或格式不對＝null（覆寫，不用 COALESCE）
}

// 本人設定推薦人（帳號）：自己、不存在、循環、超過 64 層一律不更新（同一句判斷，兩人同時互設也不會成環）
export const BIND_SQL = `UPDATE members SET referrer_id = ?2, referrer_name = NULL, referrer_at = datetime('now'), referrer_by = ?3, referrer_ack = NULL, referrer_gone = 0
  WHERE id = ?1 AND ?2 != ?1 AND referrer_id IS NOT ?2
    AND EXISTS (SELECT 1 FROM members p WHERE p.id = ?2)
    AND NOT EXISTS (WITH RECURSIVE up(id, d) AS (
        SELECT ?2, 0
        UNION ALL
        SELECT m.referrer_id, up.d + 1 FROM members m JOIN up ON m.id = up.id WHERE m.referrer_id IS NOT NULL AND up.d < 64)
      SELECT 1 FROM up WHERE up.id = ?1 OR up.d >= 64)
  RETURNING id`;
// 只填名字（舊的帳號推薦人 id 用請求開頭 currentMember 讀到的 member.referrer_id，標掉他那則通知）
export const NAME_SQL = `UPDATE members SET referrer_id = NULL, referrer_name = ?2, referrer_at = datetime('now'), referrer_by = 'self', referrer_ack = NULL, referrer_gone = 0
  WHERE id = ?1`;
export const CLEAR_SQL = `UPDATE members SET referrer_id = NULL, referrer_name = NULL, referrer_at = NULL, referrer_by = NULL, referrer_ack = NULL, referrer_gone = 0
  WHERE id = ?1 AND (referrer_id IS NOT NULL OR referrer_name IS NOT NULL OR referrer_gone = 1 OR referrer_ack IS NOT NULL) RETURNING id`;
export const DENY_SQL = `UPDATE members SET referrer_id = NULL, referrer_name = NULL, referrer_ack = 'denied', referrer_at = datetime('now'), referrer_by = NULL
  WHERE id = ?1 AND referrer_id = ?2 RETURNING id, name, nickname`;
export const ACK_SQL = `UPDATE members SET referrer_ack = 'ok' WHERE id = ?1 AND referrer_id = ?2 AND referrer_ack IS NOT 'ok' RETURNING id`;
// 往上：每一步帶出那一層的欄位（全部是主鍵查找）；path 擋住髒資料的環
export const UP_SQL = `WITH RECURSIVE up(d, path, id, ref, name, nickname, club, membership, phone, gone, rname) AS (
    SELECT 1, ',' || c.id || ',' || p.id || ',', p.id, p.referrer_id, p.name, p.nickname, p.club, p.membership, p.phone, p.referrer_gone, p.referrer_name
      FROM members c JOIN members p ON p.id = c.referrer_id WHERE c.id = ?1
    UNION ALL
    SELECT up.d + 1, up.path || p.id || ',', p.id, p.referrer_id, p.name, p.nickname, p.club, p.membership, p.phone, p.referrer_gone, p.referrer_name
      FROM up JOIN members p ON p.id = up.ref WHERE up.d < ?2 AND instr(up.path, ',' || p.id || ',') = 0)
  SELECT d, id, ref, name, nickname, club, membership, phone, gone, rname FROM up ORDER BY d`;
// 往下：members_referrer 索引；最多 ?2 層、LIMIT 301（第 301 筆＝還有更多）
export const DOWN_SQL = `WITH RECURSIVE down(id, parent, d, path, name, nickname, membership, ack, by, at) AS (
    SELECT id, NULL, 0, ',' || id || ',', name, nickname, membership, referrer_ack, referrer_by, referrer_at FROM members WHERE id = ?1
    UNION ALL
    SELECT m.id, down.id, down.d + 1, down.path || m.id || ',', m.name, m.nickname, m.membership, m.referrer_ack, m.referrer_by, m.referrer_at
      FROM down JOIN members m ON m.referrer_id = down.id
      WHERE down.d < ?2 AND instr(down.path, ',' || m.id || ',') = 0)
  SELECT id, parent, d, name, nickname, membership, ack, by, at,
    (SELECT COUNT(*) FROM members k WHERE k.referrer_id = down.id) AS kids
  FROM down WHERE d > 0 ORDER BY d, name LIMIT 301`;
export const FOCUS_SQL = `SELECT id, name, nickname, club, membership, member_no, phone, referrer_id, referrer_name, referrer_gone, referrer_ack, referrer_by, referrer_at,
    (SELECT COUNT(*) FROM members k WHERE k.referrer_id = members.id) AS kids FROM members WHERE id = ?1`;
// 管理員把「只填名字」連到帳號：一句做完；會形成循環的那位（推薦人的上層就是他自己）跳過
export const RELINK_SQL = `UPDATE members SET referrer_id = ?3, referrer_name = NULL, referrer_by = 'admin', referrer_at = datetime('now'), referrer_ack = NULL, referrer_gone = 0
  WHERE id IN (SELECT value FROM json_each(?1)) AND referrer_id IS NULL AND referrer_name = ?2 AND id != ?3
    AND EXISTS (SELECT 1 FROM members p WHERE p.id = ?3)
    AND NOT EXISTS (WITH RECURSIVE up(id, d) AS (SELECT ?3, 0 UNION ALL SELECT m.referrer_id, up.d + 1 FROM members m JOIN up ON m.id = up.id WHERE m.referrer_id IS NOT NULL AND up.d < 64)
      SELECT 1 FROM up WHERE up.id = members.id OR up.d >= 64)
  RETURNING id, name, nickname`;
export const ADMIN_CLEAR_SQL = CLEAR_SQL;
export const SUMMARY_SQL = `SELECT COUNT(referrer_id) AS linked,
    COALESCE(SUM(referrer_id IS NULL AND referrer_name IS NOT NULL), 0) AS named,
    COALESCE(SUM(referrer_id IS NOT NULL AND referrer_ack IS NULL), 0) AS pending,
    COALESCE(SUM(referrer_gone = 1 AND referrer_id IS NULL AND referrer_name IS NULL), 0) AS gone,
    COALESCE(SUM(email_h IS NOT NULL), 0) AS findable, COUNT(*) AS total FROM members`;
// 搜尋用 instr（不用 LIKE：D1 的 LIKE 樣式 50 bytes 上限，20 個中文字就超過）
export const SEARCH_SQL = `SELECT m.id, m.name, m.nickname, m.club, m.member_no, m.membership, m.referrer_name, m.referrer_gone, m.referrer_ack, m.referrer_by,
    r.id AS r_id, r.name AS r_name, r.nickname AS r_nick, (SELECT COUNT(*) FROM members k WHERE k.referrer_id = m.id) AS kids
  FROM members m LEFT JOIN members r ON r.id = m.referrer_id
  WHERE instr(lower(m.name), lower(?1)) > 0 OR instr(lower(COALESCE(m.nickname, '')), lower(?1)) > 0 OR m.member_no = ?1
  ORDER BY m.name LIMIT 31`;
export const NAMES_SQL = `SELECT referrer_name AS name, COUNT(*) AS n FROM members
  WHERE referrer_id IS NULL AND referrer_name IS NOT NULL AND instr(lower(referrer_name), lower(?1)) > 0
  GROUP BY referrer_name ORDER BY n DESC, referrer_name LIMIT 31`;
export const NAMED_SQL = `SELECT id, name, nickname, club, referrer_at, referrer_by FROM members
  WHERE referrer_id IS NULL AND referrer_name = ?1 ORDER BY referrer_at DESC LIMIT 101`;
// 「不是我」之後的冷卻（rate_limits，180 天；還原備份時照 referrer.deny 重做）
export const COOLDOWN_SQL = `INSERT INTO rate_limits (key, count, window_end) VALUES (?1, 1000000, datetime('now', '+${REF.DENY_DAYS} days'))
  ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_end = excluded.window_end`;
// 推薦通知標成已讀（ref＝rf:<對方 id>）
export const MARK_READ_SQL = "UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE member_id = ?1 AND ref = ?2";

// Google 登入寫 email_h（三條路徑）：同一句把別人身上相同的查詢碼清掉（換了 Google 帳號、還原備份），被清掉的人不寫稽核、不通知
//   ?1 會員 id｜?2 大頭貼（null＝不改）｜?3 查詢碼或 null｜?4 1＝要改 email_h（nextEmailHash 的 set）
export const LOGIN_SQL = `UPDATE members SET
  avatar  = CASE WHEN id = ?1 THEN COALESCE(?2, avatar) ELSE avatar END,
  email_h = CASE WHEN id = ?1 THEN (CASE WHEN ?4 = 1 THEN ?3 ELSE email_h END) ELSE NULL END
  WHERE id = ?1 OR (?4 = 1 AND ?3 IS NOT NULL AND email_h = ?3 AND id != ?1)`;
// 綁定模式（帳號與安全、推薦人頁的「用 Google 確認」）：多綁 google_sub（?5）
export const LINK_SQL = `UPDATE members SET
  google_sub = CASE WHEN id = ?1 THEN ?5 ELSE google_sub END,
  avatar     = CASE WHEN id = ?1 THEN COALESCE(?2, avatar) ELSE avatar END,
  email_h    = CASE WHEN id = ?1 THEN (CASE WHEN ?4 = 1 THEN ?3 ELSE email_h END) ELSE NULL END
  WHERE id = ?1 OR (?4 = 1 AND ?3 IS NOT NULL AND email_h = ?3 AND id != ?1)`;
// 新帳號：INSERT 之前（同一個 batch）先把別人身上相同的查詢碼清掉
export const CLEAR_HOLDER_SQL = 'UPDATE members SET email_h = NULL WHERE ?1 IS NOT NULL AND email_h = ?1';
