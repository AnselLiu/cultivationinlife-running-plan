// 無障礙：用 axe 檢查主要頁面，嚴重（critical）與重大（serious）問題一律要修
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, acceptPrivacyIfAsked } from './helpers.mjs';

const PAGES = ['#/', '#/plan', '#/plan/race', '#/plan/setup', '#/plan/season', '#/plan/guide', '#/run', '#/calendar', '#/challenge', '#/me', '#/me/profile', '#/me/notify', '#/me/reg', '#/map', '#/tickets', '#/notifications'];
test('登入頁沒有嚴重的無障礙問題', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.welcome');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => ['critical', 'serious'].includes(v.impact));
  expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
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
for (const scheme of ['light', 'dark']) for (const p of ['#/notifications', '#/me/notify']) {
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
