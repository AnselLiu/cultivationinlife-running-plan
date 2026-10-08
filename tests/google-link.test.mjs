// 先 Google、再通行金鑰：已經有通行金鑰的帳號綁 Google 先記下待確認（google_pending）、用通行金鑰確認才綁上；逾時、取消、確認時再檢查一次；
//   協會強制兩步驟的幹部用 Google 登入後到 #/?mfa=1；剛用 Google 登入或重新確認（google_at）的一般跑友可以不用舊的通行金鑰新增一把，幹部不行；執行額度
//   用 /api/dev/google 模擬 Google 登入（不碰 ID Token 驗證），軟體驗證器模擬手機的通行金鑰（同 tests/passkey.test.mjs）
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8799', RP = new URL(BASE).hostname;
const T = Date.now().toString(36);
const devCookie = async (id, mfa) => (await fetch(`${BASE}/api/dev/login?id=${id}${mfa ? '&mfa=1' : ''}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
async function call(cookie, path, { method = 'GET', body } = {}) {
  const headers = { origin: BASE, ...(cookie ? { cookie } : {}) };
  if (method !== 'GET' && method !== 'DELETE') headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers, d1: Number(/d1=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
// 模擬 Google 登入或綁定：回傳導向的位置與新的工作階段 cookie
async function google(params, cookie) {
  const r = await fetch(`${BASE}/api/dev/google?${new URLSearchParams(params)}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const sess = r.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess='))?.split(';')[0];
  return { status: r.status, location: r.headers.get('location'), cookie: sess, d1: Number(/d1=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
const me = async (cookie) => (await call(cookie, '/me')).json.member;
const age = (id, what) => fetch(`${BASE}/api/dev/google-age?id=${id}&what=${what}`).then((r) => r.json());
const IPS = ['local', '127.0.0.1', '::1', '::ffff:127.0.0.1'].map((ip) => createHash('sha256').update(`${ip}|test-salt`).digest('hex').slice(0, 16));
// 用邀請碼加入（沒有綁 Google 的帳號）
async function join(name) {
  for (const h of IPS) await fetch(`${BASE}/api/dev/rate?key=${encodeURIComponent(`join:${h}`)}&clear=1`);
  const j = await call(null, '/join', { method: 'POST', body: { code: 'test-join', name, consent: true } });
  assert.equal(j.status, 200, j.text);
  return { cookie: j.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess=')).split(';')[0], id: j.json.member.id };
}
const auditOf = async (action) => (await call(await devCookie('t_chair'), `/audit?action=${action.split('_')[0]}`)).json.items.filter((r) => r.action === action);

// 軟體驗證器：一把金鑰可以註冊、驗證（簽章計數每次加一）
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
async function newKey() {
  return { key: await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), credId: crypto.getRandomValues(new Uint8Array(32)), counter: 1 };
}
// 新增通行金鑰：回傳 options 與 verify 的回應（options 被擋下時 verify 是 null）
async function register(cookie, k) {
  const o = await call(cookie, '/passkey/options', { method: 'POST', body: { purpose: 'register' } });
  if (o.status !== 200) return { options: o, verify: null };
  const jwk = await crypto.subtle.exportKey('jwk', k.key.publicKey);
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
  const ad = cat(await sha(te.encode(RP)), new Uint8Array([0x45, 0, 0, 0, k.counter]), new Uint8Array(16), new Uint8Array([0, 32]), k.credId, cbor(cose));
  const cd = te.encode(JSON.stringify({ type: 'webauthn.create', challenge: o.json.publicKey.challenge, origin: BASE }));
  const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const v = await call(cookie, '/passkey/verify', { method: 'POST', body: { cid: o.json.cid, credential: { id: b64u(k.credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(att) } } } });
  return { options: o, verify: v };
}
async function stepup(cookie, k) {
  const op = (await call(cookie, '/passkey/options', { method: 'POST', body: { purpose: 'stepup' } })).json;
  k.counter += 1;
  const a = cat(await sha(te.encode(RP)), new Uint8Array([0x05, 0, 0, 0, k.counter]));
  const c = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: op.publicKey.challenge, origin: BASE }));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key.privateKey, cat(a, await sha(c))));
  const r = await call(cookie, '/passkey/verify', { method: 'POST', body: { cid: op.cid, credential: { id: b64u(k.credId), type: 'public-key', response: { clientDataJSON: b64u(c), authenticatorData: b64u(a), signature: b64u(der(raw)) } } } });
  assert.equal(r.status, 200, r.text);
}
const confirm = (cookie) => call(cookie, '/google/confirm-link', { method: 'POST' });

const B = {};   // 每支 API 這次用掉的 D1 句數（最後一起檢查）
const chairKey = { id: null };
// 通行金鑰每個 IP 10 分鐘 30 次：這裡新增、驗證很多次，每個測試前與結束時清掉（不然接著跑的 passkey.test 會被擋）
const clearPk = async () => { for (const h of IPS) await fetch(`${BASE}/api/dev/rate?key=${encodeURIComponent(`pk:${h}`)}&clear=1`); };
beforeEach(clearPk);
after(async () => {
  await clearPk();
  const chair = await devCookie('t_chair', true);
  await call(chair, '/settings/security', { method: 'POST', body: { require_mfa: false } });
  await call(chair, '/settings/features', { method: 'POST', body: { referral: false } });
  // 這裡替理事長新增的通行金鑰拿掉（其他測試照原本「理事長沒有通行金鑰」的狀態）
  if (chairKey.id) await call(chair, `/passkeys/${encodeURIComponent(chairKey.id)}`, { method: 'DELETE' });
});

test('有通行金鑰綁 Google：先記下待確認 → 沒驗證不能確認 → 用通行金鑰驗證後確認才綁上；稽核記怎麼確認的；只能確認一次', async () => {
  const j = await join('先綁甲'), k = await newKey();
  assert.equal((await register(j.cookie, k)).verify.status, 200, '還沒有通行金鑰：第一把直接新增');
  const sub = `gl_a_${T}`;
  const g = await google({ link: '1', sub, name: '先綁甲' }, j.cookie);
  assert.equal(g.location, '/#/me?google=confirm', '不再擋下（以前是 google=stepup）');
  B.pending = g.d1;
  assert.equal((await me(j.cookie)).google, false, '還沒確認：沒有綁上');
  const no = await confirm(j.cookie);
  assert.equal(no.status, 403);
  assert.equal(no.json.stepup, true, '沒用通行金鑰驗證過：App 會叫出通行金鑰再送一次');
  await stepup(j.cookie, k);
  const ok = await confirm(j.cookie);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { ok: true, result: 'linked', mode: 'L' });
  B.confirm = ok.d1;
  assert.equal((await me(j.cookie)).google, true);
  assert.equal((await confirm(j.cookie)).status, 404, '待確認已經刪掉');
  const lk = (await auditOf('google.link')).filter((r) => r.target_id === j.id);
  assert.deepEqual(lk.map((r) => r.detail), ['綁定 Google（通行金鑰確認）']);
  const back = await google({ sub, name: '先綁甲' });
  assert.equal(back.location, '/#/', 'Google 登入回到同一個帳號');
  assert.equal((await me(back.cookie)).id, j.id);
  // 這次登入 15 分鐘內已經用通行金鑰驗證過：直接綁（稽核註明），不用再確認
  const j2 = await join('先綁乙'), k2 = await newKey();
  await register(j2.cookie, k2);
  await stepup(j2.cookie, k2);
  assert.equal((await google({ link: '1', sub: `gl_a2_${T}` }, j2.cookie)).location, '/#/me?google=linked');
  assert.deepEqual((await auditOf('google.link')).filter((r) => r.target_id === j2.id).map((r) => r.detail), ['綁定 Google（這次登入已用通行金鑰驗證）']);
  // 沒有通行金鑰：照舊直接綁
  const j3 = await join('先綁丙');
  assert.equal((await google({ link: '1', from: 'ref', sub: `gl_a3_${T}` }, j3.cookie)).location, '/#/me/referral?google=linked');
  assert.deepEqual((await auditOf('google.link')).filter((r) => r.target_id === j3.id).map((r) => r.detail), ['綁定 Google（帳號沒有通行金鑰）']);
});

test('待確認：只有發起的那個工作階段能確認、10 分鐘逾時、取消、重新綁定蓋掉舊的；沒登入不能確認', async () => {
  // 別的工作階段（例如偷到登入狀態的人記下自己的 Google 帳號，再騙本人按確認）：就算驗證過也確認不了
  const j = await join('逾時甲'), k = await newKey();
  await register(j.cookie, k);
  assert.equal((await google({ link: '1', sub: `gl_s_${T}` }, j.cookie)).location, '/#/me?google=confirm');
  const other = await devCookie(j.id, true);
  assert.equal((await confirm(other)).status, 404, '另一個工作階段');
  // 取消
  assert.equal((await call(j.cookie, '/google/pending', { method: 'DELETE' })).status, 200);
  await stepup(j.cookie, k);
  assert.equal((await confirm(j.cookie)).status, 404, '取消後沒有待確認');
  assert.equal((await me(j.cookie)).google, false);
  // 逾時
  const j2 = await join('逾時乙'), k2 = await newKey();
  await register(j2.cookie, k2);
  assert.equal((await google({ link: '1', sub: `gl_e_${T}` }, j2.cookie)).location, '/#/me?google=confirm');
  await age(j2.id, 'pending');
  await stepup(j2.cookie, k2);
  const late = await confirm(j2.cookie);
  assert.equal(late.status, 404);
  assert.equal(late.json.expired, true);
  assert.equal((await me(j2.cookie)).google, false);
  // 重新綁定：同一個人只留最新的一筆（UPSERT）
  const j3 = await join('逾時丙'), k3 = await newKey();
  await register(j3.cookie, k3);
  await google({ link: '1', sub: `gl_e1_${T}` }, j3.cookie);
  await google({ link: '1', sub: `gl_e2_${T}` }, j3.cookie);
  await stepup(j3.cookie, k3);
  assert.equal((await confirm(j3.cookie)).json.result, 'linked');
  assert.equal((await me((await google({ sub: `gl_e2_${T}` })).cookie)).id, j3.id, '綁上的是最後一次選的 Google 帳號');
  assert.equal((await google({ sub: `gl_e1_${T}` })).location, '/#/me?welcome=1', '前一次選的沒有綁');
  assert.equal((await call(null, '/google/confirm-link', { method: 'POST' })).status, 401);
  assert.equal((await call(null, '/google/pending', { method: 'DELETE' })).status, 401);
});

test('確認時再檢查一次：這段時間被別人綁走（taken）、自己綁了別的 Google 帳號（other）都不綁', async () => {
  const j = await join('被搶甲'), k = await newKey();
  await register(j.cookie, k);
  const sub = `gl_t_${T}`;
  await google({ link: '1', sub }, j.cookie);
  const other = await google({ sub, name: '先登入的人' });   // 同一個 Google 帳號先登入，開了新帳號
  assert.equal(other.location, '/#/me?welcome=1');
  await stepup(j.cookie, k);
  assert.deepEqual((await confirm(j.cookie)).json, { ok: true, result: 'taken', mode: 'L' });
  assert.equal((await me(j.cookie)).google, false);
  assert.equal((await confirm(j.cookie)).status, 404, '不能再確認');
  // 推薦人頁綁定時已經綁了別的 Google 帳號
  const j2 = await join('換綁甲'), k2 = await newKey();
  await register(j2.cookie, k2);
  assert.equal((await google({ link: '1', from: 'ref', sub: `gl_o1_${T}` }, j2.cookie)).location, '/#/me/referral?google=confirm');
  await stepup(j2.cookie, k2);
  assert.equal((await google({ link: '1', sub: `gl_o2_${T}` }, j2.cookie)).location, '/#/me?google=linked', '驗證過的這 15 分鐘直接綁了另一個');
  assert.deepEqual((await confirm(j2.cookie)).json, { ok: true, result: 'other', mode: 'R' });
  const g = await google({ sub: `gl_o2_${T}` });
  assert.equal((await me(g.cookie)).id, j2.id, '沒有被換綁');
});

test('推薦人頁：待確認確認後寫查詢碼（confirmed）；這段時間關掉「用 Gmail 找到我」就清掉（off）', async () => {
  const chair = await devCookie('t_chair', true);
  assert.equal((await call(chair, '/settings/features', { method: 'POST', body: { referral: true } })).status, 200);
  const j = await join('推薦確認甲'), k = await newKey();
  await register(j.cookie, k);
  const g = await google({ link: '1', from: 'ref', sub: `gl_r_${T}`, email: `gl.r.${T}@gmail.com`, verified: '1' }, j.cookie);
  assert.equal(g.location, '/#/me/referral?google=confirm');
  assert.equal((await me(j.cookie)).referral.emailLinked, false, '確認前沒有查詢碼');
  await stepup(j.cookie, k);
  assert.deepEqual((await confirm(j.cookie)).json, { ok: true, result: 'confirmed', mode: 'R' });
  assert.equal((await me(j.cookie)).referral.emailLinked, true);
  const j2 = await join('推薦確認乙'), k2 = await newKey();
  const found = await call(j2.cookie, '/me/referral/lookup', { method: 'POST', body: { email: `gl.r.${T}@gmail.com` } });
  assert.equal(found.json.found, true, '跑友用 Gmail 找得到');
  await register(j2.cookie, k2);
  await google({ link: '1', from: 'ref', sub: `gl_r2_${T}`, email: `gl.r2.${T}@gmail.com`, verified: '1' }, j2.cookie);
  assert.equal((await call(j2.cookie, '/me/email-findable', { method: 'POST', body: { on: false } })).status, 200);
  await stepup(j2.cookie, k2);
  assert.deepEqual((await confirm(j2.cookie)).json, { ok: true, result: 'off', mode: 'R' });
  assert.equal((await me(j2.cookie)).referral.emailLinked, false);
  assert.equal((await me(j2.cookie)).google, true, 'Google 照樣綁上');
});

test('剛用 Google 登入或重新確認（15 分鐘內）的一般跑友不用舊的通行金鑰就能新增一把；超過就要；稽核註明；新增通行金鑰前用 Google 重新確認（P）', async () => {
  const sub = `gl_p_${T}`;
  const g = await google({ sub, name: '換手機甲' });
  const id = (await me(g.cookie)).id, k1 = await newKey(), k2 = await newKey(), k3 = await newKey();
  assert.equal((await register(g.cookie, k1)).verify.status, 200);
  const r2 = await register(g.cookie, k2);
  assert.equal(r2.options.status, 200, '剛用 Google 登入：不用舊的那一把');
  B.register = r2.options.d1;
  assert.equal(r2.verify.status, 200);
  const adds = (await auditOf('passkey.add')).filter((r) => r.target_id === id).map((r) => r.detail);
  assert.equal(adds.length, 2);
  assert.ok(adds.some((d) => d.endsWith('｜Google 確認後新增')), adds.join(' / '));
  assert.ok(adds.some((d) => !d.includes('Google')), '第一把不用註明');
  // 不是用 Google 登入的工作階段：要先驗證，回應告訴 App 可以用 Google 重新確認
  const plain = await devCookie(id);
  const no = await register(plain, k3);
  assert.equal(no.options.status, 403);
  assert.deepEqual({ stepup: no.options.json.stepup, officer: no.options.json.officer, google: no.options.json.google }, { stepup: true, officer: false, google: true });
  // 用同一個 Google 帳號重新確認（P）：回到帳號與安全、可以新增
  const p = await google({ link: '1', from: 'pk', sub }, plain);
  assert.equal(p.location, '/#/me/security?google=pkok');
  B.pkok = p.d1;
  assert.equal((await register(plain, k3)).verify.status, 200);
  // 超過 15 分鐘：要先用現有的通行金鑰驗證
  await age(id, 'session');
  assert.equal((await register(g.cookie, await newKey())).options.status, 403);
  // P 選到另一個 Google 帳號：不換綁，回到帳號與安全（other）
  assert.equal((await google({ link: '1', from: 'pk', sub: `${sub}_x` }, plain)).location, '/#/me?google=other');
  // 還沒綁 Google 的帳號走 P：跟一般綁定一樣（有通行金鑰就是待確認）
  const j = await join('沒綁甲'), kj = await newKey();
  await register(j.cookie, kj);
  assert.equal((await google({ link: '1', from: 'pk', sub: `gl_pj_${T}` }, j.cookie)).location, '/#/me?google=confirm');
});

test('協會強制兩步驟：幹部用 Google 登入到 #/?mfa=1（沒有通行金鑰 #/?mfa=add）；一般跑友不提示；幹部不能靠 Google 確認新增通行金鑰', async () => {
  const chair = await devCookie('t_chair', true);
  // 理事長要先有通行金鑰才能開啟（這裡新增的，跑完拿掉）
  const ck = await newKey();
  assert.equal((await register(chair, ck)).verify.status, 200);
  chairKey.id = b64u(ck.credId);
  const mk = async (key, role) => {
    const g = await google({ sub: `gl_m_${key}_${T}`, name: `幹部${key}` });
    const id = (await me(g.cookie)).id;
    if (role) assert.equal((await call(chair, `/members/${id}/role`, { method: 'POST', body: { role } })).status, 200);
    return { id, sub: `gl_m_${key}_${T}` };
  };
  const coach = await mk('a', 'coach'), bare = await mk('b', 'coach'), runner = await mk('c', null);
  // 教練先新增一把通行金鑰（還沒開兩步驟）
  const ok = await newKey();
  const c0 = await google({ sub: coach.sub });
  assert.equal(c0.location, '/#/', '還沒開兩步驟：不提示');
  assert.equal((await register(c0.cookie, ok)).verify.status, 200);
  assert.equal((await call(chair, '/settings/security', { method: 'POST', body: { require_mfa: true } })).status, 200);
  const c1 = await google({ sub: coach.sub });
  assert.equal(c1.location, '/#/?mfa=1');
  B.officerLogin = c1.d1;
  assert.equal((await me(c1.cookie)).mfaPending, true, '驗證前只有跑友權限');
  assert.equal((await google({ sub: bare.sub })).location, '/#/?mfa=add', '還沒有通行金鑰');
  assert.equal((await google({ sub: runner.sub })).location, '/#/', '一般跑友不提示');
  // 剛用 Google 登入也不行：幹部一定要用現有的通行金鑰（可以用其他裝置）
  const no = await register(c1.cookie, await newKey());
  assert.equal(no.options.status, 403);
  assert.deepEqual({ officer: no.options.json.officer, google: no.options.json.google }, { officer: true, google: false });
  const noP = await google({ link: '1', from: 'pk', sub: coach.sub }, c1.cookie);
  assert.equal(noP.location, '/#/me/security?google=pkok', '重新確認本身照樣可以做');
  assert.equal((await register(c1.cookie, await newKey())).options.status, 403, '重新確認後幹部照樣要用現有的通行金鑰');
  await stepup(c1.cookie, ok);
  assert.equal((await me(c1.cookie)).mfaPending, false);
  assert.equal((await register(c1.cookie, await newKey())).verify.status, 200, '驗證後可以新增');
  // 分團團長、幹部也算
  const lead = await mk('d', null);
  assert.equal((await call(chair, '/teams/youth/members', { method: 'POST', body: { member_id: lead.id, action: 'add', role: 'officer' } })).status, 200);
  assert.equal((await google({ sub: lead.sub })).location, '/#/?mfa=add');
  assert.equal((await call(chair, '/settings/security', { method: 'POST', body: { require_mfa: false } })).status, 200);
  assert.equal((await google({ sub: coach.sub })).location, '/#/', '關掉後不提示');
});

test('執行額度：每支 API 的 D1 句數在規格內，沒有超過上限', async () => {
  // 待確認 4（登入狀態、設定與會員、有沒有通行金鑰、寫入）｜確認 7（登入狀態、設定、限流、待確認、綁定＋刪除＋稽核）｜
  //   新增通行金鑰的 options 7｜重新確認 4｜幹部登入 6（跟一般 Google 登入一樣，多讀的都在同一句）
  const max = { pending: 4, confirm: 7, register: 7, pkok: 4, officerLogin: 6 };
  for (const [k, n] of Object.entries(max)) assert.ok(B[k] > 0 && B[k] <= n, `${k} 用了 ${B[k]} 句（上限 ${n}）`);
  const v = (await (await fetch(`${BASE}/api/dev/budget-violations`)).json()).list;
  assert.deepEqual(v.filter((x) => /google|passkey/.test(x.name)), []);
});
