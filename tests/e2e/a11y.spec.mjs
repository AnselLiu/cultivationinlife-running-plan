// 無障礙：用 axe 檢查主要頁面，嚴重（critical）與重大（serious）問題一律要修
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

const PAGES = ['#/', '#/plan', '#/run', '#/calendar', '#/challenge', '#/me', '#/me/profile', '#/me/notify', '#/me/reg', '#/map', '#/tickets', '#/notifications'];
test('登入頁沒有嚴重的無障礙問題', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.welcome');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => ['critical', 'serious'].includes(v.impact));
  expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
PAGES.push('#/me/calendar', '#/me/display');   // 「我的」的行事曆訂閱、外觀與語言子頁
for (const p of PAGES) {
  test(`無障礙 ${p}`, async ({ page }) => {
    await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
    await page.goto(`/${p}`);
    await page.waitForTimeout(1200);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).exclude('.leaflet-tile-pane').analyze();
    const bad = r.violations.filter((v) => ['critical', 'serious'].includes(v.impact));
    expect(bad.map((v) => `${v.id}: ${v.help}｜${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    // 版面：沒有東西超出手機畫面右邊（可以左右滑的列表除外）
    const over = await page.evaluate(() => {
      const vw = innerWidth, out = [];
      for (const el of document.querySelectorAll('#view *')) {
        if (el.closest('svg') && el.tagName !== 'svg') continue;
        let p = el.parentElement, scroller = false;
        while (p && p.id !== 'view') { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = true; break; } p = p.parentElement; }
        if (scroller) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.right > vw + 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} → ${Math.round(r.right)}px`);
      }
      return out.slice(0, 5);
    });
    expect(over).toEqual([]);
  });
}
// 通知中心與通知設定：淺色、深色都要通過；通知頁另外在動作選單打開時再跑一次
const axeBad = async (page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations
  .filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.help}｜${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
for (const scheme of ['light', 'dark']) for (const p of ['#/notifications', '#/me/notify', '#/me/display']) {
  test(`無障礙 ${p}（${scheme}）`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
    await page.goto(`/${p}`);
    await page.waitForTimeout(1200);
    expect(await axeBad(page)).toEqual([]);
    if (p === '#/notifications' && await page.locator('#nfeed .nmore').count()) {
      await page.locator('#nfeed .nmore').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await axeBad(page)).toEqual([]);
    }
  });
}
// 報名設定、統計頁審核、後台活動報名預設（幹部頁面）：淺色、深色都要通過，375px 寬不能水平捲動
for (const scheme of ['light', 'dark']) test(`無障礙 報名設定與審核（${scheme}）`, async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: '無障礙 審核', date: plus(6), gather_time: '07:00', capacity: 5, require_approval: true, notify: false } });
  await apiAs(request, 't_other', `/events/${ev.id}/signup`, { method: 'POST', body: {} });
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  for (const p of ['#/new', `#/e/${ev.id}/stats?f=pending`, '#/admin?tab=settings']) {
    await page.goto(`/${p}`);
    await page.waitForTimeout(1200);
    expect(await axeBad(page), p).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${p} 水平捲動`).toBe(true);
  }
  // 整批操作列與婉拒面板
  await page.goto(`/#/e/${ev.id}/stats?f=pending`);
  await page.locator('.prow [data-sel]').first().check();
  await expect(page.getByRole('toolbar', { name: '整批審核' })).toBeVisible();
  await page.locator('[data-bulk="reject"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await axeBad(page)).toEqual([]);
  await page.locator('.sheet [data-x]').last().click();
});

