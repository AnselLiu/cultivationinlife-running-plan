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
  // 即時搜尋：打字就出結果，不用按「搜尋」
  await page.locator('#roleSearch [name=q]').fill('路人');
  await page.locator('#roleList [data-role]').first().click();
  await page.locator('#rf [name=role]').selectOption('coach');
  await page.locator('#rf').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText(/已更新/)).toBeVisible();
  await expect(page.locator('.seg [aria-pressed="true"]')).toHaveText('權限');
  // 存檔後權限分頁會重畫：等新的搜尋框出來（名單是空的）再打字
  await expect(page.locator('#panel')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#roleList [data-role]')).toHaveCount(0);
  await page.locator('#roleSearch [name=q]').fill('路人');
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

test('管理後台：切換每個分頁不會整頁跳動；離開後點下方分頁列不會被拉回管理後台', async ({ page }) => {
  await enter(page, 't_chair');
  await page.goto('/#/admin');
  await expect(page.locator('.adminseg')).toBeVisible();
  for (const name of ['會員', '權限', '分團', '活動', '系統設定', '稽核', '總覽']) {
    const title = await page.locator('#view h1').elementHandle();
    await page.locator('.adminseg').getByRole('button', { name }).click();
    await expect(page.locator('.adminseg [aria-pressed="true"]')).toHaveText(name);
    await expect(page.locator('#panel')).not.toHaveAttribute('aria-busy', 'true');
    expect(await title.evaluate((el) => el.isConnected), '標題與分頁列沒有重畫').toBe(true);
  }
  // 以前分頁按鈕的點擊會綁到下方分頁列，離開後每點一次都會被拉回管理後台
  await page.locator('.tabs a[data-tab="/plan"]').click();
  await expect(page).toHaveURL(/#\/plan$/);
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.locator('#view h1')).toContainText('課表');
  await expect(page.locator('.tabs a[data-tab="/plan"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('.tabs a[data-tab="/me"]').click();
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/#\/me$/);
  await expect(page.locator('.adminseg')).toHaveCount(0);
});

test('新舊版本混在一起（新模組要的東西舊主程式沒有）：自動重新載入一次就恢復', async ({ page }) => {
  await enter(page, 't_chair');
  // 第一次載入 admin.js 時，模擬新版模組：多 import 一個舊版 app.js 沒有的名稱
  let first = true;
  await page.route(/\/admin\.js(\?.*)?$/, async (route) => {
    if (!first) return route.continue();
    first = false;
    const body = (await (await route.fetch()).text()).replace("import { $,", "import { 不存在的新功能, $,");
    await route.fulfill({ body, contentType: 'text/javascript' });
  });
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await page.goto('/#/admin');   // 只換 #，不會重新載入頁面
  await expect(page.locator('.adminseg')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#view')).not.toContainText('Importing binding');
  expect(first).toBe(false);
  expect(loads, '有自動重新載入一次').toBe(1);
});

test('群發：標題用了系統安全通知的保留字會就近顯示錯誤；預覽是紫色「協會公告」', async ({ page }) => {
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/admin?tab=overview');
  await page.locator('#bcForm [name=title]').fill('通行金鑰更新提醒');
  await expect(page.locator('#bcPreview .nitem.n-announce')).toBeVisible();
  await expect(page.locator('#bcPreview')).toContainText('協會公告');
  await page.locator('#bcCount').click();
  await expect(page.locator('#bcOut')).toContainText('這個標題保留給系統安全通知');
});

test('活動報名預設：設定活動前 7 天 20:00，預覽跟著更新', async ({ page, request }) => {
  await enter(page, 't_chair');
  await page.goto('/#/admin?tab=settings');
  const f = page.locator('#signupDefForm');
  const before = await page.locator('#sdPreview').innerText();
  await f.locator('[name=open_days]').selectOption('7');
  await f.locator('[name=open_time]').fill('20:00');
  await expect(page.locator('#sdPreview')).not.toHaveText(before);
  await expect(page.locator('#sdPreview')).toContainText('20:00 開放');
  await f.getByRole('button', { name: '儲存報名預設' }).click();
  await expect(page.getByText('已儲存活動報名預設')).toBeVisible();
  await apiAs(request, 't_chair', '/settings/signup', { method: 'POST', body: { approval: false, notify: true, open_days: null, close_days: null } });
});

test('系統設定：休息站資料來源，只由維護工具同步的來源沒有「立即同步」，顯示上次同步的時間；小來源有按鈕', async ({ page, request }) => {
  await request.get('/api/dev/rest-sync?source=twd');   // 代替維護工具寫入（REST_MOCK 不連外）
  await enter(page, 't_chair');
  await page.goto('/#/admin?tab=settings');
  const row = (k) => page.locator('#restSrcList .camsrc').filter({ has: page.locator(`[data-restsrc="${k}"]`) });
  await expect(row('twd')).toContainText('由維護工具同步');
  await expect(row('twd')).toContainText('上次同步');
  for (const k of ['twd', 'tpt', 'tprv', 'cpct', 'sav', 'tbk']) await expect(row(k).locator('[data-restsync]')).toHaveCount(0);
  await expect(row('tpbk').locator('[data-restsync="tpbk"]')).toBeVisible();
  await expect(row('ntrv').locator('[data-restsync="ntrv"]')).toBeVisible();
});
