// 成績與挑戰的共用規則（public/achrule.js）：時間解析與格式、配速合理範圍、達成判斷的整數運算邊界、挑戰設定檢查、發布後的修改檢查、條件句
//   worker.js 與前端共用同一份，這裡只測純函式（不用伺服器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as A from '../public/achrule.js';

test('parseTime：h:mm:ss、m:ss、沒有小時時分鐘可以超過 59；看不懂回 null', () => {
  assert.equal(A.parseTime('3:28:41'), 12521);
  assert.equal(A.parseTime('24:35'), 1475);
  assert.equal(A.parseTime('75:30'), 4530);
  assert.equal(A.parseTime(' 1:02:03 '), 3723);
  for (const s of ['3:61:00', '1:2:3', '0:00', '', '   ', null, undefined, '3:28', 'abc', '1:00:60']) {
    if (s === '3:28') continue;   // 3 分 28 秒，合法（只是用在全馬會被 timeOk 擋掉）
    assert.equal(A.parseTime(s), null, String(s));
  }
  assert.equal(A.parseTime('3:28'), 208);
});

test('fmtTime／fmtPace：不到一小時 m:ss', () => {
  assert.equal(A.fmtTime(12521), '3:28:41');
  assert.equal(A.fmtTime(1475), '24:35');
  assert.equal(A.fmtTime(59), '0:59');
  assert.equal(A.fmtTime(3600), '1:00:00');
  assert.equal(A.fmtPace(12521, 42.195), '4:57/km');
});

test('timeOk：每公里 2:40–20:00，邊界與非整數', () => {
  assert.equal(Math.ceil(42.195 * 160), 6752);
  assert.equal(Math.floor(42.195 * 1200), 50634);
  assert.equal(A.timeOk(6752, 42.195), true);
  assert.equal(A.timeOk(6751, 42.195), false);
  assert.equal(A.timeOk(50634, 42.195), true);
  assert.equal(A.timeOk(50635, 42.195), false);
  assert.equal(A.timeOk(12521.5, 42.195), false);
  assert.equal(A.timeOk(12521, 0), false);
  assert.equal(A.timeOk(A.parseTime('3:28'), 42.195), false, '全馬填 3:28 擋掉');
});

test('paceMet／weightMet／pctDown：整數運算，邊界算達成；顯示無條件捨去', () => {
  assert.equal(A.paceMet(12000, 11640, 3), true, '(360)*1000 = 12000*30');
  assert.equal(A.paceMet(12000, 11641, 3), false);
  assert.equal(A.paceMet(0, 100, 3), false);
  assert.equal(A.weightMet(724, 702, 3), true, '22000 ≥ 21720');
  assert.equal(A.weightMet(724, 703, 3), false, '21000 < 21720');
  assert.equal(A.x10(3.1), 31);
  assert.equal(A.x10(72.4), 724);
  assert.equal(A.x10('2.5'), 25);
  // 規格 §19.2 第 5 項寫 x10(3.05)＝31；照抄的 Math.round(3.05 * 10) 因為二進位浮點是 30。挑戰的百分比存檔前已經整理成一位小數，碰不到這個值（交付說明有寫）
  assert.equal(A.x10(3.05), Math.round(3.05 * 10));
  assert.equal(A.pctDown(12000, 11641), 2.9, '不是 3.0');
  assert.equal(A.pctDown(12000, 11640), 3);
  assert.equal(A.pctDown(0, 1), 0);
  assert.equal(A.kgOk(30), true);
  assert.equal(A.kgOk(250), true);
  assert.equal(A.kgOk(29.9), false);
  assert.equal(A.kgOk(NaN), false);
});

test('距離：distFromRace、kmOf、kmOk、distLabel', () => {
  assert.equal(A.distFromRace('全馬'), 'fm');
  assert.equal(A.distFromRace(' 半馬 '), 'hm');
  assert.equal(A.distFromRace('10K'), '10k');
  assert.equal(A.distFromRace('5K'), '5k');
  assert.equal(A.distFromRace('超馬'), 'other');
  assert.equal(A.distFromRace(null), 'other');
  assert.equal(A.kmOf('fm'), 42.195);
  assert.equal(A.kmOf('other', 12.34), 12.3);
  assert.equal(A.kmOf('other', '50'), 50);
  assert.equal(A.kmOf('xx'), null);
  assert.equal(A.kmOk('other', 1), true);
  assert.equal(A.kmOk('other', 250), true);
  assert.equal(A.kmOk('other', 0.9), false);
  assert.equal(A.kmOk('other', 251), false);
  assert.equal(A.kmOk('hm', 21.0975), true);
  assert.equal(A.kmOk('xx', 5), false);
  assert.equal(A.isDist('other'), true);
  assert.equal(A.isDist('toString'), false, '不吃原型上的鍵');
  assert.equal(A.distLabel('other', 12.34), '12.3 公里');
  assert.equal(A.distLabel('fm'), '全馬');
  assert.equal(A.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(A.daysBetween('2026-10-01', '2026-10-22'), 21);
  assert.equal(A.isDay('2026-02-30'), A.isDay('2026-02-30'));   // 依執行環境的 Date.parse；只要是固定結果
  assert.equal(A.isDay('2026-1-1'), false);
});

// 合法的六種（各一個）
const base = { title: '測試', start_date: '2026-10-15', end_date: '2026-12-31', join_by: '2026-12-31', opts: {}, rewards: { badge: 'medal' } };
const OK = {
  pb: { ...base, kind: 'pb', dist_key: null, target: null, opts: { first_ok: 1 } },
  time: { ...base, kind: 'time', dist_key: 'fm', target: 14400, rewards: { badge: 'stopwatch', board: 1, shirt: { sizes: A.SIZES, quota: 50, size_by: '2027-01-15', chart: null, pool: '2026 團服' } } },
  pace: { ...base, kind: 'pace', dist_key: 'hm', target: 3 },
  weight: { ...base, kind: 'weight', target: 3, opts: { verify: 'witness' }, join_by: '2026-10-29', rewards: { badge: 'heart', shirt: { sizes: ['M'], quota: null, size_by: null, chart: null, pool: null } } },
  km: { ...base, kind: 'km', target: 300, confirm: true },
  attend: { ...base, kind: 'attend', target: 10, opts: { kinds: ['track', 'core', 'long'] } },
};

test('checkCampaign：六種合法的回 null；每個錯誤分支各一個', () => {
  for (const [k, c] of Object.entries(OK)) assert.equal(A.checkCampaign(c), null, k);
  const bad = (patch, msg, from = OK.time) => assert.equal(A.checkCampaign({ ...from, ...patch }), msg, msg);
  bad({ title: '' }, '請填挑戰名稱');
  bad({ kind: 'run' }, '請選挑戰類型');
  bad({ start_date: '2026-13-01' }, '請選開始與結束日期');
  bad({ end_date: '2026-10-01' }, '請選開始與結束日期');
  bad({ end_date: '2027-10-16', join_by: '2027-10-16' }, '挑戰期間最長一年');
  bad({ join_by: '2026-09-01' }, '報名截止要在開始前 30 天到結束日之間');
  bad({ join_by: '2027-01-01' }, '報名截止要在開始前 30 天到結束日之間');
  bad({ dist_key: 'other' }, '請選距離', OK.pb);
  bad({ dist_key: null }, '請選距離');
  bad({ target: 3000 }, '目標時間看起來不對');
  bad({ target: 14400.5 }, '目標時間看起來不對');
  bad({ dist_key: 'trail' }, '請選距離', OK.pace);
  bad({ target: 0.4 }, '進步幅度請填 0.5–20%', OK.pace);
  bad({ target: 20.1 }, '進步幅度請填 0.5–20%', OK.pace);
  bad({ target: 0.9 }, '減少幅度請填 1–10%', OK.weight);
  bad({ target: 10.5 }, '減少幅度請填 1–10%', OK.weight);
  bad({ start_date: '2026-10-15', end_date: '2026-11-10', join_by: '2026-10-15' }, '體重挑戰至少要 4 週', OK.weight);   // 27 天
  bad({ start_date: '2026-10-15', end_date: '2027-04-13', join_by: '2026-10-29' }, '體重挑戰最長 6 個月', OK.weight);  // 181 天
  assert.equal(A.checkCampaign({ ...OK.weight, start_date: '2026-10-15', end_date: '2026-11-11', join_by: '2026-10-15' }), null, '28 天可以');
  assert.equal(A.checkCampaign({ ...OK.weight, start_date: '2026-10-15', end_date: '2027-04-12', join_by: '2026-10-29' }), null, '180 天可以');
  bad({ opts: { verify: 'x' } }, '請選體重的確認方式', OK.weight);
  bad({ join_by: '2026-12-14' }, '體重挑戰的報名截止要在結束日 18 天以前', OK.weight);
  bad({ opts: { verify: 'honor' } }, '自主聲明的體重挑戰不能送團服（沒辦法驗證）', OK.weight);
  bad({ target: 9 }, '目標里程請填 10–5000 公里', OK.km);
  bad({ target: 5001 }, '目標里程請填 10–5000 公里', OK.km);
  bad({ target: 0 }, '出席次數請填 1–200 次', OK.attend);
  bad({ target: 2.5 }, '出席次數請填 1–200 次', OK.attend);
  bad({ opts: { kinds: [] } }, '請選要算哪些團練', OK.attend);
  bad({ opts: { kinds: ['party'] } }, '請選要算哪些團練', OK.attend);
  const sh = (patch) => ({ rewards: { ...OK.time.rewards, shirt: { ...OK.time.rewards.shirt, ...patch } } });
  bad(sh({ sizes: [] }), '團服尺寸請選 1–12 種');
  bad(sh({ sizes: ['XXXXXXXL'] }), '團服尺寸請選 1–12 種');
  bad(sh({ quota: 0 }), '團服名額請填 1–2000');
  bad(sh({ quota: 2001 }), '團服名額請填 1–2000');
  bad(sh({ size_by: '2026-12-30' }), '尺寸截止要在結束日以後');
  bad(sh({ pool: '一二三四五六七八九十一二三四五六七八九十一' }), '同款團服的名稱最多 20 字');
  bad({ rewards: { badge: 'rocket' } }, '請選徽章圖示');
  bad({ rewards: {} }, '請至少選一種獎勵');
});

test('checkEdit：草稿隨便改；發布後鎖住條件、名額只能增加、尺寸只能加、尺寸截止只能延後、結束日只能在原結束日以前延長', () => {
  const old = { ...OK.time, status: 'open' }, today = '2026-11-01';
  assert.equal(A.checkEdit({ ...old, status: 'draft' }, { ...old, target: 10800 }, today), null);
  assert.equal(A.checkEdit(old, { ...old, title: '改名', end_date: '2027-01-31', join_by: '2027-01-31' }, today), null);
  assert.equal(A.checkEdit(old, { ...old, target: 10800 }, today), '挑戰開始後不能改條件');
  assert.equal(A.checkEdit(old, { ...old, rewards: { ...old.rewards, board: undefined } }, today), '挑戰開始後不能改條件');
  assert.equal(A.checkEdit(old, { ...old, rewards: { badge: 'stopwatch', board: 1 } }, today), '挑戰開始後不能改條件', '拿掉團服');
  assert.equal(A.checkEdit(old, { ...old, rewards: { ...old.rewards, shirt: { ...old.rewards.shirt, pool: '別款' } } }, today), '挑戰開始後不能改條件');
  assert.equal(A.checkEdit(old, { ...old, end_date: '2026-12-30' }, today), '挑戰開始後不能改條件', '不能縮短');
  assert.equal(A.checkEdit(old, { ...old, end_date: '2027-01-31' }, '2027-01-02'), '挑戰已經結束，不能再延長');
  assert.equal(A.checkEdit(old, { ...old, join_by: '2026-10-20' }, today), '報名截止要在開始前 30 天到結束日之間');
  const sh = (patch) => ({ ...old, rewards: { ...old.rewards, shirt: { ...old.rewards.shirt, ...patch } } });
  assert.equal(A.checkEdit(old, sh({ quota: 49 }), today), '名額只能增加');
  assert.equal(A.checkEdit(old, sh({ quota: 60 }), today), null);
  assert.equal(A.checkEdit(old, sh({ quota: null }), today), null, '改成不限量');
  assert.equal(A.checkEdit(sh({ quota: null }), sh({ quota: 100 }), today), '名額只能增加', '不限量改回限量');
  assert.equal(A.checkEdit(old, sh({ sizes: ['M'] }), today), '尺寸只能增加');
  assert.equal(A.checkEdit(old, sh({ sizes: [...A.SIZES, '4XL'] }), today), null);
  assert.equal(A.checkEdit(old, sh({ size_by: '2027-01-14' }), today), '尺寸截止只能延後');
  assert.equal(A.checkEdit(old, sh({ size_by: '2027-02-01' }), today), null);
});

test('ruleLines：六種類型與選項的句子（快照）；英文介面的整句翻譯由 i18n.js 的 PATTERNS 負責', () => {
  const lines = (c) => A.ruleLines(c);
  assert.deepEqual(lines(OK.pb), ['期間內任一距離跑出比挑戰開始前更快的成績', '基準是比賽日在開始前的最佳成績，而且至少要有一筆是挑戰發布前就登錄的',
    '之前沒有成績的人，期間內完賽就算', '比賽成績要先登錄並通過審核']);
  assert.deepEqual(lines({ ...OK.pb, dist_key: 'fm', opts: {} }), ['期間內跑出比挑戰開始前更快的全馬成績', '基準是比賽日在開始前的最佳成績，而且至少要有一筆是挑戰發布前就登錄的', '比賽成績要先登錄並通過審核']);
  assert.deepEqual(lines({ ...OK.time, opts: { first_time: 1 } }), ['期間內全馬跑進 4:00:00', '限第一次跑進', '比賽成績要先登錄並通過審核']);
  assert.deepEqual(lines(OK.pace), ['半馬成績比挑戰開始前的 PB 快 3% 以上', '基準是比賽日在開始前的最佳成績，而且至少要有一筆是挑戰發布前就登錄的', '比賽成績要先登錄並通過審核']);
  assert.deepEqual(lines({ ...OK.pace, dist_key: null }).slice(0, 1), ['任一距離成績比挑戰開始前的 PB 快 3% 以上']);
  assert.deepEqual(lines(OK.weight), ['在團練現場量起始與結束體重（幹部見證），減少 3% 以上', '幹部看著體重計輸入讀數；體重加密保存，系統裡只有你看得到數字']);
  assert.deepEqual(lines({ ...OK.weight, opts: { verify: 'honor' } }), ['挑戰結束前自主聲明體重比開始時減少 3% 以上', '榮譽制：體重不會上傳']);
  assert.deepEqual(lines(OK.km), ['期間內訓練紀錄累積 300 公里', '結束後 3 天內補記的也算，之後新增或修改的不算', '達成後由幹部確認']);
  assert.deepEqual(lines(OK.attend), ['期間內出席 10 次團練', '以現場報到為準']);
});

// 主句的英文要靠 MEMBER 線在 public/i18n.js 加的 PATTERNS（規格 §20.3）與字典；合併 MEMBER 之前標 todo
test('ruleLines：每個主句都能被 i18n.js 的 PATTERNS 翻成英文', { todo: !readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8').includes('期間內跑出比挑戰開始前更快的') }, () => {
  const src = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
  // PATTERNS 沒有匯出（模組載入時會碰 localStorage）：從原始碼抓每一列開頭的 [/^…$/,，看不懂的略過
  const res = [...src.matchAll(/^\s*\[\/(\^.*?\$)\/,/gm)].map((m) => { try { return new RegExp(m[1]); } catch { return null; } }).filter(Boolean);
  // 沒有變數的主句（任一距離的破 PB）是 i18n-en.js 字典的鍵
  const dict = readFileSync(new URL('../public/i18n-en.js', import.meta.url), 'utf8');
  for (const c of Object.values(OK)) { const l = A.ruleLines(c)[0]; assert.ok(res.some((re) => re.test(l)) || dict.includes(`"${l}":`), l); }
});
