// 幹部的主要流程：建立活動 → 發布異動 → 統計頁確認收款 → 刪除活動（選擇面板）
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

test('建立活動並收到下一步提示，發布改時間異動', async ({ page }) => {
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/new');
  await page.locator('#ef [name=title]').fill('E2E 幹部建立的長跑');
  await page.locator('#ef [name=date]').fill(plus(3));
  await page.locator('#ef [name=gather_time]').fill('06:00');
  if (await page.locator('#ef [name=notify]').count()) await page.locator('#ef [name=notify]').uncheck();
  await page.getByRole('button', { name: '建立' }).click();
  await expect(page.locator('.hero')).toContainText('E2E 幹部建立的長跑');
  await page.getByText('發布異動（取消、改地點、改時間）').click();
  await page.locator('#noticeForm [name=gather_time]').fill('06:30');
  await page.getByRole('button', { name: /送出並通知/ }).click();
  await expect(page.getByText(/已通知/)).toBeVisible();
  await expect(page.locator('.hero')).toContainText('06:30');
});

test('統計頁確認收款，刪除活動用選擇面板', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'buy', title: 'E2E 收款測試', date: plus(9), notify: false, items: [{ name: '帽子', price: 250 }] } });
  const it = (await apiAs(request, 't_other', `/events/${ev.id}`)).items[0];
  await apiAs(request, 't_other', `/events/${ev.id}/signup`, { method: 'POST', body: { items: [{ id: it.id, qty: 1 }] } });
  await apiAs(request, 't_other', `/events/${ev.id}/pay-report`, { method: 'POST', body: { method: 'transfer', ref: '11223' } });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  await page.goto(`/#/e/${ev.id}/stats`);
  await expect(page.locator('.moneygrid')).toContainText('NT$250');
  await page.getByRole('button', { name: '確認收款' }).click();
  await expect(page.getByText('已確認收款')).toBeVisible();
  await page.goto(`/#/e/${ev.id}`);
  await page.locator('#del').click();
  await expect(page.getByRole('dialog', { name: '刪除活動' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '刪除', exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
});
