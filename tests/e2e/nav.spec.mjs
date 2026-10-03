// 導覽選單：下方分頁列（5 格、文字、選取膠囊、縮小、再點一次）、側邊欄分區、「我的」分組與外觀設定
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked } from './helpers.mjs';

const enter = async (page, id = 't_runner') => { await login(page, id); await acceptPrivacyIfAsked(page); };
const tab = (page, t) => page.locator(`.tabs > a[data-tab="${t}"]`);
const visibleTabs = (page) => page.locator('.tabs > a[data-tab]:visible');
const box = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; });

for (const vp of [{ width: 393, height: 852 }, { width: 375, height: 667 }]) test(`分頁列 ${vp.width}×${vp.height}：5 格都有文字、沒有超出畫面、可以點的範圍至少 44×44`, async ({ page }) => {
  await page.setViewportSize(vp);
  await enter(page);
  await expect(visibleTabs(page)).toHaveCount(5);
  await expect(tab(page, '/studio')).toBeHidden();   // GPS 開著：拍照收進跑步
  for (const [t, name] of [['/', '團練'], ['/plan', '課表'], ['/run', '跑步'], ['/map', '地圖'], ['/me', '我的']]) {
    await expect(tab(page, t).locator('.tl')).toBeVisible();
    await expect(tab(page, t)).toContainText(name);
    const b = await box(tab(page, t));
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.r).toBeLessThanOrEqual(vp.width);
    expect(b.w).toBeGreaterThanOrEqual(44); expect(b.h).toBeGreaterThanOrEqual(44);
  }
  // 選取狀態只有一個，而且是 aria-current="page"
  await expect(page.locator('.tabs [aria-current]')).toHaveCount(1);
  await expect(tab(page, '/')).toHaveAttribute('aria-current', 'page');
});

test('只顯示圖示：文字隱藏、aria-label 還在；側邊欄仍有文字；第一次載入新版會清掉舊設定一次', async ({ page }) => {
  // 舊版留下的「只顯示圖示」：第一次載入新版時清掉
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('cil-tab-icons', '1'); localStorage.removeItem('cil-nav-v2'); sessionStorage.setItem('seeded', '1'); } } catch {} });
  await enter(page);
  await expect(tab(page, '/plan').locator('.tl')).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('cil-tab-icons'), localStorage.getItem('cil-nav-v2')])).toEqual([null, '1']);
  // 在「我的 › 外觀與語言」打開
  await page.goto('/#/me/display');
  await page.locator('label.switch', { has: page.locator('#iconsOnly') }).click();
  await expect(tab(page, '/plan').locator('.tl')).toBeHidden();
  await expect(tab(page, '/plan')).toHaveAttribute('aria-label', '課表');
  const b = await box(tab(page, '/plan'));
  expect(b.w).toBeGreaterThanOrEqual(44); expect(b.h).toBeGreaterThanOrEqual(44);
  // 重新整理後還是只顯示圖示（設定只清一次）
  await page.reload();
  await expect(tab(page, '/plan').locator('.tl')).toBeHidden();
  // 側邊欄一律有文字
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tab(page, '/plan').locator('.tl')).toBeVisible();
});

test('拍照收進跑步：分頁列亮「跑步」、返回鍵是「‹ 跑步」；跑步頁的「拍照分享」帶到拍照', async ({ page }) => {
  await enter(page);
  await page.goto('/#/run');
  await expect(page.locator('#view h1')).toHaveText('跑步');
  await expect(page.locator('.maplink')).toHaveCount(0);
  await page.locator('.runshare').click();
  await expect(page).toHaveURL(/#\/studio$/);
  await expect(tab(page, '/run')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#backBtn')).toBeVisible();
  // 直接打開（從捷徑或分享進來，App 裡沒有上一頁）：返回鍵回到上一層「跑步」
  await page.goto('/#/studio?km=5');
  await page.reload();
  await expect(page.locator('#backLabel')).toHaveText('跑步');
  await expect(tab(page, '/run')).toHaveAttribute('aria-current', 'page');
});

test.describe('功能開關', () => {
  test.afterEach(async ({ request }) => { await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: {} }); });
  test('GPS 關、拍照開：第 3 格是拍照（沒有返回鍵）；兩個都關：剩 4 格，膠囊位置正確', async ({ page, request }) => {
    await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { gps: false } });
    await enter(page);
    await expect(visibleTabs(page)).toHaveCount(5);
    await expect(visibleTabs(page).nth(2)).toHaveAttribute('data-tab', '/studio');
    await expect(visibleTabs(page).nth(2)).toContainText('拍照');
    await visibleTabs(page).nth(2).click();
    await expect(page).toHaveURL(/#\/studio$/);
    await expect(page.locator('#backBtn')).toBeHidden();
    await expect(tab(page, '/studio')).toHaveAttribute('aria-current', 'page');
    // 兩個都關
    await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { gps: false, studio: false } });
    await page.goto('/#/map'); await page.reload();
    await expect(visibleTabs(page)).toHaveCount(4);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--n').trim())).toBe('4');
    // 選取膠囊和「地圖」那一格對齊
    await page.waitForTimeout(600);
    const sel = await box(page.locator('.tabsel')), m = await box(tab(page, '/map'));
    expect(Math.abs(sel.x - m.x)).toBeLessThan(3);
    expect(Math.abs(sel.w - m.w)).toBeLessThan(3);
  });
});

test('再點一次目前的分頁：子頁回到第一層；第一層捲回頂端', async ({ page }) => {
  await enter(page);
  await page.goto('/#/me');
  await page.goto('/#/me/profile');
  await expect(tab(page, '/me')).toHaveAttribute('aria-current', 'page');
  await tab(page, '/me').click();
  await expect(page).toHaveURL(/#\/me$/);
  await expect(page.locator('#backBtn')).toBeHidden();
  await page.goto('/#/');
  await page.evaluate(() => { document.body.style.minHeight = '4000px'; scrollTo(0, 2000); });
  await page.waitForTimeout(200);
  await tab(page, '/').click({ force: true });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
});

test('往下捲分頁列縮小、往上捲展開；地圖頁不縮小', async ({ page }) => {
  await enter(page);
  await page.goto('/#/me');
  await page.evaluate(() => { document.body.style.minHeight = '4000px'; });
  await page.evaluate(() => scrollTo(0, 200)); await page.waitForTimeout(50);
  await page.evaluate(() => scrollTo(0, 400));
  await expect(page.locator('.tabs.mini')).toHaveCount(1);
  // 縮小時可以點的範圍仍然至少 44×44
  const b = await box(tab(page, '/plan'));
  expect(b.w).toBeGreaterThanOrEqual(44); expect(b.h).toBeGreaterThanOrEqual(44);
  await page.evaluate(() => scrollTo(0, 340));
  await expect(page.locator('.tabs.mini')).toHaveCount(0);
  await page.goto('/#/map');
  await page.evaluate(() => { dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.tabs.mini')).toHaveCount(0);
});

test('從地圖按鈴鐺：分頁列還是亮「地圖」，只有一個 aria-current', async ({ page }) => {
  await enter(page);
  await page.goto('/#/map');
  await expect(tab(page, '/map')).toHaveAttribute('aria-current', 'page');
  await page.locator('#bell').click();
  await expect(page).toHaveURL(/#\/notifications/);
  await expect(tab(page, '/map')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.tabs [aria-current]')).toHaveCount(1);
});

test('側邊欄（1280×800）：訓練、跑團分區；報表亮「訓練報表」；幹部項目照權限', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enter(page);
  await expect(page.locator('#ngTrain')).toBeVisible();
  await expect(page.locator('#ngClub')).toBeVisible();
  await expect(page.locator('#navStaff')).toBeHidden();   // 一般團員看不到幹部
  await page.goto('/#/report');
  await expect(page.locator('.navmore a[data-nav="/report"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.tabs [aria-current]')).toHaveCount(1);
  await page.goto('/#/t/youth');
  await expect(page.locator('.navmore a[data-nav="/teams"]')).toHaveAttribute('aria-current', 'page');
});

test('側邊欄：理事長看得到幹部分區，側邊欄可以捲到最後一列', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enter(page, 't_chair');
  await expect(page.locator('#navStaff')).toBeVisible();
  for (const p of ['/admin', '/roster', '/logs/team', '/plan/new']) await expect(page.locator(`.navmore a[data-nav="${p}"]`)).toBeVisible();
  const last = page.locator('.navmore a[data-nav="/plan/new"]');
  await last.scrollIntoViewIfNeeded();
  const b = await box(last), nav = await box(page.locator('#tabs'));
  expect(b.b).toBeLessThanOrEqual(nav.b);
  await last.click();
  await expect(page).toHaveURL(/#\/plan\/new$/);
  await expect(last).toHaveAttribute('aria-current', 'page');
});

test('外觀：深色、自動；上方列沒有深淺色按鈕', async ({ page }) => {
  await enter(page);
  await expect(page.locator('#theme')).toHaveCount(0);
  await page.goto('/#/me/display');
  await page.getByRole('button', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '自動' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await page.evaluate(() => localStorage.getItem('cil-theme'))).toBeNull();
  await expect(page.getByRole('button', { name: '自動' })).toHaveAttribute('aria-pressed', 'true');
});

test('「我的」分組順序；訓練報表與里程挑戰不在這裡', async ({ page }) => {
  await enter(page);
  await page.goto('/#/me');
  await expect(page.locator('.setgroup .sgt')).toHaveText(['賽事與入場券', '分團與協會', '設定']);
  await expect(page.locator('#view a[href="#/report"]')).toHaveCount(0);
  await expect(page.locator('#view a[href="#/challenge"]')).toHaveCount(0);
  for (const h of ['#/me/notify', '#/me/calendar', '#/me/display']) await expect(page.locator(`#view a[href="${h}"]`)).toHaveCount(1);
  await page.goto('/#/me/calendar');
  await expect(page.locator('#calCard')).toBeVisible();
  await expect(page.locator('#backLabel')).toHaveText('我的');
});

test('「我的」：幹部看得到幹部專區（排在設定前面），含團員訓練', async ({ page }) => {
  await enter(page, 't_chair');
  await page.goto('/#/me');
  await expect(page.locator('.setgroup .sgt')).toHaveText(['賽事與入場券', '分團與協會', '幹部專區', '設定']);
  await expect(page.locator('#view a[href="#/logs/team"]')).toHaveCount(1);
});

test('記錄中：跑步分頁有小點與「跑步，記錄中」，計時列和分頁列一樣寬、在分頁列上方', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('cil-run-session', JSON.stringify({ status: 'running', startedAt: Date.now() - 60000, elapsedMs: 0, resumedAt: Date.now() - 60000, points: [], dist: 1200, gain: 0, laps: [],
      useGps: false, gps: 'off', acc: null, goal: null, goalAsked: false, auto: false, lastMoveAt: Date.now(), anchor: null, askedAt: Date.now() })); } catch {}
  });
  await enter(page);
  await page.goto('/#/plan');
  await expect(tab(page, '/run')).toHaveAttribute('data-live', 'running');
  await expect(tab(page, '/run')).toHaveAttribute('aria-label', '跑步，記錄中');
  await expect(page.locator('#runbar')).toBeVisible();
  const r = await box(page.locator('#runbar')), t = await box(page.locator('#tabs'));
  expect(Math.abs(r.w - t.w)).toBeLessThan(2);
  expect(r.b).toBeLessThanOrEqual(t.y);
  await page.locator('#runbar').click();
  await expect(page).toHaveURL(/#\/run$/);
  await expect(page.locator('#runbar')).toHaveCount(0);
});

test('地圖畫路線時收起分頁列（看不到也點不到），取消後恢復', async ({ page }) => {
  await enter(page);
  await page.goto('/#/map');
  await expect(page.locator('#drawBtn')).toBeEnabled({ timeout: 15000 });
  await page.locator('#drawBtn').click();
  await expect(page.locator('#drawBar')).toBeVisible();
  await expect(page.locator('body.tasking')).toHaveCount(1);
  await expect(page.locator('#tabs')).toHaveCSS('pointer-events', 'none');
  await expect(page.locator('#tabs')).toHaveCSS('opacity', '0');
  await page.locator('#drawCancel').click();
  await expect(page.locator('body.tasking')).toHaveCount(0);
  await expect(page.locator('#tabs')).toHaveCSS('opacity', '1');
});

test('鍵盤：跳到主要分頁', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enter(page);
  await page.goto('/#/plan');
  await page.locator('#skipTabs').focus();
  await expect(page.locator('#skipTabs')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(tab(page, '/plan')).toBeFocused();
});
