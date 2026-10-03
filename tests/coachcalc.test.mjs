// coachcalc.js 單元測試：跟 coach.html 原本的計算結果（tests/fixtures/coach-golden.json）逐項比對
// 對照答案由 tools/coach-golden.mjs 直接執行 coach.html 的程式產生
process.env.TZ = 'Asia/Taipei';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as P from '../public/plan.js';
import * as K from '../public/coachcalc.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const WEEKS = JSON.parse(read('tests/fixtures/coach-weeks.json'));
const GOLD = JSON.parse(read('tests/fixtures/coach-golden.json'));
const h = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const json = (x) => JSON.parse(JSON.stringify(x));
// 跟 tools/coach-golden.mjs 同一組設定
const BASE = { name: '測試跑者', race: '臺北馬拉松', raceDate: '2026-12-20', start: '06:30', dist: 'fm', grp: 'D', vol: '30', days: 6, club: true,
  age: 45, sex: 'M', kg: 62, rest: null, sweat: '中', pbDist: '10', pbTime: '0:48:30' };
const PROFILES = [
  { id: 'fmD45M', dist: 'fm', grp: 'D', age: 45, sex: 'M', kg: 62, rest: null, start: '06:30', sweat: '中' },
  { id: 'fmB38F', dist: 'fm', grp: 'B', age: 38, sex: 'F', kg: 50, rest: 55, start: '07:00', sweat: '低', pbDist: '21.0975', pbTime: '1:32:00' },
  { id: 'fmG52M', dist: 'fm', grp: 'G', age: 52, sex: 'M', kg: 75, rest: null, start: '06:30', sweat: '高', vol: 'lt30', days: 4 },
  { id: 'fmS38M', dist: 'fm', grp: 'S', age: 38, sex: 'M', kg: 63, rest: 52, start: '07:00', sweat: '中', days: 4, vol: '50', pbTime: '0:36:00' },
  { id: 'fmI52F', dist: 'fm', grp: 'I', age: 52, sex: 'F', kg: 58, rest: 60, start: '', sweat: '中', days: 3, club: false },
  { id: 'hmC45M', dist: 'hm', grp: 'C', age: 45, sex: 'M', kg: 62, rest: null, start: '06:30', sweat: '中' },
  { id: 'hmA38F', dist: 'hm', grp: 'A', age: 38, sex: 'F', kg: 50, rest: 55, start: '07:00', sweat: '低', days: 5, pbTime: '0:40:00' },
  { id: 'hmE52M', dist: 'hm', grp: 'E', age: 52, sex: 'M', kg: 75, rest: null, start: '', sweat: '高', days: 3, vol: 'lt30', club: false },
];
const nowAt = (d) => () => new Date(`${d}T08:00:00+08:00`);
// 課表教練的 S → coachcalc 的 ctx（週四團練地點用課表教練原本寫死的臺北田徑場）
function coach(fix, date = '2026-10-03') {
  const s = { ...BASE, ...fix };
  return K.createCoach({ dist: s.dist, grp: s.grp, nickname: s.name, venue: '臺北田徑場',
    prefs: { days: s.days, club: s.club, vol: s.vol }, pb: { dist: s.pbDist, time: s.pbTime },
    body: { age: s.age, sex: s.sex, kg: s.kg, rest: s.rest, sweat: s.sweat }, start: s.start,
    weeks: WEEKS, now: nowAt(date), cycle: { kind: s.raceDate === P.RACE_ISO ? 'club' : 'race', anchor: s.raceDate, name: s.race } });
}

test('錨點數字：MP、年齡分級、補給、心率', () => {
  const c = coach({});
  assert.equal(P.fmtP(c.goalPace()), '5:09');
  assert.equal(K.std100(45, 'M'), 128.89485);
  assert.equal(K.ageGrade(45, 'M', 217.5).toFixed(3), '59.262');
  const f = K.fuelCalc(62, 217.5, 'fm', '中');
  assert.deepEqual([f.lo, f.hi, f.gLo, f.gHi, f.gap, f.load], [60, 90, 9, 13, 15, [620, 744]]);
  assert.deepEqual(K.hrCalc(45, null).zones[1].slice(1, 3), [106, 124]);
  assert.deepEqual(K.hrCalc(45, 55).zones[1].slice(1, 3), [128, 140]);
  assert.equal(Math.round(K.hrCalc(45, null).p130), 74);
  assert.equal(Math.round(K.hrCalc(45, 55).p130), 62);
});

test('每組 × 每週天數 × 週四團練：可省略、配速、詳細內容、週文字跟課表教練一樣', () => {
  for (const key of Object.keys(GOLD.grid)) {
    const [, dist, grp, days, club] = /^(fm|hm)(\w)-(\d)-(T|F)$/.exec(key);
    const c = coach({ dist, grp, days: +days, club: club === 'T' });
    const pd = [], pn = [], ex = [], wt = [];
    for (const w of WEEKS) {
      const list = c.planDays(w);
      pd.push(list && list.map((x) => [x.k, x.opt, x.noteKeys]));
      pn.push(list && list.map((x) => c.paceNotes(x.t)));
      ex.push(list && list.map((x) => c.explain(x)));
      wt.push(c.weekText(w));
    }
    assert.deepEqual({ planDays: h(pd), paceNotes: h(pn), explain: h(ex), weekText: h(wt) }, GOLD.grid[key], key);
  }
});

test('沒填年齡：詳細內容只有 zone，不出現個人心率', () => {
  for (const [key, g] of Object.entries(GOLD.gridNoAge)) {
    const c = coach({ dist: key.slice(0, 2), grp: key.slice(2), age: null });
    const ex = WEEKS.map((w) => (c.planDays(w) || []).map((x) => c.explain(x)));
    assert.equal(h(ex), g.explain, key);
    assert.ok(!/bpm|下）/.test(JSON.stringify(ex)));
  }
  // 有年齡才算 bpm（zoneBpm 跟著 body.age）
  const withAge = coach({}).explain({ d: '週末', t: "110'LR@zone2", k: 'long' });
  assert.ok(withAge.some(([k, v]) => k === '心率' && /你約 \d+–\d+ 下/.test(v)));
});

test('全季複製文字與 .ics 全文一樣', () => {
  for (const [key, g] of Object.entries(GOLD.text)) {
    const c = coach({ dist: key.slice(0, 2), grp: key.slice(2) });
    assert.equal(c.copyPayload('all'), g.copyAll, `${key} 複製`);
    const ics = c.buildIcs();
    assert.equal(ics.count, g.ics.count);
    assert.equal(ics.text, g.ics.text, `${key} ics`);
    assert.ok(ics.text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75), '每行不超過 75 bytes');
  }
});

test('個人數字：比賽日流程、補給、心率、年齡分級、成績推算、提醒', () => {
  for (const p of PROFILES) {
    const g = GOLD.profiles[p.id];
    for (const d of Object.keys(g).filter((k) => /^\d{4}-/.test(k))) {
      const c = coach(p, d);
      assert.equal(c.weekIndex(), g[d].weekIndex, `${p.id} ${d} 週次`);
      assert.deepEqual(c.warnings().map((x) => x.text), g[d].warnings, `${p.id} ${d} 提醒`);
    }
    const c = coach(p), S = { ...BASE, ...p }, tMin = c.targetMin(), pred = c.predictedMin();
    const { offsets, ...rdp } = c.raceDayPlan();
    assert.deepEqual(offsets, [-240, -180, -90, -60, -25, -15, 0]);
    assert.deepEqual(json({
      targetMin: tMin, goalPace: c.goalPace(), raceDayPlan: rdp, fuel: K.fuelCalc(S.kg, tMin, S.dist, S.sweat || '中'),
      hr: K.hrCalc(S.age, S.rest), std100: K.std100(S.age, S.sex), ageGrade: K.ageGrade(S.age, S.sex, tMin),
      predictedMin: pred, suggestGroup: pred ? c.suggestGroup(pred) : null,
      verdict: pred ? K.verdict(K.ageGrade(S.age, S.sex, tMin) - K.ageGrade(S.age, S.sex, pred)) : null,
    }), (({ targetMin, goalPace, raceDayPlan, fuel, hr, std100, ageGrade, predictedMin, suggestGroup, verdict }) =>
      ({ targetMin, goalPace, raceDayPlan, fuel, hr, std100, ageGrade, predictedMin, suggestGroup, verdict }))(g), p.id);
  }
});

test('全季統計：只有完成時跟課表教練一樣；部分完成算 0.5', () => {
  const c = coach({}), done = new Set(GOLD.seasonStat.log);
  const statusOf = (n, x, i) => (done.has(`2026-12-20|${n}|${i}`) ? 'done' : null);
  assert.deepEqual(c.seasonStat(statusOf), GOLD.seasonStat.stat);
  const half = c.seasonStat((n, x, i) => (done.has(`2026-12-20|${n}|${i}`) ? 'partial' : null));
  assert.equal(half.done, GOLD.seasonStat.stat.done / 2);
  const w = c.weekStat(9, statusOf);
  assert.ok(w.req > 0);
});

test('個人週期：週次、全季文字、.ics 跟課表教練一樣', () => {
  for (const [a, r] of Object.entries(GOLD.personal)) {
    for (const [d, x] of Object.entries(r)) {
      if (!x?.w1) continue;
      const c = coach({ raceDate: a, race: '我的比賽' }, d);
      assert.equal(P.iso(c.w1Monday()), x.w1);
      assert.equal(c.weekIndex(), x.weekIndex, `${a} ${d}`);
    }
    const c = coach({ raceDate: a, race: '我的比賽' });
    assert.equal(h(c.copyPayload('all')), r.copyAll, `${a} 複製`);
    assert.equal(h(c.buildIcs()), r.ics, `${a} ics`);
  }
});

test('協會課表（W20 寫臺北馬拉松）也認得比賽列；週四團練地點由設定決定', () => {
  const season = JSON.parse(read('public/data/season-2026.json'));
  const c = K.createCoach({ dist: 'fm', grp: 'D', weeks: season, now: nowAt('2026-10-03') });
  const race = c.planDays(season[19]).find((x) => x.d === '週末');
  assert.equal(race.race, true);
  assert.equal(c.dispText(race), '比賽日：臺北馬拉松');
  assert.deepEqual(race.noteKeys, ['rd']);
  const w12 = c.planDays(season[11]).find((x) => x.d === '週末');
  assert.equal(w12.race, false);
  const thu = c.planDays(season[8]).find((x) => x.d === '週四');
  assert.deepEqual(thu.notes, ['週四團練']);
  const v = K.createCoach({ dist: 'fm', grp: 'D', weeks: season, venue: '臺北田徑場' });
  assert.deepEqual(v.planDays(season[8]).find((x) => x.d === '週四').notes, ['週四團練・臺北田徑場']);
  assert.equal(c.planTitle(), '跑者@臺北馬拉松課表');
  assert.match(c.copyPayload('week', 9), /■ W9 基礎期/);
  // 沒有起跑時間：時間軸用「起跑前幾小時」，並附 offsets
  const rd = c.raceDayPlan();
  assert.equal(rd.timeline[0][0], '起跑前 4 小時');
  assert.equal(rd.needKg, true);
});

test('目標成績覆寫與 parseGoal', () => {
  assert.equal(K.parseGoal('3:30'), 210);
  assert.equal(K.parseGoal('3:30:30'), 210.5);
  assert.equal(K.parseGoal('1：45'), 105);
  assert.equal(K.parseGoal('sub3'), null);
  assert.equal(K.parseGoal('3:75'), null);
  assert.equal(K.parseGoal(''), null);
  const c = K.createCoach({ dist: 'fm', grp: 'D', goalMin: 210, weeks: WEEKS });
  assert.equal(c.targetMin(), 210);
  assert.equal(P.fmtP(c.goalPace()), '4:59');
  assert.equal(K.parseTime('0:48:30'), 48.5);
});

test('純函式：coachcalc.js 不碰瀏覽器物件與網路', () => {
  const src = read('public/coachcalc.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const w of ['document', 'window', 'localStorage', 'fetch', 'navigator']) assert.ok(!new RegExp(`\\b${w}\\b`).test(src), `coachcalc.js 不能用 ${w}`);
});
