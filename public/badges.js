// 每月里程挑戰的徽章：伺服器（月初總結通知）與畫面（挑戰頁）共用
//   km：當月里程；runs：練跑次數（不含沒練）；weeks：當月每一週是否都有練（陣列，true＝有練）
export const BADGES = [
  { id: 'km50', name: '50 公里', desc: '一個月跑滿 50 公里', ok: (s) => s.km >= 50 },
  { id: 'km100', name: '百K 跑者', desc: '一個月跑滿 100 公里', ok: (s) => s.km >= 100 },
  { id: 'km200', name: '200 公里', desc: '一個月跑滿 200 公里', ok: (s) => s.km >= 200 },
  { id: 'km300', name: '300 公里', desc: '一個月跑滿 300 公里', ok: (s) => s.km >= 300 },
  { id: 'steady', name: '每週都有練', desc: '這個月每一週都有訓練紀錄', ok: (s) => s.weeks.length >= 4 && s.weeks.every(Boolean) },
  { id: 'runs16', name: '一週四練', desc: '一個月練 16 次以上', ok: (s) => s.runs >= 16 },
];
export const earned = (s) => BADGES.filter((b) => b.ok(s)).map((b) => b.id);
// 某個月份（YYYY-MM）的週次：從當月 1 號起每 7 天一週，最後不滿 4 天的併入前一週
export function weeksOf(month, dates) {
  const days = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const n = Math.max(4, Math.floor(days / 7));
  const weeks = Array(n).fill(false);
  for (const d of dates) weeks[Math.min(n - 1, Math.floor((+d.slice(8, 10) - 1) / 7))] = true;
  return weeks;
}
