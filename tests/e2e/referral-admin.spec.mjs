// 推薦族譜（管理後台 #/admin/tree）：會員分頁的入口列、搜尋 → 以某位跑友為中心（往上推薦人、往下推薦的跑友）、
//   只填名字的一群人 → 「連到跑友帳號」面板（焦點鎖在面板裡、Esc 關閉、焦點回到按鈕）、監事只能看、功能開關的「會員」分組、
//   淺色深色 375px 沒有嚴重的無障礙問題也不水平捲動；功能關閉時沒有入口列，但頁面照樣能開
//   workers = 1：功能開關一次只有這個檔案在改；結束時一定關回去、清掉測試填的推薦人
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked } from './helpers.mjs';

const enter = async (page, id) => { await login(page, id); await acceptPrivacyIfAsked(page); };
const setReferral = async (request, on) => {
  const f = (await apiAs(request, 't_chair', '/me')).settings?.features || {};
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { ...f, referral: on } });
};
const axeBad = async (page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations
  .filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const search = async (page, q) => {
  await page.locator('#rtForm [name=q]').fill(q);
  await page.locator('#rtForm').getByRole('button', { name: '搜尋' }).click();
};

test.describe.serial('推薦族譜：功能打開', () => {
  test.beforeAll(async ({ request }) => {
    await setReferral(request, true);
    // 測試跑友先只填名字，再由理事長連到測試團長的帳號（不用 Gmail 也能有「帳號推薦人」）；路人跑友只填名字「王大明」
    await apiAs(request, 't_runner', '/me/referral', { method: 'PUT', body: { name: 'E2E推薦甲' } });
    const r = await apiAs(request, 't_chair', '/admin/referrals/relink', { method: 'POST', body: { name: 'E2E推薦甲', to: 't_lead' } });
    expect(r.linked).toBe(1);
    await apiAs(request, 't_other', '/me/referral', { method: 'PUT', body: { name: '王大明' } });
  });
  test.afterAll(async ({ request }) => {
    try { for (const id of ['t_runner', 't_other']) await apiAs(request, id, '/me/referral', { method: 'DELETE' }); }
    finally { await setReferral(request, false); }
  });

  test('理事長：會員分頁的入口 → 搜尋 → 以推薦人為中心，往下看到推薦的跑友；往上看到推薦人', async ({ page }) => {
    await enter(page, 't_chair');
    await page.goto('/#/admin?tab=members');
    await page.locator('#panel a.setrow[href="#/admin/tree"]').click();
    await expect(page).toHaveURL(/#\/admin\/tree$/);
    await expect(page.locator('#view h1')).toHaveText('推薦族譜');
    await expect(page.locator('#rtHint')).toContainText('不會一次列出所有人');
    await search(page, '測試');
    const lead = page.locator('#rtOut button[data-fid="t_lead"]');
    await expect(lead).toContainText(/推薦了 \d+ 位/);
    await lead.click();
    await expect(page).toHaveURL(/#\/admin\/tree\?id=t_lead$/);
    await expect(page.locator('#rtFocusH')).toBeFocused();
    await expect(page.locator('#rtFocusH')).toContainText('測試團長');
    await expect(page.locator('.reftree')).toContainText('測試跑友');
    // 以測試跑友為中心：往上第 1 層是測試團長，由管理員設定，可以移除
    await page.goto('/#/admin/tree?id=t_runner');
    await expect(page.locator('.refup')).toContainText('測試團長');
    await expect(page.locator('.refup .pill').first()).toHaveText('第 1 層');
    await expect(page.locator('#rtOut .reffocus')).toContainText('由管理員設定');
    await expect(page.locator('#rtClear')).toBeVisible();
    await expect(page.locator('#rtRelinkOne')).toHaveCount(0);   // 推薦人是帳號，不是只填名字
    // 往上那一列點了以他為中心
    await page.locator('.refup button[data-fid="t_lead"]').click();
    await expect(page).toHaveURL(/id=t_lead$/);
  });

  test('只填名字：搜尋名字 → 這群跑友 → 「連到跑友帳號」面板（焦點鎖在面板裡、Esc 關閉）', async ({ page }) => {
    await enter(page, 't_chair');
    await page.goto('/#/admin/tree');
    await search(page, '王大明');
    const grp = page.locator('#rtOut button[data-fname="王大明"]');
    await expect(grp).toContainText(/\d+ 位跑友填了這個名字/);
    await grp.click();
    await expect(page).toHaveURL(/#\/admin\/tree\?name=/);
    await expect(page.locator('#rtNameH')).toContainText('王大明');
    await expect(page.locator('#rtOut')).toContainText('路人跑友');
    await expect(page.locator('#rtOut [data-nid="t_other"]')).toBeChecked();
    const open = page.locator('#rtRelink');
    await open.click();
    const sheet = page.getByRole('dialog', { name: '連到跑友帳號' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[name=q]')).toBeFocused();
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.sheet'))).toBe(true);
    // 選一位才有確認文字、才能按「連結」（這裡不真的連，Esc 關掉）
    await expect(sheet.locator('#rlGo')).toBeDisabled();
    await sheet.locator('[name=q]').fill('測試團長');
    await sheet.locator('#rlF').getByRole('button', { name: '搜尋' }).click();
    await sheet.locator('input[name=rlTo][value="t_lead"]').check();
    await expect(sheet.locator('#rlMsg')).toContainText('對方會收到通知');
    await expect(sheet.locator('#rlGo')).toBeEnabled();
    expect(await axeBad(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test('監事：同一頁只能看，沒有「連到跑友帳號」與「移除推薦人」', async ({ page }) => {
    await enter(page, 't_super');
    await page.goto('/#/admin/tree?id=t_runner');
    await expect(page.locator('#view')).toContainText('監事只能查看。');
    await expect(page.locator('#rtOut .reffocus')).toContainText('測試跑友');
    await expect(page.locator('#rtClear, #rtRelinkOne')).toHaveCount(0);
    await page.goto(`/#/admin/tree?name=${encodeURIComponent('王大明')}`);
    await expect(page.locator('#rtNameH')).toContainText('王大明');
    await expect(page.locator('#rtRelink, [data-nid]')).toHaveCount(0);
  });

  test('功能開關：「會員」分組有推薦人，而且是打開的', async ({ page }) => {
    await enter(page, 't_chair');
    await page.goto('/#/admin/settings/features');
    const grp = page.locator('fieldset.featgrp', { has: page.locator('legend', { hasText: /^會員$/ }) });
    await expect(grp).toContainText('推薦人（跑友填介紹人、推薦族譜）');
    await expect(grp.locator('input[name=referral]')).toBeChecked();
  });

  for (const scheme of ['light', 'dark']) test(`無障礙：以人為中心、只填名字（375px，${scheme}）`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await enter(page, 't_chair');
    for (const [p, sel] of [['#/admin/tree?id=t_lead', '#rtFocusH'], ['#/admin/tree?id=t_runner', '#rtFocusH'], [`#/admin/tree?name=${encodeURIComponent('王大明')}`, '#rtNameH']]) {
      await page.goto(`/${p}`);
      await expect(page.locator(sel)).toBeVisible();
      expect(await axeBad(page), p).toEqual([]);
      expect(await noHScroll(page), `${p} 水平捲動`).toBe(true);
    }
  });
});

// 功能關閉（預設）：會員分頁沒有入口列；已經填的資料可能還在，所以頁面照樣能開
for (const scheme of ['light', 'dark']) test(`推薦族譜：功能關閉時沒有入口列，頁面照樣能開（375px，${scheme}）`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 375, height: 812 });
  await enter(page, 't_chair');
  await page.goto('/#/admin?tab=members');
  await expect(page.locator('#mf2')).toBeVisible();
  await expect(page.locator('a.setrow[href="#/admin/tree"]')).toHaveCount(0);
  for (const [p, sel] of [['#/admin/tree', '#rtForm'], ['#/admin/tree?id=t_chair', '#rtFocusH']]) {
    await page.goto(`/${p}`);
    await expect(page.locator(sel)).toBeVisible();
    expect(await axeBad(page), p).toEqual([]);
    expect(await noHScroll(page), `${p} 水平捲動`).toBe(true);
  }
});
