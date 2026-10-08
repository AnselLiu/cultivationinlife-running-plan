// 成績與挑戰（管理後台）：功能開關的分組、權限對照、成績審核（比目前 PB 快、官方連結、核准、婉拒選常用原因）、截圖全螢幕（Esc 關閉、焦點回縮圖）、
//   挑戰編輯（時間門檻的常用目標、預覽句子、發布不通知、發布後條件停用；體重類型的恭喜榜停用）、團服（結算、統計、就地勾已發放、CSV）、
//   見證體重量測（手動輸入代碼）、監事唯讀、稽核的「成績」分組、axe（淺色深色 375px、不水平捲動）
//   workers = 1：功能開關一次只有這個檔案在改；結束時關回去、刪掉測試建立的成績、取消測試建立的挑戰
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked, plus } from './helpers.mjs';

const enter = async (page, id) => { await login(page, id); await acceptPrivacyIfAsked(page); };
const setAchieve = async (request, on) => {
  const f = (await apiAs(request, 't_chair', '/me')).settings?.features || {};
  await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { ...f, achieve: on, achieve_rank: on } });
};
const axeBad = async (page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations
  .filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
// 不是 JSON 的回應（CSV）：照 apiAs 的方式帶登入 cookie
async function rawAs(request, id, path) {
  const r = await request.get(`/api/dev/login?id=${id}`, { maxRedirects: 0 });
  const cookie = r.headers()['set-cookie'].split(';')[0];
  return request.get(`/api${path}`, { headers: { cookie } });
}
const RESULT = 'https://www.sportsnet.org.tw/e2e';
const pbs = [], camps = [];
const logPb = async (request, who, body) => {
  const r = await apiAs(request, who, '/pb', { method: 'POST', body: { dist_key: 'fm', result_url: RESULT, ...body } });
  expect(r.id, JSON.stringify(r)).toBeTruthy();
  pbs.push([who, r.id]);
  return r.id;
};
const newCamp = async (request, body) => {
  const r = await apiAs(request, 't_chair', '/admin/ach', { method: 'POST', body: { intro: null, team_id: null, members_only: false, opts: {}, confirm: false, ...body } });
  expect(r.id, JSON.stringify(r)).toBeTruthy();
  camps.push(r.id);
  return r.id;
};

test.describe.serial('成績與挑戰：後台', () => {
  test.beforeAll(async ({ request }) => { await setAchieve(request, false); });
  test.afterAll(async ({ request }) => {
    try {
      for (const [who, id] of pbs) await apiAs(request, who, `/pb/${id}`, { method: 'DELETE' }).catch(() => {});
      for (const id of camps) await apiAs(request, 't_chair', `/admin/ach/${id}/cancel`, { method: 'POST', body: { note: '測試結束' } }).catch(() => {});
    } finally { await setAchieve(request, false); }
  });

  test('功能開關：「成績與挑戰」分組有兩個開關，存檔後重新整理仍是開', async ({ page }) => {
    await enter(page, 't_chair');
    await page.goto('/#/admin/settings/features');
    const grp = page.locator('fieldset.featgrp', { has: page.locator('legend', { hasText: /^成績與挑戰$/ }) });
    await expect(grp).toContainText('成績與挑戰（PB 登錄、目標挑戰、恭喜榜）');
    await expect(grp).toContainText('恭喜榜的各距離 PB 排行');
    for (const k of ['achieve', 'achieve_rank']) {
      const sw = grp.locator(`input[name=${k}]`);
      await expect(sw).not.toBeChecked();
      await grp.locator('label.switch', { has: page.locator(`input[name=${k}]`) }).click();   // has 的定位要相對於 label（不能用從 fieldset 開始的 sw）
      await expect(sw).toBeChecked();
    }
    await page.locator('#featForm').getByRole('button', { name: '儲存功能開關' }).click();
    await expect(page.getByText(/已儲存|已更新/).first()).toBeVisible();
    await page.reload();
    await acceptPrivacyIfAsked(page);
    for (const k of ['achieve', 'achieve_rank']) await expect(page.locator(`#featForm input[name=${k}]`)).toBeChecked();
  });

  test('權限對照：「成績與挑戰」欄，理事長、行政人員打勾，監事沒有', async ({ page }) => {
    await enter(page, 't_chair');
    await page.goto('/#/admin?tab=roles');
    const hd = page.locator('.permtable .hd span');
    await expect(hd.last()).toHaveText('成績與挑戰');
    const col = await hd.count();
    const cell = (role) => page.locator('.permtable .rw').filter({ has: page.locator('span:first-child', { hasText: new RegExp(`^${role}$`) }) }).locator(`> span:nth-child(${col})`);
    await expect(cell('理事長').locator('i.yes')).toHaveCount(1);
    await expect(cell('行政人員').locator('i.yes')).toHaveCount(1);
    await expect(cell('監事').locator('i.yes')).toHaveCount(0);
  });

  test('成績審核：比目前 PB 快、開官方成績；核准一筆、婉拒一筆（常用原因），卡片離開清單；跑友看到原因', async ({ page, request }) => {
    // 先有一筆核准過的全馬（比較慢），再送一筆更快的與一筆要婉拒的
    const base = await logPb(request, 't_runner', { seconds: 15000, race_name: 'E2E 基準馬', race_date: plus(-61) });
    expect((await apiAs(request, 't_chair', `/admin/pb/${base}/review`, { method: 'POST', body: { approve: true } })).status).toBe('approved');
    const fast = await logPb(request, 't_runner', { seconds: 14400 - 61, race_name: 'E2E 秋季馬', race_date: plus(-33) });
    const bad = await logPb(request, 't_runner', { seconds: 14800, race_name: 'E2E 冬季馬', race_date: plus(-27) });
    await enter(page, 't_staff');
    await page.goto('/#/admin/ach');
    await expect(page.locator('#view h1')).toHaveText('成績與挑戰');
    await expect(page.locator('[data-achtab="queue"]')).toHaveAttribute('aria-pressed', 'true');
    const card = page.locator(`[data-pb="${fast}"]`);
    await expect(card).toContainText('比目前 PB 快');
    await expect(card).toContainText('11:01');   // 15000 − 14339 秒
    await expect(card).toContainText('測試跑友');
    await expect(card.locator('a.adm-ach-link')).toHaveAttribute('href', RESULT);
    await expect(card.locator('a.adm-ach-link')).toHaveAttribute('rel', /noopener/);
    await expect(card.locator('a.adm-ach-link')).toContainText('開官方成績');
    await card.getByRole('button', { name: '核准' }).click();
    await expect(page.locator('.toast')).toContainText('已核准');
    await expect(card).toHaveCount(0);
    const bc = page.locator(`[data-pb="${bad}"]`);
    await bc.getByRole('button', { name: '婉拒' }).click();
    const dlg = page.getByRole('dialog', { name: '婉拒這筆成績' });
    await dlg.getByRole('button', { name: '連結打不開' }).click();
    await dlg.locator('[data-ok]').click();
    await expect(page.locator('.toast')).toContainText('已婉拒');
    await expect(bc).toHaveCount(0);
    const mine = await apiAs(request, 't_runner', '/pb');
    const r = mine.items.find((x) => x.id === bad);
    expect(r.status).toBe('rejected');
    expect(r.review_note).toBe('連結打不開');
    // 已婉拒分頁看得到，而且可以改判核准
    await page.locator('[data-pbst="rejected"]').click();
    await expect(page.locator(`[data-pb="${bad}"]`)).toContainText('改判核准');
  });

  test('截圖：點縮圖開全螢幕，Esc 關閉，焦點回到縮圖', async ({ page, request }) => {
    await page.goto('/');
    const proof = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 60; c.height = 40; const g = c.getContext('2d'); g.fillStyle = '#1C4698'; g.fillRect(0, 0, 30, 40); return c.toDataURL('image/jpeg', 0.8); });
    const id = await logPb(request, 't_other', { seconds: 16000, race_name: 'E2E 截圖馬', race_date: plus(-17), result_url: null, proof });
    await enter(page, 't_staff');
    await page.goto('/#/admin/ach');
    const thumb = page.locator(`[data-proof="${id}"]`);
    await expect(thumb).toBeVisible();
    await expect(page.locator(`[data-pb="${id}"]`)).toContainText('只有截圖、沒有官方連結');
    await thumb.click();
    const viewer = page.locator('.sheet.adm-ach-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('img.adm-ach-full')).toHaveAttribute('src', /^blob:/);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(thumb).toBeFocused();
  });

  test('挑戰編輯：常用目標「4:00:00」、預覽句子、發布不通知；發布後條件停用；體重類型的恭喜榜停用並說明', async ({ page }) => {
    await enter(page, 't_chair');
    await page.goto('/#/admin/ach?tab=campaigns');
    await page.getByRole('link', { name: '新增挑戰' }).click();
    await expect(page).toHaveURL(/#\/admin\/ach\/new$/);
    await expect(page.locator('#view h1')).toHaveText('新增挑戰');
    await expect(page.locator('input[name=kind][value=time]')).toBeChecked();
    await page.locator('#achPresets [data-preset="14400"]').click();
    await expect(page.locator('#achForm [name=th]')).toHaveValue('4');
    await page.locator('#achForm [name=title]').fill('E2E 全馬破 4');
    await expect(page.locator('#achPrev')).toContainText('期間內全馬跑進 4:00:00');
    await page.locator('#achPub').click();
    await page.getByRole('dialog', { name: '發布挑戰' }).getByRole('button', { name: '發布，不通知' }).click();
    await expect(page).toHaveURL(/#\/admin\/ach\/c\/[\w-]+$/);
    camps.push(page.url().split('/').pop());
    await expect(page.locator('.adm-ach-head')).toContainText('E2E 全馬破 4');
    await expect(page.locator('.adm-ach-head .adm-ach-rules')).toContainText('期間內全馬跑進 4:00:00');
    await page.locator('.adm-ach-head').getByRole('link', { name: '編輯' }).click();
    await expect(page.locator('#view h1')).toHaveText('修改挑戰');
    await expect(page.locator('#achForm')).toContainText('挑戰開始後不能改條件');
    await expect(page.locator('input[name=kind][value=pb]')).toBeDisabled();
    await expect(page.locator('#achForm [name=th]')).toBeDisabled();
    await expect(page.locator('#achForm [name=title]')).toBeEnabled();
    await expect(page.locator('#achForm [name=end]')).toBeEnabled();
    // 體重類型：恭喜榜停用、說明為什麼；建議中性名稱
    await page.goto('/#/admin/ach/new');
    await page.locator('label.adm-ach-kind', { has: page.locator('input[value=weight]') }).click();
    await expect(page.locator('#achForm [name=board]')).toBeDisabled();
    await expect(page.locator('#achBoardHint')).toHaveText('體重挑戰一律不上榜，避免讓人知道誰參加了減重');
    await expect(page.locator('#achForm')).toContainText('建議用中性的名稱');
    // 榮譽制不能送團服
    await expect(page.locator('#achForm [name=shirt]')).toBeDisabled();
  });

  test('團服：結算後統計正確，勾「已發放」就地更新（焦點留在勾選框），CSV 有 BOM 與標題列', async ({ page, request }) => {
    const cid = await newCamp(request, { title: 'E2E 團服挑戰', kind: 'time', dist_key: 'fm', target: 14400,
      rewards: { badge: 'shirt', shirt: { sizes: ['S', 'M', 'L'], quota: 2, size_by: null, chart: null, pool: null } },
      start_date: plus(-3), end_date: plus(0), join_by: plus(0) });
    await apiAs(request, 't_chair', `/admin/ach/${cid}/open`, { method: 'POST', body: { announce: false } });
    const j = await apiAs(request, 't_other', `/ach/${cid}/join`, { method: 'POST', body: { shirt_size: 'M' } });
    expect(j.ok, JSON.stringify(j)).toBeTruthy();
    const p = await logPb(request, 't_other', { seconds: 14000, race_name: 'E2E 期間內', race_date: plus(-1) });
    const rv = await apiAs(request, 't_chair', `/admin/pb/${p}/review`, { method: 'POST', body: { approve: true } });
    expect(rv.achieved.map((a) => a.cid)).toContain(cid);
    // 結算：時間推到結束後第 8 天上午 10 點（台北）；同一個整點的其他排程工作先跳過（週報、清理會用掉額度，結算就延到下一個整點）
    const OTHER_JOBS = 'events,opsAlerts,backup,signupOpen,followups,weather,signupReviews,digest,renewals,retention,auditDigest,monthSummary,review,fatigue,weeklyReport,cams,rest,promoteSweep,push';
    const st = await (await request.get(`/api/dev/cron?at=${plus(8)}T02:00:00Z&skip=${OTHER_JOBS}`)).json();
    expect(st.achSettle, JSON.stringify(st)).not.toBe('deferred');
    await enter(page, 't_chair');
    await page.goto(`/#/admin/ach/c/${cid}`);
    await expect(page.locator('.adm-ach-head .pill').first()).toHaveText('已結算');
    await expect(page.locator('[data-n="granted"] b')).toHaveText('1');
    await expect(page.locator('[data-n="issued"] b')).toHaveText('0');
    const box = page.locator('[data-issue]').first();
    await expect(box).toHaveAccessibleName(/已發放：路人跑友/);
    await box.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.toast')).toContainText('已標記發放');
    await expect(box).toBeChecked();
    await expect(box).toBeFocused();
    await expect(page.locator('[data-n="issued"] b')).toHaveText('1');
    await expect(page.locator('.adm-ach-erow [data-rw]').first()).toHaveText('已發放');
    for (const view of ['list', 'order']) {
      const r = await rawAs(request, 't_chair', `/admin/ach/${cid}/shirts.csv?view=${view}`);
      expect(r.status()).toBe(200);
      const text = await r.text();
      expect(text.charCodeAt(0), `${view} 有 BOM`).toBe(0xfeff);
      expect(text, view).toContain('\r\n');
      if (view === 'list') expect(text.split('\r\n')[0]).toContain('姓名');
      else expect(text).not.toContain('路人跑友');
    }
    await expect(page.locator('a[href$="view=order"]')).toHaveText('下載訂製統計（CSV）');
    await expect(page.locator('.adm-ach-shirtbox')).toContainText('不要轉給廠商');
  });

  test('見證體重量測：手動輸入見證碼與體重計讀數，訊息只說「已見證」，不顯示任何數字', async ({ page, request }) => {
    const cid = await newCamp(request, { title: 'E2E 秋季體態挑戰', kind: 'weight', dist_key: null, target: 3, opts: { verify: 'witness' },
      rewards: { badge: 'heart' }, start_date: plus(0), end_date: plus(40), join_by: plus(14) });
    await apiAs(request, 't_chair', `/admin/ach/${cid}/open`, { method: 'POST', body: { announce: false } });
    const j = await apiAs(request, 't_runner', `/ach/${cid}/join`, { method: 'POST', body: { consent: true } });
    expect(j.ok, JSON.stringify(j)).toBeTruthy();
    const w = await apiAs(request, 't_runner', `/ach/${cid}/weigh`, { method: 'POST', body: { which: 'base', kg: 72.4 } });
    expect(w.token).toBeTruthy();
    await enter(page, 't_chair');
    await page.goto(`/#/admin/ach/c/${cid}`);
    await expect(page.locator('#view')).toContainText('體重挑戰不顯示誰有沒有達成');
    await page.locator('#achWit').click();
    const sheet = page.locator('.sheet');
    await sheet.locator('[name=kg]').fill('72.5');
    await sheet.locator('input[name=code]').fill(w.token.match(/.{1,4}/g).join(' '));
    await sheet.locator('form:not(#achKgF)').getByRole('button', { name: '送出' }).click();
    await expect(sheet.locator('.scanmsg')).toHaveText(/^已見證 .+ 的起始量測$/);
    await expect(sheet.locator('.scanmsg')).not.toContainText(/\d/);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    // 名單（重新整理）：只有見證進度，沒有有沒有達成
    await page.reload();
    await acceptPrivacyIfAsked(page);
    const row = page.locator('.adm-ach-erow', { hasText: '測試跑友' });
    await expect(row).toContainText('起始已見證');
    await expect(row).toContainText('參加中');
    await expect(row).not.toContainText(/已達成|沒有達成|72/);
  });

  test('監事：只有挑戰分頁，沒有新增挑戰、沒有成績審核；挑戰頁看不到名單與按鈕', async ({ page }) => {
    await enter(page, 't_super');
    await page.goto('/#/admin/ach');
    await expect(page.locator('#view h1')).toHaveText('成績與挑戰');
    await expect(page.locator('[data-achtab]')).toHaveCount(0);
    await expect(page.locator('#view')).toContainText('監事只能看挑戰清單與彙總數字');
    await expect(page.getByRole('link', { name: '新增挑戰' })).toHaveCount(0);
    await expect(page.locator('[data-pb]')).toHaveCount(0);
    const first = page.locator('a.adm-ach-camp').first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page.locator('#view h1')).toHaveText('挑戰管理');
    await expect(page.locator('#view')).toContainText('監事看不到名單。');
    await expect(page.locator('#achOpen, #achCancel, #achDel, #achRoster, #achWit, [data-issue]')).toHaveCount(0);
  });

  test('稽核：「成績」分組看得到「核准成績」與「距離：全馬」（不是代碼）', async ({ page }) => {
    await enter(page, 't_chair');
    await page.goto('/#/admin?tab=audit');
    await page.locator('#auf [name=action]').selectOption('pb');
    await page.locator('#auf').getByRole('button', { name: '查詢' }).click();
    const list = page.locator('#auList');
    await expect(list).toContainText('核准成績');
    await expect(list).toContainText('距離：全馬');
    await expect(list).toContainText('原因：連結打不開');
    await expect(list).not.toContainText(/d=fm|r=link/);
  });

  for (const scheme of ['light', 'dark']) test(`無障礙：成績與挑戰的三個分頁、編輯頁、挑戰管理頁（375px，${scheme}）`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await enter(page, 't_chair');
    for (const tab of ['queue', 'met', 'campaigns', 'shirts']) {
      await page.goto(`/#/admin/ach?tab=${tab}`);
      await expect(page.locator(`[data-achtab="${tab}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#achPanel > *').first()).toBeVisible();
      expect(await axeBad(page), tab).toEqual([]);
      expect(await noHScroll(page), `${tab} 水平捲動`).toBe(true);
    }
    await page.goto('/#/admin/ach/new');
    await expect(page.locator('#achForm')).toBeVisible();
    expect(await axeBad(page), 'new').toEqual([]);
    expect(await noHScroll(page), 'new 水平捲動').toBe(true);
    const cid = camps[0];
    await page.goto(`/#/admin/ach/c/${cid}`);
    await expect(page.locator('.adm-ach-head')).toBeVisible();
    expect(await axeBad(page), 'camp').toEqual([]);
    expect(await noHScroll(page), 'camp 水平捲動').toBe(true);
  });
});
