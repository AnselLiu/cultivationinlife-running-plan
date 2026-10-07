// Email 查詢碼（推薦人）：正規化、HKDF 子金鑰與 HMAC 的固定向量，跟 node:crypto 的獨立實作比對；名字遮罩、只填名字的檢查、登入時要不要改查詢碼
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync, createHmac, randomBytes } from 'node:crypto';
import { normalizeEmail, deriveEmailKey, emailDigest } from '../src/email.js';
import { maskName, validRefName, nextEmailHash } from '../src/referral.js';

const SECRET = 'test-audit-key';   // 跟 tests/run.mjs、端到端測試伺服器的 AUDIT_KEY 一樣
const ref = (secret, s, info = 'email-lookup-v1') => createHmac('sha256', Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), info, 32))).update(s).digest('hex');

test('normalizeEmail：Gmail 去點與 +標籤、全形、中文句號、空白與零寬字元；其他網域只轉小寫', () => {
  const ok = [
    ['Ab.C+x@GMAIL.com', 'abc@gmail.com'],
    ['ａｂｃ＠ｇｍａｉｌ．ｃｏｍ', 'abc@gmail.com'],
    ['abc@googlemail.com', 'abc@gmail.com'],
    [' abc@gmail.com ', 'abc@gmail.com'],
    ['a.b.c@gmail。com', 'abc@gmail.com'],
    ['abc​@gmail.com', 'abc@gmail.com'],
    ['﻿abc@gmail.com⁠', 'abc@gmail.com'],
    ['abc@gmail.com.', 'abc@gmail.com'],
    ['Abc@Example.COM', 'abc@example.com'],
    ['a.b+c@example.com', 'a.b+c@example.com'],
  ];
  for (const [i, o] of ok) assert.equal(normalizeEmail(i), o, JSON.stringify(i));
  for (const bad of ['+tag@gmail.com', 'a@b', 'a@@gmail.com', '王@gmail.com', '', null, undefined, 42, `${'a'.repeat(245)}@gmail.com` /* 255 字 */, `${'a'.repeat(65)}@example.com`, '@gmail.com', 'abc@']) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeEmail(`${'a'.repeat(245)}@b.com`), null, '超過 254 字');
});

test('查詢碼：HKDF 子金鑰與 HMAC 的固定向量', async () => {
  const subtle = globalThis.crypto.subtle;
  const sub = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(32), 'email-lookup-v1', 32)).toString('hex');
  assert.equal(sub, 'dd9368c74b955df2d5418774620036d0339fafe2f31431b2f361dd3642f82a58');
  assert.equal(Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), 'email-lookup-v1', 32)).toString('hex'), sub, '空 salt 與 32 個 0 的 salt 結果一樣');
  const key = await deriveEmailKey(SECRET);
  assert.equal(key.extractable, false);
  assert.equal(await emailDigest(key, 'abc@gmail.com'), '21150afda65ecbd6943774a9eaa9caebe8ff5db848e8eab6dc5b40ed89136963');
  assert.equal(await emailDigest(key, 'abc@example.com'), '22cc7fc500d5b77ac2a0585e3d359be4b61e642919490a4d7fe02c735d0867f5');
  assert.match(await emailDigest(key, normalizeEmail('Ab.C+x@GMAIL.com'), subtle), /^[0-9a-f]{64}$/);
});

test('查詢碼：50 個隨機地址跟 node:crypto 的獨立實作一樣；換金鑰或換 info 就不一樣', async () => {
  const key = await deriveEmailKey(SECRET), other = await deriveEmailKey('another-key');
  for (let i = 0; i < 50; i++) {
    const s = normalizeEmail(`${randomBytes(6).toString('hex')}.${i}+x@${i % 2 ? 'gmail.com' : 'example.org'}`);
    assert.ok(s);
    const d = await emailDigest(key, s);
    assert.equal(d, ref(SECRET, s));
    assert.notEqual(d, await emailDigest(other, s));
    assert.notEqual(d, ref(SECRET, s, 'email-lookup-v2'));
  }
});

test('maskName：中間最多 3 個○', () => {
  assert.equal(maskName('王大明'), '王○明');
  assert.equal(maskName('王明'), '王○');
  assert.equal(maskName('歐陽小明'), '歐○○明');
  assert.equal(maskName('一二三四五六七'), '一○○○七');
  assert.equal(maskName('A'), 'A');
  assert.equal(maskName(''), '');
  assert.equal(maskName(null), '');
});

test('validRefName：1–20 字，不收 Email、電話、網址', () => {
  for (const bad of ['', '   ', 'x'.repeat(21), 'a@b.com', '0912345678', 'https://x', 'www.example.com', '​', null]) assert.equal(validRefName(bad), null, JSON.stringify(bad));
  assert.equal(validRefName(' 王 大明 '), '王 大明');
  assert.equal(validRefName('王​大明'), '王大明');
  assert.equal(validRefName('ＡＢＣ'), 'ABC');
  assert.equal(validRefName('x'.repeat(20)), 'x'.repeat(20));
  assert.equal(validRefName('跑友 123'), '跑友 123', '3 位數字可以');
});

test('nextEmailHash：功能關閉、沒有金鑰、關掉找我、還沒同意新版政策、沒給 Email、驗證過或沒驗證', () => {
  const base = { refOn: true, keyOk: true, findable: 1, consentOk: true, hasClaim: true, hash: 'h' };
  assert.deepEqual(nextEmailHash({ ...base, refOn: false }), { set: false });
  assert.deepEqual(nextEmailHash({ ...base, keyOk: false }), { set: false });
  assert.deepEqual(nextEmailHash({ ...base, refOn: false, findable: 0 }), { set: false }, '功能關閉時連關掉的也不動');
  assert.deepEqual(nextEmailHash({ ...base, findable: 0 }), { set: true, value: null });
  assert.deepEqual(nextEmailHash({ ...base, findable: 0, consentOk: false, hasClaim: false }), { set: true, value: null }, '關掉找我優先');
  assert.deepEqual(nextEmailHash({ ...base, consentOk: false }), { set: false });
  assert.deepEqual(nextEmailHash({ ...base, hasClaim: false }), { set: false });
  assert.deepEqual(nextEmailHash(base), { set: true, value: 'h' });
  assert.deepEqual(nextEmailHash({ ...base, hash: null }), { set: true, value: null }, '沒驗證的 Email：清掉');
  assert.deepEqual(nextEmailHash({ ...base, hash: undefined }), { set: true, value: null });
});
