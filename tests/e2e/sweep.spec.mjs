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
  const small = [...document.querySelectorAll('#view button, #view a.btn, #view [role=button]')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 30 || r.width < 30); }).slice(0, 5)
    .map((b) => `小按鈕 ${b.tagName.toLowerCase()}「${b.textContent.trim().slice(0, 8)}」${Math.round(b.getBoundingClientRect().width)}×${Math.round(b.getBoundingClientRect().height)}`);
  return [...out.slice(0, 8), ...small];
};

// 淺色、深色各掃一次（色塊、對比問題常常只出現在其中一種）
for (const scheme of ['light', 'dark']) test(`逐頁檢查・${scheme === 'dark' ? '深色' : '淺色'}（理事長看得到全部頁面）`, async ({ page, request }) => {
  test.setTimeout(300000);
  await page.emulateMedia({ colorScheme: scheme });
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'buy', title: '逐頁檢查 團購', date: plus(6), notify: false, items: [{ name: '團服', price: 650, sizes: 'S,M,L' }], pay_info: { account: '測試銀行 004 帳號 123456789012', methods: ['transfer', 'cash'] }, options: [{ name: '全馬', price: 1200 }] } });
  const party = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'party', title: '逐頁檢查 慶功宴', date: plus(20), gather_time: '18:30', place: '榮榮園', address: '台北市大安區信義路四段25號2樓', fee: 800, guest_max: 2, meal_options: '葷食,素食', link_url: 'https://forms.gle/example', link_label: '登記座位', notify: false } });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  const routes = ['#/', '#/plan', '#/run', '#/map', '#/calendar', '#/challenge', '#/studio', '#/report', '#/past', '#/notifications', '#/tickets', '#/teams', '#/t/youth',
    '#/me', '#/me/profile', '#/me/races', '#/me/reg', '#/me/teams', '#/me/notify', '#/me/security', '#/me/privacy', '#/me/assoc', '#/me/card',
    '#/admin?tab=overview', '#/admin?tab=members', '#/admin?tab=roles', '#/admin?tab=teams', '#/admin?tab=events', '#/admin?tab=settings', '#/admin?tab=audit', '#/roster', '#/logs/team',
    '#/new', `#/e/${ev.id}`, `#/e/${ev.id}/stats`, `#/edit/${ev.id}`, `#/e/${party.id}`, `#/e/${party.id}/stats`, '#/log?extra=1', '#/plan/new', '#/privacy'];
  const problems = {};
  const dir = `test-results/sweep${scheme === 'dark' ? '-dark' : ''}`;
  for (const r of routes) {
    await page.goto(`/${r}`);
    // 只換 # 不會重新載入頁面：等骨架消失才算畫好
    const ok = await page.waitForFunction(() => document.querySelector('#view') && !document.querySelector('#view .skel'), null, { timeout: 8000 }).then(() => true, () => false);
    if (!ok) { problems[r] = ['8 秒後還在載入']; continue; }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    const bad = await page.evaluate(overflow);
    if (bad.length) problems[r] = bad;
    // 整頁截圖時把浮動的上方列與分頁列藏起來，不然會疊在頁面中間
    await page.addStyleTag({ content: '.tabs,.top{visibility:hidden!important}' });
    await page.screenshot({ path: `${dir}/${r.replace(/[#/?=&]+/g, '_').replace(/^_+|_+$/g, '') || 'home'}.png`, fullPage: true });
    await page.evaluate(() => document.querySelectorAll('style').forEach((x) => { if (x.textContent.includes('.tabs,.top{visibility')) x.remove(); }));
  }
  console.log(JSON.stringify(problems, null, 1));
  expect(problems).toEqual({});
});
