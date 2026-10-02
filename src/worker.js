// 耕跑團 Cultivation in Life Run — API（Cloudflare Worker ＋ D1）
// 身分：用 LINE 群公告的邀請碼加入（JOIN_CODE 是團員，ADMIN_CODE 是幹部），工作階段權杖放 HttpOnly cookie，D1 只存 SHA-256。
// 寫入類 API 只接受同源的 JSON 請求，用來擋 CSRF。
import { subscribe, unsubscribe, push, validEndpoint } from './push.js';

const COOKIE = '__Host-cil_sess';
const SESSION_DAYS = 180;          // 跑團是長期使用，給長一點；登出或換裝置會重發
const rid = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, n * 2);
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status, msg) => json({ error: msg }, status);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const FM = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const HM = ['A', 'B', 'C', 'D', 'E'];
const KINDS = ['track', 'core', 'long', 'race', 'other'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => !s || /^\d{2}:\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);

function validGroup(dist, grp) {
  return dist === 'hm' ? HM.includes(grp) : FM.includes(grp);
}

// ---- 工作階段 ----
async function currentMember(req, env) {
  const token = (req.headers.get('cookie') || '').match(new RegExp(`${COOKIE}=([\\w]+)`))?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).bind(await sha(token)).first();
  if (row) env.ctx?.waitUntil(env.DB.prepare("UPDATE members SET last_seen = datetime('now') WHERE id = ?").bind(row.id).run());
  return row || null;
}

async function startSession(env, memberId) {
  const token = rid(24);
  await env.DB.prepare(`INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .bind(await sha(token), memberId).run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

const pub = (m) => ({ id: m.id, name: m.name, dist: m.dist, grp: m.grp, role: m.role, avatar: m.avatar || null, line: !!m.line_id });

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
    'set-cookie': `${LINE_STATE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  } });
}

async function lineCallback(req, env, url) {
  const clear = `${LINE_STATE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const back = (msg) => new Response(null, { status: 302, headers: { location: `/#/?err=${encodeURIComponent(msg)}`, 'set-cookie': clear } });
  const want = (req.headers.get('cookie') || '').match(new RegExp(`${LINE_STATE}=([\\w]+)`))?.[1];
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state || !want || state !== want) return back('登入逾時，請再試一次');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(url), client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET });
  const tok = await (await fetch('https://api.line.me/oauth2/v2.1/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).json();
  if (!tok.access_token) return back('LINE 登入失敗');
  const prof = await (await fetch('https://api.line.me/v2/profile', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  if (!prof.userId) return back('拿不到 LINE 資料');
  const pic = str(prof.pictureUrl, 300) || null;
  let m = await env.DB.prepare('SELECT id FROM members WHERE line_id = ?').bind(prof.userId).first();
  let isNew = false;
  if (m) {
    await env.DB.prepare('UPDATE members SET avatar = ? WHERE id = ?').bind(pic, m.id).run();
  } else {
    isNew = true;
    const id = rid(8);
    await env.DB.prepare('INSERT INTO members (id, name, dist, grp, role, line_id, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, str(prof.displayName, 40) || '跑者', 'fm', 'D', 'member', prof.userId, pic).run();
    m = { id };
  }
  return new Response(null, { status: 302, headers: [
    ['location', isNew ? '/#/me?welcome=1' : '/#/'],
    ['set-cookie', await startSession(env, m.id)],
    ['set-cookie', clear],
  ] });
}

// ---- 活動 ----
const eventCols = 'id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, status, created_at';

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
  return json({ ok: true, status });
}

// 取消報名後，候補的第一位自動遞補
async function cancelSignup(env, ev, member) {
  await env.DB.prepare("UPDATE signups SET status = 'cancel' WHERE event_id = ? AND member_id = ?").bind(ev.id, member.id).run();
  if (ev.capacity) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND status = 'in'").bind(ev.id).first()).n;
    if (n < ev.capacity) {
      const next = await env.DB.prepare("SELECT id, member_id, name FROM signups WHERE event_id = ? AND status = 'wait' ORDER BY created_at LIMIT 1").bind(ev.id).first();
      if (next) {
        await env.DB.prepare("UPDATE signups SET status = 'in' WHERE id = ?").bind(next.id).run();
        env.defer(push(env, [next.member_id], { title: '候補遞補成功', body: `${ev.title} 有人取消，你已經排進正取名單。`, url: `/#/e/${ev.id}` }));
      }
    }
  }
  return json({ ok: true });
}

// ---- 路由 ----
async function api(req, env, path, method) {
  const member = await currentMember(req, env);
  const need = () => (member ? null : fail(401, '請先加入'));
  const needAdmin = () => (member?.role === 'admin' ? null : fail(403, '只有幹部可以操作'));
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  if (path === '/api/me' && method === 'GET')
    return json({ member: member ? pub(member) : null, vapid: env.VAPID_PUBLIC_KEY || null, lineLogin: !!(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET) });

  // 已登入的人輸入幹部碼升級成幹部
  if (path === '/api/me/admin' && method === 'POST') {
    const g = need(); if (g) return g;
    const code = str((await body()).code, 60);
    if (!env.ADMIN_CODE || code !== env.ADMIN_CODE) return fail(403, '幹部碼不正確');
    await env.DB.prepare("UPDATE members SET role = 'admin' WHERE id = ?").bind(member.id).run();
    return json({ member: { ...pub(member), role: 'admin' } });
  }

  if (path === '/api/join' && method === 'POST') {
    const b = await body();
    const code = str(b.code, 60);
    const admin = env.ADMIN_CODE && code === env.ADMIN_CODE;
    if (!admin && (!env.JOIN_CODE || code !== env.JOIN_CODE)) return fail(403, '邀請碼不正確');
    const name = str(b.name, 40);
    const dist = b.dist === 'hm' ? 'hm' : 'fm';
    const grp = (str(b.grp, 2) || (dist === 'hm' ? 'C' : 'D')).toUpperCase();
    if (!name) return fail(400, '請填姓名');
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    const id = rid(8);
    await env.DB.prepare('INSERT INTO members (id, name, dist, grp, role) VALUES (?, ?, ?, ?, ?)').bind(id, name, dist, grp, admin ? 'admin' : 'member').run();
    const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
    return json({ member: pub(m) }, 200, { 'set-cookie': await startSession(env, id) });
  }

  if (path === '/api/me' && method === 'PUT') {
    const g = need(); if (g) return g;
    const b = await body();
    const name = str(b.name, 40) || member.name;
    const dist = b.dist === 'hm' ? 'hm' : 'fm';
    const grp = (str(b.grp, 2) || member.grp).toUpperCase();
    if (!validGroup(dist, grp)) return fail(400, '組別不正確');
    await env.DB.prepare('UPDATE members SET name = ?, dist = ?, grp = ? WHERE id = ?').bind(name, dist, grp, member.id).run();
    return json({ member: { ...pub(member), name, dist, grp } });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = (req.headers.get('cookie') || '').match(new RegExp(`${COOKIE}=([\\w]+)`))?.[1];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha(token)).run();
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
    await env.DB.prepare(`INSERT INTO events (id, kind, title, date, gather_time, end_time, place, lead, note, week_no, plan_text, capacity, signup_open, deadline, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, member.id).run();
    env.defer(push(env, null, { title: `新活動：${e.title}`, body: `${e.date}${e.gather_time ? ` ${e.gather_time}` : ''}　${e.place || ''}`, url: `/#/e/${id}` }));
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
      const r = await env.DB.prepare(`UPDATE events SET kind=?, title=?, date=?, gather_time=?, end_time=?, place=?, lead=?, note=?, week_no=?, plan_text=?, capacity=?, signup_open=?, deadline=? WHERE id = ?`)
        .bind(e.kind, e.title, e.date, e.gather_time, e.end_time, e.place, e.lead, e.note, e.week_no, e.plan_text, e.capacity, e.signup_open, e.deadline, id).run();
      return r.meta.changes ? json({ ok: true }) : fail(404, '找不到這個活動');
    }
    if (method === 'DELETE') {
      const ga = needAdmin(); if (ga) return ga;
      await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
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
