// 耕跑團 PWA — Service Worker
//   外殼快取：離線也打得開
//   資料快取：入場券、課表、活動、訓練紀錄等讀取類 API 先走網路，斷線時改用上次的資料（標頭 x-cil-offline: 1）
//   更新：新版本裝好後先等待，畫面提示「有新版本」，使用者按下才切換（不會在填表單時突然重整）
//   推播：顯示通知並更新主畫面圖示的未讀數字
//   分享：從其他 App 分享 GPX／TCX 檔過來，暫存後打開數據照
const CACHE = 'cil-v17';
const API_CACHE = 'cil-api';
const SHARE_CACHE = 'cil-share';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/plan.js', '/data/season-2026.json', '/manifest.webmanifest', '/coach.html', '/party.js', '/qr.js', '/vendor/qrcode.js', '/studio.js',
  '/icons/icon-192.png', '/teams/youth.webp', '/teams/kids.webp', '/teams/core.webp', '/teams/geng.webp'];
// 斷線時可以用上次資料的 API（都是本人看得到的內容；登出時整個清掉）
const OFFLINE_API = [/^\/api\/me$/, /^\/api\/my\/tickets$/, /^\/api\/my\/prizes$/, /^\/api\/events$/, /^\/api\/events\/[\w-]+$/, /^\/api\/events\/[\w-]+\/seats$/,
  /^\/api\/plans$/, /^\/api\/logs$/, /^\/api\/teams$/, /^\/api\/notifications$/, /^\/api\/races$/];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![CACHE, API_CACHE, SHARE_CACHE].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  // 登出或刪除帳號：清掉這台裝置上暫存的個人資料
  if (e.data?.type === 'CLEAR_DATA') e.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(SHARE_CACHE)]));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // 從其他 App 分享檔案進來（manifest 的 share_target）
  if (e.request.method === 'POST' && url.pathname === '/share-target') { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    if (OFFLINE_API.some((r) => r.test(url.pathname))) e.respondWith(networkFirst(e.request));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => hit || caches.match('/index.html'));
    return hit || net;
  }));
});

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
    const { unread } = await r.json();
    unread ? await self.navigator.setAppBadge(unread) : await self.navigator.clearAppBadge();
  } catch {}
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: '耕跑團', body: e.data?.text() || '' }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || '耕跑團', {
      body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      data: { url: d.url || '/' }, tag: d.tag,
    }),
    refreshBadge(),
  ]));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if (w.url.includes(location.origin)) return w.focus().then(() => w.navigate(url));
    return clients.openWindow(url);
  }));
});
