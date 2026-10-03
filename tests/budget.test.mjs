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
