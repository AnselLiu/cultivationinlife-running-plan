// iPhone Safari（WebKit）逐頁檢查：每一頁都打開，檢查有沒有東西超出畫面、互相重疊的按鈕，並截圖存到 test-results/sweep 方便人工檢視
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

const overflow = () => {
  const vw = innerWidth, out = [];
  for (const el of document.querySelectorAll('#view *, .tabs *, .top *')) {
    if (el.closest('svg') && el.tagName !== 'svg') continue;
    let p = el.parentElement, scroller = false;
    while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = true; break; } p = p.parentElement; }
    if (scroller) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.right > vw + 1 || r.left < -1)) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).split(' ')[0]} [${Math.round(r.left)}–${Math.round(r.right)}]`);
  }
  // 按鈕或連結太小（小於 30×30）不好點
  // 可點範圍：按鈕本身＋用 ::after 往外擴的部分（例如快速打勾看起來 28px、可點 44px）
  const hit = (b) => {
    const r = b.getBoundingClientRect(), a = getComputedStyle(b, '::after'), out = (v) => Math.max(0, -parseFloat(v) || 0);
    return a.content !== 'none' && a.position === 'absolute' ? { w: r.width + out(a.left) + out(a.right), h: r.height + out(a.top) + out(a.bottom) } : { w: r.width, h: r.height };
  };
  const small = [...document.querySelectorAll('#view button, #view a.btn, #view [role=button]')].filter((b) => { const r = b.getBoundingClientRect(), h = hit(b); return r.width > 0 && (h.h < 30 || h.w < 30); }).slice(0, 5)
    .map((b) => `小按鈕 ${b.tagName.toLowerCase()}「${b.textContent.trim().slice(0, 8)}」${Math.round(hit(b).w)}×${Math.round(hit(b).h)}`);
  return [...out.slice(0, 8), ...small];
};

// 淺色、深色各掃一次（色塊、對比問題常常只出現在其中一種）
for (const scheme of ['light', 'dark']) test(`逐頁檢查・${scheme === 'dark' ? '深色' : '淺色'}（理事長看得到全部頁面）`, async ({ page, request }) => {
  test.setTimeout(300000);
  await page.emulateMedia({ colorScheme: scheme });
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'buy', title: '逐頁檢查 團購', date: plus(6), notify: false, items: [{ name: '團服', price: 650, sizes: 'S,M,L' }], pay_info: { account: '測試銀行 004 帳號 123456789012', methods: ['transfer', 'cash'] }, options: [{ name: '全馬', price: 1200 }] } });
  const party = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'party', title: '逐頁檢查 慶功宴', date: plus(20), gather_time: '18:30', place: '榮榮園', address: '台北市大安區信義路四段25號2樓', fee: 800, guest_max: 2, meal_options: '葷食,素食', link_url: 'https://forms.gle/example', link_label: '登記座位', notify: false } });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  const routes = ['#/', '#/plan', '#/plan/season', '#/plan/race', '#/plan/guide', '#/plan/setup', '#/run', '#/map', '#/calendar', '#/challenge', '#/studio', '#/report', '#/past', '#/notifications', '#/tickets', '#/teams', '#/t/youth',
    '#/me', '#/me/profile', '#/me/races', '#/me/reg', '#/me/teams', '#/me/notify', '#/me/security', '#/me/privacy', '#/me/assoc', '#/me/card',
    '#/admin?tab=overview', '#/admin?tab=members', '#/admin?tab=roles', '#/admin?tab=teams', '#/admin?tab=events', '#/admin?tab=settings', '#/admin/settings/signup', '#/admin/settings/org', '#/admin/settings/features', '#/admin/settings/retention', '#/admin?tab=audit', '#/roster', '#/logs/team',
    '#/new', `#/e/${ev.id}`, `#/e/${ev.id}/stats`, `#/e/${ev.id}/stats?f=pending`, `#/edit/${ev.id}`, `#/e/${party.id}`, `#/e/${party.id}/stats`, '#/log?extra=1', '#/plan/new', '#/privacy'];
  const problems = {};
  routes.push('#/me/calendar', '#/me/display');   // 「我的」的行事曆訂閱、外觀與語言子頁
  // 系統設定的其他子頁（清單本身與每一段）
  routes.push('#/admin/settings', ...['races', 'holidays', 'docs', 'training', 'rest', 'cams', 'tabs', 'mfa', 'backup', 'privacy'].map((k) => `#/admin/settings/${k}`));
  const dir = `test-results/sweep${scheme === 'dark' ? '-dark' : ''}`;
  // 每一頁的 JavaScript 錯誤與失敗的 API（4xx 權限類以外）都算問題
  let errs = [];
  page.on('pageerror', (e) => errs.push(`JS 錯誤：${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|service worker|tile/i.test(m.text())) errs.push(`console：${m.text().slice(0, 160)}`); });
  page.on('response', (res) => { if (res.url().includes('/api/') && res.status() >= 500) errs.push(`API ${res.status()}：${new URL(res.url()).pathname}`); });
  for (const r of routes) {
    errs = [];
    await page.goto(`/${r}`);
    // 只換 # 不會重新載入頁面：先等骨架有機會出現（150 毫秒後才會畫），再等它消失才算畫好
    await page.waitForTimeout(300);
    const ok = await page.waitForFunction(() => document.querySelector('#view') && !document.querySelector('#view .skel'), null, { timeout: 8000 }).then(() => true, () => false);
    if (!ok) { problems[r] = ['8 秒後還在載入']; continue; }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    const bad = [...await page.evaluate(overflow), ...errs];
    if (bad.length) problems[r] = bad;
    // 整頁截圖時把浮動的上方列與分頁列藏起來，不然會疊在頁面中間
    await page.addStyleTag({ content: '.tabs,.top{visibility:hidden!important}' });
    await page.screenshot({ path: `${dir}/${r.replace(/[#/?=&]+/g, '_').replace(/^_+|_+$/g, '') || 'home'}.png`, fullPage: true });
    await page.evaluate(() => document.querySelectorAll('style').forEach((x) => { if (x.textContent.includes('.tabs,.top{visibility')) x.remove(); }));
  }
  console.log(JSON.stringify(problems, null, 1));
  expect(problems).toEqual({});
});
