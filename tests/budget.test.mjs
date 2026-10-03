// 執行額度測試（Workers 免費方案：每次執行 50 個子請求）：排程拆開、每日備份、失敗重跑、安靜的整點
// 需要：測試用伺服器（tests/run.mjs 會用 PLAN=free、BUDGET_STRICT=1 啟動，超過上限就丟錯並記到 /api/dev/budget-violations）
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
const cron = async (q) => (await call(null, `/dev/cron?${q}`)).json;
const jobs = async () => Object.fromEntries((await call(null, '/dev/jobs')).json.jobs.map((j) => [j.job, j]));
const violations = async () => (await call(null, '/dev/budget-violations?clear=1')).json.list;
const plus = (d) => new Date(Date.now() + 8 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
// 每個執行（父執行與每個子執行）都在 50 以內
function within(r, msg) {
  const all = [['root', r._budget.root], ...Object.entries(r._budget.jobs)];
  for (const [k, b] of all) {
    assert.ok(b.sub <= 50, `${msg}：${k} 用了 ${b.sub} 個子請求`);
    if (b.d1 != null) assert.ok(b.d1 <= 50, `${msg}：${k} 用了 ${b.d1} 句 D1`);
  }
}

test('執行額度：台北 03:00 只跑備份（開自己的執行），資料清理延到 04:00', async () => {
  await violations();
  const r = await cron('at=2028-03-14T19:00:00Z');
  within(r, '03:00');
  assert.ok(r.backup && typeof r.backup === 'object', JSON.stringify(r));
  assert.equal(r.backup.label, '2028-03-15');
  assert.ok(r.backup.tables >= 25 && r.backup.rows > 10);
  const bj = r._budget.jobs.backup;
  assert.ok(bj, '備份有自己的用量紀錄');
  assert.ok(bj.sub - (bj.inherit || 0) <= 40, `備份子執行用了 ${bj.sub - (bj.inherit || 0)} 個`);
  assert.ok(r.retention === null || r.retention === 'deferred', `資料清理應該延後：${JSON.stringify(r.retention)}`);
  assert.deepEqual(await violations(), []);
  // 04:00：不再備份，補做資料清理
  const r4 = await cron('at=2028-03-14T20:00:00Z');
  within(r4, '04:00');
  assert.ok(r4.retention && typeof r4.retention === 'object', JSON.stringify(r4));
  assert.ok('sessions' in r4.retention);
  assert.equal(r4.backup, null);
  const j = await jobs();
  assert.equal(j.backup.last_run, '2028-03-15');
  assert.equal(j.retention.last_run, '2028-03-15');
  assert.equal(j.backup.claim_key, null);
  assert.deepEqual(await violations(), []);
});

test('執行額度：備份解得回來，格式與筆數都對', async () => {
  // 每日備份（上一個測試的 2028-03-15）
  const d = (await call(null, '/dev/backup-check?label=2028-03-15')).json;
  assert.equal(d.format, 'cil-backup');
  assert.equal(d.version, 1);
  assert.ok(!('sessions' in d.counts) && !('client_metrics' in d.counts) && !('client_errors' in d.counts), '暫存與遙測不在備份裡');
  assert.ok(d.counts.members >= 5);
  // 手動備份之後馬上對照：除了稽核紀錄（備份完才寫），每張表的筆數都和現在一樣
  const bk = await call('t_chair', '/backups', { method: 'POST', body: {} });
  assert.equal(bk.status, 200, bk.text);
  const sub = Number(/sub=(\d+)/.exec(bk.headers.get('x-budget'))?.[1]);
  assert.ok(sub > 0 && sub <= 50, `手動備份用了 ${sub} 個子請求`);
  const m = (await call(null, '/dev/backup-check')).json;
  assert.match(m.key, /manual/);
  assert.equal(m.format, 'cil-backup');
  for (const [t, n] of Object.entries(m.counts)) {
    if (t === 'audit_log') assert.ok(n <= m.now[t] && m.now[t] - n <= 3, `${t}：備份 ${n}、現在 ${m.now[t]}`);
    else assert.equal(n, m.now[t], `${t} 的筆數`);
  }
  if ('cams' in m.counts) assert.ok(m.counts.cams <= m.now.cams);
  assert.deepEqual(await violations(), []);
});

test('執行額度：失敗後下個整點重跑；連續失敗 3 次就放棄並寫稽核', async () => {
  // 台北 2028-03-17 03:00 備份失敗（佔用之後丟錯）
  const f1 = await cron('at=2028-03-16T19:00:00Z&fail=backup');
  within(f1, '失敗那次');
  assert.match(String(f1.backup), /^error: /);
  let j = await jobs();
  assert.equal(j.backup.attempts, 1);
  assert.equal(j.backup.last_run, '2028-03-15', '完成的 key 不變');
  assert.equal(j.backup.claim_key, '2028-03-17');
  assert.ok(j.backup.last_error);
  // 下個整點（不帶 fail）完成
  const ok = await cron('at=2028-03-16T20:00:00Z');
  within(ok, '重跑');
  assert.equal(ok.backup?.label, '2028-03-17', JSON.stringify(ok.backup));
  j = await jobs();
  assert.equal(j.backup.last_run, '2028-03-17');
  assert.equal(j.backup.last_error, null);
  // 台北 2028-03-18：連續失敗 3 次 → 放棄
  for (const h of ['19', '20', '21']) assert.match(String((await cron(`at=2028-03-17T${h}:00:00Z&fail=backup`)).backup), /^error: /);
  j = await jobs();
  assert.equal(j.backup.attempts, 3);
  const after = await cron('at=2028-03-17T22:00:00Z');
  assert.equal(after.backup, null, '失敗 3 次之後不再重跑');
  j = await jobs();
  assert.equal(j.backup.attempts, 3);
  assert.equal(j.backup.last_run, '2028-03-17');
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=cron.gave`)).json.items;
  assert.ok(au.some((x) => x.target_id === 'backup' && x.actor_name === '系統排程' && x.detail.includes('2028-03-18')), JSON.stringify(au));
  // 隔天重新計算
  const next = await cron('at=2028-03-18T19:00:00Z');
  assert.equal(next.backup?.label, '2028-03-19');
  assert.deepEqual(await violations(), []);
});

test('執行額度：強制走 ctx.exports.Jobs（dispatch=self）也正常', async () => {
  const r = await cron('at=2028-03-19T20:00:00Z&dispatch=self');
  within(r, 'self');
  assert.ok(r.retention && typeof r.retention === 'object', JSON.stringify(r));
  assert.ok(r._budget.jobs.retention && r._budget.jobs.retention.kind === 'job', '資料清理在自己的執行裡跑');
  assert.deepEqual(await violations(), []);
});

test('執行額度：安靜的整點只有 1 句', async () => {
  // 台北 2031-01-16 02:00：沒有每日工作；先跑幾次把待處理的舊資料（例如逾期待審核）處理掉
  let r;
  for (let i = 0; i < 5; i++) {
    r = await cron('at=2031-01-15T18:00:00Z');
    within(r, '安靜的整點');
    if (r._budget.root.sub === 1) break;
  }
  assert.equal(r._budget.root.sub, 1, JSON.stringify(r._budget));
  assert.equal(r._budget.root.d1, 1);
  assert.deepEqual(r._budget.jobs, {});
  assert.deepEqual(await violations(), []);
});

test('執行額度：一般請求帶 x-budget，而且在 50 以內', async () => {
  const r = await call('t_chair', '/me?boot=1');
  assert.equal(r.status, 200);
  const h = r.headers.get('x-budget');
  assert.match(h, /^d1=\d+;kv=\d+;fetch=\d+;rpc=\d+;sub=\d+$/);
  assert.ok(Number(/sub=(\d+)/.exec(h)[1]) <= 50);
  assert.deepEqual(await violations(), []);
});

// ---- 大量輸入的路由（每個請求 50 個子請求以內；逐人處理的流程分段，回 more 再送一次）----
const subOf = (r) => Number(/sub=(\d+)/.exec(r.headers.get('x-budget') || '')?.[1]);
const ok50 = (r, msg) => { assert.equal(r.status, 200, `${msg}：${r.text}`); assert.ok(subOf(r) <= 50, `${msg}：用了 ${subOf(r)} 個子請求`); return r.json; };
const evBody = (body) => ({ kind: 'track', title: '額度測試', gather_time: '07:00', notify: false, date: plus(20), ...body });
// 照前端 apiAll 的做法：看到 more 就合併進 body 再送，結果加總；回傳每一輪的回應
async function rounds(who, path, body, max = 200) {
  const out = [];
  for (let i = 0, b = body; i < max; i++) {
    const r = await call(who, path, { method: 'POST', body: b });
    out.push(ok50(r, `${path} 第 ${i + 1} 輪`));
    if (!r.json.more) return out;
    b = { ...b, ...r.json.more };
  }
  throw new Error(`${path} 超過 ${max} 輪還沒做完`);
}
const bnames = (from, n) => Array.from({ length: n }, (_, i) => `大量測試${String(from + i).padStart(4, '0')}`);
const bids = (from, n) => Array.from({ length: n }, (_, i) => `b_${String(from + i).padStart(4, '0')}`);

test('大量輸入：300 位會員、400 個訂閱的測試資料', async () => {
  await violations();
  assert.equal((await call(null, '/dev/seed-bulk?members=300&subs=400')).json.members, 300);
});

test('大量輸入：系列活動 60 場、刪除之後的場次、獎品 200 列、邀請 150 與 300 人', async () => {
  const s = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '每天揪跑', date: plus(30), repeat: { weekdays: [0, 1, 2, 3, 4, 5, 6], until: plus(120) } }) }), '系列活動');
  assert.equal(s.count, 60);
  const list = ok50(await call('t_chair', `/events/${s.id}`), '讀活動');
  assert.equal(list.date, plus(30));
  const del = ok50(await call('t_chair', `/events/${s.id}?series=after`, { method: 'DELETE' }), '刪除之後的場次');
  assert.equal(del.count, 60);
  assert.equal((await call('t_chair', `/events/${s.id}`)).status, 404);

  const pid = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ kind: 'party', title: '額度尾牙' }) }), '建立餐敘').id;
  const prizes = Array.from({ length: 200 }, (_, i) => ({ stage: i < 100 ? '上半場' : '下半場', name: `獎品 ${i + 1}`, qty: 1 + (i % 3), sponsor: '測試贊助' }));
  assert.equal(ok50(await call('t_chair', `/events/${pid}/prizes`, { method: 'POST', body: { list: prizes } }), '獎品匯入').added, 200);
  const pr = (await call('t_chair', `/events/${pid}/prizes`)).json.prizes;
  assert.equal(pr.length, 200);
  assert.deepEqual(pr.slice(0, 3).map((p) => p.name), ['獎品 1', '獎品 2', '獎品 3'], '順序不變');

  const iid = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '額度邀請', visibility: 'invite' }) }), '建立邀請制').id;
  assert.equal(ok50(await call('t_chair', `/events/${iid}/invites`, { method: 'POST', body: { member_ids: bids(0, 150), notify: false } }), '邀請 150 人').added, 150);
  // 300 個 id（以前 IN() 綁 300 個參數，超過 D1 的 100 個上限）：前 150 個已經邀過
  assert.equal(ok50(await call('t_chair', `/events/${iid}/invites`, { method: 'POST', body: { member_ids: [...bids(0, 300), 'nobody'], notify: false } }), '邀請 300 人').added, 150);
  assert.equal((await call('t_chair', `/events/${iid}/invites`)).json.invites.length, 300);
  assert.deepEqual(await violations(), []);
});

test('大量輸入：貼上 300 個名字代為報名，分段處理的結果和一次處理相同', async () => {
  const id = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '額度代報', capacity: 100, require_approval: false }) }), '建立活動').id;
  const names = bnames(0, 300);
  const rs = await rounds('t_chair', `/events/${id}/bulk`, { action: 'signup', names: names.join('\n') });
  assert.ok(rs.length > 1, '一輪做不完，要分段');
  assert.equal(rs.reduce((n, r) => n + r.added, 0), 300);
  assert.deepEqual(rs[0].unmatched, []);
  const ev = (await call('t_chair', `/events/${id}`)).json;
  const st = Object.fromEntries(ev.signups.map((x) => [x.member_id, x.status]));
  // 依貼上的順序：前 100 位正取、其餘候補（和一次處理一樣）
  assert.deepEqual(bids(0, 100).map((m) => st[m]), Array(100).fill('in'));
  assert.deepEqual(bids(100, 200).map((m) => st[m]), Array(200).fill('wait'));
  assert.deepEqual(await violations(), []);
});

test('大量輸入：審核 60 人，分段處理，依報名先後排進正取', async () => {
  const id = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '額度審核', capacity: 30, require_approval: true }) }), '建立活動').id;
  await call(null, `/dev/seed-bulk?event=${id}&pending=60`);
  const rs = await rounds('t_chair', `/events/${id}/review`, { action: 'approve', member_ids: bids(0, 60) });
  assert.ok(rs.length > 1, '一輪做不完，要分段');
  assert.equal(rs.reduce((n, r) => n + r.in.length + r.wait.length, 0), 60);
  assert.equal(rs.at(-1).pending, 0);
  const ev = (await call('t_chair', `/events/${id}`)).json;
  const st = Object.fromEntries(ev.signups.map((x) => [x.member_id, x.status]));
  // 報名時間依序相差 1 秒：先報名的 30 位正取、後面 30 位候補
  assert.deepEqual(bids(0, 30).map((m) => st[m]), Array(30).fill('in'));
  assert.deepEqual(bids(30, 30).map((m) => st[m]), Array(30).fill('wait'));
  assert.deepEqual(ev.signups.filter((x) => x.status === 'wait').map((x) => x.member_id), bids(30, 30), '候補順序依報名先後');
  // 繳費標記 60 人一句
  ok50(await call('t_chair', `/events/${id}/payments`, { method: 'POST', body: { member_ids: bids(0, 60), paid: 'waived' } }), '繳費標記');
  assert.deepEqual(await violations(), []);
});

test('大量輸入：國定假日匯入（假資料 365 天）在 16 個子請求以內；主團設定 300 人', async () => {
  const r = await call('t_chair', '/holidays/import', { method: 'POST', body: { year: 2031 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.total, 365);
  assert.ok(subOf(r) <= 16, `假日匯入用了 ${subOf(r)} 個子請求`);
  const cal = (await call('t_chair', '/calendar?from=2031-01-01&to=2031-01-31')).json;
  assert.ok(cal);
  ok50(await call('t_chair', '/members/main-team', { method: 'POST', body: { member_ids: bids(0, 300), team_id: null } }), '主團設定');
  assert.deepEqual(await violations(), []);
});

test('大量輸入：排桌（同一個代碼以最後一筆為準）與一次抽 20 位', async () => {
  const id = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ kind: 'party', title: '額度抽獎' }) }), '建立餐敘').id;
  await rounds('t_chair', `/events/${id}/bulk`, { action: 'signup', names: bnames(0, 30).join('\n') });
  const tickets = (await call('t_chair', `/events/${id}/tickets`)).json.tickets;
  assert.equal(tickets.length, 30);
  const seats = tickets.map((t, i) => ({ code: t.code, table_no: 1 + (i % 5) }));
  seats.push({ code: tickets[0].code.toLowerCase(), table_no: 9, note: '主桌' });
  assert.equal(ok50(await call('t_chair', `/events/${id}/seats/assign`, { method: 'POST', body: { seats } }), '排桌').updated, 30);
  const t0 = (await call('t_chair', `/events/${id}/tickets`)).json.tickets.find((t) => t.code === tickets[0].code);
  assert.equal(t0.table_no, 9); assert.equal(t0.note, '主桌');
  const pid = ok50(await call('t_chair', `/events/${id}/prizes`, { method: 'POST', body: { name: '大獎', qty: 20 } }), '新增獎項').id;
  const d = ok50(await call('t_chair', `/events/${id}/draw`, { method: 'POST', body: { prize_id: pid, count: 20, onlyCheckedIn: false } }), '抽 20 位');
  assert.equal(d.winners.length, 20);
  assert.equal((await call('t_chair', `/events/${id}/prizes`)).json.draws.length, 20);
  assert.deepEqual(await violations(), []);
});

test('大量輸入：清掉測試資料', async () => {
  assert.equal((await call(null, '/dev/seed-bulk?clear=1')).json.ok, true);
});
