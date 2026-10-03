// 耕跑團 — Web Push（RFC 8291 aes128gcm 加密＋RFC 8292 VAPID），只用 WebCrypto，不需要外部套件
// 金鑰放在 secrets：VAPID_PUBLIC_KEY（未壓縮公鑰 base64url）、VAPID_PRIVATE_JWK（私鑰 JWK JSON）
// 免費方案一次執行只有 50 個子請求：通知寫進通知中心時同時排進推播佇列（push_queue，每台裝置一列），
//   之後由 drainPush() 分批送出（每段最多 plan.pushPerHop 台、同時最多 plan.pushConc 個連線）
import { planOf, xfetch } from './budget.js';

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// VAPID：私鑰匯入一次（key 是 JWK 字串的雜湊，只存不可匯出的 CryptoKey）；JWT 依推播服務的網域快取 12 小時，剩不到 1 小時就重簽
//   （RFC 8292 允許最長 24 小時）；ECDH 金鑰仍然每則訊息重新產生（RFC 8291 的要求）
let vapidKey = { h: '', p: null };
const jwtCache = new Map();   // 推播服務的 origin → { header, exp, k }
export async function vapidAuth(env, endpoint, now = Date.now()) {
  const aud = new URL(endpoint).origin, hit = jwtCache.get(aud);
  if (hit && hit.k === env.VAPID_PUBLIC_KEY && hit.exp - now / 1000 > 3600) return hit.header;
  const h = await hex(env.VAPID_PRIVATE_JWK);
  if (vapidKey.h !== h) vapidKey = { h, p: crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  let key;
  try { key = await vapidKey.p; } catch (e) { vapidKey = { h: '', p: null }; throw e; }
  const exp = Math.floor(now / 1000) + 12 * 3600;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  const header = `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
  jwtCache.set(aud, { header, exp, k: env.VAPID_PUBLIC_KEY });
  if (jwtCache.size > 20) jwtCache.delete(jwtCache.keys().next().value);
  return header;
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

// 測試用（PUSH_MOCK=1 而且 DEV_LOGIN=1）：不連外，固定回 201（gone 裡的 endpoint 回 410），記下 endpoint 與 payload 的 id；照樣算 1 個子請求
export const pushMock = { list: [], gone: new Set() };
const mocked = (env) => env.PUSH_MOCK === '1' && env.DEV_LOGIN === '1';

// 送一台裝置：回傳 HTTP 狀態碼（連線失敗會丟錯）；回應內容不讀，直接取消
async function sendOne(env, sub, payload, { ttl = 86400, urgency = 'normal' } = {}) {
  if (mocked(env)) {
    env.budget?.take('fetch');
    if (pushMock.gone.has(sub.endpoint)) return 410;
    if (pushMock.list.length < 5000) pushMock.list.push({ endpoint: sub.endpoint, id: JSON.parse(payload).id || null });
    return 201;
  }
  const res = await xfetch(env, sub.endpoint, {
    method: 'POST',
    headers: { authorization: await vapidAuth(env, sub.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(Math.max(0, Math.round(ttl))), urgency },
    body: await encrypt(sub, payload),
  });
  try { await res.body?.cancel(); } catch {}
  return res.status;
}
// 依序跑，同時最多 conc 個
async function pool(items, conc, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, v: await fn(items[k]) }; } catch (e) { out[k] = { ok: false, e }; } }
  }));
  return out;
}

export const vapidOn = (env) => !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY);
const PERMANENT = (st) => st === 404 || st === 410 || (st >= 400 && st < 500 && st !== 408 && st !== 429);

// 送出一段：領取一批（1 句）→ 讀訂閱金鑰（1 句）→ 送出（每台 1 個 fetch）→ 收尾（一個 batch 2–3 句）
//   max：這段最多送幾台；實際取 min(max, plan.pushPerHop, 剩下的額度 − 6)
//   送成功與永久失敗（404、410、其他 4xx）的刪掉，404／410 連訂閱一起刪（佇列跟著 cascade）；5xx、429、網路錯誤留著，租約（120 秒）到期後重送
//   過期或試滿 3 次的刪掉，筆數放在 dropped，由呼叫端寫稽核 push.dropped
// 推播佇列裡過期、或試滿 3 次而且租約已過的列：刪掉，回傳筆數（VAPID 沒設定時也要清，不然通知內容會一直留在 D1）
export const PUSH_EXPIRED = `DELETE FROM push_queue WHERE expires_at <= datetime('now') OR (attempts >= 3 AND (lease_until IS NULL OR lease_until < datetime('now'))) RETURNING id`;
export async function drainPush(env, { max = Infinity } = {}) {
  const out = { leased: 0, sent: 0, failed: 0, dropped: 0 };
  if (!vapidOn(env)) {
    // 推播關閉（VAPID 拿掉）：不送，但過期的照樣清掉，通知內容不會一直留在 D1（資料清理也會清）
    if (!env.budget || env.budget.room(1)) out.dropped = (await env.DB.prepare(PUSH_EXPIRED).all()).results.length;
    return out;
  }
  const plan = planOf(env), n = Math.min(max, plan.pushPerHop, (env.budget ? env.budget.left() : Infinity) - 6);
  if (!(n >= 1)) return out;
  // 有時效的先送：urgency high（集合前提醒、帳號安全）優先，再依過期時間、排入順序；大量廣播排在前面時，時效短的不會被擠到過期
  //   收件人那一列通知的主人必須還是這台裝置的主人（裝置換人登入、重新訂閱之後，前一個人還沒送的推播不會送到新主人的裝置）
  const rows = (await env.DB.prepare(`UPDATE push_queue SET lease_until = datetime('now', '+120 seconds'), attempts = attempts + 1
    WHERE id IN (SELECT id FROM push_queue WHERE (lease_until IS NULL OR lease_until < datetime('now'))
                 AND expires_at > datetime('now') AND attempts < 3 ORDER BY urgency = 'high' DESC, expires_at, id LIMIT ?1)
    RETURNING id, endpoint, notif_id, payload, urgency, attempts,
      CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER) AS ttl`).bind(Math.floor(n)).all()).results;
  out.leased = rows.length;
  const done = [], gone = [];
  if (rows.length) {
    const keys = new Map((await env.DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth, s.member_id, json_extract(j.value, '$[1]') AS nid,
        (SELECT n.member_id FROM notifications n WHERE n.id = json_extract(j.value, '$[1]')) AS owner
      FROM json_each(?1) j JOIN push_subs s ON s.endpoint = json_extract(j.value, '$[0]')`)
      .bind(JSON.stringify(rows.map((r) => [r.endpoint, r.notif_id]))).all()).results.map((s) => [`${s.endpoint} ${s.nid}`, s]));
    const res = await pool(rows, plan.pushConc, async (r) => {
      const sub = keys.get(`${r.endpoint} ${r.notif_id}`);
      if (!sub) return 410;   // 訂閱已經不在了
      if (r.notif_id && sub.owner !== sub.member_id) return 403;   // 裝置已經換人（或通知已刪）：不送，直接丟掉這一列
      let msg; try { msg = JSON.parse(r.payload); } catch { return 400; }
      // TTL 是剩下的秒數（從 expires_at 算）
      return sendOne(env, sub, JSON.stringify({ ...msg, id: r.notif_id || undefined }), { ttl: r.ttl, urgency: r.urgency });
    });
    rows.forEach((r, i) => {
      const x = res[i], st = x.ok ? x.v : 0;
      if (x.ok && st < 300) { out.sent++; done.push(r.id); return; }
      out.failed++;
      if (x.ok && (st === 404 || st === 410) && keys.has(`${r.endpoint} ${r.notif_id}`)) gone.push(r.endpoint);
      if (x.ok && PERMANENT(st)) done.push(r.id);
      else if (r.attempts >= 3) { done.push(r.id); out.dropped++; }   // 暫時性失敗已經試滿 3 次
    });
  }
  const fin = [];
  if (done.length) fin.push(env.DB.prepare('DELETE FROM push_queue WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(done)));
  if (gone.length) fin.push(env.DB.prepare('DELETE FROM push_subs WHERE endpoint IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...new Set(gone)])));
  fin.push(env.DB.prepare(PUSH_EXPIRED));
  const r = await env.DB.batch(fin);
  out.dropped += r[r.length - 1].results.length;
  return out;
}

// ---- 本專案的推播：訂閱管理（資料表 push_subs：endpoint、member_id、p256dh、auth）----
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const MAX_DEVICES = 10;
export const validEndpoint = (s) => { try { const u = new URL(s); return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname)); } catch { return false; } };

export async function subscribe(env, memberId, { endpoint, p256dh, auth }) {
  // 每人最多 10 台：超過就刪掉最舊的（一句），再寫入這一台
  //   同一台裝置換人訂閱（共用裝置、前一個人的工作階段逾時沒有登出）：前一個人還在佇列裡的推播一起刪掉，不會送到新主人的裝置
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_queue WHERE endpoint = ?2 AND EXISTS (SELECT 1 FROM push_subs WHERE endpoint = ?2 AND member_id != ?1)').bind(memberId, endpoint),
    env.DB.prepare(`DELETE FROM push_subs WHERE member_id = ?1 AND endpoint != ?2 AND endpoint NOT IN
      (SELECT endpoint FROM push_subs WHERE member_id = ?1 AND endpoint != ?2 ORDER BY created_at DESC LIMIT ?3)`).bind(memberId, endpoint, MAX_DEVICES - 1),
    env.DB.prepare(`INSERT INTO push_subs (endpoint, member_id, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth`).bind(endpoint, memberId, p256dh, auth),
  ]);
}

export const unsubscribe = (env, memberId, endpoint) =>
  env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND member_id = ?').bind(endpoint, memberId).run();

// 測試推播：直接送給本人的裝置（最多 10 台，不經過佇列）
export async function pushTest(env, memberId, msg) {
  if (!vapidOn(env)) return { sent: 0 };
  const subs = (await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE member_id = ? LIMIT ?').bind(memberId, MAX_DEVICES).all()).results;
  const res = await pool(subs, planOf(env).pushConc, (s) => sendOne(env, s, JSON.stringify(msg), { ttl: 3600 }));
  const gone = subs.filter((s, i) => res[i].ok && (res[i].v === 404 || res[i].v === 410)).map((s) => s.endpoint);
  if (gone.length) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(gone)).run();
  return { sent: res.filter((x) => x.ok && x.v < 300).length };
}
