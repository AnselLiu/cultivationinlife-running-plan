// 產生課表教練的對照答案（tests/fixtures/coach-golden.json）：直接執行 public/coach.html 裡原本的程式，
// 之後 coachcalc.js、plan.js 的測試拿這份答案比對，確認搬家沒有改到任何計算結果。
// 用法：mise exec node@22.23.2 -- node tools/coach-golden.mjs（重跑結果要一模一樣）
// 做法：取出 coach.html 純計算的段落（行號固定，coach.html 在 P6 之前不會改），放進 node:vm，
//       用固定時間的 Date、空的 localStorage 執行；不需要瀏覽器。
process.env.TZ = 'Asia/Taipei';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lines = fs.readFileSync(`${ROOT}public/coach.html`, 'utf8').split('\n');
const at = (n) => lines[n - 1];
// 確認行號沒有跑掉
const ANCHORS = { 1093: 'const WEEKS = [', 1097: 'const DAY = 864e5;', 1189: 'function kind(day,t){', 1236: 'function planDays(w){',
  1337: 'function todayItems(){', 1414: 'function headerText(){', 1652: 'function raceDayPlan(){', 1933: 'function weekStat(n){', 2425: 'function buildIcs(){' };
for (const [n, s] of Object.entries(ANCHORS)) if (!at(+n).startsWith(s)) throw new Error(`coach.html 第 ${n} 行不是「${s}」，請更新行號`);
const RANGES = [[1093, 1093], [1097, 1107], [1111, 1252], [1277, 1284], [1296, 1308], [1337, 1344], [1414, 1442], [1467, 1472],
  [1478, 1490], [1516, 1520], [1532, 1541], [1586, 1644], [1651, 1680], [1695, 1721], [1927, 1945], [2412, 2462]];
const src = RANGES.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');
export const WEEKS = JSON.parse(at(1093).replace(/^const WEEKS = /, '').replace(/;\s*$/, ''));

// 固定時間的 Date：沒有參數時回傳 clock.now
const clock = { now: 0 };
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(clock.now); }
  static now() { return clock.now; }
}
const store = {};
const ctx = vm.createContext({ Date: FakeDate, TextEncoder, navigator: { language: 'zh-TW' }, console,
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } }, document: {} });
vm.runInContext(`${src}
globalThis.__coach = { set(fix) { S = Object.assign({}, DEFAULTS, fix, { lang: 'zh', week: null, view: 'week', explain: false, hl: null }); D = { log: {}, cds: [], badge: false }; },
  get S() { return S; }, setLog(log) { D.log = log; },
  WEEKS, planDays, paceNotes, explain, weekText, copyPayload, buildIcs, raceDayPlan, fuelCalc, hrCalc, std100, ageGrade, verdict, lvl,
  predictedMin, suggestGroup, warnings, todayItems, weekIndex, currentWeek, w1Monday, weekStart, targetMin, goalPace, seasonStat, kind, iso };`, ctx);
const C = ctx.__coach;

// 固定時間：當地時間早上 8 點
export const setNow = (isoDate) => { clock.now = new Date(`${isoDate}T08:00:00+08:00`).getTime(); };
export const h = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const json = (x) => JSON.parse(JSON.stringify(x));

// 一組設定（照課表教練的欄位）；預設：臺北馬、06:30 起跑、45 歲男性 62 kg
export const BASE = { name: '測試跑者', race: '臺北馬拉松', raceDate: '2026-12-20', start: '06:30', dist: 'fm', grp: 'D', vol: '30', days: 6, club: true,
  age: 45, sex: 'M', kg: 62, rest: null, sweat: '中', pbDist: '10', pbTime: '0:48:30' };
export const FM_G = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], HM_G = ['A', 'B', 'C', 'D', 'E'];
export const PROFILES = [
  { id: 'fmD45M', dist: 'fm', grp: 'D', age: 45, sex: 'M', kg: 62, rest: null, start: '06:30', sweat: '中' },
  { id: 'fmB38F', dist: 'fm', grp: 'B', age: 38, sex: 'F', kg: 50, rest: 55, start: '07:00', sweat: '低', pbDist: '21.0975', pbTime: '1:32:00' },
  { id: 'fmG52M', dist: 'fm', grp: 'G', age: 52, sex: 'M', kg: 75, rest: null, start: '06:30', sweat: '高', vol: 'lt30', days: 4 },
  { id: 'fmS38M', dist: 'fm', grp: 'S', age: 38, sex: 'M', kg: 63, rest: 52, start: '07:00', sweat: '中', days: 4, vol: '50', pbTime: '0:36:00' },
  { id: 'fmI52F', dist: 'fm', grp: 'I', age: 52, sex: 'F', kg: 58, rest: 60, start: '', sweat: '中', days: 3, club: false },
  { id: 'hmC45M', dist: 'hm', grp: 'C', age: 45, sex: 'M', kg: 62, rest: null, start: '06:30', sweat: '中' },
  { id: 'hmA38F', dist: 'hm', grp: 'A', age: 38, sex: 'F', kg: 50, rest: 55, start: '07:00', sweat: '低', days: 5, pbTime: '0:40:00' },
  { id: 'hmE52M', dist: 'hm', grp: 'E', age: 52, sex: 'M', kg: 75, rest: null, start: '', sweat: '高', days: 3, vol: 'lt30', club: false },
];
export const DATES = ['2026-07-20', '2026-10-03', '2026-12-19', '2026-12-20', '2027-01-20'];
export const ANCHORS_P = ['2027-03-21', '2027-02-13', '2026-11-15'];
export const DATES_P = ['2026-10-03', '2026-11-02', '2027-02-13', '2027-03-21'];

export function capture() {
  const out = { grid: {}, gridNoAge: {}, text: {}, profiles: {}, personal: {} };
  setNow('2026-10-03');
  // 1) 每組 × 每週天數 × 週四團練：planDays（k、opt、noteKeys）、配速、詳細內容、週文字
  for (const [dist, gs] of [['fm', FM_G], ['hm', HM_G]]) for (const grp of gs) for (const days of [6, 5, 4, 3]) for (const club of [true, false]) {
    C.set({ ...BASE, dist, grp, days, club });
    const pd = [], pn = [], ex = [], wt = [];
    for (const w of C.WEEKS) {
      const list = C.planDays(w);
      pd.push(list && list.map((x) => [x.k, x.opt, x.noteKeys]));
      pn.push(list && list.map((x) => C.paceNotes(x.t)));
      ex.push(list && list.map((x) => C.explain(x)));
      wt.push(C.weekText(w));
    }
    out.grid[`${dist}${grp}-${days}-${club ? 'T' : 'F'}`] = { planDays: h(pd), paceNotes: h(pn), explain: h(ex), weekText: h(wt) };
  }
  // 沒填年齡：詳細內容只顯示 zone，不顯示 bpm
  for (const [dist, grp] of [['fm', 'D'], ['hm', 'C']]) {
    C.set({ ...BASE, dist, grp, age: null });
    const ex = C.WEEKS.map((w) => (C.planDays(w) || []).map((x) => C.explain(x)));
    out.gridNoAge[`${dist}${grp}`] = { explain: h(ex), bpm: JSON.stringify(ex).includes('下）') };
  }
  // 2) 全文：全季複製文字與 .ics
  for (const [dist, grp] of [['fm', 'D'], ['hm', 'C']]) {
    C.set({ ...BASE, dist, grp });
    out.text[`${dist}${grp}`] = { copyAll: C.copyPayload('all'), ics: C.buildIcs() };
  }
  // 3) 個人數字
  for (const p of PROFILES) {
    const r = {};
    for (const d of DATES) {
      setNow(d);
      C.set({ ...BASE, ...p });
      const S = C.S, tMin = C.targetMin(), pred = C.predictedMin();
      r[d] = json({
        weekIndex: C.weekIndex(), warnings: C.warnings(),
        todayItems: (() => { const t = C.todayItems(); return t && { n: t.w.n, items: t.items.map((x) => x.d) }; })(),
      });
      if (d === '2026-10-03') Object.assign(r, json({
        targetMin: tMin, goalPace: C.goalPace(), raceDayPlan: C.raceDayPlan(), fuel: C.fuelCalc(S.kg, tMin, S.dist, S.sweat || '中'),
        hr: C.hrCalc(S.age, S.rest), std100: C.std100(S.age, S.sex), ageGrade: C.ageGrade(S.age, S.sex, tMin),
        predictedMin: pred, suggestGroup: pred ? C.suggestGroup(pred) : null,
        verdict: pred ? C.verdict(C.ageGrade(S.age, S.sex, tMin) - C.ageGrade(S.age, S.sex, pred)) : null,
      }));
    }
    out.profiles[p.id] = r;
  }
  // 全季統計：W2–W9 每週前兩堂完成
  setNow('2026-10-03');
  C.set({ ...BASE });
  const log = {};
  for (let n = 2; n <= 9; n++) for (const i of [0, 1, 3]) log[`2026-12-20|${n}|${i}`] = 1;
  C.setLog(log);
  out.seasonStat = { log: Object.keys(log), stat: json(C.seasonStat()) };
  // 4) 個人週期：週次、今天的課、全季文字與 .ics
  for (const a of ANCHORS_P) {
    const r = {};
    for (const d of DATES_P) {
      setNow(d);
      C.set({ ...BASE, raceDate: a, race: '我的比賽' });
      const t = C.todayItems();
      r[d] = { weekIndex: C.weekIndex(), w1: C.iso(C.w1Monday()), todayItems: t && { n: t.w.n, items: t.items.map((x) => x.d) } };
    }
    setNow('2026-10-03');
    C.set({ ...BASE, raceDate: a, race: '我的比賽' });
    r.copyAll = h(C.copyPayload('all'));
    r.ics = h(C.buildIcs());
    out.personal[a] = r;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = capture();
  fs.writeFileSync(`${ROOT}tests/fixtures/coach-weeks.json`, JSON.stringify(WEEKS) + '\n');
  fs.writeFileSync(`${ROOT}tests/fixtures/coach-golden.json`, JSON.stringify(out, null, 1) + '\n');
  console.log('已寫入 tests/fixtures/coach-golden.json、coach-weeks.json');
}
