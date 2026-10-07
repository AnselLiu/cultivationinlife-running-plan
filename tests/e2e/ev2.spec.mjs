// 索票、時間暫定、異動重新確認：幹部開索票活動、團員選張數與幹部發票、改地點後請已報名的人重新確認、暫定時間的標示（含英文介面）
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

const tag = () => Date.now().toString(36).slice(-4);
// 嚴重（critical）與重大（serious）的無障礙問題一律要修
const axeBad = async (page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations
  .filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.help}｜${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
const drop = (request, id) => (id ? apiAs(request, 't_chair', `/events/${id}`, { method: 'DELETE' }).catch(() => {}) : null);

test('幹部開索票活動：每人最多幾張、總張數上限，攜伴與加購不顯示；勾時間暫定', async ({ page, request }) => {
  let id = null;
  try {
    await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
    await page.goto('/#/new');
    const f = page.locator('#ef');
    await f.locator('[name=kind]').selectOption('claim');
    await expect(f.getByText('每人最多幾張')).toBeVisible();
    await expect(f.getByText('總張數上限')).toBeVisible();
    await expect(f.getByText('票發完就排候補')).toBeVisible();
    await expect(f.locator('label', { has: page.locator('[name=guest_max]') })).toBeHidden();
    await expect(f.locator('label.switch', { has: page.locator('[name=count_guests]') })).toBeHidden();
    await expect(page.locator('#itemBox')).toBeHidden();
    await f.locator('[name=title]').fill(`E2E 索票 ${tag()}`);
    await f.locator('[name=date]').fill(plus(6));
    await f.locator('[name=date]').dispatchEvent('change');
    await f.locator('[name=gather_time]').fill('19:15');
    await f.locator('[name=capacity]').fill('6');
    await f.locator('[name=claim_max]').fill('3');
    await f.locator('label', { has: page.locator('[name=time_tbd]') }).click();
    await expect(f.locator('[name=time_tbd]')).toBeChecked();
    if (await f.locator('[name=notify]').count()) await f.locator('[name=notify]').uncheck();
    const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST', { timeout: 10000 });
    await page.getByRole('button', { name: '建立' }).click();
    id = (await (await created).json()).id;
    expect(id, '建立索票活動失敗').toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`#/e/${id}$`));
    await expect(page.locator('.hero .pill').first()).toHaveText('索票');
    await expect(page.locator('.hero')).toContainText('時間暫定');
    await expect(page.locator('#myStatusH')).toHaveText('已登記 0 / 6 張');
    await expect(page.locator('#myStatus')).toContainText('每人最多 3 張');
  } finally { await drop(request, id); }
});

test('團員索票選 3 張，幹部在統計頁勾「已發票」；首頁卡片顯示張數', async ({ page, request }) => {
  // 先開一場較早的活動：索票那場不會是首頁最上面的大卡，一定是下面的活動卡片
  const early = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: `E2E 索票前一場 ${tag()}`, date: plus(1), gather_time: '06:00', notify: false } });
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'claim', title: `E2E 公關票 ${tag()}`, date: plus(7), gather_time: '19:15', guest_max: 3, capacity: 6, notify: false } });
  try {
    expect(ev.id, '建立索票活動失敗').toBeTruthy();
    await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
    await page.goto(`/#/e/${ev.id}`);
    await expect(page.locator('#pform legend')).toContainText('要幾張？');
    await page.getByLabel('張數').selectOption('2');   // 本人那張也算：value 2＝3 張
    await page.getByRole('button', { name: '我要索票' }).click();
    await expect(page.locator('#toasts .toast')).toContainText('已登記 3 張');
    await expect(page.locator('#myStatus .roster')).toContainText('3 張');
    await expect(page.locator('#myStatusMsg')).toContainText('你已登記 3 張');
    // 首頁：卡片顯示「3/6」、類型標籤是索票的顏色
    await page.goto('/#/');
    const card = page.locator(`a.card[href="#/e/${ev.id}"]`);
    await expect(card.locator('.evright .tiny.num')).toHaveText('3/6');
    await expect(card.locator('.evright .mine')).toHaveText('已登記');
    await expect(card.locator('.pills .pill').first()).toHaveClass(/\bclaim\b/);

    await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
    await page.goto(`/#/e/${ev.id}/stats`);
    const kpi = (k) => page.locator('.kpi', { has: page.locator('span.tiny', { hasText: new RegExp(`^${k}$`) }) }).locator('b');
    await expect(kpi('已登記')).toHaveText('3 張');
    await expect(page.getByText('已登記 3 張／共 6 張・剩 3 張')).toBeVisible();
    await expect(kpi('已發票')).toHaveText('0/3 張');
    await expect(kpi('登記人數')).toHaveText('1');
    // 勾「已發票」就地更新張數：搜尋字與焦點都留著（現場一路勾下去）
    await page.locator('#pq').fill(' ');
    await page.locator('.prow [data-pick]').first().click();
    await expect(kpi('已發票')).toHaveText('3/3 張');
    await expect(page.locator('.prow [data-pick]').first()).toBeChecked();
    await expect(page.locator('.prow [data-pick]').first()).toBeFocused();
    await expect(page.locator('#pq')).toHaveValue(' ');
    await page.locator('.prow [data-pick]').first().click();
    await expect(kpi('已發票')).toHaveText('0/3 張');
    await expect(page.getByText(/^名單格式：1\. 名字 \/ 2張/)).toBeVisible();
  } finally { await drop(request, ev.id); await drop(request, early.id); }
});

test('異動重新確認：改地點時請已報名的人確認，「仍參加」與「取消報名」，統計頁未確認篩選', async ({ page, request }) => {
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: `E2E 重新確認 ${tag()}`, date: plus(8), gather_time: '06:00', place: '臺北田徑場', notify: false } });
  try {
    expect(ev.id, '建立活動失敗').toBeTruthy();
    for (const who of ['t_runner', 't_other']) await apiAs(request, who, `/events/${ev.id}/signup`, { method: 'POST', body: {} });
    // 時間只到秒：跟發布通知同一秒報名的人算已確認，先等過這一秒
    await page.waitForTimeout(1100);
    await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
    await page.goto(`/#/e/${ev.id}`);
    await page.getByText('發布通知或異動（改時間、改地點、取消）').click();
    await page.locator('#noticeForm label.chip', { hasText: '改地點' }).click();
    await page.locator('#noticeForm [name=place]').fill('大佳河濱公園');
    await page.locator('#noticeForm label.switch', { has: page.locator('[name=reconfirm]') }).click();
    await expect(page.locator('#noticeForm [name=reconfirm]')).toBeChecked();
    await page.getByRole('button', { name: /送出並通知/ }).click();
    await expect(page.locator('#toasts .toast')).toContainText('已通知 2 人，請 2 人重新確認');

    // 團員：首頁標「請確認」；從通知的連結（?rc=1）進來，焦點在確認卡
    await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
    await page.goto('/#/');
    await expect(page.locator(`a.card[href="#/e/${ev.id}"]`)).toContainText('請確認');
    await page.goto(`/#/e/${ev.id}?rc=1`);
    await expect(page.locator('#rcBanner')).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#/e/${ev.id}$`));
    expect(await axeBad(page)).toEqual([]);
    await page.locator('#rcYes').click();
    await expect(page.locator('#toasts .toast')).toContainText('已確認，謝謝你');
    await expect(page.locator('#rcBanner')).toHaveCount(0);

    await login(page, 't_other'); await acceptPrivacyIfAsked(page);
    await page.goto(`/#/e/${ev.id}`);
    await page.locator('#rcNo').click();
    await page.getByRole('dialog').getByRole('button', { name: '取消報名' }).click();
    await expect(page.locator('#toasts .toast')).toContainText('已取消報名');
    await expect(page.locator('#rcBanner')).toHaveCount(0);
    await expect(page.locator('#cancel')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '我要報名' })).toBeVisible();

    // 主辦：未確認篩選（已確認的人不在列表）、已取消的那一列寫「異動後取消」
    await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
    await page.goto(`/#/e/${ev.id}/stats?f=unconfirmed`);
    await expect(page.locator('[data-f=unconfirmed]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.prow:not([hidden])')).toHaveCount(0);
    expect(await axeBad(page)).toEqual([]);
    await page.locator('[data-f=confirmed]').click();
    await expect(page.locator('.prow:not([hidden])')).toHaveCount(1);
    await page.locator('[data-f=cancel]').click();
    await expect(page.locator('.prow:not([hidden])')).toHaveCount(1);
    await expect(page.locator('.prow:not([hidden])')).toContainText('異動後取消');
  } finally { await drop(request, ev.id); }
});

test('時間暫定：首頁卡片與行事曆標「（暫定）」，英文介面是 (tentative) 與 Time TBC', async ({ page, request }) => {
  const date = plus(10);
  const early = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'track', title: `E2E 暫定前一場 ${tag()}`, date: plus(1), gather_time: '06:00', notify: false } });
  const ev = await apiAs(request, 't_chair', '/events', { method: 'POST', body: { kind: 'long', title: `E2E 暫定 ${tag()}`, date, gather_time: '06:00', time_tbd: true, notify: false } });
  try {
    expect(ev.id, '建立活動失敗').toBeTruthy();
    await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
    await page.goto('/#/');
    const card = page.locator(`a.card[href="#/e/${ev.id}"]`);
    await expect(card.locator('.tbdtag')).toHaveText('（暫定）');
    await page.goto(`/#/calendar?m=${date.slice(0, 7)}`);
    await page.locator(`[data-day="${date}"]`).click();
    await expect(page.locator('#dayBox')).toContainText('06:00 集合（暫定）');

    await page.evaluate(() => localStorage.setItem('cil-lang', 'en'));
    try {
      await page.goto('/#/');
      await page.reload();
      await expect(card.locator('.tbdtag')).toContainText('(tentative)');
      await page.goto(`/#/e/${ev.id}`);
      await expect(page.locator('.hero')).toContainText('Time TBC');
    } finally { await page.evaluate(() => localStorage.removeItem('cil-lang')); }
  } finally { await drop(request, ev.id); await drop(request, early.id); }
});
