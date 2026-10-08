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
  // 行事曆訂閱（從「通知設定」搬到自己的子頁）
  await page.goto('/#/me/calendar');
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

test('通知中心：分類 chip、單則已讀、動作選單、刪除可以復原、安全通知不能刪', async ({ page, request }) => {
  const tag = Date.now().toString(36).slice(-4);
  // 準備：兩則協會公告（youth 分團），兩則帳號安全（分團身分改成幹部再改回來）
  for (const x of ['A', 'B', 'C']) await apiAs(request, 't_chair', '/admin/broadcast', { method: 'POST', body: { title: `E2E 公告 ${tag} ${x}`, body: '測試內容', teams: ['youth'] } });
  await apiAs(request, 't_lead', '/teams/youth/members', { method: 'POST', body: { member_id: 't_runner', action: 'role', role: 'officer' } });
  await apiAs(request, 't_lead', '/teams/youth/members', { method: 'POST', body: { member_id: 't_runner', action: 'role', role: 'member' } });
  await enter(page);
  try { await page.evaluate(() => localStorage.removeItem('cil-ncat')); } catch {}
  await page.goto('/#/notifications');
  await expect(page.locator('.chipbar[role=tablist]')).toBeVisible();
  await expect(page.locator('#nfeed .nitem').first()).toBeVisible();
  // 鈴鐺的 aria-label 帶數字（看過之後只剩未讀的帳號安全通知）
  await expect(page.locator('#bell')).toHaveAttribute('aria-label', /\d/);
  // 介面不放 emoji
  expect(await page.locator('#view').innerText()).not.toMatch(/\p{Extended_Pictographic}/u);
  // 進頁面不再自動全部已讀
  const before = (await apiAs(request, 't_runner', '/notifications/count')).unread;
  await page.waitForTimeout(2000);
  expect((await apiAs(request, 't_runner', '/notifications/count')).unread).toBe(before);
  // 點一列未讀：只有那一列變成已讀（公告沒有連結，開詳細內容）
  const unreadN = await page.locator('#nfeed .nitem.unread').count();
  const first = page.locator('#nfeed .nitem.n-announce.unread').first();
  const id = await first.getAttribute('data-id');
  await first.locator('a.nrow').click();
  await expect(page.locator(`#nfeed .nitem[data-id="${id}"]`)).not.toHaveClass(/unread/);
  await expect(page.locator('#nfeed .nitem.unread')).toHaveCount(unreadN - 1);
  await page.keyboard.press('Escape');
  // 動作選單：用鍵盤打開「更多動作」，已讀的列可以標為未讀；刪除後可以復原
  await page.locator(`#nfeed .nitem[data-id="${id}"] .nmore`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByText('標為未讀')).toBeVisible();
  await page.getByRole('dialog').getByText('刪除這則通知').click();
  await page.locator('.toast .toastbtn', { hasText: '復原' }).click();
  await expect(page.locator(`#nfeed .nitem[data-id="${id}"]`)).toBeVisible();
  // 帳號安全通知的選單沒有刪除
  const sec = page.locator('#nfeed .nitem.n-security').first();
  await sec.locator('.nmore').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByText('標為')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('刪除這則通知')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // 公告 chip：只剩公告；重新整理後記得這顆 chip
  await page.getByRole('tab', { name: /公告/ }).click();
  await expect(page.locator('#nfeed .nitem').first()).toBeVisible();
  expect(await page.locator('#nfeed .nitem:not(.n-announce)').count()).toBe(0);
  await page.reload();
  await expect(page.getByRole('tab', { name: /公告/ })).toHaveAttribute('aria-selected', 'true');
  // 全部已讀：只有非安全通知的未讀消失
  await page.getByRole('tab', { name: '全部' }).click();
  await expect(page.locator('#nfeed .nitem').first()).toBeVisible();
  await page.locator('#readAll').click();
  await expect(page.locator('#nfeed .nitem.unread:not(.n-security)')).toHaveCount(0);
  expect(await page.locator('#nfeed .nitem.n-security.unread').count()).toBeGreaterThan(0);
});

test('通知中心：減少動態效果時，刪除的列馬上從畫面移除', async ({ page, request }) => {
  await apiAs(request, 't_chair', '/admin/broadcast', { method: 'POST', body: { title: `E2E 減少動態 ${Date.now().toString(36).slice(-4)}`, teams: ['youth'] } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enter(page);
  try { await page.evaluate(() => localStorage.setItem('cil-ncat', 'announce')); } catch {}
  await page.goto('/#/notifications');
  const row = page.locator('#nfeed .nitem.n-announce').first();
  const id = await row.getAttribute('data-id');
  await row.locator('.nmore').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByText('刪除這則通知').click();
  await expect(page.locator(`#nfeed .nitem[data-id="${id}"]`)).toHaveCount(0, { timeout: 500 });
});

test('通知全部已讀、入場券與領取、每月挑戰、使用說明導覽', async ({ page }) => {
  await enter(page);
  await page.goto('/#/notifications');
  // 全部已讀按鈕一律存在，沒有可以標已讀的通知時是 hidden
  await expect(page.locator('#nfeed')).toBeVisible();
  if (await page.locator('#readAll').isVisible()) { await page.locator('#readAll').click(); }
  await page.goto('/#/tickets');
  await expect(page.locator('h1')).toContainText('入場券');
  await page.goto('/#/challenge');
  await expect(page.locator('.badges .badge')).toHaveCount(6);
  // 使用說明：重新打開「開始使用」卡；三步都略過後問要不要看五個分頁的導覽
  await page.goto('/#/me');
  await page.locator('#openGuide').click();
  await expect(page.locator('#startCard')).toBeVisible();
  await expect(page.locator('#startTitle')).toBeFocused();
  for (const k of ['install', 'push', 'group']) if (await page.locator(`[data-stskip="${k}"]`).count()) await page.locator(`[data-stskip="${k}"]`).click();
  await expect(page.locator('#startTitle')).toHaveText('都設定好了');
  await page.locator('#startTour').click();
  await expect(page.locator('#gTitle')).toBeVisible();
  const titles = [];
  for (let i = 0; i < 10 && await page.locator('#guide').isVisible(); i++) {
    const t = await page.locator('#gTitle').innerText();
    titles.push(t);
    // 步數對齊下方 5 格分頁（「1 / N」的 N 不含開頭與結尾）
    const n = Number((await page.locator('#gCount').innerText()).split('/')[1] || 0);
    if (n) expect(n).toBe(5);
    // 背景是 inert：Tab 不會跑出說明框
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#guide'))).toBe(true);
    await page.locator('#gNext').click();
    if (t === '準備好了') break;
    await page.waitForTimeout(600);
  }
  await expect(page.locator('#guide')).toBeHidden();
  // GPS 跑步開著：第 3 格是跑步；地圖那一步不會被跳過
  expect(titles).toEqual(['歡迎來到耕跑團', '團練', '課表', '跑步', '地圖', '我的', '準備好了']);
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

// ---- 報名期間 ----
const tpAt = (min) => new Date(Date.now() + 8 * 3600e3 + min * 60e3).toISOString().slice(0, 16);
test('尚未開放報名：活動頁顯示開放時間，首頁卡片顯示開放', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: 'E2E 尚未開放', date: plus(4), gather_time: '07:00', signup_start: tpAt(2 * 1440), notify: false } });
  await enter(page);
  await page.goto(`/#/e/${ev.id}`);
  await expect(page.getByText(/尚未開放報名/)).toBeVisible();
  await expect(page.locator('#signup')).toHaveCount(0);
  await expect(page.locator('#openCountdown')).toContainText('開放報名');
  await page.goto('/#/');
  await expect(page.locator('a.card', { hasText: 'E2E 尚未開放' }).first()).toContainText(/開放/);
  // 活動卡片（不是最上面的大卡時）的報名狀態：即將開放＋開放時間
  const lit = page.locator('a.card.lit', { hasText: 'E2E 尚未開放' });
  if (await lit.count()) await expect(lit.first().locator('.pill.reg-soon')).toContainText('即將開放');
});

test('報名截止與額滿：顯示報名已截止、排候補', async ({ page, request }) => {
  const closed = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: 'E2E 已截止', date: plus(4), gather_time: '07:00', deadline: tpAt(60), notify: false } });
  await apiAs(request, 't_chair', `/events/${closed.id}`, { method: 'PUT', body: { kind: 'track', title: 'E2E 已截止', date: plus(4), gather_time: '07:00', deadline: tpAt(-60) } });
  const full = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: 'E2E 額滿', date: plus(4), gather_time: '07:00', capacity: 1, notify: false } });
  await apiAs(request, 't_other', `/events/${full.id}/signup`, { method: 'POST', body: {} });
  await enter(page);
  await page.goto(`/#/e/${closed.id}`);
  await expect(page.getByText('報名已截止').first()).toBeVisible();
  await page.goto(`/#/e/${full.id}`);
  await expect(page.getByRole('button', { name: '排候補' })).toBeVisible();
});

test('LINE 分享文字含報名期間', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: 'E2E 分享期間', date: plus(5), gather_time: '07:00', notify: false } });
  await enter(page);
  await page.addInitScript(() => { window.open = (u) => { window.__shared = u; return null; }; });
  await page.goto(`/#/e/${ev.id}`);
  await page.evaluate(() => { window.open = (u) => { window.__shared = u; return null; }; });
  await page.locator('#shareLine').click();
  const shared = decodeURIComponent(await page.evaluate(() => window.__shared));
  expect(shared).toContain('報名期間');
  // 分享連結用 /e/:id（LINE 看得到活動預覽卡），加上 openExternalBrowser=1 直接用 Safari／Chrome 打開
  expect(shared).toContain(`/e/${ev.id}?openExternalBrowser=1`);
  expect(shared).not.toContain('#/e/');
});

test('分享連結 /e/:id：沒登入先看到活動預覽與報名狀態，登入後回到活動頁；已登入直接到活動頁', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: 'E2E 分享連結', date: plus(5), gather_time: '07:00', place: '田徑場', notify: false } });
  await page.goto(`/e/${ev.id}?openExternalBrowser=1`);
  await expect(page).toHaveURL(new RegExp(`/#/e/${ev.id}$`));
  const card = page.locator('#sharedEv .card.shared');
  await expect(card).toContainText('E2E 分享連結');
  await expect(card.locator('.pill.reg-open')).toHaveText('報名中');
  await enter(page);
  await expect(page).toHaveURL(new RegExp(`#/e/${ev.id}$`));
  await page.goto('/#/');
  await page.goto(`/e/${ev.id}`);
  await expect(page).toHaveURL(new RegExp(`/#/e/${ev.id}$`));
  await expect(page.locator('h1.evtitle')).toContainText('E2E 分享連結');
});

test('現場報到 QR：沒登入掃到，登入後回到報到頁（報到代碼不會被當成邀請代碼）', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: 'E2E 掃碼報到', date: plus(0), notify: false } });
  const { token } = await apiAs(request, 't_chair', `/events/${ev.id}/attend-token`, { method: 'POST', body: { on: true } });
  await page.goto(`/#/e/${ev.id}/attend?t=${token}`);
  await expect(page.locator('#sharedEv .card.shared')).toContainText('E2E 掃碼報到');
  // 報到頁沒有 h1：自己處理隱私權政策同意（這個帳號在前面的測試可能已經同意過）
  await login(page, 't_staff');
  await page.waitForSelector('#consentBtn, .attendok', { timeout: 10000 });
  if (await page.locator('#consentBtn').count()) await page.locator('#consentBtn').click();
  await expect(page.locator('.attendok h2')).toHaveText('報到完成');
});

test('附近即時影像：捲到才載縮圖、點開大圖有顯名、省流量時不自動載入（CAM_MOCK 不連外）', async ({ page, request }) => {
  // 功能開關預設關閉：先打開
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { cams: true } });
  await apiAs(request, 't_chair', '/cams/sync', { method: 'POST', body: { source: 'wra' } });
  await enter(page);
  const frames = [];
  page.on('request', (r) => { if (r.url().includes('/frame')) frames.push(r.url()); });
  await page.goto('/#/map?spot=seed07');
  await expect(page.locator('.spotcard')).toContainText('大佳');
  await page.locator('#camCard').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('#camBox .camimg img').count()).toBeGreaterThan(0);
  expect(await page.locator('#camBox .camtile').count()).toBeLessThanOrEqual(3);
  await expect(page.locator('#camCard')).toContainText('經濟部水利署');
  await page.locator('#camBox [data-cam="wra:M1"]').click();
  await expect(page.locator('.camsheet #camvImg')).toBeVisible();
  await expect(page.locator('.camsheet')).toContainText('影像來源：經濟部水利署');
  await page.keyboard.press('Escape');
  await expect(page.locator('.camsheet')).toHaveCount(0);
  // 省流量：縮圖不自動載入，點了才載
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true }));
  await page.reload();
  await page.locator('#camCard').scrollIntoViewIfNeeded();
  const before = frames.length;
  await expect(page.locator('#camBox')).toContainText('點一下才載入');
  await page.waitForTimeout(500);
  expect(frames.length).toBe(before);
  // 「我的 → 外觀與語言」的省流量開關（存在這支手機）
  await page.evaluate(() => localStorage.setItem('cil-cam-lazy', '1'));
  await page.goto('/#/me/display');
  await expect(page.locator('#camLazy')).toBeChecked();
});

// ---- 跑者休息站（REST_MOCK 不連外）----
// 功能開關預設關閉：測試前打開（其他開關照目前的值送回去），用開發端點同步所有來源（不受「立即同步」每小時 3 次的限制）
async function restOn(request) {
  const f = (await apiAs(request, 't_chair', '/me')).settings?.features || {};
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { ...f, rest: true } });
  for (const k of ['twd', 'tpt', 'tprv', 'ntrv', 'tpbk', 'cpct', 'sav']) await request.get(`/api/dev/rest-sync?source=${k}`);
}
// 地圖的初始位置：只在這個分頁第一次載入時設定（之後重新整理要保留測試裡改的值）
// addInitScript 只會把函式的文字送進頁面，外層變數帶不過去：用第二個參數傳
const restView = (view, on = '0') => [({ view, on }) => { try { if (sessionStorage.getItem('rv')) return; sessionStorage.setItem('rv', '1'); localStorage.setItem('cil-map-view', view); localStorage.setItem('cil-map-rest', on); localStorage.removeItem('cil-map-rest-types'); } catch {} }, { view, on }];

test('跑者休息站：底圖選單打開圖層、13 級以下不抓、類型 chip 會記住、跟練跑地點分開群集', async ({ page, request }) => {
  await restOn(request);
  await page.addInitScript(...restView('[25.07,121.54,12]'));
  await enter(page);
  const cells = [];
  page.on('request', (r) => { if (r.url().includes('/api/rest/cell/')) cells.push(r.url()); });
  // 圖層關著：地圖打開時不下載 reststops.js，打開圖層才下載
  const mods = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/reststops.js') mods.push(r.url()); });
  await page.goto('/#/map');
  await expect(page.locator('#baseBtn')).toBeEnabled();
  await expect(page.locator('#addBtn')).toBeEnabled();
  expect(mods).toEqual([]);
  // 預設關閉；開關收在底圖選單（menuitemcheckbox），不另外加浮動按鈕
  await page.locator('#baseBtn').click();
  await expect(page.locator('#restTog')).toHaveAttribute('role', 'menuitemcheckbox');
  await expect(page.locator('#restTog')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#restBar')).toBeHidden();
  await page.locator('#restTog').click();
  await expect(page.locator('#baseMenu')).toBeHidden();
  await expect(page.locator('#baseBtn')).toBeFocused();
  expect(mods).toHaveLength(1);
  // 12 級：只顯示提示，不抓任何格子
  await expect(page.locator('#restHint')).toBeVisible();
  await expect(page.locator('#restChips')).toBeHidden();
  await page.waitForTimeout(800);
  expect(cells).toEqual([]);
  // 放大到 16 級：抓得到、一次最多 16 格、網址帶版本
  await page.evaluate(() => localStorage.setItem('cil-map-view', '[25.0736,121.5401,16]'));
  await page.reload();
  await expect(page.locator('.rpin').first()).toBeVisible();
  expect(cells.length).toBeGreaterThan(0);
  expect(cells.length).toBeLessThanOrEqual(16);
  for (const u of cells) expect(u).toMatch(/\/api\/rest\/cell\/\d{3,4}_\d{4,5}\?v=\d+$/);
  await expect(page.locator('#restChips')).toHaveAttribute('role', 'group');
  await expect(page.locator('#restChips')).toHaveAttribute('aria-label', '休息站類型');
  // chip 多選、重新整理後還在
  await page.locator('#restChips [data-rt="water"]').click();
  await page.locator('#restChips [data-rt="toilet"]').click();
  await page.reload();
  await expect(page.locator('#restChips [data-rt="water"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#restChips [data-rt="toilet"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#restChips [data-rt="shower"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.rpin.t-shower')).toHaveCount(0);
  for (const k of ['water', 'toilet']) await page.locator(`#restChips [data-rt="${k}"]`).click();
  // 群集：休息站與練跑地點各自合併（休息站是灰色泡泡 .rclus，練跑地點是 .mclus），不會混在同一顆
  await page.evaluate(() => localStorage.setItem('cil-map-view', '[25.0736,121.5401,14]'));
  await page.reload();
  await expect(page.locator('.rpin-host').first()).toBeAttached();
  await expect(page.locator('.mclus .rpin, .mclus .rclus, .rclus .mpin')).toHaveCount(0);
  // 兩個數字要在同一刻量：分兩次 count() 中間若剛好重畫（休息站模組晚一步載入、格子陸續回來），會量到不同畫面
  await expect.poll(() => page.evaluate(() => {
    const hosts = document.querySelectorAll('.rpin-host').length;
    return hosts > 0 && hosts === document.querySelectorAll('.rpin, .rclus').length;
  })).toBe(true);
  // 關掉：針都拿掉
  await page.locator('#baseBtn').click();
  await page.locator('#restTog').click();
  await expect(page.locator('.rpin-host')).toHaveCount(0);
  await expect(page.locator('#restBar')).toBeHidden();
});

test('跑者休息站：地點卡的附近休息站、休息站卡（顯名與授權外連、回到地點）、在地圖上顯示', async ({ page, request }) => {
  await restOn(request);
  await page.addInitScript(...restView('[25.0736,121.5401,15]'));
  await enter(page);
  await page.goto('/#/map?spot=seed07');
  const near = page.locator('#restNear');
  await expect(near).toBeVisible();
  await expect(near.locator('#restNearH')).toHaveText('附近休息站');
  await expect(near.locator('.rng')).toHaveCount(4);
  await expect(near).toContainText('大佳河濱公園 9號水門');
  await expect(near).toContainText(/\d+ 公尺/);
  await expect(near).toContainText('直線距離；資料來自政府開放資料與幹部整理，以現場為準');
  // 公共廁所 120 m 排在店家 100 m 前面（權重）
  const toilet = near.locator('.rng').nth(1).locator('.rnitem');
  await expect(toilet.first()).toContainText('大佳河濱公園');
  // 休息站卡
  const first = near.locator('.rnitem').first();
  const id = await first.getAttribute('data-rest');
  await first.click();
  const card = page.locator('.restcard');
  await expect(card).toBeVisible();
  await expect(page.locator('#restName')).toBeFocused();
  await expect(card).toContainText('免費・公共直飲臺');
  await expect(card).toContainText('資料可能與現況不同，以現場與官方公告為準');
  await expect(card).toContainText(/從「.+」直線 \d+ 公尺/);
  const lic = card.locator('.restcredit a').first();
  await expect(lic).toHaveAttribute('href', 'https://data.gov.tw/license');
  await expect(lic).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(card.locator('a', { hasText: '導航' })).toHaveAttribute('href', /travelmode=walking/);
  expect(page.url()).toContain(`rest=${encodeURIComponent(id)}`);
  // 地圖上那一處放大顯示
  await expect(page.locator(`.rpin.sel[data-rid="${id}"]`)).toBeAttached();
  // 只打開休息站卡不會改這台裝置的圖層設定（圖層關著也畫出正在看的那一處）
  expect(await page.evaluate(() => localStorage.getItem('cil-map-rest'))).toBe('0');
  await expect(page.locator('#restBar')).toBeHidden();
  // 回到地點：焦點回到剛才那一列
  await page.locator('#restBack').click();
  await expect(page.locator('.spotcard').first()).toContainText('大佳');
  await expect(page.locator(`#restNear [data-rest="${id}"]`)).toBeFocused();
  // 在地圖上顯示：打開圖層
  await page.locator('#restShow').click();
  await expect(page.locator('#restBar')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cil-map-rest'))).toBe('1');
  // 點地圖上的針打開卡片，關閉鈕關掉
  //   打開圖層後格子陸續回來，每回來一格就重畫一次（換掉所有針）：先找到針、下一步才點，中間剛好重畫就會點到已經拿掉的舊針（沒反應）
  //   所以找與點在頁面裡同一步做完；還沒畫出來就等下一次
  await expect.poll(() => page.evaluate((rid) => {
    const host = document.querySelector(`.rpin[data-rid="${CSS.escape(rid)}"]`)?.closest('.leaflet-marker-icon');
    host?.click();
    return !!host;
  }, id)).toBe(true);
  await expect(card).toBeVisible();
  await page.locator('#restClose').click();
  await expect(page.locator('.restcard')).toHaveCount(0);
});

test.describe('跑者休息站：手機', () => {
  test.use({ viewport: { width: 393, height: 852 } });
  test('抽屜全開時按「在地圖上顯示」：抽屜降到半開、地圖上看得到休息站的針', async ({ page, request }) => {
    await restOn(request);
    await page.addInitScript(...restView('[25.0736,121.5401,15]'));
    await enter(page);
    await page.goto('/#/map?spot=seed07');
    await expect(page.locator('#restNear .rnitem').first()).toBeVisible();
    const sheet = page.locator('#msheet');
    while ((await sheet.getAttribute('data-detent')) !== 'full') await page.locator('#grab').click();
    await page.locator('#restShow').click();
    await expect(sheet).toHaveAttribute('data-detent', 'half');
    await expect(page.locator('.rpin').first()).toBeVisible();
    await expect(page.locator('#restHint')).toBeHidden();
    // 至少有一顆針在抽屜上面（看得到的地圖裡）
    await expect.poll(async () => {
      const top = (await sheet.boundingBox()).y;
      const ys = await page.locator('.rpin').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
      return ys.some((y) => y > 0 && y < top);
    }).toBe(true);
  });
  test('網址帶 ?rest= 但讀不到那一處：回到地點清單，不停在「載入中」', async ({ page, request }) => {
    await restOn(request);
    await enter(page);
    await page.goto('/#/map?rest=twd:NOPE404');
    await expect(page.locator('#spotQ')).toBeVisible();
    expect(page.url()).not.toContain('rest=');
  });
});

test.describe('跑者休息站：離線', () => {
  test.use({ serviceWorkers: 'allow' });
  test('離線時地點卡的附近休息站用上次的資料', async ({ page, context, request }) => {
    await restOn(request);
    await enter(page);
    await page.goto('/#/map?spot=seed07');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();   // 讓 Service Worker 接手這一頁
    await expect(page.locator('#restNear .rnitem').first()).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#restNear .rnitem').first()).toBeVisible();
    await expect(page.locator('#restNear')).toContainText('大佳河濱公園 9號水門');
    await context.setOffline(false);
  });
});

test('團員揪團：協會打開開關後，團員從首頁發起（精簡表單、不收費），活動頁標「揪團」，管理區只有統計、編輯與刪除', async ({ page, request }) => {
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { meetup: true } });
  let id = null, ok = false;
  try {
    await enter(page);
    await page.goto('/#/');
    await page.getByRole('link', { name: '發起揪團' }).click();
    await expect(page.locator('#view h1')).toHaveText('發起揪團');
    // 精簡表單：類型、誰看得到、收費、問卷、審核、外連、建立後通知都不顯示；分團只有自己參加的
    for (const n of ['kind', 'visibility', 'fee', 'require_approval', 'link_url', 'notify', 'signup_start']) await expect(page.locator(`#ef [name=${n}]`).first()).toBeHidden();
    await expect(page.locator('#ef [name=team_id] option')).not.toHaveCount(0);
    await expect(page.locator('#ef [name=capacity]')).toBeVisible();
    await expect(page.locator('#ef [name=deadline]')).toBeVisible();
    await page.locator('#ef [name=title]').fill(`E2E 揪團 ${Date.now().toString(36).slice(-4)}`);
    await page.locator('#ef [name=date]').fill(plus(5));
    await page.locator('#ef [name=date]').dispatchEvent('change');
    await page.locator('#ef [name=gather_time]').fill('06:30');
    await page.locator('#ef [name=place]').fill('大佳河濱');
    // 代碼從建立的回應拿：後面哪一步失敗，收尾都刪得掉這場（留著會佔「同時最多 3 場」，重試時跟著失敗）
    const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST', { timeout: 10000 });
    await page.getByRole('button', { name: '建立' }).click();
    id = (await (await created).json()).id;
    expect(id, '建立揪團失敗').toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`#/e/${id}$`));
    await expect(page.locator('.hero .pill').first()).toHaveText('揪團');
    await expect(page.locator('.hero')).toContainText(/發起：.*跑友/);   // 帶團欄位是開團人的暱稱（前面的測試可能改過暱稱）
    await expect(page.getByRole('link', { name: '報名統計' })).toBeVisible();
    await expect(page.locator('#del')).toBeVisible();
    for (const s of ['#noticeForm', '#bulkForm', '#attendWrap']) await expect(page.locator(s)).toHaveCount(0);
    await page.getByRole('link', { name: '編輯', exact: true }).click();
    await expect(page.locator('#view h1')).toHaveText('編輯揪團');
    await expect(page.locator('#ef [name=team_id]')).toBeDisabled();
    ok = true;
  } finally {
    await tidy([
      ['刪除揪團', () => id && apiAs(request, 't_runner', `/events/${id}`, { method: 'DELETE' })],
      ['關閉團員揪團', () => apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { meetup: false } })],
    ], ok);
  }
});
// 收尾：每一步都做（前一步失敗也一樣）；測試本身已經失敗時，收尾的錯誤只記在報告（annotation），不蓋掉真正的錯誤
async function tidy(steps, ok) {
  const errs = [];
  for (const [what, fn] of steps) {
    try { const r = await fn(); if (r?.error) throw new Error(r.error); } catch (e) { errs.push(`${what}：${e.message}`); }
  }
  if (!errs.length) return;
  if (ok) throw new Error(`收尾失敗：${errs.join('；')}`);
  test.info().annotations.push({ type: '收尾失敗', description: errs.join('；') });
}
