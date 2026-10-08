// 後台「權限」→「安全」：理事長重設別人的通行金鑰並登出所有裝置（帳號被盜用、幹部第一把不是本人、幹部唯一一把的手機弄丟）
//   GET /api/members/:id/security 只給數字；POST …/security-reset：只有理事長、15 分鐘內用通行金鑰驗證過、不能重設自己、一小時 10 次；
//   通行金鑰、工作階段（連同行事曆訂閱網址）、推播訂閱、待確認的 Google 綁定、挑戰值一起刪；unlink_google 再解除 Google 與 Gmail 查詢碼；
//   稽核只記數字；原因只在給本人的通知；D1 句數固定（跟金鑰、裝置數量無關）
//   重設後沒有登入方式的（沒綁 Google，或一起解除）要輸入對方的姓名確認，並一起產生一次性恢復連結（只回一次；接回帳號的流程在 tests/recovery.test.mjs）
//   登入、新增通行金鑰、綁定 Google 途中剛好被重設（x-dev-race 模擬）：不會留下工作階段、通行金鑰或綁定
//   用 /api/dev/google 模擬 Google 登入，軟體驗證器模擬手機的通行金鑰（同 tests/google-link.test.mjs）
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8799', RP = new URL(BASE).hostname;
const T = Date.now().toString(36);
const devCookie = async (id, mfa) => (await fetch(`${BASE}/api/dev/login?id=${id}${mfa ? '&mfa=1' : ''}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
async function call(cookie, path, { method = 'GET', body, race } = {}) {
  const headers = { origin: BASE, ...(cookie ? { cookie } : {}), ...(race ? { 'x-dev-race': race } : {}) };
  if (method !== 'GET' && method !== 'DELETE') headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, d1: Number(/d1=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
async function google(params, cookie, race) {
  const r = await fetch(`${BASE}/api/dev/google?${new URLSearchParams(params)}`, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(race ? { 'x-dev-race': race } : {}) } });
  return { location: r.headers.get('location'), cookie: r.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess='))?.split(';')[0] };
}
const me = async (cookie) => (await call(cookie, '/me')).json?.member ?? null;
const IPS = ['local', '127.0.0.1', '::1', '::ffff:127.0.0.1'].map((ip) => createHash('sha256').update(`${ip}|test-salt`).digest('hex').slice(0, 16));
const rate = (key, q) => fetch(`${BASE}/api/dev/rate?key=${encodeURIComponent(key)}&${q}`);
async function join(name) {
  for (const h of IPS) await rate(`join:${h}`, 'clear=1');
  const j = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'test-join', name, consent: true }) });
  assert.equal(j.status, 200);
  return { cookie: j.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess=')).split(';')[0], id: (await j.json()).member.id };
}
const auditOf = async (action) => (await call(await devCookie('t_chair', true), `/audit?action=${action}`)).json.items.filter((r) => r.action === action);
const security = async (cookie) => { const r = (await call(cookie, '/notifications?cat=security')).json; return [...(r.pinned || []), ...r.items]; };

// 軟體驗證器（同 tests/google-link.test.mjs）
const te = new TextEncoder(), b64u = (b) => Buffer.from(b).toString('base64url'), unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const sha = async (d) => new Uint8Array(await crypto.subtle.digest('SHA-256', d));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const head = (mt, n) => (n < 24 ? [mt << 5 | n] : n < 256 ? [mt << 5 | 24, n] : [mt << 5 | 25, n >> 8, n & 255]);
function cbor(v) {
  if (typeof v === 'number') return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = te.encode(v); return cat(new Uint8Array(head(3, b.length)), b); }
  if (v instanceof Uint8Array) return cat(new Uint8Array(head(2, v.length)), v);
  return cat(new Uint8Array(head(5, v.size)), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}
const der = (raw) => { const enc = (x) => { let i = 0; while (i < 31 && x[i] === 0) i++; let v = x.slice(i); if (v[0] & 0x80) v = cat(new Uint8Array([0]), v); return cat(new Uint8Array([2, v.length]), v); };
  const r = enc(raw.slice(0, 32)), s = enc(raw.slice(32)); return cat(new Uint8Array([0x30, r.length + s.length]), r, s); };
const newKey = async () => ({ key: await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), credId: crypto.getRandomValues(new Uint8Array(32)), counter: 1 });
async function register(cookie, k, race) {
  const o = await call(cookie, '/passkey/options', { method: 'POST', body: { purpose: 'register' } });
  assert.equal(o.status, 200, o.text);
  const jwk = await crypto.subtle.exportKey('jwk', k.key.publicKey);
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
  const ad = cat(await sha(te.encode(RP)), new Uint8Array([0x45, 0, 0, 0, k.counter]), new Uint8Array(16), new Uint8Array([0, 32]), k.credId, cbor(cose));
  const cd = te.encode(JSON.stringify({ type: 'webauthn.create', challenge: o.json.publicKey.challenge, origin: BASE }));
  const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const v = await call(cookie, '/passkey/verify', { method: 'POST', race, body: { cid: o.json.cid, credential: { id: b64u(k.credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(att) } } } });
  if (race) return v;
  assert.equal(v.status, 200, v.text);
}
// 驗證（stepup）或登入（purpose login，不帶 cookie）：拿挑戰值、簽章、送出；送出前可以先做別的事（between），回傳 verify 的回應
async function stepup(cookie, k, between, { purpose = 'stepup', race } = {}) {
  const op = await call(cookie, '/passkey/options', { method: 'POST', body: { purpose } });
  assert.equal(op.status, 200, op.text);
  if (between) await between();
  k.counter += 1;
  const a = cat(await sha(te.encode(RP)), new Uint8Array([0x05, 0, 0, 0, k.counter]));
  const c = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: op.json.publicKey.challenge, origin: BASE }));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key.privateKey, cat(a, await sha(c))));
  return call(cookie, '/passkey/verify', { method: 'POST', race, body: { cid: op.json.cid, credential: { id: b64u(k.credId), type: 'public-key', response: { clientDataJSON: b64u(c), authenticatorData: b64u(a), signature: b64u(der(raw)) } } } });
}
const EP = (x) => `https://fcm.googleapis.com/fcm/send/sec_reset_${x}_${T}`;
const subscribe = (cookie, ep) => call(cookie, '/push/subscribe', { method: 'POST', body: { endpoint: ep, keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) } } });
const subs = async () => (await (await fetch(`${BASE}/api/dev/push-mock`)).json()).subs;
const reset = (cookie, id, body = {}) => call(cookie, `/members/${id}/security-reset`, { method: 'POST', body });

const B = {};   // 每支 API 這次用掉的 D1 句數（最後一起檢查）
const clearPk = async () => { for (const h of IPS) await rate(`pk:${h}`, 'clear=1'); };
const S = {};
before(async () => {
  await clearPk();
  await rate('secreset:t_chair', 'clear=1');
  // 理事（測試帳號沒有）：邀請碼加入後由理事長指派
  const d = await join(`安全理事${T}`);
  assert.equal((await call(await devCookie('t_chair', true), `/members/${d.id}/role`, { method: 'POST', body: { role: 'director' } })).status, 200);
  S.director = d.id;
});
after(async () => {
  await clearPk();
  await rate('secreset:t_chair', 'clear=1');
  const chair = await devCookie('t_chair', true);
  if (S.director) await call(chair, `/members/${S.director}/role`, { method: 'POST', body: { role: 'member' } });
  await call(chair, '/settings/features', { method: 'POST', body: { referral: false } });
});

test('帳號安全的數字：只有理事長看得到；只有數字，沒有裝置名稱、IP；幹部與分團幹部標出來', async () => {
  const chair = await devCookie('t_chair');   // 唯讀：不用再驗證
  // 甲：邀請碼加入、新增通行金鑰、另一台裝置登入、開推播；綁 Google 先記下待確認（已經有通行金鑰）
  const a = await join(`重設甲${T}`), k = await newKey();
  await register(a.cookie, k);
  await devCookie(a.id);
  assert.equal(await (await google({ link: '1', sub: `sr_a_${T}` }, a.cookie)).location, '/#/me?google=confirm');
  const g = await call(chair, `/members/${a.id}/security`);
  assert.equal(g.status, 200, g.text);
  B.get = g.d1;
  assert.deepEqual(Object.keys(g.json).sort(), ['google', 'lastSeen', 'name', 'officer', 'passkeys', 'pending', 'recovery', 'sessions']);
  assert.deepEqual({ ...g.json, lastSeen: null }, { name: `重設甲${T}`, passkeys: 1, sessions: 2, lastSeen: null, google: false, pending: true, officer: false, recovery: null });
  assert.match(g.json.lastSeen, /^\d{4}-\d{2}-\d{2}$/, '最近使用：台北日期');
  assert.equal((await call(chair, '/members/t_coach/security')).json.officer, true, '教練');
  assert.equal((await call(chair, '/members/t_lead/security')).json.officer, true, '分團團長（協會身分是團員）');
  assert.equal((await call(chair, '/members/nobody_here/security')).status, 404);
  for (const id of ['t_staff', 't_super', 't_coach', S.director, 't_runner']) {
    const r = await call(await devCookie(id, true), `/members/${a.id}/security`);
    assert.equal(r.status, 403, `${id}：${r.text}`);
  }
  assert.equal((await call(null, `/members/${a.id}/security`)).status, 401);
  S.a = { ...a, k, name: `重設甲${T}` };
});

test('重設：只有理事長；要 15 分鐘內用通行金鑰驗證過；不能重設自己；找不到的人 404', async () => {
  const a = S.a;
  for (const id of ['t_staff', 't_super', 't_coach', S.director]) {
    const r = await reset(await devCookie(id, true), a.id);
    assert.equal(r.status, 403, `${id}：${r.text}`);
    assert.equal(r.json.error, '只有理事長可以重設別人的通行金鑰');
  }
  const stale = await reset(await devCookie('t_chair'), a.id);
  assert.equal(stale.status, 403);
  assert.equal(stale.json.stepup, true, '沒用通行金鑰驗證過：App 會叫出驗證');
  const self = await reset(await devCookie('t_chair', true), 't_chair');
  assert.equal(self.status, 400);
  assert.equal(self.json.error, '重設自己的請到「我的 → 帳號與安全」');
  assert.equal((await reset(await devCookie('t_chair', true), 'nobody_here')).status, 404);
  // 沒有綁 Google：重設後回不到這個帳號，要輸入對方的姓名確認（空的、錯的都擋）
  for (const confirm of [undefined, '', '重設甲', `重設乙${T}`]) {
    const r = await reset(await devCookie('t_chair', true), a.id, { confirm });
    assert.equal(r.status, 400, `${confirm}：${r.text}`);
    assert.deepEqual(r.json, { error: '請輸入對方的姓名確認', confirm: true });
  }
  assert.equal((await call(await devCookie('t_chair'), `/members/${a.id}/security`)).json.passkeys, 1, '都沒有動到');
  assert.ok(await me(a.cookie), '沒有被登出');
  await rate('secreset:t_chair', 'clear=1');   // 上面的嘗試也算次數（一小時 10 次），後面的測試重新算
});

test('重設：通行金鑰、所有裝置的登入、推播訂閱、待確認的 Google 綁定、挑戰值一起刪；原因只在通知；稽核只記數字；舊裝置收不到推播', async () => {
  const a = S.a, chair = await devCookie('t_chair', true);
  assert.equal((await subscribe(a.cookie, EP('a'))).status, 200);
  // 送出前拿到的挑戰值（例如偷到登入狀態的人正在按 Face ID）：重設後用不了
  let pendingVerify;
  await stepup(a.cookie, a.k, async () => {
    await fetch(`${BASE}/api/dev/push-mock?clear=1`);
    const n0 = await subs();
    const r = await reset(chair, a.id, { reason: '手機遺失，請重新登入', confirm: ` ${a.name} ` });
    assert.equal(r.status, 200, r.text);
    const { recovery, ...rest } = r.json;
    assert.deepEqual(rest, { ok: true, passkeys: 1, sessions: 2, unlinked: false });
    assert.match(recovery.url, new RegExp(`^${BASE}/r/[\\w-]{43}$`), '沒有登入方式：一起產生恢復連結（只回這一次）');
    B.resetA = r.d1;
    assert.equal(await subs(), n0 - 1, '推播訂閱刪掉');
  }).then((v) => { pendingVerify = v; });
  assert.equal(pendingVerify.status, 400);
  assert.equal(pendingVerify.json.error, '驗證逾時，請再試一次', '挑戰值已經刪掉');
  assert.equal(await me(a.cookie), null, '原本的登入失效');
  const g = (await call(await devCookie('t_chair'), `/members/${a.id}/security`)).json;
  assert.deepEqual({ passkeys: g.passkeys, sessions: g.sessions, pending: g.pending }, { passkeys: 0, sessions: 0, pending: false });
  // 舊裝置收不到推播（訂閱已經刪了）
  await fetch(`${BASE}/api/dev/drain`);
  assert.ok(!(await (await fetch(`${BASE}/api/dev/push-mock`)).json()).list.some((x) => x.endpoint === EP('a')));
  // 本人重新登入後在通知中心看到：原因只在這裡
  const back = await devCookie(a.id);
  const n = (await security(back)).find((x) => x.title === '帳號安全已重設');
  assert.ok(n, '通知本人');
  // 沒綁 Google：要用理事長私訊的恢復連結接回（這裡用測試登入看），通知不放連結
  assert.equal(n.body, '理事長重設了你的通行金鑰並登出所有裝置。理事長會私訊給你一個恢復連結（24 小時內有效，只能用一次），用它接回這個帳號後，請新增通行金鑰。原因：手機遺失，請重新登入');
  assert.equal(n.url, '/#/me/security');
  const au = (await auditOf('security.reset')).filter((x) => x.target_id === a.id);
  assert.deepEqual(au.map((x) => x.detail), ['通行金鑰 1 把、裝置 2 個'], '稽核只記數字，沒有原因');
  assert.equal(au[0].actor_name, '測試理事長');
  // 重設後本人可以再新增第一把通行金鑰
  await register(back, await newKey());
});

test('重設：沒勾就保留 Google 綁定；勾了「解除 Google」清掉 google_sub 與 Gmail 查詢碼，同一個 Google 帳號登入會開新帳號', async () => {
  const chair = await devCookie('t_chair', true);
  assert.equal((await call(chair, '/settings/features', { method: 'POST', body: { referral: true } })).status, 200);
  const sub = `sr_b_${T}`, gb = await google({ sub, name: '重設乙', email: `sr.b.${T}@gmail.com`, verified: '1' });
  const b = await me(gb.cookie);
  assert.equal(b.google, true);
  assert.equal(b.referral.emailLinked, true, '有 Gmail 查詢碼');
  await register(gb.cookie, await newKey());
  await register(gb.cookie, await newKey());   // 一般跑友剛用 Google 登入：第二把不用舊的驗證（金鑰數量跟甲不同，句數照樣一樣）
  const keep = await reset(chair, b.id);   // 還有 Google 可以登入：不用輸入姓名
  assert.equal(keep.status, 200, keep.text);
  assert.equal(keep.json.unlinked, false);
  assert.equal(keep.json.recovery, undefined, '還能用 Google 登入：不產生恢復連結');
  B.resetB = keep.d1;
  assert.equal((await google({ sub })).location, '/#/', '沒勾：照樣用 Google 登入回到同一個帳號');
  assert.equal((await me((await google({ sub })).cookie)).id, b.id);
  assert.ok((await security(await devCookie(b.id))).some((x) => x.body === '理事長重設了你的通行金鑰並登出所有裝置。用 Google 重新登入後，請到「我的 → 帳號與安全」新增通行金鑰。'));
  // 解除 Google：之後沒有登入方式，要輸入姓名確認
  const no = await reset(chair, b.id, { unlink_google: true });
  assert.equal(no.status, 400, no.text);
  assert.equal(no.json.confirm, true);
  assert.equal((await call(chair, `/members/${b.id}/security`)).json.google, true, '還沒解除');
  const off = await reset(chair, b.id, { unlink_google: true, reason: 'Google 帳號被盜用', confirm: '重設乙' });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.unlinked, true);
  const aft = await me(await devCookie(b.id));
  assert.deepEqual({ google: aft.google, emailLinked: aft.referral.emailLinked }, { google: false, emailLinked: false });
  assert.notEqual((await me((await google({ sub, name: '重設乙' })).cookie)).id, b.id, '同一個 Google 帳號登入不會回到這個帳號');
  const n = (await security(await devCookie(b.id))).filter((x) => x.title === '帳號安全已重設');
  assert.ok(n.some((x) => x.body === '理事長重設了你的通行金鑰並登出所有裝置，也解除了 Google 綁定。理事長會私訊給你一個恢復連結（24 小時內有效，只能用一次），用它接回這個帳號後，請新增通行金鑰。原因：Google 帳號被盜用'));
  assert.match(off.json.recovery.url, /\/r\/[\w-]{43}$/, '解除 Google：一起產生恢復連結');
  const au = (await auditOf('security.reset')).filter((x) => x.target_id === b.id).map((x) => x.detail);
  assert.ok(au.some((d) => /^通行金鑰 0 把、裝置 \d+ 個、解除 Google$/.test(d)), au.join(' / '));
  assert.ok(au.every((d) => !d.includes('盜用')), '原因不進稽核');
  // 已經沒有綁 Google：勾了也不算解除
  assert.equal((await reset(chair, b.id, { unlink_google: true, confirm: '重設乙' })).json.unlinked, false);
});

test('重設：一小時 10 次（理事長）；超過回 429，什麼都不動', async () => {
  const chair = await devCookie('t_chair', true), c = await join(`重設丙${T}`);
  await rate('secreset:t_chair', 'count=11&sec=3600');
  const r = await reset(chair, c.id);
  assert.equal(r.status, 429);
  assert.ok(await me(c.cookie), '沒有被登出');
  await rate('secreset:t_chair', 'clear=1');
  assert.equal((await reset(chair, c.id, { confirm: `重設丙${T}` })).status, 200);
});

test('途中被重設（理事長剛好送出）：登入、新增通行金鑰、綁定 Google 都不會留下來', async () => {
  const chair = await devCookie('t_chair'), sec = async (id) => (await call(chair, `/members/${id}/security`)).json;
  await clearPk();
  // 通行金鑰登入：驗證通過後、開工作階段前被重設（通行金鑰已經刪了）→ 不開工作階段、不記登入
  const d = await join(`重設丁${T}`), k = await newKey();
  await register(d.cookie, k);
  const lg = await stepup(null, k, null, { purpose: 'login', race: 'pk-login' });
  assert.equal(lg.status, 400, lg.text);
  assert.equal(lg.json.error, '找不到這把通行金鑰，可能已經被移除');
  assert.deepEqual({ passkeys: (await sec(d.id)).passkeys, sessions: (await sec(d.id)).sessions }, { passkeys: 0, sessions: 0 });
  assert.ok(!(await auditOf('login')).some((x) => x.target_id === d.id && x.detail === '通行金鑰'), '沒有記登入');
  // 新增通行金鑰：挑戰值用掉後、寫入前被重設（工作階段已經刪了）→ 這把不會寫進去
  const add = await register(await devCookie(d.id), await newKey(), 'pk-add');
  assert.equal(add.status, 400, add.text);
  assert.equal(add.json.error, '登入已經失效，請重新登入');
  assert.equal((await sec(d.id)).passkeys, 0);
  // Google 登入：找到帳號後、開工作階段前被重設並解除 Google → 不開工作階段
  const sub = `sr_e_${T}`, e = await google({ sub, name: '重設戊' });
  const eid = (await me(e.cookie)).id;
  const gl = await google({ sub }, null, 'google');
  assert.match(gl.location, /^\/#\/\?err=/);
  assert.equal(gl.cookie, undefined, '沒有工作階段');
  assert.deepEqual({ google: (await sec(eid)).google, sessions: (await sec(eid)).sessions }, { google: false, sessions: 0 });
  // 直接綁定 Google（沒有通行金鑰的帳號）：寫入前被重設 → 不會綁回去
  const f = await join(`重設己${T}`);
  const lk = await google({ link: '1', sub: `sr_f_${T}` }, f.cookie, 'link');
  assert.match(lk.location, /^\/#\/\?err=/);
  assert.equal((await sec(f.id)).google, false);
  // 先 Google、再通行金鑰的確認：送出確認時被重設 → 不綁、不記稽核
  const h = await join(`重設庚${T}`), hk = await newKey();
  await register(h.cookie, hk);
  const hc = await devCookie(h.id);
  assert.equal((await google({ link: '1', sub: `sr_h_${T}` }, hc)).location, '/#/me?google=confirm');
  assert.equal((await stepup(hc, hk)).status, 200);
  const pid = (await call(hc, '/google/pending')).json.pending.pid;
  const cf = await call(hc, '/google/confirm-link', { method: 'POST', body: { pid }, race: 'confirm' });
  assert.equal(cf.status, 401, cf.text);
  assert.equal(cf.json.error, '登入已經失效，請重新登入');
  assert.equal((await sec(h.id)).google, false);
  assert.ok(!(await auditOf('google.link')).some((x) => x.target_id === h.id), '沒有記綁定');
  await clearPk();
});

test('執行額度：D1 句數固定（跟通行金鑰、裝置數量無關），沒有超過上限', async (t) => {
  t.diagnostic(`D1 句數 ${JSON.stringify(B)}`);
  // 讀數字 3 以內（登入狀態、設定、一句數字）｜重設 17 以內（登入狀態、設定、限流、一句數字、一個 batch 11 句〔含恢復連結 3 句〕、通知 2 句）
  assert.ok(B.get > 0 && B.get <= 3, `GET 用了 ${B.get} 句`);
  assert.ok(B.resetA > 0 && B.resetA <= 17, `重設用了 ${B.resetA} 句`);
  assert.equal(B.resetB, B.resetA, '金鑰與裝置數量不同、有沒有產生恢復連結，句數一樣');
  const v = (await (await fetch(`${BASE}/api/dev/budget-violations`)).json()).list;
  assert.deepEqual(v.filter((x) => /security/.test(x.name)), []);
});
