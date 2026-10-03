// 附近即時影像：政府公開攝影機的清單同步、地點附近的鏡頭、畫面轉送
//   來源（第一階段）：
//     wra  經濟部水利署 水利防災用影像（data.gov.tw 36687，政府資料開放授權條款第1版，顯名「經濟部水利署」）
//     thb  交通部公路局 省道 CCTV（opendataCCTVs.xml；對外提供要註明公路局，重複擷取間隔不得小於 60 秒）
//     heo  臺北市水利處 cctv_islive（沒有開放授權聲明，要取得書面同意；預設關閉，關閉時不發出任何連線）
//     link 幹部手動新增的官方直播連結（例如 YouTube），只做外連、不嵌入、不轉送
//   畫面一律經 Worker 轉送：跑友的 IP 不會送到第三方主機、CSP 的 img-src 不用開放外部網域、
//   每支鏡頭向來源抓取的間隔由這裡保證（至少 60 秒）；影像只在 Cache API（約 60 秒）與記憶體（最多 10 分鐘）暫存，不寫入 D1、KV 或 R2。
//   整個功能由「功能開關」的 features.cams 控制，預設關閉（staging 實測 Cache API、出口 IP 與解析 CPU 時間之後才開）。
import * as Mock from './cams-mock.js';
import { xfetch } from './budget.js';

const UA = 'cil-run camera relay (+https://cil-run.anselliu7.workers.dev)';
// 來源登錄表：清單網址、解析、主機白名單、顯名。主機白名單跟資安有關（避免變成開放代理），寫在程式碼裡
export const SOURCES = {
  wra: {
    name: '經濟部水利署', attribution: '影像來源：經濟部水利署（政府資料開放授權條款第1版）', hour: 4,
    list: 'https://opendata.wra.gov.tw/api/v2/f71b74eb-cbe5-42c6-8be5-7500450e7db0?format=JSON',
    page: 'https://fhy.wra.gov.tw/fhyv2/monitor/cctv', hosts: [/^fmg\.wra\.gov\.tw$/], parse: parseWra,
  },
  // 公路局清單約 1.7 MB、2300 多筆：解析與寫入超過免費方案一次執行的 CPU 與子請求，改用電腦上的同步工具（tools/cams-sync.mjs）更新；
  //   畫面轉送照常（offline 只影響清單同步）
  thb: {
    name: '交通部公路局', attribution: '影像來源：交通部公路局', hour: 5, offline: true,
    list: 'https://cctv-maintain.thb.gov.tw/opendataCCTVs.xml',
    page: 'https://thbapp.thb.gov.tw/opendata/', hosts: [/^cctv-ss0[1-8]\.thb\.gov\.tw$/], parse: parseThb,
  },
  heo: {
    name: '臺北市水利處', attribution: '影像來源：臺北市政府工務局水利工程處', hour: 4, consent: true,
    list: 'https://heopublic.gov.taipei/taipei-heo-api/cctv_islive',
    page: 'https://taipeiheo.aws-gov.org/public/realtime',
    hosts: [/^heocctv[2-4]\.gov\.taipei$/, /^video\.nvr\.taifo\.com\.tw$/, /^antiflood\.wra10\.gov\.tw$/], parse: parseHeo,
  },
  link: { name: '官方直播', attribution: '官方直播連結', manual: true, hosts: [] },
};
export const CAM_KINDS = ['river', 'park', 'road', 'sky', 'coast'];
const MIN_IV = 60;              // 秒：每支鏡頭向來源抓取的最短間隔
const MAX_IMG = 800 * 1024;     // 單張畫面上限
const MAX_LIST = 4 * 1024 * 1024;

// 測試模式（CAM_MOCK=1 而且 DEV_LOGIN=1）：清單與畫面都用假資料，不連外
const mocked = (env) => env.CAM_MOCK === '1' && env.DEV_LOGIN === '1';
// 對外連線一律算進執行額度（測試的假來源也照算，計數才和正式環境一樣）
const camFetch = (env, url, init) => {
  if (!mocked(env)) return xfetch(env, url, init);
  try { env.budget?.take('fetch'); } catch (e) { return Promise.reject(e); }
  return Promise.resolve(Mock.fetchMock(url));
};
export const mockControl = (q) => Mock.control(q);

// FNV-1a：清單欄位有沒有變（不是資安用途）
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const coord = (v) => { const n = Number(String(v ?? '').replace(/\s+/g, '')); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : NaN; };
const inTaiwan = (lat, lng) => lat >= 21 && lat <= 26.5 && lng >= 118 && lng <= 122.5;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// 來源代碼一律用 Object.hasOwn 查（避免 __proto__、constructor 這類名稱查到原型上的東西）
export const sourceOf = (k) => (typeof k === 'string' && Object.hasOwn(SOURCES, k) ? SOURCES[k] : null);
// 白名單：https、沒有帳密、預設埠（443）、主機在該來源的清單裡
export const hostOk = (source, u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && x.port === '' && (sourceOf(source)?.hosts || []).some((re) => re.test(x.hostname)); } catch { return false; }
};
// 功能開關：settings.features 的 cams 要明確設成 true 才開（預設關閉）
export const featureOn = (raw) => { try { return JSON.parse(raw || '{}')?.cams === true; } catch { return false; } };
// 清單的一筆 → 資料表的一列（不合格的丟掉：座標不在臺灣、網址不是 https 或主機不在白名單）
function row(source, raw) {
  const id = String(raw.id ?? '').trim();
  if (!/^[\w.-]{1,48}$/.test(id)) return null;
  const lat = coord(raw.lat), lng = coord(raw.lng);
  if (!inTaiwan(lat, lng) || !hostOk(source, raw.src)) return null;
  const r = { id: `${source}:${id}`, name: clip(raw.name, 60) || id, kind: CAM_KINDS.includes(raw.kind) ? raw.kind : 'road', lat, lng,
    city: clip(raw.city, 10) || null, basin: clip(raw.basin, 20) || null, media: 'snapshot', src: String(raw.src).slice(0, 400), page: SOURCES[source].page, iv: MIN_IV };
  r.h = fnv(JSON.stringify([r.name, r.kind, r.lat, r.lng, r.city, r.basin, r.media, r.src, r.page, r.iv]));
  return r;
}
function parseWra(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('清單格式不對');
  return list.map((x) => row('wra', { id: x.cameraid, name: x.cameraname || x.videosurveillancestationname, kind: 'river', lat: x.latitude_4326, lng: x.longitude_4326,
    city: x.countiesandcitieswherethemonitoringpointsarelocated, basin: x.basinname, src: x.imageurl }));
}
// 公路局 XML 約 1.7 MB：用 indexOf 逐段找標籤，不用 DOM 也不用大量 regex（排程的 CPU 時間有限）
const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
function parseThb(text) {
  const out = [];
  let i = 0;
  const tag = (name, from, to) => {
    const a = text.indexOf(`<${name}>`, from);
    if (a < 0 || a > to) return '';
    const b = text.indexOf(`</${name}>`, a);
    return b < 0 || b > to ? '' : unxml(text.slice(a + name.length + 2, b)).trim();
  };
  for (;;) {
    const a = text.indexOf('<CCTV>', i);
    if (a < 0) break;
    const b = text.indexOf('</CCTV>', a);
    if (b < 0) break;
    const road = tag('RoadName', a, b), mile = tag('LocationMile', a, b), desc = tag('SurveillanceDescription', a, b);
    out.push(row('thb', { id: tag('CCTVID', a, b), name: desc || `${road} ${mile}`, kind: 'road', lat: tag('PositionLat', a, b), lng: tag('PositionLon', a, b), src: tag('VideoImageURL', a, b) }));
    i = b + 7;
  }
  if (!out.length && !/<CCTVList/.test(text)) throw new Error('清單格式不對');
  return out;
}
// 水利處的分類 → 鏡頭類型；iframe 類（video.nvr.taifo.com.tw/{uuid}.html）改用每分鐘更新的封面圖 memfs/{uuid}.jpg
const HEO_KIND = { 公園: 'park', 市區: 'road' };
function parseHeo(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('清單格式不對');
  return list.filter((x) => Number(x.IsLive) === 1).map((x) => {
    let src = String(x.url_snapshot || '');
    const m = src.match(/^https:\/\/video\.nvr\.taifo\.com\.tw\/([0-9a-f-]{36})\.html$/);
    if (m) src = `https://video.nvr.taifo.com.tw/memfs/${m[1]}.jpg`;
    else if (x.url_resoure_type === 'iframe') src = '';
    return row('heo', { id: x.stn_id, name: x.stn_name, kind: HEO_KIND[x.category] || 'river', lat: x.lat, lng: x.lon, city: '臺北市', basin: x.basin_name, src });
  });
}

async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) { try { await res.body?.cancel(); } catch {} return null; }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch {} return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

// ---- 每日同步 ----
export const UPSERT = `INSERT INTO cams (id, source, name, kind, lat, lng, city, basin, media, src_url, page_url, min_interval, hash)
  SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.name'), json_extract(value, '$.kind'), json_extract(value, '$.lat'), json_extract(value, '$.lng'),
    json_extract(value, '$.city'), json_extract(value, '$.basin'), json_extract(value, '$.media'), json_extract(value, '$.src'), json_extract(value, '$.page'),
    json_extract(value, '$.iv'), json_extract(value, '$.h')
  FROM json_each(?2) WHERE true
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, lat = excluded.lat, lng = excluded.lng, city = excluded.city, basin = excluded.basin,
    media = excluded.media, src_url = excluded.src_url, page_url = excluded.page_url, min_interval = excluded.min_interval, hash = excluded.hash, enabled = 1, updated_at = datetime('now')
  WHERE cams.hash IS NOT excluded.hash OR cams.enabled = 0`;
// 來源清單不再出現的鏡頭：停用（不刪除）
export const DISABLE = `UPDATE cams SET enabled = 0, updated_at = datetime('now')
  WHERE source = ?1 AND manual = 0 AND enabled = 1 AND id NOT IN (SELECT value FROM json_each(?2))`;

// 抓不到畫面而被標成 down 的鏡頭：每天同步後重新給一次機會；來源的同步結果
export const HEALTH_RESET = "UPDATE cams SET health = 'ok', fails = 0 WHERE source = ?1 AND health = 'down'";
export const SOURCE_OK = "UPDATE cam_sources SET last_sync_at = datetime('now'), last_ok_at = datetime('now'), last_count = ?2, last_error = NULL, rev = rev + 1 WHERE source = ?1";
// 清單文字 → 資料列（白名單與臺灣座標範圍檢查、同一個 id 只留第一筆）；Worker 與 tools/cams-sync.mjs 共用
export const parseList = (source, text) => { const seen = new Set(); return sourceOf(source).parse(text).filter((r) => r && !seen.has(r.id) && seen.add(r.id)); };
// 同步要寫的語句（[SQL, 參數]）：UPSERT 每 chunk 筆一句、停用消失的鏡頭、重設 down、來源狀態；Worker 與同步工具共用
export function syncPlan(source, rows, chunk = 400) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) out.push([UPSERT, [source, JSON.stringify(rows.slice(i, i + chunk))]]);
  out.push([DISABLE, [source, JSON.stringify(rows.map((r) => r.id))]], [HEALTH_RESET, [source]], [SOURCE_OK, [source, rows.length]]);
  return out;
}

// 同步中的標記：開始抓清單前先寫，成功或失敗都會覆蓋掉。如果一直停在這個值，表示那次執行被中斷（例如超過 CPU 時間上限）
export const SYNCING = '同步中';
const setError = (env, source, error) => env.DB.prepare("UPDATE cam_sources SET last_sync_at = datetime('now'), last_error = ? WHERE source = ?").bind(error, source).run();
export const markFailed = (env, source, error) => setError(env, source, String(error || '同步失敗').slice(0, 120)).catch(() => {});
// 清單只接受同一台主機的 https（允許同主機轉址，不接受轉到別的主機或降級成 http）
const sameHost = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.protocol === 'https:' && x.hostname === y.hostname && x.port === y.port; } catch { return false; } };

// 同步一個來源：抓清單 → 清理 → 完整性檢查（比上次少 30% 以上就不寫）→ 用雜湊決定要不要寫 → 停用消失的鏡頭
export async function syncSource(env, source) {
  const S = sourceOf(source);
  if (!S?.list) return { error: '這個來源不能同步' };
  const src = await env.DB.prepare('SELECT enabled, last_count FROM cam_sources WHERE source = ?').bind(source).first();
  if (!src?.enabled) return { error: '來源沒有開啟' };   // 關閉的來源（例如還沒取得同意的 heo）不發出任何連線
  await setError(env, source, SYNCING);
  let rows = null, error = null;
  try {
    let res = await camFetch(env, S.list, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA, accept: 'application/json, application/xml, text/xml' } });
    // 最多跟一次同主機的轉址（例如加斜線）；轉到別的主機或 http 一律不收
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) {
      try { await res.body?.cancel(); } catch {}
      const next = new URL(loc, S.list).href;
      if (!sameHost(next, S.list)) throw new Error('來源轉址到別的主機');
      res = await camFetch(env, next, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA, accept: 'application/json, application/xml, text/xml' } });
    }
    if (!res.ok) throw new Error(`來源回應 ${res.status}`);
    const buf = await readCapped(res, MAX_LIST);
    if (!buf) throw new Error('清單太大');
    rows = parseList(source, new TextDecoder().decode(buf));
  } catch (e) { error = e.name === 'TimeoutError' ? '來源逾時' : String(e.message || e).slice(0, 120); }
  if (!error && !rows.length) error = '清單是空的';
  if (!error && src.last_count && rows.length < src.last_count * 0.7) error = `筆數從 ${src.last_count} 掉到 ${rows.length}，這次不更新`;
  if (error) { await markFailed(env, source, error); return { error }; }
  const stmts = syncPlan(source, rows).map(([sql, p]) => env.DB.prepare(sql).bind(...p));
  const nUp = stmts.length - 3;
  let res;
  try { res = await env.DB.batch(stmts); } catch (e) {
    const msg = `寫入資料庫失敗：${String(e?.message || e).slice(0, 80)}`;
    await markFailed(env, source, msg);
    return { error: msg };
  }
  return { count: rows.length, changed: res.slice(0, nUp).reduce((n, r) => n + (r.meta?.changes || 0), 0), disabled: res[nUp].meta?.changes || 0 };
}

// ---- 地點附近的鏡頭 ----
const RAD = Math.PI / 180;
const haversine = (a, b) => {
  const x = Math.sin((b.lat - a.lat) * RAD / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin((b.lng - a.lng) * RAD / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));   // 公尺
};
// 依地點類型偏好的鏡頭類型（乘在距離上，越小越優先）：河濱優先河川鏡頭、公園優先公園鏡頭
const PREFER = {
  river: { river: 0.6, park: 0.8, road: 1.3, sky: 1.5 },
  park: { park: 0.7, river: 0.9, road: 1.0, sky: 1.2 },
  track: { park: 0.8, river: 1.0, road: 1.0, sky: 1.2 },
  trail: { sky: 0.8, road: 1.0, river: 1.2 },
  road: { road: 0.8, park: 1.0, river: 1.1 },
};
// 1.5 公里內最多 3 支（同一來源最多 2 支）；1.5 公里內都沒有時，改找 3 公里內最近的 1 支，標「較遠」
export const RADIUS = 1500, FALLBACK = 3000, MAX_CAMS = 3, PER_SOURCE = 2;
async function nearCams(env, spot) {
  const dLat = FALLBACK / 111320, dLng = FALLBACK / (111320 * Math.cos(spot.lat * RAD));
  const rows = (await env.DB.prepare(`SELECT c.id, c.source, c.name, c.kind, c.media, c.lat, c.lng, c.page_url, c.label, c.min_interval
    FROM cams c JOIN cam_sources s ON s.source = c.source AND s.enabled = 1
    WHERE c.enabled = 1 AND c.health != 'down' AND c.lat BETWEEN ?1 AND ?2 AND c.lng BETWEEN ?3 AND ?4 LIMIT 300`)
    .bind(spot.lat - dLat, spot.lat + dLat, spot.lng - dLng, spot.lng + dLng).all()).results;
  const w = PREFER[spot.kind] || {};
  const all = rows.map((c) => ({ ...c, dist: Math.round(haversine(spot, c)) })).filter((c) => c.dist <= FALLBACK);
  const near = all.filter((c) => c.dist <= RADIUS);
  // 1.5 公里內一支都沒有：只給 3 公里內最近的一支（不套類型偏好，純看距離）
  if (!near.length) return all.sort((a, b) => a.dist - b.dist).slice(0, 1);
  const ranked = near.map((c) => ({ ...c, score: Math.max(c.dist, 30) * (w[c.kind] ?? 1.1) * (c.media === 'snapshot' ? 1 : 1.15) }))
    .sort((a, b) => a.score - b.score);
  const out = [], per = {};
  for (const c of ranked) {
    if ((per[c.source] = (per[c.source] || 0) + 1) > PER_SOURCE) continue;
    out.push(c);
    if (out.length >= MAX_CAMS) break;
  }
  return out.sort((a, b) => a.dist - b.dist);
}
// 回給前端的欄位：絕對不含 src_url（原始影像網址只在伺服器端使用）
//   label：幹部輸入的來源名稱（使用者內容，前端標 translate="no"）；沒填時前端顯示可翻譯的「官方直播」
//   far：只能用 3 公里備援半徑找到的鏡頭，前端標「較遠（x 公里），僅供參考天氣」
const publicCam = (c) => ({
  id: c.id, name: c.name, kind: c.kind, dist: c.dist, media: c.media, source: c.source, far: c.dist > RADIUS,
  source_name: c.source === 'link' ? SOURCES.link.name : sourceOf(c.source)?.name || '', label: c.source === 'link' ? c.label || null : null,
  attribution: c.source === 'link' ? (c.label ? `「${c.label}」官方直播` : SOURCES.link.attribution) : sourceOf(c.source)?.attribution || '',
  page_url: c.page_url || null, interval: Math.max(MIN_IV, c.min_interval || MIN_IV),
});
// 地點附近的鏡頭：結果用 Cache API 存 1 小時；來源開關、同步或手動連結有變（rev 加 1）就換 key，立即生效
//   回 { cams, enabled（有沒有任何來源開著）, link（官方直播連結的來源有沒有開） }
export async function forSpot(env, spot) {
  const srcs = (await env.DB.prepare('SELECT source, enabled, rev FROM cam_sources').all()).results.filter((s) => s.enabled && sourceOf(s.source));
  const link = srcs.some((s) => s.source === 'link');
  if (!srcs.length) return { cams: [], enabled: false, link };
  const ver = fnv(JSON.stringify(srcs.map((s) => [s.source, s.rev])));
  const key = new Request(`https://cil-run.internal/spotcams/v2/${encodeURIComponent(spot.id)}/${spot.lat},${spot.lng}/${ver}`);
  const cache = globalThis.caches?.default;
  let cams = null;
  try { const hit = await cache?.match(key); if (hit) cams = await hit.json(); } catch {}
  if (!cams) {
    cams = (await nearCams(env, spot)).map(publicCam);
    const put = cache?.put(key, new Response(JSON.stringify(cams), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } }));
    if (put) env.ctx?.waitUntil ? env.ctx.waitUntil(put.catch(() => {})) : await put.catch(() => {});
  }
  return { cams, enabled: true, link };
}

// ---- 畫面轉送 ----
// 檔頭判斷格式：水利署回 PNG 卻標 image/jpeg，一律以檔頭為準；不是圖片就不轉送
const sniff = (b) => (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
  : b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'image/png' : null);
// 同一個 isolate 裡最近的畫面（Cache API 在 workers.dev 上不一定有作用時的備援）；最多 24 張、最多留 10 分鐘
const MEM_TTL = 10 * 60e3;
const mem = new Map();
const remember = (id, v) => { mem.delete(id); mem.set(id, v); if (mem.size > 24) mem.delete(mem.keys().next().value); };
const recall = (id) => {
  const m = mem.get(id);
  if (m && Date.now() - m.t >= MEM_TTL) { mem.delete(id); return null; }
  return m || null;
};
// 最近一次向來源抓取失敗的時間（同一個 isolate）：節流期間回 502「暫時無法取得畫面」，不要誤報成「更新中」
const bad = new Map();
const FRAME_HEADERS = {
  'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer', 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'x-frame-options': 'DENY',
};
const frameRes = (buf, type, at, iv, how) => new Response(buf, { headers: {
  'content-type': type, 'content-length': String(buf.byteLength), 'cache-control': `private, max-age=${Math.max(1, iv - 5)}`,
  'x-cam-at': at, 'x-cam-cache': how, ...FRAME_HEADERS } });
const frameFail = (status, msg, extra = {}) => new Response(JSON.stringify({ error: msg }), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...FRAME_HEADERS, ...extra } });

// cam：已確認啟用中的 snapshot 鏡頭（含 src_url）；throttle(key, limit, sec)：用 rate_limits 表限制向來源抓取的次數
export async function frame(env, cam, throttle) {
  const iv = Math.max(MIN_IV, cam.min_interval || MIN_IV);
  const key = new Request(`https://cil-run.internal/cam/v1/${encodeURIComponent(cam.id)}`);
  const cache = globalThis.caches?.default;
  try {
    const hit = await cache?.match(key);
    if (hit) return frameRes(await hit.arrayBuffer(), hit.headers.get('content-type'), hit.headers.get('x-cam-at') || '', iv, 'hit');
  } catch {}
  const m = recall(cam.id);
  if (m && Date.now() - m.t < iv * 1000) return frameRes(m.buf, m.type, m.at, iv, 'mem');
  // 每支鏡頭在 min_interval 秒內最多向來源抓 1 次（公路局的規定），Cache API 沒作用時也一樣
  //   rate_limits 的時間只到整秒，多留 1 秒，兩次抓取的間隔才一定不少於 min_interval
  if (await throttle(`camo:${cam.id}`, 1, iv + 1)) {
    if (m) return frameRes(m.buf, m.type, m.at, iv, 'stale');
    const b = bad.get(cam.id);
    if ((b && Date.now() - b < (iv + 1) * 1000) || cam.fails > 0) return frameFail(502, '暫時無法取得畫面');
    // 別的 isolate 剛抓過（這裡沒有那張畫面）：告訴前端還要等幾秒，前端繼續顯示上一張
    const w = await env.DB.prepare("SELECT CAST(strftime('%s', window_end) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER) AS s FROM rate_limits WHERE key = ?")
      .bind(`camo:${cam.id}`).first().catch(() => null);
    const wait = Math.min(Math.max(Number(w?.s) || iv, 1), iv + 1);
    return frameFail(503, '畫面更新中，請稍後再試', { 'retry-after': String(wait) });
  }
  const failed = async (msg) => {
    bad.set(cam.id, Date.now());
    if (bad.size > 200) bad.delete(bad.keys().next().value);
    // 連續 3 次抓不到就設成 down，不再推薦（每天同步後重新嘗試）
    const p = env.DB.prepare("UPDATE cams SET fails = fails + 1, health = CASE WHEN fails + 1 >= 3 THEN 'down' ELSE health END WHERE id = ?").bind(cam.id).run();
    env.ctx?.waitUntil ? env.ctx.waitUntil(p.catch(() => {})) : await p.catch(() => {});
    return frameFail(502, msg);
  };
  if (!hostOk(cam.source, cam.src_url)) return frameFail(502, '暫時無法取得畫面');
  let buf = null;
  try {
    // 不帶任何跑友的資訊（cookie、IP、Referer 都不轉送）；不跟隨轉址（避免被導到白名單以外的主機）
    const res = await camFetch(env, cam.src_url, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'user-agent': UA, accept: 'image/jpeg, image/png, image/*;q=0.8' } });
    if (res.status !== 200) { try { await res.body?.cancel(); } catch {} return failed('暫時無法取得畫面'); }
    buf = await readCapped(res, MAX_IMG);
  } catch { return failed('暫時無法取得畫面'); }
  const type = buf && sniff(buf);
  if (!type) return failed('暫時無法取得畫面');
  const at = new Date().toISOString();
  remember(cam.id, { t: Date.now(), buf, type, at });
  bad.delete(cam.id);
  const jobs = [];
  if (cache) jobs.push(cache.put(key, new Response(buf, { headers: { 'content-type': type, 'cache-control': `public, max-age=${iv}`, 'x-cam-at': at } })));
  // 健康狀態只在變化時寫（或每小時更新一次最後成功時間），省 D1 寫入
  if (cam.fails || cam.health !== 'ok' || !cam.last_ok_at || Date.parse(`${cam.last_ok_at.replace(' ', 'T')}Z`) < Date.now() - 3600e3) {
    jobs.push(env.DB.prepare("UPDATE cams SET fails = 0, health = 'ok', last_ok_at = datetime('now') WHERE id = ?").bind(cam.id).run());
  }
  const all = Promise.all(jobs).catch(() => {});
  env.ctx?.waitUntil ? env.ctx.waitUntil(all) : await all;
  return frameRes(buf, type, at, iv, 'miss');
}
