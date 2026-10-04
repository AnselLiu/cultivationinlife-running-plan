// 推播：VAPID JWT 依推播服務網域快取（12 小時，剩不到 1 小時就重簽）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vapidAuth } from '../src/push.js';

test('VAPID JWT：同一個推播服務重用，換網域或快到期才重簽', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const env = { VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url'),
    VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)), VAPID_SUBJECT: 'mailto:test@example.com' };
  const t0 = Date.now();
  const a = await vapidAuth(env, 'https://fcm.googleapis.com/fcm/send/aaa', t0);
  assert.equal(await vapidAuth(env, 'https://fcm.googleapis.com/fcm/send/bbb', t0 + 3600e3), a, '同一個網域重用');
  const other = await vapidAuth(env, 'https://web.push.apple.com/xyz', t0);
  assert.notEqual(other, a);
  const jwt = a.match(/^vapid t=([^,]+), k=/)[1].split('.');
  const body = JSON.parse(Buffer.from(jwt[1], 'base64url').toString());
  assert.equal(body.aud, 'https://fcm.googleapis.com');
  assert.ok(body.exp - t0 / 1000 <= 12 * 3600 + 1 && body.exp - t0 / 1000 > 11 * 3600, '有效 12 小時（RFC 8292 最長 24 小時）');
  // 簽章驗得過
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, Buffer.from(jwt[2], 'base64url'), new TextEncoder().encode(`${jwt[0]}.${jwt[1]}`));
  assert.ok(ok);
  // 剩不到 1 小時：重簽
  const later = await vapidAuth(env, 'https://fcm.googleapis.com/fcm/send/aaa', t0 + 11.5 * 3600e3);
  assert.notEqual(later, a);
});

test('推播佇列順序：帳號安全最先，不會排在 TTL 較短的大量活動異動後面', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const { PUSH_ORDER } = await import('../src/push.js');
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });   // 只建佇列這張表，不建訂閱表
  db.exec(readFileSync(new URL('../migrations/0043_push_queue.sql', import.meta.url), 'utf8'));
  const add = db.prepare("INSERT INTO push_queue (endpoint, payload, urgency, expires_at) VALUES ('e', ?, ?, datetime('now', ?))");
  // 安全提醒先排進來（TTL 24 小時），之後 1 小時內排進來 50 則活動異動（TTL 12 小時）與一般通知
  add.run(JSON.stringify({ cat: 'security', title: '新裝置登入' }), 'high', '+86400 seconds');
  for (let i = 0; i < 50; i++) add.run(JSON.stringify({ cat: 'change', title: `活動異動 ${i}` }), 'high', `+${43200 + i * 60} seconds`);
  add.run(JSON.stringify({ cat: 'event', title: '新活動' }), 'normal', '+3600 seconds');
  const order = db.prepare(`SELECT json_extract(payload, '$.cat') AS cat FROM push_queue ORDER BY ${PUSH_ORDER} LIMIT 10`).all().map((r) => r.cat);
  assert.equal(order[0], 'security', '一次只送 10 則時，安全提醒在第一批');
  assert.ok(order.slice(1).every((c) => c === 'change'), 'urgency high 的活動異動接著送，排在一般通知前面');
});

// ---- 營運三項的純函式（src/ops.js）----
test('推播摘要 holdable：帳號安全、待辦、系統狀態、force、now、urgency high 沒有 latest、TTL 不到 6 小時一律即時；公告可以延後', async () => {
  const { holdable } = await import('../src/ops.js');
  for (const c of ['security', 'todo', 'ops']) assert.equal(holdable(c, {}).hold, 0, c);
  assert.equal(holdable('announce', {}, { force: true }).hold, 0, 'force');
  assert.equal(holdable('event', { now: true }).hold, 0, '有名額的開放報名');
  assert.equal(holdable('signup', { urgency: 'high', ttl: 3600 }).hold, 0, '集合前提醒');
  assert.equal(holdable('event', { ttl: 5 * 3600 }).hold, 0, 'TTL 5 小時');
  assert.deepEqual(holdable('announce', {}), { hold: 1, latest: null });
  assert.equal(holdable('report', {}).hold, 1);
  // 活動異動（timed）：沒有 latest（當天、明天、取消）即時；帶了後天以後的 latest 才可以延後
  assert.equal(holdable('change', {}).hold, 0);
  assert.equal(holdable('change', { latest: null }).hold, 0);
  assert.deepEqual(holdable('change', { latest: '2030-01-05 04:00' }), { hold: 1, latest: '2030-01-05 04:00' });
  assert.equal(holdable('signup', { latest: 'not a time' }).hold, 0, '格式不對當成沒有');
});

test('推播摘要 eventLatest：集合前 3 小時；取消、今天、明天的活動一律即時', async () => {
  const { eventLatest } = await import('../src/ops.js');
  const now = new Date('2030-01-01T02:00:00Z');   // 台北 2030-01-01 10:00
  assert.equal(eventLatest({ date: '2030-01-05', gather_time: '07:00' }, now), '2030-01-05 04:00');
  assert.equal(eventLatest({ date: '2030-01-05', gather_time: '02:00' }, now), '2030-01-04 23:00', '跨日');
  assert.equal(eventLatest({ date: '2030-01-05', gather_time: '' }, now), '2030-01-05 03:00', '沒有集合時間當 06:00');
  assert.equal(eventLatest({ date: '2030-01-05', gather_time: '07:00' }, now, { cancel: true }), null);
  assert.equal(eventLatest({ date: '2030-01-05', gather_time: '07:00', status: 'cancelled' }, now), null);
  assert.equal(eventLatest({ date: '2030-01-02', gather_time: '19:00' }, now), null, '明天');
  assert.equal(eventLatest({ date: '2030-01-01', gather_time: '19:00' }, now), null, '今天');
  assert.equal(eventLatest({ date: '2030-01-03', gather_time: '19:00' }, now), '2030-01-03 16:00', '後天');
});

test('推播摘要 digestText：只有分類名稱與則數，最多 4 類，其餘併成「其他 N」', async () => {
  const { digestText } = await import('../src/ops.js');
  const d = digestText({ change: 2, signup: 3, announce: 1 });
  assert.equal(d.title, '今天的通知摘要');
  assert.equal(d.body, '活動異動 2、我的報名 3、公告 1。點開看全部');
  const many = digestText({ announce: 1, training: 2, event: 3, signup: 4, change: 5, membership: 6, weird: 7 });
  assert.equal(many.body, '活動異動 5、我的報名 4、活動與邀請 3、訓練與課表 2、其他 14。點開看全部');
  assert.equal(many.n, 28);
  // 傳進來的任何文字都不會出現（只看鍵與數字）
  assert.ok(!/王小明|NT\$/.test(digestText({ '王小明 NT$500': 1, announce: 1 }).body));
});

test('系統告警 opsConditions：六個條件的邊界', async () => {
  const { opsConditions, OPS } = await import('../src/ops.js');
  const quota = { req: 100000, d1Read: 5000000, d1Write: 100000, kvRead: 100000, kvWrite: 1000, kvList: 1000, kvDel: 1000 };
  const now = Date.parse('2030-01-01T12:00:00Z'), ago = (h) => new Date(now - h * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  const conds = (p, cfg = {}) => opsConditions(p, { quota, nowMs: now, backupOn: true, ...cfg }).map((c) => c.cond);
  assert.deepEqual(conds({}), []);
  // 額度：剛好 80% 發，79.99% 不發；付費方案（quota null）不檢查
  assert.deepEqual(conds({ daily: { d1_read: 4000000 } }), ['quota']);
  assert.deepEqual(conds({ daily: { d1_read: 3999999 } }), []);
  assert.deepEqual(conds({ daily: { kv_write: 900 } }, { quota: null }), []);
  const q = opsConditions({ daily: { d1_read: 4150000, kv_write: 810 } }, { quota, nowMs: now })[0];
  assert.match(q.text, /^今天的 D1 讀取 用量已到每日額度的 83%/);
  assert.equal(q.detail, 'D1 讀取 83%', '後台看得到的細節用中文名稱，不是內部鍵');
  assert.match(opsConditions({ bk: [ago(27), null] }, { nowMs: now, backupOn: true })[0].detail, /^上次完成：2029-12-31 17:00（27 小時前）$/, '台北時間');
  // 備份：26 小時；從沒完成過看第一次佔用；沒設定備份不檢查
  assert.deepEqual(conds({ bk: [ago(27), null] }), ['backup']);
  assert.deepEqual(conds({ bk: [ago(25), null] }), []);
  assert.deepEqual(conds({ bk: [null, new Date(now - 30 * 3600e3).toISOString()] }), ['backup']);
  assert.deepEqual(conds({ bk: [ago(27), null] }, { backupOn: false }), []);
  // 停下：同一個工作 2 次；本來就分段做的（每日備份、推播）不算
  assert.deepEqual(conds({ stops: ['hourly:events'] }), ['stops']);
  assert.deepEqual(conds({ stops: ['backup:sub', 'hourly:backup', 'push', 'drain#1'] }), []);
  // 前端錯誤：E＝19 不發；E＝20、開啟 100（20%）≥ 前 7 天 2% 的 3 倍；基準 0 時用 2% 下限
  assert.deepEqual(conds({ err: 19, opens: 20 }), []);
  assert.deepEqual(conds({ err: 20, opens: 100, base: [14, 700] }), ['errors']);
  assert.deepEqual(conds({ err: 20, opens: 100, base: [70, 700] }), [], '前 7 天 10%，3 倍是 30%');
  assert.deepEqual(conds({ err: 20, opens: 1000, base: [0, 0] }), ['errors'], '2% 下限');
  assert.deepEqual(conds({ err: 20, opens: 1001, base: [0, 0] }), [], '不到 2%');
  // 推播：失敗＋丟棄 ≥ 20 而且 ≥ 25%；或佇列最早一則超過 6 小時
  assert.deepEqual(conds({ daily: { push_err: 30, push_sent: 50 } }), ['push']);
  assert.deepEqual(conds({ daily: { push_err: 19, push_sent: 0 } }), []);
  assert.deepEqual(conds({ daily: { push_err: 30, push_sent: 1000 } }), []);
  assert.deepEqual(conds({ pq: ago(7) }), ['push']);
  assert.deepEqual(conds({ pq: ago(5) }), []);
  // 排程放棄
  assert.deepEqual(conds({ gave: ['backup'] }), ['cron']);
  // 文字不含錯誤原文與個資：一律接「請到管理後台「總覽」查看」
  for (const c of opsConditions({ gave: ['x'], pq: ago(7), err: 99, opens: 1, bk: [ago(30)], stops: ['a'], daily: { d1_read: 5e6 } }, { quota, nowMs: now, backupOn: true })) {
    assert.match(c.text, /請到管理後台「總覽」查看$/);
  }
  assert.equal(OPS.quotaPct, 0.8);
});

test('幹部週報 reportPush／reportFor：鎖定畫面只有數字；行政人員看不到訓練區塊', async () => {
  const { reportPush, reportFor } = await import('../src/ops.js');
  const d = { scope: 'assoc', signups: { new: 42 }, attendance: { pct: 78 }, newcomers: { runners: 3 }, training: { pct: 50 }, health: { backup: { days: 7 }, alerts: {} } };
  assert.equal(reportPush(d), '報名 42、出席率 78%、新成員 3。系統：備份正常、沒有告警');
  assert.equal(reportPush({ scope: 'team:youth', signups: { new: 18 }, attendance: { pct: 81 }, newcomers: { members: 1 } }), '報名 18、出席率 81%、新團員 1');
  assert.equal(reportPush({ ...d, health: { backup: { days: 5 }, alerts: { quota: 2 } } }), '報名 42、出席率 78%、新成員 3。系統：備份 5／7 天、告警 2 次');
  assert.ok(!('training' in reportFor(d, { training: false, health: true })));
  assert.ok(!('health' in reportFor(d, { training: true, health: false })));
  assert.deepEqual(reportFor(d, { training: true, health: true }), d);
});

test('每日用量估計：寫入前先拿走累加值，同時結束的請求不重複寫、寫入期間的計數不會被刪；寫失敗加回', async () => {
  const { addUsage, usageDue, takeUsage, restoreUsage, usage } = await import('../src/budget.js');
  usage.days.clear(); usage.last = 0;
  const b = { kind: 'request', d1: 1, rows: 1, wrote: 0, kvGet: 0, kvPut: 0, kvList: 0, kvDel: 0, pushSent: 0, pushErr: 0, pushGone: 0, pushDrop: 0 };
  const day = '2036-01-01', writes = [];
  // 三個請求：1、2 同時結束，3 在 1 寫入期間累加
  addUsage(b, day);
  const d1 = usageDue(Date.parse('2036-01-01T01:00:00Z'));
  const t1 = takeUsage(d1, Date.parse('2036-01-01T01:00:00Z'));
  addUsage(b, day);
  assert.equal(usageDue(Date.parse('2036-01-01T01:00:01Z')), null, '1 剛拿走：2 不會馬上再寫');
  addUsage(b, day);
  writes.push(t1.v.req);
  const t2 = takeUsage(usageDue(Date.parse('2036-01-01T01:20:00Z')), Date.parse('2036-01-01T01:20:00Z'));
  writes.push(t2.v.req);
  assert.deepEqual(writes, [1, 2], '每個請求剛好算一次');
  // 寫失敗：加回（期間新增的合併），last 回到寫之前
  addUsage(b, day);
  const t3 = takeUsage(day, Date.parse('2036-01-01T02:00:00Z'));
  addUsage(b, day);
  restoreUsage(day, t3);
  assert.equal(usage.days.get(day).req, 2);
  assert.equal(usage.last, Date.parse('2036-01-01T01:20:00Z'));
  usage.days.clear(); usage.last = 0;
});
