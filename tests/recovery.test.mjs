// 一次性恢復連結（migrations/0056）：理事長「重設並登出」後沒有登入方式（解除 Google 或沒綁 Google）時一起產生，或只產生（POST /api/members/:id/recovery）；
//   本人打開 /r/<代碼>（首頁原樣、no-store、no-referrer）→ #/recover → POST /api/recover/check（遮過的名字）→ 用 Google（mode X，可以是新的 Google 帳號）
//   或通行金鑰接回原本的帳號並登入；24 小時、只能用一次、產生新的或重設時舊的失效、不存在／過期／用過一律同一個回應、每個 IP 10 分鐘 10 次；
//   稽核不記代碼與網址；接回後通知本人與理事長；D1 句數固定
//   用 /api/dev/google 模擬 Google（recover=<代碼>，或 state=1 照 callback 讀 /api/google/start?mode=X 放進去的 state cookie），軟體驗證器模擬通行金鑰
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { maskName } from '../src/referral.js';

const BASE = process.env.BASE || 'http://localhost:8799', RP = new URL(BASE).hostname;
const T = Date.now().toString(36);
const INVALID = { error: '這個恢復連結無效或已過期，請聯絡理事長重新產生', invalid: true };
const TAKEN = '這個 Google 帳號已經是另一個帳號，請換一個';
const devCookie = async (id, mfa) => (await fetch(`${BASE}/api/dev/login?id=${id}${mfa ? '&mfa=1' : ''}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
async function call(cookie, path, { method = 'GET', body } = {}) {
  const headers = { origin: BASE, ...(cookie ? { cookie } : {}) };
  if (method !== 'GET' && method !== 'DELETE') headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers, d1: Number(/d1=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
const sessOf = (headers) => headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess='))?.split(';')[0];
async function google(params, cookie) {
  const r = await fetch(`${BASE}/api/dev/google?${new URLSearchParams(params)}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { location: r.headers.get('location'), cookie: sessOf(r.headers), setCookies: r.headers.getSetCookie(), d1: Number(/d1=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
const me = async (cookie) => (await call(cookie, '/me')).json?.member ?? null;
const IPS = ['local', '127.0.0.1', '::1', '::ffff:127.0.0.1'].map((ip) => createHash('sha256').update(`${ip}|test-salt`).digest('hex').slice(0, 16));
const rate = (key, q) => fetch(`${BASE}/api/dev/rate?key=${encodeURIComponent(key)}&${q}`);
const clearRec = async () => { for (const h of IPS) { await rate(`rec:${h}`, 'clear=1'); await rate(`pk:${h}`, 'clear=1'); } };
async function join(name) {
  for (const h of IPS) await rate(`join:${h}`, 'clear=1');
  const j = await call(null, '/join', { method: 'POST', body: { code: 'test-join', name, consent: true } });
  assert.equal(j.status, 200, j.text);
  return { cookie: sessOf(j.headers), id: j.json.member.id, name };
}
const chair = () => devCookie('t_chair', true);
const reset = async (id, body = {}) => call(await chair(), `/members/${id}/security-reset`, { method: 'POST', body });
const issue = async (id, cookie) => call(cookie ?? await chair(), `/members/${id}/recovery`, { method: 'POST' });
const tokenOf = (r) => r.json.recovery.url.split('/r/')[1];
const check = (token, extra = {}) => call(null, '/recover/check', { method: 'POST', body: { token, ...extra } });
// 稽核：action LIKE 'security.recover%'（含 security.recovery_issue；底線在查詢裡會被拿掉，所以只用前綴）
const recAudit = async () => (await call(await chair(), '/audit?action=security.recover')).json.items;
const security = async (cookie) => { const r = (await call(cookie, '/notifications?cat=security')).json; return [...(r.pinned || []), ...r.items]; };

// 軟體驗證器（同 tests/security-reset.test.mjs）
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
const newKey = async () => ({ key: await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), credId: crypto.getRandomValues(new Uint8Array(32)), counter: 1 });
async function attest(k, challenge) {
  const jwk = await crypto.subtle.exportKey('jwk', k.key.publicKey);
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
  const ad = cat(await sha(te.encode(RP)), new Uint8Array([0x45, 0, 0, 0, k.counter]), new Uint8Array(16), new Uint8Array([0, 32]), k.credId, cbor(cose));
  const cd = te.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: BASE }));
  return { id: b64u(k.credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))) } };
}
// 一般的新增通行金鑰（登入後）
async function register(cookie, k) {
  const o = await call(cookie, '/passkey/options', { method: 'POST', body: { purpose: 'register' } });
  assert.equal(o.status, 200, o.text);
  return call(cookie, '/passkey/verify', { method: 'POST', body: { cid: o.json.cid, credential: await attest(k, o.json.publicKey.challenge) } });
}
const recOptions = (token) => call(null, '/recover/passkey/options', { method: 'POST', body: { token } });
const recVerify = async (token, opts, k) => call(null, '/recover/passkey/verify', { method: 'POST', body: { token, cid: opts.json.cid, credential: await attest(k, opts.json.publicKey.challenge) } });

const B = {};   // 每支 API 這次用掉的 D1 句數（最後一起檢查）
const S = {};
const clearLimits = async () => { await clearRec(); await rate('secreset:t_chair', 'clear=1'); await rate('recissue:t_chair', 'clear=1'); };
before(async () => {
  await clearLimits();
  const d = await join(`恢復理事${T}`);
  assert.equal((await call(await chair(), `/members/${d.id}/role`, { method: 'POST', body: { role: 'director' } })).status, 200);
  S.director = d.id;
});
after(async () => {
  await clearLimits();
  if (S.director) await call(await chair(), `/members/${S.director}/role`, { method: 'POST', body: { role: 'member' } });
});

test('重設：解除 Google（或沒綁 Google）時一起產生恢復連結，只回這一次、24 小時；稽核只記「24 小時」；還能用 Google 登入的不產生，還沒用的舊連結一起失效', async () => {
  const sub = `rc_a_${T}`, name = `恢復甲${T}`;
  const a = await google({ sub, name });
  const id = (await me(a.cookie)).id;
  const r = await reset(id, { unlink_google: true, confirm: name, reason: 'Google 帳號被盜用' });
  assert.equal(r.status, 200, r.text);
  B.reset = r.d1;
  assert.match(r.json.recovery.url, new RegExp(`^${BASE}/r/[\\w-]{43}$`));
  const exp = Date.parse(r.json.recovery.expires_at);
  assert.ok(Math.abs(exp - (Date.now() + 24 * 3600e3)) < 120e3, `24 小時後到期：${r.json.recovery.expires_at}`);
  const token = tokenOf(r);
  // 後台只看得到「有沒有還沒用的連結、到什麼時候」，看不到連結本身
  const g = await call(await devCookie('t_chair'), `/members/${id}/security`);
  assert.equal(g.json.recovery, r.json.recovery.expires_at);
  assert.ok(!g.text.includes(token));
  const c = await check(token);
  assert.equal(c.status, 200, c.text);
  B.check = c.d1;
  assert.deepEqual(c.json, { name: maskName(name), expires_at: r.json.recovery.expires_at }, '只給遮過的名字');
  const au = (await recAudit()).filter((x) => x.action === 'security.recovery_issue' && x.target_id === id);
  assert.deepEqual(au.map((x) => [x.detail, x.actor_name]), [['24 小時', '測試理事長']]);
  S.a = { id, name, sub, token };
  // 還有 Google 可以登入（沒勾解除）：不產生；之前另外產生、還沒用的連結一起失效（重設＝收回所有登入方式）
  const bsub = `rc_b_${T}`, b = await google({ sub: bsub, name: `恢復乙${T}` });
  const bid = (await me(b.cookie)).id;
  const old = await issue(bid);
  assert.equal(old.status, 200, old.text);
  assert.equal((await check(tokenOf(old))).status, 200);
  const keep = await reset(bid);
  assert.equal(keep.status, 200, keep.text);
  assert.equal(keep.json.recovery, undefined);
  assert.deepEqual((await check(tokenOf(old))).json, INVALID, '重設後舊的恢復連結不能用');
  assert.equal((await call(await devCookie('t_chair'), `/members/${bid}/security`)).json.recovery, null);
  await clearLimits();
});

test('只產生恢復連結：只有理事長、一定要驗證、不能替自己、找不到 404、一小時 10 次；通知本人（不放連結）；產生新的舊的就失效', async () => {
  const z = await join(`恢復丙${T}`);
  for (const who of ['t_staff', 't_super', 't_coach', 't_runner', S.director]) {
    const r = await issue(z.id, await devCookie(who, true));
    assert.equal(r.status, 403, `${who}：${r.text}`);
    assert.equal(r.json.error, '只有理事長可以產生恢復連結');
  }
  assert.equal((await call(null, `/members/${z.id}/recovery`, { method: 'POST' })).status, 401);
  const stale = await issue(z.id, await devCookie('t_chair'));
  assert.equal(stale.status, 403);
  assert.equal(stale.json.stepup, true, '沒用通行金鑰驗證過：App 會叫出驗證');
  const self = await issue('t_chair');
  assert.equal(self.status, 400);
  assert.equal(self.json.error, '不能替自己產生恢復連結');
  assert.equal((await issue('nobody_here')).status, 404);
  const r1 = await issue(z.id), r2 = await issue(z.id);
  assert.equal(r1.status, 200, r1.text);
  B.issue = r2.d1;
  assert.notEqual(tokenOf(r1), tokenOf(r2));
  assert.deepEqual((await check(tokenOf(r1))).json, INVALID, '產生新的：舊的失效');
  assert.equal((await check(tokenOf(r2))).status, 200);
  assert.ok(await me(z.cookie), '只產生連結：不會登出');
  const n = (await security(z.cookie)).filter((x) => x.title === '理事長產生了恢復連結');
  assert.equal(n.length, 2);
  assert.equal(n[0].body, '理事長替你的帳號產生了一個恢復連結（24 小時內有效，只能用一次），會私訊給你。不是你要求的，請馬上聯絡理事長。');
  assert.ok(n.every((x) => !JSON.stringify(x).includes('/r/') && !JSON.stringify(x).includes(tokenOf(r2))), '通知裡沒有連結');
  await rate('recissue:t_chair', 'count=11&sec=3600');
  assert.equal((await issue(z.id)).status, 429);
  assert.equal((await check(tokenOf(r2))).status, 200, '被擋下：什麼都沒動');
  await clearLimits();
  S.z = { ...z, token: tokenOf(r2) };
});

test('恢復連結：不存在、格式不對、過期、用過一律同一個回應；每個 IP 10 分鐘 10 次', async () => {
  for (const token of [undefined, '', 'short', 'x'.repeat(43), `${'A'.repeat(42)}!`, 'B'.repeat(44)]) {
    const r = await check(token);
    assert.equal(r.status, 404, `${token}：${r.text}`);
    assert.deepEqual(r.json, INVALID);
  }
  await clearRec();
  const w = await join(`恢復丁${T}`), r = await issue(w.id);
  await fetch(`${BASE}/api/dev/recovery-age?id=${w.id}`);
  assert.deepEqual((await check(tokenOf(r))).json, INVALID, '過期');
  assert.deepEqual((await recOptions(tokenOf(r))).json, INVALID, '過期：通行金鑰也一樣');
  assert.match((await google({ sub: `rc_w_${T}`, recover: tokenOf(r) })).location, /^\/#\/recover\?err=/, '過期：Google 也一樣');
  for (const h of IPS) await rate(`rec:${h}`, 'count=11&sec=600');
  const lim = await check(S.z.token);
  assert.equal(lim.status, 429, lim.text);
  assert.equal((await recOptions(S.z.token)).status, 429, '改用通行金鑰也算');
  await clearRec();
  assert.equal((await check(S.z.token)).status, 200);
});

test('Google（mode X）：代碼從 HttpOnly cookie 搬進 state cookie（不進任何網址）；別人的 Google 帳號不接；接回原本的帳號、換成新的 Google 帳號並登入，馬上可以新增通行金鑰；只能用一次；通知本人與理事長', async () => {
  const { id, name, sub, token } = S.a;
  // 已經是另一個帳號的 Google：不接，連結還能用
  const other = `rc_o_${T}`;
  await google({ sub: other, name: '別人' });
  const taken = await google({ sub: other, recover: token });
  assert.equal(taken.location, `/#/recover?err=${encodeURIComponent(TAKEN)}`);
  assert.equal(taken.cookie, undefined, '沒有工作階段');
  assert.equal((await check(token)).status, 200);
  // 按「用 Google 登入並接回帳號」：check 帶 google → HttpOnly、SameSite=Strict、10 分鐘的 __Host-cil_rec
  const prep = await check(token, { google: true });
  const rc = prep.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_rec='));
  assert.ok(rc, '設了 __Host-cil_rec');
  assert.match(rc, /; HttpOnly/); assert.match(rc, /; Secure/); assert.match(rc, /SameSite=Strict/); assert.match(rc, /Max-Age=600/);
  assert.ok(!(await check(token)).headers.getSetCookie().some((c) => c.startsWith('__Host-cil_rec=')), '只看名字時不設');
  // /api/google/start?mode=X：代碼搬進 OAuth 的 state cookie，Google 的網址裡沒有；__Host-cil_rec 清掉
  const st = await fetch(`${BASE}/api/google/start?mode=X`, { redirect: 'manual', headers: { cookie: rc.split(';')[0] } });
  assert.equal(st.status, 302);
  const loc = st.headers.get('location');
  assert.match(loc, /^https:\/\/accounts\.google\.com\//);
  assert.ok(!loc.includes(token), 'Google 的網址沒有代碼');
  const state = st.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_oauth='));
  assert.match(state, new RegExp(`^__Host-cil_oauth=\\w+\\.\\w+\\.X\\.${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$`));
  assert.ok(st.headers.getSetCookie().some((c) => /^__Host-cil_rec=;.*Max-Age=0/.test(c)), '__Host-cil_rec 清掉');
  // 沒有 __Host-cil_rec（例如超過 10 分鐘）：回到恢復帳號頁
  const none = await fetch(`${BASE}/api/google/start?mode=X`, { redirect: 'manual' });
  assert.equal(none.headers.get('location'), `/#/recover?err=${encodeURIComponent(INVALID.error)}`);
  // Google 回來（照 callback 讀 state cookie）：換成新的 Google 帳號接回原本的帳號
  const nsub = `rc_n_${T}`;
  const back = await google({ sub: nsub, name: '新的 Google', state: '1' }, state.split(';')[0]);
  assert.equal(back.location, '/#/me/security?recovered=1');
  assert.ok(back.cookie, '開了工作階段');
  assert.ok(back.setCookies.some((c) => /^__Host-cil_oauth=;.*Max-Age=0/.test(c)), 'state cookie 清掉');
  B.google = back.d1;
  const m = await me(back.cookie);
  assert.equal(m.id, id, '原本的帳號');
  assert.equal(m.google, true);
  // 用 Google 接回：15 分鐘內可以直接新增通行金鑰（一般跑友也不用舊的）
  const add = await register(back.cookie, await newKey());
  assert.equal(add.status, 200, add.text);
  // 只能用一次
  assert.deepEqual((await check(token)).json, INVALID, '用過');
  const again = await google({ sub: `rc_x_${T}`, recover: token });
  assert.equal(again.location, `/#/recover?err=${encodeURIComponent(INVALID.error)}`);
  assert.equal(again.cookie, undefined);
  // 之後用新的 Google 帳號登入回到這個帳號；被盜用、已經解除的舊 Google 帳號不會
  assert.equal((await me((await google({ sub: nsub })).cookie)).id, id);
  assert.notEqual((await me((await google({ sub })).cookie)).id, id);
  // 稽核：actor 是本人，只記 Google 與裝置
  const au = (await recAudit()).filter((x) => x.action === 'security.recover' && x.target_id === id);
  assert.equal(au.length, 1);
  assert.equal(au[0].actor_name, name);
  assert.match(au[0].detail, /^Google｜/);
  // 通知：本人與理事長（理事長點開直接是這位跑友的「安全」）
  const mine = (await security(back.cookie)).find((x) => x.title === '用恢復連結接回帳號');
  assert.ok(mine, '通知本人');
  assert.match(mine.body, new RegExp(`^${name} 用恢復連結重新接回帳號（.+）。不是你的話，請馬上聯絡理事長。$`));
  const ch = (await security(await devCookie('t_chair'))).find((x) => x.title === '跑友用恢復連結接回帳號' && x.body.startsWith(name));
  assert.ok(ch, '通知理事長');
  assert.equal(ch.url, `/#/admin?tab=roles&sec=${id}`);
  await clearRec();
});

test('通行金鑰（不用 Google）：替這個帳號新增一把並登入；同一個連結同時用兩次只有一個成功；用過、格式不對的不給挑戰值', async () => {
  const p = await join(`恢復戊${T}`), r = await issue(p.id), token = tokenOf(r);
  assert.equal((await reset(p.id, { confirm: p.name })).status, 200);   // 重設：舊的連結失效，換成重設時產生的
  assert.deepEqual((await recOptions(token)).json, INVALID);
  const tk = tokenOf(await reset(p.id, { confirm: p.name }));
  const o1 = await recOptions(tk), o2 = await recOptions(tk);
  assert.equal(o1.status, 200, o1.text);
  assert.equal(o1.json.publicKey.user.displayName, p.name);
  assert.deepEqual(o1.json.publicKey.excludeCredentials, []);
  const v1 = await recVerify(tk, o1, await newKey());
  assert.equal(v1.status, 200, v1.text);
  B.pkVerify = v1.d1;
  const cookie = sessOf(v1.headers);
  const m = await me(cookie);
  assert.equal(m.id, p.id);
  assert.equal(m.mfa, true, '通行金鑰本身就是兩步驟');
  assert.equal((await call(cookie, '/passkeys')).json.passkeys.length, 1);
  // 另一個同時拿到挑戰值的：連結已經用掉，不寫通行金鑰、沒有工作階段
  const v2 = await recVerify(tk, o2, await newKey());
  assert.equal(v2.status, 404, v2.text);
  assert.deepEqual(v2.json, INVALID);
  assert.equal(sessOf(v2.headers), undefined);
  assert.equal((await call(cookie, '/passkeys')).json.passkeys.length, 1);
  assert.deepEqual((await check(tk)).json, INVALID);
  assert.deepEqual((await recOptions('nope')).json, INVALID);
  const au = (await recAudit()).filter((x) => x.action === 'security.recover' && x.target_id === p.id);
  assert.equal(au.length, 1);
  assert.match(au[0].detail, /^通行金鑰｜/);
  assert.ok((await security(cookie)).some((x) => x.title === '用恢復連結接回帳號'));
  // 稽核裡沒有任何代碼或連結
  const all = JSON.stringify((await call(await chair(), '/audit?action=security')).json.items);
  for (const t of [token, tk, S.a.token, S.z.token]) assert.ok(!all.includes(t), '稽核沒有代碼');
  assert.ok(!all.includes('/r/'), '稽核沒有連結');
  await clearRec();
});

test('/r/<代碼>：回沒改過的首頁（CSP 照舊）；安全標頭跟靜態檔一樣、不送 Referer、不快取；代碼不會出現在頁面', async () => {
  const lines = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split('\n'), want = {};
  for (let i = lines.indexOf('/*') + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) { const [k, ...v] = lines[i].trim().split(':'); want[k.trim().toLowerCase()] = v.join(':').trim(); }
  assert.ok(Object.keys(want).length >= 5);
  const cspOf = (html) => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  const home = await (await fetch(`${BASE}/`)).text();
  for (const tok of [S.z.token, 'C'.repeat(43), 'not-a-token']) {
    const r = await fetch(`${BASE}/r/${tok}?openExternalBrowser=1`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    for (const [k, v] of Object.entries(want)) assert.equal(r.headers.get(k), k === 'referrer-policy' ? 'no-referrer' : v, `${k}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.equal(html, home, '首頁原樣');
    assert.equal(cspOf(html), cspOf(home));
    assert.match(cspOf(html), /upgrade-insecure-requests/);
    assert.ok(!html.includes(tok), '代碼不在頁面裡');
  }
  const h = await fetch(`${BASE}/r/${S.z.token}`, { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('cache-control'), 'no-store');
  assert.equal((await check(S.z.token)).status, 200, '打開頁面不會用掉連結');
  await clearRec();
});

test('執行額度：D1 句數固定，沒有超過上限', async (t) => {
  t.diagnostic(`D1 句數 ${JSON.stringify(B)}`);
  // 查連結 3（設定、限流、一句）｜只產生 9（登入、設定、限流、一句、batch 3、通知 2）｜重設 17｜
  //   Google 接回 12（設定與帳號一句、連結一句、batch 5、理事長一句、通知 2×2）｜通行金鑰接回 14（設定、挑戰值讀與刪 2、連結一句、batch 5、理事長一句、通知 2×2）
  const max = { check: 3, issue: 9, reset: 17, google: 12, pkVerify: 14 };
  for (const [k, n] of Object.entries(max)) assert.ok(B[k] > 0 && B[k] <= n, `${k} 用了 ${B[k]} 句（上限 ${n}）`);
  const v = (await (await fetch(`${BASE}/api/dev/budget-violations`)).json()).list;
  assert.deepEqual(v.filter((x) => /recover|google|security/.test(x.name)), []);
});
