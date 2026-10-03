// API 權限與核心流程測試：每次改程式都重跑，確認權限沒有被改壞
// 需要：測試用伺服器（npm run test:ci 會自動啟動），帳號見 tests/seed.sql
import { test } from 'node:test';
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
async function call(who, path, { method = 'GET', body } = {}) {
  const headers = { origin: BASE };
  if (who) headers.cookie = await as(who);
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const plus = (d) => new Date(Date.now() + 8 * 3600e3 + d * 864e5).toISOString().slice(0, 10);

test('沒登入不能讀資料；跨站寫入被擋', async () => {
  assert.equal((await call(null, '/members')).status, 401);
  assert.equal((await call(null, '/events')).status, 401);
  const r = await fetch(`${BASE}/api/events`, { method: 'POST', headers: { cookie: await as('t_chair'), origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403, '別的網域送來的寫入要擋');
  const r2 = await fetch(`${BASE}/api/events`, { method: 'POST', headers: { cookie: await as('t_chair'), 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r2.status, 415, '不是 JSON 的寫入要擋');
});

test('邀請碼只能成為跑友；初始理事長碼在已有理事長時無效', async () => {
  const j = await call(null, '/join', { method: 'POST', body: { code: 'wrong', name: 'x', consent: true } });
  assert.equal(j.status, 403);
  const c = await call('t_runner', '/me/admin', { method: 'POST', body: { code: 'test-chair' } });
  assert.equal(c.status, 403, '已有理事長，初始設定碼不能再用');
});

test('名冊一定要帶條件；電話依權限遮罩', async () => {
  const none = await call('t_chair', '/members');
  assert.equal(none.json.needFilter, true);
  assert.equal(none.json.members.length, 0);
  const q = await call('t_chair', '/members?q=測試');
  assert.ok(q.json.members.length >= 3);
  assert.equal((await call('t_runner', '/members?q=測試')).status, 403, '跑友不能看名冊');
});

test('稽核：只有理事長與監事能看，而且一定要有時間區間', async () => {
  assert.equal((await call('t_staff', '/audit')).status, 403);
  assert.equal((await call('t_super', '/audit')).status, 200);
  assert.equal((await call('t_chair', '/audit?from=2020-01-01&to=2026-10-01')).status, 400, '超過一年要擋');
});

test('身分只能由理事長指派；監事唯讀', async () => {
  assert.equal((await call('t_staff', '/members/t_runner/role', { method: 'POST', body: { role: 'staff' } })).status, 403);
  assert.equal((await call('t_super', '/members/t_runner/membership', { method: 'POST', body: { membership: 'active' } })).status, 403);
});

test('分團：團長可建自己分團的活動、不能建全協會活動；團長只能由理事長指派', async () => {
  assert.equal((await call('t_lead', '/events', { method: 'POST', body: { kind: 'track', title: '全協會', date: plus(3) } })).status, 403);
  const ok = await call('t_lead', '/events', { method: 'POST', body: { kind: 'track', title: '青年團練', date: plus(3), team_id: 'youth' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await call('t_lead', '/events', { method: 'POST', body: { kind: 'track', title: '別團', date: plus(3), team_id: 'kids' } })).status, 403);
  const lead = await call('t_lead', '/teams/youth/members', { method: 'POST', body: { member_id: 't_runner', action: 'role', role: 'lead' } });
  assert.equal(lead.status, 403);
  const officer = await call('t_lead', '/teams/youth/members', { method: 'POST', body: { member_id: 't_runner', action: 'role', role: 'officer' } });
  assert.equal(officer.status, 200);
  await call('t_lead', '/teams/youth/members', { method: 'POST', body: { member_id: 't_runner', action: 'role', role: 'member' } });
});

test('私密分團的活動，非團員看不到', async () => {
  const team = await call('t_chair', '/teams', { method: 'POST', body: { name: '私密測試團', private: true } });
  await call('t_chair', `/teams/${team.json.id}`, { method: 'PUT', body: { name: '私密測試團', private: true } });
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'core', title: '私密課', date: plus(4), team_id: team.json.id, notify: false } });
  assert.equal((await call('t_other', `/events/${ev.json.id}`)).status, 404);
  assert.ok(!(await call('t_other', '/events')).json.events.some((e) => e.id === ev.json.id));
  assert.equal((await call(null, `/public/e/${ev.json.id}`)).status, 404);
});

test('邀請制：只有受邀的人看得到，移出後立刻看不到', async () => {
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'other', title: '邀請制聚餐', date: plus(5), visibility: 'invite' } });
  const id = ev.json.id;
  assert.equal((await call('t_runner', `/events/${id}`)).status, 404);
  assert.equal((await call('t_chair', `/events/${id}/invites`, { method: 'POST', body: { member_ids: ['t_runner'] } })).json.added, 1);
  assert.equal((await call('t_runner', `/events/${id}`)).status, 200);
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: {} })).status, 200);
  await call('t_chair', `/events/${id}/invites/t_runner`, { method: 'DELETE' });
  assert.equal((await call('t_runner', `/events/${id}`)).status, 404);
  // 邀請連結：錯的代碼不行，對的才加入
  const tok = (await call('t_chair', `/events/${id}/invite-link`, { method: 'POST', body: { on: true } })).json.token;
  assert.equal((await call('t_other', `/events/${id}/accept`, { method: 'POST', body: { t: 'nope' } })).status, 404);
  assert.equal((await call('t_other', `/events/${id}/accept`, { method: 'POST', body: { t: tok } })).status, 200);
  assert.equal((await call('t_other', `/events/${id}`)).status, 200);
});

test('問卷：必填與選項驗證；CSV 擋公式注入', async () => {
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'other', title: '團服調查', date: plus(6), notify: false,
    questions: [{ type: 'single', label: '尺寸', options: ['S', 'M'], required: true }, { type: 'text', label: '備註' }] } });
  const id = ev.json.id;
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { answers: {} } })).status, 400);
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { answers: { q1: 'XXL' } } })).status, 400);
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { answers: { q1: 'M', q2: '=HYPERLINK("x")' } } })).status, 200);
  assert.equal((await call('t_runner', `/events/${id}/stats`)).status, 403, '跑友不能看統計');
  const csv = await call('t_chair', `/events/${id}/export.csv`);
  assert.ok(csv.text.includes(`"'=HYPERLINK`), '開頭是 = 的儲存格要加 \' ');
});

test('訓練紀錄：不能記未來、查詢有上限、教練要本人分享才看得到', async () => {
  assert.equal((await call('t_runner', '/logs', { method: 'POST', body: { date: plus(5), km: 5 } })).status, 400);
  const r = await call('t_runner', '/logs', { method: 'POST', body: { date: today, status: 'done', km: 10, seconds: 3000, rpe: 6, note: '私人備註' } });
  assert.equal(r.status, 200);
  assert.equal((await call('t_runner', '/logs?from=2024-01-01&to=2026-10-01')).status, 400);
  assert.equal((await call('t_coach', '/logs/member/t_runner')).status, 403, '沒分享不能看');
  await call('t_runner', '/me/share-logs', { method: 'POST', body: { share: true } });
  const seen = await call('t_coach', '/logs/member/t_runner');
  assert.equal(seen.status, 200);
  assert.ok(seen.json.logs.every((l) => !('note' in l)), '教練看不到備註');
  assert.equal((await call('t_other', `/logs/${r.json.id}`, { method: 'DELETE' })).status, 200);
  assert.ok((await call('t_runner', `/logs?from=${today}&to=${today}`)).json.logs.some((l) => l.id === r.json.id), '別人刪不掉我的紀錄');
});

test('排程：活動提醒不重複；每季檢視只發一次', async () => {
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'track', title: '提醒測試', date: '2027-03-10', gather_time: '19:00', notify: false } });
  await call('t_runner', `/events/${ev.json.id}/signup`, { method: 'POST', body: {} });
  const a = await call(null, '/dev/cron?at=2027-03-09T12:00:00Z');
  assert.ok(a.json.events >= 1);
  assert.equal((await call(null, '/dev/cron?at=2027-03-09T12:00:00Z')).json.events, 0);
  assert.equal((await call(null, '/dev/cron?at=2027-04-01T01:00:00Z')).json.review, 2, '通知理事長與監事');
  assert.equal((await call(null, '/dev/cron?at=2027-04-01T01:00:00Z')).json.review, 0);
});

test('行事曆訂閱：只有本人的活動，停用後立即失效', async () => {
  const { json } = await call('t_runner', '/me/calendar', { method: 'POST' });
  const r = await fetch(json.url.replace(/^https?:\/\/[^/]+/, BASE));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /BEGIN:VCALENDAR/);
  await call('t_runner', '/me/calendar', { method: 'DELETE' });
  assert.equal((await fetch(json.url.replace(/^https?:\/\/[^/]+/, BASE))).status, 404);
});

test('群發通知：只允許站內連結，跑友不能用', async () => {
  assert.equal((await call('t_runner', '/admin/broadcast', { method: 'POST', body: { title: 'x' } })).status, 403);
  assert.equal((await call('t_chair', '/admin/broadcast', { method: 'POST', body: { title: 'x', url: 'https://evil.example' } })).status, 400);
  assert.equal((await call('t_chair', '/admin/broadcast', { method: 'POST', body: { title: 'x', teams: ['youth'], dryRun: true } })).json.count, 2);
});

test('稽核紀錄有簽章，完整性檢查通過', async () => {
  const r = await call('t_chair', `/audit/verify?from=${plus(-1)}&to=${today}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.modified, 0);
  assert.ok(r.json.checked > 0);
});

test('個資：本人可匯出，匯出不含行事曆代碼與登入權杖', async () => {
  const r = await call('t_runner', '/me/export');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('cal_token_hash') && !r.text.includes('token_hash'));
});

test('Google 登入：導向 Google 授權頁、只要 openid profile、綁定模式帶標記、state 不符或取消都擋下', async () => {
  const r = await fetch(`${BASE}/api/google/start`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), `${BASE}/api/google/callback`);
  assert.equal(loc.searchParams.get('scope'), 'openid profile', '不要 Email');
  assert.ok(loc.searchParams.get('nonce') && loc.searchParams.get('state'));
  assert.match(r.headers.get('set-cookie'), /__Host-cil_oauth=\w+\.\w+;/);
  const l = await fetch(`${BASE}/api/google/start?link=1`, { redirect: 'manual', headers: { cookie: await as('t_runner') } });
  assert.match(l.headers.get('set-cookie'), /__Host-cil_oauth=\w+\.\w+\.L;/, '綁定模式要帶 .L');
  const anon = await fetch(`${BASE}/api/google/start?link=1`, { redirect: 'manual' });
  assert.doesNotMatch(anon.headers.get('set-cookie'), /\.L;/, '沒登入不能進綁定模式');
  const bad = await fetch(`${BASE}/api/google/callback?code=x&state=forged`, { redirect: 'manual', headers: { cookie: '__Host-cil_oauth=real.nonce' } });
  assert.match(decodeURIComponent(bad.headers.get('location')), /登入逾時/);
  const cancel = await fetch(`${BASE}/api/google/callback?error=access_denied&state=x`, { redirect: 'manual' });
  assert.match(decodeURIComponent(cancel.headers.get('location')), /取消/);
  assert.equal((await call(null, '/me')).json.googleLogin, true);
  assert.equal((await fetch(`${BASE}/api/line/start`, { redirect: 'manual' })).status, 404, 'LINE 登入已移除');
});

test('倒數：可以選自己的賽事、協會預設或不顯示；常用賽事清單只有幹部能改', async () => {
  assert.equal((await call('t_runner', '/settings/race-presets', { method: 'POST', body: { presets: [] } })).status, 403);
  const p = await call('t_chair', '/settings/race-presets', { method: 'POST', body: { presets: [{ name: '測試馬', date: plus(30), dist: '全馬' }, { name: '沒日期' }] } });
  assert.equal(p.json.presets.length, 1, '沒日期的要濾掉');
  assert.equal((await call('t_runner', '/races')).json.presets.length, 1);
  await call('t_runner', '/me/countdown', { method: 'POST', body: { mode: 'off' } });
  assert.equal((await call('t_runner', '/me')).json.race, null);
  await call('t_runner', '/me/countdown', { method: 'POST', body: { mode: 'club' } });
  assert.equal((await call('t_runner', '/me')).json.race.mine, false);
  await call('t_runner', '/races', { method: 'POST', body: { name: '我的比賽', date: plus(10), is_primary: true } });
  await call('t_runner', '/me/countdown', { method: 'POST', body: { mode: 'mine' } });
  assert.equal((await call('t_runner', '/me')).json.race.name, '我的比賽');
});

test('GPS 跑步記錄可以存成訓練紀錄（來源 gps）', async () => {
  const r = await call('t_runner', '/logs', { method: 'POST', body: { date: today, status: 'extra', km: 5.2, seconds: 1800, source: 'gps' } });
  assert.equal(r.status, 200);
  const l = (await call('t_runner', `/logs?from=${today}&to=${today}`)).json.logs.find((x) => x.id === r.json.id);
  assert.equal(l.source, 'gps');
});

test('分團：申請加入要該團幹部核准、不能自己退出主團；耕建築只由耕建築幹部處理；所屬跑團跟著主團', async () => {
  assert.equal((await call('t_other', '/teams/youth/join', { method: 'POST' })).json.status, 'pending');
  assert.equal((await call('t_staff', '/teams/youth/members', { method: 'POST', body: { member_id: 't_other', action: 'approve' } })).status, 200, '一般分團協會幹部也能核准');
  assert.equal((await call('t_other', '/teams/youth/leave', { method: 'POST' })).status, 200, '不是主團可以退出');
  assert.equal((await call('t_super', '/members/main-team', { method: 'POST', body: { member_ids: ['t_other'], team_id: 'youth' } })).status, 403, '監事唯讀');
  const r = await call('t_staff', '/members/main-team', { method: 'POST', body: { member_ids: ['t_other', 't_lead'], team_id: 'kids' } });
  assert.equal(r.json.count, 2);
  const me = (await call('t_other', '/me')).json;
  assert.equal(me.member.main_team, 'kids');
  assert.equal(me.member.club, '小耕跑', '所屬跑團跟著主團');
  assert.equal((await call('t_other', '/teams/kids/leave', { method: 'POST' })).status, 403, '主團不能自己退');
  assert.equal((await call('t_lead', '/me')).json.teams.find((t) => t.id === 'youth').my_role, 'lead', '團長的分團保留');
  // 耕建築：協會幹部不能設主團、不能代為核准；耕建築幹部可以
  assert.equal((await call('t_staff', '/members/main-team', { method: 'POST', body: { member_ids: ['t_other'], team_id: 'geng' } })).status, 403);
  await call('t_runner', '/teams/geng/join', { method: 'POST' });
  assert.equal((await call('t_chair', '/teams/geng/members', { method: 'POST', body: { member_id: 't_runner', action: 'approve' } })).status, 403);
  await call('t_staff', '/teams/geng/members', { method: 'POST', body: { member_id: 't_other', action: 'add', role: 'officer' } }).then((x) => assert.equal(x.status, 403, '協會幹部不能直接加人'));
  // 待審核清單：協會幹部看不到耕建築的申請，耕建築幹部看得到
  assert.ok(!(await call('t_staff', '/teams/pending')).json.pending.some((r) => r.team_id === 'geng'));
  assert.ok((await call('t_coach', '/teams/pending')).json.pending.some((r) => r.team_id === 'geng' && r.id === 't_runner'));
  assert.ok((await call('t_chair', '/teams/pending')).json.pending.every((r) => r.team_id !== 'geng'));
  // 理事長可以指派任何分團的團長（耕建築沒有幹部時才不會卡住）
  assert.equal((await call('t_chair', '/teams/geng/members', { method: 'POST', body: { member_id: 't_other', action: 'add', role: 'lead' } })).status, 200);
  assert.equal((await call('t_other', '/me')).json.teams.find((t) => t.id === 'geng').my_role, 'lead');
  assert.ok((await call('t_staff', '/members?team=none')).json.members.every((m) => !m.main_team));
});

test('代為團體報名：要先填好賽事報名資料並同意；組別價格；只有主辦幹部能下載，資料加密保存', async () => {
  const profile = { name_zh: '測試跑友', name_en: 'TEST RUNNER', id_no: 'a123456789', birthday: '1990-01-01', gender: '男', phone: '0912345678',
    email: 'runner@example.com', address: '台北市測試路 1 號', emergency_name: '家人', emergency_phone: '0922000000', emergency_rel: '配偶', shirt: 'M' };
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'other', title: '臺北馬團體報名', date: plus(40), notify: false, group_reg: true,
    options: [{ name: '全馬', price: 1650 }, { name: '半馬', price: 1350 }] } });
  const id = ev.json.id;
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { option: '全馬', reg_consent: true } })).status, 400, '還沒填賽事報名資料');
  assert.equal((await call('t_runner', '/me/race-profile', { method: 'PUT', body: { ...profile, id_no: 'not-an-id!' } })).status, 400);
  const put = await call('t_runner', '/me/race-profile', { method: 'PUT', body: profile });
  assert.equal(put.json.complete, true);
  assert.equal((await call('t_runner', '/me/race-profile')).json.profile.id_no, 'A123456789', '本人看得到完整內容');
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { reg_consent: true } })).status, 400, '有組別要選');
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { option: '全馬' } })).status, 400, '沒勾同意');
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { option: '全馬', reg_consent: true } })).status, 200);
  const st = (await call('t_chair', `/events/${id}/stats`)).json;
  assert.equal(st.byOption['全馬'], 1);
  assert.equal((await call('t_runner', `/events/${id}/registrations.csv`)).status, 403, '跑友不能下載');
  assert.equal((await call('t_super', `/events/${id}/registrations.csv`)).status, 403, '監事唯讀');
  const csv = await call('t_chair', `/events/${id}/registrations.csv`);
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('A123456789') && csv.text.includes('全馬'));
  // 刪除後，已同意的也一起撤回
  await call('t_runner', '/me/race-profile', { method: 'DELETE' });
  assert.ok(!(await call('t_chair', `/events/${id}/registrations.csv`)).text.includes('A123456789'));
  assert.equal((await call('t_runner', '/me/race-profile')).json.profile, null);
});

test('移交理事長：要輸入對方姓名確認；一步完成，雙方舊的工作階段作廢', async () => {
  assert.equal((await call('t_staff', '/members/t_runner/handover', { method: 'POST', body: { my_role: 'member', confirm: '測試跑友' } })).status, 403, '只有理事長能移交');
  const name = (await call('t_runner', '/me')).json.member.name;
  assert.equal((await call('t_chair', '/members/t_runner/handover', { method: 'POST', body: { my_role: 'director', confirm: '錯的名字' } })).status, 400);
  assert.equal((await call('t_chair', '/members/t_runner/handover', { method: 'POST', body: { my_role: 'chair', confirm: name } })).status, 400, '自己要改成別的身分');
  const r = await call('t_chair', '/members/t_runner/handover', { method: 'POST', body: { my_role: 'director', confirm: name } });
  assert.equal(r.status, 200);
  assert.equal(r.json.member.role, 'director');
  assert.equal((await call('t_runner', '/me')).json.member, null, '對方要重新登入');
  delete cookies.t_runner; delete cookies.t_chair;
  assert.equal((await call('t_runner', '/me')).json.member.role, 'chair');
  // 還原：移交回去，讓其他測試不受影響
  const back = await call('t_runner', '/members/t_chair/handover', { method: 'POST', body: { my_role: 'member', confirm: (await call('t_chair', '/me')).json.member.name } });
  assert.equal(back.status, 200);
  delete cookies.t_runner; delete cookies.t_chair;
});

test('團購與收費：尺寸、每人上限、庫存；早鳥與會員優惠由伺服器計算；回報繳費、確認收款、訂購單', async () => {
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'buy', title: '團服團購', date: plus(20), notify: false,
    fee: 0, items: [{ name: '團服', price: 600, sizes: 'S,M,L', stock: 3, max: 2 }, { name: '帽子', price: 300 }],
    pay_info: { account: '台灣銀行 004 帳號 123-456-789', due: plus(10), methods: ['transfer', 'cash'] }, min_qty: 10 } });
  const id = ev.json.id;
  const e = (await call('t_runner', `/events/${id}`)).json;
  const shirt = e.items.find((i) => i.name === '團服'), hat = e.items.find((i) => i.name === '帽子');
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: {} })).status, 400, '團購至少選一項');
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { items: [{ id: shirt.id, qty: 1 }] } })).status, 400, '要選尺寸');
  assert.equal((await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { items: [{ id: shirt.id, size: 'M', qty: 3 }] } })).status, 400, '每人上限');
  const r = await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { items: [{ id: shirt.id, size: 'M', qty: 2 }, { id: hat.id, qty: 1 }], amount: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.amount, 1500, '金額以伺服器計算為準，不信任前端送來的數字');
  assert.equal((await call('t_other', `/events/${id}/signup`, { method: 'POST', body: { items: [{ id: shirt.id, size: 'S', qty: 2 }] } })).status, 400, '庫存只剩 1 件');
  // 回報繳費 → 幹部確認
  assert.equal((await call('t_runner', `/events/${id}/pay-report`, { method: 'POST', body: { method: 'transfer', ref: 'abc' } })).status, 400, '後五碼要是數字');
  assert.equal((await call('t_runner', `/events/${id}/pay-report`, { method: 'POST', body: { method: 'transfer', ref: '12345' } })).status, 200);
  let st = (await call('t_chair', `/events/${id}/stats`)).json;
  assert.equal(st.money.expected, 1500);
  assert.equal(st.money.reportedN, 1);
  assert.equal(st.items.find((i) => i.name === '團服').by.M, 2);
  assert.equal((await call('t_runner', `/events/${id}/payments`, { method: 'POST', body: { member_ids: ['t_runner'], paid: 'paid' } })).status, 403, '團員不能自己標已繳');
  await call('t_chair', `/events/${id}/payments`, { method: 'POST', body: { member_ids: ['t_runner'], paid: 'paid' } });
  st = (await call('t_chair', `/events/${id}/stats`)).json;
  assert.equal(st.money.collected, 1500);
  // 已繳後追加：改回未繳並記下差額
  await call('t_runner', `/events/${id}/signup`, { method: 'POST', body: { items: [{ id: shirt.id, size: 'M', qty: 2 }, { id: hat.id, qty: 2 }] } });
  const me2 = (await call('t_runner', `/events/${id}`)).json;
  assert.equal(me2.myAmount, 1800);
  assert.equal(me2.myPaid, 'unpaid');
  assert.match(me2.myPaidNote, /追加 300/);
  const csv = await call('t_chair', `/events/${id}/orders.csv`);
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('團服（M）') && csv.text.includes('1800'));
  assert.equal((await call('t_runner', `/events/${id}/orders.csv`)).status, 403);
  // 早鳥＋會員優惠：只折報名費，折到 0 為止
  const ev2 = await call('t_chair', '/events', { method: 'POST', body: { kind: 'race', title: '早鳥測試', date: plus(30), notify: false,
    options: [{ name: '全馬', price: 1000 }], pricing: { early_until: plus(5), early_off: 200, member_off: 900 } } });
  const r2 = await call('t_staff', `/events/${ev2.json.id}/signup`, { method: 'POST', body: { option: '全馬' } });
  assert.equal(r2.json.amount, 800, '不是協會會員：只有早鳥');
  await call('t_chair', '/members/t_runner/membership', { method: 'POST', body: { membership: 'active' } });
  const r3 = await call('t_runner', `/events/${ev2.json.id}/signup`, { method: 'POST', body: { option: '全馬' } });
  assert.equal(r3.json.amount, 0, '早鳥 200＋會員 900 超過報名費，折到 0');
});

test('行事曆：定期揪跑一次建立每一場、刪除之後的場次；月曆與賽事提醒；訂閱包含所有活動', async () => {
  const start = plus(1), wd = new Date(`${start}T00:00:00Z`).getUTCDay();
  const r = await call('t_chair', '/events', { method: 'POST', body: { kind: 'long', title: '週末揪跑', date: start, gather_time: '06:00', notify: false,
    repeat: { weekdays: [wd, (wd + 3) % 7], until: plus(22) } } });
  assert.equal(r.status, 200);
  assert.ok(r.json.count >= 6 && r.json.count <= 7, `兩個星期幾、三週：${r.json.count} 場`);
  const ev = (await call('t_runner', `/events/${r.json.id}`)).json;
  assert.equal(ev.series.length, r.json.count);
  assert.equal((await call('t_chair', '/events', { method: 'POST', body: { kind: 'long', title: 'x', date: start, notify: false, repeat: { weekdays: [1], until: plus(-3) } } })).status, 400);
  // 月曆
  const mo = start.slice(0, 7), cal = (await call('t_runner', `/calendar?month=${mo}`)).json;
  assert.ok(cal.events.some((e) => e.series_id === ev.series_id));
  assert.equal((await call('t_runner', '/calendar?month=2026-13')).status, 400);
  // 賽事提醒：跑友不能加，幹部可以
  assert.equal((await call('t_runner', '/calendar/items', { method: 'POST', body: { date: plus(3), title: '臺北馬報名開始' } })).status, 403);
  const it = await call('t_chair', '/calendar/items', { method: 'POST', body: { date: plus(3), title: '臺北馬報名開始', kind: 'signup', url: 'https://www.taipeicitymarathon.com/' } });
  assert.equal(it.status, 200);
  assert.ok((await call('t_runner', `/calendar?month=${plus(3).slice(0, 7)}`)).json.items.some((x) => x.id === it.json.id));
  // 訂閱：預設包含所有看得到的活動與提醒；切成只有自己的就沒有
  const { url } = (await call('t_runner', '/me/calendar', { method: 'POST' })).json;
  const ics = await (await fetch(url.replace(/^https?:\/\/[^/]+/, BASE))).text();
  assert.ok(ics.includes('週末揪跑') && ics.includes('臺北馬報名開始'));
  await call('t_runner', '/me/calendar-scope', { method: 'POST', body: { scope: 'mine' } });
  const ics2 = await (await fetch(url.replace(/^https?:\/\/[^/]+/, BASE))).text();
  assert.ok(!ics2.includes('週末揪跑'));
  // 刪除這場以後的同系列場次
  const third = ev.series[2];
  const del = await call('t_chair', `/events/${third.id}?series=after`, { method: 'DELETE' });
  assert.equal(del.json.count, r.json.count - 2);
  assert.equal((await call('t_runner', `/events/${r.json.id}`)).json.series.length, 2);
  assert.equal((await call('t_chair', `/calendar/items/${it.json.id}`, { method: 'DELETE' })).status, 200);
  // 假日匯入只有理事長與行政人員
  assert.equal((await call('t_runner', '/holidays/import', { method: 'POST', body: { year: 2027 } })).status, 403);
});
