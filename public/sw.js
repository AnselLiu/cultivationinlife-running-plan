// 耕跑團 PWA — Service Worker
//   外殼快取：離線也打得開
//   資料快取：入場券、課表、活動、訓練紀錄等讀取類 API 先走網路，斷線時改用上次的資料（標頭 x-cil-offline: 1）
//   更新：新版本裝好後先等待，畫面提示「有新版本」，使用者按下才切換（不會在填表單時突然重整）
//   推播：顯示通知並更新主畫面圖示的未讀數字
//   分享：從其他 App 分享 GPX／TCX 檔過來，暫存後打開拍照分享
const CACHE = 'cil-v65';
const API_CACHE = 'cil-api';
const SHARE_CACHE = 'cil-share';
// 地圖圖磚：看過的與「下載離線地圖」存的都在這裡，最多約 3000 張，先存的先清
const TILE_CACHE = 'cil-tiles', TILE_HOSTS = ['wmts.nlsc.gov.tw', 'tile.openstreetmap.org'], TILE_MAX = 3000;
// 外殼：public 的每個 JS 模組都要列（含用到才載入的活動頁、「我的」子頁、休息站、課表加強功能），離線才打得開；
//   index.html 只 modulepreload 第一屏要的模組，其他的在這裡安裝時一次存好
const SHELL = ['/', '/style.css', '/app.js', '/plan.js', '/data/season-2026.json', '/data/zip3.json', '/manifest.webmanifest', '/coach', '/party.js', '/qr.js', '/vendor/qrcode.js', '/studio.js', '/run.js', '/guide.js', '/admin.js', '/photo.js', '/report.js', '/manage.js', '/teams.js', '/pricing.js', '/calendar.js', '/map.js', '/reststops.js', '/weather.js', '/wxrule.js', '/hours.js', '/challenge.js', '/badges.js', '/coachcalc.js', '/coach.js', '/coachweek.js', '/coachpdf.js', '/vendor/leaflet.js', '/vendor/leaflet.css', '/i18n.js', '/i18n-en.js', '/notif-cats.js', '/signup-window.js', '/device.js', '/event.js', '/me.js',
  '/icons/icon-192.png', '/teams/youth.webp', '/teams/kids.webp', '/teams/core.webp', '/teams/geng.webp'];
// 斷線時可以用上次資料的 API（都是本人看得到的內容；登出時整個清掉）
const OFFLINE_API = [/^\/api\/spots$/, /^\/api\/spots\/[\w-]+$/, /^\/api\/spots\/[\w-]+\/rest$/, /^\/api\/routes$/, /^\/api\/routes\/[\w-]+$/, /^\/api\/me$/, /^\/api\/my\/tickets$/, /^\/api\/my\/prizes$/, /^\/api\/my\/pickups$/, /^\/api\/events$/, /^\/api\/events\/[\w-]+$/, /^\/api\/events\/[\w-]+\/seats$/,
  /^\/api\/plans$/, /^\/api\/logs$/, /^\/api\/teams$/, /^\/api\/notifications$/, /^\/api\/races$/];

self.addEventListener('install', (e) => {
  // 略過瀏覽器的 HTTP 快取，確保新版本拿到的是最新的檔案
  //   有轉址的檔案存成沒有轉址紀錄的版本（見 clean）
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map(async (u) => {
    const res = await fetch(new Request(u, { cache: 'reload' }));
    if (!res.ok) throw new Error(`快取失敗：${u}`);
    await c.put(u, await clean(res));
  }))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![CACHE, API_CACHE, SHARE_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  // 登出或刪除帳號：清掉這台裝置上暫存的個人資料
  if (e.data?.type === 'CLEAR_DATA') e.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(SHARE_CACHE)]));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (TILE_HOSTS.includes(url.hostname) && e.request.method === 'GET') { e.respondWith(tile(e.request)); return; }
  if (url.origin !== location.origin) return;
  // 從其他 App 分享檔案進來（manifest 的 share_target）
  if (e.request.method === 'POST' && url.pathname === '/share-target') { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    if (OFFLINE_API.some((r) => r.test(url.pathname))) e.respondWith(networkFirst(e.request));
    return;
  }
  // 程式與頁面（js、css、html、json、頁面導覽）有快取就只用快取，不在背景一個一個換新：
  //   不然同一次使用中會新舊版混在一起（新模組配舊主程式就會壞）；換版一律靠新版 Service Worker 整批安裝
  const code = e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/coach' || /\.(js|mjs|css|html|json|webmanifest)$/.test(url.pathname);
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(async (hit) => {
    if (hit && code) return clean(hit);
    const net = fetch(e.request).then(async (res) => {
      if (res.ok) { const c = await clean(res.clone()); caches.open(CACHE).then((x) => x.put(e.request, c)); }
      return res;
    }).catch(async () => hit || clean(await caches.match('/')));
    return hit ? clean(hit) : net;
  }));
});

// 轉址過的回應（例如 /coach.html → /coach）不能拿來回應頁面導覽，Safari 與 Chrome 都會直接顯示錯誤：重新包成沒有轉址紀錄的回應
async function clean(res) {
  if (!res || !res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

let tilePuts = 0;
async function tile(req) {
  const c = await caches.open(TILE_CACHE), hit = await c.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type !== 'opaque') {
      await c.put(req.url, res.clone());
      if (++tilePuts % 200 === 0) { const ks = await c.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - TILE_MAX))) await c.delete(k); }
    }
    return res;
  } catch { return new Response('', { status: 504 }); }
}
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(API_CACHE)).put(req, res.clone());
    return res;
  } catch {
    const hit = await (await caches.open(API_CACHE)).match(req);
    if (!hit) return new Response(JSON.stringify({ error: '目前離線，這個畫面還沒有暫存的資料' }), { status: 503, headers: { 'content-type': 'application/json', 'x-cil-offline': '1' } });
    const h = new Headers(hit.headers); h.set('x-cil-offline', '1');
    return new Response(await hit.blob(), { status: 200, headers: h });
  }
}

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const file = form.getAll('track').find((f) => f && f.size && f.size < 20e6);
    if (file) await (await caches.open(SHARE_CACHE)).put('/shared-track', new Response(file, { headers: { 'x-name': encodeURIComponent(file.name || 'track.gpx') } }));
  } catch {}
  return Response.redirect('/#/studio?shared=1', 303);
}

// 主畫面圖示的未讀數字（支援的平台：iOS 16.4+ 加到主畫面、Android、桌機）
async function refreshBadge() {
  if (!self.navigator.setAppBadge) return;
  try {
    const r = await fetch('/api/notifications/count', { credentials: 'include' });
    // badge＝新通知＋未讀的帳號安全通知；舊版伺服器只有 unread
    const { badge, unread } = await r.json(); const n = badge ?? unread;
    n ? await self.navigator.setAppBadge(n) : await self.navigator.clearAppBadge();
  } catch {}
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: '耕跑團', body: e.data?.text() || '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || '耕跑團', {
      body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      tag: d.tag || undefined, renotify: !!(d.tag && d.re), timestamp: d.ts || Date.now(), lang: 'zh-Hant-TW',
      data: { url: d.url || '/', id: d.id || null },
    });
    await refreshBadge();
    // 開著的 App 只拿到「去重抓」的訊號，不帶通知內容
    for (const c of await clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'notif', cat: d.cat || null });
  })());
});
// 點推播：只接受站內網址（不能被拿來做開放式轉址）；標為已讀；已開著的 App 用 postMessage 導頁（不受控制的視窗 navigate() 會失敗）
const SAFE_URL = /^\/(#\/[\w/?=&.%-]*)?$/;
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { url: raw, id } = e.notification.data || {};
  const url = SAFE_URL.test(raw || '') ? raw : '/#/notifications';
  e.waitUntil((async () => {
    if (id) await fetch('/api/notifications/read', { method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {});
    const w = (await clients.matchAll({ type: 'window', includeUncontrolled: true })).find((x) => new URL(x.url).origin === location.origin);
    if (w) { await w.focus().catch(() => {}); w.postMessage({ type: 'go', url }); } else await clients.openWindow(url);
    await refreshBadge();
  })());
});
// 推播服務換了訂閱（瀏覽器更新金鑰等）：用新的訂閱重新登記，沒有就用原本的金鑰重新訂閱
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const sub = e.newSubscription || (e.oldSubscription?.options?.applicationServerKey
      ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: e.oldSubscription.options.applicationServerKey }) : null);
    if (!sub) return;
    const j = sub.toJSON();
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) }).catch(() => {});
  })());
});
