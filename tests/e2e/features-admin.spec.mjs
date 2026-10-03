// 全功能測試（管理後台）：總覽與待審核、會員查詢、指派身分、分團、系統設定、備份、稽核、名冊
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked } from './helpers.mjs';

const enter = async (page, id) => { await login(page, id); await acceptPrivacyIfAsked(page); };

test('總覽：待審核的入團申請可以直接核准', async ({ page, request }) => {
  await apiAs(request, 't_super', '/teams/kids/join', { method: 'POST' });
  await enter(page, 't_chair');
  await page.goto('/#/admin');
  await expect(page.locator('#pendingTop')).toContainText('測試監事');
  await page.locator('#pendingTop [data-pa="approve"]').first().click();
  await expect(page.getByText('已核准')).toBeVisible();
});

test('會員：查詢跑友、掃描會籍卡（手動貼上）', async ({ page, request }) => {
  await apiAs(request, 't_chair', '/members/t_other/membership', { method: 'POST', body: { membership: 'active' } });
  const card = await apiAs(request, 't_other', '/me/card');
  await enter(page, 't_chair');
  await page.goto('/#/admin?tab=members');
  await page.locator('#verifyCard').click();
  await page.locator('.sheet input[name=code]').fill(card.qr);
  await page.locator('.sheet form').getByRole('button').click();
  await expect(page.locator('.scanmsg')).toContainText('有效會員');
  await page.locator('.sheet [data-close]').click();
  await expect(page).toHaveURL(/tab=members/);
});

test('權限：搜尋跑友指派身分，分頁停在權限', async ({ page }) => {
  await enter(page, 't_chair');
  await page.goto('/#/admin?tab=roles');
  await page.locator('#roleSearch [name=q]').fill('路人');
  await page.locator('#roleSearch').getByRole('button').click();
  await page.locator('#roleList [data-role]').first().click();
  await page.locator('#rf [name=role]').selectOption('coach');
  await page.locator('#rf').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText(/已更新/)).toBeVisible();
  await expect(page.locator('.seg [aria-pressed="true"]')).toHaveText('權限');
  await page.locator('#roleSearch [name=q]').fill('路人');
  await page.locator('#roleSearch').getByRole('button').click();
  await page.locator('#roleList [data-role]').first().click();
  await page.locator('#rf [name=role]').selectOption('member');
  await page.locator('#rf').getByRole('button', { name: '儲存' }).click();
});

test('系統設定：功能開關、分頁名稱、立即備份；稽核查詢與完整性檢查；名冊查詢', async ({ page }) => {
  await enter(page, 't_chair');
  await page.goto('/#/admin?tab=settings');
  await page.locator('#tabsForm [name=home]').fill('揪跑');
  await page.locator('#tabsForm').getByRole('button').click();
  await expect(page.locator('.tabs')).toContainText('揪跑');
  await page.locator('#tabsForm [name=home]').fill('');
  await page.locator('#tabsForm').getByRole('button').click();
  await page.locator('#bkNow').click();
  await expect(page.getByText(/已備份/)).toBeVisible();
  await expect(page.locator('#bkList')).toContainText('manual');
  await page.goto('/#/admin?tab=audit');
  await expect(page.locator('#panel')).toContainText('稽核');
  const verify = page.getByRole('button', { name: /完整性/ });
  if (await verify.count()) { await verify.click(); await expect(page.locator('#panel')).toContainText(/異常|筆/); }
  await page.goto('/#/roster');
  await expect(page.locator('h1')).toContainText('名冊');
});
