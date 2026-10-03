// 耕跑團 — 場地開放時間：把地點的「開放時間」文字解析成規則，判斷「現在有沒有開放、幾點開」
//   看得懂的寫法：「05:00–22:00」「每日 05:00–22:00」「全日開放」「24 小時」「24H」
//   「週二至週六 08:30–21:00；週日、週一 09:00–17:00」「08:30–21:00（週一及國定假日休館）」
//   「平日 05:30–07:00、17:40–21:30；假日 05:30–21:30」「4–9 月 06:00–18:00，10–3 月 06:00–17:30」「週一休園」
//   看不懂就回傳 null（畫面不反灰，只顯示原文），寧可不判斷也不要判斷錯
const WD = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const TIME = /(\d{1,2})[:：](\d{2})\s*[–—\-~～至到]\s*(\d{1,2})[:：](\d{2})/g;
const mins = (h, m) => Number(h) * 60 + Number(m);
const hhmm = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const D = '[一二三四五六日天]';
// 星期區間「週二至週六」→ [2..6]（跨週也可以，例如週五至週一）
const span = (a, b) => { const out = []; for (let i = WD[a]; ; i = (i + 1) % 7) { out.push(i); if (i === WD[b]) break; } return out; };
// 一段文字裡的星期 → [0..6]；沒有提到回 null；提到但看不懂回 'bad'
function daysOf(seg) {
  const s = seg.replace(/星期/g, '週');
  let m;
  if (/平日|週一至週五|週一到週五|一至五/.test(s)) return [1, 2, 3, 4, 5];
  if ((m = s.match(new RegExp(`週(${D})\\s*[至到~～–\\-—]\\s*週?(${D})`)))) return span(m[1], m[2]);
  if ((m = s.match(new RegExp(`週(${D})(?:\\s*[、,，及和]\\s*週?(${D}))+`)))) return [...m[0].matchAll(new RegExp(D, 'g'))].map((x) => WD[x[0]]);
  if (/假日|週末|週六日|六日/.test(s)) return [0, 6];
  if ((m = s.match(new RegExp(`週(${D})`)))) return [WD[m[1]]];
  return /週|假日/.test(s) ? 'bad' : null;
}

export function parseHours(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.replace(/[:：]\s*\n/g, '：')   // 「週日、週一:↵9:00-17:00」標籤與時間分兩行 → 接起來
    .replace(/（[^）]*）|\([^)]*\)/g, ' ').replace(/星期/g, '週')
    .replace(/(\d)\s*(?=(?:每)?週[一二三四五六日天])/g, '$1；')                // 「…17:00週二~週六…」先斷開
    .replace(/[，,]\s*(?=(?:每)?週[一二三四五六日天]|平日|假日)/g, '；');
  const closedDays = new Set();
  for (const m of text.replace(/星期/g, '週').matchAll(new RegExp(`(?:每)?週(${D})(?:\\s*[、,和及]\\s*週?(${D}))?(?:\\s*[及和、]\\s*國定假日)?\\s*(?:休館|休園|休息|公休|不開放|閉館|休場)`, 'g'))) {
    closedDays.add(WD[m[1]]); if (m[2]) closedDays.add(WD[m[2]]);
  }
  const rules = [];
  for (const part of t.split(/[；;\n]/)) {
    for (const seg of /\d+\s*[–—\-~～至]\s*\d+\s*月/.test(part) ? part.split(/[，,](?=\s*\d+\s*[–—\-~～至]\s*\d+\s*月)/) : [part]) {
      const ranges = [...seg.matchAll(TIME)].map((m) => { const a = mins(m[1], m[2]), b0 = mins(m[3], m[4]); return [a, b0 === 0 ? 1440 : b0]; })
        .filter(([a, b]) => a < 1440 && b <= 1440 && a !== b);
      if (!ranges.length) continue;
      const mm = seg.match(/(\d{1,2})\s*[–—\-~～至]\s*(\d{1,2})\s*月/);
      const days = daysOf(seg.replace(/週.休館|休館/g, ''));
      if (days === 'bad') return null;                 // 提到星期卻看不懂：寧可不判斷
      rules.push({ months: mm ? [Number(mm[1]), Number(mm[2])] : null, days, ranges });
    }
  }
  if (!rules.length) {
    if (/全日|全天|24\s*小時|24\s*H\b|不限時|全年無休|全時段/i.test(t)) return { always: true, closedDays: [...closedDays], text };
    return null;
  }
  // 防呆：原文有星期或假日字樣，但沒有任何規則或休館日用到 → 不判斷
  const rest = text.replace(/星期/g, '週').replace(new RegExp(`(?:每)?週(${D})(?:\\s*[、,和及]\\s*週?(${D}))?(?:\\s*[及和、]\\s*國定假日)?\\s*(?:休館|休園|休息|公休|不開放|閉館|休場)`, 'g'), '').replace(/國定假日|例假日/g, '');
  if (/週[一二三四五六日天]|假日|平日|週末|周[一二三四五六日]/.test(rest) && !rules.some((r) => r.days)) return null;
  return { always: false, closedDays: [...closedDays], rules, text };
}

// 台北時間的 {日期、星期、分鐘}
function tp(now) {
  const d = new Date(now.getTime() + 8 * 3600e3);
  return { month: d.getUTCMonth() + 1, wd: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
const inMonths = (m, r) => !r || (r[0] <= r[1] ? m >= r[0] && m <= r[1] : m >= r[0] || m <= r[1]);
function rangesFor(h, month, wd) {
  if (h.closedDays.includes(wd)) return [];
  if (h.always) return [[0, 24 * 60]];
  return h.rules.filter((r) => inMonths(month, r.months) && (!r.days || r.days.includes(wd))).flatMap((r) => r.ranges).sort((a, b) => a[0] - b[0]);
}

// 現在的狀態：{ open, until?, next?, label }；看不懂回傳 null
export function hoursNow(text, now = new Date()) {
  const h = typeof text === 'object' && text ? text : parseHours(text);
  if (!h) return null;
  const { month, wd, min } = tp(now);
  const today = rangesFor(h, month, wd);
  const cur = today.find(([a, b]) => min >= a && min < b);
  if (cur) {
    if (h.always || (cur[0] === 0 && cur[1] === 24 * 60)) return { open: true, label: '開放中' };
    return { open: true, until: hhmm(cur[1]), label: `開放中・到 ${hhmm(cur[1])}` };
  }
  const later = today.find(([a]) => a > min);
  if (later) return { open: false, next: hhmm(later[0]), label: `目前未開放・${hhmm(later[0])} 開放` };
  // 往後找 7 天內第一個開放時段
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() + i * 864e5), x = tp(d), r = rangesFor(h, x.month, x.wd);
    if (r.length) return { open: false, next: hhmm(r[0][0]), label: `目前未開放・${i === 1 ? '明天' : `週${'日一二三四五六'[x.wd]}`} ${hhmm(r[0][0])} 開放` };
  }
  return { open: false, label: '目前未開放' };
}
