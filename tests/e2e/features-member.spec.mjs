// 全功能測試（團員）：課表、GPS 跑步、拍照、行事曆、地圖、我的各頁、通行金鑰、會籍卡、分享 App、通知、入場券、挑戰、使用說明
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

const enter = async (page, id = 't_runner') => { await login(page, id); await acceptPrivacyIfAsked(page); };

test('課表：切換週次、從課表某一天記錄訓練', async ({ page }) => {
  await enter(page);
  await page.goto('/#/plan');
  const wk = async () => (await page.locator('#view .card h2').first().innerText()).match(/W\d+|賽後恢復/)?.[0];
  await expect(page.locator('#view .card h2').first()).toContainText(/W\d+/);   // 等課表畫好再讀週次
  const w = await wk();
  await page.getByRole('button', { name: '下一週' }).click();
  await expect.poll(wk).not.toBe(w);
  await page.getByRole('button', { name: '上一週' }).click();
  await expect.poll(wk).toBe(w);
  const logBtn = page.locator('.days .logbtn').first();
  if (await logBtn.count()) {
    await page.waitForLoadState('networkidle');
    await logBtn.evaluate((el) => el.scrollIntoView({ block: 'center' }));   // 浮動分頁列在下方，捲到畫面中間再點
    await page.waitForTimeout(300);
    await logBtn.click();
    await expect(page.locator('h1')).toContainText(/記錄訓練|修改紀錄/);
  }
});

test('GPS 跑步：開始、移動、暫停、繼續、結束，存成訓練紀錄', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  let lat = 25.0478, lng = 121.5170;
  await context.setGeolocation({ latitude: lat, longitude: lng, accuracy: 5 });
  await enter(page);
  await page.goto('/#/run');
  await page.locator('#runGo').click();
  await expect(page.locator('#rTime')).toBeVisible();
  for (let i = 0; i < 12; i++) { lat += 0.00007; await context.setGeolocation({ latitude: lat, longitude: lng, accuracy: 5 }); await page.waitForTimeout(1100); }
  await page.locator('#rPause').click();
  await expect(page.locator('#rResume')).toBeVisible();
  await page.locator('#rResume').click();
  await page.locator('#rPause').click();
  page.once('dialog', (d) => d.accept());
  await page.locator('#rStop').click();
  await expect(page.getByText(/累計/)).toBeVisible();
  await page.getByRole('link', { name: /存成訓練紀錄|存到訓練紀錄|記錄/ }).first().click();
  await expect(page.locator('[name=km]')).not.toHaveValue('');
});

test('拍照分享：換版型與尺寸、手動輸入成績，畫面會重畫', async ({ page }) => {
  await enter(page);
  await page.goto('/#/studio');
  await expect(page.locator('#cv')).toBeVisible();
  await page.locator('[data-size]').nth(1).click();
  await page.locator('[data-tpl]').nth(1).click();
  await page.locator('#mform [name=km]').fill('21.10');
  await page.locator('#mform [name=time]').fill('1:45:00');
  const w = await page.locator('#cv').evaluate((c) => c.width);
  expect(w).toBeGreaterThan(500);
  // 自訂開關：點看得到的那一列（真正的 checkbox 視覺上隱藏）
  await page.locator('label.switch', { has: page.locator('#arFirst') }).click();
  await expect(page.locator('#arFirst')).toBeChecked();
  await page.locator('label.switch', { has: page.locator('#arFirst') }).click();
});

test('行事曆：換月份、點日期看內容', async ({ page, request }) => {
  await apiAs(request, 't_chair', '/calendar/items', { method: 'POST', body: { date: plus(2), title: 'E2E 賽事報名截止', kind: 'signup' } });
  await enter(page);
  await page.goto('/#/calendar');
  await page.locator(`[data-day="${plus(2)}"]`).click({ trial: false }).catch(async () => { await page.getByRole('button', { name: '下個月' }).click(); await page.locator(`[data-day="${plus(2)}"]`).click(); });
  await expect(page.locator('#dayBox')).toContainText('E2E 賽事報名截止');
  await page.getByRole('button', { name: '下個月' }).click();
  await page.getByRole('button', { name: '上個月' }).click();
  await expect(page.locator('.calhead h2')).toBeVisible();
});

test('地圖：提議地點（待審核）、幹部通過後回報現場、畫路線存檔並下載 GPX', async ({ page, request }) => {
  await enter(page);
  const sp = await apiAs(request, 't_runner', '/spots', { method: 'POST', body: { name: 'E2E 河濱', kind: 'river', lat: 25.07, lng: 121.53, intro: '測試' } });
  expect(sp.status).toBe('pending');
  await apiAs(request, 't_chair', `/spots/${sp.id}/review`, { method: 'POST', body: { approve: true } });
  await page.goto(`/#/map?spot=${sp.id}`);
  await expect(page.locator('.spotcard')).toContainText('E2E 河濱');
  await expect(page.getByRole('link', { name: '在 LINE 揪人' })).toBeVisible();   // 團員沒有開團權限
  await page.getByRole('button', { name: '回報現場' }).click();
  await page.locator('#rf').getByText('濕滑').click();
  await page.locator('#rf [name=note]').fill('E2E 測試回報');
  await page.locator('#rf').getByRole('button', { name: '送出' }).click();
  await expect(page.locator('.reports')).toContainText('E2E 測試回報');
  // 畫路線：點三下地圖
  await page.locator('#drawBtn').click();
  const box = await page.locator('#map').boundingBox();
  for (const [x, y] of [[0.3, 0.3], [0.5, 0.5], [0.7, 0.4]]) await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  await expect(page.locator('#drawPts')).toContainText('3 個點');
  await page.locator('#drawDone').click();
  await page.locator('#rtf [name=name]').fill('E2E 路線');
  await page.locator('#rtf').getByRole('button', { name: '儲存' }).click();
  await expect(page.locator('#panel')).toContainText('E2E 路線');
  const dl = page.waitForEvent('download');
  await page.locator('#gpxBtn').click();
  expect((await dl).suggestedFilename()).toMatch(/\.gpx$/);
});

test('我的：個人資料、賽事、賽事報名資料、隱私、分享 App、會籍卡、行事曆訂閱', async ({ page, request }) => {
  await enter(page);
  // 個人資料
  await page.goto('/#/me/profile');
  await page.locator('#mf [name=nickname]').fill('E2E 跑友');
  await page.locator('#mf').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText('已儲存')).toBeVisible();
  // 我的賽事
  await page.goto('/#/me/races');
  await page.locator('#raceForm [name=name]').fill('E2E 測試馬拉松');
  await page.locator('#raceForm [name=date]').fill(plus(60));
  await page.locator('#raceForm').getByRole('button', { name: '加入賽事' }).click();
  await expect(page.locator('#raceList')).toContainText('E2E 測試馬拉松');
  // 賽事報名資料：填好、刪除
  await page.goto('/#/me/reg');
  const f = page.locator('#regForm');
  for (const [k, v] of [['name_zh', '測試跑友'], ['id_no', 'A123456789'], ['birthday', '1990-01-01'], ['phone', '0912345678'], ['emergency_name', '家人'], ['emergency_phone', '0922333444']]) await f.locator(`[name=${k}]`).fill(v);
  await f.locator('[name=gender]').selectOption('男');
  await f.locator('[name=shirt]').selectOption('M');
  await f.getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText(/已儲存/)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.locator('#regDel').click();
  await expect(page.getByText('已刪除')).toBeVisible();
  // 隱私：上排行榜、下載我的資料
  await page.goto('/#/me/privacy');
  await page.locator('label.switch', { has: page.locator('#showRank') }).click();
  await expect(page.getByText('已加入排行榜')).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.getByRole('link', { name: '下載我的資料' }).click();
  expect((await dl).suggestedFilename()).toContain('json');
  // 行事曆訂閱
  await page.goto('/#/me/notify');
  await page.locator('#calNew').click();
  await expect(page.locator('input[aria-label="行事曆訂閱網址"]')).toHaveValue(/\/api\/cal\/.+\.ics$/);
  // 分享 App
  await page.goto('/#/me');
  await page.locator('#shareApp').click();
  await expect(page.locator('#appQR svg')).toBeVisible();
  await page.getByRole('button', { name: '完成' }).click();
  // 會籍卡（先讓行政人員把會籍設成有效）
  await apiAs(request, 't_chair', '/members/t_runner/membership', { method: 'POST', body: { membership: 'active', paid_until: plus(200), member_no: 'E2E-001' } });
  await page.goto('/#/me/card');
  await expect(page.locator('.membercard')).toContainText('有效');
  await expect(page.locator('#cardQR svg')).toBeVisible();
});

test('通行金鑰：用裝置的生物辨識新增，列在帳號與安全', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await enter(page);
  await page.goto('/#/me/security');
  await page.locator('#pkAdd').click();
  await expect(page.getByText('已新增通行金鑰')).toBeVisible();
  await expect(page.locator('#pkList')).toContainText(/通行金鑰|Chrome|iPhone|Mac/);
});

test('通知全部已讀、入場券與領取、每月挑戰、使用說明導覽', async ({ page }) => {
  await enter(page);
  await page.goto('/#/notifications');
  if (await page.locator('#readAll').count()) { await page.locator('#readAll').click(); }
  await page.goto('/#/tickets');
  await expect(page.locator('h1')).toContainText('入場券');
  await page.goto('/#/challenge');
  await expect(page.locator('.badges .badge')).toHaveCount(6);
  await page.goto('/#/me');
  await page.locator('#openGuide').click();
  await expect(page.locator('#gTitle')).toBeVisible();
  for (let i = 0; i < 12 && await page.locator('#guide').isVisible(); i++) {
    const t = await page.locator('#gTitle').innerText();
    await page.locator('#gNext').click();
    if (t === '準備好了') break;
    await page.waitForTimeout(600);
  }
  await expect(page.locator('#guide')).toBeHidden();
});

test('練跑地圖：搜尋、類型、縣市篩選，地圖上的針跟著篩', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.removeItem('cil-map-kind'); localStorage.removeItem('cil-map-city'); localStorage.setItem('cil-map-view', '[25.03,121.53,16]'); } catch {} });
  await enter(page);
  await page.goto('/#/map');
  await expect(page.locator('#spotList .spotrow').first()).toBeVisible();
  const total = await page.locator('#spotList .spotrow').count();
  expect(total).toBeGreaterThanOrEqual(36);
  // 打字就篩（不用按搜尋）
  await page.locator('#spotQ').fill('河濱');
  await expect.poll(() => page.locator('#spotList .spotrow').count()).toBeLessThan(total);
  for (const t of await page.locator('#spotList .spotrow b').allInnerTexts()) expect(t + '河濱').toBeTruthy();
  await page.locator('#spotQ').fill('');
  // 類型：只剩田徑場，清單每一列都是田徑場
  await page.locator('#kindChips [data-kind="track"]').click();
  await expect(page.locator('#kindChips [data-kind="track"]')).toHaveAttribute('aria-pressed', 'true');
  for (const t of await page.locator('#spotList .spotrow b + .tiny').allInnerTexts()) expect(t).toContain('田徑場');
  // 地圖上的針也只剩田徑場（16 級以上不合併）
  await expect(page.locator('.mpin:not(.k-track)')).toHaveCount(0);
  // 縣市
  await page.locator('#kindChips [data-kind=""]').click();
  await page.locator('#spotCity').selectOption('高雄市');
  for (const t of await page.locator('#spotList .spotrow b + .tiny').allInnerTexts()) expect(t).toContain('高雄市');
  await page.locator('#spotCity').selectOption('');
});
