// 通行金鑰與幹部兩步驟驗證：用軟體驗證器模擬手機（產生金鑰、組 CBOR、簽章），測伺服器端驗證
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8799', RP = new URL(BASE).hostname;
const te = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const sha = async (d) => new Uint8Array(await crypto.subtle.digest('SHA-256', d));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const head = (mt, n) => (n < 24 ? [mt << 5 | n] : n < 256 ? [mt << 5 | 24, n] : [mt << 5 | 25, n >> 8, n & 255]);
function cbor(v) {
  if (typeof v === 'number') return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = te.encode(v); return cat(new Uint8Array(head(3, b.length)), b); }
  if (v instanceof Uint8Array) return cat(new Uint8Array(head(2, v.length)), v);
  return cat(new Uint8Array(head(5, v.size)), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}
const der = (raw) => { const enc = (x) => { let i = 0; while (i < 31 && x[i] === 0) i++; let v = x.slice(i); if (v[0] & 0x80) v = cat(new Uint8Array([0]), v); return cat(new Uint8Array([2, v.length]), v); };
  const r = enc(raw.slice(0, 32)), s = enc(raw.slice(32)); return cat(new Uint8Array([0x30, r.length + s.length]), r, s); };
async function call(path, body, cookie) {
  const r = await fetch(`${BASE}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}

test('通行金鑰：註冊、登入、防重放與偽造、幹部強制兩步驟', async () => {
  const cookie = (await fetch(`${BASE}/api/dev/login?id=t_chair`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(32)), rpHash = await sha(te.encode(RP));
  let counter = 1;

  // 註冊
  const o = (await call('/passkey/options', { purpose: 'register' }, cookie)).json;
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
  const ad = cat(rpHash, new Uint8Array([0x45, 0, 0, 0, counter]), new Uint8Array(16), new Uint8Array([0, 32]), credId, cbor(cose));
  const cd = te.encode(JSON.stringify({ type: 'webauthn.create', challenge: o.publicKey.challenge, origin: BASE }));
  const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const credential = { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(att) } };
  assert.equal((await call('/passkey/verify', { cid: o.cid, credential }, cookie)).status, 200);
  assert.equal((await call('/passkey/verify', { cid: o.cid, credential }, cookie)).status, 400, '同一個挑戰不能用兩次');

  const assertion = async (purpose, ck, opts = {}) => {
    const op = (await call('/passkey/options', { purpose }, ck)).json;
    counter += 1;
    const a = cat(rpHash, new Uint8Array([0x05, 0, 0, 0, opts.counter ?? counter]));
    const c = te.encode(JSON.stringify({ type: 'webauthn.get', challenge: op.publicKey.challenge, origin: opts.origin || BASE }));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, cat(a, await sha(c))));
    return call('/passkey/verify', { cid: op.cid, credential: { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(c), authenticatorData: b64u(a), signature: b64u(der(raw)) } } }, ck);
  };
  const login = await assertion('login', null);
  assert.equal(login.status, 200);
  const pkCookie = login.cookie;
  assert.equal((await call('/me', null, pkCookie)).json.member.mfa, true);
  assert.equal((await assertion('login', null, { origin: 'https://evil.example' })).status, 400, '別的網域要擋');
  assert.equal((await assertion('login', null, { counter: 1 })).status, 400, '計數倒退要擋');

  // 強制兩步驟：沒驗證過的工作階段不能開；開了之後沒驗證的幹部只有跑友權限
  assert.equal((await call('/settings/security', { require_mfa: true }, cookie)).status, 400);
  assert.equal((await call('/settings/security', { require_mfa: true }, pkCookie)).status, 200);
  assert.equal((await call('/me', null, cookie)).json.member.mfaPending, true);
  assert.equal((await call('/members?q=測試', null, cookie)).status, 403);
  assert.equal((await assertion('stepup', cookie)).status, 200);
  assert.equal((await call('/members?q=測試', null, cookie)).status, 200);
  assert.equal((await call('/settings/security', { require_mfa: false }, pkCookie)).status, 200);
});
