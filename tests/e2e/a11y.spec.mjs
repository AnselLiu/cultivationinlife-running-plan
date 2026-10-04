// 無障礙：用 axe 檢查主要頁面，嚴重（critical）與重大（serious）問題一律要修
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

const PAGES = ['#/', '#/plan', '#/plan/race', '#/plan/setup', '#/plan/season', '#/plan/guide', '#/run', '#/calendar', '#/challenge', '#/me', '#/me/profile', '#/me/notify', '#/me/reg', '#/map', '#/tickets', '#/notifications'];
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
  for (const p of ['#/new', `#/e/${ev.id}/stats?f=pending`, '#/admin?tab=settings', '#/admin/settings/signup', '#/admin/settings/features', '#/admin/settings/retention', '#/admin/settings/races']) {
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

// 跑者休息站：底圖選單（menuitemcheckbox）、類型 chip（aria-pressed）、地圖針、地點卡的附近休息站、休息站卡、資料來源清單；淺色與深色
for (const scheme of ['light', 'dark']) test(`無障礙 跑者休息站（${scheme}）`, async ({ page, request }) => {
  const f = (await apiAs(request, 't_chair', '/me')).settings?.features || {};
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { ...f, rest: true } });
  for (const k of ['twd', 'tpt', 'tprv']) await request.get(`/api/dev/rest-sync?source=${k}`);
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript(() => { try { if (sessionStorage.getItem('rv')) return; sessionStorage.setItem('rv', '1'); localStorage.setItem('cil-map-rest', '1'); localStorage.setItem('cil-map-view', '[25.0736,121.5401,16]'); } catch {} });
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  const axe = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).exclude('.leaflet-tile-pane').analyze()).violations
    .filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.help}｜${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  await page.goto('/#/map');
  await expect(page.locator('.rpin').first()).toBeVisible();
  expect(await axe()).toEqual([]);
  // 14 級：休息站合併成灰色泡泡，白色數字的對比也要過（16 級以上不合併，上面那次檢查不到）
  await page.locator('#map').focus();
  await page.keyboard.press('Minus'); await page.keyboard.press('Minus');
  await expect(page.locator('.rclus').first()).toBeVisible();
  expect(await axe()).toEqual([]);
  // 類型 chip 至少 44 px 高的點擊範圍（按鈕 36 px＋上下各 4 px 的透明延伸）
  const h = await page.locator('#restChips .rchip').first().evaluate((el) => el.getBoundingClientRect().height + 2 * Math.max(0, -parseFloat(getComputedStyle(el, '::after').top)));
  expect(h).toBeGreaterThanOrEqual(44);
  await page.locator('#baseBtn').click();
  expect(await axe()).toEqual([]);
  await page.keyboard.press('Escape');
  await page.goto('/#/map?spot=seed07');
  await expect(page.locator('#restNear .rnitem').first()).toBeVisible();
  expect(await axe()).toEqual([]);
  await page.locator('#restNear .rnitem').first().click();
  await expect(page.locator('.restcard')).toBeVisible();
  expect(await axe()).toEqual([]);
  await page.locator('#baseBtn').click();
  await page.locator('#restSrc').click();
  await expect(page.getByRole('dialog', { name: '休息站資料來源' })).toBeVisible();
  expect(await axe()).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#baseBtn')).toBeFocused();
});

// ---------- VoiceOver 走查修正的回歸檢查（換頁焦點、sheet、報名與記錄的焦點、表單錯誤、導覽、地圖） ----------
// 標題層級：活動頁與「我的」子頁要有 h1，卡片標題不跳級（best-practice 的兩條規則，不分嚴重度）
test('標題層級：活動頁與「我的」子頁有 h1、不跳級', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: '無障礙 標題', date: plus(5), gather_time: '07:00', capacity: 10, notify: false } });
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  for (const p of [`#/e/${ev.id}`, '#/me/races', '#/me/teams', '#/me/security', '#/me/privacy', '#/me/assoc', '#/me/calendar', '#/me/display']) {
    await page.goto(`/${p}`);
    await page.waitForTimeout(900);
    const r = await new AxeBuilder({ page }).withRules(['page-has-heading-one', 'heading-order']).analyze();
    expect(r.violations.map((v) => `${v.id}｜${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`), p).toEqual([]);
  }
});
// 換頁：從「我的」點一列，焦點在新頁的 h1、分頁標題含頁名；點分頁列焦點留在分頁
test('換頁後焦點在新頁面的大標題，document.title 有頁名', async ({ page }) => {
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/me');
  await page.locator('#view a[href="#/me/races"]').click();
  await expect(page.locator('#view h1')).toBeFocused();
  await expect(page).toHaveTitle(/我的賽事與倒數/);
  await page.locator('.tabs a[data-tab="/plan"]').click();
  await expect(page.locator('.tabs a[data-tab="/plan"]')).toBeFocused();
  await expect(page).toHaveTitle(/課表/);
});
// 共用 sheet：焦點移進去、Tab 不會跑到背景、Esc 關閉、焦點回到開啟的按鈕（倒數選擇、分享 App、choose）
test('倒數選擇、分享 App、選擇面板：焦點進出與 Esc', async ({ page, request }) => {
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  const inSheet = () => page.evaluate(() => !!document.activeElement?.closest('.sheet'));
  const check = async (open, opener) => {
    await open();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await inSheet()).toBe(true);
    for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); expect(await inSheet(), `第 ${i + 1} 次 Tab`).toBe(true); }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  };
  await page.goto('/#/');
  await check(() => page.locator('#countdown').click(), page.locator('#countdown'));
  await page.goto('/#/me');
  await check(() => page.locator('#shareApp').click(), page.locator('#shareApp'));
  // choose()：刪除賽事（是課表週期的那場才問，其他用 confirm）→ 用活動頁的取消報名
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: '無障礙 取消', date: plus(5), gather_time: '07:00', capacity: 10, notify: false } });
  await apiAs(request, 't_runner', `/events/${ev.id}/signup`, { method: 'POST', body: {} });
  await page.goto(`/#/e/${ev.id}`);
  await check(() => page.locator('#cancel').click(), page.locator('#cancel'));
  await expect(page.locator('#myStatusMsg')).toContainText('你已報名');
});
// 報名後焦點在「我的報名狀態」；記錄頁空白送出：錯誤綁在距離欄、aria-invalid、焦點移過去
test('報名後焦點在報名狀態；記錄訓練的錯誤標在欄位上', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: '無障礙 報名', date: plus(5), gather_time: '07:00', capacity: 10, notify: false } });
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto(`/#/e/${ev.id}`);
  await expect(page.locator('#signup')).toHaveAttribute('aria-describedby', /evWindow/);
  await page.locator('#signup').click();
  await expect(page.locator('#myStatusMsg')).toBeFocused();
  await expect(page.locator('#toasts .toast')).toContainText('報名完成');
  await page.goto('/#/log?extra=1');
  await page.locator('#lf').getByRole('button', { name: '儲存' }).click();
  await expect(page.locator('#lf [name=km]')).toBeFocused();
  await expect(page.locator('#lf [name=km]')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#lf [name=time]')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator(`#${await page.locator('#lf [name=km]').getAttribute('aria-describedby')}`)).toHaveText('填一下距離或時間');
  await page.locator('#lf [name=km]').fill('5');
  await expect(page.locator('#lf [name=km]')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#lf [name=rpe]')).toHaveAttribute('aria-valuetext', /5，/);
});
// 地圖：「跳到地點清單」在地圖前面；地圖針不在 Tab 順序；群集針有名稱
test('地圖：跳到地點清單、地圖針不進 Tab 順序', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('cil-map-view', '[25.03,121.53,11]'); } catch {} });
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/map');
  await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible();
  expect(await page.locator('.leaflet-marker-icon[tabindex="0"]').count()).toBe(0);
  expect(await page.evaluate(() => !!(document.querySelector('#skipList').compareDocumentPosition(document.querySelector('#map')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.locator('#skipList').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#spotQ')).toBeFocused();
  // 從清單打開地點卡：焦點到地點名稱；Esc 關掉、焦點回到同一列
  await page.locator('#spotList [data-open]').first().click();
  await expect(page.locator('#spotName')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#spotList [data-open]').first()).toBeFocused();
});
