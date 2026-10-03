// 課表教練整合進課表分頁（P1）：照課表記錄不必填距離；自主加練仍要填距離或時間
import { test, expect } from '@playwright/test';
import { login, acceptPrivacyIfAsked } from './helpers.mjs';

const enter = async (page, id) => { await login(page, id); await acceptPrivacyIfAsked(page); };

test('記錄訓練：課表日按「完成」不填距離也能存', async ({ page }) => {
  await enter(page, 't_other');
  await page.goto('/#/log?w=2&i=1');                      // W2 週二（已經過去的日子）
  await expect(page.locator('#lf [name=status][value=done]')).toBeChecked();
  await page.locator('#lf').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText('已記錄，辛苦了')).toBeVisible();
});

test('記錄訓練：自主加練沒填距離或時間會提醒', async ({ page }) => {
  await enter(page, 't_other');
  await page.goto('/#/log?extra=1');
  await page.locator('#lf').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText('填一下距離或時間')).toBeVisible();
  await expect(page.getByText('已記錄，辛苦了')).toHaveCount(0);
});
