// 耕跑團 Cultivation in Life Run — API（Cloudflare Worker ＋ D1）
// 資安設計對應 ISO/IEC 27001:2022 附錄 A（詳見 docs/SECURITY.md）：
//   A.5.15／A.5.18 存取控制：最小權限，特權身分只能由理事長指派，不能靠共用代碼取得
//   A.8.2 特權存取：幹部的工作階段閒置 8 小時、絕對 7 天就失效；身分變更後舊工作階段立即作廢
//   A.8.5 安全鑑別：LINE OIDC（state＋nonce 驗證）；邀請碼與報到代碼有嘗試次數限制
//   A.8.15 日誌：特權操作寫入 audit_log，監事可查
//   A.5.34 個資：最小蒐集、電話遮罩、IP 只存雜湊、本人可匯出與刪除
// 工作階段權杖放 HttpOnly cookie，D1 只存 SHA-256；寫入類 API 只接受同源 JSON（擋 CSRF）。
import { subscribe, unsubscribe, push, validEndpoint } from './push.js';
import * as WebAuthn from './webauthn.js';

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
const KINDS = ['track', 'core', 'long', 'race', 'party', 'survey', 'other'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => !s || /^\d{2}:\d{2}$/.test(s);
// 「今天」一律用台北時間（UTC 會在台灣早上 8 點前還停在前一天）
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const url0 = (req) => new URL(req.url);
// 隱私權政策版本：預設值；實際版本由後台「系統設定」決定，改版後使用者下次開啟會被要求重新同意
const PRIVACY_VERSION = '2026-10-03.1';
const SETTING_KEYS = ['org', 'features', 'docs', 'privacy'];
async function getSettings(env) {
  const rows = (await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN ('org','features','docs','privacy')`).all()).results;
  const out = { org: {}, features: {}, docs: [], privacy: { version: PRIVACY_VERSION, body: '' } };
  for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch {} }
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
    `SELECT m.*, s.last_seen_at AS s_seen, s.role_at_issue AS s_role, s.created_at AS s_created, s.mfa_at AS s_mfa, s.token_hash AS s_th
     FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).bind(th).first();
  if (!row) return null;
  const pol = policyOf(row.role), now = Date.now();
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
const revokeSessions = (env, memberId) => env.DB.prepare('DELETE FROM sessions WHERE member_id = ?').bind(memberId).run();

// 嘗試次數限制：在 window 秒內超過 limit 次就擋
async function limited(env, key, limit, windowSec) {
  const row = await env.DB.prepare("SELECT count, window_end > datetime('now') AS live FROM rate_limits WHERE key = ?").bind(key).first();
  if (row?.live && row.count >= limit) return true;
  if (row?.live) await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  else await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_end) VALUES (?, 1, datetime('now', '+${windowSec} seconds'))
    ON CONFLICT(key) DO UPDATE SET count = 1, window_end = excluded.window_end`).bind(key).run();
  return false;
}

// 稽核紀錄：特權操作一律記下（detail 只放摘要，不放個資原文）
// 防竄改：每筆用 AUDIT_KEY（只有 Worker 知道）算 HMAC，改動任何欄位都驗得出來；刪除則由每日摘要鏈檢查
async function hmac(env, text) {
  if (!env.AUDIT_KEY) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUDIT_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const auditFields = (r) => [r.id, r.at, r.actor_id, r.actor_name, r.actor_role, r.action, r.target_type, r.target_id, r.detail, r.ip_hash].map((v) => v ?? '').join('\u001f');
async function audit(env, req, actor, action, targetType, targetId, detail) {
  try {
    const row = { id: rid(10), at: new Date().toISOString().replace('T', ' ').slice(0, 19), actor_id: actor?.id || null,
      actor_name: actor?.name || (req ? null : '系統排程'), actor_role: actor ? norm(actor.real_role || actor.role) : null, action,
      target_type: targetType || null, target_id: targetId || null, detail: str(detail, 300) || null, ip_hash: await ipHash(req, env) };
    row.mac = await hmac(env, auditFields(row));
    await env.DB.prepare(`INSERT INTO audit_log (id, at, actor_id, actor_name, actor_role, action, target_type, target_id, detail, ip_hash, mac)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.at, row.actor_id, row.actor_name, row.actor_role, row.action, row.target_type, row.target_id, row.detail, row.ip_hash, row.mac).run();
  } catch (e) { console.error('audit', e); }
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
      await notify(env, [member.id], 'system', { title: '新裝置登入', body: `${label} 用${how}登入了你的帳號。不是你的話，到「我的」按「登出所有裝置」。`, url: '/#/me' });
      await audit(env, req, member, 'login.new_device', 'member', member.id, label);
    }
  } catch (e) { console.error('noteDevice', e); }
}
// LINE 大頭貼只接受 LINE 自己的圖床
const safeAvatar = (u) => (/^https:\/\/(profile|obs)\.line-scdn\.net\//.test(u || '') ? u.slice(0, 300) : null);

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
  title: m.title || null, avatar: m.avatar || null, line: !!m.line_id,
  nickname: m.nickname || '', club: m.club || '', meal_pref: m.meal_pref || '', phone: m.phone || '',
  membership: m.membership || 'none', membershipName: MEMBERSHIP[m.membership || 'none'],
  member_type: m.member_type || null, member_no: m.member_no || null, paid_until: m.paid_until || null,
  share_logs: !!m.share_logs, show_rank: !!m.show_rank, can: PERMS[norm(m.role)],
  mfaPending: !!m.mfa_pending, realRole: m.real_role ? norm(m.real_role) : null, realRoleName: m.real_role ? ROLES[norm(m.real_role)] : null, mfa: !!m.s_mfa,
});

// ---- 通知中心：推播成功與否都留一份 ----
async function notify(env, memberIds, kind, msg) {
  const ids = [...new Set(memberIds)].filter(Boolean);
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    await env.DB.batch(part.map((id) => env.DB.prepare(
      'INSERT INTO notifications (id, member_id, kind, title, body, url) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(rid(8), id, kind, str(msg.title, 80), str(msg.body, 300), str(msg.url, 200) || null)));
  }
  env.defer(push(env, ids, msg));
}
const allMemberIds = async (env, exceptId) =>
  (await env.DB.prepare('SELECT id FROM members' + (exceptId ? ' WHERE id != ?' : '')).bind(...(exceptId ? [exceptId] : [])).all())
    .results.map((r) => r.id);

// ---- LINE 登入（OpenID Connect 授權碼流程）----
// 需要 secrets：LINE_CHANNEL_ID、LINE_CHANNEL_SECRET；LINE Developers 的 Callback URL 填 https://網域/api/line/callback
const LINE_STATE = '__Host-cil_oauth';
const redirectUri = (url) => `${url.origin}/api/line/callback`;

function lineStart(env, url) {
  if (!env.LINE_CHANNEL_ID || !env.LINE_CHANNEL_SECRET) return fail(503, '尚未設定 LINE 登入');
  const state = rid(12), nonce = rid(12);
  const auth = new URL('https://access.line.me/oauth2/v2.1/authorize');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.LINE_CHANNEL_ID);
  auth.searchParams.set('redirect_uri', redirectUri(url));
  auth.searchParams.set('state', state);
  auth.searchParams.set('scope', 'profile openid');
  auth.searchParams.set('nonce', nonce);
  return new Response(null, { status: 302, headers: {
    location: auth.toString(),
    // state 與 nonce 一起綁在發起登入的瀏覽器上，callback 時兩個都要對得上
    'set-cookie': `${LINE_STATE}=${state}.${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  } });
}

async function lineCallback(req, env, url) {
  const clear = `${LINE_STATE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const back = (msg) => new Response(null, { status: 302, headers: { location: `/#/?err=${encodeURIComponent(msg)}`, 'set-cookie': clear } });
  const [want, nonce] = ((req.headers.get('cookie') || '').match(new RegExp(`${LINE_STATE}=([\\w]+\\.[\\w]+)`))?.[1] || '').split('.');
  // 使用者在 LINE 授權頁按了取消
  if (url.searchParams.get('error')) return back(url.searchParams.get('error') === 'access_denied' ? '你取消了 LINE 登入' : 'LINE 登入失敗，請再試一次');
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state || !want || state !== want) return back('登入逾時，請再試一次');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(url), client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET });
  const tok = await (await fetch('https://api.line.me/oauth2/v2.1/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).json();
  if (!tok.access_token || !tok.id_token) return back('LINE 登入失敗');
  // 驗證 ID Token：簽章、發行者、對象、期限與 nonce 都交給 LINE 的驗證端點檢查
  const vf = new URLSearchParams({ id_token: tok.id_token, client_id: env.LINE_CHANNEL_ID, nonce });
  const idt = await (await fetch('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: vf })).json();
  if (!idt.sub || idt.nonce !== nonce) return back('LINE 登入驗證失敗');
  const prof = await (await fetch('https://api.line.me/v2/profile', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  if (!prof.userId || prof.userId !== idt.sub) return back('LINE 登入驗證失敗');
  const pic = safeAvatar(prof.pictureUrl);
  let m = await env.DB.prepare('SELECT id, name, role FROM members WHERE line_id = ?').bind(prof.userId).first();
  let isNew = false;
  if (m) {
    await env.DB.prepare('UPDATE members SET avatar = ? WHERE id = ?').bind(pic, m.id).run();
  } else {
    isNew = true;
    const id = rid(8);
    await env.DB.prepare("INSERT INTO members (id, name, dist, grp, role, line_id, avatar, consent_at, consent_version) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)")
      .bind(id, str(prof.displayName, 40) || '跑者', 'fm', 'D', 'member', prof.userId, pic, (await getSettings(env)).privacy.version).run();
    m = { id, name: str(prof.displayName, 40), role: 'member' };
  }
  await audit(env, req, m, isNew ? 'account.create' : 'login', 'member', m.id, 'LINE');
  env.ctx?.waitUntil(noteDevice({ ...env, defer: (p) => env.ctx.waitUntil(p) }, req, m, ' LINE '));
  return new Response(null, { status: 302, headers: [
    ['location', isNew ? '/#/me?welcome=1' : '/#/'],
    ['set-cookie', await startSession(env, m, req)],
    ['set-cookie', clear],
  ] });
}

// ---- 活動 ----
const eventCols = 'id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, status, created_at, fee, guest_max, meal_options, link_url, link_label, team_id, questions, visibility, created_by';

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
const parseQ = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
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
    lead: str(b.lead, 60),
    note: str(b.note, 1000),
    week_no: Number.isInteger(b.week_no) && b.week_no >= 1 && b.week_no <= 21 ? b.week_no : null,
    plan_text: str(b.plan_text, 4000),
    capacity: Number.isInteger(b.capacity) && b.capacity > 0 ? Math.min(b.capacity, 999) : null,
    signup_open: b.signup_open === false ? 0 : 1,
    deadline: str(b.deadline, 16),
    fee: Number.isInteger(b.fee) && b.fee >= 0 ? b.fee : null,
    guest_max: Number.isInteger(b.guest_max) && b.guest_max > 0 ? Math.min(b.guest_max, 9) : null,
    meal_options: str(b.meal_options, 60),
    link_url: /^https:\/\/[\w.-]+/.test(str(b.link_url, 300)) ? str(b.link_url, 300) : '',
    link_label: str(b.link_label, 20),
    team_id: str(b.team_id, 16) || null,
    questions: readQuestions(b.questions),
    visibility: b.visibility === 'invite' ? 'invite' : 'public',
  };
  if (!e.title || !isDate(e.date) || !isTime(e.gather_time) || !isTime(e.end_time)) return null;
  return e;
}

async function eventWithSignups(env, id) {
  const ev = await env.DB.prepare(`SELECT ${eventCols} FROM events WHERE id = ?`).bind(id).first();
  if (!ev) return null;
  const signups = (await env.DB.prepare(
    "SELECT id, member_id, name, grp, dist, note, status, created_at FROM signups WHERE event_id = ? AND status != 'cancel' ORDER BY created_at").bind(id).all()).results;
  return { ...ev, signups };
}

// 報名：超過人數上限就排候補
async function doSignup(env, ev, member, b) {
  const name = str(b.name, 40) || member.name;
  const dist = b.dist === 'hm' ? 'hm' : member.dist;
  const grp = (str(b.grp, 2) || member.grp).toUpperCase();
  if (!validGroup(dist, grp)) return fail(400, '組別不正確');
  if (!ev.signup_open || ev.status !== 'open') return fail(400, '這個活動沒有開放報名');
  const ans = readAnswers(ev.questions, b.answers);
  if (ans.error) return fail(400, ans.error);
  if (ev.deadline && new Date(ev.deadline) < new Date()) return fail(400, '已經過了報名截止時間');
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in'").bind(ev.id).first()).n;
  const mine = await env.DB.prepare('SELECT id, status FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
  const full = ev.capacity && n >= ev.capacity && mine?.status !== 'in';
  const status = full ? 'wait' : 'in';
  if (mine) {
    await env.DB.prepare('UPDATE signups SET name = ?, grp = ?, dist = ?, note = ?, status = ?, answers = ? WHERE id = ?')
      .bind(name, grp, dist, str(b.note, 100), status, ans.answers, mine.id).run();
  } else {
    await env.DB.prepare('INSERT INTO signups (id, event_id, member_id, name, grp, dist, note, status, answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(rid(8), ev.id, member.id, name, grp, dist, str(b.note, 100), status, ans.answers).run();
  }
  if (ev.kind === 'party' && status === 'in') {
    const guests = Math.max(0, Math.min(Number(b.guests) || 0, ev.guest_max || 0));
    const meal = str(b.meal, 20) || member.meal_pref || '';
    await env.DB.prepare(`INSERT INTO tickets (id, event_id, member_id, code, guests, meal, note) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, member_id) DO UPDATE SET guests = excluded.guests, meal = excluded.meal, note = excluded.note`)
      .bind(rid(8), ev.id, member.id, ticketCode(), guests, meal, str(b.note, 60)).run();
  }
  return json({ ok: true, status });
}
// 入場代碼：去掉容易看錯的 0/O/1/I
const ticketCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

// 取消報名後，候補的第一位自動遞補
async function cancelSignup(env, ev, member) {
  await env.DB.prepare("UPDATE signups SET status = 'cancel' WHERE event_id = ? AND member_id = ?").bind(ev.id, member.id).run();
  if (ev.capacity) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in'").bind(ev.id).first()).n;
    if (n < ev.capacity) {
      const next = await env.DB.prepare("SELECT id, member_id, name FROM signups WHERE event_id = ? AND status = 'wait' ORDER BY created_at LIMIT 1").bind(ev.id).first();
      if (next) {
        await env.DB.prepare("UPDATE signups SET status = 'in' WHERE id = ?").bind(next.id).run();
        await notify(env, [next.member_id], 'signup', { title: '候補遞補成功', body: `${ev.title} 有人取消，你已經排進正取名單。`, url: `/#/e/${ev.id}` });
      }
    }
  }
  return json({ ok: true });
}

// 倒數目標：自己設定的主要賽事 → 最近一場自己的賽事 → 協會預設
async function countdownTarget(env, member) {
  if (member) {
    const r = await env.DB.prepare(
      `SELECT name, date, dist, goal FROM races WHERE member_id = ? AND date >= date('now')
       ORDER BY is_primary DESC, date ASC LIMIT 1`).bind(member.id).first();
    if (r) return { ...r, mine: true };
  }
  const c = await env.DB.prepare("SELECT value FROM settings WHERE key = 'club_race'").first();
  try { return c ? { ...JSON.parse(c.value), mine: false } : null; } catch { return null; }
}

// ---- 路由 ----
async function api(req, env, path, method) {
  let member = await currentMember(req, env);
  // 幹部兩步驟驗證：理事長開啟後，幹部的工作階段要用通行金鑰驗證過，才有管理權限（之前一律當一般跑友）
  const security = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'security'").first().then((r) => JSON.parse(r?.value || '{}')).catch(() => ({})));
  if (member && security.require_mfa && norm(member.role) !== 'member' && !member.s_mfa)
    member = { ...member, real_role: member.role, role: 'member', mfa_pending: true };
  const need = () => (member ? null : fail(401, '請先加入'));
  const needPerm = (p) => (can(member, p) ? null : fail(403, '沒有這個權限'));
  const needAdmin = () => needPerm('event');
  const body = async () => { try { return await req.json(); } catch { return {}; } };
  // 我在各分團的身分（每次請求即時查，團長被撤換後馬上失去權限）
  const myTeams = member ? Object.fromEntries((await env.DB.prepare('SELECT team_id, role, status, title FROM team_members WHERE member_id = ?')
    .bind(member.id).all()).results.map((r) => [r.team_id, r])) : {};
  const inTeam = (tid) => myTeams[tid]?.status === 'active';
  // 協會層級的權限涵蓋所有分團；分團幹部只管自己的分團
  const GLOBAL_EQ = { approve: 'members', appoint: 'roles' };
  const teamCan = (tid, p) => {
    if (can(member, GLOBAL_EQ[p] || p) && !(READONLY[norm(member.role)] && p !== 'roster')) return true;
    return !!tid && inTeam(tid) && TEAM_PERMS[myTeams[tid].role]?.includes(p);
  };
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
  // ---- 分團清單（/api/me 也會用到）----
  const teamOut = async (t, counts, leaders) => {
    const mine = myTeams[t.id];
    const showLine = !t.private || inTeam(t.id) || can(member, 'settings');
    return { id: t.id, name: t.name, intro: t.intro || '', color: t.color, join_policy: t.join_policy, private: !!t.private, sort: t.sort,
      line_url: showLine ? t.line_url || '' : '', count: counts[t.id] || 0, icon: t.icon_v ? `/api/teams/${t.id}/icon?v=${t.icon_v}` : null, leaders: leaders.filter((l) => l.team_id === t.id),
      my_role: mine?.role || null, my_status: mine?.status || null, my_title: mine?.title || null };
  };
  const listTeams = async () => {
    const teams = (await env.DB.prepare('SELECT id, name, intro, color, line_url, join_policy, private, sort, icon_v FROM teams ORDER BY sort, created_at').all()).results;
    const counts = Object.fromEntries((await env.DB.prepare("SELECT team_id, COUNT(*) AS n FROM team_members WHERE status = 'active' GROUP BY team_id").all()).results.map((r) => [r.team_id, r.n]));
    const leaders = (await env.DB.prepare(
      `SELECT tm.team_id, tm.role, tm.title, m.name, m.nickname, m.avatar FROM team_members tm JOIN members m ON m.id = tm.member_id
       WHERE tm.role IN ('lead', 'officer') AND tm.status = 'active' ORDER BY tm.role = 'lead' DESC, tm.created_at`).all()).results;
    return Promise.all(teams.map((t) => teamOut(t, counts, leaders)));
  };
  const readTeam = (b, full) => {
    const t = { intro: str(b.intro, 300), line_url: lineGroupUrl(str(b.line_url, 260)) };
    if (str(b.line_url, 260) && !t.line_url) return { error: 'LINE 群組連結要是 https://line.me/ 開頭的邀請連結' };
    if (!full) return t;
    Object.assign(t, { name: str(b.name, 20), color: isColor(b.color) ? b.color : '#1C4698',
      join_policy: b.join_policy === 'approve' ? 'approve' : 'open', private: b.private === true ? 1 : 0,
      sort: Number.isInteger(b.sort) ? Math.max(0, Math.min(b.sort, 99)) : null });
    if (!t.name) return { error: '請填分團名稱' };
    return t;
  };

  // 行事曆訂閱的 .ics：只列本人有報名（正取或候補）的活動，過去 30 天到未來 180 天
  const mcal = path.match(/^\/api\/cal\/([\w]{16,64})\.ics$/);
  if (mcal && method === 'GET') {
    const th = await sha(mcal[1]);
    if (await limited(env, `cal:${th.slice(0, 16)}`, 60, 3600)) return fail(429, '更新太頻繁');
    const who = await env.DB.prepare('SELECT id FROM members WHERE cal_token_hash = ?').bind(th).first();
    if (!who) return fail(404, '訂閱網址已失效');
    const rows = (await env.DB.prepare(`SELECT e.id, e.title, e.date, e.gather_time, e.end_time, e.place, e.note, e.kind, s.status
      FROM signups s JOIN events e ON e.id = s.event_id WHERE s.member_id = ? AND s.status IN ('in', 'wait')
      AND e.date BETWEEN date('now', '-30 days') AND date('now', '+180 days') ORDER BY e.date LIMIT 300`).bind(who.id).all()).results;
    const icsEsc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
    const fold = (line) => { const out = []; let cur = ''; for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 73) { out.push(cur); cur = ` ${ch}`; } else cur += ch; } out.push(cur); return out.join('\r\n'); };
    const d8 = (d) => d.replace(/-/g, ''), t6 = (t) => `${t.replace(':', '')}00`;
    const origin = new URL(req.url).origin, stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const plus1 = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    const ev = rows.map((r) => {
      const timed = /^\d{2}:\d{2}$/.test(r.gather_time || '');
      const end = timed ? (/^\d{2}:\d{2}$/.test(r.end_time || '') && r.end_time > r.gather_time ? r.end_time
        : `${String(Math.min(23, Number(r.gather_time.slice(0, 2)) + 2)).padStart(2, '0')}${r.gather_time.slice(2)}`) : null;
      return ['BEGIN:VEVENT', `UID:${r.id}@cil-run`, `DTSTAMP:${stamp}`,
        timed ? `DTSTART;TZID=Asia/Taipei:${d8(r.date)}T${t6(r.gather_time)}` : `DTSTART;VALUE=DATE:${d8(r.date)}`,
        timed ? `DTEND;TZID=Asia/Taipei:${d8(r.date)}T${t6(end)}` : `DTEND;VALUE=DATE:${d8(plus1(r.date))}`,
        `SUMMARY:${icsEsc(`${r.status === 'wait' ? '（候補）' : ''}${r.title}`)}`, r.place ? `LOCATION:${icsEsc(r.place)}` : '',
        `DESCRIPTION:${icsEsc(`${r.note ? `${r.note}\n` : ''}${origin}/#/e/${r.id}`)}`, `URL:${origin}/#/e/${r.id}`, 'END:VEVENT'].filter(Boolean).map(fold).join('\r\n');
    });
    const body2 = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cultivation in Life Run//cil-run//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:耕跑團', 'X-WR-TIMEZONE:Asia/Taipei', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Taipei', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST', 'END:STANDARD', 'END:VTIMEZONE',
      ...ev, 'END:VCALENDAR'].join('\r\n');
    return new Response(body2, { headers: { ...SEC_HEADERS, 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': 'inline; filename="cil-run.ics"' } });
  }

  // 前端錯誤回報：只寫進 Workers Logs，不存資料庫；有次數限制
  if (path === '/api/client-error' && method === 'POST') {
    if (await limited(env, `cerr:${await ipHash(req, env)}`, 20, 600)) return json({ ok: true });
    const b = await body();
    console.error('client-error', JSON.stringify({ message: str(b.message, 300), source: str(b.source, 120), line: Number(b.line) || 0,
      page: str(b.page, 60), device: deviceLabel(req.headers.get('user-agent') || ''), member: member ? 'yes' : 'no' }));
    return json({ ok: true });
  }
  // 分團小圖：網址帶版本號，可以長期快取
  const mic = path.match(/^\/api\/teams\/([\w-]{1,16})\/icon$/);
  if (mic && method === 'GET') {
    const r = await env.DB.prepare('SELECT icon FROM teams WHERE id = ?').bind(mic[1]).first();
    const m = r?.icon?.match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return fail(404, '沒有圖示');
    return new Response(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)), { headers: { ...SEC_HEADERS,
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
    if (await limited(env, `pk:${await ipHash(req, env)}`, 30, 600)) return fail(429, '嘗試太多次，請稍後再試');
    const cid = rid(12), challenge = WebAuthn.b64u(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')").run();
    await env.DB.prepare("INSERT INTO webauthn_challenges (id, challenge, member_id, purpose, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+5 minutes'))")
      .bind(cid, challenge, member?.id || null, purpose).run();
    const mine = member ? (await env.DB.prepare('SELECT id FROM passkeys WHERE member_id = ?').bind(member.id).all()).results : [];
    const base = { challenge, timeout: 60000, rpId, userVerification: 'preferred' };
    if (purpose === 'register') return json({ cid, publicKey: { ...base, rp: { id: rpId, name: '耕跑團' },
      user: { id: WebAuthn.b64u(new TextEncoder().encode(member.id)), name: member.nickname || member.name, displayName: member.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
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
        await env.DB.prepare('INSERT INTO passkeys (id, member_id, public_jwk, sign_count, name) VALUES (?, ?, ?, ?, ?)')
          .bind(r.credId, member.id, JSON.stringify(r.jwk), r.signCount, str(b.name, 20) || deviceLabel(req.headers.get('user-agent') || '')).run();
        await audit(env, req, member, 'passkey.add', 'member', member.id, deviceLabel(req.headers.get('user-agent') || ''));
        return json({ ok: true });
      }
      const pk = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(str(cred.id, 400)).first();
      if (!pk) throw new Error('找不到這把通行金鑰，可能已經被移除');
      if (ch.purpose === 'stepup' && (!member || pk.member_id !== member.id || ch.member_id !== member.id)) throw new Error('這把通行金鑰不是你的');
      const r = await WebAuthn.verifyAssertion({ credential: cred, challenge: ch.challenge, origin: origin0, rpId, jwk: JSON.parse(pk.public_jwk), signCount: pk.sign_count });
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
    if (r.meta.changes) await audit(env, req, member, 'passkey.remove', 'member', member.id, '');
    return json({ ok: true });
  }
  // 開關幹部兩步驟驗證：只有理事長；開啟前自己要有通行金鑰而且這次登入已經驗證過，避免把自己鎖在門外
  if (path === '/api/settings/security' && method === 'POST') {
    const g = need(); if (g) return g;
    if (norm(member.real_role || member.role) !== 'chair') return fail(403, '只有理事長可以設定');
    const on = (await body()).require_mfa === true;
    if (on) {
      const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE member_id = ?').bind(member.id).first()).n;
      if (!n) return fail(400, '請先在「我的 → 通行金鑰」新增一把，再開啟');
      if (!member.s_mfa) return fail(400, '請先用通行金鑰驗證一次（「我的 → 通行金鑰 → 驗證」），確定可以用再開啟');
    }
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('security', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ require_mfa: on })).run();
    await audit(env, req, member, 'settings.security', 'settings', 'security', on ? '幹部強制兩步驟驗證：開啟' : '關閉');
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
    const rows = (await env.DB.prepare(`SELECT * FROM audit_log WHERE at >= ? AND at < ? ORDER BY at, id LIMIT 20000`).bind(from, `${to} 24`).all()).results;
    let bad = 0, unsigned = 0; const badIds = [];
    for (const r of rows) { if (!r.mac) { unsigned += 1; continue; } if ((await hmac(env, auditFields(r))) !== r.mac) { bad += 1; if (badIds.length < 20) badIds.push(r.id); } }
    const digests = (await env.DB.prepare('SELECT * FROM audit_digests WHERE day BETWEEN ? AND ? ORDER BY day').bind(from, to).all()).results;
    const brokenDays = [];
    for (const d of digests) {
      const prev = (await env.DB.prepare('SELECT digest FROM audit_digests WHERE day < ? ORDER BY day DESC LIMIT 1').bind(d.day).first())?.digest || '';
      const dayRows = (await env.DB.prepare("SELECT mac FROM audit_log WHERE at >= ? AND at < ? AND mac IS NOT NULL ORDER BY at, id").bind(d.day, `${d.day} 24`).all()).results;
      const dg = await hmac(env, `${prev}|${dayRows.map((x) => x.mac).join('|')}`);
      if (dg !== d.digest || dayRows.length !== d.rows) brokenDays.push(d.day);
    }
    await audit(env, req, member, 'audit.verify', 'audit', null, `${from}～${to}：${rows.length} 筆，異常 ${bad}，摘要異常 ${brokenDays.length} 天`);
    return json({ from, to, checked: rows.length, unsigned, modified: bad, modifiedIds: badIds, days: digests.length, brokenDays });
  }

  // 分享連結的預覽：還沒登入的人點進來，先看到是什麼活動（私密分團的活動不顯示）
  const mpv = path.match(/^\/api\/public\/e\/([\w-]{1,32})$/);
  if (mpv && method === 'GET') {
    const e = await env.DB.prepare(`SELECT e.title, e.date, e.gather_time, e.place, e.kind, e.visibility, e.invite_token, t.name AS team, t.private
      FROM events e LEFT JOIN teams t ON t.id = e.team_id WHERE e.id = ?`).bind(mpv[1]).first();
    // 邀請制：要帶正確的邀請代碼才看得到預覽
    const tok = str(url0(req).searchParams.get('t'), 40);
    const okInvite = e?.visibility === 'invite' && e.invite_token && tok === e.invite_token;
    if (!e || (e.visibility === 'invite' ? !okInvite : e.private)) return fail(404, '找不到這個活動');
    const { private: _, invite_token: _t, ...pub2 } = e;
    return json({ event: pub2 });
  }

  if (path === '/api/me' && method === 'GET')
    return json({ member: member ? pub(member) : null, vapid: env.VAPID_PUBLIC_KEY || null, lineLogin: !!(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET),
      ...(await (async () => { const st = await getSettings(env);
        return { settings: st, privacyVersion: st.privacy.version, needConsent: !!member && member.consent_version !== st.privacy.version }; })()),
      race: await countdownTarget(env, member),
      teams: member ? await listTeams() : [], calendarOn: !!member?.cal_token_hash, requireMfa: !!security.require_mfa,
      shortcut: await env.DB.prepare("SELECT value FROM settings WHERE key = 'health_shortcut'").first().then((r) => r?.value || null) });

  // 已登入的人輸入幹部碼或理事長碼升級
  // 初始設定：系統裡還沒有理事長時，才能用 CHAIR_CODE 把自己設為理事長（只能用一次）。
  // 之後所有幹部身分一律由理事長在後台指派，不再有共用的幹部碼（A.5.18 存取權限）。
  if (path === '/api/me/admin' && method === 'POST') {
    const g = need(); if (g) return g;
    if (await limited(env, `bootstrap:${await ipHash(req, env)}`, 5, 900)) return fail(429, '嘗試太多次，請 15 分鐘後再試');
    const code = str((await body()).code, 80);
    const hasChair = await env.DB.prepare("SELECT 1 FROM members WHERE role = 'chair' LIMIT 1").first();
    if (hasChair || !env.CHAIR_CODE || code !== env.CHAIR_CODE) {
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
    if (!env.JOIN_CODE || code !== env.JOIN_CODE) {
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
    const name = str(b.name, 40) || member.name;
    const dist = b.dist === 'hm' ? 'hm' : 'fm';
    const grp = (str(b.grp, 2) || member.grp).toUpperCase();
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    const extra = { nickname: str(b.nickname, 20), club: str(b.club, 30), meal_pref: str(b.meal_pref, 10), phone: str(b.phone, 20) };
    await env.DB.prepare('UPDATE members SET name = ?, dist = ?, grp = ?, nickname = ?, club = ?, meal_pref = ?, phone = ? WHERE id = ?')
      .bind(name, dist, grp, extra.nickname, extra.club, extra.meal_pref, extra.phone, member.id).run();
    return json({ member: pub({ ...member, name, dist, grp, ...extra }) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = tokenOf(req);
    if ((await body()).all && member) await revokeSessions(env, member.id);
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
    const rows = (await env.DB.prepare(
      `SELECT ${eventCols}, (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'in') AS signed,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'wait') AS waiting,
              (SELECT s.status FROM signups s WHERE s.event_id = events.id AND s.member_id = ?1) AS mine,
              (SELECT json_group_array(json_object('n', x.name, 'a', x.avatar)) FROM (
                 SELECT s.name, m.avatar FROM signups s LEFT JOIN members m ON m.id = s.member_id
                 WHERE s.event_id = events.id AND s.status = 'in' ORDER BY s.created_at LIMIT 4) x) AS peek
       FROM events WHERE date BETWEEN ?3 AND ?4 ${past ? 'AND date < ?5' : ''} AND ${seeSQL} ORDER BY date ${past ? 'DESC' : 'ASC'}, gather_time LIMIT 100`)
      .bind(member.id, can(member, 'event') ? 1 : 0, ...range, ...(past ? [today()] : [])).all()).results;
    return json({ events: rows.map(({ questions, ...r }) => ({ ...r, survey: !!questions, peek: JSON.parse(r.peek || '[]') })) });
  }

  if (path === '/api/events' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body(), e = readEvent(b);
    if (!e) return fail(400, '活動資料不完整');
    if (e.team_id && !(await teamIds()).includes(e.team_id)) return fail(400, '找不到這個分團');
    if (!teamCan(e.team_id, 'event')) return fail(403, e.team_id ? '只有這個分團的團長與幹部可以建立活動' : '只有幹部可以建立全協會活動');
    const id = rid(8);
    await env.DB.prepare(`INSERT INTO events (id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, created_by, fee, guest_max, meal_options, link_url, link_label, team_id, questions, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, member.id, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label, e.team_id, e.questions, e.visibility).run();
    // 複製活動：沿用原活動的座位圖（獎項每年不同，不複製）
    const from = str(b.copy_from, 32);
    if (from) {
      const src = await evById(from);
      if (src && await canSee(src)) await env.DB.prepare('UPDATE events SET seat_layout = (SELECT seat_layout FROM events WHERE id = ?) WHERE id = ?').bind(from, id).run();
    }
    await audit(env, req, member, 'event.create', 'event', id, `${e.title}${e.team_id ? `（${e.team_id}）` : ''}${e.visibility === 'invite' ? '，邀請制' : ''}${from ? `，複製自 ${from}` : ''}`);
    // 邀請制不廣播；之後邀請誰就通知誰
    if (b.notify !== false && e.visibility !== 'invite') await notify(env, e.team_id ? await teamMemberIds(e.team_id, member.id) : await allMemberIds(env, member.id), 'event',
      { title: `${e.kind === 'survey' ? '新問卷' : '新活動'}：${e.title}`, body: `${e.date}${e.gather_time ? ` ${e.gather_time}` : ''}　${e.place || ''}`, url: `/#/e/${id}` });
    return json({ id });
  }

  const m1 = path.match(/^\/api\/events\/([\w-]{1,32})$/);
  if (m1) {
    const g = need(); if (g) return g;
    const id = m1[1];
    const cur = await evById(id);
    if (!cur || !(await canSee(cur))) return fail(404, '找不到這個活動');
    if (method === 'GET') {
      const ev = await eventWithSignups(env, id);
      const mine = await env.DB.prepare('SELECT answers, paid, attended_at FROM signups WHERE event_id = ? AND member_id = ?').bind(id, member.id).first();
      const team = ev.team_id ? await env.DB.prepare('SELECT id, name, color FROM teams WHERE id = ?').bind(ev.team_id).first() : null;
      const manage = canManage(ev);
      const inv = ev.visibility === 'invite' && manage
        ? { count: (await env.DB.prepare('SELECT COUNT(*) AS n FROM event_invites WHERE event_id = ?').bind(id).first()).n,
            token: (await env.DB.prepare('SELECT invite_token FROM events WHERE id = ?').bind(id).first()).invite_token || null } : null;
      const attendTok = manage ? (await env.DB.prepare('SELECT attend_token FROM events WHERE id = ?').bind(id).first()).attend_token : null;
      return json({ ...ev, questions: parseQ(ev.questions), myAnswers: mine?.answers ? JSON.parse(mine.answers) : null,
        myPaid: mine?.paid || null, myAttended: mine?.attended_at || null,
        team, manage, checkin: teamCan(ev.team_id, 'checkin'), invite: inv, attendToken: attendTok });
    }
    if (method === 'PUT') {
      const e = readEvent(await body());
      if (!e) return fail(400, '活動資料不完整');
      if (e.team_id && !(await teamIds()).includes(e.team_id)) return fail(400, '找不到這個分團');
      // 原本的分團與改過去的分團都要有權限
      if (!teamCan(cur.team_id, 'event') || !teamCan(e.team_id, 'event')) return fail(403, '沒有編輯這個活動的權限');
      await env.DB.prepare(`UPDATE events SET kind=?, title=?, date=?, gather_time=?, end_time=?, place=?, lead=?, note=?, week_no=?, plan_text=?, capacity=?, signup_open=?, deadline=?, fee=?, guest_max=?, meal_options=?, link_url=?, link_label=?, team_id=?, questions=?, visibility=? WHERE id = ?`)
        .bind(e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label, e.team_id, e.questions, e.visibility, id).run();
      await audit(env, req, member, 'event.update', 'event', id, `${e.title}${cur.visibility !== e.visibility ? `（改為${e.visibility === 'invite' ? '邀請制' : '公開'}）` : ''}`);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      if (!teamCan(cur.team_id, 'event')) return fail(403, '沒有刪除這個活動的權限');
      await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
      await audit(env, req, member, 'event.delete', 'event', id, cur.title);
      return json({ ok: true });
    }
  }

  const m2 = path.match(/^\/api\/events\/([\w-]{1,32})\/signup$/);
  if (m2) {
    const g = need(); if (g) return g;
    const ev = await evById(m2[1]);
    if (!ev || !(await canSee(ev))) return fail(404, '找不到這個活動');
    if (method === 'POST') return doSignup(env, ev, member, await body());
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
      const exist = new Set((await env.DB.prepare(`SELECT id FROM members WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results.map((r) => r.id));
      const before = new Set((await env.DB.prepare('SELECT member_id FROM event_invites WHERE event_id = ?').bind(ev.id).all()).results.map((r) => r.member_id));
      const fresh = ids.filter((x) => exist.has(x) && !before.has(x));
      for (let i = 0; i < fresh.length; i += 50) await env.DB.batch(fresh.slice(i, i + 50).map((mid) =>
        env.DB.prepare('INSERT OR IGNORE INTO event_invites (event_id, member_id, invited_by, via) VALUES (?, ?, ?, ?)').bind(ev.id, mid, member.id, via)));
      if (fresh.length) {
        await audit(env, req, member, 'event.invite', 'event', ev.id, `${fresh.length} 人${tid ? `（分團 ${tid}）` : ''}`);
        if (b.notify !== false) await notify(env, fresh, 'event', { title: `你受邀參加：${ev.title}`, body: `${ev.date}${ev.gather_time ? ` ${ev.gather_time}` : ''}　${ev.place || ''}`, url: `/#/e/${ev.id}` });
      }
      return json({ added: fresh.length });
    }
    if (kind === 'invites' && method === 'DELETE' && minv[3]) {
      // 取消邀請：一併取消報名與入場券，避免還能入場
      await env.DB.batch([
        env.DB.prepare('DELETE FROM event_invites WHERE event_id = ? AND member_id = ?').bind(ev.id, minv[3]),
        env.DB.prepare("UPDATE signups SET status = 'cancel' WHERE event_id = ? AND member_id = ?").bind(ev.id, minv[3]),
        env.DB.prepare('DELETE FROM tickets WHERE event_id = ? AND member_id = ?').bind(ev.id, minv[3]),
      ]);
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

  // ---- 活動營運：繳費、點名、自助報到、整批匯入 ----
  const mops = path.match(/^\/api\/events\/([\w-]{1,32})\/(payments|attendance|attend|attend-token|bulk)$/);
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
      const mine = await env.DB.prepare('SELECT id, status FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
      if (mine) await env.DB.prepare("UPDATE signups SET status = 'in', attended_at = COALESCE(attended_at, datetime('now')) WHERE id = ?").bind(mine.id).run();
      else await env.DB.prepare("INSERT INTO signups (id, event_id, member_id, name, grp, dist, note, status, attended_at) VALUES (?, ?, ?, ?, ?, ?, '現場報到', 'in', datetime('now'))")
        .bind(rid(8), ev.id, member.id, member.name, member.grp, member.dist).run();
      return json({ ok: true, walkIn: !mine });
    }
    if (!canManage(ev) && !(op === 'attendance' && teamCan(ev.team_id, 'checkin'))) return fail(403, '只有這個活動的幹部可以操作');
    if (op === 'payments') {
      const PAID = ['unpaid', 'paid', 'waived', 'refunded'];
      const ids = Array.isArray(b.member_ids) ? b.member_ids.map((x) => str(x, 32)).filter(Boolean).slice(0, 500) : [];
      if (!ids.length || !PAID.includes(b.paid)) return fail(400, '繳費資料不正確');
      await env.DB.batch(ids.map((mid) => env.DB.prepare(`UPDATE signups SET paid = ?, paid_note = COALESCE(?, paid_note),
        paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE paid_at END WHERE event_id = ? AND member_id = ?`)
        .bind(b.paid, str(b.note, 60) || null, b.paid, ev.id, mid)));
      await audit(env, req, member, 'event.payment', 'event', ev.id, `${ids.length} 人 → ${b.paid}`);
      return json({ ok: true });
    }
    if (op === 'attendance') {
      const mid = str(b.member_id, 32);
      await env.DB.prepare(`UPDATE signups SET attended_at = ${b.present === false ? 'NULL' : "COALESCE(attended_at, datetime('now'))"} WHERE event_id = ? AND member_id = ?`).bind(ev.id, mid).run();
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
      const matched = [], ambiguous = [], unmatched = [], failed = [];
      for (const n of names) {
        const rows = (await env.DB.prepare('SELECT * FROM members WHERE name = ? OR nickname = ? LIMIT 3').bind(n, n).all()).results;
        if (rows.length === 1) matched.push(rows[0]); else (rows.length ? ambiguous : unmatched).push(n);
      }
      let added = 0;
      if (action === 'invite') {
        for (const m of matched) added += (await env.DB.prepare("INSERT OR IGNORE INTO event_invites (event_id, member_id, invited_by, via) VALUES (?, ?, ?, 'manual')").bind(ev.id, m.id, member.id).run()).meta.changes;
        if (added) await notify(env, matched.map((m) => m.id), 'event', { title: `你受邀參加：${ev.title}`, body: `${ev.date}${ev.gather_time ? ` ${ev.gather_time}` : ''}　${ev.place || ''}`, url: `/#/e/${ev.id}` });
      } else {
        for (const m of matched) {
          if (ev.visibility === 'invite') await env.DB.prepare("INSERT OR IGNORE INTO event_invites (event_id, member_id, invited_by, via) VALUES (?, ?, ?, 'manual')").bind(ev.id, m.id, member.id).run();
          const r = await doSignup(env, ev, m, { note: '幹部代為報名' });
          if (r.ok) added += 1; else failed.push(`${m.name}（${(await r.json()).error}）`);
        }
        if (added) await notify(env, matched.map((m) => m.id), 'signup', { title: `已幫你報名：${ev.title}`, body: '如果不能參加，請到活動頁取消', url: `/#/e/${ev.id}` });
      }
      await audit(env, req, member, 'event.bulk', 'event', ev.id, `${action === 'invite' ? '邀請' : '代為報名'} ${added} 人，找不到 ${unmatched.length}、同名 ${ambiguous.length}`);
      return json({ added, matched: matched.map((m) => m.name), ambiguous, unmatched, failed });
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
      profile: (({ s_seen, s_role, s_created, line_id, cal_token_hash, ...rest }) => ({ ...rest, line_linked: !!line_id, calendar_feed: !!cal_token_hash }))(member),
      signups: await q('SELECT event_id, name, grp, dist, note, status, answers, paid, attended_at, created_at FROM signups WHERE member_id = ?'),
      teams: await q('SELECT team_id, role, title, status, created_at FROM team_members WHERE member_id = ?'),
      tickets: await q('SELECT event_id, code, guests, meal, table_no, checked_in_at FROM tickets WHERE member_id = ?'),
      prizes: await q('SELECT event_id, prize_id, created_at, claimed_at FROM draws WHERE member_id = ?'),
      notifications: await q('SELECT kind, title, body, created_at, read_at FROM notifications WHERE member_id = ?'),
      sessions: await q('SELECT created_at, last_seen_at, ua FROM sessions WHERE member_id = ?'),
      races: await q('SELECT name, date, dist, goal, is_primary FROM races WHERE member_id = ?'),
      training_logs: await q('SELECT date, week_no, plan_day, plan_text, status, km, seconds, hr, rpe, feel, note, source FROM training_logs WHERE member_id = ? ORDER BY date'),
      log_comments: await q('SELECT l.date, c.author_name, c.body, c.created_at FROM log_comments c JOIN training_logs l ON l.id = c.log_id WHERE l.member_id = ? ORDER BY c.created_at'),
    };
    await audit(env, req, member, 'privacy.export', 'member', member.id, '');
    return json(data, 200, { 'content-disposition': 'attachment; filename="my-data.json"' });
  }
  if (path === '/api/me' && method === 'DELETE') {
    const g = need(); if (g) return g;
    if (norm(member.role) === 'chair') {
      const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'chair'").first()).n;
      if (n <= 1) return fail(400, '你是唯一的理事長，請先指派新的理事長再刪除帳號');
    }
    // 得獎紀錄要留給協會對帳，所以只匿名化，不刪除
    await env.DB.batch([
      env.DB.prepare("UPDATE draws SET name = '已刪除帳號', member_id = NULL WHERE member_id = ?").bind(member.id),
      env.DB.prepare('DELETE FROM members WHERE id = ?').bind(member.id),
    ]);
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
    return json({ races: rows });
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

  const mset = path.match(/^\/api\/settings\/(org|features|docs|privacy)$/);
  if (mset && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings')) return fail(403, '只有理事長與行政人員可以修改系統設定');
    const key = mset[1], b = await body();
    let value;
    if (key === 'org') {
      value = { name: str(b.name, 40), short: str(b.short, 12), contact: str(b.contact, 200), retention: str(b.retention, 200), join_form: httpsUrl(b.join_form),
        parent: str(b.parent, 30), parent_url: httpsUrl(b.parent_url), parent_note: str(b.parent_note, 80),
        event_data_years: Math.max(0, Math.min(Math.round(Number(b.event_data_years) || 0), 20)),
        log_years: Math.max(0, Math.min(Math.round(Number(b.log_years) || 0), 20)),
        audit_years: Math.max(1, Math.min(Math.round(Number(b.audit_years) || 3), 10)) };
      if (!value.name) return fail(400, '請填協會名稱');
      if (b.join_form && !value.join_form) return fail(400, '入會表單連結要是 https:// 開頭的網址');
      if (b.parent_url && !value.parent_url) return fail(400, '企業網站要是 https:// 開頭的網址');
    } else if (key === 'features') {
      value = {};
      for (const f of ['studio', 'health', 'file', 'coach', 'party']) value[f] = b[f] !== false;
    } else if (key === 'docs') {
      const list = Array.isArray(b.docs) ? b.docs.slice(0, 30) : [];
      value = list.map((d) => ({ title: str(d.title, 40), url: httpsUrl(d.url), note: str(d.note, 80) })).filter((d) => d.title && d.url);
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
  const LOG_SOURCES = ['manual', 'health', 'file'];
  const LOG_KINDS = ['easy', 'quality', 'long', 'strength', 'race', 'rest'];
  if (path === '/api/logs' && method === 'GET') {
    const g = need(); if (g) return g;
    const r = rangeOf(new URL(req.url), 370, 6);
    if (!r) return fail(400, '查詢區間最長一年');
    const rows = (await env.DB.prepare(
      `SELECT id, date, week_no, plan_day, kind, plan_text, status, km, seconds, hr, rpe, feel, note, source,
              (SELECT COUNT(*) FROM log_comments c WHERE c.log_id = training_logs.id) AS comments,
              (SELECT COUNT(*) FROM log_comments c WHERE c.log_id = training_logs.id AND c.read_at IS NULL) AS unread
       FROM training_logs WHERE member_id = ? AND date BETWEEN ? AND ? ORDER BY date, created_at LIMIT 1000`).bind(member.id, ...r).all()).results;
    return json({ logs: rows, from: r[0], to: r[1] });
  }
  if (path === '/api/logs' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body(), id = str(b.id, 32);
    const n = (v, lo, hi, int) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? (int ? Math.round(x) : Math.round(x * 100) / 100) : null; };
    const date = str(b.date, 10);
    if (!isDate(date) || date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) return fail(400, '日期不正確（不能記未來的訓練）');
    const status = LOG_STATUS.includes(b.status) ? b.status : 'done';
    const log = {
      date, status, week_no: n(b.week_no, 1, 21, true), plan_day: str(b.plan_day, 12) || null,
      kind: LOG_KINDS.includes(b.kind) ? b.kind : null, plan_text: str(b.plan_text, 300) || null,
      km: status === 'skip' ? null : n(b.km, 0.01, 400), seconds: status === 'skip' ? null : n(b.seconds, 1, 200000, true),
      hr: n(b.hr, 30, 230, true), rpe: n(b.rpe, 1, 10, true), feel: n(b.feel, 1, 5, true),
      note: str(b.note, 300) || null, source: LOG_SOURCES.includes(b.source) ? b.source : 'manual',
    };
    const cols = Object.keys(log);
    if (id) {
      const r = await env.DB.prepare(`UPDATE training_logs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ? AND member_id = ?`)
        .bind(...Object.values(log), id, member.id).run();
      return r.meta.changes ? json({ id }) : fail(404, '找不到這筆紀錄');
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
    await env.DB.prepare('DELETE FROM training_logs WHERE id = ? AND member_id = ?').bind(mlog[1], member.id).run();
    return json({ ok: true });
  }
  // 教練看某位團員的紀錄（本人要有打開分享；不含備註）；以及教練留言
  const canCoach = async (mid) => {
    const m = await env.DB.prepare('SELECT id, name, nickname, share_logs, dist, grp FROM members WHERE id = ?').bind(mid).first();
    if (!m || !m.share_logs) return null;
    if (can(member, 'plan')) return m;
    const shared = (await env.DB.prepare("SELECT team_id FROM team_members WHERE member_id = ? AND status = 'active'").bind(mid).all()).results;
    return shared.some((t) => teamCan(t.team_id, 'roster')) ? m : null;
  };
  const mlm = path.match(/^\/api\/logs\/member\/([\w-]{1,32})$/);
  if (mlm && method === 'GET') {
    const g = need(); if (g) return g;
    const who = await canCoach(mlm[1]);
    if (!who) return fail(403, '這位團員沒有分享訓練紀錄，或不在你帶的分團');
    const r = rangeOf(new URL(req.url), 62, 6);
    if (!r) return fail(400, '查詢區間最長兩個月');
    const rows = (await env.DB.prepare(
      `SELECT id, date, week_no, plan_day, kind, plan_text, status, km, seconds, hr, rpe, feel,
              (SELECT COUNT(*) FROM log_comments c WHERE c.log_id = training_logs.id) AS comments
       FROM training_logs WHERE member_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT 200`).bind(who.id, ...r).all()).results;
    return json({ member: { id: who.id, name: who.name, nickname: who.nickname, dist: who.dist, grp: who.grp }, logs: rows, from: r[0], to: r[1] });
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
      const text = str((await body()).body, 500);
      if (!text) return fail(400, '請輸入留言');
      if (await limited(env, `comment:${member.id}`, 60, 3600)) return fail(429, '留言太頻繁');
      await env.DB.prepare('INSERT INTO log_comments (id, log_id, author_id, author_name, body) VALUES (?, ?, ?, ?, ?)')
        .bind(rid(8), log.id, member.id, member.nickname || member.name, text).run();
      await notify(env, [log.member_id], 'log', { title: `${member.nickname || member.name} 回饋了你的訓練`, body: text.slice(0, 60), url: `/#/log?id=${log.id}` });
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
  // 教練與分團幹部：有開分享的團員，在區間內的完成次數與里程（不含備註）
  if (path === '/api/logs/team' && method === 'GET') {
    const g = need(); if (g) return g;
    const u = new URL(req.url), team = str(u.searchParams.get('team'), 16);
    if (!(can(member, 'plan') || (team && teamCan(team, 'roster')))) return fail(403, '只有教練與分團幹部可以看團員訓練');
    const r = rangeOf(u, 31, 6);
    if (!r) return fail(400, '查詢區間最長 31 天');
    const rows = (await env.DB.prepare(
      `SELECT m.id, m.name, m.nickname, m.avatar, m.dist, m.grp,
              SUM(l.status = 'done') AS done, SUM(l.status = 'partial') AS partial, SUM(l.status = 'skip') AS skip, SUM(l.status = 'extra') AS extra,
              ROUND(SUM(COALESCE(l.km, 0)), 1) AS km, ROUND(AVG(l.rpe), 1) AS rpe, MAX(l.date) AS last
       FROM members m LEFT JOIN training_logs l ON l.member_id = m.id AND l.date BETWEEN ? AND ?
       WHERE m.share_logs = 1 ${team ? "AND m.id IN (SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active')" : ''}
       GROUP BY m.id ORDER BY km DESC, m.name LIMIT 200`).bind(...r, ...(team ? [team] : [])).all()).results;
    return json({ members: rows, from: r[0], to: r[1] });
  }

  // ---- 通知中心 ----
  if (path === '/api/notifications' && method === 'GET') {
    const g = need(); if (g) return g;
    // 一次 30 則，before 往回翻；未讀數另外算
    const before = str(new URL(req.url).searchParams.get('before'), 20);
    const items = (await env.DB.prepare(
      `SELECT id, kind, title, body, url, created_at, read_at FROM notifications WHERE member_id = ? ${before ? 'AND created_at < ?' : ''}
       ORDER BY created_at DESC LIMIT 31`).bind(member.id, ...(before ? [before] : [])).all()).results;
    const unread = (await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read_at IS NULL').bind(member.id).first()).n;
    return json({ items: items.slice(0, 30), next: items.length > 30 ? items[29].created_at : null, unread });
  }
  if (path === '/api/notifications/read' && method === 'POST') {
    const g = need(); if (g) return g;
    await env.DB.prepare("UPDATE notifications SET read_at = datetime('now') WHERE member_id = ? AND read_at IS NULL").bind(member.id).run();
    return json({ ok: true });
  }
  if (path === '/api/notifications/count' && method === 'GET') {
    if (!member) return json({ unread: 0 });
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read_at IS NULL').bind(member.id).first();
    return json({ unread: r.n });
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
    if (b.notify !== false) await notify(env, teamId ? await teamMemberIds(teamId) : await allMemberIds(env), 'plan', { title: `新課表：${title}`, body: `${member.name} 發布了${week ? ` W${week}` : ''}課表`, url: `/#/plan` });
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
  if (path === '/api/my/tickets' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare(
      `SELECT t.code, t.guests, t.meal, t.seat, t.table_no, t.checked_in_at, e.id AS event_id, e.title, e.date, e.gather_time, e.place
       FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.member_id = ? AND e.date >= ? ORDER BY e.date`)
      .bind(member.id, today()).all()).results;
    return json({ tickets: rows });
  }
  const ml = path.match(/^\/api\/events\/([\w-]{1,32})\/layout$/);
  if (ml) {
    const g = need(); if (g) return g;
    if (method === 'GET') {
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
    let n = 0;
    for (const row of list) {
      const code = str(row.code, 8).toUpperCase(), tableNo = Number(row.table_no) || null;
      if (!code) continue;
      const r = await env.DB.prepare('UPDATE tickets SET table_no = ?, note = COALESCE(?, note) WHERE event_id = ? AND code = ?')
        .bind(tableNo, str(row.note, 60) || null, msa[1], code).run();
      n += r.meta.changes;
    }
    return json({ updated: n });
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
    const t = await env.DB.prepare('SELECT t.*, m.name FROM tickets t JOIN members m ON m.id = t.member_id WHERE t.event_id = ? AND t.code = ?')
      .bind(mc[1], code).first();
    if (!t) return fail(404, '找不到這個入場代碼');
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
        await env.DB.batch(rows.slice(0, 200).map((r) => env.DB.prepare(
          'INSERT INTO prizes (id, event_id, name, qty, sponsor, sort, stage, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(rid(8), eid, str(r.name, 60), Math.max(1, Math.min(Number(r.qty) || 1, 400)), str(r.sponsor, 40), ++sort, str(r.stage, 12), str(r.note, 80))));
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
       WHERE t.event_id = ? ${onlyCheckedIn ? 'AND t.checked_in_at IS NOT NULL' : ''}
         ${allowRepeat ? '' : 'AND t.member_id NOT IN (SELECT member_id FROM draws WHERE event_id = ? AND member_id IS NOT NULL)'}`)
      .bind(...(allowRepeat ? [eid] : [eid, eid])).all()).results;
    if (!pool.length) return fail(400, onlyCheckedIn ? '還沒有人報到，或大家都中過獎了' : '沒有可抽的名單');
    const winners = [];
    for (let i = 0; i < want && pool.length; i++) {
      const k = crypto.getRandomValues(new Uint32Array(1))[0] % pool.length;
      winners.push(pool.splice(k, 1)[0]);
    }
    await env.DB.batch(winners.map((w) => env.DB.prepare('INSERT INTO draws (id, event_id, prize_id, member_id, name) VALUES (?, ?, ?, ?, ?)')
      .bind(rid(8), eid, prizeId, w.member_id, w.name)));
    await audit(env, req, member, 'lottery.draw', 'prize', prizeId, `${winners.length} 位`);
    await notify(env, winners.map((w) => w.member_id), 'lottery', { title: `恭喜中獎：${prize.name}`, body: '請到台前領獎', url: `/#/e/${eid}` });
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
    const esc2 = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['時間,階段,獎項,贊助,得獎人,暱稱,桌次',
      ...rows.map((r) => [r.created_at, r.stage, r.prize, r.sponsor, r.name, r.nickname, r.table_no].map(esc2).join(','))].join('\n');
    return new Response(`\ufeff${csv}`, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="draws.csv"' } });
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
    const dr = await env.DB.prepare('SELECT event_id FROM draws WHERE id = ?').bind(mdd[1]).first();
    if (!dr || !teamCan((await evById(dr.event_id))?.team_id, 'lottery')) return fail(403, '只有幹部可以重抽');
    await env.DB.prepare('DELETE FROM draws WHERE id = ?').bind(mdd[1]).run();
    await audit(env, req, member, 'lottery.undo', 'draw', mdd[1], '');
    return json({ ok: true });
  }

  // ---- 活動統計與問卷結果（活動所屬分團的幹部，或協會幹部）----
  const mst = path.match(/^\/api\/events\/([\w-]{1,32})\/(stats|export\.csv)$/);
  if (mst && method === 'GET') {
    const g = need(); if (g) return g;
    const ev = await evById(mst[1]);
    if (!ev) return fail(404, '找不到這個活動');
    if (!teamCan(ev.team_id, 'event') && !teamCan(ev.team_id, 'checkin')) return fail(403, '只有這個活動的幹部可以看統計');
    const qs = parseQ(ev.questions);
    const rows = (await env.DB.prepare(
      `SELECT s.member_id, s.name, s.grp, s.dist, s.note, s.status, s.answers, s.created_at, s.paid, s.paid_note, s.attended_at,
              m.nickname, m.club, m.phone, m.membership,
              t.guests, t.meal, t.table_no, t.checked_in_at,
              (SELECT group_concat(tm.team_id) FROM team_members tm WHERE tm.member_id = s.member_id AND tm.status = 'active') AS teams
       FROM signups s LEFT JOIN members m ON m.id = s.member_id
       LEFT JOIN tickets t ON t.event_id = s.event_id AND t.member_id = s.member_id
       WHERE s.event_id = ? ORDER BY s.created_at`).bind(ev.id).all()).results;
    const teamName = Object.fromEntries((await env.DB.prepare('SELECT id, name FROM teams').all()).results.map((t) => [t.id, t.name]));
    const ans = (r) => { try { return JSON.parse(r.answers || '{}'); } catch { return {}; } };
    if (mst[2] === 'export.csv') {
      // 匯出含個資：寫稽核；電話只有可管理會籍的人看得到；開頭是 = + - @ 的儲存格加 ' 防公式注入
      const fullPhone = can(member, 'members') && !READONLY[norm(member.role)];
      const cell = (v) => { let x = String(v ?? ''); if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`; return `"${x.replace(/"/g, '""')}"`; };
      const STATUS = { in: '正取', wait: '候補', cancel: '已取消' };
      const PAID = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
      const head = ['報名時間', '狀態', '姓名', '暱稱', '分團', '跑團', '項目', '組別', ...(fullPhone ? ['電話'] : []), ...(ev.fee ? ['繳費', '繳費備註'] : []), '出席',
        ...(ev.kind === 'party' ? ['攜伴', '餐點', '桌次', '報到時間'] : []), ...qs.map((q) => q.label), '備註'];
      const lines = rows.map((r) => { const a = ans(r); return [r.created_at, STATUS[r.status] || r.status, r.name, r.nickname,
        (r.teams || '').split(',').filter(Boolean).map((t) => teamName[t] || t).join('、'), r.club, r.dist === 'hm' ? '半馬' : '全馬', r.grp,
        ...(fullPhone ? [r.phone] : []), ...(ev.fee ? [PAID[r.paid] || '', r.paid_note] : []), r.attended_at || r.checked_in_at || '',
        ...(ev.kind === 'party' ? [r.guests ?? '', r.meal, r.table_no ?? '', r.checked_in_at] : []),
        ...qs.map((q) => (Array.isArray(a[q.id]) ? a[q.id].join('、') : a[q.id] ?? '')), r.note].map(cell).join(','); });
      await audit(env, req, member, 'event.export', 'event', ev.id, `${rows.length} 筆`);
      const fname = encodeURIComponent(`${ev.date}-${ev.title}.csv`);
      return new Response(`﻿${[head.map(cell).join(','), ...lines].join('\r\n')}`, { headers: { ...SEC_HEADERS, 'cache-control': 'no-store',
        'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="event.csv"; filename*=UTF-8''${fname}` } });
    }
    const live = rows.filter((r) => r.status !== 'cancel'), ins = live.filter((r) => r.status === 'in');
    const tally = (list, f) => { const o = {}; for (const r of list) for (const k of [].concat(f(r)).filter((x) => x !== '' && x != null)) o[k] = (o[k] || 0) + 1; return o; };
    const byDay = tally(rows, (r) => r.created_at.slice(0, 10));
    return json({
      title: ev.title, date: ev.date, kind: ev.kind, capacity: ev.capacity,
      total: { in: ins.length, wait: live.length - ins.length, cancel: rows.length - live.length,
        guests: ins.reduce((n, r) => n + (r.guests || 0), 0), checkedIn: ins.filter((r) => r.checked_in_at).length,
        attended: ins.filter((r) => r.attended_at || r.checked_in_at).length,
        members: ins.filter((r) => r.membership === 'active').length },
      fee: ev.fee || 0,
      money: ev.fee ? (() => { const due = (r) => ev.fee * (1 + (r.guests || 0));
        return { expected: ins.filter((r) => r.paid !== 'waived').reduce((n, r) => n + due(r), 0),
          collected: ins.filter((r) => r.paid === 'paid').reduce((n, r) => n + due(r), 0),
          counts: tally(ins, (r) => r.paid || 'unpaid') }; })() : null,
      people: live.map((r) => ({ member_id: r.member_id, name: r.name, nickname: r.nickname, status: r.status, guests: r.guests || 0,
        paid: r.paid, paid_note: r.paid_note, attended: !!(r.attended_at || r.checked_in_at), created_at: r.created_at })),
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
        if (b.notify !== false) await notify(env, await teamMemberIds(tid, member.id), 'event', { title: `${team.name}公告：${title}`, body: text.slice(0, 80), url: `/#/t/${tid}` });
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
  if (path === '/api/admin/broadcast' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !(can(member, 'members') && !READONLY[norm(member.role)])) return fail(403, '只有理事長與行政人員可以群發通知');
    if (await limited(env, `broadcast:${member.id}`, 10, 3600)) return fail(429, '一小時最多群發 10 次');
    const b = await body(), title = str(b.title, 60), text = str(b.body, 300), link = str(b.url, 200);
    if (!title) return fail(400, '請填標題');
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
    await notify(env, ids, 'system', { title, body: text, url: link || '/#/notifications' });
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
      if (full) await env.DB.prepare('UPDATE teams SET name = ?, intro = ?, color = ?, line_url = ?, join_policy = ?, private = ?, sort = COALESCE(?, sort) WHERE id = ?')
        .bind(t.name, t.intro, t.color, t.line_url, t.join_policy, t.private, t.sort, tid).run();
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
    if (sub === 'join' && method === 'POST') {
      if (myTeams[tid]) return json({ status: myTeams[tid].status });
      const status = team.join_policy === 'approve' ? 'pending' : 'active';
      await env.DB.prepare('INSERT INTO team_members (team_id, member_id, status) VALUES (?, ?, ?)').bind(tid, member.id, status).run();
      await audit(env, req, member, 'team.join', 'team', tid, `${team.name}${status === 'pending' ? '（申請）' : ''}`);
      if (status === 'pending') {
        const mgr = (await env.DB.prepare("SELECT member_id FROM team_members WHERE team_id = ? AND role IN ('lead','officer') AND status = 'active'").bind(tid).all()).results.map((r) => r.member_id);
        await notify(env, mgr, 'system', { title: `${team.name}：有人申請加入`, body: `${member.name} 想加入${team.name}`, url: `/#/t/${tid}` });
      }
      return json({ status });
    }
    if (sub === 'leave' && method === 'POST') {
      await env.DB.prepare('DELETE FROM team_members WHERE team_id = ? AND member_id = ?').bind(tid, member.id).run();
      await audit(env, req, member, 'team.leave', 'team', tid, team.name);
      return json({ ok: true });
    }
    if (sub === 'members' && method === 'GET') {
      if (!teamCan(tid, 'roster')) return fail(403, '只有這個分團的團長與幹部可以看名冊');
      // 一次 50 人；有關鍵字就只查符合的（姓名、暱稱）
      const u = new URL(req.url), q = str(u.searchParams.get('q'), 20), after = Math.max(0, Number(u.searchParams.get('after')) || 0);
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
      return json({ members: rows.slice(0, 50), next: rows.length > 50 ? after + 50 : null, total, pending,
        can: { approve: teamCan(tid, 'approve'), appoint: teamCan(tid, 'appoint'), lead: can(member, 'roles'),
          add: can(member, 'members') && !READONLY[norm(member.role)] } });
    }
    if (sub === 'members' && method === 'POST') {
      // action：add（協會幹部把人加進分團）｜approve｜remove｜role
      const b = await body(), mid = str(b.member_id, 32), action = str(b.action, 10);
      const target = await env.DB.prepare('SELECT tm.*, m.name FROM members m LEFT JOIN team_members tm ON tm.member_id = m.id AND tm.team_id = ? WHERE m.id = ?').bind(tid, mid).first();
      if (!target) return fail(404, '找不到這位跑友');
      const role = TEAM_ROLES[b.role] ? b.role : 'member';
      if (action === 'add') {
        if (!(can(member, 'members') && !READONLY[norm(member.role)])) return fail(403, '只有協會幹部可以直接把人加進分團');
        if (role === 'lead' && !can(member, 'roles')) return fail(403, '團長只能由理事長指派');
        await env.DB.prepare(`INSERT INTO team_members (team_id, member_id, role, status) VALUES (?, ?, ?, 'active')
          ON CONFLICT(team_id, member_id) DO UPDATE SET status = 'active'`).bind(tid, mid, role).run();
        await audit(env, req, member, 'team.add', 'member', mid, `${team.name}／${TEAM_ROLES[role]}`);
        await notify(env, [mid], 'system', { title: `你已加入${team.name}`, body: team.line_url ? '記得也加入分團的 LINE 群組' : '', url: `/#/t/${tid}` });
        return json({ ok: true });
      }
      if (!target.team_id) return fail(404, '這位跑友不在這個分團');
      // 動到團長（撤換或移除）一律只有理事長可以
      if (target.role === 'lead' && !can(member, 'roles')) return fail(403, '團長只能由理事長調整');
      if (action === 'approve') {
        if (!teamCan(tid, 'approve')) return fail(403, '只有團長與幹部可以審核');
        await env.DB.prepare("UPDATE team_members SET status = 'active' WHERE team_id = ? AND member_id = ?").bind(tid, mid).run();
        await audit(env, req, member, 'team.approve', 'member', mid, team.name);
        await notify(env, [mid], 'system', { title: `${team.name}：申請通過`, body: team.line_url ? '歡迎加入！記得也加入分團的 LINE 群組' : '歡迎加入！', url: `/#/t/${tid}` });
        return json({ ok: true });
      }
      if (action === 'remove') {
        if (!teamCan(tid, target.role === 'member' ? 'approve' : 'appoint')) return fail(403, '沒有移除的權限');
        await env.DB.prepare('DELETE FROM team_members WHERE team_id = ? AND member_id = ?').bind(tid, mid).run();
        await audit(env, req, member, target.status === 'pending' ? 'team.reject' : 'team.remove', 'member', mid, team.name);
        return json({ ok: true });
      }
      if (action === 'role') {
        if (role === 'lead' ? !can(member, 'roles') : !teamCan(tid, 'appoint')) return fail(403, role === 'lead' ? '團長只能由理事長指派' : '只有團長可以指派幹部');
        if (mid === member.id && !can(member, 'roles')) return fail(400, '不能調整自己的分團身分');
        await env.DB.prepare("UPDATE team_members SET role = ?, title = ?, status = 'active' WHERE team_id = ? AND member_id = ?")
          .bind(role, str(b.title, 12) || null, tid, mid).run();
        await audit(env, req, member, 'team.role', 'member', mid, `${team.name}／${TEAM_ROLES[role]}${b.title ? `／${str(b.title, 12)}` : ''}`);
        await notify(env, [mid], 'system', { title: `${team.name}：身分更新`, body: `你在${team.name}的身分是${str(b.title, 12) || TEAM_ROLES[role]}`, url: `/#/t/${tid}` });
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
    const q = sp('q', 20).replace(/[%_]/g, ''), ms = sp('membership', 10), role = sp('role', 12), team = sp('team', 16), after = Math.max(0, Number(u.searchParams.get('after')) || 0);
    const where = [], args = [];
    if (q) { where.push('(name LIKE ? OR nickname LIKE ? OR club LIKE ? OR member_no = ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, q); }
    if (MEMBERSHIP[ms]) { where.push('membership = ?'); args.push(ms); }
    if (role === 'officers') where.push("role NOT IN ('member')");
    else if (ROLES[role]) { where.push('role = ?'); args.push(role); }
    if (team) { where.push("id IN (SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active')"); args.push(team); }
    const counts = Object.fromEntries((await env.DB.prepare('SELECT membership, COUNT(*) AS n FROM members GROUP BY membership').all()).results.map((r) => [r.membership || 'none', r.n]));
    const meta = { roles: ROLES, perms: PERMS, membership: MEMBERSHIP, memberTypes: MEMBER_TYPES, counts, total: Object.values(counts).reduce((a2, b2) => a2 + b2, 0) };
    if (!where.length) return json({ members: [], next: null, matched: 0, needFilter: true, ...meta });
    const W = `WHERE ${where.join(' AND ')}`;
    const rows = (await env.DB.prepare(
      `SELECT id, name, nickname, club, dist, grp, role, title, avatar, created_at,
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
  const mm = path.match(/^\/api\/members\/([\w-]{1,32})\/membership$/);
  if (mm && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'members') || READONLY[norm(member.role)]) return fail(403, '沒有管理會籍的權限');
    const b = await body();
    const st = MEMBERSHIP[b.membership] ? b.membership : null;
    if (!st) return fail(400, '會籍狀態不正確');
    await env.DB.prepare('UPDATE members SET membership = ?, member_type = ?, member_no = ?, joined_on = ?, paid_until = ?, membership_note = ? WHERE id = ?')
      .bind(st, str(b.member_type, 10) || null, str(b.member_no, 20) || null, str(b.joined_on, 10) || null,
            str(b.paid_until, 10) || null, str(b.membership_note, 100) || null, mm[1]).run();
    await audit(env, req, member, 'membership.update', 'member', mm[1], `${MEMBERSHIP[st]}${b.member_type ? `／${str(b.member_type, 10)}` : ''}`);
    if (st === 'active') await notify(env, [mm[1]], 'system', { title: '入會完成', body: '你已經是台灣耕跑團協會會員', url: '/#/me' });
    return json({ ok: true });
  }

  // 跑友自己申請入會（填完表單後按一下，行政人員在後台審核）
  if (path === '/api/me/apply' && method === 'POST') {
    const g = need(); if (g) return g;
    if (member.membership === 'active') return fail(400, '你已經是會員');
    await env.DB.prepare("UPDATE members SET membership = 'applied' WHERE id = ?").bind(member.id).run();
    const admins = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair','staff','director')").all()).results.map((r) => r.id);
    await notify(env, admins, 'system', { title: '有人申請入會', body: `${member.name} 送出入會申請`, url: '/#/admin' });
    return json({ member: pub({ ...member, membership: 'applied' }) });
  }

  const mr = path.match(/^\/api\/members\/([\w-]{1,32})\/role$/);
  if (mr && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'roles')) return fail(403, '只有理事長可以指派角色');
    const b = await body(), role = ROLES[b.role] ? b.role : null;
    if (!role) return fail(400, '角色不正確');
    if (mr[1] === member.id && role !== 'chair') return fail(400, '不能把自己降級，請先指派新的理事長');
    await env.DB.prepare('UPDATE members SET role = ?, title = ? WHERE id = ?').bind(role, str(b.title, 20) || null, mr[1]).run();
    await revokeSessions(env, mr[1]);
    await audit(env, req, member, 'role.change', 'member', mr[1], `${ROLES[role]}${b.title ? `／${str(b.title, 20)}` : ''}`);
    await notify(env, [mr[1]], 'system', { title: '身分更新', body: `你的身分已設定為${ROLES[role]}`, url: '/#/me' });
    return json({ ok: true });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body();
    const endpoint = str(b.endpoint, 1000), p256dh = str(b.keys?.p256dh, 200), auth = str(b.keys?.auth, 100);
    if (!validEndpoint(endpoint) || !/^[A-Za-z0-9_-]{40,120}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) return fail(400, '訂閱資料錯誤');
    await subscribe(env, member.id, { endpoint, p256dh, auth });
    return json({ ok: true });
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const g = need(); if (g) return g;
    await unsubscribe(env, member.id, str((await body()).endpoint, 1000));
    return json({ ok: true });
  }
  if (path === '/api/push/test' && method === 'POST') {
    const g = need(); if (g) return g;
    const n = await push(env, [member.id], { title: '耕跑團', body: '通知設定完成，新團練和報名提醒都會通知你。', url: '/' });
    return n ? json({ ok: true, sent: n }) : fail(400, '沒有送出，請確認這台裝置已開啟通知');
  }

  return fail(404, '沒有這個 API');
}

// ---- 排程工作（wrangler.jsonc 的 cron：每小時整點）----
// 時間一律用台北時間判斷；每項工作都有防重複的標記，重跑也不會重複通知
const taipei = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3);   // 只拿來讀年月日時，不當成真的時區物件
const tpDate = (d) => taipei(d).toISOString().slice(0, 10);
async function onceOn(env, job, key) {
  // 同一個 key（例如日期、季別）只執行一次
  const r = await env.DB.prepare('SELECT last_run FROM job_runs WHERE job = ?').bind(job).first();
  if (r?.last_run === key) return false;
  await env.DB.prepare('INSERT INTO job_runs (job, last_run) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET last_run = excluded.last_run').bind(job, key).run();
  return true;
}
const signedIds = async (env, eid) => (await env.DB.prepare("SELECT member_id FROM signups WHERE event_id = ? AND status = 'in' AND member_id IS NOT NULL").bind(eid).all()).results.map((r) => r.member_id);

// 活動提醒：前一晚 20:00 提醒明天的活動；集合前 1–2 小時再提醒一次
async function remindEvents(env, now) {
  const hour = taipei(now).getUTCHours(), today0 = tpDate(now), tomorrow = tpDate(new Date(now.getTime() + 864e5));
  let sent = 0;
  if (hour === 20) {
    const evs = (await env.DB.prepare(`SELECT id, title, date, gather_time, place, kind FROM events
      WHERE date = ? AND status = 'open' AND kind != 'survey' AND remind_day_at IS NULL`).bind(tomorrow).all()).results;
    for (const ev of evs) {
      const ids = await signedIds(env, ev.id);
      await env.DB.prepare("UPDATE events SET remind_day_at = datetime('now') WHERE id = ?").bind(ev.id).run();
      if (!ids.length) continue;
      await notify(env, ids, 'event', { title: `明天：${ev.title}`, body: `${ev.gather_time ? `${ev.gather_time} 集合` : '明天'}${ev.place ? `・${ev.place}` : ''}${ev.kind === 'party' ? '・記得帶入場券 QR Code' : ''}`, url: `/#/e/${ev.id}`, tag: `day-${ev.id}` });
      sent += ids.length;
    }
  }
  // 集合時間落在 (現在 + 60 分, 現在 + 120 分]
  const nowMin = taipei(now).getUTCHours() * 60 + taipei(now).getUTCMinutes();
  const evs = (await env.DB.prepare(`SELECT id, title, gather_time, place, kind FROM events
    WHERE date = ? AND status = 'open' AND kind != 'survey' AND gather_time != '' AND gather_time IS NOT NULL AND remind_hour_at IS NULL`).bind(today0).all()).results;
  for (const ev of evs) {
    const [h, m] = ev.gather_time.split(':').map(Number), diff = h * 60 + m - nowMin;
    if (!(diff > 60 && diff <= 120)) continue;
    const ids = await signedIds(env, ev.id);
    await env.DB.prepare("UPDATE events SET remind_hour_at = datetime('now') WHERE id = ?").bind(ev.id).run();
    if (!ids.length) continue;
    await notify(env, ids, 'event', { title: `${ev.gather_time} 集合：${ev.title}`, body: `${ev.place || ''}${ev.kind === 'party' ? '　入場券在「我的入場券」' : '　出門前記得暖身補水'}`, url: ev.kind === 'party' ? '/#/tickets' : `/#/e/${ev.id}`, tag: `hour-${ev.id}` });
    sent += ids.length;
  }
  return sent;
}

// 會費到期：到期前 30 天提醒本人一次（同一個到期日只提醒一次）
async function remindRenewals(env, now) {
  const until = tpDate(new Date(now.getTime() + 30 * 864e5)), today0 = tpDate(now);
  const rows = (await env.DB.prepare(`SELECT id, paid_until FROM members WHERE membership = 'active' AND paid_until IS NOT NULL
    AND paid_until BETWEEN ? AND ? AND (renew_notified IS NULL OR renew_notified != paid_until) LIMIT 500`).bind(today0, until).all()).results;
  for (const r of rows) {
    await notify(env, [r.id], 'system', { title: '會費即將到期', body: `你的協會會費繳至 ${r.paid_until}，記得續繳`, url: '/#/me' });
    await env.DB.prepare('UPDATE members SET renew_notified = ? WHERE id = ?').bind(r.paid_until, r.id).run();
  }
  return rows.length;
}

// 每季第一天 09:00：提醒理事長與監事檢視幹部名單與權限（ISO 27001 A.5.18）
async function quarterlyReview(env, now) {
  const t = taipei(now);
  if (t.getUTCDate() !== 1 || ![0, 3, 6, 9].includes(t.getUTCMonth()) || t.getUTCHours() !== 9) return 0;
  if (!(await onceOn(env, 'quarterly_review', `${t.getUTCFullYear()}Q${t.getUTCMonth() / 3 + 1}`))) return 0;
  const ids = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair', 'supervisor')").all()).results.map((r) => r.id);
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE role != 'member'").first()).n;
  const leads = (await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE role IN ('lead', 'officer') AND status = 'active'").first()).n;
  await notify(env, ids, 'system', { title: '每季權限檢視', body: `目前協會幹部 ${n} 位、分團團長與幹部 ${leads} 位。請確認卸任的人已移除權限。`, url: '/#/admin?tab=roles' });
  await audit(env, null, null, 'review.reminder', 'system', null, `幹部 ${n}、分團幹部 ${leads}`);
  return ids.length;
}

// 每天 03:00：清掉過期資料；活動個資依後台設定的保存年限清除（沒設定就不動）
async function retention(env, now) {
  const t = taipei(now);
  if (t.getUTCHours() !== 3 || !(await onceOn(env, 'retention', tpDate(now)))) return null;
  const org = (await getSettings(env)).org || {};
  const out = {};
  const run = async (k, sql, ...args) => { out[k] = (await env.DB.prepare(sql).bind(...args).run()).meta.changes; };
  await run('sessions', "DELETE FROM sessions WHERE expires_at < datetime('now')");
  await run('rate_limits', "DELETE FROM rate_limits WHERE window_end < datetime('now')");
  await run('notifications', "DELETE FROM notifications WHERE created_at < datetime('now', '-180 days')");
  const auditYears = Math.max(1, Math.min(Number(org.audit_years) || 3, 10));
  await run('audit', `DELETE FROM audit_log WHERE at < datetime('now', '-${auditYears} years')`);
  const evYears = Math.max(0, Math.min(Number(org.event_data_years) || 0, 20));
  if (evYears) {
    const cut = `${t.getUTCFullYear() - evYears}${tpDate(now).slice(4)}`;
    const old = `SELECT id FROM events WHERE date < ?`;
    await run('signups', `DELETE FROM signups WHERE event_id IN (${old})`, cut);
    await run('tickets', `DELETE FROM tickets WHERE event_id IN (${old})`, cut);
    await run('invites', `DELETE FROM event_invites WHERE event_id IN (${old})`, cut);
    await run('draws', `UPDATE draws SET name = '已清除', member_id = NULL WHERE member_id IS NOT NULL AND event_id IN (${old})`, cut);
  }
  const logYears = Math.max(0, Math.min(Number(org.log_years) || 0, 20));
  if (logYears) await run('training_logs', `DELETE FROM training_logs WHERE date < date('now', '-${logYears} years')`);
  await audit(env, null, null, 'retention.cleanup', 'system', null, Object.entries(out).map(([k, v]) => `${k} ${v}`).join('、'));
  return out;
}

// 每天 21:00：疲勞提醒（只通知本人，不通知教練）
//   最近 7 天有 3 次以上 RPE ≥ 8，或最近 7 天里程超過前三週平均的 1.3 倍（而且超過 20 公里）
async function fatigueCheck(env, now) {
  if (taipei(now).getUTCHours() !== 21 || !(await onceOn(env, 'fatigue', tpDate(now)))) return 0;
  const d7 = tpDate(new Date(now.getTime() - 6 * 864e5)), d28 = tpDate(new Date(now.getTime() - 27 * 864e5)), today0 = tpDate(now);
  const rows = (await env.DB.prepare(`SELECT member_id,
      SUM(CASE WHEN date >= ?1 AND rpe >= 8 THEN 1 ELSE 0 END) AS hard,
      SUM(CASE WHEN date >= ?1 THEN COALESCE(km, 0) ELSE 0 END) AS km7,
      SUM(CASE WHEN date < ?1 THEN COALESCE(km, 0) ELSE 0 END) AS km21
    FROM training_logs WHERE date BETWEEN ?2 AND ?3 GROUP BY member_id`).bind(d7, d28, today0).all()).results;
  let n = 0;
  for (const r of rows) {
    const jump = r.km7 > 20 && r.km21 > 0 && r.km7 > (r.km21 / 3) * 1.3;
    if (!(r.hard >= 3 || jump)) continue;
    const m = await env.DB.prepare('SELECT fatigue_notified FROM members WHERE id = ?').bind(r.member_id).first();
    if (m?.fatigue_notified && Date.parse(today0) - Date.parse(m.fatigue_notified) < 7 * 864e5) continue;
    await notify(env, [r.member_id], 'log', { title: '這週練得很兇，注意恢復',
      body: r.hard >= 3 ? `最近 7 天有 ${r.hard} 次自覺強度 8 以上，安排一兩天輕鬆跑或休息吧` : `最近 7 天跑了 ${Math.round(r.km7)} 公里，比前三週平均多了不少，小心受傷`, url: '/#/report' });
    await env.DB.prepare('UPDATE members SET fatigue_notified = ? WHERE id = ?').bind(today0, r.member_id).run();
    n += 1;
  }
  return n;
}

// 每天台北 09:00：把前一天（UTC）的稽核 HMAC 串成摘要鏈；有人刪掉或改掉紀錄，重算就對不上
async function auditDigest(env, now) {
  if (!env.AUDIT_KEY || taipei(now).getUTCHours() !== 9) return null;
  const day = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
  if (await env.DB.prepare('SELECT 1 FROM audit_digests WHERE day = ?').bind(day).first()) return null;
  const prev = (await env.DB.prepare('SELECT digest FROM audit_digests WHERE day < ? ORDER BY day DESC LIMIT 1').bind(day).first())?.digest || '';
  const rows = (await env.DB.prepare('SELECT mac FROM audit_log WHERE at >= ? AND at < ? AND mac IS NOT NULL ORDER BY at, id').bind(day, `${day} 24`).all()).results;
  const digest = await hmac(env, `${prev}|${rows.map((x) => x.mac).join('|')}`);
  await env.DB.prepare('INSERT INTO audit_digests (day, rows, digest) VALUES (?, ?, ?)').bind(day, rows.length, digest).run();
  return { day, rows: rows.length };
}

async function scheduled(env, now = new Date()) {
  const res = {};
  for (const [k, fn] of [['events', remindEvents], ['renewals', remindRenewals], ['review', quarterlyReview], ['retention', retention], ['fatigue', fatigueCheck], ['auditDigest', auditDigest]]) {
    try { res[k] = await fn(env, now); } catch (e) { console.error('cron', k, e); res[k] = `error: ${e.message}`; }
  }
  return res;
}

export default {
  async scheduled(event, env, ctx) {
    env.defer = (p) => ctx.waitUntil(Promise.resolve(p).catch((e) => console.error('defer', e)));
    ctx.waitUntil(scheduled(env, new Date(event.scheduledTime)).then((r) => console.log('cron', JSON.stringify(r))));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    env.ctx = ctx;
    // LINE 登入是瀏覽器導向（GET、不是 JSON），走在下面的 CSRF 檢查之前
    if (path === '/api/line/start' && req.method === 'GET') return lineStart(env, url);
    if (path === '/api/line/callback' && req.method === 'GET') return lineCallback(req, env, url);
    // 開發用：手動觸發排程，可指定時間 ?at=2026-10-03T12:00:00Z（只有 DEV_LOGIN=1 的本機有效）
    if (path === '/api/dev/cron' && env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      env.defer = (p) => ctx.waitUntil(Promise.resolve(p).catch(() => {}));
      return json(await scheduled(env, url.searchParams.get('at') ? new Date(url.searchParams.get('at')) : new Date()));
    }
    // 開發用登入：只有 .dev.vars 設 DEV_LOGIN=1 而且在 localhost 才有效，正式環境不會有這個設定
    if (path === '/api/dev/login' && req.method === 'GET' && env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(str(url.searchParams.get('id'), 32)).first();
      if (!m) return fail(404, '找不到這個帳號');
      return new Response(null, { status: 302, headers: { location: '/#/', 'set-cookie': await startSession(env, m, req) } });
    }
    env.ctx = ctx;
    env.defer = (p) => ctx.waitUntil(Promise.resolve(p).catch((e) => console.error('defer', e)));
    // 擋 CSRF：寫入類請求只收同源的 JSON
    if (req.method !== 'GET') {
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) return fail(403, '來源不正確');
      if (!(req.headers.get('content-type') || '').includes('application/json') && req.method !== 'DELETE') return fail(415, '請用 JSON');
    }
    try {
      return await api(req, env, path, req.method);
    } catch (e) {
      console.error('api', path, e);
      return fail(500, '伺服器錯誤');
    }
  },
};
