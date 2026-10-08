// 成績與挑戰 API（規格 §19.3）：開關、登錄與審核、修改與刪除、截圖、核准快照、挑戰的建立與發布與資格、六種達成條件、結算與團服、
//   體重見證與榮譽制、恭喜榜、隱私開關、匯出與刪除帳號、稽核與推播不含個資、待處理摘要、CSV
//   跑完把開關關回去、取消還開著的挑戰、清掉成績與挑戰的資料（後面的 budget.test 照預設狀態，排程不會多出結算工作）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8799';
const cookies = {};
async function as(id) {
  if (!cookies[id]) {
    const r = await fetch(`${BASE}/api/dev/login?id=${id}`, { redirect: 'manual' });
    cookies[id] = r.headers.get('set-cookie').split(';')[0];
  }
  return cookies[id];
}
// who：測試帳號 id（t_runner）或 dev/google 拿到的 cookie（__Host-cil_sess=…）
async function call(who, path, { method = 'GET', body, raw } = {}) {
  const headers = { origin: BASE };
  if (who) headers.cookie = who.startsWith('__Host-') ? who : await as(who);
  if (method !== 'GET' && method !== 'DELETE') headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: raw ?? (method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {})) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers, sub: Number(/sub=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]) };
}
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${r.text}`); return r.json; };
const err = (r, status, msg) => { assert.equal(r.status, status, r.text); if (msg) assert.equal(r.json?.error, msg); return r; };
// 新帳號（模擬 Google 登入）：回傳 cookie 與 id
let seq = 0;
async function fresh(name) {
  const r = await fetch(`${BASE}/api/dev/google?${new URLSearchParams({ sub: `ach-${Date.now()}-${++seq}`, name })}`, { redirect: 'manual' });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('__Host-cil_sess=')).split(';')[0];
  return { cookie, id: (await call(cookie, '/me')).json.member.id };
}
const dev = async (q) => (await fetch(`${BASE}/api/dev/ach?${q}`)).json();
const rate = (key) => fetch(`${BASE}/api/dev/rate?key=${encodeURIComponent(key)}&clear=1`);
// 只跑成績與挑戰的排程（其他工作略過，不影響後面的測試）
const OTHER_JOBS = 'events,opsAlerts,backup,signupOpen,followups,weather,signupReviews,digest,renewals,retention,auditDigest,monthSummary,review,fatigue,weeklyReport,cams,rest,promoteSweep,push';
const cron = async (at) => (await call(null, `/dev/cron?at=${at}&skip=${OTHER_JOBS}`)).json;
const T = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const D = (n) => new Date(Date.parse(`${T}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const at10 = (d) => `${d}T02:00:00Z`;   // 台北 10:00
const auditOf = async (action) => (await call('t_chair', `/audit?action=${action.split('_')[0]}`)).json.items.filter((r) => r.action === action);
const notes = async (who, cat = 'training') => (await call(who, `/notifications?cat=${cat}`)).json.items;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WEBP = `data:image/webp;base64,${'UklGRg'.repeat(20)}`;
const pbBody = (o = {}) => ({ dist_key: 'fm', seconds: 14000, race_name: '測試馬拉松', race_date: D(-10), result_url: 'https://example.com/result/1', ...o });
const submit = async (who, o) => ok(await call(who, '/pb', { method: 'POST', body: pbBody(o) }), '登錄成績').id;
const approve = (id, who = 't_chair') => call(who, `/admin/pb/${id}/review`, { method: 'POST', body: { approve: true } });
const campBody = (o = {}) => ({ title: '全馬破 4', kind: 'time', dist_key: 'fm', target: 14400, rewards: { badge: 'stopwatch', board: 1 },
  start_date: D(-20), end_date: D(30), join_by: D(30), ...o });
async function campaign(o = {}, { open = true, who = 't_chair' } = {}) {
  const id = ok(await call(who, '/admin/ach', { method: 'POST', body: campBody(o) }), '建立挑戰').id;
  if (open) ok(await call(who, `/admin/ach/${id}/open`, { method: 'POST', body: {} }), '發布');
  return id;
}
const joinC = (who, cid, body = {}) => call(who, `/ach/${cid}/join`, { method: 'POST', body });
const mine = async (who, cid) => ok(await call(who, `/ach/${cid}`));
const setFeat = (body) => call('t_chair', '/settings/features', { method: 'POST', body });

after(async () => {
  // 還開著的挑戰取消、草稿刪掉，再跑一次遞補（budget.test 的排程不會多出成績與挑戰的工作）
  const list = (await call('t_chair', '/admin/ach')).json?.campaigns || [];
  for (const c of list) {
    if (c.status === 'open') await call('t_chair', `/admin/ach/${c.id}/cancel`, { method: 'POST', body: { note: '測試結束' } });
    if (c.status === 'draft') await call('t_chair', `/admin/ach/${c.id}`, { method: 'DELETE' });
  }
  await cron(at10(D(1)));
  await setFeat({ achieve: false, achieve_rank: false });
  // 清掉這裡產生的成績與挑戰資料：每張非空的表在每日備份都多一句讀取，後面 budget.test 的備份額度測試照原本的表數
  await dev('purge=1');
});

test('開關關閉：登錄 403、我的成績 on:false、恭喜榜 on:false；開關存檔真的寫進 features', async () => {
  await setFeat({ achieve: false, achieve_rank: false });
  err(await call('t_runner', '/pb', { method: 'POST', body: pbBody() }), 403, '協會目前沒有開放成績與挑戰');
  const m = ok(await call('t_runner', '/pb'));
  assert.equal(m.on, false);
  assert.deepEqual(ok(await call('t_runner', '/ach/board')), { on: false });
  err(await call('t_chair', '/admin/ach', { method: 'POST', body: campBody() }), 403, '協會目前沒有開放成績與挑戰');
  const v = ok(await setFeat({ achieve: true, achieve_rank: true })).value;
  assert.equal(v.achieve, true);
  assert.equal(v.achieve_rank, true);
  assert.equal(ok(await call('t_runner', '/me')).settings.features.achieve, true);
  // 別的開關存檔不會把它們關掉（沒送的保留原值）
  assert.equal(ok(await setFeat({ meetup: false })).value.achieve, true);
  // /api/me 的 member 新欄位
  const me = ok(await call('t_runner', '/me')).member;
  assert.deepEqual([me.cheer_board, me.cheer_rank, me.ach], [false, false, { queue: 0, needSize: 0 }]);
  assert.ok(ok(await call('t_chair', '/me')).member.can.includes('achieve'));
  assert.ok(!ok(await call('t_super', '/me')).member.can.includes('achieve'));
});

test('登錄驗證：每個欄位錯誤各一個 400；截圖太大或 png 400；連結與截圖都沒有 400；未來日期 400；請求太大 413', async () => {
  const u = await fresh('驗證跑友');
  const bad = async (o, msg) => err(await call(u.cookie, '/pb', { method: 'POST', body: pbBody(o) }), 400, msg);
  await bad({ dist_key: 'ultra' }, '請選距離');
  await bad({ dist_key: 'other', km: 300 }, '其他距離請填 1–250 公里');
  await bad({ seconds: 3 * 60 + 28 }, '時間看起來不對，請用 時:分:秒（例如 3:28:41）');
  await bad({ seconds: 'abc' }, '時間看起來不對，請用 時:分:秒（例如 3:28:41）');
  await bad({ race_name: '  ' }, '請填賽事名稱');
  await bad({ race_date: '2026/10/01' }, '請選比賽日期');
  await bad({ race_date: D(1) }, '比賽日期不能晚於今天');
  await bad({ result_url: 'http://example.com/x' }, '成績連結要是 https:// 開頭的網址');
  await bad({ result_url: '', proof: PNG }, '截圖格式不對或太大');
  await bad({ result_url: '', proof: `data:image/webp;base64,${'A'.repeat(200001)}` }, '截圖格式不對或太大');
  await bad({ result_url: '' }, '請附上官方成績連結或截圖');
  err(await call(u.cookie, '/pb', { method: 'POST', raw: JSON.stringify(pbBody({ note: 'x'.repeat(220000) })) }), 413, '資料太大');
  // 字串時間也收（h:mm:ss）；其他距離一位小數
  const id = ok(await call(u.cookie, '/pb', { method: 'POST', body: pbBody({ dist_key: 'other', km: 12.34, seconds: '1:05:00', race_name: '越野賽' }) })).id;
  const p = ok(await call(u.cookie, '/pb')).items.find((x) => x.id === id);
  assert.deepEqual([p.km, p.seconds, p.status, p.proof, p.edited], [12.3, 3900, 'pending', false, false]);
});

test('重複：同一場同距離第二筆 409；婉拒後可以重送；審核中最多 5 筆；登錄限流 10 次／小時', async () => {
  const u = await fresh('重複跑友');
  const a = await submit(u.cookie, { race_date: D(-30) });
  err(await call(u.cookie, '/pb', { method: 'POST', body: pbBody({ race_date: D(-30), seconds: 13000 }) }), 409, '這場比賽的這個距離已經登錄過了');
  ok(await call('t_chair', `/admin/pb/${a}/review`, { method: 'POST', body: { approve: false, code: 'link', note: '連結打不開' } }));
  const a2 = await submit(u.cookie, { race_date: D(-30), seconds: 13000 });
  for (let i = 0; i < 4; i++) await submit(u.cookie, { race_date: D(-40 - i) });
  err(await call(u.cookie, '/pb', { method: 'POST', body: pbBody({ race_date: D(-50) }) }), 400, '審核中的成績最多 5 筆，等審核完再送');
  // 婉拒的那筆改判核准：撞到同一場的有效紀錄 409
  err(await approve(a), 409, '這場比賽的這個距離已經登錄過了');
  let r;
  for (let i = 0; i < 5; i++) { r = await call(u.cookie, '/pb', { method: 'POST', body: pbBody({ race_date: D(-60 - i) }) }); if (r.status === 429) break; }
  err(r, 429, '送出太頻繁，請稍後再試');
  await rate(`pb:${u.id}`);
  assert.ok(a2);
});

test('截圖：本人與審核者拿得到（private, no-store），別人與監事 403；清單不含截圖本身', async () => {
  const u = await fresh('截圖跑友');
  const id = ok(await call(u.cookie, '/pb', { method: 'POST', body: pbBody({ result_url: '', proof: WEBP }) })).id;
  for (const who of [u.cookie, 't_chair', 't_staff']) {
    const r = await fetch(`${BASE}/api/pb/${id}/proof`, { headers: { cookie: who.startsWith('__Host-') ? who : await as(who) } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    assert.match(r.headers.get('cache-control'), /private/);
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal(r.headers.get('content-disposition'), 'inline');
  }
  err(await call('t_other', `/pb/${id}/proof`), 403);
  err(await call('t_super', `/pb/${id}/proof`), 403);
  const list = await call(u.cookie, '/pb');
  assert.ok(list.text.length < 10000 && !list.text.includes('UklGRg'));
  assert.equal(list.json.items[0].proof, true);
  const adm = await call('t_chair', '/admin/pb?status=pending');
  assert.ok(!adm.text.includes('UklGRg'));
  // 移除截圖（PUT proof:null）而且沒有連結 → 400；換成連結可以
  err(await call(u.cookie, `/pb/${id}`, { method: 'PUT', body: pbBody({ result_url: '', proof: null }) }), 400, '請附上官方成績連結或截圖');
  ok(await call(u.cookie, `/pb/${id}`, { method: 'PUT', body: pbBody({ proof: null }) }));
  err(await call(u.cookie, `/pb/${id}/proof`), 404, '截圖已刪除');
});

test('修改：審核中可以改（edited）；通過的不能改；婉拒的改完回到審核中', async () => {
  const u = await fresh('修改跑友');
  const id = await submit(u.cookie, { race_date: D(-15) });
  ok(await call(u.cookie, `/pb/${id}`, { method: 'PUT', body: pbBody({ race_date: D(-15), seconds: 13900 }) }));
  let p = ok(await call(u.cookie, '/pb')).items.find((x) => x.id === id);
  assert.deepEqual([p.seconds, p.edited, p.status], [13900, true, 'pending']);
  err(await call('t_other', `/pb/${id}`, { method: 'PUT', body: pbBody() }), 404, '找不到這筆成績');
  ok(await call('t_staff', `/admin/pb/${id}/review`, { method: 'POST', body: { approve: false, code: 'unclear', note: '看不清楚。' } }));
  p = ok(await call(u.cookie, '/pb')).items.find((x) => x.id === id);
  assert.deepEqual([p.status, p.review_note], ['rejected', '看不清楚']);
  assert.ok((await notes(u.cookie)).some((n) => n.title === '你的成績沒有通過審核' && n.body === '看不清楚。可以修改後重新送出'));
  ok(await call(u.cookie, `/pb/${id}`, { method: 'PUT', body: pbBody({ race_date: D(-15), seconds: 13800 }) }));
  p = ok(await call(u.cookie, '/pb')).items.find((x) => x.id === id);
  assert.deepEqual([p.status, p.review_note, p.review_at], ['pending', null, null]);
  // 登錄時間（挑戰「發布前登錄」與團服排序看這個）：只改賽事名稱不重算；改了時間、日期、距離就重算成現在
  await dev(`pb=${id}&created=${D(-40)} 00:00:00`);
  ok(await call(u.cookie, `/pb/${id}`, { method: 'PUT', body: pbBody({ race_date: D(-15), seconds: 13800, race_name: '改名馬拉松' }) }));
  assert.equal(ok(await call(u.cookie, '/pb')).items.find((x) => x.id === id).created_at, `${D(-40)} 00:00:00`, '只改名稱不重算');
  ok(await call(u.cookie, `/pb/${id}`, { method: 'PUT', body: pbBody({ race_date: D(-300), seconds: 19800, race_name: '改名馬拉松' }) }));
  assert.ok(ok(await call(u.cookie, '/pb')).items.find((x) => x.id === id).created_at > `${D(-1)} 23:59:59`, '換成另一場比賽：登錄時間重算');
  ok(await approve(id));
  err(await call(u.cookie, `/pb/${id}`, { method: 'PUT', body: pbBody() }), 400, '通過審核的成績不能修改，可以刪除後重新登錄');
});

test('審核權限：跑友、監事、教練 403；不能審自己的；兩次核准第二次 409；只有理事長與行政人員是審核者', async () => {
  const id = await submit('t_runner', { race_date: D(-12), seconds: 14100 });
  for (const who of ['t_runner', 't_super', 't_coach', 't_lead']) err(await approve(id, who), 403, '只有理事長與行政人員可以審核成績');
  err(await call('t_super', '/admin/pb'), 403);
  const own = await submit('t_chair', { race_date: D(-12) });
  err(await approve(own), 403, '不能審核自己的成績');
  ok(await approve(own, 't_staff'));
  ok(await approve(id));
  err(await approve(id, 't_staff'), 409, '這筆成績已經審核過了');
  const meta = ok(await call('t_chair', '/admin/ach')).meta;
  assert.equal(meta.approvers, 2, '種子資料：理事長與行政人員');
  assert.equal(meta.raceKey, true);
  assert.equal(meta.readonly, false);
  // 審核清單：待審核依送出時間舊到新、q 用姓名或暱稱、比目前 PB 快多少要的 current_best
  const list = ok(await call('t_staff', '/admin/pb?status=approved&q=理事長')).items;
  assert.ok(list.length && list.every((x) => x.member.id === 't_chair'));
  assert.equal(list[0].review_by_name, '測試行政');
});

test('核准快照 pb_kind：第一筆 first、更快 break（prev_seconds）、更慢與同秒 none；補登更早更慢的比賽是 first，之後的快照不變', async () => {
  const u = await fresh('快照跑友');
  const kind = async (o) => { const id = await submit(u.cookie, o); return ok(await approve(id)).pb_kind; };
  assert.equal(await kind({ race_date: D(-100), seconds: 15000 }), 'first');
  const b = await submit(u.cookie, { race_date: D(-80), seconds: 14000 });
  assert.equal(ok(await approve(b)).pb_kind, 'break');
  assert.equal(await kind({ race_date: D(-60), seconds: 14500 }), 'none');
  assert.equal(await kind({ race_date: D(-40), seconds: 14000 }), 'none');
  assert.equal(await kind({ race_date: D(-300), seconds: 16000 }), 'first');
  const items = ok(await call(u.cookie, '/pb')).items;
  const bb = items.find((x) => x.id === b);
  assert.deepEqual([bb.pb_kind, bb.prev_seconds], ['break', 15000]);
  const best = ok(await call(u.cookie, '/pb')).best;
  assert.equal(best.fm.id, b, '同秒取比賽日早的');
  assert.ok((await notes(u.cookie)).some((n) => n.title === '你的成績通過審核' && n.body === '全馬 3:53:20・測試馬拉松・刷新 PB'));
});

test('挑戰 CRUD：監事看得到清單（met 是空的）、其他寫入 403；checkCampaign 的訊息原樣回傳；發布後改條件 409、延長可以；只能刪草稿', async () => {
  const s = ok(await call('t_super', '/admin/ach'));
  assert.deepEqual([s.met, s.meta.readonly], [[], true]);
  err(await call('t_super', '/admin/ach', { method: 'POST', body: campBody() }), 403, '只有理事長與行政人員可以管理挑戰');
  for (const who of ['t_runner', 't_coach', 't_lead']) err(await call(who, '/admin/ach'), 403);
  err(await call('t_chair', '/admin/ach', { method: 'POST', body: campBody({ target: 3000 }) }), 400, '目標時間看起來不對');
  err(await call('t_chair', '/admin/ach', { method: 'POST', body: campBody({ kind: 'weight', target: 3, opts: { verify: 'honor' }, start_date: D(0), end_date: D(40), join_by: D(10),
    rewards: { badge: 'heart', shirt: { sizes: ['M'], quota: 10 } } }) }), 400, '自主聲明的體重挑戰不能送團服（沒辦法驗證）');
  err(await call('t_chair', '/admin/ach', { method: 'POST', body: campBody({ kind: 'weight', target: 3, opts: { verify: 'witness' }, start_date: D(0), end_date: D(40), join_by: D(30) }) }),
    400, '體重挑戰的報名截止要在結束日 18 天以前');
  const draft = await campaign({ title: '草稿' }, { open: false });
  ok(await call('t_chair', `/admin/ach/${draft}`, { method: 'PUT', body: campBody({ title: '草稿改名', target: 10800 }) }));
  ok(await call('t_chair', `/admin/ach/${draft}`, { method: 'DELETE' }));
  const id = await campaign({ title: 'CRUD 測試', rewards: { badge: 'stopwatch', board: 1, shirt: { sizes: ['S', 'M'], quota: 5, pool: '測試款' } } });
  err(await call('t_chair', `/admin/ach/${id}`, { method: 'DELETE' }), 409, '只能刪除草稿');
  const body = campBody({ title: 'CRUD 測試', rewards: { badge: 'stopwatch', board: 1, shirt: { sizes: ['S', 'M'], quota: 5, pool: '測試款' } } });
  err(await call('t_chair', `/admin/ach/${id}`, { method: 'PUT', body: { ...body, target: 10800 } }), 409, '挑戰開始後不能改條件');
  err(await call('t_chair', `/admin/ach/${id}`, { method: 'PUT', body: { ...body, rewards: { badge: 'stopwatch', board: 1 } } }), 409, '挑戰開始後不能改條件');
  err(await call('t_chair', `/admin/ach/${id}`, { method: 'PUT', body: { ...body, rewards: { ...body.rewards, shirt: { ...body.rewards.shirt, pool: '別款' } } } }), 409, '挑戰開始後不能改條件');
  err(await call('t_chair', `/admin/ach/${id}`, { method: 'PUT', body: { ...body, rewards: { ...body.rewards, shirt: { ...body.rewards.shirt, quota: 4 } } } }), 409, '名額只能增加');
  err(await call('t_chair', `/admin/ach/${id}`, { method: 'PUT', body: { ...body, rewards: { ...body.rewards, shirt: { ...body.rewards.shirt, sizes: ['M'] } } } }), 409, '尺寸只能增加');
  ok(await call('t_chair', `/admin/ach/${id}`, { method: 'PUT', body: { ...body, title: 'CRUD 延長', end_date: D(40), join_by: D(40), rewards: { ...body.rewards, shirt: { ...body.rewards.shirt, quota: 6, sizes: ['S', 'M', 'L'] } } } }));
  const c = ok(await call('t_chair', '/admin/ach')).campaigns.find((x) => x.id === id);
  assert.deepEqual([c.title, c.end_date, c.rewards.shirt.quota, c.rewards.shirt.sizes, c.rewards.shirt.size_by], ['CRUD 延長', D(40), 6, ['S', 'M', 'L'], D(44)]);
  assert.ok(ok(await call('t_chair', '/admin/ach')).meta.pools.includes('測試款'));
  err(await call('t_super', `/admin/ach/${id}/open`, { method: 'POST', body: {} }), 403);
  err(await call('t_chair', `/admin/ach/${id}/open`, { method: 'POST', body: {} }), 409, '這一筆已經處理過了');
  // 已經結束（在結算等待期）的不能再延長
  await dev(`camp=${id}&end=${D(-2)}&join=${D(-2)}`);
  err(await call('t_chair', `/admin/ach/${id}`, { method: 'PUT', body: { ...body, end_date: D(50), join_by: D(50),
    rewards: { ...body.rewards, shirt: { ...body.rewards.shirt, quota: 6, sizes: ['S', 'M', 'L'], size_by: D(60) } } } }), 409, '挑戰已經結束，不能再延長');
  ok(await call('t_chair', `/admin/ach/${id}/cancel`, { method: 'POST', body: { note: '測試' } }));
});

test('資格：分團挑戰別團的人 403；只限協會會員；截止後 403；草稿看不到；發布通知有資格的人', async () => {
  // 前面的測試檔會把種子帳號加進別的分團、改會籍：這裡用新帳號（y 加進青年團）
  const x = await fresh('別團跑友'), y = await fresh('青年跑友');
  await dev(`team=youth&add=${y.id}`);
  const team = await campaign({ title: '青年團破 4', team_id: 'youth' });
  err(await joinC(x.cookie, team), 403, '這個挑戰只限分團團員');
  err(await call(x.cookie, `/ach/${team}`), 404, '找不到這個挑戰');
  assert.ok(!ok(await call(x.cookie, '/ach')).campaigns.some((c) => c.id === team));
  assert.ok(ok(await call(y.cookie, '/ach')).campaigns.some((c) => c.id === team));
  ok(await joinC(y.cookie, team));
  const mem = await campaign({ title: '會員限定', members_only: true, kind: 'km', dist_key: null, target: 300 });
  err(await joinC(y.cookie, mem), 403, '這個挑戰只限協會會員');
  assert.equal(ok(await joinC('t_chair', mem)).entry.status, 'joined');
  const late = await campaign({ title: '已截止' });
  await dev(`camp=${late}&join=${D(-1)}`);
  err(await joinC(y.cookie, late), 403, '這個挑戰已經截止報名');
  const draft = await campaign({ title: '還沒發布' }, { open: false });
  err(await joinC(y.cookie, draft), 404, '找不到這個挑戰');
  // 發布時通知有資格的人（分團挑戰只有團員）
  const r = ok(await call('t_chair', `/admin/ach/${draft}/open`, { method: 'POST', body: { announce: true } }));
  assert.ok(r.notified >= 5);
  assert.ok((await notes(y.cookie)).some((n) => n.title === '新的目標挑戰' && n.body === `「還沒發布」${Number(D(-20).slice(5, 7))}/${Number(D(-20).slice(8))}–${Number(D(30).slice(5, 7))}/${Number(D(30).slice(8))}`));
  const t2 = await campaign({ title: '青年通知', team_id: 'youth' }, { open: false });
  ok(await call('t_chair', `/admin/ach/${t2}/open`, { method: 'POST', body: { announce: true } }));
  assert.ok(!(await notes(x.cookie)).some((n) => n.body.startsWith('「青年通知」')));
  assert.ok((await notes(y.cookie)).some((n) => n.body.startsWith('「青年通知」')));
});

test('破 PB：基準要有一筆挑戰發布前登錄的；核准期間內更快的成績→達成並通知；追平不算；first_ok；開始前的成績都是發布後才登錄的→base_late', async () => {
  const u = await fresh('破PB跑友'), v = await fresh('補登跑友'), w = await fresh('第一次跑友');
  // 基準是挑戰發布前登錄的（測試裡同一秒內就發布，登錄時間往前調一天）
  const base = await submit(u.cookie, { race_date: D(-200), seconds: 15000 });
  await dev(`pb=${base}&created=${D(-1)} 00:00:00`);
  ok(await approve(base));
  const cid = await campaign({ title: '破全馬 PB', kind: 'pb', dist_key: 'fm', target: null, rewards: { badge: 'medal', board: 1 } });
  const any = await campaign({ title: '任一距離破 PB', kind: 'pb', dist_key: null, target: null, opts: { first_ok: 1 }, rewards: { badge: 'medal' } });
  for (const x of [u, v, w]) { ok(await joinC(x.cookie, cid)); ok(await joinC(x.cookie, any)); }
  assert.deepEqual((await mine(u.cookie, cid)).progress, { best: null, base: 15000, base_late: false, pending_pb: 0 });
  ok(await approve(await submit(u.cookie, { race_date: D(-5), seconds: 15000 })));
  assert.equal((await mine(u.cookie, cid)).me.status, 'joined', '追平不算');
  const r = ok(await approve(await submit(u.cookie, { race_date: D(-3), seconds: 14999 })));
  assert.deepEqual(r.achieved.map((x) => x.cid).sort(), [cid, any].sort());
  const m = (await mine(u.cookie, cid));
  assert.equal(m.me.status, 'achieved');
  assert.ok((await notes(u.cookie)).some((n) => n.title === '恭喜完成挑戰' && n.body === '「破全馬 PB」'));
  // v：發布之後才補登開始前的慢成績 → 沒有基準（兩種挑戰都不算），M6 base_late
  ok(await approve(await submit(v.cookie, { race_date: D(-150), seconds: 20000 })));
  ok(await approve(await submit(v.cookie, { race_date: D(-4), seconds: 16000 })));
  const vm = (await mine(v.cookie, cid));
  assert.deepEqual([vm.me.status, vm.progress.base, vm.progress.base_late], ['joined', null, true]);
  assert.equal((await mine(v.cookie, any)).me.status, 'joined', 'first_ok 也不能靠補登變成第一次');
  assert.equal(ok(await call(v.cookie, '/ach')).campaigns.find((c) => c.id === cid).progress.base_late, true);
  // w：開始前沒有任何成績 → first_ok 的挑戰期間內完賽就算（任一標準距離）
  ok(await approve(await submit(w.cookie, { dist_key: '10k', seconds: 3600, race_date: D(-2) })));
  assert.equal((await mine(w.cookie, any)).me.status, 'achieved');
  assert.equal((await mine(w.cookie, cid)).me.status, 'joined');
});

test('時間門檻：4:00:00 不算、3:59:59 算；first_time（開始前已經破過的不算）；參加時已經有符合的成績就直接達成', async () => {
  const u = await fresh('破四跑友'), v = await fresh('早就破四');
  const cid = await campaign({ title: '全馬破 4 首次', opts: { first_time: 1 } });
  ok(await approve(await submit(v.cookie, { race_date: D(-100), seconds: 14000 })));
  for (const x of [u, v]) ok(await joinC(x.cookie, cid));
  ok(await approve(await submit(u.cookie, { race_date: D(-6), seconds: 14400 })));
  assert.equal((await mine(u.cookie, cid)).me.status, 'joined');
  ok(await approve(await submit(u.cookie, { race_date: D(-5), seconds: 14399 })));
  assert.equal((await mine(u.cookie, cid)).me.status, 'achieved');
  ok(await approve(await submit(v.cookie, { race_date: D(-5), seconds: 13000 })));
  assert.equal((await mine(v.cookie, cid)).me.status, 'joined', '限第一次跑進');
  const plain = await campaign({ title: '全馬破 4 一般' });
  const j = ok(await joinC(v.cookie, plain));
  assert.equal(j.entry.status, 'achieved', '參加時就有期間內破 4 的成績');
  assert.ok((await notes(v.cookie)).some((n) => n.body === '「全馬破 4 一般」'));
});

test('速度上升：剛好 3.0% 算、2.99% 不算；沒有基準不算；M6 的進度', async () => {
  const u = await fresh('速度跑友'), v = await fresh('沒基準跑友');
  const base = await submit(u.cookie, { dist_key: 'hm', seconds: 6000, race_date: D(-120) });
  await dev(`pb=${base}&created=${D(-1)} 00:00:00`);
  ok(await approve(base));
  const cid = await campaign({ title: '半馬進步 3%', kind: 'pace', dist_key: 'hm', target: 3, rewards: { badge: 'flame' } });
  for (const x of [u, v]) ok(await joinC(x.cookie, cid));
  ok(await approve(await submit(u.cookie, { dist_key: 'hm', seconds: 5821, race_date: D(-8) })));
  const m = (await mine(u.cookie, cid));
  assert.deepEqual([m.me.status, m.progress.best, m.progress.base], ['joined', 5821, 6000], '(6000-5821)*1000 < 6000*30');
  ok(await approve(await submit(u.cookie, { dist_key: 'hm', seconds: 5820, race_date: D(-7) })));
  assert.equal((await mine(u.cookie, cid)).me.status, 'achieved');
  ok(await approve(await submit(v.cookie, { dist_key: 'hm', seconds: 5000, race_date: D(-7) })));
  assert.equal((await mine(v.cookie, cid)).me.status, 'joined');
});

test('刪除成績：寫 pb.delete（本人、原狀態）；官方 PB 回到下一筆；已達成的挑戰不收回；恭喜跟著刪', async () => {
  const u = await fresh('刪除跑友');
  ok(await call(u.cookie, '/me/cheer-board', { method: 'POST', body: { on: true } }));
  const slow = await submit(u.cookie, { race_date: D(-50), seconds: 15000 });
  ok(await approve(slow));
  const cid = await campaign({ title: '刪除測試破 4' });
  ok(await joinC(u.cookie, cid));
  const fast = await submit(u.cookie, { race_date: D(-4), seconds: 14000 });
  ok(await approve(fast));
  assert.equal(ok(await call(u.cookie, '/pb')).best.fm.id, fast);
  const r = ok(await call('t_other', '/ach/cheer', { method: 'POST', body: { item: `pb:${fast}`, on: true } }));
  assert.deepEqual([r.cheers, r.cheered], [1, true]);
  assert.equal(ok(await call(u.cookie, '/pb')).items.find((x) => x.id === fast).cheers, 1);
  ok(await call(u.cookie, `/pb/${fast}`, { method: 'DELETE' }));
  err(await call(u.cookie, `/pb/${fast}`, { method: 'DELETE' }), 404);
  assert.equal(ok(await call(u.cookie, '/pb')).best.fm.id, slow);
  const m = (await mine(u.cookie, cid));
  assert.deepEqual([m.me.status, m.me.evidence], ['achieved', fast], '已達成的不收回（證據留 id）');
  assert.ok(!ok(await call('t_other', '/ach/board')).items.some((x) => x.item === `pb:${fast}`));
  err(await call('t_other', '/ach/cheer', { method: 'POST', body: { item: `pb:${fast}`, on: true } }), 400, '這則恭喜已經看不到了');
  const a = (await auditOf('pb.delete')).find((x) => x.target_id === fast);
  assert.deepEqual([a.actor_name, a.detail], ['刪除跑友', 'approved']);
});

test('刪掉影響基準的成績：挑戰發布後刪開始前較快的成績 → 之後判定達成要幹部確認（先刪再參加也一樣）；刪較慢的不影響；確認、取消挑戰時回到參加中、取消的不能選尺寸', async () => {
  const u = await fresh('刪基準跑友');
  const ids = [];
  for (const [d, sec] of [[-200, 12600], [-150, 13500], [-120, 14000]]) {   // 3:30、3:45、3:53:20，都是挑戰發布前登錄的
    const id = await submit(u.cookie, { race_date: D(d), seconds: sec });
    await dev(`pb=${id}&created=${D(-1)} 00:00:00`);
    ok(await approve(id));
    ids.push(id);
  }
  const [fast, mid, slow] = ids;
  const c1 = await campaign({ title: '刪基準破 PB', kind: 'pb', dist_key: 'fm', target: null, rewards: { badge: 'medal' } });
  const c2 = await campaign({ title: '刪基準破 PB 團服', kind: 'pb', dist_key: 'fm', target: null, rewards: { badge: 'medal', shirt: { sizes: ['M'], quota: 5 } } });
  ok(await joinC(u.cookie, c1));
  ok(await approve(await submit(u.cookie, { race_date: D(-3), seconds: 13200 })));   // 3:40：沒有破 3:30
  // 刪較慢的（不是基準）：不影響
  ok(await call(u.cookie, `/pb/${slow}`, { method: 'DELETE' }));
  ok(await approve(await submit(u.cookie, { dist_key: '10k', seconds: 3000, race_date: D(-2) })));   // 觸發重新判定
  assert.equal((await mine(u.cookie, c1)).me.status, 'joined');
  // 刪掉 3:30：基準變成 3:45，3:40 就「破了」→ 要幹部確認；之後才參加的挑戰也一樣
  ok(await call(u.cookie, `/pb/${fast}`, { method: 'DELETE' }));
  const j = ok(await joinC(u.cookie, c2));
  assert.equal(j.entry.status, 'met');
  assert.equal((await mine(u.cookie, c1)).me.status, 'met');
  assert.ok((await notes(u.cookie)).some((n) => n.title === '挑戰達成，等幹部確認' && n.body === '「刪基準破 PB 團服」'));
  const list = ok(await call('t_chair', '/admin/ach'));
  const q = list.met.find((x) => x.cid === c1 && x.member?.id === u.id);
  assert.deepEqual([q.base_del, q.pb?.seconds, q.evidence], [true, 13200, null]);
  const e1 = (await mine(u.cookie, c1)).me.id;
  assert.equal(ok(await call('t_chair', `/admin/ach/${c1}/entries/${e1}`)).detail.base_del, true);
  assert.ok(mid);
  // 確認 → 達成；取消另一個挑戰 → 回到參加中、不再待確認、不能選尺寸
  assert.deepEqual(ok(await call('t_chair', `/admin/ach/${c1}/entries/${e1}/confirm`, { method: 'POST', body: { approve: true } })), { ok: true, status: 'achieved' });
  ok(await call('t_chair', `/admin/ach/${c2}/cancel`, { method: 'POST', body: { note: '測試取消' } }));
  assert.equal((await mine(u.cookie, c2)).me.status, 'joined');
  assert.ok(!ok(await call('t_chair', '/admin/ach')).met.some((x) => x.member?.id === u.id));
  err(await call(u.cookie, `/ach/${c2}/shirt`, { method: 'POST', body: { size: 'M' } }), 400, '挑戰已取消，團服不會發放');
  // 匯出：記下的挑戰（只有名稱與時間，沒有成績）
  const ex = ok(await call(u.cookie, '/me/export')), titles = ex.challenge_base_deleted.map((x) => x.title);
  assert.ok(['刪基準破 PB', '刪基準破 PB 團服'].every((t) => titles.includes(t)), JSON.stringify(titles));
  assert.ok(ex.challenge_base_deleted.every((x) => Object.keys(x).sort().join() === 'created_at,title'));
});

test('撤銷成績：選了「不需要」團服的，改用別筆重新達成時不會又排進名額', async () => {
  const u = await fresh('不需要跑友');
  const cid = await campaign({ title: '撤銷不需要', rewards: { badge: 'medal', shirt: { sizes: ['M'], quota: 5 } } });
  ok(await joinC(u.cookie, cid));
  const p1 = await submit(u.cookie, { race_date: D(-9), seconds: 14300 }), p2 = await submit(u.cookie, { race_date: D(-6), seconds: 14200 });
  ok(await approve(p1)); ok(await approve(p2));
  assert.equal(ok(await call(u.cookie, `/ach/${cid}/shirt`, { method: 'POST', body: { decline: true } })).reward_state, 'declined');
  ok(await call('t_staff', `/admin/pb/${p1}/revoke`, { method: 'POST', body: { code: 'wrong' } }));
  const m = (await mine(u.cookie, cid));
  assert.deepEqual([m.me.status, m.me.evidence, m.me.reward_state], ['achieved', p2, 'declined']);
});

test('撤銷成績：以它為證據的達成退回、改用別筆符合的成績（仍達成）；沒有別筆→回到參加中；稽核與通知', async () => {
  const u = await fresh('撤銷跑友');
  const cid = await campaign({ title: '撤銷測試破 4' });
  ok(await joinC(u.cookie, cid));
  const p1 = await submit(u.cookie, { race_date: D(-9), seconds: 14300 }), p2 = await submit(u.cookie, { race_date: D(-6), seconds: 14200 });
  ok(await approve(p1)); ok(await approve(p2));
  assert.equal((await mine(u.cookie, cid)).me.evidence, p1);
  err(await call('t_runner', `/admin/pb/${p1}/revoke`, { method: 'POST', body: { code: 'wrong' } }), 403);
  const r = ok(await call('t_staff', `/admin/pb/${p1}/revoke`, { method: 'POST', body: { code: 'wrong', note: '成績有誤' } }));
  assert.deepEqual([r.revoked, r.kept], [0, 1]);
  let m = (await mine(u.cookie, cid));
  assert.deepEqual([m.me.status, m.me.evidence], ['achieved', p2]);
  ok(await call('t_staff', `/admin/pb/${p2}/revoke`, { method: 'POST', body: { code: 'notself' } }));
  m = (await mine(u.cookie, cid));
  assert.deepEqual([m.me.status, m.me.evidence], ['joined', null], '進行中：回到參加中，期間內還能再達成');
  err(await call('t_staff', `/admin/pb/${p2}/revoke`, { method: 'POST', body: { code: 'notself' } }), 409, '這筆成績已經審核過了');
  assert.ok((await notes(u.cookie)).some((n) => n.title === '你的成績已被撤銷' && n.body === '成績有誤'));
  assert.equal((await auditOf('pb.revoke')).find((x) => x.target_id === p1).detail, 'd=fm｜r=wrong');
  assert.equal(ok(await call(u.cookie, '/pb')).items.find((x) => x.id === p1).status, 'revoked');
});

// 里程挑戰與團服：結算、名額依達成先後、候補、放棄與遞補、調高名額、尺寸截止與補訂、讓出名額、發放、通知領取、提醒、CSV、刪除帳號
const S = {};
const log = async (who, date, km, extra = {}) => ok(await call(who, '/logs', { method: 'POST', body: { date, status: 'done', km, ...extra } }), '記錄訓練');
async function settle(cid) {
  for (let i = 0; i < 6; i++) {
    const r = await cron(at10(D(10)));
    assert.ok(r._budget.root.sub <= 50, `結算用了 ${r._budget.root.sub} 個子請求`);
    const c = ok(await call('t_chair', '/admin/ach')).campaigns.find((x) => x.id === cid);
    if (c.status === 'settled') return r;
  }
  throw new Error('結算沒有完成');
}
test('里程結算：凍結（結束後第 4 天之後修改的不算）、單筆最多算 100 公里、要確認的是 met（審核者待辦）、rank_key 是累積到目標那天；確認與退回', async () => {
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) S[k] = await fresh(k === 'k3' ? '=甲' : `里程${k}`);
  S.km = await campaign({ title: '里程團服', kind: 'km', dist_key: null, target: 30, start_date: D(-20), end_date: D(1), join_by: D(1), confirm: false,
    rewards: { badge: 'mountain', board: 1, shirt: { sizes: ['M', 'L'], quota: 2, chart: 'https://example.com/size' } } });
  S.km2 = await campaign({ title: '里程確認', kind: 'km', dist_key: null, target: 50, start_date: D(-20), end_date: D(1), join_by: D(1), confirm: true,
    rewards: { badge: 'mountain' } });
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) { ok(await joinC(S[k].cookie, S.km)); ok(await joinC(S[k].cookie, S.km2)); }
  await log(S.k3.cookie, D(-15), 120);                                  // 只算 100，達成日 D(-15)
  await log(S.k1.cookie, D(-10), 31);                                   // 達成日 D(-10)
  await log(S.k2.cookie, D(-12), 20); await log(S.k2.cookie, D(-8), 15); // 達成日 D(-8)
  await log(S.k5.cookie, D(-3), 60);                                    // 達成日 D(-3)
  const l4 = await log(S.k4.cookie, D(-12), 25), l4b = await log(S.k4.cookie, D(-6), 30);
  // k4 的第二筆在凍結時間之後修改過：不算（25 < 30、25 < 50；不凍結的話 55 會達成）；F＝結束後第 4 天 00:00（台北）
  await dev(`log=${l4b.id}&updated=${D(5)} 00:00:00`);
  assert.ok(l4.id);
  const mk = (await mine(S.k1.cookie, S.km));
  assert.deepEqual([mk.progress.km, mk.me.status, mk.me.position], [31, 'joined', null], '進行中只顯示進度，不套凍結');
  await settle(S.km);
  await settle(S.km2);
  const st = async (k, cid) => (await mine(S[k].cookie, cid)).me;
  assert.deepEqual(await Promise.all(['k3', 'k1', 'k2', 'k5', 'k4'].map(async (k) => { const e = await st(k, S.km); return [k, e.status, e.reward_state, e.reward_rank]; })),
    [['k3', 'achieved', 'granted', 1], ['k1', 'achieved', 'granted', 2], ['k2', 'achieved', 'waitlist', 3], ['k5', 'achieved', 'waitlist', 4], ['k4', 'not_met', null, null]]);
  assert.equal((await st('k3', S.km)).evidence, '100.0');
  const e4 = await st('k4', S.km2), e5 = await st('k5', S.km2);
  assert.deepEqual([e4.status, e4.evidence, e5.status, e5.evidence], ['not_met', '25.0', 'met', '60.0']);
  // 通知：名額確定、候補第幾位、沒達成
  assert.ok((await notes(S.k3.cookie)).some((n) => n.title === '團服名額確定了' && n.body.startsWith('「里程團服」：請在 ')));
  assert.ok((await notes(S.k5.cookie)).some((n) => n.title === '你在團服候補名單' && n.body === '「里程團服」候補第 2 位，有名額會通知你'));
  assert.ok((await notes(S.k4.cookie)).some((n) => n.title === '挑戰結束了' && n.body === '「里程確認」這次沒有達成，謝謝你一起努力'));
  // 待確認：審核者待辦、待處理摘要、/api/me 的 queue
  assert.ok((await notes('t_staff', 'todo')).some((n) => n.title === '挑戰達成待確認' && n.ref === 'ach:queue'));
  const todo = ok(await call('t_chair', '/notifications?cat=todo')).todo;
  assert.ok(todo.achMet >= 1 && typeof todo.pb === 'number');
  assert.ok(ok(await call('t_chair', '/me')).member.ach.queue >= 1);
  const adm = ok(await call('t_chair', '/admin/ach'));
  const met = adm.met.filter((m) => m.cid === S.km2);
  assert.deepEqual(met.map((m) => m.member.id).sort(), [S.k3.id, S.k5.id].sort());
  const k5e = met.find((m) => m.member.id === S.k5.id);
  // 可疑訊號（單筆最大、來源）
  const d = ok(await call('t_chair', `/admin/ach/${S.km2}/entries/${k5e.eid}`));
  assert.deepEqual([d.detail.total, d.detail.max, d.detail.logs, d.detail.by_source.manual.n], [60, 60, 1, 1]);
  err(await call('t_super', `/admin/ach/${S.km2}/entries/${k5e.eid}/confirm`, { method: 'POST', body: { approve: true } }), 403);
  ok(await call('t_chair', `/admin/ach/${S.km2}/entries/${k5e.eid}/confirm`, { method: 'POST', body: { approve: true } }));
  assert.equal((await st('k5', S.km2)).status, 'achieved');
  err(await call('t_chair', `/admin/ach/${S.km2}/entries/${k5e.eid}/confirm`, { method: 'POST', body: { approve: true } }), 409, '這一筆已經處理過了');
  const k3e = met.find((m) => m.member.id === S.k3.id);
  ok(await call('t_staff', `/admin/ach/${S.km2}/entries/${k3e.eid}/confirm`, { method: 'POST', body: { approve: false, code: 'doubt', note: '紀錄有疑問' } }));
  assert.equal((await st('k3', S.km2)).status, 'rejected');
  assert.ok((await notes(S.k3.cookie)).some((n) => n.title === '挑戰達成沒有通過確認' && n.body === '「里程確認」：紀錄有疑問'));
  assert.equal((await auditOf('ach.reject')).find((a) => a.target_id === k3e.eid).detail, `c=${S.km2}｜r=doubt`);
  // 沒有待確認的了：審核者的待辦標成已讀
  assert.ok((await notes('t_staff', 'todo')).filter((n) => n.ref === 'ach:queue').every((n) => n.read_at));
});

test('團服：放棄→遞補、又想要→排在最後、調高名額→遞補、調低 409；尺寸截止後第一次選可以（補訂）、改尺寸 400；讓出沒選尺寸的名額；發放；通知領取；提醒；CSV', async () => {
  const st = async (k) => (await mine(S[k].cookie, S.km)).me;
  const shirt = (k, body) => call(S[k].cookie, `/ach/${S.km}/shirt`, { method: 'POST', body });
  ok(await shirt('k1', { decline: true }));
  assert.equal((await st('k2')).reward_state, 'granted');
  assert.ok((await notes(S.k2.cookie)).some((n) => n.title === '團服名額輪到你了' && n.body === '「里程團服」請選好尺寸'));
  const back = ok(await shirt('k1', { decline: false }));
  assert.equal(back.reward_state, 'waitlist');
  assert.equal((await st('k1')).reward_rank, 5, '重新排隊在最後');
  const body = campBody({ title: '里程團服', kind: 'km', dist_key: null, target: 30, start_date: D(-20), end_date: D(1), join_by: D(1), confirm: false,
    rewards: { badge: 'mountain', board: 1, shirt: { sizes: ['M', 'L'], quota: 3, chart: 'https://example.com/size' } } });
  ok(await call('t_chair', `/admin/ach/${S.km}`, { method: 'PUT', body }));
  assert.equal((await st('k5')).reward_state, 'granted', '名額調高：候補第一位（k5）遞補');
  err(await call('t_chair', `/admin/ach/${S.km}`, { method: 'PUT', body: { ...body, rewards: { ...body.rewards, shirt: { ...body.rewards.shirt, quota: 2 } } } }), 409, '名額只能增加');
  // 尺寸：k3 第一次選、截止前可以改；截止後改 400；k2 截止後第一次選可以（補訂）
  ok(await shirt('k3', { size: 'M' }));
  ok(await shirt('k3', { size: 'L' }));
  err(await shirt('k3', { size: 'XL' }), 400, '這個尺寸不在選項裡');
  err(await call('t_chair', `/admin/ach/${S.km}/release-unsized`, { method: 'POST', body: {} }), 400, '只有尺寸截止後才能讓出名額');
  // 尺寸截止改到昨天（測試用；k3 第一次選的時間改到更早，才不算補訂）
  await dev(`sizeby=${S.km}&date=${D(-1)}`);
  await dev(`sizeat=${(await st('k3')).id}&at=${D(-2)} 01:00:00`);
  err(await shirt('k3', { size: 'M' }), 400, '尺寸選擇已截止，請聯絡幹部');
  ok(await shirt('k2', { size: 'M' }));
  // A10 名單：補訂、尺寸統計、沒選尺寸的人數
  const list = ok(await call('t_chair', `/admin/ach/${S.km}/entries?state=shirt`));
  const row = (k) => list.entries.find((e) => e.member?.id === S[k].id);
  assert.deepEqual([row('k2').late_size, row('k3').late_size], [true, false]);
  assert.deepEqual([list.sizes, list.unsized], [{ L: 1, M: 1 }, 1]);
  // 提醒還沒選尺寸的人（k5）；一天一次
  assert.equal(ok(await call('t_chair', `/admin/ach/${S.km}/remind-size`, { method: 'POST', body: {} })).n, 1);
  err(await call('t_chair', `/admin/ach/${S.km}/remind-size`, { method: 'POST', body: {} }), 429, '今天已經提醒過了');
  assert.ok((await notes(S.k5.cookie)).some((n) => n.title === '請選團服尺寸'));
  // 讓出沒選尺寸的名額（k5 → declined），候補（k1）遞補；兩邊都通知
  const rel = ok(await call('t_chair', `/admin/ach/${S.km}/release-unsized`, { method: 'POST', body: {} }));
  assert.deepEqual([rel.released, rel.promoted], [1, 1]);
  assert.deepEqual([(await st('k5')).reward_state, (await st('k1')).reward_state], ['declined', 'granted']);
  assert.ok((await notes(S.k5.cookie)).some((n) => n.title === '團服名額已讓出'));
  // 發放：審核者可以；不是名額的 400；重複勾不會重複寫稽核；全協會挑戰的分團幹部不行
  const e3 = row('k3').id;
  err(await call('t_lead', `/admin/ach/${S.km}/entries/${e3}/issue`, { method: 'POST', body: { issued: true } }), 403);
  assert.equal(ok(await call('t_chair', `/admin/ach/${S.km}/entries/${e3}/issue`, { method: 'POST', body: { issued: true } })).changed, true);
  assert.equal(ok(await call('t_chair', `/admin/ach/${S.km}/entries/${e3}/issue`, { method: 'POST', body: { issued: true } })).changed, false);
  err(await call('t_chair', `/admin/ach/${S.km}/entries/${row('k5').id}/issue`, { method: 'POST', body: { issued: true } }), 400, '沒有名額，不能發放');
  assert.equal((await auditOf('ach.issue')).filter((a) => a.target_id === e3).length, 1);
  err(await shirt('k3', { size: 'M' }), 400, '已經發放，不能改尺寸');
  // 通知領取：只通知已達成＋有名額、還沒發放的（k1、k2）；一天一次；領取方式存在挑戰上
  err(await call('t_chair', `/admin/ach/${S.km}/notify-pickup`, { method: 'POST', body: { note: '' } }), 400, '請填領取方式（60 字以內）');
  assert.equal(ok(await call('t_chair', `/admin/ach/${S.km}/notify-pickup`, { method: 'POST', body: { note: '週四團練在田徑場入口領' } })).n, 2);
  err(await call('t_chair', `/admin/ach/${S.km}/notify-pickup`, { method: 'POST', body: { note: '週四團練在田徑場入口領' } }), 429, '今天已經通知過了');
  assert.equal((await mine(S.k2.cookie, S.km)).campaign.pickup, '週四團練在田徑場入口領');
  assert.ok((await notes(S.k1.cookie)).some((n) => n.title === '團服可以領了' && n.body === '「里程團服」：週四團練在田徑場入口領'));
  assert.ok(!(await notes(S.k3.cookie)).some((n) => n.title === '團服可以領了'), '已發放的不通知');
  assert.equal((await auditOf('ach.notify_pickup')).find((a) => a.target_id === S.km).detail, '2 人');
  // CSV：訂製統計沒有任何姓名；發放名單有 BOM、CRLF、公式注入防護、補訂
  // fetch 的 text() 會吃掉 BOM：看位元組
  const csv = async (view) => {
    const r = await fetch(`${BASE}/api/admin/ach/${S.km}/shirts.csv?view=${view}`, { headers: { cookie: await as('t_chair') } });
    assert.equal(r.status, 200);
    const b = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...b.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM');
    return new TextDecoder().decode(b);
  };
  const order = await csv('order');
  assert.ok(order.includes('\r\n'));
  assert.ok(![S.k1, S.k2, S.k3].some((x) => order.includes(x.id)) && !order.includes('里程') && !order.includes('甲'));
  assert.match(order, /"L","1","0"/);
  assert.match(order, /"M","1","1"/);
  const names = await csv('list');
  assert.ok(names.startsWith('"順位"'));
  assert.ok(names.includes(`"'=甲"`), '= 開頭的名字加單引號');
  assert.match(names, /"里程k2","","","M","待發放","補訂",""/);
  assert.match(names, /"已發放"/);
  err(await call('t_lead', `/admin/ach/${S.km}/shirts.csv?view=list`), 403);
  const ex = await auditOf('ach.shirts_export');
  assert.ok(ex.some((a) => a.detail === '訂製統計') && ex.some((a) => /^名單 \d+ 筆$/.test(a.detail)));
});

test('刪除帳號：已發放的參加列匿名化保留（尺寸還在）；其他參加與成績全刪；審核人欄位清空；空出的名額由排程遞補', async () => {
  // k5 又想要（回到候補）；k2（有名額、沒發放）刪除帳號 → 名額空出來 → 排程遞補 k5
  const back = ok(await call(S.k5.cookie, `/ach/${S.km}/shirt`, { method: 'POST', body: { decline: false } }));
  assert.equal(back.reward_state, 'waitlist');
  ok(await call(S.k2.cookie, '/me', { method: 'DELETE' }));
  ok(await call(S.k3.cookie, '/me', { method: 'DELETE' }));
  const r = await cron(at10(T));
  assert.ok(r._budget.root.sub <= 50);
  assert.equal((await mine(S.k5.cookie, S.km)).me.reward_state, 'granted');
  assert.ok((await notes(S.k5.cookie)).some((n) => n.title === '團服名額輪到你了'));
  const list = ok(await call('t_chair', `/admin/ach/${S.km}/entries`)).entries;
  const anon = list.filter((e) => !e.member);
  assert.deepEqual(anon.map((e) => [e.reward_state, e.shirt_size, e.evidence]), [['issued', 'L', null]]);
  assert.ok(!list.some((e) => e.member?.id === S.k2.id));
});

test('團練出席：只算田徑場、核心日、長跑團練；分團挑戰只算那個分團的活動；手動標出席真的有變才寫稽核', async () => {
  const u = await fresh('出席跑友');
  await dev(`team=youth&add=${u.id}`);
  const cid = await campaign({ title: '青年出席', kind: 'attend', dist_key: null, target: 1, team_id: 'youth', start_date: D(-5), end_date: T, join_by: T, rewards: { badge: 'star' } });
  ok(await joinC(u.cookie, cid));
  const ev = async (who, o) => ok(await call(who, '/events', { method: 'POST', body: { kind: 'track', title: '出席測試', date: T, gather_time: '23:59', notify: false, ...o } }), '建立活動').id;
  const track = await ev('t_lead', { team_id: 'youth' }), party = await ev('t_lead', { team_id: 'youth', kind: 'party' }), long = await ev('t_chair', { kind: 'long' });
  for (const id of [track, party, long]) ok(await call(u.cookie, `/events/${id}/signup`, { method: 'POST', body: {} }), '報名');
  const mark = (who, id, present = true) => call(who, `/events/${id}/attendance`, { method: 'POST', body: { member_id: u.id, present } });
  ok(await mark('t_lead', party)); ok(await mark('t_chair', long));
  assert.equal((await mine(u.cookie, cid)).progress.att, 0, 'party 與別的分團不算');
  ok(await mark('t_lead', track));
  ok(await mark('t_lead', track));
  assert.equal((await mine(u.cookie, cid)).progress.att, 1);
  const au = (await call('t_chair', '/audit?action=event.attendance')).json.items.filter((a) => a.target_id === track);
  assert.deepEqual(au.map((a) => a.detail), [`標記出席（${u.id}）`], '第二次沒有改變，不寫稽核');
  ok(await mark('t_lead', track, false));
  ok(await mark('t_lead', track, true));
  await dev(`camp=${cid}&end=${D(-9)}&join=${D(-9)}&start=${D(-14)}`);
  await dev(`camp=${cid}&end=${T}`);
});

// 見證制體重：同意、起始量測、見證資格、比對（差 0.3 公斤以內、錯 3 次作廢、過期、用過）、存見證者的讀數、21 天、結束量測達成、最小揭露、AAD
test('體重見證：同意與資格、比對與作廢、存見證者讀數、回應不含數字與結果、21 天、達成、AAD 綁挑戰', async () => {
  const body = { title: '減重 3%', kind: 'weight', dist_key: null, target: 3, opts: { verify: 'witness' }, start_date: D(-5), end_date: D(23), join_by: T,
    rewards: { badge: 'heart', shirt: { sizes: ['M'], quota: 10 } } };
  err(await call('t_chair', '/admin/ach', { method: 'POST', body: campBody({ ...body, join_by: D(6) }) }), 400, '體重挑戰的報名截止要在結束日 18 天以前');
  const cid = await campaign(body);
  const c = (await mine('t_runner', cid)).campaign;
  assert.deepEqual([c.rewards.board, c.confirm], [undefined, false], '體重挑戰不上恭喜榜、不用確認');
  err(await joinC('t_runner', cid), 400, '參加體重挑戰要先勾選同意');
  const j = ok(await joinC('t_runner', cid, { consent: true }));
  assert.ok(j.entry.consent_at);
  const eid = j.entry.id;
  const weigh = (which, kg, who = 't_runner') => call(who, `/ach/${cid}/weigh`, { method: 'POST', body: { which, kg } });
  const witness = (code, kg, who = 't_lead') => call(who, '/ach/witness', { method: 'POST', body: { code, kg } });
  err(await weigh('base', 29), 400, '體重請填 30–250 公斤');
  err(await weigh('last', 70), 400, '現在不是量結束體重的時間');
  let w = ok(await weigh('base', 72.4));
  assert.match(w.token, /^b[0-9a-z]{15}$/);
  assert.ok(!('kg' in w));
  assert.equal((await mine('t_runner', cid)).me.w_pending, 'base');
  assert.deepEqual(ok(await call('t_runner', `/ach/${cid}/wit`)), { pending: 'base', base_at: null, last_at: null, status: 'joined' });
  err(await witness(w.token, 72.4, 't_runner'), 403, '不能見證自己的量測');
  err(await witness(w.token, 72.4, 't_other'), 403, '只有協會幹部或這位跑友分團的幹部可以見證');
  err(await witness(w.token, 72.4, 't_coach'), 403, '只有協會幹部或這位跑友分團的幹部可以見證');
  err(await witness(w.token, 72.8), 400, '數字和跑友輸入的不一樣，請再看一次體重計');
  assert.equal((await dev(`entry=${eid}`)).entry.w_tries, 1);
  err(await witness(`cil-wit:${w.token}`, 72.0), 400, '數字和跑友輸入的不一樣，請再看一次體重計');
  err(await witness(w.token, 80), 400, '對不上 3 次，見證碼已作廢，請跑友重新產生');
  err(await witness(w.token, 72.4), 400, '見證碼無效或已過期，請跑友重新產生');
  // 過期
  w = ok(await weigh('base', 72.4));
  await dev(`expire=${eid}`);
  err(await witness(w.token, 72.4), 400, '見證碼無效或已過期，請跑友重新產生');
  // 差 0.2 公斤：成功，存的是見證者的讀數；回應沒有數字與結果
  w = ok(await weigh('base', 72.4));
  const r = ok(await witness(w.token, 72.6));
  assert.deepEqual(r, { ok: true, which: 'base', name: '跑友' });
  err(await witness(w.token, 72.6), 400, '見證碼無效或已過期，請跑友重新產生');
  const m = await mine('t_runner', cid);
  assert.deepEqual([m.weight.base.kg, m.me.w_pending, !!m.me.w_base_at, m.canWitness], [72.6, null, true, false]);
  assert.ok((await mine('t_lead', cid)).canWitness, '分團團長看得到見證按鈕');
  const wit = ok(await call('t_runner', `/ach/${cid}/wit`));
  assert.ok(!JSON.stringify(wit).includes('72') && wit.base_at);
  // 加密：v1、AAD 綁挑戰（複製到別的挑戰解不開 → weight:null）
  const enc = (await dev(`private=${cid}&member=t_runner`)).private.enc;
  assert.match(enc, /^v1\./);
  assert.ok(!enc.includes('726'));
  const other = await campaign({ ...body, title: '減重 3% 另一場', rewards: { badge: 'heart' } });
  ok(await joinC('t_runner', other, { consent: true }));
  await dev(`copyenc=${cid}&to=${other}&member=t_runner`);
  assert.equal((await mine('t_runner', other)).weight, null);
  // 結束量測：期間外 400；起始見證後不到 21 天 400；21 天以上可以
  err(await weigh('last', 70), 400, '現在不是量結束體重的時間');
  await dev(`camp=${cid}&end=${D(10)}`);
  err(await weigh('last', 70), 400, '結束量測要在起始量測 21 天以後');
  await dev(`wbase=${eid}&at=${D(-22)} 01:00:00`);
  w = ok(await weigh('last', 70.0));
  assert.match(w.token, /^l/);
  ok(await witness(w.token, 70.1, 't_chair'));
  const done = await mine('t_runner', cid);
  assert.deepEqual([done.me.status, done.weight.last.kg, done.weight.pct], ['achieved', 70.1, 3.4]);
  assert.ok((await notes('t_runner')).some((n) => n.title === '恭喜完成挑戰' && n.body.startsWith('「減重 3%」')));
  // 最小揭露：審核者的名單只有 joined、沒有時間；篩選無效；單筆詳細沒有數字與結果
  const a10 = ok(await call('t_chair', `/admin/ach/${cid}/entries?state=achieved`));
  const me10 = a10.entries.find((e) => e.member.id === 't_runner');
  assert.deepEqual([me10.status, me10.met_at, me10.achieved_at, me10.evidence], ['joined', null, null, null]);
  assert.ok(a10.entries.length >= 1);
  const a11 = ok(await call('t_chair', `/admin/ach/${cid}/entries/${eid}`));
  assert.deepEqual(Object.keys(a11.detail).sort(), ['verify', 'w_base_at', 'w_last_at']);
  assert.equal(a11.entry.status, 'joined');
  assert.ok(!JSON.stringify(a11).includes('70.1') && !JSON.stringify(a11).includes('kg10'));
  // 起始期間結束後不能再量起始
  await dev(`camp=${other}&join=${D(-1)}&start=${D(-10)}`);
  err(await weigh('base', 72, 't_runner').then(() => call('t_runner', `/ach/${other}/weigh`, { method: 'POST', body: { which: 'base', kg: 72 } })), 400, '現在不是量起始體重的時間');
  // 稽核只有代碼
  const au = (await auditOf('ach.witness')).filter((a) => a.target_id === eid).map((a) => a.detail);
  assert.deepEqual(au.sort(), [`c=${cid}｜w=b`, `c=${cid}｜w=l`]);
  assert.equal((await auditOf('ach.join')).find((a) => a.target_id === 't_runner' && a.detail === `c=${cid}｜consent`)?.detail, `c=${cid}｜consent`);
  S.weight = cid;
  S.weightOther = other;
});

test('分團體重挑戰：分團幹部只看得到有團服名額的列；別團的幹部不能見證', async () => {
  const cid = await campaign({ title: '青年減重', kind: 'weight', dist_key: null, target: 2, opts: { verify: 'witness' }, team_id: 'youth', start_date: D(-5), end_date: D(23), join_by: T,
    rewards: { badge: 'heart', shirt: { sizes: ['M'], quota: 5 } } });
  ok(await joinC('t_runner', cid, { consent: true }));
  const w = ok(await call('t_runner', `/ach/${cid}/weigh`, { method: 'POST', body: { which: 'base', kg: 65 } }));
  err(await call('t_coach', '/ach/witness', { method: 'POST', body: { code: w.token, kg: 65 } }), 403);
  const lim = ok(await call('t_lead', `/admin/ach/${cid}/entries`));
  assert.deepEqual([lim.limited, lim.entries.length], [true, 0], '還沒有團服名額：看不到誰參加');
  err(await call('t_coach', `/admin/ach/${cid}/entries`), 403);
  ok(await call('t_lead', '/ach/witness', { method: 'POST', body: { code: w.token, kg: 65.2 } }));
});

test('榮譽制體重：伺服器不收體重；聲明期間外 400；聲明直接達成（不進待確認）', async () => {
  const cid = await campaign({ title: '自主減重', kind: 'weight', dist_key: null, target: 2, opts: { verify: 'honor' }, start_date: D(-5), end_date: D(30), join_by: T, rewards: { badge: 'heart' } });
  ok(await joinC('t_other', cid));
  err(await call('t_other', `/ach/${cid}/weigh`, { method: 'POST', body: { which: 'base', kg: 70 } }), 404);
  err(await call('t_other', `/ach/${cid}/claim`, { method: 'POST', body: {} }), 400, '現在不是送出聲明的時間');
  await dev(`camp=${cid}&end=${D(5)}`);
  assert.deepEqual(ok(await call('t_other', `/ach/${cid}/claim`, { method: 'POST', body: {} })), { ok: true, status: 'achieved' });
  assert.equal((await dev(`private=${cid}&member=t_other`)).private, null);
  // 體重挑戰進行中不給達成人數（見證的幹部比對前後人數就知道那位跑友有沒有達成）
  assert.deepEqual((await mine('t_runner', cid)).stats, { joined: 1, done: null, granted: 0, waitlist: 0, issued: 0 });
  assert.equal(ok(await call('t_chair', '/admin/ach')).campaigns.find((c) => c.id === cid).stats.done, null);
  assert.ok(!ok(await call('t_chair', '/admin/ach')).met.some((m) => m.cid === cid));
  err(await call('t_other', `/ach/${cid}/leave`, { method: 'POST', body: {} }), 400, '已經達成，不能退出');
});

test('退出與刪除體重：退出見證制刪體重（privacy.ach_weight_delete c=｜leave）；只刪體重 c=、已達成的不變；開關關閉也可以；取消挑戰同時刪體重並通知', async () => {
  const cid = S.weight, other = S.weightOther;
  // t_runner 在 other 有體重（複製過去的）：退出 → 刪掉
  ok(await call('t_runner', `/ach/${other}/leave`, { method: 'POST', body: {} }));
  assert.equal((await dev(`private=${other}&member=t_runner`)).private, null);
  assert.ok((await auditOf('privacy.ach_weight_delete')).some((a) => a.target_id === 't_runner' && a.detail === `c=${other}｜leave`));
  // 開關關閉時：只刪體重照樣可以；已達成的狀態不變
  await setFeat({ achieve: false });
  assert.deepEqual(ok(await call('t_runner', `/ach/${cid}/weight`, { method: 'DELETE' })), { ok: true, status: 'achieved' });
  err(await call('t_runner', `/ach/${cid}/weight`, { method: 'DELETE' }), 404, '沒有體重資料');
  err(await joinC('t_other', cid, { consent: true }), 403, '協會目前沒有開放成績與挑戰');
  await setFeat({ achieve: true });
  const m = await mine('t_runner', cid);
  assert.deepEqual([m.me.status, m.weight], ['achieved', null]);
  assert.ok((await auditOf('privacy.ach_weight_delete')).some((a) => a.detail === `c=${cid}`));
  // 取消：體重資料同一個 batch 刪掉、參加者收到通知
  const u = await fresh('取消跑友');
  const c2 = await campaign({ title: '取消測試', kind: 'weight', dist_key: null, target: 2, opts: { verify: 'witness' }, start_date: D(-5), end_date: D(23), join_by: T, rewards: { badge: 'heart' } });
  ok(await joinC(u.cookie, c2, { consent: true }));
  ok(await call(u.cookie, `/ach/${c2}/weigh`, { method: 'POST', body: { which: 'base', kg: 80 } }));
  assert.ok((await dev(`private=${c2}&member=${u.id}`)).private);
  ok(await call('t_chair', `/admin/ach/${c2}/cancel`, { method: 'POST', body: { note: '場地借不到' } }));
  assert.equal((await dev(`private=${c2}&member=${u.id}`)).private, null);
  assert.ok((await notes(u.cookie)).some((n) => n.title === '挑戰取消了' && n.body === '「取消測試」：場地借不到。你的體重資料已刪除'));
  err(await call('t_chair', `/admin/ach/${c2}/cancel`, { method: 'POST', body: {} }), 409);
});

test('恭喜榜：沒打開的不出現、打開後出現；體重挑戰不出現；私密分團只有團員看得到；不能恭喜自己；看不到的 400；收回；限流；排行同秒並列、只有同意的人', async () => {
  const a = await fresh('恭喜甲'), b = await fresh('恭喜乙');
  const pa = await submit(a.cookie, { race_date: D(-3), seconds: 12000 });
  ok(await approve(pa));
  const board = async (who, q = '') => ok(await call(who, `/ach/board${q}`));
  assert.ok(!(await board(b.cookie)).items.some((x) => x.item === `pb:${pa}`), '沒打開恭喜榜');
  assert.deepEqual((await board(a.cookie)).me, { cheer_board: false, cheer_rank: false });
  ok(await call(a.cookie, '/me/cheer-board', { method: 'POST', body: { on: true } }));
  const it = (await board(b.cookie)).items.find((x) => x.item === `pb:${pa}`);
  assert.deepEqual([it.type, it.member.name, it.self, it.cheers, it.pb.pb_kind, it.pb.seconds], ['pb', '恭喜甲', false, 0, 'first', 12000]);
  assert.equal((await board(a.cookie)).items.find((x) => x.item === `pb:${pa}`).self, true);
  err(await call(a.cookie, '/ach/cheer', { method: 'POST', body: { item: `pb:${pa}`, on: true } }), 403, '不能恭喜自己');
  assert.deepEqual(ok(await call(b.cookie, '/ach/cheer', { method: 'POST', body: { item: `pb:${pa}`, on: true } })), { ok: true, cheers: 1, cheered: true });
  assert.deepEqual(ok(await call(b.cookie, '/ach/cheer', { method: 'POST', body: { item: `pb:${pa}`, on: true } })), { ok: true, cheers: 1, cheered: true }, '重複按不會變兩次');
  assert.deepEqual(ok(await call(b.cookie, '/ach/cheer', { method: 'POST', body: { item: `pb:${pa}`, on: false } })), { ok: true, cheers: 0, cheered: false });
  err(await call(b.cookie, '/ach/cheer', { method: 'POST', body: { item: 'pb:nope', on: true } }), 400, '這則恭喜已經看不到了');
  // 體重挑戰不上榜（t_runner 完成了減重 3%）
  ok(await call('t_runner', '/me/cheer-board', { method: 'POST', body: { on: true } }));
  assert.ok(!(await board(b.cookie)).items.some((x) => x.type === 'ach' && x.ach.kind === 'weight'));
  // 私密分團：core 改成私密，只有團員看得到分團 pill 與分團挑戰
  await dev('tpriv=core&on=1');
  await dev(`team=core&add=${a.id}`);
  const pc = await campaign({ title: '核心團破 PB', kind: 'pb', dist_key: null, target: null, opts: { first_ok: 1 }, team_id: 'core', rewards: { badge: 'medal', board: 1 } });
  ok(await joinC(a.cookie, pc));
  const item = (await board(a.cookie)).items.find((x) => x.type === 'ach' && x.ach.cid === pc);
  assert.ok(item, '團員看得到');
  assert.ok(!(await board(b.cookie)).items.some((x) => x.type === 'ach' && x.ach.cid === pc), '別人看不到私密分團的挑戰');
  err(await call(b.cookie, '/ach/cheer', { method: 'POST', body: { item: item.item, on: true } }), 400, '這則恭喜已經看不到了');
  err(await call(b.cookie, '/ach/board?team=core'), 403);
  await dev('tpriv=core&on=0');
  // 限流 60 次／10 分
  let r;
  for (let i = 0; i < 70; i++) { r = await call(b.cookie, '/ach/cheer', { method: 'POST', body: { item: `pb:${pa}`, on: i % 2 === 0 } }); if (r.status === 429) break; }
  err(r, 429, '恭喜太頻繁，請稍後再試');
  await rate(`cheer:${b.id}`);
  // 排行：只有同時打開恭喜榜與排行的人；同秒同日並列；achieve_rank 關時沒有 rank
  const pb2 = await submit(b.cookie, { race_date: D(-3), seconds: 12000, race_name: '另一場' });
  ok(await approve(pb2));
  ok(await call(b.cookie, '/me/cheer-board', { method: 'POST', body: { rank: true } }));
  let rk = await board(b.cookie, '?tab=rank&dist=fm');
  assert.ok(rk.rank.some((x) => x.member.id === b.id) && !rk.rank.some((x) => x.member.id === a.id), '甲沒有同意排行');
  assert.equal(rk.mine.member.id, b.id);
  ok(await call(a.cookie, '/me/cheer-board', { method: 'POST', body: { rank: true } }));
  rk = await board(b.cookie, '?tab=rank&dist=fm');
  const ra = rk.rank.find((x) => x.member.id === a.id), rb = rk.rank.find((x) => x.member.id === b.id);
  assert.equal(ra.rk, rb.rk, '同秒同日並列');
  await setFeat({ achieve_rank: false });
  assert.ok(!('rank' in (await board(b.cookie, '?tab=rank&dist=fm'))));
  await setFeat({ achieve_rank: true });
});

test('隱私開關：恭喜榜開關寫稽核；{ rank: true } 而恭喜榜還關著時兩個一起打開、寫兩筆；pub() 的欄位', async () => {
  const u = await fresh('隱私跑友');
  ok(await call(u.cookie, '/me/cheer-board', { method: 'POST', body: { rank: true } }));
  let me = ok(await call(u.cookie, '/me')).member;
  assert.deepEqual([me.cheer_board, me.cheer_rank], [true, true]);
  const ab = (await auditOf('privacy.cheer_board')).filter((a) => a.actor_name === '隱私跑友').map((a) => a.detail);
  const ar = (await auditOf('privacy.cheer_rank')).filter((a) => a.actor_name === '隱私跑友').map((a) => a.detail);
  assert.deepEqual([ab, ar], [['開啟'], ['開啟']]);
  ok(await call(u.cookie, '/me/cheer-board', { method: 'POST', body: { on: false } }));
  me = ok(await call(u.cookie, '/me')).member;
  assert.deepEqual([me.cheer_board, me.cheer_rank], [false, true]);
  assert.deepEqual((await auditOf('privacy.cheer_board')).filter((a) => a.actor_name === '隱私跑友').map((a) => a.detail).sort(), ['關閉', '開啟'].sort());
  assert.ok(ok(await call('t_chair', '/me')).member.ach.queue >= 0);
  assert.equal(ok(await call('t_runner', '/me')).member.ach.queue, 0, '不是審核者一律 0');
});

test('匯出：成績、截圖、挑戰、解密後的體重、恭喜人數；不含審核人、發放人、見證碼', async () => {
  const u = await fresh('匯出跑友');
  const pid = ok(await call(u.cookie, '/pb', { method: 'POST', body: pbBody({ proof: WEBP }) })).id;
  const cid = await campaign({ title: '匯出減重', kind: 'weight', dist_key: null, target: 2, opts: { verify: 'witness' }, start_date: D(-5), end_date: D(23), join_by: T, rewards: { badge: 'heart' } });
  ok(await joinC(u.cookie, cid, { consent: true }));
  ok(await call(u.cookie, `/ach/${cid}/weigh`, { method: 'POST', body: { which: 'base', kg: 66.6 } }));
  const ex = ok(await call(u.cookie, '/me/export'));
  assert.equal(ex.pb_records[0].id, pid);
  assert.ok(!('review_by' in ex.pb_records[0]));
  assert.equal(ex.pb_proofs[0].pb_id, pid);
  assert.equal(ex.challenges[0].title, '匯出減重');
  assert.ok(!('issued_by' in ex.challenges[0]) && !('w_token' in ex.challenges[0]));
  assert.deepEqual([ex.challenge_weights[0].campaign_id, ex.challenge_weights[0].p.kg10], [cid, 666]);
  assert.deepEqual(ex.cheers, { given: 0, received: 0 });
  assert.equal(ex.profile.cheer_board, 0);
});

test('稽核與推播不含個資：detail 沒有時間、體重、原因文字、姓名；推播內容不含時間與名字', async () => {
  const rows = [];
  for (const p of ['pb.', 'ach.', 'privacy.cheer', 'privacy.ach']) rows.push(...(await call('t_chair', `/audit?action=${p}`)).json.items);
  assert.ok(rows.length > 10);
  const names = ['測試跑友', '路人跑友', '測試團長', '里程k1', '恭喜甲', '跑友'];
  for (const r of rows) {
    const d = r.detail || '';
    assert.ok(!/\d:\d{2}/.test(d) && !/kg/i.test(d) && !d.includes('疑問') && !d.includes('有誤') && !names.some((n) => d.includes(n)), `${r.action}：${d}`);
  }
  // 推播（PUSH_MOCK）：核准與達成的推播內容只有固定的標題與一句話
  const ep = 'https://fcm.googleapis.com/fcm/send/b_ach_push', u = await fresh('推播跑友');
  ok(await call(u.cookie, '/push/subscribe', { method: 'POST', body: { endpoint: ep, keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) } } }));
  await call(null, '/dev/push-mock?clear=1');
  const cid = await campaign({ title: '推播測試破 4' });
  ok(await joinC(u.cookie, cid));
  ok(await approve(await submit(u.cookie, { race_date: D(-2), seconds: 14100 })));
  for (let i = 0; i < 20; i++) { const d = (await call(null, '/dev/drain')).json; if (!d.queue) break; }
  const got = (await call(null, '/dev/push-mock')).json.list.filter((x) => x.endpoint === ep).map((x) => x.text);
  assert.deepEqual(got.sort(), ['你的成績通過審核｜點開看你的成績', '恭喜完成挑戰｜點開看你的挑戰'].sort());
  await call(u.cookie, '/push/unsubscribe', { method: 'POST', body: { endpoint: ep } });
});

test('待處理摘要：審核者有 pb 與 achMet；清空時其他審核者的「成績待審核」待辦一起標成已讀；送出成績一小時只通知一次', async () => {
  // 先把所有待審核的清掉
  for (let i = 0; i < 5; i++) {
    const items = ok(await call('t_chair', '/admin/pb?status=pending')).items;
    if (!items.length) break;
    for (const p of items) await call(p.member.id === 't_chair' ? 't_staff' : 't_chair', `/admin/pb/${p.id}/review`, { method: 'POST', body: { approve: false, code: 'other' } });
  }
  await rate('pbq:notify');
  const before = new Set((await notes('t_staff', 'todo')).filter((n) => n.ref === 'pb:queue').map((n) => n.id));
  const u = await fresh('待辦跑友');
  const id = await submit(u.cookie, { race_date: D(-2) });
  await submit(u.cookie, { race_date: D(-3) });
  const q = (await notes('t_staff', 'todo')).filter((n) => n.ref === 'pb:queue');
  assert.ok(q.length >= 1 && !q[0].read_at);
  assert.equal(q.filter((n) => !before.has(n.id)).length, 1, '一小時一則');
  const todo = ok(await call('t_chair', '/notifications?cat=todo')).todo;
  assert.equal(todo.pb, 2);
  assert.equal(typeof todo.achMet, 'number');
  assert.ok(todo.total >= 2);
  ok(await approve(id));
  assert.ok(!(await notes('t_staff', 'todo')).find((n) => n.ref === 'pb:queue').read_at, '還有一筆待審核');
  for (const p of ok(await call('t_chair', '/admin/pb?status=pending')).items) ok(await approve(p.id));
  assert.ok((await notes('t_staff', 'todo')).filter((n) => n.ref === 'pb:queue').every((n) => n.read_at), '清空了：其他審核者的待辦標成已讀');
});
