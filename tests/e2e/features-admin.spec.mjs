// 全功能測試（管理後台）：總覽與待審核、會員查詢、指派身分、重設通行金鑰並登出、分團、系統設定、備份、稽核、名冊
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked, BASE } from './helpers.mjs';
import { maskName } from '../../src/referral.js';

const enter = async (page, id, opt) => { await login(page, id, opt); await acceptPrivacyIfAsked(page); };

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
  await page.locator('.sheet button[data-close]').click();
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

test('權限：「安全」重設通行金鑰並登出（看數字、焦點在取消、沒綁 Google 的警告與姓名確認、填原因、重設後提示），對方的登入失效', async ({ page, request }) => {
  // 要重設的跑友：邀請碼加入（一個登入中的裝置、沒有通行金鑰、沒綁 Google）
  const name = `安全測試${Date.now().toString(36).slice(-4)}`;
  const j = await request.post('/api/join', { headers: { origin: BASE, 'content-type': 'application/json' }, data: JSON.stringify({ code: 'test-join', name, consent: true }) });
  expect(j.status()).toBe(200);
  const cookie = j.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('__Host-cil_sess=')).value.split(';')[0];
  // 理事長：剛用通行金鑰驗證過（重設要 15 分鐘內驗證過）
  await enter(page, 't_chair', { mfa: true });
  await page.goto('/#/admin?tab=roles');
  await expect(page.locator('#panel [data-sec="t_coach"]')).toHaveCount(1);
  await expect(page.locator('#panel [data-sec="t_chair"]')).toHaveCount(0);   // 自己的在「帳號與安全」
  await page.locator('#roleSearch [name=q]').fill(name);
  const btn = page.locator('#roleList [data-sec]').first();
  await expect(btn).toHaveAccessibleName(new RegExp(`^安全\\s*：${name}$`));   // VoiceOver 讀得出是誰的
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), '一列兩顆按鈕也不超出手機畫面').toBeLessThanOrEqual(0);
  await btn.click();
  const sheet = page.getByRole('dialog', { name: '重設通行金鑰並登出' });
  await expect(sheet.locator('#secN')).toHaveText('通行金鑰 0 把・登入中的裝置 1 個');
  await expect(sheet.locator('#secG')).toBeHidden();   // 沒綁 Google：沒有「解除 Google」
  await expect(sheet.getByRole('button', { name: '取消' })).toBeFocused();   // 危險操作：焦點先在安全的那一顆
  // 沒綁 Google：重設後沒有登入方式（要用恢復連結接回）→ 紅色警告、要輸入姓名，「用 Google 重新登入」的說明不顯示
  await expect(sheet.locator('#secL')).toBeVisible();
  await expect(sheet.locator('#secL')).toContainText('重設後本人沒有登入方式');
  await expect(sheet.locator('#secL')).toContainText('會產生一個恢復連結');
  await expect(sheet.locator('#secOk')).toBeHidden();
  const confirm = sheet.getByRole('textbox', { name: new RegExp(`^輸入「\\s*${name}\\s*」確認$`) });
  await expect(confirm).toHaveAttribute('required', '');
  await sheet.getByLabel('原因（選填）').fill('手機遺失');
  await confirm.fill('不是這個名字');
  await sheet.getByRole('button', { name: '重設並登出' }).click();
  await expect(page.locator('.toast')).toHaveText('請輸入對方的姓名確認');   // 伺服器也檢查
  await expect(confirm).toBeFocused();
  expect((await (await request.get('/api/me', { headers: { cookie } })).json()).member, '還沒重設').not.toBeNull();
  await confirm.fill(name);
  await sheet.getByRole('button', { name: '重設並登出' }).click();
  await expect(page.locator('.toast')).toHaveText(`已重設通行金鑰並登出所有裝置：${name}`);
  await expect(page.locator('.toast [translate="no"]')).toHaveText(name);   // 英文介面名字不會被拆開翻譯
  // 沒有登入方式：面板換成恢復連結（只顯示這一次）；點背景不關（手指不小心碰到），還沒複製也沒傳出去就按「完成」或 Esc 先確認
  const panel = page.getByRole('dialog', { name: '恢復連結' });
  await expect(panel.locator('#recT')).toBeFocused();
  await page.locator('.sheet-bg').click({ position: { x: 5, y: 5 } });
  await expect(panel).toHaveCount(1);
  const asked = [];
  page.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
  await page.keyboard.press('Escape');
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toBe('連結還沒複製或傳出，關掉後就看不到了，確定關閉？');
  await expect(panel).toHaveCount(1);   // 按了取消：留著
  page.once('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await panel.getByRole('button', { name: '完成' }).click();
  await expect(panel).toHaveCount(0);
  expect(asked.length).toBe(2);
  await expect(page.locator('#roleSearch [name=q]')).toBeFocused();   // 重畫後焦點回到搜尋框
  const me = await (await request.get('/api/me', { headers: { cookie } })).json();
  expect(me.member).toBeNull();
});

test('權限：幹部第一把通行金鑰的通知直接打開「安全」（已勾解除 Google、警告與姓名確認），取消不重設', async ({ page, request }) => {
  // 綁了 Google 的跑友（模擬那位幹部；通知的網址 #/admin?tab=roles&sec=<id>&g=1）
  const gname = `谷歌測試${Date.now().toString(36).slice(-4)}`;
  const g = await request.get(`/api/dev/google?${new URLSearchParams({ sub: `e2e_sec_${Date.now()}`, name: gname })}`, { maxRedirects: 0 });
  const gc = g.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('__Host-cil_sess=')).value.split(';')[0];
  const gid = (await (await request.get('/api/me', { headers: { cookie: gc } })).json()).member.id;
  await enter(page, 't_chair', { mfa: true });
  await page.goto(`/#/admin?tab=roles&sec=${gid}&g=1`);
  const sheet = page.getByRole('dialog', { name: '重設通行金鑰並登出' });
  await expect(sheet.locator('#secN')).toHaveText('通行金鑰 0 把・登入中的裝置 1 個・已綁 Google');
  await expect(sheet.locator('#secWho')).toHaveText(gname);   // 不在名單上也有名字（伺服器給的）
  await expect(page).toHaveURL(/#\/admin\?tab=roles$/);   // 參數拿掉，重新整理不會再跳出來
  const unlink = sheet.getByRole('checkbox', { name: /同時解除 Google 綁定/ });
  await expect(unlink).toBeChecked();
  await expect(sheet.locator('#secL')).toBeVisible();   // 解除後沒有登入方式：警告與姓名確認
  await expect(sheet.getByRole('textbox', { name: new RegExp(`^輸入「\\s*${gname}\\s*」確認$`) })).toBeVisible();
  await expect(sheet.getByRole('button', { name: '重設並登出' })).toBeEnabled();
  // 不勾：還能用 Google 重新登入，不用輸入姓名
  await unlink.uncheck();
  await expect(sheet.locator('#secL')).toBeHidden();
  await expect(sheet.locator('#secOk')).toHaveText('之後本人用已綁定的 Google 重新登入，再新增通行金鑰。');
  await sheet.getByRole('button', { name: '取消' }).click();
  await expect(sheet).toHaveCount(0);
  expect((await (await request.get('/api/me', { headers: { cookie: gc } })).json()).member.id, '取消：沒有重設').toBe(gid);
});

test('恢復連結：「安全」解除 Google 並重設 → 恢復連結（複製、用 LINE 傳給本人、關掉不再顯示）→ 本人沒登入打開連結看到遮過的名字（LINE 裡只給「用瀏覽器開啟」）→ 用 Google 接回原本的帳號，到帳號與安全新增通行金鑰', async ({ page, request, browser }) => {
  const gname = `恢復測試${Date.now().toString(36).slice(-4)}`, sub = `e2e_rec_${Date.now()}`;
  const g = await request.get(`/api/dev/google?${new URLSearchParams({ sub, name: gname })}`, { maxRedirects: 0 });
  const gc = g.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('__Host-cil_sess=')).value.split(';')[0];
  const gid = (await (await request.get('/api/me', { headers: { cookie: gc } })).json()).member.id;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await enter(page, 't_chair', { mfa: true });
  await page.goto(`/#/admin?tab=roles&sec=${gid}&g=1`);
  const sheet = page.getByRole('dialog', { name: '重設通行金鑰並登出' });
  await expect(sheet.locator('#secN')).toHaveText('通行金鑰 0 把・登入中的裝置 1 個・已綁 Google');
  await expect(sheet.getByRole('checkbox', { name: /同時解除 Google 綁定/ })).toBeChecked();
  await expect(sheet.locator('#secL')).toContainText('會產生一個恢復連結（24 小時內有效，只能用一次）');
  await expect(sheet.getByRole('button', { name: '產生恢復連結' })).toBeEnabled();   // 不重設、只產生連結的另一顆
  await sheet.getByRole('textbox', { name: new RegExp(`^輸入「\\s*${gname}\\s*」確認$`) }).fill(gname);
  await sheet.getByRole('button', { name: '重設並登出' }).click();
  // 恢復連結（只有這一次）：唯讀的網址、複製、用 LINE 傳給本人、提醒不要貼到群組
  const panel = page.getByRole('dialog', { name: '恢復連結' });
  await expect(panel.locator('#recT')).toBeFocused();
  const field = panel.getByRole('textbox', { name: '恢復連結（24 小時內有效，只能用一次）' });
  await expect(field).toHaveAttribute('readonly', '');
  // 代碼在 # 後面（不會送到伺服器）；openExternalBrowser=1 讓 LINE 直接用 Safari／Chrome 打開
  const url = await field.inputValue(), token = url.split('#/recover/')[1];
  expect(url).toMatch(/^https?:\/\/localhost:\d+\/\?openExternalBrowser=1#\/recover\/[\w-]{43}$/);
  await expect(panel.locator('#recWarn')).toHaveText('請私訊給本人，不要貼到群組；拿到連結的人可以登入這個帳號');
  await expect(field).toHaveAccessibleDescription('請私訊給本人，不要貼到群組；拿到連結的人可以登入這個帳號');
  const copyBtn = panel.getByRole('button', { name: '複製' }), line = panel.getByRole('link', { name: '用 LINE 傳給本人' }), done = panel.getByRole('button', { name: '完成' });
  await copyBtn.click();
  await expect(page.locator('#toasts .toast').last()).toHaveText('已複製');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  const href = await line.getAttribute('href');
  expect(href.startsWith('https://line.me/R/share?text=')).toBe(true);
  expect(decodeURIComponent(href.slice('https://line.me/R/share?text='.length))).toContain(url);
  await expect(line).toHaveAttribute('target', '_blank');
  for (const b of [copyBtn, line, done]) expect((await b.boundingBox()).height, '按鈕至少 44 點').toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), '不超出手機畫面').toBeLessThanOrEqual(0);
  const bad = (await new AxeBuilder({ page }).include('.sheet').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations.filter((v) => ['critical', 'serious'].includes(v.impact));
  expect(bad.map((v) => v.id)).toEqual([]);
  await done.click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('#recUrl')).toHaveCount(0);   // 關掉之後不會再顯示
  // 已經登入別的帳號（這裡是理事長）打開：提醒接回後這台裝置會改成登入原本的帳號
  await page.goto(url);
  await expect(page.locator('#recOther')).toContainText('你目前登入的是「測試理事長」；接回後這台裝置會改成登入原本的帳號');
  // 本人：沒登入的瀏覽器打開連結（/?openExternalBrowser=1#/recover/<代碼>）→ 看到遮過的名字；Safari／Chrome 馬上把代碼從網址拿掉（只留在這個分頁的 sessionStorage）
  await page.context().clearCookies();
  await page.goto('/#/');
  await page.goto(url);
  await expect(page.locator('#recT')).toHaveText(`恢復帳號：${maskName(gname)}`);
  await expect(page).toHaveURL(/\/#\/recover$/);
  expect(page.url()).not.toContain(token);
  await expect(page.locator('#recOther')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('cil-recover'))).toBe(token);
  await expect(page.locator('#recCard')).toContainText('24 小時內有效，只能用一次。');
  await expect(page.getByRole('button', { name: '改用通行金鑰' })).toBeVisible();
  expect((await page.getByRole('button', { name: '改用通行金鑰' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const bad2 = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations.filter((v) => ['critical', 'serious'].includes(v.impact));
  expect(bad2.map((v) => v.id)).toEqual([]);
  // LINE 的內建瀏覽器：Google 與通行金鑰都不能用，只給「用瀏覽器開啟」（同一個連結）；代碼留在網址裡（用 LINE 選單的「在瀏覽器開啟」也跟著走）
  const lineCtx = await browser.newContext({ userAgent: `${await page.evaluate(() => navigator.userAgent)} Line/14.13.0`, serviceWorkers: 'block', locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: page.viewportSize() });
  const lp = await lineCtx.newPage();
  await lp.goto(url);
  await expect(lp.locator('#recT')).toHaveText(`恢復帳號：${maskName(gname)}`);
  expect(lp.url()).toBe(url);
  await expect(lp.getByRole('link', { name: '用瀏覽器開啟' })).toHaveAttribute('href', url);
  await expect(lp.getByRole('button', { name: '改用通行金鑰' })).toHaveCount(0);
  expect((await lp.getByRole('link', { name: '用瀏覽器開啟' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
  await lineCtx.close();
  // e2e 伺服器沒有設定 Google（沒有 Google 按鈕）：用 /api/dev/google 模擬 Google 回來，換成另一個 Google 帳號
  await expect(page.locator('#recG')).toHaveCount(0);
  await page.goto(`/api/dev/google?${new URLSearchParams({ sub: `${sub}_new`, name: '新的 Google', recover: token })}`);
  await page.waitForURL(/#\/me\/security\?recovered=1$/);
  const card = page.locator('#pkOk');
  await expect(card.locator('h2')).toHaveText('帳號已恢復，請新增通行金鑰');
  await expect(card.locator('h2')).toBeFocused();
  await expect(card.getByRole('button', { name: '新增通行金鑰' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('cil-recover')), '代碼用完就清掉').toBeNull();
  expect((await (await page.request.get('/api/me')).json()).member.id, '接回原本的帳號').toBe(gid);
  // 連結只能用一次：再打開是「無效或已過期」；已經登入了，給「帳號與安全」，不叫他再找理事長
  await page.goto(url);
  await expect(page.locator('#view .notice.err')).toHaveText('這個恢復連結無效或已過期。');
  await expect(page.locator('#view')).toContainText(`你目前登入的是「${gname}」。這就是你的帳號的話，不用再恢復。`);
  await expect(page.getByRole('link', { name: '帳號與安全' })).toBeVisible();
  // 沒登入：說明已經接回的直接登入就好
  await page.context().clearCookies();
  await page.goto('/#/');
  await page.goto(url);
  await expect(page.locator('#view .notice.err')).toHaveText('這個恢復連結無效或已過期，請聯絡理事長重新產生');
  await expect(page.locator('#view')).toContainText('已經接回帳號的話，直接用 Google 或通行金鑰登入就可以。');
});

test('系統設定：功能開關、分頁名稱、立即備份；稽核查詢與完整性檢查；名冊查詢', async ({ page }) => {
  await enter(page, 't_chair');
  // 系統設定是清單：每一列的副標是目前的值，點進去才是表單（#/admin/settings/<段>）
  await page.goto('/#/admin?tab=settings');
  await expect(page.locator('#panel .setgroup .sgt')).toHaveText(['活動與報名', '協會', '地圖資料', '功能與畫面', '安全與隱私']);
  await page.locator('#panel a[href="#/admin/settings/tabs"]').click();
  await expect(page.locator('#view h1')).toHaveText('分頁列名稱');
  await expect(page.locator('#backLabel')).toHaveText('管理後台');
  await page.locator('#tabsForm [name=home]').fill('揪跑');
  await page.locator('#tabsForm').getByRole('button').click();
  await expect(page.locator('.tabs')).toContainText('揪跑');
  await page.locator('#tabsForm [name=home]').fill('');
  await page.locator('#tabsForm').getByRole('button').click();
  // 從「我的 → 系統設定」捷徑兩下就到控制項
  await page.goto('/#/me');
  await page.locator('#view a[href="#/admin/settings"]').click();
  await expect(page.locator('#view h1')).toHaveText('系統設定');   // 大標題跟點的那一列同名
  await page.locator('#view a[href="#/admin/settings/backup"]').click();
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
  for (const name of ['會員', '權限', '分團', '活動', '設定', '稽核', '總覽']) {
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
  await page.goto('/#/admin/settings/signup');
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
  await page.goto('/#/admin/settings/rest');
  const row = (k) => page.locator('#restSrcList .camsrc').filter({ has: page.locator(`[data-restsrc="${k}"]`) });
  await expect(row('twd')).toContainText('由維護工具同步');
  await expect(row('twd')).toContainText('上次同步');
  for (const k of ['twd', 'tpt', 'tprv', 'cpct', 'sav', 'tbk']) await expect(row(k).locator('[data-restsync]')).toHaveCount(0);
  await expect(row('tpbk').locator('[data-restsync="tpbk"]')).toBeVisible();
  await expect(row('ntrv').locator('[data-restsync="ntrv"]')).toBeVisible();
});

test('系統設定：協會資訊拆成三張表單，各自儲存不會清掉其他欄位', async ({ page, request }) => {
  await enter(page, 't_chair');
  const before = (await apiAs(request, 't_chair', '/me')).settings.org;
  await page.goto('/#/admin/settings/training');
  await page.locator('#venueForm [name=thu_venue]').fill('E2E 田徑場');
  await page.locator('#venueForm').getByRole('button', { name: '儲存團練地點' }).click();
  await expect(page.getByText('已儲存團練地點')).toBeVisible();
  await page.goto('/#/admin/settings/retention');
  await page.locator('#retForm [name=log_years]').selectOption('2');
  await page.locator('#retForm').getByRole('button', { name: '儲存保存期限' }).click();
  await expect(page.getByText('已儲存保存期限')).toBeVisible();
  const after = (await apiAs(request, 't_chair', '/me')).settings.org;
  expect(after.name).toBe(before.name);
  expect(after.contact).toBe(before.contact);
  expect(after.thu_venue).toBe('E2E 田徑場');
  expect(after.log_years).toBe(2);
  await apiAs(request, 't_chair', '/settings/org', { method: 'POST', body: { thu_venue: before.thu_venue || '', log_years: before.log_years || 0 } });
});
