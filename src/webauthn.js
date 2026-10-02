// 通行金鑰（WebAuthn／Passkey）驗證：只用 WebCrypto，不需要外部套件
// 支援 ES256（Apple、Google、多數裝置）與 RS256（部分 Windows Hello）
// 註冊用 attestation: 'none'（不驗證裝置廠商證明，只確認金鑰屬於這個網域與這次挑戰）

export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 最小的 CBOR 解碼（WebAuthn 只用到整數、位元組、字串、陣列、對照表）
function cbor(buf, start = 0) {
  let o = start;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = () => {
    const ib = buf[o++], mt = ib >> 5, ai = ib & 31;
    let len;
    if (ai < 24) len = ai;
    else if (ai === 24) len = buf[o++];
    else if (ai === 25) { len = dv.getUint16(o); o += 2; }
    else if (ai === 26) { len = dv.getUint32(o); o += 4; }
    else if (ai === 27) { len = Number(dv.getBigUint64(o)); o += 8; }
    else throw new Error('不支援的 CBOR 格式');
    switch (mt) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: { const v = buf.slice(o, o + len); o += len; return v; }
      case 3: { const v = new TextDecoder().decode(buf.slice(o, o + len)); o += len; return v; }
      case 4: { const a = []; for (let i = 0; i < len; i++) a.push(read()); return a; }
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = read(); m.set(k, read()); } return m; }
      case 7: return ai === 20 ? false : ai === 21 ? true : null;
      default: throw new Error('不支援的 CBOR 型別');
    }
  };
  const value = read();
  return { value, end: o };
}

function parseAuthData(ad) {
  const flags = ad[32];
  const out = { rpIdHash: ad.slice(0, 32), up: !!(flags & 1), uv: !!(flags & 4), at: !!(flags & 64),
    signCount: new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0) };
  if (out.at) {
    const len = (ad[53] << 8) | ad[54];
    out.credId = ad.slice(55, 55 + len);
    const { value } = cbor(ad, 55 + len);
    out.cose = value;
  }
  return out;
}

// COSE 公鑰 → JWK（存進資料庫）
function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) return { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)), alg: 'ES256' };
  if (kty === 3 && alg === -257) return { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)), alg: 'RS256' };
  throw new Error('這個裝置的金鑰類型不支援');
}

// ECDSA 簽章是 DER 格式，WebCrypto 要的是 r||s 各 32 bytes
function derToRaw(der) {
  let o = 2;
  if (der[1] & 0x80) o = 2 + (der[1] & 0x7f);
  const int = () => { if (der[o++] !== 2) throw new Error('簽章格式錯誤'); const len = der[o++]; let v = der.slice(o, o + len); o += len; while (v.length > 32 && v[0] === 0) v = v.slice(1); const out = new Uint8Array(32); out.set(v, 32 - v.length); return out; };
  const r = int(), s = int(), raw = new Uint8Array(64); raw.set(r); raw.set(s, 32);
  return raw;
}

function checkClient(clientDataJSON, type, challenge, origin) {
  const c = JSON.parse(new TextDecoder().decode(clientDataJSON));
  if (c.type !== type) throw new Error('驗證類型不正確');
  if (c.challenge !== challenge) throw new Error('驗證逾時，請再試一次');
  if (c.origin !== origin) throw new Error('來源網域不正確');
}

// 註冊：回傳要存的憑證
export async function verifyRegistration({ credential, challenge, origin, rpId }) {
  const clientDataJSON = unb64u(credential.response.clientDataJSON);
  checkClient(clientDataJSON, 'webauthn.create', challenge, origin);
  const att = cbor(unb64u(credential.response.attestationObject)).value;
  const ad = parseAuthData(att.get('authData'));
  if (!eq(ad.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) throw new Error('網域不符');
  if (!ad.up || !ad.at) throw new Error('沒有完成使用者確認');
  const jwk = coseToJwk(ad.cose);
  return { credId: b64u(ad.credId), jwk, signCount: ad.signCount, uv: ad.uv };
}

// 登入或再次驗證：用存好的公鑰驗簽
export async function verifyAssertion({ credential, challenge, origin, rpId, jwk, signCount }) {
  const clientDataJSON = unb64u(credential.response.clientDataJSON);
  checkClient(clientDataJSON, 'webauthn.get', challenge, origin);
  const authData = unb64u(credential.response.authenticatorData);
  const ad = parseAuthData(authData);
  if (!eq(ad.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) throw new Error('網域不符');
  if (!ad.up) throw new Error('沒有完成使用者確認');
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData); signed.set(await sha256(clientDataJSON), authData.length);
  const sig = unb64u(credential.response.signature);
  let ok;
  if (jwk.kty === 'EC') {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), signed);
  } else {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
  }
  if (!ok) throw new Error('通行金鑰驗證失敗');
  // 計數器：兩邊都有計數時，新的一定要比舊的大（防複製的金鑰）
  if (ad.signCount && signCount && ad.signCount <= signCount) throw new Error('通行金鑰計數異常，請重新登入');
  return { signCount: ad.signCount, uv: ad.uv };
}
