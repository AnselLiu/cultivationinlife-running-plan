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
