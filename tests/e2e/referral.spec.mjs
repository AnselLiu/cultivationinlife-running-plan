// 推薦人（團員端）：首頁推薦人卡、「我的 → 推薦人」只填名字與用 Gmail 找、推薦人按「不是我」、開始使用的第 4 步、登入頁說明、功能關閉時的畫面
//   這個檔案開頭打開「推薦人」功能開關、結束時關掉（workers＝1，不會影響同時跑的其他測試）
//   會留下狀態的步驟（收起提示、按「不是我」之後 180 天不能再設）一律用這次新建的帳號或先清掉，重用伺服器重跑也會過
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked, BASE } from './helpers.mjs';

const axeBad = async (page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations
  .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
const noScrollX = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const toast = (page) => page.locator('#toasts .toast');
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// 全形（中文輸入法打出來的 Ｅ２Ｅ．ＲＥＣ＠ＧＭＡＩＬ．ＣＯＭ）：伺服器要整理成同一個 Gmail
const fullWidth = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
// 用邀請碼新建一個跑友帳號（這次測試專用，收起提示等伺服器狀態不會留到下一次）；page.request 跟頁面共用登入
async function joinFresh(page, { start = false } = {}) {
  if (!start) await page.addInitScript(() => { try { localStorage.setItem('cil-start', JSON.stringify({ v: 1, dismissed: 1 })); } catch {} });
  const res = await page.request.post('/api/join', { headers: { origin: BASE, 'content-type': 'application/json' }, data: JSON.stringify({ code: 'test-join', name: `推薦測試${stamp().slice(-4)}`, dist: 'fm', grp: 'D', consent: true }) });
  expect(res.ok(), `加入失敗 ${res.status()} ${await res.text()}`).toBe(true);
}
const devGoogle = (sub, email, name) => `/api/dev/google?sub=${encodeURIComponent(sub)}&email=${encodeURIComponent(email)}&verified=1&name=${encodeURIComponent(name)}`;

test.beforeAll(async ({ request }) => { await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { referral: true } }); });
test.afterAll(async ({ request }) => { await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { referral: false } }); });

test('首頁推薦人卡：還沒填推薦人才出現，「沒有推薦人」收起後重新整理也不再出現；只填名字、移除', async ({ page }) => {
  await joinFresh(page);
  await page.goto('/#/'); await acceptPrivacyIfAsked(page);
  const card = page.locator('#refCard');
  await expect(card.locator('[data-row="A"]')).toContainText('是誰介紹你來耕跑團的？');
  await expect(card.locator('[data-row="B"]')).toHaveCount(0);   // e2e 沒有 Google 登入
  expect(await axeBad(page)).toEqual([]);
  await card.getByRole('button', { name: '沒有推薦人' }).click();
  await expect(page.locator('#refCard')).toHaveCount(0);
  await expect(page.locator('#view h1')).toBeFocused();
  await page.reload();
  await expect(page.locator('#view h1')).toHaveText('團練');
  await expect(page.locator('#refCard')).toHaveCount(0);   // 收起記在伺服器

  // 「我的」有推薦人這一列；收起首頁提示之後照樣可以填
  await page.goto('/#/me');
  await expect(page.locator('a.setrow[href="#/me/referral"]')).toContainText('誰介紹你來的、推薦我的跑友');
  await page.locator('a.setrow[href="#/me/referral"]').click();
  await expect(page.locator('#view h1')).toHaveText('推薦人');
  await expect(page.getByText('還沒有填推薦人。')).toBeVisible();
  await page.getByRole('button', { name: '只填名字' }).click();
  await expect(page.getByRole('button', { name: '只填名字' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('推薦人的名字')).toBeFocused();
  await page.getByLabel('推薦人的名字').fill('王大明');
  await page.getByRole('button', { name: '儲存' }).click();
  await expect(toast(page)).toContainText('已儲存推薦人');
  const mine = page.locator('section.card', { has: page.locator('#refMine') });
  await expect(mine.locator('.pill', { hasText: '只填名字' })).toBeVisible();
  await expect(mine).toContainText('王大明');
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);
  page.once('dialog', (d) => { expect(d.message()).toBe('移除推薦人？對方不會收到通知。'); d.accept(); });
  await mine.getByRole('button', { name: '移除' }).click();
  await expect(toast(page)).toContainText('已移除推薦人');
  await expect(page.getByText('還沒有填推薦人。')).toBeVisible();
  // 名字不能是 Email、電話或網址
  await page.getByRole('button', { name: '只填名字' }).click();
  await page.getByLabel('推薦人的名字').fill('0912345678');
  await page.getByRole('button', { name: '儲存' }).click();
  await expect(page.locator('.ferr')).toContainText('名字請填 1–20 個字');
});

test('用 Gmail 找推薦人（全形也找得到）、推薦人收到通知按「不是我」、跑友看到推薦人沒有確認', async ({ page, request }) => {
  const id = stamp(), sub = `e2e_rec_${id}`, email = `e2e.rec.${id}@gmail.com`, name = '推薦人乙';
  // 推薦人用 Google 登入一次（另外的連線，不影響頁面的登入）：協會開放推薦人時會存下查詢碼
  const seed = await request.get(devGoogle(sub, email, name), { maxRedirects: 0 });
  expect(seed.status(), await seed.text()).toBeLessThan(400);
  await apiAs(request, 't_runner', '/me/referral', { method: 'DELETE' });   // 上一次留下的推薦人先清掉（撤回一律可以做）

  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/me/referral');
  const mine = page.locator('section.card', { has: page.locator('#refMine') });
  await expect(mine.getByRole('button', { name: '用 Gmail 找' })).toHaveAttribute('aria-pressed', 'true');
  // 自己的 Gmail 以外查不到的：顯示找不到
  await page.getByLabel('推薦人的 Gmail').fill(`nobody.${id}@gmail.com`);
  await page.getByRole('button', { name: '找找看' }).click();
  await expect(page.locator('#refHit')).toContainText('找不到這個 Gmail');
  await expect(page.locator('#refHit')).toBeFocused();
  await page.getByLabel('推薦人的 Gmail').fill(fullWidth(email.toUpperCase()));
  await page.getByRole('button', { name: '找找看' }).click();
  await expect(page.locator('#refHit')).toContainText(/找到了：推○+乙/);   // 名字遮罩，不給 Email、不給帳號代碼
  await expect(page.locator('#refHit')).not.toContainText('@');
  expect(await axeBad(page)).toEqual([]);
  await page.getByRole('button', { name: '是，設為推薦人' }).click();
  await expect(toast(page)).toContainText('已設定推薦人，等對方確認');
  await expect(mine.locator('.pill.wait', { hasText: '等對方確認' })).toBeVisible();
  await expect(mine.locator('.pill', { hasText: '跑友帳號' })).toBeVisible();
  await expect(mine.getByRole('button', { name: '更換' })).toBeVisible();

  // 推薦人那邊：「我的」有待確認的數字，通知點進去是推薦人頁，按「不是我」
  await page.goto(devGoogle(sub, email, name));
  await page.waitForURL(/#\//);
  await page.goto('/#/me');
  await expect(page.locator('a.setrow[href="#/me/referral"] .pill.wait')).toHaveText('1 位待確認');
  await page.goto('/#/notifications');
  await page.locator('a.nrow', { hasText: '有跑友把你設為推薦人' }).first().click();
  // 內文較長、在通知列被截斷時先開詳情面板，按「前往」才到推薦人頁
  const go = page.getByRole('link', { name: '前往' });
  await expect(go.or(page.locator('.refkids'))).toBeVisible();
  if (await go.isVisible()) await go.click();
  await expect(page).toHaveURL(/#\/me\/referral/);
  const kids = page.locator('.refkids');
  await expect(kids.locator('.r')).toHaveCount(1);
  await expect(kids.locator('.pill.wait')).toHaveText('等你確認');
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);
  page.once('dialog', (d) => d.accept());
  await kids.getByRole('button', { name: '不是我' }).click();
  await expect(toast(page)).toContainText('已移除，也通知對方了');
  await expect(page.getByText('還沒有跑友把你設為推薦人。')).toBeVisible();

  // 跑友那邊：推薦人已經移除，說明可以再找一次或只填名字
  await login(page, 't_runner');
  await page.goto('/#/me/referral');
  await expect(page.locator('.notice', { hasText: '上一位推薦人表示不認識你的帳號' })).toBeVisible();
  await expect(page.getByText('還沒有填推薦人。')).toBeVisible();
  // 同一位推薦人不能再設（180 天）
  await page.getByLabel('推薦人的 Gmail').fill(email);
  await page.getByRole('button', { name: '找找看' }).click();
  await page.getByRole('button', { name: '是，設為推薦人' }).click();
  await expect(toast(page)).toContainText('這位跑友之前表示不認識你的帳號');
});

test('開始使用：協會開放推薦人時多一步「填推薦人」，略過後進度更新、這次打開一直留著', async ({ page }) => {
  await joinFresh(page, { start: true });
  await page.goto('/#/?welcome=1'); await acceptPrivacyIfAsked(page);
  const card = page.locator('#startCard');
  await expect(card.locator('.ststeps > li')).toHaveCount(4);
  await expect(card.locator('#startProg')).toHaveText(/^\d \/ 4 完成$/);
  const before = Number((await card.locator('#startProg').innerText()).split(' ')[0]);
  await expect(card.locator('[data-step="ref"]')).toContainText('選填');
  await expect(page.locator('#refCard [data-row="A"]')).toHaveCount(0);   // 卡片已經有這一步，推薦人卡不重複問
  expect(await axeBad(page)).toEqual([]);
  await card.locator('[data-stskip="ref"]').click();
  await expect(card.locator('[data-step="ref"] .ststate')).toHaveText('已略過');
  await expect(card.locator('#startProg')).toHaveText(`${before + 1} / 4 完成`);
  // 重畫（換到「我的」）：這一步還在，狀態是已略過
  await page.goto('/#/me');
  await expect(page.locator('#startCard .ststeps > li')).toHaveCount(4);
  await expect(page.locator('#startCard [data-step="ref"] .ststate')).toHaveText('已略過');
});

test('開始使用：從「填寫」去推薦人頁存好，回到原本的頁面並打勾', async ({ page }) => {
  await joinFresh(page, { start: true });
  await page.goto('/#/?welcome=1'); await acceptPrivacyIfAsked(page);
  await page.locator('#startCard #stRefGo').click();
  await expect(page).toHaveURL(/#\/me\/referral\?from=start/);
  await page.getByRole('button', { name: '只填名字' }).click();
  await page.getByLabel('推薦人的名字').fill('陳小華');
  await page.getByRole('button', { name: '儲存' }).click();
  await expect(page).toHaveURL(/#\/(\?welcome=1)?$/);
  await expect(page.locator('#startCard [data-step="ref"] .ststate')).toHaveText('已完成');
});

test('登入頁：協會開放推薦人時說明 Email 只換算成查詢碼；取消 Google 登入時可以只用名稱與大頭貼', async ({ page }) => {
  let on = true;
  await page.route('**/api/me*', async (route) => {
    const res = await route.fetch(), json = await res.json();
    json.googleLogin = true;
    json.settings = { ...(json.settings || {}), features: { ...(json.settings?.features || {}), referral: on } };
    await route.fulfill({ response: res, json });
  });
  await page.goto('/');
  const auth = page.locator('.authcard');
  await expect(auth).toContainText('無法還原的查詢碼');
  await expect(auth).not.toContainText('不會取得 Email');
  await expect(page.getByRole('link', { name: '只用名稱與大頭貼登入' })).toHaveCount(0);
  await page.goto(`/#/?err=${encodeURIComponent('你取消了 Google 登入')}`);
  await page.reload();
  const basic = page.getByRole('link', { name: '只用名稱與大頭貼登入' });
  await expect(basic).toHaveAttribute('href', /basic=1/);
  await expect(basic).not.toHaveAttribute('href', /link=1/);
  expect(await axeBad(page)).toEqual([]);
  // 功能關閉：維持原本的說明，沒有「只用名稱與大頭貼」
  on = false;
  await page.reload();
  await expect(page.locator('.authcard')).toContainText('不會取得 Email');
  await expect(page.getByRole('link', { name: '只用名稱與大頭貼登入' })).toHaveCount(0);
});

test('功能關閉：推薦人頁只留已填的資料與移除，首頁卡、我的列與開始使用的這一步都不出現', async ({ page, request }) => {
  await joinFresh(page);
  await page.goto('/#/'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/me/referral');
  await page.getByRole('button', { name: '只填名字' }).click();
  await page.getByLabel('推薦人的名字').fill('林志明');
  await page.getByRole('button', { name: '儲存' }).click();
  await expect(page.locator('.pill', { hasText: '只填名字' })).toBeVisible();
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { referral: false } });
  try {
    await page.goto('/#/');
    await page.reload();
    await expect(page.locator('#view h1')).toHaveText('團練');
    await expect(page.locator('#refCard')).toHaveCount(0);
    await page.goto('/#/me');
    // 已經填了推薦人：關掉後「我的」照樣有這一列（看得到、可以移除）
    await expect(page.locator('a.setrow[href="#/me/referral"]')).toContainText('已填・推薦我的跑友');
    await page.goto('/#/me/referral');
    await expect(page.locator('.notice', { hasText: '推薦人功能目前沒有開放' })).toBeVisible();
    await expect(page.getByRole('button', { name: '更換' })).toHaveCount(0);
    await expect(page.locator('#refEmailF, #refNameF')).toHaveCount(0);
    expect(await axeBad(page)).toEqual([]);
    expect(await noScrollX(page)).toBe(true);
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: '移除' }).click();   // 撤回一律可以做
    await expect(toast(page)).toContainText('已移除推薦人');
    await expect(page.getByText('還沒有填推薦人。')).toBeVisible();
  } finally {
    await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { referral: true } });
  }
});

test('隱私：「讓我推薦的跑友用 Gmail 找到我」開關（有 Google 登入時才出現），我們存了什麼寫到推薦人與查詢碼', async ({ page }) => {
  await page.route('**/api/me*', async (route) => {
    const res = await route.fetch(), json = await res.json();
    json.googleLogin = true;
    await route.fulfill({ response: res, json });
  });
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/me/privacy');
  await expect(page.locator('#view')).toContainText('Gmail 查詢碼（無法還原成 Email）');
  const sw = page.locator('#emailFind'), was = await sw.isChecked();
  expect(await axeBad(page)).toEqual([]);
  // 關掉立刻刪除查詢碼；再打開（不會自己恢復查詢碼，要再用 Google 確認）
  await page.locator('label.switch', { has: sw }).click();
  await expect(toast(page)).toContainText(was ? '已關閉，查詢碼已刪除' : '跑友可以用 Gmail 找到你');
  await page.locator('label.switch', { has: sw }).click();
  await expect(toast(page)).toContainText(was ? '跑友可以用 Gmail 找到你' : '已關閉，查詢碼已刪除');
  await expect(sw).toBeChecked({ checked: was });
});
