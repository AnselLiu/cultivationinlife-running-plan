// plan.js 單元測試：課表引擎（分類、配速、週期、日期、可省略、完成率）
// 跑法：mise exec node@22.23.2 -- npm run test:unit（tests/run.mjs 也會先跑）
process.env.TZ = 'Asia/Taipei';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as P from '../public/plan.js';
import * as O from './fixtures/plan-old.mjs';

const ROOT = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const SEASON = JSON.parse(read('public/data/season-2026.json'));
const COACH_WEEKS = JSON.parse(read('tests/fixtures/coach-weeks.json'));
const GOLD = JSON.parse(read('tests/fixtures/coach-golden.json'));
P.useWeeks(SEASON);

// 每一列：[週次, 項目, 組別, 第幾列, 星期, 內容]
function* rowsOf(weeks) {
  for (const w of weeks) {
    if (!w.plan) continue;
    const sets = w.plan.fmAll ? [['fm', '*', w.plan.fmAll], ['hm', '*', w.plan.hmAll]]
      : Object.entries(w.plan).flatMap(([dist, g]) => Object.entries(g).map(([grp, rows]) => [dist, grp, rows]));
    for (const [dist, grp, rows] of sets) for (const [i, [d, t]] of rows.entries()) yield { n: w.n, dist, grp, i, d, t };
  }
}
const gOf = (r) => (r.grp === '*' ? (r.dist === 'hm' ? 'C' : 'D') : r.grp);

test('分類與配速：跟舊版只差 33 列（W6 週四、W7 全馬週末、W7 半馬週二、W10 全馬 G/H/I 週一）', () => {
  const diff = [];
  for (const r of rowsOf(SEASON)) {
    const g = gOf(r);
    if (O.kindOf(r.d, r.t) !== P.kind(r.d, r.t) || O.paceHint(r.t, r.dist, g) !== P.paceHint(r.t, r.dist, g)) diff.push(`${r.n}|${r.dist}|${r.grp}|${r.i}`);
  }
  const WL = [
    ...'SABCDEFGHI'.split('').map((g) => `6|fm|${g}|3`), ...'ABCDE'.split('').map((g) => `6|hm|${g}|3`),
    ...'SABCDEFGHI'.split('').map((g) => `7|fm|${g}|5`), ...'ABCDE'.split('').map((g) => `7|hm|${g}|1`),
    '10|fm|G|0', '10|fm|H|0', '10|fm|I|0'];
  assert.equal(WL.length, 33);
  assert.deepEqual(diff.sort(), WL.sort());
  // 只有 W10 G/H/I 週一的分類改變（質量 → 輕鬆），其他 30 列是新增的配速提示
  const kindDiff = [...rowsOf(SEASON)].filter((r) => O.kindOf(r.d, r.t) !== P.kind(r.d, r.t)).map((r) => `${r.n}|${r.grp}|${P.kind(r.d, r.t)}`);
  assert.deepEqual(kindDiff, ['10|G|easy', '10|H|easy', '10|I|easy']);
  assert.equal(P.paceHint('10K MP', 'fm', 'D'), '≈ 5:09/km');
  assert.equal(P.paceHint("60' freejog@MP+90''~60''(體感漸進)", 'fm', 'G'), '≈ 7:29–6:59/km');
  assert.equal(P.paceHint("60' easyjog@MP+1'30''~1'", 'fm', 'D'), '≈ 6:39–6:09/km', '分鐘差要看得懂');
  assert.equal(P.paceHint('10K MP', 'fm', 'Z'), '', '組別不正確不給提示');
  assert.equal(P.kind('週末', '臺北馬拉松'), 'race');
  assert.equal(P.kindOf, P.kind);
});

test('目標配速與時間格式', () => {
  assert.equal(P.fmtPace(P.goalPace('fm', 'D')), '5:09');
  assert.equal(P.fmtP, P.fmtPace);
  assert.equal(P.fmtT(217.5), '3:37');
  assert.equal(P.fmtHMS(217.5), '3:37:30');
  assert.equal(P.fmtT(239.995), '4:00', '不會出現 3:60');
  assert.equal('fmTime' in P || 'fmtTime' in P, false, 'fmtTime 已刪除（沒有人用，且有 3:60 的錯）');
});

test('協會課表與教練 WEEKS 只差 W1 和 W20 比賽列（rep→rpe 由 build_data.py 修正後就不用換）', () => {
  const norm = (w) => { const { src, ...x } = w; return JSON.parse(JSON.stringify(x).replace(/rep([23])/g, 'rpe$1')); };
  const diff = [];
  for (let i = 0; i < 21; i++) {
    const a = norm(SEASON[i]), b = norm(COACH_WEEKS[i]);
    if (isDeepStrictEqual(a, b)) continue;
    if (i === 0) { diff.push('W1'); continue; }
    const fix = JSON.parse(JSON.stringify(a).replaceAll('"週末","臺北馬拉松"', '"週末","比賽日"'));
    assert.deepEqual(fix, b, `W${i + 1} 只能差比賽列`);
    diff.push(`W${i + 1}`);
  }
  assert.deepEqual(diff, ['W1', 'W20']);
});

test('週期：協會賽季與個人比賽日', () => {
  assert.equal(P.iso(P.W1), '2026-08-03');
  assert.equal(P.W1.getTime(), P.addDays(P.mondayOf(P.RACE), -133).getTime());
  assert.equal(P.W1.getTime(), P.CLUB.w1.getTime());
  assert.equal(P.CLUB.w1ISO, '2026-08-03');
  assert.equal(P.cycleOf('2027-03-21').w1ISO, '2026-11-02');
  assert.equal(P.cycleOf('2027-02-13').w1ISO, '2026-09-28');
  assert.equal(P.cycleOf('2026-11-15').w1ISO, '2026-06-29');
  const spring = P.cycleOf('2027-03-21');
  assert.equal(P.weekIndexOf('2026-10-03', spring), -4);
  assert.equal(P.currentWeek(new Date(2026, 9, 3), spring), 1);
  assert.equal(P.currentWeek(new Date(2026, 9, 3)), 9);
  assert.equal(P.inCycle('2026-10-03', spring), false);
  assert.equal(P.clubWeekOf('2026-08-02'), null);
  assert.equal(P.clubWeekOf('2026-08-03'), 1);
  assert.equal(P.clubWeekOf('2026-12-27'), 21);
  assert.equal(P.clubWeekOf('2026-12-28'), null);
  assert.equal(P.clubWeekOf('2027-01-04'), null);
  assert.equal(P.clubWeekOf('nope'), null);
  // 跟課表教練的週次一致
  for (const [a, r] of Object.entries(GOLD.personal)) for (const [d, x] of Object.entries(r)) {
    if (!x.w1) continue;
    assert.equal(P.cycleOf(a).w1ISO, x.w1);
    assert.equal(P.weekIndexOf(d, P.cycleOf(a)), x.weekIndex, `${a} 在 ${d}`);
  }
});

test('預設週期：週次與日期跟舊版完全一樣（W20 比賽日當天以後除外）', () => {
  const oldDates = (week, label) => {               // app.js 原本的 dayDates
    const WD = { 一: [0], 二: [1], 三: [2], 四: [3], 五: [4], 六: [5], 日: [6], 末: [5, 6] };
    const s = O.weekStart(week);
    const idx = [...String(label).matchAll(/[週周]([一二三四五六日末])/g)].flatMap((m) => WD[m[1]]);
    return (idx.length ? idx : [0]).map((i) => P.iso(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i)));
  };
  for (let n = 1; n <= 21; n++) {
    assert.equal(P.weekStart(n).getTime(), O.weekStart(n).getTime());
    for (const label of ['週一', '週二', '週三', '週四', '週五', '週六', '週日', '週五或週六', '週末', '週六或週日', '其他']) {
      const a = P.dayDates(n, label), b = oldDates(n, label);
      if (n === 20) assert.deepEqual(a, b.filter((d) => d < '2026-12-20'), `W20 ${label}`);
      else assert.deepEqual(a, b, `W${n} ${label}`);
    }
  }
  for (let d = new Date(2026, 6, 1); d < new Date(2027, 1, 1); d = P.addDays(d, 1)) {
    assert.equal(P.currentWeek(d), O.currentWeek(d), P.iso(d));
    assert.equal(P.weekOf(P.iso(d)), O.weekOf(P.iso(d)), P.iso(d));
  }
});

test('weekPlan、weekInfo、dayByGroup：除了 W10 G/H/I 週一的分類，結果跟舊版一樣', async () => {
  // 舊版的 weekPlan 用 fetch，這裡直接拿同一份資料照舊版的分類組出來比對
  for (let n = 1; n <= 21; n++) for (const [dist, gs] of [['fm', Object.keys(P.FM)], ['hm', Object.keys(P.HM)]]) for (const grp of gs) {
    const a = await P.weekPlan(n, dist, grp);
    const w = SEASON[n - 1];
    const raw = !w.plan ? null : w.plan.fmAll ? (dist === 'hm' ? w.plan.hmAll : w.plan.fmAll) : w.plan[dist]?.[grp];
    const b = raw ? raw.map(([d, t]) => ({ d, t, kind: O.kindOf(d, t) })) : null;
    if (n === 10 && dist === 'fm' && 'GHI'.includes(grp)) { b[0].kind = 'easy'; }
    assert.deepEqual(a, b, `W${n} ${dist} ${grp}`);
  }
  assert.equal((await P.weekInfo(9)).phase, '基礎期');
  const thu = await P.dayByGroup(6, 'fm', '週四');
  assert.equal(thu.find((x) => x.grp === 'D').hint, '≈ 5:09/km');
});

test('比賽日：只有 W20 週末那一列；W12「or 賽事」是一般長跑日', async () => {
  const hits = [];
  for (const r of rowsOf(SEASON)) if (P.isRaceDay({ d: r.d, t: r.t, kind: P.kind(r.d, r.t) }, r.n)) hits.push(`${r.n}|${r.d}`);
  assert.ok(hits.length > 0 && hits.every((h) => h === '20|週末'));
  const w12 = (await P.weekPlan(12, 'fm', 'D')).find((x) => x.d === '週末');
  assert.equal(w12.kind, 'race');
  assert.equal(P.isRaceDay(w12, 12), false);
  assert.equal(P.isRaceDay({ d: '週末', t: '比賽日', k: 'race' }, 7), true, '寫「比賽日」的列任何一週都算');
  const race = (await P.weekPlan(20, 'fm', 'D')).find((x) => x.d === '週末');
  assert.deepEqual(P.dayDates(20, '週末', P.CLUB, race), ['2026-12-20']);
});

test('個人週期：週六比賽、平日比賽的 W20 日期', () => {
  const sat = P.cycleOf('2027-02-13');
  assert.deepEqual(P.dayDates(20, '週五或週六', sat), ['2027-02-12']);
  assert.deepEqual(P.dayDates(20, '週末', sat, { d: '週末', t: '臺北馬拉松', kind: 'race' }), ['2027-02-13']);
  assert.deepEqual(P.dayDates(20, '週末', sat), [], '週末一般列：比賽日當天與之後不排');
  const wed = P.cycleOf('2027-03-17');
  assert.deepEqual(P.dayDates(20, '週二', wed), ['2027-03-16']);
  assert.deepEqual(P.dayDates(20, '週四', wed), []);
  assert.deepEqual(P.dayDates(5, '週二', P.cycleOf('2027-03-21')), ['2026-12-01']);
});

test('logMatches：協會與個人週期的紀錄不會互相對到', () => {
  const row = { d: '週二' }, spring = P.cycleOf('2027-03-21'), other = P.cycleOf('2027-02-13');
  const club = { week_no: 12, plan_day: '週二' }, mine = { week_no: 14, cycle_anchor: '2027-03-21', cycle_week: 5, plan_day: '週二' };
  assert.equal(P.logMatches(club, P.CLUB, 12, row), true);
  assert.equal(P.logMatches(club, spring, 12, row), false);
  assert.equal(P.logMatches(mine, spring, 5, row), true);
  assert.equal(P.logMatches(mine, P.CLUB, 14, row), false, '個人紀錄不會對到協會週次');
  assert.equal(P.logMatches(mine, other, 5, row), false, '也不會對到別場比賽');
  assert.equal(P.logMatches(mine, spring, 5, { d: '週三' }), false);
  assert.equal(P.logCycleKey({ plan_day: 'x' }), null);
  assert.deepEqual(P.cycleFields(P.CLUB, 12), { week_no: 12 });
  assert.deepEqual(P.cycleFields(spring, 5), { cycle_anchor: '2027-03-21', cycle_week: 5 });
});

test('可省略：每週 6 天不省略；5/4/3 天跟課表教練一樣', () => {
  for (const [dist, gs] of [['fm', 'SABCDEFGHI'], ['hm', 'ABCDE']]) for (const grp of gs) for (const days of [6, 5, 4, 3]) for (const club of [true, false]) {
    const pd = COACH_WEEKS.map((w) => {
      const raw = !w.plan ? null : w.plan.fmAll ? (dist === 'fm' ? w.plan.fmAll : w.plan.hmAll) : (w.plan[dist] || {})[grp] || null;
      if (!raw) return null;
      return P.markOptional(raw.map(([d, t]) => ({ d, t, k: P.kind(d, t) })), { days, club }, w.n).map((x) => [x.k, x.opt, x.noteKeys]);
    });
    const h = crypto.createHash('sha256').update(JSON.stringify(pd)).digest('hex').slice(0, 16);
    assert.equal(h, GOLD.grid[`${dist}${grp}-${days}-${club ? 'T' : 'F'}`].planDays, `${dist}${grp} ${days} 天 ${club}`);
    if (days === 6) for (const list of pd) assert.ok(!list || list.every((x) => !x[1]), '6 天不省略');
  }
});

test('完成率：6 天時跟現在課表頁的算法一樣；部分完成算 0.5、可省略的算加練', async () => {
  const rows = await P.weekPlan(9, 'fm', 'D');
  const logs = [{ plan_day: '週一', status: 'done' }, { plan_day: '週二', status: 'partial' }, { plan_day: '週二', status: 'skip' },
    { plan_day: '週四', status: 'partial' }, { plan_day: '週四', status: 'done' }, { plan_day: null, status: 'extra' }];
  const logOf = (d) => logs.filter((l) => l.plan_day === d.d);
  // app.js planView 原本的算法
  const planned = rows.filter((d) => d.kind !== 'rest');
  const doneN = planned.filter((d) => logOf(d).some((l) => l.status === 'done')).length;
  const partN = planned.filter((d) => logOf(d).some((l) => l.status === 'partial') && !logOf(d).some((l) => l.status === 'done')).length;
  const pct = Math.round((doneN + partN * 0.5) / planned.length * 100);
  const c = P.weekCompletion(P.markOptional(rows), logOf);
  assert.deepEqual([c.req, c.full, c.partial, c.pct], [planned.length, doneN, partN, pct]);
  const by = {}; for (const l of logs) if (l.plan_day) (by[l.plan_day] ||= []).push(l);
  assert.deepEqual(P.weekCompletion(P.markOptional(rows), by), c, '也可以傳 { 星期: 紀錄 }');
  const four = P.markOptional(rows, { days: 4, club: true });
  const c4 = P.weekCompletion(four, logOf);
  assert.ok(c4.req < c.req, '可省略的課不算在分母');
  assert.equal(c4.extra, four.filter((x) => x.opt && logOf(x).some((l) => l.status === 'done' || l.status === 'partial')).length);
  assert.deepEqual(P.weekCompletion(null, {}), { req: 0, done: 0, full: 0, partial: 0, extra: 0, pct: 0 });
});

test('今天的課：日期邊界與週末規則', async () => {
  const rowsOfWeek = async (n) => P.markOptional(await P.weekPlan(n, 'fm', 'D'), undefined, n);
  const labels = (date) => { const n = P.weekOf(date); return rowsOfWeek(n).then((r) => P.todaySessions(date, P.weekIndexOf(date), r).map((x) => x.d)); };
  assert.deepEqual(await labels('2026-08-02'), [], '8/3 以前沒有課');
  assert.deepEqual(await labels('2026-10-03'), ['週五或週六', '週末'], '週六：週五或週六，加上週末那一列（還沒記錄前）');
  assert.deepEqual(await labels('2026-10-02'), ['週五或週六'], '週五：週五或週六');
  assert.deepEqual(await labels('2026-10-10'), ['週五或週六', '週末']);
  assert.deepEqual(await labels('2026-10-11'), ['週末'], '週日');
  assert.deepEqual(await labels('2026-12-19'), ['週五或週六'], 'W20 週六只剩週五或週六');
  assert.deepEqual(await labels('2026-12-20'), ['週末'], '12/20 比賽');
  assert.deepEqual(await labels('2026-12-28'), [], '12/27 以後沒有課');
  const r = await rowsOfWeek(9);
  assert.deepEqual(P.todaySessions('2026-10-10', 10, await rowsOfWeek(10), ['週五或週六']).map((x) => x.d), ['週末'], '記錄過的不再出現');
  assert.equal(P.todaySessions('2026-09-29', 9, r)[0].i, 1, '帶回在週課表的位置');
});

test('今天的課：跟課表教練的 todayItems 一致（週末兩天都顯示、週六比賽日除外）', () => {
  for (const [a, rec] of Object.entries(GOLD.personal)) for (const [d, x] of Object.entries(rec)) {
    if (!x || typeof x !== 'object' || !x.todayItems) continue;
    const c = P.cycleOf(a), n = x.todayItems.n, w = COACH_WEEKS[n - 1];
    const rows = w.plan.fmAll ? w.plan.fmAll : w.plan.fm.D;
    const mine = P.todaySessions(d, n, rows.map(([dd, t]) => ({ d: dd, t, k: P.kind(dd, t) })), [], c).map((y) => y.d);
    let coach = x.todayItems.items;
    if (a === '2027-02-13' && d === '2027-02-13') coach = coach.filter((y) => y !== '週五或週六');   // 刻意不同：週六比賽當天不排週五或週六
    const sat = new Date(`${d}T00:00:00`).getDay() === 6;
    assert.deepEqual(mine.filter((y) => !(sat && y === '週末' && n !== 20)), coach, `${a} ${d}`);
  }
});

test('賽前階段', () => {
  assert.equal(P.raceStage('2026-12-06', '2026-12-20'), 'prep');
  assert.equal(P.raceStage('2026-12-05', '2026-12-20'), null);
  assert.equal(P.raceStage('2026-12-20', '2026-12-20'), 'race');
  assert.equal(P.raceStage('2026-12-22', '2026-12-20'), 'recover');
  assert.equal(P.raceStage('2026-12-27', '2026-12-20'), 'recover');
  assert.equal(P.raceStage('2026-12-28', '2026-12-20'), null);
  assert.equal(P.raceStage('x', '2026-12-20'), null);
  assert.equal(P.PHASES['比賽期'], 'sharp');
});

test('純函式：plan.js 只在 weeks() 用 fetch，不碰瀏覽器物件', () => {
  const src = read('public/plan.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const w of ['document', 'window', 'localStorage', 'navigator']) assert.ok(!new RegExp(`\\b${w}\\b`).test(src), `plan.js 不能用 ${w}`);
  const uses = [...src.matchAll(/\bfetch\(/g)];
  assert.equal(uses.length, 1);
  const fn = src.slice(src.indexOf('export async function weeks()'));
  assert.ok(fn.indexOf('fetch(') < fn.indexOf('\n}'), 'fetch 只在 weeks() 裡');
});
