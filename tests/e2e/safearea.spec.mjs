// iPhone 瀏海與手勢條（安全區域）逐頁檢查：用 Chrome 模擬上方 59、下方 34 點的安全區域
//   1. 可以點的東西不能在瀏海或手勢條底下
//   2. 捲到最底時，最後一個可以點的東西不能被浮動分頁列蓋住
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked } from './helpers.mjs';

const TOP = 59, BOTTOM = 34;
test.use({ viewport: { width: 393, height: 852 } });

test('安全區域：瀏海、手勢條、浮動分頁列不會擋到內容', async ({ page, context }) => {
  test.setTimeout(240000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: TOP, bottom: BOTTOM, left: 0, right: 0 } });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  const routes = ['#/', '#/plan', '#/run', '#/map', '#/calendar', '#/challenge', '#/studio', '#/report', '#/notifications', '#/tickets', '#/teams', '#/t/youth',
    '#/me', '#/me/profile', '#/me/races', '#/me/reg', '#/me/notify', '#/me/security', '#/me/privacy', '#/me/card',
    '#/admin?tab=overview', '#/admin?tab=members', '#/admin?tab=settings', '#/roster', '#/new', '#/log?extra=1', '#/privacy'];
  const problems = {};
  for (const r of routes) {
    await page.goto(`/${r}`);
    await page.waitForFunction(() => document.querySelector('#view') && !document.querySelector('#view .skel'), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    const bad = await page.evaluate(({ TOP, BOTTOM }) => {
      const out = [], H = innerHeight;
      const seen = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 ? r : null; };
      const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}「${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 10)}」`;
      // 只看真的會被點到的：元素中心點最上層是它自己（或它的子元素）
      const onTop = (el, r) => { const x = r.left + r.width / 2, y = r.top + r.height / 2; if (y < 0 || y > H) return false; const hit = document.elementFromPoint(x, y); return hit && (hit === el || el.contains(hit)); };
      // 只檢查固定位置的元件（上方列、分頁列、抽屜、浮動按鈕、提示列）：一般內容捲動時本來就會經過手勢條
      const fixedish = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') return true; } return false; };
      for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]')) {
        const r = seen(el); if (!r || !onTop(el, r) || !fixedish(el)) continue;
        if (r.top < TOP - 1) out.push(`瀏海底下：${label(el)} top=${Math.round(r.top)}`);
        if (r.bottom > H - BOTTOM + 1) out.push(`手勢條上：${label(el)} bottom=${Math.round(r.bottom)}`);
      }
      return out.slice(0, 6);
    }, { TOP, BOTTOM });
    // 捲到底：最後一個可以點的內容不能被分頁列蓋住（地圖頁是滿版、用抽屜，不適用）
    if (r !== '#/map') {
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(250);
      const hidden = await page.evaluate(() => {
        const tabs = document.querySelector('.tabs'); if (!tabs) return null;
        const t = tabs.getBoundingClientRect().top;
        // 收合的 <details> 裡的東西看不到（新版 Chrome 仍會回報座標），不算
        const items = [...document.querySelectorAll('#view a[href], #view button, #view input, #view select, #view textarea')].filter((el) => { const r = el.getBoundingClientRect(); const d = el.closest('details:not([open])'); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !(d && !el.closest('summary')); });
        const last = items.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
        if (last && last.type === 'checkbox' && getComputedStyle(last).opacity === '0') return null;
        if (!last) return null;
        const r = last.getBoundingClientRect();
        return r.bottom > t + 1 ? `捲到底仍被分頁列蓋住：${last.tagName.toLowerCase()}「${(last.textContent || last.getAttribute('aria-label') || '').trim().slice(0, 10)}」bottom=${Math.round(r.bottom)} tabs=${Math.round(t)}` : null;
      });
      if (hidden) bad.push(hidden);
    }
    if (bad.length) problems[r] = bad;
    await page.screenshot({ path: `test-results/safearea/${r.replace(/[#/?=&]+/g, '_').replace(/^_+|_+$/g, '') || 'home'}.png` });
  }
  console.log(JSON.stringify(problems, null, 1));
  expect(problems).toEqual({});
});

// 跑者休息站的類型 chip：在上方列底下、不在瀏海裡，也不會蓋住右邊的地圖工具；手勢條上沒有可以點的東西
test('安全區域：練跑地圖打開休息站圖層', async ({ page, context, request }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: TOP, bottom: BOTTOM, left: 0, right: 0 } });
  const f = (await apiAs(request, 't_chair', '/me')).settings?.features || {};
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { ...f, rest: true } });
  await page.addInitScript(() => { try { localStorage.setItem('cil-map-rest', '1'); localStorage.setItem('cil-map-view', '[25.0736,121.5401,16]'); } catch {} });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/map');
  await expect(page.locator('#restChips')).toBeVisible();
  const r = await page.evaluate(() => {
    const top = document.querySelector('.top').getBoundingClientRect().bottom, ctl = document.querySelector('.mapctl').getBoundingClientRect();
    return [...document.querySelectorAll('#restChips .rchip')].map((b) => b.getBoundingClientRect()).filter((x) => x.right > 0 && x.left < innerWidth)
      .map((x) => ({ top: x.top, bottom: x.bottom, right: x.right, underTop: x.top < top - 1, overCtl: x.right > ctl.left + 1 && x.bottom > ctl.top }));
  });
  expect(r.length).toBeGreaterThan(0);
  for (const x of r) { expect(x.top).toBeGreaterThanOrEqual(TOP); expect(x.underTop).toBe(false); expect(x.overCtl).toBe(false); }
  // 圖資版權往下讓開，不被 chip 蓋住
  const attr = await page.locator('.leaflet-control-attribution').boundingBox();
  const chips = await page.locator('#restChips').boundingBox();
  expect(attr.y).toBeGreaterThanOrEqual(chips.y + chips.height - 4);
});
