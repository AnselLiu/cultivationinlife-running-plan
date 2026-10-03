// API 權限與核心流程測試：每次改程式都重跑，確認權限沒有被改壞
// 需要：測試用伺服器（npm run test:ci 會自動啟動），帳號見 tests/seed.sql
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8799';
const cookies = {};
async function as(id) {
  if (!cookies[id]) {
    const [uid, flag] = id.split(':');   // 't_chair:mfa'＝用通行金鑰驗證過的工作階段
    const r = await fetch(`${BASE}/api/dev/login?id=${uid}${flag === 'mfa' ? '&mfa=1' : ''}`, { redirect: 'manual' });
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
  // 身分證字號驗檢查碼（A123456788 最後一碼錯）；身分證與護照分開，至少要有一個
  assert.equal((await call('t_runner', '/me/race-profile', { method: 'PUT', body: { ...profile, id_no: 'A123456788' } })).status, 400, '檢查碼錯');
  assert.equal((await call('t_runner', '/me/race-profile', { method: 'PUT', body: { ...profile, id_no: '', passport_no: 'AB-123' } })).status, 400, '護照格式');
  assert.equal((await call('t_runner', '/me/race-profile', { method: 'PUT', body: { ...profile, id_no: '', passport_no: '' } })).json.complete, false, '兩個都沒填就不完整');
  const pp = await call('t_runner', '/me/race-profile', { method: 'PUT', body: { ...profile, id_no: '', passport_no: '312345678' } });
  assert.equal(pp.json.complete, true, '外籍跑友只填護照也可以');
  assert.equal((await call('t_runner', '/me/race-profile')).json.profile.address_zip, '106682', '通訊地址經郵局核對');
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
  const nopk = await call('t_chair', `/events/${id}/registrations.csv`);
  assert.equal(nopk.status, 403, '含身分證字號：沒有通行金鑰驗證不能下載');
  assert.equal(nopk.json.stepup, true);
  const csv = await call('t_chair:mfa', `/events/${id}/registrations.csv`);
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('A123456789') && csv.text.includes('全馬'));
  // 刪除後，已同意的也一起撤回
  await call('t_runner', '/me/race-profile', { method: 'DELETE' });
  assert.ok(!(await call('t_chair:mfa', `/events/${id}/registrations.csv`)).text.includes('A123456789'));
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

test('練跑地圖：幹部新增直接上架、團員提議要審核；現場回報不顯示是誰、一小時一次；路線與開揪跑', async () => {
  const a = await call('t_chair', '/spots', { method: 'POST', body: { name: '測試田徑場', kind: 'track', lat: 25.0487, lng: 121.552, intro: '400 公尺跑道', info: { lap: '400m', light: '有' } } });
  assert.equal(a.json.status, 'approved');
  const p = await call('t_runner', '/spots', { method: 'POST', body: { name: '我家附近河濱', kind: 'river', lat: 25.07, lng: 121.53 } });
  assert.equal(p.json.status, 'pending');
  assert.ok(!(await call('t_super', '/spots')).json.spots.some((x) => x.id === p.json.id), '審核前別人看不到');
  assert.equal((await call('t_runner', `/spots/${p.json.id}/review`, { method: 'POST', body: { approve: true } })).status, 403);
  assert.equal((await call('t_chair', `/spots/${p.json.id}/review`, { method: 'POST', body: { approve: true } })).status, 200);
  assert.ok((await call('t_other', '/spots')).json.spots.some((x) => x.id === p.json.id));
  assert.equal((await call('t_runner', '/spots', { method: 'POST', body: { name: '', lat: 999, lng: 0 } })).status, 400);
  // 現場回報
  assert.equal((await call('t_runner', `/spots/${a.json.id}/reports`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await call('t_runner', `/spots/${a.json.id}/reports`, { method: 'POST', body: { crowd: '多', surface: '濕滑', note: '跑道內圈積水' } })).status, 200);
  assert.equal((await call('t_runner', `/spots/${a.json.id}/reports`, { method: 'POST', body: { crowd: '少' } })).status, 429, '一小時一次');
  const d = (await call('t_super', `/spots/${a.json.id}`)).json;
  assert.equal(d.reports[0].crowd, '多');
  assert.ok(!JSON.stringify(d.reports).includes('t_runner') && d.reports[0].mine === false, '不顯示是誰');
  assert.equal((await call('t_super', `/spots/${a.json.id}/reports/${d.reports[0].id}`, { method: 'DELETE' })).status, 403);
  // 路線
  const rt = await call('t_runner', '/routes', { method: 'POST', body: { name: '河濱 5K', points: [[25.07, 121.53], [25.08, 121.53], [25.08, 121.54]], spot_id: p.json.id } });
  assert.ok(rt.json.distance > 2000 && rt.json.distance < 2300, `距離 ${rt.json.distance}`);
  assert.equal((await call('t_runner', '/routes', { method: 'POST', body: { points: [[25, 121]] } })).status, 400);
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'long', title: '河濱揪跑', date: plus(2), notify: false, spot_id: p.json.id, route_id: rt.json.id } });
  const e = (await call('t_other', `/events/${ev.json.id}`)).json;
  assert.equal(e.spot.name, '我家附近河濱');
  assert.equal(e.route.points.length, 3);
  assert.equal((await call('t_super', `/routes/${rt.json.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('t_runner', '/weather?lat=999&lng=0')).status, 400);
});

test('資安：刪除帳號會清乾淨新功能的資料；跨站請求與偽裝的 JSON 被擋；理事長移交要驗證；分團幹部不能自己加幹部', async () => {
  // 偽裝 content-type、跨站 fetch metadata
  const r1 = await fetch(`${BASE}/api/races`, { method: 'POST', headers: { cookie: await as('t_runner'), 'content-type': 'text/plain; x=application/json' }, body: '{}' });
  assert.equal(r1.status, 415);
  const r2 = await fetch(`${BASE}/api/races`, { method: 'POST', headers: { cookie: await as('t_runner'), 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' });
  assert.equal(r2.status, 403);
  // 分團幹部不能自己指派幹部（要理事長或團長）
  await call('t_chair', '/teams/kids/members', { method: 'POST', body: { member_id: 't_coach', action: 'add', role: 'officer' } });
  assert.equal((await call('t_coach', '/teams/kids/members', { method: 'POST', body: { member_id: 't_super', action: 'add', role: 'officer' } })).status, 403);
  // 建一個新帳號，留下各種資料後刪除
  const j = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'test-join', name: '刪除測試', dist: 'fm', grp: 'D', consent: true }) });
  const ck = j.headers.get('set-cookie').split(';')[0];
  const as2 = (path, body, method = 'POST') => fetch(`${BASE}/api${path}`, { method, headers: { cookie: ck, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json().then((x) => ({ status: r.status, json: x })));
  const spots = (await call('t_runner', '/spots')).json.spots;
  await as2(`/spots/${spots[0].id}/reports`, { crowd: '少' });
  const rt = await as2('/routes', { name: '我的路線', points: [[25, 121], [25.01, 121]] });
  await as2('/races', { name: '測試賽', date: plus(30), dist: '全馬' });
  const del = await fetch(`${BASE}/api/me`, { method: 'DELETE', headers: { cookie: ck, origin: BASE } });
  assert.equal(del.status, 200);
  assert.equal((await call('t_runner', `/routes/${rt.json.id}`)).status, 404, '分享出去的路線也一起刪除');
});

test('活動異動、跑完接續、團購到貨領取 QR、銀行對帳、會籍卡、每月挑戰、備份', async () => {
  // 活動異動：改時間、取消；跑友不能發
  const ev = await call('t_chair', '/events', { method: 'POST', body: { kind: 'long', title: '異動測試', date: '2027-05-01', gather_time: '06:00', notify: false } });
  await call('t_runner', `/events/${ev.json.id}/signup`, { method: 'POST', body: {} });
  assert.equal((await call('t_runner', `/events/${ev.json.id}/notice`, { method: 'POST', body: { type: 'cancel' } })).status, 403);
  assert.equal((await call('t_chair', `/events/${ev.json.id}/notice`, { method: 'POST', body: { type: 'time', gather_time: '07:00', message: '晚一小時' } })).json.count, 1);
  assert.equal((await call('t_runner', `/events/${ev.json.id}`)).json.gather_time, '07:00');
  // 跑完接續：結束 15 分鐘後提醒（台北 2027-05-01 09:30 → UTC 01:30）
  const fu = (await call(null, '/dev/cron?at=2027-05-01T01:30:00Z')).json;
  assert.equal(fu.followups, 1);
  assert.equal((await call(null, '/dev/cron?at=2027-05-01T02:30:00Z')).json.followups, 0, '只提醒一次');
  await call('t_chair', `/events/${ev.json.id}/notice`, { method: 'POST', body: { type: 'cancel', message: '颱風' } });
  assert.equal((await call('t_runner', `/events/${ev.json.id}`)).json.cancelled, true);

  // 慶功宴這類用外部表單登記的餐敘：有地址；改日期與時間時通知所有看得到的人（不只已報名的人）
  const pv = await call('t_chair', '/events', { method: 'POST', body: { kind: 'party', title: '慶功宴', date: '2027-06-01', gather_time: '18:30', place: '榮榮園', address: '臺北市大安區信義路四段25號2樓', link_url: 'https://forms.gle/x', notify: false } });
  assert.equal((await call('t_runner', `/events/${pv.json.id}`)).json.address, '臺北市大安區信義路四段25號2樓');
  assert.equal((await call('t_runner', `/events/${pv.json.id}`)).json.address_zip, '106682', '地址經郵局核對，存 6 碼郵遞區號');
  // 地址一律要經過郵局核對：沒有縣市、查不到門牌都擋下
  assert.equal((await call('t_chair', '/events', { method: 'POST', body: { kind: 'party', title: '地址錯', date: '2027-06-02', address: '信義路四段25號', notify: false } })).status, 400);
  assert.equal((await call('t_chair', '/events', { method: 'POST', body: { kind: 'party', title: '地址錯', date: '2027-06-02', address: '臺北市大安區信義路', notify: false } })).status, 400);
  const ck = await call('t_runner', '/address/check', { method: 'POST', body: { address: '台北市大安區愛國東路２１６號' } });
  assert.deepEqual([ck.status, ck.json.zip, ck.json.address], [200, '106682', '臺北市大安區愛國東路216號'], '全形數字轉半形、台改臺');
  assert.equal((await call(null, '/address/check', { method: 'POST', body: { address: '臺北市大安區愛國東路216號' } })).status, 401);
  // 賽事報名資料的通訊地址也要核對，團體報名 CSV 多一欄郵遞區號
  assert.equal((await call('t_runner', '/me/race-profile', { method: 'PUT', body: { address: '大安區某某路' } })).status, 400);
  assert.equal((await call('t_chair', `/events/${pv.json.id}/notice`, { method: 'POST', body: { type: 'time', date: '2027-06-04', gather_time: '19:00' } })).json.count, 0, '沒人報名、只通知報名的人');
  assert.ok((await call('t_chair', `/events/${pv.json.id}/notice`, { method: 'POST', body: { type: 'other', message: '請大家登記座位', audience: 'all' } })).json.count > 1, '全協會都收到');
  const pv2 = (await call('t_runner', `/events/${pv.json.id}`)).json;
  assert.deepEqual([pv2.date, pv2.gather_time], ['2027-06-04', '19:00']);

  // 團購：到貨前看不到領取碼；到貨後掃碼領取
  const buy = await call('t_chair', '/events', { method: 'POST', body: { kind: 'buy', title: '毛巾團購', date: plus(15), notify: false, items: [{ name: '毛巾', price: 300 }], pay_info: { methods: ['transfer'] } } });
  const towel = (await call('t_runner', `/events/${buy.json.id}`)).json.items[0];
  await call('t_runner', `/events/${buy.json.id}/signup`, { method: 'POST', body: { items: [{ id: towel.id, qty: 2 }] } });
  assert.equal((await call('t_runner', `/events/${buy.json.id}`)).json.myPickCode, null);
  assert.equal((await call('t_runner', `/events/${buy.json.id}/arrived`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await call('t_chair', `/events/${buy.json.id}/arrived`, { method: 'POST', body: { note: '週四團練現場領取' } })).json.count, 1);
  const code = (await call('t_runner', `/events/${buy.json.id}`)).json.myPickCode;
  assert.match(code, /^[A-Z2-9]{6}$/);
  const pk = await call('t_chair', `/events/${buy.json.id}/pickup`, { method: 'POST', body: { code } });
  assert.equal(pk.json.already, false);
  assert.equal((await call('t_chair', `/events/${buy.json.id}/pickup`, { method: 'POST', body: { code } })).json.already, true);
  // 銀行對帳：後五碼＋金額都對上才標已繳
  await call('t_runner', `/events/${buy.json.id}/pay-report`, { method: 'POST', body: { method: 'transfer', ref: '13579' } });
  const rows = [{ amount: 600, refs: ['0081234513579'.slice(-5), '20271001'.slice(-5)], date: '2027-01-02' }, { amount: 999, refs: ['55555'] }];
  const dry = await call('t_chair', `/events/${buy.json.id}/reconcile`, { method: 'POST', body: { rows } });
  assert.equal(dry.json.matched.length, 1);
  assert.equal((await call('t_runner', `/events/${buy.json.id}`)).json.myPaid, 'unpaid', '預覽不會改資料');
  await call('t_chair', `/events/${buy.json.id}/reconcile`, { method: 'POST', body: { rows, apply: true } });
  assert.equal((await call('t_runner', `/events/${buy.json.id}`)).json.myPaid, 'paid');

  // 會籍卡：簽章對才能驗；跑友不能驗別人
  const card = (await call('t_runner', '/me/card')).json;
  assert.match(card.qr, /^CILM:t_runner\.[0-9a-f]{16}$/);
  assert.equal((await call('t_other', `/members/verify?c=${encodeURIComponent(card.qr)}`)).status, 403);
  assert.equal((await call('t_staff', `/members/verify?c=${encodeURIComponent(card.qr)}`)).json.name, '測試跑友');
  assert.equal((await call('t_staff', `/members/verify?c=${encodeURIComponent(card.qr.replace(/.$/, (c) => (c === '0' ? '1' : '0')))}`)).status, 400, '改過的 QR 不能用');

  // 每月挑戰
  await call('t_runner', '/logs', { method: 'POST', body: { date: today, status: 'extra', km: 12.5 } });
  const ch = (await call('t_runner', '/challenge')).json;
  assert.ok(ch.me.km >= 12.5);
  assert.ok(Array.isArray(ch.teams) && ch.badges.length >= 4);

  // 備份：只有理事長、行政人員；寫得進去也列得出來
  assert.equal((await call('t_runner', '/backups', { method: 'POST', body: {} })).status, 403);
  const bk = await call('t_chair', '/backups', { method: 'POST', body: {} });
  assert.equal(bk.status, 200);
  assert.ok(bk.json.tables > 20 && bk.json.rows > 10);
  assert.ok((await call('t_super', '/backups')).json.list.some((x) => x.key.includes('manual')));
});

// ---- 通知中心：分類、游標、已讀模型、隱私 ----
test('通知分類登記表：8 類，chip 只用合法分類；worker 不再用舊的 kind 當分類', async () => {
  const { CATS, CHIPS, isCat, MUTABLE } = await import('../public/notif-cats.js');
  assert.deepEqual(Object.keys(CATS).sort(), ['announce', 'change', 'event', 'membership', 'security', 'signup', 'todo', 'training']);
  for (const c of Object.values(CATS)) assert.ok(c.zh && c.urgency && c.ttl > 0);
  for (const c of CHIPS) if (c.q && c.q !== 'unread') assert.ok(c.q.split(',').every(isCat), c.q);
  assert.ok(!MUTABLE.includes('security') && !MUTABLE.includes('change'));
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const bad = src.split('\n').filter((l) => /notify\(env/.test(l) && /'(system|log|plan|lottery)'/.test(l.replace(/kind: '\w+'/g, '')));
  assert.deepEqual(bad, [], '分類參數不能是舊的 kind');
});

test('通知列表：複合游標不漏列、篩選白名單、舊格式游標相容', async () => {
  const seen = new Set();
  let next = null, pages = 0;
  do {
    const r = await call('t_other', `/notifications${next ? `?before=${encodeURIComponent(next)}` : ''}`);
    assert.equal(r.status, 200, r.text);
    for (const n of [...r.json.items, ...(next ? [] : r.json.pinned)]) { assert.ok(!seen.has(n.id), `重複 ${n.id}`); seen.add(n.id); }
    if (!next) assert.ok(r.json.cats && 'badge' in r.json && 'unread' in r.json && 'todo' in r.json, '第一頁帶計數');
    next = r.json.next; pages++;
  } while (next && pages < 20);
  for (let i = 1; i <= 35; i++) assert.ok(seen.has(`nseed${String(i).padStart(11, '0')}`), `漏了第 ${i} 則`);
  assert.ok(seen.has('nseedsec00000001') && seen.has('nseedtodo0000001'));
  const first = await call('t_other', '/notifications');
  assert.ok(first.json.pinned.some((n) => n.id === 'nseedsec00000001'), '未讀的安全通知在「需要留意」');
  assert.ok(!first.json.items.some((n) => n.id === 'nseedsec00000001'), '需要留意的不會在清單重複出現');
  assert.equal((await call('t_other', `/notifications?before=${encodeURIComponent(first.json.items[0].created_at)}`)).status, 200, '舊版只送時間戳');
  assert.equal((await call('t_other', '/notifications?cat=foo')).status, 400);
  assert.equal((await call('t_other', '/notifications?cat=event,signup,change,todo')).status, 400);
  assert.equal((await call('t_other', '/notifications?before=x')).status, 400);
  const mine = await call('t_other', '/notifications?cat=signup,change');
  assert.equal(mine.status, 200);
  assert.ok(mine.json.items.every((n) => ['signup', 'change'].includes(n.category)));
  const un = await call('t_other', '/notifications?cat=unread');
  assert.ok(un.json.items.length > 0 && un.json.items.every((n) => n.read_at === null));
});

test('通知：跨會員一律 404；計數與看過；全部已讀有上界；依活動已讀不動待辦；安全通知受保護', async () => {
  // 翻完所有頁找某一則（含「需要留意」）
  const row = async (id) => {
    let next = null;
    do {
      const r = (await call('t_other', `/notifications${next ? `?before=${encodeURIComponent(next)}` : ''}`)).json;
      const hit = [...r.items, ...(r.pinned || [])].find((n) => n.id === id);
      if (hit) return hit;
      next = r.next;
    } while (next);
    return null;
  };
  // 跨會員
  assert.equal((await call('t_runner', '/notifications/read', { method: 'POST', body: { id: 'nseed00000000001' } })).status, 200);
  assert.equal((await call('t_runner', '/notifications/unread', { method: 'POST', body: { id: 'nseed00000000001' } })).status, 404);
  assert.equal((await call('t_runner', '/notifications/nseed00000000001', { method: 'DELETE' })).status, 404);
  assert.equal((await row('nseed00000000001')).read_at, null, '別人的列沒有變');
  // 計數
  const c = await call('t_other', '/notifications/count');
  assert.ok(['badge', 'unseen', 'unread'].every((k) => typeof c.json[k] === 'number'));
  assert.equal(c.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual((await call(null, '/notifications/count')).json, { badge: 0, unseen: 0, unread: 0 });
  const s = await call('t_other', '/notifications/seen', { method: 'POST' });
  const secUnread = (await call('t_other', '/notifications?cat=security')).json.items.filter((n) => !n.read_at).length;
  assert.ok(secUnread >= 1);
  assert.equal(s.json.badge, secUnread, '看過之後鈴鐺只剩未讀的安全通知');
  // 全部已讀的上界：同一秒的列，id 比上界大的維持未讀
  const ts = (await row('nseed00000000010')).created_at;
  await call('t_other', '/notifications/read', { method: 'POST', body: { all: true, cat: 'event', upto: `${ts}|nseed00000000010` } });
  assert.ok((await row('nseed00000000010')).read_at);
  assert.equal((await row('nseed00000000011')).read_at, null);
  assert.equal((await call('t_other', '/notifications/read', { method: 'POST', body: { all: true } })).status, 400, 'upto 必填');
  // 依活動已讀：同一個 ref 的待辦不動
  await call('t_other', '/notifications/read', { method: 'POST', body: { ref: 'e:seed' } });
  assert.ok((await row('nseed00000000035')).read_at);
  assert.equal((await call('t_other', '/notifications?cat=todo')).json.items.find((n) => n.id === 'nseedtodo0000001').read_at, null);
  assert.equal((await call('t_other', '/notifications/read', { method: 'POST', body: { ref: 'pay:x:y' } })).status, 400);
  // 標為未讀
  assert.equal((await call('t_other', '/notifications/unread', { method: 'POST', body: { id: 'nseed00000000001' } })).status, 200);
  assert.equal((await row('nseed00000000001')).read_at, null);
  assert.equal((await call('t_other', '/notifications/nseed00000000001', { method: 'DELETE' })).status, 200, '一般通知可以刪');
  assert.equal((await call('t_other', '/notifications/nseed00000000001', { method: 'DELETE' })).status, 404);
  // 安全通知：不能刪、清除已讀與全部已讀都不動，只有單則已讀可以
  assert.equal((await call('t_other', '/notifications/nseedsec00000001', { method: 'DELETE' })).status, 404);
  const newest = (await call('t_other', '/notifications')).json.items[0];
  await call('t_other', '/notifications/read', { method: 'POST', body: { all: true, upto: `${newest.created_at}|${newest.id}` } });
  await call('t_other', '/notifications/read', { method: 'POST', body: {} });
  const cr = await call('t_other', '/notifications/clear-read', { method: 'POST' });
  assert.ok(cr.json.removed > 0);
  assert.equal((await call('t_other', '/notifications?cat=event')).json.items.length, 0, '已讀的都清掉了');
  const sec = (await call('t_other', '/notifications')).json.pinned.find((n) => n.id === 'nseedsec00000001');
  assert.ok(sec && sec.read_at === null, '安全通知還在而且未讀');
  await call('t_other', '/notifications/read', { method: 'POST', body: { id: 'nseedsec00000001' } });
  assert.ok((await call('t_other', '/notifications?cat=security')).json.items.find((n) => n.id === 'nseedsec00000001').read_at);
});

test('群發一律是公告、不能偽裝成安全通知；推播偏好只收可以關的類別', async () => {
  const r = await call('t_chair', '/admin/broadcast', { method: 'POST', body: { title: '週末颱風停課', body: '本週六團練取消', teams: ['youth'] } });
  assert.equal(r.status, 200, r.text);
  // 用標題找：前一個測試可能在同一秒寫了別的通知，同一秒內的順序看隨機代碼，不能假設是第一則
  const n = (await call('t_runner', '/notifications')).json.items.find((x) => x.title === '週末颱風停課');
  assert.deepEqual([n?.title, n?.category, n?.kind, n?.url], ['週末颱風停課', 'announce', 'broadcast', null]);
  assert.equal((await call('t_chair', '/admin/broadcast', { method: 'POST', body: { title: '新裝置登入通知', teams: ['youth'], dryRun: true } })).status, 400);
  assert.equal((await call('t_chair', '/admin/broadcast', { method: 'POST', body: { title: '請登入 App 更新資料', teams: ['youth'], dryRun: true } })).status, 200);
  // 零寬字元、空白、異體字繞不過；內文也不能冒充安全通知
  for (const body of [{ title: '新\u200b裝置登入' }, { title: '身份 更新' }, { title: '活動提醒', body: '請點開確認是不是你本人' }])
    assert.equal((await call('t_chair', '/admin/broadcast', { method: 'POST', body: { ...body, teams: ['youth'], dryRun: true } })).status, 400, JSON.stringify(body));
  const p = await call('t_runner', '/me/notify-prefs', { method: 'PUT', body: { mute: ['security', 'change', 'training', 'bogus'] } });
  assert.deepEqual(p.json.mute, ['training']);
  assert.deepEqual((await call('t_runner', '/me/notify-prefs')).json.mute, ['training']);
  assert.equal((await call(null, '/me/notify-prefs', { method: 'PUT', body: { mute: [] } })).status, 401);
  const x = await fetch(`${BASE}/api/me/notify-prefs`, { method: 'PUT', headers: { cookie: await as('t_runner'), origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"mute":[]}' });
  assert.equal(x.status, 403);
  await call('t_runner', '/me/notify-prefs', { method: 'PUT', body: { mute: [] } });
});

test('身分變更寫安全通知；入會申請不能重複；待處理摘要只含自己分團', async () => {
  delete cookies['t_chair:mfa'];
  assert.equal((await call('t_chair:mfa', '/members/t_other/role', { method: 'POST', body: { role: 'member' } })).status, 200);
  delete cookies.t_other;
  const sec = (await call('t_other', '/notifications?cat=security')).json.items;
  assert.ok(sec.some((n) => n.title === '身分更新'));
  assert.equal((await call('t_other', '/me/apply', { method: 'POST' })).status, 200);
  assert.equal((await call('t_other', '/me/apply', { method: 'POST' })).status, 409);
  const todo = (await call('t_staff', '/notifications?cat=todo')).json.items.find((n) => n.title === '有人申請入會');
  assert.ok(todo && !todo.body.includes('路人跑友'), '待辦不放本名');
  assert.equal(todo.url, '/#/admin?tab=members');
  // 入團申請：通知該團團長，連到分團頁
  assert.equal((await call('t_other', '/teams/youth/join', { method: 'POST' })).json.status, 'pending');
  const lead = await call('t_lead', '/notifications');
  assert.ok(lead.json.todo && lead.json.todo.joins.length >= 1);
  assert.ok(lead.json.todo.joins.every((j) => j.tid === 'youth'), '只含自己分團');
  const jn = (await call('t_lead', '/notifications?cat=todo')).json.items.find((n) => n.title.endsWith('有人申請加入'));
  assert.equal(jn.url, '/#/t/youth');
  assert.equal((await call('t_runner', '/notifications')).json.todo, null);
  // 核准後，同一則待辦一起結束
  await call('t_lead', '/teams/youth/members', { method: 'POST', body: { member_id: 't_other', action: 'approve' } });
  assert.ok((await call('t_lead', '/notifications?cat=todo')).json.items.find((n) => n.id === jn.id).read_at);
});

// ---- 活動報名：報名期間、審核、通知、候補遞補、系統預設、排程 ----
const tp = (min = 0) => new Date(Date.now() + 8 * 3600e3 + min * 60e3).toISOString().slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));   // created_at 只到秒：順序有差的報名之間 sleep(1100)
const notes = async (who) => { const r = (await call(who, '/notifications')).json; return [...(r.pinned || []), ...r.items]; };
const notesFor = async (who, id) => (await notes(who)).filter((n) => (n.url || '').includes(`/e/${id}`));
const signup = (who, id, body = {}) => call(who, `/events/${id}/signup`, { method: 'POST', body });
const unsign = (who, id) => call(who, `/events/${id}/signup`, { method: 'DELETE' });
const review = (who, id, body) => call(who, `/events/${id}/review`, { method: 'POST', body });
const evBase = { kind: 'track', title: '報名測試', gather_time: '07:00', notify: false };
async function mkEvent(body, who = 't_chair') {
  const r = await call(who, '/events', { method: 'POST', body: { ...evBase, date: plus(7), ...body } });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}
const stOf = async (who, id) => (await call(who, `/events/${id}`)).json.myStatus;

test('報名期間：台北時間截止、尚未開始、格式錯誤、定期揪跑一起平移', async () => {
  const base = { ...evBase, title: '期間測試', date: plus(3) };
  const past = await call('t_chair', '/events', { method: 'POST', body: { ...base, deadline: tp(-60) } });
  assert.equal(past.status, 400);
  assert.match(past.json.error, /報名截止時間已經過了/);
  const id = await mkEvent({ ...base, deadline: tp(60) });
  assert.equal((await call('t_chair', `/events/${id}`, { method: 'PUT', body: { ...base, deadline: tp(-60) } })).status, 200, '編輯可以把截止改到過去');
  const late = await signup('t_other', id);
  assert.equal(late.status, 400, '台北時間已截止（舊版晚 8 小時才擋）');
  assert.match(late.json.error, /截止/);
  const soonId = await mkEvent({ ...base, date: plus(5), signup_start: tp(1440) });
  const soon = await signup('t_other', soonId);
  assert.equal(soon.status, 400);
  assert.match(soon.json.error, /報名將於/);
  const g = (await call('t_other', `/events/${soonId}`)).json;
  assert.equal(g.myStatus, null);
  assert.equal(typeof g.serverNow, 'number');
  assert.equal(g.signup_start, tp(1440));
  const bad = await call('t_chair', '/events', { method: 'POST', body: { ...base, deadline: 'tomorrow' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /格式不正確/);
  // 定期揪跑：兩個時間一起依日期差平移；格式錯誤是 400 不是 500
  const start = plus(10), wd = new Date(`${start}T00:00:00Z`).getUTCDay();
  const sr = await call('t_chair', '/events', { method: 'POST', body: { ...base, date: start, deadline: `${plus(9)}T22:00`, signup_start: `${plus(8)}T20:00`, repeat: { weekdays: [wd], until: plus(17) } } });
  assert.equal(sr.status, 200, sr.text);
  assert.equal(sr.json.count, 2);
  const second = (await call('t_chair', `/events/${sr.json.id}`)).json.series.find((x) => x.date === plus(17));
  const s2 = (await call('t_chair', `/events/${second.id}`)).json;
  assert.equal(s2.deadline, `${plus(16)}T22:00`);
  assert.equal(s2.signup_start, `${plus(15)}T20:00`);
  assert.equal((await call('t_chair', '/events', { method: 'POST', body: { ...base, date: start, deadline: '2026-99-99T25:00', repeat: { weekdays: [wd], until: plus(17) } } })).status, 400);
  assert.equal((await call('t_chair', '/events', { method: 'POST', body: { ...base, signup_start: `${plus(2)}T20:00`, deadline: `${plus(2)}T20:00` } })).status, 400, '開始要早於截止');
  assert.equal((await call('t_chair', '/events', { method: 'POST', body: { ...base, deadline: `${plus(3)}T08:00` } })).status, 400, '截止不能晚於集合時間');
  // 沒填截止＝活動開始時截止；幹部代為報名不受期間限制
  const yid = await mkEvent({ ...base, date: plus(-1) });
  assert.equal((await signup('t_other', yid)).status, 400);
  const bulk = await call('t_chair', `/events/${yid}/bulk`, { method: 'POST', body: { names: ['路人跑友'], action: 'signup' } });
  assert.equal(bulk.json.added, 1, bulk.text);
});

test('審核：待審核不佔名額也不公開；核准照報名順序；婉拒擋重報；同時核准只成功一次', async () => {
  const id = await mkEvent({ title: '審核測試', capacity: 1, require_approval: true, notify_signup: true });
  const a = await signup('t_runner', id);
  assert.equal(a.json.status, 'pending', a.text);
  await sleep(1100);
  const b = await signup('t_other', id);
  assert.equal(b.json.status, 'pending');
  assert.equal(b.json.full, false, '待審核不佔名額');
  assert.ok(!(await call('t_other', `/events/${id}`)).json.signups.some((s) => s.member_id === 't_runner'), '待審核不出現在公開名單');
  assert.equal(await stOf('t_runner', id), 'pending');
  const row = (await call('t_runner', '/events')).json.events.find((e) => e.id === id);
  assert.equal(row.mine, 'pending');
  assert.ok(!('pending' in row), '一般團員拿不到待審核數');
  assert.equal((await call('t_chair', '/events')).json.events.find((e) => e.id === id).pending, 2);
  const pr = await call('t_runner', `/events/${id}/pay-report`, { method: 'POST', body: { method: 'cash' } });
  assert.equal(pr.status, 400);
  assert.match(pr.json.error, /審核/);
  // 故意反過來送：依報名先後排正取
  const ap = await review('t_chair', id, { action: 'approve', member_ids: ['t_other', 't_runner'] });
  assert.equal(ap.status, 200, ap.text);
  assert.deepEqual(ap.json.in.map((x) => x.member_id), ['t_runner']);
  assert.deepEqual(ap.json.wait.map((x) => [x.member_id, x.position]), [['t_other', 1]]);
  assert.ok((await notesFor('t_runner', id)).some((n) => /審核通過/.test(n.title)));
  assert.ok((await notesFor('t_other', id)).some((n) => /審核通過，候補第 1 位/.test(n.title)));
  // 移出候補要確認；婉拒原因只給本人
  const nr = await review('t_chair', id, { action: 'reject', member_ids: ['t_other'], note: 'x原因' });
  assert.equal(nr.status, 409);
  assert.equal(nr.json.needRevoke, true);
  assert.equal((await review('t_chair', id, { action: 'reject', member_ids: ['t_other'], note: 'x原因', revoke: true })).status, 200);
  let g = (await call('t_other', `/events/${id}`)).json;
  assert.equal(g.myStatus, 'rejected');
  assert.equal(g.myReviewNote, 'x原因');
  const re = await signup('t_other', id);
  assert.equal(re.status, 400);
  assert.match(re.json.error, /婉拒/);
  assert.equal((await unsign('t_other', id)).status, 200);
  assert.equal(await stOf('t_other', id), 'rejected', '取消不能繞過婉拒');
  assert.equal((await signup('t_other', id)).status, 400);
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=event.signup`)).json.items;
  assert.ok(au.some((x) => x.action === 'event.signup_review' && x.target_id === id));
  assert.ok(au.some((x) => x.action === 'event.signup_reject' && x.target_id === 't_other'));
  assert.ok(au.every((x) => !(x.detail || '').includes('x原因')), '稽核不記原因');
  assert.ok((await notesFor('t_other', id)).some((n) => n.title.startsWith('已被移出名單') && n.body.includes('x原因')), '原因只在通知中心內文');
  // 重新審核 → 待審核；正取取消時不會自動錄取待審核
  assert.deepEqual((await review('t_chair', id, { action: 'reopen', member_ids: ['t_other'] })).json.reopened.map((x) => x.member_id), ['t_other']);
  assert.equal(await stOf('t_other', id), 'pending');
  assert.equal((await unsign('t_runner', id)).json.was, 'in');
  const st = (await call('t_chair', `/events/${id}/stats`)).json;
  assert.equal(st.total.in, 0);
  assert.equal(st.total.pending, 1);
  assert.equal(st.seatsLeft, 1);
  // 兩個核准同時送出：只有一個處理成功、只通知一次
  const before = (await notesFor('t_other', id)).filter((n) => /審核通過/.test(n.title)).length;
  const [x1, x2] = await Promise.all([1, 2].map(() => review('t_chair', id, { action: 'approve', member_ids: ['t_other'] })));
  const listed = [x1, x2].filter((x) => [...x.json.in, ...x.json.wait].some((y) => y.member_id === 't_other'));
  assert.equal(listed.length, 1);
  assert.ok([x1, x2].some((x) => x.json.skipped.some((y) => y.reason === '這筆已被處理')));
  assert.equal((await notesFor('t_other', id)).filter((n) => /審核通過/.test(n.title)).length, before + 1);
  assert.equal(await stOf('t_other', id), 'in');
  // 權限：監事、一般團員、別的分團團長不能審核；分團團長可以審自己分團的活動；別的活動的報名改不到
  assert.equal((await review('t_super', id, { action: 'approve', member_ids: ['t_other'] })).status, 403);
  assert.equal((await review('t_runner', id, { action: 'approve', member_ids: ['t_other'] })).status, 403);
  assert.equal((await review('t_lead', id, { action: 'reject', member_ids: ['t_other'], revoke: true })).status, 403, '團長不能審全協會活動');
  const yid = await mkEvent({ title: '青年審核', team_id: 'youth', require_approval: true }, 't_lead');
  assert.equal((await signup('t_runner', yid)).json.status, 'pending');
  const cross = await review('t_lead', yid, { action: 'reject', member_ids: ['t_other'], revoke: true });
  assert.equal(cross.status, 200);
  assert.equal(cross.json.skipped[0].reason, '找不到這筆報名');
  assert.equal(await stOf('t_other', id), 'in', '別的活動的報名沒有被改');
  assert.equal((await review('t_lead', yid, { action: 'approve', member_ids: ['t_runner'] })).json.in.length, 1);
  // 問卷一律不審核
  const sid = await mkEvent({ kind: 'survey', title: '問卷不審核', require_approval: true, questions: [{ type: 'text', label: '想法' }] });
  assert.equal((await call('t_chair', `/events/${sid}`)).json.require_approval, 0);
  assert.equal((await signup('t_staff', sid, { answers: { q1: 'ok' } })).json.status, 'in');
});

test('名單不洩漏：非管理者的 GET、列表、統計、CSV 都看不到待審核或婉拒的姓名；統計與 CSV 分開計算', async () => {
  const id = await mkEvent({ title: '名單測試', capacity: 1, require_approval: true });
  await review('t_chair', id, { action: 'approve', member_ids: [] });   // 空清單：400，不影響
  assert.equal((await signup('t_staff', id)).json.status, 'in', '主辦幹部本人報名＝核准');
  assert.equal((await signup('t_lead', id)).json.status, 'pending');
  await sleep(1100);
  assert.equal((await signup('t_super', id)).json.status, 'pending');
  await review('t_chair', id, { action: 'reject', member_ids: ['t_super'] });
  const bulk = await call('t_chair', `/events/${id}/bulk`, { method: 'POST', body: { names: ['測試教練'], action: 'signup' } });
  assert.equal(bulk.json.added, 1);
  const g = (await call('t_runner', `/events/${id}`)).json;
  assert.deepEqual(g.signups.map((s) => s.member_id).sort(), ['t_coach', 't_staff']);
  assert.equal(g.pendingCount, undefined);
  const list = (await call('t_runner', '/events')).json.events.find((e) => e.id === id);
  assert.ok(!JSON.stringify(list).includes('測試團長') && !JSON.stringify(list).includes('測試監事'));
  assert.equal((await call('t_runner', `/events/${id}/stats`)).status, 403);
  const roster = await call('t_chair', `/events/${id}/roster`);
  assert.ok(!roster.json.text.includes('測試團長') && !roster.json.text.includes('測試監事'), '名單文字只有正取與候補');
  const st = (await call('t_chair', `/events/${id}/stats`)).json;
  assert.equal(st.canReview, true);
  assert.deepEqual([st.total.in, st.total.wait, st.total.pending, st.total.rejected], [1, 1, 1, 1]);
  assert.equal(st.people.find((p) => p.member_id === 't_super').status, 'rejected');
  const csv = (await call('t_chair', `/events/${id}/export.csv`)).text;
  assert.ok(csv.includes('待審核') && csv.includes('未通過') && csv.includes('"審核"'));
  assert.equal((await call('t_coach', `/events/${id}/stats`)).status, 200);
});

test('報名通知：開關控制、狀態沒變不重複、代為報名只通知真的報上的人', async () => {
  const id = await mkEvent({ title: '通知測試', capacity: 1, notify_signup: true, fee: 300 });
  assert.equal((await signup('t_lead', id)).json.status, 'in');
  const ok = (await notesFor('t_lead', id)).filter((n) => n.title.startsWith('報名成功'));
  assert.equal(ok.length, 1);
  assert.match(ok[0].body, /應繳 NT\$300/);
  await signup('t_lead', id, { note: '改備註' });
  assert.equal((await notesFor('t_lead', id)).filter((n) => n.title.startsWith('報名成功')).length, 1, '修改內容不通知');
  const w = await signup('t_super', id);
  assert.equal(w.json.status, 'wait');
  assert.equal(w.json.position, 1);
  assert.ok((await notesFor('t_super', id)).some((n) => n.title.startsWith('已排入候補') && n.body.includes('候補第 1 位')));
  await call('t_chair', `/events/${id}/payments`, { method: 'POST', body: { member_ids: ['t_lead'], paid: 'paid' } });
  assert.ok((await notesFor('t_lead', id)).some((n) => n.title.startsWith('已確認收款') && n.body === 'NT$300'));
  const quiet = await mkEvent({ title: '不通知', notify_signup: false });
  assert.equal((await signup('t_lead', quiet)).json.status, 'in');
  assert.equal((await notesFor('t_lead', quiet)).length, 0);
});

test('候補與遞補：重報排到最後、調高名額遞補、移出受邀名單遞補、入場券只給正取', async () => {
  const body = { title: '遞補測試', capacity: 1 };
  const id = await mkEvent(body);
  assert.equal((await signup('t_staff', id)).json.status, 'in');
  await sleep(1100);
  assert.equal((await signup('t_super', id)).json.status, 'wait');
  await sleep(1100);
  assert.equal((await signup('t_coach', id)).json.status, 'wait');
  await sleep(1100);
  await unsign('t_super', id);
  const back = await signup('t_super', id);
  assert.equal(back.json.position, 2, '取消後重報排到最後');
  await unsign('t_staff', id);
  assert.equal(await stOf('t_coach', id), 'in', '遞補的是排在前面的人');
  assert.equal(await stOf('t_super', id), 'wait');
  assert.ok((await notesFor('t_coach', id)).some((n) => n.title.startsWith('候補遞補成功')));
  assert.equal((await call('t_chair', `/events/${id}`, { method: 'PUT', body: { ...evBase, date: plus(7), ...body, capacity: 2 } })).status, 200);
  assert.equal(await stOf('t_super', id), 'in', '調高名額遞補');
  // 邀請制：把正取移出受邀名單，候補遞補
  const iid = await mkEvent({ title: '邀請遞補', capacity: 1, visibility: 'invite' });
  await call('t_chair', `/events/${iid}/invites`, { method: 'POST', body: { member_ids: ['t_staff', 't_super'], notify: false } });
  await signup('t_staff', iid);
  await sleep(1100);
  assert.equal((await signup('t_super', iid)).json.status, 'wait');
  await call('t_chair', `/events/${iid}/invites/t_staff`, { method: 'DELETE' });
  assert.equal(await stOf('t_super', iid), 'in');
  // 餐敘：入場券只給正取；遞補的人拿到入場券（含攜伴），取消的人入場券失效
  const pid = await mkEvent({ kind: 'party', title: '餐敘遞補', capacity: 1, guest_max: 3 });
  await signup('t_staff', pid, { guests: 1 });
  await sleep(1100);
  assert.equal((await signup('t_coach', pid, { guests: 2 })).json.status, 'wait');
  assert.ok(!(await call('t_coach', '/my/tickets')).json.tickets.some((t) => t.event_id === pid), '候補沒有入場券');
  const old = (await call('t_staff', '/my/tickets')).json.tickets.find((t) => t.event_id === pid);
  assert.ok(old);
  await unsign('t_staff', pid);
  const mine = (await call('t_coach', '/my/tickets')).json.tickets.find((t) => t.event_id === pid);
  assert.equal(mine?.guests, 2, '遞補的人有入場券，攜伴照報名時填的');
  assert.ok(!(await call('t_staff', '/my/tickets')).json.tickets.some((t) => t.event_id === pid));
  assert.equal((await call('t_chair', `/events/${pid}/checkin`, { method: 'POST', body: { code: old.code } })).status, 404);
  // 現場報到 QR：需要審核的活動只有正取與候補可以；被婉拒的人任何活動都不行
  const qid = await mkEvent({ title: '報到審核', date: today, gather_time: '23:58', require_approval: true });
  const tok = (await call('t_chair', `/events/${qid}/attend-token`, { method: 'POST', body: { on: true } })).json.token;
  assert.equal((await signup('t_super', qid)).json.status, 'pending');
  assert.equal((await signup('t_lead', qid)).json.status, 'pending');
  await review('t_chair', qid, { action: 'reject', member_ids: ['t_lead'] });
  const at = (who, eid, t) => call(who, `/events/${eid}/attend`, { method: 'POST', body: { t } });
  assert.match((await at('t_super', qid, tok)).json.error, /等主辦核准/);
  assert.match((await at('t_lead', qid, tok)).json.error, /未核准/);
  assert.match((await at('t_other', qid, tok)).json.error, /主辦核准才能參加/);
  const oid = await mkEvent({ title: '報到一般', date: today, gather_time: '23:58' });
  const tok2 = (await call('t_chair', `/events/${oid}/attend-token`, { method: 'POST', body: { on: true } })).json.token;
  const walk = await at('t_other', oid, tok2);
  assert.equal(walk.status, 200);
  assert.equal(walk.json.walkIn, true);
  // 活動開始後，正取不能自己取消
  const sid = await mkEvent({ title: '已開始', date: today, gather_time: '00:00' });
  await call('t_chair', `/events/${sid}/bulk`, { method: 'POST', body: { names: ['測試行政'], action: 'signup' } });
  assert.equal((await unsign('t_staff', sid)).status, 400);
  // 第一次報名同時送兩次：都成功、只有一列、最多一則通知
  const did = await mkEvent({ title: '重複送出', notify_signup: true });
  const [d1, d2] = await Promise.all([signup('t_lead', did), signup('t_lead', did)]);
  assert.equal(d1.status, 200, d1.text);
  assert.equal(d2.status, 200, d2.text);
  assert.equal((await call('t_chair', `/events/${did}/stats`)).json.people.length, 1);
  assert.ok((await notesFor('t_lead', did)).filter((n) => n.title.startsWith('報名成功')).length <= 1);
});

test('系統預設：只有理事長與行政能改；建立時沒帶欄位用預設；舊版畫面編輯不會清掉設定', async () => {
  const set = (who, body) => call(who, '/settings/signup', { method: 'POST', body });
  try {
    assert.equal((await set('t_coach', { approval: true })).status, 403);
    const r = await set('t_chair', { approval: true, notify: false, open_days: 999, open_time: 'xx', close_days: 1, close_time: '22:00' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.value.open_days, 60);
    assert.equal(r.json.value.open_time, '20:00');
    assert.equal((await set('t_chair', { open_days: 1, close_days: 3 })).status, 400);
    assert.deepEqual((await call('t_chair', '/me')).json.settings.signup, r.json.value);
    const plain = { kind: 'track', title: '預設測試', date: plus(9), gather_time: '07:00', notify: false };
    const id = (await call('t_chair', '/events', { method: 'POST', body: plain })).json.id;
    let e = (await call('t_chair', `/events/${id}`)).json;
    assert.deepEqual([e.require_approval, e.notify_signup, e.signup_start], [1, 0, null]);
    // 舊版畫面：PUT 沒帶新欄位 → 不變
    assert.equal((await call('t_chair', `/events/${id}`, { method: 'PUT', body: { ...plain, place: '河濱' } })).status, 200);
    e = (await call('t_chair', `/events/${id}`)).json;
    assert.equal(e.require_approval, 1);
    assert.equal(e.place, '河濱');
    await signup('t_lead', id);
    await sleep(1100);
    await signup('t_super', id);
    const off = await call('t_chair', `/events/${id}`, { method: 'PUT', body: { ...plain, require_approval: false } });
    assert.equal(off.status, 409);
    assert.equal(off.json.needPendingAction, true);
    assert.equal(off.json.pending, 2);
    const admit = await call('t_chair', `/events/${id}`, { method: 'PUT', body: { ...plain, require_approval: false, pending_action: 'admit' } });
    assert.equal(admit.status, 200, admit.text);
    assert.equal(await stOf('t_lead', id), 'in');
    assert.equal(await stOf('t_super', id), 'in');
    assert.ok((await notesFor('t_super', id)).some((n) => n.title.startsWith('審核通過')));
  } finally {
    await set('t_chair', { approval: false, notify: true, open_days: null, close_days: null });
  }
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=settings.signup`)).json.items;
  assert.ok(au.length >= 1);
});

test('排程：開放報名推播一次、20:00 待審核整理、活動結束後待審核失效、改時間重設提醒', async () => {
  const oid = await mkEvent({ title: '開放推播', team_id: 'youth', date: '2027-07-01', signup_start: '2027-06-20T20:00', notify: true }, 't_lead');
  assert.ok((await call(null, '/dev/cron?at=2027-06-20T11:30:00Z')).json.signupOpen === 0, '還沒到開放時間');
  assert.ok((await call(null, '/dev/cron?at=2027-06-20T12:30:00Z')).json.signupOpen >= 1);
  assert.ok((await notesFor('t_runner', oid)).some((n) => n.title.startsWith('開放報名')));
  assert.equal((await call(null, '/dev/cron?at=2027-06-20T13:30:00Z')).json.signupOpen, 0, '只推一次');
  // 待審核：20:00 整理一次；活動結束後失效
  const rid = await mkEvent({ title: '逾期審核', date: '2027-06-10', gather_time: '07:00', require_approval: true });
  assert.equal((await signup('t_other', rid)).json.status, 'pending');
  assert.ok((await call(null, '/dev/cron?at=2027-06-09T12:00:00Z')).json.signupReviews >= 1);
  assert.ok((await notesFor('t_chair', rid)).some((n) => n.title.startsWith('還有 1 筆待審核')));
  assert.equal((await call(null, '/dev/cron?at=2027-06-09T12:30:00Z')).json.signupReviews, 0);
  await call(null, '/dev/cron?at=2027-06-10T01:30:00Z');
  assert.equal(await stOf('t_other', rid), null);
  assert.ok((await notesFor('t_other', rid)).some((n) => n.title.startsWith('申請已失效')));
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=signup.expire`)).json.items;
  assert.ok(au.some((x) => x.target_id === rid));
  // 改期：重設活動提醒
  const body = { title: '改期提醒', date: '2027-08-10', gather_time: '19:00' };
  const mid = await mkEvent(body);
  await signup('t_lead', mid);
  assert.ok((await call(null, '/dev/cron?at=2027-08-09T12:00:00Z')).json.events >= 1);
  await call('t_chair', `/events/${mid}`, { method: 'PUT', body: { ...evBase, ...body, date: '2027-08-12' } });
  assert.ok((await call(null, '/dev/cron?at=2027-08-11T12:00:00Z')).json.events >= 1, '改期後會再提醒');
});

test('審核補強：全會與邀請制的開放推播、移出後領取碼失效、改時間平移報名期間、監事不能審核、取消待辦不放金額', async () => {
  // 開放推播：全會活動（沒有分團）與邀請制，參數綁定要對（D1 參數數量不符會丟錯，這場的推播就永遠不會送）
  const aid = await mkEvent({ title: '全會開放', date: '2027-07-02', signup_start: '2027-06-21T20:00', notify: true });
  const iid = await mkEvent({ title: '邀請開放', date: '2027-07-03', signup_start: '2027-06-22T20:00', notify: true, visibility: 'invite' });
  await call('t_chair', `/events/${iid}/invites`, { method: 'POST', body: { member_ids: ['t_runner'], notify: false } });
  const c1 = (await call(null, '/dev/cron?at=2027-06-21T12:30:00Z')).json;
  assert.ok(c1.signupOpen >= 1, JSON.stringify(c1));
  assert.ok((await notesFor('t_other', aid)).some((n) => n.title.startsWith('開放報名')));
  const c2 = (await call(null, '/dev/cron?at=2027-06-22T12:30:00Z')).json;
  assert.ok(c2.signupOpen >= 1, JSON.stringify(c2));
  assert.ok((await notesFor('t_runner', iid)).some((n) => n.title.startsWith('開放報名')));
  assert.ok(!(await notesFor('t_other', iid)).some((n) => n.title.startsWith('開放報名')), '不在受邀名單的人不推');
  // 監事不能審核
  assert.equal((await review('t_super', aid, { action: 'approve', member_ids: ['t_other'] })).status, 403);
  // 團購到貨後被移出：領取碼失效，也不再回傳
  const buy = await mkEvent({ kind: 'buy', title: '移出團購', date: plus(16), items: [{ name: '帽子', price: 200 }], pay_info: { methods: ['transfer'] } });
  const hat = (await call('t_other', `/events/${buy}`)).json.items[0];
  await signup('t_other', buy, { items: [{ id: hat.id, qty: 1 }] });
  await call('t_chair', `/events/${buy}/arrived`, { method: 'POST', body: {} });
  const code = (await call('t_other', `/events/${buy}`)).json.myPickCode;
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal((await review('t_chair', buy, { action: 'reject', member_ids: ['t_other'], revoke: true })).status, 200);
  assert.equal((await call('t_other', `/events/${buy}`)).json.myPickCode, null);
  const pk = await call('t_chair', `/events/${buy}/pickup`, { method: 'POST', body: { code } });
  assert.equal(pk.status, 404);
  assert.match(pk.json.error, /已失效/);
  // 改時間（含日期）：報名截止與還沒到的開始時間跟著平移
  const mv = await mkEvent({ title: '平移期間', date: plus(10), deadline: `${plus(9)}T22:00`, signup_start: `${plus(2)}T20:00` });
  assert.equal((await call('t_chair', `/events/${mv}/notice`, { method: 'POST', body: { type: 'time', date: plus(6) } })).status, 200);
  let e = (await call('t_chair', `/events/${mv}`)).json;
  assert.deepEqual([e.date, e.deadline, e.signup_start], [plus(6), `${plus(5)}T22:00`, null], '截止跟著提前 4 天；開始時間平移後已經過了，改成立即開放');
  assert.equal((await call('t_chair', `/events/${mv}/notice`, { method: 'POST', body: { type: 'time', date: plus(1), gather_time: '07:00' } })).status, 200);
  e = (await call('t_chair', `/events/${mv}`)).json;
  assert.ok(!e.deadline || e.deadline <= `${plus(1)}T07:00`, `截止不會晚於活動開始：${e.deadline}`);
  // 已繳費的正取取消：主辦待辦不放金額
  const paid = await mkEvent({ title: '退費待辦', options: [{ name: '一般', price: 300 }] });
  await signup('t_runner', paid, { option: '一般' });
  await call('t_chair', `/events/${paid}/payments`, { method: 'POST', body: { member_ids: ['t_runner'], paid: 'paid' } });
  await unsign('t_runner', paid);
  const todo = (await notesFor('t_chair', paid)).find((n) => n.title.endsWith('有人取消報名'));
  assert.ok(todo, '主辦收到退費待辦');
  assert.ok(!/NT\$/.test(todo.body || ''), todo.body);
  // 標記已退費：待辦結掉，待退費備註清掉
  await call('t_chair', `/events/${paid}/payments`, { method: 'POST', body: { member_ids: ['t_runner'], paid: 'refunded' } });
  const row = (await call('t_chair', `/events/${paid}/stats`)).json.people.find((x) => x.member_id === 't_runner');
  assert.equal(row?.paid, 'refunded');
  assert.ok(!/待退費/.test(row?.paid_note || ''));
});

test('附近即時影像：功能開關預設關閉、同步與完整性檢查、最近鏡頭（3 公里備援）不回原始網址、畫面轉送與節流、來源開關要同意、手動直播連結（CAM_MOCK 不連外）', async () => {
  const mock = (q = '') => fetch(`${BASE}/api/dev/cams-mock?${q}`).then((r) => r.json());
  const frame = (who, id) => call(who, `/cams/${encodeURIComponent(id)}/frame`);
  const near = async (who = 't_runner') => (await call(who, '/spots/seed07/cams')).json.cams;
  await mock('reset=1');
  // 權限：要登入；來源設定只有理事長、行政人員能改，監事只能看
  assert.equal((await call(null, '/spots/seed07/cams')).status, 401);
  assert.equal((await call(null, `/cams/${encodeURIComponent('wra:M1')}/frame`)).status, 401);
  assert.equal((await call('t_runner', '/cams/sources')).status, 403);
  assert.equal((await call('t_runner', '/cams/sync', { method: 'POST', body: { source: 'wra' } })).status, 403);
  const sv = await call('t_super', '/cams/sources');
  assert.equal(sv.status, 200); assert.equal(sv.json.editable, false);
  assert.equal((await call('t_super', '/cams/sources', { method: 'POST', body: { source: 'wra', enabled: false } })).status, 403);
  // 預設：水利署、公路局開啟；臺北市水利處關閉（要書面同意），關閉時不能同步、也不會連線
  const on = async () => Object.fromEntries((await call('t_chair', '/cams/sources')).json.sources.map((s) => [s.source, s.enabled]));
  assert.deepEqual(await on(), { wra: true, thb: true, heo: false, link: true });
  assert.equal((await call('t_chair', '/cams/sync', { method: 'POST', body: { source: 'heo' } })).status, 400);
  assert.equal((await call('t_chair', '/cams/sources', { method: 'POST', body: { source: '__proto__', enabled: true } })).status, 400, '來源代碼查不到原型上的東西');
  assert.equal((await call('t_chair', '/cams/sources', { method: 'POST', body: { source: 'constructor', enabled: true } })).status, 400);
  // 手動同步（功能開關關著也可以先測）：白名單外的主機、非 https、非預設埠、國外座標都不收
  const w = await call('t_chair', '/cams/sync', { method: 'POST', body: { source: 'wra' } });
  assert.equal(w.status, 200); assert.equal(w.json.count, 4);
  assert.equal((await call('t_chair', '/cams/sources')).json.sources.find((s) => s.source === 'wra').last_error, null, '同步成功後清掉「同步中」');
  // 功能開關預設關閉：地點卡不顯示、畫面與新增連結都 404、排程不同步
  const cron = async (at) => (await call(null, `/dev/cron?at=${at}`)).json.cams;
  assert.equal((await call('t_chair', '/cams/sources')).json.feature, false);
  const off = await call('t_runner', '/spots/seed07/cams');
  assert.equal(off.status, 200); assert.equal(off.json.enabled, false); assert.deepEqual(off.json.cams, []);
  assert.equal((await frame('t_runner', 'wra:M1')).status, 404);
  assert.equal((await call('t_chair', '/cams', { method: 'POST', body: { name: 'x', page_url: 'https://www.youtube.com/watch?v=x', lat: 25.07, lng: 121.54 } })).status, 404);
  const hits0 = Object.values((await mock()).hits).reduce((n, v) => n + v, 0);
  assert.equal(await cron('2027-06-15T20:30:00Z'), null, '功能關閉時排程不同步');
  assert.equal(Object.values((await mock()).hits).reduce((n, v) => n + v, 0), hits0, '也不連線');
  assert.equal((await call('t_chair', '/settings/features', { method: 'POST', body: { cams: true } })).status, 200);
  assert.equal((await call('t_chair', '/cams/sources')).json.feature, true);
  // 排程：每天每個來源只同步一次（台北 04:00 起），每次排程最多一個來源
  await mock('shrink=1');
  const c1 = await cron('2027-06-15T20:30:00Z');
  assert.match(String(c1.wra), /^error: 筆數從 4 掉到 1/, '筆數驟減：這次不寫入');
  assert.equal(c1.thb, undefined, '公路局 05:00 才同步');
  assert.equal((await cron('2027-06-15T20:40:00Z')), null, '同一天不重複');
  assert.ok((await near()).some((c) => c.id === 'wra:M1'), '完整性檢查擋下時不停用任何鏡頭');
  assert.match((await call('t_chair', '/cams/sources')).json.sources.find((s) => s.source === 'wra').last_error, /這次不更新/);
  await mock('shrink=0&drop=1');
  assert.equal((await cron('2027-06-16T20:30:00Z')).wra, 3, '少一支（75%）照常更新');
  assert.equal((await call('t_chair', '/cams/sources')).json.sources.find((s) => s.source === 'wra').active, 3, '清單不再出現的鏡頭停用');
  await mock('drop=0');
  assert.equal((await cron('2027-06-17T20:30:00Z')).wra, 4);
  assert.equal((await cron('2027-06-17T21:30:00Z')).thb, 2);
  assert.equal(await cron('2027-06-17T21:40:00Z'), null);
  // 地點附近：1.5 公里內最多 3 支、河濱優先河川鏡頭；不回原始影像網址
  const r = await call('t_runner', '/spots/seed07/cams');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /^private/);
  const cams = r.json.cams;
  assert.ok(cams.length >= 2 && cams.length <= 3, `鏡頭 ${cams.length} 支`);
  assert.ok(cams.every((c) => c.dist <= 1500 && c.attribution && c.source_name), '都在 1.5 公里內、有顯名');
  assert.ok(!cams.some((c) => c.id === 'wra:M4'), '太遠的不列');
  assert.ok(cams.filter((c) => c.source === 'wra').length <= 2, '同一來源最多 2 支');
  assert.equal(cams.find((c) => c.id === 'wra:M1').attribution, '影像來源：經濟部水利署（政府資料開放授權條款第1版）');
  assert.ok(!/src_url|getImage|\/snapshot|cctv-ss|fmg\.wra/.test(r.text), '不回原始影像網址');
  assert.equal(r.json.enabled, true);
  assert.ok(cams.every((c) => c.far === false));
  assert.equal((await call('t_runner', '/spots/nope404/cams')).status, 404);
  // 1.5 公里內沒有：改給 3 公里內最近的 1 支，標 far
  const fb = (await call('t_runner', '/spots/seed01/cams')).json.cams;
  assert.equal(fb.length, 1, '備援半徑只給一支');
  assert.ok(fb[0].far && fb[0].dist > 1500 && fb[0].dist <= 3000, `較遠 ${fb[0].dist} 公尺`);
  // 畫面轉送：檔頭判斷格式（水利署標 jpeg 其實是 PNG）、不轉送來源的 cookie、快取、CSP
  const f1 = await frame('t_runner', 'wra:M1');
  assert.equal(f1.status, 200);
  assert.equal(f1.headers.get('content-type'), 'image/png');
  assert.equal(f1.headers.get('set-cookie'), null, '來源的 cookie 不轉送');
  assert.match(f1.headers.get('cache-control'), /^private, max-age=\d+$/);
  assert.equal(f1.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(f1.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Date.parse(f1.headers.get('x-cam-at')) > Date.now() - 120e3, '有擷取時間');
  const f2 = await frame('t_other', 'wra:M1');
  assert.equal(f2.status, 200);
  assert.match(f2.headers.get('x-cam-cache'), /^(hit|mem)$/, '60 秒內不再向來源抓');
  const hits = (await mock()).hits;
  assert.equal(Object.entries(hits).filter(([u]) => /CCTV_SN=0xMOCKM1$/.test(u)).reduce((n, [, v]) => n + v, 0), 1, '同一支鏡頭只向來源抓一次');
  assert.equal((await frame('t_runner', 'thb:CCTV-T1')).headers.get('content-type'), 'image/jpeg');
  // 抓不到：502；60 秒內再要也不會再打來源，而且照實回 502（不是「更新中」的 503）
  assert.equal((await frame('t_runner', 'wra:M3')).status, 502);
  assert.equal((await frame('t_runner', 'wra:M3')).status, 502);
  assert.equal(Object.entries((await mock()).hits).filter(([u]) => /0xBROKEN$/.test(u)).reduce((n, [, v]) => n + v, 0), 1, '節流期間不再向來源抓');
  assert.equal((await frame('t_runner', 'wra:NOPE')).status, 404);
  assert.equal((await frame('t_runner', 'wra:M5')).status, 404, '白名單外的鏡頭根本沒有收進來');
  // 臺北市水利處：沒有勾選書面同意不能開；開啟後才同步、才出現；關掉立即消失，也不再轉送
  assert.equal(Object.keys((await mock()).hits).filter((u) => u.includes('heopublic')).length, 0, '關閉時沒有任何連線');
  assert.equal((await call('t_chair', '/cams/sources', { method: 'POST', body: { source: 'heo', enabled: true } })).status, 400);
  assert.equal((await call('t_chair', '/cams/sources', { method: 'POST', body: { source: 'heo', enabled: true, consent: true } })).status, 200);
  assert.equal((await call('t_chair', '/cams/sync', { method: 'POST', body: { source: 'heo' } })).json.count, 2, '只收 IsLive=1；iframe 類改用封面圖');
  assert.ok((await near()).some((c) => c.source === 'heo' && c.attribution === '影像來源：臺北市政府工務局水利工程處'));
  assert.equal((await frame('t_runner', 'heo:H2')).status, 200);
  assert.ok(Object.keys((await mock()).hits).some((u) => u === 'https://video.nvr.taifo.com.tw/memfs/ab77d8d8-5abf-46f7-abba-9789b04e64e6.jpg'));
  assert.equal((await call('t_chair', '/cams/sources', { method: 'POST', body: { source: 'heo', enabled: false } })).status, 200);
  assert.ok(!(await near()).some((c) => c.source === 'heo'), '關掉立即消失');
  assert.equal((await frame('t_runner', 'heo:H1')).status, 404);
  await cron('2027-06-18T20:30:00Z');
  assert.equal(Object.entries((await mock()).hits).filter(([u]) => u.includes('heopublic')).reduce((n, [, v]) => n + v, 0), 1, '關閉後排程不再連線');
  // 手動直播連結：幹部新增、只外連（沒有畫面轉送）；直播連結的來源關掉時不能新增
  const link = { name: '大佳河濱直播', page_url: 'https://www.youtube.com/watch?v=test123', label: '臺北市觀光傳播局', lat: 25.07358, lng: 121.54011, kind: 'park' };
  await call('t_chair', '/cams/sources', { method: 'POST', body: { source: 'link', enabled: false } });
  assert.equal((await call('t_runner', '/spots/seed07/cams')).json.link, false);
  assert.equal((await call('t_chair', '/cams', { method: 'POST', body: link })).status, 400);
  await call('t_chair', '/cams/sources', { method: 'POST', body: { source: 'link', enabled: true } });
  assert.equal((await call('t_runner', '/spots/seed07/cams')).json.link, true);
  assert.equal((await call('t_runner', '/cams', { method: 'POST', body: link })).status, 403);
  assert.equal((await call('t_chair', '/cams', { method: 'POST', body: { ...link, page_url: 'http://example.com' } })).status, 400);
  assert.equal((await call('t_chair', '/cams', { method: 'POST', body: { ...link, lat: 40 } })).status, 400);
  const lk = await call('t_chair', '/cams', { method: 'POST', body: link });
  assert.equal(lk.status, 200);
  const shown = (await near()).find((c) => c.id === lk.json.id);
  assert.equal(shown.media, 'link'); assert.equal(shown.page_url, link.page_url); assert.match(shown.attribution, /臺北市觀光傳播局/);
  assert.equal(shown.label, '臺北市觀光傳播局'); assert.equal(shown.source_name, '官方直播');
  assert.equal((await frame('t_runner', lk.json.id)).status, 404, '連結不轉送畫面');
  assert.equal((await call('t_runner', `/cams/${lk.json.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('t_chair', `/cams/${lk.json.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await near()).some((c) => c.id === lk.json.id));
  // 每位跑友 10 分鐘最多 120 張
  let last = null;
  for (let i = 0; i < 121; i++) last = await frame('t_lead', 'wra:M1');
  assert.equal(last.status, 429);
  // 全站緊急停用：關掉功能開關，地點卡與畫面立即消失
  assert.equal((await call('t_chair', '/settings/features', { method: 'POST', body: { cams: false } })).status, 200);
  assert.equal((await call('t_runner', '/spots/seed07/cams')).json.enabled, false);
  assert.equal((await frame('t_runner', 'wra:M1')).status, 404);
  await mock('reset=1');
});

test('跑者休息站：功能開關預設關閉、權限、同步轉換與完整性檢查、分頁續跑、幹部修正不被覆蓋、格子與附近 API、不收管理人資料、稽核、刪帳號（REST_MOCK 不連外）', async () => {
  const mock = (q = '') => fetch(`${BASE}/api/dev/rest-mock?${q}`).then((r) => r.json());
  const hits = async () => Object.values((await mock()).hits).reduce((n, v) => n + v, 0);
  const cron = async (at) => (await call(null, `/dev/cron?at=${at}`)).json.rest;
  const sync = (source, who = 't_chair') => call(who, '/rest/sync', { method: 'POST', body: { source } });
  // 在電腦上同步的來源（tools/rest-sync.mjs）：正式環境的「立即同步」與排程都不跑，測試用開發端點走同一套解析與寫入
  const devSync = async (source) => { const r = await fetch(`${BASE}/api/dev/rest-sync?source=${source}`); return { status: r.status, json: await r.json() }; };
  const srcs = async () => Object.fromEntries((await call('t_chair', '/rest/sources')).json.sources.map((s) => [s.source, s]));
  const stops = async (key, who = 't_runner') => (await call(who, `/rest/cell/${key}`)).json.stops;
  const ids = async (key) => (await stops(key)).map((s) => s[0]);
  const find = async (key, name) => (await stops(key)).find((s) => s[7] === name)?.[0];
  const detail = (id, who = 't_runner') => call(who, `/rest/${encodeURIComponent(id)}`);
  const toggle = (source, enabled) => call('t_chair', '/rest/sources', { method: 'POST', body: { source, enabled } });
  await mock('reset=1');
  // 要登入
  for (const p of ['/rest/meta', '/rest/cell/1253_6077', '/spots/seed07/rest', '/rest/twd:D1', '/rest/sources']) assert.equal((await call(null, p)).status, 401, p);
  // 功能開關預設關閉：跑友端都 404、排程不同步也不連線
  assert.equal((await call('t_chair', '/rest/sources')).json.feature, false);
  for (const p of ['/rest/meta', '/rest/cell/1253_6077', '/spots/seed07/rest', '/rest/twd:D1']) assert.equal((await call('t_runner', p)).status, 404, p);
  const h0 = await hits();
  assert.equal(await cron('2027-07-04T17:30:00Z'), null, '功能關閉時排程不同步');
  assert.equal(await hits(), h0, '也不連線');
  // 權限：來源設定只有理事長、行政人員能改，監事只能看；一般跑友不能新增或同步
  assert.equal((await call('t_runner', '/rest/sources')).status, 403);
  assert.equal((await sync('twd', 't_runner')).status, 403);
  assert.equal((await call('t_runner', '/rest', { method: 'POST', body: { name: 'x', type: 'water', subtype: 'shop', lat: 25.07, lng: 121.54 } })).status, 403);
  const sv = await call('t_super', '/rest/sources');
  assert.equal(sv.status, 200); assert.equal(sv.json.editable, false);
  assert.equal((await call('t_super', '/rest/sources', { method: 'POST', body: { source: 'twd', enabled: false } })).status, 403);
  assert.equal((await toggle('__proto__', true)).status, 400, '來源代碼查不到原型上的東西');
  assert.equal((await toggle('tpbk', false)).status, 200);
  assert.equal((await sync('tpbk')).status, 400, '關閉的來源不能同步');
  assert.equal((await toggle('tpbk', true)).status, 200);
  assert.equal((await sync('cur')).status, 400, '整理清單不能同步');
  assert.deepEqual(Object.entries(await srcs()).filter(([, s]) => !s.enabled).map(([k]) => k), [], '第一批來源預設都開啟');
  // 手動同步（功能開關關著也可以先測）：重複代碼合併、國外座標丟掉；沒變就不寫
  assert.equal((await srcs()).twd.local, true); assert.equal((await srcs()).tprv.local, false);
  const lw = await sync('twd');
  assert.equal(lw.status, 400, '在電腦上同步的來源：立即同步不收（免費方案 CPU 不夠）'); assert.match(lw.json.error, /rest-sync/);
  const w = await devSync('twd');
  assert.equal(w.status, 200, JSON.stringify(w.json)); assert.equal(w.json.count, 5);
  assert.equal((await srcs()).twd.last_error, null, '同步成功後清掉「同步中」');
  assert.equal((await devSync('twd')).json.same, true, '內容雜湊沒變：不解析也不寫');
  // 開啟功能（只送其他開關、不帶 rest 的舊版畫面不會把它關掉）
  assert.equal((await call('t_chair', '/settings/features', { method: 'POST', body: { rest: true } })).status, 200);
  assert.equal((await call('t_chair', '/settings/features', { method: 'POST', body: { cams: false } })).status, 200);
  assert.equal((await call('t_chair', '/rest/sources')).json.feature, true);
  for (const k of ['tprv', 'ntrv', 'tpbk']) { const r = await sync(k); assert.equal(r.status, 200, `${k} ${r.text}`); }
  for (const k of ['tpt', 'cpct', 'sav']) { const r = await devSync(k); assert.equal(r.status, 200, `${k} ${JSON.stringify(r.json)}`); }
  const meta = await call('t_runner', '/rest/meta');
  assert.equal(meta.status, 200);
  assert.ok(meta.json.sources.some((s) => s.source === 'twd' && /臺北自來水事業處，依政府資料開放授權條款第1版提供/.test(s.attribution) && s.data_date === '2026-08-14'));
  // 座標轉換：TWD97（WGS84 空白）與度分秒
  const kid = await find('1253_6076', '大佳河濱公園');
  const k1 = (await detail(kid)).json.stop;
  assert.ok(Math.abs(k1.lat - 25.074578) < 1e-4 && Math.abs(k1.lng - 121.535869) < 1e-4, `TWD97 換算 ${k1.lat},${k1.lng}`);
  const nt = (await detail((await ids('1258_6071'))[0])).json.stop;
  assert.ok(Math.abs(nt.lat - 25.171244) < 1e-5 && Math.abs(nt.lng - 121.437361) < 1e-5, `度分秒 ${nt.lat},${nt.lng}`);
  assert.equal(nt.attribution, '資料來源：新北市政府水利局，依政府資料開放授權條款第1版提供');
  assert.equal((await detail('twd:FAR1')).status, 404, '國外座標不收');
  assert.equal((await ids('1253_6077')).filter((x) => x === 'twd:D1').length, 1, '重複代碼只有一筆');
  // 格子 API：不含暫停、精簡陣列、快取標頭、代碼格式
  const c1 = await call('t_runner', '/rest/cell/1253_6077');
  assert.equal(c1.status, 200);
  assert.equal(c1.headers.get('cache-control'), 'private, max-age=86400');
  assert.ok(!c1.json.stops.some((s) => s[0] === 'twd:D3'), '暫停的直飲臺不出現');
  assert.deepEqual(c1.json.stops.find((s) => s[0] === 'twd:D1').slice(1), ['water', 'fountain', 513, 'public', 25.0738, 121.5403, '大佳河濱公園 9號水門', '24 小時']);
  assert.equal((await detail('twd:D3')).json.stop.status, 'paused');
  for (const bad of ['12_34', 'abc', '1253_6077x', '1253-6077', '9_9', '12345_6077']) assert.equal((await call('t_runner', `/rest/cell/${bad}`)).status, 400, bad);
  // 完整性檢查：筆數掉到 70% 以下不寫入、不停用
  await mock('shrink=1');
  const sh = await devSync('twd');
  assert.equal(sh.status, 502); assert.match(sh.json.error, /筆數從 5 掉到 1，這次不更新/);
  assert.ok((await ids('1251_6076')).includes('twd:D2'), '擋下時不停用任何一筆');
  // 少一筆（80%）照常更新並停用消失的列
  await mock('shrink=0&drop=1');
  assert.equal((await devSync('twd')).json.count, 4);
  assert.ok(!(await ids('1255_6080')).includes('twd:D4'), '清單不再出現的直飲臺停用');
  assert.equal((await detail('twd:D4')).status, 404);
  assert.equal((await detail('twd:D4', 't_chair')).json.edit.enabled, false, '幹部看得到停用的列');
  // 排程：只跑留在 Worker 的小來源（河濱廁所、租借站、新北河濱），台北 01:00 起每次排程只跑一個到期的來源；在電腦上同步的來源排程不跑
  assert.deepEqual(await cron('2027-07-04T17:30:00Z'), { tprv: 2 }, '台北 01:30：直飲臺、臺北公廁在電腦上同步，排程輪到河濱廁所');
  assert.equal(await cron('2027-07-04T17:40:00Z'), null, '01:40：沒有其他到期的 Worker 來源');
  assert.equal(await cron('2027-07-04T19:30:00Z'), null, '03:00 不跑（備份時段）');
  assert.deepEqual(await cron('2027-07-04T22:30:00Z'), { tpbk: 2 }, '06:30：租借站與新北河濱都到期，一次只跑一個');
  assert.deepEqual(await cron('2027-07-04T22:40:00Z'), { ntrv: 1 });
  assert.equal(await cron('2027-07-04T22:50:00Z'), null, '這一期都跑完了（中油、運動場館、騎跡不在排程裡）');
  // 幹部修正與隱藏：同步後不被覆蓋
  const park = await find('1253_6076', '新生公園'), daan = await find('1251_6076', '大安森林公園');
  assert.ok(park && daan);
  assert.equal((await call('t_runner', `/rest/${park}`, { method: 'PUT', body: { fix: { name: 'x' } } })).status, 403, '跑友不能改');
  assert.equal((await call('t_chair', `/rest/${park}`, { method: 'PUT', body: { fix: { lat: 40, lng: 121 } } })).status, 400);
  assert.equal((await call('t_chair', `/rest/${park}`, { method: 'PUT', body: { fix: { name: '新生公園（近民族東路）', hours: '每日 05:00–23:00' }, note: '在公園東側' } })).status, 200);
  assert.equal((await call('t_chair', `/rest/${daan}`, { method: 'PUT', body: { hidden: true } })).status, 200);
  assert.ok(!(await ids('1251_6076')).includes(daan), '隱藏的不出現在格子');
  await mock('change=1');
  const ch = await devSync('tpt');
  assert.equal(ch.status, 200); assert.ok(ch.json.changed >= 1, '來源有變的列照常更新');
  const pk = (await detail(park)).json.stop;
  assert.equal(pk.name, '新生公園（近民族東路）'); assert.equal(pk.hours, '每日 05:00–23:00'); assert.equal(pk.note, '在公園東側');
  assert.ok(pk.svc & 32, '來源的新資料（無障礙）有寫進去');
  assert.ok(!(await ids('1251_6076')).includes(daan), '同步後仍然隱藏');
  assert.equal((await detail(daan)).status, 404);
  assert.equal((await detail(daan, 't_chair')).json.edit.hidden, true);
  // 地點附近：每類最多 2 處，依「距離 × 權重」排序；同一處（60 公尺內同名）合併
  const nr = await call('t_runner', '/spots/seed07/rest');
  assert.equal(nr.status, 200);
  const { groups } = nr.json;
  assert.ok(Object.values(groups).every((g) => g.length <= 2 && g.every((x) => x.dist <= 1000)));
  assert.deepEqual(groups.toilet.map((x) => x.name), ['大佳河濱公園', '麥當勞大直店'], '公共 120 m 排在店家 100 m（權重 1.3）前面');
  assert.ok(groups.toilet[0].svc & 32);
  assert.equal((await stops('1253_6077')).filter((s) => s[7] === '大佳河濱公園').length, 1, '臺北公廁與河濱廁所（11 m、同名）合併成一處');
  assert.equal(groups.toilet[1].access, 'customer');
  assert.equal(groups.water[0].id, 'twd:D1');
  assert.ok(!JSON.stringify(groups).includes('twd:D3'), '暫停的不列');
  assert.equal((await call('t_runner', '/spots/nope404/rest')).status, 404);
  // 運動場館：不收管理人姓名與電話；開放時間整理成標準寫法、原文去掉電話
  const savId = (await stops('1251_6076')).find((s) => s[0].startsWith('sav:'))[0];
  const sd = await detail(savId);
  assert.equal(sd.json.stop.hours, '每日 06:00–22:00'); assert.equal(sd.json.stop.access, 'paid');
  assert.match(sd.json.stop.attribution, /運動部/);
  for (const t of [sd.text, (await call('t_runner', '/rest/cell/1251_6076')).text]) assert.ok(!/王小明|2345-6789|2377-0300|管理人/.test(t), '沒有管理人與電話');
  // 外連只收 https
  assert.equal((await detail('twd:D2')).json.stop.ref_url, null, '來源給 http 的水質頁不收');
  assert.match((await detail('twd:D1')).json.stop.ref_url, /^https:\/\//);
  // 幹部新增、修改、刪除（man）；官方資料不能刪
  const add = { name: '測試補水點', type: 'water', subtype: 'shop', lat: 25.0737, lng: 121.5402, hours: '每日 07:00–19:00', access: 'customer', ref_url: 'https://example.com/x', note: '電話 02-2345-6789，請先詢問' };
  assert.equal((await call('t_chair', '/rest', { method: 'POST', body: { ...add, ref_url: 'http://example.com' } })).status, 400);
  assert.equal((await call('t_chair', '/rest', { method: 'POST', body: { ...add, ref_url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('t_chair', '/rest', { method: 'POST', body: { ...add, type: 'spa' } })).status, 400);
  assert.equal((await call('t_chair', '/rest', { method: 'POST', body: { ...add, svc: 2048 } })).status, 400);
  assert.equal((await call('t_chair', '/rest', { method: 'POST', body: { ...add, lat: 40 } })).status, 400);
  assert.equal((await call('t_chair', '/rest', { method: 'POST', body: { ...add, name: '名'.repeat(41) } })).status, 400);
  const mk = await call('t_chair', '/rest', { method: 'POST', body: add });
  assert.equal(mk.status, 200);
  const md = (await detail(mk.json.id)).json.stop;
  assert.equal(md.hours, '每日 07:00–19:00'); assert.equal(md.manual, true); assert.ok(!/2345/.test(md.note), '補充說明不存電話');
  assert.ok((await ids('1253_6077')).includes(mk.json.id));
  assert.equal((await call('t_chair', `/rest/${mk.json.id}`, { method: 'PUT', body: { ...add, hours: '看天氣' } })).status, 200);
  const md2 = (await detail(mk.json.id)).json.stop;
  assert.equal(md2.hours, null); assert.equal(md2.hours_raw, '看天氣', '看不懂的時間只存原文');
  assert.equal((await call('t_chair', '/rest/twd:D1', { method: 'DELETE' })).status, 400, '官方資料不能刪');
  assert.equal((await call('t_runner', `/rest/${mk.json.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('t_chair', `/rest/${mk.json.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await detail(mk.json.id)).status, 404);
  assert.equal((await detail('cur:runbase-daan')).json.stop.checked_at, '2026-10-03', '整理清單有查證日');
  // 分頁來源（臺灣騎跡，25 條路線 → 3 頁）：中途中斷後續跑，跑完一輪才停用消失的列（正式環境在電腦上一次跑完，這裡測 Worker 的分頁版本）
  await mock('drop=0');
  assert.equal(await cron('2027-07-05T18:30:00Z'), null, '騎跡不在排程裡');
  assert.equal((await devSync('tbk')).json.page, 1);
  await mock('failPage=2');
  const pf = await devSync('tbk');
  assert.equal(pf.status, 502); assert.match(pf.json.error, /來源回應 500/);
  assert.equal((await srcs()).tbk.page, 1, '失敗時 cursor 不動');
  await mock('failPage=0');
  assert.equal((await devSync('tbk')).json.page, 2, '從中斷的那一頁續跑');
  const t3 = (await devSync('tbk')).json;
  assert.equal(t3.page, 3); assert.equal(t3.count, 28); assert.equal(t3.done, true);
  const seven = (await stops('1170_6020')).find((s) => /7-ELEVEN/.test(s[7]));
  assert.equal(seven[4], 'customer', '超商補給站是店家');
  const tail = (await ids('1165_6015'))[0];
  assert.ok(tail);
  await mock('drop=1');
  await devSync('tbk'); await devSync('tbk');
  assert.equal((await detail(tail)).status, 200, '一輪還沒跑完不停用');
  assert.equal((await devSync('tbk')).json.count, 27);
  assert.equal((await detail(tail)).status, 404, '跑完一輪才停用沒看到的列');
  // 稽核紀錄
  const au = (await call('t_chair', '/audit?action=rest.')).json.items.map((x) => x.action);
  for (const a of ['rest.add', 'rest.fix', 'rest.hide', 'rest.delete']) assert.ok(au.includes(a), a);
  const as = (await call('t_chair', '/audit?action=settings.rest')).json.items.map((x) => x.action);
  assert.ok(as.includes('settings.rest') && as.includes('settings.rest_sync'));
  // 刪除帳號：建立者與修改者欄位清掉，資料留著
  const j = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'test-join', name: '休息站測試', dist: 'fm', grp: 'D', consent: true }) });
  const uid = (await j.json()).member.id;
  assert.equal((await call('t_chair:mfa', `/members/${uid}/role`, { method: 'POST', body: { role: 'coach' } })).status, 200);
  const ck = (await fetch(`${BASE}/api/dev/login?id=${uid}&mfa=1`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const hd = { cookie: ck, origin: BASE, 'content-type': 'application/json' };
  const mine = await (await fetch(`${BASE}/api/rest`, { method: 'POST', headers: hd, body: JSON.stringify({ ...add, name: '刪帳號測試點' }) })).json();
  assert.ok(mine.id);
  assert.ok((await detail(mine.id, 't_chair')).json.edit.added_by, '幹部看得到是誰新增的');
  assert.equal((await fetch(`${BASE}/api/me`, { method: 'DELETE', headers: { cookie: ck, origin: BASE } })).status, 200);
  const after = await detail(mine.id, 't_chair');
  assert.equal(after.status, 200, '資料留著'); assert.equal(after.json.edit.added_by, null, '建立者清掉');
  // 全站緊急停用
  assert.equal((await call('t_chair', '/settings/features', { method: 'POST', body: { rest: false } })).status, 200);
  assert.equal((await call('t_runner', '/rest/cell/1253_6077')).status, 404);
  assert.equal((await call('t_runner', '/spots/seed07/rest')).status, 404);
  await mock('reset=1');
});
