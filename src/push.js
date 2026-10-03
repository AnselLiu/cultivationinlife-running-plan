// 耕跑團 — Web Push（RFC 8291 aes128gcm 加密＋RFC 8292 VAPID），只用 WebCrypto，不需要外部套件
// 金鑰放在 secrets：VAPID_PUBLIC_KEY（未壓縮公鑰 base64url）、VAPID_PRIVATE_JWK（私鑰 JWK JSON）
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

async function vapidAuth(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function encrypt(sub, payload) {
  const uaPub = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // record size 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

// 對外連線的額度由 push() 先一次佔用（env.budget.take('fetch', n)），這裡不再重複計算
async function sendOne(env, sub, msg, { ttl = 86400, urgency = 'normal' } = {}) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { authorization: await vapidAuth(env, sub.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(ttl), urgency },
    body: await encrypt(sub, JSON.stringify(msg)),
  });
  if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
  return res.status;
}


// ---- 本專案的推播：訂閱管理與送出（資料表 push_subs：endpoint、member_id、p256dh、auth）----
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const MAX_DEVICES = 10;
export const validEndpoint = (s) => { try { const u = new URL(s); return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname)); } catch { return false; } };

export async function subscribe(env, memberId, { endpoint, p256dh, auth }) {
  const mine = (await env.DB.prepare('SELECT endpoint FROM push_subs WHERE member_id = ? AND endpoint != ? ORDER BY created_at').bind(memberId, endpoint).all()).results;
  for (const x of mine.slice(0, Math.max(0, mine.length - (MAX_DEVICES - 1)))) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(x.endpoint).run();
  await env.DB.prepare(`INSERT INTO push_subs (endpoint, member_id, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth`).bind(endpoint, memberId, p256dh, auth).run();
}

export const unsubscribe = (env, memberId, endpoint) =>
  env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND member_id = ?').bind(endpoint, memberId).run();

// 送給指定成員；payload 的 id 是收件人自己那一列通知的 id（隨機值，不是會員 id）
// 裝置數超過上限就截掉，回傳 dropped 讓呼叫端寫稽核
// 上限以一次執行為單位：這次執行剩下的子請求額度（env.budget，見 src/budget.js），同一次執行裡的多次推播共用
export async function push(env, memberIds, msg, { rowIds, ttl = 86400, urgency = 'normal' } = {}) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return { sent: 0, dropped: 0 };
  const ids = [...new Set(memberIds || [])].filter(Boolean);
  if (!ids.length) return { sent: 0, dropped: 0 };
  let subs = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90), q = part.map(() => '?').join(',');
    subs.push(...(await env.DB.prepare(`SELECT endpoint, p256dh, auth, member_id FROM push_subs WHERE member_id IN (${q})`).bind(...part).all()).results);
  }
  const max = Math.max(50, Number(env.PUSH_MAX_DEVICES) || 900);
  // 讀剩餘額度和佔用額度在同一段同步程式裡，同時進行的推播不會重複使用；留 2 個給 404／410 的清理與稽核
  const cap = Math.min(max, env.budget ? Math.max(0, env.budget.left() - 2) : max), devices = subs.length;
  env.budget?.take('fetch', Math.min(devices, cap));
  let dropped = 0;
  if (devices > cap) {
    dropped = devices - cap; subs = subs.slice(0, cap);
    console.warn('push truncated', { cat: msg.cat, devices, cap });
  }
  let sent = 0, failed = 0;
  for (let i = 0; i < subs.length; i += 10) {
    const res = await Promise.allSettled(subs.slice(i, i + 10).map((s) => sendOne(env, s, { ...msg, id: rowIds?.get(s.member_id) || undefined }, { ttl, urgency })));
    sent += res.filter((r) => r.status === 'fulfilled' && r.value < 300).length;
    failed += res.filter((r) => r.status === 'rejected').length;
  }
  return { sent, dropped, failed };
}
