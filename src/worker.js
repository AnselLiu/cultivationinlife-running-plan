// 耕跑團 Cultivation in Life Run — API（Cloudflare Worker ＋ D1）
// 資安設計對應 ISO/IEC 27001:2022 附錄 A（詳見 docs/SECURITY.md）：
//   A.5.15／A.5.18 存取控制：最小權限，特權身分只能由理事長指派，不能靠共用代碼取得
//   A.8.2 特權存取：幹部的工作階段閒置 8 小時、絕對 7 天就失效；身分變更後舊工作階段立即作廢
//   A.8.5 安全鑑別：Google OIDC（state＋nonce、JWKS 驗章）、通行金鑰；邀請碼與報到代碼有嘗試次數限制
//   A.8.15 日誌：特權操作寫入 audit_log，監事可查
//   A.5.34 個資：最小蒐集、電話遮罩、IP 只存雜湊、本人可匯出與刪除
// 工作階段權杖放 HttpOnly cookie，D1 只存 SHA-256；寫入類 API 只接受同源 JSON（擋 CSRF）。
import { subscribe, unsubscribe, push, validEndpoint } from './push.js';
import * as WebAuthn from './webauthn.js';
import { quote } from '../public/pricing.js';
import { hourOf } from '../public/wxrule.js';
import { BADGES, earned, weeksOf } from '../public/badges.js';

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
const PRIVACY_VERSION = '2026-10-03.3';
const SETTING_KEYS = ['org', 'features', 'docs', 'privacy'];
async function getSettings(env, preloaded) {
  const rows = preloaded || (await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN ('org','features','docs','privacy','tabs')`).all()).results;
  const out = { org: {}, features: {}, docs: [], privacy: { version: PRIVACY_VERSION, body: '' }, tabs: {} };
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
    `SELECT m.*, s.last_seen_at AS s_seen, s.role_at_issue AS s_role, s.created_at AS s_created, s.mfa_at AS s_mfa, s.token_hash AS s_th,
       (SELECT json_group_array(json_object('team_id', tm.team_id, 'role', tm.role, 'status', tm.status, 'title', tm.title)) FROM team_members tm WHERE tm.member_id = m.id) AS s_teams
     FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).bind(th).first();
  if (!row) return null;
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
  const r = await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_end) VALUES (?, 1, datetime('now', '+${Math.round(windowSec)} seconds'))
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_end > datetime('now') THEN count + 1 ELSE 1 END,
      window_end = CASE WHEN window_end > datetime('now') THEN window_end ELSE excluded.window_end END
    RETURNING count`).bind(key).first();
  return (r?.count || 0) > limit;
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
  share_logs: !!m.share_logs, show_rank: !!m.show_rank, main_team: m.main_team || null, home_spot: m.home_spot || null, can: PERMS[norm(m.role)],
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
    googleKeys = { at: Date.now(), keys: (await (await fetch('https://www.googleapis.com/oauth2/v3/certs')).json()).keys || [] };
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
    const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).json();
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
  env.ctx?.waitUntil(noteDevice({ ...env, defer: (p) => env.ctx.waitUntil(p) }, req, m, ' Google '));
  return new Response(null, { status: 302, headers: [
    ['location', isNew ? '/#/me?welcome=1' : '/#/'],
    ['set-cookie', await startSession(env, m, req)],
    ['set-cookie', clear],
  ] });
}

// ---- 賽事報名資料（代為團體報名用）：AES-GCM 加密，金鑰 RACE_KEY（32 bytes base64）----
const RACE_FIELDS = {
  name_zh: ['中文姓名', 20, true], name_en: ['英文姓名（護照拼音）', 40, false], id_no: ['身分證字號或護照號碼', 20, true],
  birthday: ['生日', 10, true], gender: ['性別', 4, true], phone: ['手機', 20, true], email: ['Email', 80, false],
  address: ['通訊地址', 120, false], emergency_name: ['緊急聯絡人', 20, true], emergency_phone: ['緊急聯絡人電話', 20, true],
  emergency_rel: ['關係', 10, false], shirt: ['衣服尺寸', 6, true], note: ['備註', 100, false],
};
async function raceKey(env) {
  if (!env.RACE_KEY) throw new Error('尚未設定 RACE_KEY');
  return crypto.subtle.importKey('raw', WebAuthn.unb64u(env.RACE_KEY.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'AES-GCM', false, ['encrypt', 'decrypt']);
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
const maskId = (v) => (v ? `${v.slice(0, 2)}${'*'.repeat(Math.max(0, v.length - 5))}${v.slice(-3)}` : '');

// ---- 活動 ----
const eventCols = 'id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, status, created_at, fee, guest_max, meal_options, link_url, link_label, team_id, questions, visibility, created_by, options, group_reg, items, pricing, pay_info, min_qty, series_id, spot_id, route_id';

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
  if (ev.deadline && new Date(ev.deadline) < new Date()) return fail(400, '已經過了報名截止時間');
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in'").bind(ev.id).first()).n;
  const mine = await env.DB.prepare('SELECT id, status, created_at, amount, paid, items, amount_detail FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
  // 加購／團購：檢查品項、尺寸、每人上限與庫存（庫存扣掉其他人已訂的數量）
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
      const others = (await env.DB.prepare("SELECT items FROM signups WHERE event_id = ? AND status = 'in' AND member_id != ? AND items IS NOT NULL").bind(ev.id, member.id).all()).results
        .reduce((t, r) => t + parseQ(r.items).filter((x) => x.id === d.id).reduce((u, x) => u + x.qty, 0), 0);
      if (others + q > d.stock) return fail(400, `「${d.name}」只剩 ${Math.max(0, d.stock - others)} 件`);
    }
  }
  if (ev.kind === 'buy' && !items.length) return fail(400, '請至少選一項商品');
  // 金額由伺服器算：早鳥看第一次報名的日期（改報名內容不會失去早鳥）
  const guests0 = ev.kind === 'party' ? Math.max(0, Math.min(Number(b.guests) || 0, ev.guest_max || 0)) : 0;
  const q = quote({ ...ev, options: opts, items: defs, pricing: parseQ(ev.pricing, {}) },
    { option, guests: guests0, items, membership: member.membership, signedOn: mine?.created_at ? tpDate(new Date(`${mine.created_at.replace(' ', 'T')}Z`)) : today() });
  // 已繳費後追加：改回未繳，備註差額
  const repay = mine?.paid === 'paid' && mine.amount != null && q.total > mine.amount;
  const full = ev.capacity && n >= ev.capacity && mine?.status !== 'in';
  const status = full ? 'wait' : 'in';
  if (mine) {
    await env.DB.prepare(`UPDATE signups SET name = ?, grp = ?, dist = ?, note = ?, status = ?, answers = ?, option = ?,
      reg_consent_at = CASE WHEN ? THEN COALESCE(reg_consent_at, datetime('now')) ELSE NULL END, items = ?, amount = ?, amount_detail = ?,
      paid = CASE WHEN ? THEN 'unpaid' ELSE paid END, paid_note = CASE WHEN ? THEN ? ELSE paid_note END WHERE id = ?`)
      .bind(name, grp, dist, str(b.note, 100), status, ans.answers, option, ev.group_reg ? 1 : 0, items.length ? JSON.stringify(items) : null, q.total, JSON.stringify(q.lines),
        repay ? 1 : 0, repay ? 1 : 0, repay ? `追加 ${q.total - mine.amount} 元` : null, mine.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO signups (id, event_id, member_id, name, grp, dist, note, status, answers, option, reg_consent_at, items, amount, amount_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${ev.group_reg ? "datetime('now')" : 'NULL'}, ?, ?, ?)`)
      .bind(rid(8), ev.id, member.id, name, grp, dist, str(b.note, 100), status, ans.answers, option, items.length ? JSON.stringify(items) : null, q.total, JSON.stringify(q.lines)).run();
  }
  // 同時很多人報名：寫入後再確認一次（D1 沒有交易鎖）
  //   名額：照報名先後，排在名額外的改成候補；庫存：超賣就把這筆退回原狀
  let final = status;
  const row = await env.DB.prepare('SELECT id, created_at FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
  if (status === 'in' && ev.capacity && mine?.status !== 'in') {
    const ahead = (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in' AND (created_at < ? OR (created_at = ? AND id < ?))")
      .bind(ev.id, row.created_at, row.created_at, row.id).first()).n;
    if (ahead >= ev.capacity) { await env.DB.prepare("UPDATE signups SET status = 'wait' WHERE id = ?").bind(row.id).run(); final = 'wait'; }
  }
  if (final === 'in' && items.length) for (const d of defs.filter((x) => x.stock && items.some((y) => y.id === x.id))) {
    const sold = (await env.DB.prepare("SELECT items FROM signups WHERE event_id = ? AND status = 'in' AND items IS NOT NULL").bind(ev.id).all()).results
      .reduce((t, r) => t + parseQ(r.items).filter((x) => x.id === d.id).reduce((u, x) => u + x.qty, 0), 0);
    if (sold > d.stock) {
      if (mine) await env.DB.prepare('UPDATE signups SET items = ?, amount = ?, amount_detail = ?, status = ? WHERE id = ?').bind(mine.items, mine.amount, mine.amount_detail, mine.status, row.id).run();
      else await env.DB.prepare('DELETE FROM signups WHERE id = ?').bind(row.id).run();
      return fail(409, `「${d.name}」剛好被訂完了，請重新整理看剩餘數量`);
    }
  }
  if (ev.kind === 'party' && final === 'in') {
    const guests = Math.max(0, Math.min(Number(b.guests) || 0, ev.guest_max || 0));
    const meal = str(b.meal, 20) || member.meal_pref || '';
    await env.DB.prepare(`INSERT INTO tickets (id, event_id, member_id, code, guests, meal, note) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, member_id) DO UPDATE SET guests = excluded.guests, meal = excluded.meal, note = excluded.note`)
      .bind(rid(8), ev.id, member.id, ticketCode(), guests, meal, str(b.note, 60)).run();
  }
  return json({ ok: true, status: final, amount: q.total, lines: q.lines });
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
  const k = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`, cache = caches.default, key = new Request(`https://cil-run.internal/weather/v1/${k}`);
  const hit = await cache.match(key);
  if (hit) return { body: await hit.text(), hit: true };
  const [la, lo] = k.split(',');
  const fc = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,uv_index&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,weather_code&timezone=Asia%2FTaipei&forecast_days=7&wind_speed_unit=ms`;
  const aq = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${la}&longitude=${lo}&hourly=pm2_5,us_aqi&timezone=Asia%2FTaipei&forecast_days=5`;
  const [a, b] = await Promise.all([fetch(fc).then((r) => (r.ok ? r.json() : null)).catch(() => null), fetch(aq).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  if (!a?.hourly) return null;
  const body = JSON.stringify({ at: new Date().toISOString(), hourly: a.hourly, daily: a.daily, air: b?.hourly ? { time: b.hourly.time, pm2_5: b.hourly.pm2_5, us_aqi: b.hourly.us_aqi } : null });
  const put = cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } }));
  env.ctx?.waitUntil ? env.ctx.waitUntil(put) : await put;
  return { body, hit: false };
}

// ---- 路由 ----
async function api(req, env, path, method) {
  // 登入狀態（含我在各分團的身分）與系統設定同時查，一次往返就好
  const [member0, settingRows] = await Promise.all([currentMember(req, env), env.DB.prepare('SELECT key, value FROM settings').all().then((r) => r.results)]);
  let member = member0;
  const setting = (k) => settingRows.find((r) => r.key === k)?.value;
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
  // 活動清單（/api/events 與開啟 App 的 /api/me?boot=1 共用）
  const listEvents = async (past, range) => {
    const rows = (await env.DB.prepare(
      `SELECT ${eventCols}, (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'in') AS signed,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'wait') AS waiting,
              (SELECT s.status FROM signups s WHERE s.event_id = events.id AND s.member_id = ?1) AS mine,
              (SELECT json_group_array(json_object('n', x.name, 'a', x.avatar)) FROM (
                 SELECT s.name, m.avatar FROM signups s LEFT JOIN members m ON m.id = s.member_id
                 WHERE s.event_id = events.id AND s.status = 'in' ORDER BY s.created_at LIMIT 4) x) AS peek
       FROM events WHERE date BETWEEN ?3 AND ?4 ${past ? 'AND date < ?5' : ''} AND ${seeSQL} ORDER BY date ${past ? 'DESC' : 'ASC'}, gather_time LIMIT 100`)
      .bind(member.id, can(member, 'event') ? 1 : 0, ...range, ...(past ? [today()] : [])).all()).results;
    return rows.map(({ questions, options, items, pricing, pay_info, ...r }) => ({ ...r, survey: !!questions, options: parseQ(options),
      items: parseQ(items).map((i) => ({ name: i.name, price: i.price })), peek: JSON.parse(r.peek || '[]') }));
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
    const l = await store.list();
    return json({ enabled: !!env.BACKUP_KEY, where: store.kind, list: l.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 40) });
  }
  if (path === '/api/backups' && method === 'POST') {
    const g = need(); if (g) return g;
    if (norm(member.role) !== 'chair' && norm(member.role) !== 'staff') return fail(403, '只有理事長與行政人員可以手動備份');
    { const su = await needStepUp(); if (su) return su; }
    if (!backupStore(env) || !env.BACKUP_KEY) return fail(400, '備份還沒設定');
    if (await limited(env, `backup:${member.id}`, 3, 3600)) return fail(429, '一小時最多手動備份 3 次');
    const r = await runBackup(env, `${today()}-manual-${Date.now().toString(36)}`);
    await audit(env, req, member, 'backup.manual', 'system', null, `${r.tables} 張表 ${r.rows} 筆`);
    return json(r);
  }
  // ---- 練跑地圖 ----
  const SPOT_KINDS = ['track', 'river', 'park', 'trail', 'road', 'other'];
  // 地點審核與管理：協會層級有建立活動權限的幹部（分團幹部可以提議，不能改別人的）
  const canEditSpots = () => !!member && !READONLY[norm(member.role)] && can(member, 'event');
  const readSpot = (b) => {
    const lat = Number(b.lat), lng = Number(b.lng);
    const info = {}; for (const k of ['surface', 'lap', 'light', 'water', 'toilet', 'parking', 'hours']) { const v = str(b.info?.[k], 60); if (v) info[k] = v; }
    const sp = { name: str(b.name, 40), kind: SPOT_KINDS.includes(b.kind) ? b.kind : 'other', lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, intro: str(b.intro, 600), info: Object.keys(info).length ? JSON.stringify(info) : null };
    if (!sp.name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return sp;
  };
  if (path === '/api/spots' && method === 'GET') {
    const g = need(); if (g) return g;
    const editor = canEditSpots();
    const rows = (await env.DB.prepare(`SELECT s.id, s.name, s.kind, s.lat, s.lng, s.status, s.created_by,
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
    await env.DB.prepare('INSERT INTO spots (id, name, kind, lat, lng, intro, info, status, created_by, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, sp.name, sp.kind, sp.lat, sp.lng, sp.intro || null, sp.info, editor ? 'approved' : 'pending', member.id, editor ? member.id : null).run();
    await audit(env, req, member, editor ? 'spot.add' : 'spot.propose', 'spot', id, sp.name);
    if (!editor) {
      const mgr = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair', 'staff', 'coach')").all()).results.map((r) => r.id);
      await notify(env, mgr, 'system', { title: '練跑地圖：有新的地點提議', body: `${member.name} 提議「${sp.name}」，請到地圖審核`, url: `/#/map?spot=${id}` });
    }
    return json({ id, status: editor ? 'approved' : 'pending' });
  }
  const msp = path.match(/^\/api\/spots\/([\w-]{1,32})(?:\/(reports|review))?(?:\/([\w-]{1,32}))?$/);
  if (msp) {
    const g = need(); if (g) return g;
    const sp = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(msp[1]).first();
    const editor = canEditSpots();
    if (!sp || (sp.status !== 'approved' && sp.created_by !== member.id && !editor)) return fail(404, '找不到這個地點');
    const sub = msp[2];
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
      await env.DB.prepare("UPDATE spots SET name = ?, kind = ?, lat = ?, lng = ?, intro = ?, info = ?, updated_at = datetime('now') WHERE id = ?").bind(v.name, v.kind, v.lat, v.lng, v.intro || null, v.info, sp.id).run();
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
      if (sp.created_by && sp.created_by !== member.id) await notify(env, [sp.created_by], 'system', { title: ok ? `「${sp.name}」已加到練跑地圖` : `「${sp.name}」沒有通過`, body: ok ? '謝謝你的提議' : '可以補充說明後再提議一次', url: `/#/map?spot=${sp.id}` });
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
    await env.DB.prepare('INSERT INTO routes (id, name, points, distance, spot_id, shared, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, JSON.stringify(pts), Math.round(dist), spot, b.shared === false ? 0 : 1, member.id).run();
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
      if (r.created_by !== member.id) await audit(env, req, member, 'route.delete', 'route', r.id, r.name);
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
          (SELECT s.status FROM signups s WHERE s.event_id = events.id AND s.member_id = ?1) AS mine,
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
    const rows = [];
    for (let page = 0; page < 20; page++) {
      const r = await fetch(`https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json?page=${page}&size=1000`, { headers: { accept: 'application/json' }, cf: { cacheTtl: 3600 } });
      if (!r.ok) return fail(502, `新北市資料開放平台暫時無法連線（${r.status}），請稍後再試`);
      const list = await r.json().catch(() => null);
      if (!Array.isArray(list)) return fail(502, '新北市資料開放平台回傳的格式不正確');
      if (!list.length) break;
      for (const x of list) if (String(x.year) === String(year) && /^\d{8}$/.test(x.date || '')) rows.push(x);
      if (list.length < 1000) break;
    }
    if (!rows.length) return fail(404, `新北市資料開放平台還沒有 ${year} 年的資料，通常前一年 6 月後公告`);
    await env.DB.prepare('DELETE FROM holidays WHERE year = ?').bind(year).run();
    for (let i = 0; i < rows.length; i += 80) await env.DB.batch(rows.slice(i, i + 80).map((x) => env.DB.prepare(
      'INSERT OR REPLACE INTO holidays (date, year, name, is_holiday, category, description) VALUES (?, ?, ?, ?, ?, ?)').bind(
      `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`, year, str(x.name, 40) || null, x.isholiday === '是' ? 1 : 0, str(x.holidaycategory, 40) || null, str(x.description, 120) || null)));
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
      ? (await env.DB.prepare(`SELECT e.id, e.title, e.date, e.gather_time, e.end_time, e.place, e.note, e.kind, s.status
          FROM signups s JOIN events e ON e.id = s.event_id WHERE s.member_id = ? AND s.status IN ('in', 'wait')
          AND e.date BETWEEN date('now', '-30 days') AND date('now', '+180 days') ORDER BY e.date LIMIT 300`).bind(who.id).all()).results
      : (await env.DB.prepare(`SELECT events.id, events.title, events.date, events.gather_time, events.end_time, events.place, events.note, events.kind,
          (SELECT s.status FROM signups s WHERE s.event_id = events.id AND s.member_id = ?1) AS status
          FROM events WHERE events.date BETWEEN date('now', '-30 days') AND date('now', '+180 days') AND ${seeSQL} ORDER BY events.date LIMIT 400`)
        .bind(who.id, 0).all()).results;   // 訂閱網址不帶幹部的檢視權限（邀請制只看得到自己受邀的）
    const items = who.cal_scope === 'mine' ? [] : (await env.DB.prepare(`SELECT id, date, title, kind, url, note FROM calendar_items
      WHERE date BETWEEN date('now', '-30 days') AND date('now', '+400 days') AND (team_id IS NULL OR team_id IN (SELECT team_id FROM team_members WHERE member_id = ? AND status = 'active'))
      ORDER BY date LIMIT 200`).bind(who.id).all()).results;
    const icsEsc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
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
        `SUMMARY:${icsEsc(`${r.status === 'wait' ? '（候補）' : r.status === 'in' ? '（已報名）' : ''}${r.title}`)}`, r.place ? `LOCATION:${icsEsc(r.place)}` : '',
        `DESCRIPTION:${icsEsc(`${r.status === 'in' ? '已報名\n' : r.status === 'wait' ? '候補中\n' : '還沒報名，點連結報名\n'}${r.note ? `${r.note}\n` : ''}${origin}/#/e/${r.id}`)}`, `URL:${origin}/#/e/${r.id}`, 'END:VEVENT'].filter(Boolean).map(fold).join('\r\n');
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
    if (rows.length) await env.DB.batch(rows.map(([k, v]) => env.DB.prepare('INSERT INTO client_metrics (day, metric, value, page, device, standalone, warm) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(today(), k, Math.round(v * (k === 'cls' ? 1000 : 1)) / (k === 'cls' ? 1000 : 1), page, device, b.standalone ? 1 : 0, b.warm ? 1 : 0)));
    return json({ ok: true });
  }
  // 速度與錯誤（管理後台總覽）：最近 N 天的 p75 與最常見的錯誤
  if (path === '/api/admin/health' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'settings') && !can(member, 'audit')) return fail(403, '只有理事長、行政人員與監事可以看');
    const days = [7, 30, 90].includes(Number(url0(req).searchParams.get('days'))) ? Number(url0(req).searchParams.get('days')) : 7;
    const from = new Date(Date.now() + 8 * 3600e3 - (days - 1) * 864e5).toISOString().slice(0, 10);
    const vals = (await env.DB.prepare('SELECT metric, value, warm, standalone FROM client_metrics WHERE day >= ? ORDER BY metric, value').bind(from).all()).results;
    const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
    const metrics = {};
    for (const k of ['ready', 'fcp', 'lcp', 'inp', 'cls', 'ttfb']) {
      const all = vals.filter((v) => v.metric === k).map((v) => v.value);
      const warm = vals.filter((v) => v.metric === k && v.warm).map((v) => v.value);
      metrics[k] = { n: all.length, p50: pct(all, 0.5), p75: pct(all, 0.75), warmP75: pct(warm, 0.75) };
    }
    const errors = (await env.DB.prepare(`SELECT message, source, line, page, device, SUM(n) AS n, MAX(last_at) AS last_at FROM client_errors WHERE day >= ?
      GROUP BY message, source, line ORDER BY n DESC LIMIT 20`).bind(from).all()).results;
    return json({ days, metrics, errors });
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
        await notify(env, [member.id], 'system', { title: '新增了一把通行金鑰', body: `${deviceLabel(req.headers.get('user-agent') || '')}。不是你的話，請到「我的 → 帳號與安全」移除並登出所有裝置。`, url: '/#/me/security' });
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
    if (r.meta.changes) await audit(env, req, member, 'passkey.remove', 'member', member.id, '');
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

  // 開啟 App：boot=1 時順便帶回首頁要用的活動與今天的訓練紀錄，少兩輪等待
  if (path === '/api/me' && method === 'GET') {
    const st = await getSettings(env, settingRows.filter((r) => ['org', 'features', 'docs', 'privacy', 'tabs'].includes(r.key)));
    const boot = !!member && url0(req).searchParams.get('boot') === '1';
    const [race, teamList, events, todayLogs] = await Promise.all([
      countdownTarget(env, member, settingRows), member ? listTeams() : [],
      boot ? listEvents(false, [today(), new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10)]) : null,
      boot ? env.DB.prepare(`SELECT id, date, week_no, plan_day, kind, plan_text, status, km, seconds, hr, rpe, feel, note, source, 0 AS comments, 0 AS unread
        FROM training_logs WHERE member_id = ? AND date = ? ORDER BY created_at`).bind(member.id, today()).all().then((r) => r.results) : null,
    ]);
    return json({ member: member ? pub(member) : null, vapid: env.VAPID_PUBLIC_KEY || null, googleLogin: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      settings: st, privacyVersion: st.privacy.version, needConsent: !!member && member.consent_version !== st.privacy.version,
      race, teams: teamList, calendarOn: !!member?.cal_token_hash, calScope: member?.cal_scope || 'all', requireMfa: !!security.require_mfa, shortcut: setting('health_shortcut') || null,
      homeSpot: member?.home_spot ? await env.DB.prepare("SELECT id, name, lat, lng FROM spots WHERE id = ? AND status = 'approved'").bind(member.home_spot).first() : null,
      ...(boot ? { boot: { events, todayLogs, today: today() } } : {}) });
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
    const name = str(b.name, 40) || member.name;
    const dist = b.dist === 'hm' ? 'hm' : 'fm';
    const grp = (str(b.grp, 2) || member.grp).toUpperCase();
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    // 所屬跑團跟著主團（由管理員設定），本人不能改
    const extra = { nickname: str(b.nickname, 20), meal_pref: str(b.meal_pref, 10), phone: str(b.phone, 20),
      home_spot: /^[\w-]{1,32}$/.test(b.home_spot || '') && await env.DB.prepare("SELECT 1 FROM spots WHERE id = ? AND status = 'approved'").bind(b.home_spot).first() ? b.home_spot : null };
    await env.DB.prepare('UPDATE members SET name = ?, dist = ?, grp = ?, nickname = ?, meal_pref = ?, phone = ?, home_spot = ? WHERE id = ?')
      .bind(name, dist, grp, extra.nickname, extra.meal_pref, extra.phone, extra.home_spot, member.id).run();
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
    return json({ events: await listEvents(past, range) });
  }

  if (path === '/api/events' && method === 'POST') {
    const g = need(); if (g) return g;
    const b = await body(), e = readEvent(b);
    if (!e) return fail(400, '活動資料不完整');
    if (e.team_id && !(await teamIds()).includes(e.team_id)) return fail(400, '找不到這個分團');
    if (!teamCan(e.team_id, 'event')) return fail(403, e.team_id ? '只有這個分團的團長與幹部可以建立活動' : '只有幹部可以建立全協會活動');
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
    // 報名截止：跟著每一場往後推（保持跟活動日的距離）
    const dl = (d) => { if (!e.deadline) return e.deadline; const shift = Date.parse(`${d}T00:00:00Z`) - Date.parse(`${e.date}T00:00:00Z`); const t = new Date(Date.parse(`${e.deadline}:00Z`) + shift); return t.toISOString().slice(0, 16); };
    const ids = dates.map(() => rid(8)), id = ids[0];
    await env.DB.batch(dates.map((d, i) => env.DB.prepare(`INSERT INTO events (id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, created_by, fee, guest_max, meal_options, link_url, link_label, team_id, questions, visibility, options, group_reg, items, pricing, pay_info, min_qty, series_id, spot_id, route_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ids[i], e.kind, e.title, d, e.gather_time, e.end_time, e.place, e.lead, e.note, i ? null : e.week_no, e.plan_text, e.capacity, e.signup_open, dl(d), member.id, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label, e.team_id, e.questions, e.visibility, e.options, e.group_reg, e.items, e.pricing, e.pay_info, e.min_qty, series, e.spot_id, e.route_id)));
    // 複製活動：沿用原活動的座位圖（獎項每年不同，不複製）
    const from = str(b.copy_from, 32);
    if (from) {
      const src = await evById(from);
      if (src && await canSee(src)) await env.DB.prepare('UPDATE events SET seat_layout = (SELECT seat_layout FROM events WHERE id = ?) WHERE id = ?').bind(from, id).run();
    }
    await audit(env, req, member, 'event.create', 'event', id, `${e.title}${e.team_id ? `（${e.team_id}）` : ''}${e.visibility === 'invite' ? '，邀請制' : ''}${from ? `，複製自 ${from}` : ''}${series ? `，定期 ${dates.length} 場` : ''}`);
    // 邀請制不廣播；之後邀請誰就通知誰
    let notified = 0;
    if (b.notify !== false && e.visibility !== 'invite') {
      const to = e.team_id ? await teamMemberIds(e.team_id, member.id) : await allMemberIds(env, member.id);
      notified = to.length;
      await notify(env, to, 'event',
        { title: `${e.kind === 'survey' ? '新問卷' : series ? '定期揪跑' : '新活動'}：${e.title}`, body: series ? `${dates[0]} 起共 ${dates.length} 場${e.gather_time ? `，${e.gather_time} 集合` : ''}　${e.place || ''}` : `${e.date}${e.gather_time ? ` ${e.gather_time}` : ''}　${e.place || ''}`, url: `/#/e/${id}` });
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
      const mine = await env.DB.prepare('SELECT answers, paid, attended_at, option, reg_consent_at, items, amount, amount_detail, pay_ref, pay_method, pay_reported_at, picked_at, paid_note, pick_code FROM signups WHERE event_id = ? AND member_id = ?').bind(id, member.id).first();
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
        arrived: arr?.arrived_at || null, pickupNote: arr?.pickup_note || null, myPickCode: arr?.arrived_at ? mine?.pick_code || null : null, cancelled: arr?.status === 'cancelled',
        items: itemDefs, pricing: parseQ(ev.pricing, null), payInfo: parseQ(ev.pay_info, null), sold, myMembership: member.membership,
        options: parseQ(ev.options), regProfile: ev.group_reg ? (regRow ? (regRow.complete ? 'ok' : 'incomplete') : 'none') : null,
        team, manage, checkin: teamCan(ev.team_id, 'checkin'), invite: inv, attendToken: attendTok,
        series: ev.series_id ? (await env.DB.prepare('SELECT id, date FROM events WHERE series_id = ? ORDER BY date LIMIT 80').bind(ev.series_id).all()).results : null,
        spot: ev.spot_id ? await env.DB.prepare("SELECT id, name, kind, lat, lng FROM spots WHERE id = ? AND status = 'approved'").bind(ev.spot_id).first() : null,
        route: ev.route_id ? await env.DB.prepare('SELECT id, name, distance, points FROM routes WHERE id = ?').bind(ev.route_id).first().then((r) => (r ? { ...r, points: parseQ(r.points) } : null)) : null });
    }
    if (method === 'PUT') {
      const e = readEvent(await body());
      if (!e) return fail(400, '活動資料不完整');
      if (e.team_id && !(await teamIds()).includes(e.team_id)) return fail(400, '找不到這個分團');
      // 原本的分團與改過去的分團都要有權限
      if (!teamCan(cur.team_id, 'event') || !teamCan(e.team_id, 'event')) return fail(403, '沒有編輯這個活動的權限');
      if (e.route_id && e.route_id !== cur.route_id && !(await env.DB.prepare('SELECT 1 FROM routes WHERE id = ? AND (shared = 1 OR created_by = ?)').bind(e.route_id, member.id).first())) return fail(400, '找不到這條路線');
      await env.DB.prepare(`UPDATE events SET kind=?, title=?, date=?, gather_time=?, end_time=?, place=?, lead=?, note=?, week_no=?, plan_text=?, capacity=?, signup_open=?, deadline=?, fee=?, guest_max=?, meal_options=?, link_url=?, link_label=?, team_id=?, questions=?, visibility=?, options=?, group_reg=?, items=?, pricing=?, pay_info=?, min_qty=?, spot_id=?, route_id=? WHERE id = ?`)
        .bind(e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label, e.team_id, e.questions, e.visibility, e.options, e.group_reg, e.items, e.pricing, e.pay_info, e.min_qty, e.spot_id, e.route_id, id).run();
      await audit(env, req, member, 'event.update', 'event', id, `${e.title}${cur.visibility !== e.visibility ? `（改為${e.visibility === 'invite' ? '邀請制' : '公開'}）` : ''}`);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      if (!teamCan(cur.team_id, 'event')) return fail(403, '沒有刪除這個活動的權限');
      // 定期揪跑：?series=after 連同之後的場次一起刪，已報名的人會收到通知
      const after = url0(req).searchParams.get('series') === 'after' && cur.series_id;
      const gone = after ? (await env.DB.prepare('SELECT id, date FROM events WHERE series_id = ? AND date >= ? AND team_id IS ?').bind(cur.series_id, cur.date, cur.team_id).all()).results : [{ id, date: cur.date }];
      const who = (await env.DB.prepare(`SELECT DISTINCT member_id FROM signups WHERE status IN ('in','wait') AND event_id IN (${gone.map(() => '?').join(',')})`).bind(...gone.map((g) => g.id)).all()).results.map((r) => r.member_id).filter((x) => x !== member.id);
      await env.DB.batch(gone.map((g) => env.DB.prepare('DELETE FROM events WHERE id = ?').bind(g.id)));
      if (who.length) await notify(env, who, 'event', { title: `活動取消：${cur.title}`, body: gone.length > 1 ? `${gone[0].date} 起 ${gone.length} 場取消` : `${cur.date} 這場取消`, url: '/#/' });
      await audit(env, req, member, 'event.delete', 'event', id, `${cur.title}${gone.length > 1 ? `（連同之後 ${gone.length} 場）` : ''}`);
      return json({ ok: true, count: gone.length });
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

  // ---- 賽事報名資料（本人）----
  if (path === '/api/me/race-profile') {
    const g = need(); if (g) return g;
    if (!env.RACE_KEY) return fail(503, '賽事報名資料功能還沒啟用，請聯絡行政人員');
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT enc, complete, updated_at FROM member_private WHERE member_id = ?').bind(member.id).first();
      return json({ fields: Object.fromEntries(Object.entries(RACE_FIELDS).map(([k, [label, max, req]]) => [k, { label, max, req }])),
        profile: row ? await openPrivate(env, row.enc, member.id) : null, complete: !!row?.complete, updated_at: row?.updated_at || null });
    }
    if (method === 'PUT') {
      const b = await body(), p = {};
      for (const [k, [, max]] of Object.entries(RACE_FIELDS)) p[k] = str(b[k], max);
      p.id_no = p.id_no.toUpperCase().replace(/\s/g, '');
      if (p.birthday && !isDate(p.birthday)) return fail(400, '生日格式不正確');
      if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return fail(400, 'Email 格式不正確');
      if (p.id_no && !/^[A-Z][12A-D89]\d{8}$/.test(p.id_no) && !/^[A-Z0-9]{6,12}$/.test(p.id_no)) return fail(400, '身分證字號或護照號碼格式不正確');
      if (p.gender && !['男', '女', '其他'].includes(p.gender)) return fail(400, '性別請選 男、女 或 其他');
      const complete = Object.entries(RACE_FIELDS).every(([k, [, , req]]) => !req || p[k]) ? 1 : 0;
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
    const keys = Object.keys(RACE_FIELDS);
    const head = ['報名組別', ...keys.map((k) => RACE_FIELDS[k][0]), '繳費', '報名時間'];
    const PAID = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
    const lines = [];
    for (const r of rows) { const p = await openPrivate(env, r.enc, r.member_id); lines.push([r.option || '', ...keys.map((k) => p[k] || ''), PAID[r.paid] || '', r.created_at].map(cell).join(',')); }
    await audit(env, req, member, 'event.reg_export', 'event', ev.id, `${rows.length} 筆（含身分證字號）`);
    return new Response(`﻿${[head.map(cell).join(','), ...lines].join('\r\n')}`, { headers: { ...SEC_HEADERS, 'cache-control': 'no-store',
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="registrations.csv"; filename*=UTF-8''${encodeURIComponent(`${ev.date}-${ev.title}-團體報名.csv`)}` } });
  }
  // ---- 活動營運：繳費、點名、自助報到、整批匯入 ----
  const mops = path.match(/^\/api\/events\/([\w-]{1,32})\/(payments|attendance|attend|attend-token|bulk|pay-report|pickup|arrived|notice|reconcile)$/);
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
    // 團員回報已繳費（轉帳後五碼或現金），等幹部確認；不串金流
    if (op === 'pay-report') {
      const mine = await env.DB.prepare("SELECT id, amount, paid FROM signups WHERE event_id = ? AND member_id = ? AND status = 'in'").bind(ev.id, member.id).first();
      if (!mine) return fail(400, '你還沒有報名這個活動');
      if (!mine.amount) return fail(400, '這筆報名不用繳費');
      if (mine.paid === 'paid') return fail(400, '幹部已經確認收款了');
      if (b.cancel === true) {
        await env.DB.prepare('UPDATE signups SET pay_ref = NULL, pay_method = NULL, pay_reported_at = NULL WHERE id = ?').bind(mine.id).run();
        return json({ ok: true });
      }
      const method = PAY_METHODS[b.method] ? b.method : 'transfer';
      const ref = str(b.ref, 20).replace(/\s/g, '');
      if (method === 'transfer' && !/^\d{4,6}$/.test(ref)) return fail(400, '請填轉帳帳號的後五碼');
      await env.DB.prepare("UPDATE signups SET pay_ref = ?, pay_method = ?, pay_reported_at = datetime('now') WHERE id = ?").bind(ref || null, method, mine.id).run();
      const mgr = new Set([ev.created_by, ...(ev.team_id ? (await env.DB.prepare("SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active' AND role IN ('lead','officer')").bind(ev.team_id).all()).results.map((r) => r.member_id) : [])]);
      mgr.delete(member.id);
      await notify(env, [...mgr].filter(Boolean), 'event', { title: `${ev.title}：有人回報繳費`, body: `${member.name} ${PAY_METHODS[method]} ${mine.amount} 元${ref ? `，後五碼 ${ref}` : ''}，請確認收款`, url: `/#/e/${ev.id}/stats` });
      return json({ ok: true });
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
    // 團購到貨：通知訂購的人來領，每個人一個領取 QR
    if (op === 'arrived') {
      const note = str(b.note, 120);
      const rows = (await env.DB.prepare("SELECT id, member_id, pick_code FROM signups WHERE event_id = ? AND status = 'in' AND items IS NOT NULL").bind(ev.id).all()).results;
      for (const r of rows) if (!r.pick_code) await env.DB.prepare('UPDATE signups SET pick_code = ? WHERE id = ?').bind(ticketCode(), r.id).run();
      await env.DB.prepare("UPDATE events SET arrived_at = COALESCE(arrived_at, datetime('now')), pickup_note = ? WHERE id = ?").bind(note || null, ev.id).run();
      const ids = rows.map((r) => r.member_id).filter(Boolean);
      if (ids.length) await notify(env, ids, 'event', { title: `到貨了：${ev.title}`, body: `${note || '請到活動頁看領取方式'}。領取時出示 App 裡的領取 QR。`, url: `/#/e/${ev.id}`, tag: `arrived-${ev.id}` });
      await audit(env, req, member, 'event.arrived', 'event', ev.id, `${ids.length} 人`);
      return json({ ok: true, count: ids.length });
    }
    // 活動異動：取消、改地點、改時間或其他，通知所有報名（含候補）的人
    if (op === 'notice') {
      const type = ['cancel', 'place', 'time', 'other'].includes(b.type) ? b.type : 'other', msg = str(b.message, 300);
      const place = str(b.place, 120), time = isTime(str(b.gather_time, 5)) && str(b.gather_time, 5) ? str(b.gather_time, 5) : '';
      if (type === 'place' && !place) return fail(400, '請填新的地點');
      if (type === 'time' && !time) return fail(400, '請填新的集合時間');
      if (type === 'other' && !msg) return fail(400, '請填異動內容');
      if (type === 'cancel') await env.DB.prepare("UPDATE events SET status = 'cancelled', signup_open = 0 WHERE id = ?").bind(ev.id).run();
      if (type === 'place') await env.DB.prepare('UPDATE events SET place = ?, spot_id = ? WHERE id = ?').bind(place, /^[\w-]{1,32}$/.test(b.spot_id || '') ? b.spot_id : null, ev.id).run();
      if (type === 'time') await env.DB.prepare('UPDATE events SET gather_time = ?, remind_hour_at = NULL WHERE id = ?').bind(time, ev.id).run();
      const ids = (await env.DB.prepare("SELECT member_id FROM signups WHERE event_id = ? AND status IN ('in', 'wait') AND member_id IS NOT NULL").bind(ev.id).all()).results.map((r) => r.member_id).filter((x) => x !== member.id);
      const TITLE = { cancel: '活動取消', place: '改地點', time: '改時間', other: '活動異動' };
      const body2 = type === 'cancel' ? `${ev.date} 這場取消${msg ? `：${msg}` : ''}` : type === 'place' ? `改到 ${place}${msg ? `。${msg}` : ''}` : type === 'time' ? `改成 ${time} 集合${msg ? `。${msg}` : ''}` : msg;
      if (ids.length) await notify(env, ids, 'event', { title: `${TITLE[type]}：${ev.title}`, body: body2, url: `/#/e/${ev.id}`, tag: `notice-${ev.id}` });
      await audit(env, req, member, 'event.notice', 'event', ev.id, `${TITLE[type]}：${body2}`.slice(0, 200));
      return json({ ok: true, count: ids.length });
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
        await env.DB.batch(matched.map((m) => env.DB.prepare("UPDATE signups SET paid = 'paid', paid_at = datetime('now'), paid_note = ? WHERE event_id = ? AND member_id = ?").bind(`對帳 ${m.date || today()}`, ev.id, m.member_id)));
        await audit(env, req, member, 'event.reconcile', 'event', ev.id, `對上 ${matched.length} 筆`);
      }
      return json({ matched, unmatchedRows: rows.filter((_, k) => !used.has(k)).length, unpaid: due.filter((d) => !matched.some((m) => m.member_id === d.member_id)).map((d) => ({ name: d.name, amount: d.amount, pay_ref: d.pay_ref })) });
    }
    // 團購到貨：記錄誰已經領取（點名或掃領取 QR）
    if (op === 'pickup') {
      if (b.code) {
        const r = await env.DB.prepare("SELECT member_id, name, items, picked_at FROM signups WHERE event_id = ? AND pick_code = ?").bind(ev.id, str(b.code, 12).toUpperCase()).first();
        if (!r) return fail(404, '找不到這個領取碼');
        if (!r.picked_at) await env.DB.prepare("UPDATE signups SET picked_at = datetime('now') WHERE event_id = ? AND member_id = ?").bind(ev.id, r.member_id).run();
        return json({ ok: true, name: r.name, already: !!r.picked_at, items: parseQ(r.items) });
      }
      const mid = str(b.member_id, 32);
      await env.DB.prepare(`UPDATE signups SET picked_at = ${b.picked === false ? 'NULL' : "COALESCE(picked_at, datetime('now'))"} WHERE event_id = ? AND member_id = ?`).bind(ev.id, mid).run();
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
      profile: (({ s_seen, s_role, s_created, s_mfa, s_th, s_teams, line_id, google_sub, cal_token_hash, ...rest }) => ({ ...rest, google_linked: !!google_sub, calendar_feed: !!cal_token_hash }))(member),
      signups: await q('SELECT event_id, name, grp, dist, note, status, answers, option, reg_consent_at, items, amount, pay_method, pay_ref, pay_reported_at, paid, picked_at, attended_at, created_at FROM signups WHERE member_id = ?'),
      teams: await q('SELECT team_id, role, title, status, created_at FROM team_members WHERE member_id = ?'),
      race_profile: await (async () => { const r = await env.DB.prepare('SELECT enc FROM member_private WHERE member_id = ?').bind(member.id).first(); return r ? openPrivate(env, r.enc, member.id).catch(() => null) : null; })(),
      tickets: await q('SELECT event_id, code, guests, meal, table_no, checked_in_at FROM tickets WHERE member_id = ?'),
      prizes: await q('SELECT event_id, prize_id, created_at, claimed_at FROM draws WHERE member_id = ?'),
      notifications: await q('SELECT kind, title, body, created_at, read_at FROM notifications WHERE member_id = ?'),
      sessions: await q('SELECT created_at, last_seen_at, ua FROM sessions WHERE member_id = ?'),
      races: await q('SELECT name, date, dist, goal, is_primary FROM races WHERE member_id = ?'),
      training_logs: await q('SELECT date, week_no, plan_day, plan_text, status, km, seconds, hr, rpe, feel, note, source FROM training_logs WHERE member_id = ? ORDER BY date'),
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
    // 得獎紀錄要留給協會對帳，所以只匿名化，不刪除
    await env.DB.batch([
      env.DB.prepare("UPDATE draws SET name = '已刪除帳號', member_id = NULL WHERE member_id = ?").bind(member.id),
      env.DB.prepare('DELETE FROM member_private WHERE member_id = ?').bind(member.id),
      env.DB.prepare('UPDATE events SET created_by = NULL WHERE created_by = ?').bind(member.id),
      env.DB.prepare('UPDATE plan_posts SET author_id = NULL WHERE author_id = ?').bind(member.id),
      env.DB.prepare("UPDATE log_comments SET author_name = '已刪除帳號' WHERE author_id = ?").bind(member.id),
      env.DB.prepare("UPDATE team_posts SET author_name = '已刪除帳號' WHERE author_id = ?").bind(member.id),
      env.DB.prepare('DELETE FROM routes WHERE created_by = ?').bind(member.id),
      env.DB.prepare('DELETE FROM spot_reports WHERE member_id = ?').bind(member.id),
      env.DB.prepare('UPDATE spots SET created_by = NULL WHERE created_by = ?').bind(member.id),
      env.DB.prepare('UPDATE calendar_items SET created_by = NULL WHERE created_by = ?').bind(member.id),
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

  const mset = path.match(/^\/api\/settings\/(org|features|docs|privacy|tabs)$/);
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
      for (const f of ['gps', 'studio', 'health', 'file', 'coach', 'party']) value[f] = b[f] !== false;
    } else if (key === 'tabs') {
      // 下方分頁列的名稱（每個最多 4 個字，空白就用預設）
      value = {};
      for (const k of ['home', 'plan', 'studio', 'coach', 'me']) { const v = str(b[k], 4); if (v) value[k] = v; }
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
  const LOG_SOURCES = ['manual', 'health', 'file', 'gps'];
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
       FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.member_id = ? AND e.date >= ? ORDER BY e.date`)
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
    const dr = await env.DB.prepare('SELECT event_id FROM draws WHERE id = ?').bind(mdd[1]).first();
    if (!dr || !teamCan((await evById(dr.event_id))?.team_id, 'lottery')) return fail(403, '只有幹部可以重抽');
    await env.DB.prepare('DELETE FROM draws WHERE id = ?').bind(mdd[1]).run();
    await audit(env, req, member, 'lottery.undo', 'draw', mdd[1], '');
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
    const rows = (await env.DB.prepare(
      `SELECT s.member_id, s.name, s.grp, s.dist, s.note, s.status, s.answers, s.created_at, s.paid, s.paid_note, s.attended_at, s.option, s.reg_consent_at,
              s.items, s.amount, s.pay_ref, s.pay_method, s.pay_reported_at, s.picked_at,
              m.nickname, m.club, m.phone, m.membership,
              t.guests, t.meal, t.table_no, t.checked_in_at,
              (SELECT group_concat(tm.team_id) FROM team_members tm WHERE tm.member_id = s.member_id AND tm.status = 'active') AS teams
       FROM signups s LEFT JOIN members m ON m.id = s.member_id
       LEFT JOIN tickets t ON t.event_id = s.event_id AND t.member_id = s.member_id
       WHERE s.event_id = ? ORDER BY s.created_at`).bind(ev.id).all()).results;
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
      const STATUS = { in: '正取', wait: '候補', cancel: '已取消' };
      const PAID = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
      const head = ['報名時間', '狀態', '姓名', '暱稱', '分團', '跑團', '項目', '組別', ...(ev.options ? ['報名組別'] : []), ...(fullPhone ? ['電話'] : []), ...(ev.fee || ev.options ? ['繳費', '繳費備註'] : []), '出席',
        ...(ev.kind === 'party' ? ['攜伴', '餐點', '桌次', '報到時間'] : []), ...qs.map((q) => q.label), '備註'];
      const lines = rows.map((r) => { const a = ans(r); return [r.created_at, STATUS[r.status] || r.status, r.name, r.nickname,
        (r.teams || '').split(',').filter(Boolean).map((t) => teamName[t] || t).join('、'), r.club, r.dist === 'hm' ? '半馬' : '全馬', r.grp,
        ...(ev.options ? [r.option || ''] : []), ...(fullPhone ? [r.phone] : []), ...(ev.fee || ev.options ? [PAID[r.paid] || '', r.paid_note] : []), r.attended_at || r.checked_in_at || '',
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
      people: live.map((r) => ({ member_id: r.member_id, name: r.name, nickname: r.nickname, status: r.status, guests: r.guests || 0, option: r.option || null, regOk: !!r.reg_consent_at,
        amount: r.amount, items: parseQ(r.items), payRef: r.pay_ref, payMethod: r.pay_method, payReported: r.pay_reported_at, picked: !!r.picked_at,
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
  // 待審核的入團申請：列出我有權核准的所有分團（管理後台集中處理）
  if (path === '/api/teams/pending' && method === 'GET') {
    const g = need(); if (g) return g;
    const rows = (await env.DB.prepare(`SELECT tm.team_id, tm.created_at, m.id, m.name, m.nickname, m.avatar, m.dist, m.grp, m.main_team, t.name AS team_name, t.self_managed
      FROM team_members tm JOIN members m ON m.id = tm.member_id JOIN teams t ON t.id = tm.team_id
      WHERE tm.status = 'pending' ORDER BY tm.created_at LIMIT 200`).all()).results;
    const out = [];
    for (const r of rows) if (r.self_managed ? teamOwn(r.team_id, 'approve') : teamCan(r.team_id, 'approve')) out.push(r);
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
      let mgr = (await env.DB.prepare("SELECT member_id FROM team_members WHERE team_id = ? AND role IN ('lead','officer') AND status = 'active'").bind(tid).all()).results.map((r) => r.member_id);
      // 分團還沒有團長或幹部：改通知協會管理員（一般分團可以直接核准；本團自己管理的分團請理事長先指派團長）
      if (!mgr.length) mgr = (await env.DB.prepare("SELECT id FROM members WHERE role IN ('chair', 'staff')").all()).results.map((r) => r.id);
      await notify(env, mgr, 'system', { title: `${team.name}：有人申請加入`, body: `${member.name} 想加入${team.name}，請到管理後台核准`, url: '/#/admin?tab=teams' });
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
        await audit(env, req, member, 'team.add', 'member', mid, `${team.name}／${TEAM_ROLES[role]}`);
        await notify(env, [mid], 'system', { title: `你已加入${team.name}`, body: team.line_url ? '記得也加入分團的 LINE 群組' : '', url: `/#/t/${tid}` });
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
        await notify(env, [mid], 'system', { title: `${team.name}：申請通過`, body: team.line_url ? '歡迎加入！記得也加入分團的 LINE 群組' : '歡迎加入！', url: `/#/t/${tid}` });
        return json({ ok: true });
      }
      if (action === 'remove') {
        if (!(await canManageMembers(tid, target.role === 'member' ? 'approve' : 'appoint'))) return fail(403, '沒有移除的權限');
        await env.DB.prepare('DELETE FROM team_members WHERE team_id = ? AND member_id = ?').bind(tid, mid).run();
        await audit(env, req, member, target.status === 'pending' ? 'team.reject' : 'team.remove', 'member', mid, team.name);
        return json({ ok: true });
      }
      if (action === 'role') {
        if (role === 'lead' ? !can(member, 'roles') : !(await canManageMembers(tid, 'appoint'))) return fail(403, role === 'lead' ? '團長只能由理事長指派' : '只有團長可以指派幹部');
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
    const locked = (await env.DB.prepare(`SELECT m.id, m.main_team FROM members m JOIN teams t ON t.id = m.main_team
      WHERE t.self_managed = 1 AND m.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results.filter((r) => !teamOwn(r.main_team, 'approve'));
    if (locked.length) return fail(403, `有 ${locked.length} 位的主團只能由該團幹部調整`);
    const stmts = [];
    for (const mid of ids) {
      stmts.push(env.DB.prepare('UPDATE members SET main_team = ?, club = (SELECT name FROM teams WHERE id = ?) WHERE id = ?').bind(tid, tid, mid));
      // 一般團員只屬於主團；擔任團長或幹部的分團保留
      stmts.push(env.DB.prepare("DELETE FROM team_members WHERE member_id = ? AND role = 'member' AND (? IS NULL OR team_id != ?)").bind(mid, tid, tid));
      if (tid) stmts.push(env.DB.prepare(`INSERT INTO team_members (team_id, member_id, role, status) VALUES (?, ?, 'member', 'active')
        ON CONFLICT(team_id, member_id) DO UPDATE SET status = 'active'`).bind(tid, mid));
    }
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    const tname = tid ? (await env.DB.prepare('SELECT name FROM teams WHERE id = ?').bind(tid).first())?.name : '未設定';
    await audit(env, req, member, 'team.main', 'members', ids.length === 1 ? ids[0] : null, `${ids.length} 人 → ${tname}`);
    if (tid) await notify(env, ids, 'system', { title: `你的主團：${tname}`, body: '分團的活動與公告會通知你', url: `/#/t/${tid}` });
    return json({ ok: true, count: ids.length });
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
    await audit(env, req, member, 'role.handover', 'member', target.id, `理事長移交給 ${target.name}；原理事長改為${ROLES[myRole]}`);
    await notify(env, [target.id], 'system', { title: '你已成為理事長', body: `${member.name} 把理事長移交給你，請重新登入後到管理後台確認幹部名單`, url: '/#/admin' });
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

// 會費到期：到期前 30 天、7 天、到期當天各提醒本人一次（同一個到期日的同一階段只提醒一次）
async function remindRenewals(env, now) {
  const until = tpDate(new Date(now.getTime() + 30 * 864e5)), today0 = tpDate(now);
  const rows = (await env.DB.prepare(`SELECT id, paid_until, renew_notice FROM members WHERE membership = 'active' AND paid_until IS NOT NULL
    AND paid_until BETWEEN ? AND ? LIMIT 1000`).bind(today0, until).all()).results;
  let n = 0;
  for (const r of rows) {
    const days = Math.round((Date.parse(`${r.paid_until}T00:00:00Z`) - Date.parse(`${today0}T00:00:00Z`)) / 864e5);
    const stage = days <= 0 ? 0 : days <= 7 ? 7 : 30, key = `${r.paid_until}:${stage}`;
    if (r.renew_notice === key) continue;
    await notify(env, [r.id], 'system', { title: stage === 0 ? '會費今天到期' : `會費 ${days} 天後到期`, body: `你的協會會費繳至 ${r.paid_until}，續繳後會籍卡就會更新`, url: '/#/me/card' });
    await env.DB.prepare('UPDATE members SET renew_notice = ? WHERE id = ?').bind(key, r.id).run();
    n++;
  }
  return n;
}

// 壞天氣提醒：前一晚 20:00，明天有指定地點的活動，集合時間預報「不建議」、大雨或空氣不佳，通知報名的人與主辦幹部
async function weatherAlerts(env, now) {
  if (taipei(now).getUTCHours() !== 20) return 0;
  const tomorrow = tpDate(new Date(now.getTime() + 864e5));
  const evs = (await env.DB.prepare(`SELECT e.id, e.title, e.gather_time, e.team_id, e.created_by, s.name AS spot, s.lat, s.lng FROM events e JOIN spots s ON s.id = e.spot_id
    WHERE e.date = ? AND e.status = 'open' AND e.kind != 'survey' AND e.wx_alert_at IS NULL`).bind(tomorrow).all()).results;
  let sent = 0;
  for (const ev of evs) {
    await env.DB.prepare("UPDATE events SET wx_alert_at = datetime('now') WHERE id = ?").bind(ev.id).run();
    const w = await getWeather(env, ev.lat, ev.lng);
    if (!w) continue;
    const hh = /^\d{2}:\d{2}$/.test(ev.gather_time || '') ? ev.gather_time.slice(0, 2) : '07';
    const x = hourOf(JSON.parse(w.body), `${tomorrow}T${hh}:00`);
    if (!x || !(x.advice.level === 'poor' || (x.rain >= 70 && x.mm >= 2) || x.aqi >= 101)) continue;
    const why = x.advice.why.join('；');
    const ids = await signedIds(env, ev.id);
    if (ids.length) await notify(env, ids, 'event', { title: `明天${x.advice.level === 'poor' ? '天氣不佳' : '天氣提醒'}：${ev.title}`, body: `${hh}:00 ${ev.spot}：${x.text}，體感 ${Math.round(x.feel)}°。${why}。有異動幹部會再通知。`, url: `/#/e/${ev.id}`, tag: `wx-${ev.id}` });
    if (x.advice.level === 'poor') {
      const mgr = [...new Set([ev.created_by, ...(ev.team_id ? (await env.DB.prepare("SELECT member_id FROM team_members WHERE team_id = ? AND status = 'active' AND role IN ('lead','officer')").bind(ev.team_id).all()).results.map((r) => r.member_id) : [])])].filter(Boolean);
      if (mgr.length) await notify(env, mgr, 'event', { title: `要不要調整：${ev.title}`, body: `明天 ${hh}:00 預報不建議跑步（${why}）。可以在活動頁「發布異動」通知大家。`, url: `/#/e/${ev.id}`, tag: `wxm-${ev.id}` });
    }
    sent += ids.length;
  }
  return sent;
}

// 跑完接續：團練結束 15 分鐘後，提醒有報名的人記錄今天的訓練（帶入課表），記完可以直接拍照分享
async function runFollowups(env, now) {
  const today0 = tpDate(now), t = taipei(now), nowMin = t.getUTCHours() * 60 + t.getUTCMinutes();
  const evs = (await env.DB.prepare(`SELECT id, title, gather_time, end_time FROM events WHERE date = ? AND status = 'open' AND kind IN ('track', 'core', 'long', 'race', 'other')
    AND followup_at IS NULL AND gather_time IS NOT NULL AND gather_time != ''`).bind(today0).all()).results;
  let sent = 0;
  for (const ev of evs) {
    const [gh, gm] = ev.gather_time.split(':').map(Number);
    const end = /^\d{2}:\d{2}$/.test(ev.end_time || '') && ev.end_time > ev.gather_time ? ev.end_time.split(':').map(Number).reduce((h, m) => h * 60 + m) : gh * 60 + gm + 120;
    if (nowMin < end + 15) continue;
    await env.DB.prepare("UPDATE events SET followup_at = datetime('now') WHERE id = ?").bind(ev.id).run();
    const ids = await signedIds(env, ev.id);
    if (!ids.length) continue;
    await notify(env, ids, 'event', { title: '跑完了嗎？', body: `記錄今天「${ev.title}」的訓練，再拍張照分享`, url: `/#/log?event=${ev.id}`, tag: `fu-${ev.id}` });
    sent += ids.length;
  }
  return sent;
}

// 每月 1 號 09:00：上個月的里程挑戰總結（個人里程與徽章、分團平均第一名），只通知上個月有紀錄的人
async function monthSummary(env, now) {
  const t = taipei(now);
  if (t.getUTCDate() !== 1 || t.getUTCHours() !== 9) return 0;
  const prev = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  if (!(await onceOn(env, 'month_summary', prev))) return 0;
  const logs = (await env.DB.prepare("SELECT member_id, date, km FROM training_logs WHERE date BETWEEN ? AND ? AND status != 'skip'").bind(`${prev}-01`, `${prev}-31`).all()).results;
  const by = {};
  for (const l of logs) (by[l.member_id] ||= []).push(l);
  const teams = (await env.DB.prepare(`SELECT t.name, COUNT(DISTINCT tm.member_id) AS members, COALESCE(SUM(l.km), 0) AS km FROM teams t
    JOIN team_members tm ON tm.team_id = t.id AND tm.status = 'active' LEFT JOIN training_logs l ON l.member_id = tm.member_id AND l.date BETWEEN ? AND ? AND l.status != 'skip'
    WHERE t.private = 0 GROUP BY t.id`).bind(`${prev}-01`, `${prev}-31`).all()).results.filter((x) => x.members).sort((a, b) => b.km / b.members - a.km / a.members);
  const champ = teams[0] && teams[0].km > 0 ? `分團平均第一：${teams[0].name}（每人 ${(teams[0].km / teams[0].members).toFixed(1)} 公里）` : '';
  let n = 0;
  for (const [mid, list] of Object.entries(by)) {
    const km = list.reduce((s0, l) => s0 + (l.km || 0), 0), stat = { km, runs: list.length, weeks: weeksOf(prev, list.map((l) => l.date)) };
    const got = earned(stat).map((id) => BADGES.find((b) => b.id === id).name);
    await notify(env, [mid], 'system', { title: `${Number(prev.slice(5))} 月跑了 ${km.toFixed(1)} 公里`, body: `${list.length} 次訓練${got.length ? `，獲得徽章：${got.join('、')}` : ''}。${champ}`, url: `/#/challenge?m=${prev}` });
    n++;
  }
  return n;
}

// 備份存放：有綁 R2（BACKUP）就存 R2，否則存 Workers KV（BACKUP_KV）；兩邊格式一樣
const backupStore = (env) => (env.BACKUP ? {
  put: (k, v, meta) => env.BACKUP.put(k, v, { customMetadata: meta }),
  list: async () => (await env.BACKUP.list({ prefix: 'daily/', include: ['customMetadata'] })).objects.map((o) => ({ key: o.key, size: o.size, at: o.uploaded, ...o.customMetadata })),
  del: (k) => env.BACKUP.delete(k), kind: 'R2',
} : env.BACKUP_KV ? {
  put: (k, v, meta) => env.BACKUP_KV.put(k, v, { metadata: { ...meta, size: v.length, at: new Date().toISOString() } }),
  list: async () => (await env.BACKUP_KV.list({ prefix: 'daily/' })).keys.map((o) => ({ key: o.name, ...o.metadata })),
  del: (k) => env.BACKUP_KV.delete(k), kind: 'KV',
} : null);
// 每天 03:00：資料庫加密備份（保留 35 天）。格式：CILB1＋IV＋AES-GCM(gzip(JSON))，還原見 tools/restore-backup.mjs
async function dailyBackup(env, now) {
  if (!backupStore(env) || !env.BACKUP_KEY || taipei(now).getUTCHours() !== 3 || !(await onceOn(env, 'backup', tpDate(now)))) return null;
  return runBackup(env, tpDate(now));
}
async function runBackup(env, label) {
  const skip = ['sessions', 'rate_limits', 'webauthn_challenges', 'd1_migrations'];
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results.map((r) => r.name).filter((n) => !skip.includes(n));
  const data = { format: 'cil-backup', version: 1, at: new Date().toISOString(), tables: {} };
  let rows = 0;
  for (const tb of tables) {
    const out = [];
    for (let off = 0; ; off += 1000) {
      const r = (await env.DB.prepare(`SELECT * FROM "${tb.replace(/"/g, '')}" LIMIT 1000 OFFSET ${off}`).all()).results;
      out.push(...r);
      if (r.length < 1000) break;
    }
    data.tables[tb] = out; rows += out.length;
  }
  const gz = await new Response(new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const key = await crypto.subtle.importKey('raw', WebAuthn.unb64u(env.BACKUP_KEY.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('cil-backup-v1') }, key, gz));
  const blob = new Uint8Array(5 + 12 + ct.length);
  blob.set(new TextEncoder().encode('CILB1'), 0); blob.set(iv, 5); blob.set(ct, 17);
  const store = backupStore(env);
  await store.put(`daily/${label}.bin`, blob, { tables: String(tables.length), rows: String(rows) });
  const cut = `daily/${tpDate(new Date(Date.now() - 35 * 864e5))}`;
  for (const o of await store.list()) if (o.key < cut) await store.del(o.key);
  await audit(env, null, null, 'backup.daily', 'system', label, `${tables.length} 張表 ${rows} 筆，${blob.length} bytes`);
  return { label, tables: tables.length, rows, bytes: blob.length };
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
  await run('client_metrics', "DELETE FROM client_metrics WHERE day < date('now', '-90 days')");
  await run('client_errors', "DELETE FROM client_errors WHERE day < date('now', '-90 days')");
  await run('spot_reports', "DELETE FROM spot_reports WHERE created_at < datetime('now', '-90 days')");
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
  for (const [k, fn] of [['events', remindEvents], ['weather', weatherAlerts], ['followups', runFollowups], ['renewals', remindRenewals], ['monthSummary', monthSummary],
    ['review', quarterlyReview], ['retention', retention], ['fatigue', fatigueCheck], ['auditDigest', auditDigest], ['backup', dailyBackup]]) {
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
    // 資安金鑰沒設定就不提供 API（避免用預設值雜湊 IP、稽核紀錄沒有簽章）
    if ((!env.HASH_SALT || !env.AUDIT_KEY) && !['localhost', '127.0.0.1'].includes(url.hostname)) return new Response(JSON.stringify({ error: '系統設定不完整，請聯絡管理員' }), { status: 503, headers: { 'content-type': 'application/json' } });
    env.ctx = ctx;
    // Google 登入是瀏覽器導向（GET、不是 JSON），走在下面的 CSRF 檢查之前
    if (path === '/api/google/start' && req.method === 'GET') return googleStart(env, url, url.searchParams.get('link') === '1' ? await currentMember(req, env) : null);
    if (path === '/api/google/callback' && req.method === 'GET') return googleCallback(req, env, url);
    // 開發用：手動觸發排程，可指定時間 ?at=2026-10-03T12:00:00Z（只有 DEV_LOGIN=1 的本機有效）
    if (path === '/api/dev/cron' && env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      env.defer = (p) => ctx.waitUntil(Promise.resolve(p).catch(() => {}));
      return json(await scheduled(env, url.searchParams.get('at') ? new Date(url.searchParams.get('at')) : new Date()));
    }
    // 開發用登入：只有 .dev.vars 設 DEV_LOGIN=1 而且在 localhost 才有效，正式環境不會有這個設定
    if (path === '/api/dev/login' && req.method === 'GET' && env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
      const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(str(url.searchParams.get('id'), 32)).first();
      if (!m) return fail(404, '找不到這個帳號');
      return new Response(null, { status: 302, headers: { location: '/#/', 'set-cookie': await startSession(env, m, req, { mfa: url.searchParams.get('mfa') === '1' }) } });
    }
    env.ctx = ctx;
    env.defer = (p) => ctx.waitUntil(Promise.resolve(p).catch((e) => console.error('defer', e)));
    // 擋 CSRF：寫入類請求只收同源的 JSON
    if (req.method !== 'GET') {
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) return fail(403, '來源不正確');
      if (req.headers.get('sec-fetch-site') === 'cross-site') return fail(403, '來源不正確');
      if ((req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json' && req.method !== 'DELETE') return fail(415, '請用 JSON');
    }
    try {
      return await api(req, env, path, req.method);
    } catch (e) {
      console.error('api', path, e);
      return fail(500, '伺服器錯誤');
    }
  },
};
