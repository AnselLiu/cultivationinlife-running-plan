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

// ---------- P3：單週課表與首頁（快速打勾、離線、可省略、用語、滑動、今天、個人週期） ----------
const logsOf = async (request, id, from, to) => (await apiAs(request, id, `/logs?from=${from}&to=${to}`)).logs || [];
// 協會 W3（已經過去的一週）：8/17–8/23
const W3 = ['2026-08-17', '2026-08-23'];
const firstTick = (page) => page.locator('.days .day:not(.logged) .tick:not([disabled])').first();

test('快速打勾：記一筆、更新完成率，連點也只有一筆，復原會刪掉', async ({ page, request }) => {
  await enter(page, 't_other');
  await page.goto('/#/plan/3');
  const before = await logsOf(request, 't_other', ...W3);
  const ring = page.locator('.logsum .ring');
  const pct0 = await ring.getAttribute('aria-label');
  const tick = firstTick(page);
  const label = await tick.getAttribute('aria-label');
  await tick.dblclick();
  await expect(page.getByText('已記錄完成')).toBeVisible();
  const after = await logsOf(request, 't_other', ...W3);
  expect(after.length).toBe(before.length + 1);
  const added = after.find((l) => !before.some((b) => b.id === l.id));
  expect(added).toMatchObject({ status: 'done', week_no: 3 });
  expect(added.cycle_anchor ?? null).toBeNull();
  await expect(ring).not.toHaveAttribute('aria-label', pct0);
  await expect(page.locator(`.days .tick[aria-label="${label}"]`)).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '復原' }).click();
  await expect(page.getByText('已復原')).toBeVisible();
  expect((await logsOf(request, 't_other', ...W3)).length).toBe(before.length);
});

test('離線打勾：先存在手機，復原從暫存區拿掉；連上網路補傳不重複', async ({ page, context, request }) => {
  await enter(page, 't_other');
  await page.goto('/#/plan/3');
  const before = await logsOf(request, 't_other', ...W3);
  await context.setOffline(true);
  await firstTick(page).click();
  await expect(page.getByText('目前離線，已先存在手機')).toBeVisible();
  const q1 = await page.evaluate(() => JSON.parse(localStorage.getItem('cil-log-queue') || '[]'));
  expect(q1).toHaveLength(1);
  expect(q1[0].qid).toBeTruthy();
  await page.getByRole('button', { name: '復原' }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cil-log-queue'))).toBeNull();
  // 再打一次勾，連上網路後自動補傳；再補傳一次（模擬另一台裝置）也不會多一筆
  await firstTick(page).click();
  const q2 = await page.evaluate(() => JSON.parse(localStorage.getItem('cil-log-queue') || '[]'));
  expect(q2).toHaveLength(1);
  await context.setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cil-log-queue'))).toBeNull();
  const { queued, qid, ...body } = q2[0];
  const again = await apiAs(request, 't_other', '/logs', { method: 'POST', body: { ...body, if_absent: true } });
  expect(again.existed).toBe(true);
  const after = await logsOf(request, 't_other', ...W3);
  expect(after.length).toBe(before.length + 1);
  await apiAs(request, 't_other', `/logs/${again.id}`, { method: 'DELETE' });
});

test('可省略：每週 4 天時課表標「可省略」，完成率的分母一起變少', async ({ page }) => {
  await enter(page, 't_other');
  const denom = async () => Number((await page.locator('.logsum .lstats span').first().innerText()).match(/\/(\d+)/)[1]);
  await page.evaluate(() => localStorage.setItem('cil-coach', JSON.stringify({ v: 1, plan: { days: 6, club: true, vol: null } })));
  await page.goto('/#/plan/3');
  await expect(page.locator('.days .pill.opt')).toHaveCount(0);
  const six = await denom();
  await page.evaluate(() => localStorage.setItem('cil-coach', JSON.stringify({ v: 1, plan: { days: 4, club: true, vol: null } })));
  await page.reload();
  const opt = await page.locator('.days .pill.opt').count();
  expect(opt).toBeGreaterThan(0);
  expect(await denom()).toBe(six - opt);
  await expect(page.locator('.warnslot .notice')).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('cil-coach'));
});

test('用語：點開說明、標示本週全部（?hl=）；詳細內容有主課與配速、沒填年齡不顯示 bpm', async ({ page }) => {
  await enter(page, 't_other');
  await page.evaluate(() => localStorage.removeItem('cil-coach'));
  await page.goto('/#/plan/3');
  const term = page.locator('.days button.term').first();
  await expect(term).toBeVisible();
  const key = await term.getAttribute('data-term');
  await term.click();
  const dlg = page.locator('[role=dialog]').filter({ hasText: '本週' });
  await expect(dlg).toContainText(/本週 \d+ 堂用到/);
  await dlg.getByRole('button', { name: '標示本週全部' }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]hl=${key}`));
  expect(await page.locator('.days .day.term-hl').count()).toBeGreaterThan(0);
  const xd = page.locator('.days .day.quality').filter({ hasText: /\d\s*[xX]\s*\d/ }).locator('details.xd').first();   // 間歇課（有主課）
  await xd.locator('summary').click();
  await expect(xd).toContainText('主課');
  await expect(xd).toContainText('配速');
  await expect(page.locator('.days')).not.toContainText('bpm');
});

test('滑動換週：從螢幕邊緣 24px 內開始不換週，中間滑動才換', async ({ page }) => {
  await enter(page, 't_other');
  await page.goto('/#/plan/5');
  await expect(page.locator('#xall')).toBeVisible();   // 閒下來才載入的加強功能（滑動、用語）已經接上
  const swipe = (x0, x1) => page.evaluate(([a, b]) => {
    const el = document.querySelector('.days .day .dl'), y = el.getBoundingClientRect().top + 10;
    const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t(a)], changedTouches: [t(a)] }));
    el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t(b)] }));
  }, [x0, x1]);
  await swipe(10, 200);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/#\/plan\/5$/);
  await swipe(300, 100);
  await expect(page).toHaveURL(/#\/plan\/6$/);
});

test('首頁：比賽日顯示「今天就是 臺北馬拉松」；週末的課週六、週日都出現', async ({ page }) => {
  await enter(page, 't_other');
  const at = async (iso) => { await page.clock.install({ time: new Date(iso) }); await page.goto('/#/'); await page.reload(); };
  await at('2026-12-20T07:00:00+08:00');
  await expect(page.locator('.todaycard')).toContainText('今天就是 臺北馬拉松');
  await at('2026-12-12T07:00:00+08:00');
  const sat = await page.locator('.todaycard h2.long').innerText();
  await expect(page.locator('.todaycard')).toContainText('擇一天');
  await at('2026-12-13T07:00:00+08:00');
  await expect(page.locator('.todaycard h2.long')).toHaveText(sat);
});

test('契約：課表頁與首頁的導覽選擇器還在；首頁不會載入 coach.js、coachcalc.js、coachpdf.js', async ({ page }) => {
  const urls = [];
  page.on('request', (r) => urls.push(new URL(r.url()).pathname));
  await enter(page, 't_other');
  await page.clock.install({ time: new Date('2026-11-17T07:00:00+08:00') });   // 未來的週二：還沒有紀錄
  await page.goto('/#/');
  await page.reload();
  await expect(page.locator('.todaycard .btn').first()).toBeVisible();
  await page.waitForTimeout(2000);
  for (const f of ['/coach.js', '/coachcalc.js', '/coachpdf.js']) expect(urls).not.toContain(f);
  await page.goto('/#/plan/3');
  for (const s of ['.logsum', '.days .day', '.days .logbtn']) await expect(page.locator(s).first()).toBeVisible();
});

test('英文介面：課表頁除了 translate=no 以外沒有中文', async ({ page }) => {
  await enter(page, 't_other');
  await page.evaluate(() => localStorage.setItem('cil-lang', 'en'));
  try {
    await page.goto('/#/plan/3');
    await page.reload();
    await page.locator('.days button.term').first().waitFor();
    const left = await page.evaluate(() => {
      const out = [], w = document.createTreeWalker(document.querySelector('#view'), NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) if (/[一-鿿]/.test(n.nodeValue) && !n.parentElement.closest('[translate=no]')) out.push(n.nodeValue.trim());
      return out;
    });
    expect(left).toEqual([]);
  } finally { await page.evaluate(() => localStorage.removeItem('cil-lang')); }
});

test('個人週期：打勾記成個人週次、首頁標個人 W、?c=club 只能看、公告收起來、換回協會後列在其他週期', async ({ page, request }) => {
  // 比賽日排在讓「今天」落在個人 W3：W1 星期一＝這週一往前兩週；W1＝比賽那週的星期一往前 133 天，所以比賽日（週日）＝這週一＋125 天
  const now = new Date(Date.now() + 8 * 3600e3), dow = (now.getUTCDay() + 6) % 7;
  const mon = new Date(now.getTime() - dow * 864e5), raceDay = new Date(mon.getTime() + 125 * 864e5);
  const date = raceDay.toISOString().slice(0, 10), w2from = new Date(mon.getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const { id } = await apiAs(request, 't_other', '/races', { method: 'POST', body: { name: 'E2E 個人週期馬', date, dist: '全馬' } });
  const r = await apiAs(request, 't_other', '/me/plan', { method: 'PUT', body: { cycle: 'race', race_id: id } });
  expect(r.planCycle?.kind).toBe('race');
  const club = (await apiAs(request, 't_other', '/me')).member;
  let post = null;
  try {
    const clubWeek = Math.floor((mon - new Date('2026-08-03T00:00:00Z')) / (7 * 864e5)) + 1;
    if (clubWeek >= 1 && clubWeek <= 21) post = await apiAs(request, 't_chair', '/plans', { method: 'POST', body: { title: 'E2E 協會公告', body: '測試', week_no: clubWeek, notify: false } });
    await enter(page, 't_other');
    await page.goto('/#/plan');
    await expect(page.locator('#view .card h2').first()).toContainText('W3');
    await expect(page.locator('#view .lt p')).toContainText('個人週期');
    if (post?.id) {
      await expect(page.locator('details.clubposts')).toHaveCount(1);
      await expect(page.locator('details.clubposts')).not.toHaveAttribute('open', '');
    }
    // 個人 W2 已經過去：打勾記成 cycle_week 2，伺服器補協會週次
    await page.goto('/#/plan/2');
    await firstTick(page).click();
    await expect(page.getByText('已記錄完成')).toBeVisible();
    const mineLogs = (await logsOf(request, 't_other', w2from, mon.toISOString().slice(0, 10))).filter((l) => l.cycle_anchor === date);
    expect(mineLogs).toHaveLength(1);
    expect(mineLogs[0].cycle_week).toBe(2);
    // 首頁：標個人 W3
    await page.goto('/#/');
    await expect(page.locator('.weekstrip')).toContainText('個人週期');
    await expect(page.locator('.weekstrip .hd b')).toHaveText('W3');
    if (await page.locator('.todaycard').count()) await expect(page.locator('.todaycard .tiny').first()).toContainText('個人 W3');
    // ?c=club：只能看，沒有打勾與記錄
    await page.goto('/#/plan?c=club');
    await expect(page.locator('#view')).toContainText('只能看');
    await expect(page.locator('.days .tick')).toHaveCount(0);
    await expect(page.locator('.days a.logbtn:not([href*="id="])')).toHaveCount(0);
    await expect(page.locator('.logsum')).toHaveCount(0);
    // 換回協會賽季：個人週期的紀錄列在「其他週期的紀錄」，報表有個人W2
    await apiAs(request, 't_other', '/me/plan', { method: 'PUT', body: { cycle: 'club' } });
    await page.goto('/#/');
    await page.reload();
    await page.goto(`/#/plan/${mineLogs[0].week_no}`);
    await expect(page.locator('#view')).toContainText('其他週期的紀錄');
    await expect(page.locator('#view')).toContainText('個人 W2');
    await page.goto('/#/report');
    await expect(page.locator('#view svg.chart').filter({ hasText: '個人W2' })).toHaveCount(1);
    await apiAs(request, 't_other', `/logs/${mineLogs[0].id}`, { method: 'DELETE' });
  } finally {
    await apiAs(request, 't_other', '/me/plan', { method: 'PUT', body: { cycle: 'club', grp: club.grp } });
    if (post?.id) await apiAs(request, 't_chair', `/plans/${post.id}`, { method: 'DELETE' });
    await apiAs(request, 't_other', `/races/${id}`, { method: 'DELETE' });
  }
});
