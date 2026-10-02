// 耕跑團 Cultivation in Life Run — API（Cloudflare Worker ＋ D1）
// 資安設計對應 ISO/IEC 27001:2022 附錄 A（詳見 docs/SECURITY.md）：
//   A.5.15／A.5.18 存取控制：最小權限，特權身分只能由理事長指派，不能靠共用代碼取得
//   A.8.2 特權存取：幹部的工作階段閒置 8 小時、絕對 7 天就失效；身分變更後舊工作階段立即作廢
//   A.8.5 安全鑑別：LINE OIDC（state＋nonce 驗證）；邀請碼與報到代碼有嘗試次數限制
//   A.8.15 日誌：特權操作寫入 audit_log，監事可查
//   A.5.34 個資：最小蒐集、電話遮罩、IP 只存雜湊、本人可匯出與刪除
// 工作階段權杖放 HttpOnly cookie，D1 只存 SHA-256；寫入類 API 只接受同源 JSON（擋 CSRF）。
import { subscribe, unsubscribe, push, validEndpoint } from './push.js';

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
const KINDS = ['track', 'core', 'long', 'race', 'party', 'other'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => !s || /^\d{2}:\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);

function validGroup(dist, grp) {
  return dist === 'hm' ? HM.includes(grp) : FM.includes(grp);
}

// ---- 工作階段 ----
const tokenOf = (req) => (req.headers.get('cookie') || '').match(new RegExp(`${COOKIE}=([\\w]+)`))?.[1];
const ipHash = async (req, env) => (await sha(`${req.headers.get('cf-connecting-ip') || 'local'}|${env.HASH_SALT || 'cil'}`)).slice(0, 16);

async function currentMember(req, env) {
  const token = tokenOf(req);
  if (!token) return null;
  const th = await sha(token);
  const row = await env.DB.prepare(
    `SELECT m.*, s.last_seen_at AS s_seen, s.role_at_issue AS s_role, s.created_at AS s_created
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

async function startSession(env, member, req) {
  const token = rid(24), pol = policyOf(member.role);
  await env.DB.prepare(`INSERT INTO sessions (token_hash, member_id, expires_at, last_seen_at, role_at_issue, ip_hash, ua)
    VALUES (?, ?, datetime('now', '+${pol.absDays} days'), datetime('now'), ?, ?, ?)`)
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
async function audit(env, req, actor, action, targetType, targetId, detail) {
  try {
    await env.DB.prepare(`INSERT INTO audit_log (id, actor_id, actor_name, actor_role, action, target_type, target_id, detail, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(rid(10), actor?.id || null, actor?.name || null, actor ? norm(actor.role) : null, action,
            targetType || null, targetId || null, str(detail, 300) || null, await ipHash(req, env)).run();
  } catch (e) { console.error('audit', e); }
}
// LINE 大頭貼只接受 LINE 自己的圖床
const safeAvatar = (u) => (/^https:\/\/(profile|obs)\.line-scdn\.net\//.test(u || '') ? u.slice(0, 300) : null);

// 角色：參考人民團體的組織分層。chair 理事長｜director 理事｜supervisor 監事｜staff 行政人員｜coach 教練｜member 團員
export const ROLES = { chair: '理事長', director: '理事', supervisor: '監事', staff: '行政人員', coach: '教練', member: '團員' };
const norm = (r) => (r === 'admin' ? 'staff' : ROLES[r] ? r : 'member');   // 相容舊的 admin
// 權限：活動（建立與編輯）、課表（發布）、報到、抽獎、名冊、角色指派
const PERMS = {
  chair:      ['event', 'plan', 'checkin', 'lottery', 'roster', 'roles', 'members', 'layout', 'audit'],
  director:   ['event', 'checkin', 'lottery', 'roster', 'members'],
  supervisor: ['roster', 'members', 'audit'],        // 監事：監督角色，只看名冊、會籍與稽核紀錄
  staff:      ['event', 'checkin', 'lottery', 'roster', 'members', 'layout'],
  coach:      ['event', 'plan', 'checkin'],
  member:     [],
};
const READONLY = { supervisor: true };               // 監事：看得到名冊與會籍，但不能改
export const MEMBERSHIP = { none: '跑友', applied: '申請中', active: '協會會員', expired: '會籍到期' };
export const MEMBER_TYPES = ['一般會員', '永久會員', '贊助會員'];
const can = (m, p) => !!m && PERMS[norm(m.role)].includes(p);
const pub = (m) => ({
  id: m.id, name: m.name, dist: m.dist, grp: m.grp, role: norm(m.role), roleName: ROLES[norm(m.role)],
  title: m.title || null, avatar: m.avatar || null, line: !!m.line_id,
  nickname: m.nickname || '', club: m.club || '', meal_pref: m.meal_pref || '', phone: m.phone || '',
  membership: m.membership || 'none', membershipName: MEMBERSHIP[m.membership || 'none'],
  member_type: m.member_type || null, member_no: m.member_no || null, paid_until: m.paid_until || null,
  can: PERMS[norm(m.role)],
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
    await env.DB.prepare('INSERT INTO members (id, name, dist, grp, role, line_id, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, str(prof.displayName, 40) || '跑者', 'fm', 'D', 'member', prof.userId, pic).run();
    m = { id, name: str(prof.displayName, 40), role: 'member' };
  }
  await audit(env, req, m, isNew ? 'account.create' : 'login', 'member', m.id, 'LINE');
  return new Response(null, { status: 302, headers: [
    ['location', isNew ? '/#/me?welcome=1' : '/#/'],
    ['set-cookie', await startSession(env, m, req)],
    ['set-cookie', clear],
  ] });
}

// ---- 活動 ----
const eventCols = 'id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, status, created_at, fee, guest_max, meal_options, link_url, link_label';

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
  if (ev.deadline && new Date(ev.deadline) < new Date()) return fail(400, '已經過了報名截止時間');
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in'").bind(ev.id).first()).n;
  const mine = await env.DB.prepare('SELECT id, status FROM signups WHERE event_id = ? AND member_id = ?').bind(ev.id, member.id).first();
  const full = ev.capacity && n >= ev.capacity && mine?.status !== 'in';
  const status = full ? 'wait' : 'in';
  if (mine) {
    await env.DB.prepare('UPDATE signups SET name = ?, grp = ?, dist = ?, note = ?, status = ? WHERE id = ?')
      .bind(name, grp, dist, str(b.note, 100), status, mine.id).run();
  } else {
    await env.DB.prepare('INSERT INTO signups (id, event_id, member_id, name, grp, dist, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(rid(8), ev.id, member.id, name, grp, dist, str(b.note, 100), status).run();
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

// ---- 路由 ----
async function api(req, env, path, method) {
  const member = await currentMember(req, env);
  const need = () => (member ? null : fail(401, '請先加入'));
  const needPerm = (p) => (can(member, p) ? null : fail(403, '沒有這個權限'));
  const needAdmin = () => needPerm('event');
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  if (path === '/api/me' && method === 'GET')
    return json({ member: member ? pub(member) : null, vapid: env.VAPID_PUBLIC_KEY || null, lineLogin: !!(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET) });

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
    const name = str(b.name, 40);
    const dist = b.dist === 'hm' ? 'hm' : 'fm';
    const grp = (str(b.grp, 2) || (dist === 'hm' ? 'C' : 'D')).toUpperCase();
    if (!name) return fail(400, '請填姓名');
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    const id = rid(8);
    await env.DB.prepare('INSERT INTO members (id, name, dist, grp, role) VALUES (?, ?, ?, ?, ?)').bind(id, name, dist, grp, role).run();
    const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
    await audit(env, req, m, 'account.create', 'member', id, '邀請碼');
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
    const u = new URL(req.url), past = u.searchParams.get('past') === '1';
    const rows = (await env.DB.prepare(
      `SELECT ${eventCols}, (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'in') AS signed,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = events.id AND s.status = 'wait') AS waiting,
              (SELECT s.status FROM signups s WHERE s.event_id = events.id AND s.member_id = ?) AS mine
       FROM events WHERE date ${past ? '<' : '>='} ? ORDER BY date ${past ? 'DESC' : 'ASC'}, gather_time LIMIT 60`)
      .bind(member.id, today()).all()).results;
    return json({ events: rows });
  }

  if (path === '/api/events' && method === 'POST') {
    const g = need() || needAdmin(); if (g) return g;
    const e = readEvent(await body());
    if (!e) return fail(400, '活動資料不完整');
    const id = rid(8);
    await env.DB.prepare(`INSERT INTO events (id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, created_by, fee, guest_max, meal_options, link_url, link_label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, member.id, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label).run();
    await audit(env, req, member, 'event.create', 'event', id, e.title);
    await notify(env, await allMemberIds(env, member.id), 'event',
      { title: `新活動：${e.title}`, body: `${e.date}${e.gather_time ? ` ${e.gather_time}` : ''}　${e.place || ''}`, url: `/#/e/${id}` });
    return json({ id });
  }

  const m1 = path.match(/^\/api\/events\/([\w-]{1,32})$/);
  if (m1) {
    const g = need(); if (g) return g;
    const id = m1[1];
    if (method === 'GET') {
      const ev = await eventWithSignups(env, id);
      return ev ? json(ev) : fail(404, '找不到這個活動');
    }
    if (method === 'PUT') {
      const ga = needAdmin(); if (ga) return ga;
      const e = readEvent(await body());
      if (!e) return fail(400, '活動資料不完整');
      const r = await env.DB.prepare(`UPDATE events SET kind=?, title=?, date=?, gather_time=?, end_time=?, place=?, lead=?, note=?, week_no=?, plan_text=?, capacity=?, signup_open=?, deadline=?, fee=?, guest_max=?, meal_options=?, link_url=?, link_label=? WHERE id = ?`)
        .bind(e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, e.fee, e.guest_max, e.meal_options, e.link_url, e.link_label, id).run();
      return r.meta.changes ? json({ ok: true }) : fail(404, '找不到這個活動');
    }
    if (method === 'DELETE') {
      const ga = needAdmin(); if (ga) return ga;
      await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
      await audit(env, req, member, 'event.delete', 'event', id, '');
      return json({ ok: true });
    }
  }

  const m2 = path.match(/^\/api\/events\/([\w-]{1,32})\/signup$/);
  if (m2) {
    const g = need(); if (g) return g;
    const ev = await env.DB.prepare(`SELECT ${eventCols} FROM events WHERE id = ?`).bind(m2[1]).first();
    if (!ev) return fail(404, '找不到這個活動');
    if (method === 'POST') return doSignup(env, ev, member, await body());
    if (method === 'DELETE') return cancelSignup(env, ev, member);
  }

  // 幹部：匯出報名名單（純文字，貼回 LINE 用）
  const m3 = path.match(/^\/api\/events\/([\w-]{1,32})\/roster$/);
  if (m3 && method === 'GET') {
    const g = need(); if (g) return g;
    const ev = await eventWithSignups(env, m3[1]);
    if (!ev) return fail(404, '找不到這個活動');
    const lines = ev.signups.filter((s) => s.status === 'in').map((s, i) => `${i + 1}. ${s.grp}　${s.name}${s.note ? `（${s.note}）` : ''}`);
    const wait = ev.signups.filter((s) => s.status === 'wait').map((s, i) => `候補${i + 1}. ${s.grp}　${s.name}`);
    return json({ text: [`${ev.title}　${ev.date}`, ...lines, ...wait].join('\n') });
  }

  // ---- 個資：本人可以匯出與刪除（A.5.34） ----
  if (path === '/api/me/export' && method === 'GET') {
    const g = need(); if (g) return g;
    const q = (sql) => env.DB.prepare(sql).bind(member.id).all().then((r) => r.results);
    const data = {
      exported_at: new Date().toISOString(),
      profile: (({ s_seen, s_role, s_created, line_id, ...rest }) => ({ ...rest, line_linked: !!line_id }))(member),
      signups: await q('SELECT event_id, name, grp, dist, note, status, created_at FROM signups WHERE member_id = ?'),
      tickets: await q('SELECT event_id, code, guests, meal, table_no, checked_in_at FROM tickets WHERE member_id = ?'),
      prizes: await q('SELECT event_id, prize_id, created_at, claimed_at FROM draws WHERE member_id = ?'),
      notifications: await q('SELECT kind, title, body, created_at, read_at FROM notifications WHERE member_id = ?'),
      sessions: await q('SELECT created_at, last_seen_at, ua FROM sessions WHERE member_id = ?'),
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
    const u = new URL(req.url), action = str(u.searchParams.get('action'), 40);
    const rows = (await env.DB.prepare(
      `SELECT at, actor_name, actor_role, action, target_type, target_id, detail FROM audit_log
       ${action ? 'WHERE action LIKE ?' : ''} ORDER BY at DESC LIMIT 200`).bind(...(action ? [`${action}%`] : [])).all()).results;
    return json({ items: rows });
  }

  // ---- 通知中心 ----
  if (path === '/api/notifications' && method === 'GET') {
    const g = need(); if (g) return g;
    const items = (await env.DB.prepare(
      'SELECT id, kind, title, body, url, created_at, read_at FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 60')
      .bind(member.id).all()).results;
    const unread = items.filter((x) => !x.read_at).length;
    return json({ items, unread });
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
      `SELECT p.id, p.week_no, p.title, p.phase, p.body, p.created_at, m.name AS author
       FROM plan_posts p LEFT JOIN members m ON m.id = p.author_id
       ${week ? 'WHERE p.week_no = ?' : ''} ORDER BY p.created_at DESC LIMIT ${week ? 1 : 20}`)
      .bind(...(week ? [week] : [])).all()).results;
    return json({ plans: rows });
  }
  if (path === '/api/plans' && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'plan')) return fail(403, '只有教練可以發布課表');
    const b = await body();
    const title = str(b.title, 60), bodyText = str(b.body, 8000);
    const week = Number.isInteger(b.week_no) && b.week_no >= 1 && b.week_no <= 21 ? b.week_no : null;
    if (!title || !bodyText) return fail(400, '標題和課表內容都要填');
    const id = rid(8);
    await env.DB.prepare('INSERT INTO plan_posts (id, week_no, title, phase, body, author_id) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, week, title, str(b.phase, 20), bodyText, member.id).run();
    await audit(env, req, member, 'plan.publish', 'plan', id, title);
    if (b.notify !== false) await notify(env, await allMemberIds(env), 'plan', { title: `新課表：${title}`, body: `${member.name} 發布了${week ? ` W${week}` : ''}課表`, url: `/#/plan` });
    return json({ id });
  }
  const pdel = path.match(/^\/api\/plans\/([\w-]{1,32})$/);
  if (pdel && method === 'DELETE') {
    const g = need(); if (g) return g;
    if (!can(member, 'plan')) return fail(403, '只有教練可以刪除課表');
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
      if (!can(member, 'layout')) return fail(403, '只有行政人員可以設定座位圖');
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
    if (!can(member, 'checkin')) return fail(403, '只有幹部可以排桌');
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
    if (!can(member, 'checkin')) return fail(403, '只有幹部可以看報到名單');
    const rows = (await env.DB.prepare(
      `SELECT t.code, t.guests, t.meal, t.seat, t.table_no, t.note, t.checked_in_at, m.id AS member_id, m.name, m.nickname, m.club, m.avatar
       FROM tickets t JOIN members m ON m.id = t.member_id WHERE t.event_id = ? ORDER BY t.table_no, m.name`).bind(mt[1]).all()).results;
    return json({ tickets: rows, checkedIn: rows.filter((r) => r.checked_in_at).length,
      people: rows.reduce((n, r) => n + 1 + (r.guests || 0), 0) });
  }
  const mc = path.match(/^\/api\/events\/([\w-]{1,32})\/checkin$/);
  if (mc && method === 'POST') {
    const g = need(); if (g) return g;
    if (!can(member, 'checkin')) return fail(403, '只有幹部可以報到');
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
    if (method === 'GET') {
      const prizes = (await env.DB.prepare('SELECT id, name, qty, sponsor, sort, stage, note FROM prizes WHERE event_id = ? ORDER BY sort, rowid').bind(eid).all()).results;
      const draws = (await env.DB.prepare('SELECT id, prize_id, member_id, name, created_at, claimed_at FROM draws WHERE event_id = ? ORDER BY created_at').bind(eid).all()).results;
      return json({ prizes, draws });
    }
    if (method === 'POST') {
      if (!can(member, 'lottery')) return fail(403, '只有幹部可以設定獎項');
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
    if (!can(member, 'lottery')) return fail(403, '只有幹部可以抽獎');
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
    if (!can(member, 'lottery')) return fail(403, '只有幹部可以匯出');
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
    if (!can(member, 'lottery')) return fail(403, '只有幹部可以確認領獎');
    await env.DB.prepare("UPDATE draws SET claimed_at = datetime('now') WHERE id = ?").bind(mclaim[1]).run();
    await audit(env, req, member, 'lottery.claim', 'draw', mclaim[1], '');
    return json({ ok: true });
  }

  const mdd = path.match(/^\/api\/draws\/([\w-]{1,32})$/);
  if (mdd && method === 'DELETE') {
    const g = need(); if (g) return g;
    if (!can(member, 'lottery')) return fail(403, '只有幹部可以重抽');
    await env.DB.prepare('DELETE FROM draws WHERE id = ?').bind(mdd[1]).run();
    await audit(env, req, member, 'lottery.undo', 'draw', mdd[1], '');
    return json({ ok: true });
  }

  // ---- 名冊與角色（理事長指派）----
  if (path === '/api/members' && method === 'GET') {
    const g = need(); if (g) return g;
    if (!can(member, 'roster')) return fail(403, '只有幹部可以看名冊');
    const rows = (await env.DB.prepare(
      `SELECT id, name, nickname, club, dist, grp, role, title, avatar, created_at,
              membership, member_type, member_no, joined_on, paid_until, membership_note, phone
       FROM members ORDER BY created_at`).all()).results;
    const fullPhone = can(member, 'members') && !READONLY[norm(member.role)];
    const mask = (p) => (p ? `${p.slice(0, 4)}***${p.slice(-3)}` : '');
    return json({
      members: rows.map((m) => ({ ...m, phone: fullPhone ? m.phone : mask(m.phone),
        role: norm(m.role), roleName: ROLES[norm(m.role)], membershipName: MEMBERSHIP[m.membership || 'none'] })),
      roles: ROLES, perms: PERMS, membership: MEMBERSHIP, memberTypes: MEMBER_TYPES,
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    env.ctx = ctx;
    // LINE 登入是瀏覽器導向（GET、不是 JSON），走在下面的 CSRF 檢查之前
    if (path === '/api/line/start' && req.method === 'GET') return lineStart(env, url);
    if (path === '/api/line/callback' && req.method === 'GET') return lineCallback(req, env, url);
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
