// 課表教練整合進課表分頁：P1 照課表記錄不必填距離（自主加練仍要填距離或時間）；P2 賽事準備、課表設定、分段與路由
import { test, expect } from '@playwright/test';
import { login, acceptPrivacyIfAsked, apiAs } from './helpers.mjs';

const enter = async (page, id) => { await login(page, id); await acceptPrivacyIfAsked(page); };

test('記錄訓練：課表日按「完成」不填距離也能存', async ({ page }) => {
  await enter(page, 't_other');
  await page.goto('/#/log?w=2&i=1');                      // W2 週二（已經過去的日子）
  await expect(page.locator('#lf [name=status][value=done]')).toBeChecked();
  await page.locator('#lf').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText('已記錄，辛苦了')).toBeVisible();
});

test('記錄訓練：自主加練沒填距離或時間會提醒', async ({ page }) => {
  await enter(page, 't_other');
  await page.goto('/#/log?extra=1');
  await page.locator('#lf').getByRole('button', { name: '儲存' }).click();
  await expect(page.getByText('填一下距離或時間')).toBeVisible();
  await expect(page.getByText('已記錄，辛苦了')).toHaveCount(0);
});

// ---------- P2：賽事準備、課表設定、分段與路由 ----------

test('分段：單週、全季、賽事、參考用 replace 切換（返回鍵不會在分段之間來回）', async ({ page }) => {
  await enter(page, 't_other');
  await page.goto('/#/plan');
  await expect(page.locator('#view .card h2').first()).toContainText(/W\d+|賽後恢復/);
  const before = await page.evaluate(() => history.length);
  for (const [name, hash] of [['全季', '#/plan/season'], ['賽事', '#/plan/race'], ['參考', '#/plan/guide'], ['單週', '#/plan']]) {
    await page.locator('.planseg').getByRole('button', { name }).click();
    await expect(page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`));
    await expect(page.locator('.planseg [aria-pressed="true"]')).toHaveText(name);
  }
  expect(await page.evaluate(() => history.length)).toBe(before);
  await expect(page.locator('#backBtn')).toBeHidden();
});

test('賽事準備：沒填身體資料時顯示空狀態；填了年齡、性別、體重就有年齡分級、心率與補給', async ({ page }) => {
  await enter(page, 't_other');
  await page.evaluate(() => localStorage.removeItem('cil-coach'));
  await page.goto('/#/plan/race');
  await expect(page.locator('#hr')).toContainText('到課表設定填年齡就會顯示心率');
  await expect(page.locator('#age')).toContainText('填年齡');
  await expect(page.locator('#fuel')).toContainText('到課表設定填體重就會顯示');
  await expect(page.locator('#view')).not.toContainText('bpm');
  await page.goto('/#/plan/setup?go=body');
  await page.locator('#bodyForm [name=age]').fill('47');
  await page.locator('#bodyForm [name=age]').blur();
  await page.locator('#bodyForm label.chip', { hasText: '男' }).click();
  await page.locator('#bodyForm [name=kg]').fill('63.5');
  await page.locator('#bodyForm [name=kg]').blur();
  await page.goto('/#/plan/race');
  await expect(page.locator('#hr table.hz')).toContainText('Z2');
  await expect(page.locator('#hr')).toContainText('估算');
  await expect(page.locator('#age .agemeter')).toBeVisible();
  await expect(page.locator('#fuel')).toContainText('肝醣超補');
});

test('半馬沒有年齡分級', async ({ page, request }) => {
  await apiAs(request, 't_other', '/me/plan', { method: 'PUT', body: { dist: 'hm', grp: 'C' } });
  try {
    await enter(page, 't_other');
    await page.evaluate(() => localStorage.setItem('cil-coach', JSON.stringify({ v: 1, body: { age: 45, sex: 'M' } })));
    await page.goto('/#/plan/race');
    await expect(page.locator('#age')).toContainText('半馬沒有年齡分級');
  } finally { await apiAs(request, 't_other', '/me/plan', { method: 'PUT', body: { dist: 'fm', grp: 'E' } }); }
});

test('隱私：身體資料不會出現在任何請求裡，只存在 cil-coach；登出時清除', async ({ page }) => {
  await enter(page, 't_other');
  const sent = [];
  page.on('request', (r) => sent.push(`${r.url()} ${r.postData() || ''}`));
  await page.goto('/#/plan/setup?go=body');
  const f = page.locator('#bodyForm');
  for (const [k, v] of [['age', '47'], ['kg', '63.5'], ['rest', '52']]) { await f.locator(`[name=${k}]`).fill(v); await f.locator(`[name=${k}]`).blur(); }
  await f.locator('label.chip', { hasText: '女' }).click();
  await page.goto('/#/plan/race');
  await expect(page.locator('#hr table.hz')).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cil-coach')).body);
  expect(stored).toMatchObject({ age: 47, kg: 63.5, rest: 52, sex: 'F' });
  for (const s of sent) {
    expect(s).not.toContain('63.5');
    expect(s).not.toMatch(/"(age|kg|rest|sex)"\s*:/);
    expect(s).not.toMatch(/[?&](age|kg|rest|sex)=/);
  }
  await page.goto('/#/me/security');
  await page.locator('#logout').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cil-coach'))).toBeNull();
});

test('課表設定：存組別只改項目與組別，課表頁副標題跟著變，暱稱不受影響', async ({ page, request }) => {
  await enter(page, 't_other');
  const before = (await apiAs(request, 't_other', '/me')).member;
  await page.goto('/#/plan/setup');
  await page.locator('#gtiles label.chip', { hasText: 'D 組' }).click();
  await page.locator('#grpSave').click();
  await expect(page.getByText('已儲存')).toBeVisible();
  await page.goto('/#/plan');
  await expect(page.locator('#view .lt p')).toContainText('全馬 D 組');
  const after = (await apiAs(request, 't_other', '/me')).member;
  expect(after.nickname).toBe(before.nickname);
  await apiAs(request, 't_other', '/me/plan', { method: 'PUT', body: { grp: before.grp } });
});

test('課表設定：選自己的比賽排課（W1 預覽），存檔後課表標「個人週期」，再改回協會賽季', async ({ page, request }) => {
  const d = new Date(Date.now() + 8 * 3600e3 + 200 * 864e5), date = d.toISOString().slice(0, 10);
  const { id } = await apiAs(request, 't_other', '/races', { method: 'POST', body: { name: 'E2E 測試馬拉松', date, dist: '全馬' } });
  try {
    await enter(page, 't_other');
    await page.goto(`/#/plan/setup?go=cycle&race=${id}`);
    await expect(page.locator('#cycle [name=cyc][value=race]')).toBeChecked();
    await expect(page.locator('#cycle .cycraces')).toContainText(/W1 .*開始，還有 \d+ 天/);
    await page.locator('#cycSave').click();
    await expect(page.getByText(/已改成跟 .* 排課/)).toBeVisible();
    // 右上角倒數是另一場時會問要不要一起換：不換
    const ask = page.locator('.sheet[aria-label="也把右上角倒數改成這場？"]');
    if (await ask.count()) await ask.getByRole('button', { name: '取消' }).click();
    await page.goto('/#/plan');
    await expect(page.locator('#view .lt p')).toContainText('個人週期');
    await page.goto('/#/plan/setup?go=cycle');
    await page.locator('#cycle label.cycopt', { hasText: '跟協會賽季' }).click();
    await page.locator('#cycSave').click();
    await expect(page.getByText('已改回協會賽季')).toBeVisible();
  } finally {
    await apiAs(request, 't_other', '/me/plan', { method: 'PUT', body: { cycle: 'club' } });
    if (id) await apiAs(request, 't_other', `/races/${id}`, { method: 'DELETE' });
  }
});

test('功能關閉：課表教練關掉時四個頁面顯示沒有開放，課表頁沒有分段', async ({ page, request }) => {
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { coach: false } });
  try {
    await enter(page, 't_other');
    for (const s of ['season', 'race', 'guide']) {
      await page.goto(`/#/plan/${s}`);
      await expect(page.locator('#view')).toContainText('這個功能目前沒有開放');
    }
    await page.goto('/#/plan');
    await expect(page.locator('#view .card h2').first()).toContainText(/W\d+|賽後恢復/);
    await expect(page.locator('.planseg')).toHaveCount(0);
  } finally { await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { coach: true } }); }
});

test('凍結時間：賽前 14 天、比賽前一天的倒數、比賽日、賽後恢復', async ({ page }) => {
  await enter(page, 't_other');
  await page.evaluate(() => localStorage.setItem('cil-coach', JSON.stringify({ v: 1, start: { '2026-12-20|2026 臺北馬拉松': '06:30' } })));
  const at = async (iso) => { await page.clock.install({ time: new Date(iso) }); await page.reload(); };
  await at('2026-12-06T09:00:00+08:00');
  await page.goto('/#/plan');
  await expect(page.locator('.stagecard')).toContainText('賽前 14 天');
  await at('2026-12-19T08:00:00+08:00');
  await page.goto('/#/plan/race');
  await expect(page.locator('#raceClock')).toContainText(/\d+:\d{2}/);
  await at('2026-12-20T05:00:00+08:00');
  await page.goto('/#/plan');
  await expect(page.locator('.stagecard.race')).toContainText('今天比賽');
  await at('2026-12-22T09:00:00+08:00');
  await page.goto('/#/plan');
  await expect(page.locator('.stagecard.recover')).toContainText('辛苦了');
});

test('倒數關閉：賽事準備改用我的賽事或協會賽季，課表頁不顯示賽前階段', async ({ page, request }) => {
  await apiAs(request, 't_other', '/me/countdown', { method: 'POST', body: { mode: 'off' } });
  try {
    await enter(page, 't_other');
    await page.clock.install({ time: new Date('2026-12-10T09:00:00+08:00') });
    await page.reload();
    await page.goto('/#/plan/race');
    await expect(page.locator('.card.bib .bibrace')).not.toBeEmpty();
    await page.goto('/#/plan');
    await expect(page.locator('.stagecard')).toHaveCount(0);
  } finally { await apiAs(request, 't_other', '/me/countdown', { method: 'POST', body: { mode: 'mine' } }); }
});
