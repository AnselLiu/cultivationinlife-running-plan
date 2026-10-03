// 無障礙：用 axe 檢查主要頁面，嚴重（critical）與重大（serious）問題一律要修
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, acceptPrivacyIfAsked } from './helpers.mjs';

const PAGES = ['#/', '#/plan', '#/run', '#/calendar', '#/challenge', '#/me', '#/me/profile', '#/me/notify', '#/me/reg', '#/map', '#/tickets', '#/notifications'];
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
  });
}
