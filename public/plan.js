// 耕跑團課表資料與換算（前端、伺服器與公告產生器共用）
// 課表來源：耕跑團記事本。2026 台北馬 W2–W8 是教練實際發布的；W9 以後依 2025 同期推估，標成「推估」。
// 純函式模組：只有 weeks() 會用 fetch；不碰 document、window、localStorage（node 測試與 worker 都能 import）
export const W1 = new Date(2026, 7, 3);        // 2026-08-03（一）
export const RACE = new Date(2026, 11, 20);    // 2026 臺北馬
export const RACE_ISO = '2026-12-20';
export const FM = { S: ['2:55–3:00', 175, 180], A: ['3:05–3:10', 185, 190], B: ['3:15–3:20', 195, 200], C: ['3:25–3:30', 205, 210], D: ['3:35–3:40', 215, 220], E: ['3:45–3:50', 225, 230], F: ['3:55–4:00', 235, 240], G: ['4:10–4:15', 250, 255], H: ['4:20–4:30', 260, 270], I: ['4:40–4:45', 280, 285] };
export const HM = { A: ['1:30', 85, 90], B: ['1:40', 95, 100], C: ['1:50', 105, 110], D: ['2:00', 115, 120], E: ['2:10', 125, 130] };
export const KIND_LABEL = { easy: '輕鬆', quality: '質量', long: '長跑', rest: '休息', strength: '肌力', race: '比賽' };
// 階段 → CSS 色彩 token（--ph-*）
export const PHASES = { 準備期: 'prep', 基礎期: 'base', 強化期: 'build', 巔峰期: 'peak', 比賽期: 'sharp', 賽事週: 'raceweek', 賽後恢復: 'rec' };

let WEEKS = null;
export async function weeks() {
  if (!WEEKS) WEEKS = await fetch('/data/season-2026.json').then((r) => r.json());
  return WEEKS;
}
// 測試與伺服器端直接注入課表資料（不用 fetch）
export function useWeeks(arr) { WEEKS = arr; }

/* ---------- 日期（照課表教練：用 setDate 加減天數，不用毫秒，換日光節約時間也不會差一天） ---------- */
const DAY = 864e5;
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
export const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
export function parseISO(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); return isNaN(d) ? null : d; }
export const dayDiff = (a, b) => Math.round((a - b) / DAY);

/* ---------- 週期：協會賽季，或跟自己的一場比賽排 20 週（同一份範本，只換日期） ---------- */
export function cycleOf(anchorISO, meta = {}) {      // meta: { kind, raceId, name, dist, goal }
  const w1 = addDays(mondayOf(parseISO(anchorISO)), -133);
  return Object.freeze({ kind: meta.kind || 'race', anchor: anchorISO, w1, w1ISO: iso(w1), ...meta });
}
export const CLUB = cycleOf(RACE_ISO, { kind: 'club', name: '臺北馬拉松' });
// 既有的週次函式都多一個選填的週期參數，預設協會賽季，舊的呼叫方式結果不變
export const weekStart = (n, c = CLUB) => addDays(c.w1, (n - 1) * 7);                                    // Date
export const weekIndexOf = (dateISO, c = CLUB) => Math.floor(dayDiff(parseISO(dateISO), c.w1) / 7) + 1; // 不夾在 1–21
export const currentWeek = (d = new Date(), c = CLUB) => Math.min(21, Math.max(1, weekIndexOf(iso(new Date(d)), c)));
// 某一天屬於第幾週（活動日期用）
export const weekOf = (dateISO, c = CLUB) => Math.min(21, Math.max(1, weekIndexOf(dateISO, c)));
export const inCycle = (dateISO, c = CLUB) => { const i = weekIndexOf(dateISO, c); return i >= 1 && i <= 21; };
// 某一天在協會賽季的第幾週；賽季外（8/3 以前、12/27 以後）是 null
export const clubWeekOf = (dateISO) => (parseISO(dateISO) && inCycle(dateISO, CLUB) ? weekIndexOf(dateISO, CLUB) : null);

// 訓練紀錄對到課表列：一律走這裡（協會週次 c|n，個人週期 r:比賽日|n）
export const logCycleKey = (l) => (l.cycle_anchor ? `r:${l.cycle_anchor}|${l.cycle_week}` : l.week_no ? `c|${l.week_no}` : null);
export const cycleKey = (c, n) => (c.kind === 'club' ? `c|${n}` : `r:${c.anchor}|${n}`);
export const logMatches = (l, c, n, row) => logCycleKey(l) === cycleKey(c, n) && l.plan_day === row.d;
export const cycleFields = (c, n) => (c.kind === 'club' ? { week_no: n } : { cycle_anchor: c.anchor, cycle_week: n });

/* ---------- 配速 ---------- */
export const groups = (dist) => (dist === 'hm' ? HM : FM);
export const fmtPace = (sec) => { sec = Math.round(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
export const fmtP = fmtPace;
export const fmtT = (min) => { const s = Math.round(min * 60); return Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };
export const fmtHMS = (min) => { const s = Math.round(min * 60); return Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
export function goalPace(dist, grp) {
  const g = groups(dist)[grp];
  if (!g) return 0;
  return ((g[1] + g[2]) / 2 * 60) / (dist === 'hm' ? 21.0975 : 42.195);
}

/* ---------- MP±時間 解析（照課表教練原文：分鐘差也看得懂，例如 MP+1'30''~1'） ---------- */
export const OFF = `(\\d+'\\d+(?:''|")|\\d+'(?!')|\\d+(?:''|"))`;
export const MP_RE = new RegExp(`(H?MP)\\s*([+-])\\s*${OFF}(\\s*~\\s*([+-])?\\s*${OFF})?`, 'g');
export function offSec(s) { let m; if ((m = /^(\d+)'(\d+)/.exec(s))) return +m[1] * 60 + +m[2]; if ((m = /^(\d+)'$/.exec(s))) return +m[1] * 60; return +/^\d+/.exec(s)[0]; }
export function mpMatches(t) {
  const out = []; let m; MP_RE.lastIndex = 0;
  while ((m = MP_RE.exec(t))) {
    const a = (m[2] === '-' ? -1 : 1) * offSec(m[3]);
    const b = m[6] != null ? (((m[5] || m[2]) === '-') ? -1 : 1) * offSec(m[6]) : null;
    out.push({ base: m[1], a, b, text: m[0] });
  }
  return out;
}

/* ---------- 每天的類型判斷（用原文判斷，與語言無關；照課表教練） ---------- */
export function kind(day, t) {
  if (/賽事|比賽日|馬拉松$/.test(t)) return 'race';
  if (/^(休息|主動恢復)/.test(t)) return 'rest';
  if (/^核心/.test(t)) return 'strength';
  if (/週末|週日/.test(day)) return 'long';
  if (/LR|LSD|HLSD/.test(t)) return 'long';
  const noST = t.replace(/\d+(?:\.\d+)?(?:~\d+)?\s*(?:M|m|''|")?\s*ST\s*[xX]\s*\d+(?:~\d+)?/g, '');
  const reps = /\d\s*[xX]\s*\d|\)\s*[xX]\s*\d|on\s*\+/.test(noST);
  let rest = t; for (const x of mpMatches(t)) if (x.a >= 60 && (x.b == null || x.b >= 60)) rest = rest.replace(x.text, '');
  const hasMP = /H?MP/.test(rest);
  const easyWord = /easy|freejog|Free Run|jog@|E@|(^|[^A-Za-z])[EＥ]([^A-Za-z]|$)/.test(t);
  if (easyWord && !reps && !hasMP) return 'easy';
  if (reps || /Tempo|LT|pace|H?MP|漸進|@\s*\d{1,2}:\d{2}/.test(rest)) return 'quality';
  return 'easy';
}
export const kindOf = kind;

/* ---------- 配速換算：MP±秒、HMP±秒 → 實際配速 ---------- */
export function paceNotes(t, dist, grp) {
  const S = { dist, grp }, goalPace_ = () => goalPace(dist, grp);
  const mp = goalPace_(), out = [];
  for (const x of mpMatches(t)) {
    if (x.base === 'HMP' && S.dist === 'fm') continue;
    const p = [mp + x.a]; if (x.b != null) p.push(mp + x.b); p.sort((a, b) => b - a);
    out.push([...new Set(p.map(fmtP))].join('–'));
  }
  if (!out.length) {
    const plain = /(H?MP)(?!\s*[+-]\s*\d)/.exec(t);
    if (plain && !(plain[1] === 'HMP' && S.dist === 'fm')) out.push(fmtP(mp));
  }
  return [...new Set(out)];
}
// 例如「≈ 5:29–5:19/km」；組別不正確時回傳空字串
export function paceHint(text, dist, grp) {
  if (!goalPace(dist, grp)) return '';
  const n = paceNotes(text, dist, grp);
  return n.length ? `≈ ${n.join('、')}/km` : '';
}

/* ---------- 比賽日、可省略的課、課表日期 ---------- */
// 比賽那一列：寫「比賽日」，或 W20 週末的賽事（W12 的「or 賽事」只是一般長跑日）
export const isRaceDay = (row, n) => (row.kind ?? row.k) === 'race' && (row.t === '比賽日' || (n === 20 && /週末|週日/.test(row.d)));
// 每週能練的天數不夠時，照課表教練的順序把輕鬆跑標成可省略：週五／六 → 週一 → 週三 → 其他
// 回傳新的陣列（每列多 opt 與 noteKeys：club 週四團練、self 自己練、opt 可省略、rd 比賽日）
export function markOptional(rows, prefs = { days: 6, club: true }, n = null) {
  if (!rows) return rows;
  const days = Number(prefs?.days) || 6, club = prefs?.club !== false;
  const k = (x) => x.kind ?? x.k;
  const list = rows.map((r) => ({ ...r, opt: false }));
  let drop = Math.max(0, list.filter((x) => k(x) !== 'rest' && k(x) !== 'strength').length - days);
  for (const re of [/週五|週六/, /週一/, /週三/, /./])
    for (const x of list) { if (drop <= 0) break; if (k(x) === 'easy' && !x.opt && re.test(x.d)) { x.opt = true; drop--; } }
  for (const x of list) {
    const thu = /週四/.test(x.d);
    x.noteKeys = [];
    if (club && thu && k(x) === 'quality') x.noteKeys.push('club');
    if (!club && thu && /團體/.test(x.t)) x.noteKeys.push('self');
    if (x.opt) x.noteKeys.push('opt');
    if (isRaceDay(x, n)) x.noteKeys.push('rd');
  }
  return list;
}
// 課表上的「週二」「週五或週六」「週末」→ 那一週實際的日期（週末＝六＋日）
export const WD_IDX = { 一: [0], 二: [1], 三: [2], 四: [3], 五: [4], 六: [5], 日: [6], 末: [5, 6] };
export function dayDates(n, label, c = CLUB, row = null) {
  if (row && isRaceDay(row, n)) return [c.anchor];               // 比賽那一列：只在比賽日
  const s = weekStart(n, c);
  const idx = [...String(label).matchAll(/[週周]([一二三四五六日末])/g)].flatMap((m) => WD_IDX[m[1]]);
  const out = (idx.length ? idx : [0]).map((i) => iso(addDays(s, i)));
  return n === 20 ? out.filter((d) => d < c.anchor) : out;      // W20：比賽日當天與之後不排課
}
// 今天要練的課：日期對得上、還沒記錄的列（loggedDays：已記錄的 plan_day）；回傳的每列多一個 i（在週課表裡的位置）
export function todaySessions(dateISO, week, rows, loggedDays = [], c = CLUB) {
  if (!(week >= 1 && week <= 21)) return [];
  const done = new Set(loggedDays);
  return (rows || []).map((r, i) => ({ ...r, i })).filter((r) => dayDates(week, r.d, c, r).includes(dateISO) && !done.has(r.d));
}
// 完成率：要練的＝不是休息、也不是可省略；完成算 1、部分完成算 0.5；可省略的課有練算加練
// logsOf(row) 回傳這一列的紀錄，或傳 { [plan_day]: logs[] }
export function weekCompletion(rows, logsOf) {
  const get = typeof logsOf === 'function' ? logsOf : (r) => logsOf?.[r.d] || [];
  let req = 0, done = 0, full = 0, partial = 0, extra = 0;
  for (const r of rows || []) {
    if ((r.kind ?? r.k) === 'rest') continue;
    const L = get(r) || [], d = L.some((l) => l.status === 'done'), p = !d && L.some((l) => l.status === 'partial');
    if (r.opt) { if (d || p) extra++; continue; }
    req++;
    if (d) { done += 1; full++; } else if (p) { done += 0.5; partial++; }
  }
  return { req, done, full, partial, extra, pct: req ? Math.round(done / req * 100) : 0 };
}
// 賽前 1–14 天 prep、當天 race、賽後 1–7 天 recover，其他 null
export function raceStage(todayISO, raceISO) {
  const a = parseISO(todayISO), b = parseISO(raceISO);
  if (!a || !b) return null;
  const d = dayDiff(b, a);
  return d === 0 ? 'race' : d >= 1 && d <= 14 ? 'prep' : d <= -1 && d >= -7 ? 'recover' : null;
}

// 快速打勾記在哪一天：候選日期裡今天（含）以前最近的一天；都還沒到回傳 null（未來的課不能先打勾）
export function tickDate(n, row, c = CLUB, todayISO) {
  const ds = dayDates(n, row.d, c, row).filter((d) => d <= todayISO);
  return ds.length ? ds[ds.length - 1] : null;
}
// 這週日期範圍內、不屬於這個週期這一週任何一列的照課表紀錄（例如換週期以前記的）：只算里程，不算完成率
export const otherCycleLogs = (logs, c, n, rows) =>
  (logs || []).filter((l) => l.plan_day && l.status !== 'extra' && !(rows || []).some((r) => logMatches(l, c, n, r)));
// 比賽在週末（六、日）：課表範本假設週日比賽，平日比賽的賽事週要請教練確認
export const weekendRace = (c) => { const d = parseISO(c.anchor); return !!d && (d.getDay() === 0 || d.getDay() === 6); };
// 紀錄屬於哪個週期的第幾週（畫面標示）：個人週期「個人 W5」、協會賽季「協會 W12」
export const logWeekLabel = (l) => (l.cycle_anchor || l.personal ? `個人 W${l.cycle_week}` : l.week_no ? `協會 W${l.week_no}` : '');

// 取某週、某組的課表；回傳 [{ d, t, kind }]
export async function weekPlan(n, dist, grp) {
  const w = (await weeks())[n - 1];
  if (!w || !w.plan) return null;
  const raw = w.plan.fmAll ? (dist === 'hm' ? w.plan.hmAll : w.plan.fmAll) : w.plan[dist]?.[grp];
  if (!raw) return null;
  return raw.map(([d, t]) => ({ d, t, kind: kind(d, t) }));
}
export async function weekInfo(n) { return (await weeks())[n - 1] || null; }

// 公告用：某週各組的某一天課表（週四團練、週末長跑…）
export async function dayByGroup(n, dist, dayPattern) {
  const w = (await weeks())[n - 1];
  if (!w?.plan || w.plan.fmAll) return [];
  const re = new RegExp(dayPattern);
  return Object.entries(w.plan[dist] || {}).map(([grp, days]) => {
    const hit = days.find(([d]) => re.test(d));
    return hit ? { grp, text: hit[1], hint: paceHint(hit[1], dist, grp) } : null;
  }).filter(Boolean);
}
