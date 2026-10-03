// 全功能測試（幹部）：定期揪跑、邀請制、代為團體報名、春酒入場券與報到抽獎、分團公告、行事曆提醒、地點新增、匯出與複製活動
import { test, expect } from '@playwright/test';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

const enter = async (page, id) => { await login(page, id); await acceptPrivacyIfAsked(page); };
const tag = Date.now().toString(36).slice(-4);

test('定期揪跑：用表單建立每週兩天的系列，活動頁看得到其他場次', async ({ page }) => {
  await enter(page, 't_chair');
  await page.goto(`/#/new?date=${plus(1)}`);
  await page.locator('#ef [name=kind]').selectOption('long');
  await page.locator('#ef [name=title]').fill(`E2E 定期揪跑 ${tag}`);
  await page.locator('#ef [name=gather_time]').fill('06:00');
  await page.locator('#repBox summary').click();
  const wd = new Date(`${plus(1)}T00:00:00`).getDay();
  await page.locator(`#ef [name=rep_wd][value="${wd}"]`).check({ force: true });
  await page.locator(`#ef [name=rep_wd][value="${(wd + 3) % 7}"]`).check({ force: true });
  await page.locator('#ef [name=rep_until]').fill(plus(20));
  if (await page.locator('#ef [name=notify]').count()) await page.locator('#ef [name=notify]').uncheck();
  await page.getByRole('button', { name: '建立' }).click();
  await expect(page.getByText(/定期揪跑/).first()).toBeVisible();
  await expect(page.locator('.serieschips a')).not.toHaveCount(0);
});

test('邀請制：搜尋邀請團員，被邀請的人看得到、其他人看不到', async ({ page, request, browser }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'other', title: `E2E 邀請制 ${tag}`, date: plus(5), visibility: 'invite', notify: false } });
  await enter(page, 't_chair');
  await page.goto(`/#/e/${ev.id}`);
  await page.locator('#invSearch [name=q]').fill('測試跑友');
  await page.locator('#invSearch').getByRole('button').click();
  await page.locator('#invHits [data-inv]').first().click();
  await expect(page.getByText(/已邀請/)).toBeVisible();
  expect((await apiAs(request, 't_runner', `/events/${ev.id}`)).title).toContain('邀請制');
  expect((await apiAs(request, 't_super', `/events/${ev.id}`)).error).toBeTruthy();
});

test('代為團體報名：沒填資料先帶去填，填完回來報名，選擇還在', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'race', title: `E2E 團體報名 ${tag}`, date: plus(40), group_reg: true, notify: false, options: [{ name: '全馬', price: 1650 }, { name: '半馬', price: 1350 }] } });
  await apiAs(request, 't_other', '/me/race-profile', { method: 'DELETE' });
  await enter(page, 't_other');
  await page.goto(`/#/e/${ev.id}`);
  await page.locator('#pform').getByText('半馬').click();
  await page.locator('#pform [name=note]').fill('E2E 備註');
  await page.getByRole('link', { name: '去填寫 ›' }).click();
  await expect(page).toHaveURL(/#\/me\/reg/);
  const f = page.locator('#regForm');
  for (const [k, v] of [['name_zh', '路人跑友'], ['id_no', 'B223456782'], ['birthday', '1992-02-02'], ['phone', '0911222333'], ['emergency_name', '家人'], ['emergency_phone', '0922333444']]) await f.locator(`[name=${k}]`).fill(v);
  await f.locator('[name=gender]').selectOption('女');
  await f.locator('[name=shirt]').selectOption('S');
  await f.getByRole('button', { name: '儲存' }).click();
  await expect(page).toHaveURL(new RegExp(`#/e/${ev.id}`));
  await expect(page.getByText('已帶回你剛才選的內容')).toBeVisible();
  await expect(page.locator('#pform [name=note]')).toHaveValue('E2E 備註');
  await page.locator('#pform [name=reg_consent]').check();
  await page.locator('#pform').getByRole('button', { name: '我要報名' }).click();
  await expect(page.locator('#payCard')).toContainText('NT$1,350');
});

test('春酒：報名帶攜伴拿到入場券，幹部輸入代碼報到、設獎項抽獎', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'party', title: `E2E 春酒 ${tag}`, date: plus(30), gather_time: '18:00', fee: 800, guest_max: 2, meal_options: '葷食,素食', notify: false } });
  await enter(page, 't_runner');
  await page.goto(`/#/e/${ev.id}`);
  await page.locator('#pform [name=guests]').selectOption('1');
  await page.locator('#pform [name=meal]').selectOption('素食');
  await page.locator('#pform').getByRole('button', { name: '我要報名' }).click();
  await expect(page.locator('.ticket')).toBeVisible();
  const code = (await page.locator('.ticket .code').innerText()).trim();
  await expect(page.locator('#payCard')).toContainText('NT$1,600');   // 本人＋攜伴 1 位
  await enter(page, 't_chair');
  await page.goto(`/#/e/${ev.id}`);
  await page.locator('#cform [name=code]').fill(code);
  await page.locator('#cform').getByRole('button').first().click();
  await expect(page.getByText(/報到完成|已經報到/)).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.locator('#prizeForm [name=name]').fill('E2E 大獎');
  await page.locator('#prizeForm').getByRole('button', { name: '新增獎項' }).click();
  await expect(page.getByText('已新增獎項')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.locator('[data-draw]').first().click();
  await expect(page.getByText(/抽出 E2E 大獎/)).toBeVisible();
});

test('分團：幹部發公告、行事曆新增賽事提醒、地圖直接新增地點、複製活動與匯出', async ({ page, request }) => {
  await enter(page, 't_chair');
  await page.goto('/#/t/youth');
  await page.locator('#newPost').click();
  await page.locator('#postForm [name=title]').fill(`E2E 公告 ${tag}`);
  await page.locator('#postForm [name=notify]').uncheck();
  await page.locator('#postForm').getByRole('button', { name: '發布' }).click();
  await expect(page.getByText(`E2E 公告 ${tag}`)).toBeVisible();
  await page.goto('/#/calendar');
  await page.locator('#addItem').click();
  await page.locator('#itf [name=title]').fill(`E2E 賽事 ${tag}`);
  await page.locator('#itf').getByRole('button', { name: '新增' }).click();
  await expect(page.locator('#dayBox')).toContainText(`E2E 賽事 ${tag}`);
  // 新增地點（幹部直接上架）
  await page.goto('/#/map');
  await page.locator('#addBtn').click();
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);   // 地圖上半部（下方是抽屜）；選位置時圖釘不會搶走點擊
  await expect(page.locator('#sf')).toBeVisible();
  await page.locator('#sf [name=name]').fill(`E2E 田徑場 ${tag}`);
  await page.locator('#sf').getByRole('button', { name: '新增' }).click();
  await expect(page.locator('.spotcard')).toContainText(`E2E 田徑場 ${tag}`);
  await expect(page.getByRole('link', { name: '在這裡開揪跑' })).toBeVisible();
  // 複製活動、匯出
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: `E2E 匯出 ${tag}`, date: plus(4), notify: false } });
  await page.goto(`/#/e/${ev.id}/stats`);
  const dl = page.waitForEvent('download');
  await page.getByRole('link', { name: '下載 CSV' }).click();
  expect((await dl).suggestedFilename()).toContain('.csv');
  await page.goto(`/#/new?from=${ev.id}`);
  await expect(page.locator('#ef [name=title]')).toHaveValue(new RegExp(`E2E 匯出 ${tag}`));
});

test('通知中心：幹部看得到「待辦」chip 與待處理摘要，連到分團頁', async ({ page, request }) => {
  await apiAs(request, 't_other', '/teams/youth/join', { method: 'POST' });
  await enter(page, 't_lead');
  await page.goto('/#/notifications');
  await expect(page.getByRole('tab', { name: /待辦/ })).toBeVisible();
  await expect(page.locator('#todoBox')).toContainText('入團申請');
  await expect(page.locator('#todoBox a[href="#/t/youth"]')).toBeVisible();
  await apiAs(request, 't_other', '/teams/youth/leave', { method: 'POST' });
});

// ---- 報名設定與審核 ----
test.describe('報名設定', () => {
  test.afterAll(async ({ request }) => { await apiAs(request, 't_chair', '/settings/signup', { method: 'POST', body: { approval: false, notify: true, open_days: null, close_days: null } }); });
  test('報名設定：系統預設帶入報名期間，改日期會跟著算，手動改過就不動', async ({ page, request }) => {
    await apiAs(request, 't_chair', '/settings/signup', { method: 'POST', body: { open_days: 3, open_time: '20:00', close_days: 1, close_time: '22:00', approval: true, notify: true } });
    await enter(page, 't_chair');
    await page.goto(`/#/new?date=${plus(10)}`);
    await expect(page.locator('#ef [name=signup_start]')).toHaveValue(`${plus(7)}T20:00`);
    await expect(page.locator('#ef [name=deadline]')).toHaveValue(`${plus(9)}T22:00`);
    await expect(page.locator('#ef [name=require_approval]')).toBeChecked();
    await expect(page.locator('#ef [name=notify_signup]')).toBeChecked();
    await expect(page.locator('#winHint')).toContainText('需要審核');
    await page.locator('#ef [name=date]').fill(plus(12));
    await page.locator('#ef [name=date]').dispatchEvent('change');
    await expect(page.locator('#ef [name=signup_start]')).toHaveValue(`${plus(9)}T20:00`);
    await page.locator('#ef [name=deadline]').fill(`${plus(10)}T21:00`);
    await page.locator('#ef [name=date]').fill(plus(13));
    await page.locator('#ef [name=date]').dispatchEvent('change');
    await expect(page.locator('#ef [name=deadline]')).toHaveValue(`${plus(10)}T21:00`);
    await page.locator('#ef [name=title]').fill(`E2E 報名設定 ${tag}`);
    await page.locator('#ef [name=gather_time]').fill('07:00');
    if (await page.locator('#ef [name=notify]').count()) await page.locator('#ef [name=notify]').uncheck();
    await page.getByRole('button', { name: '建立' }).click();
    await expect(page.getByText(/開放報名/).first()).toBeVisible();
  });
});

test('審核：團員送出申請，幹部在統計頁核准與婉拒', async ({ page, request, browser }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: `E2E 審核 ${tag}`, date: plus(8), gather_time: '07:00', require_approval: true, notify: false } });
  const runner = await browser.newPage();
  await enter(runner, 't_runner');
  await runner.goto(`/#/e/${ev.id}`);
  await runner.getByRole('button', { name: '送出申請' }).click();
  await expect(runner.getByText(/已送出申請/)).toBeVisible();
  await expect(runner.locator('#cancel')).toHaveText('撤回申請');
  await expect(runner.getByText(/審核/).first()).toBeVisible();
  await apiAs(request, 't_other', `/events/${ev.id}/signup`, { method: 'POST', body: {} });
  await enter(page, 't_chair');
  await page.goto(`/#/e/${ev.id}/stats?f=pending`);
  await expect(page.locator('[data-f="pending"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.prow[data-mid="t_runner"] [data-rv="approve"]').click();
  await expect(page.getByText(/已核准 1 人/)).toBeVisible();
  await runner.reload();
  await expect(runner.getByRole('button', { name: '取消報名' })).toBeVisible();
  await expect(runner.locator('#view')).not.toContainText('審核中');
  await page.locator('.prow[data-mid="t_other"] [data-rv="reject"]').click();
  await page.locator('.sheet [data-c="資格不符"]').click();
  await page.locator('.sheet [data-ok]').click();
  await expect(page.getByText(/已婉拒 1 人/)).toBeVisible();
  const other = await browser.newPage();
  await enter(other, 't_other');
  await other.goto(`/#/e/${ev.id}`);
  await expect(other.getByText('未通過審核')).toBeVisible();
  await expect(other.getByText(/資格不符/)).toBeVisible();
  await expect(other.getByRole('button', { name: '我要報名' })).toHaveCount(0);
});

test('關閉審核：還有待審核時要確認，確認後直接錄取', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: `E2E 關閉審核 ${tag}`, date: plus(9), gather_time: '07:00', require_approval: true, notify: false } });
  await apiAs(request, 't_lead', `/events/${ev.id}/signup`, { method: 'POST', body: {} });
  await enter(page, 't_chair');
  await page.goto(`/#/edit/${ev.id}`);
  await page.locator('#ef [name=require_approval]').uncheck({ force: true });
  let msg = '';
  page.once('dialog', (d) => { msg = d.message(); d.accept(); });
  await page.getByRole('button', { name: '儲存' }).click();
  await expect(page).toHaveURL(new RegExp(`#/e/${ev.id}$`));
  expect(msg).toContain('還有 1 筆待審核');
  expect((await apiAs(request, 't_chair', `/events/${ev.id}/stats`)).total.pending).toBe(0);
});
