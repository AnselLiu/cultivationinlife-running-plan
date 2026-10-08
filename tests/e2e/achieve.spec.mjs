// 成績與挑戰（團員端）：登錄成績（三格時間、即時配速、沒有連結與截圖擋下、截圖在手機上縮小）、核准後的 PB 卡、
//   恭喜榜（本人打開才上榜、別人恭喜與收回、只分享自己的到 LINE）、目標挑戰（參加、核准後達成、英文條件句）、
//   見證制體重（同意書、見證碼面板、幹部見證後變成已見證）、隱私頁的開關與文字、無障礙與版面寬度
//   這個檔案開頭打開「成績與挑戰」與「PB 排行」功能開關、結束時關掉（workers＝1，不會影響同時跑的其他測試）
//   會留下狀態的步驟（審核中的成績最多 5 筆、同一場同距離只能一筆）一律用這次新建的帳號；挑戰每次新建，重用伺服器重跑也會過
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, apiAs, acceptPrivacyIfAsked, plus, BASE } from './helpers.mjs';

const axeBad = async (page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations
  .filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
const noScrollX = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const toast = (page) => page.locator('#toasts .toast');
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const tag = stamp().slice(-6);
const origin = () => { try { return test.info().project.use.baseURL || BASE; } catch { return BASE; } };
// 用邀請碼新建一個跑友帳號（這次測試專用）；page.request 跟頁面共用登入
async function joinFresh(page, label) {
  await page.addInitScript(() => { try { localStorage.setItem('cil-start', JSON.stringify({ v: 1, dismissed: 1 })); } catch {} });
  const name = `${label}${stamp().slice(-4)}`;
  const res = await page.request.post('/api/join', { headers: { origin: origin(), 'content-type': 'application/json' },
    data: JSON.stringify({ code: 'test-join', name, dist: 'fm', grp: 'D', consent: true }) });
  expect(res.ok(), `加入失敗 ${res.status()} ${await res.text()}`).toBe(true);
  return name;
}
// 以頁面目前登入的帳號呼叫 API（新建的帳號沒有開發登入的 id）
async function pageApi(page, path, { method = 'GET', body } = {}) {
  const res = await page.request.fetch(`/api${path}`, { method, headers: { origin: origin(), 'content-type': 'application/json' }, data: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  expect(res.ok(), `${method} ${path}：HTTP ${res.status()} ${j.error || ''}`).toBe(true);
  return j;
}
// 理事長建立並發布挑戰（不通知）
async function newCampaign(request, body) {
  const base = { intro: '端到端測試用的挑戰', team_id: null, members_only: false, dist_key: null, target: null, opts: {}, confirm: false };
  const r = await apiAs(request, 't_chair', '/admin/ach', { method: 'POST', body: { ...base, ...body } });
  expect(r.id, `建立挑戰失敗：${r.error || ''}`).toBeTruthy();
  const o = await apiAs(request, 't_chair', `/admin/ach/${r.id}/open`, { method: 'POST', body: { announce: false } });
  expect(o.ok, `發布挑戰失敗：${o.error || ''}`).toBe(true);
  return r.id;
}
const approve = async (request, id) => {
  const r = await apiAs(request, 't_chair', `/admin/pb/${id}/review`, { method: 'POST', body: { approve: true } });
  expect(r.ok, `核准失敗：${r.error || ''}`).toBe(true);
  return r;
};

test.beforeAll(async ({ request }) => { await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { achieve: true, achieve_rank: true } }); });
test.afterAll(async ({ request }) => { await apiAs(request, 't_chair', '/settings/features', { method: 'POST', body: { achieve: false, achieve_rank: false } }); });

test('登錄成績：三格時間與即時配速、沒有連結與截圖擋下、截圖縮小重新編碼、核准後 PB 卡與「第一筆」，減少動態時沒有光帶', async ({ page, request }) => {
  await joinFresh(page, '成績測試');
  await page.goto('/#/me'); await acceptPrivacyIfAsked(page);
  await page.locator('a.setrow[href="#/pb"]').click();
  await expect(page.locator('#view h1')).toHaveText('我的成績');
  await expect(page.locator('.pb-cell')).toHaveCount(4);
  await page.getByRole('link', { name: '登錄比賽成績' }).click();
  await expect(page.locator('#view h1')).toHaveText('登錄比賽成績');
  const f = page.locator('#pbForm');
  await f.locator('.pb-seg [data-d="fm"]').click();
  await expect(f.locator('.pb-seg [data-d="fm"]')).toHaveAttribute('aria-pressed', 'true');
  await f.locator('[name="h"]').fill('3'); await f.locator('[name="m"]').fill('28'); await f.locator('[name="s"]').fill('41');
  await expect(page.locator('#pbPace')).toHaveText('配速 4:57/km');   // 12521 秒 ÷ 42.195 公里 ≈ 297 秒
  await f.locator('[name="race_name"]').fill(`E2E 臺北馬拉松 ${tag}`);
  await f.locator('[name="race_date"]').fill(plus(-5));
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);
  await page.locator('#pbSubmit').click();
  await expect(page.locator('.ferr')).toHaveText('請附上官方成績連結或截圖');
  await expect(f.locator('[name="result_url"]')).toBeFocused();
  await f.locator('[name="result_url"]').fill('https://example.com/result/12521');
  await page.locator('#pbSubmit').click();
  await expect(toast(page)).toContainText('已送出，審核通過後會通知你');
  await expect(page.locator('#view h1')).toHaveText('我的成績');
  const pending = page.locator('section.setgroup', { has: page.locator('h2.sgt', { hasText: '審核中' }) });
  await expect(pending).toContainText('3:28:41');
  await expect(pending.locator('.pill.wait', { hasText: '審核中' })).toBeVisible();

  // 截圖：2000×3000 的 PNG → 手機上縮成長邊 1280、WebP（或 JPEG），送出的 data URI 不超過 200,000 字
  await page.goto('/#/pb/new');
  await f.locator('.pb-seg [data-d="10k"]').click();
  await f.locator('[name="m"]').fill('45'); await f.locator('[name="s"]').fill('10');
  await expect(page.locator('#pbPace')).toHaveText('配速 4:31/km');
  await f.locator('[name="race_name"]').fill(`E2E 10K ${tag}`);
  await f.locator('[name="race_date"]').fill(plus(-12));
  const png = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 2000; c.height = 3000;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 2000, 3000);
    gr.addColorStop(0, '#1C4698'); gr.addColorStop(1, '#FDF36D'); g.fillStyle = gr; g.fillRect(0, 0, 2000, 3000);
    g.fillStyle = '#fff'; g.font = 'bold 200px sans-serif'; g.fillText('45:10', 300, 800);
    return c.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.locator('#pbFile').setInputFiles({ name: 'result.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('img.pb-thumb')).toBeVisible();
  await expect(page.locator('#pbProofPrev').getByRole('button', { name: '移除' })).toBeVisible();
  const sent = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/pb' && r.method() === 'POST');
  await page.locator('#pbSubmit').click();
  const body = (await sent).postDataJSON();
  expect(body.proof).toMatch(/^data:image\/(webp|jpeg);base64,/);
  expect(body.proof.length).toBeLessThanOrEqual(200000);
  expect(body.result_url).toBeNull();
  await expect(toast(page)).toContainText('已送出');

  // 核准全馬那一筆：PB 卡顯示時間與「新 PB」、清單「已通過」有「第一筆」；減少動態時光帶不出現
  const mine = await pageApi(page, '/pb');
  const fm = mine.items.find((p) => p.dist_key === 'fm' && p.seconds === 12521);
  expect(fm?.status).toBe('pending');
  const r = await approve(request, fm.id);
  expect(r.pb_kind).toBe('first');
  await page.goto('/#/pb'); await page.reload();
  const cell = page.locator('.pb-cell[data-dist="fm"]');
  await expect(cell).toContainText('3:28:41');
  await expect(cell).toContainText('配速 4:57/km');
  await expect(cell).toHaveClass(/pb-new/);
  await expect(cell.locator('.pill', { hasText: '新 PB' })).toBeVisible();
  expect(await cell.evaluate((el) => getComputedStyle(el, '::after').display)).toBe('none');
  const okGroup = page.locator('section.setgroup', { has: page.locator('h2.sgt', { hasText: '已通過' }) });
  await expect(okGroup.locator('.pill', { hasText: '第一筆' })).toBeVisible();
  // 點 PB 卡片＝清單只看這個距離
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pbList')).not.toContainText('45:10');
  // 光帶只出現一次：看過之後重新整理就沒有
  await page.reload();
  await expect(page.locator('.pb-cell[data-dist="fm"]')).not.toHaveClass(/pb-new/);
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);
});

test('恭喜榜：沒打開時看到說明卡、打開後自己的卡片沒有恭喜鍵；別人恭喜與收回；LINE 分享只有自己的成績', async ({ page, request, browser }) => {
  const name = await joinFresh(page, '恭喜測試');
  const pb = await pageApi(page, '/pb', { method: 'POST', body: { dist_key: 'hm', seconds: 6300, race_name: `E2E 半馬 ${tag}`, race_date: plus(-3), result_url: 'https://example.com/hm/6300' } });
  await approve(request, pb.id);
  await page.goto('/#/cheers'); await acceptPrivacyIfAsked(page);
  await expect(page.locator('#view h1')).toHaveText('恭喜榜');
  const intro = page.locator('.cheer-intro');
  await expect(intro).toContainText('你目前不在恭喜榜上');
  await expect(page.locator('.cheer-card', { hasText: name })).toHaveCount(0);
  await intro.getByRole('button', { name: '出現在恭喜榜' }).click();
  await expect(toast(page)).toContainText('已加入恭喜榜');
  await expect(page.locator('.cheer-intro')).toHaveCount(0);
  const own = page.locator('.cheer-card', { hasText: name });
  await expect(own).toContainText('1:45:00');
  await expect(own).toContainText('完賽 半馬');
  await expect(own.locator('[data-cheer]')).toHaveCount(0);
  await expect(own.getByRole('button', { name: '分享到 LINE' })).toBeVisible();
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);

  // 別的跑友：恭喜（人數 1、aria-pressed）→ 本人看到「1 位跑友恭喜你」→ 再按一次收回
  const other = await browser.newPage();
  await login(other, 't_other'); await acceptPrivacyIfAsked(other);
  await other.goto('/#/cheers');
  const card = other.locator('.cheer-card', { hasText: name });
  const btn = card.locator('[data-cheer]');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn.locator('.num')).toHaveText('1');
  await page.reload();
  await expect(page.locator('.cheer-card', { hasText: name })).toContainText('1 位跑友恭喜你');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn.locator('.num')).toHaveText('');
  await other.close();

  // LINE 分享：只有自己的成績，不帶別人的名字
  await page.locator('.cheer-card', { hasText: name }).getByRole('button', { name: '分享到 LINE' }).click();
  const line = page.locator('#achLine');
  const href = await line.getAttribute('href');
  expect(href.startsWith('https://line.me/R/share?text=')).toBe(true);
  const text = decodeURIComponent(href.split('text=')[1]);
  expect(text).toContain('1:45:00');
  expect(text).toContain('openExternalBrowser=1');
  expect(text).not.toContain('路人');
  await page.keyboard.press('Escape');

  // PB 排行：另外同意才列入
  await page.getByRole('button', { name: 'PB 排行' }).click();
  await expect(page.locator('.cheer-intro')).toContainText('PB 排行要另外同意');
  await page.locator('.cheer-dists [data-dist="hm"]').click();
  await page.getByRole('button', { name: '也列入 PB 排行' }).click();
  await expect(toast(page)).toContainText('已列入 PB 排行');
  await expect(page.locator('.cheer-rank li.me')).toContainText('1:45:00');
});

test('目標挑戰：發布「全馬破 4」→ 跑友看到卡片與條件句、參加 → 核准 3:59:59 後顯示已達成；英文介面的條件句是英文', async ({ page, request }) => {
  const cid = await newCampaign(request, { title: `E2E 全馬破 4 ${tag}`, kind: 'time', dist_key: 'fm', target: 14400, rewards: { badge: 'stopwatch', board: 1 },
    start_date: plus(-10), end_date: plus(30), join_by: plus(30) });
  await joinFresh(page, '挑戰測試');
  await page.goto('/#/plan'); await acceptPrivacyIfAsked(page);
  await page.locator('a.setrow[href="#/ach"]').click();
  await expect(page.locator('#view h1')).toHaveText('目標挑戰');
  const card = page.locator(`a.ach-card[href="#/ach/c/${cid}"]`);
  await expect(card).toContainText(`E2E 全馬破 4 ${tag}`);
  await expect(card.locator('.ach-rule')).toHaveText('期間內全馬跑進 4:00:00');
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);
  await card.click();
  await expect(page.locator('#view h1')).toHaveText(`E2E 全馬破 4 ${tag}`);
  await expect(page.locator('.ach-rules li').first()).toHaveText('期間內全馬跑進 4:00:00');
  await page.getByRole('button', { name: '參加挑戰' }).click();
  await expect(toast(page)).toContainText('已參加');
  await expect(page.locator('.ach-mystate')).toContainText('已參加');
  await expect(page.locator('#achProg')).toContainText('期間內最佳');
  const pb = await pageApi(page, '/pb', { method: 'POST', body: { dist_key: 'fm', seconds: 14399, race_name: `E2E 破 4 ${tag}`, race_date: plus(-1), result_url: 'https://example.com/fm/14399' } });
  const r = await approve(request, pb.id);
  expect(r.achieved.map((a) => a.cid)).toContain(cid);
  await page.reload();
  await expect(page.locator('.ach-mystate')).toContainText('已達成');
  await expect(page.locator('#achProg')).toContainText('3:59:59');
  await expect(page.getByRole('button', { name: '分享到 LINE' })).toBeVisible();
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);
  // 英文介面：條件句由 i18n.js 的句型整句換成英文
  await page.evaluate(() => localStorage.setItem('cil-lang', 'en'));
  try {
    await page.reload();
    await expect(page.locator('.ach-rules li').first()).toHaveText('Run a marathon under 4:00:00 during the challenge');
    await expect(page.locator('#view h1')).toHaveText(`E2E 全馬破 4 ${tag}`);   // 挑戰名稱是幹部寫的內容，不翻譯
  } finally { await page.evaluate(() => localStorage.removeItem('cil-lang')); }
});

test('見證制體重：同意書沒勾不能參加、量體重後的見證碼面板（數字預設遮住）、團長見證後 10 秒內變成已見證', async ({ page, request }) => {
  const cid = await newCampaign(request, { title: `E2E 體重見證 ${tag}`, kind: 'weight', target: 3, opts: { verify: 'witness' }, rewards: { badge: 'heart' },
    start_date: plus(0), end_date: plus(40), join_by: plus(14) });
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  await page.goto(`/#/ach/c/${cid}`);
  await expect(page.locator('.ach-health')).toContainText('健康的減重大約每週不超過體重的 1%');
  await expect(page.locator('.ach-rewards')).toContainText('這個挑戰不上恭喜榜');
  await page.getByRole('button', { name: '參加挑戰' }).click();
  const sheet = page.locator('.sheet');
  await expect(sheet.locator('#achJoinT')).toHaveText('參加前請確認');
  await expect(sheet).toContainText('見證的幹部當下會看到體重計');
  const go = sheet.getByRole('button', { name: '同意並參加' });
  await expect(go).toBeDisabled();
  await sheet.locator('#achAgree').check();
  await expect(go).toBeEnabled();
  expect(await axeBad(page)).toEqual([]);
  await go.click();
  await expect(toast(page)).toContainText('已參加');
  await expect(page.locator('.ach-step').first()).toContainText('還沒量');
  await page.locator('[data-weigh="base"]').click();
  await page.locator('.sheet [name="kg"]').fill('72.4');
  await page.locator('.sheet').getByRole('button', { name: '請幹部見證' }).click();
  const panel = page.locator('.sheet', { has: page.locator('#achQrT') });
  await expect(panel.locator('#achKgV')).toHaveText('●●.●');   // 旁邊的人看不到
  await expect(panel.locator('#achQR svg')).toBeVisible();
  const code = await panel.locator('.ach-code').getAttribute('data-code');
  expect(code).toMatch(/^b[0-9a-z]{15}$/);
  await panel.getByRole('button', { name: '顯示數字' }).click();
  await expect(panel.locator('#achKgV')).toHaveText('72.4');
  expect(await axeBad(page)).toEqual([]);
  // 團長（同分團）見證：伺服器不回傳任何數字，也不回傳有沒有達成
  const w = await apiAs(request, 't_lead', '/ach/witness', { method: 'POST', body: { code: `cil-wit:${code}`, kg: 72.4 } });
  expect(w.ok, `見證失敗：${w.error || ''}`).toBe(true);
  expect(JSON.stringify(w)).not.toContain('72');
  await expect(panel.locator('#achWState')).toContainText('已見證', { timeout: 10000 });
  await panel.getByRole('button', { name: '關閉' }).click();
  await expect(page.locator('.ach-step').first()).toContainText('已見證');
  // 隨時可以刪除自己的體重資料
  await page.getByRole('button', { name: '刪除我的體重資料' }).click();
  await page.locator('.sheet').getByRole('button', { name: '刪除' }).click();
  await expect(toast(page)).toContainText('體重資料已刪除');
  await expect(page.locator('.ach-step').first()).toContainText('還沒量');
  await apiAs(request, 't_runner', `/ach/${cid}/leave`, { method: 'POST' });
});

test('隱私頁：「出現在恭喜榜」開關與縮排的「也列入 PB 排行」、我們存了什麼含成績句、改過的排行榜說明', async ({ page }) => {
  await joinFresh(page, '隱私測試');
  await page.goto('/#/me/privacy'); await acceptPrivacyIfAsked(page);
  await expect(page.locator('label.switch', { hasText: '出現在分團里程排行榜' })).toContainText('登入的跑友在每月里程挑戰與分團排行榜看得到你的名字與里程');
  const board = page.locator('label.switch', { hasText: '出現在恭喜榜' });
  await expect(board).toContainText('體重挑戰一律不上榜');
  await expect(page.locator('#cheerRank')).toBeDisabled();
  await expect(page.locator('#cheerRankHint')).toHaveText('先打開恭喜榜');
  await board.click();
  await expect(toast(page)).toContainText('已加入恭喜榜');
  await expect(page.locator('#cheerBoard')).toBeChecked();
  await expect(page.locator('#cheerRank')).toBeEnabled();
  await page.locator('label.switch', { hasText: '也列入 PB 排行' }).click();
  await expect(toast(page)).toContainText('已列入 PB 排行');
  await page.reload();
  await expect(page.locator('#cheerBoard')).toBeChecked();
  await expect(page.locator('#cheerRank')).toBeChecked();
  await expect(page.locator('section.card', { hasText: '我們存了什麼' })).toContainText('比賽成績與挑戰紀錄');
  await expect(page.locator('section.card', { hasText: '刪除帳號' })).toContainText('比賽成績、挑戰紀錄與體重都會刪除');
  // 隱私權政策：新的條文在「蒐集的資料」裡
  await page.goto('/#/privacy');
  await expect(page.locator('.prose')).toContainText('比賽成績（選填）');
  await expect(page.locator('.prose')).toContainText('體重（選填，敏感資料）');
  expect(await axeBad(page)).toEqual([]);
});

test('無障礙與版面：我的成績、登錄成績、目標挑戰、挑戰詳細（團服卡）、恭喜榜沒有嚴重問題，也不超出 390px', async ({ page, request }) => {
  const cid = await newCampaign(request, { title: `E2E 累積里程 ${tag}`, kind: 'km', target: 50, confirm: true,
    rewards: { badge: 'flame', shirt: { sizes: ['S', 'M', 'L'], quota: 10, size_by: null, chart: null, pool: null } }, start_date: plus(-5), end_date: plus(20), join_by: plus(20) });
  await apiAs(request, 't_runner', `/ach/${cid}/join`, { method: 'POST', body: { shirt_size: 'M' } });
  await login(page, 't_runner'); await acceptPrivacyIfAsked(page);
  for (const h of ['#/pb', '#/pb/new', '#/ach', `#/ach/c/${cid}`, '#/cheers']) {
    await page.goto(`/${h}`);
    await expect(page.locator('#view h1')).toBeVisible();
    await page.waitForTimeout(600);
    expect(await axeBad(page), h).toEqual([]);
    expect(await noScrollX(page), h).toBe(true);
  }
  // 挑戰詳細：里程進度環有說明、團服卡的尺寸是 44px 的按鈕
  await page.goto(`/#/ach/c/${cid}`);
  await expect(page.locator('#achProg [role="img"]')).toHaveAttribute('aria-label', /已跑 [\d.]+ 公里，目標 50 公里/);
  const m = page.locator('#achShirt [data-shirt="M"]');
  await expect(m).toHaveAttribute('aria-pressed', 'true');
  expect((await m.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await apiAs(request, 't_runner', `/ach/${cid}/leave`, { method: 'POST' });
});
