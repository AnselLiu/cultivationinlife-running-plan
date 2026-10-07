// 跑步記錄：計圈防連按、進行中的這一圈、口袋模式（防誤觸、滑動解鎖、VoiceOver 解鎖按鈕、偏好記在這台手機）
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, acceptPrivacyIfAsked } from './helpers.mjs';

const enter = async (page, id = 't_runner') => { await login(page, id); await acceptPrivacyIfAsked(page); };
const startRun = async (page, context) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 25.0478, longitude: 121.5170, accuracy: 5 });
  await enter(page);
  await page.goto('/#/run');
  await page.locator('#runGo').click();
  await expect(page.locator('#rTime')).toBeVisible();
};
const axeBad = async (page) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  return r.violations.filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
};
const status = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('cil-run-session') || 'null')?.status);

test('計圈：連按只算一圈，進行中的這一圈每秒更新，成績只留完成的圈', async ({ page, context }) => {
  await startRun(page, context);
  await page.locator('#rLap').click();                 // 剛開始 3 秒內不算
  await expect(page.locator('#rLapMsg')).toHaveText('剛開始，3 秒後再記圈');
  await expect(page.locator('#rLaps > div')).toHaveCount(0);
  await page.waitForTimeout(3200);
  await page.locator('#rLap').click();
  await expect(page.locator('#rLapMsg')).toContainText('已記第 1 圈');
  await page.locator('#rLap').click();                 // 連按
  await expect(page.locator('#rLapMsg')).toHaveText('剛記過一圈，這次不算');
  await expect(page.locator('#rLaps > div:not(.cur)')).toHaveCount(1);
  const cur = page.locator('#rLaps > div.cur');
  await expect(cur).toContainText('第 2 圈・進行中');
  const t1 = await cur.locator('b').innerText();
  await expect.poll(() => cur.locator('b').innerText(), { timeout: 4000 }).not.toBe(t1);
  expect(await axeBad(page)).toEqual([]);              // 記錄中（含計圈、螢幕保持亮著的提醒）
  await page.locator('#rPause').click();
  page.once('dialog', (d) => d.accept());
  await page.locator('#rStop').click();
  await expect(page.getByText(/累計/)).toBeVisible();
  await expect(page.getByText(/^第 1 圈/)).toHaveCount(1);
  await expect(page.getByText(/^第 2 圈/)).toHaveCount(0);
});

test('口袋模式：點了沒反應，滑到右邊才解鎖；VoiceOver 用解鎖按鈕；開始後直接進入的偏好記在這台手機', async ({ page, context }) => {
  await startRun(page, context);
  // 主畫面 App 的狀態列跟著變黑，離開口袋模式再還原
  const themes = () => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content));
  const before = await themes();
  await page.locator('#rPocket').click();
  const pocket = page.locator('#pocket');
  await expect(page.getByRole('dialog', { name: '口袋模式' })).toBeVisible();
  await expect(page.locator('#pkTime')).toHaveText(/\d+:\d\d/);
  await expect(page.locator('#pkState')).toHaveText('記錄中');
  expect(await themes()).toEqual(['#000000', '#000000']);
  expect(await axeBad(page)).toEqual([]);
  // 誤觸：點暫停鈕的位置、畫面中間，都不會暫停
  const pb = await page.locator('#rPause').boundingBox();
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2);
  const vp = page.viewportSize();
  await page.mouse.click(vp.width / 2, vp.height / 2);
  await expect(pocket).toBeVisible();
  expect(await status(page)).toBe('running');
  // 拖一半放開：彈回去，不解鎖
  const drag = async (frac) => {
    const k = await page.locator('#pkKnob').boundingBox(), t = await page.locator('#pkSlide').boundingBox();
    const y = k.y + k.height / 2;
    await page.mouse.move(k.x + k.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(k.x + k.width / 2 + (t.width - k.width) * frac, y, { steps: 8 });
    await page.mouse.up();
  };
  await drag(0.4);
  await expect(pocket).toBeVisible();
  // 拖到底：解鎖，焦點回到「口袋模式」按鈕
  await drag(1);
  await expect(pocket).toHaveCount(0);
  await expect(page.locator('#rPocket')).toBeFocused();
  expect(await themes()).toEqual(before);
  // VoiceOver／鍵盤：解鎖按鈕
  await page.locator('#rPocket').click();
  await expect(pocket).toBeVisible();
  await page.getByRole('button', { name: '解鎖口袋模式' }).focus();
  await page.keyboard.press('Enter');
  await expect(pocket).toHaveCount(0);
  expect(await status(page)).toBe('running');
  // 偏好：打開「開始後直接進入口袋模式」，重新整理後還記得，按開始就進入口袋模式
  page.on('dialog', (d) => d.accept());
  await page.locator('#rPause').click();
  await page.locator('#rStop').click();
  await page.locator('#runDiscard').click();
  await page.locator('label.switch', { has: page.locator('#pkPref') }).click();
  await expect(page.locator('#pkPref')).toBeChecked();
  // 重新整理後要重新下載整季課表（讀今天的目標）：故意讓它晚到，還沒讀到就按開始也要有反應
  //   以前按鈕等課表讀完才接上，電腦忙的時候這裡按了沒反應（偶發失敗）
  await page.route('**/data/season-2026.json', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue().catch(() => {}); });
  await page.reload();
  await expect(page.locator('#pkPref')).toBeChecked();
  await page.locator('#runGo').click();
  await expect(pocket).toBeVisible();
  await page.getByRole('button', { name: '解鎖口袋模式' }).focus();
  await page.keyboard.press('Enter');
  await expect(pocket).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
