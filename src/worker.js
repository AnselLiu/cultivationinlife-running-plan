// 耕跑團 Cultivation in Life Run — API（Cloudflare Worker ＋ D1）
// 資安設計對應 ISO/IEC 27001:2022 附錄 A（詳見 docs/SECURITY.md）：
//   A.5.15／A.5.18 存取控制：最小權限，特權身分只能由理事長指派，不能靠共用代碼取得
//   A.8.2 特權存取：幹部的工作階段閒置 8 小時、絕對 7 天就失效；身分變更後舊工作階段立即作廢
//   A.8.5 安全鑑別：Google OIDC（state＋nonce、JWKS 驗章）、通行金鑰；邀請碼與報到代碼有嘗試次數限制
//   A.8.15 日誌：特權操作寫入 audit_log，監事可查
//   A.5.34 個資：最小蒐集、電話遮罩、IP 只存雜湊、本人可匯出與刪除
// 工作階段權杖放 HttpOnly cookie，D1 只存 SHA-256；寫入類 API 只接受同源 JSON（擋 CSRF）。
import { subscribe, unsubscribe, pushTest, drainPush, vapidOn, validEndpoint, pushMock } from './push.js';
import * as WebAuthn from './webauthn.js';
import { quote } from '../public/pricing.js';
import { hourOf } from '../public/wxrule.js';
import { BADGES, earned, weeksOf } from '../public/badges.js';
import { clubWeekOf, cycleOf, weekIndexOf, RACE_ISO, logFloor } from '../public/plan.js';
import { CATS, isCat, MUTABLE } from '../public/notif-cats.js';
import { tpNow, shiftDays, daysBetween, evStart, signupEnd, signupState, STATE_TEXT, tpText, SIGNUP_DEFAULTS, windowError, isStamp } from '../public/signup-window.js';
import * as Cams from './cams.js';
import * as Rest from './rest.js';
import { fold, b64bytes } from './ics.js';
import { ERASE_MEMBER } from './erase.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Budget, invocationEnv, logBudget, settled, strictViolations, xfetch, planOf, cacheOf } from './budget.js';

const COOKIE = '__Host-cil_sess';
// 工作階段期限：一般跑友長期使用；幹部看得到別人的資料，期限短很多
const SESSION_POLICY = {
  member:     { idleMs: 30 * 864e5, absDays: 180 },
  privileged: { idleMs: 8 * 3600e3, absDays: 7 },
};
const policyOf = (role) => (norm(role) === 'member' ? SESSION_POLICY.member : SESSION_POLICY.privileged);
const rid = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, n * 2);
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
// API 回應一律帶安全標頭（靜態檔的標頭在 public/_headers）
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...headers } });
const fail = (status, msg) => json({ error: msg }, status);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const FM = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const HM = ['A', 'B', 'C', 'D', 'E'];
const KINDS = ['track', 'core', 'long', 'race', 'party', 'survey', 'buy', 'other'];
const PAY_METHODS = { transfer: '銀行轉帳', cash: '現金', linepay: 'LINE Pay' };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => !s || /^\d{2}:\d{2}$/.test(s);
// 「今天」一律用台北時間（UTC 會在台灣早上 8 點前還停在前一天）
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const url0 = (req) => new URL(req.url);
// 隱私權政策版本：預設值；實際版本由後台「系統設定」決定，改版後使用者下次開啟會被要求重新同意
const PRIVACY_VERSION = '2026-10-03.4';
async function getSettings(env, preloaded) {
  const rows = preloaded || (await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN ('org','features','docs','privacy','tabs','signup')`).all()).results;
  const out = { org: {}, features: {}, docs: [], privacy: { version: PRIVACY_VERSION, body: '' }, tabs: {}, signup: { ...SIGNUP_DEFAULTS } };
  for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch {} }
  // 活動報名預設：只存相對規則，缺的欄位用內建預設補上
  out.signup = { ...SIGNUP_DEFAULTS, ...(out.signup && typeof out.signup === 'object' ? out.signup : {}) };
  // 用內建條文時，版本跟著程式走（條文改了就要重新同意）；後台自訂條文才用後台存的版本
  if (!out.privacy.body) out.privacy.version = PRIVACY_VERSION;
  out.privacy.version ||= PRIVACY_VERSION;
  return out;
}
const httpsUrl = (u, max = 300) => (/^https:\/\/[\w.-]+\.[a-z]{2,}(\/[^\s<>"']*)?$/i.test(u || '') ? String(u).slice(0, max) : '');

function validGroup(dist, grp) {
  return dist === 'hm' ? HM.includes(grp) : FM.includes(grp);
}

// ---- 工作階段 ----
const tokenOf = (req) => (req.headers.get('cookie') || '').match(new RegExp(`${COOKIE}=([\\w]+)`))?.[1];
const ipHash = async (req, env) => (await sha(`${req?.headers.get('cf-connecting-ip') || (req ? 'local' : 'system')}|${env.HASH_SALT || 'cil'}`)).slice(0, 16);

async function currentMember(req, env) {
  const token = tokenOf(req);
  if (!token) return null;
  const th = await sha(token);
  const row = await env.DB.prepare(
    `SELECT m.*, s.last_seen_at AS s_seen, s.role_at_issue AS s_role, s.created_at AS s_created, s.mfa_at AS s_mfa, s.token_hash AS s_th,
       (SELECT json_group_array(json_object('team_id', tm.team_id, 'role', tm.role, 'status', tm.status, 'title', tm.title)) FROM team_members tm WHERE tm.member_id = m.id) AS s_teams,
       (SELECT 1 FROM push_queue WHERE lease_until IS NULL OR lease_until < datetime('now') LIMIT 1) AS s_pq
     FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).bind(th).first();
  if (!row) return null;
  // 推播佇列有待送的：這次請求結束後用剩下的額度順便送幾台（不多花一句查詢）
  if (row.s_pq) env.pushKick = true;
  // 分團團長、幹部看得到分團名冊與活動報名資料，工作階段期限比照協會幹部
  const teamOfficer = JSON.parse(row.s_teams || '[]').some((t) => t.status === 'active' && (t.role === 'lead' || t.role === 'officer'));
  row.team_officer = teamOfficer;
  const pol = teamOfficer ? SESSION_POLICY.privileged : policyOf(row.role), now = Date.now();
  const seen = Date.parse(`${(row.s_seen || row.s_created).replace(' ', 'T')}Z`);
  // 閒置逾時，或簽發後身分被改過（升級或降級都要重新登入）
  if (now - seen > pol.idleMs || (row.s_role && norm(row.s_role) !== norm(row.role))) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(th).run();
    return null;
  }
  if (now - seen > 5 * 60e3) {   // 最多每 5 分鐘更新一次，減少寫入
    env.ctx?.waitUntil(env.DB.batch([
      env.DB.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ?").bind(th),
      env.DB.prepare("UPDATE members SET last_seen = datetime('now') WHERE id = ?").bind(row.id),
    ]));
  }
  return row;
}

async function startSession(env, member, req, { mfa = false } = {}) {
  const token = rid(24), pol = policyOf(member.role);
  await env.DB.prepare(`INSERT INTO sessions (token_hash, member_id, expires_at, last_seen_at, role_at_issue, ip_hash, ua, mfa_at)
    VALUES (?, ?, datetime('now', '+${pol.absDays} days'), datetime('now'), ?, ?, ?, ${mfa ? "datetime('now')" : 'NULL'})`)
    .bind(await sha(token), member.id, norm(member.role), await ipHash(req, env), str(req.headers.get('user-agent'), 120)).run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${pol.absDays * 86400}`;
}
// 作廢所有工作階段，同時讓行事曆訂閱網址失效（登出所有裝置、身分變更時都要重新訂閱）
const revokeSessions = (env, memberId) => env.DB.batch([
  env.DB.prepare('DELETE FROM sessions WHERE member_id = ?').bind(memberId),
  env.DB.prepare('UPDATE members SET cal_token_hash = NULL WHERE id = ?').bind(memberId),
]);

// 嘗試次數限制：在 window 秒內超過 limit 次就擋
async function limited(env, key, limit, windowSec) {
  // 一個陳述式完成「計數＋判斷」，同時多個請求也不會超過上限
  //   已經超過上限（計數到 limit＋1）而且還在時間窗內：不再更新（沒有回傳列＝擋下），被擋的請求不寫 D1
  //   （免費方案每天只有 10 萬列寫入，不讓一直重送的程式靠被擋的請求用光寫入額度）
  const r = await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_end) VALUES (?1, 1, datetime('now', '+${Math.round(windowSec)} seconds'))
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_end > datetime('now') THEN count + 1 ELSE 1 END,
      window_end = CASE WHEN window_end > datetime('now') THEN window_end ELSE excluded.window_end END
    WHERE rate_limits.window_end <= datetime('now') OR rate_limits.count <= ?2
    RETURNING count`).bind(key, Math.floor(limit)).first();
  return !r || r.count > limit;
}
// 每天＋短時間兩層上限：回傳 'day'｜'burst'｜null（放行）
//   1. 短時間的上限已經滿了：只讀不寫就擋下，不扣每天的次數（被擋的請求不寫 D1，也不會把一天的額度白白用掉）
//   2. 每天的上限：用完後被擋的請求不寫任何計數
//   3. 短時間的上限：剛好在這一次滿了，把第 2 步扣掉的每天次數還回去（每個時間窗最多還一次）
async function limitedPair(env, dayKey, dayLimit, burstKey, burstLimit, burstSec) {
  const full = await env.DB.prepare("SELECT 1 FROM rate_limits WHERE key = ? AND count > ? AND window_end > datetime('now')").bind(burstKey, Math.floor(burstLimit)).first();
  if (full) return 'burst';
  if (await limited(env, dayKey, dayLimit, 86400)) return 'day';
  if (await limited(env, burstKey, burstLimit, burstSec)) {
    await env.DB.prepare('UPDATE rate_limits SET count = count - 1 WHERE key = ? AND count > 0').bind(dayKey).run();
    return 'burst';
  }
  return null;
}

// 稽核紀錄：特權操作一律記下（detail 只放摘要，不放個資原文）
// 防竄改：每筆用 AUDIT_KEY（只有 Worker 知道）算 HMAC，改動任何欄位都驗得出來；刪除則由每日摘要鏈檢查
// 匯入過的金鑰存在模組層級（key 是 secret 的 SHA-256，存的是不可匯出的 CryptoKey），不用每次 importKey
const keyCache = new Map();
async function cachedKey(tag, secret, make) {
  const h = `${tag}:${await sha(secret)}`;
  let p = keyCache.get(h);
  if (!p) {
    p = make().catch((e) => { keyCache.delete(h); throw e; });
    keyCache.set(h, p);
    if (keyCache.size > 16) keyCache.delete(keyCache.keys().next().value);
  }
  return p;
}
async function hmac(env, text) {
  if (!env.AUDIT_KEY) return null;
  const key = await cachedKey('hmac', env.AUDIT_KEY, () => crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUDIT_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const auditFields = (r) => [r.id, r.at, r.actor_id, r.actor_name, r.actor_role, r.action, r.target_type, r.target_id, r.detail, r.ip_hash].map((v) => v ?? '').join('\u001f');
// auditStmt 只產生 statement（HMAC 照算），讓呼叫端可以和其他寫入放進同一個 DB.batch（同一個交易）
async function auditStmt(env, req, actor, action, targetType, targetId, detail) {
  const row = { id: rid(10), at: new Date().toISOString().replace('T', ' ').slice(0, 19), actor_id: actor?.id || null,
    actor_name: actor?.name || (req ? null : '系統排程'), actor_role: actor ? norm(actor.real_role || actor.role) : null, action,
    target_type: targetType || null, target_id: targetId || null, detail: str(detail, 300) || null, ip_hash: await ipHash(req, env) };
  row.mac = await hmac(env, auditFields(row));
  return env.DB.prepare(`INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, target_type, target_id, detail, ip_hash, mac)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.at, row.actor_id, row.actor_name, row.actor_role, row.action, row.target_type, row.target_id, row.detail, row.ip_hash, row.mac);
}
// 同一個操作、很多個對象（例如婉拒 60 人，每位一列）：一句寫完，每列各自簽章（HMAC 照算）
async function auditManyStmt(env, req, actor, action, targetType, list) {
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19), ip = await ipHash(req, env), rows = [];
  for (const [targetId, detail] of list) {
    const row = { id: rid(10), at, actor_id: actor?.id || null, actor_name: actor?.name || (req ? null : '系統排程'), actor_role: actor ? norm(actor.real_role || actor.role) : null, action,
      target_type: targetType || null, target_id: targetId || null, detail: str(detail, 300) || null, ip_hash: ip };
    row.mac = await hmac(env, auditFields(row));
    rows.push([row.id, row.at, row.actor_id, row.actor_name, row.actor_role, row.action, row.target_type, row.target_id, row.detail, row.ip_hash, row.mac]);
  }
  return env.DB.prepare(`INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, target_type, target_id, detail, ip_hash, mac)
    SELECT ${Array.from({ length: 11 }, (_, i) => `json_extract(j.value, '$[${i}]')`).join(', ')} FROM json_each(?) j`).bind(JSON.stringify(rows));
}
async function audit(env, req, actor, action, targetType, targetId, detail) {
  try { await (await auditStmt(env, req, actor, action, targetType, targetId, detail)).run(); } catch (e) { console.error('audit', e); }
}

// 新裝置登入：只記「裝置類型・瀏覽器」的雜湊；第一次以外的新組合會通知本人
function deviceLabel(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '其他裝置';
  const br = /Line\//.test(ua) ? 'LINE' : /EdgA?\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '瀏覽器';
  return `${os}・${br}`;
}
async function noteDevice(env, req, member, how) {
  try {
    const label = deviceLabel(req.headers.get('user-agent') || ''), h = (await sha(`dev|${label}`)).slice(0, 24);
    const known = await env.DB.prepare('SELECT 1 FROM login_devices WHERE member_id = ? AND device_hash = ?').bind(member.id, h).first();
    if (known) { await env.DB.prepare("UPDATE login_devices SET last_seen = datetime('now') WHERE member_id = ? AND device_hash = ?").bind(member.id, h).run(); return; }
    const any = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_devices WHERE member_id = ?').bind(member.id).first();
    await env.DB.prepare('INSERT INTO login_devices (member_id, device_hash, label) VALUES (?, ?, ?)').bind(member.id, h, label).run();
    if (any.n) {
      await securityNotify(env, [member.id], { title: '新裝置登入', body: `${label} 用${how}登入了你的帳號。不是你的話，到「我的 → 帳號與安全」按「登出所有裝置」。`, url: '/#/me/security',
        push: { body: '點開確認是不是你本人' } });
      await audit(env, req, member, 'login.new_device', 'member', member.id, label);
    }
  } catch (e) { console.error('noteDevice', e); }
}
// 大頭貼只接受 Google 自己的圖床（舊的 LINE 圖床網址照樣顯示）
const safeAvatar = (u) => (/^https:\/\/lh\d\.googleusercontent\.com\//.test(u || '') ? u.slice(0, 300) : null);

// 角色：參考人民團體的組織分層。chair 理事長｜director 理事｜supervisor 監事｜staff 行政人員｜coach 教練｜member 團員
export const ROLES = { chair: '理事長', director: '理事', supervisor: '監事', staff: '行政人員', coach: '教練', member: '團員' };
const norm = (r) => (r === 'admin' ? 'staff' : ROLES[r] ? r : 'member');   // 相容舊的 admin
// 權限：活動（建立與編輯）、課表（發布）、報到、抽獎、名冊、角色指派
const PERMS = {
  chair:      ['event', 'plan', 'checkin', 'lottery', 'roster', 'roles', 'members', 'layout', 'audit', 'settings'],
  director:   ['event', 'checkin', 'lottery', 'roster', 'members'],
  supervisor: ['roster', 'members', 'audit'],        // 監事：監督角色，只看名冊、會籍與稽核紀錄
  staff:      ['event', 'checkin', 'lottery', 'roster', 'members', 'layout', 'settings'],
  coach:      ['event', 'plan', 'checkin'],
  member:     [],
};
const READONLY = { supervisor: true };               // 監事：看得到名冊與會籍，但不能改
export const MEMBERSHIP = { none: '跑友', applied: '申請中', active: '協會會員', expired: '會籍到期' };
export const MEMBER_TYPES = ['一般會員', '永久會員', '贊助會員'];
const can = (m, p) => !!m && PERMS[norm(m.role)].includes(p);
// 分團層級：團長由理事長指派，幹部由團長指派；權限只作用在自己的分團
//   event 建立與編輯分團活動｜checkin 分團活動報到與排桌｜lottery 抽獎｜layout 座位圖（團長）｜roster 看分團名冊（不含電話）｜approve 審核入團｜appoint 指派分團幹部
export const TEAM_ROLES = { lead: '團長', officer: '幹部', member: '團員' };
const TEAM_PERMS = { lead: ['event', 'checkin', 'lottery', 'layout', 'roster', 'approve', 'appoint'], officer: ['event', 'checkin', 'lottery', 'roster', 'approve'], member: [] };
const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
const lineGroupUrl = (u) => (/^https:\/\/(line\.me|lin\.ee|liff\.line\.me)\/[^\s<>"']{1,250}$/.test(u || '') ? u : '');
const pub = (m) => ({
  id: m.id, name: m.name, dist: m.dist, grp: m.grp, role: norm(m.role), roleName: ROLES[norm(m.role)],
  title: m.title || null, avatar: m.avatar || null, google: !!m.google_sub,
  nickname: m.nickname || '', club: m.club || '', meal_pref: m.meal_pref || '', phone: m.phone || '',
  membership: m.membership || 'none', membershipName: MEMBERSHIP[m.membership || 'none'],
  member_type: m.member_type || null, member_no: m.member_no || null, paid_until: m.paid_until || null,
  share_logs: !!m.share_logs, show_rank: !!m.show_rank, main_team: m.main_team || null, home_spot: m.home_spot || null, plan_cycle: m.plan_cycle === 'race' ? 'race' : 'club', can: PERMS[norm(m.role)],
  mfaPending: !!m.mfa_pending, realRole: m.real_role ? norm(m.real_role) : null, realRoleName: m.real_role ? ROLES[norm(m.real_role)] : null, mfa: !!m.s_mfa,
});

// ---- 通知中心：推播成功與否都留一份 ----
// 分類只在伺服器端決定（public/notif-cats.js）；帳號安全只能經由 securityNotify 寫入，群發無法偽裝
const SEC = Symbol('security');   // 模組私有：沒有任何請求路徑拿得到
const REF_RE = /^(e|t|spot|log|join|apply|pay|wx|review|sr):[\w:-]{1,70}$/;   // sr＝報名待審核（signup review）
// 寫通知：通知中心與推播佇列各一句（每 1000 位收件人），句數跟人數無關（免費方案一次執行只有 50 個子請求）
//   items：[通知 id, 收件人, 標題, 內文, 網址, ref, 推播內容 JSON]，後 5 欄沒有就用 o 的共同值
//   推播佇列只排「沒有關掉這一類」的人的裝置（locked 類別或 force 一律排）；opt.also 的語句放在同一個 batch（同一個交易）
//   有排進佇列就標記 env.wantDrain：這次執行結束前用剩下的額度先送一段，剩下的由之後的請求與每小時排程送完
const NOTE_SQL = `INSERT INTO notifications (id, member_id, kind, category, ref, title, body, url)
  SELECT json_extract(j.value, '$[0]'), m.id, ?2, ?3, COALESCE(json_extract(j.value, '$[5]'), ?4), COALESCE(json_extract(j.value, '$[2]'), ?5),
    COALESCE(json_extract(j.value, '$[3]'), ?6), COALESCE(json_extract(j.value, '$[4]'), ?7)
  FROM json_each(?1) j JOIN members m ON m.id = json_extract(j.value, '$[1]')`;
const QUEUE_SQL = `INSERT INTO push_queue (endpoint, notif_id, payload, urgency, expires_at)
  SELECT s.endpoint, json_extract(j.value, '$[0]'), COALESCE(json_extract(j.value, '$[6]'), ?2), ?3, datetime('now', '+' || ?4 || ' seconds')
  FROM json_each(?1) j JOIN push_subs s ON s.member_id = json_extract(j.value, '$[1]') JOIN members m ON m.id = s.member_id
  WHERE ?5 = 1 OR m.notif_mute IS NULL OR instr(',' || m.notif_mute || ',', ?6) = 0`;
async function writeNotes(env, cat, items, o) {
  const push = vapidOn(env), stmts = [];
  for (let i = 0; i < items.length; i += 1000) {
    const j = JSON.stringify(items.slice(i, i + 1000));
    stmts.push(env.DB.prepare(NOTE_SQL).bind(j, o.kind, cat, o.ref ?? null, o.title ?? null, o.body ?? null, o.url ?? null));
    if (push) stmts.push(env.DB.prepare(QUEUE_SQL).bind(j, o.payload ?? null, o.urgency || 'normal', Math.max(60, Math.round(o.ttl || 86400)), o.force ? 1 : 0, `,${cat},`));
  }
  const res = await env.DB.batch([...stmts, ...(o.also || [])]);
  let rows = 0, queued = 0;
  res.slice(0, stmts.length).forEach((r, k) => { if (push && k % 2) queued += r.meta?.changes || 0; else rows += r.meta?.changes || 0; });
  if (queued) env.wantDrain = true;
  return { rows, queued };
}
const pushPayload = (cat, def, msg, ref) => JSON.stringify({ cat, ts: Date.now(), title: str(msg.push?.title ?? msg.title, 80), body: str(msg.push?.body ?? msg.body, 160),
  url: msg.url || '/#/notifications', tag: msg.tag || (ref ? `r-${ref}`.slice(0, 64) : undefined), re: msg.renotify === true || def.locked });
// 同樣內容給一群人；回傳 { rows, queued }
async function notify(env, memberIds, cat, msg, opt = {}) {
  if (!isCat(cat)) throw new Error(`notify: unknown category ${cat}`);
  if (cat === 'security' && opt[SEC] !== true) throw new Error('notify: security only via securityNotify');
  const def = CATS[cat], ids = [...new Set(memberIds)].filter(Boolean);
  if (!ids.length) { if (opt.also?.length) await env.DB.batch(opt.also); return { rows: 0, queued: 0 }; }
  const ref = REF_RE.test(msg.ref || '') ? msg.ref : null;
  return writeNotes(env, cat, ids.map((id) => [rid(8), id]), { kind: msg.kind || cat, ref, title: str(msg.title, 80), body: str(msg.body, 300), url: str(msg.url, 200) || null,
    payload: pushPayload(cat, def, msg, ref), ttl: msg.ttl ?? def.ttl, urgency: msg.urgency ?? def.urgency, force: def.locked || opt.force, also: opt.also });
}
// 每人內容不同（例如每月總結、疲勞提醒、會費到期、收款）：list 每一項 { member_id, title, body, url, ref, tag, push }，同樣 2 句
async function notifyMany(env, cat, list, opt = {}) {
  if (!isCat(cat) || cat === 'security') throw new Error(`notifyMany: bad category ${cat}`);
  const def = CATS[cat];
  const items = list.filter((x) => x?.member_id).map((x) => {
    const ref = REF_RE.test(x.ref || '') ? x.ref : null;
    return [rid(8), x.member_id, str(x.title, 80), str(x.body, 300), str(x.url, 200) || null, ref, pushPayload(cat, def, x, ref)];
  });
  if (!items.length) { if (opt.also?.length) await env.DB.batch(opt.also); return { rows: 0, queued: 0 }; }
  return writeNotes(env, cat, items, { kind: opt.kind || cat, ttl: opt.ttl ?? def.ttl, urgency: opt.urgency ?? def.urgency, force: def.locked || opt.force, also: opt.also });
}
// 送出推播佇列的一段；過期或送不出去而被丟掉的寫稽核 push.dropped（取代以前的 push.truncated）
async function drain(env, opt = {}) {
  const r = await drainPush(env, opt);
  if (r.dropped) await audit(env, null, null, 'push.dropped', 'notifications', null, `略過 ${r.dropped} 則（過期或送不出去）`);
  return r;
}
// 每次執行只送一段（最多 plan.pushPerHop 台）：每台約 0.2–0.3 ms CPU（M4），10 台乘 2 換算 Cloudflare 主機還在 10 ms 內；
//   多送幾段 CPU 就會超過而被終止（已送出的列沒刪掉，租約到期後重複推播）。剩下的交給之後請求的 pushKick、下個整點、
//   或 self 模式的下一段（Jobs.drainPush）。每小時排程、/api/dev/drain、self 模式的 Jobs.drainPush 共用；回傳是否可能還有剩
async function drainAll(env) {
  const plan = planOf(env);
  if (!env.budget.room(6 + 1)) { env.budget.stop('push'); return { sent: 0, more: true }; }
  const cap = Math.min(plan.pushPerHop, env.budget.left() - 6);
  const r = await drain(env, { max: cap });
  return { sent: r.sent, more: r.leased > 0 && r.leased >= cap };   // 領到的比上限少：佇列裡沒有可以送的了
}
const securityNotify = (env, memberIds, msg) => notify(env, memberIds, 'security', msg, { [SEC]: true });
// 一位幹部處理完，其他收件幹部的同一則待辦一起標為已讀
//   一句處理所有 ref（json_each），句數跟筆數無關
const settleTodo = (env, ...refs) => refs.length && env.DB.prepare(
  "UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE category = 'todo' AND ref IN (SELECT value FROM json_each(?))").bind(JSON.stringify(refs)).run();
// 活動的管理者（送出當下重新檢查權限，已經失去權限的建立者不會收到）
const eventManagers = async (env, ev) => (await env.DB.prepare(
  `SELECT id FROM members WHERE id = ?1 AND role IN ('chair','director','staff','coach')
   UNION SELECT member_id FROM team_members WHERE ?2 IS NOT NULL AND team_id = ?2 AND status = 'active' AND role IN ('lead','officer')
   UNION SELECT id FROM members WHERE ?2 IS NULL AND role IN ('chair','staff')`).bind(ev.created_by || '', ev.team_id || null).all()).results.map((r) => r.id);
const allMemberIds = async (env, exceptId) =>
  (await env.DB.prepare('SELECT id FROM members' + (exceptId ? ' WHERE id != ?' : '')).bind(...(exceptId ? [exceptId] : [])).all())
    .results.map((r) => r.id);

// ---- Google 登入（OpenID Connect 授權碼流程）----
// 需要 secrets：GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET
// Google Cloud 的「已授權的重新導向 URI」填 https://網域/api/google/callback
// 範圍只要 openid profile（名稱與大頭貼），不要 Email；資料庫只存 Google 的 sub
const OAUTH_STATE = '__Host-cil_oauth';
const googleRedirect = (url) => `${url.origin}/api/google/callback`;
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];

// link=1：已經登入的人把 Google 綁到目前帳號（例如先用邀請碼加入），不會另外開新帳號
function googleStart(env, url, current) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail(503, '尚未設定 Google 登入');
  const state = rid(12), nonce = rid(12), link = url.searchParams.get('link') === '1' && current ? '.L' : '';
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', googleRedirect(url));
  auth.searchParams.set('scope', 'openid profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('nonce', nonce);
  auth.searchParams.set('prompt', 'select_account');
  return new Response(null, { status: 302, headers: {
    location: auth.toString(),
    // state 與 nonce 一起綁在發起登入的瀏覽器上，callback 時兩個都要對得上
    'set-cookie': `${OAUTH_STATE}=${state}.${nonce}${link}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  } });
}

// 驗證 Google 的 ID Token：用 Google 公開金鑰（JWKS）驗 RS256 簽章，再檢查發行者、對象、期限與 nonce
let googleKeys = { at: 0, keys: [] };
async function verifyGoogleIdToken(env, idToken, nonce) {
  const [h, p, sig] = String(idToken).split('.');
  if (!h || !p || !sig) throw new Error('ID Token 格式錯誤');
  const dec = (x) => JSON.parse(new TextDecoder().decode(WebAuthn.unb64u(x)));
  const header = dec(h), claims = dec(p);
  if (header.alg !== 'RS256') throw new Error('簽章演算法不正確');
  if (Date.now() - googleKeys.at > 3600e3 || !googleKeys.keys.some((k) => k.kid === header.kid)) {
    googleKeys = { at: Date.now(), keys: (await (await xfetch(env, 'https://www.googleapis.com/oauth2/v3/certs')).json()).keys || [] };
  }
  const jwk = googleKeys.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('找不到簽章金鑰');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, WebAuthn.unb64u(sig), new TextEncoder().encode(`${h}.${p}`)))) throw new Error('簽章不正確');
  const now = Date.now() / 1000;
  if (!GOOGLE_ISS.includes(claims.iss)) throw new Error('發行者不正確');
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error('對象不正確');
  if (!(claims.exp > now - 60) || (claims.iat && claims.iat > now + 300)) throw new Error('已過期');
  if (claims.nonce !== nonce) throw new Error('nonce 不正確');
  if (!claims.sub) throw new Error('缺少帳號識別碼');
  return claims;
}

async function googleCallback(req, env, url) {
  const clear = `${OAUTH_STATE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const back = (msg) => new Response(null, { status: 302, headers: { location: `/#/?err=${encodeURIComponent(msg)}`, 'set-cookie': clear } });
  const [want, nonce, linkFlag] = ((req.headers.get('cookie') || '').match(new RegExp(`${OAUTH_STATE}=([\\w]+\\.[\\w]+(?:\\.L)?)`))?.[1] || '').split('.');
  // 使用者在 Google 授權頁按了取消
  if (url.searchParams.get('error')) return back(url.searchParams.get('error') === 'access_denied' ? '你取消了 Google 登入' : 'Google 登入失敗，請再試一次');
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state || !want || state !== want) return back('登入逾時，請再試一次');
  let claims;
  try {
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: googleRedirect(url), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
    const tok = await (await xfetch(env, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).json();
    if (!tok.id_token) return back('Google 登入失敗');
    claims = await verifyGoogleIdToken(env, tok.id_token, nonce);
  } catch (e) {
    await audit(env, req, null, 'login.denied', null, null, `Google：${str(e.message, 60)}`);
    return back('Google 登入驗證失敗');
  }
  const pic = safeAvatar(claims.picture), displayName = str(claims.name || claims.given_name, 40) || '跑者';
  let m = await env.DB.prepare('SELECT id, name, role FROM members WHERE google_sub = ?').bind(claims.sub).first();
  // 綁定模式：把這個 Google 帳號接到目前登入的帳號
  if (linkFlag === 'L') {
    const cur = await currentMember(req, env);
    const toMe = (q) => new Response(null, { status: 302, headers: { location: `/#/me?${q}`, 'set-cookie': clear } });
    if (!cur) return back('請先登入再綁定 Google');
    if (m && m.id !== cur.id) return toMe('google=taken');
    const pkOf = await env.DB.prepare('SELECT 1 FROM passkeys WHERE member_id = ? LIMIT 1').bind(cur.id).first();
    if (pkOf && !(cur.s_mfa && Date.now() - Date.parse(`${cur.s_mfa.replace(' ', 'T')}Z`) < 15 * 60e3)) return toMe('google=stepup');
    await env.DB.prepare('UPDATE members SET google_sub = ?, avatar = COALESCE(?, avatar) WHERE id = ?').bind(claims.sub, pic, cur.id).run();
    await audit(env, req, cur, 'google.link', 'member', cur.id, '綁定 Google');
    return toMe('google=linked');
  }
  let isNew = false;
  if (m) {
    if (pic) await env.DB.prepare('UPDATE members SET avatar = ? WHERE id = ?').bind(pic, m.id).run();
  } else {
    isNew = true;
    const id = rid(8);
    await env.DB.prepare("INSERT INTO members (id, name, dist, grp, role, google_sub, avatar, consent_at, consent_version) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)")
      .bind(id, displayName, 'fm', 'D', 'member', claims.sub, pic, (await getSettings(env)).privacy.version).run();
    m = { id, name: displayName, role: 'member' };
  }
  await audit(env, req, m, isNew ? 'account.create' : 'login', 'member', m.id, 'Google');
  env.defer(noteDevice(env, req, m, ' Google '));   // env 是這次執行專用的（不要用 { ...env } 複製，綁定會不見）
  return new Response(null, { status: 302, headers: [
    ['location', isNew ? '/#/me?welcome=1' : '/#/'],
    ['set-cookie', await startSession(env, m, req)],
    ['set-cookie', clear],
  ] });
}

// ---- 賽事報名資料（代為團體報名用）：AES-GCM 加密，金鑰 RACE_KEY（32 bytes base64）----
const RACE_FIELDS = {
  name_zh: ['中文姓名', 20, true], name_en: ['英文姓名（護照拼音）', 40, false], id_no: ['身分證字號（或居留證號）', 10, false], passport_no: ['護照號碼', 12, false],
  birthday: ['生日', 10, true], gender: ['性別', 4, true], phone: ['手機', 20, true], email: ['Email', 80, false],
  address: ['通訊地址', 120, false], emergency_name: ['緊急聯絡人', 20, true], emergency_phone: ['緊急聯絡人電話', 20, true],
  emergency_rel: ['關係', 10, false], shirt: ['衣服尺寸', 6, true], note: ['備註', 100, false],
};
async function raceKey(env) {
  if (!env.RACE_KEY) throw new Error('尚未設定 RACE_KEY');
  return cachedKey('race', env.RACE_KEY, () => crypto.subtle.importKey('raw', WebAuthn.unb64u(env.RACE_KEY.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'AES-GCM', false, ['encrypt', 'decrypt']));
}
// 格式 v1.<iv>.<密文>：把會員代碼當附加驗證資料（AAD），密文搬到別人名下就解不開；開頭的版本號留給日後換金鑰
async function sealPrivate(env, obj, memberId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(memberId) }, await raceKey(env), new TextEncoder().encode(JSON.stringify(obj)));
  return `v1.${WebAuthn.b64u(iv)}.${WebAuthn.b64u(ct)}`;
}
async function openPrivate(env, enc, memberId) {
  const parts = String(enc).split('.');
  const [iv, ct] = parts[0] === 'v1' ? parts.slice(1) : parts;   // 舊格式（沒有版本號、沒有 AAD）仍可讀
  const alg = parts[0] === 'v1' ? { name: 'AES-GCM', iv: WebAuthn.unb64u(iv), additionalData: new TextEncoder().encode(memberId) } : { name: 'AES-GCM', iv: WebAuthn.unb64u(iv) };
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(alg, await raceKey(env), WebAuthn.unb64u(ct))));
}
// ---- 地址核對：送中華郵政 3+3 郵遞區號 Web Service（官方介面 GetZipAddress），拿到 6 碼郵遞區號才算通過 ----
//   只送地址文字，不含姓名或其他資料；回傳郵局正規化後的寫法（例如「台」改「臺」）與郵遞區號
//   測試環境設 POST_MOCK=1 時不連外：含「號」且以縣市開頭就當作通過
const POST_WS = 'https://33wsp.post.gov.tw/LZWZIP/TZIP33.asmx';
const CITY_RE = /^(臺|台)(北|中|南|東)(市|縣)|^(新北|桃園|高雄|基隆|新竹|嘉義)(市|縣)|^(苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|澎湖|金門|連江)縣/;
async function postCheck(env, raw) {
  const addr = String(raw || '').replace(/\s+/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).slice(0, 120);
  if (!addr) return { ok: true, empty: true };
  if (!CITY_RE.test(addr)) return { ok: false, error: '地址請從縣市開始寫，例如 臺北市大安區信義路四段25號' };
  if (env.POST_MOCK === '1' && env.DEV_LOGIN === '1') return /號/.test(addr) ? { ok: true, address: addr.replace(/^台/, '臺'), zip: '106682' } : { ok: false, error: '郵局查不到這個門牌，請確認路名、段、巷弄與號碼' };
  const x = addr.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
  let text = '';
  try {
    const r = await xfetch(env, POST_WS, { method: 'POST', signal: AbortSignal.timeout(6000),
      headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: '"http://tempuri.org/GetZipAddress"' },
      body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetZipAddress xmlns="http://tempuri.org/"><addrStr>${x}</addrStr></GetZipAddress></soap:Body></soap:Envelope>` });
    if (!r.ok) return { ok: false, unavailable: true };
    text = await r.text();
  } catch { return { ok: false, unavailable: true }; }
  const m = text.match(/<GetZipAddressResult>([\s\S]*?)<\/GetZipAddressResult>/);
  let j = null;
  try { j = JSON.parse(m[1].replace(/&(quot|amp|lt|gt|apos);/g, (_, e) => ({ quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" })[e])); } catch { return { ok: false, unavailable: true }; }
  // 只對到鄉鎮市區（3 碼）表示路名或門牌郵局查不到
  if (!/^\d{6}$/.test(j?.ZipCode || '')) return { ok: false, error: '郵局查不到這個門牌，請確認路名、段、巷弄與號碼' };
  return { ok: true, address: String(j.Address || addr).replace(/\s+/g, '').slice(0, 120), zip: j.ZipCode, notServed: j.AddressNotServed === 'Y' };
}
const postFail = (c) => (c.unavailable ? [503, '郵局的地址核對服務暫時連不上，請稍後再試（或先不填地址）'] : [400, c.error]);

// 身分證字號、居留證號（新式 8/9、舊式 A–D）：格式加檢查碼
const ID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';   // A=10 … H=17, J=18 …, W=32, Z=33, I=34, O=35
function twIdOk(v) {
  if (!/^[A-Z][12ABCD89]\d{8}$/.test(v)) return false;
  const n = ID_LETTERS.indexOf(v[0]) + 10, second = /\d/.test(v[1]) ? Number(v[1]) : (ID_LETTERS.indexOf(v[1]) + 10) % 10;
  const d = [Math.floor(n / 10), n % 10, second, ...v.slice(2).split('').map(Number)];
  return d.reduce((sum, x, i) => sum + x * [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1][i], 0) % 10 === 0;
}
// 舊資料：以前身分證與護照共用一格，讀出來時護照號碼搬到自己的欄位
function splitIdNo(p) {
  if (p?.id_no && !p.passport_no && !/^[A-Z][12ABCD89]\d{8}$/.test(p.id_no)) { p.passport_no = p.id_no; p.id_no = ''; }
  return p;
}
const maskId = (v) => (v ? `${v.slice(0, 2)}${'*'.repeat(Math.max(0, v.length - 5))}${v.slice(-3)}` : '');

// ---- 活動 ----
const eventCols = 'id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, status, created_at, fee, guest_max, meal_options, link_url, link_label, team_id, questions, visibility, created_by, options, group_reg, items, pricing, pay_info, min_qty, series_id, spot_id, route_id, address, address_zip, signup_start, require_approval, notify_signup';

// 報名問卷：單選、複選、簡答；最多 12 題
const Q_TYPES = ['single', 'multi', 'text'];
function readQuestions(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  const qs = v.slice(0, 12).map((q, i) => {
    let id = /^[\w-]{1,12}$/.test(q?.id || '') ? q.id : `q${i + 1}`;
    while (seen.has(id)) id = `q${i + 1}${rid(1)}`;
    seen.add(id);
    return {
      id, type: Q_TYPES.includes(q?.type) ? q.type : 'single', label: str(q?.label, 80), required: q?.required === true,
      options: Array.isArray(q?.options) ? [...new Set(q.options.map((o) => str(o, 40)).filter(Boolean))].slice(0, 12) : [],
    };
  }).filter((q) => q.label && (q.type === 'text' || q.options.length));
  return qs.length ? JSON.stringify(qs.map((q) => (q.type === 'text' ? { ...q, options: [] } : q))) : null;
}
const parseQ = (s, d = []) => { if (!s) return d; try { return JSON.parse(s); } catch { return d; } };
// 回答只接受題目裡有的選項；必填沒填就擋下
function readAnswers(questions, raw) {
  const qs = parseQ(questions), out = {};
  for (const q of qs) {
    const v = raw?.[q.id];
    if (q.type === 'text') { const t = str(v, 300); if (t) out[q.id] = t; }
    else if (q.type === 'single') { if (q.options.includes(v)) out[q.id] = v; }
    else if (Array.isArray(v)) { const pick = q.options.filter((o) => v.includes(o)); if (pick.length) out[q.id] = pick; }
    if (q.required && !(q.id in out)) return { error: `請回答「${q.label}」` };
  }
  return { answers: qs.length ? JSON.stringify(out) : null };
}

function readEvent(b) {
  const e = {
    kind: KINDS.includes(b.kind) ? b.kind : 'other',
    title: str(b.title, 80),
    date: str(b.date, 10),
    gather_time: str(b.gather_time, 5),
    end_time: str(b.end_time, 5),
    place: str(b.place, 120),
    address: str(b.address, 120),
    lead: str(b.lead, 60),
    note: str(b.note, 1000),
    week_no: Number.isInteger(b.week_no) && b.week_no >= 1 && b.week_no <= 21 ? b.week_no : null,
    plan_text: str(b.plan_text, 4000),
    capacity: Number.isInteger(b.capacity) && b.capacity > 0 ? Math.min(b.capacity, 999) : null,
    signup_open: b.signup_open === false ? 0 : 1,
    deadline: str(b.deadline, 16) || null,
    // 三態：undefined＝保留原值（編輯）或套用系統預設（新增）；格式由呼叫端的 windowError() 檢查
    signup_start: b.signup_start === undefined ? undefined : (str(b.signup_start, 16) || null),
    require_approval: b.require_approval === true ? 1 : b.require_approval === false ? 0 : undefined,
    notify_signup: b.notify_signup === true ? 1 : b.notify_signup === false ? 0 : undefined,
    fee: Number.isInteger(b.fee) && b.fee >= 0 ? b.fee : null,
    guest_max: Number.isInteger(b.guest_max) && b.guest_max > 0 ? Math.min(b.guest_max, 9) : null,
    meal_options: str(b.meal_options, 60),
    link_url: /^https:\/\/[\w.-]+/.test(str(b.link_url, 300)) ? str(b.link_url, 300) : '',
    link_label: str(b.link_label, 20),
    team_id: str(b.team_id, 16) || null,
    questions: readQuestions(b.questions),
    visibility: b.visibility === 'invite' ? 'invite' : 'public',
    // 組別與價格：[{name:'全馬', price:1200}, …]，最多 10 組
    options: (() => { const o = Array.isArray(b.options) ? b.options.slice(0, 10).map((x) => ({ name: str(x?.name, 20), price: Math.max(0, Math.min(Math.round(Number(x?.price) || 0), 100000)) })).filter((x) => x.name) : [];
      return o.length ? JSON.stringify(o) : null; })(),
    group_reg: b.group_reg === true ? 1 : 0,
    // 加購／團購商品：[{id, name, price, sizes:['S','M'], stock, max}]，最多 20 項
    items: (() => {
      const it = Array.isArray(b.items) ? b.items.slice(0, 20).map((x, i) => ({
        id: /^[a-z0-9]{1,8}$/.test(x?.id || '') ? x.id : `i${i + 1}`, name: str(x?.name, 30),
        price: Math.max(0, Math.min(Math.round(Number(x?.price) || 0), 100000)),
        sizes: (Array.isArray(x?.sizes) ? x.sizes : String(x?.sizes || '').split(/[,，、]/)).map((z) => str(z, 10)).filter(Boolean).slice(0, 12),
        stock: Number.isInteger(x?.stock) && x.stock > 0 ? Math.min(x.stock, 99999) : null,
        max: Number.isInteger(x?.max) && x.max > 0 ? Math.min(x.max, 99) : 10,
      })).filter((x) => x.name) : [];
      const ids = new Set(); for (const x of it) { while (ids.has(x.id)) x.id = `i${ids.size + 1}${x.id}`.slice(0, 8); ids.add(x.id); }
      return it.length ? JSON.stringify(it) : null; })(),
    // 優惠：早鳥截止日與折扣、協會會員折扣（只折報名費）
    pricing: (() => { const p = b.pricing || {}, o = { early_until: isDate(p.early_until) ? p.early_until : '',
        early_off: Math.max(0, Math.min(Math.round(Number(p.early_off) || 0), 100000)), member_off: Math.max(0, Math.min(Math.round(Number(p.member_off) || 0), 100000)) };
      if (!o.early_until) o.early_off = 0;
      return o.early_off || o.member_off ? JSON.stringify(o) : null; })(),
    // 收款資訊：帳戶、繳費期限、可用方式（只做紀錄，不串金流）
    pay_info: (() => { const p = b.pay_info || {}, o = { account: str(p.account, 200), due: isDate(p.due) ? p.due : '', note: str(p.note, 200),
        methods: (Array.isArray(p.methods) ? p.methods : []).filter((m) => PAY_METHODS[m]).slice(0, 3) };
      return o.account || o.due || o.note || o.methods.length ? JSON.stringify(o) : null; })(),
    min_qty: Number.isInteger(b.min_qty) && b.min_qty > 0 ? Math.min(b.min_qty, 99999) : null,
    spot_id: /^[\w-]{1,32}$/.test(b.spot_id || '') ? b.spot_id : null,
    route_id: /^[\w-]{1,32}$/.test(b.route_id || '') ? b.route_id : null,
  };
  if (!e.title || !isDate(e.date) || !isTime(e.gather_time) || !isTime(e.end_time)) return null;
  if (e.kind === 'survey') e.require_approval = 0;   // 問卷不審核
  return e;
}

async function eventWithSignups(env, id) {
  const ev = await env.DB.prepare(`SELECT ${eventCols} FROM events WHERE id = ?`).bind(id).first();
  if (!ev) return null;
  const signups = (await env.DB.prepare(
    "SELECT id, member_id, name, grp, dist, note, status, created_at FROM signups WHERE event_id = ? AND status IN ('in','wait') ORDER BY created_at, id").bind(id).all()).results;   // 待審核與婉拒不公開
  return { ...ev, signups };
}

// ---- 報名 ----
// 狀態：in 正取｜wait 候補｜pending 待審核｜cancel 取消（review='rejected' 時是「未通過」）
// 不變式（code review 逐條對照）：
//   1. 有入場券 ⇔ status='in'
//   2. 名額與庫存只算 status='in'
//   3. 已經有人在 wait 時，新的報名一律進 wait；排隊順序只看 (created_at, id)
//   4. cancel 重新變成有效報名時，created_at 重設為現在
//   5. 每次狀態改變都用 compare-and-set（UPDATE … WHERE … AND status = 預期），並檢查 meta.changes
//   6. 只有狀態真的改變才通知（舊狀態 ≠ 新狀態），修改內容不通知
// 只有 promote() 能把 wait 改成 in。
// by：幹部代為報名（member 物件）；manager：本人是這場的主辦幹部（本人報名＝核准）；req：寫稽核用
async function doSignup(env, ev, member, b, { by = null, manager = false, req = null } = {}) {
  const name = str(b.name, 40) || member.name;
  const dist = b.dist === 'hm' ? 'hm' : member.dist;
  const grp = (str(b.grp, 2) || member.grp).toUpperCase();
  if (!validGroup(dist, grp)) return fail(400, '組別不正確');
  const mine = await env.DB.prepare('SELECT id, status, review, reviewed_by, reviewed_at, created_at, amount, paid, items, amount_detail FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
  const was = mine && mine.status !== 'cancel' ? mine.status : null;
  // 被婉拒：本人不能重報（取消再報也繞不過），幹部要先「重新審核」
  if (mine?.status === 'cancel' && mine.review === 'rejected') return fail(400, by ? '已婉拒，請先到統計頁「重新審核」' : '主辦已婉拒這筆報名，如有疑問請聯絡主辦人');
  // 活動狀態與報名期間（台北時間字串比較）；幹部代為報名不受期間與開關限制，但已取消的活動一律不收
  if (ev.status !== 'open') return fail(400, '這個活動已經取消');
  if (!by) { const st = signupState(ev, tpNow()); if (st !== 'open') return fail(400, STATE_TEXT[st](ev)); }
  const ans = readAnswers(ev.questions, b.answers);
  if (ans.error) return fail(400, ans.error);
  // 組別與價格：有設定就一定要選
  const opts = parseQ(ev.options);
  const option = opts.length ? (opts.find((o) => o.name === b.option)?.name || null) : null;
  if (opts.length && !option) return fail(400, '請選擇報名組別');
  // 代為團體報名：要有完整的賽事報名資料，而且同意提供給這場
  if (ev.group_reg) {
    const pr = await env.DB.prepare('SELECT complete FROM member_private WHERE member_id = ?').bind(member.id).first();
    if (!pr?.complete) return fail(400, '這場要代為團體報名，請先到「我的 → 賽事報名資料」填好必填欄位');
    if (b.reg_consent !== true) return fail(400, '請勾選同意把賽事報名資料提供給這場代報名');
  }
  // 加購／團購：檢查品項、尺寸、每人上限與庫存（庫存扣掉其他正取已訂的數量）
  const defs = parseQ(ev.items), picked = {};
  for (const x of Array.isArray(b.items) ? b.items.slice(0, 60) : []) {
    const d = defs.find((y) => y.id === x?.id), qty = Math.round(Number(x?.qty) || 0);
    if (!d || qty <= 0) continue;
    const size = d.sizes.length ? (d.sizes.includes(x.size) ? x.size : null) : '';
    if (size === null) return fail(400, `請選「${d.name}」的尺寸`);
    const k = `${d.id}|${size}`; picked[k] = { id: d.id, size, qty: (picked[k]?.qty || 0) + qty };
  }
  const items = Object.values(picked);
  for (const d of defs) {
    const q = items.filter((x) => x.id === d.id).reduce((t, x) => t + x.qty, 0);
    if (q > d.max) return fail(400, `「${d.name}」每人最多 ${d.max} 件`);
    if (q && d.stock) {
      const others = sumItems((await env.DB.prepare("SELECT items FROM signups WHERE event_id = ? AND status = 'in' AND member_id != ? AND items IS NOT NULL").bind(ev.id, member.id).all()).results, d.id);
      if (others + q > d.stock) return fail(400, `「${d.name}」只剩 ${Math.max(0, d.stock - others)} 件`);
    }
  }
  if (ev.kind === 'buy' && !items.length) return fail(400, '請至少選一項商品');
  // 餐敘的攜伴與餐點先記在報名上，成為正取才開入場券
  const party = ev.kind === 'party';
  const guests = party ? Math.max(0, Math.min(Number(b.guests) || 0, ev.guest_max || 0)) : null;
  const meal = party ? str(b.meal, 20) || member.meal_pref || '' : null;
  const note = str(b.note, 100);
  // 金額由伺服器算：早鳥看這次報名的日期（改報名內容不會失去早鳥；取消後重報用今天）
  const fresh = !was;
  const signedOn = fresh ? today() : tpDate(new Date(`${mine.created_at.replace(' ', 'T')}Z`));
  const q = quote({ ...ev, options: opts, items: defs, pricing: parseQ(ev.pricing, {}) },
    { option, guests: guests || 0, items, membership: member.membership, signedOn });
  // 已繳費後追加：改回未繳，備註差額
  const repay = mine?.paid === 'paid' && mine.amount != null && q.total > mine.amount;
  const cnt = await env.DB.prepare("SELECT COALESCE(SUM(status = 'in'), 0) AS n, COALESCE(SUM(status = 'wait'), 0) AS w FROM signups WHERE event_id = ?").bind(ev.id).first();
  const full = !!ev.capacity && (cnt.n >= ev.capacity || cnt.w > 0);
  // 決定狀態
  const needReview = !!ev.require_approval && ev.kind !== 'survey';
  // 監事（READONLY）唯讀：不論代為報名、本人報名或其他路徑，都不能把報名變成核准（職責分離，A.5.3）
  const approver = READONLY[norm((by || member).role)] ? null : by || (manager ? member : null);
  let status;
  if (was === 'in' || was === 'wait') status = was;                 // 改內容不改狀態，候補改內容也不會插隊
  else if (approver) status = full ? 'wait' : 'in';                  // 幹部代報、主辦本人報名＝核准
  else if (was === 'pending' || needReview) status = 'pending';
  else status = full ? 'wait' : 'in';
  const approveNow = needReview && !!approver && (!was || was === 'pending');
  const reset = mine?.status === 'cancel';                           // 取消後重報：排到最後、清掉舊審核
  const edited = approveNow || reset ? 0 : (was === 'in' && mine.review === 'approved' ? 1 : null);   // null＝不改
  const itemsJson = items.length ? JSON.stringify(items) : null;
  if (mine) {
    const r = await env.DB.prepare(`UPDATE signups SET name = ?1, grp = ?2, dist = ?3, note = ?4, status = ?5, answers = ?6, option = ?7,
      reg_consent_at = CASE WHEN ?8 THEN COALESCE(reg_consent_at, datetime('now')) ELSE NULL END, items = ?9, amount = ?10, amount_detail = ?11,
      paid = CASE WHEN ?12 THEN 'unpaid' ELSE paid END, paid_note = CASE WHEN ?12 THEN ?13 ELSE paid_note END, guests = ?14, meal = ?15,
      created_at = CASE WHEN ?16 THEN datetime('now') ELSE created_at END,
      review = CASE WHEN ?17 THEN 'approved' WHEN ?16 THEN NULL ELSE review END,
      reviewed_by = CASE WHEN ?17 THEN ?18 WHEN ?16 THEN NULL ELSE reviewed_by END,
      reviewed_at = CASE WHEN ?17 THEN datetime('now') WHEN ?16 THEN NULL ELSE reviewed_at END,
      review_note = CASE WHEN ?17 OR ?16 THEN NULL ELSE review_note END,
      edited_after_review = COALESCE(?19, edited_after_review)
      WHERE id = ?20 AND status = ?21`)
      .bind(name, grp, dist, note, status, ans.answers, option, ev.group_reg ? 1 : 0, itemsJson, q.total, JSON.stringify(q.lines),
        repay ? 1 : 0, repay ? `追加 ${q.total - mine.amount} 元` : null, guests, meal, reset ? 1 : 0, approveNow ? 1 : 0, approver?.id || null, edited,
        mine.id, mine.status).run();
    if (!r.meta.changes) return fail(409, '報名狀態剛被主辦更新，請重新整理再試');
  } else {
    // 連按兩次或兩台裝置同時送出：第二筆什麼都不做，回傳第一筆的狀態（不重複通知）
    const r = await env.DB.prepare(`INSERT INTO signups (id, event_id, member_id, name, grp, dist, note, status, answers, option, reg_consent_at, items, amount, amount_detail, guests, meal, review, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${ev.group_reg ? "datetime('now')" : 'NULL'}, ?, ?, ?, ?, ?, ?, ?, ${approveNow ? "datetime('now')" : 'NULL'})
      ON CONFLICT(event_id, member_id) DO NOTHING`)
      .bind(rid(8), ev.id, member.id, name, grp, dist, note, status, ans.answers, option, itemsJson, q.total, JSON.stringify(q.lines), guests, meal,
        approveNow ? 'approved' : null, approveNow ? approver.id : null).run();
    if (!r.meta.changes) {
      const row = await env.DB.prepare('SELECT status FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
      return json({ ok: true, status: row?.status || status, amount: q.total, lines: q.lines, full, dup: true });
    }
  }
  // 同時很多人報名：寫入後再確認一次（D1 沒有交易鎖）
  //   名額：照 (created_at, id) 先後，排在名額外的改成候補；庫存：超賣就把這筆退回原狀
  let final = status;
  const row = await env.DB.prepare('SELECT id, created_at FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
  if (status === 'in' && ev.capacity && was !== 'in') {
    const ahead = (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in' AND (created_at < ? OR (created_at = ? AND id < ?))")
      .bind(ev.id, row.created_at, row.created_at, row.id).first()).n;
    if (ahead >= ev.capacity) { await env.DB.prepare("UPDATE signups SET status = 'wait' WHERE id = ? AND status = 'in'").bind(row.id).run(); final = 'wait'; }
  }
  if (final === 'in' && items.length) for (const d of defs.filter((x) => x.stock && items.some((y) => y.id === x.id))) {
    const sold = sumItems((await env.DB.prepare("SELECT items FROM signups WHERE event_id = ? AND status = 'in' AND items IS NOT NULL").bind(ev.id).all()).results, d.id);
    if (sold > d.stock) {
      // 退回原狀也要 compare-and-set：中間被主辦婉拒或移出就不蓋掉；本人核准的審核欄位一起還原
      if (mine) await env.DB.prepare(`UPDATE signups SET items = ?1, amount = ?2, amount_detail = ?3, status = ?4, created_at = ?5,
          review = CASE WHEN ?6 THEN ?7 ELSE review END, reviewed_by = CASE WHEN ?6 THEN ?8 ELSE reviewed_by END, reviewed_at = CASE WHEN ?6 THEN ?9 ELSE reviewed_at END
        WHERE id = ?10 AND status = 'in'`)
        .bind(mine.items, mine.amount, mine.amount_detail, mine.status, mine.created_at, approveNow ? 1 : 0, mine.review, mine.reviewed_by, mine.reviewed_at, row.id).run();
      else await env.DB.prepare("DELETE FROM signups WHERE id = ? AND status = 'in'").bind(row.id).run();
      return fail(409, `「${d.name}」剛好被訂完了，請重新整理看剩餘數量`);
    }
  }
  // 避免卡在候補：名額其實還有空（同時有人取消、或排在前面的人庫存不夠）就馬上遞補
  if (final === 'wait' && (!ev.capacity || (await countIn(env, ev.id)) < ev.capacity)) {
    await promote(env, ev, { manual: !!by, quiet: new Set([member.id]) });
    final = (await env.DB.prepare('SELECT status FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first()).status;
  }
  if (party && final === 'in') await ensureTicket(env, ev, { member_id: member.id, guests, meal, note });
  if (approveNow && !by) await audit(env, req, member, 'event.signup_review', 'event', ev.id, '幹部本人報名，自動核准');
  if (was === 'pending' && final !== 'pending') await settleReviews(env, ev.id);
  // 通知：只有狀態真的改變、本人報名（代為報名由呼叫端整批通知）、不是問卷
  if (final !== was && !by && ev.kind !== 'survey') {
    const base = { kind: 'signup', ref: `e:${ev.id}`, tag: `signup-${ev.id}`, url: `/#/e/${ev.id}` };
    if (final === 'pending') {
      if (ev.notify_signup) await notify(env, [member.id], 'signup', { ...base, title: `已送出申請：${ev.title}`, body: `主辦幹部審核後會通知你${q.total ? '，核准後再繳費' : ''}` });
      await alertReviewers(env, ev, member.id);
    } else if (ev.notify_signup && final === 'in') {
      await notify(env, [member.id], 'signup', { ...base, title: `報名成功：${ev.title}`, body: `${whenText(ev)}${dueText(ev, q.total)}${party ? '；入場券在「我的入場券」' : ''}`, ...duePush(ev, q.total) });
    } else if (ev.notify_signup && final === 'wait') {
      await notify(env, [member.id], 'signup', { ...base, title: `已排入候補：${ev.title}`, body: `目前候補第 ${await queuePos(env, ev.id, member.id)} 位，有人取消會自動遞補並通知你` });
    }
  }
  return json({ ok: true, status: final, amount: q.total, lines: q.lines, full, position: final === 'wait' ? await queuePos(env, ev.id, member.id) : null });
}
// 入場代碼：去掉容易看錯的 0/O/1/I
const ticketCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const countIn = async (env, eid) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in'").bind(eid).first()).n;
const sumItems = (rows, id) => rows.reduce((t, r) => t + parseQ(r.items).filter((x) => x.id === id).reduce((u, x) => u + x.qty, 0), 0);
// 庫存：正取的人已訂的數量（一句查出來，之後在 JS 裡累加；以前每位候補各查一次，候補多的團購一次就超過 50 句）
const STOCK_SQL = "SELECT member_id, items FROM signups WHERE event_id = ? AND status = 'in' AND items IS NOT NULL";
const qtyOf = (items, id) => items.filter((x) => x.id === id).reduce((t, x) => t + x.qty, 0);
const takenOf = (rows) => { const t = {}; for (const r of rows) for (const x of parseQ(r.items)) t[x.id] = (t[x.id] || 0) + x.qty; return t; };
// 這一筆缺哪一項庫存（taken：其他正取已訂的數量；回報給主辦用）
const shortOf = (defs, taken, items) => defs.find((d) => { const q = qtyOf(items, d.id); return q && (taken[d.id] || 0) + q > d.stock; })?.name || null;
// 入場券只給正取：成為正取就開（保留原本的代碼與座位），離開正取就刪
const ensureTicket = (env, ev, row) => env.DB.prepare(`INSERT INTO tickets (id, event_id, member_id, code, guests, meal, note) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id, member_id) DO UPDATE SET guests = excluded.guests, meal = excluded.meal`)
  .bind(rid(8), ev.id, row.member_id, ticketCode(), row.guests || 0, row.meal || '', str(row.note, 60)).run();
const dropTicket = (env, eid, mid) => env.DB.prepare('DELETE FROM tickets WHERE event_id = ? AND member_id = ?').bind(eid, mid).run();
// 很多人一起成為正取（遞補、核准）：一句開完入場券（代碼在 JS 產生）
const ensureTickets = (env, ev, rows) => rows.length && env.DB.prepare(`INSERT INTO tickets (id, event_id, member_id, code, guests, meal, note)
  SELECT json_extract(j.value, '$[0]'), ?1, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]')
  FROM json_each(?2) j WHERE true ON CONFLICT(event_id, member_id) DO UPDATE SET guests = excluded.guests, meal = excluded.meal`)
  .bind(ev.id, JSON.stringify(rows.map((r) => [rid(8), r.member_id, ticketCode(), r.guests || 0, r.meal || '', str(r.note, 60)]))).run();
// 候補第幾位（依 created_at, id）
const queuePos = async (env, eid, mid) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM signups w, signups me
  WHERE me.event_id = ?1 AND me.member_id = ?2 AND w.event_id = ?1 AND w.status = 'wait'
    AND (w.created_at < me.created_at OR (w.created_at = me.created_at AND w.id <= me.id))`).bind(eid, mid).first()).n;
const pendingCount = async (env, eid) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'pending'").bind(eid).first()).n;
// 通知用的文字：日期（星期）、金額與繳費期限、日期時間地點
const tpDay = (date) => tpText(`${date}T00:00`).slice(0, -5);
// 金額只放通知中心，鎖定畫面與推播佇列不放：要繳費時推播改成不含金額的說法
const duePush = (ev, amount, lead = '') => (amount ? { push: { body: `${lead}${whenText(ev)}；點開看繳費資訊` } } : {});
const dueText = (ev, amount) => { const p = parseQ(ev.pay_info, {}); return amount ? `；應繳 NT$${amount}${p.due ? `，${p.due.slice(5).replace('-', '/')} 前繳費` : ''}` : ''; };
const whenText = (ev) => `${tpDay(ev.date)}${ev.gather_time ? ` ${ev.gather_time} ${ev.kind === 'party' ? '開始' : '集合'}` : ''}${ev.place ? `・${ev.place}` : ''}`;

// 唯一把 wait 改成 in 的地方：取消、移出、移出受邀名單、調高名額、關閉審核、刪除帳號、每小時的 promoteSweep 都呼叫它
//   manual：幹部的操作（核准、調名額），活動開始後仍可遞補；自動遞補到活動開始為止
//   quiet：這些人由呼叫端自己通知；rounds：最多跑幾輪；reserve：呼叫端之後還要用的子請求數
//   句數跟人數無關（免費方案一次執行 50 個子請求）：每輪最多 8 句（名額、候補、庫存、遞補一句、超賣檢查 2–4 句），
//   收尾最多 4 句（入場券一句、是否已通知一句、通知 2 句）。額度不夠就不開始下一輪，回傳值帶 more，
//   剩下的空位由每小時的 promoteSweep 接著遞補
const PROMOTE_ROUND = 8, PROMOTE_TAIL = 4;
async function promote(env, ev, { manual = false, quiet = new Set(), rounds = 3, reserve = 0 } = {}) {
  const done = [];
  if (!ev || ev.status !== 'open') return done;
  if (!manual && tpNow() >= evStart(ev)) return done;          // 活動開始後不自動遞補（手動核准、調名額仍可）
  const defs = parseQ(ev.items).filter((d) => d.stock);
  // D1 沒有交易鎖：同時好幾個遞補（兩人取消、取消＋核准、報名自降＋遞補）可能超賣。
  //   超過名額時，每個呼叫端都用同一個排序（created_at, id，與報名時自降一致）判斷誰排在名額外，只退回自己遞補、排在名額外的人；
  //   退完反而空出位子（排序相同但兩邊都退）就再補一輪，最多三輪
  for (let round = 0; round < rounds; round++) {
    if (!env.budget.room(PROMOTE_ROUND + PROMOTE_TAIL + reserve)) { env.budget.stop('promote'); done.more = true; break; }
    let free = ev.capacity ? ev.capacity - await countIn(env, ev.id) : Infinity;
    if (free <= 0) break;
    const waits = (await env.DB.prepare(`SELECT id, member_id, name, items, amount, guests, meal, note, created_at, review, reviewed_at FROM signups
      WHERE event_id = ? AND status = 'wait' ORDER BY created_at, id LIMIT 200`).bind(ev.id).all()).results;
    if (!waits.length) break;
    const taken = defs.length && waits.some((w) => parseQ(w.items).length) ? takenOf((await env.DB.prepare(STOCK_SQL).bind(ev.id).all()).results) : {};
    const pick = [];
    for (const w of waits) {
      if (free <= 0) break;
      const mine = parseQ(w.items);
      if (shortOf(defs, taken, mine)) continue;                 // 庫存不夠：留在候補，換下一位
      for (const x of mine) taken[x.id] = (taken[x.id] || 0) + x.qty;
      pick.push(w); free--;
    }
    if (!pick.length) break;
    const up = new Set((await env.DB.prepare(`UPDATE signups SET status = 'in' WHERE event_id = ?1 AND status = 'wait' AND id IN (SELECT value FROM json_each(?2)) RETURNING id`)
      .bind(ev.id, JSON.stringify(pick.map((w) => w.id))).all()).results.map((r) => r.id));
    let got = pick.filter((w) => up.has(w.id));
    if (!got.length) break;
    let n = ev.capacity ? await countIn(env, ev.id) : 0;
    if (ev.capacity && n > ev.capacity) {
      // 排序在名額外（第 capacity 位之後）的正取裡，這次遞補的人退回候補
      const back = new Set((await env.DB.prepare(`UPDATE signups SET status = 'wait' WHERE status = 'in' AND id IN (SELECT value FROM json_each(?1))
          AND id IN (SELECT id FROM signups WHERE event_id = ?2 AND status = 'in' ORDER BY created_at, id LIMIT -1 OFFSET ?3) RETURNING id`)
        .bind(JSON.stringify(got.map((w) => w.id)), ev.id, ev.capacity).all()).results.map((r) => r.id));
      got = got.filter((w) => !back.has(w.id));
      n = await countIn(env, ev.id);
      // 少見：遞補的人排在既有正取前面（之前因庫存跳過），排序判斷退不到自己；退回這次最晚遞補的
      if (n > ev.capacity && got.length) {
        const last = got.splice(-(n - ev.capacity));
        await env.DB.prepare("UPDATE signups SET status = 'wait' WHERE status = 'in' AND id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(last.map((w) => w.id))).run();
        n -= last.length;
      }
    }
    done.push(...got);
    if (!ev.capacity || n >= ev.capacity) break;
  }
  if (!done.length) return done;
  if (ev.kind === 'party') await ensureTickets(env, ev, done);
  // 同時有人在核准這位：核准那一方已經送了「審核通過（正取）」就不再送遞補成功（反之亦然，見 notifyApproved）
  const tell = done.filter((x) => x.member_id && !quiet.has(x.member_id));
  const seen = await seatNoticed(env, ev.id, tell.filter((w) => w.review === 'approved'));
  await notifyMany(env, 'change', tell.filter((w) => !seen.has(w.member_id)).map((w) => ({ member_id: w.member_id, ref: `e:${ev.id}`, tag: `signup-${ev.id}`, url: `/#/e/${ev.id}`,
    title: `候補遞補成功：${ev.title}`, body: `有人取消，你已排進正取・${whenText(ev)}${dueText(ev, w.amount)}。不能參加請到活動頁取消，讓給下一位`, ...duePush(ev, w.amount, '有人取消，你已排進正取・') })), { kind: 'signup' });
  return done;
}
// 這次核准（reviewed_at）之後，本人是否已經收到「排進正取」的通知（遞補成功或審核通過）：一句查完，回傳已經收到的 member_id
async function seatNoticed(env, eid, rows) {
  const list = rows.filter((r) => r.member_id && r.reviewed_at).map((r) => [r.member_id, r.reviewed_at]);
  if (!list.length) return new Set();
  return new Set((await env.DB.prepare(`SELECT json_extract(j.value, '$[0]') AS mid FROM json_each(?1) j WHERE EXISTS (SELECT 1 FROM notifications n
    WHERE n.member_id = json_extract(j.value, '$[0]') AND n.ref = ?2 AND (n.title LIKE ?3 OR n.title LIKE ?4) AND n.created_at >= json_extract(j.value, '$[1]'))`)
    .bind(JSON.stringify(list), `e:${eid}`, ...['候補遞補成功：', '審核通過：'].map((t) => `${t}%`)).all()).results.map((r) => r.mid));
}
// 有新的待審核：通知主辦，一小時最多一次（其餘交給 20:00 的整理）；推播只有數量
async function alertReviewers(env, ev, actorId) {
  const r = await env.DB.prepare(`UPDATE events SET review_notified_at = datetime('now') WHERE id = ?
    AND (review_notified_at IS NULL OR review_notified_at < datetime('now', '-60 minutes'))`).bind(ev.id).run();
  if (!r.meta.changes) return;
  const n = await pendingCount(env, ev.id);
  const to = (await eventManagers(env, ev)).filter((x) => x !== actorId);
  if (to.length) await notify(env, to, 'todo', { kind: 'event', ref: `sr:${ev.id}`, tag: `review-${ev.id}`, url: `/#/e/${ev.id}/stats?f=pending`,
    title: `待審核：${ev.title}`, body: `目前 ${n} 筆報名等你核准` });
}
// 核准（或關閉審核自動錄取）之後，這些人各自落在正取還是候補（候補順位在同一句算）
async function reviewOutcome(env, ev, ids) {
  const out = { in: [], wait: [] };
  if (!ids.length) return out;
  const rows = (await env.DB.prepare(`SELECT me.member_id, me.name, me.status, me.amount, me.reviewed_at, me.items,
      CASE WHEN me.status = 'wait' THEN (SELECT COUNT(*) FROM signups w WHERE w.event_id = ?1 AND w.status = 'wait'
        AND (w.created_at < me.created_at OR (w.created_at = me.created_at AND w.id <= me.id))) END AS position
    FROM signups me WHERE me.event_id = ?1 AND me.member_id IN (SELECT value FROM json_each(?2))`).bind(ev.id, JSON.stringify(ids)).all()).results;
  const by = new Map(rows.map((r) => [r.member_id, r]));
  for (const mid of ids) {
    const r = by.get(mid);
    if (r?.status === 'in') out.in.push({ member_id: mid, name: r.name, amount: r.amount, reviewed_at: r.reviewed_at });
    else if (r?.status === 'wait') out.wait.push({ member_id: mid, name: r.name, position: r.position, items: r.items });
  }
  return out;
}
// 審核通過的通知（一律送，change 分類）：正取附日期地點與繳費；候補附順位。所有人一次寫完（是否已通知 1 句＋通知 2 句）
async function notifyApproved(env, ev, out) {
  const base = { ref: `e:${ev.id}`, tag: `signup-${ev.id}`, url: `/#/e/${ev.id}` };
  const seen = await seatNoticed(env, ev.id, out.in);
  await notifyMany(env, 'change', [
    ...out.in.filter((x) => !seen.has(x.member_id)).map((x) => ({ ...base, member_id: x.member_id, title: `審核通過：${ev.title}`, body: `你已經在正取名單・${whenText(ev)}${dueText(ev, x.amount)}`, ...duePush(ev, x.amount, '你已經在正取名單・') })),
    ...out.wait.map((x) => ({ ...base, member_id: x.member_id, title: `審核通過，候補第 ${x.position} 位：${ev.title}`, body: '有人取消會自動遞補並通知你' })),
  ], { kind: 'signup' });
}
// 沒有待審核了：主辦的待辦一起標為已處理
const settleReviews = async (env, eid) => { if (!(await pendingCount(env, eid))) await settleTodo(env, `sr:${eid}`); };
// 核准前重新檢查資格（核准按鈕與關閉審核直接錄取共用）：受邀名單、私密分團、代為團體報名的資料
//   所有人一起查（最多 3 句，跟人數無關）；回傳 Map(member_id → 不符的原因)
async function reviewBlocks(env, ev, mids) {
  const out = new Map(), j = JSON.stringify(mids);
  if (!mids.length) return out;
  const has = async (sql, ...a) => new Set((await env.DB.prepare(sql).bind(...a).all()).results.map((r) => r.member_id));
  if (ev.visibility === 'invite') {
    const ok = await has('SELECT member_id FROM event_invites WHERE event_id = ?1 AND member_id IN (SELECT value FROM json_each(?2))', ev.id, j);
    for (const m of mids) if (!ok.has(m)) out.set(m, '已不在受邀名單');
    return out;
  }
  if (ev.team_id) {
    const ok = await has(`SELECT member_id FROM team_members WHERE team_id = ?1 AND status = 'active' AND member_id IN (SELECT value FROM json_each(?2))
      UNION SELECT value FROM json_each(?2) WHERE NOT EXISTS (SELECT 1 FROM teams WHERE id = ?1 AND private = 1)`, ev.team_id, j);
    for (const m of mids) if (!ok.has(m)) out.set(m, '已不在分團');
  }
  if (ev.group_reg) {
    const ok = await has('SELECT member_id FROM member_private WHERE complete = 1 AND member_id IN (SELECT value FROM json_each(?1))', j);
    for (const m of mids) if (!out.has(m) && !ok.has(m)) out.set(m, '報名資料不完整');
  }
  return out;
}
// 核准一批待審核（核准按鈕與關閉審核直接錄取共用）：資格檢查 ≤3 句、改成候補 1 句、promote()、正取或候補 1 句、
//   庫存說明 0–1 句、通知 3 句；句數跟人數無關。rows：[{ id, member_id, name }]（都是 pending），note：審核備註
//   核准一律先進候補，再由 promote() 依報名先後排進正取（不會插隊到原本的候補前面）
async function approveMany(env, ev, actor, rows, { note = null, reserve = 0 } = {}) {
  const blocks = await reviewBlocks(env, ev, rows.map((r) => r.member_id));
  const ok = rows.filter((r) => !blocks.has(r.member_id));
  const res = ok.length ? (await env.DB.prepare(`UPDATE signups SET status = 'wait', review = 'approved', reviewed_by = ?1, reviewed_at = datetime('now'), review_note = ?2, edited_after_review = 0
    WHERE event_id = ?3 AND status = 'pending' AND id IN (SELECT value FROM json_each(?4)) RETURNING id`).bind(actor.id, note, ev.id, JSON.stringify(ok.map((r) => r.id))).all()).results : [];
  const upd = new Set(res.map((r) => r.id));
  const approved = ok.filter((r) => upd.has(r.id)).map((r) => r.member_id);
  await promote(env, ev, { manual: true, quiet: new Set(approved), reserve: reserve + 5 });
  const out = await reviewOutcome(env, ev, approved);
  out.blocked = rows.filter((r) => blocks.has(r.member_id)).map((r) => ({ ...r, reason: blocks.get(r.member_id) }));
  out.lost = ok.filter((r) => !upd.has(r.id));   // 兩句之間被別人處理掉的
  // 候補裡因為庫存不夠排不進正取的，告訴主辦缺哪一項
  const defs = parseQ(ev.items).filter((d) => d.stock);
  out.notes = [];
  if (defs.length && out.wait.some((w) => parseQ(w.items).length)) {
    const taken = takenOf((await env.DB.prepare(STOCK_SQL).bind(ev.id).all()).results);
    for (const w of out.wait) { const short = shortOf(defs, taken, parseQ(w.items)); if (short) out.notes.push({ name: w.name, reason: `「${short}」庫存不夠，先排候補` }); }
  }
  await notifyApproved(env, ev, out);
  return out;
}
// 本人取消或撤回：沒有報名或已婉拒時不做事（不能取消再重報繞過婉拒）；正取在活動開始後不能自己取消
async function cancelSignup(env, ev, member) {
  const mine = await env.DB.prepare('SELECT id, status, review, paid, pay_reported_at, amount FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
  if (!mine || mine.status === 'cancel') return json({ ok: true, was: null });
  if (mine.status === 'in' && tpNow() >= evStart(ev)) return fail(400, '活動已經開始，不能取消報名，請直接聯絡主辦人');
  const late = mine.status === 'in' && tpNow() > signupEnd(ev);
  const r = await env.DB.prepare(`UPDATE signups SET status = 'cancel', reg_consent_at = NULL,
      paid_note = CASE WHEN paid = 'paid' THEN ? ELSE paid_note END WHERE id = ? AND status = ?`).bind('取消，待退費', mine.id, mine.status).run();
  if (!r.meta.changes) return fail(409, '報名狀態剛被主辦更新，請重新整理再試');
  await dropTicket(env, ev.id, member.id);
  if (mine.status === 'in') await promote(env, ev);
  if (mine.status === 'pending') await settleReviews(env, ev.id);
  // 已繳費（或已回報繳費）的正取取消、截止後取消：通知主辦處理退費或調整
  if (mine.status === 'in' && (mine.paid === 'paid' || mine.pay_reported_at || late)) {
    const to = (await eventManagers(env, ev)).filter((x) => x !== member.id);
    const paid = mine.paid === 'paid' || mine.pay_reported_at;
    // 通知中心不放金額（與繳費回報一致），金額在統計頁看
    if (to.length) await notify(env, to, 'todo', { kind: 'event', ref: `pay:${ev.id}:${member.id}`, url: `/#/e/${ev.id}/stats`,
      title: `${ev.title}：有人取消報名`, body: `${member.nickname || member.name} 取消了報名${paid ? `（${mine.paid === 'paid' ? '已繳費' : '已回報繳費'}，待退費）` : '（截止後取消）'}`,
      push: { body: paid ? '1 筆已繳費的報名取消，請到統計頁處理退費' : '有 1 筆報名在截止後取消' } });
  }
  return json({ ok: true, was: mine.status });
}

// 倒數目標：看本人的設定（off 不顯示、club 協會預設）；預設是自己的主要賽事 → 最近一場自己的賽事 → 協會預設
async function countdownTarget(env, member, rows) {
  if (member?.countdown_mode === 'off') return null;
  if (member && member.countdown_mode !== 'club') {
    const r = await env.DB.prepare(
      `SELECT name, date, dist, goal FROM races WHERE member_id = ? AND date >= date('now', '+8 hours')
       ORDER BY is_primary DESC, date ASC LIMIT 1`).bind(member.id).first();
    if (r) return { ...r, mine: true };
  }
  const c = rows ? rows.find((r) => r.key === 'club_race') : await env.DB.prepare("SELECT value FROM settings WHERE key = 'club_race'").first();
  try { return c ? { ...JSON.parse(c.value), mine: false } : null; } catch { return null; }
}
const racePresets = async (env) => { try { return JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'race_presets'").first())?.value || '[]'); } catch { return []; } };

// 天氣：Open-Meteo 預報＋空氣品質，同一格（0.01 度）快取 30 分鐘；API 與排程（壞天氣提醒）共用
async function getWeather(env, lat, lng) {
  const k = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`, cache = cacheOf(env), key = new Request(`https://cil-run.internal/weather/v1/${k}`);
  const hit = await cache.match(key);
  if (hit) return { body: await hit.text(), hit: true };
  const [la, lo] = k.split(',');
  const fc = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,uv_index&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,weather_code&timezone=Asia%2FTaipei&forecast_days=7&wind_speed_unit=ms`;
  const aq = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${la}&longitude=${lo}&hourly=pm2_5,us_aqi&timezone=Asia%2FTaipei&forecast_days=5`;
  const [a, b] = await Promise.all([xfetch(env, fc).then((r) => (r.ok ? r.json() : null)).catch(() => null), xfetch(env, aq).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  if (!a?.hourly) return null;
  const body = JSON.stringify({ at: new Date().toISOString(), hourly: a.hourly, daily: a.daily, air: b?.hourly ? { time: b.hourly.time, pm2_5: b.hourly.pm2_5, us_aqi: b.hourly.us_aqi } : null });
  const put = cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } }));
  env.ctx?.waitUntil ? env.ctx.waitUntil(put) : await put;
  return { body, hit: false };
}

// 測試用（NTPC_MOCK=1、DEV_LOGIN=1 的本機）：新北市假日資料的假回應（指定年份 365 天，週末放假），不連外；照樣算 1 個子請求
function ntpcMock(env, year, page) {
  env.budget?.take('fetch');
  const out = [];
  if (page === 0) for (let t = Date.UTC(year, 0, 1); new Date(t).getUTCFullYear() === year; t += 864e5) {
    const d = new Date(t), wk = d.getUTCDay(), ds = d.toISOString().slice(0, 10).replace(/-/g, ''), ny = ds.endsWith('0101');
    out.push({ date: ds, year: String(year), name: ny ? '開國紀念日' : '', isholiday: wk === 0 || wk === 6 || ny ? '是' : '否', holidaycategory: wk === 0 || wk === 6 ? '星期六、星期日' : ny ? '放假之紀念日及節日' : '', description: '' });
  }
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}

// ---- 路由 ----
// 路由：寫成括號包住的函式運算式，V8 在載入模組時就先編譯（冷啟動的第一個 /api 請求從 13–22 ms 降到約 2 ms）
const api = (async function api(req, env, path, method) {
  // 登入狀態（含我在各分團的身分）與系統設定同時查，一次往返就好
  const [member0, settingRows] = await Promise.all([currentMember(req, env), env.DB.prepare('SELECT key, value FROM settings').all().then((r) => r.results)]);
  let member = member0;
  const setting = (k) => settingRows.find((r) => r.key === k)?.value;
  const camsOn = () => Cams.featureOn(setting('features'));
  const restOn = () => Rest.featureOn(setting('features'));
  // 跑者休息站的讀取額度（免費方案 D1 每天 500 萬列讀取）：每位跑友 10 分鐘的上限（kind＝restc 格子｜restd 詳情與地點附近），
  //   再加上格子、詳情、地點附近共用的每天上限 REST_DAY_LIMIT（rate_limits 24 小時窗）。見 limitedPair：被 10 分鐘上限擋下的請求
  //   不扣每天的次數；每天的用完後被擋的請求不寫任何計數。這個 isolate 記得誰今天已經用完（10 分鐘內不再查 D1）
  const restQuota = async (kind, limit) => {
    const until = restSpent.get(member.id);
    if (until && until > Date.now()) return fail(429, '今天查詢休息站的次數已達上限，明天再試');
    const hit = await limitedPair(env, `restday:${member.id}`, REST_DAY_LIMIT, `${kind}:${member.id}`, limit, 600);
    if (hit === 'day') {
      restSpent.set(member.id, Date.now() + 600e3);
      if (restSpent.size > 500) restSpent.delete(restSpent.keys().next().value);
      return fail(429, '今天查詢休息站的次數已達上限，明天再試');
    }
    return hit ? fail(429, '查詢太頻繁，請稍後再試') : null;
  };
  // 幹部兩步驟驗證：理事長開啟後，幹部的工作階段要用通行金鑰驗證過，才有管理權限（之前一律當一般跑友）
  const security = (() => { try { return JSON.parse(setting('security') || '{}'); } catch { return {}; } })();
  if (member && security.require_mfa && (norm(member.role) !== 'member' || member.team_officer) && !member.s_mfa) {
    // 沒用通行金鑰驗證前：協會幹部當一般跑友，分團團長與幹部也只有團員的權限
    const teams = JSON.parse(member.s_teams || '[]').map((t) => ({ ...t, role: t.role === 'lead' || t.role === 'officer' ? 'member' : t.role }));
    member = { ...member, real_role: member.role, role: 'member', mfa_pending: true, s_teams: JSON.stringify(teams) };
  }
  // 高風險操作（移交、改身分、改安全設定、下載身分證字號）：有通行金鑰的人要在 15 分鐘內驗證過
  const freshMfa = () => !!member?.s_mfa && Date.now() - Date.parse(`${member.s_mfa.replace(' ', 'T')}Z`) < 15 * 60e3;
  const hasPasskey = async () => !!member && !!(await env.DB.prepare('SELECT 1 FROM passkeys WHERE member_id = ? LIMIT 1').bind(member.id).first());
  const needStepUp = async (always = false) => {
    if (freshMfa()) return null;
    if (always || security.require_mfa || await hasPasskey()) return json({ error: always && !(await hasPasskey()) ? '這個操作要先新增通行金鑰並驗證（我的 → 帳號與安全）' : '這個操作要先用通行金鑰驗證身分', stepup: true }, 403);
    return null;
  };
  const need = () => (member ? null : fail(401, '請先加入'));
  // 功能開關（預設開；後台關掉才是 false）
  const featOnServer = (k) => { try { return JSON.parse(setting('features') || '{}')[k] !== false; } catch { return true; } };
  // 我現在的課表週期：協會賽季，或跟自己的一場比賽（比賽被刪掉、功能關閉時回到協會賽季）
  const planCycleOf = async (m) => {
    if (!m) return null;
    if (!featOnServer('plan_cycle')) return { kind: 'club', ...(m.plan_cycle === 'race' ? { suspended: true } : {}) };
    if (m.plan_cycle !== 'race') return { kind: 'club' };
    const r = m.plan_race_id ? await env.DB.prepare('SELECT id, name, date, dist, goal FROM races WHERE id = ? AND member_id = ?').bind(m.plan_race_id, m.id).first() : null;
    return r ? { kind: 'race', race: r } : { kind: 'club', lost: true };
  };
  const needPerm = (p) => (can(member, p) ? null : fail(403, '沒有這個權限'));
  const needAdmin = () => needPerm('event');
  const body = async () => { try { return await req.json(); } catch { return {}; } };
  // 我在各分團的身分（每次請求即時查，團長被撤換後馬上失去權限）
  const myTeams = member ? Object.fromEntries(JSON.parse(member.s_teams || '[]').map((r) => [r.team_id, r])) : {};
  const inTeam = (tid) => myTeams[tid]?.status === 'active';
  // 協會層級的權限涵蓋所有分團；分團幹部只管自己的分團
  const GLOBAL_EQ = { approve: 'members', appoint: 'roles' };
  const teamCan = (tid, p) => {
    if (can(member, GLOBAL_EQ[p] || p) && !(READONLY[norm(member.role)] && p !== 'roster')) return true;
    return !!tid && inTeam(tid) && TEAM_PERMS[myTeams[tid].role]?.includes(p);
  };
  // 管理分團成員（核准、加入、移出、設成主團）：一般分團＝協會幹部或該團團長、幹部；
  // 「只由本團幹部管理」的分團（例如耕建築，公司自己處理）＝只有該團團長、幹部
  const selfManaged = async (tid) => !!tid && !!(await env.DB.prepare('SELECT self_managed FROM teams WHERE id = ?').bind(tid).first())?.self_managed;
  const teamOwn = (tid, p) => !!tid && inTeam(tid) && TEAM_PERMS[myTeams[tid].role]?.includes(p);
  const canManageMembers = async (tid, p = 'approve') => ((await selfManaged(tid)) ? teamOwn(tid, p) : teamCan(tid, p));
  // 看得到這個活動嗎：
  //   邀請制：只有受邀的人，加上建立者、該分團團長與幹部、協會建立活動權限的人（管理用）
  //   公開：全協會、公開分團，或私密分團的團員；協會建立活動權限的人都看得到
  const seeSQL = `(CASE WHEN events.visibility = 'invite' THEN
      (events.id IN (SELECT event_id FROM event_invites WHERE member_id = ?1) OR events.created_by = ?1 OR ?2 = 1
       OR events.team_id IN (SELECT team_id FROM team_members WHERE member_id = ?1 AND status = 'active' AND role IN ('lead', 'officer')))
    ELSE (events.team_id IS NULL OR events.team_id IN (SELECT id FROM teams WHERE private = 0)
      OR events.team_id IN (SELECT team_id FROM team_members WHERE member_id = ?1 AND status = 'active') OR ?2 = 1) END)`;
  const invited = async (eid) => !!(await env.DB.prepare('SELECT 1 FROM event_invites WHERE event_id = ? AND member_id = ?').bind(eid, member.id).first());
  const canSee = async (ev) => {
    if (teamCan(ev.team_id, 'event') || ev.created_by === member.id) return true;
    if (ev.visibility === 'invite') return invited(ev.id);
    if (!ev.team_id || inTeam(ev.team_id)) return true;
    return !(await env.DB.prepare('SELECT private FROM teams WHERE id = ?').bind(ev.team_id).first())?.private;
  };
  // 管理這個活動：該分團（或全協會）的建立活動權限；建立者後來被撤換就不能再管
  const canManage = (ev) => teamCan(ev.team_id, 'event');
  const evById = (id) => env.DB.prepare(`SELECT ${eventCols} FROM events WHERE id = ?`).bind(id).first();
  const teamIds = async () => (await env.DB.prepare('SELECT id FROM teams').all()).results.map((r) => r.id);
  const teamMemberIds = async (tid, exceptId) => (await env.DB.prepare(
    "SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active'").bind(tid).all()).results.map((r) => r.member_id).filter((x) => x !== exceptId);
  // 我有權核准的入團申請（/api/teams/pending 與通知中心的待處理摘要共用）
  const pendingRows = async () => (await env.DB.prepare(`SELECT tm.team_id, tm.created_at, m.id, m.name, m.nickname, m.avatar, m.dist, m.grp, m.main_team, t.name AS team_name, t.self_managed
      FROM team_members tm JOIN members m ON m.id = tm.member_id JOIN teams t ON t.id = tm.team_id
      WHERE tm.status = 'pending' ORDER BY tm.created_at LIMIT 200`).all()).results;
  const canApproveRow = (r) => (r.self_managed ? teamOwn(r.team_id, 'approve') : teamCan(r.team_id, 'approve'));
  const pendingJoins = async (rows) => (rows || await pendingRows()).filter(canApproveRow);
  // 活動清單（/api/events 與開啟 App 的 /api/me?boot=1 共用）
  const listEvents = async (past, range) => {
    const rows = (await env.DB.prepare(
      `SELECT ${eventCols}, (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'in') AS signed,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'wait') AS waiting,
              (SELECT CASE WHEN s.status = 'cancel' AND s.review = 'rejected' THEN 'rejected' ELSE s.status END FROM signups s WHERE s.event_id = events.id AND s.member_id = ?1) AS mine,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'pending') AS pending,
              (SELECT json_group_array(json_object('n', x.name, 'a', x.avatar)) FROM (
                 SELECT s.name, m.avatar FROM signups s LEFT JOIN members m ON m.id = s.member_id
                 WHERE s.event_id = events.id AND s.status = 'in' ORDER BY s.created_at LIMIT 4) x) AS peek
       FROM events WHERE date BETWEEN ?3 AND ?4 ${past ? 'AND date < ?5' : ''} AND ${seeSQL} ORDER BY date ${past ? 'DESC' : 'ASC'}, gather_time LIMIT 100`)
      .bind(member.id, can(member, 'event') ? 1 : 0, ...range, ...(past ? [today()] : [])).all()).results;
    return rows.map(({ questions, options, items, pricing, pay_info, ...r }) => {
      if (!teamCan(r.team_id, 'event')) delete r.pending;   // 待審核數只給主辦幹部
      return { ...r, survey: !!questions, options: parseQ(options), items: parseQ(items).map((i) => ({ name: i.name, price: i.price })), peek: JSON.parse(r.peek || '[]') };
    });
  };
  // ---- 分團清單（/api/me 也會用到）----
  const teamOut = async (t, counts, leaders) => {
    const mine = myTeams[t.id];
    const showLine = !t.private || inTeam(t.id) || can(member, 'settings');
    return { id: t.id, name: t.name, intro: t.intro || '', color: t.color, join_policy: t.join_policy, private: !!t.private, self_managed: !!t.self_managed, sort: t.sort,
      line_url: showLine ? t.line_url || '' : '', count: counts[t.id] || 0, icon: t.icon_v ? `/api/teams/${t.id}/icon?v=${t.icon_v}` : null, leaders: leaders.filter((l) => l.team_id === t.id),
      my_role: mine?.role || null, my_status: mine?.status || null, my_title: mine?.title || null };
  };
  const listTeams = async () => {
    const [teams, countRows, leaders] = (await env.DB.batch([
      env.DB.prepare('SELECT id, name, intro, color, line_url, join_policy, private, self_managed, sort, icon_v FROM teams ORDER BY sort, created_at'),
      env.DB.prepare("SELECT team_id, COUNT(*) AS n FROM team_members WHERE status = 'active' GROUP BY team_id"),
      env.DB.prepare(`SELECT tm.team_id, tm.role, tm.title, m.name, m.nickname, m.avatar FROM team_members tm JOIN members m ON m.id = tm.member_id
       WHERE tm.role IN ('lead', 'officer') AND tm.status = 'active' ORDER BY tm.role = 'lead' DESC, tm.created_at`),
    ])).map((r) => r.results);
    const counts = Object.fromEntries(countRows.map((r) => [r.team_id, r.n]));
    return Promise.all(teams.map((t) => teamOut(t, counts, leaders)));
  };
  const readTeam = (b, full) => {
    const t = { intro: str(b.intro, 300), line_url: lineGroupUrl(str(b.line_url, 260)) };
    if (str(b.line_url, 260) && !t.line_url) return { error: 'LINE 群組連結要是 https://line.me/ 開頭的邀請連結' };
    if (!full) return t;
    Object.assign(t, { name: str(b.name, 20), color: isColor(b.color) ? b.color : '#1C4698',
      join_policy: 'approve', private: b.private === true ? 1 : 0, self_managed: b.self_managed === true ? 1 : 0,
      sort: Number.isInteger(b.sort) ? Math.max(0, Math.min(b.sort, 99)) : null });
    if (!t.name) return { error: '請填分團名稱' };
    return t;
  };

  // 行事曆訂閱的 .ics：只列本人有報名（正取或候補）的活動，過去 30 天到未來 180 天
  // ---- 每月里程挑戰 ----
  // 個人：自己的里程、次數、徽章；分團：全部團員加總與平均（不揭露個人）；排行：只列有同意上排行榜的人
  if (path === '/api/challenge' && method === 'GET') {
    const g = need(); if (g) return g;
    const mo = /^\d{4}-(0[1-9]|1[0-2])$/.test(url0(req).searchParams.get('month') || '') ? url0(req).searchParams.get('month') : today().slice(0, 7);
    const [mine, teamsAgg, top] = await Promise.all([
      env.DB.prepare("SELECT date, km FROM training_logs WHERE member_id = ? AND date BETWEEN ? AND ? AND status != 'skip'").bind(member.id, `${mo}-01`, `${mo}-31`).all(),
      env.DB.prepare(`SELECT t.id, t.name, t.color, COUNT(DISTINCT tm.member_id) AS members, COALESCE(SUM(l.km), 0) AS km, COUNT(DISTINCT l.member_id) AS active
        FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.status = 'active'
        LEFT JOIN training_logs l ON l.member_id = tm.member_id AND l.date BETWEEN ? AND ? AND l.status != 'skip'
        WHERE t.private = 0 OR t.id IN (SELECT team_id FROM team_members WHERE member_id = ? AND status = 'active') GROUP BY t.id ORDER BY t.sort`).bind(`${mo}-01`, `${mo}-31`, member.id).all(),
      env.DB.prepare(`SELECT m.id, COALESCE(NULLIF(m.nickname, ''), m.name) AS name, SUM(l.km) AS km, COUNT(*) AS runs FROM training_logs l JOIN members m ON m.id = l.member_id
        WHERE l.date BETWEEN ? AND ? AND l.status != 'skip' AND m.show_rank = 1 GROUP BY m.id HAVING km > 0 ORDER BY km DESC LIMIT 20`).bind(`${mo}-01`, `${mo}-31`).all(),
    ]);
    const logs = mine.results, km = Math.round(logs.reduce((n, l) => n + (l.km || 0), 0) * 10) / 10;
    const stat = { km, runs: logs.length, weeks: weeksOf(mo, logs.map((l) => l.date)) };
    return json({ month: mo, me: { ...stat, badges: earned(stat), rank: member.show_rank ? top.results.findIndex((x) => x.id === member.id) + 1 || null : null },
      badges: BADGES.map(({ id, name, desc }) => ({ id, name, desc })),
      teams: teamsAgg.results.map((t) => ({ ...t, km: Math.round(t.km * 10) / 10, avg: t.members ? Math.round((t.km / t.members) * 10) / 10 : 0 })),
      top: top.results.map((x) => ({ name: x.name, km: Math.round(x.km * 10) / 10, runs: x.runs, me: x.id === member.id })), showRank: !!member.show_rank });
  }
  // ---- 會籍卡 ----
  // 卡上的 QR：會員代碼＋簽章（用 AUDIT_KEY 簽，無法偽造），幹部掃了看得到會籍狀態
  const cardSig = async (id) => (await hmac(env, `card|${id}`) || '').slice(0, 16);
  if (path === '/api/me/card' && method === 'GET') {
    const g = need(); if (g) return g;
    const st = await getSettings(env, settingRows.filter((r) => r.key === 'org'));
    return json({ name: member.name, nickname: member.nickname, member_no: member.member_no, member_type: member.member_type, membership: member.membership,
      paid_until: member.paid_until, joined_on: member.joined_on || null, org: st.org?.name || '台灣耕跑團協會', qr: `CILM:${member.id}.${await cardSig(member.id)}` });
  }
  if (path === '/api/members/verify' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'roster') && !can(member, 'checkin')) return fail(403, '只有幹部可以驗證會籍');
    const m0 = (url0(req).searchParams.get('c') || '').match(/^CILM:([\w-]{1,32})\.([0-9a-f]{16})$/);
    if (!m0 || m0[2] !== await cardSig(m0[1])) return fail(400, '這不是有效的會籍卡');
    const m = await env.DB.prepare('SELECT name, nickname, membership, member_type, member_no, paid_until FROM members WHERE id = ?').bind(m0[1]).first();
    if (!m) return fail(404, '找不到這位會員');
    await audit(env, req, member, 'member.verify', 'member', m0[1], '掃描會籍卡');
    return json({ ...m, valid: m.membership === 'active' && (!m.paid_until || m.paid_until >= today()) });
  }
  // ---- 備份 ----
  if (path === '/api/backups' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !can(member, 'audit')) return fail(403, '只有理事長、行政人員與監事可以看');
    const store = backupStore(env);
    if (!store) return json({ enabled: false, list: [] });
    const [l, run] = await Promise.all([store.list(), env.DB.prepare("SELECT cursor FROM job_runs WHERE job = 'backup'").first()]);
    // 備份是不是卡住了：進行中的那份開始超過 24 小時，或最新做完的每日備份超過 36 小時（A.8.13）
    const cur = parseQ(run?.cursor, null);
    const newest = l.map((x) => /^daily\/(\d{4}-\d{2}-\d{2})\.bin$/.exec(x.key)?.[1]).filter(Boolean).sort().pop() || null;
    const stale = cur?.label && backupStalled(cur) ? { pending: cur.label, since: cur.at } : newest && newest < tpDate(new Date(Date.now() - 36 * 3600e3)) ? { newest } : null;
    return json({ enabled: !!env.BACKUP_KEY, where: store.kind, list: l.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 40), stale });
  }
  if (path === '/api/backups' && method === 'POST') {
    const g = need(); if (g) return g;
    if (norm(member.role) !== 'chair' && norm(member.role) !== 'staff') return fail(403, '只有理事長與行政人員可以手動備份');
    { const su = await needStepUp(); if (su) return su; }
    if (!backupStore(env) || !env.BACKUP_KEY) return fail(400, '備份還沒設定');
    if (await limited(env, `backup:${member.id}`, 3, 3600)) return fail(429, '一小時最多手動備份 3 次');
    // 和每日備份同一套分段做法（backupStep）：資料少時這次就做完；做不完的由每小時排程接著做（管理後台的清單在做完後才出現）
    const m = await env.DB.prepare("SELECT claim_key, attempts, cursor FROM job_runs WHERE job = 'backup_manual'").first();
    if (backupPending(m)) return fail(409, '上一次手動備份還在分段進行中，會在接下來的整點做完');
    const label = `${today()}-manual-${Date.now().toString(36)}`;
    const r = await backupStep(env, 'backup_manual', label, { action: 'backup.manual' });
    if (!r.done) {
      await audit(env, req, member, 'backup.manual', 'system', label, '開始（資料較多，分段進行）');
      return json({ started: true, label }, 202);
    }
    await audit(env, req, member, 'backup.manual', 'system', label, `${r.result.tables} 張表 ${r.result.rows} 筆`);
    return json(r.result);
  }
  // ---- 練跑地圖 ----
  const SPOT_KINDS = ['track', 'river', 'park', 'trail', 'road', 'other'];
  const SPOT_CITIES = ['臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
  // 地點審核與管理：協會層級有建立活動權限的幹部（分團幹部可以提議，不能改別人的）
  const canEditSpots = () => !!member && !READONLY[norm(member.role)] && can(member, 'event');
  const readSpot = (b) => {
    const lat = Number(b.lat), lng = Number(b.lng);
    const info = {}; for (const k of ['surface', 'lap', 'light', 'water', 'toilet', 'parking', 'hours']) { const v = str(b.info?.[k], 60); if (v) info[k] = v; }
    const sp = { name: str(b.name, 40), kind: SPOT_KINDS.includes(b.kind) ? b.kind : 'other', lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, intro: str(b.intro, 600), info: Object.keys(info).length ? JSON.stringify(info) : null };
    if (!sp.name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const city = str(b.city, 4).replace(/^台/, '臺');
    sp.city = SPOT_CITIES.includes(city) ? city : null;
    return sp;
  };
  if (path === '/api/spots' && method === 'GET') {
    const g = need(); if (g) return g;
    const editor = canEditSpots();
    const rows = (await env.DB.prepare(`SELECT s.id, s.name, s.kind, s.lat, s.lng, s.city, s.status, s.created_by, json_extract(s.info, '$.hours') AS hours,
        (SELECT COUNT(*) FROM spot_reports r WHERE r.spot_id = s.id AND r.created_at >= datetime('now', '-24 hours')) AS reports,
        (SELECT r.data FROM spot_reports r WHERE r.spot_id = s.id AND r.created_at >= datetime('now', '-24 hours') ORDER BY r.created_at DESC LIMIT 1) AS latest
      FROM spots s WHERE s.status = 'approved' OR (s.status = 'pending' AND (s.created_by = ? OR ? = 1)) ORDER BY s.name LIMIT 500`).bind(member.id, editor ? 1 : 0).all()).results;
    return json({ spots: rows.map((r) => ({ ...r, latest: parseQ(r.latest, null), mine: r.created_by === member.id, created_by: undefined })), editor });
  }
  if (path === '/api/spots' && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `spot:${member.id}`, 20, 3600)) return fail(429, '新增太頻繁，請稍後再試');
    const sp = readSpot(await body());
    if (!sp) return fail(400, '請填地點名稱並在地圖上選位置');
    const editor = canEditSpots(), id = rid(8);
    await env.DB.prepare('INSERT INTO spots (id, name, kind, lat, lng, city, intro, info, status, created_by, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, sp.name, sp.kind, sp.lat, sp.lng, sp.city, sp.intro || null, sp.info, editor ? 'approved' : 'pending', member.id, editor ? member.id : null).run();
    await audit(env, req, member, editor ? 'spot.add' : 'spot.propose', 'spot', id, sp.name);
    if (!editor) {
      // 收件人跟 canEditSpots 一致；內文只放暱稱，鎖定畫面不放人名
      const mgr = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair', 'director', 'staff', 'coach')").all()).results.map((r) => r.id);
      await notify(env, mgr, 'todo', { kind: 'system', title: '練跑地圖：有新的地點提議', body: `${member.nickname || '一位跑友'} 提議「${sp.name}」，請到地圖審核`, url: `/#/map?spot=${id}`,
        ref: `spot:${id}`, push: { body: '點開審核' } });
    }
    return json({ id, status: editor ? 'approved' : 'pending' });
  }
  const msp = path.match(/^\/api\/spots\/([\w-]{1,32})(?:\/(reports|review|cams|rest))?(?:\/([\w-]{1,32}))?$/);
  if (msp) {
    const g = need(); if (g) return g;
    const sp = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(msp[1]).first();
    const editor = canEditSpots();
    if (!sp || (sp.status !== 'approved' && sp.created_by !== member.id && !editor)) return fail(404, '找不到這個地點');
    const sub = msp[2];
    // 附近即時影像：1.5 公里內最多 3 支，沒有就找 3 公里內最近的 1 支（只回名稱、距離、來源與顯名，不回原始影像網址）
    //   功能開關關閉：回 enabled=false，前端整段不顯示
    if (sub === 'cams' && method === 'GET' && !msp[3]) {
      const r = camsOn() ? await Cams.forSpot(env, sp) : { cams: [], enabled: false, link: false };
      return json({ ...r, radius: Cams.RADIUS, fallback: Cams.FALLBACK }, 200, { 'cache-control': 'private, max-age=300' });
    }
    // 附近休息站：1 公里內每類最多 2 處（距離 × 權重排序）；功能開關關閉時 404
    //   結果依地點＋版本快取（記憶體與 Cache API）；和詳情共用 10 分鐘的上限，和格子、詳情共用每天的上限（見 restQuota）
    if (sub === 'rest' && method === 'GET' && !msp[3]) {
      if (!restOn()) return fail(404, '找不到休息站');
      const q = await restQuota('restd', REST_DETAIL_LIMIT); if (q) return q;
      const r = await Rest.nearSpot(env, sp);
      return json(r.out, 200, { 'cache-control': 'private, max-age=300', 'x-rest-cache': r.from });
    }
    if (!sub && method === 'GET') {
      const reps = (await env.DB.prepare(`SELECT id, data, created_at, member_id FROM spot_reports WHERE spot_id = ? AND created_at >= datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 20`).bind(sp.id).all()).results;
      const week = (await env.DB.prepare(`SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM spot_reports WHERE spot_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY d`).bind(sp.id).all()).results;
      const routes = (await env.DB.prepare('SELECT id, name, distance FROM routes WHERE spot_id = ? AND (shared = 1 OR created_by = ?) ORDER BY created_at DESC LIMIT 10').bind(sp.id, member.id).all()).results;
      const events = (await env.DB.prepare(`SELECT events.id, events.title, events.date, events.gather_time FROM events WHERE events.spot_id = ?3 AND events.date >= ?4 AND ${seeSQL} ORDER BY events.date LIMIT 5`)
        .bind(member.id, can(member, 'event') ? 1 : 0, sp.id, today()).all()).results;
      return json({ spot: { ...sp, info: parseQ(sp.info, {}), mine: sp.created_by === member.id, created_by: undefined, reviewed_by: undefined }, editor,
        reports: reps.map((r) => ({ id: r.id, ...parseQ(r.data, {}), at: r.created_at, mine: r.member_id === member.id })), week, routes, events });
    }
    if (!sub && method === 'PUT') {
      if (!editor && !(sp.created_by === member.id && sp.status === 'pending')) return fail(403, '只有幹部可以修改地點');
      const v = readSpot(await body());
      if (!v) return fail(400, '地點資料不完整');
      await env.DB.prepare("UPDATE spots SET name = ?, kind = ?, lat = ?, lng = ?, city = COALESCE(?, city), intro = ?, info = ?, updated_at = datetime('now') WHERE id = ?").bind(v.name, v.kind, v.lat, v.lng, v.city, v.intro || null, v.info, sp.id).run();
      await audit(env, req, member, 'spot.update', 'spot', sp.id, v.name);
      return json({ ok: true });
    }
    if (!sub && method === 'DELETE') {
      if (!editor && !(sp.created_by === member.id && sp.status === 'pending')) return fail(403, '只有幹部可以刪除地點');
      await env.DB.prepare('DELETE FROM spots WHERE id = ?').bind(sp.id).run();
      await env.DB.prepare('UPDATE events SET spot_id = NULL WHERE spot_id = ?').bind(sp.id).run();
      await audit(env, req, member, 'spot.delete', 'spot', sp.id, sp.name);
      return json({ ok: true });
    }
    if (sub === 'review' && method === 'POST') {
      if (!editor) return fail(403, '只有幹部可以審核');
      const ok = (await body()).approve === true;
      const r = await env.DB.prepare("UPDATE spots SET status = ?, reviewed_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'").bind(ok ? 'approved' : 'rejected', member.id, sp.id).run();
      if (!r.meta.changes) return fail(409, '這個地點已經審核過了');
      await audit(env, req, member, ok ? 'spot.approve' : 'spot.reject', 'spot', sp.id, sp.name);
      await settleTodo(env, `spot:${sp.id}`);
      if (sp.created_by && sp.created_by !== member.id) await notify(env, [sp.created_by], 'membership', { kind: 'system', ref: `spot:${sp.id}`, title: ok ? `「${sp.name}」已加到練跑地圖` : `「${sp.name}」沒有通過`, body: ok ? '謝謝你的提議' : '可以補充說明後再提議一次', url: `/#/map?spot=${sp.id}` });
      return json({ ok: true });
    }
    // 現場回報：一小時內同一個地點只能回報一次；24 小時後不再顯示；不顯示是誰
    if (sub === 'reports' && method === 'POST') {
      if (sp.status !== 'approved') return fail(400, '地點審核通過後才能回報');
      const b = await body();
      const pick = (v, list) => (list.includes(v) ? v : undefined);
      const data = { crowd: pick(b.crowd, ['少', '普通', '多']), surface: pick(b.surface, ['乾燥', '濕滑', '積水', '施工', '封閉']), light: pick(b.light, ['充足', '偏暗', '沒有']),
        weather: pick(b.weather, ['晴', '陰', '小雨', '大雨', '悶熱', '強風']), note: str(b.note, 200) || undefined };
      if (!Object.values(data).some(Boolean)) return fail(400, '至少選一項');
      const recent = await env.DB.prepare("SELECT 1 FROM spot_reports WHERE spot_id = ? AND member_id = ? AND created_at >= datetime('now', '-1 hours')").bind(sp.id, member.id).first();
      if (recent) return fail(429, '一小時內已經回報過這個地點');
      const id = rid(8);
      await env.DB.prepare('INSERT INTO spot_reports (id, spot_id, member_id, data) VALUES (?, ?, ?, ?)').bind(id, sp.id, member.id, JSON.stringify(data)).run();
      return json({ id });
    }
    if (sub === 'reports' && method === 'DELETE' && msp[3]) {
      const r = await env.DB.prepare('SELECT member_id FROM spot_reports WHERE id = ? AND spot_id = ?').bind(msp[3], sp.id).first();
      if (!r) return fail(404, '找不到這筆回報');
      if (r.member_id !== member.id && !editor) return fail(403, '只能刪除自己的回報');
      await env.DB.prepare('DELETE FROM spot_reports WHERE id = ?').bind(msp[3]).run();
      if (r.member_id !== member.id) await audit(env, req, member, 'spot.report_delete', 'spot', sp.id, '刪除不當回報');
      return json({ ok: true });
    }
  }
  // 天氣：Open-Meteo 預報＋空氣品質，經過這裡快取（同一格 0.01 度 30 分鐘），不讓每支手機各自去打
  if (path === '/api/weather' && method === 'GET') {
    const g = need(); if (g) return g;
    const u = url0(req), lat = Number(u.searchParams.get('lat')), lng = Number(u.searchParams.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail(400, '座標不正確');
    if (await limited(env, `wx:${member.id}`, 60, 600)) return fail(429, '查詢太頻繁，請稍後再試');
    const w = await getWeather(env, lat, lng);
    if (!w) return fail(502, '天氣預報暫時查不到，請稍後再試');
    return new Response(w.body, { headers: { ...SEC_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=300', 'x-weather-cache': w.hit ? 'hit' : 'miss' } });
  }
  // ---- 附近即時影像（政府公開攝影機；畫面經 Worker 轉送，不保存）----
  //   整個功能由 features.cams 控制（預設關閉）：關閉時畫面與新增連結都回 404，來源設定仍可以先調好
  // 畫面：只轉送啟用中的來源與鏡頭；每位跑友 10 分鐘最多 120 張；每支鏡頭向來源抓取至少間隔 60 秒
  const mcf = path.match(/^\/api\/cams\/([\w:.-]{1,64})\/frame$/);
  if (mcf && method === 'GET') {
    const g = need(); if (g) return g;
    if (!camsOn()) return fail(404, '找不到這支攝影機');
    if (await limited(env, `camv:${member.id}`, 120, 600)) return fail(429, '影像看得太頻繁，請稍後再試');
    const cam = await env.DB.prepare(`SELECT c.id, c.source, c.src_url, c.min_interval, c.health, c.fails, c.last_ok_at FROM cams c
      JOIN cam_sources s ON s.source = c.source AND s.enabled = 1 WHERE c.id = ? AND c.enabled = 1 AND c.media = 'snapshot'`).bind(mcf[1]).first();
    if (!cam) return fail(404, '找不到這支攝影機');
    return Cams.frame(env, cam, (key, n, sec) => limited(env, key, n, sec));
  }
  // 幹部手動新增官方直播連結（例如 YouTube 直播頁）：只顯示成外連，不嵌入、不轉送
  if (path === '/api/cams' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!canEditSpots()) return fail(403, '只有幹部可以新增直播連結');
    if (!camsOn()) return fail(404, '附近即時影像沒有開啟');
    if (!(await env.DB.prepare("SELECT enabled FROM cam_sources WHERE source = 'link'").first())?.enabled) return fail(400, '官方直播連結的來源已關閉，請先在系統設定開啟');
    if (await limited(env, `camlink:${member.id}`, 20, 3600)) return fail(429, '新增太頻繁，請稍後再試');
    const b = await body();
    const name = str(b.name, 40), page = httpsUrl(b.page_url), label = str(b.label, 30) || null, lat = Number(b.lat), lng = Number(b.lng);
    const kind = Cams.CAM_KINDS.includes(b.kind) ? b.kind : 'park';
    if (!name) return fail(400, '請填名稱');
    if (!page) return fail(400, '直播網址要是 https:// 開頭');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 21 || lat > 26.5 || lng < 118 || lng > 122.5) return fail(400, '位置要在臺灣');
    const id = `link:${rid(6)}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cams (id, source, name, kind, lat, lng, media, page_url, label, manual, created_by, hash) VALUES (?, 'link', ?, ?, ?, ?, 'link', ?, ?, 1, ?, '')`)
        .bind(id, name, kind, Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, page, label, member.id),
      env.DB.prepare("UPDATE cam_sources SET last_sync_at = datetime('now'), rev = rev + 1 WHERE source = 'link'"),
    ]);
    await audit(env, req, member, 'cam.link.add', 'cam', id, `${name} ${page}`.slice(0, 200));
    return json({ id });
  }
  const mcd = path.match(/^\/api\/cams\/(link:[\w-]{1,32})$/);
  if (mcd && method === 'DELETE') {
    const g = need(); if (g) return g;
    if (!canEditSpots()) return fail(403, '只有幹部可以刪除直播連結');
    const c = await env.DB.prepare("SELECT name FROM cams WHERE id = ? AND manual = 1").bind(mcd[1]).first();
    if (!c) return fail(404, '找不到這個連結');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM cams WHERE id = ? AND manual = 1').bind(mcd[1]),
      env.DB.prepare("UPDATE cam_sources SET last_sync_at = datetime('now'), rev = rev + 1 WHERE source = 'link'"),
    ]);
    await audit(env, req, member, 'cam.link.delete', 'cam', mcd[1], c.name);
    return json({ ok: true });
  }
  // 來源開關與同步狀態（系統設定）：理事長、行政人員可以改；監事可以看
  if (path === '/api/cams/sources' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !can(member, 'audit')) return fail(403, '只有理事長、行政人員與監事可以看');
    const [srcs, counts] = (await env.DB.batch([
      env.DB.prepare('SELECT source, enabled, last_sync_at, last_ok_at, last_count, last_error FROM cam_sources'),
      env.DB.prepare("SELECT source, SUM(enabled) AS active, SUM(CASE WHEN enabled = 1 AND health = 'down' THEN 1 ELSE 0 END) AS down FROM cams GROUP BY source"),
    ])).map((r) => r.results);
    const cnt = Object.fromEntries(counts.map((r) => [r.source, r]));
    // 「同步中」超過 2 分鐘還沒被覆蓋：那次執行被中斷了（例如超過 CPU 時間上限），照實顯示
    const stuck = (r) => r.last_error === Cams.SYNCING && r.last_sync_at && Date.parse(`${r.last_sync_at.replace(' ', 'T')}Z`) < Date.now() - 120e3;
    return json({ sources: Object.entries(Cams.SOURCES).map(([k, S]) => {
      const r = srcs.find((x) => x.source === k) || {};
      return { source: k, name: S.name, attribution: S.attribution, manual: !!S.manual, consent: !!S.consent, offline: !!S.offline, enabled: !!r.enabled,
        last_sync_at: r.last_sync_at || null, last_ok_at: r.last_ok_at || null, last_count: r.last_count ?? null,
        last_error: stuck(r) ? '上次同步沒有完成（可能超過執行時間上限）' : r.last_error || null,
        active: cnt[k]?.active || 0, down: cnt[k]?.down || 0 };
    }), editable: can(member, 'settings'), feature: camsOn() });
  }
  if (path === '/api/cams/sources' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以修改系統設定');
    const b = await body(), src = str(b.source, 10), S = Cams.sourceOf(src), on = b.enabled === true;
    if (!S) return fail(400, '沒有這個來源');
    // 臺北市水利處的影像沒有開放授權聲明：要確認已取得書面同意才能開啟
    if (on && S.consent && b.consent !== true) return fail(400, '開啟前請先確認已取得臺北市水利處的書面同意');
    await env.DB.prepare('INSERT INTO cam_sources (source, enabled) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled, rev = rev + 1').bind(src, on ? 1 : 0).run();
    await audit(env, req, member, 'settings.cams', 'settings', `cams.${src}`, `${S.name}：${on ? '開啟' : '關閉'}${on && S.consent ? '（已確認取得書面同意）' : ''}`);
    return json({ ok: true });
  }
  // 立即同步（第一次開啟來源後不用等到隔天清晨）：每個來源一小時最多 3 次
  if (path === '/api/cams/sync' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以同步');
    const src = str((await body()).source, 10), S = Cams.sourceOf(src);
    if (!S?.list) return fail(400, '沒有這個來源');
    if (S.offline) return fail(400, '公路局的清單改用電腦上的同步工具更新（tools/cams-sync.mjs），這裡不能同步');
    if (!(await env.DB.prepare('SELECT enabled FROM cam_sources WHERE source = ?').bind(src).first())?.enabled) return fail(400, '請先開啟這個來源');
    if (await limited(env, `camsync:${src}`, 3, 3600)) return fail(429, '這個來源一小時最多同步 3 次');
    let r;
    try { r = await Cams.syncSource(env, src); } catch (e) { r = { error: String(e?.message || e).slice(0, 120) }; await Cams.markFailed(env, src, r.error); }
    await audit(env, req, member, 'settings.cams_sync', 'settings', `cams.${src}`, r.error ? `失敗：${r.error}` : `${r.count} 支，更新 ${r.changed}、停用 ${r.disabled}`);
    if (r.error) return fail(502, r.error);
    return json(r);
  }
  // ---- 跑者休息站（政府開放資料＋幹部整理；src/rest.js）----
  //   整個功能由 features.rest 控制（預設關閉）：關閉時跑友端的 API 都回 404、排程不同步；來源設定與手動同步仍可以先調好（比照附近即時影像）
  //   只開放給登入的跑友（避免被當成免費的資料代理）；伺服器只收到格子代碼或地點代碼，不收跑友的位置
  const RID = /^(?:[a-z]{2,6}):[\w.~-]{1,64}$/;
  const bumpRest = (source) => env.DB.prepare('UPDATE rest_sources SET rev = rev + 1 WHERE source = ?').bind(source);
  // 資料來源清單（地圖選單的「休息站資料來源」）與目前版本（格子 API 的 ?v=）
  if (path === '/api/rest/meta' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!restOn()) return fail(404, '找不到休息站');
    const st = await Rest.sourceState(env);
    // 內容依身分不同（editor）：不讓瀏覽器快取（共用裝置換人登入、幹部改完重新讀都要拿到新的）
    return json({ enabled: true, rev: st.rev, editor: canEditSpots(), sources: st.rows.filter((s) => s.enabled).map((s) => Rest.credit(s.source, s)) });
  }
  // 一格（0.02 度）的休息站：精簡陣列；用格子＋版本快取（這個 isolate 的記憶體＋Cache API；workers.dev 上 Cache API 沒有作用）；
  //   每位跑友 10 分鐘最多 150 次（一個畫面最多 16 格，瀏覽器另外快取一天），加上格子、詳情、地點附近共用的每天上限（restQuota）
  const mrcell = path.match(/^\/api\/rest\/cell\/([^/]{1,20})$/);
  if (mrcell && method === 'GET') {
    const g = need(); if (g) return g;
    if (!restOn()) return fail(404, '找不到休息站');
    if (!Rest.CELL_RE.test(mrcell[1])) return fail(400, '格子代碼不正確');
    const q = await restQuota('restc', 150); if (q) return q;
    const r = await Rest.cellStops(env, mrcell[1]);
    return new Response(r.body, { headers: { ...SEC_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=86400', 'x-rest-cache': r.from } });
  }
  // 來源開關與同步狀態（系統設定）：理事長、行政人員可以改；監事可以看
  if (path === '/api/rest/sources' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !can(member, 'audit')) return fail(403, '只有理事長、行政人員與監事可以看');
    const [srcs, counts] = (await env.DB.batch([
      env.DB.prepare('SELECT source, enabled, last_sync_at, last_ok_at, last_count, last_error, data_date, cursor FROM rest_sources'),
      env.DB.prepare('SELECT source, SUM(CASE WHEN enabled = 1 AND hidden = 0 THEN 1 ELSE 0 END) AS active, SUM(hidden) AS hidden FROM rest_stops GROUP BY source'),
    ])).map((r) => r.results);
    const cnt = Object.fromEntries(counts.map((r) => [r.source, r]));
    const stuck = (r) => r.last_error === Rest.SYNCING && r.last_sync_at && Date.parse(`${r.last_sync_at.replace(' ', 'T')}Z`) < Date.now() - 120e3;
    return json({ sources: Object.entries(Rest.SOURCES).map(([k, S]) => {
      const r = srcs.find((x) => x.source === k) || {};
      return { ...Rest.credit(k, r), manual: !!S.manual, local: !!S.local, enabled: !!r.enabled, every: S.every || null, paged: !!S.pages,
        last_sync_at: r.last_sync_at || null, last_count: r.last_count ?? null, page: r.cursor ?? null,
        last_error: stuck(r) ? '上次同步沒有完成（可能超過執行時間上限）' : r.last_error || null, active: cnt[k]?.active || 0, hidden: cnt[k]?.hidden || 0 };
    }), editable: can(member, 'settings'), feature: restOn() });
  }
  if (path === '/api/rest/sources' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以修改系統設定');
    const b = await body(), src = str(b.source, 10), S = Rest.sourceOf(src), on = b.enabled === true;
    if (!S) return fail(400, '沒有這個來源');
    await env.DB.prepare('INSERT INTO rest_sources (source, enabled) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled, rev = rev + 1').bind(src, on ? 1 : 0).run();
    await audit(env, req, member, 'settings.rest', 'settings', `rest.${src}`, `${S.name}：${on ? '開啟' : '關閉'}`);
    return json({ ok: true });
  }
  // 立即同步（分頁來源一次一頁）：每個來源一小時最多 3 次
  //   只由維護工具同步的來源（SOURCES 標 local：大檔、多檔）不在 Worker 跑：免費方案每次執行只有 10 ms CPU，會被強制中斷
  //   D1 指令：登入與設定 2–4＋開啟檢查 1＋節流 1＋同步 5＋稽核 1，最多約 12 個
  if (path === '/api/rest/sync' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以同步');
    const src = str((await body()).source, 10), S = Rest.sourceOf(src);
    if (!S || S.manual) return fail(400, '沒有這個來源');
    if (S.local) return fail(400, '這個來源由維護工具同步（tools/rest-sync.mjs），不能在這裡立即同步');
    if (!(await env.DB.prepare('SELECT enabled FROM rest_sources WHERE source = ?').bind(src).first())?.enabled) return fail(400, '請先開啟這個來源');
    if (await limited(env, `restsync:${src}`, 3, 3600)) return fail(429, '這個來源一小時最多同步 3 次');
    let r;
    try { r = await Rest.syncSource(env, src); } catch (e) { r = { error: String(e?.message || e).slice(0, 120) }; await Rest.markFailed(env, src, r.error); }
    await audit(env, req, member, 'settings.rest_sync', 'settings', `rest.${src}`, r.error ? `失敗：${r.error}` : `${r.count} 處，更新 ${r.changed}、停用 ${r.disabled}${r.pages ? `（第 ${r.page}／${r.pages} 頁）` : ''}`);
    if (r.error) return fail(502, r.error);
    return json(r);
  }
  // 幹部新增（source='man'）：權限同地點管理
  if (path === '/api/rest' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!canEditSpots()) return fail(403, '只有幹部可以新增休息站');
    if (!restOn()) return fail(404, '跑者休息站沒有開啟');
    if (!(await env.DB.prepare("SELECT enabled FROM rest_sources WHERE source = 'man'").first())?.enabled) return fail(400, '幹部新增的來源已關閉，請先在系統設定開啟');
    if (await limited(env, `restadd:${member.id}`, 20, 3600)) return fail(429, '新增太頻繁，請稍後再試');
    const v = Rest.readStop(await body());
    if (v.error) return fail(400, v.error);
    const s = v.value, id = `man:${rid(6)}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO rest_stops (id, source, type, subtype, svc, access, name, place, address, city, lat, lng, cell, hours, hours_raw, fee, note, ref_url, manual, checked_at, created_by, updated_by, hash)
        VALUES (?, 'man', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '')`)
        .bind(id, s.type, s.subtype, s.svc, s.access, s.name, s.place, s.address, s.city, s.lat, s.lng, s.cell, s.hours, s.hours_raw, s.fee, s.note, s.ref_url, today(), member.id, member.id),
      bumpRest('man'),
    ]);
    await audit(env, req, member, 'rest.add', 'rest', id, s.name);
    return json({ id });
  }
  const mrs = path.match(/^\/api\/rest\/([^/]{1,80})$/);
  if (mrs && RID.test(mrs[1]) && ['GET', 'PUT', 'DELETE'].includes(method)) {
    const g = need(); if (g) return g;
    const editor = canEditSpots();
    if (method === 'GET') {
      if (!restOn()) return fail(404, '找不到休息站');
      // 跑友的版本依 id＋版本快取；每位跑友 10 分鐘最多 60 次（和地點的附近休息站共用），加上每天的上限（restQuota）
      const q = await restQuota('restd', REST_DETAIL_LIMIT); if (q) return q;
      const d = await Rest.detail(env, mrs[1], editor);
      // 幹部多看得到建立者、修正前的值與隱藏的列：不讓瀏覽器快取（json 預設 no-store）
      return d.out ? json(d.out, 200, { 'x-rest-cache': d.from }) : fail(404, '找不到休息站');
    }
    if (!editor) return fail(403, '只有幹部可以修改休息站');
    if (!restOn()) return fail(404, '跑者休息站沒有開啟');
    const row = await env.DB.prepare('SELECT id, source, name, lat, lng, fix, hidden, manual FROM rest_stops WHERE id = ?').bind(mrs[1]).first();
    if (!row) return fail(404, '找不到休息站');
    if (method === 'DELETE') {
      // 官方資料不刪（同步會再出現），改用隱藏
      if (!row.manual) return fail(400, '官方資料不能刪除，請改用隱藏');
      await env.DB.batch([env.DB.prepare('DELETE FROM rest_stops WHERE id = ? AND manual = 1').bind(row.id), bumpRest(row.source)]);
      await audit(env, req, member, 'rest.delete', 'rest', row.id, row.name);
      return json({ ok: true });
    }
    // PUT：官方資料只能寫 fix、note 或隱藏；man 和 cur 可以整筆修改
    const b = await body(), stmts = [];
    const hidden = typeof b.hidden === 'boolean' ? b.hidden : null;
    let fixed = false, name = row.name;
    if (row.manual && b.name !== undefined) {
      const v = Rest.readStop(b);
      if (v.error) return fail(400, v.error);
      const s = v.value;
      name = s.name;
      stmts.push(env.DB.prepare(`UPDATE rest_stops SET type = ?, subtype = ?, svc = ?, access = ?, name = ?, place = ?, address = ?, city = ?, lat = ?, lng = ?, cell = ?,
        hours = ?, hours_raw = ?, fee = ?, note = ?, ref_url = ?, checked_at = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(s.type, s.subtype, s.svc, s.access, s.name, s.place, s.address, s.city, s.lat, s.lng, s.cell, s.hours, s.hours_raw, s.fee, s.note, s.ref_url, today(), member.id, row.id));
      fixed = true;
    } else {
      if (b.fix !== undefined) {
        if (row.manual) return fail(400, '整理清單與幹部新增的資料請直接修改欄位');
        const f = Rest.readFix(b.fix);
        if (f.error) return fail(400, f.error);
        // 修正位置時，格子跟著修正後的位置（同步不會改回來源的格子）
        const lat = f.value?.lat ?? row.lat, lng = f.value?.lng ?? row.lng;
        stmts.push(env.DB.prepare("UPDATE rest_stops SET fix = ?, cell = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(f.value ? JSON.stringify(f.value) : null, Rest.cellOf(lat, lng), member.id, row.id));
        if (f.value?.name) name = f.value.name;
        fixed = true;
      }
      if (b.note !== undefined) {
        const note = typeof b.note === 'string' ? b.note.replace(/\s+/g, ' ').trim() : '';
        if (note.length > 200) return fail(400, '補充說明最多 200 字');
        stmts.push(env.DB.prepare("UPDATE rest_stops SET note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").bind(Rest.noPhone(note) || null, member.id, row.id));
        fixed = true;
      }
    }
    const hide = hidden !== null && hidden !== !!row.hidden;
    if (hide) stmts.push(env.DB.prepare("UPDATE rest_stops SET hidden = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").bind(hidden ? 1 : 0, member.id, row.id));
    if (!stmts.length) return fail(400, '沒有要修改的內容');
    stmts.push(bumpRest(row.source));
    await env.DB.batch(stmts);
    if (fixed) await audit(env, req, member, 'rest.fix', 'rest', row.id, name);
    if (hide) await audit(env, req, member, 'rest.hide', 'rest', row.id, `${hidden ? '隱藏' : '取消隱藏'}：${name}`);
    return json({ ok: true });
  }
  // 路線：在地圖上畫的路線，可以分享給全團、下載 GPX、拿來開揪跑
  if (path === '/api/routes' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare(`SELECT r.id, r.name, r.distance, r.spot_id, r.shared, r.created_at, r.created_by = ? AS mine, m.nickname, m.name AS author
      FROM routes r LEFT JOIN members m ON m.id = r.created_by WHERE r.shared = 1 OR r.created_by = ? ORDER BY r.created_at DESC LIMIT 100`).bind(member.id, member.id).all()).results;
    return json({ routes: rows.map((r) => ({ ...r, mine: !!r.mine, author: r.nickname || r.author || '', nickname: undefined })) });
  }
  if (path === '/api/routes' && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `route:${member.id}`, 30, 3600)) return fail(429, '儲存太頻繁，請稍後再試');
    const b = await body();
    const pts = (Array.isArray(b.points) ? b.points : []).slice(0, 3000).map((p) => [Math.round(Number(p?.[0]) * 1e6) / 1e6, Math.round(Number(p?.[1]) * 1e6) / 1e6])
      .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180);
    if (pts.length < 2) return fail(400, '路線至少要兩個點');
    const R = 6371000, rad = (x) => (x * Math.PI) / 180;
    let dist = 0;
    for (let i = 1; i < pts.length; i++) { const [a1, o1] = pts[i - 1], [a2, o2] = pts[i]; const h = Math.sin(rad(a2 - a1) / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(rad(o2 - o1) / 2) ** 2; dist += 2 * R * Math.asin(Math.sqrt(h)); }
    const id = rid(8), name = str(b.name, 40) || `${(dist / 1000).toFixed(1)} 公里路線`;
    const spot = /^[\w-]{1,32}$/.test(b.spot_id || '') ? b.spot_id : null;
    // 每人最多 ROUTE_MAX 條（一條最多約 66 KB）：不讓一個帳號把資料庫與每日備份灌爆（A.8.13）；數量檢查和寫入同一句
    const r = await env.DB.prepare(`INSERT INTO routes (id, name, points, distance, spot_id, shared, created_by) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE (SELECT COUNT(*) FROM routes WHERE created_by = ?7) < ${ROUTE_MAX}`)
      .bind(id, name, JSON.stringify(pts), Math.round(dist), spot, b.shared === false ? 0 : 1, member.id).run();
    if (!r.meta.changes) return fail(400, `每人最多存 ${ROUTE_MAX} 條路線，請先刪掉不用的`);
    return json({ id, distance: Math.round(dist), name });
  }
  const mrt = path.match(/^\/api\/routes\/([\w-]{1,32})$/);
  if (mrt) {
    const g = need(); if (g) return g;
    const r = await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(mrt[1]).first();
    if (!r || (!r.shared && r.created_by !== member.id && !(await env.DB.prepare(`SELECT 1 FROM events WHERE events.route_id = ?3 AND ${seeSQL} LIMIT 1`).bind(member.id, can(member, 'event') ? 1 : 0, r.id).first()))) return fail(404, '找不到這條路線');
    if (method === 'GET') return json({ route: { id: r.id, name: r.name, distance: r.distance, spot_id: r.spot_id, shared: !!r.shared, points: parseQ(r.points), mine: r.created_by === member.id } });
    if (method === 'DELETE') {
      if (r.created_by !== member.id && !canEditSpots()) return fail(403, '只能刪除自己畫的路線');
      await env.DB.prepare('DELETE FROM routes WHERE id = ?').bind(r.id).run();
      await env.DB.prepare('UPDATE events SET route_id = NULL WHERE route_id = ?').bind(r.id).run();
      // 自己刪自己的路線也寫稽核（不記名稱）：還原備份或 Time Travel 後才能再刪一次（tools/restore-sql.mjs）
      await audit(env, req, member, 'route.delete', 'route', r.id, r.created_by !== member.id ? r.name : '');
      return json({ ok: true });
    }
  }
  // ---- 行事曆 ----
  // 月曆：看得到的活動、國定假日、賽事提醒、我自己的賽事（每月一次查完）
  if (path === '/api/calendar' && method === 'GET') {
    const g = need(); if (g) return g;
    const mo = url0(req).searchParams.get('month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mo || '')) return fail(400, '月份格式不正確');
    const from = `${mo}-01`, to = `${mo}-31`;
    const [events, hol, items, races] = await Promise.all([
      env.DB.prepare(`SELECT events.id, events.title, events.date, events.gather_time, events.place, events.kind, events.team_id, events.series_id,
          (SELECT CASE WHEN s.status = 'cancel' AND s.review = 'rejected' THEN 'rejected' ELSE s.status END FROM signups s WHERE s.event_id = events.id AND s.member_id = ?1) AS mine,
          (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'in') AS signed
        FROM events WHERE events.date BETWEEN ?3 AND ?4 AND ${seeSQL} ORDER BY events.date, events.gather_time LIMIT 300`).bind(member.id, can(member, 'event') ? 1 : 0, from, to).all(),
      env.DB.prepare('SELECT date, name, is_holiday, category FROM holidays WHERE date BETWEEN ? AND ? AND (name IS NOT NULL OR is_holiday = 0)').bind(from, to).all(),
      env.DB.prepare(`SELECT id, date, title, kind, url, note, team_id, created_by FROM calendar_items WHERE date BETWEEN ? AND ?
        AND (team_id IS NULL OR team_id IN (SELECT team_id FROM team_members WHERE member_id = ? AND status = 'active') OR ? = 1) ORDER BY date`).bind(from, to, member.id, can(member, 'event') ? 1 : 0).all(),
      env.DB.prepare('SELECT id, name, date, dist FROM races WHERE member_id = ? AND date BETWEEN ? AND ?').bind(member.id, from, to).all(),
    ]);
    const holidaysLoaded = !!(await env.DB.prepare('SELECT 1 FROM holidays WHERE year = ? LIMIT 1').bind(Number(mo.slice(0, 4))).first());
    return json({ month: mo, events: events.results, holidays: hol.results, items: items.results.map((it) => ({ ...it, mine: it.created_by === member.id, canEdit: it.created_by === member.id || teamCan(it.team_id, 'event') })),
      races: races.results, holidaysLoaded, canAdd: teamCan(null, 'event') || Object.keys(myTeams).some((t) => teamCan(t, 'event')) });
  }
  if (path === '/api/calendar/items' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body();
    const it = { date: str(b.date, 10), title: str(b.title, 60), kind: ['race', 'signup', 'note'].includes(b.kind) ? b.kind : 'race',
      url: httpsUrl(str(b.url, 300)), note: str(b.note, 300), team_id: str(b.team_id, 16) || null };
    if (!isDate(it.date) || !it.title) return fail(400, '請填日期與標題');
    if (!teamCan(it.team_id, 'event')) return fail(403, it.team_id ? '只有這個分團的團長與幹部可以新增' : '只有幹部可以新增全協會的提醒');
    const id = rid(8);
    await env.DB.prepare('INSERT INTO calendar_items (id, date, title, kind, url, note, team_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, it.date, it.title, it.kind, it.url || null, it.note || null, it.team_id, member.id).run();
    await audit(env, req, member, 'calendar.add', 'calendar', id, `${it.date} ${it.title}`);
    if (b.notify === true) await notify(env, it.team_id ? await teamMemberIds(it.team_id, member.id) : await allMemberIds(env, member.id), 'event',
      { title: `行事曆：${it.title}`, body: `${it.date}${it.note ? `　${it.note}` : ''}`, url: `/#/calendar?m=${it.date.slice(0, 7)}` });
    return json({ id });
  }
  const mci = path.match(/^\/api\/calendar\/items\/([\w-]{1,32})$/);
  if (mci && method === 'DELETE') {
    const g = need(); if (g) return g;
    const it = await env.DB.prepare('SELECT * FROM calendar_items WHERE id = ?').bind(mci[1]).first();
    if (!it) return fail(404, '找不到這筆提醒');
    if (it.created_by !== member.id && !teamCan(it.team_id, 'event')) return fail(403, '沒有權限刪除');
    await env.DB.prepare('DELETE FROM calendar_items WHERE id = ?').bind(it.id).run();
    await audit(env, req, member, 'calendar.delete', 'calendar', it.id, `${it.date} ${it.title}`);
    return json({ ok: true });
  }
  // 國定假日：管理員每年手動匯入（新北市政府資料開放平台「政府行政機關辦公日曆表」）
  if (path === '/api/holidays' && method === 'GET') {
    const g = need(); if (g) return g;
    const years = (await env.DB.prepare('SELECT year, COUNT(*) AS n, SUM(CASE WHEN name IS NOT NULL AND is_holiday = 1 THEN 1 ELSE 0 END) AS named FROM holidays GROUP BY year ORDER BY year DESC LIMIT 10').all()).results;
    return json({ years });
  }
  if (path === '/api/holidays/import' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以匯入假日');
    const year = Number((await body()).year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) return fail(400, '年份不正確');
    if (await limited(env, `holiday:${member.id}`, 10, 3600)) return fail(429, '匯入太頻繁，請稍後再試');
    // 頁數上限跟著執行額度（免費方案 10 頁＝1 萬筆，新北市的資料約 4 千筆）
    const rows = [], pages = planOf(env).holidayPages, mock = env.NTPC_MOCK === '1' && env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url0(req).hostname);
    for (let page = 0; page < pages; page++) {
      const r = mock ? ntpcMock(env, year, page) : await xfetch(env, `https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json?page=${page}&size=1000`, { headers: { accept: 'application/json' }, cf: { cacheTtl: 3600 } });
      if (!r.ok) return fail(502, `新北市資料開放平台暫時無法連線（${r.status}），請稍後再試`);
      const list = await r.json().catch(() => null);
      if (!Array.isArray(list)) return fail(502, '新北市資料開放平台回傳的格式不正確');
      if (!list.length) break;
      for (const x of list) if (String(x.year) === String(year) && /^\d{8}$/.test(x.date || '')) rows.push(x);
      if (list.length < 1000) break;
    }
    if (!rows.length) return fail(404, `新北市資料開放平台還沒有 ${year} 年的資料，通常前一年 6 月後公告`);
    // 刪除與寫入在同一個 batch（同一個交易）；一整年一句 INSERT … SELECT FROM json_each
    const hj = JSON.stringify(rows.map((x) => [`${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`, str(x.name, 40) || null, x.isholiday === '是' ? 1 : 0, str(x.holidaycategory, 40) || null, str(x.description, 120) || null]));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM holidays WHERE year = ?').bind(year),
      env.DB.prepare(`INSERT OR REPLACE INTO holidays (date, year, name, is_holiday, category, description)
        SELECT json_extract(value, '$[0]'), ?1, json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]') FROM json_each(?2)`).bind(year, hj),
    ]);
    const named = rows.filter((x) => x.name && x.isholiday === '是');
    await audit(env, req, member, 'holiday.import', 'settings', String(year), `${rows.length} 天，節日 ${named.length} 天`);
    return json({ year, total: rows.length, holidays: named.map((x) => ({ date: `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`, name: x.name })),
      workdays: rows.filter((x) => x.isholiday === '否').length });
  }
  if (path === '/api/me/calendar-scope' && method === 'POST') {
    const g = need(); if (g) return g;
    const scope = (await body()).scope === 'mine' ? 'mine' : 'all';
    await env.DB.prepare('UPDATE members SET cal_scope = ? WHERE id = ?').bind(scope, member.id).run();
    return json({ scope });
  }
  const mcal = path.match(/^\/api\/cal\/([\w]{16,64})\.ics$/);
  if (mcal && method === 'GET') {
    const th = await sha(mcal[1]);
    if (await limited(env, `cal:${th.slice(0, 16)}`, 60, 3600)) return fail(429, '更新太頻繁');
    const who = await env.DB.prepare('SELECT id, role, cal_scope FROM members WHERE cal_token_hash = ?').bind(th).first();
    if (!who) return fail(404, '訂閱網址已失效');
    // all：看得到的所有活動（標出自己的報名狀態）＋幹部設定的賽事提醒；mine：只有自己報名的
    const rows = who.cal_scope === 'mine'
      ? (await env.DB.prepare(`SELECT e.id, e.title, e.date, e.gather_time, e.end_time, e.place, e.address, e.note, e.kind, s.status
          FROM signups s JOIN events e ON e.id = s.event_id WHERE s.member_id = ? AND s.status IN ('in', 'wait', 'pending')
          AND e.date BETWEEN date('now', '-30 days') AND date('now', '+180 days') ORDER BY e.date LIMIT 300`).bind(who.id).all()).results
      : (await env.DB.prepare(`SELECT events.id, events.title, events.date, events.gather_time, events.end_time, events.place, events.address, events.note, events.kind,
          (SELECT CASE WHEN s.status = 'cancel' AND s.review = 'rejected' THEN 'rejected' ELSE s.status END FROM signups s WHERE s.event_id = events.id AND s.member_id = ?1) AS status
          FROM events WHERE events.date BETWEEN date('now', '-30 days') AND date('now', '+180 days') AND ${seeSQL} ORDER BY events.date LIMIT 400`)
        .bind(who.id, 0).all()).results;   // 訂閱網址不帶幹部的檢視權限（邀請制只看得到自己受邀的）
    const items = who.cal_scope === 'mine' ? [] : (await env.DB.prepare(`SELECT id, date, title, kind, url, note FROM calendar_items
      WHERE date BETWEEN date('now', '-30 days') AND date('now', '+400 days') AND (team_id IS NULL OR team_id IN (SELECT team_id FROM team_members WHERE member_id = ? AND status = 'active'))
      ORDER BY date LIMIT 200`).bind(who.id).all()).results;
    const icsEsc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
    const d8 = (d) => d.replace(/-/g, ''), t6 = (t) => `${t.replace(':', '')}00`;
    const origin = new URL(req.url).origin, stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const plus1 = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    const ev = rows.filter((r) => r.status !== 'rejected').map((r) => {   // 被婉拒的不列出
      const timed = /^\d{2}:\d{2}$/.test(r.gather_time || '');
      const end = timed ? (/^\d{2}:\d{2}$/.test(r.end_time || '') && r.end_time > r.gather_time ? r.end_time
        : `${String(Math.min(23, Number(r.gather_time.slice(0, 2)) + 2)).padStart(2, '0')}${r.gather_time.slice(2)}`) : null;
      return ['BEGIN:VEVENT', `UID:${r.id}@cil-run`, `DTSTAMP:${stamp}`,
        timed ? `DTSTART;TZID=Asia/Taipei:${d8(r.date)}T${t6(r.gather_time)}` : `DTSTART;VALUE=DATE:${d8(r.date)}`,
        timed ? `DTEND;TZID=Asia/Taipei:${d8(r.date)}T${t6(end)}` : `DTEND;VALUE=DATE:${d8(plus1(r.date))}`,
        `SUMMARY:${icsEsc(`${r.status === 'wait' ? '（候補）' : r.status === 'in' ? '（已報名）' : r.status === 'pending' ? '（審核中）' : ''}${r.title}`)}`, r.place || r.address ? `LOCATION:${icsEsc([r.place, r.address].filter(Boolean).join(' '))}` : '',
        `DESCRIPTION:${icsEsc(`${r.status === 'in' ? '已報名\n' : r.status === 'wait' ? '候補中\n' : r.status === 'pending' ? '審核中\n' : '還沒報名，點連結報名\n'}${r.note ? `${r.note}\n` : ''}${origin}/#/e/${r.id}`)}`, `URL:${origin}/#/e/${r.id}`, 'END:VEVENT'].filter(Boolean).map(fold).join('\r\n');
    });
    const CAL_KIND = { race: '賽事', signup: '報名', note: '提醒' };
    for (const it of items) ev.push(['BEGIN:VEVENT', `UID:${it.id}@cil-run-item`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d8(it.date)}`, `DTEND;VALUE=DATE:${d8(plus1(it.date))}`,
      `SUMMARY:${icsEsc(`【${CAL_KIND[it.kind] || '提醒'}】${it.title}`)}`, `DESCRIPTION:${icsEsc(`${it.note || ''}${it.url ? `\n${it.url}` : ''}`)}`, it.url ? `URL:${it.url}` : '',
      ...(it.kind === 'signup' ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(it.title)}`, 'TRIGGER:-PT15H', 'END:VALARM'] : []), 'END:VEVENT'].filter(Boolean).map(fold).join('\r\n'));
    const body2 = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cultivation in Life Run//cil-run//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:耕跑團', 'X-WR-TIMEZONE:Asia/Taipei', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Taipei', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST', 'END:STANDARD', 'END:VTIMEZONE',
      ...ev, 'END:VCALENDAR'].join('\r\n');
    return new Response(body2, { headers: { ...SEC_HEADERS, 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': 'inline; filename="cil-run.ics"' } });
  }

  // 前端錯誤回報：同一天同一個錯誤只留一筆並累加次數；不存身分；有次數限制
  if (path === '/api/client-error' && method === 'POST') {
    if (await limited(env, `cerr:${await ipHash(req, env)}`, 20, 600)) return json({ ok: true });
    const b = await body(), e = { message: str(b.message, 300), source: str(b.source, 120), line: Math.max(0, Math.min(Number(b.line) || 0, 1e6)), page: str(b.page, 60) };
    if (!e.message) return json({ ok: true });
    const device = deviceLabel(req.headers.get('user-agent') || '');
    console.error('client-error', JSON.stringify({ ...e, device, member: member ? 'yes' : 'no' }));
    await env.DB.prepare(`INSERT INTO client_errors (day, message, source, line, page, device) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, message, source, line) DO UPDATE SET n = n + 1, last_at = datetime('now'), page = excluded.page, device = excluded.device`)
      .bind(today(), e.message, e.source, e.line, e.page, device).run();
    return json({ ok: true });
  }
  // 開啟速度：每次開啟最多送一次（幾個數字），不存身分
  if (path === '/api/vitals' && method === 'POST') {
    if (await limited(env, `vit:${await ipHash(req, env)}`, 30, 600)) return json({ ok: true });
    const b = await body(), device = deviceLabel(req.headers.get('user-agent') || ''), page = str(b.page, 40);
    const LIM = { ready: 60000, fcp: 60000, lcp: 60000, inp: 20000, ttfb: 60000, cls: 10 };
    const rows = Object.entries(LIM).map(([k, max]) => [k, Number(b[k])]).filter(([k, v]) => Number.isFinite(v) && v >= 0 && v <= LIM[k]);
    // 資料讀取時間：每種 API（代碼換成 :id）的中位數，api＝總時間、apisrv＝其中伺服器處理的時間
    const apis = (Array.isArray(b.api) ? b.api : []).slice(0, 10).filter((x) => /^\/[\w/:.-]{1,48}$/.test(x?.p || '') && Number.isFinite(x.ms) && x.ms >= 0 && x.ms <= 60000);
    // 全部一句寫完（json_each：[指標, 數值, 頁面, warm]），寫入的列數不變
    const all = [...rows.map(([k, v]) => [k, Math.round(v * (k === 'cls' ? 1000 : 1)) / (k === 'cls' ? 1000 : 1), page, b.warm ? 1 : 0]),
      ...apis.flatMap((x) => [['api', x.ms], ...(Number.isFinite(x.srv) && x.srv >= 0 && x.srv <= 60000 ? [['apisrv', x.srv]] : [])].map(([k, v]) => [k, Math.round(v), x.p, 0]))];
    if (all.length) await env.DB.prepare(`INSERT INTO client_metrics (day, metric, value, page, device, standalone, warm)
      SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?2, ?3, json_extract(value, '$[3]') FROM json_each(?4)`)
      .bind(today(), device, b.standalone ? 1 : 0, JSON.stringify(all)).run();
    return json({ ok: true });
  }
  // 速度與錯誤（管理後台總覽）：最近 N 天的 p75 與最常見的錯誤
  if (path === '/api/admin/health' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !can(member, 'audit')) return fail(403, '只有理事長、行政人員與監事可以看');
    const days = [7, 30, 90].includes(Number(url0(req).searchParams.get('days'))) ? Number(url0(req).searchParams.get('days')) : 7;
    const from = new Date(Date.now() + 8 * 3600e3 - (days - 1) * 864e5).toISOString().slice(0, 10);
    // 百分位在 SQL 算（ROW_NUMBER＋COUNT，取第 floor(n×p)+1 名，和以前在 JS 排序的結果一樣），不再把幾萬列讀進 Worker；
    //   同一個 batch 再帶出執行額度、排程工作、推播佇列（管理後台「執行額度」區塊）
    const PCT = (p) => `MIN(n, CAST(n * ${p} AS INTEGER) + 1)`, MET = "('ready','fcp','lcp','inp','cls','ttfb')";
    const [mres, eres, ares, bres, jres, qres] = await env.DB.batch([
      env.DB.prepare(`WITH r AS (SELECT metric, value, warm, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY value) AS rn, COUNT(*) OVER (PARTITION BY metric) AS n
          FROM client_metrics WHERE day >= ?1 AND metric IN ${MET}),
        w AS (SELECT metric, value, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY value) AS rn, COUNT(*) OVER (PARTITION BY metric) AS n
          FROM client_metrics WHERE day >= ?1 AND warm AND metric IN ${MET})
        SELECT metric, MAX(n) AS n, MAX(CASE WHEN rn = ${PCT(0.5)} THEN value END) AS p50, MAX(CASE WHEN rn = ${PCT(0.75)} THEN value END) AS p75,
          (SELECT value FROM w WHERE w.metric = r.metric AND w.rn = MIN(w.n, CAST(w.n * 0.75 AS INTEGER) + 1)) AS warmP75
        FROM r GROUP BY metric`).bind(from),
      env.DB.prepare(`SELECT message, source, line, page, device, SUM(n) AS n, MAX(last_at) AS last_at FROM client_errors WHERE day >= ?
        GROUP BY message, source, line ORDER BY n DESC LIMIT 20`).bind(from),
      // 最慢的資料讀取（p75）：總時間與其中伺服器處理的時間
      env.DB.prepare(`WITH a AS (SELECT page, metric, value, ROW_NUMBER() OVER (PARTITION BY page, metric ORDER BY value) AS rn, COUNT(*) OVER (PARTITION BY page, metric) AS n
          FROM client_metrics WHERE day >= ?1 AND metric IN ('api', 'apisrv'))
        SELECT page, MAX(CASE WHEN metric = 'api' THEN n END) AS n, MAX(CASE WHEN metric = 'api' AND rn = ${PCT(0.75)} THEN value END) AS p75,
          MAX(CASE WHEN metric = 'apisrv' AND rn = ${PCT(0.75)} THEN value END) AS srv
        FROM a GROUP BY page HAVING n > 0 ORDER BY p75 DESC LIMIT 8`).bind(from),
      env.DB.prepare(`SELECT name, kind, SUM(n) AS n, SUM(stopped) AS stopped, SUM(over) AS over, MAX(max_sub) AS max_sub, MAX(last_at) AS last_at FROM budget_log
        WHERE day >= ? GROUP BY name ORDER BY SUM(stopped) + SUM(over) DESC, SUM(n) DESC LIMIT 20`).bind(from),
      env.DB.prepare("SELECT job, last_run, claim_key, claim_at, attempts, last_error, done_at FROM job_runs WHERE job != 'promote_sweep' ORDER BY job"),
      env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM push_queue"),
    ]);
    const metrics = {};
    for (const k of ['ready', 'fcp', 'lcp', 'inp', 'cls', 'ttfb']) {
      const r = mres.results.find((x) => x.metric === k);
      metrics[k] = { n: r?.n || 0, p50: r?.p50 ?? null, p75: r?.p75 ?? null, warmP75: r?.warmP75 ?? null };
    }
    const errors = eres.results, apis = ares.results.map((x) => ({ page: x.page, n: x.n, p75: x.p75, srv: x.srv ?? null }));
    // 排程工作的狀態：完成、等下個整點補做、失敗 n 次（連續 3 次就放棄）
    //   佔用超過 15 分鐘還沒結束、也沒有錯誤訊息＝被平台終止（下個整點會補記錯誤）；已經第 3 次就算放棄
    //   跑者休息站（rest.<來源>）沒有用佔用：last_run 還是「retry:日期」＝那天沒有同步完成（失敗或被終止），隔天重試
    const stale = (at) => !!at && Date.parse(`${at.replace(' ', 'T')}Z`) < Date.now() - 15 * 60e3;
    const jobs = jres.results.map((j) => ({ ...j, state: j.claim_key && j.attempts >= 3 && (j.last_error || stale(j.claim_at)) ? 'gave_up'
      : j.last_error ? 'failed' : j.claim_key ? 'pending' : String(j.last_run || '').startsWith('retry:') ? 'retry' : 'done' }));
    return json({ days, metrics, errors, apis, budget: bres.results, jobs, pushQueue: { n: qres.results[0].n, oldest: qres.results[0].oldest } });
  }
  // 分團小圖：網址帶版本號，可以長期快取
  const mic = path.match(/^\/api\/teams\/([\w-]{1,16})\/icon$/);
  if (mic && method === 'GET') {
    const r = await env.DB.prepare('SELECT icon FROM teams WHERE id = ?').bind(mic[1]).first();
    const m = r?.icon?.match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return fail(404, '沒有圖示');
    return new Response(b64bytes(m[2]), { headers: { ...SEC_HEADERS,
      'content-type': m[1], 'cache-control': 'public, max-age=31536000, immutable' } });
  }
  if (mic && method === 'PUT') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !teamCan(mic[1], 'appoint')) return fail(403, '只有團長或行政人員可以換分團圖示');
    const icon = (await body()).icon;
    if (icon !== null && !(typeof icon === 'string' && icon.length <= 80000 && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(icon))) return fail(400, '圖片格式不對或太大');
    const r = await env.DB.prepare('UPDATE teams SET icon = ?, icon_v = ? WHERE id = ?').bind(icon, icon ? Date.now() : null, mic[1]).run();
    if (!r.meta.changes) return fail(404, '找不到這個分團');
    await audit(env, req, member, 'team.icon', 'team', mic[1], icon ? '更新圖示' : '移除圖示');
    return json({ ok: true });
  }


  // ---- 通行金鑰（Face ID／指紋登入）與幹部兩步驟驗證 ----
  const rpId = new URL(req.url).hostname, origin0 = new URL(req.url).origin;
  if (path === '/api/passkey/options' && method === 'POST') {
    const b = await body(), purpose = ['register', 'login', 'stepup'].includes(b.purpose) ? b.purpose : null;
    if (!purpose) return fail(400, '用途不正確');
    if (purpose !== 'login') { const g = need(); if (g) return g; }
    // 已經有通行金鑰、或協會要求兩步驟的幹部：再新增一把要先用現有的驗證（避免偷到登入的人自己加一把）
    if (purpose === 'register' && (await hasPasskey() || (security.require_mfa && member.mfa_pending)) && !freshMfa())
      return json({ error: '新增通行金鑰前，請先用現有的通行金鑰驗證', stepup: true }, 403);
    if (await limited(env, `pk:${await ipHash(req, env)}`, 30, 600)) return fail(429, '嘗試太多次，請稍後再試');
    const cid = rid(12), challenge = WebAuthn.b64u(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')").run();
    await env.DB.prepare("INSERT INTO webauthn_challenges (id, challenge, member_id, purpose, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))")
      .bind(cid, challenge, member?.id || null, purpose).run();
    const mine = member ? (await env.DB.prepare('SELECT id FROM passkeys WHERE member_id = ?').bind(member.id).all()).results : [];
    const base = { challenge, timeout: 60000, rpId, userVerification: 'required' };
    if (purpose === 'register') return json({ cid, publicKey: { ...base, rp: { id: rpId, name: '耕跑團' },
      user: { id: WebAuthn.b64u(new TextEncoder().encode(member.id)), name: member.nickname || member.name, displayName: member.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: mine.map((x) => ({ type: 'public-key', id: x.id })) } });
    if (purpose === 'stepup' && !mine.length) return fail(400, '你還沒有通行金鑰，請先新增一把');
    return json({ cid, publicKey: { ...base, allowCredentials: purpose === 'stepup' ? mine.map((x) => ({ type: 'public-key', id: x.id })) : [] } });
  }
  if (path === '/api/passkey/verify' && method === 'POST') {
    const b = await body(), cred = b.credential;
    const ch = await env.DB.prepare("SELECT * FROM webauthn_challenges WHERE id = ? AND expires_at > datetime('now')").bind(str(b.cid, 32)).first();
    if (!ch || !cred?.response) return fail(400, '驗證逾時，請再試一次');
    await env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?').bind(ch.id).run();   // 挑戰只能用一次
    try {
      if (ch.purpose === 'register') {
        const g = need(); if (g) return g;
        if (ch.member_id !== member.id) return fail(400, '驗證逾時，請再試一次');
        if ((await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE member_id = ?').bind(member.id).first()).n >= 10) return fail(400, '最多 10 把通行金鑰');
        const r = await WebAuthn.verifyRegistration({ credential: cred, challenge: ch.challenge, origin: origin0, rpId });
        if (!r.uv) throw new Error('請用 Face ID、Touch ID 或裝置密碼確認');
        await env.DB.prepare('INSERT INTO passkeys (id, member_id, public_jwk, sign_count, name) VALUES (?, ?, ?, ?, ?)')
          .bind(r.credId, member.id, JSON.stringify(r.jwk), r.signCount, str(b.name, 20) || deviceLabel(req.headers.get('user-agent') || '')).run();
        await audit(env, req, member, 'passkey.add', 'member', member.id, deviceLabel(req.headers.get('user-agent') || ''));
        await securityNotify(env, [member.id], { title: '新增了一把通行金鑰', body: `${deviceLabel(req.headers.get('user-agent') || '')}。不是你的話，請到「我的 → 帳號與安全」移除並登出所有裝置。`, url: '/#/me/security' });
        return json({ ok: true });
      }
      const pk = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(str(cred.id, 400)).first();
      if (!pk) throw new Error('找不到這把通行金鑰，可能已經被移除');
      if (ch.purpose === 'stepup' && (!member || pk.member_id !== member.id || ch.member_id !== member.id)) throw new Error('這把通行金鑰不是你的');
      const r = await WebAuthn.verifyAssertion({ credential: cred, challenge: ch.challenge, origin: origin0, rpId, jwk: JSON.parse(pk.public_jwk), signCount: pk.sign_count });
      if (!r.uv) throw new Error('請用 Face ID、Touch ID 或裝置密碼確認');   // 登入與兩步驟都要「本人」確認，不只是「有人按了」
      await env.DB.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = datetime('now') WHERE id = ?").bind(r.signCount, pk.id).run();
      if (ch.purpose === 'stepup') {
        await env.DB.prepare("UPDATE sessions SET mfa_at = datetime('now') WHERE token_hash = ?").bind(member.s_th).run();
        await audit(env, req, member, 'mfa.verify', 'member', member.id, '通行金鑰');
        return json({ ok: true });
      }
      // 用通行金鑰登入：本身就是兩步驟（裝置＋生物辨識），工作階段直接標記已驗證
      const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(pk.member_id).first();
      if (!m) throw new Error('帳號不存在');
      await audit(env, req, m, 'login', 'member', m.id, '通行金鑰');
      await noteDevice(env, req, m, '通行金鑰');
      return json({ ok: true }, 200, { 'set-cookie': await startSession(env, m, req, { mfa: true }) });
    } catch (e) {
      await audit(env, req, member, 'passkey.denied', 'member', member?.id || null, str(e.message, 80));
      return fail(400, e.message || '通行金鑰驗證失敗');
    }
  }
  if (path === '/api/passkeys' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE member_id = ? ORDER BY created_at').bind(member.id).all()).results;
    return json({ passkeys: rows.map((r) => ({ ...r, id: r.id })), requireMfa: !!security.require_mfa });
  }
  const mpk = path.match(/^\/api\/passkeys\/([\w-]{8,400})$/);
  if (mpk && method === 'DELETE') {
    const g = need(); if (g) return g;
    const r = await env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND member_id = ?').bind(mpk[1], member.id).run();
    if (r.meta.changes) {
      // 記下金鑰 id 的前 64 字（公開的識別碼，不是金鑰本身）：還原備份或 Time Travel 後才能把這一把再刪一次（tools/restore-sql.mjs）
      await audit(env, req, member, 'passkey.remove', 'member', member.id, `id=${mpk[1].slice(0, 64)}`);
      await securityNotify(env, [member.id], { title: '移除了一把通行金鑰', body: `${deviceLabel(req.headers.get('user-agent') || '')} 移除了一把通行金鑰。不是你的話，請到「我的 → 帳號與安全」登出所有裝置。`, url: '/#/me/security' });
    }
    return json({ ok: true });
  }
  // 開關幹部兩步驟驗證：只有理事長；開啟前自己要有通行金鑰而且這次登入已經驗證過，避免把自己鎖在門外
  if (path === '/api/settings/security' && method === 'POST') {
    const g = need(); if (g) return g;
    if (norm(member.real_role || member.role) !== 'chair') return fail(403, '只有理事長可以設定');
    const su = await needStepUp(true); if (su) return su;
    const on = (await body()).require_mfa === true;
    if (on) {
      const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE member_id = ?').bind(member.id).first()).n;
      if (!n) return fail(400, '請先在「我的 → 帳號與安全」新增一把通行金鑰，再開啟');
      if (!member.s_mfa) return fail(400, '請先用通行金鑰驗證一次（「我的 → 帳號與安全 → 驗證一次」），確定可以用再開啟');
    }
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('security', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ require_mfa: on })).run();
    await audit(env, req, member, 'settings.security', 'settings', 'security', on ? '幹部強制兩步驟驗證：開啟' : '關閉');
    if (on && !security.require_mfa) await securityNotify(env, (await env.DB.prepare("SELECT id FROM members WHERE role != 'member' AND id != ?").bind(member.id).all()).results.map((r) => r.id),
      { title: '幹部需要兩步驟驗證', body: '理事長開啟了幹部兩步驟驗證。請到「我的 → 帳號與安全」新增通行金鑰，驗證後才有管理權限。', url: '/#/me/security' });
    return json({ ok: true });
  }
  // 稽核紀錄完整性檢查：重算每筆 HMAC 與每日摘要鏈
  if (path === '/api/audit/verify' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'audit')) return fail(403, '只有理事長與監事可以檢查');
    if (!env.AUDIT_KEY) return fail(503, '尚未設定 AUDIT_KEY');
    const u = new URL(req.url), to = isDate(u.searchParams.get('to') || '') ? u.searchParams.get('to') : today();
    const from = isDate(u.searchParams.get('from') || '') ? u.searchParams.get('from') : new Date(Date.parse(to) - 29 * 864e5).toISOString().slice(0, 10);
    if (Date.parse(to) - Date.parse(from) > 92 * 864e5) return fail(400, '一次最多檢查 92 天');
    // 逐筆重算 HMAC 很吃 CPU：一次最多 400 筆，超過就回 more.after（游標），前端（apiAll）接著送
    const [cAt, cId] = str(u.searchParams.get('after'), 60).split('|');
    const cur = cAt && cId ? [cAt, cAt, cId] : null;
    const rows = (await env.DB.prepare(`SELECT * FROM audit_log WHERE at >= ? AND at < ? ${cur ? 'AND (at > ? OR (at = ? AND id > ?))' : ''} ORDER BY at, id LIMIT 401`)
      .bind(from, `${to} 24`, ...(cur || [])).all()).results;
    const page = rows.slice(0, 400);
    let bad = 0, unsigned = 0; const badIds = [];
    for (const r of page) { if (!r.mac) { unsigned += 1; continue; } if ((await hmac(env, auditFields(r))) !== r.mac) { bad += 1; if (badIds.length < 20) badIds.push(r.id); } }
    // 每日摘要鏈只在第一段檢查：一句讀出區間內（含前一份，當作鏈的起點）的摘要、一句讀出區間內所有的 mac，在 JS 依日期分組
    let days, brokenDays = [];
    if (!cur) {
      const [dg, mac] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM audit_digests WHERE day >= COALESCE((SELECT MAX(day) FROM audit_digests WHERE day < ?1), ?1) AND day <= ?2 ORDER BY day').bind(from, to),
        env.DB.prepare('SELECT substr(at, 1, 10) AS day, mac FROM audit_log WHERE at >= ?1 AND at < ?2 AND mac IS NOT NULL ORDER BY at, id').bind(from, `${to} 24`),
      ]);
      const byDay = new Map();
      for (const r of mac.results) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r.mac); }
      const list = dg.results.filter((d) => d.day >= from);
      days = list.length;
      for (const d of list) {
        const i = dg.results.indexOf(d), prev = i > 0 ? dg.results[i - 1].digest : '';
        const macs = byDay.get(d.day) || [];
        if ((await hmac(env, `${prev}|${macs.join('|')}`)) !== d.digest || macs.length !== d.rows) brokenDays.push(d.day);
      }
    }
    const last = page[page.length - 1];
    await audit(env, req, member, 'audit.verify', 'audit', null, `${from}～${to}${cur ? '（續）' : ''}：${page.length} 筆，異常 ${bad}${cur ? '' : `，摘要異常 ${brokenDays.length} 天`}`);
    return json({ from, to, checked: page.length, unsigned, modified: bad, modifiedIds: badIds, ...(cur ? {} : { days, brokenDays }),
      ...(rows.length > 400 ? { more: { after: `${last.at}|${last.id}` } } : {}) });
  }

  // 分享連結的預覽：還沒登入的人點進來，先看到是什麼活動（私密分團的活動不顯示）
  const mpv = path.match(/^\/api\/public\/e\/([\w-]{1,32})$/);
  if (mpv && method === 'GET') {
    const e = await env.DB.prepare(`SELECT e.title, e.date, e.gather_time, e.place, e.kind, e.visibility, e.invite_token, e.signup_start, e.deadline, e.require_approval, e.signup_open, t.name AS team, t.private
      FROM events e LEFT JOIN teams t ON t.id = e.team_id WHERE e.id = ?`).bind(mpv[1]).first();
    // 邀請制：要帶正確的邀請代碼才看得到預覽
    const tok = str(url0(req).searchParams.get('t'), 40);
    const okInvite = e?.visibility === 'invite' && e.invite_token && tok === e.invite_token;
    if (!e || (e.visibility === 'invite' ? !okInvite : e.private)) return fail(404, '找不到這個活動');
    const { private: _, invite_token: _t, ...pub2 } = e;
    return json({ event: pub2 });
  }

  // 開啟 App：boot=1 時順便帶回首頁要用的活動與今天的訓練紀錄，少兩輪等待
  if (path === '/api/me' && method === 'GET') {
    const st = await getSettings(env, settingRows.filter((r) => ['org', 'features', 'docs', 'privacy', 'tabs', 'signup'].includes(r.key)));
    const boot = !!member && url0(req).searchParams.get('boot') === '1';
    // 這週一（臺北時間）到今天的紀錄：首頁「今天」卡片的擇一天課（週五或週六、週末）要看前幾天記過沒，不用再多等一輪
    const t0 = today(), monday = new Date(Date.parse(`${t0}T00:00:00Z`) - ((new Date(`${t0}T00:00:00Z`).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
    // 系統初始設定（CHAIR_CODE）：只有系統還沒有理事長時，「帳號與安全」才顯示那一格（一般跑友看不到無關的欄位）
    const bootstrapQ = member && norm(member.role) === 'member' && env.CHAIR_CODE
      ? env.DB.prepare("SELECT 1 FROM members WHERE role = 'chair' LIMIT 1").first().then((r) => !r) : false;
    const [race, teamList, events, weekLogs, planCycle, bootstrapOpen] = await Promise.all([
      countdownTarget(env, member, settingRows), member ? listTeams() : [],
      boot ? listEvents(false, [today(), new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10)]) : null,
      boot ? env.DB.prepare(`SELECT id, date, week_no, plan_day, cycle_anchor, cycle_week, kind, plan_text, status, km, seconds, hr, rpe, feel, note, source, 0 AS comments, 0 AS unread
        FROM training_logs WHERE member_id = ? AND date BETWEEN ? AND ? ORDER BY created_at`).bind(member.id, monday, t0).all().then((r) => r.results) : null,
      planCycleOf(member), bootstrapQ,
    ]);
    return json({ member: member ? pub(member) : null, bootstrapOpen, vapid: env.VAPID_PUBLIC_KEY || null, googleLogin: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      settings: st, privacyVersion: st.privacy.version, needConsent: !!member && member.consent_version !== st.privacy.version,
      race, planCycle, teams: teamList, calendarOn: !!member?.cal_token_hash, calScope: member?.cal_scope || 'all', requireMfa: !!security.require_mfa, shortcut: setting('health_shortcut') || null,
      homeSpot: member?.home_spot ? await env.DB.prepare("SELECT id, name, lat, lng FROM spots WHERE id = ? AND status = 'approved'").bind(member.home_spot).first() : null,
      ...(boot ? { boot: { events, todayLogs: weekLogs.filter((l) => l.date === t0), weekLogs: { from: monday, logs: weekLogs }, today: t0 } } : {}), serverNow: Date.now() });
  }

  // 已登入的人輸入幹部碼或理事長碼升級
  // 初始設定：系統裡還沒有理事長時，才能用 CHAIR_CODE 把自己設為理事長（只能用一次）。
  // 之後所有幹部身分一律由理事長在後台指派，不再有共用的幹部碼（A.5.18 存取權限）。
  if (path === '/api/me/admin' && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `bootstrap:${await ipHash(req, env)}`, 5, 900)) return fail(429, '嘗試太多次，請 15 分鐘後再試');
    const code = str((await body()).code, 80);
    const hasChair = await env.DB.prepare("SELECT 1 FROM members WHERE role = 'chair' LIMIT 1").first();
    // 設定碼比對：兩邊都去掉前後空白與換行（用 wrangler secret put 設定時可能多了換行）
    if (hasChair || !env.CHAIR_CODE || code !== env.CHAIR_CODE.trim()) {
      await audit(env, req, member, 'bootstrap.denied', 'member', member.id, hasChair ? '已有理事長' : '代碼錯誤');
      return fail(403, '幹部身分由理事長在後台指派');
    }
    await env.DB.prepare("UPDATE members SET role = 'chair' WHERE id = ?").bind(member.id).run();
    await audit(env, req, member, 'bootstrap.chair', 'member', member.id, '初始理事長');
    await revokeSessions(env, member.id);
    return json({ member: pub({ ...member, role: 'chair' }), relogin: true },
      200, { 'set-cookie': await startSession(env, { ...member, role: 'chair' }, req) });
  }

  if (path === '/api/join' && method === 'POST') {
    if (await limited(env, `join:${await ipHash(req, env)}`, 8, 600)) return fail(429, '嘗試太多次，請 10 分鐘後再試');
    const b = await body();
    const code = str(b.code, 80);
    // 邀請碼只能加入成為跑友；任何特權身分都要由理事長指派
    if (!env.JOIN_CODE || code !== env.JOIN_CODE.trim()) {
      await audit(env, req, null, 'join.denied', null, null, '邀請碼錯誤');
      return fail(403, '邀請碼不正確');
    }
    const role = 'member';
    if (b.consent !== true) return fail(400, '請先閱讀並同意隱私權政策');
    const name = str(b.name, 40);
    const dist = b.dist === 'hm' ? 'hm' : 'fm';
    const grp = (str(b.grp, 2) || (dist === 'hm' ? 'C' : 'D')).toUpperCase();
    if (!name) return fail(400, '請填姓名');
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    const id = rid(8);
    await env.DB.prepare("INSERT INTO members (id, name, dist, grp, role, consent_at, consent_version) VALUES (?, ?, ?, ?, ?, datetime('now'), ?)")
      .bind(id, name, dist, grp, role, (await getSettings(env)).privacy.version).run();
    const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
    await audit(env, req, m, 'account.create', 'member', id, '邀請碼');
    await noteDevice(env, req, m, '邀請碼');
    return json({ member: pub(m) }, 200, { 'set-cookie': await startSession(env, m, req) });
  }

  if (path === '/api/me' && method === 'PUT') {
    const g = need(); if (g) return g;
    const b = await body();
    // 只改有送來的欄位：沒送的維持原值（不會把暱稱、電話清掉，也不會把半馬改成全馬）；其他欄位（年齡、體重…）一律不收
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const name = str(b.name, 40) || member.name;
    const dist = has('dist') ? (b.dist === 'hm' ? 'hm' : 'fm') : member.dist;
    const grp = (str(b.grp, 2) || member.grp).toUpperCase();
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    // 所屬跑團跟著主團（由管理員設定），本人不能改
    const extra = { nickname: has('nickname') ? str(b.nickname, 20) : member.nickname, meal_pref: has('meal_pref') ? str(b.meal_pref, 10) : member.meal_pref,
      phone: has('phone') ? str(b.phone, 20) : member.phone,
      home_spot: !has('home_spot') ? member.home_spot : /^[\w-]{1,32}$/.test(b.home_spot || '') && await env.DB.prepare("SELECT 1 FROM spots WHERE id = ? AND status = 'approved'").bind(b.home_spot).first() ? b.home_spot : null };
    await env.DB.prepare('UPDATE members SET name = ?, dist = ?, grp = ?, nickname = ?, meal_pref = ?, phone = ?, home_spot = ? WHERE id = ?')
      .bind(name, dist, grp, extra.nickname, extra.meal_pref, extra.phone, extra.home_spot, member.id).run();
    return json({ member: pub({ ...member, name, dist, grp, ...extra }) });
  }

  // 課表設定：項目、組別、課表週期（只改有送來的欄位；不碰暱稱、電話等個人資料）
  if (path === '/api/me/plan' && method === 'PUT') {
    const g = need(); if (g) return g;
    if (await limited(env, `plan:${member.id}`, 60, 3600)) return fail(429, '改太頻繁，請稍後再試');
    const b = await body(), has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    let dist = member.dist, grp = member.grp;
    if (has('dist')) { if (b.dist !== 'fm' && b.dist !== 'hm') return fail(400, '項目只能是全馬或半馬'); dist = b.dist; }
    if (has('grp')) grp = str(b.grp, 2).toUpperCase();
    else if (dist !== member.dist && !validGroup(dist, grp)) grp = dist === 'hm' ? 'C' : 'D';
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    let cycle = member.plan_cycle === 'race' ? 'race' : 'club', raceId = member.plan_race_id || null, note;
    if (has('cycle')) {
      if (b.cycle === 'club') { cycle = 'club'; raceId = null; }
      else if (b.cycle === 'race') {
        if (!featOnServer('plan_cycle')) return fail(403, '目前沒有開放個人週期');
        const r = await env.DB.prepare('SELECT id, date FROM races WHERE id = ? AND member_id = ?').bind(str(b.race_id, 32), member.id).first();
        if (!r) return fail(404, '找不到這場比賽');
        const max = new Date(Date.parse(today()) + 400 * 864e5).toISOString().slice(0, 10);
        if (!isDate(r.date) || r.date < today() || r.date > max) return fail(400, '請選今天以後、一年內的比賽');
        if (r.date === RACE_ISO) { cycle = 'club'; raceId = null; note = 'same_as_club'; }
        else { cycle = 'race'; raceId = r.id; }
      } else return fail(400, '課表週期不正確');
    }
    await env.DB.prepare('UPDATE members SET dist = ?, grp = ?, plan_cycle = ?, plan_race_id = ? WHERE id = ?').bind(dist, grp, cycle, raceId, member.id).run();
    const m2 = { ...member, dist, grp, plan_cycle: cycle, plan_race_id: raceId };
    // 稽核只記週期真的有變（同樣的值重送不寫）
    if (has('cycle') && (cycle !== (member.plan_cycle === 'race' ? 'race' : 'club') || raceId !== (member.plan_race_id || null))) await audit(env, req, member, 'plan.cycle', 'member', member.id, cycle);
    return json({ member: pub(m2), planCycle: await planCycleOf(m2), ...(note ? { note } : {}) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = tokenOf(req);
    if ((await body()).all && member) {
      await revokeSessions(env, member.id);
      // 推播訂閱一起刪掉：被拿走的裝置不再收到任何推播（這則通知也只留在通知中心）
      await env.DB.prepare('DELETE FROM push_subs WHERE member_id = ?').bind(member.id).run();
      // 寫稽核：還原備份或 Time Travel 會把撤銷的登入與推播訂閱帶回來，還原工具靠這一列重做（tools/restore-sql.mjs）
      await audit(env, req, member, 'session.revoke_all', 'member', member.id, deviceLabel(req.headers.get('user-agent') || ''));
      await securityNotify(env, [member.id], { title: '已登出所有裝置', body: `${deviceLabel(req.headers.get('user-agent') || '')} 登出了你所有裝置上的工作階段。不是你的話，請盡快重新登入並檢查通行金鑰。`, url: '/#/me/security' });
    }
    else if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  // 活動列表：預設從今天起算，past=1 看過去的
  if (path === '/api/events' && method === 'GET') {
    const g = need(); if (g) return g;
    // 接下來：今天起 180 天內；過去：指定月份（month=YYYY-MM，預設這個月）
    const u = new URL(req.url), past = u.searchParams.get('past') === '1';
    const month = /^\d{4}-\d{2}$/.test(u.searchParams.get('month') || '') ? u.searchParams.get('month') : today().slice(0, 7);
    const range = past ? [`${month}-01`, `${month}-31`] : [today(), new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10)];
    return json({ events: await listEvents(past, range), serverNow: Date.now() });
  }

  if (path === '/api/events' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body(), e = readEvent(b);
    if (!e) return fail(400, '活動資料不完整');
    if (e.team_id && !(await teamIds()).includes(e.team_id)) return fail(400, '找不到這個分團');
    if (e.address) { const c = await postCheck(env, e.address); if (!c.ok) return fail(...postFail(c)); e.address = c.address; e.address_zip = c.zip; }
    if (!teamCan(e.team_id, 'event')) return fail(403, e.team_id ? '只有這個分團的團長與幹部可以建立活動' : '只有幹部可以建立全協會活動');
    // 報名設定：沒帶的套用系統預設（只有審核與通知；報名期間只在表單依預設推算，舊版畫面與腳本建立的活動不會有意外的期間）
    const sd = { ...SIGNUP_DEFAULTS, ...(() => { try { return JSON.parse(setting('signup') || '{}'); } catch { return {}; } })() };
    e.require_approval ??= e.kind === 'survey' ? 0 : sd.approval ? 1 : 0;
    e.notify_signup ??= sd.notify ? 1 : 0;
    e.signup_start ??= null;
    { const err = windowError(e, { now: tpNow(), create: true }); if (err) return fail(400, err); }
    if (e.route_id && !(await env.DB.prepare('SELECT 1 FROM routes WHERE id = ? AND (shared = 1 OR created_by = ?)').bind(e.route_id, member.id).first())) return fail(400, '找不到這條路線');
    // 定期揪跑：每週選幾天、到哪一天為止，一次建立每一場（最多 60 場），可選擇遇到國定假日不開
    const rep = b.repeat && Array.isArray(b.repeat.weekdays) ? { days: [...new Set(b.repeat.weekdays.map(Number).filter((d) => d >= 0 && d <= 6))], until: str(b.repeat.until, 10), skip: b.repeat.skip_holidays === true } : null;
    let dates = [e.date];
    if (rep && rep.days.length) {
      if (!isDate(rep.until) || rep.until < e.date) return fail(400, '重複的結束日期不正確');
      const end = Math.min(Date.parse(`${rep.until}T00:00:00Z`), Date.parse(`${e.date}T00:00:00Z`) + 366 * 864e5);
      const off = rep.skip ? new Set((await env.DB.prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ? AND is_holiday = 1 AND name IS NOT NULL').bind(e.date, rep.until).all()).results.map((r) => r.date)) : new Set();
      dates = [];
      for (let t = Date.parse(`${e.date}T00:00:00Z`); t <= end && dates.length < 60; t += 864e5) {
        const d = new Date(t).toISOString().slice(0, 10);
        if (rep.days.includes(new Date(t).getUTCDay()) && !off.has(d)) dates.push(d);
      }
      if (!dates.length) return fail(400, '這段期間沒有符合的日期');
    }
    const series = dates.length > 1 ? rid(8) : null;
    // 報名期間：跟著每一場往後推（保持跟活動日的距離）；「立即開放」（開始時間已過或沒填）不位移
    const sh = (x, d) => (x ? shiftDays(x, daysBetween(e.date, d)) : x);
    const shStart = (d) => (e.signup_start && e.signup_start > tpNow() ? sh(e.signup_start, d) : e.signup_start);
    // 之後才開放：到了開始時間由排程推播一次（建立時有勾通知、不是定期揪跑）；其他情況直接標成已推播
    const openOwed = b.notify !== false && !!e.signup_start && e.signup_start > tpNow() && !series;
    const ids = dates.map(() => rid(8)), id = ids[0];
    // 每一場不同的欄位（id、日期、週次、截止、開始）放進 JSON，一句 INSERT … SELECT FROM json_each（句數跟場數無關）
    const dj = JSON.stringify(dates.map((d, i) => [ids[i], d, i ? null : e.week_no ?? null, sh(e.deadline, d) ?? null, shStart(d) ?? null]));
    await env.DB.prepare(`INSERT INTO events (id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, created_by, fee, guest_max, meal_options, link_url, link_label, team_id, questions, visibility, options, group_reg, items, pricing, pay_info, min_qty, series_id, spot_id, route_id, address, address_zip, signup_start, require_approval, notify_signup, open_notified_at)
      SELECT json_extract(value, '$[0]'), ?2, ?3, json_extract(value, '$[1]'), ?4, ?5, ?6, ?7, ?8, json_extract(value, '$[2]'), ?9, ?10, ?11, json_extract(value, '$[3]'), ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31,
        json_extract(value, '$[4]'), ?32, ?33, ${openOwed ? 'NULL' : "datetime('now')"} FROM json_each(?1)`)
      .bind(dj, e.kind, e.title, e.gather_time, e.end_time, e.place, e.lead, e.note, e.plan_text, e.capacity, e.signup_open, member.id, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label, e.team_id, e.questions, e.visibility, e.options, e.group_reg, e.items, e.pricing, e.pay_info, e.min_qty, series, e.spot_id, e.route_id, e.address, e.address_zip || null,
        e.require_approval, e.notify_signup).run();
    // 複製活動：沿用原活動的座位圖（獎項每年不同，不複製）
    const from = str(b.copy_from, 32);
    if (from) {
      const src = await evById(from);
      if (src && await canSee(src)) await env.DB.prepare('UPDATE events SET seat_layout = (SELECT seat_layout FROM events WHERE id = ?) WHERE id = ?').bind(from, id).run();
    }
    await audit(env, req, member, 'event.create', 'event', id, `${e.title}${e.team_id ? `（${e.team_id}）` : ''}${e.visibility === 'invite' ? '，邀請制' : ''}${from ? `，複製自 ${from}` : ''}${series ? `，定期 ${dates.length} 場` : ''}${e.require_approval ? '，需審核' : ''}${e.signup_start || e.deadline ? `，報名 ${e.signup_start || '即日起'}–${e.deadline || '活動開始'}` : ''}`);
    // 邀請制不廣播；之後邀請誰就通知誰
    let notified = 0;
    if (b.notify !== false && e.visibility !== 'invite') {
      const to = e.team_id ? await teamMemberIds(e.team_id, member.id) : await allMemberIds(env, member.id);
      notified = to.length;
      const opens = e.signup_start && e.signup_start > tpNow() ? `・${tpText(e.signup_start)} 開放報名` : '';
      await notify(env, to, 'event',
        { title: `${e.kind === 'survey' ? '新問卷' : series ? '定期揪跑' : '新活動'}：${e.title}`, body: `${series ? `${dates[0]} 起共 ${dates.length} 場${e.gather_time ? `，${e.gather_time} 集合` : ''}　${e.place || ''}` : `${e.date}${e.gather_time ? ` ${e.gather_time}` : ''}　${e.place || ''}`}${opens}`, url: `/#/e/${id}`, ref: `e:${id}` });
    }
    return json({ id, count: dates.length, series, notified, invite: e.visibility === 'invite' });
  }

  const m1 = path.match(/^\/api\/events\/([\w-]{1,32})$/);
  if (m1) {
    const g = need(); if (g) return g;
    const id = m1[1];
    const cur = await evById(id);
    if (!cur || !(await canSee(cur))) return fail(404, '找不到這個活動');
    if (method === 'GET') {
      const ev = await eventWithSignups(env, id);
      const mine = await env.DB.prepare('SELECT status, review, review_note, reviewed_at, created_at, answers, paid, attended_at, option, reg_consent_at, items, amount, amount_detail, pay_ref, pay_method, pay_reported_at, picked_at, paid_note, pick_code FROM signups WHERE event_id = ? AND member_id = ?').bind(id, member.id).first();
      const arr = await env.DB.prepare('SELECT arrived_at, pickup_note, status FROM events WHERE id = ?').bind(id).first();
      // 團購：每項已訂數量（算剩餘庫存與成團進度）
      const itemDefs = parseQ(ev.items), sold = {};
      if (itemDefs.length) for (const r of (await env.DB.prepare("SELECT items FROM signups WHERE event_id = ? AND status = 'in' AND items IS NOT NULL").bind(id).all()).results)
        for (const x of parseQ(r.items)) sold[x.id] = (sold[x.id] || 0) + x.qty;
      const regRow = ev.group_reg ? await env.DB.prepare('SELECT complete FROM member_private WHERE member_id = ?').bind(member.id).first() : null;
      const team = ev.team_id ? await env.DB.prepare('SELECT id, name, color FROM teams WHERE id = ?').bind(ev.team_id).first() : null;
      const manage = canManage(ev);
      const inv = ev.visibility === 'invite' && manage
        ? { count: (await env.DB.prepare('SELECT COUNT(*) AS n FROM event_invites WHERE event_id = ?').bind(id).first()).n,
            token: (await env.DB.prepare('SELECT invite_token FROM events WHERE id = ?').bind(id).first()).invite_token || null } : null;
      const attendTok = manage ? (await env.DB.prepare('SELECT attend_token FROM events WHERE id = ?').bind(id).first()).attend_token : null;
      return json({ ...ev, questions: parseQ(ev.questions), myAnswers: mine?.answers ? JSON.parse(mine.answers) : null,
        myPaid: mine?.paid || null, myAttended: mine?.attended_at || null, myOption: mine?.option || null, myRegConsent: !!mine?.reg_consent_at,
        myItems: parseQ(mine?.items), myAmount: mine?.amount ?? null, myLines: parseQ(mine?.amount_detail), myPayRef: mine?.pay_ref || null, myPayMethod: mine?.pay_method || null,
        myPayReported: mine?.pay_reported_at || null, myPicked: mine?.picked_at || null, myPaidNote: mine?.paid_note || null,
        arrived: arr?.arrived_at || null, pickupNote: arr?.pickup_note || null, myPickCode: arr?.arrived_at && mine?.status === 'in' ? mine.pick_code || null : null, cancelled: arr?.status === 'cancelled',
        items: itemDefs, pricing: parseQ(ev.pricing, null), payInfo: parseQ(ev.pay_info, null), sold, myMembership: member.membership,
        options: parseQ(ev.options), regProfile: ev.group_reg ? (regRow ? (regRow.complete ? 'ok' : 'incomplete') : 'none') : null,
        team, manage, checkin: teamCan(ev.team_id, 'checkin'), invite: inv, attendToken: attendTok,
        series: ev.series_id ? (await env.DB.prepare('SELECT id, date FROM events WHERE series_id = ? ORDER BY date LIMIT 80').bind(ev.series_id).all()).results : null,
        spot: ev.spot_id ? await env.DB.prepare("SELECT id, name, kind, lat, lng FROM spots WHERE id = ? AND status = 'approved'").bind(ev.spot_id).first() : null,
        route: ev.route_id ? await env.DB.prepare('SELECT id, name, distance, points FROM routes WHERE id = ?').bind(ev.route_id).first().then((r) => (r ? { ...r, points: parseQ(r.points) } : null)) : null,
        // 自己的報名狀態一律看 myStatus（待審核與未通過不在公開的 signups 裡）
        myStatus: !mine ? null : mine.status === 'cancel' ? (mine.review === 'rejected' ? 'rejected' : null) : mine.status,
        myReviewNote: mine?.status === 'cancel' && mine.review === 'rejected' ? mine.review_note || null : null,
        myReviewedAt: mine?.reviewed_at || null,
        myPosition: mine?.status === 'wait' ? await queuePos(env, id, member.id) : null,
        mySignedOn: mine && mine.status !== 'cancel' ? tpDate(new Date(`${mine.created_at.replace(' ', 'T')}Z`)) : null,   // 早鳥預覽用
        pendingCount: manage ? await pendingCount(env, id) : undefined,
        pendingGuests: manage && ev.kind === 'party' ? (await env.DB.prepare("SELECT COALESCE(SUM(guests), 0) AS n FROM signups WHERE event_id = ? AND status = 'pending'").bind(id).first()).n : undefined,
        serverNow: Date.now() });
    }
    if (method === 'PUT') {
      const b = await body();
      const e = readEvent(b);
      if (!e) return fail(400, '活動資料不完整');
      // 三態合併：舊版畫面沒帶這些欄位時保留原值，不會把設定清掉
      for (const k of ['signup_start', 'require_approval', 'notify_signup']) if (e[k] === undefined) e[k] = cur[k] ?? null;
      e.require_approval = e.kind === 'survey' ? 0 : e.require_approval ? 1 : 0;
      e.notify_signup = e.notify_signup ? 1 : 0;
      // 編輯時允許把截止改到過去（表單會先確認「儲存後立即截止」）
      { const err = windowError(e, { now: tpNow() }); if (err) return fail(400, err); }
      if (e.address && e.address === cur.address) e.address_zip = cur.address_zip;
      else if (e.address) { const c = await postCheck(env, e.address); if (!c.ok) return fail(...postFail(c)); e.address = c.address; e.address_zip = c.zip; }
      if (e.team_id && !(await teamIds()).includes(e.team_id)) return fail(400, '找不到這個分團');
      // 原本的分團與改過去的分團都要有權限
      if (!teamCan(cur.team_id, 'event') || !teamCan(e.team_id, 'event')) return fail(403, '沒有編輯這個活動的權限');
      if (e.route_id && e.route_id !== cur.route_id && !(await env.DB.prepare('SELECT 1 FROM routes WHERE id = ? AND (shared = 1 OR created_by = ?)').bind(e.route_id, member.id).first())) return fail(400, '找不到這條路線');
      // 關閉審核時還有待審核：要明確選「直接錄取」（前端確認後帶 pending_action: 'admit'）
      const closing = !!cur.require_approval && !e.require_approval;
      const pend = closing ? await pendingCount(env, id) : 0;
      if (pend && b.pending_action !== 'admit') return json({ error: `還有 ${pend} 筆待審核`, needPendingAction: true, pending: pend }, 409);
      if (pend && READONLY[norm(member.role)]) return fail(403, '監事不能審核報名');
      const reopen = b.reopen === true && cur.status === 'cancelled';
      await env.DB.prepare(`UPDATE events SET kind=?, title=?, date=?, gather_time=?, end_time=?, place=?, lead=?, note=?, week_no=?, plan_text=?, capacity=?, signup_open=?, deadline=?, fee=?, guest_max=?, meal_options=?, link_url=?, link_label=?, team_id=?, questions=?, visibility=?, options=?, group_reg=?, items=?, pricing=?, pay_info=?, min_qty=?, spot_id=?, route_id=?, address=?, address_zip=?, signup_start=?, require_approval=?, notify_signup=?${reopen ? ", status='open'" : ''} WHERE id = ?`)
        .bind(e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label, e.team_id, e.questions, e.visibility, e.options, e.group_reg, e.items, e.pricing, e.pay_info, e.min_qty, e.spot_id, e.route_id, e.address, e.address_zip || null,
          e.signup_start, e.require_approval, e.notify_signup, id).run();
      const ev = await evById(id);
      // 改期：重設活動提醒、天氣提醒、跑完接續的標記，新的日期會再提醒一次
      if (e.date !== cur.date || (e.gather_time || '') !== (cur.gather_time || ''))
        await env.DB.prepare('UPDATE events SET remind_day_at = NULL, remind_hour_at = NULL, wx_alert_at = NULL, followup_at = NULL WHERE id = ?').bind(id).run();
      // 關閉審核並直接錄取：所有待審核一次處理（句數跟人數無關，見 approveMany），依報名先後改成候補，再由 promote() 排進正取
      //   資格不符的留在待審核，回報給主辦（主辦之後仍可在統計頁核准或婉拒）
      let admitted = null;
      if (pend) {
        const pending = (await env.DB.prepare("SELECT id, member_id, name FROM signups WHERE event_id = ? AND status = 'pending' ORDER BY created_at, id").bind(id).all()).results;
        admitted = await approveMany(env, ev, member, pending, { note: '關閉審核自動錄取', reserve: 6 });
        const skipped = admitted.blocked.length + admitted.lost.length;
        admitted.skipped = skipped;
        await audit(env, req, member, 'event.signup_review', 'event', id, `關閉審核，自動錄取 ${admitted.in.length + admitted.wait.length}（正取 ${admitted.in.length}、候補 ${admitted.wait.length}）${skipped ? `、資格不符留在待審核 ${skipped}` : ''}`);
        await settleReviews(env, id);
      }
      // 名額變多或拿掉上限：遞補候補（名額變少不會讓任何人掉回候補）；人多時做不完的由每小時的 promoteSweep 接著遞補
      if (!admitted && (cur.capacity && (!e.capacity || e.capacity > cur.capacity))) await promote(env, ev, { manual: true, reserve: 4 });
      if (reopen) await audit(env, req, member, 'event.reopen', 'event', id, e.title);
      const changed = [
        cur.visibility !== e.visibility ? `改為${e.visibility === 'invite' ? '邀請制' : '公開'}` : '',
        !!cur.require_approval !== !!e.require_approval ? `審核 ${cur.require_approval ? '開→關' : '關→開'}` : '',
        (cur.signup_start || null) !== (e.signup_start || null) || (cur.deadline || null) !== (e.deadline || null) ? '報名期間' : '',
        !!cur.notify_signup !== !!e.notify_signup ? `通知報名者 ${e.notify_signup ? '開' : '關'}` : '',
        (cur.capacity || null) !== (e.capacity || null) ? `名額 ${cur.capacity || '不限'}→${e.capacity || '不限'}` : '',
        cur.date !== e.date || (cur.gather_time || '') !== (e.gather_time || '') ? '改期' : '',
        !!cur.signup_open !== !!e.signup_open ? `開放報名 ${e.signup_open ? '開' : '關'}` : '',
      ].filter(Boolean);
      await audit(env, req, member, 'event.update', 'event', id, `${e.title}${changed.length ? `（${changed.join('、')}）` : ''}`);
      return json({ ok: true, admitted: admitted ? { in: admitted.in.length, wait: admitted.wait.length, skipped: admitted.skipped } : null });
    }
    if (method === 'DELETE') {
      if (!teamCan(cur.team_id, 'event')) return fail(403, '沒有刪除這個活動的權限');
      // 定期揪跑：?series=after 連同之後的場次一起刪，已報名的人會收到通知
      const after = url0(req).searchParams.get('series') === 'after' && cur.series_id;
      //   通知對象和刪除放在同一個 batch：先查（刪除會連報名一起刪），再一句刪掉所有場次
      const where = after ? 'series_id = ?1 AND date >= ?2 AND team_id IS ?3' : 'id = ?1';
      const args = after ? [cur.series_id, cur.date, cur.team_id] : [id];
      const [w0, g0] = await env.DB.batch([
        env.DB.prepare(`SELECT DISTINCT member_id FROM signups WHERE status IN ('in','wait','pending') AND event_id IN (SELECT id FROM events WHERE ${where})`).bind(...args),
        env.DB.prepare(`DELETE FROM events WHERE ${where} RETURNING id, date`).bind(...args),
      ]);
      const who = w0.results.map((r) => r.member_id).filter((x) => x !== member.id);
      const gone = g0.results.sort((a, c) => a.date.localeCompare(c.date));
      if (!gone.length) gone.push({ id, date: cur.date });
      if (who.length) await notify(env, who, 'change', { kind: 'event', title: `活動取消：${cur.title}`, body: gone.length > 1 ? `${gone[0].date} 起 ${gone.length} 場取消` : `${cur.date} 這場取消`, url: '/#/', ref: `e:${id}`, tag: `notice-${id}` });
      await audit(env, req, member, 'event.delete', 'event', id, `${cur.title}${gone.length > 1 ? `（連同之後 ${gone.length} 場）` : ''}`);
      return json({ ok: true, count: gone.length });
    }
  }

  const m2 = path.match(/^\/api\/events\/([\w-]{1,32})\/signup$/);
  if (m2) {
    const g = need(); if (g) return g;
    const ev = await evById(m2[1]);
    if (!ev || !(await canSee(ev))) return fail(404, '找不到這個活動');
    if ((method === 'POST' || method === 'DELETE') && await limited(env, `signup:${member.id}`, 30, 600)) return fail(429, '操作太頻繁，請稍後再試');
    if (method === 'POST') return doSignup(env, ev, member, await body(), { manager: canManage(ev) && !READONLY[norm(member.role)], req });
    if (method === 'DELETE') return cancelSignup(env, ev, member);
  }

  // ---- 邀請制活動：受邀名單、邀請連結 ----
  const minv = path.match(/^\/api\/events\/([\w-]{1,32})\/(invites|invite-link|accept)(?:\/([\w-]{1,32}))?$/);
  if (minv) {
    const g = need(); if (g) return g;
    const ev = await evById(minv[1]);
    if (!ev) return fail(404, '找不到這個活動');
    const kind = minv[2];
    // 用邀請連結加入：代碼對了就把自己加進受邀名單
    if (kind === 'accept' && method === 'POST') {
      if (await limited(env, `accept:${member.id}`, 20, 600)) return fail(429, '嘗試太多次，請稍後再試');
      const row = await env.DB.prepare('SELECT invite_token FROM events WHERE id = ?').bind(ev.id).first();
      const t = str((await body()).t, 40);
      if (ev.visibility !== 'invite') return json({ ok: true });
      if (!row?.invite_token || t !== row.invite_token) {
        await audit(env, req, member, 'event.invite_denied', 'event', ev.id, '邀請連結無效');
        return fail(404, '邀請連結已失效，請向主辦人索取新的連結');
      }
      const r = await env.DB.prepare("INSERT OR IGNORE INTO event_invites (event_id, member_id, via) VALUES (?, ?, 'link')").bind(ev.id, member.id).run();
      if (r.meta.changes) await audit(env, req, member, 'event.invite_accept', 'event', ev.id, ev.title);
      return json({ ok: true });
    }
    if (!canManage(ev)) return fail(403, '只有這個活動的主辦幹部可以管理邀請');
    if (kind === 'invites' && method === 'GET') {
      const rows = (await env.DB.prepare(
        `SELECT m.id, m.name, m.nickname, m.avatar, i.via, i.created_at, s.status
         FROM event_invites i JOIN members m ON m.id = i.member_id
         LEFT JOIN signups s ON s.event_id = i.event_id AND s.member_id = i.member_id
         WHERE i.event_id = ? ORDER BY s.status = 'in' DESC, m.name LIMIT 1000`).bind(ev.id).all()).results;
      return json({ invites: rows });
    }
    if (kind === 'invites' && method === 'POST') {
      const b = await body();
      let ids = Array.isArray(b.member_ids) ? b.member_ids.map((x) => str(x, 32)).filter(Boolean).slice(0, 300) : [];
      let via = 'manual';
      const tid = str(b.team_id, 16);
      if (tid) {
        // 整個分團：要看得到那個分團名冊的人才能這樣邀
        if (!teamCan(tid, 'roster')) return fail(403, '沒有這個分團的名冊權限');
        ids = await teamMemberIds(tid);
        via = 'team';
      }
      if (!ids.length) return fail(400, '沒有要邀請的人');
      // 名單比對、既有邀請檢查、寫入一句完成（json_each；以前用 IN() 綁到 300 個參數，超過 D1 的 100 個上限）
      const fresh = (await env.DB.prepare(`INSERT OR IGNORE INTO event_invites (event_id, member_id, invited_by, via)
        SELECT ?1, m.id, ?2, ?3 FROM json_each(?4) j JOIN members m ON m.id = j.value
        WHERE NOT EXISTS (SELECT 1 FROM event_invites i WHERE i.event_id = ?1 AND i.member_id = m.id) RETURNING member_id`)
        .bind(ev.id, member.id, via, JSON.stringify([...new Set(ids)])).all()).results.map((r) => r.member_id);
      if (fresh.length) {
        await audit(env, req, member, 'event.invite', 'event', ev.id, `${fresh.length} 人${tid ? `（分團 ${tid}）` : ''}`);
        if (b.notify !== false) await notify(env, fresh, 'event', { title: `你受邀參加：${ev.title}`, body: `${ev.date}${ev.gather_time ? ` ${ev.gather_time}` : ''}　${ev.place || ''}`, url: `/#/e/${ev.id}`, ref: `e:${ev.id}` });
      }
      return json({ added: fresh.length });
    }
    if (kind === 'invites' && method === 'DELETE' && minv[3]) {
      // 取消邀請：一併取消報名與入場券，避免還能入場；空出的正取名額由候補遞補
      const was = (await env.DB.prepare('SELECT status FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, minv[3]).first())?.status;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM event_invites WHERE event_id = ? AND member_id = ?').bind(ev.id, minv[3]),
        env.DB.prepare("UPDATE signups SET status = 'cancel', reg_consent_at = NULL WHERE event_id = ? AND member_id = ?").bind(ev.id, minv[3]),
        env.DB.prepare('DELETE FROM tickets WHERE event_id = ? AND member_id = ?').bind(ev.id, minv[3]),
      ]);
      if (was === 'in') await promote(env, await evById(ev.id));
      if (was === 'pending') await settleReviews(env, ev.id);
      await audit(env, req, member, 'event.uninvite', 'member', minv[3], ev.title);
      return json({ ok: true });
    }
    if (kind === 'invite-link' && method === 'POST') {
      const on = (await body()).on !== false;
      const token = on ? rid(12) : null;   // 每次開啟都換新代碼，舊連結立即失效
      await env.DB.prepare('UPDATE events SET invite_token = ? WHERE id = ?').bind(token, ev.id).run();
      await audit(env, req, member, 'event.invite_link', 'event', ev.id, on ? '開啟／重新產生' : '關閉');
      return json({ token });
    }
  }

  // ---- 賽事報名資料（本人）----
  // 地址核對（表單即時檢查用，存檔時伺服器還會再查一次）
  if (path === '/api/address/check' && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `addr:${member.id}`, 40, 600)) return fail(429, '查詢太多次，請稍後再試');
    const c = await postCheck(env, str((await body()).address, 160));
    return c.ok ? json({ ok: true, address: c.address || '', zip: c.zip || '', notServed: !!c.notServed }) : fail(...postFail(c));
  }
  if (path === '/api/me/race-profile') {
    const g = need(); if (g) return g;
    if (!env.RACE_KEY) return fail(503, '賽事報名資料功能還沒啟用，請聯絡行政人員');
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT enc, complete, updated_at FROM member_private WHERE member_id = ?').bind(member.id).first();
      return json({ fields: Object.fromEntries(Object.entries(RACE_FIELDS).map(([k, [label, max, req]]) => [k, { label, max, req }])),
        profile: row ? splitIdNo(await openPrivate(env, row.enc, member.id)) : null, complete: !!row?.complete, updated_at: row?.updated_at || null });
    }
    if (method === 'PUT') {
      const b = await body(), p = {};
      for (const [k, [, max]] of Object.entries(RACE_FIELDS)) p[k] = str(b[k], max);
      p.id_no = p.id_no.toUpperCase().replace(/\s/g, '');
      p.passport_no = p.passport_no.toUpperCase().replace(/\s/g, '');
      if (p.birthday && !isDate(p.birthday)) return fail(400, '生日格式不正確');
      if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return fail(400, 'Email 格式不正確');
      if (p.id_no && !twIdOk(p.id_no)) return fail(400, '身分證字號（或居留證號）不正確，請再核對一次');
      if (p.passport_no && !/^[A-Z0-9]{6,12}$/.test(p.passport_no)) return fail(400, '護照號碼格式不正確（英文字母與數字 6–12 碼）');
      if (p.gender && !['男', '女', '其他'].includes(p.gender)) return fail(400, '性別請選 男、女 或 其他');
      // 通訊地址：送中華郵政核對，存郵局的寫法與 6 碼郵遞區號（沒改就不再送）
      if (p.address) {
        const old = await env.DB.prepare('SELECT enc FROM member_private WHERE member_id = ?').bind(member.id).first().then((r) => (r ? openPrivate(env, r.enc, member.id) : null)).catch(() => null);
        if (old?.address === p.address && old.address_zip) p.address_zip = old.address_zip;
        else { const c = await postCheck(env, p.address); if (!c.ok) return fail(...postFail(c)); p.address = c.address; p.address_zip = c.zip; }
      }
      // 身分證字號（或居留證號）與護照號碼至少要有一個
      const complete = Object.entries(RACE_FIELDS).every(([k, [, , req]]) => !req || p[k]) && (p.id_no || p.passport_no) ? 1 : 0;
      await env.DB.prepare(`INSERT INTO member_private (member_id, enc, complete, updated_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(member_id) DO UPDATE SET enc = excluded.enc, complete = excluded.complete, updated_at = excluded.updated_at`)
        .bind(member.id, await sealPrivate(env, p, member.id), complete).run();
      await audit(env, req, member, 'privacy.race_profile', 'member', member.id, complete ? '更新（完整）' : '更新（未完整）');
      return json({ ok: true, complete: !!complete });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM member_private WHERE member_id = ?').bind(member.id).run();
      await env.DB.prepare('UPDATE signups SET reg_consent_at = NULL WHERE member_id = ?').bind(member.id).run();
      await audit(env, req, member, 'privacy.race_profile_delete', 'member', member.id, '');
      return json({ ok: true });
    }
  }
  // 代為團體報名：主辦幹部下載有同意的人的報名資料（解密後產生 CSV；寫稽核）
  const mreg = path.match(/^\/api\/events\/([\w-]{1,32})\/registrations\.csv$/);
  if (mreg && method === 'GET') {
    const g = need(); if (g) return g;
    const ev = await evById(mreg[1]);
    if (!ev || !ev.group_reg) return fail(404, '這個活動沒有代為團體報名');
    if (!canManage(ev) || READONLY[norm(member.role)]) return fail(403, '只有這個活動的主辦幹部可以下載');
    { const su = await needStepUp(true); if (su) return su; }   // 含身分證字號：一律要通行金鑰驗證
    const rows = (await env.DB.prepare(`SELECT s.member_id, s.name, s.option, s.status, s.paid, s.created_at, p.enc FROM signups s
      JOIN member_private p ON p.member_id = s.member_id WHERE s.event_id = ? AND s.status = 'in' AND s.reg_consent_at IS NOT NULL ORDER BY s.created_at`).bind(ev.id).all()).results;
    const cell = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return `"${x.replace(/"/g, '""')}"`; };
    // 通訊地址前面加郵遞區號（中華郵政核對過的 6 碼）
    const keys = Object.keys(RACE_FIELDS).flatMap((k) => (k === 'address' ? ['address_zip', 'address'] : [k]));
    const head = ['報名組別', ...keys.map((k) => (k === 'address_zip' ? '郵遞區號' : RACE_FIELDS[k][0])), '繳費', '報名時間'];
    const PAID = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
    const lines = [];
    for (const r of rows) { const p = splitIdNo(await openPrivate(env, r.enc, r.member_id)); lines.push([r.option || '', ...keys.map((k) => p[k] || ''), PAID[r.paid] || '', r.created_at].map(cell).join(',')); }
    await audit(env, req, member, 'event.reg_export', 'event', ev.id, `${rows.length} 筆（含身分證字號）`);
    return new Response(`﻿${[head.map(cell).join(','), ...lines].join('\r\n')}`, { headers: { ...SEC_HEADERS, 'cache-control': 'no-store',
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="registrations.csv"; filename*=UTF-8''${encodeURIComponent(`${ev.date}-${ev.title}-團體報名.csv`)}` } });
  }
  // ---- 活動營運：繳費、點名、自助報到、整批匯入 ----
  const mops = path.match(/^\/api\/events\/([\w-]{1,32})\/(payments|attendance|attend|attend-token|bulk|pay-report|pickup|arrived|notice|reconcile|review)$/);
  if (mops && method === 'POST') {
    const g = need(); if (g) return g;
    const ev = await evById(mops[1]);
    if (!ev || !(await canSee(ev))) return fail(404, '找不到這個活動');
    const op = mops[2], b = await body();
    // 現場自助報到：掃主辦人手機上的 QR（帶代碼），活動當天前後一天內有效
    if (op === 'attend') {
      if (await limited(env, `attend:${member.id}`, 20, 600)) return fail(429, '嘗試太多次，請稍後再試');
      const row = await env.DB.prepare('SELECT attend_token FROM events WHERE id = ?').bind(ev.id).first();
      if (!row?.attend_token || str(b.t, 40) !== row.attend_token) return fail(400, '報到 QR 已失效，請主辦人重新出示');
      if (Math.abs(Date.parse(ev.date) - Date.parse(tpDate(new Date()))) > 864e5) return fail(400, '只能在活動當天報到');
      const mine = await env.DB.prepare('SELECT id, status, review FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
      // 被婉拒的人任何活動都不能自助報到；需要審核的活動只有正取與候補可以（其他人請現場幹部在統計頁核准）
      if (mine?.status === 'cancel' && mine.review === 'rejected') return fail(400, '主辦人未核准這筆報名，請洽現場幹部');
      if (mine?.status === 'pending') return fail(400, '你的報名還在等主辦核准，請洽現場幹部');
      if (ev.require_approval && (!mine || mine.status === 'cancel')) return fail(400, '這場要主辦核准才能參加，請洽現場幹部');
      if (mine) await env.DB.prepare("UPDATE signups SET status = 'in', attended_at = COALESCE(attended_at, datetime('now')) WHERE id = ?").bind(mine.id).run();
      else await env.DB.prepare("INSERT INTO signups (id, event_id, member_id, name, grp, dist, note, status, attended_at) VALUES (?, ?, ?, ?, ?, ?, '現場報到', 'in', datetime('now'))")
        .bind(rid(8), ev.id, member.id, member.name, member.grp, member.dist).run();
      return json({ ok: true, walkIn: !mine });
    }
    // 團員回報已繳費（轉帳後五碼或現金），等幹部確認；不串金流
    if (op === 'pay-report') {
      const mine = await env.DB.prepare('SELECT id, amount, paid, status FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
      if (mine?.status === 'pending') return fail(400, '審核通過後再繳費');
      if (mine?.status !== 'in') return fail(400, '你還沒有報名這個活動');
      if (!mine.amount) return fail(400, '這筆報名不用繳費');
      if (mine.paid === 'paid') return fail(400, '幹部已經確認收款了');
      if (b.cancel === true) {
        await env.DB.prepare('UPDATE signups SET pay_ref = NULL, pay_method = NULL, pay_reported_at = NULL WHERE id = ?').bind(mine.id).run();
        await settleTodo(env, `pay:${ev.id}:${member.id}`);
        return json({ ok: true });
      }
      const method = PAY_METHODS[b.method] ? b.method : 'transfer';
      const ref = str(b.ref, 20).replace(/\s/g, '');
      if (method === 'transfer' && !/^\d{4,6}$/.test(ref)) return fail(400, '請填轉帳帳號的後五碼');
      // 回報、取消、再回報會一直推播給幹部，同一場一小時最多 5 次
      if (await limited(env, `payrep:${member.id}:${ev.id}`, 5, 3600)) return fail(429, '操作太頻繁，請稍後再試');
      await env.DB.prepare("UPDATE signups SET pay_ref = ?, pay_method = ?, pay_reported_at = datetime('now') WHERE id = ?").bind(ref || null, method, mine.id).run();
      // 通知中心不放金額與後五碼；鎖定畫面不放人名
      const mgr = (await eventManagers(env, ev)).filter((x) => x !== member.id);
      await notify(env, mgr, 'todo', { kind: 'event', title: `${ev.title}：有人回報繳費`, body: `${member.nickname || member.name} 回報已繳費（${PAY_METHODS[method]}），請到統計確認`, url: `/#/e/${ev.id}/stats`,
        ref: `pay:${ev.id}:${member.id}`, push: { title: `${ev.title}：有 1 筆繳費回報`, body: '點開確認收款' } });
      return json({ ok: true });
    }
    if (!canManage(ev) && !(op === 'attendance' && teamCan(ev.team_id, 'checkin'))) return fail(403, '只有這個活動的幹部可以操作');
    // 報名審核：核准、婉拒（含移出正取與候補）、重新審核；只有這場的主辦幹部（canManage）可以
    //   所有查詢都限定這個活動，其他活動的 member_id 一律「找不到這筆報名」
    if (op === 'review') {
      if (READONLY[norm(member.role)]) return fail(403, '監事不能審核報名');
      // 婉拒與重新審核會送不能關的通知給團員：同一場每位幹部 10 分鐘最多 30 次
      if (await limited(env, `review:${member.id}:${ev.id}`, 30, 600)) return fail(429, '操作太頻繁，請稍後再試');
      const action = ['approve', 'reject', 'reopen'].includes(b.action) ? b.action : null;
      const ids = [...new Set((Array.isArray(b.member_ids) ? b.member_ids : []).map((x) => str(x, 32)).filter(Boolean))].slice(0, 200);
      if (!action || !ids.length) return fail(400, '審核資料不正確');
      const note = action === 'reject' ? str(b.note, 120) || null : null;
      const rows = (await env.DB.prepare(`SELECT id, member_id, name, status, review, paid, pay_reported_at, amount, created_at FROM signups
        WHERE event_id = ? AND member_id IN (SELECT value FROM json_each(?))`).bind(ev.id, JSON.stringify(ids)).all()).results
        .sort((a, c) => (a.created_at < c.created_at ? -1 : a.created_at > c.created_at ? 1 : a.id < c.id ? -1 : 1));
      const out = { in: [], wait: [], rejected: [], reopened: [], skipped: [], notes: [], refund: [] };
      // 所有人一起處理（免費方案一次執行 50 個子請求）：每一步都是一句處理所有人（json_each），句數跟人數無關，
      //   一次最多 200 人。萬一這次請求的額度已經不夠（核准約 30、婉拒約 20、重新審核約 10），全部放進 more，前端（apiAll）再送一次
      const NEED = { approve: 30, reject: 22, reopen: 10 }[action];
      if (!env.budget.room(NEED)) { env.budget.stop('review:more'); return json({ ...out, more: { member_ids: ids } }); }
      const skip = (r, reason) => out.skipped.push({ member_id: r.member_id, name: r.name || '', reason });
      for (const mid of ids) if (!rows.some((r) => r.member_id === mid)) skip({ member_id: mid }, '找不到這筆報名');
      const base = { ref: `e:${ev.id}`, tag: `signup-${ev.id}`, url: `/#/e/${ev.id}` };
      let revoked = 0;
      if (action === 'approve') {
        const todo = [];
        for (const r of rows) {
          if (r.status !== 'pending') { skip(r, (r.status === 'in' || r.status === 'wait') && r.review === 'approved' ? '這筆已被處理' : '目前狀態不能這樣處理'); continue; }
          todo.push(r);
        }
        if (todo.length) {
          const res = await approveMany(env, ev, member, todo, { reserve: 6 });
          for (const x of res.blocked) skip(x, x.reason);
          for (const x of res.lost) skip(x, '這筆已被處理');
          out.in = res.in.map(({ member_id, name }) => ({ member_id, name }));
          out.wait = res.wait.map(({ member_id, name, position }) => ({ member_id, name, position }));
          out.notes = res.notes;
        }
      } else if (action === 'reject') {
        const live = rows.filter((r) => ['pending', 'in', 'wait'].includes(r.status));
        for (const r of rows.filter((x) => !live.includes(x))) skip(r, r.review === 'rejected' ? '這筆已被處理' : '目前狀態不能這樣處理');
        const listed = live.filter((r) => r.status !== 'pending');
        // 已經在名單上的（正取或候補）要明確確認「移出」
        if (listed.length && b.revoke !== true)
          return json({ error: '這些人已經在名單上，要確認移出', needRevoke: true, count: listed.length, paid: listed.filter((r) => r.paid === 'paid').length }, 409);
        // 一句改完所有人（每人比對自己原本的狀態，兩句之間被別人處理掉的不會改到）
        const upd = live.length ? new Set((await env.DB.prepare(`UPDATE signups SET status = 'cancel', review = 'rejected', reviewed_by = ?1, reviewed_at = datetime('now'), review_note = ?2, reg_consent_at = NULL,
            paid_note = CASE WHEN paid = 'paid' THEN '婉拒，待退費' ELSE paid_note END
          WHERE event_id = ?3 AND (id || ':' || status) IN (SELECT value FROM json_each(?4)) RETURNING id`)
          .bind(member.id, note, ev.id, JSON.stringify(live.map((r) => `${r.id}:${r.status}`))).all()).results.map((x) => x.id)) : new Set();
        const gone = live.filter((r) => upd.has(r.id));
        for (const r of live.filter((x) => !upd.has(x.id))) skip(r, '這筆已被處理');
        const notes = [];
        for (const r of gone) {
          const paid = r.paid === 'paid';
          if (paid) out.refund.push(r.name);
          out.rejected.push({ member_id: r.member_id, name: r.name, was: r.status });
          // 原因只放通知中心內文；鎖定畫面用通用文字
          if (r.status === 'pending') notes.push({ ...base, member_id: r.member_id, title: `未通過審核：${ev.title}`,
            body: note ? `主辦婉拒了這筆報名：${note}` : '主辦婉拒了這筆報名，有疑問請聯絡主辦人', push: { body: '請到活動頁查看說明' } });
          else { revoked++; notes.push({ ...base, member_id: r.member_id, title: `已被移出名單：${ev.title}`,
            body: `主辦把你移出了名單${note ? `：${note}` : ''}${paid ? '。已繳費用由主辦處理退費' : ''}`, push: { body: '請到活動頁查看說明' } }); }
        }
        if (gone.length) {
          // 入場券一句刪完；每位一列稽核（對象是會員，只記活動標題，不記原因），一句寫完
          await env.DB.batch([env.DB.prepare('DELETE FROM tickets WHERE event_id = ?1 AND member_id IN (SELECT value FROM json_each(?2))').bind(ev.id, JSON.stringify(gone.map((r) => r.member_id))),
            await auditManyStmt(env, req, member, 'event.signup_reject', 'member', gone.map((r) => [r.member_id, ev.title]))]);
          await notifyMany(env, 'change', notes, { kind: 'signup' });
        }
        if (gone.some((r) => r.status === 'in')) await promote(env, ev, { reserve: 6 });
      } else {
        const todo = [];
        for (const r of rows) {
          if (!(r.status === 'cancel' && r.review === 'rejected')) { skip(r, r.status === 'pending' ? '這筆已被處理' : '目前狀態不能這樣處理'); continue; }
          if (!ev.require_approval) { skip(r, '這場沒有開啟審核，請改用代為報名'); continue; }
          todo.push(r);
        }
        // 重新審核：保留原本的 created_at（排隊順序不變）
        const upd = todo.length ? new Set((await env.DB.prepare(`UPDATE signups SET status = 'pending', review = NULL, review_note = NULL, reviewed_by = ?1, reviewed_at = datetime('now')
          WHERE event_id = ?2 AND status = 'cancel' AND review = 'rejected' AND id IN (SELECT value FROM json_each(?3)) RETURNING id`)
          .bind(member.id, ev.id, JSON.stringify(todo.map((r) => r.id))).all()).results.map((x) => x.id)) : new Set();
        for (const r of todo) {
          if (!upd.has(r.id)) { skip(r, '這筆已被處理'); continue; }
          out.reopened.push({ member_id: r.member_id, name: r.name });
        }
        if (out.reopened.length) {
          await notify(env, out.reopened.map((x) => x.member_id), 'change', { kind: 'signup', ...base, title: `你的報名重新進入審核：${ev.title}`, body: '主辦會再通知你結果' });
          await alertReviewers(env, ev, member.id);
        }
      }
      const nRej = out.rejected.length - revoked;
      await audit(env, req, member, 'event.signup_review', 'event', ev.id,
        `核准 ${out.in.length + out.wait.length}（正取 ${out.in.length}、候補 ${out.wait.length}）、婉拒 ${nRej}、移出 ${revoked}、重新審核 ${out.reopened.length}、略過 ${out.skipped.length}`);
      await settleReviews(env, ev.id);
      const signed = await countIn(env, ev.id);
      return json({ ...out, seatsLeft: ev.capacity ? Math.max(0, ev.capacity - signed) : null, pending: await pendingCount(env, ev.id) });
    }
    if (op === 'payments') {
      const PAID = ['unpaid', 'paid', 'waived', 'refunded'];
      const ids = Array.isArray(b.member_ids) ? b.member_ids.map((x) => str(x, 32)).filter(Boolean).slice(0, 500) : [];
      if (!ids.length || !PAID.includes(b.paid)) return fail(400, '繳費資料不正確');
      // 先記下原本的繳費狀態：只有真的改成已收款或已退費的人才通知
      const pj = JSON.stringify([...new Set(ids)]);
      const before = (await env.DB.prepare(`SELECT member_id, paid, amount FROM signups WHERE event_id = ? AND status != 'pending' AND member_id IN (SELECT value FROM json_each(?))`).bind(ev.id, pj).all()).results;
      // 標記已退費時，把取消／婉拒留下的「待退費」備註清掉；所有人一句
      await env.DB.prepare(`UPDATE signups SET paid = ?1,
        paid_note = COALESCE(?2, CASE WHEN ?1 = 'refunded' AND paid_note LIKE '%待退費' THEN NULL ELSE paid_note END),
        paid_at = CASE WHEN ?1 = 'paid' THEN datetime('now') ELSE paid_at END WHERE event_id = ?3 AND status != 'pending' AND member_id IN (SELECT value FROM json_each(?4))`)
        .bind(b.paid, str(b.note, 60) || null, ev.id, pj).run();
      await audit(env, req, member, 'event.payment', 'event', ev.id, `${ids.length} 人 → ${b.paid}`);
      if (b.paid !== 'unpaid') await settleTodo(env, ...ids.map((mid) => `pay:${ev.id}:${mid}`));
      // 每人金額不同：notifyMany 一次寫完（2 句）
      if (ev.notify_signup && (b.paid === 'paid' || b.paid === 'refunded'))
        await notifyMany(env, 'signup', before.filter((x) => x.paid !== b.paid && x.member_id !== member.id).map((r) => ({ member_id: r.member_id, ref: `e:${ev.id}`, tag: `signup-${ev.id}`, url: `/#/e/${ev.id}`,
          title: `${b.paid === 'paid' ? '已確認收款' : '已退費'}：${ev.title}`, body: `NT$${r.amount || 0}`, push: { body: '點開看繳費狀態' } })), { kind: 'signup' });   // 金額只放通知中心，鎖定畫面與推播佇列不放
      return json({ ok: true });
    }
    // 團購到貨：通知訂購的人來領，每個人一個領取 QR
    if (op === 'arrived') {
      const note = str(b.note, 120);
      const rows = (await env.DB.prepare("SELECT id, member_id, pick_code FROM signups WHERE event_id = ? AND status = 'in' AND items IS NOT NULL").bind(ev.id).all()).results;
      // 領取碼在 JS 產生、一句寫完（UPDATE … FROM json_each），和到貨標記同一個 batch
      const codes = rows.filter((r) => !r.pick_code).map((r) => [r.id, ticketCode()]);
      await env.DB.batch([
        ...(codes.length ? [env.DB.prepare(`UPDATE signups SET pick_code = json_extract(j.value, '$[1]') FROM json_each(?1) j
          WHERE signups.id = json_extract(j.value, '$[0]') AND signups.pick_code IS NULL`).bind(JSON.stringify(codes))] : []),
        env.DB.prepare("UPDATE events SET arrived_at = COALESCE(arrived_at, datetime('now')), pickup_note = ? WHERE id = ?").bind(note || null, ev.id),
      ]);
      const ids = rows.map((r) => r.member_id).filter(Boolean);
      if (ids.length) await notify(env, ids, 'signup', { kind: 'event', title: `到貨了：${ev.title}`, body: `${note || '請到活動頁看領取方式'}。領取時出示 App 裡的領取 QR。`, url: `/#/e/${ev.id}`, ref: `e:${ev.id}`, tag: `arrived-${ev.id}` });
      await audit(env, req, member, 'event.arrived', 'event', ev.id, `${ids.length} 人`);
      return json({ ok: true, count: ids.length });
    }
    // 活動異動：取消、改地點、改時間（可連日期）或其他，通知報名（含候補）的人；
    //   audience=all 時通知所有看得到這個活動的人（分團活動只通知該分團、邀請制只通知受邀的人），例如用外部表單登記的慶功宴
    if (op === 'notice') {
      const type = ['cancel', 'place', 'time', 'other'].includes(b.type) ? b.type : 'other', msg = str(b.message, 300);
      const place = str(b.place, 120), address = str(b.address, 120), time = isTime(str(b.gather_time, 5)) && str(b.gather_time, 5) ? str(b.gather_time, 5) : '';
      const date = isDate(str(b.date, 10)) ? str(b.date, 10) : '';
      if (type === 'place' && !place) return fail(400, '請填新的地點');
      let addrOk = { ok: true };
      if (type === 'place' && address) { addrOk = await postCheck(env, address); if (!addrOk.ok) return fail(...postFail(addrOk)); }
      if (type === 'time' && !time && !date) return fail(400, '請填新的日期或時間');
      if (type === 'other' && !msg) return fail(400, '請填異動內容');
      // 「其他」活動通知會推給所有報名的人而且不能關，每場每天最多 3 則
      if (type === 'other' && await limited(env, `notice-other:${ev.id}`, 3, 86400)) return fail(429, '同一個活動一天最多發 3 則活動通知');
      if (type === 'cancel') await env.DB.prepare("UPDATE events SET status = 'cancelled', signup_open = 0 WHERE id = ?").bind(ev.id).run();
      if (type === 'place') await env.DB.prepare('UPDATE events SET place = ?, address = ?, address_zip = ?, spot_id = ? WHERE id = ?').bind(place, addrOk.address || null, addrOk.zip || null, /^[\w-]{1,32}$/.test(b.spot_id || '') ? b.spot_id : null, ev.id).run();
      if (type === 'time') {
        // 報名期間跟著改期平移（與系列活動相同）；還沒到的開始時間才移，移完不合理就改成活動開始截止／立即開放
        const nx = { ...ev, date: date || ev.date, gather_time: time || ev.gather_time }, shift = daysBetween(ev.date, nx.date), nowTp = tpNow();
        if (shift && isStamp(ev.deadline)) nx.deadline = shiftDays(ev.deadline, shift);
        if (shift && isStamp(ev.signup_start) && ev.signup_start > nowTp) nx.signup_start = shiftDays(ev.signup_start, shift);
        if (nx.deadline && nx.deadline > evStart(nx)) nx.deadline = null;
        if (nx.signup_start && (nx.signup_start <= nowTp || nx.signup_start >= signupEnd(nx))) nx.signup_start = null;
        await env.DB.prepare('UPDATE events SET date = ?, gather_time = ?, deadline = ?, signup_start = ?, remind_hour_at = NULL, remind_day_at = NULL, wx_alert_at = NULL, followup_at = NULL WHERE id = ?')
          .bind(nx.date, nx.gather_time || null, nx.deadline || null, nx.signup_start || null, ev.id).run();
      }
      // 報名（含候補、待審核）的人歸「活動異動」（不能關推播）；audience=all 時其他人歸「活動與邀請」
      const ids = (await env.DB.prepare("SELECT member_id FROM signups WHERE event_id = ? AND status IN ('in', 'wait', 'pending') AND member_id IS NOT NULL").bind(ev.id).all()).results.map((r) => r.member_id).filter((x) => x !== member.id);
      let others = [];
      if (b.audience === 'all') {
        const all = ev.visibility === 'invite'
          ? (await env.DB.prepare('SELECT member_id FROM event_invites WHERE event_id = ?').bind(ev.id).all()).results.map((r) => r.member_id).filter((x) => x !== member.id)
          : ev.team_id ? await teamMemberIds(ev.team_id, member.id) : await allMemberIds(env, member.id);
        const mine = new Set(ids); others = all.filter((x) => !mine.has(x));
      }
      const TITLE = { cancel: '活動取消', place: '改地點', time: '改時間', other: '活動通知' };
      const when = `${date ? `${date.slice(5).replace('-', '/')}（${'日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()]}）` : ''}${time ? ` ${time}` : ''}`.trim();
      const body2 = type === 'cancel' ? `${ev.date} 這場取消${msg ? `：${msg}` : ''}` : type === 'place' ? `改到 ${place}${addrOk.address ? `（${addrOk.address}）` : ''}${msg ? `。${msg}` : ''}` : type === 'time' ? `改成 ${when}${msg ? `。${msg}` : ''}` : msg;
      const nmsg = { kind: 'event', title: `${TITLE[type]}：${ev.title}`, body: body2, url: `/#/e/${ev.id}`, ref: `e:${ev.id}`, tag: `notice-${ev.id}` };
      if (ids.length) await notify(env, ids, 'change', nmsg);
      if (others.length) await notify(env, others, 'event', nmsg);
      await settleTodo(env, `wx:${ev.id}`);
      await audit(env, req, member, 'event.notice', 'event', ev.id, `${TITLE[type]}：${body2}`.slice(0, 200));
      return json({ ok: true, count: ids.length + others.length });
    }
    // 銀行對帳：上傳的入帳明細（金額＋明細裡的數字），跟團員回報的後五碼與應繳金額比對，對上的標記已繳
    if (op === 'reconcile') {
      const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 2000).map((r) => ({ amount: Math.round(Number(r?.amount) || 0), refs: (Array.isArray(r?.refs) ? r.refs : []).map((x) => str(x, 12)).filter((x) => /^\d{4,6}$/.test(x)).slice(0, 10), date: str(r?.date, 10) }))
        .filter((r) => r.amount > 0 && r.refs.length);
      const due = (await env.DB.prepare("SELECT member_id, name, amount, pay_ref FROM signups WHERE event_id = ? AND status = 'in' AND paid NOT IN ('paid', 'waived', 'refunded') AND amount > 0").bind(ev.id).all()).results;
      const used = new Set(), matched = [];
      for (const s0 of due) {
        if (!s0.pay_ref) continue;
        const i = rows.findIndex((r, k) => !used.has(k) && r.amount === s0.amount && r.refs.some((x) => x.endsWith(s0.pay_ref) || s0.pay_ref.endsWith(x)));
        if (i < 0) continue;
        used.add(i); matched.push({ member_id: s0.member_id, name: s0.name, amount: s0.amount, date: rows[i].date });
      }
      if (matched.length && b.apply === true) {
        await env.DB.prepare(`UPDATE signups SET paid = 'paid', paid_at = datetime('now'), paid_note = json_extract(j.value, '$[1]') FROM json_each(?2) j
          WHERE signups.event_id = ?1 AND signups.member_id = json_extract(j.value, '$[0]')`).bind(ev.id, JSON.stringify(matched.map((m) => [m.member_id, `對帳 ${m.date || today()}`]))).run();
        await audit(env, req, member, 'event.reconcile', 'event', ev.id, `對上 ${matched.length} 筆`);
        await settleTodo(env, ...matched.map((m) => `pay:${ev.id}:${m.member_id}`));
      }
      return json({ matched, unmatchedRows: rows.filter((_, k) => !used.has(k)).length, unpaid: due.filter((d) => !matched.some((m) => m.member_id === d.member_id)).map((d) => ({ name: d.name, amount: d.amount, pay_ref: d.pay_ref })) });
    }
    // 團購到貨：記錄誰已經領取（點名或掃領取 QR）
    if (op === 'pickup') {
      if (b.code) {
        const r = await env.DB.prepare("SELECT member_id, name, items, picked_at, status FROM signups WHERE event_id = ? AND pick_code = ?").bind(ev.id, str(b.code, 12).toUpperCase()).first();
        if (!r) return fail(404, '找不到這個領取碼');
        if (r.status !== 'in') return fail(404, '這個領取碼已失效');            // 取消、婉拒、移出之後不能再領
        if (!r.picked_at) await env.DB.prepare("UPDATE signups SET picked_at = datetime('now') WHERE event_id = ? AND member_id = ? AND status = 'in'").bind(ev.id, r.member_id).run();
        return json({ ok: true, name: r.name, already: !!r.picked_at, items: parseQ(r.items) });
      }
      const mid = str(b.member_id, 32);
      await env.DB.prepare(`UPDATE signups SET picked_at = ${b.picked === false ? 'NULL' : "COALESCE(picked_at, datetime('now'))"} WHERE event_id = ? AND member_id = ? AND status = 'in'`).bind(ev.id, mid).run();
      return json({ ok: true });
    }
    if (op === 'attendance') {
      const mid = str(b.member_id, 32);
      await env.DB.prepare(`UPDATE signups SET attended_at = ${b.present === false ? 'NULL' : "COALESCE(attended_at, datetime('now'))"} WHERE event_id = ? AND member_id = ? AND status = 'in'`).bind(ev.id, mid).run();
      return json({ ok: true });
    }
    if (op === 'attend-token') {
      const token = b.on === false ? null : rid(10);
      await env.DB.prepare('UPDATE events SET attend_token = ? WHERE id = ?').bind(token, ev.id).run();
      await audit(env, req, member, 'event.attend_token', 'event', ev.id, token ? '開啟現場報到' : '關閉現場報到');
      return json({ token });
    }
    if (op === 'bulk') {
      // 貼上一欄姓名（從 Excel 複製）：完全符合姓名或暱稱、而且只有一位的才處理
      const names = [...new Set((Array.isArray(b.names) ? b.names : String(b.names || '').split(/[\n,，、\t]+/)).map((x) => str(x, 40)).filter(Boolean))].slice(0, 300);
      const action = b.action === 'invite' ? 'invite' : 'signup';
      if (!names.length) return fail(400, '請貼上姓名');
      const matched = [], ambiguous = [], unmatched = [], failed = [], rest = [];
      // 名字比對一句（json_each JOIN members）
      const hits = (await env.DB.prepare('SELECT j.value AS q_name, m.* FROM json_each(?) j JOIN members m ON m.name = j.value OR m.nickname = j.value').bind(JSON.stringify(names)).all()).results;
      const byName = new Map(), seen = new Set();
      for (const { q_name, ...m } of hits) { if (!byName.has(q_name)) byName.set(q_name, []); byName.get(q_name).push(m); }
      for (const n of names) {
        const rows = byName.get(n) || [];
        if (rows.length === 1) { if (!seen.has(rows[0].id)) { seen.add(rows[0].id); matched.push({ ...rows[0], q_name: n }); } } else (rows.length ? ambiguous : unmatched).push(n);
      }
      let added = 0, nIn = 0, nWait = 0;
      if (action === 'invite') {
        // 只通知這次真的新增邀請的人（原本就受邀的不再通知一次）；一句寫完
        const fresh = matched.length ? (await env.DB.prepare(`INSERT OR IGNORE INTO event_invites (event_id, member_id, invited_by, via)
          SELECT ?1, value, ?2, 'manual' FROM json_each(?3) RETURNING member_id`).bind(ev.id, member.id, JSON.stringify(matched.map((m) => m.id))).all()).results.map((r) => r.member_id) : [];
        added = fresh.length;
        if (fresh.length) await notify(env, fresh, 'event', { title: `你受邀參加：${ev.title}`, body: `${ev.date}${ev.gather_time ? ` ${ev.gather_time}` : ''}　${ev.place || ''}`, url: `/#/e/${ev.id}`, ref: `e:${ev.id}` });
      } else {
        // 只通知這次報名成功的人；原本就已報名（含候補）的不再通知，候補的人用候補文案
        const had = new Set((await env.DB.prepare(`SELECT member_id FROM signups WHERE event_id = ? AND status IN ('in','wait') AND member_id IN (SELECT value FROM json_each(?))`)
          .bind(ev.id, JSON.stringify(matched.map((m) => m.id))).all()).results.map((r) => r.member_id));
        const okIn = [], okWait = [];
        // 分段處理：代為報名要逐人走 doSignup（一人約 5–9 句），每人之前確認額度（用目前為止單人最高用量估），
        //   不夠就停，沒處理到的人放進 more.names，前端（apiAll）再送一次
        let per = 10;
        for (const m of matched) {
          if (rest.length || !env.budget.room(per + notifyCost(okIn.length + okWait.length + 1) + 4)) { rest.push(m.q_name); continue; }
          const s0 = env.budget.sub;
          if (ev.visibility === 'invite') await env.DB.prepare("INSERT OR IGNORE INTO event_invites (event_id, member_id, invited_by, via) VALUES (?, ?, ?, 'manual')").bind(ev.id, m.id, member.id).run();
          const r = await doSignup(env, ev, m, { note: '幹部代為報名' }, { by: member, req });
          if (!r.ok) { failed.push(`${m.name}（${(await r.json()).error}）`); continue; }
          added += 1;
          const st = (await r.json()).status;
          if (!had.has(m.id)) (st === 'wait' ? okWait : okIn).push(m.id);
          if (st === 'in') nIn++; else if (st === 'wait') nWait++;
          per = Math.max(per, env.budget.sub - s0 + 1);
        }
        if (okIn.length) await notify(env, okIn, 'signup', { title: `已幫你報名：${ev.title}`, body: '如果不能參加，請到活動頁取消', url: `/#/e/${ev.id}`, ref: `e:${ev.id}` });
        if (okWait.length) await notify(env, okWait, 'signup', { title: `已幫你排入候補：${ev.title}`, body: '有人取消時會依序遞補，遞補成功會再通知你', url: `/#/e/${ev.id}`, ref: `e:${ev.id}` });
      }
      const outside = action === 'signup' && signupState(ev, tpNow()) !== 'open' ? '（期間外代報）' : '';
      await audit(env, req, member, 'event.bulk', 'event', ev.id, `${action === 'invite' ? '邀請' : '代為報名'} ${added} 人${action === 'signup' ? `（正取 ${nIn}、候補 ${nWait}）` : ''}，找不到 ${unmatched.length}、同名 ${ambiguous.length}${outside}`);
      if (rest.length) env.budget.stop('bulk:more');
      return json({ added, matched: matched.filter((m) => !rest.includes(m.q_name)).map((m) => m.name), ambiguous, unmatched, failed, ...(rest.length ? { more: { names: rest } } : {}) });
    }
  }

  // ---- 行事曆訂閱：產生個人專屬網址（行事曆 App 不帶 cookie，所以用代碼；資料庫只存雜湊）----
  if (path === '/api/me/calendar' && (method === 'POST' || method === 'DELETE')) {
    const g = need(); if (g) return g;
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE members SET cal_token_hash = NULL WHERE id = ?').bind(member.id).run();
      await audit(env, req, member, 'calendar.off', 'member', member.id, '');
      return json({ ok: true });
    }
    const token = rid(16);
    await env.DB.prepare('UPDATE members SET cal_token_hash = ? WHERE id = ?').bind(await sha(token), member.id).run();
    await audit(env, req, member, 'calendar.on', 'member', member.id, '產生訂閱網址');
    return json({ url: `${new URL(req.url).origin}/api/cal/${token}.ics` });
  }

  // 幹部：匯出報名名單（純文字，貼回 LINE 用）
  const m3 = path.match(/^\/api\/events\/([\w-]{1,32})\/roster$/);
  if (m3 && method === 'GET') {
    const g = need(); if (g) return g;
    const ev = await eventWithSignups(env, m3[1]);
    if (!ev) return fail(404, '找不到這個活動');
    if (!teamCan(ev.team_id, 'event') && !teamCan(ev.team_id, 'checkin')) return fail(403, '只有幹部可以匯出名單');
    const lines = ev.signups.filter((s) => s.status === 'in').map((s, i) => `${i + 1}. ${s.grp}　${s.name}${s.note ? `（${s.note}）` : ''}`);
    const wait = ev.signups.filter((s) => s.status === 'wait').map((s, i) => `候補${i + 1}. ${s.grp}　${s.name}`);
    return json({ text: [`${ev.title}　${ev.date}`, ...lines, ...wait].join('\n') });
  }

  if (path === '/api/me/consent' && method === 'POST') {
    const g = need(); if (g) return g;
    const ver = (await getSettings(env)).privacy.version;
    await env.DB.prepare("UPDATE members SET consent_at = datetime('now'), consent_version = ? WHERE id = ?").bind(ver, member.id).run();
    await audit(env, req, member, 'privacy.consent', 'member', member.id, ver);
    return json({ ok: true });
  }

  // ---- 個資：本人可以匯出與刪除（A.5.34） ----
  if (path === '/api/me/export' && method === 'GET') {
    const g = need(); if (g) return g;
    const q = (sql) => env.DB.prepare(sql).bind(member.id).all().then((r) => r.results);
    const data = {
      exported_at: new Date().toISOString(),
      profile: (({ s_seen, s_role, s_created, s_mfa, s_th, s_teams, line_id, google_sub, cal_token_hash, ...rest }) => ({ ...rest, google_linked: !!google_sub, calendar_feed: !!cal_token_hash }))(member),
      signups: await q('SELECT event_id, name, grp, dist, note, status, answers, option, reg_consent_at, items, amount, pay_method, pay_ref, pay_reported_at, paid, picked_at, attended_at, created_at, review, reviewed_at, review_note FROM signups WHERE member_id = ?'),   // 不含審核人
      teams: await q('SELECT team_id, role, title, status, created_at FROM team_members WHERE member_id = ?'),
      race_profile: await (async () => { const r = await env.DB.prepare('SELECT enc FROM member_private WHERE member_id = ?').bind(member.id).first(); return r ? openPrivate(env, r.enc, member.id).catch(() => null) : null; })(),
      tickets: await q('SELECT event_id, code, guests, meal, table_no, checked_in_at FROM tickets WHERE member_id = ?'),
      prizes: await q('SELECT event_id, prize_id, created_at, claimed_at FROM draws WHERE member_id = ?'),
      notifications: await q('SELECT kind, category, title, body, created_at, read_at FROM notifications WHERE member_id = ?'),   // ref 含其他會員的 id，不匯出
      sessions: await q('SELECT created_at, last_seen_at, ua FROM sessions WHERE member_id = ?'),
      races: await q('SELECT name, date, dist, goal, is_primary FROM races WHERE member_id = ?'),
      training_logs: await q('SELECT date, week_no, plan_day, cycle_anchor, cycle_week, plan_text, status, km, seconds, hr, rpe, feel, note, source FROM training_logs WHERE member_id = ? ORDER BY date'),
      plan_cycle: await (async () => { const c = await planCycleOf(member); return { setting: member.plan_cycle || 'club', ...(c?.race ? { race: { name: c.race.name, date: c.race.date } } : {}) }; })(),
      log_comments: await q('SELECT l.date, c.author_name, c.body, c.created_at FROM log_comments c JOIN training_logs l ON l.id = c.log_id WHERE l.member_id = ? ORDER BY c.created_at'),
      spots_proposed: await q('SELECT name, kind, lat, lng, status, created_at FROM spots WHERE created_by = ?'),
      spot_reports: await q('SELECT s.name AS spot, r.data, r.created_at FROM spot_reports r JOIN spots s ON s.id = r.spot_id WHERE r.member_id = ?'),
      routes: await q('SELECT name, distance, shared, points, created_at FROM routes WHERE created_by = ?'),
      calendar_items: await q('SELECT date, title, kind, url, note, created_at FROM calendar_items WHERE created_by = ?'),
    };
    await audit(env, req, member, 'privacy.export', 'member', member.id, '');
    return json(data, 200, { 'content-disposition': 'attachment; filename="my-data.json"' });
  }
  if (path === '/api/me' && method === 'DELETE') {
    const g = need(); if (g) return g;
    if (norm(member.real_role || member.role) === 'chair') {
      const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'chair'").first()).n;
      if (n <= 1) return fail(400, '你是唯一的理事長，請先指派新的理事長再刪除帳號');
    }
    // 刪除後空出的正取名額要遞補：先記下還沒舉行、本人是正取的活動
    const freed = (await env.DB.prepare(`SELECT s.event_id FROM signups s JOIN events e ON e.id = s.event_id
      WHERE s.member_id = ? AND s.status = 'in' AND e.date >= ?`).bind(member.id, today()).all()).results.map((r) => r.event_id);
    // 每一句見 erase.js（還原備份後也用同一份重做刪除）；得獎紀錄只匿名化，不刪除
    await env.DB.batch(ERASE_MEMBER.map((q) => env.DB.prepare(q).bind(member.id)));
    // 遞補：額度夠的場次現在處理，剩下的由每小時的 promoteSweep 在下個整點遞補
    for (const eid of freed) { if (!env.budget.room(1 + PROMOTE_ROUND + PROMOTE_TAIL + 2)) { env.budget.stop('delete:promote'); break; } await promote(env, await evById(eid), { rounds: 1, reserve: 2 }); }
    await audit(env, req, member, 'privacy.delete', 'member', member.id, '本人刪除帳號');
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  // ---- 稽核紀錄（理事長、監事）----
  if (path === '/api/audit' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'audit')) return fail(403, '只有理事長與監事可以查看稽核紀錄');
    // 一定要有時間區間（預設最近 7 天、最長 366 天）；可再加操作類型、操作者、對象；一次 50 筆，用 before 往回翻
    const u = new URL(req.url), sp = (k, n) => str(u.searchParams.get(k), n);
    const to = isDate(sp('to', 10)) ? sp('to', 10) : today();
    const from = isDate(sp('from', 10)) ? sp('from', 10) : new Date(Date.parse(to) - 6 * 864e5).toISOString().slice(0, 10);
    if (Date.parse(to) - Date.parse(from) > 366 * 864e5 || from > to) return fail(400, '查詢區間最長一年');
    const where = ['at >= ?', 'at < ?'], args = [from, `${to} 24`];
    const action = sp('action', 40), actor = sp('actor', 20).replace(/[%_]/g, ''), target = sp('target', 32), before = sp('before', 60);
    if (action) { where.push('action LIKE ?'); args.push(`${action.replace(/[%_]/g, '')}%`); }
    if (actor) { where.push('actor_name LIKE ?'); args.push(`%${actor}%`); }
    if (target) { where.push('target_id = ?'); args.push(target); }
    const [bAt, bId] = before.split('|');
    if (bAt && bId) { where.push('(at < ? OR (at = ? AND id < ?))'); args.push(bAt, bAt, bId); }
    const rows = (await env.DB.prepare(
      `SELECT id, at, actor_name, actor_role, action, target_type, target_id, detail FROM audit_log
       WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT 51`).bind(...args).all()).results;
    const last = rows[49];
    return json({ items: rows.slice(0, 50), next: rows.length > 50 ? `${last.at}|${last.id}` : null, from, to });
  }

  // ---- 我的賽事（倒數）----
  if (path === '/api/races' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare('SELECT id, name, date, dist, goal, is_primary FROM races WHERE member_id = ? ORDER BY date').bind(member.id).all()).results;
    const club = await env.DB.prepare("SELECT value FROM settings WHERE key = 'club_race'").first();
    return json({ races: rows, presets: (await racePresets(env)).filter((p) => p.date >= today()), mode: member.countdown_mode || 'mine',
      club: (() => { try { return JSON.parse(club?.value || 'null'); } catch { return null; } })() });
  }
  if (path === '/api/races' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body(), name = str(b.name, 40), date = str(b.date, 10);
    if (!name || !isDate(date)) return fail(400, '請填賽事名稱與日期');
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM races WHERE member_id = ?').bind(member.id).first()).n;
    if (n >= 30) return fail(400, '最多 30 場');
    const id = rid(8), primary = b.is_primary === true || n === 0 ? 1 : 0;
    if (primary) await env.DB.prepare('UPDATE races SET is_primary = 0 WHERE member_id = ?').bind(member.id).run();
    await env.DB.prepare('INSERT INTO races (id, member_id, name, date, dist, goal, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, member.id, name, date, str(b.dist, 10), str(b.goal, 12), primary).run();
    return json({ id });
  }
  const mrc = path.match(/^\/api\/races\/([\w-]{1,32})(\/primary)?$/);
  if (mrc) {
    const g = need(); if (g) return g;
    if (method === 'DELETE') {
      // 刪掉的是課表週期跟著的那場：課表改回協會賽季（以前的紀錄保留當時的週期）
      if (member.plan_cycle === 'race' && member.plan_race_id === mrc[1]) {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM races WHERE id = ? AND member_id = ?').bind(mrc[1], member.id),
          env.DB.prepare("UPDATE members SET plan_cycle = 'club', plan_race_id = NULL WHERE id = ?").bind(member.id),
        ]);
        return json({ ok: true, cycleReset: true });
      }
      await env.DB.prepare('DELETE FROM races WHERE id = ? AND member_id = ?').bind(mrc[1], member.id).run();
      return json({ ok: true });
    }
    if (method === 'POST' && mrc[2]) {
      await env.DB.batch([
        env.DB.prepare('UPDATE races SET is_primary = 0 WHERE member_id = ?').bind(member.id),
        env.DB.prepare('UPDATE races SET is_primary = 1 WHERE id = ? AND member_id = ?').bind(mrc[1], member.id),
      ]);
      return json({ ok: true });
    }
  }
  // 倒數要顯示哪一種：mine 自己的主要賽事｜club 協會預設｜off 不顯示
  if (path === '/api/me/countdown' && method === 'POST') {
    const g = need(); if (g) return g;
    const want = (await body()).mode, mode = ['mine', 'club', 'off'].includes(want) ? want : 'mine';
    await env.DB.prepare('UPDATE members SET countdown_mode = ? WHERE id = ?').bind(mode, member.id).run();
    return json({ ok: true, race: await countdownTarget(env, { ...member, countdown_mode: mode }) });
  }
  // 常用賽事清單（後台維護）
  if (path === '/api/settings/race-presets' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !can(member, 'event')) return fail(403, '只有幹部可以維護賽事清單');
    const raw = (await body()).presets, list = Array.isArray(raw) ? raw : [];
    const clean = list.slice(0, 40).map((p) => ({ name: str(p.name, 40), date: str(p.date, 10), dist: str(p.dist, 10) })).filter((p) => p.name && isDate(p.date));
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('race_presets', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(clean)).run();
    await audit(env, req, member, 'settings.race_presets', 'settings', 'race_presets', `${clean.length} 場`);
    return json({ ok: true, presets: clean });
  }
  // 協會預設倒數（建立活動權限即可修改）
  if (path === '/api/settings/club-race' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'event')) return fail(403, '只有幹部可以修改協會預設賽事');
    const b = await body(), name = str(b.name, 40), date = str(b.date, 10);
    if (!name || !isDate(date)) return fail(400, '請填賽事名稱與日期');
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('club_race', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify({ name, date })).run();
    await audit(env, req, member, 'settings.club_race', 'settings', 'club_race', `${name} ${date}`);
    return json({ ok: true });
  }

  const mset = path.match(/^\/api\/settings\/(org|features|docs|privacy|tabs|signup)$/);
  if (mset && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以修改系統設定');
    const key = mset[1], b = await body();
    const cur = (() => { try { return JSON.parse(setting(key) || '{}') || {}; } catch { return {}; } })();
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    let value;
    if (key === 'org') {
      // 後台把協會資訊拆成三張表單（協會資訊、課表與團練、資料保存期限）各自儲存：每個欄位都是「有送才改，沒送就保留原值」
      const pick = (k, f) => (has(k) ? f(b[k]) : f(cur[k]));
      const years = (lo, hi, d) => (v) => Math.max(lo, Math.min(Math.round(Number(v) || d), hi));
      value = { name: pick('name', (v) => str(v, 40)), short: pick('short', (v) => str(v, 12)), contact: pick('contact', (v) => str(v, 200)), retention: pick('retention', (v) => str(v, 200)),
        join_form: pick('join_form', httpsUrl), parent: pick('parent', (v) => str(v, 30)), parent_url: pick('parent_url', httpsUrl), parent_note: pick('parent_note', (v) => str(v, 80)),
        thu_venue: pick('thu_venue', (v) => str(v, 20)),   // 週四團練地點（課表備註用）
        event_data_years: pick('event_data_years', years(0, 20, 0)), log_years: pick('log_years', years(0, 20, 0)), audit_years: pick('audit_years', years(1, 10, 3)) };
      if (has('name') && !value.name) return fail(400, '請填協會名稱');
      if (b.join_form && !value.join_form) return fail(400, '入會表單連結要是 https:// 開頭的網址');
      if (b.parent_url && !value.parent_url) return fail(400, '企業網站要是 https:// 開頭的網址');
    } else if (key === 'features') {
      value = {};
      // 預設開；後台關掉才是 false。沒送的開關保留原值（舊版後台不認得的新開關不會被改掉）
      for (const f of ['gps', 'studio', 'health', 'file', 'coach', 'party', 'plan_export', 'plan_cycle']) value[f] = has(f) ? b[f] !== false : cur[f] !== false;
      // 預設關閉的功能：明確送 true 才開，沒送保留原值；不能併進上面預設開的迴圈
      //   附近即時影像：staging 實測過 Cache API、出口 IP 與解析 CPU 時間之後才開
      //   跑者休息站：還不認得它的舊版管理畫面存其他開關時不會順手關掉
      for (const f of ['cams', 'rest']) value[f] = has(f) ? b[f] === true : cur[f] === true;
    } else if (key === 'tabs') {
      // 下方分頁列的名稱（每個最多 4 個字，空白就用預設）
      value = {};
      for (const k of ['home', 'plan', 'run', 'map', 'studio', 'me']) { const v = str(b[k], 4); if (v) value[k] = v; }
    } else if (key === 'docs') {
      const list = Array.isArray(b.docs) ? b.docs.slice(0, 30) : [];
      value = list.map((d) => ({ title: str(d.title, 40), url: httpsUrl(d.url), note: str(d.note, 80) })).filter((d) => d.title && d.url);
    } else if (key === 'signup') {
      // 活動報名預設：只存相對規則（活動前 N 天幾點），新增活動時由表單推算；null＝立即開放／活動開始時截止
      const days = (v) => (v === null || v === '' || v === undefined ? null : Math.max(0, Math.min(Math.round(Number(v)) || 0, 60)));
      const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? v : d);
      value = { approval: b.approval === true, notify: b.notify === true, open_days: days(b.open_days), open_time: hm(b.open_time, '20:00'),
        close_days: days(b.close_days), close_time: hm(b.close_time, '22:00') };
      if (value.open_days != null && value.close_days != null
        && shiftDays(`2030-01-31T${value.open_time}`, -value.open_days) >= shiftDays(`2030-01-31T${value.close_time}`, -value.close_days))
        return fail(400, '預設的報名開始要早於截止');
    } else {
      const cur = (await getSettings(env)).privacy;
      const bodyText = str(b.body, 20000);
      // 內容有改就自動升版，使用者下次開啟要重新同意
      const bump = b.bump === true || bodyText !== (cur.body || '');
      value = { body: bodyText, version: bump ? new Date().toISOString().slice(0, 16).replace('T', ' ') : cur.version };
    }
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value)).run();
    await audit(env, req, member, `settings.${key}`, 'settings', key, key === 'privacy' ? `版本 ${value.version}` : JSON.stringify(value).slice(0, 200));
    return json({ ok: true, value });
  }

  // 協會的 iPhone 捷徑連結（只接受 iCloud 分享連結）
  if (path === '/api/settings/shortcut' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'event')) return fail(403, '只有幹部可以設定');
    const u = str((await body()).url, 200);
    if (u && !/^https:\/\/www\.icloud\.com\/shortcuts\/[\w-]+$/.test(u)) return fail(400, '請貼上 iCloud 捷徑分享連結（https://www.icloud.com/shortcuts/…）');
    if (u) await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('health_shortcut', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(u).run();
    else await env.DB.prepare("DELETE FROM settings WHERE key = 'health_shortcut'").run();
    await audit(env, req, member, 'settings.shortcut', 'settings', 'health_shortcut', u ? '更新' : '移除');
    return json({ ok: true });
  }


  // ---- 訓練紀錄（照課表打卡）----
  // 查詢一定要有日期區間：自己的紀錄最長 120 天，教練看團員最長 31 天
  const rangeOf = (u, maxDays, defDays) => {
    const to = isDate(u.searchParams.get('to') || '') ? u.searchParams.get('to') : today();
    const from = isDate(u.searchParams.get('from') || '') ? u.searchParams.get('from') : new Date(Date.parse(to) - defDays * 864e5).toISOString().slice(0, 10);
    return from > to || Date.parse(to) - Date.parse(from) > maxDays * 864e5 ? null : [from, to];
  };
  const LOG_STATUS = ['done', 'partial', 'skip', 'extra'];
  const LOG_SOURCES = ['manual', 'health', 'file', 'gps'];
  const LOG_KINDS = ['easy', 'quality', 'long', 'strength', 'race', 'rest'];
  if (path === '/api/logs' && method === 'GET') {
    const g = need(); if (g) return g;
    const r = rangeOf(new URL(req.url), 370, 6);
    if (!r) return fail(400, '查詢區間最長一年');
    const rows = (await env.DB.prepare(
      `SELECT id, date, week_no, plan_day, cycle_anchor, cycle_week, kind, plan_text, status, km, seconds, hr, rpe, feel, note, source,
              (SELECT COUNT(*) FROM log_comments c WHERE c.log_id = training_logs.id) AS comments,
              (SELECT COUNT(*) FROM log_comments c WHERE c.log_id = training_logs.id AND c.read_at IS NULL) AS unread
       FROM training_logs WHERE member_id = ? AND date BETWEEN ? AND ? ORDER BY date, created_at LIMIT 1000`).bind(member.id, ...r).all()).results;
    return json({ logs: rows, from: r[0], to: r[1] });
  }
  // 新增與修改（離線補傳、舊版資料搬移也走這裡）：每位跑友每天最多 LOG_DAY_LIMIT 次、10 分鐘最多 LOG_BURST 次（見 limitedPair：
  //   被 10 分鐘上限擋下的不扣每天的次數，每天的用完後被擋的請求不寫 D1）；日期最早到 logFloor（協會這一季第 1 週往前 400 天）；
  //   整個請求最多 8 KB、備註最多 300 字。同一天最多 5 筆：新增與「修改時改了日期」都檢查，
  //   所以總數被「每天最多 5 筆 × 可以記的天數（logFloor 到明天）」限住，不會把資料庫與每日備份灌爆
  if (path === '/api/logs' && method === 'POST') {
    const g = need(); if (g) return g;
    if (Number(req.headers.get('content-length')) > LOG_BODY_MAX) return fail(413, '資料太大');
    const hit = await limitedPair(env, `logday:${member.id}`, LOG_DAY_LIMIT, `logw:${member.id}`, LOG_BURST, 600);
    if (hit) return fail(429, hit === 'day' ? '今天記錄的次數已達上限，明天再試' : '記錄太頻繁，請 10 分鐘後再試');
    let b = {};
    try { const raw = await req.text(); if (raw.length > LOG_BODY_MAX) return fail(413, '資料太大'); b = JSON.parse(raw || '{}') || {}; } catch {}
    if (typeof b !== 'object') b = {};
    const id = str(b.id, 32);
    const n = (v, lo, hi, int) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? (int ? Math.round(x) : Math.round(x * 100) / 100) : null; };
    const date = str(b.date, 10);
    if (!isDate(date) || date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) return fail(400, '日期不正確（不能記未來的訓練）');
    const floor = logFloor(today());
    if (date < floor) {
      // 以前就存在的舊紀錄：日期沒改的話照樣可以修改
      const keep = id && (await env.DB.prepare('SELECT date FROM training_logs WHERE id = ? AND member_id = ?').bind(id, member.id).first())?.date === date;
      if (!keep) return fail(400, `日期太早，最早只能記到 ${floor}`);
    }
    if (typeof b.note === 'string' && b.note.trim().length > LOG_NOTE_MAX) return fail(400, `備註最多 ${LOG_NOTE_MAX} 字`);
    const status = LOG_STATUS.includes(b.status) ? b.status : 'done';
    // 個人週期：記下比賽日與第幾週；week_no 由伺服器算成這一天在協會賽季的週次（賽季外是空的）
    const anchor = isDate(str(b.cycle_anchor, 10)) ? str(b.cycle_anchor, 10) : null;
    const cweek = anchor ? n(b.cycle_week, 1, 21, true) : null;
    if (anchor && !cweek) return fail(400, '週期週次不正確');
    if (anchor && Math.abs(weekIndexOf(date, cycleOf(anchor)) - cweek) > 1) return fail(400, '週期週次跟日期對不上');
    const log = {
      date, status, week_no: anchor ? clubWeekOf(date) : n(b.week_no, 1, 21, true), plan_day: str(b.plan_day, 12) || null,
      kind: LOG_KINDS.includes(b.kind) ? b.kind : null, plan_text: str(b.plan_text, 300) || null,
      km: status === 'skip' ? null : n(b.km, 0.01, 400), seconds: status === 'skip' ? null : n(b.seconds, 1, 200000, true),
      hr: n(b.hr, 30, 230, true), rpe: n(b.rpe, 1, 10, true), feel: n(b.feel, 1, 5, true),
      note: str(b.note, LOG_NOTE_MAX) || null, source: LOG_SOURCES.includes(b.source) ? b.source : 'manual',
    };
    if (id) {
      // 修改：有送 cycle_anchor 才改週期欄位；舊版 App 沒送時保留原本的週期（個人週期的 week_no 也不動）
      const upd = { ...log };
      if ('cycle_anchor' in b) Object.assign(upd, { cycle_anchor: anchor, cycle_week: cweek });
      else {
        const cur = await env.DB.prepare('SELECT cycle_anchor FROM training_logs WHERE id = ? AND member_id = ?').bind(id, member.id).first();
        if (!cur) return fail(404, '找不到這筆紀錄');
        if (cur.cycle_anchor) delete upd.week_no;
      }
      // 改到別的日期：那一天已經有 5 筆就不能搬過去（同一個陳述式判斷，同時送也不會超過）
      const ucols = Object.keys(upd);
      const r = await env.DB.prepare(`UPDATE training_logs SET ${ucols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now')
        WHERE id = ? AND member_id = ? AND (date = ? OR (SELECT COUNT(*) FROM training_logs t WHERE t.member_id = ? AND t.date = ?) < 5)`)
        .bind(...Object.values(upd), id, member.id, date, member.id, date).run();
      if (r.meta.changes) return json({ id });
      const exists = await env.DB.prepare('SELECT 1 FROM training_logs WHERE id = ? AND member_id = ?').bind(id, member.id).first();
      return exists ? fail(400, '同一天最多 5 筆紀錄') : fail(404, '找不到這筆紀錄');
    }
    log.cycle_anchor = anchor; log.cycle_week = cweek;
    const cols = Object.keys(log);
    // 照課表記錄（快速打勾、離線補傳、舊資料搬移）：同一個週期、同一週、同一天已經有紀錄就不再新增
    if (b.if_absent === true && log.plan_day && (anchor ? cweek : log.week_no)) {
      const hit = await env.DB.prepare(`SELECT id FROM training_logs WHERE member_id = ?1 AND plan_day = ?2 AND
        ((?3 IS NULL AND cycle_anchor IS NULL AND week_no = ?4) OR (cycle_anchor = ?3 AND cycle_week = ?5)) LIMIT 1`)
        .bind(member.id, log.plan_day, anchor, log.week_no, cweek).first();
      if (hit) return json({ id: hit.id, existed: true });
    }
    const cnt = (await env.DB.prepare('SELECT COUNT(*) AS n FROM training_logs WHERE member_id = ? AND date = ?').bind(member.id, date).first()).n;
    if (cnt >= 5) return fail(400, '同一天最多 5 筆紀錄');
    const nid = rid(8);
    await env.DB.prepare(`INSERT INTO training_logs (id, member_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
      .bind(nid, member.id, ...Object.values(log)).run();
    return json({ id: nid });
  }
  const mlog = path.match(/^\/api\/logs\/([\w-]{1,32})$/);
  if (mlog && method === 'DELETE') {
    const g = need(); if (g) return g;
    const r = await env.DB.prepare('DELETE FROM training_logs WHERE id = ? AND member_id = ?').bind(mlog[1], member.id).run();
    // 寫稽核（只有紀錄 id）：還原備份或 Time Travel 後，刪掉的紀錄（備註、心率、強度）才不會跟著回來（tools/restore-sql.mjs 重做）
    if (r.meta.changes) await audit(env, req, member, 'log.delete', 'log', mlog[1], '');
    return json({ ok: true });
  }
  // 教練看某位團員的紀錄（本人要有打開分享）；以及教練留言
  //   照分享同意書的字面（「只看得到完成率、里程與平均強度」）：每一筆只給完成狀況、距離與課表位置，
  //   強度只給區間平均；每一筆的時間（配速）、心率、自覺強度、感覺與備註只有本人看得到（本人的 /api/logs 照舊是完整資料）
  // 教練視角（團員分享的訓練、留回饋）：只有課表教練（plan）與該分團的團長、幹部（teamOwn），對齊分享同意書的「教練與分團幹部」；
  //   協會層級的名冊權限（理事、行政、監事）不算，監事唯讀也不能留回饋
  const coachOf = (tid) => can(member, 'plan') || teamOwn(tid, 'roster');
  const canCoach = async (mid) => {
    const m = await env.DB.prepare('SELECT id, name, nickname, share_logs, dist, grp, plan_cycle FROM members WHERE id = ?').bind(mid).first();
    if (!m || !m.share_logs) return null;
    if (can(member, 'plan')) return m;
    const shared = (await env.DB.prepare("SELECT team_id FROM team_members WHERE member_id = ? AND status = 'active'").bind(mid).all()).results;
    return shared.some((t) => coachOf(t.team_id)) ? m : null;
  };
  // 平均強度（RPE）：只算整週（週一到週日，跟協會週次同一個起點），而且那一週至少 RPE_MIN 筆有填強度才計入。
  //   查詢區間碰到的週一律整週算，所以把 from、to 縮到一天也拿不到單次的 RPE；不足 RPE_MIN 筆的週整週不算，
  //   兩個區間相減也推不回來（分享同意書：「每次的強度只有本人看得到」）
  const RPE_MIN = 3;
  const rpeByWeek = async (whoSql, binds, [from, to]) => {
    const rows = (await env.DB.prepare(`SELECT member_id, SUM(rpe) AS s, COUNT(*) AS n FROM training_logs
       WHERE ${whoSql} AND date BETWEEN date(?, 'weekday 0', '-6 days') AND date(?, 'weekday 0') AND rpe IS NOT NULL
       GROUP BY member_id, date(date, 'weekday 0', '-6 days') HAVING COUNT(*) >= ${RPE_MIN}`).bind(...binds, from, to).all()).results;
    const by = new Map();
    for (const r of rows) { const a = by.get(r.member_id) || { s: 0, n: 0 }; a.s += r.s; a.n += r.n; by.set(r.member_id, a); }
    return new Map([...by].map(([k, a]) => [k, Math.round((a.s / a.n) * 10) / 10]));
  };
  const mlm = path.match(/^\/api\/logs\/member\/([\w-]{1,32})$/);
  if (mlm && method === 'GET') {
    const g = need(); if (g) return g;
    const who = await canCoach(mlm[1]);
    if (!who) return fail(403, '這位團員沒有分享訓練紀錄，或不在你帶的分團');
    const r = rangeOf(new URL(req.url), 62, 6);
    if (!r) return fail(400, '查詢區間最長兩個月');
    const rows = (await env.DB.prepare(
      `SELECT id, date, week_no, plan_day, cycle_week, (cycle_anchor IS NOT NULL) AS personal, kind, plan_text, status, km,
              (SELECT COUNT(*) FROM log_comments c WHERE c.log_id = training_logs.id) AS comments
       FROM training_logs WHERE member_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT 200`).bind(who.id, ...r).all()).results;
    // 區間合計：完成次數、里程（每一筆本來就看得到）；平均強度照 rpeByWeek（整週、每週至少 RPE_MIN 筆），跟 /api/logs/team 同一套
    const sum = await env.DB.prepare(`SELECT SUM(status != 'skip') AS runs, ROUND(SUM(COALESCE(km, 0)), 1) AS km
       FROM training_logs WHERE member_id = ? AND date BETWEEN ? AND ?`).bind(who.id, ...r).first();
    const rpe = (await rpeByWeek('member_id = ?', [who.id], r)).get(who.id) ?? null;
    // 個人週期只給週次與「個人」標記，不給比賽日與比賽名稱
    return json({ member: { id: who.id, name: who.name, nickname: who.nickname, dist: who.dist, grp: who.grp, plan_cycle: who.plan_cycle === 'race' ? 'race' : 'club' }, logs: rows,
      summary: { runs: sum?.runs || 0, km: sum?.km || 0, rpe }, from: r[0], to: r[1] });
  }
  const mlc = path.match(/^\/api\/logs\/([\w-]{1,32})\/comments$/);
  if (mlc) {
    const g = need(); if (g) return g;
    const log = await env.DB.prepare('SELECT id, member_id, date, plan_day FROM training_logs WHERE id = ?').bind(mlc[1]).first();
    if (!log) return fail(404, '找不到這筆紀錄');
    const own = log.member_id === member.id;
    if (!own && !(await canCoach(log.member_id))) return fail(403, '沒有權限');
    if (method === 'GET') {
      const rows = (await env.DB.prepare('SELECT id, author_name, body, created_at FROM log_comments WHERE log_id = ? ORDER BY created_at LIMIT 100').bind(log.id).all()).results;
      if (own) await env.DB.prepare("UPDATE log_comments SET read_at = datetime('now') WHERE log_id = ? AND read_at IS NULL").bind(log.id).run();
      return json({ comments: rows });
    }
    if (method === 'POST') {
      if (own) return fail(400, '留言是給教練用的');
      if (READONLY[norm(member.role)]) return fail(403, '監事不能留訓練回饋');
      const text = str((await body()).body, 500);
      if (!text) return fail(400, '請輸入留言');
      if (await limited(env, `comment:${member.id}`, 60, 3600)) return fail(429, '留言太頻繁');
      await env.DB.prepare('INSERT INTO log_comments (id, log_id, author_id, author_name, body) VALUES (?, ?, ?, ?, ?)')
        .bind(rid(8), log.id, member.id, member.nickname || member.name, text).run();
      // 不放教練的本名（沒有暱稱就寫「教練」）
      await notify(env, [log.member_id], 'training', { kind: 'log', title: member.nickname ? `${member.nickname} 回饋了你的訓練` : '教練回饋了你的訓練', body: text.slice(0, 60), url: `/#/log?id=${log.id}`,
        ref: `log:${log.id}`, push: { title: '教練回饋了你的訓練', body: '點開看教練的回饋' } });
      return json({ ok: true });
    }
  }
  if (path === '/api/me/share-logs' && method === 'POST') {
    const g = need(); if (g) return g;
    const on = (await body()).share === true ? 1 : 0;
    await env.DB.prepare('UPDATE members SET share_logs = ? WHERE id = ?').bind(on, member.id).run();
    await audit(env, req, member, 'privacy.share_logs', 'member', member.id, on ? '開啟' : '關閉');
    return json({ ok: true, share: !!on });
  }
  // 教練與分團幹部：有開分享的團員，在區間內的完成次數、里程與平均強度（不含每一筆的時間、心率、強度、感覺與備註）
  if (path === '/api/logs/team' && method === 'GET') {
    const g = need(); if (g) return g;
    const u = new URL(req.url), team = str(u.searchParams.get('team'), 16);
    if (!(can(member, 'plan') || (team && coachOf(team)))) return fail(403, '只有教練與分團幹部可以看團員訓練');
    const r = rangeOf(u, 31, 6);
    if (!r) return fail(400, '查詢區間最長 31 天');
    const rows = (await env.DB.prepare(
      `SELECT m.id, m.name, m.nickname, m.avatar, m.dist, m.grp, m.plan_cycle,
              SUM(l.status = 'done') AS done, SUM(l.status = 'partial') AS partial, SUM(l.status = 'skip') AS skip, SUM(l.status = 'extra') AS extra,
              ROUND(SUM(COALESCE(l.km, 0)), 1) AS km, MAX(l.date) AS last
       FROM members m LEFT JOIN training_logs l ON l.member_id = m.id AND l.date BETWEEN ? AND ?
       WHERE m.share_logs = 1 ${team ? "AND m.id IN (SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active')" : ''}
       GROUP BY m.id ORDER BY km DESC, m.name LIMIT 200`).bind(...r, ...(team ? [team] : [])).all()).results;
    // 平均強度：整週、每週至少 RPE_MIN 筆（rpeByWeek）；區間縮到一天也拿不到單次的 RPE
    const rpe = rows.length ? await rpeByWeek(`member_id IN (SELECT id FROM members WHERE share_logs = 1${team ? " AND id IN (SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active')" : ''})`,
      team ? [team] : [], r) : new Map();
    return json({ members: rows.map((m) => ({ ...m, rpe: rpe.get(m.id) ?? null })), from: r[0], to: r[1] });
  }

  // ---- 通知中心 ----
  // 每一條 SQL 都綁目前登入的會員；查不到和不是你的，一律回同一個 404
  // NOTSEC：批次操作與刪除不碰帳號安全通知；category 是 NULL（部署空窗期）的列比照保護
  const NOTSEC = "category IS NOT NULL AND category != 'security'";
  const NID = /^[a-z0-9]{8,24}$/, CURSOR = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\|([a-z0-9]{8,24}))?$/;
  const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  // cat：省略＝全部｜unread｜最多 3 個逗號分隔的分類；不認得回 null
  const notifCats = (q) => {
    if (!q) return { all: true };
    if (q === 'unread') return { unread: true };
    const list = [...new Set(q.split(','))];
    return list.length <= 3 && list.every(isCat) ? { cats: list } : null;
  };
  const cursorSql = (c, inclusive) => (c[2] ? `AND (created_at < ? OR (created_at = ? AND id ${inclusive ? '<=' : '<'} ?))` : `AND created_at ${inclusive ? '<=' : '<'} ?`);
  const cursorArgs = (c) => (c[2] ? [c[1], c[1], c[2]] : [c[1]]);
  // 鈴鐺：badge＝上次打開通知中心之後的新通知＋未讀的帳號安全通知；unread 保留給舊版用戶端
  const notifCounts = async (seenAt) => {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS unread, COALESCE(SUM(created_at > ?2 OR category IS NULL OR category = 'security'), 0) AS badge,
        COALESCE(SUM(created_at > ?2), 0) AS unseen FROM notifications WHERE member_id = ?1 AND read_at IS NULL`).bind(member.id, seenAt ?? member.notif_seen_at ?? '').first();
    return { badge: r.badge, unseen: r.unseen, unread: r.unread };
  };
  // 幹部：決定要不要顯示「幹部待辦」（依目前權限即時判斷，卸任馬上看不到）
  const isOfficer = () => !!member && ((can(member, 'members') && !READONLY[norm(member.role)]) || canEditSpots()
    || Object.values(myTeams).some((t) => t.status === 'active' && t.role !== 'member')
    || ['chair', 'supervisor'].includes(norm(member.role)));
  // 我能審核的報名待審核（每場一列；/api/me/reviews 與待處理摘要共用）
  const reviewRows = async () => (await env.DB.prepare(`SELECT e.id, e.title, e.date, e.team_id, e.capacity, COUNT(*) AS n, MIN(s.created_at) AS oldest,
      (SELECT COUNT(*) FROM signups x WHERE x.event_id = e.id AND x.status = 'in') AS signed
    FROM signups s JOIN events e ON e.id = s.event_id WHERE s.status = 'pending' AND e.date >= ? AND e.status = 'open'
    GROUP BY e.id ORDER BY e.date LIMIT 50`).bind(today()).all()).results.filter((e) => teamCan(e.team_id, 'event'));
  if (path === '/api/me/reviews' && method === 'GET') {
    const g = need(); if (g) return g;
    return json({ events: (await reviewRows()).map(({ team_id, signed, capacity, ...r }) => ({ ...r, seatsLeft: capacity ? Math.max(0, capacity - signed) : null })) });
  }
  // 待處理摘要：從來源資料表即時計算，只在通知列表第一頁算
  const todoSummary = async () => {
    if (!isOfficer()) return null;
    const joins = {}; for (const r of await pendingJoins()) (joins[r.team_id] ||= { tid: r.team_id, name: r.team_name, n: 0 }).n++;
    const applied = can(member, 'members') && !READONLY[norm(member.role)]
      ? (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE membership = 'applied'").first()).n : 0;
    const spots = canEditSpots() ? (await env.DB.prepare("SELECT COUNT(*) AS n FROM spots WHERE status = 'pending'").first()).n : 0;
    const pays = (await env.DB.prepare(`SELECT e.id, e.title, e.team_id, COUNT(*) AS n FROM signups s JOIN events e ON e.id = s.event_id
        WHERE s.pay_reported_at IS NOT NULL AND s.paid NOT IN ('paid','waived','refunded') AND s.status = 'in' AND e.date >= date('now','-120 days')
        GROUP BY e.id ORDER BY MIN(s.pay_reported_at) LIMIT 50`).all()).results.filter((e) => teamCan(e.team_id, 'event')).slice(0, 5);
    const reviews = (await reviewRows()).slice(0, 5).map(({ id, title, n }) => ({ id, title, n }));
    const total = Object.values(joins).reduce((t, x) => t + x.n, 0) + applied + spots + pays.reduce((t, x) => t + x.n, 0) + reviews.reduce((t, x) => t + x.n, 0);
    return { joins: Object.values(joins), applied, spots, pays: pays.map(({ id, title, n }) => ({ id, title, n })), reviews, total };
  };
  const notifPrefs = () => ({ mute: (member.notif_mute || '').split(',').filter((c) => MUTABLE.includes(c)), locked: Object.keys(CATS).filter((k) => CATS[k].locked),
    officer: isOfficer(), reviewForced: ['chair', 'supervisor'].includes(norm(member.role)) });
  if (path === '/api/notifications' && method === 'GET') {
    const g = need(); if (g) return g;
    const u = new URL(req.url), q = str(u.searchParams.get('cat'), 60), f = notifCats(q);
    if (!f) return fail(400, '通知分類不正確');
    const rawBefore = str(u.searchParams.get('before'), 40), cur = rawBefore ? rawBefore.match(CURSOR) : null;
    if (rawBefore && !cur) return fail(400, '分頁參數不正確');
    const COLS = 'id, kind, category, ref, title, body, url, created_at, read_at';
    // 「需要留意」：未讀的活動異動與帳號安全（14 天內最多 3 則），每一頁都從清單排除
    const pinned = f.cats ? [] : (await env.DB.prepare(`SELECT ${COLS} FROM notifications WHERE member_id = ? AND read_at IS NULL AND category IN ('change','security')
        AND created_at > datetime('now', '-14 days') ORDER BY created_at DESC, id DESC LIMIT 3`).bind(member.id).all()).results;
    const where = ['member_id = ?'], args = [member.id];
    if (f.unread) where.push('read_at IS NULL');
    if (f.cats) { where.push(`category IN (${f.cats.map(() => '?').join(',')})`); args.push(...f.cats); }
    if (pinned.length) { where.push(`id NOT IN (${pinned.map(() => '?').join(',')})`); args.push(...pinned.map((r) => r.id)); }
    const items = (await env.DB.prepare(`SELECT ${COLS} FROM notifications WHERE ${where.join(' AND ')} ${cur ? cursorSql(cur, false) : ''}
       ORDER BY created_at DESC, id DESC LIMIT 31`).bind(...args, ...(cur ? cursorArgs(cur) : [])).all()).results;
    const out = { items: items.slice(0, 30), next: items.length > 30 ? `${items[29].created_at}|${items[29].id}` : null };
    if (!cur) {
      const cats = {};
      for (const r of (await env.DB.prepare(`SELECT COALESCE(category, 'other') AS c, COUNT(*) AS n, COALESCE(SUM(read_at IS NULL), 0) AS u FROM notifications
          WHERE member_id = ? GROUP BY 1`).bind(member.id).all()).results) { const x = cats[isCat(r.c) ? r.c : 'other'] ||= { n: 0, u: 0 }; x.n += r.n; x.u += r.u; }
      // officer：「待辦」chip 要不要出現（不管目前篩選哪一類都要知道）
      Object.assign(out, await notifCounts(), { cats, pinned, officer: isOfficer(), todo: f.all || q === 'todo' ? await todoSummary() : null });
    }
    return json(out);
  }
  if (path === '/api/notifications/count' && method === 'GET') {
    const h = { 'cache-control': 'private, no-store' };
    if (!member) return json({ badge: 0, unseen: 0, unread: 0 }, 200, h);
    return json(await notifCounts(), 200, h);
  }
  if (path === '/api/notifications/seen' && method === 'POST') {
    const g = need(); if (g) return g;
    const now = nowSql();
    await env.DB.prepare('UPDATE members SET notif_seen_at = ? WHERE id = ?').bind(now, member.id).run();
    return json({ ok: true, ...(await notifCounts(now)) });
  }
  if ((path === '/api/notifications/read' || path === '/api/notifications/unread') && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `nread:${member.id}`, 300, 3600)) return fail(429, '操作太頻繁，請稍後再試');
    const b = await body();
    if (path.endsWith('/unread')) {
      if (!NID.test(b.id || '')) return fail(404, '找不到這則通知');
      const r = await env.DB.prepare('UPDATE notifications SET read_at = NULL WHERE id = ? AND member_id = ?').bind(b.id, member.id).run();
      if (!r.meta.changes) return fail(404, '找不到這則通知');
      return json({ ok: true, ...(await notifCounts()) });
    }
    if (b.id !== undefined) {
      // 單則已讀（包含帳號安全：這就是確認安全通知的方式）；不是你的就不會動到任何一列
      if (!NID.test(b.id || '')) return fail(404, '找不到這則通知');
      await env.DB.prepare("UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND member_id = ?").bind(b.id, member.id).run();
    } else if (b.ref !== undefined) {
      // 依活動等關聯對象已讀：不會把幹部的繳費、天氣待辦或安全通知一起標掉
      if (!/^(e|t|spot|log):[\w-]{1,32}$/.test(b.ref || '')) return fail(400, '關聯對象不正確');
      await env.DB.prepare("UPDATE notifications SET read_at = datetime('now') WHERE member_id = ? AND ref = ? AND read_at IS NULL AND COALESCE(category, '') NOT IN ('todo', 'security')")
        .bind(member.id, b.ref).run();
    } else if (b.all === true) {
      // 全部已讀有上界：頁面打開之後才進來的通知維持未讀
      const f = notifCats(str(b.cat, 60)), c = str(b.upto, 40).match(CURSOR);
      if (!f || !c) return fail(400, '全部已讀的範圍不正確');
      const args = [member.id, ...(f.cats || [])];
      await env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE member_id = ? AND read_at IS NULL AND ${NOTSEC}
        ${f.cats ? `AND category IN (${f.cats.map(() => '?').join(',')})` : ''} ${cursorSql(c, true)}`).bind(...args, ...cursorArgs(c)).run();
    } else if (!Object.keys(b).length) {
      // 舊版用戶端（沒有 body）：標全部但不含帳號安全；下一個版本刪掉
      await env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE member_id = ? AND read_at IS NULL AND ${NOTSEC}`).bind(member.id).run();
    } else return fail(400, '參數不正確');
    return json({ ok: true, ...(await notifCounts()) });
  }
  if (path === '/api/notifications/clear-read' && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `nclear:${member.id}`, 10, 3600)) return fail(429, '操作太頻繁，請稍後再試');
    const r = await env.DB.prepare(`DELETE FROM notifications WHERE member_id = ? AND read_at IS NOT NULL AND ${NOTSEC}`).bind(member.id).run();
    return json({ ok: true, removed: r.meta.changes });
  }
  const mnd = path.match(/^\/api\/notifications\/([a-z0-9]{8,24})$/);
  if (mnd && method === 'DELETE') {
    const g = need(); if (g) return g;
    if (await limited(env, `ndel:${member.id}`, 120, 3600)) return fail(429, '操作太頻繁，請稍後再試');
    // 真的刪除（資料最小化）；帳號安全通知不能刪
    const r = await env.DB.prepare(`DELETE FROM notifications WHERE id = ? AND member_id = ? AND ${NOTSEC}`).bind(mnd[1], member.id).run();
    if (!r.meta.changes) return fail(404, '找不到這則通知');
    return json({ ok: true });
  }
  if (path === '/api/me/notify-prefs' && method === 'GET') {
    const g = need(); if (g) return g;
    return json(notifPrefs());
  }
  if (path === '/api/me/notify-prefs' && method === 'PUT') {
    const g = need(); if (g) return g;
    if (await limited(env, `nprefs:${member.id}`, 30, 600)) return fail(429, '操作太頻繁，請稍後再試');
    const b = await body();
    // 只收白名單裡可以關的類別；security 與 change 不會存進來
    const mute = [...new Set(Array.isArray(b.mute) ? b.mute : [])].filter((c) => MUTABLE.includes(c)).slice(0, 8);
    const val = mute.length ? mute.join(',') : null;
    if (val !== (member.notif_mute || null)) {
      await env.DB.prepare('UPDATE members SET notif_mute = ? WHERE id = ?').bind(val, member.id).run();
      await audit(env, req, member, 'notif.prefs', 'member', member.id, `mute=${mute.join(',')}`);
    }
    member = { ...member, notif_mute: val };
    return json(notifPrefs());
  }

  // ---- 教練發布課表 ----
  if (path === '/api/plans' && method === 'GET') {
    const g = need(); if (g) return g;
    const u = new URL(req.url), week = Number(u.searchParams.get('week'));
    const rows = (await env.DB.prepare(
      `SELECT p.id, p.week_no, p.title, p.phase, p.body, p.created_at, p.team_id, m.name AS author, t.name AS team_name
       FROM plan_posts p LEFT JOIN members m ON m.id = p.author_id LEFT JOIN teams t ON t.id = p.team_id
       WHERE (p.team_id IS NULL OR t.private = 0 OR p.team_id IN (SELECT team_id FROM team_members WHERE member_id = ?1 AND status = 'active') OR ?2 = 1)
       ${week ? 'AND p.week_no = ?3' : ''} ORDER BY p.created_at DESC LIMIT ${week ? 6 : 20}`)
      .bind(member.id, can(member, 'plan') ? 1 : 0, ...(week ? [week] : [])).all()).results;
    return json({ plans: rows });
  }
  if (path === '/api/plans' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body();
    // 教練可以發給全協會或任何分團；分團團長只能發給自己的分團
    if (!can(member, 'plan') && !(str(b.team_id, 16) && teamCan(str(b.team_id, 16), 'appoint'))) return fail(403, '只有教練與分團團長可以發布課表');
    const title = str(b.title, 60), bodyText = str(b.body, 8000);
    const week = Number.isInteger(b.week_no) && b.week_no >= 1 && b.week_no <= 21 ? b.week_no : null;
    if (!title || !bodyText) return fail(400, '標題和課表內容都要填');
    const teamId = str(b.team_id, 16) || null;
    if (teamId && !(await teamIds()).includes(teamId)) return fail(400, '找不到這個分團');
    const id = rid(8);
    await env.DB.prepare('INSERT INTO plan_posts (id, week_no, title, phase, body, author_id, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, week, title, str(b.phase, 20), bodyText, member.id, teamId).run();
    await audit(env, req, member, 'plan.publish', 'plan', id, title);
    // 連結指定協會賽季（?c=club）：教練公告是協會週次，個人週期的會員點進來才不會跑到自己的同號週
    if (b.notify !== false) await notify(env, teamId ? await teamMemberIds(teamId, member.id) : await allMemberIds(env, member.id), 'training',
      { kind: 'plan', title: `新課表：${title}`, body: `${member.title || member.nickname || '教練'} 發布了${week ? ` W${week}` : ''}課表`, url: week ? `/#/plan/${week}?c=club` : '/#/plan' });
    return json({ id });
  }
  const pdel = path.match(/^\/api\/plans\/([\w-]{1,32})$/);
  if (pdel && method === 'DELETE') {
    const g = need(); if (g) return g;
    const post = await env.DB.prepare('SELECT team_id FROM plan_posts WHERE id = ?').bind(pdel[1]).first();
    if (!post) return fail(404, '找不到這則課表');
    if (!can(member, 'plan') && !(post.team_id && teamCan(post.team_id, 'appoint'))) return fail(403, '只有教練與分團團長可以刪除課表');
    await env.DB.prepare('DELETE FROM plan_posts WHERE id = ?').bind(pdel[1]).run();
    await audit(env, req, member, 'plan.delete', 'plan', pdel[1], '');
    return json({ ok: true });
  }

  // ---- 春酒：入場券、報到、獎項與抽獎 ----
  if (path === '/api/my/prizes' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare(
      `SELECT d.id, d.created_at, d.claimed_at, p.name AS prize, p.stage, p.sponsor, e.title, e.id AS event_id
       FROM draws d JOIN prizes p ON p.id = d.prize_id JOIN events e ON e.id = d.event_id
       WHERE d.member_id = ? ORDER BY d.created_at DESC LIMIT 30`).bind(member.id).all()).results;
    return json({ prizes: rows });
  }
  // 我的團購領取：已到貨、還沒領的
  if (path === '/api/my/pickups' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare(`SELECT s.pick_code AS code, s.items, e.id AS event_id, e.title, e.pickup_note AS note FROM signups s JOIN events e ON e.id = s.event_id
      WHERE s.member_id = ? AND s.status = 'in' AND s.pick_code IS NOT NULL AND s.picked_at IS NULL AND e.arrived_at IS NOT NULL ORDER BY e.arrived_at DESC LIMIT 20`).bind(member.id).all()).results;
    return json({ pickups: rows.map((r) => ({ ...r, items: parseQ(r.items) })) });
  }
  if (path === '/api/my/tickets' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare(
      `SELECT t.code, t.guests, t.meal, t.seat, t.table_no, t.checked_in_at, e.id AS event_id, e.title, e.date, e.gather_time, e.place
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN signups s ON s.event_id = t.event_id AND s.member_id = t.member_id AND s.status = 'in'   -- 第二道防線：只有正取的入場券有效
       WHERE t.member_id = ? AND e.date >= ? ORDER BY e.date`)
      .bind(member.id, today()).all()).results;
    return json({ tickets: rows });
  }
  const ml = path.match(/^\/api\/events\/([\w-]{1,32})\/layout$/);
  if (ml) {
    const g = need(); if (g) return g;
    if (method === 'GET') {
      const ev0 = await evById(ml[1]);
      if (!ev0 || !(await canSee(ev0))) return fail(404, '找不到這個活動');
      const r = await env.DB.prepare('SELECT seat_layout FROM events WHERE id = ?').bind(ml[1]).first();
      return json({ layout: r?.seat_layout ? JSON.parse(r.seat_layout) : null });
    }
    if (method === 'POST') {
      if (!teamCan((await evById(ml[1]))?.team_id, 'layout')) return fail(403, '只有行政人員可以設定座位圖');
      const b = await body();
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 20).map((r) => (Array.isArray(r) ? r.slice(0, 12).map((v) => (Number(v) > 0 ? Number(v) : null)) : [])) : null;
      if (!rows?.length) return fail(400, '座位佈局格式不正確');
      const layout = { rows, stage: str(b.stage, 20) || '舞台', foot: str(b.foot, 40), entry: str(b.entry, 20) || '↑ 入口' };
      await env.DB.prepare('UPDATE events SET seat_layout = ? WHERE id = ?').bind(JSON.stringify(layout), ml[1]).run();
      await audit(env, req, member, 'layout.update', 'event', ml[1], `${rows.length} 排`);
      return json({ ok: true, layout });
    }
  }

  const ms = path.match(/^\/api\/events\/([\w-]{1,32})\/seats$/);
  if (ms && method === 'GET') {
    const g = need(); if (g) return g;
    const sev = await evById(ms[1]);
    if (!sev || !(await canSee(sev))) return fail(404, '找不到這個活動');
    const rows = (await env.DB.prepare(
      `SELECT t.table_no, t.note, t.guests, m.name, m.nickname, m.club
       FROM tickets t JOIN members m ON m.id = t.member_id
       WHERE t.event_id = ? ORDER BY t.table_no, m.name`).bind(ms[1]).all()).results;
    const ly = await env.DB.prepare('SELECT seat_layout FROM events WHERE id = ?').bind(ms[1]).first();
    return json({ seats: rows, layout: ly?.seat_layout ? JSON.parse(ly.seat_layout) : null,
      tables: [...new Set(rows.map((r) => r.table_no).filter(Boolean))].sort((a, b) => a - b) });
  }
  // 幹部：排桌（單筆或整批）
  const msa = path.match(/^\/api\/events\/([\w-]{1,32})\/seats\/assign$/);
  if (msa && method === 'POST') {
    const g = need(); if (g) return g;
    if (!teamCan((await evById(msa[1]))?.team_id, 'checkin')) return fail(403, '只有幹部可以排桌');
    const b = await body();
    const list = Array.isArray(b.seats) ? b.seats.slice(0, 400) : [];
    if (!list.length) return fail(400, '沒有要排的資料');
    // 一句 UPDATE … FROM json_each；同一個代碼出現多次時以最後一筆為準（和以前逐筆更新一樣）
    const seats = new Map();
    for (const row of list) { const code = str(row.code, 8).toUpperCase(); if (code) { seats.delete(code); seats.set(code, [code, Number(row.table_no) || null, str(row.note, 60) || null]); } }
    if (!seats.size) return json({ updated: 0 });
    const r = await env.DB.prepare(`UPDATE tickets SET table_no = json_extract(j.value, '$[1]'), note = COALESCE(json_extract(j.value, '$[2]'), tickets.note)
      FROM json_each(?2) j WHERE tickets.event_id = ?1 AND tickets.code = json_extract(j.value, '$[0]')`).bind(msa[1], JSON.stringify([...seats.values()])).run();
    return json({ updated: r.meta.changes });
  }

  const mt = path.match(/^\/api\/events\/([\w-]{1,32})\/tickets$/);
  if (mt && method === 'GET') {
    const g = need(); if (g) return g;
    if (!teamCan((await evById(mt[1]))?.team_id, 'checkin')) return fail(403, '只有幹部可以看報到名單');
    const rows = (await env.DB.prepare(
      `SELECT t.code, t.guests, t.meal, t.seat, t.table_no, t.note, t.checked_in_at, m.id AS member_id, m.name, m.nickname, m.club, m.avatar
       FROM tickets t JOIN members m ON m.id = t.member_id WHERE t.event_id = ? ORDER BY t.table_no, m.name`).bind(mt[1]).all()).results;
    return json({ tickets: rows, checkedIn: rows.filter((r) => r.checked_in_at).length,
      people: rows.reduce((n, r) => n + 1 + (r.guests || 0), 0) });
  }
  const mc = path.match(/^\/api\/events\/([\w-]{1,32})\/checkin$/);
  if (mc && method === 'POST') {
    const g = need(); if (g) return g;
    if (!teamCan((await evById(mc[1]))?.team_id, 'checkin')) return fail(403, '只有幹部可以報到');
    if (await limited(env, `checkin:${member.id}`, 90, 60)) return fail(429, '報到太頻繁，請稍候');
    const b = await body(), code = str(b.code, 8).toUpperCase();
    const t = await env.DB.prepare(`SELECT t.*, m.name FROM tickets t JOIN members m ON m.id = t.member_id
      JOIN signups s ON s.event_id = t.event_id AND s.member_id = t.member_id AND s.status = 'in' WHERE t.event_id = ? AND t.code = ?`)
      .bind(mc[1], code).first();
    if (!t) {
      // 代碼存在但報名已經不是正取（取消、婉拒、移出）：入場券失效
      const dead = await env.DB.prepare('SELECT 1 FROM tickets WHERE event_id = ? AND code = ?').bind(mc[1], code).first();
      return fail(404, dead ? '這張入場券已失效' : '找不到這個入場代碼');
    }
    if (t.checked_in_at) return json({ ok: true, already: true, name: t.name, guests: t.guests, meal: t.meal, seat: t.seat });
    await env.DB.prepare("UPDATE tickets SET checked_in_at = datetime('now'), seat = COALESCE(?, seat) WHERE id = ?")
      .bind(str(b.seat, 20) || null, t.id).run();
    await audit(env, req, member, 'checkin', 'ticket', t.id, `活動 ${mc[1]}`);
    return json({ ok: true, name: t.name, guests: t.guests, meal: t.meal, seat: str(b.seat, 20) || t.seat });
  }
  const mp = path.match(/^\/api\/events\/([\w-]{1,32})\/prizes$/);
  if (mp) {
    const g = need(); if (g) return g;
    const eid = mp[1];
    const pev = await evById(eid);
    if (!pev || !(await canSee(pev))) return fail(404, '找不到這個活動');
    if (method === 'GET') {
      const prizes = (await env.DB.prepare('SELECT id, name, qty, sponsor, sort, stage, note FROM prizes WHERE event_id = ? ORDER BY sort, rowid').bind(eid).all()).results;
      const draws = (await env.DB.prepare('SELECT id, prize_id, member_id, name, created_at, claimed_at FROM draws WHERE event_id = ? ORDER BY created_at').bind(eid).all()).results;
      return json({ prizes, draws });
    }
    if (method === 'POST') {
      if (!teamCan((await evById(eid))?.team_id, 'lottery')) return fail(403, '只有幹部可以設定獎項');
      const b = await body();
      // 批次匯入：{ list: [{stage,name,qty,sponsor,note}, …] }，或貼上文字（每行「[階段] 獎項 x數量 / 贊助」）
      if (Array.isArray(b.list) || typeof b.text === 'string') {
        const rows = Array.isArray(b.list) ? b.list : b.text.split('\n').map((line) => {
          const t = line.trim(); if (!t) return null;
          const stage = t.match(/^\[([^\]]{1,12})\]\s*/)?.[1] || '';
          const rest = t.replace(/^\[[^\]]{1,12}\]\s*/, '');
          const [main, sponsor = ''] = rest.split('/');
          const qty = Number(main.match(/[x×]\s*(\d+)\s*$/i)?.[1]) || 1;
          return { stage, name: main.replace(/[x×]\s*\d+\s*$/i, '').trim(), qty, sponsor: sponsor.trim() };
        }).filter((r) => r && r.name);
        if (!rows.length) return fail(400, '沒有可匯入的獎項');
        let sort = (await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM prizes WHERE event_id = ?').bind(eid).first()).m;
        const list = rows.slice(0, 200).map((r) => [rid(8), str(r.name, 60), Math.max(1, Math.min(Number(r.qty) || 1, 400)), str(r.sponsor, 40), ++sort, str(r.stage, 12), str(r.note, 80)]);
        await env.DB.prepare(`INSERT INTO prizes (id, event_id, name, qty, sponsor, sort, stage, note)
          SELECT json_extract(value, '$[0]'), ?1, json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]')
          FROM json_each(?2)`).bind(eid, JSON.stringify(list)).run();
        return json({ added: Math.min(rows.length, 200) });
      }
      const name = str(b.name, 60);
      if (!name) return fail(400, '請填獎項名稱');
      const id = rid(8);
      await env.DB.prepare('INSERT INTO prizes (id, event_id, name, qty, sponsor, sort, stage, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, eid, name, Math.max(1, Math.min(Number(b.qty) || 1, 400)), str(b.sponsor, 40), Number(b.sort) || 0, str(b.stage, 12), str(b.note, 80)).run();
      return json({ id });
    }
  }
  const md = path.match(/^\/api\/events\/([\w-]{1,32})\/draw$/);
  if (md && method === 'POST') {
    const g = need(); if (g) return g;
    if (!teamCan((await evById(md[1]))?.team_id, 'lottery')) return fail(403, '只有幹部可以抽獎');
    const eid = md[1], b = await body(), prizeId = str(b.prize_id, 32);
    const prize = await env.DB.prepare('SELECT * FROM prizes WHERE id = ? AND event_id = ?').bind(prizeId, eid).first();
    if (!prize) return fail(404, '找不到這個獎項');
    const drawnForPrize = (await env.DB.prepare('SELECT COUNT(*) AS n FROM draws WHERE prize_id = ?').bind(prizeId).first()).n;
    const want = Math.max(1, Math.min(Number(b.count) || 1, prize.qty - drawnForPrize));
    if (want <= 0) return fail(400, '這個獎項已經抽完了');
    // 候選：已報到的人優先；沒有人報到就用已報名的人。預設一個人只中一次
    const onlyCheckedIn = b.onlyCheckedIn !== false;
    const allowRepeat = b.allowRepeat === true;
    const pool = (await env.DB.prepare(
      `SELECT t.member_id, m.name, m.nickname, t.table_no FROM tickets t JOIN members m ON m.id = t.member_id
       JOIN signups s ON s.event_id = t.event_id AND s.member_id = t.member_id AND s.status = 'in'
       WHERE t.event_id = ? ${onlyCheckedIn ? 'AND t.checked_in_at IS NOT NULL' : ''}
         ${allowRepeat ? '' : 'AND t.member_id NOT IN (SELECT member_id FROM draws WHERE event_id = ? AND member_id IS NOT NULL)'}`)
      .bind(...(allowRepeat ? [eid] : [eid, eid])).all()).results;
    if (!pool.length) return fail(400, onlyCheckedIn ? '還沒有人報到，或大家都中過獎了' : '沒有可抽的名單');
    const winners = [];
    for (let i = 0; i < want && pool.length; i++) {
      const k = crypto.getRandomValues(new Uint32Array(1))[0] % pool.length;
      winners.push(pool.splice(k, 1)[0]);
    }
    await env.DB.prepare(`INSERT INTO draws (id, event_id, prize_id, member_id, name)
      SELECT json_extract(value, '$[0]'), ?1, ?2, json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?3)`)
      .bind(eid, prizeId, JSON.stringify(winners.map((w) => [rid(8), w.member_id, w.name]))).run();
    await audit(env, req, member, 'lottery.draw', 'prize', prizeId, `${winners.length} 位`);
    await notify(env, winners.map((w) => w.member_id), 'signup', { kind: 'lottery', title: `恭喜中獎：${prize.name}`, body: '請到台前領獎', url: `/#/e/${eid}`, ref: `e:${eid}` });
    return json({ winners: winners.map((w) => ({ name: w.name, nickname: w.nickname || '', table_no: w.table_no || null })), prize: prize.name, stage: prize.stage || '' });
  }
  const mdc = path.match(/^\/api\/events\/([\w-]{1,32})\/draws\.csv$/);
  if (mdc && method === 'GET') {
    const g = need(); if (g) return g;
    if (!teamCan((await evById(mdc[1]))?.team_id, 'lottery')) return fail(403, '只有幹部可以匯出');
    const rows = (await env.DB.prepare(
      `SELECT d.created_at, p.stage, p.name AS prize, p.sponsor, d.name, m.nickname, t.table_no
       FROM draws d JOIN prizes p ON p.id = d.prize_id
       LEFT JOIN members m ON m.id = d.member_id
       LEFT JOIN tickets t ON t.member_id = d.member_id AND t.event_id = d.event_id
       WHERE d.event_id = ? ORDER BY d.created_at`).bind(mdc[1]).all()).results;
    const esc2 = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return `"${x.replace(/"/g, '""')}"`; };
    const csv = ['時間,階段,獎項,贊助,得獎人,暱稱,桌次',
      ...rows.map((r) => [r.created_at, r.stage, r.prize, r.sponsor, r.name, r.nickname, r.table_no].map(esc2).join(','))].join('\n');
    return new Response(`\ufeff${csv}`, { headers: { ...SEC_HEADERS, 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="draws.csv"' } });
  }

  const mclaim = path.match(/^\/api\/draws\/([\w-]{1,32})\/claim$/);
  if (mclaim && method === 'POST') {
    const g = need(); if (g) return g;
    const dr = await env.DB.prepare('SELECT event_id FROM draws WHERE id = ?').bind(mclaim[1]).first();
    if (!dr || !teamCan((await evById(dr.event_id))?.team_id, 'lottery')) return fail(403, '只有幹部可以確認領獎');
    await env.DB.prepare("UPDATE draws SET claimed_at = datetime('now') WHERE id = ?").bind(mclaim[1]).run();
    await audit(env, req, member, 'lottery.claim', 'draw', mclaim[1], '');
    return json({ ok: true });
  }

  const mdd = path.match(/^\/api\/draws\/([\w-]{1,32})$/);
  if (mdd && method === 'DELETE') {
    const g = need(); if (g) return g;
    const dr = await env.DB.prepare('SELECT event_id, member_id FROM draws WHERE id = ?').bind(mdd[1]).first();
    const dev = dr && await evById(dr.event_id);
    if (!dr || !teamCan(dev?.team_id, 'lottery')) return fail(403, '只有幹部可以重抽');
    await env.DB.prepare('DELETE FROM draws WHERE id = ?').bind(mdd[1]).run();
    await audit(env, req, member, 'lottery.undo', 'draw', mdd[1], '');
    if (dr.member_id) await notify(env, [dr.member_id], 'signup', { kind: 'lottery', title: `抽獎結果更正：${dev.title}`, body: '這次的中獎結果已撤銷，以台上公布為準', url: `/#/e/${dr.event_id}`, ref: `e:${dr.event_id}` });
    return json({ ok: true });
  }

  // ---- 活動統計與問卷結果（活動所屬分團的幹部，或協會幹部）----
  const mst = path.match(/^\/api\/events\/([\w-]{1,32})\/(stats|export\.csv|orders\.csv)$/);
  if (mst && method === 'GET') {
    const g = need(); if (g) return g;
    const ev = await evById(mst[1]);
    if (!ev) return fail(404, '找不到這個活動');
    if (!teamCan(ev.team_id, 'event') && !teamCan(ev.team_id, 'checkin')) return fail(403, '只有這個活動的幹部可以看統計');
    const qs = parseQ(ev.questions);
    // 能審核的人（這場的主辦幹部）看全部狀態；只有報到權限的人只看正取與候補（待審核、未通過、已取消都不給）
    const canReview = teamCan(ev.team_id, 'event');
    let rows = (await env.DB.prepare(
      `SELECT s.member_id, s.name, s.grp, s.dist, s.note, s.status, s.answers, s.created_at, s.paid, s.paid_note, s.attended_at, s.option, s.reg_consent_at,
              s.items, s.amount, s.pay_ref, s.pay_method, s.pay_reported_at, s.picked_at,
              s.review, s.review_note, s.reviewed_at, s.edited_after_review, s.guests AS s_guests, s.meal AS s_meal,
              m.nickname, m.club, m.phone, m.membership, r.name AS reviewer_name, mp.complete AS reg_complete,
              t.guests, t.meal, t.table_no, t.checked_in_at,
              (SELECT group_concat(tm.team_id) FROM team_members tm WHERE tm.member_id = s.member_id AND tm.status = 'active') AS teams
       FROM signups s LEFT JOIN members m ON m.id = s.member_id
       LEFT JOIN members r ON r.id = s.reviewed_by
       LEFT JOIN member_private mp ON mp.member_id = s.member_id
       LEFT JOIN tickets t ON t.event_id = s.event_id AND t.member_id = s.member_id
       WHERE s.event_id = ? ORDER BY s.created_at, s.id`).bind(ev.id).all()).results;
    if (!canReview) rows = rows.filter((r) => r.status === 'in' || r.status === 'wait');
    const isRejected = (r) => r.status === 'cancel' && r.review === 'rejected';
    const teamName = Object.fromEntries((await env.DB.prepare('SELECT id, name FROM teams').all()).results.map((t) => [t.id, t.name]));
    const ans = (r) => { try { return JSON.parse(r.answers || '{}'); } catch { return {}; } };
    // 訂購單：給廠商或對帳用（姓名、品項尺寸數量、金額、繳費、後五碼、領取）
    if (mst[2] === 'orders.csv') {
      const cell = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return `"${x.replace(/"/g, '""')}"`; };
      const defs = parseQ(ev.items), PAID = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
      const cols = defs.flatMap((d) => (d.sizes.length ? d.sizes.map((z) => [d.id, z, `${d.name}（${z}）`]) : [[d.id, '', d.name]]));
      const ins2 = rows.filter((r) => r.status === 'in');
      const lines = ins2.map((r) => { const it = parseQ(r.items);
        return [r.name, r.option || '', ...cols.map(([id, z]) => it.filter((x) => x.id === id && (x.size || '') === z).reduce((n, x) => n + x.qty, 0) || ''),
          r.amount ?? '', PAID[r.paid] || '未繳', r.pay_reported_at ? (PAY_METHODS[r.pay_method] || '') : '', r.pay_ref || '', r.picked_at ? '已領' : ''].map(cell).join(','); });
      const totals = ['合計', '', ...cols.map(([id, z]) => ins2.reduce((n, r) => n + parseQ(r.items).filter((x) => x.id === id && (x.size || '') === z).reduce((u, x) => u + x.qty, 0), 0)),
        ins2.reduce((n, r) => n + (r.amount || 0), 0), '', '', '', ''].map(cell).join(',');
      const csv = '\uFEFF' + [['姓名', '報名組別', ...cols.map((c) => c[2]), '應繳', '繳費', '方式', '後五碼', '領取'].map(cell).join(','), ...lines, totals].join('\r\n');
      await audit(env, req, member, 'event.orders_export', 'event', ev.id, `${ins2.length} 筆`);
      return new Response(csv, { headers: { ...SEC_HEADERS, 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${ev.title}-訂購單.csv`)}` } });
    }
    if (mst[2] === 'export.csv') {
      // 匯出含個資：寫稽核；電話只有可管理會籍的人看得到；開頭是 = + - @ 的儲存格加 ' 防公式注入
      const fullPhone = can(member, 'members') && !READONLY[norm(member.role)];
      const cell = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return `"${x.replace(/"/g, '""')}"`; };
      const STATUS = { in: '正取', wait: '候補', pending: '待審核', cancel: '已取消' };
      const REVIEW = { approved: '核准', rejected: '婉拒' };
      const PAID = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
      const head = ['報名時間', '狀態', '姓名', '暱稱', '分團', '跑團', '項目', '組別', ...(ev.options ? ['報名組別'] : []), ...(fullPhone ? ['電話'] : []), ...(ev.fee || ev.options ? ['繳費', '繳費備註'] : []), '出席',
        ...(ev.kind === 'party' ? ['攜伴', '餐點', '桌次', '報到時間'] : []), ...qs.map((q) => q.label), '備註', ...(canReview ? ['審核', '審核時間', '審核備註'] : [])];
      const lines = rows.map((r) => { const a = ans(r); return [r.created_at, isRejected(r) ? '未通過' : STATUS[r.status] || r.status, r.name, r.nickname,
        (r.teams || '').split(',').filter(Boolean).map((t) => teamName[t] || t).join('、'), r.club, r.dist === 'hm' ? '半馬' : '全馬', r.grp,
        ...(ev.options ? [r.option || ''] : []), ...(fullPhone ? [r.phone] : []), ...(ev.fee || ev.options ? [PAID[r.paid] || '', r.paid_note] : []), r.attended_at || r.checked_in_at || '',
        ...(ev.kind === 'party' ? [r.guests ?? r.s_guests ?? '', r.meal || r.s_meal || '', r.table_no ?? '', r.checked_in_at] : []),
        ...qs.map((q) => (Array.isArray(a[q.id]) ? a[q.id].join('、') : a[q.id] ?? '')), r.note,
        ...(canReview ? [REVIEW[r.review] || '', r.reviewed_at || '', r.review_note || ''] : [])].map(cell).join(','); });
      await audit(env, req, member, 'event.export', 'event', ev.id, `${rows.length} 筆`);
      const fname = encodeURIComponent(`${ev.date}-${ev.title}.csv`);
      return new Response(`﻿${[head.map(cell).join(','), ...lines].join('\r\n')}`, { headers: { ...SEC_HEADERS, 'cache-control': 'no-store',
        'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="event.csv"; filename*=UTF-8''${fname}` } });
    }
    const live = rows.filter((r) => r.status !== 'cancel'), ins = live.filter((r) => r.status === 'in');
    const pend = rows.filter((r) => r.status === 'pending');
    const tally = (list, f) => { const o = {}; for (const r of list) for (const k of [].concat(f(r)).filter((x) => x !== '' && x != null)) o[k] = (o[k] || 0) + 1; return o; };
    const byDay = tally(live, (r) => r.created_at.slice(0, 10));
    return json({
      title: ev.title, date: ev.date, kind: ev.kind, capacity: ev.capacity,
      canReview, requireApproval: !!ev.require_approval, seatsLeft: ev.capacity ? Math.max(0, ev.capacity - ins.length) : null,
      payDuePassed: (() => { const due = parseQ(ev.pay_info, {})?.due; return !!due && due < today(); })(),
      total: { in: ins.length, wait: rows.filter((r) => r.status === 'wait').length, pending: pend.length, pendingGuests: pend.reduce((n, r) => n + (r.s_guests || 0), 0),
        rejected: rows.filter(isRejected).length, cancel: rows.filter((r) => r.status === 'cancel' && !isRejected(r)).length,
        guests: ins.reduce((n, r) => n + (r.guests || 0), 0), checkedIn: ins.filter((r) => r.checked_in_at).length,
        attended: ins.filter((r) => r.attended_at || r.checked_in_at).length,
        members: ins.filter((r) => r.membership === 'active').length },
      fee: ev.fee || 0, options: parseQ(ev.options), groupReg: !!ev.group_reg,
      byOption: parseQ(ev.options).length ? tally(ins, (r) => r.option || '未選') : null,
      regReady: ev.group_reg ? ins.filter((r) => r.reg_consent_at).length : null,
      money: ev.fee || parseQ(ev.options).some((o) => o.price) || parseQ(ev.items).some((i) => i.price) ? (() => { const price = Object.fromEntries(parseQ(ev.options).map((o) => [o.name, o.price]));
        // 新的報名有伺服器算好的金額；舊資料照組別價格推算
        const due = (r) => (r.amount != null ? r.amount : (r.option && price[r.option] != null ? price[r.option] : ev.fee || 0) * (1 + (r.guests || 0)));
        const owe = ins.filter((r) => r.paid !== 'waived' && r.paid !== 'refunded' && due(r) > 0);
        return { expected: owe.reduce((n, r) => n + due(r), 0),
          collected: owe.filter((r) => r.paid === 'paid').reduce((n, r) => n + due(r), 0),
          reported: owe.filter((r) => r.paid !== 'paid' && r.pay_reported_at).reduce((n, r) => n + due(r), 0),
          reportedN: owe.filter((r) => r.paid !== 'paid' && r.pay_reported_at).length,
          counts: tally(ins, (r) => r.paid || 'unpaid'), payInfo: parseQ(ev.pay_info, null) }; })() : null,
      // 團購：每項每個尺寸的數量、成團門檻
      items: parseQ(ev.items).map((d) => { const by = {}; let total = 0;
        for (const r of ins) for (const x of parseQ(r.items)) if (x.id === d.id) { by[x.size || '—'] = (by[x.size || '—'] || 0) + x.qty; total += x.qty; }
        return { ...d, total, by }; }),
      minQty: ev.min_qty || null, picked: ins.filter((r) => r.picked_at).length,
      people: (canReview ? rows : live).map((r) => ({ member_id: r.member_id, name: r.name, nickname: r.nickname, status: isRejected(r) ? 'rejected' : r.status,
        guests: r.guests ?? r.s_guests ?? 0, option: r.option || null, regOk: !!r.reg_consent_at,
        amount: r.amount, items: parseQ(r.items), payRef: r.pay_ref, payMethod: r.pay_method, payReported: r.pay_reported_at, picked: !!r.picked_at,
        paid: r.paid, paid_note: r.paid_note, attended: !!(r.attended_at || r.checked_in_at), created_at: r.created_at,
        ...(canReview ? { reviewNote: isRejected(r) ? r.review_note || null : null, reviewedAt: r.reviewed_at || null, reviewerName: r.reviewer_name || null,
          review: r.review || null, edited: !!r.edited_after_review, regComplete: !!r.reg_complete } : {}) })),
      byTeam: Object.entries(tally(ins, (r) => (r.teams || '').split(',').filter(Boolean))).map(([k, n]) => ({ k: teamName[k] || k, n })),
      byGroup: tally(ins, (r) => `${r.dist === 'hm' ? '半馬' : '全馬'} ${r.grp}`),
      byMeal: ev.kind === 'party' ? tally(ins, (r) => r.meal || '未指定') : null,
      byDay: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)),
      questions: qs.map((q) => q.type === 'text'
        ? { ...q, answers: ins.map((r) => ({ name: r.nickname || r.name, text: ans(r)[q.id] })).filter((x) => x.text) }
        : { ...q, counts: q.options.map((o) => ({ o, n: ins.filter((r) => [].concat(ans(r)[q.id] || []).includes(o)).length })),
            answered: ins.filter((r) => ans(r)[q.id] != null).length }),
    });
  }

  // ---- 分團公告欄與里程排行榜 ----
  const mtp = path.match(/^\/api\/teams\/([\w-]{1,16})\/(posts|leaderboard)(?:\/([\w-]{1,32}))?$/);
  if (mtp) {
    const g = need(); if (g) return g;
    const tid = mtp[1], team = await env.DB.prepare('SELECT id, name, private FROM teams WHERE id = ?').bind(tid).first();
    if (!team) return fail(404, '找不到這個分團');
    const canRead = !team.private || inTeam(tid) || teamCan(tid, 'roster');
    if (mtp[2] === 'posts') {
      if (method === 'GET') {
        if (!canRead) return fail(403, '這是私密分團的公告');
        const before = str(new URL(req.url).searchParams.get('before'), 20);
        const rows = (await env.DB.prepare(`SELECT id, author_id, author_name, title, body, pinned, created_at FROM team_posts WHERE team_id = ?
          ${before ? 'AND created_at < ?' : ''} ORDER BY pinned DESC, created_at DESC LIMIT 21`).bind(tid, ...(before ? [before] : [])).all()).results;
        return json({ posts: rows.slice(0, 20), next: rows.length > 20 ? rows[19].created_at : null, canPost: teamCan(tid, 'event') });
      }
      if (method === 'POST' && !mtp[3]) {
        if (!teamCan(tid, 'event')) return fail(403, '只有分團團長與幹部可以發公告');
        const b = await body(), title = str(b.title, 60), text = str(b.body, 3000);
        if (!title) return fail(400, '請填標題');
        const id = rid(8);
        await env.DB.prepare('INSERT INTO team_posts (id, team_id, author_id, author_name, title, body, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, tid, member.id, member.nickname || member.name, title, text, b.pinned === true ? 1 : 0).run();
        await audit(env, req, member, 'team.post', 'team', tid, title);
        // 通知中心的標題不加分團前綴，發送者由用戶端依分類與 ref 顯示；鎖定畫面仍帶分團名稱
        if (b.notify !== false) await notify(env, await teamMemberIds(tid, member.id), 'announce', { kind: 'event', title, body: text.slice(0, 80), url: `/#/t/${tid}`, ref: `t:${tid}`,
          push: { title: `${team.name}公告：${title}` } });
        return json({ id });
      }
      if (method === 'DELETE' && mtp[3]) {
        const post = await env.DB.prepare('SELECT author_id FROM team_posts WHERE id = ? AND team_id = ?').bind(mtp[3], tid).first();
        if (!post) return fail(404, '找不到這則公告');
        if (post.author_id !== member.id && !teamCan(tid, 'appoint')) return fail(403, '只有發文的人或團長可以刪除');
        await env.DB.prepare('DELETE FROM team_posts WHERE id = ?').bind(mtp[3]).run();
        await audit(env, req, member, 'team.post_delete', 'team', tid, mtp[3]);
        return json({ ok: true });
      }
    }
    if (mtp[2] === 'leaderboard' && method === 'GET') {
      // 只有團員看得到；只列出自己同意上榜的人
      if (!inTeam(tid) && !teamCan(tid, 'roster')) return fail(403, '加入分團後才看得到排行榜');
      const period = new URL(req.url).searchParams.get('period') === 'month' ? 'month' : 'week';
      const now = new Date(), from = period === 'month' ? `${tpDate(now).slice(0, 7)}-01`
        : tpDate(new Date(now.getTime() - ((taipei(now).getUTCDay() + 6) % 7) * 864e5));
      const rows = (await env.DB.prepare(`SELECT m.id, m.name, m.nickname, m.avatar, ROUND(SUM(COALESCE(l.km, 0)), 1) AS km, COUNT(l.id) AS n
        FROM members m JOIN team_members tm ON tm.member_id = m.id AND tm.team_id = ? AND tm.status = 'active'
        JOIN training_logs l ON l.member_id = m.id AND l.date BETWEEN ? AND ? AND l.status != 'skip'
        WHERE m.show_rank = 1 GROUP BY m.id HAVING km > 0 ORDER BY km DESC LIMIT 30`).bind(tid, from, tpDate(now)).all()).results;
      return json({ period, from, rows, me: !!member.show_rank });
    }
  }
  if (path === '/api/me/show-rank' && method === 'POST') {
    const g = need(); if (g) return g;
    const on = (await body()).on === true ? 1 : 0;
    await env.DB.prepare('UPDATE members SET show_rank = ? WHERE id = ?').bind(on, member.id).run();
    await audit(env, req, member, 'privacy.show_rank', 'member', member.id, on ? '開啟' : '關閉');
    return json({ ok: true });
  }

  // ---- 管理總覽與群發通知 ----
  if (path === '/api/admin/overview' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'roster')) return fail(403, '只有幹部可以看總覽');
    const one = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first())?.n || 0;
    const m0 = `${tpDate(new Date()).slice(0, 7)}-01`;
    const growth = (await env.DB.prepare(`SELECT substr(created_at, 1, 7) AS m, COUNT(*) AS n FROM members
      WHERE created_at >= date('now', 'start of month', '-11 months') GROUP BY m ORDER BY m`).all()).results;
    const teamSizes = (await env.DB.prepare(`SELECT t.id, t.name, t.color, COUNT(tm.member_id) AS n FROM teams t
      LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.status = 'active' GROUP BY t.id ORDER BY t.sort`).all()).results;
    const att = await env.DB.prepare(`SELECT SUM(CASE WHEN s.attended_at IS NOT NULL THEN 1 ELSE 0 END) AS a, COUNT(*) AS n FROM signups s
      JOIN events e ON e.id = s.event_id WHERE s.status = 'in' AND e.kind NOT IN ('party', 'survey') AND e.date BETWEEN date('now', '-30 days') AND date('now', '-1 day')`).first();
    return json({
      members: await one('SELECT COUNT(*) AS n FROM members'),
      newThisMonth: await one('SELECT COUNT(*) AS n FROM members WHERE created_at >= ?', m0),
      active30: await one("SELECT COUNT(*) AS n FROM members WHERE last_seen >= datetime('now', '-30 days')"),
      association: await one("SELECT COUNT(*) AS n FROM members WHERE membership = 'active'"),
      applied: await one("SELECT COUNT(*) AS n FROM members WHERE membership = 'applied'"),
      expiring: await one("SELECT COUNT(*) AS n FROM members WHERE membership = 'active' AND paid_until BETWEEN date('now') AND date('now', '+30 days')"),
      events30: await one("SELECT COUNT(*) AS n FROM events WHERE date BETWEEN date('now', '-30 days') AND date('now')"),
      upcoming: await one("SELECT COUNT(*) AS n FROM events WHERE date BETWEEN date('now') AND date('now', '+30 days')"),
      signups30: await one("SELECT COUNT(*) AS n FROM signups WHERE created_at >= datetime('now', '-30 days') AND status != 'cancel'"),
      logs7: await one("SELECT COUNT(*) AS n FROM training_logs WHERE date >= date('now', '-6 days')"),
      pushSubs: await one('SELECT COUNT(DISTINCT member_id) AS n FROM push_subs'),
      attendance: att?.n ? Math.round((att.a || 0) / att.n * 100) : null,
      growth, teamSizes,
    });
  }
  // staging 驗證「呼叫自己會不會拿到新的額度」（只有 SELFTEST=1 的環境有這個 API，正式站沒有）：
  //   ctx.exports.Jobs 的呼叫鏈跑 3 層，每層依序 40 句 SELECT 1、一個 60 句的 DB.batch、約 8 ms 的 CPU，回報每層成功或失敗與錯誤原文
  //   只有理事長、要通過通行金鑰再驗證；一小時 3 次；寫稽核
  if (path === '/api/admin/selftest' && method === 'POST' && env.SELFTEST === '1') {
    const g = need(); if (g) return g;
    if (norm(member.role) !== 'chair') return fail(403, '只有理事長可以執行');
    { const su = await needStepUp(true); if (su) return su; }
    if (await limited(env, `selftest:${member.id}`, 3, 3600)) return fail(429, '一小時最多 3 次');
    const exp = env.ctx?.exports?.Jobs;
    if (!exp) return fail(503, '這個環境沒有 ctx.exports');
    // 先寫稽核再呼叫：如果額度真的和父執行共用，呼叫之後父執行可能已經沒有額度寫稽核
    await audit(env, req, member, 'admin.selftest', 'system', null, '開始');
    env.budget.take('rpc');
    let layers;
    try { layers = await exp.selftest({ depth: 1 }); } catch (e) { layers = [{ layer: 1, error: String(e?.message || e).slice(0, 300) }]; }
    await audit(env, req, member, 'admin.selftest', 'system', null, layers.map((l) => `第 ${l.layer} 層 ${l.error ? '失敗' : '成功'}`).join('、'));
    return json({ layers });
  }
  if (path === '/api/admin/broadcast' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !(can(member, 'members') && !READONLY[norm(member.role)])) return fail(403, '只有理事長與行政人員可以群發通知');
    if (await limited(env, `broadcast:${member.id}`, 10, 3600)) return fail(429, '一小時最多群發 10 次');
    const b = await body(), title = str(b.title, 60), text = str(b.body, 300), link = str(b.url, 200);
    if (!title) return fail(400, '請填標題');
    // 系統安全通知的用語保留給伺服器（單獨的「登入」不擋，避免擋到一般公告）
    // 比對前先 NFKC、去掉零寬等格式字元與空白；異體字與簡體也算。內文只擋會冒充安全通知的說法
    const flat = (s) => s.normalize('NFKC').replace(/[\p{Cf}\s]/gu, '');
    if (/新[裝装]置|[裝装]置登入|新[設设]備|通行[金密][鑰钥]|身[分份]([更变變]新|[變变]更)|理事[長长]|登出|[帳帐][號号户戶]|密[碼码]|[驗验][證证]/.test(flat(title))) return fail(400, '這個標題保留給系統安全通知');
    if (/新[裝装]置|新[設设]備|通行[金密][鑰钥]|登出所有|是不是你本人|身[分份]([更变變]新|[變变]更)|密[碼码]|[驗验][證证]碼/.test(flat(text))) return fail(400, '內文不能用系統安全通知的說法');
    if (link && !/^\/#\/[\w/?=&.-]*$/.test(link)) return fail(400, '連結只能是站內頁面，例如 /#/e/活動代碼');
    const teams2 = Array.isArray(b.teams) ? b.teams.map((x) => str(x, 16)).filter(Boolean).slice(0, 30) : [];
    const roles = Array.isArray(b.roles) ? b.roles.filter((r) => ROLES[r]) : [];
    const ms = Array.isArray(b.membership) ? b.membership.filter((r) => MEMBERSHIP[r]) : [];
    const where = [], args = [];
    if (teams2.length) { where.push(`id IN (SELECT member_id FROM team_members WHERE status = 'active' AND team_id IN (${teams2.map(() => '?').join(',')}))`); args.push(...teams2); }
    if (roles.length) { where.push(`role IN (${roles.map(() => '?').join(',')})`); args.push(...roles); }
    if (ms.length) { where.push(`membership IN (${ms.map(() => '?').join(',')})`); args.push(...ms); }
    const ids = (await env.DB.prepare(`SELECT id FROM members ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).bind(...args).all()).results.map((r) => r.id);
    if (b.dryRun === true) return json({ count: ids.length });
    if (!ids.length) return fail(400, '沒有符合條件的人');
    // 群發一律是公告，不接受用戶端指定分類；稽核 detail 的「標題｜」格式是回填比對群發的依據，不要改
    // 鎖定畫面沒有分類色磚，標題前面加上來源，跟分團公告一樣
    await notify(env, ids, 'announce', { kind: 'broadcast', title, body: text, url: link || null, push: { title: `協會公告：${title}` } });
    await audit(env, req, member, 'broadcast', 'members', null, `${title}｜${ids.length} 人${teams2.length ? `｜分團 ${teams2.join(',')}` : ''}${roles.length ? `｜身分 ${roles.join(',')}` : ''}${ms.length ? `｜會籍 ${ms.join(',')}` : ''}`);
    return json({ count: ids.length });
  }

  // ---- 分團 ----
  if (path === '/api/teams' && method === 'GET') {
    const g = need(); if (g) return g;
    return json({ teams: await listTeams(), roles: TEAM_ROLES });
  }
  if (path === '/api/teams' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以新增分團');
    const t = readTeam(await body(), true);
    if (t.error) return fail(400, t.error);
    if ((await teamIds()).length >= 30) return fail(400, '分團最多 30 個');
    const id = rid(4);
    await env.DB.prepare('INSERT INTO teams (id, name, intro, color, line_url, join_policy, private, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, t.name, t.intro, t.color, t.line_url, t.join_policy, t.private, t.sort ?? 50).run();
    await audit(env, req, member, 'team.create', 'team', id, t.name);
    return json({ id });
  }
  // 待審核的入團申請：列出我有權核准的所有分團（管理後台集中處理）
  if (path === '/api/teams/pending' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = await pendingRows(), out = await pendingJoins(rows);
    // 沒有幹部的「本團自己管理」分團：提醒理事長先指派團長
    const orphan = can(member, 'roles') ? [...new Set(rows.filter((r) => r.self_managed && !out.includes(r)).map((r) => r.team_id))] : [];
    return json({ pending: out, needLead: orphan });
  }
  const mtm = path.match(/^\/api\/teams\/([\w-]{1,16})(?:\/(join|leave|members))?$/);
  if (mtm) {
    const g = need(); if (g) return g;
    const tid = mtm[1], sub = mtm[2];
    const team = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(tid).first();
    if (!team) return fail(404, '找不到這個分團');
    if (!sub && method === 'PUT') {
      // 理事長、行政人員可以改全部；團長只能改介紹與 LINE 群組連結
      const full = can(member, 'settings');
      if (!full && !teamCan(tid, 'appoint')) return fail(403, '只有團長或行政人員可以修改分團資料');
      const t = readTeam(await body(), full);
      if (t.error) return fail(400, t.error);
      if (full) await env.DB.prepare('UPDATE teams SET name = ?, intro = ?, color = ?, line_url = ?, join_policy = ?, private = ?, self_managed = ?, sort = COALESCE(?, sort) WHERE id = ?')
        .bind(t.name, t.intro, t.color, t.line_url, t.join_policy, t.private, t.self_managed, t.sort, tid).run();
      if (full && t.name !== team.name) await env.DB.prepare('UPDATE members SET club = ? WHERE main_team = ?').bind(t.name, tid).run();
      else await env.DB.prepare('UPDATE teams SET intro = ?, line_url = ? WHERE id = ?').bind(t.intro, t.line_url, tid).run();
      await audit(env, req, member, 'team.update', 'team', tid, t.name || team.name);
      return json({ ok: true });
    }
    if (!sub && method === 'DELETE') {
      if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以刪除分團');
      await env.DB.batch([
        env.DB.prepare('UPDATE events SET team_id = NULL WHERE team_id = ?').bind(tid),
        env.DB.prepare('UPDATE plan_posts SET team_id = NULL WHERE team_id = ?').bind(tid),
        env.DB.prepare('DELETE FROM team_members WHERE team_id = ?').bind(tid),
        env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(tid),
      ]);
      await audit(env, req, member, 'team.delete', 'team', tid, team.name);
      return json({ ok: true });
    }
    // 申請加入：一律由該團的團長或幹部核准；退出：主團不能自己退，由管理員調整
    if (sub === 'join' && method === 'POST') {
      if (myTeams[tid]) return json({ status: myTeams[tid].status });
      if (await limited(env, `teamjoin:${member.id}`, 10, 3600)) return fail(429, '申請太頻繁，請稍後再試');
      await env.DB.prepare("INSERT INTO team_members (team_id, member_id, status) VALUES (?, ?, 'pending')").bind(tid, member.id).run();
      await audit(env, req, member, 'team.join', 'team', tid, `${team.name}（申請）`);
      const mgr = (await env.DB.prepare("SELECT member_id FROM team_members WHERE team_id = ? AND role IN ('lead','officer') AND status = 'active'").bind(tid).all()).results.map((r) => r.member_id);
      const jmsg = { kind: 'system', title: `${team.name}：有人申請加入`, ref: `join:${tid}:${member.id}`, push: { body: '點開審核' } };
      if (mgr.length) await notify(env, mgr, 'todo', { ...jmsg, body: `${member.nickname || '一位跑友'} 想加入${team.name}，請到分團頁審核`, url: `/#/t/${tid}` });
      // 分團還沒有團長或幹部：改通知協會管理員（一般分團可以直接核准；本團自己管理的分團請理事長先指派團長）
      else await notify(env, (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair', 'staff')").all()).results.map((r) => r.id), 'todo',
        { ...jmsg, body: `${member.nickname || '一位跑友'} 想加入${team.name}，請到管理後台審核`, url: '/#/admin?tab=teams' });
      return json({ status: 'pending' });
    }
    if (sub === 'leave' && method === 'POST') {
      if (member.main_team === tid && myTeams[tid]?.status === 'active') return fail(403, '這是你的主團，要更換請聯絡管理員');
      if (myTeams[tid]?.role === 'lead') return fail(400, '團長要先請理事長指派新團長');
      await env.DB.prepare('DELETE FROM team_members WHERE team_id = ? AND member_id = ?').bind(tid, member.id).run();
      await audit(env, req, member, 'team.leave', 'team', tid, team.name);
      return json({ ok: true });
    }
    if (sub === 'members' && method === 'GET') {
      if (!teamCan(tid, 'roster')) return fail(403, '只有這個分團的團長與幹部可以看名冊');
      // 一次 50 人；有關鍵字就只查符合的（姓名、暱稱）
      const u = new URL(req.url), q = str(u.searchParams.get('q'), 20), after = Math.min(1e6, Math.max(0, Math.floor(Number(u.searchParams.get('after'))) || 0));
      const cols = 'm.id, m.name, m.nickname, m.avatar, m.dist, m.grp, m.membership, tm.role, tm.title, tm.status, tm.created_at';
      const like = q ? ' AND (m.name LIKE ?2 OR m.nickname LIKE ?2)' : '';
      const args = [tid, ...(q ? [`%${q.replace(/[%_]/g, '')}%`] : [])];
      const rows = (await env.DB.prepare(
        `SELECT ${cols} FROM team_members tm JOIN members m ON m.id = tm.member_id WHERE tm.team_id = ?1 AND tm.status = 'active'${like}
         ORDER BY CASE tm.role WHEN 'lead' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END, m.name LIMIT 51 OFFSET ${after}`).bind(...args).all()).results;
      const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM team_members tm JOIN members m ON m.id = tm.member_id
         WHERE tm.team_id = ?1 AND tm.status = 'active'${like}`).bind(...args).first()).n;
      const pending = after ? [] : (await env.DB.prepare(`SELECT ${cols} FROM team_members tm JOIN members m ON m.id = tm.member_id
         WHERE tm.team_id = ? AND tm.status = 'pending' ORDER BY tm.created_at LIMIT 100`).bind(tid).all()).results;
      const own = await selfManaged(tid);
      return json({ members: rows.slice(0, 50), next: rows.length > 50 ? after + 50 : null, total, pending, selfManaged: own,
        can: { approve: await canManageMembers(tid, 'approve'), appoint: await canManageMembers(tid, 'appoint'), lead: can(member, 'roles'),
          add: own ? teamOwn(tid, 'approve') : can(member, 'members') && !READONLY[norm(member.role)] } });
    }
    if (sub === 'members' && method === 'POST') {
      // action：add（協會幹部把人加進分團）｜approve｜remove｜role
      const b = await body(), mid = str(b.member_id, 32), action = str(b.action, 10);
      const target = await env.DB.prepare('SELECT tm.*, m.name FROM members m LEFT JOIN team_members tm ON tm.member_id = m.id AND tm.team_id = ? WHERE m.id = ?').bind(tid, mid).first();
      if (!target) return fail(404, '找不到這位跑友');
      const role = TEAM_ROLES[b.role] ? b.role : 'member';
      if (action === 'add') {
        // 理事長可以在任何分團指派團長（包含耕建築這類本團自己管理的分團，由公司指定人選後交給理事長設定）
        const chairLead = role === 'lead' && can(member, 'roles');
        if (role === 'officer' && !(can(member, 'roles') || teamOwn(tid, 'appoint'))) return fail(403, '分團幹部要由理事長或該團團長指派');
        if (!chairLead && (await selfManaged(tid)) && target.status !== 'pending' && role === 'member') return fail(403, '本團自己管理的分團，只能核准已申請的人');
        if (!chairLead && (await selfManaged(tid) ? !teamOwn(tid, 'approve') : !(can(member, 'members') && !READONLY[norm(member.role)])))
          return fail(403, (await selfManaged(tid)) ? `${team.name}的成員只由${team.name}的團長與幹部處理` : '只有協會幹部可以直接把人加進分團');
        if (role === 'lead' && !can(member, 'roles')) return fail(403, '團長只能由理事長指派');
        await env.DB.prepare(`INSERT INTO team_members (team_id, member_id, role, status) VALUES (?, ?, ?, 'active')
          ON CONFLICT(team_id, member_id) DO UPDATE SET status = 'active', role = CASE WHEN excluded.role = 'lead' THEN 'lead' ELSE role END`).bind(tid, mid, role).run();
        // 以團員身分加入＝把這團設成主團（一般團員只屬於一個分團）
        if (role === 'member') await env.DB.batch([
          env.DB.prepare('UPDATE members SET main_team = ?, club = ? WHERE id = ?').bind(tid, team.name, mid),
          env.DB.prepare("DELETE FROM team_members WHERE member_id = ? AND role = 'member' AND team_id != ?").bind(mid, tid),
        ]);
        // 已經在團裡的人，ON CONFLICT 只會升成團長；通知依實際寫入的身分，不依要求的身分
        const eff = (await env.DB.prepare('SELECT role FROM team_members WHERE team_id = ? AND member_id = ?').bind(tid, mid).first())?.role || role;
        await audit(env, req, member, 'team.add', 'member', mid, `${team.name}／${TEAM_ROLES[eff]}`);
        if (target.status === 'pending') await settleTodo(env, `join:${tid}:${mid}`);
        // 真的拿到團長、幹部權限才歸帳號安全；新加入的一般團員歸會籍與分團；身分沒變就不通知
        if (eff !== 'member' && eff !== target.role) await securityNotify(env, [mid], { title: `你成為${team.name}${TEAM_ROLES[eff]}`, body: `你在${team.name}的身分是${TEAM_ROLES[eff]}，可以管理分團成員與活動`, url: `/#/t/${tid}`, ref: `t:${tid}`,
          push: { title: `${team.name}：身分更新`, body: '點開查看' } });
        else if (target.status !== 'active') await notify(env, [mid], 'membership', { kind: 'system', title: `你已加入${team.name}`, body: team.line_url ? '記得也加入分團的 LINE 群組' : '', url: `/#/t/${tid}`, ref: `t:${tid}` });
        return json({ ok: true });
      }
      if (!target.team_id) return fail(404, '這位跑友不在這個分團');
      // 動到團長（撤換或移除）一律只有理事長可以
      if (target.role === 'lead' && !can(member, 'roles')) return fail(403, '團長只能由理事長調整');
      if (action === 'approve') {
        if (!(await canManageMembers(tid, 'approve'))) return fail(403, '只有這個分團的團長與幹部可以核准');
        await env.DB.prepare("UPDATE team_members SET status = 'active' WHERE team_id = ? AND member_id = ?").bind(tid, mid).run();
        await audit(env, req, member, 'team.approve', 'member', mid, team.name);
        // 還沒有主團的人，第一個核准的分團就當主團
        await env.DB.prepare('UPDATE members SET main_team = ?, club = ? WHERE id = ? AND main_team IS NULL').bind(tid, team.name, mid).run();
        await settleTodo(env, `join:${tid}:${mid}`);
        await notify(env, [mid], 'membership', { kind: 'system', title: `${team.name}：申請通過`, body: team.line_url ? '歡迎加入！記得也加入分團的 LINE 群組' : '歡迎加入！', url: `/#/t/${tid}`, ref: `t:${tid}` });
        return json({ ok: true });
      }
      if (action === 'remove') {
        if (!(await canManageMembers(tid, target.role === 'member' ? 'approve' : 'appoint'))) return fail(403, '沒有移除的權限');
        await env.DB.prepare('DELETE FROM team_members WHERE team_id = ? AND member_id = ?').bind(tid, mid).run();
        // 結尾的 ｜team=分團 id：還原備份或 Time Travel 後靠它把這個人再移出一次（tools/restore-sql.mjs）
        await audit(env, req, member, target.status === 'pending' ? 'team.reject' : 'team.remove', 'member', mid, `${team.name}｜team=${tid}`);
        if (target.status === 'pending') {
          await settleTodo(env, `join:${tid}:${mid}`);
          if (mid !== member.id) await notify(env, [mid], 'membership', { kind: 'system', title: `${team.name}：這次沒有通過申請`, body: '可以看看其他分團，或之後再申請一次', url: '/#/teams', ref: `t:${tid}` });
        }
        return json({ ok: true });
      }
      if (action === 'role') {
        if (role === 'lead' ? !can(member, 'roles') : !(await canManageMembers(tid, 'appoint'))) return fail(403, role === 'lead' ? '團長只能由理事長指派' : '只有團長可以指派幹部');
        if (mid === member.id && !can(member, 'roles')) return fail(400, '不能調整自己的分團身分');
        // 帳號安全通知關不掉，來回切換身分會一直震動對方的手機：同一人一小時最多調整 5 次
        if (await limited(env, `teamrole:${tid}:${mid}`, 5, 3600)) return fail(429, '操作太頻繁，請稍後再試');
        await env.DB.prepare("UPDATE team_members SET role = ?, title = ?, status = 'active' WHERE team_id = ? AND member_id = ?")
          .bind(role, str(b.title, 12) || null, tid, mid).run();
        // 結尾的 ｜team=分團 id｜role=代碼：還原後照最後一次重設分團身分（降級不會跟著倒回去；tools/restore-sql.mjs）
        await audit(env, req, member, 'team.role', 'member', mid, `${team.name}／${TEAM_ROLES[role]}${b.title ? `／${str(b.title, 12)}` : ''}｜team=${tid}｜role=${role}`);
        if (target.role !== role || (target.title || null) !== (str(b.title, 12) || null)) await securityNotify(env, [mid], { title: `${team.name}：身分改為${TEAM_ROLES[role]}`, body: `你在${team.name}的身分是${str(b.title, 12) || TEAM_ROLES[role]}`, url: `/#/t/${tid}`, ref: `t:${tid}`,
          push: { title: `${team.name}：身分更新`, body: '點開查看' } });
        return json({ ok: true });
      }
      return fail(400, '不支援的操作');
    }
  }

  // ---- 名冊與角色（理事長指派）----
  // 名冊一律帶條件查詢、一次 50 筆：q 姓名／暱稱／跑團／會員編號｜membership｜role（staff＝所有幹部）｜team｜after 分頁
  if (path === '/api/members' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'roster')) return fail(403, '只有幹部可以看名冊');
    const u = new URL(req.url), sp = (k, n) => str(u.searchParams.get(k), n);
    const q = sp('q', 20).replace(/[%_]/g, ''), ms = sp('membership', 10), role = sp('role', 12), team = sp('team', 16), after = Math.min(1e6, Math.max(0, Math.floor(Number(u.searchParams.get('after'))) || 0));
    const where = [], args = [];
    if (q) { where.push('(name LIKE ? OR nickname LIKE ? OR club LIKE ? OR member_no = ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, q); }
    if (MEMBERSHIP[ms]) { where.push('membership = ?'); args.push(ms); }
    if (role === 'officers') where.push("role NOT IN ('member')");
    else if (ROLES[role]) { where.push('role = ?'); args.push(role); }
    if (team === 'none') where.push('main_team IS NULL');
    else if (team) { where.push("id IN (SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active')"); args.push(team); }
    const counts = Object.fromEntries((await env.DB.prepare('SELECT membership, COUNT(*) AS n FROM members GROUP BY membership').all()).results.map((r) => [r.membership || 'none', r.n]));
    const meta = { roles: ROLES, perms: PERMS, membership: MEMBERSHIP, memberTypes: MEMBER_TYPES, counts, total: Object.values(counts).reduce((a2, b2) => a2 + b2, 0) };
    if (!where.length) return json({ members: [], next: null, matched: 0, needFilter: true, ...meta });
    const W = `WHERE ${where.join(' AND ')}`;
    const rows = (await env.DB.prepare(
      `SELECT id, name, nickname, club, dist, grp, role, title, avatar, created_at, main_team,
              membership, member_type, member_no, joined_on, paid_until, membership_note, phone,
              (SELECT json_group_array(json_object('t', team_id, 'r', role, 's', status)) FROM team_members WHERE member_id = members.id) AS teams
       FROM members ${W} ORDER BY name LIMIT 51 OFFSET ${after}`).bind(...args).all()).results;
    const matched = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM members ${W}`).bind(...args).first()).n;
    const fullPhone = can(member, 'members') && !READONLY[norm(member.role)];
    const mask = (p) => (p ? `${p.slice(0, 4)}***${p.slice(-3)}` : '');
    return json({
      members: rows.slice(0, 50).map((m) => ({ ...m, teams: JSON.parse(m.teams || '[]'), phone: fullPhone ? m.phone : mask(m.phone),
        role: norm(m.role), roleName: ROLES[norm(m.role)], membershipName: MEMBERSHIP[m.membership || 'none'] })),
      next: rows.length > 50 ? after + 50 : null, matched, ...meta,
    });
  }
  // 設定主團（理事長、理事、行政人員；監事唯讀）：可以一次設定多位
  if (path === '/api/members/main-team' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'members') || READONLY[norm(member.role)]) return fail(403, '只有理事長、理事與行政人員可以設定主團');
    const b = await body();
    const ids = Array.isArray(b.member_ids) ? b.member_ids.map((x) => str(x, 32)).filter(Boolean).slice(0, 300) : [];
    const tid = str(b.team_id, 16) || null;
    if (!ids.length) return fail(400, '請選擇成員');
    if (tid && !(await teamIds()).includes(tid)) return fail(400, '找不到這個分團');
    if (tid && (await selfManaged(tid)) && !teamOwn(tid, 'approve')) return fail(403, '這個分團的成員只由該團的團長與幹部處理');
    // 目前主團是「只由本團幹部管理」的人，也不能由協會幹部改走
    const mj = JSON.stringify([...new Set(ids)]);
    const locked = (await env.DB.prepare(`SELECT m.id, m.main_team FROM members m JOIN teams t ON t.id = m.main_team
      WHERE t.self_managed = 1 AND m.id IN (SELECT value FROM json_each(?))`).bind(mj).all()).results.filter((r) => !teamOwn(r.main_team, 'approve'));
    if (locked.length) return fail(403, `有 ${locked.length} 位的主團只能由該團幹部調整`);
    // 只通知主團真的有變的人
    const changed = tid ? (await env.DB.prepare('SELECT id FROM members WHERE main_team IS NOT ?1 AND id IN (SELECT value FROM json_each(?2))').bind(tid, mj).all()).results.map((r) => r.id) : [];
    // 所有人 2–3 句（json_each），句數跟人數無關；一般團員只屬於主團，擔任團長或幹部的分團保留
    await env.DB.batch([
      env.DB.prepare('UPDATE members SET main_team = ?1, club = (SELECT name FROM teams WHERE id = ?1) WHERE id IN (SELECT value FROM json_each(?2))').bind(tid, mj),
      env.DB.prepare("DELETE FROM team_members WHERE member_id IN (SELECT value FROM json_each(?2)) AND role = 'member' AND (?1 IS NULL OR team_id != ?1)").bind(tid, mj),
      ...(tid ? [env.DB.prepare(`INSERT INTO team_members (team_id, member_id, role, status) SELECT ?1, m.id, 'member', 'active' FROM json_each(?2) j JOIN members m ON m.id = j.value WHERE true
        ON CONFLICT(team_id, member_id) DO UPDATE SET status = 'active'`).bind(tid, mj)] : []),
    ]);
    const tname = tid ? (await env.DB.prepare('SELECT name FROM teams WHERE id = ?').bind(tid).first())?.name : '未設定';
    await audit(env, req, member, 'team.main', 'members', ids.length === 1 ? ids[0] : null, `${ids.length} 人 → ${tname}`);
    if (changed.length) await notify(env, changed, 'membership', { kind: 'system', title: `你的主團：${tname}`, body: '分團的活動與公告會通知你', url: `/#/t/${tid}`, ref: `t:${tid}` });
    return json({ ok: true, count: ids.length });
  }
  const mm = path.match(/^\/api\/members\/([\w-]{1,32})\/membership$/);
  if (mm && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'members') || READONLY[norm(member.role)]) return fail(403, '沒有管理會籍的權限');
    const b = await body();
    const st = MEMBERSHIP[b.membership] ? b.membership : null;
    if (!st) return fail(400, '會籍狀態不正確');
    const old = (await env.DB.prepare('SELECT membership FROM members WHERE id = ?').bind(mm[1]).first())?.membership || 'none';
    await env.DB.prepare('UPDATE members SET membership = ?, member_type = ?, member_no = ?, joined_on = ?, paid_until = ?, membership_note = ? WHERE id = ?')
      .bind(st, str(b.member_type, 10) || null, str(b.member_no, 20) || null, str(b.joined_on, 10) || null,
            str(b.paid_until, 10) || null, str(b.membership_note, 100) || null, mm[1]).run();
    await audit(env, req, member, 'membership.update', 'member', mm[1], `${MEMBERSHIP[st]}${b.member_type ? `／${str(b.member_type, 10)}` : ''}`);
    // 只在狀態真的改變時通知（續繳、改會員編號不再重複通知）
    if (st === 'active' && old !== 'active') await notify(env, [mm[1]], 'membership', { kind: 'system', title: '入會完成', body: '你已經是台灣耕跑團協會會員', url: '/#/me/card' });
    if (st === 'expired' && old !== 'expired') await notify(env, [mm[1]], 'membership', { kind: 'system', title: '會籍已到期', body: '續繳會費後，會籍卡就會恢復', url: '/#/me/card' });
    if (old === 'applied' && st !== 'applied') await settleTodo(env, `apply:${mm[1]}`);
    return json({ ok: true });
  }

  // 跑友自己申請入會（填完表單後按一下，行政人員在後台審核）
  if (path === '/api/me/apply' && method === 'POST') {
    const g = need(); if (g) return g;
    if (member.membership === 'active') return fail(400, '你已經是會員');
    if (member.membership === 'applied') return fail(409, '已經送出申請，等待審核');
    if (await limited(env, `apply:${member.id}`, 3, 86400)) return fail(429, '申請太頻繁，請明天再試');
    await env.DB.prepare("UPDATE members SET membership = 'applied' WHERE id = ?").bind(member.id).run();
    const admins = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair','staff','director')").all()).results.map((r) => r.id);
    await notify(env, admins, 'todo', { kind: 'system', title: '有人申請入會', body: `${member.nickname || '一位跑友'} 送出入會申請`, url: '/#/admin?tab=members',
      ref: `apply:${member.id}`, push: { title: '有新的入會申請', body: '點開審核' } });
    return json({ member: pub({ ...member, membership: 'applied' }) });
  }

  // 移交理事長：對方成為理事長、自己同時改成指定的身分，一步完成（不會出現沒有理事長或兩位理事長的空窗）
  const mho = path.match(/^\/api\/members\/([\w-]{1,32})\/handover$/);
  if (mho && method === 'POST') {
    const g = need(); if (g) return g;
    if (norm(member.role) !== 'chair') return fail(403, '只有理事長可以移交');
    { const su = await needStepUp(); if (su) return su; }
    const b = await body(), myRole = ROLES[b.my_role] && b.my_role !== 'chair' ? b.my_role : null;
    if (!myRole) return fail(400, '請選擇你移交後的身分');
    if (mho[1] === member.id) return fail(400, '請選擇另一位跑友');
    const target = await env.DB.prepare('SELECT id, name FROM members WHERE id = ?').bind(mho[1]).first();
    if (!target) return fail(404, '找不到這位跑友');
    if (b.confirm !== target.name) return fail(400, '請輸入對方的姓名確認');
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET role = 'chair', title = NULL WHERE id = ?").bind(target.id),
      env.DB.prepare('UPDATE members SET role = ?, title = ? WHERE id = ?').bind(myRole, str(b.my_title, 20) || null, member.id),
    ]);
    await revokeSessions(env, target.id);
    await revokeSessions(env, member.id);
    // 結尾的 ｜role=代碼：還原後照這筆重設雙方身分（tools/restore-sql.mjs）
    await audit(env, req, member, 'role.handover', 'member', target.id, `理事長移交給 ${target.name}；原理事長改為${ROLES[myRole]}｜role=${myRole}`);
    // 鎖定畫面不放人名與新身分，詳細內容只在通知中心
    await securityNotify(env, [target.id], { title: '你已成為理事長', body: '理事長已移交給你，請重新登入後到管理後台確認幹部名單', url: '/#/admin',
      push: { title: '身分更新', body: '你的身分已變更，請重新登入' } });
    await securityNotify(env, [member.id], { title: '你已卸任理事長', body: `身分改為${ROLES[myRole]}`, url: '/#/me', push: { title: '身分更新', body: '你的身分已變更，請重新登入' } });
    const next = { ...member, role: myRole };
    return json({ ok: true, member: pub(next) }, 200, { 'set-cookie': await startSession(env, next, req) });
  }
  const mr = path.match(/^\/api\/members\/([\w-]{1,32})\/role$/);
  if (mr && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'roles')) return fail(403, '只有理事長可以指派角色');
    { const su = await needStepUp(); if (su) return su; }
    const b = await body(), role = ROLES[b.role] ? b.role : null;
    if (!role) return fail(400, '角色不正確');
    if (mr[1] === member.id && role !== 'chair') return fail(400, '不能把自己降級，請先指派新的理事長');
    await env.DB.prepare('UPDATE members SET role = ?, title = ? WHERE id = ?').bind(role, str(b.title, 20) || null, mr[1]).run();
    await revokeSessions(env, mr[1]);
    // 結尾的 ｜role=代碼：還原後照最後一次重設身分（降級不會跟著倒回去；tools/restore-sql.mjs）
    await audit(env, req, member, 'role.change', 'member', mr[1], `${ROLES[role]}${b.title ? `／${str(b.title, 20)}` : ''}｜role=${role}`);
    await securityNotify(env, [mr[1]], { title: '身分更新', body: `你的身分已設定為${ROLES[role]}`, url: '/#/me', push: { body: '你的身分已變更，請重新登入' } });
    return json({ ok: true });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body();
    const endpoint = str(b.endpoint, 1000), p256dh = str(b.keys?.p256dh, 200), auth = str(b.keys?.auth, 100);
    if (!validEndpoint(endpoint) || !/^[A-Za-z0-9_-]{40,120}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) return fail(400, '訂閱資料錯誤');
    await subscribe(env, member.id, { endpoint, p256dh, auth });
    await audit(env, req, member, 'push.subscribe', 'member', member.id, deviceLabel(req.headers.get('user-agent') || ''));
    return json({ ok: true });
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const g = need(); if (g) return g;
    const r = await unsubscribe(env, member.id, str((await body()).endpoint, 1000));
    if (r.meta?.changes) await audit(env, req, member, 'push.unsubscribe', 'member', member.id, deviceLabel(req.headers.get('user-agent') || ''));
    return json({ ok: true });
  }
  // 這支手機的訂閱還在不在伺服器（伺服器收到 404／410 會刪掉）
  if (path === '/api/push/check' && method === 'POST') {
    const g = need(); if (g) return g;
    const known = !!(await env.DB.prepare('SELECT 1 FROM push_subs WHERE endpoint = ? AND member_id = ?').bind(str((await body()).endpoint, 1000), member.id).first());
    return json({ known });
  }
  if (path === '/api/push/test' && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `pushtest:${member.id}`, 10, 3600)) return fail(429, '測試太頻繁，請稍後再試');
    const { sent } = await pushTest(env, member.id, { cat: 'test', title: '耕跑團', body: '通知設定完成，新團練和報名提醒都會通知你。', url: '/#/me/notify', ts: Date.now() });
    return sent ? json({ ok: true, sent }) : fail(400, '沒有送出，請確認這台裝置已開啟通知');
  }

  return fail(404, '沒有這個 API');
});

// ---- 排程工作（wrangler.jsonc 的 cron：每小時整點）----
// 時間一律用台北時間判斷；每項工作都有防重複的標記，重跑也不會重複通知
// 免費方案一次執行只有 50 個子請求（見 src/budget.js），所以：
//   1. 每小時先用一句 SQL（CRON_PROBE）看哪些工作有事要做，安靜的整點只花 1 句
//   2. 有事的工作依優先順序跑，共用一份預算；每處理一項（一場活動、一位會員）之前先確認額度，不夠就停，下個整點接著做
//   3. 每日、每季的工作是兩段式：開始時先佔用，做完才標成完成；中途被終止的話，下個整點會重跑（最多 3 次，之後寫稽核 cron.gave_up）
//   4. 時間門檻是「到了以後都可以補做」（hour >= H），錯過的整點在同一天後面的整點補上
//   5. 每日備份（own）開自己的執行（ctx.exports.Jobs），不和其他工作擠同一份額度
const taipei = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3);   // 只拿來讀年月日時，不當成真的時區物件
const tpDate = (d) => taipei(d).toISOString().slice(0, 10);

// 佔用：已完成、別人正在跑（15 分鐘內）、或已經失敗 3 次，都回 null
//   claim_at 是 NULL（因為額度停下或失敗後釋放）也當作可以接著做
const CLAIM = `INSERT INTO job_runs (job, last_run, claim_key, claim_at, attempts) VALUES (?1, '', ?2, datetime('now'), 1)
  ON CONFLICT(job) DO UPDATE SET attempts = CASE WHEN job_runs.claim_key IS ?2 THEN job_runs.attempts + 1 ELSE 1 END,
    claim_key = ?2, claim_at = datetime('now'), last_error = NULL
  WHERE job_runs.last_run IS NOT ?2 AND (job_runs.claim_key IS NOT ?2
    OR ((job_runs.claim_at IS NULL OR job_runs.claim_at < datetime('now', '-15 minutes')) AND job_runs.attempts < 3))
  RETURNING attempts, cursor`;
async function claim(env, job, key) {
  const r = await env.DB.prepare(CLAIM).bind(job, key).first();
  if (!r) return null;
  env.claimed = { job, key, attempts: r.attempts };
  // 測試用（/api/dev/cron?fail=backup，只有 DEV_LOGIN=1 的本機）：佔用之後丟錯，用來測重跑
  if (env.failAfterClaim && env.failAfterClaim === env.jobName) throw new Error('測試：佔用之後失敗');
  return r;
}
// 完成標記：要和收尾的寫入（例如稽核）放在同一個 DB.batch，才是同一個交易
//   這項工作佔用的部分到這裡就算完成：之後再出錯（例如待審核整理之後的逾期失效）不算在這個佔用上
const doneStmt = (env, job, key) => {
  if (env.claimed?.job === job) env.claimed = null;
  return env.DB.prepare("UPDATE job_runs SET last_run = ?2, done_at = datetime('now'), claim_key = NULL, last_error = NULL, cursor = NULL WHERE job = ?1").bind(job, key);
};
// 因為額度停下：不算失敗，把次數退回去、釋放佔用，讓下個整點接著做
const yieldStmt = (env, job) => env.DB.prepare('UPDATE job_runs SET attempts = MAX(0, attempts - 1), claim_at = NULL WHERE job = ?1').bind(job);
// 失敗：記下錯誤並釋放佔用（確定沒有人在跑了，下個整點就能重跑，不用等 15 分鐘）
const failStmt = (env, job, msg) => env.DB.prepare('UPDATE job_runs SET last_error = ?2, claim_at = NULL WHERE job = ?1').bind(job, String(msg).slice(0, 200));
const yieldTo = async (env, job, name, result = 'deferred') => { env.budget.stop(name); await yieldStmt(env, job).run(); return { done: false, result }; };
// 額度夠不夠處理下一項；不夠就記下「因額度停下」
const fits = (env, n, name) => { if (env.budget.room(n)) return true; env.budget.stop(name); return false; };
// notify()／notifyMany() 一次用掉的子請求：通知中心與推播佇列各一句（每 1000 人）；推播在執行結束前用剩下的額度送
const notifyCost = (n) => (n ? 2 * Math.ceil(n / 1000) : 0);

const signedIds = async (env, eid) => (await env.DB.prepare("SELECT member_id FROM signups WHERE event_id = ? AND status = 'in' AND member_id IS NOT NULL").bind(eid).all()).results.map((r) => r.member_id);

// 活動提醒：集合前 2 小時內提醒一次（每小時排程；錯過的整點在下一個整點補送，只要還沒集合）；前一晚 20:00 起提醒明天的活動（之後的整點補做）
//   集合前提醒有時效，先做；明天的提醒額度不夠就留到下個整點
async function remindEvents(env, now) {
  const hour = taipei(now).getUTCHours(), today0 = tpDate(now), tomorrow = tpDate(new Date(now.getTime() + 864e5));
  let sent = 0;
  // 集合時間落在 (現在, 現在 + 120 分]：正常是在集合前 1–2 小時的整點送；那個整點被延後（額度、03:00 的備份）就在下一個整點補送
  const nowMin = taipei(now).getUTCHours() * 60 + taipei(now).getUTCMinutes();
  const hevs = (await env.DB.prepare(`SELECT id, title, gather_time, place, kind FROM events
    WHERE date = ? AND status = 'open' AND kind != 'survey' AND gather_time != '' AND gather_time IS NOT NULL AND remind_hour_at IS NULL LIMIT 100`).bind(today0).all()).results;
  for (const ev of hevs) {
    const [h, m] = ev.gather_time.split(':').map(Number), diff = h * 60 + m - nowMin;
    if (!(diff > 0 && diff <= 120)) continue;
    if (!fits(env, 2, 'events')) return { done: false, result: sent };
    const ids = await signedIds(env, ev.id);
    if (!fits(env, 1 + notifyCost(ids.length), 'events')) return { done: false, result: sent };
    // 集合前提醒到集合時間就過期（最多 1 小時），不會集合之後才收到
    await notify(env, ids, 'signup', { kind: 'event', ref: `e:${ev.id}`, title: `${ev.gather_time} 集合：${ev.title}`, body: `${ev.place || ''}${ev.kind === 'party' ? '　入場券在「我的入場券」' : '　出門前記得暖身補水'}`, url: ev.kind === 'party' ? '/#/tickets' : `/#/e/${ev.id}`, tag: `hour-${ev.id}`,
      ttl: Math.min(3600, diff * 60), urgency: 'high' }, { also: [env.DB.prepare("UPDATE events SET remind_hour_at = datetime('now') WHERE id = ?").bind(ev.id)] });
    sent += ids.length;
  }
  if (hour >= 20) {
    const evs = (await env.DB.prepare(`SELECT id, title, date, gather_time, place, kind FROM events
      WHERE date = ? AND status = 'open' AND kind != 'survey' AND remind_day_at IS NULL LIMIT 100`).bind(tomorrow).all()).results;
    for (const ev of evs) {
      if (!fits(env, 2, 'events')) return { done: false, result: sent };
      const ids = await signedIds(env, ev.id);
      if (!fits(env, 1 + notifyCost(ids.length), 'events')) return { done: false, result: sent };
      // 提醒標記和通知在同一個 batch：不會標了沒送、也不會送了沒標（下個整點重送）
      await notify(env, ids, 'signup', { kind: 'event', ref: `e:${ev.id}`, title: `明天：${ev.title}`, body: `${ev.gather_time ? `${ev.gather_time} 集合` : '明天'}${ev.place ? `・${ev.place}` : ''}${ev.kind === 'party' ? '・記得帶入場券 QR Code' : ''}`, url: `/#/e/${ev.id}`, tag: `day-${ev.id}` },
        { also: [env.DB.prepare("UPDATE events SET remind_day_at = datetime('now') WHERE id = ?").bind(ev.id)] });
      sent += ids.length;
    }
  }
  return { done: true, result: sent };
}

// 會費到期：到期前 30 天、7 天、到期當天各提醒本人一次（同一個到期日的同一階段只提醒一次；renew_notice 就是游標）
async function remindRenewals(env, now) {
  const until = tpDate(new Date(now.getTime() + 30 * 864e5)), today0 = tpDate(now);
  const rows = (await env.DB.prepare(`SELECT id, paid_until, renew_notice FROM members WHERE membership = 'active' AND paid_until IS NOT NULL
    AND paid_until BETWEEN ? AND ? LIMIT 1000`).bind(today0, until).all()).results;
  const list = [], marks = [];
  for (const r of rows) {
    const days = Math.round((Date.parse(`${r.paid_until}T00:00:00Z`) - Date.parse(`${today0}T00:00:00Z`)) / 864e5);
    const stage = days <= 0 ? 0 : days <= 7 ? 7 : 30, key = `${r.paid_until}:${stage}`;
    if (r.renew_notice === key) continue;
    list.push({ member_id: r.id, title: stage === 0 ? '會費今天到期' : `會費 ${days} 天後到期`, body: `你的協會會費繳至 ${r.paid_until}，續繳後會籍卡就會更新`, url: '/#/me/card' });
    marks.push([r.id, key]);
  }
  // 所有人一次寫完（通知＋標記同一個 batch，共 3 句）
  if (!fits(env, notifyCost(list.length) + 1, 'renewals')) return { done: false, result: 0 };
  await notifyMany(env, 'membership', list, { kind: 'system', also: marks.length ? [env.DB.prepare(`UPDATE members SET renew_notice = json_extract(j.value, '$[1]')
    FROM json_each(?1) j WHERE members.id = json_extract(j.value, '$[0]')`).bind(JSON.stringify(marks))] : [] });
  return { done: true, result: list.length };
}

// 壞天氣提醒：前一晚 20:00 起，明天有指定地點的活動，集合時間預報「不建議」、大雨或空氣不佳，通知報名的人與主辦幹部
//   先查天氣與名單、確認額度夠，才標記 wx_alert_at 並通知（額度不夠就不標記，下個整點重來）
async function weatherAlerts(env, now) {
  const tomorrow = tpDate(new Date(now.getTime() + 864e5));
  const evs = (await env.DB.prepare(`SELECT e.id, e.title, e.gather_time, e.team_id, e.created_by, s.name AS spot, s.lat, s.lng FROM events e JOIN spots s ON s.id = e.spot_id
    WHERE e.date = ? AND e.status = 'open' AND e.kind != 'survey' AND e.wx_alert_at IS NULL LIMIT 50`).bind(tomorrow).all()).results;
  let sent = 0;
  const mark = (id) => env.DB.prepare("UPDATE events SET wx_alert_at = datetime('now') WHERE id = ?").bind(id).run();
  for (const ev of evs) {
    if (!fits(env, 7, 'weather')) return { done: false, result: sent };   // 快取查詢 1＋天氣 2＋寫入快取 1（命中就只有查詢）＋名單 1＋幹部 1＋標記 1
    const w = await getWeather(env, ev.lat, ev.lng);
    if (!w) { await mark(ev.id); continue; }
    const hh = /^\d{2}:\d{2}$/.test(ev.gather_time || '') ? ev.gather_time.slice(0, 2) : '07';
    const x = hourOf(JSON.parse(w.body), `${tomorrow}T${hh}:00`);
    if (!x || !(x.advice.level === 'poor' || (x.rain >= 70 && x.mm >= 2) || x.aqi >= 101)) { await mark(ev.id); continue; }
    const why = x.advice.why.join('；');
    const ids = await signedIds(env, ev.id);
    const mgr = x.advice.level === 'poor' ? await eventManagers(env, ev) : [];
    if (!fits(env, 1 + notifyCost(ids.length) + notifyCost(mgr.length), 'weather')) return { done: false, result: sent };
    await mark(ev.id);
    // 鎖定畫面用同一個 day- tag 取代同一場的「明天」提醒，通知中心兩筆都保留
    if (ids.length) await notify(env, ids, 'signup', { kind: 'event', ref: `e:${ev.id}`, title: `明天${x.advice.level === 'poor' ? '天氣不佳' : '天氣提醒'}：${ev.title}`, body: `${hh}:00 ${ev.spot}：${x.text}，體感 ${Math.round(x.feel)}°。${why}。有異動幹部會再通知。`, url: `/#/e/${ev.id}`, tag: `day-${ev.id}`, renotify: true });
    if (mgr.length) await notify(env, mgr, 'todo', { kind: 'event', ref: `wx:${ev.id}`, title: `要不要調整：${ev.title}`, body: `明天 ${hh}:00 預報不建議跑步（${why}）。可以在活動頁「發布異動」通知大家。`, url: `/#/e/${ev.id}`, tag: `wxm-${ev.id}` });
    sent += ids.length;
  }
  return { done: true, result: sent };
}

// 跑完接續：團練結束 15 分鐘後，提醒有報名的人記錄今天的訓練（帶入課表），記完可以直接拍照分享
async function runFollowups(env, now) {
  const today0 = tpDate(now), t = taipei(now), nowMin = t.getUTCHours() * 60 + t.getUTCMinutes();
  const evs = (await env.DB.prepare(`SELECT id, title, gather_time, end_time FROM events WHERE date = ? AND status = 'open' AND kind IN ('track', 'core', 'long', 'race', 'other')
    AND followup_at IS NULL AND gather_time IS NOT NULL AND gather_time != '' LIMIT 100`).bind(today0).all()).results;
  let sent = 0;
  for (const ev of evs) {
    const [gh, gm] = ev.gather_time.split(':').map(Number);
    const end = /^\d{2}:\d{2}$/.test(ev.end_time || '') && ev.end_time > ev.gather_time ? ev.end_time.split(':').map(Number).reduce((h, m) => h * 60 + m) : gh * 60 + gm + 120;
    if (nowMin < end + 15) continue;
    if (!fits(env, 2, 'followups')) return { done: false, result: sent };
    const ids = await signedIds(env, ev.id);
    if (!fits(env, 1 + notifyCost(ids.length), 'followups')) return { done: false, result: sent };
    await env.DB.prepare("UPDATE events SET followup_at = datetime('now') WHERE id = ?").bind(ev.id).run();
    if (!ids.length) continue;
    await notify(env, ids, 'training', { kind: 'event', ref: `e:${ev.id}`, title: '跑完了嗎？', body: `記錄今天「${ev.title}」的訓練，再拍張照分享`, url: `/#/log?event=${ev.id}`, tag: `fu-${ev.id}` });
    sent += ids.length;
  }
  return { done: true, result: sent };
}

// 每月 1 號 09:00 起：上個月的里程挑戰總結（個人里程與徽章、分團平均第一名），只通知上個月有紀錄的人
const prevMonthOf = (t) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
async function monthSummary(env, now) {
  const prev = prevMonthOf(taipei(now));
  if (!(await claim(env, 'month_summary', prev))) return { done: true, result: 0 };
  const logs = (await env.DB.prepare("SELECT member_id, date, km FROM training_logs WHERE date BETWEEN ? AND ? AND status != 'skip'").bind(`${prev}-01`, `${prev}-31`).all()).results;
  const by = {};
  for (const l of logs) (by[l.member_id] ||= []).push(l);
  const teams = (await env.DB.prepare(`SELECT t.name, COUNT(DISTINCT tm.member_id) AS members, COALESCE(SUM(l.km), 0) AS km FROM teams t
    JOIN team_members tm ON tm.team_id = t.id AND tm.status = 'active' LEFT JOIN training_logs l ON l.member_id = tm.member_id AND l.date BETWEEN ? AND ? AND l.status != 'skip'
    WHERE t.private = 0 GROUP BY t.id`).bind(`${prev}-01`, `${prev}-31`).all()).results.filter((x) => x.members).sort((a, b) => b.km / b.members - a.km / a.members);
  const champ = teams[0] && teams[0].km > 0 ? `分團平均第一：${teams[0].name}（每人 ${(teams[0].km / teams[0].members).toFixed(1)} 公里）` : '';
  // 每人一則，所有人一次寫完；完成標記放在同一個 batch（不會只送一半又重送）
  const notes = Object.entries(by).map(([mid, list]) => {
    const km = list.reduce((s0, l) => s0 + (l.km || 0), 0), stat = { km, runs: list.length, weeks: weeksOf(prev, list.map((l) => l.date)) };
    const got = earned(stat).map((id) => BADGES.find((b) => b.id === id).name);
    return { member_id: mid, title: `${Number(prev.slice(5))} 月跑了 ${km.toFixed(1)} 公里`, body: `${list.length} 次訓練${got.length ? `，獲得徽章：${got.join('、')}` : ''}。${champ}`, url: `/#/challenge?m=${prev}`,
      push: { title: `${Number(prev.slice(5))} 月訓練總結`, body: '點開看本月里程與徽章' } };
  });
  if (!fits(env, notifyCost(notes.length) + 1, 'monthSummary')) return yieldTo(env, 'month_summary', 'monthSummary');
  await notifyMany(env, 'training', notes, { kind: 'system', also: [doneStmt(env, 'month_summary', prev)] });
  return { done: true, result: notes.length };
}

// 備份存放：有綁 R2（BACKUP）就存 R2，否則存 Workers KV（BACKUP_KV）；兩邊格式一樣
//   KV 的每個物件都設 36 天後自動過期（分段備份一份可能有很多段，逐一刪除太花子請求）；R2 沒有逐筆期限，過期的整份一起刪（list 1＋批次刪除 1）
const BACKUP_TTL = 36 * 86400;
const backupStore = (env) => (env.BACKUP ? {
  put: (k, v, meta) => env.BACKUP.put(k, v, { customMetadata: meta }),
  list: async (prefix = 'daily/') => (await env.BACKUP.list({ prefix, include: ['customMetadata'] })).objects.map((o) => ({ key: o.key, size: o.size, at: o.uploaded, ...o.customMetadata })),
  get: async (k) => (await env.BACKUP.get(k))?.arrayBuffer(),
  del: (k) => env.BACKUP.delete(k), kind: 'R2',
} : env.BACKUP_KV ? {
  put: (k, v, meta) => env.BACKUP_KV.put(k, v, { metadata: { ...meta, size: v.length, at: new Date().toISOString() }, expirationTtl: BACKUP_TTL }),
  list: async (prefix = 'daily/') => (await env.BACKUP_KV.list({ prefix })).keys.map((o) => ({ key: o.name, ...o.metadata })),
  get: (k) => env.BACKUP_KV.get(k, 'arrayBuffer'),
  del: (k) => env.BACKUP_KV.delete(k), kind: 'KV',
} : null);
const backupKey = (env, use) => crypto.subtle.importKey('raw', WebAuthn.unb64u(env.BACKUP_KEY.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'AES-GCM', false, [use]);
const BACKUP_AAD = new TextEncoder().encode('cil-backup-v1');
// 不備份的表：暫存（工作階段、限流、通行金鑰挑戰、migration 紀錄）、遙測（前端效能與錯誤，保存 90 天）、
//   推播佇列與執行額度紀錄，以及通知中心（保存 180 天的訊息副本，人多時是最大的一張表；真正的狀態在各自的資料表，還原後通知中心從空的開始）
const BACKUP_SKIP = new Set(['sessions', 'rate_limits', 'webauthn_challenges', 'd1_migrations',
  'client_metrics', 'client_errors', 'push_queue', 'budget_log', 'notifications']);
// 同步來的鏡頭清單（水利署、水利處）可以在管理後台重新同步，只備份幹部手動新增的連結；公路局用 tools/cams-sync.mjs 重新匯入
//   跑者休息站的官方開放資料可以重新同步（tools/rest-sync.mjs 與管理後台的立即同步）：只備份幹部整理、新增、修正、隱藏或寫了補充說明的列
//   （條件有 OR，用的地方一律加括號）
const BACKUP_FILTER = { cams: 'manual = 1', rest_stops: 'manual = 1 OR fix IS NOT NULL OR hidden = 1 OR note IS NOT NULL' };
// 每筆可能很大的表（路線最多 3000 點約 66 KB、分團小圖最多 80 KB）：第一次只讀幾筆，之後照平均大小調整，一段的 CPU 才不會爆
const BACKUP_FIRST = { routes: 5, teams: 5, plan_posts: 50, team_posts: 50 };
const ROUTE_MAX = 100;   // 每人最多存幾條路線（見 POST /api/routes）
// 訓練紀錄的新增與修改（POST /api/logs）：每位跑友每天最多幾次、10 分鐘最多幾次、一次請求最大、備註最多幾字
//   舊版課表教練資料搬移一筆一個請求（一季約 120 筆，兩三個週期也在 10 分鐘 300 次內）；離線暫存區最多 30 筆
//   最壞情況一個帳號一天寫 D1：600 次 ×（紀錄 1 列＋3 個索引＋計數 2 列）≈ 3,600 列（免費方案每天 10 萬列）
const LOG_DAY_LIMIT = 600, LOG_BURST = 300, LOG_BODY_MAX = 8192, LOG_NOTE_MAX = 300;
const REST_DETAIL_LIMIT = 60;   // 休息站詳細與地點的附近休息站：每位跑友 10 分鐘最多幾次
// 休息站格子、詳細、地點附近合計：每位跑友每天最多幾次（一個畫面最多 16 格、瀏覽器快取一天，一般一天用不到 100 次）。
//   一次讀的列數（本機 D1 的 rows_read 實測）＝索引範圍內讀到的列＋約 18 列（來源狀態、設定等）；快取命中只有那 18 列。
//   地點附近的範圍約 3 格寬、1 格高，讀到的列約「3 × 每格列數」：真實資料最密的一格 189 列，最壞一次約 590 列。
//   上限是結構上的：休息站的查詢在 SQL 裡只有索引的條件，讀到幾列就算進 LIMIT（Rest.CELL_LIMIT 800，見 src/rest.js 的 cellRows），
//   所以不管一格長到多少，一次最多約 820 列（每格 1,024 處的測試實測），一位跑友一天最多 300 × 820 ≈ 25 萬列（免費方案每天 500 萬列）
const REST_DAY_LIMIT = 300;
const restSpent = new Map();   // 這個 isolate 記得今天已經用完休息站額度的跑友（id → 到什麼時候前不再查 D1）
// 加密一個備份物件：'CILB2'＋IV＋AES-GCM(gzip(text))；AAD 綁住日期與第幾段（manifest 是 'manifest'），段落不能被換位置或拿去拼別份
async function sealBackup(env, text, aad) {
  const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`cil-backup-v2|${aad}`) }, await backupKey(env, 'encrypt'), gz));
  const blob = new Uint8Array(5 + 12 + ct.length);
  blob.set(new TextEncoder().encode('CILB2'), 0); blob.set(iv, 5); blob.set(ct, 17);
  return blob;
}
async function openBackup(env, buf, aad) {
  const magic = new TextDecoder().decode(buf.subarray(0, 5));
  const ad = magic === 'CILB2' ? new TextEncoder().encode(`cil-backup-v2|${aad}`) : magic === 'CILB1' ? BACKUP_AAD : null;
  if (!ad) throw new Error('格式不對');
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(5, 17), additionalData: ad }, await backupKey(env, 'decrypt'), buf.subarray(17));
  return JSON.parse(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
}
const partKey = (label, n) => `part/${label}/${String(n).padStart(4, '0')}.bin`;
const cursorStmt = (env, job, cur) => env.DB.prepare('UPDATE job_runs SET cursor = ?2 WHERE job = ?1').bind(job, cur ? JSON.stringify(cur) : null);
const backupPending = (r) => !!(r && r.cursor && r.claim_key && r.attempts < 3);

// 每天 03:00 起：資料庫加密備份（保留 35 天），分段做（見 backupStep）；手動備份（backup_manual）還沒做完的先接著做
//   上一份還沒做完（資料多時要好幾個整點，甚至跨日）：先接著做完，再開始新的一天；失敗 3 次而放棄的，從今天重新開始
async function dailyBackup(env, now) {
  if (!backupStore(env) || !env.BACKUP_KEY) return { done: true, result: null };
  const rows = (await env.DB.prepare("SELECT job, claim_key, attempts, cursor FROM job_runs WHERE job IN ('backup', 'backup_manual')").all()).results;
  const m = rows.find((r) => r.job === 'backup_manual'), d = rows.find((r) => r.job === 'backup');
  if (backupPending(m)) return backupStep(env, 'backup_manual', m.claim_key, { action: 'backup.manual', now });
  const label = backupPending(d) ? d.claim_key : tpDate(now);
  return backupStep(env, 'backup', label, { action: 'backup.daily', now });
}
// 分段備份的一段（一次執行）：依表名排序，每張表依 rowid 往後讀，讀到 plan.backupSeg 個 JSON 字元或額度用完就停，
//   加密寫成一段 part/<日期>/<第幾段>.bin，游標存在 job_runs.cursor，下個整點接著做；全部做完才寫 daily/<日期>.bin（manifest：每張表幾筆、共幾段），
//   管理後台的清單只看得到做完的備份。CPU 跟這一段的資料量成正比，不再跟整個資料庫成正比（人多時一次做完會超過 10 ms 而被終止）
//   子請求：佔用 1、開頭一次（表名 1、哪些表有資料 1）、每次讀取 1、寫入一段 1、收尾 2（manifest 1＋完成標記與稽核）
//   注意：資料多而跨好幾個整點時，每張表是各自讀取時的狀態，不是同一時間點的快照；要還原到某個時間點請用 D1 Time Travel（免費方案 7 天）
const BK_RESERVE = 5;
const BACKUP_STALL_MS = 24 * 3600e3;
const backupStalled = (cur, now = new Date()) => now.getTime() - (cur.started ?? Date.parse(cur.at)) > BACKUP_STALL_MS;
// 各表目前最大的 rowid（有 BACKUP_FILTER 的只看符合條件的列）；空的表是 null。一句
const maxRowids = async (env, names) => (names.length
  ? JSON.parse((await env.DB.prepare(`SELECT json_array(${names.map((n) => `(SELECT MAX(rowid) FROM "${n}"${BACKUP_FILTER[n] ? ` WHERE (${BACKUP_FILTER[n]})` : ''})`).join(', ')}) AS j`).first()).j) : []);
async function backupStep(env, job, label, { action = 'backup.daily', now = new Date() } = {}) {
  const store = backupStore(env), plan = planOf(env);
  const c0 = await claim(env, job, label);
  if (!c0) return { done: true, result: null };
  let cur = parseQ(c0.cursor, null);
  if (!cur || cur.label !== label) {
    if (!fits(env, 2 + BK_RESERVE, 'backup:start')) { await yieldStmt(env, job).run(); return { done: false, result: 'deferred' }; }
    const names = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all())
      .results.map((r) => r.name).filter((n) => !BACKUP_SKIP.has(n) && /^\w+$/.test(n));
    // 一句看完各表開始時的最大 rowid：空的表不用逐張去讀；之後只讀到這個 rowid 為止（max），
    //   備份進行中新增的列（例如有人一直存路線）留給下一份，不會一直追著新資料跑而永遠做不完（A.8.13）
    const top = await maxRowids(env, names);
    cur = { label, at: new Date().toISOString(), started: now.getTime(), all: names, tables: names.filter((n, i) => top[i] != null), t: 0, after: 0, n: 0, rows: Object.fromEntries(names.map((n) => [n, 0])), bytes: 0,
      max: Object.fromEntries(names.map((n, i) => [n, top[i]]).filter(([, v]) => v != null)) };
  }
  // 部署前就開始、還沒有上限的游標：現在補上（1 句）
  if (!cur.max) { if (!fits(env, 1 + BK_RESERVE, 'backup:max')) { await yieldStmt(env, job).run(); return { done: false, result: 'deferred' }; } const top = await maxRowids(env, cur.tables); cur.max = Object.fromEntries(cur.tables.map((n, i) => [n, top[i] ?? 0])); }
  // 開始超過 24 小時還沒做完：通知理事長與行政人員一次、稽核記一筆（資料暴增或有人大量寫入時，舊備份 36 天後就會過期）
  if (!cur.alerted && backupStalled(cur, now) && fits(env, 1 + notifyCost(10) + BK_RESERVE, 'backup:alert')) {
    const ids = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair', 'staff') LIMIT 20").all()).results.map((r) => r.id);
    cur.alerted = true;
    await notify(env, ids, 'todo', { kind: 'system', title: '每日備份還沒做完', body: `${label} 的備份開始超過 24 小時還沒做完，請到「系統設定 › 每日加密備份」查看`, url: '/#/admin/settings/backup', ref: `backup:${label}` },
      { force: true, also: [cursorStmt(env, job, cur), await auditStmt(env, null, null, 'backup.stalled', 'system', label, `開始於 ${cur.at}，已完成 ${cur.n} 段`)] });
  }
  const pieces = [], seg = env.backupSeg || plan.backupSeg;   // backupSeg：測試用（/api/dev/cron?seg=，只有 DEV_LOGIN=1 的本機）
  let size = 0, lim = BACKUP_FIRST[cur.tables[cur.t]] || 200;
  while (cur.t < cur.tables.length && size < seg) {
    if (!env.budget.room(1 + BK_RESERVE)) { env.budget.stop('backup:sub'); break; }
    const t = cur.tables[cur.t], L = lim;
    const rows = (await env.DB.prepare(`SELECT *, rowid AS _rid FROM "${t}" WHERE rowid > ?1 AND rowid <= ?3${BACKUP_FILTER[t] ? ` AND (${BACKUP_FILTER[t]})` : ''} ORDER BY rowid LIMIT ?2`).bind(cur.after, L, cur.max[t] ?? 0).all()).results;
    if (rows.length) {
      const js = JSON.stringify(rows);
      pieces.push(`[${JSON.stringify(t)},${js}]`); size += js.length;
      cur.rows[t] = (cur.rows[t] || 0) + rows.length; cur.after = rows[rows.length - 1]._rid;
      // 下一次讀幾筆：照這次每筆的平均大小，填滿這一段剩下的空間（20–2000 筆）
      lim = Math.max(5, Math.min(2000, Math.floor((seg - size) / Math.max(1, js.length / rows.length))));
    }
    if (rows.length < L || cur.after >= (cur.max[t] ?? 0)) { cur.t++; cur.after = 0; lim = BACKUP_FIRST[cur.tables[cur.t]] || 200; }
  }
  if (pieces.length) {
    const blob = await sealBackup(env, `{"format":"cil-backup-part","version":2,"label":${JSON.stringify(label)},"n":${cur.n},"tables":[${pieces.join(',')}]}`, `${label}|${cur.n}`);
    await store.put(partKey(label, cur.n), blob, { label, n: String(cur.n) });
    cur.n++; cur.bytes += blob.length;
  }
  if (cur.t < cur.tables.length) {
    // 還沒做完：記下游標、釋放佔用（不算失敗），下個整點接著做
    await env.DB.batch([cursorStmt(env, job, cur), yieldStmt(env, job)]);
    return { done: false, result: 'deferred' };
  }
  const rows = Object.values(cur.rows).reduce((x, y) => x + y, 0);
  const man = await sealBackup(env, JSON.stringify({ format: 'cil-backup', version: 2, label, at: cur.at, done_at: new Date().toISOString(), parts: cur.n, tables: cur.rows }), `${label}|manifest`);
  await store.put(`daily/${label}.bin`, man, { tables: String(cur.all.length), rows: String(rows), parts: String(cur.n), bytes: String(cur.bytes + man.length) });
  // 完成標記（也清掉游標）和稽核同一個 batch
  await env.DB.batch([doneStmt(env, job, label), await auditStmt(env, null, null, action, 'system', label, `${cur.all.length} 張表 ${rows} 筆，${cur.n} 段 ${cur.bytes + man.length} bytes`)]);
  // 過期的備份（35 天）：一次最多刪 3 份；KV 的物件本來就會自動過期，這裡只是早一點清掉（額度有剩才做）
  try {
    if (env.budget.room(2)) {
      const cut = `daily/${tpDate(new Date(Date.now() - 35 * 864e5))}`;
      for (const o of (await store.list()).filter((x) => x.key < cut).slice(0, 3)) {
        if (!env.budget.room(2)) break;
        await store.del(o.key);
        if (store.kind === 'R2' && env.budget.room(2)) {
          const ps = await store.list(`part/${o.key.slice(6, -4)}/`);
          if (ps.length) await env.BACKUP.delete(ps.map((x) => x.key));
        }
      }
    }
  } catch (e) { console.error('backup cleanup', e); }
  return { done: true, result: { label, tables: cur.all.length, rows, parts: cur.n, bytes: cur.bytes + man.length } };
}

// 每季第一天 09:00 起：提醒理事長與監事檢視幹部名單與權限（ISO 27001 A.5.18）
const quarterOf = (t) => `${t.getUTCFullYear()}Q${Math.floor(t.getUTCMonth() / 3) + 1}`;
async function quarterlyReview(env, now) {
  const q = quarterOf(taipei(now));
  if (!(await claim(env, 'quarterly_review', q))) return { done: true, result: 0 };
  const ids = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair', 'supervisor')").all()).results.map((r) => r.id);
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE role != 'member'").first()).n;
  const leads = (await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE role IN ('lead', 'officer') AND status = 'active'").first()).n;
  if (!fits(env, notifyCost(ids.length) + 2, 'review')) return yieldTo(env, 'quarterly_review', 'review');
  // 理事長與監事不能關這一則的推播；完成標記與稽核和通知在同一個 batch（中途被終止也不會重送）
  await notify(env, ids, 'todo', { kind: 'system', title: '每季權限檢視', body: `目前協會幹部 ${n} 位、分團團長與幹部 ${leads} 位。請確認卸任的人已移除權限。`, url: '/#/admin?tab=roles', ref: `review:${q}` },
    { force: true, also: [doneStmt(env, 'quarterly_review', q), await auditStmt(env, null, null, 'review.reminder', 'system', null, `幹部 ${n}、分團幹部 ${leads}`)] });
  return { done: true, result: ids.length };
}

// 每天 03:00 起：清掉過期資料；活動個資依後台設定的保存年限清除（沒設定就不動）
//   子請求：佔用 1、設定 1、清理一個 batch 8–13 句、收尾 2
async function retention(env, now) {
  const t = taipei(now), label = tpDate(now);
  if (!(await claim(env, 'retention', label))) return { done: true, result: null };
  const org = (await getSettings(env)).org || {};
  const keys = [], stmts = [];
  const add = (k, sql, ...args) => { keys.push(k); stmts.push(env.DB.prepare(sql).bind(...args)); };
  add('sessions', "DELETE FROM sessions WHERE expires_at < datetime('now')");
  add('rate_limits', "DELETE FROM rate_limits WHERE window_end < datetime('now')");
  add('notifications', "DELETE FROM notifications WHERE created_at < datetime('now', '-180 days')");
  // 幹部待辦含其他會員的暱稱，真正的待處理狀態在來源資料表，60 天就清掉
  add('notif_todo', "DELETE FROM notifications WHERE category = 'todo' AND created_at < datetime('now', '-60 days')");
  add('client_metrics', "DELETE FROM client_metrics WHERE day < date('now', '-90 days')");
  add('client_errors', "DELETE FROM client_errors WHERE day < date('now', '-90 days')");
  add('spot_reports', "DELETE FROM spot_reports WHERE created_at < datetime('now', '-90 days')");
  // 跑友回報休息站（含回報人）：30 天（見 migrations/0040）
  add('rest_reports', "DELETE FROM rest_reports WHERE created_at < datetime('now', '-30 days')");
  add('budget_log', "DELETE FROM budget_log WHERE day < date('now', '-90 days')");
  // 推播佇列：過期的（最長 24 小時）；推播關閉（VAPID 拿掉）時也不會一直留著通知內容
  add('push_queue', "DELETE FROM push_queue WHERE expires_at <= datetime('now')");
  const auditYears = Math.max(1, Math.min(Number(org.audit_years) || 3, 10));
  add('audit', `DELETE FROM audit_log WHERE at < datetime('now', '-${auditYears} years')`);
  const evYears = Math.max(0, Math.min(Number(org.event_data_years) || 0, 20));
  if (evYears) {
    const cut = `${t.getUTCFullYear() - evYears}${label.slice(4)}`;
    const old = `SELECT id FROM events WHERE date < ?`;
    add('signups', `DELETE FROM signups WHERE event_id IN (${old})`, cut);
    add('tickets', `DELETE FROM tickets WHERE event_id IN (${old})`, cut);
    add('invites', `DELETE FROM event_invites WHERE event_id IN (${old})`, cut);
    add('draws', `UPDATE draws SET name = '已清除', member_id = NULL WHERE member_id IS NOT NULL AND event_id IN (${old})`, cut);
  }
  const logYears = Math.max(0, Math.min(Number(org.log_years) || 0, 20));
  if (logYears) add('training_logs', `DELETE FROM training_logs WHERE date < date('now', '-${logYears} years')`);
  if (!fits(env, stmts.length + 2, 'retention')) return yieldTo(env, 'retention', 'retention');
  const res = await env.DB.batch(stmts);
  const out = Object.fromEntries(keys.map((k, i) => [k, res[i].meta.changes]));
  await env.DB.batch([doneStmt(env, 'retention', label), await auditStmt(env, null, null, 'retention.cleanup', 'system', null, Object.entries(out).map(([k, v]) => `${k} ${v}`).join('、'))]);
  return { done: true, result: out };
}

// 每天 21:00 起：疲勞提醒（只通知本人，不通知教練）
//   最近 7 天有 3 次以上 RPE ≥ 8，或最近 7 天里程超過前三週平均的 1.3 倍（而且超過 20 公里）
//   members.fatigue_notified 就是游標：額度不夠停下時，下個整點不會重複通知已經通知過的人
async function fatigueCheck(env, now) {
  const today0 = tpDate(now);
  if (!(await claim(env, 'fatigue', today0))) return { done: true, result: 0 };
  const d7 = tpDate(new Date(now.getTime() - 6 * 864e5)), d28 = tpDate(new Date(now.getTime() - 27 * 864e5));
  const rows = (await env.DB.prepare(`SELECT member_id,
      SUM(CASE WHEN date >= ?1 AND rpe >= 8 THEN 1 ELSE 0 END) AS hard,
      SUM(CASE WHEN date >= ?1 THEN COALESCE(km, 0) ELSE 0 END) AS km7,
      SUM(CASE WHEN date < ?1 THEN COALESCE(km, 0) ELSE 0 END) AS km21
    FROM training_logs WHERE date BETWEEN ?2 AND ?3 GROUP BY member_id`).bind(d7, d28, today0).all()).results;
  // 7 天內通知過的人跳過（fatigue_notified 在同一句查詢帶出來）；所有人一次寫完，標記與完成標記同一個 batch
  const last = new Map((await env.DB.prepare('SELECT id, fatigue_notified FROM members WHERE id IN (SELECT value FROM json_each(?)) AND fatigue_notified IS NOT NULL')
    .bind(JSON.stringify(rows.map((r) => r.member_id))).all()).results.map((m) => [m.id, m.fatigue_notified]));
  const notes = [];
  for (const r of rows) {
    const jump = r.km7 > 20 && r.km21 > 0 && r.km7 > (r.km21 / 3) * 1.3;
    if (!(r.hard >= 3 || jump)) continue;
    const prev = last.get(r.member_id);
    if (prev && Date.parse(today0) - Date.parse(prev) < 7 * 864e5) continue;
    // 鎖定畫面不放 RPE 與公里數
    notes.push({ member_id: r.member_id, title: '這週練得很兇，注意恢復',
      body: r.hard >= 3 ? `最近 7 天有 ${r.hard} 次自覺強度 8 以上，安排一兩天輕鬆跑或休息吧` : `最近 7 天跑了 ${Math.round(r.km7)} 公里，比前三週平均多了不少，小心受傷`, url: '/#/report',
      push: { body: '點開看本週訓練量與恢復建議' } });
  }
  if (!fits(env, notifyCost(notes.length) + 2, 'fatigue')) return yieldTo(env, 'fatigue', 'fatigue', 0);
  await notifyMany(env, 'training', notes, { kind: 'log', also: [
    ...(notes.length ? [env.DB.prepare('UPDATE members SET fatigue_notified = ?1 WHERE id IN (SELECT value FROM json_each(?2))').bind(today0, JSON.stringify(notes.map((x) => x.member_id)))] : []),
    doneStmt(env, 'fatigue', today0)] });
  return { done: true, result: notes.length };
}

// 每天台北 09:00 起：把前一天（UTC）的稽核 HMAC 串成摘要鏈；有人刪掉或改掉紀錄，重算就對不上（audit_digests 本身防止重複）
const utcYesterday = (now) => new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
async function auditDigest(env, now) {
  if (!env.AUDIT_KEY) return { done: true, result: null };
  const day = utcYesterday(now);
  if (await env.DB.prepare('SELECT 1 FROM audit_digests WHERE day = ?').bind(day).first()) return { done: true, result: null };
  const prev = (await env.DB.prepare('SELECT digest FROM audit_digests WHERE day < ? ORDER BY day DESC LIMIT 1').bind(day).first())?.digest || '';
  const rows = (await env.DB.prepare('SELECT mac FROM audit_log WHERE at >= ? AND at < ? AND mac IS NOT NULL ORDER BY at, id').bind(day, `${day} 24`).all()).results;
  const digest = await hmac(env, `${prev}|${rows.map((x) => x.mac).join('|')}`);
  await env.DB.prepare('INSERT INTO audit_digests (day, rows, digest) VALUES (?, ?, ?)').bind(day, rows.length, digest).run();
  return { done: true, result: { day, rows: rows.length } };
}

// 開放報名推播：到了 signup_start、還沒推過的活動（每小時，最晚 59 分鐘；open_notified_at 就是游標）
async function signupOpen(env, now) {
  const evs = (await env.DB.prepare(`SELECT id, title, date, gather_time, place, kind, capacity, team_id, visibility, created_by, signup_start, signup_open, status, deadline
    FROM events WHERE open_notified_at IS NULL AND signup_start IS NOT NULL AND signup_start <= ? AND status = 'open' AND date >= ? LIMIT 50`)
    .bind(tpNow(now.getTime()), tpDate(now)).all()).results;
  let sent = 0;
  for (const ev of evs) {
    // 看得到這場、還沒報名的人（邀請制＝受邀名單、分團活動＝該分團、其他＝全體）；
    // 每個分支只綁自己用到的參數（D1 參數數量不符會直接丟錯），名單查好了、額度也夠才標記已推，查詢失敗下一輪會重試
    const team = ev.visibility !== 'invite' && ev.team_id;
    const base = ev.visibility === 'invite' ? 'SELECT member_id AS id FROM event_invites WHERE event_id = ?1'
      : team ? "SELECT member_id AS id FROM team_members WHERE team_id = ?2 AND status = 'active'" : 'SELECT id FROM members';
    const q = env.DB.prepare(`${base} EXCEPT SELECT member_id FROM signups WHERE event_id = ?1 AND status != 'cancel'`);
    if (ev.signup_open && !fits(env, 1, 'signupOpen')) return { done: false, result: sent };
    const ids = ev.signup_open ? (await (team ? q.bind(ev.id, ev.team_id) : q.bind(ev.id)).all()).results.map((r) => r.id).filter((x) => x && x !== ev.created_by) : [];
    if (!fits(env, 1 + notifyCost(ids.length), 'signupOpen')) return { done: false, result: sent };
    const c = await env.DB.prepare("UPDATE events SET open_notified_at = datetime('now') WHERE id = ? AND open_notified_at IS NULL").bind(ev.id).run();
    if (!c.meta.changes || !ev.signup_open) continue;
    if (ids.length) await notify(env, ids, 'event', { kind: 'event', ref: `e:${ev.id}`, tag: `open-${ev.id}`, url: `/#/e/${ev.id}`,
      title: `開放報名：${ev.title}`, body: `${whenText(ev)}${ev.capacity ? `・名額 ${ev.capacity}` : ''}` });
    sent += ids.length;
  }
  return { done: true, result: sent };
}
// 待審核：20:00 起提醒主辦（一天一次）；活動結束 15 分鐘後（或活動取消）待審核失效（signups.status 就是游標）
async function signupReviews(env, now) {
  let n = 0, done = true;
  if (taipei(now).getUTCHours() >= 20 && await claim(env, 'signup_review_digest', tpDate(now))) {
    // 每場的主辦名單和待審核筆數一句查出來（規則同 eventManagers：建立者還有幹部身分、分團活動的團長與幹部、協會活動的理事長與行政人員）
    const evs = (await env.DB.prepare(`WITH ev AS (SELECT e.id, e.title, e.date, e.team_id, e.created_by, COUNT(*) AS n FROM signups s JOIN events e ON e.id = s.event_id
        WHERE s.status = 'pending' AND e.status = 'open' AND e.date >= ?1 GROUP BY e.id LIMIT 100)
      SELECT ev.id, ev.title, ev.date, ev.n, (SELECT json_group_array(m.id) FROM members m WHERE
          (m.id = ev.created_by AND m.role IN ('chair', 'director', 'staff', 'coach'))
          OR (ev.team_id IS NULL AND m.role IN ('chair', 'staff'))
          OR (ev.team_id IS NOT NULL AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.member_id = m.id AND tm.team_id = ev.team_id AND tm.status = 'active' AND tm.role IN ('lead', 'officer')))) AS mgr
      FROM ev`).bind(tpDate(now)).all()).results;
    // 每場一則、沒有個別標記：所有人一次寫完，完成標記在同一個 batch（不會只送一半又重送）
    const notes = evs.flatMap((ev) => parseQ(ev.mgr).map((mid) => ({ member_id: mid, ref: `sr:${ev.id}`, tag: `review-${ev.id}`, url: `/#/e/${ev.id}/stats?f=pending`,
      title: `還有 ${ev.n} 筆待審核：${ev.title}`, body: `活動 ${tpDay(ev.date)}，請在活動開始前處理` })));
    if (fits(env, notifyCost(notes.length) + 1, 'signupReviews')) {
      await notifyMany(env, 'todo', notes, { kind: 'event', also: [doneStmt(env, 'signup_review_digest', tpDate(now))] });
      n = notes.length;
    } else { await yieldStmt(env, 'signup_review_digest').run(); done = false; }   // 留到下個整點，下面的逾期失效照樣做
  }
  // 逾期失效：結束時間（或集合＋120 分）＋15 分；取消的活動直接失效、不另外通知（已收到取消通知）
  const nowTp = tpNow(now.getTime());
  const evs = (await env.DB.prepare(`SELECT e.id, e.title, e.date, e.gather_time, e.end_time, e.status,
      (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status = 'pending') AS pn FROM events e
    WHERE (e.date <= ? OR e.status = 'cancelled') AND EXISTS (SELECT 1 FROM signups s WHERE s.event_id = e.id AND s.status = 'pending') LIMIT 100`)
    .bind(tpDate(now)).all()).results;
  for (const ev of evs) {
    const g = /^\d{2}:\d{2}$/.test(ev.gather_time || '') ? ev.gather_time : '23:59';
    const endHm = /^\d{2}:\d{2}$/.test(ev.end_time || '') && ev.end_time > g ? ev.end_time : null;
    const until = endHm ? shiftDays(`${ev.date}T${endHm}`, 15 / 1440) : shiftDays(`${ev.date}T${g}`, 135 / 1440);
    if (ev.status !== 'cancelled' && nowTp < until) continue;
    if (!fits(env, 3 + notifyCost(ev.pn), 'signupReviews')) return { done: false, result: n };
    // RETURNING 只拿真的被這一句改到的人；兩句之間被核准或撤回的不會收到「已失效」
    const ids = (await env.DB.prepare("UPDATE signups SET status = 'cancel', review_note = ?, reg_consent_at = NULL WHERE event_id = ? AND status = 'pending' RETURNING member_id")
      .bind('主辦未處理，申請已失效', ev.id).all()).results.map((r) => r.member_id);
    if (ev.status === 'open' && ids.length) await notify(env, ids, 'change', { kind: 'signup', ref: `e:${ev.id}`, tag: `signup-${ev.id}`, url: `/#/e/${ev.id}`,
      title: `申請已失效：${ev.title}`, body: '主辦在活動結束前沒有處理你的申請' });
    await audit(env, null, null, 'signup.expire', 'event', ev.id, `${ids.length} 筆`);
    await settleTodo(env, `sr:${ev.id}`);
  }
  return { done, result: n };
}

// 候補遞補補做：刪除帳號、調高名額、核准時額度不夠，沒能當場遞補的場次（有名額空著而且有人候補），每小時每場最多跑 1 輪 promote()
//   每場的句數固定（最多 PROMOTE_ROUND＋PROMOTE_TAIL），一個整點最多 5 場；排在其他工作後面，只用剩下的額度
//   「遞補不了」的場次（候補的人都因為庫存不夠排不進去）：把當下的狀態（名額、商品設定、報名人數）記在 job_runs 的 promote_sweep，
//   狀態沒變就不再試，隔天也重新試一次；不然這種場次每個整點都會白白花掉額度
const SWEEP_SIG = `events.capacity || ':' || length(COALESCE(events.items, '')) || ':' ||
  (SELECT COUNT(*) || '/' || COALESCE(SUM(length(x.items)), 0) FROM signups x WHERE x.event_id = events.id AND x.status IN ('in', 'wait')) || ':' || ?1`;
const SWEEP_SQL = `FROM events WHERE status = 'open' AND date >= ?1 AND capacity > 0
  AND EXISTS (SELECT 1 FROM signups w WHERE w.event_id = events.id AND w.status = 'wait')
  AND (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'in') < capacity
  AND NOT EXISTS (SELECT 1 FROM job_runs j WHERE j.job = 'promote_sweep' AND json_extract(j.last_run, '$."' || events.id || '"') = ${SWEEP_SIG})`;
async function promoteSweep(env, now) {
  const day = tpDate(now);
  const evs = (await env.DB.prepare(`SELECT ${eventCols}, ${SWEEP_SIG} AS sweep_sig ${SWEEP_SQL} ORDER BY date LIMIT 5`).bind(day).all()).results;
  let n = 0, done = true;
  const stuck = {};
  for (const ev of evs) {
    if (!fits(env, PROMOTE_ROUND + PROMOTE_TAIL + 1, 'promoteSweep')) { done = false; break; }
    const got = await promote(env, ev, { rounds: 1, reserve: 1 });
    if (!got.length && !got.more) stuck[ev.id] = ev.sweep_sig;
    n += got.length;
  }
  if (Object.keys(stuck).length) {
    // 只留今天的紀錄（簽章最後是日期），加上這次遞補不了的場次
    let old = {};
    try { old = JSON.parse((env.probe?.jobs?.promote_sweep || [])[0] || '{}') || {}; } catch {}
    const keep = Object.fromEntries(Object.entries(old).filter(([, v]) => String(v).endsWith(`:${day}`)));
    await env.DB.prepare(`INSERT INTO job_runs (job, last_run) VALUES ('promote_sweep', ?1) ON CONFLICT(job) DO UPDATE SET last_run = excluded.last_run`)
      .bind(JSON.stringify({ ...keep, ...stuck })).run();
  }
  return { done, result: n };
}

// 附近即時影像：每天同步一次鏡頭清單（台北 04:00 起水利署與水利處、05:00 起公路局；錯過整點就在下一個整點補跑）
//   功能開關（features.cams）關閉時完全不跑；只同步開啟的來源；失敗或筆數驟減時不寫入、不停用，隔天再試
//   每次排程最多同步一個來源（公路局 XML 約 1.7 MB，解析很吃 CPU，不跟別的來源擠在同一次執行）
//   開始前先佔用（job_runs 的 cams.<來源>）並把來源標成「同步中」：執行被強制中斷時，管理後台看得到，下個整點也會重跑（最多 3 次）
//   offline 的來源（公路局）清單改用電腦上的同步工具 tools/cams-sync.mjs；排程只做每天一次的健康狀態重設（1 句）：
//     連續抓不到畫面而被設成 down 的鏡頭隔天再給一次機會，不然短暫斷線的鏡頭會好幾個月都不出現
const camsDue = (t, s) => Object.entries(Cams.SOURCES).filter(([k, S]) => S.list && s.cams_on.includes(k) && t.h >= S.hour && open(s, `cams.${k}`, t.date)).map(([k]) => k);
async function syncCams(env, now) {
  const s = env.probe || await cronProbe(env, now);
  if (!Cams.featureOn(s.features)) return { done: true, result: null };
  const day = tpDate(now), out = {};
  for (const k of camsDue(tparts(now), s)) {
    if (!fits(env, 9, 'cams')) return { done: false, result: 'deferred' };
    if (!(await claim(env, `cams.${k}`, day))) continue;
    if (Cams.SOURCES[k].offline) { await env.DB.batch([env.DB.prepare(Cams.HEALTH_RESET).bind(k), doneStmt(env, `cams.${k}`, day)]); out[k] = 'reset'; continue; }
    let r;
    try { r = await Cams.syncSource(env, k); } catch (e) {
      const msg = String(e?.message || e).slice(0, 120);
      await Cams.markFailed(env, k, msg);
      r = { error: msg };
    }
    // 同步失敗（來源連不上、筆數驟減）也算今天做過了，隔天再試（管理後台看得到錯誤）
    await doneStmt(env, `cams.${k}`, day).run();
    return { done: true, result: { ...out, [k]: r.error ? `error: ${r.error}` : r.count } };
  }
  return { done: true, result: Object.keys(out).length ? out : null };
}

// 跑者休息站：台北 01、02、06 點（避開 04–05 點攝影機）各跑一個到期的來源（排程工作 rest，見 JOBS）
//   每天、每週或每月一次（job_runs 的 rest.<來源> 以週期為 key）；失敗的來源隔天重試；分頁來源（臺灣騎跡）一輪沒跑完就每次排程續跑下一頁
//   功能開關（features.rest）關閉時完全不跑；有沒有到期的來源由每小時那一句 CRON_PROBE（rest_on 與 job_runs）判斷，不另外查
//   只跑 Worker 可以同步的來源（SOURCES 沒有標 local）；標 local 的只由維護工具（tools/rest-sync.mjs）同步
//   一次最多：佔用 1＋同步（1＋對外 2＋寫入 3＋rev 1）＋完成 1，失敗再加 1，約 10 個子請求（JOBS.rest.cost 12）
//   先用「retry:今天」佔住這一期、成功才改成這一期：執行到一半被平台強制中斷（超過 CPU 或 50 個子請求）時留下的是 retry，隔天會再跑；
//   管理後台把 retry 顯示成「沒有完成，隔天重試」
const periodOf = (every, now) => {
  const d = tpDate(now);
  if (every === 'month') return d.slice(0, 7);
  if (every === 'week') { const t = taipei(now); return tpDate(new Date(now.getTime() - ((t.getUTCDay() + 6) % 7) * 864e5)); }
  return d;
};
const REST_WORKER = Object.keys(Rest.SOURCES).filter((k) => !Rest.SOURCES[k].manual && !Rest.SOURCES[k].local);
// 這個整點要跑哪個來源：到期的來源優先，續跑的分頁來源排在後面；s 是 CRON_PROBE 的結果
function restPick(s, now) {
  const on = s.rest_on || {}, h = taipei(now).getUTCHours(), retry = `retry:${tpDate(now)}`;
  let pick = null;
  for (const k of REST_WORKER) {
    if (!Object.hasOwn(on, k)) continue;
    const S = Rest.SOURCES[k], last = (s.jobs[`rest.${k}`] || [])[0];
    if (S.pages && on[k]) { pick ??= { k, cont: true }; continue; }
    if (h < S.hour || last === periodOf(S.every, now) || last === retry) continue;
    return { k, cont: false };
  }
  return pick;
}
const restDue = (t, s) => Rest.ALLOWED_HOURS.includes(t.h) && REST_WORKER.length > 0 && Rest.featureOn(s.features) && !!restPick(s, t.at);
async function syncRest(env, now) {
  if (!Rest.ALLOWED_HOURS.includes(taipei(now).getUTCHours()) || !REST_WORKER.length) return { done: true, result: null };
  const s = env.probe || await cronProbe(env, now);
  if (!Rest.featureOn(s.features)) return { done: true, result: null };
  const pick = restPick(s, now);
  if (!pick) return { done: true, result: null };
  const { k } = pick, retry = `retry:${tpDate(now)}`;
  // 今天只跑一次（同時兩個排程時只有一個拿得到）：寫入與判斷同一個指令；先寫 retry，成功才標成這一期跑完
  if (!pick.cont && !(await env.DB.prepare(`INSERT INTO job_runs (job, last_run) VALUES (?, ?)
    ON CONFLICT(job) DO UPDATE SET last_run = excluded.last_run WHERE job_runs.last_run IS NOT excluded.last_run RETURNING job`).bind(`rest.${k}`, retry).first())) return { done: true, result: null };
  if (Rest.mockKilled(env, k)) return { done: true, result: { [k]: 'killed' } };   // 測試：模擬在這之後被平台強制中斷
  let r;
  try { r = await Rest.syncSource(env, k); } catch (e) {
    const msg = String(e?.message || e).slice(0, 120);
    await Rest.markFailed(env, k, msg);
    r = { error: msg };
  }
  // 成功：這一期跑完；失敗：留著 retry（這一期還要再試，但今天不再試，避免每小時都打同一個壞掉的來源）；分頁來源的 cursor 不動，下次從同一頁續跑
  if (!r.error && !pick.cont) await env.DB.prepare('UPDATE job_runs SET last_run = ? WHERE job = ?').bind(periodOf(Rest.SOURCES[k].every, now), `rest.${k}`).run();
  return { done: true, result: { [k]: r.error ? `error: ${r.error}` : r.pages ? `${r.count}（${r.page}/${r.pages}）` : r.count } };
}

// 推播佇列：用這次執行剩下的額度送；JOB_DISPATCH=self 時還有剩就開下一段自己的執行（Jobs.drainPush，最多 plan.pushDepth 段）
async function pushJob(env, now, ctx) {
  const r = await drainAll(env);
  if (r.more && env.JOB_DISPATCH === 'self' && ctx?.exports?.Jobs) { env.budget.take('rpc'); ctx.waitUntil(ctx.exports.Jobs.drainPush({ depth: 1 }).catch((e) => console.error('drainPush', e))); }
  return { done: !r.more, result: r.sent };
}

// 一次執行結束：寫 log（用量偏高、因額度停下、超過計數），停下或超過時另外記一列 budget_log（佔 1 個預留額度）
async function finishBudget(e, b) {
  logBudget(b);
  if (!b.stopped.length && !b.over) return;
  const name = b.kind === 'request' ? b.name : `${b.name}${b.stopped.length ? `:${b.stopped[0].split(':')[0]}` : ''}`;
  try {
    await e.DB.prepare(`INSERT INTO budget_log (day, name, kind, n, stopped, over, max_sub, last_at) VALUES (date('now'), ?1, ?2, 1, ?3, ?4, ?5, datetime('now'))
      ON CONFLICT(day, name) DO UPDATE SET n = n + 1, stopped = stopped + excluded.stopped, over = over + excluded.over, max_sub = MAX(max_sub, excluded.max_sub), last_at = excluded.last_at`)
      .bind(name.slice(0, 80), b.kind, b.stopped.length ? 1 : 0, b.over ? 1 : 0, b.sub).run();
  } catch (err) { console.error('budget_log', err?.message || err); }
}

// ---- 排程分派 ----
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const tparts = (now) => {
  const t = taipei(now);
  return { at: now, h: t.getUTCHours(), d: t.getUTCDate(), m: t.getUTCMonth(), date: tpDate(now), prev: prevMonthOf(t), q: quarterOf(t) };
};
// 每小時一句：哪些工作有事要做（job_runs 的狀態、功能開關、各工作的資料上有沒有待處理的列）
const CRON_PROBE = `SELECT
  (SELECT json_group_object(job, json_array(last_run, claim_key, claim_at, attempts, last_error, cursor IS NOT NULL)) FROM job_runs) AS jobs,
  (SELECT value FROM settings WHERE key = 'features') AS features,
  (SELECT json_group_array(source) FROM cam_sources WHERE enabled = 1) AS cams_on,
  (SELECT json_group_object(source, cursor IS NOT NULL) FROM rest_sources WHERE enabled = 1) AS rest_on,
  EXISTS (SELECT 1 FROM events WHERE date = ?1 AND status = 'open' AND kind != 'survey' AND gather_time > '' AND remind_hour_at IS NULL AND gather_time > ?6 AND gather_time <= ?2) AS ev_hour,
  EXISTS (SELECT 1 FROM events WHERE date = ?3 AND status = 'open' AND kind != 'survey' AND remind_day_at IS NULL) AS ev_day,
  EXISTS (SELECT 1 FROM events WHERE date = ?3 AND status = 'open' AND kind != 'survey' AND spot_id IS NOT NULL AND wx_alert_at IS NULL) AS ev_wx,
  EXISTS (SELECT 1 FROM events WHERE date = ?1 AND status = 'open' AND kind IN ('track','core','long','race','other') AND followup_at IS NULL AND gather_time > '') AS fu,
  EXISTS (SELECT 1 FROM members WHERE membership = 'active' AND paid_until BETWEEN ?1 AND ?4
          AND renew_notice IS NOT (paid_until || ':' || CASE WHEN julianday(paid_until) - julianday(?1) <= 0 THEN 0
                                   WHEN julianday(paid_until) - julianday(?1) <= 7 THEN 7 ELSE 30 END)) AS rn,
  EXISTS (SELECT 1 FROM events WHERE open_notified_at IS NULL AND signup_start IS NOT NULL AND signup_start <= ?5 AND status = 'open' AND date >= ?1) AS so,
  EXISTS (SELECT 1 FROM signups WHERE status = 'pending') AS sr,
  EXISTS (SELECT 1 FROM signups s JOIN events e ON e.id = s.event_id WHERE s.status = 'pending' AND (e.date <= ?1 OR e.status = 'cancelled')) AS sr_exp,
  EXISTS (SELECT 1 FROM audit_digests WHERE day = ?7) AS ad,
  EXISTS (SELECT 1 ${SWEEP_SQL}) AS ps,
  EXISTS (SELECT 1 FROM push_queue WHERE lease_until IS NULL OR lease_until < datetime('now')) AS pq`;
async function cronProbe(env, now) {
  const t = taipei(now), nowMin = t.getUTCHours() * 60 + t.getUTCMinutes(), today0 = tpDate(now);
  // ev_hour：集合時間落在 (現在, 現在 + 120 分]、還沒提醒過（延後的整點也還能補送，見 remindEvents）
  const r = await env.DB.prepare(CRON_PROBE).bind(today0, hhmm(Math.min(nowMin + 120, 1439)), tpDate(new Date(now.getTime() + 864e5)),
    tpDate(new Date(now.getTime() + 30 * 864e5)), tpNow(now.getTime()), hhmm(nowMin), utcYesterday(now)).first();
  const parse = (v, d) => { try { return JSON.parse(v || '') ?? d; } catch { return d; } };
  return { ...r, jobs: parse(r.jobs, {}), cams_on: parse(r.cams_on, []), rest_on: parse(r.rest_on, {}) };
}
// 這個 key 還有沒有事要做：還沒完成，也沒有別人正在跑（15 分鐘內），也還沒放棄（失敗 3 次）
//   claim_at 是資料庫的 datetime('now')（真實時間），所以跟 Date.now() 比
function open(s, job, key) {
  const [last, ck, at, attempts] = s.jobs[job] || [];
  if (last === key) return false;
  if (ck !== key) return true;
  if (attempts >= 3) return false;
  return !at || Date.parse(`${at.replace(' ', 'T')}Z`) < Date.now() - 15 * 60e3;
}
// cost＝這項工作在「有事可做」時最多用多少子請求；min＝開始至少要有多少（每處理一項之前工作自己會再確認）；
// own＝一定要開自己的執行（每日備份的 cost 是開始一段至少要剩多少，一段會用掉剩下的額度）；hops＝self 模式一個整點可以接著做好幾段；
// idle＝沒事做時 /api/dev/cron 回傳的值（維持舊的回傳格式）
// 每日備份有事要做：今天的還沒做（03:00 起），或上一份（每日或手動）分段還沒做完（不限時段，接著做）
const bkOpen = (s, job) => { const [, ck, , attempts, , cursor] = s.jobs[job] || []; return !!(cursor && ck && attempts < 3 && open(s, job, ck)); };
const JOBS = {
  // 集合前提醒有時效，排在每日備份前面（便宜，而且延到下個整點就晚了）；備份本來就可以延到下個整點
  events:        { prio: 5, cost: 12, min: 4, idle: 0, due: (t, s) => !!s.ev_hour || (t.h >= 20 && !!s.ev_day), run: remindEvents },
  backup:        { prio: 10, own: true, cost: 20, idle: null, hops: true, due: (t, s, env) => !!backupStore(env) && !!env.BACKUP_KEY
    && ((t.h >= 3 && open(s, 'backup', t.date)) || bkOpen(s, 'backup') || bkOpen(s, 'backup_manual')), run: dailyBackup },
  signupOpen:    { prio: 21, cost: 12, min: 4, idle: 0, due: (t, s) => !!s.so, run: signupOpen },
  followups:     { prio: 22, cost: 12, min: 4, idle: 0, due: (t, s) => !!s.fu, run: runFollowups },
  weather:       { prio: 23, cost: 20, min: 8, idle: 0, due: (t, s) => t.h >= 20 && !!s.ev_wx, run: weatherAlerts },
  signupReviews: { prio: 24, cost: 12, min: 4, idle: 0, due: (t, s) => !!s.sr_exp || (t.h >= 20 && !!s.sr && open(s, 'signup_review_digest', t.date)), run: signupReviews },
  renewals:      { prio: 30, cost: 10, min: 4, idle: 0, due: (t, s) => !!s.rn, run: remindRenewals },
  retention:     { prio: 40, cost: 20, idle: null, due: (t, s) => t.h >= 3 && open(s, 'retention', t.date), run: retention },
  auditDigest:   { prio: 41, cost: 6, idle: null, due: (t, s, env) => t.h >= 9 && !!env.AUDIT_KEY && !s.ad, run: auditDigest },
  monthSummary:  { prio: 42, cost: 12, idle: 0, due: (t, s) => t.d === 1 && t.h >= 9 && open(s, 'month_summary', t.prev), run: monthSummary },
  review:        { prio: 43, cost: 10, idle: 0, due: (t, s) => t.d === 1 && t.m % 3 === 0 && t.h >= 9 && open(s, 'quarterly_review', t.q), run: quarterlyReview },
  fatigue:       { prio: 44, cost: 12, min: 6, idle: 0, due: (t, s) => t.h >= 21 && open(s, 'fatigue', t.date), run: fatigueCheck },
  cams:          { prio: 50, cost: 9, idle: null, due: (t, s) => Cams.featureOn(s.features) && t.h >= 4 && camsDue(t, s).length > 0, run: syncCams },
  // 跑者休息站：01、02、06 點各一個到期的來源（同步一個來源不能中途停，開始前要有整份額度）
  rest:          { prio: 55, cost: 12, idle: null, due: restDue, run: syncRest },
  // 候補遞補補做：排在其他工作後面，只用剩下的額度（每場固定句數，最多 5 場）
  promoteSweep:  { prio: 80, cost: 40, min: PROMOTE_ROUND + PROMOTE_TAIL + 1, idle: 0, due: (t, s) => !!s.ps, run: promoteSweep },
  push:          { prio: 90, cost: 15, min: 8, idle: 0, due: (t, s, env) => !!s.pq || !!env.wantDrain, run: pushJob },
};
const JOB_ORDER = Object.keys(JOBS).sort((a, b) => JOBS[a].prio - JOBS[b].prio);

// 跑一項工作：例外不往外丟，記到 job_runs.last_error；佔用後連續失敗 3 次寫稽核 cron.gave_up（管理後台會用紅字顯示）
//   佔用之前就出錯（不用佔用的工作，例如活動提醒、推播）：記在工作名稱那一列，連續失敗幾次就是 attempts，下次成功時清掉（見 cronTick）
async function runJob(e, name, now, ctx) {
  e.claimed = null; e.jobName = name;
  try {
    if (e.failBefore === name) throw new Error('測試：佔用之前失敗');   // /api/dev/cron?failpre=，只有 DEV_LOGIN=1 的本機
    return await JOBS[name].run(e, now, ctx);
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 200), c = e.claimed;
    console.error('cron', name, err);
    try {
      const stmts = [c ? failStmt(e, c.job, msg)
        : e.DB.prepare(`INSERT INTO job_runs (job, last_run, last_error, attempts) VALUES (?1, '', ?2, 1)
          ON CONFLICT(job) DO UPDATE SET last_error = excluded.last_error, attempts = CASE WHEN job_runs.claim_key IS NULL THEN job_runs.attempts + 1 ELSE job_runs.attempts END`).bind(name, msg)];
      if (c && c.attempts >= 3) stmts.push(await auditStmt(e, null, null, 'cron.gave_up', 'system', c.job, `${c.job}｜${c.key}｜${msg}`));
      await e.DB.batch(stmts);
    } catch (x) { console.error('cron fail', name, x); }
    return { done: false, error: true, result: `error: ${msg}` };
  } finally { e.claimed = null; e.jobName = null; }
}
// 被平台終止的工作（CPU 或子請求超過上限）不會跑到上面的 catch：佔用還在、沒有錯誤訊息，attempts 已經加 1。
//   rows：[job, claim_key, attempts]。補記錯誤並釋放佔用（下個整點重跑）；已經是第 3 次就寫 cron.gave_up（管理後台紅字）
async function reapStmts(e, rows, msg) {
  const out = [];
  for (const [job, key, attempts] of rows) {
    out.push(failStmt(e, job, msg));
    if (attempts >= 3) out.push(await auditStmt(e, null, null, 'cron.gave_up', 'system', job, `${job}｜${key}｜${msg}`));
  }
  return out;
}
// 每小時開頭：佔用超過 15 分鐘、沒有錯誤訊息的（整次執行被終止，例如 inline 模式的工作），補記一次
const staleClaims = (s) => Object.entries(s.jobs).filter(([, [, ck, at, , err]]) => ck && at && !err && Date.parse(`${at.replace(' ', 'T')}Z`) < Date.now() - 15 * 60e3)
  .map(([job, [, ck, , attempts]]) => [job, ck, attempts]);
const snap = (b) => ({ d1: b.d1, kv: b.kv, fetch: b.fetch, rpc: b.rpc, sub: b.sub });
const delta = (a, b) => ({ kind: 'inline', d1: b.d1 - a.d1, kv: b.kv - a.kv, fetch: b.fetch - a.fetch, rpc: b.rpc - a.rpc, sub: b.sub - a.sub });

// 每小時：1 句看哪些工作有事要做 → 依優先順序執行
//   own 的工作（每日備份）用 ctx.exports.Jobs 開自己的執行；子執行回報的用量，父執行保守地加回自己的預算
//     （假設呼叫自己和父執行共用額度，就算真的共用也不會超過）；沒有 ctx.exports 就在父執行裡直接跑
//   JOB_DISPATCH=self：每項工作都開自己的執行（staging 確認呼叫自己會拿到新的額度之後才開，只改設定）
//   inline（預設）：在父執行裡直接跑，開始前先確認額度，不夠就留到下個整點
async function cronTick(e, now, ctx, opt = {}) {
  const t = tparts(now), s = await cronProbe(e, now);
  e.probe = s;
  const res = {}, jobs = {};
  const self = opt.dispatch === 'self' || e.JOB_DISPATCH === 'self';
  const exp = ctx?.exports?.Jobs;
  // 上一次被終止、沒留下紀錄的工作：先補記（會改到 job_runs，所以之後的判斷用更新過的狀態）
  const stale = staleClaims(s);
  if (stale.length && e.budget.room(stale.length * 2 + 4)) {
    try {
      await e.DB.batch(await reapStmts(e, stale, '中途被終止（CPU 或子請求超過上限），沒有留下錯誤訊息'));
      for (const [job] of stale) { const j = s.jobs[job]; j[2] = null; j[4] = '中途被終止'; }
    } catch (err) { console.error('cron reap', err); }
  }
  for (const name of JOB_ORDER) {
    const J = JOBS[name];
    res[name] = J.idle;
    if (opt.skip?.has(name)) continue;
    let due = false;
    try { due = J.due(t, s, e); } catch (err) { console.error('cron due', name, err); }
    if (!due) continue;
    if ((J.own || self) && exp) {
      // 每日備份是分段做的：self 模式（每次呼叫自己都有自己的額度）一個整點可以接著做好幾段；inline 一個整點一段
      const hops = J.hops && self ? planOf(e).backupHops : 1;
      for (let hop = 0; hop < hops; hop++) {
        if (!self && !e.budget.room(J.cost + 1)) { e.budget.stop(name); res[name] = 'deferred'; break; }
        try {
          e.budget.take('rpc');
          const r = await exp.run({ job: name, at: now.getTime(), inherit: self ? 0 : e.budget.sub, ...(opt.fail ? { fail: opt.fail } : {}), ...(opt.seg ? { seg: opt.seg } : {}), ...(opt.failpre ? { failpre: opt.failpre } : {}) });
          if (!self) e.budget.absorb(r.used);
          res[name] = r.result ?? (r.done ? J.idle : 'deferred');
          jobs[hop ? `${name}#${hop + 1}` : name] = r.budget;
          if (r.done || r.error) break;
        } catch (err) {
          // 子執行被平台終止（CPU、子請求超過上限）：子執行的 catch 不會跑，這裡補記錯誤原文；第 3 次寫 cron.gave_up
          const msg = String(err?.message || err).slice(0, 120);
          console.error('cron rpc', name, err);
          res[name] = `error: ${msg}`;
          try {
            if (e.budget.room(2)) {
              const rows = (await e.DB.prepare("SELECT job, claim_key, attempts FROM job_runs WHERE claim_key IS NOT NULL AND claim_at >= datetime('now', '-15 minutes') AND last_error IS NULL").all()).results;
              if (rows.length && e.budget.room(rows.length * 2)) await e.DB.batch(await reapStmts(e, rows.map((r) => [r.job, r.claim_key, r.attempts]), `中途被終止：${msg}`));
            }
          } catch (x) { console.error('cron reap', x); }
          break;
        }
      }
      continue;
    }
    if (!e.budget.room(J.min ?? J.cost)) { e.budget.stop(name); res[name] = 'deferred'; continue; }
    const before = snap(e.budget);
    const r = await runJob(e, name, now, ctx);
    res[name] = r.result ?? (r.done ? J.idle : 'deferred');
    jobs[name] = delta(before, e.budget);
    // 之前在佔用前就失敗過（記在工作名稱那一列）：這次沒有出錯就清掉
    if (!r.error && s.jobs[name]?.[4] && !s.jobs[name][1] && e.budget.room(1)) {
      try { await e.DB.prepare('UPDATE job_runs SET last_error = NULL, attempts = 0 WHERE job = ?1 AND claim_key IS NULL').bind(name).run(); } catch {}
    }
  }
  return { res, jobs };
}

// 排程工作的獨立執行入口（只給內部呼叫）
//   資安（ISO 27001 A.8.3／A.8.20）：具名的 WorkerEntrypoint 從網際網路連不到，HTTP 只會進到 default.fetch；
//   只有同一支 Worker 的 ctx.exports（或同帳號裡有人另外設定 service binding）叫得到。
//   參數白名單：job 必須在 JOBS 裡、時間只能在現在前後 3 小時內（DEV_LOGIN=1 的本機測試可以模擬其他時間）；回傳值只有筆數與用量，不含個資與 secrets
export class Jobs extends WorkerEntrypoint {
  async run({ job, at, inherit = 0, fail, seg, failpre } = {}) {
    const ok = typeof job === 'string' && Object.hasOwn(JOBS, job);
    const t = Number(at);
    if (!ok || !Number.isFinite(t) || (Math.abs(Date.now() - t) > 3 * 3600e3 && this.env.DEV_LOGIN !== '1')) throw new Error('bad job');
    const b = new Budget(this.env, { kind: 'job', name: job, inherit: this.env.JOB_DISPATCH === 'self' ? 0 : inherit });
    const e = invocationEnv(this.env, this.ctx, b);
    if (this.env.DEV_LOGIN === '1') {
      if (fail) e.failAfterClaim = String(fail);
      if (failpre) e.failBefore = String(failpre);
      if (Number(seg) > 0) e.backupSeg = Number(seg);
    }
    try {
      const r = await runJob(e, job, new Date(t), this.ctx);
      await settled(e);   // defer 裡的工作也算進這次的用量
      // 這項工作排進佇列的推播，用剩下的額度先送一段（每日備份的 CPU 已經用掉大半，不在同一次執行裡送）
      if (e.wantDrain && job !== 'push' && job !== 'backup') { await drain(e, { max: planOf(e).pushPerHop }).catch((x) => console.error('drain', x)); await settled(e); }
      return { done: !!r.done, error: !!r.error, result: r.result ?? null, used: b.sub - b.inherit, budget: b.summary() };
    } finally { await finishBudget(e, b); }
  }
  // staging 驗證用（POST /api/admin/selftest，只有 SELFTEST=1）：這一層照官方文件會超過免費方案的上限（40＋60 句），
  //   看平台實際上是擋下還是放行，再呼叫下一層（最多 3 層）。直接用原本的 DB 綁定，不經過計數
  async selftest({ depth = 1 } = {}) {
    const d = Number(depth);
    if (this.env.SELFTEST !== '1' || !Number.isInteger(d) || d < 1 || d > 3) throw new Error('bad selftest');
    const out = { layer: d, seq: null, batch: null, cpuMs: 0, error: null };
    try {
      for (let i = 0; i < 40; i++) await this.env.DB.prepare('SELECT 1').first();
      out.seq = 'ok';
      await this.env.DB.batch(Array.from({ length: 60 }, () => this.env.DB.prepare('SELECT 1')));
      out.batch = 'ok';
      const t0 = Date.now(); let x = 0;
      while (Date.now() - t0 < 8) x = (x * 31 + 7) % 1000003;
      out.cpuMs = Date.now() - t0;
    } catch (e) { out.error = String(e?.message || e).slice(0, 300); }
    let next = [];
    if (d < 3 && this.ctx.exports?.Jobs) {
      try { next = await this.ctx.exports.Jobs.selftest({ depth: d + 1 }); } catch (e) { next = [{ layer: d + 1, error: String(e?.message || e).slice(0, 300) }]; }
    }
    return [out, ...next];
  }
  // 推播佇列的下一段（只在 JOB_DISPATCH=self 時由 pushJob 呼叫）：depth 必須在 1–plan.pushDepth 之間
  async drainPush({ depth = 0 } = {}) {
    const d = Number(depth), plan = planOf(this.env);
    if (!Number.isInteger(d) || d < 1 || d > plan.pushDepth) throw new Error('bad depth');
    const b = new Budget(this.env, { kind: 'push', name: `drain#${d}` }), e = invocationEnv(this.env, this.ctx, b);
    try {
      const r = await drainAll(e);
      if (r.more && d < plan.pushDepth && this.env.JOB_DISPATCH === 'self' && this.ctx.exports?.Jobs) {
        b.take('rpc');
        this.ctx.waitUntil(this.ctx.exports.Jobs.drainPush({ depth: d + 1 }).catch((x) => console.error('drainPush', x)));
      }
      await settled(e);
      return { sent: r.sent, more: r.more };
    } finally { await finishBudget(e, b); }
  }
}

// 路由樣板（給執行額度紀錄用）：路徑裡像 id 的片段（6 個字元以上而且含數字或底線）一律換成 :id，紀錄裡不會出現個資或 token
//   （rid() 產生的 id 是 16 個小寫英數字，全是字母的機率很小，也一併當成 id）
const routeName = (path) => path.split('/').map((p) => (p.length >= 6 && (/[\d_A-Z]/.test(p) || /^[a-z]{16,}$/.test(p)) ? ':id' : p)).join('/').slice(0, 80);
const LOCAL = ['localhost', '127.0.0.1'];

// 開發用路由（只有 .dev.vars 設 DEV_LOGIN=1 而且在 localhost 才有效，正式環境不會有這個設定）
async function devRoute(req, env, ctx, url, path) {
  const q = url.searchParams;
  // 手動觸發排程，可指定時間 ?at=2026-10-03T12:00:00Z；&dispatch=self 強制走 ctx.exports.Jobs；&fail=backup 備份在佔用之後丟錯；&skip=backup 略過某些工作
  if (path === '/api/dev/cron') {
    const b = new Budget(env, { kind: 'cron', name: 'dev' }), e = invocationEnv(env, ctx, b);
    // &seg=2048：每日備份一段只做 2048 個字元（測試分段）；&failpre=auditDigest：那項工作在佔用之前丟錯
    const opt = { dispatch: q.get('dispatch') === 'self' ? 'self' : null, fail: str(q.get('fail'), 20) || null, skip: new Set((q.get('skip') || '').split(',').filter(Boolean)),
      seg: Number(q.get('seg')) > 0 ? Number(q.get('seg')) : null, failpre: str(q.get('failpre'), 20) || null };
    if (opt.fail) e.failAfterClaim = opt.fail;
    if (opt.failpre) e.failBefore = opt.failpre;
    if (opt.seg) e.backupSeg = opt.seg;
    const { res, jobs } = await cronTick(e, q.get('at') ? new Date(q.get('at')) : new Date(), ctx, opt);
    await settled(e);
    const summary = b.summary();
    await finishBudget(e, b);
    return json({ ...res, _budget: { root: summary, jobs } });
  }
  // 嚴格模式的違規紀錄（BUDGET_STRICT=1）：?clear=1 清空
  if (path === '/api/dev/budget-violations') {
    const list = strictViolations.slice();
    if (q.get('clear') === '1') strictViolations.length = 0;
    return json({ list });
  }
  // 排程工作的狀態（測試重跑與放棄用）
  //   ?stale=backup&key=2028-04-02&attempts=3：模擬「被平台終止」（佔用 20 分鐘前、沒有錯誤訊息）
  if (path === '/api/dev/jobs') {
    if (q.get('stale')) await env.DB.prepare(`INSERT INTO job_runs (job, last_run, claim_key, claim_at, attempts) VALUES (?1, '', ?2, datetime('now', '-20 minutes'), ?3)
      ON CONFLICT(job) DO UPDATE SET claim_key = ?2, claim_at = datetime('now', '-20 minutes'), attempts = ?3, last_error = NULL`)
      .bind(str(q.get('stale'), 40), str(q.get('key'), 40), Number(q.get('attempts')) || 1).run();
    return json({ jobs: (await env.DB.prepare('SELECT * FROM job_runs ORDER BY job').all()).results });
  }
  // 備份能不能解回來：在 Worker 裡解密、解壓縮指定（或最新）的備份，回傳每張表的筆數，和現在的筆數對照
  if (path === '/api/dev/backup-check') {
    const store = backupStore(env);
    if (!store || !env.BACKUP_KEY) return fail(400, '備份還沒設定');
    const list = await store.list(), label = q.get('label');
    const o = label ? list.find((x) => x.key === `daily/${label}.bin`) : list.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (!o) return fail(404, '沒有這份備份');
    const lb = o.key.slice(6, -4), man = await openBackup(env, new Uint8Array(await store.get(o.key)), `${lb}|manifest`);
    // 每一段解開、接回來（AAD 綁住日期與第幾段），算每張表的筆數；_rid 是分段用的 rowid，還原時不寫回
    const counts = Object.fromEntries(Object.keys(man.tables).map((t) => [t, 0]));
    let rid = 0;
    for (let n = 0; n < (man.parts || 0); n++) {
      const p = await openBackup(env, new Uint8Array(await store.get(partKey(lb, n))), `${lb}|${n}`);
      if (p.label !== lb || p.n !== n) return fail(500, '段落對不上');
      for (const [t, rows] of p.tables) { counts[t] = (counts[t] || 0) + rows.length; rid += rows.filter((r) => '_rid' in r).length; }
    }
    const names = Object.keys(counts).filter((n) => /^\w+$/.test(n));
    const cnt = await env.DB.batch(names.map((n) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${n}" ${BACKUP_FILTER[n] ? `WHERE (${BACKUP_FILTER[n]})` : ''}`)));
    return json({ key: o.key, format: man.format, version: man.version, at: man.at, parts: man.parts, rid, manifest: man.tables,
      counts, now: Object.fromEntries(names.map((n, i) => [n, cnt[i].results[0].n])) });
  }
  // 大量資料（執行額度測試用）：?members=300&subs=400 建假會員（id 以 b_ 開頭）與假訂閱；
  //   ?event=<id>&pending=60 讓前 60 位假會員在這場待審核（報名時間依序相差 1 秒）；?clear=1 全部清掉
  if (path === '/api/dev/seed-bulk') {
    if (q.get('clear') === '1') {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM push_subs WHERE endpoint LIKE 'https://fcm.googleapis.com/fcm/send/b\\_%' ESCAPE '\\'"),
        env.DB.prepare("UPDATE draws SET member_id = NULL WHERE member_id LIKE 'b\\_%' ESCAPE '\\'"),   // 得獎紀錄沒有 ON DELETE（刪帳號時匿名化）
        env.DB.prepare("DELETE FROM members WHERE id LIKE 'b\\_%' ESCAPE '\\'"),
        env.DB.prepare("DELETE FROM routes WHERE id LIKE 'b\\_%' ESCAPE '\\'"),
      ]);
      return json({ ok: true });
    }
    const nm = Math.min(Number(q.get('members')) || 0, 1000), ns = Math.min(Number(q.get('subs')) || 0, 2000), np = Math.min(Number(q.get('pending')) || 0, 1000);
    // ?routes=100&owner=<id>：替這位會員建小路線（id 以 b_ 開頭，?clear=1 一起清掉）
    const nr = Math.min(Number(q.get('routes')) || 0, 200), owner = str(q.get('owner'), 32);
    const seq = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => i));
    const stmts = [];
    if (nr && owner) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO routes (id, name, points, distance, shared, created_by)
      SELECT printf('b_r%04d_%s', value, ?2), '大量測試路線', '[[25,121],[25.001,121]]', 111, 0, ?2 FROM json_each(?1)`).bind(seq(nr), owner));
    if (nm) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO members (id, name, nickname, dist, grp, role, membership, consent_at, consent_version)
      SELECT printf('b_%04d', value), printf('大量測試%04d', value), NULL, 'fm', 'D', 'member', 'none', datetime('now'), '2026-10-03.1' FROM json_each(?)`).bind(seq(nm)));
    if (ns && nm) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO push_subs (endpoint, member_id, p256dh, auth)
      SELECT printf('https://fcm.googleapis.com/fcm/send/b_%05d', value), printf('b_%04d', value % ?2), 'BPmock', 'mock' FROM json_each(?1)`).bind(seq(ns), nm));
    if (np && q.get('event')) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO signups (id, event_id, member_id, name, grp, dist, status, created_at)
      SELECT printf('bs%04d%s', value, substr(?1, 1, 8)), ?1, printf('b_%04d', value), printf('大量測試%04d', value), 'D', 'fm', 'pending', datetime('now', printf('-%d seconds', ?2 - value))
      FROM json_each(?3)`).bind(str(q.get('event'), 32), np, seq(np)));
    // ?mute=<id>&cats=event：關掉某人的推播分類；?events=30&per=10&date=YYYY-MM-DD：建 30 場活動、每場 10 位假會員正取；?logs=YYYY-MM：每位假會員那個月一筆訓練紀錄
    if (q.get('mute')) stmts.push(env.DB.prepare('UPDATE members SET notif_mute = ? WHERE id = ?').bind(str(q.get('cats'), 100) || null, str(q.get('mute'), 32)));
    const ne = Math.min(Number(q.get('events')) || 0, 100), per = Math.min(Number(q.get('per')) || 0, 50), day = str(q.get('date'), 10);
    if (ne && isDate(day)) {
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO events (id, kind, title, date, gather_time, status, created_by, open_notified_at)
        SELECT printf('bev%s%02d', replace(?1, '-', ''), value), 'track', printf('大量活動 %d', value), ?1, '07:00', 'open', 't_chair', datetime('now') FROM json_each(?2)`).bind(day, seq(ne)));
      if (per) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO signups (id, event_id, member_id, name, grp, dist, status)
        SELECT printf('bsg%s%04d', replace(?1, '-', ''), value), printf('bev%s%02d', replace(?1, '-', ''), value / ?3), printf('b_%04d', value), printf('大量測試%04d', value), 'D', 'fm', 'in' FROM json_each(?2)`)
        .bind(day, seq(ne * per), per));
    }
    // ?waititems=<活動 id>&n=40：前 40 位假會員排進候補，每人訂 1 件商品 a（庫存不夠時永遠遞補不了）
    if (q.get('waititems')) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO signups (id, event_id, member_id, name, grp, dist, status, items, created_at)
      SELECT printf('bw%04d%s', value, substr(?1, 1, 8)), ?1, printf('b_%04d', value), printf('大量測試%04d', value), 'D', 'fm', 'wait', '[{"id":"a","qty":1}]', datetime('now', printf('-%d seconds', 1000 - value))
      FROM json_each(?2)`).bind(str(q.get('waititems'), 32), seq(Math.min(Number(q.get('n')) || 0, 500))));
    // ?droplogs=id1,id2,…：測試收尾一次刪掉大量訓練紀錄（不經過 API，不寫 log.delete 稽核，測試資料庫才不會因為收尾而變大）
    const drop = (q.get('droplogs') || '').split(',').filter((x) => /^[\w-]{1,32}$/.test(x)).slice(0, 1000);
    if (drop.length) stmts.push(env.DB.prepare('DELETE FROM training_logs WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(drop)));
    if (/^\d{4}-\d{2}$/.test(q.get('logs') || '') && nm) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO training_logs (id, member_id, date, status, km)
      SELECT printf('blg%s%04d', replace(?1, '-', ''), value), printf('b_%04d', value), ?1 || '-10', 'done', 10 FROM json_each(?2)`).bind(q.get('logs'), seq(nm)));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, members: nm, subs: ns, pending: np });
  }
  // 推播模擬（PUSH_MOCK=1）：收到的 endpoint 與 payload id；?clear=1 清空、?gone=<endpoint> 讓它回 410；
  //   ?verify=1 檢查每個 payload 的 id 都對得到「那台裝置的主人」的通知列
  if (path === '/api/dev/push-mock' && env.PUSH_MOCK === '1') {
    if (q.get('clear') === '1') { pushMock.list.length = 0; pushMock.gone.clear(); }
    if (q.get('gone')) pushMock.gone.add(str(q.get('gone'), 300));
    if (q.get('expire') === '1') await env.DB.prepare("UPDATE push_queue SET expires_at = datetime('now', '-1 minutes')").run();   // 佇列全部當作過期
    const [qn, sn] = await env.DB.batch([env.DB.prepare('SELECT COUNT(*) AS n FROM push_queue'), env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs')]);
    let bad = null;
    if (q.get('verify') === '1') {
      const pairs = JSON.stringify(pushMock.list.map((x) => [x.endpoint, x.id]));
      bad = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM json_each(?1) j LEFT JOIN notifications n ON n.id = json_extract(j.value, '$[1]')
        LEFT JOIN push_subs s ON s.endpoint = json_extract(j.value, '$[0]') WHERE n.id IS NULL OR s.member_id IS NOT n.member_id`).bind(pairs).first()).n;
    }
    return json({ list: pushMock.list, endpoints: new Set(pushMock.list.map((x) => x.endpoint)).size, queue: qn.results[0].n, subs: sn.results[0].n, bad });
  }
  // 通知列統計（測試用）：?like=標題開頭 → 幾列、幾位收件人；&ev=活動 id 開頭 → 其中幾場已經標記前一晚提醒
  if (path === '/api/dev/notes') {
    const like = `${str(q.get('like'), 40).replace(/[%_]/g, '')}%`, ev = `${str(q.get('ev'), 32).replace(/[%_]/g, '')}%`;
    const [a, c] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT member_id) AS m FROM notifications WHERE title LIKE ?').bind(like),
      env.DB.prepare('SELECT COUNT(*) AS n, SUM(remind_day_at IS NOT NULL) AS marked FROM events WHERE id LIKE ?').bind(ev),
    ]);
    return json({ rows: a.results[0].n, members: a.results[0].m, events: c.results[0].n, marked: c.results[0].marked || 0 });
  }
  // 送推播佇列（一次執行，用完額度為止）
  if (path === '/api/dev/drain') {
    const b = new Budget(env, { kind: 'push', name: 'dev' }), e = invocationEnv(env, ctx, b);
    const r = await drainAll(e);
    await settled(e);
    const left = (await env.DB.prepare('SELECT COUNT(*) AS n FROM push_queue').first()).n;
    return json({ ...r, queue: left, _budget: { root: b.summary(), jobs: {} } });
  }
  // 測試用：附近即時影像的假來源狀態（只有 CAM_MOCK=1）
  if (path === '/api/dev/cams-mock' && env.CAM_MOCK === '1') return json(Cams.mockControl(q));
  // 測試用：模擬在電腦上跑 tools/cams-sync.mjs 匯入 offline 來源（同一套解析、完整性檢查與 SQL；假來源不連外）
  if (path === '/api/dev/cams-import' && env.CAM_MOCK === '1') return json(await Cams.syncSource(env, str(q.get('source'), 10)));
  // 測試用：跑者休息站的假來源狀態（只有 REST_MOCK=1）
  if (path === '/api/dev/rest-mock' && env.REST_MOCK === '1') return json(Rest.mockControl(q));
  // 測試用：用假資料同步任何一個來源（包含在電腦上同步的來源；正式環境的「立即同步」不收這些來源），不限次數、一次一頁
  if (path === '/api/dev/rest-sync' && env.REST_MOCK === '1') {
    const k = q.get('source') || '', S = Rest.sourceOf(k);
    if (!S || S.manual) return json({ error: '沒有這個來源' }, 400);
    const r = await Rest.syncSource(env, k);
    return json(r, r.error ? 502 : 200);
  }
  // 測試用：在一個點周圍 3×3 格鋪滿休息站（每格 per×per 處，source＝man、id 以 man:zg 開頭），量讀取列數用；?clear=1 全部刪掉
  if (path === '/api/dev/rest-grid' && env.REST_MOCK === '1') {
    const del = env.DB.prepare("DELETE FROM rest_stops WHERE id LIKE 'man:zg%'"), bump = env.DB.prepare("UPDATE rest_sources SET rev = rev + 1 WHERE source = 'man'");
    if (q.get('clear') === '1') { await env.DB.batch([del, bump]); return json({ ok: true }); }
    const lat = Number(q.get('lat')), lng = Number(q.get('lng')), per = Math.min(Math.max(Number(q.get('per')) || 0, 1), 32);
    if (!Rest.inTaiwan(lat, lng)) return fail(400, '位置要在臺灣');
    const [cy, cx] = Rest.cellOf(lat, lng).split('_').map(Number), pts = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let i = 0; i < per; i++) for (let j = 0; j < per; j++) {
      const y = cy + dy, x = cx + dx, la = Math.round(((y + (i + 0.5) / per) / 50) * 1e6) / 1e6, lo = Math.round(((x + (j + 0.5) / per) / 50) * 1e6) / 1e6;
      pts.push([`man:zg${y}_${x}_${i}_${j}`, la, lo, Rest.cellOf(la, lo)]);
    }
    await env.DB.batch([del, env.DB.prepare(`INSERT INTO rest_stops (id, source, type, subtype, svc, access, name, lat, lng, cell, manual, hash)
      SELECT json_extract(value, '$[0]'), 'man', 'water', 'shop', 1, 'public', '格子測試', json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), 1, '' FROM json_each(?)`)
      .bind(JSON.stringify(pts)), bump]);
    return json({ ok: true, rows: pts.length });
  }
  // 測試用：直接設定某個次數限制的計數（?key=restday:t_other&count=500&sec=86400）；?get=1 讀回；?clear=1 刪掉；休息站每天上限的 isolate 記憶一起清
  if (path === '/api/dev/rate') {
    const key = str(q.get('key'), 80);
    if (!key) return fail(400, '缺 key');
    if (key.startsWith('restday:')) restSpent.delete(key.slice(8));
    if (q.get('get') === '1') return json((await env.DB.prepare('SELECT count, window_end FROM rate_limits WHERE key = ?').bind(key).first()) || { count: null });
    if (q.get('clear') === '1') await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
    else await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_end) VALUES (?1, ?2, datetime('now', '+' || ?3 || ' seconds'))
      ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_end = excluded.window_end`).bind(key, Number(q.get('count')) || 0, Math.max(Number(q.get('sec')) || 600, 1)).run();
    return json({ ok: true });
  }
  // 開發用登入
  if (path === '/api/dev/login' && req.method === 'GET') {
    const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(str(q.get('id'), 32)).first();
    if (!m) return fail(404, '找不到這個帳號');
    return new Response(null, { status: 302, headers: { location: '/#/', 'set-cookie': await startSession(env, m, req, { mfa: q.get('mfa') === '1' }) } });
  }
  return null;
}

async function handle(req, env, ctx, url, path) {
  // Google 登入是瀏覽器導向（GET、不是 JSON），走在下面的 CSRF 檢查之前
  if (path === '/api/google/start' && req.method === 'GET') return googleStart(env, url, url.searchParams.get('link') === '1' ? await currentMember(req, env) : null);
  if (path === '/api/google/callback' && req.method === 'GET') return googleCallback(req, env, url);
  if (path.startsWith('/api/dev/') && env.DEV_LOGIN === '1' && LOCAL.includes(url.hostname)) {
    const r = await devRoute(req, env, ctx, url, path);
    if (r) return r;
  }
  // 擋 CSRF：寫入類請求只收同源的 JSON
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, '來源不正確');
    if (req.headers.get('sec-fetch-site') === 'cross-site') return fail(403, '來源不正確');
    if ((req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json' && req.method !== 'DELETE') return fail(415, '請用 JSON');
  }
  try {
    const t0 = Date.now();
    const res = await api(req, env, path, req.method);
    // 伺服器處理時間（主要是等資料庫）：開發工具看得到，前端也用它分辨慢在網路還是伺服器
    try { res.headers.set('server-timing', `app;dur=${Date.now() - t0}`); } catch {}
    return res;
  } catch (e) {
    console.error('api', path, e);
    return fail(500, '伺服器錯誤');
  }
}

export default {
  async scheduled(event, env, ctx) {
    const b = new Budget(env, { kind: 'cron', name: 'hourly' }), e = invocationEnv(env, ctx, b);
    ctx.waitUntil(cronTick(e, new Date(event.scheduledTime), ctx)
      .then((r) => console.log('cron', JSON.stringify(r.res)), (err) => console.error('cron', err))
      .then(() => settled(e)).finally(() => finishBudget(e, b)));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    // 資安金鑰沒設定就不提供 API（避免用預設值雜湊 IP、稽核紀錄沒有簽章）
    if ((!env.HASH_SALT || !env.AUDIT_KEY) && !LOCAL.includes(url.hostname)) return new Response(JSON.stringify({ error: '系統設定不完整，請聯絡管理員' }), { status: 503, headers: { 'content-type': 'application/json' } });
    // 每次請求一個 env（綁定包裝成會計數的版本、這次請求專用的 ctx 與 defer），不改共用的 env
    const b = new Budget(env, { kind: 'request', name: `${req.method} ${routeName(path)}` }), e = invocationEnv(env, ctx, b), plan = planOf(env);
    let res;
    try {
      res = await handle(req, e, ctx, url, path);
      // 推播：這次請求排進佇列的，回應送出後用剩下的額度先送一段；一般流量看到佇列有待送的，順便送 plan.pushKick 台
      if (e.wantDrain) { e.drained = true; e.defer(drain(e, { max: plan.pushPerHop })); }
      else if (e.pushKick && b.room(4 + plan.pushKick)) { e.drained = true; e.defer(drain(e, { max: plan.pushKick })); }
    } finally {
      // defer 裡才發的通知（例如 Google 登入後的新裝置提醒）：等 defer 都結束再看一次，有排進佇列就送
      ctx.waitUntil(settled(e).then(async () => {
        if (e.wantDrain && !e.drained) { e.drained = true; await drain(e, { max: plan.pushPerHop }).catch((x) => console.error('drain', x)); }
      }).then(() => finishBudget(e, b)));
    }
    // 測試用：回應帶這次請求到目前為止用掉的額度（只有 DEV_LOGIN=1 的本機）
    if (env.DEV_LOGIN === '1' && LOCAL.includes(url.hostname)) {
      try { const x = b.summary(); res.headers.set('x-budget', `d1=${x.d1};kv=${x.kv};fetch=${x.fetch};rpc=${x.rpc};sub=${x.sub};rows=${x.rows}`); } catch {}
    }
    return res;
  },
};
