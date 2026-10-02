// 耕跑團 PWA — Service Worker：外殼快取（離線可開）＋ 推播通知
const CACHE = 'cil-v5';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/plan.js', '/data/season-2026.json', '/manifest.webmanifest', '/coach.html', '/party.js', '/qr.js', '/vendor/qrcode.js', '/studio.js', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// API 一律走網路（活動與報名要即時）；其他檔案先用快取，背景更新
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => hit || caches.match('/index.html'));
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: '耕跑團', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '耕跑團', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { url: d.url || '/' }, tag: d.tag,
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if (w.url.includes(location.origin)) return w.focus().then(() => w.navigate(url));
    return clients.openWindow(url);
  }));
});
