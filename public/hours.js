// 耕跑團 — 場地開放時間：把地點的「開放時間」文字解析成規則，判斷「現在有沒有開放、幾點開」
//   看得懂的寫法：「05:00–22:00」「每日 05:00–22:00」「全日開放」「24 小時」
//   「平日 05:30–07:00、17:40–21:30；假日 05:30–21:30」「4–9 月 06:00–18:00，10–3 月 06:00–17:30」「週一休園」
//   看不懂就回傳 null（畫面不反灰，只顯示原文），寧可不判斷也不要判斷錯
const WD = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const TIME = /(\d{1,2})[:：](\d{2})\s*[–—\-~～至到]\s*(\d{1,2})[:：](\d{2})/g;
const mins = (h, m) => Number(h) * 60 + Number(m);
const hhmm = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export function parseHours(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.replace(/（[^）]*）|\([^)]*\)/g, ' ');   // 括號裡的補充說明不算
  const closedDays = new Set();
  // 休館日寫在括號裡也算（例如「（週一休園）」），所以從原文找
  for (const m of text.matchAll(/(?:每)?週([一二三四五六日天])(?:[、,和及]週?([一二三四五六日天]))?\s*(?:休館|休園|休息|公休|不開放|閉館|休場)/g)) {
    closedDays.add(WD[m[1]]); if (m[2]) closedDays.add(WD[m[2]]);
  }
  const rules = [];
  // 先用「；」分大段，月份寫法再用「，」分小段
  for (const part of t.split(/[；;\n]/)) {
    for (const seg of /\d+\s*[–—\-~～至]\s*\d+\s*月/.test(part) ? part.split(/[，,](?=\s*\d+\s*[–—\-~～至]\s*\d+\s*月)/) : [part]) {
      const ranges = [...seg.matchAll(TIME)].map((m) => {
        const a = mins(m[1], m[2]), b0 = mins(m[3], m[4]);
        return [a, b0 === 0 ? 24 * 60 : b0];   // 到 24:00／00:00 當作午夜
      }).filter(([a, b]) => a < 24 * 60 && b <= 24 * 60 && a !== b);
      if (!ranges.length) continue;
      const mm = seg.match(/(\d{1,2})\s*[–—\-~～至]\s*(\d{1,2})\s*月/);
      const months = mm ? [Number(mm[1]), Number(mm[2])] : null;
      let days = null;
      if (/平日|週一至週五|週一到週五|一至五/.test(seg)) days = [1, 2, 3, 4, 5];
      else if (/假日|週末|週六日|週六、日|六日/.test(seg)) days = [0, 6];
      rules.push({ months, days, ranges });
    }
  }
  if (!rules.length) {
    if (/全日|全天|24\s*小時|不限時|全年無休|全時段/.test(t)) return { always: true, closedDays: [...closedDays], text };
    return null;
  }
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
