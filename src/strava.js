// Strava 串接：OAuth 授權、活動列表與單筆活動
// 需要 secrets：STRAVA_CLIENT_ID、STRAVA_CLIENT_SECRET、TOKEN_KEY（32 bytes base64，用來加密權杖）
// Strava 後台的 Authorization Callback Domain 填正式站網域（例如 cil-run.anselliu7.workers.dev）
// 範圍只要 activity:read（看得到公開與追蹤者可見的活動），不要求 read_all，避免拿到「只有自己」的私人活動

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env) {
  if (!env.TOKEN_KEY) throw new Error('TOKEN_KEY 未設定');
  return crypto.subtle.importKey('raw', unb64(env.TOKEN_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
// AES-GCM：每次隨機 12 bytes IV，存成 iv.密文（base64）
export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(text)));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function open(env, sealed) {
  const [iv, ct] = sealed.split('.');
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(ct)));
}

export const stravaReady = (env) => !!(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.TOKEN_KEY);

export function authorizeUrl(env, origin, state) {
  const u = new URL('https://www.strava.com/oauth/authorize');
  u.searchParams.set('client_id', env.STRAVA_CLIENT_ID);
  u.searchParams.set('redirect_uri', `${origin}/api/strava/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('approval_prompt', 'auto');
  u.searchParams.set('scope', 'activity:read');
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(env, params) {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, ...params }),
  });
  if (!r.ok) throw new Error(`Strava 授權失敗（${r.status}）`);
  return r.json();
}

export async function exchange(env, memberId, code, scopeGranted) {
  const t = await tokenRequest(env, { code, grant_type: 'authorization_code' });
  await env.DB.prepare(`INSERT INTO strava_links (member_id, athlete_id, enc_refresh, enc_access, expires_at, scope)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET athlete_id = excluded.athlete_id,
    enc_refresh = excluded.enc_refresh, enc_access = excluded.enc_access, expires_at = excluded.expires_at, scope = excluded.scope`)
    .bind(memberId, String(t.athlete?.id || ''), await seal(env, t.refresh_token), await seal(env, t.access_token), t.expires_at, String(scopeGranted || '').slice(0, 80)).run();
  return t.athlete;
}

// 取得有效的存取權杖，快過期就用 refresh token 換新
async function accessToken(env, memberId) {
  const row = await env.DB.prepare('SELECT * FROM strava_links WHERE member_id = ?').bind(memberId).first();
  if (!row) return null;
  if (row.expires_at - 120 > Date.now() / 1000) return open(env, row.enc_access);
  const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: await open(env, row.enc_refresh) });
  await env.DB.prepare('UPDATE strava_links SET enc_refresh = ?, enc_access = ?, expires_at = ? WHERE member_id = ?')
    .bind(await seal(env, t.refresh_token), await seal(env, t.access_token), t.expires_at, memberId).run();
  return t.access_token;
}

async function api(env, memberId, path) {
  const tok = await accessToken(env, memberId);
  if (!tok) throw new Error('尚未連結 Strava');
  const r = await fetch(`https://www.strava.com/api/v3${path}`, { headers: { authorization: `Bearer ${tok}` } });
  if (r.status === 429) throw new Error('Strava 使用量已達上限，請 15 分鐘後再試');
  if (!r.ok) throw new Error(`Strava 讀取失敗（${r.status}）`);
  return r.json();
}

// 只回傳畫數據照需要的欄位，不把整包原始資料丟給前端
const slim = (a) => ({
  id: String(a.id), name: a.name, type: a.sport_type || a.type, start: a.start_date_local,
  distance: a.distance, moving_time: a.moving_time, elapsed_time: a.elapsed_time,
  elevation: a.total_elevation_gain, avg_hr: a.average_heartrate || null, max_hr: a.max_heartrate || null,
  avg_speed: a.average_speed, polyline: a.map?.summary_polyline || a.map?.polyline || '',
  calories: a.calories || null, city: a.location_city || null,
});
export async function listActivities(env, memberId) {
  const items = await api(env, memberId, '/athlete/activities?per_page=20');
  return items.map(slim);
}
export async function getActivity(env, memberId, id) {
  return slim(await api(env, memberId, `/activities/${encodeURIComponent(id)}`));
}
export async function disconnect(env, memberId) {
  try {
    const tok = await accessToken(env, memberId);
    if (tok) await fetch('https://www.strava.com/oauth/deauthorize', { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
  } catch {}
  await env.DB.prepare('DELETE FROM strava_links WHERE member_id = ?').bind(memberId).run();
}
