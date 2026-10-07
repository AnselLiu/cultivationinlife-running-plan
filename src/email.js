// Email → 查詢碼：伺服器（Google 登入、查推薦人）與單元測試共用；Email 本身一律不存、不記錄
//   純模組（不 import cloudflare:）：tests/email.test.mjs 直接在 Node 跑，固定測試向量見 docs/SECURITY.md
const GMAIL = new Set(['gmail.com', 'googlemail.com']);
// 正規化：看不懂就回 null（不丟錯）；Gmail 去掉點與 +標籤，其他網域只轉小寫、去空白
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFKC')                      // 全形 ＡＢＣ＠ＧＭＡＩＬ．ＣＯＭ（中文輸入法）
    .replace(/[。｡]/g, '.')                               // 中文句號
    .replace(/[\s​-‍⁠﻿]/g, '')       // 空白與零寬字元（從 LINE 複製過來常有）
    .toLowerCase();
  if (s.length > 254 || /[^\x21-\x7e]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 1 || s.indexOf('@') !== at) return null;
  let local = s.slice(0, at), domain = s.slice(at + 1).replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || domain.length > 253 || local.length > 64) return null;
  if (GMAIL.has(domain)) { local = local.split('+')[0].replace(/\./g, ''); domain = 'gmail.com'; }
  return local ? `${local}@${domain}` : null;
}
// HKDF（SHA-256、salt＝32 個 0、info＝'email-lookup-v1'）從 AUDIT_KEY 導出 256 位元，匯入成不可匯出的 HMAC-SHA256 金鑰
export async function deriveEmailKey(secret, subtle = globalThis.crypto.subtle) {
  const enc = new TextEncoder();
  const base = await subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('email-lookup-v1') }, base, 256);
  return subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
// 查詢碼：64 位小寫十六進位（normalized 是 normalizeEmail 的結果）
export async function emailDigest(key, normalized, subtle = globalThis.crypto.subtle) {
  const sig = await subtle.sign('HMAC', key, new TextEncoder().encode(normalized));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
