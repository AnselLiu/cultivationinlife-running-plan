// 耕跑團課表資料與換算（前端與公告產生器共用）
// 課表來源：耕跑團記事本。2026 台北馬 W2–W8 是教練實際發布的；W9 以後依 2025 同期推估，標成「推估」。
export const W1 = new Date(2026, 7, 3);        // 2026-08-03（一）
export const RACE = new Date(2026, 11, 20);    // 2026 臺北馬
export const FM = { S: ['2:55–3:00', 175, 180], A: ['3:05–3:10', 185, 190], B: ['3:15–3:20', 195, 200], C: ['3:25–3:30', 205, 210], D: ['3:35–3:40', 215, 220], E: ['3:45–3:50', 225, 230], F: ['3:55–4:00', 235, 240], G: ['4:10–4:15', 250, 255], H: ['4:20–4:30', 260, 270], I: ['4:40–4:45', 280, 285] };
export const HM = { A: ['1:30', 85, 90], B: ['1:40', 95, 100], C: ['1:50', 105, 110], D: ['2:00', 115, 120], E: ['2:10', 125, 130] };
export const KIND_LABEL = { easy: '輕鬆', quality: '質量', long: '長跑', rest: '休息', strength: '肌力', race: '比賽' };

let WEEKS = null;
export async function weeks() {
  if (!WEEKS) WEEKS = await fetch('/data/season-2026.json').then((r) => r.json());
  return WEEKS;
}

export const groups = (dist) => (dist === 'hm' ? HM : FM);
export const fmtPace = (sec) => { sec = Math.round(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
export const fmtTime = (min) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
export function goalPace(dist, grp) {
  const g = groups(dist)[grp];
  if (!g) return 0;
  return ((g[1] + g[2]) / 2 * 60) / (dist === 'hm' ? 21.0975 : 42.195);
}
export const weekStart = (n) => new Date(W1.getTime() + (n - 1) * 7 * 864e5);
export function currentWeek(d = new Date()) {
  const t = new Date(d); t.setHours(0, 0, 0, 0);
  return Math.min(21, Math.max(1, Math.floor((t - W1) / (7 * 864e5)) + 1));
}
// 某一天屬於第幾週（活動日期用）
export const weekOf = (dateStr) => currentWeek(new Date(`${dateStr}T00:00:00`));

export function kindOf(day, t) {
  if (/賽事|臺北馬拉松|馬拉松$/.test(t)) return 'race';
  if (/^(休息|主動恢復)/.test(t)) return 'rest';
  if (/^核心/.test(t)) return 'strength';
  if (/週末|週日/.test(day)) return 'long';
  if (/LR\b|LSD|HLSD/.test(t)) return 'long';
  const noST = t.replace(/\d*\s*['"]*\s*\d*M?\s*ST\s*x\s*[\d~]+/gi, '').replace(/\d+~?\d*\s*\d+''ST/g, '');
  const reps = /\d\s*[x*]\s*\d|\)\s*x\s*\d|on\s*\+/.test(noST);
  const easy = /easy|freejog|free jog|Free Run|jog@|E@|\bE\b|E$|Ｅ/.test(t);
  if (easy && !reps && !/H?MP(?![a-z])/.test(t.replace(/E@MP/, ''))) return 'easy';
  if (reps || /Tempo|tempo|LT|pace|H?MP|漸進|@0?\d:\d\d/.test(t)) return 'quality';
  return 'easy';
}

// 把 MP±秒、HMP±秒 換算成實際配速字串，例如「≈ 5:29–5:19/km」
export function paceHint(text, dist, grp) {
  const mp = goalPace(dist, grp);
  if (!mp) return '';
  const out = [];
  const re = /(H?MP)\s*([+-])\s*(\d+)(?:''|")(?:\s*~\s*([+-])?\s*(\d+)(?:''|"))?/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === 'HMP' && dist === 'fm') continue;
    const ps = [mp + (m[2] === '-' ? -1 : 1) * +m[3]];
    if (m[5]) ps.push(mp + ((m[4] || m[2]) === '-' ? -1 : 1) * +m[5]);
    ps.sort((a, b) => b - a);
    out.push(ps.map(fmtPace).join('–'));
  }
  if (!out.length && /@\s*H?MP(?![+\-\s]*\d)/.test(text)) out.push(fmtPace(mp));
  return out.length ? `≈ ${[...new Set(out)].join('、')}/km` : '';
}

// 取某週、某組的課表；回傳 [{ d, t, kind }]
export async function weekPlan(n, dist, grp) {
  const w = (await weeks())[n - 1];
  if (!w || !w.plan) return null;
  const raw = w.plan.fmAll ? (dist === 'hm' ? w.plan.hmAll : w.plan.fmAll) : w.plan[dist]?.[grp];
  if (!raw) return null;
  return raw.map(([d, t]) => ({ d, t, kind: kindOf(d, t) }));
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
