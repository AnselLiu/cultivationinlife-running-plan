// 團員的主要流程：同意隱私權 → 首頁 → 報名團練 → 返回 → 團購下單與回報繳費 → 記錄訓練與拍照 → 里程挑戰 → 切換英文
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

let run, buy;
const tag = Date.now().toString(36).slice(-4);   // 每次跑測試用不同標題，重跑時不會點到上一次建立的活動
test.beforeAll(async ({ request }) => {
  run = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: `E2E 週四團練 ${tag}`, date: plus(1), gather_time: '19:00', place: '田徑場', notify: false } });
  buy = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'buy', title: 'E2E 毛巾團購', date: plus(10), notify: false,
    items: [{ name: '毛巾', price: 300 }], pay_info: { account: '測試銀行 123', methods: ['transfer'] } } });
});

test('隱私權政策改版：要同意才能繼續，同意後回到首頁', async ({ page, request }) => {
  // 理事長改了隱私權政策（自動升版）→ 團員下次開啟要重新同意
  await apiAs(request, 't_chair', '/settings/privacy', { method: 'POST', body: { body: '## 測試改版\n- 一項新的說明', bump: true } });
  await login(page, 't_lead');
  await expect(page.locator('.consentbar')).toBeVisible();
  await expect(page.locator('.tabs')).toBeHidden();
  await page.getByRole('button', { name: '同意並繼續' }).click();
  await expect(page.locator('h1', { hasText: '團練' })).toBeVisible();
  await expect(page.getByText(`E2E 週四團練 ${tag}`).first()).toBeVisible();
});

test('報名團練、返回鍵回到上一頁、取消報名', async ({ page }) => {
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto(`/#/e/${run.id}`);
  await page.getByRole('button', { name: '我要報名' }).click();
  await expect(page.getByText(/報名完成/)).toBeVisible();
  await expect(page.getByRole('button', { name: '取消報名' })).toBeVisible();
  // 返回鍵：從首頁點進來的就回首頁
  await page.goto('/#/');
  await page.waitForLoadState('networkidle');
  await page.locator('a.card', { hasText: `E2E 週四團練 ${tag}` }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/e/${run.id}`));
  await page.locator('#backBtn').click();
  await expect(page).toHaveURL(/#\/$/);
  await page.goto(`/#/e/${run.id}`);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '取消報名' }).click();
  await expect(page.getByText('已取消報名')).toBeVisible();
});

test('團購：選數量即時算錢、報名、回報轉帳後五碼', async ({ page }) => {
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto(`/#/e/${buy.id}`);
  await page.getByRole('button', { name: /毛巾.*加一/ }).click();
  await page.getByRole('button', { name: /毛巾.*加一/ }).click();
  await expect(page.locator('#quote')).toContainText('NT$600');
  await page.getByRole('button', { name: '我要報名' }).click();
  await expect(page.locator('#payCard')).toContainText('NT$600');
  await page.locator('#payForm [name=ref]').fill('24680');
  await page.getByRole('button', { name: '我已繳費' }).click();
  await expect(page.locator('#payCard')).toContainText('已回報');
});

test('記錄訓練後可以直接拍照分享，挑戰頁看得到里程', async ({ page }) => {
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/log?extra=1');
  await page.locator('[name=km]').fill('10');
  await page.locator('[name=time]').fill('55:00');
  await page.getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText('已記錄，辛苦了')).toBeVisible();
  await expect(page.getByRole('link', { name: /拍照分享/ })).toBeVisible();
  await page.goto('/#/challenge');
  await expect(page.locator('.chring')).toContainText(/\d/);
});

test('切換英文介面再切回中文', async ({ page }) => {
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/me/notify');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('.tabs')).toContainText('Runs');
  await page.goto('/#/me/notify');
  await page.getByRole('button', { name: '中文' }).click();
  await expect(page.locator('.tabs')).toContainText('團練');
});
