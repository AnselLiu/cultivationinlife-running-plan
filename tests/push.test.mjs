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
