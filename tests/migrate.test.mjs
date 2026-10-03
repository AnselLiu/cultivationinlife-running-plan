// 舊版課表教練資料搬移（coachcalc.js 的 planLegacyImport 等純函式）單元測試
import './tz.mjs';   // 一定要第一個載入（見 tz.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from '../public/plan.js';
import * as K from '../public/coachcalc.js';

const WEEKS = JSON.parse(fs.readFileSync(new URL('../public/data/season-2026.json', import.meta.url), 'utf8'));
const at = (iso, hh = 20) => new Date(`${iso}T${String(hh).padStart(2, '0')}:00:00+08:00`).getTime();
const TODAY = '2026-11-04';
// 舊版的預設值（coach.html DEFAULTS）＋改過的幾欄
const MODEL = { lang: 'zh', name: '王小明', race: '臺北馬拉松', raceDate: '2026-12-20', start: '06:30', dist: 'fm', grp: 'C', vol: '30', days: 5, club: true, view: 'week',
  age: 45, sex: 'M', kg: 62, rest: null, sweat: '中', pbDist: '10', pbTime: '0:48:30', theme: 'auto' };
const logs = (dash, opt = {}) => K.legacyLogs({ model: MODEL, dash, weeks: WEEKS, today: TODAY, ...opt });

test('設定：跟舊版預設一樣的欄位標成可能是預設值；改過的不標；看不懂的值不搬', () => {
  const f = K.legacyPrefs(MODEL, { startKey: '2026-12-20|臺北馬拉松' });
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  for (const k of ['age', 'sex', 'kg', 'vol', 'club', 'start', 'pb', 'sweat']) assert.equal(by[k].def, true, k);
  assert.equal(by.days.def, false);
  assert.deepEqual(by.days.patch, { plan: { days: 5 } });
  assert.deepEqual(by.start.patch, { start: { '2026-12-20|臺北馬拉松': '06:30' } });
  assert.equal(by.rest, undefined);            // 沒填安靜心率就沒有這一列
  assert.equal(by.explain, undefined);
  // 沒有目標賽事就不搬起跑時間
  assert.equal(K.legacyPrefs(MODEL).some((x) => x.key === 'start'), false);
  // 看不懂的值：天數 9、體重 500、性別 X、跑量 99、成績亂寫
  const bad = K.legacyPrefs({ days: 9, kg: 500, sex: 'X', vol: '99', pbDist: '10', pbTime: 'abc', sweat: '超多', age: 'x' });
  assert.deepEqual(bad, []);
  // 勾選的合成一個 patch（body 的欄位合併在一起）
  assert.deepEqual(K.legacyPatch(f, ['days', 'age', 'kg']), { plan: { days: 5 }, body: { age: 45, kg: 62 } });
  assert.deepEqual(K.legacyPatch(f, []), {});
});

test('組別：照舊版的項目與組別找課表列（不是帳號現在的組別）', () => {
  assert.deepEqual(K.legacyGroup(MODEL), { dist: 'fm', grp: 'C', name: '全馬 C 組' });
  assert.deepEqual(K.legacyGroup({}), { dist: 'fm', grp: 'D', name: '全馬 D 組' });
  assert.deepEqual(K.legacyGroup({ dist: 'hm', grp: 'z' }), { dist: 'hm', grp: 'C', name: '半馬 C 組' });
  // W5 第 3 列（週四）：C 組與 D 組的配速不同
  const r = logs({ log: { '2026-12-20|5|3': at('2026-09-03') } });
  assert.equal(r.upload.length, 1);
  assert.equal(r.upload[0].plan_text, WEEKS[4].plan.fm.C[3][1]);
  assert.notEqual(r.upload[0].plan_text, WEEKS[4].plan.fm.D[3][1]);
  const all = K.planLegacyImport({ model: MODEL, dash: {}, weeks: WEEKS, today: TODAY, me: { dist: 'fm', grp: 'D' } });
  assert.deepEqual(all.groupDiff.from, { dist: 'fm', grp: 'C', name: '全馬 C 組' });
  assert.equal(all.groupDiff.to.grp, 'D');
  assert.equal(K.planLegacyImport({ model: MODEL, dash: {}, weeks: WEEKS, today: TODAY, me: { dist: 'fm', grp: 'C' } }).groupDiff, null);
  assert.equal(all.who.name, '王小明');
});

test('打卡紀錄：協會賽季的對到 W 週次；W1、休息日、壞掉的鍵、超出範圍的列對不到', () => {
  const r = logs({ log: {
    '2026-12-20|3|1': at('2026-08-18'),      // W3 週二
    '2026-12-20|1|1': at('2026-08-04'),      // W1：舊版內容不同，不搬
    '2026-12-20|20|0': at('2026-11-01'),     // W20 週一休息日（而且還沒到）
    '2026-12-20|3|9': at('2026-08-18'),      // 沒有第 9 列
    'garbage': 1, '2026-12-20|22|0': 1 } });
  assert.equal(r.upload.length, 1);
  assert.equal(r.unmatched, 5);
  assert.equal(r.total, 6);
  const b = r.upload[0];
  assert.equal(b.date, '2026-08-18');
  assert.equal(b.week_no, 3);
  assert.equal(b.plan_day, '週二');
  assert.equal(b.status, 'done');
  assert.equal(b.source, 'manual');
  assert.equal(b.note, '從舊版課表教練匯入');
  assert.equal(b.if_absent, true);
  assert.equal(b.kind, P.kind(b.plan_day, b.plan_text));
  assert.equal('cycle_anchor' in b, false);
});

test('其他比賽日的鍵：沒勾就不上傳（算其他週期）；勾了才對到個人週期 cycle_anchor', () => {
  const dash = { log: { '2026-12-20|3|1': at('2026-08-18'), '2026-11-01|3|1': at('2026-06-30') } };
  const off = logs(dash);
  assert.equal(off.upload.length, 1);
  assert.equal(off.otherLeft, 1);
  assert.deepEqual(off.other, [{ anchor: '2026-11-01', count: 1, left: 1 }]);
  const on = logs(dash, { include: ['2026-11-01'] });
  assert.equal(on.upload.length, 2);
  assert.equal(on.otherLeft, 0);
  assert.deepEqual(on.other, [{ anchor: '2026-11-01', count: 1, left: 0 }]);
  const p = on.upload.find((x) => x.cycle_anchor);
  const c = P.cycleOf('2026-11-01');
  assert.equal(c.w1ISO, '2026-06-15');
  assert.deepEqual({ anchor: p.cycle_anchor, week: p.cycle_week, date: p.date, wn: 'week_no' in p }, { anchor: '2026-11-01', week: 3, date: '2026-06-30', wn: false });
  assert.equal(P.weekIndexOf(p.date, c), 3);   // 伺服器的合理性檢查（週次跟日期差不到一週）
});

test('個人週期的比賽那一列記成「比賽日」，不帶比賽名稱', () => {
  // 2026-10-25（日）比賽：W20 週末是比賽那一列
  const r = logs({ log: { '2026-10-25|20|5': at('2026-10-25', 12) } }, { include: ['2026-10-25'] });
  assert.equal(r.upload.length, 1);
  assert.equal(r.upload[0].plan_text, '比賽日');
  assert.equal(r.upload[0].date, '2026-10-25');
  assert.equal(r.upload[0].kind, 'race');
});

test('日期：打勾那天是這一列的日期就用它；不是就取打勾以前最近的；都在未來就不搬', () => {
  // 週五或週六（W3：8/21、8/22）
  const sat = logs({ log: { '2026-12-20|3|4': at('2026-08-22') } }).upload[0];
  assert.equal(sat.date, '2026-08-22');
  // 晚了幾天才打勾（8/25）→ 取 8/22
  assert.equal(logs({ log: { '2026-12-20|3|4': at('2026-08-25') } }).upload[0].date, '2026-08-22');
  // 打勾時間比這一列早（提早打勾，8/19）→ 取今天以前的第一天 8/21
  assert.equal(logs({ log: { '2026-12-20|3|4': at('2026-08-19') } }).upload[0].date, '2026-08-21');
  // 打勾時間壞掉 → 今天以前的第一天
  assert.equal(logs({ log: { '2026-12-20|3|4': 'x' } }).upload[0].date, '2026-08-21');
  // 還沒到的週（W12 起 10/19 已過；W15 起 11/9 還沒到）→ 不搬，也不會有未來日期
  const fut = logs({ log: { '2026-12-20|15|1': at('2026-11-03') } });
  assert.equal(fut.upload.length, 0);
  assert.equal(fut.unmatched, 1);
  // 本週：週一到今天（11/4 週三）可以，週四以後不行
  const wk = logs({ log: { '2026-12-20|14|0': at('2026-11-02'), '2026-12-20|14|3': at('2026-11-04') } });
  assert.deepEqual(wk.upload.map((x) => x.date), ['2026-11-02']);
  for (const b of wk.upload) assert.ok(b.date <= TODAY);
});

test('重複：伺服器上同一個週期、同一週、同一天已經有紀錄就略過；另一個週期的不算重複', () => {
  const dash = { log: { '2026-12-20|3|1': at('2026-08-18'), '2026-12-20|3|3': at('2026-08-20') } };
  const existing = [{ date: '2026-08-18', week_no: 3, plan_day: '週二', status: 'partial' },
    { date: '2026-08-20', week_no: 12, cycle_anchor: '2027-03-21', cycle_week: 3, plan_day: '週四', status: 'done' }];
  const r = logs(dash, { existing });
  assert.equal(r.existed, 1);
  assert.deepEqual(r.upload.map((x) => x.plan_day), ['週四']);
  // 再跑一次（剛上傳的都在伺服器上了）→ 0 筆
  const again = logs(dash, { existing: [...existing, ...r.upload.map(({ key, ...b }) => b)] });
  assert.equal(again.upload.length, 0);
  assert.equal(again.existed, 2);
});

test('每天最多 5 筆：伺服器上已有的加上要搬的不超過 5', () => {
  const existing = Array.from({ length: 4 }, (_, i) => ({ date: '2026-08-18', status: 'extra', plan_day: null, km: 1 + i }));
  // W3 週二 8/18 → 第 5 筆可以；W3 週二已記，同一天再來一筆 W? 對不到同一天，改用兩個週期的週二
  const dash = { log: { '2026-12-20|3|1': at('2026-08-18') } };
  assert.equal(logs(dash, { existing }).upload.length, 1);
  const full = [...existing, { date: '2026-08-18', status: 'extra', plan_day: null }];
  const r = logs(dash, { existing: full });
  assert.equal(r.upload.length, 0);
  assert.equal(r.capped, 1);
  // 同一批裡也算：個人週期與協會賽季剛好落在同一天
  const c = P.cycleOf('2026-12-27');              // W1 從 8/10，W2 週二＝8/18
  assert.equal(P.dayDates(2, '週二', c)[0], '2026-08-18');
  const two = logs({ log: { '2026-12-20|3|1': at('2026-08-18'), '2026-12-27|2|1': at('2026-08-18') } }, { existing, include: ['2026-12-27'] });
  assert.equal(two.upload.length, 1);
  assert.equal(two.capped, 1);
});

test('倒數：只列今天以後的，照日期排；同名同日只列一次；我的賽事已有的標出來', () => {
  const dash = { cds: [{ id: 'a', name: '體檢', date: '2026-11-20' }, { id: 'b', name: '萬金石', date: '2027-03-15' }, { id: 'c', name: '舊的', date: '2026-10-01' },
    { id: 'd', name: '體檢', date: '2026-11-20' }, { id: 'e', name: '', date: '2026-12-01' }, { id: 'f', name: '壞日期', date: '2026-13-01' }, null] };
  const r = K.legacyCountdowns(dash, { today: TODAY, races: [{ name: '萬金石', date: '2027-03-15' }] });
  assert.deepEqual(r, [{ name: '體檢', date: '2026-11-20', exists: false }, { name: '萬金石', date: '2027-03-15', exists: true }]);
  assert.deepEqual(K.legacyCountdowns({}, { today: TODAY }), []);
});

test('舊版的目標賽事：今天以後、不是協會賽季那天、我的賽事沒有同一天的才建議', () => {
  assert.equal(K.legacyRace(MODEL, { today: TODAY }), null);                                    // 12/20 是協會賽季
  const m = { ...MODEL, race: '渣打臺北公益馬拉松', raceDate: '2027-03-21' };
  assert.deepEqual(K.legacyRace(m, { today: TODAY }), { name: '渣打臺北公益馬拉松', date: '2027-03-21', dist: '全馬', unnamed: false });
  assert.equal(K.legacyRace(m, { today: TODAY, races: [{ date: '2027-03-21' }] }), null);
  assert.equal(K.legacyRace({ ...m, raceDate: '2026-10-01' }, { today: TODAY }), null);
  assert.equal(K.legacyRace({ ...m, race: '' }, { today: TODAY }).unnamed, true);
});

test('查詢範圍：從最早的 W1 到今天，最多往回一年', () => {
  assert.deepEqual(K.legacyRange({ log: { '2026-12-20|3|1': 1 } }, TODAY), { from: '2026-08-03', to: TODAY });
  assert.deepEqual(K.legacyRange({ log: { '2026-11-01|3|1': 1 } }, TODAY), { from: '2026-06-15', to: TODAY });
  assert.deepEqual(K.legacyRange({ log: { '2024-01-01|3|1': 1 } }, TODAY), { from: '2025-11-04', to: TODAY });
});

test('備份：舊版的格式（舊版頁面可以還原）', () => {
  const j = JSON.parse(K.legacyBackup(MODEL, { log: { a: 1 } }, new Date('2026-11-04T00:00:00Z')));
  assert.deepEqual(Object.keys(j), ['app', 'v', 'exported', 'settings', 'dash']);
  assert.equal(j.app, 'gengpao-coach');
  assert.equal(j.settings.grp, 'C');
});

test('只有完成紀錄的備份：不含設定與身體資料、倒數', () => {
  const j = JSON.parse(K.legacyLogBackup({ log: { '2026-12-20|3|1': 1 }, cds: [{ name: 'x' }] }, new Date('2026-11-04T00:00:00Z')));
  assert.deepEqual(Object.keys(j), ['app', 'v', 'exported', 'dash']);
  assert.deepEqual(j.dash, { log: { '2026-12-20|3|1': 1 } });
  assert.ok(!('settings' in j));
});
