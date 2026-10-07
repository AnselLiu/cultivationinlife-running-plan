// 連結預覽圖（og:image）：每個活動類型一張 1200×630 的 PNG（public/og/<kind>.png），分享連結 /e/:id 貼到 LINE、Facebook 時顯示
//   用 Playwright 的 Chromium 把 HTML 樣板畫成圖片：社團名稱、類型名稱、一個線條圖示；顏色取自 public/style.css 的 :root
//   類型與 src/worker.js 的 KINDS 一致，另外加團員揪團（meetup：kind 是 other、owner_managed 的活動）；tests/api.test.mjs 檢查每張都有、尺寸對、小於 100 KB
//   用法：node tools/og-images.mjs [類型…]（改了類型、名稱或樣式再跑一次，把產生的圖片一起提交；只給類型就只畫那幾張）
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('public/style.css', root), 'utf8');
const color = (name) => css.match(new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`))[1];
const C = { navy: color('navy'), blue: color('blue'), yellow: color('yellow'), lime: color('lime') };
const mark = `data:image/png;base64,${readFileSync(new URL('public/icons/icon-512.png', root)).toString('base64')}`;

// 類型名稱同 public/app.js 的 KIND_NAME；圖示是 24×24 的線條（圓頭、圓角），放大畫；class="cover" 的形狀填底色蓋住後面的線
const KINDS = {
  track: ['田徑場團練', '<rect x="2.5" y="6" width="19" height="12" rx="6"/><rect x="6.2" y="9.2" width="11.6" height="5.6" rx="2.8"/><path d="M12 6v3.2"/>'],
  core: ['核心日', '<path d="M8.2 20.6h7.6a6 6 0 1 0-7.6 0Z"/><path d="M8.6 11 7.7 7.5a2.5 2.5 0 0 1 2.4-3.1h3.8a2.5 2.5 0 0 1 2.4 3.1L15.4 11"/>'],
  long: ['長跑團練', '<circle cx="5.4" cy="18.6" r="1.9"/><path d="M7.3 18.6H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h4.6"/><path d="M18.4 3.2c1.7 0 3 1.2 3 2.9 0 2.1-3 4.7-3 4.7s-3-2.6-3-4.7c0-1.7 1.3-2.9 3-2.9Z"/>'],
  race: ['賽事', '<circle cx="12" cy="15.4" r="5.2"/><path d="M8.2 3.2l3 7M15.8 3.2l-3 7M8.2 3.2h7.6"/><path d="M11.1 14.2l1.4-1v5"/>'],
  party: ['餐敘聚會', '<circle cx="12.5" cy="12" r="5.4"/><circle cx="12.5" cy="12" r="2.6"/><path d="M3.6 4v4.8a1.5 1.5 0 0 0 3 0V4M5.1 9.8V20"/><path d="M20.6 4c-1.6 1-2.4 3-2.4 6.2h2.4V20"/>'],
  survey: ['問卷調查', '<rect x="5" y="4.6" width="14" height="16.4" rx="2.4"/><rect class="cover" x="9" y="3" width="6" height="3.2" rx="1.1"/><path d="M8.4 11.2l1.5 1.5 2.4-2.6M14 11.2h1.8M8.4 16.2l1.5 1.5 2.4-2.6M14 16.2h1.8"/>'],
  buy: ['團購', '<path d="M5.4 8.2h13.2l-1 11.8a1.3 1.3 0 0 1-1.3 1.2H7.7a1.3 1.3 0 0 1-1.3-1.2Z"/><path d="M9 10.4V6.6a3 3 0 0 1 6 0v3.8"/>'],
  other: ['活動', '<rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/><path d="M8.8 14.6l2.2 2.2 4.4-4.6"/>'],
  // 團員自己發起的揪團（app.js 的 kindLabel）；圖示同 app.js 的 MI.team
  meetup: ['揪團', '<circle cx="8" cy="9" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M2.8 19c.5-3 2.6-4.6 5.2-4.6s4.7 1.6 5.2 4.6M14 14.6c2.6-.4 5 .9 5.7 4.4"/>'],
};

const page = (label, icon) => `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:1200px;height:630px}
  body{position:relative;overflow:hidden;background:${C.navy};color:#fff;font-family:"PingFang TC","Heiti TC","Noto Sans TC",sans-serif}
  .glow{position:absolute;right:-220px;top:-160px;width:900px;height:900px;border-radius:50%;background:${C.blue}}
  .ring{position:absolute;right:120px;top:115px;width:400px;height:400px;border-radius:50%;border:3px solid rgba(255,255,255,.22);display:grid;place-items:center}
  .ring svg{width:250px;height:250px;fill:none;stroke:${C.yellow};stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  .ring svg .cover{fill:${C.blue}}
  .left{position:absolute;left:84px;top:96px;display:grid;gap:22px;justify-items:start}
  .mark{width:120px;height:120px;border-radius:28px}
  h1{font-size:118px;font-weight:800;letter-spacing:.06em;line-height:1}
  .en{font-size:21px;font-weight:600;letter-spacing:.32em;color:${C.lime}}
  .kind{margin-top:14px;font-size:46px;font-weight:800;color:${C.navy};background:${C.yellow};border-radius:999px;padding:12px 36px}
  .line{position:absolute;left:84px;bottom:58px;width:72px;height:6px;border-radius:3px;background:${C.lime}}
</style></head><body>
  <div class="glow"></div>
  <div class="ring"><svg viewBox="0 0 24 24">${icon}</svg></div>
  <div class="left"><img class="mark" src="${mark}" alt=""><h1>耕跑團</h1><p class="en">CULTIVATION IN LIFE RUN</p><p class="kind">${label}</p></div>
  <div class="line"></div>
</body></html>`;

const out = new URL('public/og/', root);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const only = process.argv.slice(2);
  for (const [kind, [label, icon]] of Object.entries(KINDS).filter(([k]) => !only.length || only.includes(k))) {
    await tab.setContent(page(label, icon), { waitUntil: 'load' });
    const file = new URL(`${kind}.png`, out);
    writeFileSync(file, await tab.screenshot({ type: 'png' }));
    const kb = statSync(file).size / 1024;
    console.log(`${kind}.png ${kb.toFixed(1)} KB`);
    if (kb >= 100) throw new Error(`${kind}.png 超過 100 KB`);
  }
} finally {
  await browser.close();
}
