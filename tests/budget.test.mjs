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
// 要一個整點做完的備份：前面的 api.test 讓測試資料庫超過一段（256 KB），這裡把一段放大（只有 DEV_LOGIN=1 的本機收 seg）
const ONE_SEG = 4 * 1024 * 1024;
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
  assert.deepEqual(await violations(), [], '前面的測試（api.test 等）都沒有超過執行額度');
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
  assert.equal(d.version, 2);
  assert.ok(d.parts >= 1);
  assert.ok(!('sessions' in d.counts) && !('client_metrics' in d.counts) && !('client_errors' in d.counts) && !('notifications' in d.counts), '暫存、遙測、通知中心不在備份裡');
  assert.ok(d.counts.members >= 5);
  assert.deepEqual(d.counts, d.manifest, '每一段接回來的筆數和目錄一致');
  // 手動備份之後馬上對照：除了稽核紀錄（備份完才寫），每張表的筆數都和現在一樣
  const bk = await call('t_chair', '/backups', { method: 'POST', body: {} });
  assert.equal(bk.status, 200, bk.text);
  assert.equal(bk.json.parts, 1, '資料少時一段做完');
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
  const ok = await cron(`at=2028-03-16T20:00:00Z&seg=${ONE_SEG}`);
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
  const next = await cron(`at=2028-03-18T19:00:00Z&seg=${ONE_SEG}`);
  assert.equal(next.backup?.label, '2028-03-19');
  assert.deepEqual(await violations(), []);
});

test('執行額度：資料多時備份分段做，好幾個整點接著做完，接回來的筆數都對', async () => {
  // 第一段只做 4 KB、之後每段 64 KB：台北 2028-03-21 03:00 起每個整點一段
  const first = await cron('at=2028-03-20T19:00:00Z&seg=4096&skip=retention');
  within(first, '第一段');
  assert.equal(first.backup, 'deferred', JSON.stringify(first.backup));
  let j = await jobs();
  assert.equal(j.backup.claim_key, '2028-03-21');
  assert.ok(j.backup.cursor && JSON.parse(j.backup.cursor).n === 1, '游標記下做到第幾段');
  assert.equal(j.backup.attempts, 0, '分段停下不算失敗');
  assert.equal((await call(null, '/dev/backup-check?label=2028-03-21')).status, 404, '還沒做完，清單上看不到');
  let r, h = 20;
  for (; h < 44; h++) {
    r = await cron(`at=${new Date(Date.UTC(2028, 2, 20, h)).toISOString()}&seg=65536&skip=retention`);
    within(r, `第 ${h - 18} 段`);
    if (r.backup && typeof r.backup === 'object') break;
  }
  assert.equal(r.backup.label, '2028-03-21', '跨日也接著做同一份');
  assert.ok(r.backup.parts >= 2, `分成 ${r.backup.parts} 段`);
  j = await jobs();
  assert.equal(j.backup.last_run, '2028-03-21');
  assert.equal(j.backup.cursor, null);
  const d = (await call(null, '/dev/backup-check?label=2028-03-21')).json;
  assert.equal(d.parts, r.backup.parts);
  assert.deepEqual(d.counts, d.manifest);
  assert.equal(d.rid, Object.values(d.counts).reduce((x, y) => x + y, 0), '每筆都帶分段用的 rowid');
  assert.ok(d.counts.members >= 5 && d.counts.events >= 1);
  assert.deepEqual(await violations(), []);
});

test('執行額度：被平台終止（沒有留下錯誤）的工作補記錯誤；第 3 次寫 cron.gave_up，管理後台顯示已停止', async () => {
  // 模擬：每日備份第 3 次佔用之後整個執行被終止（佔用 20 分鐘前、沒有錯誤訊息）
  await call(null, '/dev/jobs?stale=backup&key=2028-04-02&attempts=3');
  let h = (await call('t_chair', '/admin/health')).json;
  assert.equal(h.jobs.find((x) => x.job === 'backup').state, 'gave_up', '佔用過期、已經 3 次就算放棄');
  const r = await cron('at=2028-04-01T20:00:00Z&skip=backup,retention');
  within(r, '補記');
  const j = await jobs();
  assert.match(j.backup.last_error, /中途被終止/);
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=cron.gave`)).json.items;
  assert.ok(au.some((x) => x.target_id === 'backup' && x.detail.includes('2028-04-02') && x.detail.includes('中途被終止')), JSON.stringify(au));
  h = (await call('t_chair', '/admin/health')).json;
  assert.equal(h.jobs.find((x) => x.job === 'backup').state, 'gave_up');
  // 只補記一次
  await cron('at=2028-04-01T21:00:00Z&skip=backup,retention');
  const au2 = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=cron.gave`)).json.items;
  assert.equal(au2.filter((x) => x.detail.includes('2028-04-02')).length, 1);
  // 還沒到 3 次：補記錯誤、釋放佔用，下個整點重跑
  await call(null, '/dev/jobs?stale=backup&key=2028-04-03&attempts=1');
  const r2 = await cron(`at=2028-04-02T19:00:00Z&skip=retention&seg=${ONE_SEG}`);
  within(r2, '重跑');
  assert.equal(r2.backup?.label, '2028-04-03', JSON.stringify(r2.backup));
  assert.equal((await jobs()).backup.last_error, null);
  assert.deepEqual(await violations(), []);
});

test('執行額度：佔用之前就失敗的工作記在工作名稱那一列，下次成功就清掉', async () => {
  const f = await cron('at=2028-04-05T01:00:00Z&failpre=auditDigest&skip=backup,retention');
  assert.match(String(f.auditDigest), /^error: /);
  let h = (await call('t_chair', '/admin/health')).json;
  const a = h.jobs.find((x) => x.job === 'auditDigest');
  assert.equal(a.state, 'failed'); assert.equal(a.attempts, 1);
  const ok = await cron('at=2028-04-05T02:00:00Z&skip=backup,retention');
  assert.ok(ok.auditDigest && typeof ok.auditDigest === 'object', JSON.stringify(ok.auditDigest));
  h = (await call('t_chair', '/admin/health')).json;
  assert.equal(h.jobs.find((x) => x.job === 'auditDigest').state, 'done');
  assert.ok(!h.jobs.some((x) => x.job === 'promote_sweep'), '遞補補做的內部紀錄不顯示');
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
  assert.match(h, /^d1=\d+;kv=\d+;fetch=\d+;rpc=\d+;sub=\d+;rows=\d+$/);
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
  assert.equal(rs.length, 1, '句數跟人數無關，一次處理完（以前每輪只有 2 人，按到限流也做不完）');
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
  // 移出 30 位正取：一次處理，空出的 30 個名額由候補依序遞補
  const rj = await rounds('t_chair', `/events/${id}/review`, { action: 'reject', member_ids: bids(0, 30), revoke: true });
  assert.equal(rj.length, 1);
  assert.equal(rj[0].rejected.length, 30);
  const ev2 = (await call('t_chair', `/events/${id}`)).json;
  assert.deepEqual(ev2.signups.filter((x) => x.status === 'in').map((x) => x.member_id).sort(), bids(30, 30), '候補全部遞補');
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=event.signup`)).json.items;
  assert.equal(au.filter((x) => x.action === 'event.signup_reject' && x.target_id?.startsWith('b_')).length, 30, '每位一列稽核');
  const v = (await call('t_chair', `/audit/verify?from=${plus(-1)}&to=${plus(1)}`)).json;
  assert.equal(v.modified, 0, '一句寫入的稽核簽章都對');
  assert.deepEqual(await violations(), []);
});

test('大量輸入：關閉審核並直接錄取 80 人，一次處理完，名額 20 依報名先後', async () => {
  const id = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '額度關閉審核', capacity: 20, require_approval: true }) }), '建立活動').id;
  await call(null, `/dev/seed-bulk?event=${id}&pending=80`);
  const cur = (await call('t_chair', `/events/${id}`)).json;
  const r = await call('t_chair', `/events/${id}`, { method: 'PUT', body: { ...evBody({ title: '額度關閉審核', capacity: 20, require_approval: false }), date: cur.date, pending_action: 'admit' } });
  ok50(r, '關閉審核');
  assert.deepEqual(r.json.admitted, { in: 20, wait: 60, skipped: 0 });
  const ev = (await call('t_chair', `/events/${id}`)).json;
  assert.equal(ev.pendingCount, 0, '沒有人留在待審核');
  assert.deepEqual(ev.signups.filter((x) => x.status === 'in').map((x) => x.member_id).sort(), bids(0, 20));
  // 名額從 20 調到 70：一次遞補 50 位
  const up = await call('t_chair', `/events/${id}`, { method: 'PUT', body: { ...evBody({ title: '額度關閉審核', capacity: 70, require_approval: false }), date: cur.date } });
  ok50(up, '調高名額');
  assert.equal((await call('t_chair', `/events/${id}`)).json.signups.filter((x) => x.status === 'in').length, 70);
  assert.deepEqual(await violations(), []);
});

test('大量輸入：候補都因為庫存不夠排不進去的場次，每小時的遞補補做不會吃掉額度，也不會一直重試', async () => {
  const id = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '額度團購', capacity: 50, items: [{ id: 'a', name: 'T恤', price: 0, stock: 1 }] }) }), '建立活動').id;
  await call(null, `/dev/seed-bulk?waititems=${id}&n=40`);
  const others = 'events,backup,signupOpen,followups,weather,signupReviews,renewals,retention,auditDigest,monthSummary,review,fatigue,cams,push';
  const r1 = await cron(`skip=${others}`);
  within(r1, '第一次');
  assert.equal(r1.promoteSweep, 1, '庫存只夠 1 位');
  const r2 = await cron(`skip=${others}`);
  within(r2, '第二次');
  assert.equal(r2.promoteSweep, 0);
  assert.ok(r2._budget.jobs.promoteSweep.sub <= 8, `遞補不了的場次只花固定句數：${r2._budget.jobs.promoteSweep.sub}`);
  const r3 = await cron(`skip=${others}`);
  assert.equal(r3._budget.jobs.promoteSweep, undefined, '狀態沒變就不再試');
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

// ---- 推播佇列（PUSH_MOCK=1：不連外，記下 endpoint 與 payload id）----
const mock = async (q = '') => (await call(null, `/dev/push-mock?${q}`)).json;
async function drainAllNow() {
  let r;
  for (let i = 0; i < 100; i++) {
    r = (await call(null, '/dev/drain')).json;
    assert.ok(r._budget.root.sub <= 50, `送推播用了 ${r._budget.root.sub} 個子請求`);
    if (!r.queue) return r;
  }
  throw new Error(`佇列送不完：還有 ${r.queue}`);
}
const bEndpoints = (list) => new Set(list.filter((x) => x.endpoint.includes('/b_')).map((x) => x.endpoint));

test('推播佇列：300 人、400 台裝置的大量廣播，每次執行都在 50 以內，每台各一則、id 對得到通知列', async () => {
  await call(null, '/dev/seed-bulk?members=300&subs=400');
  await drainAllNow();
  await mock('clear=1');
  const r = await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '全體廣播測試', notify: true }) });
  ok50(r, '建立活動並通知全體');
  assert.ok(r.json.notified >= 300);
  assert.equal((await call(null, '/dev/notes?like=新活動：全體廣播測試')).json.rows, r.json.notified, '通知中心每人一列');
  await drainAllNow();
  const m = await mock('verify=1');
  assert.equal(bEndpoints(m.list).size, 400, '400 台裝置都收到');
  assert.equal(m.list.filter((x) => x.endpoint.includes('/b_')).length, 400, '每台只送一次');
  assert.equal(m.bad, 0, 'payload 的 id 都是那台裝置主人的通知列');
  assert.equal(m.queue, 0);
  assert.deepEqual(await violations(), []);
});

test('推播佇列：關掉分類的人仍寫進通知中心但不推播；活動異動（不能關）照推；410 刪掉訂閱與佇列', async () => {
  await call(null, '/dev/seed-bulk?mute=b_0001&cats=event,change');
  await mock('clear=1');
  const id = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '關閉分類測試', notify: true }) }), '建立活動').id;
  await drainAllNow();
  let m = await mock();
  const mine = ['https://fcm.googleapis.com/fcm/send/b_00001', 'https://fcm.googleapis.com/fcm/send/b_00301'];
  assert.ok(!m.list.some((x) => mine.includes(x.endpoint)), '關掉「活動與邀請」的人不推播');
  assert.equal(bEndpoints(m.list).size, 398);
  assert.equal((await call(null, '/dev/notes?like=新活動：關閉分類測試')).json.rows >= 300, true, '通知中心照寫');
  // 活動異動（locked）：關掉也照推
  await rounds('t_chair', `/events/${id}/bulk`, { action: 'signup', names: '大量測試0001' });
  await mock('clear=1');
  ok50(await call('t_chair', `/events/${id}/notice`, { method: 'POST', body: { type: 'other', message: '集合點改到停車場' } }), '活動異動');
  await drainAllNow();
  m = await mock();
  assert.deepEqual([...bEndpoints(m.list)].sort(), mine, '活動異動不能關');
  // 410：訂閱刪掉，佇列裡同一個 endpoint 的列也一起刪掉
  const subs0 = m.subs;
  await mock(`clear=1&gone=${encodeURIComponent('https://fcm.googleapis.com/fcm/send/b_00002')}`);
  ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '失效訂閱測試', notify: true }) }), '建立活動');
  await drainAllNow();
  m = await mock();
  assert.equal(m.subs, subs0 - 1, '回 410 的訂閱刪掉');
  assert.equal(m.queue, 0);
  assert.deepEqual(await violations(), []);
});

test('推播佇列：20:00 起 30 場明天的活動（每場 10 人），每次執行 50 以內，前一晚提醒每人只送一次', async () => {
  await call(null, '/dev/seed-bulk?events=30&per=10&date=2032-06-11');
  for (const h of ['12', '13', '14', '15']) {
    const r = await cron(`at=2032-06-10T${h}:00:00Z`);
    within(r, `台北 ${Number(h) + 8}:00`);
  }
  const n = (await call(null, '/dev/notes?like=明天：大量活動&ev=bev20320611')).json;
  assert.equal(n.events, 30);
  assert.equal(n.marked, 30, '30 場都標記了');
  assert.equal(n.rows, 300, '300 人各一則');
  assert.equal(n.members, 300);
  assert.equal((await cron('at=2032-06-10T15:30:00Z')).events, 0, '不再重送');
  assert.equal((await call(null, '/dev/notes?like=明天：大量活動')).json.rows, 300);
  await drainAllNow();
  assert.deepEqual(await violations(), []);
});

test('推播佇列：每月 1 號 300 人的月總結一次做完', async () => {
  await call(null, '/dev/seed-bulk?members=300&logs=2032-04');
  const r = await cron('at=2032-05-01T01:00:00Z&skip=backup,retention');
  within(r, '月總結');
  assert.ok(r.monthSummary >= 300, JSON.stringify(r.monthSummary));
  assert.ok(r._budget.jobs.monthSummary.sub <= 20, `月總結用了 ${r._budget.jobs.monthSummary.sub} 個子請求`);
  assert.equal((await cron('at=2032-05-01T02:00:00Z&skip=backup,retention')).monthSummary, 0, '只做一次');
  await drainAllNow();
  assert.deepEqual(await violations(), []);
});

test('推播佇列：時效短的先送；裝置換人時前一個人的推播不送；一般請求順便送 3 台；過期的寫 push.dropped', async () => {
  await drainAllNow();
  await mock('clear=1');
  const ev = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '佇列順序測試', notify: true }) }), '大量廣播');
  await rounds('t_chair', `/events/${ev.id}/bulk`, { action: 'signup', names: '大量測試0007' });
  // 大量廣播排在前面，活動異動（urgency high）後到：這次請求送出的那一段就先送它
  await mock('clear=1');
  ok50(await call('t_chair', `/events/${ev.id}/notice`, { method: 'POST', body: { type: 'other', message: '集合點改到停車場' } }), '活動異動');
  await new Promise((r) => setTimeout(r, 300));
  const hi = ['https://fcm.googleapis.com/fcm/send/b_00007', 'https://fcm.googleapis.com/fcm/send/b_00307'];
  assert.deepEqual([...bEndpoints((await mock()).list)].filter((x) => hi.includes(x)).sort(), hi, '活動異動沒有被廣播擠到後面');
  // 同一台裝置換人訂閱：前一個人還在佇列裡的推播一起刪掉
  const moved = 'https://fcm.googleapis.com/fcm/send/b_00009';
  const sub = await call('t_runner', '/push/subscribe', { method: 'POST', body: { endpoint: moved, keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) } } });
  assert.equal(sub.status, 200, sub.text);
  await mock('clear=1');
  // 一般請求看到佇列有待送的，順便送（免費方案 3 台）
  assert.equal((await call('t_super', '/me')).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const kicked = (await mock()).list.length;
  assert.ok(kicked >= 1 && kicked <= 3, `順便送了 ${kicked} 台`);
  await drainAllNow();
  const m = await mock('verify=1');
  assert.ok(m.list.length > 300);
  assert.ok(!m.list.some((x) => x.endpoint === moved), '換人之後不送前一個人的通知');
  assert.equal(m.bad, 0);
  // 過期：不送，刪掉並寫稽核 push.dropped
  ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '過期測試', notify: true }) }), '再廣播一次');
  await mock('expire=1');
  const d = (await call(null, '/dev/drain')).json;
  assert.equal(d.sent, 0); assert.equal(d.queue, 0);
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=push.dropped`)).json.items;
  assert.ok(au.length >= 1 && /過期/.test(au[0].detail), JSON.stringify(au[0]));
  assert.deepEqual(await violations(), []);
});

test('推播佇列：要繳費的報名成功、遞補成功與審核通過，推播不含金額（金額只放通知中心）', async () => {
  const eps = { t_coach: 'https://fcm.googleapis.com/fcm/send/b_money_coach', t_staff: 'https://fcm.googleapis.com/fcm/send/b_money_staff',
    t_runner: 'https://fcm.googleapis.com/fcm/send/b_money_runner' };
  for (const [who, endpoint] of Object.entries(eps)) {
    const s = await call(who, '/push/subscribe', { method: 'POST', body: { endpoint, keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) } } });
    assert.equal(s.status, 200, s.text);
  }
  await drainAllNow();
  await mock('clear=1');
  // 報名成功（正取）＋候補遞補成功
  const id = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '繳費推播測試', capacity: 1, notify_signup: true, fee: 300 }) }), '建立活動').id;
  assert.equal((await call('t_coach', `/events/${id}/signup`, { method: 'POST', body: {} })).json.status, 'in');
  assert.equal((await call('t_staff', `/events/${id}/signup`, { method: 'POST', body: {} })).json.status, 'wait');
  assert.equal((await call('t_coach', `/events/${id}/signup`, { method: 'DELETE' })).status, 200);
  // 審核通過（正取；幹部報名不用審核，用一般跑友）
  const rid = ok50(await call('t_chair', '/events', { method: 'POST', body: evBody({ title: '繳費審核推播測試', capacity: 5, require_approval: true, fee: 300 }) }), '建立活動').id;
  assert.equal((await call('t_runner', `/events/${rid}/signup`, { method: 'POST', body: {} })).json.status, 'pending');
  ok50(await call('t_chair', `/events/${rid}/review`, { method: 'POST', body: { action: 'approve', member_ids: ['t_runner'] } }), '審核通過');
  await drainAllNow();
  const m = await mock();
  const got = m.list.filter((x) => Object.values(eps).includes(x.endpoint));
  assert.ok(got.length >= 3, `送出 ${got.length} 則`);
  assert.deepEqual(got.filter((x) => x.money), [], '推播不含金額');
  for (const who of ['t_coach', 't_runner']) {
    const notes = (await call(who, '/notifications')).json;
    const list = [...(notes.items || []), ...(notes.pinned || [])];
    assert.ok(list.some((n) => /NT\$300/.test(n.body || '')), `${who}：通知中心照樣有金額`);
  }
  for (const [who, endpoint] of Object.entries(eps)) await call(who, '/push/unsubscribe', { method: 'POST', body: { endpoint } });
  assert.deepEqual(await violations(), []);
});

test('推播佇列：清掉測試資料', async () => {
  assert.equal((await call(null, '/dev/seed-bulk?clear=1')).json.ok, true);
  assert.equal((await mock('clear=1')).queue, 0);
});

test('執行額度紀錄：管理後台看得到排程工作、推播佇列、最常碰到上限的功能；開啟速度一句寫入、百分位在 SQL 算', async () => {
  // 開啟速度：6 個指標＋API 時間一句寫入
  const v = await call('t_runner', '/vitals', { method: 'POST', body: { page: '/', ready: 800, fcp: 600, lcp: 900, inp: 40, cls: 0.05, ttfb: 120, warm: true, api: [{ p: '/me', ms: 300, srv: 80 }, { p: '/events', ms: 500, srv: 200 }] } });
  assert.equal(v.status, 200);
  assert.ok(subOf(v) <= 6, `開啟速度寫入用了 ${subOf(v)} 個子請求`);
  await call('t_runner', '/vitals', { method: 'POST', body: { page: '/', ready: 1600, fcp: 1200, warm: false } });
  await call('t_runner', '/vitals', { method: 'POST', body: { page: '/', ready: 400, warm: true } });
  const h = (await call('t_chair', '/admin/health?days=7')).json;
  assert.ok(h.metrics.ready.n >= 3);
  assert.ok(h.metrics.ready.p50 != null && h.metrics.ready.p75 >= h.metrics.ready.p50);
  assert.ok(h.metrics.ready.warmP75 != null);
  assert.ok(h.apis.some((a) => a.page === '/events' && a.p75 >= 500 && a.srv >= 200));
  // 排程工作：備份完成；剛才連續失敗 3 次的那天之後已經恢復
  const bk = h.jobs.find((j) => j.job === 'backup');
  assert.ok(bk && ['done', 'pending', 'failed', 'gave_up'].includes(bk.state));
  assert.ok(h.jobs.some((j) => j.job === 'retention'));
  assert.equal(typeof h.pushQueue.n, 'number');
  // 因額度停下的執行有記錄（例如分段審核、03:00 延後的資料清理），名稱不含 id
  assert.ok(h.budget.length >= 1, JSON.stringify(h.budget));
  assert.ok(h.budget.some((x) => x.stopped > 0));
  assert.ok(h.budget.every((x) => !/b_\d|\/[a-z0-9]{16}(\/|$)/.test(x.name)), JSON.stringify(h.budget.map((x) => x.name)));
  assert.equal((await call('t_runner', '/admin/health')).status, 403);
  assert.deepEqual(await violations(), []);
});

test('staging 驗證：沒有 SELFTEST=1 的環境沒有 /api/admin/selftest', async () => {
  assert.equal((await call('t_chair', '/admin/selftest', { method: 'POST', body: {} })).status, 404);
});

// 前面的測試可能留下做到一半的備份：先做完，下面的測試才是從新的一份開始
async function finishPendingBackup() {
  for (let h = 0; h < 24 && (await jobs()).backup?.cursor; h++) await cron(`at=${new Date(Date.UTC(2033, 0, 1, h)).toISOString()}&seg=${ONE_SEG}&skip=retention`);
  assert.equal((await jobs()).backup?.cursor ?? null, null, '沒有做到一半的備份');
}

test('每日備份：只讀到開始時的最後一筆，備份進行中一直新增的資料（例如大量存路線）不會讓它永遠做不完', async () => {
  await finishPendingBackup();
  const before = (await call(null, '/dev/backup-check')).json.now.routes;
  const first = await cron('at=2033-02-10T19:00:00Z&seg=4096&skip=retention');
  within(first, '第一段');
  assert.equal(first.backup, 'deferred', JSON.stringify(first.backup));
  // 備份進行中有人存了 3 條路線：留給下一份，不追著讀
  for (let i = 0; i < 3; i++) assert.equal((await call('t_lead', '/routes', { method: 'POST', body: { name: `備份中新增 ${i}`, points: [[25.07, 121.53], [25.08, 121.53 + i / 1000]], shared: false } })).status, 200);
  let r;
  for (let h = 20; h < 44; h++) {
    r = await cron(`at=${new Date(Date.UTC(2033, 1, 10, h)).toISOString()}&seg=65536&skip=retention`);
    within(r, `第 ${h - 18} 段`);
    if (r.backup && typeof r.backup === 'object') break;
  }
  assert.equal(r.backup?.label, '2033-02-11', JSON.stringify(r.backup));
  const d = (await call(null, '/dev/backup-check?label=2033-02-11')).json;
  assert.deepEqual(d.counts, d.manifest);
  assert.equal(d.counts.routes, before, '只有開始時就有的路線');
  assert.equal(d.now.routes, before + 3);
  assert.deepEqual(await violations(), []);
});

test('每日備份：開始超過 24 小時還沒做完，通知理事長與行政人員一次、稽核記一筆', async () => {
  const notes = async (who) => { const n = (await call(who, '/notifications')).json; return [...(n.pinned || []), ...n.items].filter((x) => x.title === '每日備份還沒做完'); };
  await finishPendingBackup();
  const n0 = (await notes('t_chair')).length;
  assert.equal((await cron('at=2033-03-10T19:00:00Z&seg=4096&skip=retention')).backup, 'deferred');
  assert.equal((await cron('at=2033-03-11T18:00:00Z&seg=4096&skip=retention')).backup, 'deferred', '23 小時：還不算卡住');
  assert.equal((await notes('t_chair')).length, n0);
  const late = await cron('at=2033-03-11T20:00:00Z&seg=4096&skip=retention');
  within(late, '卡住通知');
  assert.equal(late.backup, 'deferred');
  assert.equal((await notes('t_chair')).length, n0 + 1, '理事長收到通知');
  assert.ok((await notes('t_staff')).length >= 1, '行政人員收到通知');
  assert.equal((await notes('t_runner')).length, 0);
  await cron('at=2033-03-11T21:00:00Z&seg=4096&skip=retention');
  assert.equal((await notes('t_chair')).length, n0 + 1, '同一份只通知一次');
  const au = (await call('t_chair', `/audit?from=${plus(-1)}&to=${plus(1)}&action=backup.stalled`)).json.items;
  assert.equal(au.filter((x) => x.target_id === '2033-03-11').length, 1, JSON.stringify(au));
  // 做完：清單上看得到
  const done = await cron(`at=2033-03-11T22:00:00Z&seg=${ONE_SEG}&skip=retention`);
  assert.equal(done.backup?.label, '2033-03-11', JSON.stringify(done.backup));
  assert.deepEqual(await violations(), []);
});
