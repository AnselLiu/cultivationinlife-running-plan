// 推薦人（推薦族譜）API：功能開關、Google 登入寫查詢碼（同意新版政策才算、關掉找我、別人身上相同的清掉）、用 Gmail 找與設定、
//   「不是我」與冷卻、只填名字、次數限制、開關關閉也能撤回、匯出、刪除帳號、管理後台的權限與稽核、連到帳號、執行額度
//   用 /api/dev/google 模擬 Google 登入（不碰 ID Token 驗證）；跑完把開關關回去（後面的 budget.test 照預設狀態）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8799', RP = new URL(BASE).hostname;
const cookies = {};
async function as(id) {
  if (!cookies[id]) {
    const [uid, flag] = id.split(':');
    const r = await fetch(`${BASE}/api/dev/login?id=${uid}${flag === 'mfa' ? '&mfa=1' : ''}`, { redirect: 'manual' });
    cookies[id] = r.headers.get('set-cookie').split(';')[0];
  }
  return cookies[id];
}
// who：測試帳號 id（t_runner）或 dev/google 拿到的 cookie（__Host-cil_sess=…）
async function call(who, path, { method = 'GET', body } = {}) {
  const headers = { origin: BASE };
  if (who) headers.cookie = who.startsWith('__Host-') ? who : await as(who);
  if (method !== 'GET' && method !== 'DELETE') headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers, d1: Number(/d1=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
// 模擬 Google 登入：回傳導向的位置與新的工作階段 cookie
async function google(params, cookie) {
  const r = await fetch(`${BASE}/api/dev/google?${new URLSearchParams(params)}`, { redirect: 'manual', headers: cookie ? { cookie: cookie.startsWith('__Host-') ? cookie : await as(cookie) } : {} });
  const sess = r.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess='))?.split(';')[0];
  return { status: r.status, location: r.headers.get('location'), cookie: sess, d1: Number(/d1=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
const start = async (qs = '', cookie) => fetch(`${BASE}/api/google/start${qs}`, { redirect: 'manual', headers: cookie ? { cookie: await as(cookie) } : {} });
const scopeOf = (r) => new URL(r.headers.get('location')).searchParams.get('scope');
const me = async (who) => (await call(who, '/me')).json.member;
const setFeature = async (on) => assert.equal((await call('t_chair', '/settings/features', { method: 'POST', body: { referral: on } })).json.value.referral, on);
const rate = (key, extra) => fetch(`${BASE}/api/dev/rate?key=${encodeURIComponent(key)}&${extra}`).then((r) => r.json());
// IP 的雜湊：本機沒有 cf-connecting-ip 時是 'local'；保險起見幾個候選都處理
const IPS = ['local', '127.0.0.1', '::1', '::ffff:127.0.0.1'].map((ip) => createHash('sha256').update(`${ip}|test-salt`).digest('hex').slice(0, 16));
async function resetLookups(...ids) {
  for (const id of ids) for (const k of [`reflk:${id}`, `reflkb:${id}`, `refset:${id}`]) await rate(k, 'clear=1');
  for (const h of IPS) for (const k of [`reflkip:${h}`, `reflkipb:${h}`]) await rate(k, 'clear=1');
}
// 稽核查詢的 action 會去掉 _（LIKE 萬用字元），用 _ 前面那段當前綴再精確比對
const auditOf = async (action) => (await call('t_chair', `/audit?action=${action.split('_')[0]}`)).json.items.filter((r) => r.action === action);
const notes = async (who) => (await call(who, '/notifications?cat=membership')).json.items;
// 軟體驗證器：新增一把通行金鑰（同 tests/passkey.test.mjs）
const te = new TextEncoder(), b64u = (b) => Buffer.from(b).toString('base64url'), unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const head = (mt, n) => (n < 24 ? [mt << 5 | n] : n < 256 ? [mt << 5 | 24, n] : [mt << 5 | 25, n >> 8, n & 255]);
function cbor(v) {
  if (typeof v === 'number') return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = te.encode(v); return cat(new Uint8Array(head(3, b.length)), b); }
  if (v instanceof Uint8Array) return cat(new Uint8Array(head(2, v.length)), v);
  return cat(new Uint8Array(head(5, v.size)), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}
async function addPasskey(who) {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey), credId = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(RP)));
  const o = (await call(who, '/passkey/options', { method: 'POST', body: { purpose: 'register' } })).json;
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
  const ad = cat(rpHash, new Uint8Array([0x45, 0, 0, 0, 1]), new Uint8Array(16), new Uint8Array([0, 32]), credId, cbor(cose));
  const cd = te.encode(JSON.stringify({ type: 'webauthn.create', challenge: o.publicKey.challenge, origin: BASE }));
  const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const r = await call(who, '/passkey/verify', { method: 'POST', body: { cid: o.cid, credential: { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(att) } } } });
  assert.equal(r.status, 200, r.text);
}

const B = {};   // 每支 API 這次用掉的 D1 句數（最後一起檢查）
const S = {};   // 測試裡建立的帳號：{ cookie, id }
async function account(key, params) {
  const g = await google(params);
  assert.equal(g.status, 302);
  assert.ok(g.cookie, `${key} 登入失敗：${g.location}`);
  S[key] = { cookie: g.cookie, id: (await me(g.cookie)).id, location: g.location };
  return S[key];
}

after(async () => {
  await call('t_chair', '/settings/features', { method: 'POST', body: { referral: false } });
  await call('t_chair:mfa', '/settings/security', { method: 'POST', body: { require_mfa: false } });
});

test('開關關閉：Google 只要 openid profile；查詢與設定 403，移除、確認、找我開關與查看照常；打開後加 email 範圍', async () => {
  assert.equal(scopeOf(await start()), 'openid profile');
  assert.equal((await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'a@gmail.com' } })).status, 403);
  assert.equal((await call('t_other', '/me/referral', { method: 'PUT', body: { name: '王大明' } })).json.error, '推薦人功能目前沒有開放');
  assert.equal((await call('t_other', '/me/referral', { method: 'DELETE' })).status, 200);
  assert.equal((await call('t_other', '/me/email-findable', { method: 'POST', body: { on: true } })).status, 200);
  const g = await call('t_other', '/me/referral');
  assert.equal(g.status, 200);
  assert.equal(g.json.on, false);
  assert.equal((await call('t_other', '/me/referral/ack', { method: 'POST', body: { member_id: 't_runner', ok: false } })).status, 404, '不受開關影響（只是沒有這筆推薦）');
  await setFeature(true);
  assert.equal(scopeOf(await start()), 'openid profile email');
  const sr = await start(); B.start = Number(/d1=(\d+)/.exec(sr.headers.get('x-budget'))[1]);
  assert.equal(scopeOf(await start('?basic=1')), 'openid profile', '只用名稱與大頭貼登入');
  const lr = await start('?link=1&from=ref', 't_runner');
  assert.match(lr.headers.get('set-cookie'), /__Host-cil_oauth=\w+\.\w+\.R;/);
  B.startLink = Number(/d1=(\d+)/.exec(lr.headers.get('x-budget'))[1]);
  assert.match((await start('?link=1', 't_runner')).headers.get('set-cookie'), /__Host-cil_oauth=\w+\.\w+\.L;/);
  assert.doesNotMatch((await start('?link=1&from=ref')).headers.get('set-cookie'), /\.[LR];/, '沒登入不能進綁定模式');
});

test('Google 登入寫查詢碼：Email 驗證過才寫（布林或字串 true）、沒給 Email 不動、改成沒驗證就清掉', async () => {
  const a = await account('recA', { sub: 'g_rec', email: 'Rec.One+run@gmail.com', verified: '1', name: '推薦人甲' });
  assert.equal(a.location, '/#/me?welcome=1');
  assert.deepEqual((await me(a.cookie)).referral, { has: false, pending: 0, hide: 0, findable: true, emailLinked: true });
  const u = await account('unv', { sub: 'g_unv', email: 'unv@gmail.com', verified: '0', name: '未驗證' });
  assert.equal((await me(u.cookie)).referral.emailLinked, false);
  const s = await account('str', { sub: 'g_str', email: 'str@gmail.com', verified: 'str', name: '字串驗證' });
  assert.equal((await me(s.cookie)).referral.emailLinked, true);
  const again = await google({ sub: 'g_str', name: '字串驗證' });
  assert.equal(again.location, '/#/');
  assert.equal((await me(again.cookie)).referral.emailLinked, true, '沒給 Email（只用名稱與大頭貼）：不動');
  B.devLogin = again.d1;
  const off = await google({ sub: 'g_str', email: 'str@gmail.com', verified: '0' });
  assert.equal((await me(off.cookie)).referral.emailLinked, false, 'Email 沒驗證：清掉');
  assert.equal((await me(off.cookie)).name, '字串驗證', '名字不會被改掉');
});

test('同意新版政策才算查詢碼；推薦人頁的「用 Google 確認」回到推薦人頁；同一個 Google 帳號不用通行金鑰驗證、第一次綁才要（先記下待確認）；已經綁了別的不換綁', async () => {
  assert.equal((await call('t_runner', '/me')).json.needConsent, true, 't_runner 的同意版本是舊的');
  const later = await google({ link: '1', from: 'ref', sub: 'g_run', email: 'run@gmail.com', verified: '1' }, 't_runner');
  assert.equal(later.location, '/#/me/referral?google=later');
  const m0 = await me('t_runner');
  assert.equal(m0.referral.emailLinked, false);
  assert.equal(m0.google, true, 'Google 照樣綁上');
  assert.equal((await call('t_runner', '/me/consent', { method: 'POST' })).status, 200);
  const ok = await google({ link: '1', from: 'ref', sub: 'g_run', email: 'run@gmail.com', verified: '1' }, 't_runner');
  assert.equal(ok.location, '/#/me/referral?google=confirmed');
  B.link = ok.d1;
  assert.equal((await me('t_runner')).referral.emailLinked, true);
  const ref = await auditOf('google.refresh');
  assert.ok(ref.some((r) => r.target_id === 't_runner' && r.detail === '查詢碼已更新'));
  assert.ok(!JSON.stringify(ref).includes('@'), '稽核不放 Email');
  // 有通行金鑰、工作階段沒驗證過
  const pk = await account('pk', { sub: 'g_pk', name: '有金鑰' });
  await addPasskey(pk.cookie);
  assert.equal((await google({ link: '1', sub: 'g_pk', email: 'pk@gmail.com', verified: '1' }, pk.cookie)).location, '/#/me?google=linked', '同一個 Google 帳號');
  assert.equal((await google({ link: '1', from: 'ref', sub: 'g_rec' }, pk.cookie)).location, '/#/me/referral?google=taken');
  // 已經綁了 Google、帳號選擇畫面選到另一個：不換綁（不然原本那個 Google 帳號登入會開出空的新帳號），有沒有通行金鑰都一樣
  assert.equal((await google({ link: '1', from: 'ref', sub: 'g_pk2' }, pk.cookie)).location, '/#/me/referral?google=other', '換另一個 Google 帳號');
  const np = await account('nopk', { sub: 'g_nopk', email: 'nopk@gmail.com', verified: '1', name: '沒有金鑰' });
  for (const params of [{ link: '1', from: 'ref' }, { link: '1' }]) {
    const r = await google({ ...params, sub: 'g_nopk_b', email: 'nopk.b@gmail.com', verified: '1' }, np.cookie);
    assert.equal(r.location, params.from ? '/#/me/referral?google=other' : '/#/me?google=other');
  }
  const back = await google({ sub: 'g_nopk', name: '沒有金鑰' });
  assert.equal(back.location, '/#/', '原本的 Google 帳號照樣登入原本的帳號');
  assert.equal((await me(back.cookie)).id, np.id);
  assert.equal((await me(back.cookie)).referral.emailLinked, true, '查詢碼沒有被換成另一個 Gmail 的');
  // 還沒綁 Google、有通行金鑰：第一次綁要先驗證
  for (const h of IPS) await rate(`join:${h}`, 'clear=1');
  const j = await call(null, '/join', { method: 'POST', body: { code: 'test-join', name: '邀請碼加入', consent: true } });
  assert.equal(j.status, 200, j.text);
  const jc = j.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess=')).split(';')[0];
  await addPasskey(jc);
  assert.equal((await google({ link: '1', from: 'ref', sub: 'g_join' }, jc)).location, '/#/me/referral?google=confirm', '第一次綁 Google：先記下，用通行金鑰確認才綁（tests/google-link.test.mjs）');
});

test('用 Gmail 找：全形、googlemail、大小寫都找得到；只回遮罩名字與暱稱；找不到、關掉找我都是同一個回應；自己', async () => {
  await resetLookups('t_other', S.recA.id);
  for (const email of ['ＲＥＣ．ＯＮＥ＠ＧＭＡＩＬ．ＣＯＭ', 'recone@googlemail.com']) {
    const r = await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email } });
    assert.deepEqual(r.json, { found: true, name: '推○○甲', nickname: '' });
    assert.deepEqual(Object.keys(r.json), ['found', 'name', 'nickname']);
    assert.ok(!r.text.includes(S.recA.id) && !r.text.includes('@'));
    B.lookup = r.d1;
  }
  assert.equal((await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'nobody@gmail.com' } })).text, '{"found":false}');
  assert.equal((await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'not-an-email' } })).status, 400);
  const o = await account('off', { sub: 'g_off', email: 'off@gmail.com', verified: '1', name: '關掉找我' });
  const f = await call(o.cookie, '/me/email-findable', { method: 'POST', body: { on: false } });
  assert.deepEqual(f.json, { ok: true, findable: false, emailLinked: false });
  assert.equal((await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'off@gmail.com' } })).text, '{"found":false}');
  assert.deepEqual((await call(S.recA.cookie, '/me/referral/lookup', { method: 'POST', body: { email: 'rec.one@gmail.com' } })).json, { found: true, self: true });
  const lk = await auditOf('referrer.lookup');
  assert.ok(lk.some((r) => r.detail === 'found') && lk.some((r) => r.detail === 'none') && lk.some((r) => r.detail === 'self'));
  assert.ok(!JSON.stringify(lk).includes('@'));
});

test('關掉找我會一直保持：再用 Google 登入也不產生；打開後要再登入一次才有；稽核有關閉與開啟', async () => {
  const o = S.off;
  const ex = await call(o.cookie, '/me/export');
  assert.equal(ex.json.referral.gmail_lookup_code_stored, false);
  assert.equal(ex.json.referral.gmail_findable, false);
  const again = await google({ sub: 'g_off', email: 'off@gmail.com', verified: '1' });
  assert.deepEqual((await me(again.cookie)).referral, { has: false, pending: 0, hide: 0, findable: false, emailLinked: false });
  assert.equal((await call(o.cookie, '/me/email-findable', { method: 'POST', body: { on: true } })).json.emailLinked, false);
  assert.equal((await me(o.cookie)).referral.emailLinked, false, '打開不會恢復');
  const back = await google({ sub: 'g_off', email: 'off@gmail.com', verified: '1' });
  assert.equal((await me(back.cookie)).referral.emailLinked, true);
  const rows = (await auditOf('privacy.email_lookup')).filter((r) => r.target_id === o.id).map((r) => r.detail);
  assert.deepEqual([...rows].sort(), ['開啟', '關閉'].sort(), '一筆關閉、一筆開啟（同一秒的順序照隨機 id，不比順序）');
});

test('同一個查詢碼換到另一個帳號：後登入的找得到，前一個清掉', async () => {
  await resetLookups('t_other');
  const s1 = await account('s1', { sub: 'g_s', email: 'shared@example.com', verified: '1', name: '舊帳號' });
  const s2 = await account('s2', { sub: 'g_t', email: 'Shared@Example.com', verified: '1', name: '新帳號' });
  assert.deepEqual((await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'shared@example.com' } })).json, { found: true, name: '新○號', nickname: '' });
  assert.equal((await me(s1.cookie)).referral.emailLinked, false);
  assert.equal((await me(s2.cookie)).referral.emailLinked, true);
});

test('用 Gmail 設定推薦人：對方收到通知（推播不含名字）、待確認數、稽核不含 Email；我看到遮罩的名字', async () => {
  await resetLookups('t_runner');
  const ep = 'https://fcm.googleapis.com/fcm/send/ref_recA';
  assert.equal((await call(S.recA.cookie, '/push/subscribe', { method: 'POST', body: { endpoint: ep, keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) } } })).status, 200);
  const r = await call('t_runner', '/me/referral', { method: 'PUT', body: { email: 'rec.one@gmail.com' } });
  assert.equal(r.status, 200, r.text);
  B.putEmail = r.d1;
  assert.equal(r.json.referrer.kind, 'member');
  const n = (await notes(S.recA.cookie)).find((x) => x.ref === 'rf:t_runner');
  assert.equal(n.title, '有跑友把你設為推薦人');
  assert.equal(n.category, 'membership');
  assert.equal(n.url, '/#/me/referral');
  assert.match(n.body, /^測試跑友（跑友） 把你設為推薦人/);
  await fetch(`${BASE}/api/dev/drain`);
  const pushed = (await (await fetch(`${BASE}/api/dev/push-mock`)).json()).list.filter((x) => x.endpoint === ep);
  assert.ok(pushed.length >= 1);
  assert.ok(pushed.every((x) => x.text === '有跑友把你設為推薦人｜點開確認是不是你認識的人'), '鎖定畫面不含名字');
  assert.equal((await me(S.recA.cookie)).referral.pending, 1);
  const set = (await auditOf('referrer.set')).find((x) => x.target_id === 't_runner');
  assert.match(set.detail, /^account｜to=[\w-]+$/);
  const g = (await call('t_runner', '/me/referral')).json;
  assert.deepEqual({ ...g.referrer, at: undefined }, { kind: 'member', name: '推○○甲', nickname: '', at: undefined, by: 'self', ack: null });
  assert.equal((await me('t_runner')).referral.has, true);
  const mine = (await call(S.recA.cookie, '/me/referral')).json.referred;
  assert.deepEqual(mine.map((x) => [x.id, x.name, x.ack]), [['t_runner', '測試跑友', null]], '推薦人看得到全名');
  assert.equal((await call('t_runner', '/me/referral', { method: 'PUT', body: { email: 'rec.one@gmail.com' } })).json.unchanged, true);
});

test('推薦人不能是自己、不能成環（兩層、三層）', async () => {
  await resetLookups('t_runner', S.recA.id);
  assert.equal((await call('t_runner', '/me/referral', { method: 'PUT', body: { email: 'run@gmail.com' } })).json.error, '推薦人要填別人喔');
  const cyc = await call(S.recA.cookie, '/me/referral', { method: 'PUT', body: { email: 'run@gmail.com' } });
  assert.equal(cyc.status, 409);
  assert.match(cyc.json.error, /在你的推薦關係裡/);
  const c3 = await account('c3', { sub: 'g_c3', email: 'c3@gmail.com', verified: '1', name: '第三層' });
  assert.equal((await call(c3.cookie, '/me/referral', { method: 'PUT', body: { email: 'run@gmail.com' } })).status, 200);
  await resetLookups(S.recA.id);
  assert.equal((await call(S.recA.cookie, '/me/referral', { method: 'PUT', body: { email: 'c3@gmail.com' } })).status, 409, 'c3 → 跑友 → 推薦人甲');
  assert.equal((await call(S.recA.cookie, '/me/referral', { method: 'PUT', body: { email: 'nobody@gmail.com' } })).json.error, '找不到這個 Gmail');
});

test('「不是我」：移除、通知對方、我的那則標已讀、180 天內同一對不能再綁（只填名字可以）；確認', async () => {
  await resetLookups('t_runner');
  const d = await call(S.recA.cookie, '/me/referral/ack', { method: 'POST', body: { member_id: 't_runner', ok: false } });
  assert.equal(d.status, 200, d.text);
  B.deny = d.d1;
  const g = (await call('t_runner', '/me/referral')).json;
  assert.equal(g.referrer, null);
  assert.equal(g.denied, true);
  const n = (await notes('t_runner')).find((x) => x.title === '推薦人沒有確認');
  assert.match(n.body, /^推○○甲 表示不認識你的帳號/);
  assert.equal(n.ref, `rf:${S.recA.id}`);
  assert.ok((await notes(S.recA.cookie)).find((x) => x.ref === 'rf:t_runner').read_at, '推薦人那則標已讀');
  assert.equal((await me(S.recA.cookie)).referral.pending, 0);
  const again = await call('t_runner', '/me/referral', { method: 'PUT', body: { email: 'rec.one@gmail.com' } });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /之前表示不認識你的帳號/);
  const nm = await call('t_runner', '/me/referral', { method: 'PUT', body: { name: '王大明' } });
  assert.equal(nm.status, 200);
  B.putName = nm.d1;
  const den = (await auditOf('referrer.deny'))[0];
  assert.deepEqual([den.actor_name, den.target_id], ['推薦人甲', 't_runner']);
  // 確認：c3 的推薦人是跑友
  assert.equal((await me('t_runner')).referral.pending, 1);
  assert.equal((await call('t_runner', '/me/referral/ack', { method: 'POST', body: { member_id: S.c3.id, ok: true } })).json.ack, 'ok');
  assert.equal((await me('t_runner')).referral.pending, 0);
  assert.equal((await auditOf('referrer.ack'))[0].target_id, S.c3.id);
  assert.equal((await call('t_runner', '/me/referral/ack', { method: 'POST', body: { member_id: 't_other', ok: true } })).status, 404, '不是他的推薦人');
});

test('只填名字：1–20 字，不收 Email、電話、網址；不寫通知', async () => {
  const before = (await (await fetch(`${BASE}/api/dev/notes?like=${encodeURIComponent('有跑友')}`)).json()).rows;
  for (const name of ['', 'x'.repeat(21), 'a@b.com', '0912345678', 'https://x']) {
    assert.equal((await call('t_other', '/me/referral', { method: 'PUT', body: { name } })).status, 400, name);
  }
  const r = await call('t_other', '/me/referral', { method: 'PUT', body: { name: ' 王大明 ' } });
  assert.deepEqual({ ...r.json.referrer, at: undefined }, { kind: 'name', name: '王大明', at: undefined, by: 'self' });
  assert.equal((await (await fetch(`${BASE}/api/dev/notes?like=${encodeURIComponent('有跑友')}`)).json()).rows, before);
  assert.equal((await auditOf('referrer.set')).find((x) => x.target_id === 't_other').detail, 'name', '名字本身不記');
});

test('次數限制：每人每天、10 分鐘、同一個 IP（換帳號也算）、每天改推薦人、推薦人每天被綁；被擋的不寫稽核', async () => {
  await resetLookups('t_other', 't_coach');
  await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'nobody@gmail.com' } });
  const real = [];
  for (const h of IPS) if ((await rate(`reflkip:${h}`, 'get=1')).count != null) real.push(h);
  assert.equal(real.length, 1, '找到這台機器的 IP 雜湊');
  const n0 = (await auditOf('referrer.lookup')).length;
  await rate('reflk:t_other', 'count=21&sec=86400');
  const day = await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'nobody@gmail.com' } });
  assert.deepEqual([day.status, day.json.error], [429, '今天查詢的次數已達上限，明天再試']);
  assert.equal((await auditOf('referrer.lookup')).length, n0, '被擋的不寫稽核');
  await rate('reflk:t_other', 'clear=1');
  await rate('reflkb:t_other', 'count=7&sec=600');
  assert.equal((await call('t_other', '/me/referral/lookup', { method: 'POST', body: { email: 'nobody@gmail.com' } })).json.error, '查詢太頻繁，請 10 分鐘後再試');
  await rate('reflkb:t_other', 'clear=1');
  await rate(`reflkip:${real[0]}`, 'count=61&sec=86400');
  const ip = await call('t_coach', '/me/referral/lookup', { method: 'POST', body: { email: 'nobody@gmail.com' } });
  assert.deepEqual([ip.status, ip.json.error], [429, '今天查詢的次數已達上限，明天再試'], '換帳號查也擋');
  await resetLookups('t_other', 't_coach');
  await rate('refset:t_other', 'count=7&sec=86400');
  assert.equal((await call('t_other', '/me/referral', { method: 'PUT', body: { name: '李小明' } })).json.error, '今天改推薦人的次數已達上限，明天再試');
  await rate('refset:t_other', 'clear=1');
  await rate(`refin:${S.recA.id}`, 'count=11&sec=86400');
  assert.equal((await call('t_other', '/me/referral', { method: 'PUT', body: { email: 'rec.one@gmail.com' } })).json.error, '這位跑友今天收到太多確認了，明天再試');
  await rate(`refin:${S.recA.id}`, 'clear=1');
  await rate('refack:t_other', 'count=61&sec=3600');
  assert.equal((await call('t_other', '/me/referral/ack', { method: 'POST', body: { member_id: 't_runner', ok: true } })).status, 429);
  await rate('refack:t_other', 'clear=1');
  await resetLookups('t_other');
});

test('開關關閉也能撤回：移除推薦人、「不是我」、關掉找我；首頁卡片收起', async () => {
  await setFeature(false);
  try {
    const del = await call('t_runner', '/me/referral', { method: 'DELETE' });
    assert.deepEqual(del.json, { ok: true, cleared: true });
    assert.equal((await auditOf('referrer.clear'))[0].target_id, 't_runner');
    assert.equal((await call('t_runner', '/me/referral/ack', { method: 'POST', body: { member_id: S.c3.id, ok: false } })).status, 200);
    assert.equal((await call('t_runner', '/me/email-findable', { method: 'POST', body: { on: true } })).status, 200);
    assert.equal((await call('t_runner', '/me/referral', { method: 'PUT', body: { name: '王大明' } })).status, 403);
  } finally { await setFeature(true); }
  assert.equal((await call('t_runner', '/me/referral/hide', { method: 'POST', body: { bits: 4 } })).status, 400);
  assert.equal((await call('t_runner', '/me/referral/hide', { method: 'POST', body: { bits: 1 } })).json.hide, 1);
  assert.equal((await call('t_runner', '/me/referral/hide', { method: 'POST', body: { bits: 2 } })).json.hide, 3);
  assert.equal((await me('t_runner')).referral.hide, 3);
});

test('匯出：推薦人名字遮罩、推薦我的只有人數，不含查詢碼、推薦人 id 與工作階段欄位', async () => {
  await resetLookups();
  const e1 = await account('e1', { sub: 'g_e1', email: 'e1@gmail.com', verified: '1', name: '匯出者' });
  assert.equal((await call(e1.cookie, '/me/referral', { method: 'PUT', body: { email: 'rec.one@gmail.com' } })).status, 200);
  const ex = await call(e1.cookie, '/me/export');
  for (const k of ['email_h', 'referrer_id', 's_refq', 's_pq', 'team_officer', 'referral_hide', S.recA.id]) assert.ok(!ex.text.includes(k), k);
  assert.deepEqual({ ...ex.json.referral.recommender, set_at: undefined }, { kind: 'member', name: '推○○甲', nickname: '', status: 'pending', set_at: undefined, set_by: 'self' });
  assert.equal(ex.json.referral.gmail_findable, true);
  assert.equal(ex.json.referral.gmail_lookup_code_stored, true);
  const rx = await call(S.recA.cookie, '/me/export');
  assert.equal(rx.json.referral.referred_me, 1);
  assert.ok(!rx.text.includes(e1.id), '我推薦的跑友 id 不匯出');
});

test('推薦人刪除帳號：被推薦的人看到「推薦人已刪除帳號」（不留名字），提到他的推薦通知一起刪掉', async () => {
  await resetLookups();
  const r2 = await account('r2', { sub: 'g_r2', email: 'r2@gmail.com', verified: '1', name: '要刪的推薦人' });
  const k1 = await account('k1', { sub: 'g_k1', email: 'k1@gmail.com', verified: '1', name: '甲跑友' });
  const k2 = await account('k2', { sub: 'g_k2', email: 'k2@gmail.com', verified: '1', name: '乙跑友' });
  for (const k of [k1, k2]) assert.equal((await call(k.cookie, '/me/referral', { method: 'PUT', body: { email: 'r2@gmail.com' } })).status, 200);
  assert.equal((await call(r2.cookie, '/me/referral/ack', { method: 'POST', body: { member_id: k2.id, ok: false } })).status, 200);
  assert.ok((await notes(k2.cookie)).some((x) => x.ref === `rf:${r2.id}`));
  assert.equal((await call(r2.cookie, '/me', { method: 'DELETE' })).status, 200);
  const g = await call(k1.cookie, '/me/referral');
  assert.deepEqual(g.json.referrer, { kind: 'gone' });
  assert.ok(!g.text.includes('要刪的推薦人') && !g.text.includes('要○○○人'));
  assert.equal((await me(k1.cookie)).referral.has, true);
  assert.ok(!(await notes(k2.cookie)).some((x) => x.ref === `rf:${r2.id}`), '「不是我」那則一起刪');
});

test('推薦族譜（管理後台）：會員管理權限才看得到、監事唯讀、電話依權限、每次查看都有稽核', async () => {
  for (const who of ['t_runner', 't_coach']) {
    assert.equal((await call(who, '/admin/referrals')).json.error, '只有會員管理權限的幹部可以看推薦族譜');
    assert.equal((await call(who, `/admin/referrals/tree?id=${S.recA.id}`)).status, 403);
    assert.equal((await call(who, '/admin/referrals/named?name=王大明')).status, 403);
    assert.equal((await call(who, '/admin/referrals/relink', { method: 'POST', body: { name: '王大明', to: S.recA.id } })).status, 403);
    assert.equal((await call(who, '/admin/referrals/clear', { method: 'POST', body: { member_id: 't_other' } })).status, 403);
  }
  assert.equal((await call(S.recA.cookie, '/me', { method: 'PUT', body: { phone: '0912345678' } })).status, 200);
  const none = await call('t_staff', '/admin/referrals');
  assert.equal(none.json.needFilter, true);
  assert.ok(none.json.summary.total > 0 && 'linked' in none.json.summary);
  assert.equal((await call('t_staff', `/admin/referrals?q=${encodeURIComponent('測'.repeat(20))}`)).status, 200, '20 個中文字（不用 LIKE）');
  const s = await call('t_staff', `/admin/referrals?q=${encodeURIComponent('推薦人甲')}`);
  B.search = s.d1;
  const hit = s.json.members.find((x) => x.id === S.recA.id);
  assert.equal(hit.kids, 1);
  assert.equal(hit.referrer, null);
  assert.ok(!s.text.includes('0912'), '搜尋結果沒有電話');
  const names = (await call('t_staff', `/admin/referrals?q=${encodeURIComponent('王大')}`)).json.names;
  assert.ok(names.some((x) => x.name === '王大明'));
  const t = await call('t_staff', `/admin/referrals/tree?id=${S.e1.id}&down=2`);
  B.tree = t.d1;
  assert.deepEqual(t.json.up.map((r) => [r.d, r.id, r.phone]), [[1, S.recA.id, '0912345678']]);
  assert.equal(t.json.node.referrer.kind, 'member');
  const td = await call('t_super', `/admin/referrals/tree?id=${S.recA.id}`);
  assert.equal(td.status, 200);
  assert.equal(td.json.node.phone, '0912***678', '監事看到遮罩');
  assert.deepEqual(td.json.down.map((r) => [r.d, r.id, r.kids]), [[1, S.e1.id, 0]]);
  assert.ok(td.json.down.every((r) => !('phone' in r)), '下層不給電話');
  assert.equal(td.json.downMore, false);
  assert.equal((await call('t_super', '/admin/referrals/relink', { method: 'POST', body: { name: '王大明', to: S.recA.id } })).json.error, '監事只能查看，不能修改推薦人');
  assert.equal((await call('t_super', '/admin/referrals/clear', { method: 'POST', body: { member_id: 't_other' } })).status, 403);
  assert.equal((await call('t_staff', '/admin/referrals/tree?id=nobody')).status, 404);
  const views = await auditOf('referrer.view');
  assert.ok(views.some((r) => r.detail === 'search｜n=1') || views.some((r) => /^search｜n=\d+$/.test(r.detail)));
  assert.ok(views.some((r) => r.target_id === S.recA.id && /^tree｜up=0｜down=1$/.test(r.detail)));
  assert.ok(!JSON.stringify(views).includes('推薦人甲'), '不記查詢文字');
  await rate('refv:t_staff', 'count=121&sec=3600');
  assert.equal((await call('t_staff', '/admin/referrals')).status, 429);
  await rate('refv:t_staff', 'clear=1');
  // 幹部強制兩步驟驗證：沒驗證的理事長當一般跑友
  await addPasskey(await as('t_chair:mfa'));
  assert.equal((await call('t_chair:mfa', '/settings/security', { method: 'POST', body: { require_mfa: true } })).status, 200);
  try {
    assert.equal((await call('t_chair', '/admin/referrals')).status, 403);
    assert.equal((await call('t_chair:mfa', '/admin/referrals')).status, 200);
  } finally {
    assert.equal((await call('t_chair:mfa', '/settings/security', { method: 'POST', body: { require_mfa: false } })).status, 200);
  }
});

test('把「只填名字」連到跑友帳號：每人各一則通知、推薦人一則、每人一列稽核；會成環的跳過；幹部移除推薦人', async () => {
  await resetLookups();
  const n1 = await account('n1', { sub: 'g_n1', name: '名字一' });
  assert.equal((await call(n1.cookie, '/me/referral', { method: 'PUT', body: { name: '王大明' } })).status, 200);
  const named = await call('t_staff', `/admin/referrals/named?name=${encodeURIComponent('王大明')}`);
  assert.deepEqual(named.json.members.map((r) => r.id).sort(), [n1.id, 't_other'].sort());
  const rl = await call('t_staff', '/admin/referrals/relink', { method: 'POST', body: { name: '王大明', to: S.recA.id } });
  assert.deepEqual(rl.json, { linked: 2, skipped: 0 });
  B.relink = rl.d1;
  for (const who of [n1.cookie, 't_other']) {
    const g = (await call(who, '/me/referral')).json.referrer;
    assert.deepEqual([g.kind, g.by, g.ack], ['member', 'admin', null]);
    assert.ok((await notes(who)).some((x) => x.title === '推薦人已連到帳號' && x.body.includes('「王大明」')));
  }
  assert.ok((await notes(S.recA.cookie)).some((x) => x.title === '有跑友把你設為推薦人' && x.body.includes('2 位')));
  assert.equal((await auditOf('referrer.relink')).filter((r) => r.detail === `｜to=${S.recA.id}`).length, 2);
  assert.equal((await call('t_staff', '/admin/referrals/relink', { method: 'POST', body: { name: '王大明', to: S.recA.id } })).status, 409, '已經連過了');
  assert.equal((await call('t_staff', '/admin/referrals/relink', { method: 'POST', body: { name: '王大明', to: 'nobody' } })).status, 400);
  // 連到其中一位的下層：那一位跳過
  const n2 = await account('n2', { sub: 'g_n2', email: 'n2@gmail.com', verified: '1', name: '名字二' });
  const n3 = await account('n3', { sub: 'g_n3', name: '名字三' });
  const d1 = await account('d1', { sub: 'g_d1', name: '下層' });
  for (const n of [n2, n3]) assert.equal((await call(n.cookie, '/me/referral', { method: 'PUT', body: { name: '李小明' } })).status, 200);
  assert.equal((await call(d1.cookie, '/me/referral', { method: 'PUT', body: { email: 'n2@gmail.com' } })).status, 200);
  assert.deepEqual((await call('t_staff', '/admin/referrals/relink', { method: 'POST', body: { name: '李小明', to: d1.id, member_ids: [n2.id, n3.id] } })).json, { linked: 1, skipped: 1 });
  assert.equal((await call('t_staff', '/admin/referrals/relink', { method: 'POST', body: { name: '李小明', to: d1.id, member_ids: ["x' OR 1=1"] } })).status, 400);
  // 幹部移除推薦人：原推薦人那則「有跑友把你設為推薦人」一起標成已讀（跟本人移除一樣）
  const rfOf = async () => (await notes(n2.cookie)).find((x) => x.ref === `rf:${d1.id}`);
  const rf0 = await rfOf();
  assert.ok(rf0 && !rf0.read_at, 'd1 用 Gmail 設 n2 為推薦人：n2 有一則未讀');
  assert.equal((await call('t_staff', '/admin/referrals/clear', { method: 'POST', body: { member_id: d1.id } })).status, 200);
  assert.ok((await rfOf()).read_at, '幹部移除後標成已讀');
  const c = await call('t_staff', '/admin/referrals/clear', { method: 'POST', body: { member_id: n1.id } });
  assert.equal(c.status, 200);
  assert.equal((await call(n1.cookie, '/me/referral')).json.referrer, null);
  assert.ok((await notes(n1.cookie)).some((x) => x.title === '推薦人已移除'));
  const ac = (await auditOf('referrer.admin_clear')).map((r) => r.target_id);
  assert.ok(ac.includes(n1.id) && ac.includes(d1.id));
  assert.equal((await call('t_staff', '/admin/referrals/clear', { method: 'POST', body: { member_id: n1.id } })).status, 404, '沒有可以移除的');
});

test('執行額度：每支 API 的 D1 句數在規格內，沒有超過上限', async () => {
  const meD1 = (await call('t_other', '/me')).d1;
  assert.ok(meD1 >= 2 && meD1 <= 7, `GET /me ${meD1}`);   // 待確認數算在 currentMember 那一句裡，沒有多一句
  const max = { start: 1, startLink: 2, devLogin: 6, link: 5, lookup: 12, putEmail: 19, putName: 6, deny: 9, search: 7, tree: 7, relink: 10 };
  for (const [k, n] of Object.entries(max)) assert.ok(B[k] > 0 && B[k] <= n, `${k} 用了 ${B[k]} 句（上限 ${n}）`);
  const v = (await (await fetch(`${BASE}/api/dev/budget-violations`)).json()).list;
  assert.deepEqual(v.filter((x) => /referral|google|me\b/.test(x.name)), []);
});
