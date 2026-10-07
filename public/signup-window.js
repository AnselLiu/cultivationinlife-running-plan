// 耕跑團 — 報名期間：伺服器（UTC）與用戶端（任何時區）共用
// 時間一律是台北牆上時間字串 'YYYY-MM-DDTHH:MM'，直接比字串大小；不要用 new Date('YYYY-MM-DDTHH:MM')（會變成裝置時區）
export const TP_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;
const toMs = (s) => Date.parse(`${s}:00Z`);                 // 牆上時間當成 UTC 做加減
const fromMs = (t) => new Date(t).toISOString().slice(0, 16);
export const isStamp = (s) => typeof s === 'string' && TP_RE.test(s) && fromMs(toMs(s)) === s;   // 擋 2026-02-30
export const tpNow = (ms = Date.now()) => fromMs(ms + 8 * 3600e3);
export const tpToday = (ms = Date.now()) => tpNow(ms).slice(0, 10);
export const shiftDays = (s, n) => (s ? fromMs(toMs(s) + n * 864e5) : s);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
// 活動開始：日期＋集合時間；沒有集合時間（或問卷）＝當天 23:59
export const evStart = (ev) => `${ev.date}T${ev.kind !== 'survey' && /^\d{2}:\d{2}$/.test(ev.gather_time || '') ? ev.gather_time : '23:59'}`;
// 報名截止：有填就用，沒填就是活動開始
export const signupEnd = (ev) => (isStamp(ev.deadline) ? ev.deadline : evStart(ev));
// 狀態優先順序：活動已取消 > 幹部關閉 > 尚未開放 > 已截止 > 開放（額滿另外判斷，不算關閉）
export function signupState(ev, now = tpNow()) {
  if (ev.status === 'cancelled' || ev.cancelled) return 'cancelled';
  if (!ev.signup_open) return 'off';
  if (isStamp(ev.signup_start) && now < ev.signup_start) return 'soon';
  if (now > signupEnd(ev)) return 'ended';          // 截止那一分鐘仍可報名
  return 'open';
}
const WD = '日一二三四五六';
export const tpText = (s) => (s ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}（${WD[new Date(`${s.slice(0, 10)}T00:00:00Z`).getUTCDay()]}）${s.slice(11, 16)}` : '');
export const tpShort = (s) => (s ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))} ${s.slice(11, 16)}` : '');
// 伺服器擋下時的訊息
export const STATE_TEXT = {
  cancelled: () => '這個活動已經取消',
  off: () => '這個活動沒有開放報名',
  soon: (ev) => `報名將於 ${tpText(ev.signup_start)} 開始`,
  ended: (ev) => (ev.kind === 'survey' ? '問卷已經截止' : '已經過了報名截止時間'),
};
// 活動頁顯示
export const STATE_LABEL = {
  cancelled: () => '活動已取消',
  off: () => '幹部已關閉報名',
  soon: (ev) => `尚未開放報名・${tpText(ev.signup_start)} 開始`,
  ended: (ev) => (ev.kind === 'survey' ? '問卷已截止' : ev.kind === 'claim' ? '索票已截止' : '報名已截止'),
};
// 活動結束：有結束時間用結束時間，沒有就到當天結束（問卷＝截止那天結束）
export const evEnd = (ev) => `${ev.date}T${ev.kind !== 'survey' && /^\d{2}:\d{2}$/.test(ev.end_time || '') ? ev.end_time : '23:59'}`;
// 卡片與分享連結預覽的狀態：cancelled 已取消｜over 已結束｜off 幹部關閉｜ext 用外部連結登記｜soon 即將開放｜closed 報名已截止｜full 額滿可候補｜open 報名中（索票：開放索票、索票已截止）
//   伺服器（連結預覽卡）與前端（活動卡片、沒登入的預覽）共用；full 由呼叫的人給（只要「滿了沒」，不給人數）
//   ext：App 裡不開放報名、改用「前往登記」的外部連結（例如慶功宴的表單）；不說「未開放報名」，免得以為還不能登記（ev.ext 是沒登入的預覽給的「有沒有連結」）
export function evPhase(ev, now = tpNow(), full = false) {
  if (ev.status === 'cancelled' || ev.cancelled) return 'cancelled';
  if (now > evEnd(ev)) return 'over';
  if (!ev.signup_open && (ev.link_url || ev.ext)) return 'ext';
  const st = signupState(ev, now);
  if (st === 'ended') return 'closed';
  if (st !== 'open') return st;
  return full ? 'full' : 'open';
}
export const PHASE_LABEL = {
  cancelled: () => '已取消',
  over: () => '已結束',
  off: () => '未開放報名',
  ext: () => '外部登記',
  soon: (ev) => `即將開放 ${tpShort(ev.signup_start)}`,
  closed: (ev) => (ev.kind === 'survey' ? '問卷已截止' : ev.kind === 'claim' ? '索票已截止' : '報名已截止'),
  full: () => '額滿可候補',
  open: (ev) => (ev.kind === 'survey' ? '填寫中' : ev.kind === 'claim' ? '開放索票' : '報名中'),
};
// 系統預設（settings 沒有 'signup' 這一列時使用）
export const SIGNUP_DEFAULTS = { approval: false, notify: true, open_days: null, open_time: '20:00', close_days: null, close_time: '22:00' };
// 依預設規則算出這場的報名開始與截止；'' 表示「立即開放」或「活動開始時截止」
export function defaultWindow({ date, gather_time, kind }, d = SIGNUP_DEFAULTS, now = tpNow()) {
  const notes = [], start0 = evStart({ date, gather_time, kind });
  let start = d.open_days == null ? '' : shiftDays(`${date}T${d.open_time || '20:00'}`, -d.open_days);
  let end = d.close_days == null ? '' : shiftDays(`${date}T${d.close_time || '22:00'}`, -d.close_days);
  if (end && end > start0) end = '';
  if (end && end <= now) { end = ''; notes.push('預設的截止時間已經過了，改成活動開始時截止'); }
  if (start && start <= now) start = '';
  if (start && start >= (end || start0)) { start = ''; notes.push('預設的開始時間晚於截止，改成立即開放'); }
  return { start, end, notes };
}
// 驗證；回傳錯誤訊息或 null。create＝新增活動（截止不能已經過去）
export function windowError(e, { now = tpNow(), create = false } = {}) {
  // 結束時間（選填）要晚於集合／開始時間；同一天，不跨午夜；只有結束沒有開始的話，活動頁會變成「－21:00」
  const hm = (t) => /^\d{2}:\d{2}$/.test(t || '');
  if (e.kind !== 'survey' && hm(e.end_time) && !hm(e.gather_time)) return '有結束時間的話，也要填集合（開始）時間';
  if (e.kind !== 'survey' && hm(e.end_time) && e.end_time <= e.gather_time) return '結束時間要在開始之後';
  if (e.signup_start && !isStamp(e.signup_start)) return '報名開始時間格式不正確';
  if (e.deadline && !isStamp(e.deadline)) return '報名截止時間格式不正確';
  const start0 = evStart(e);
  if (e.deadline && e.deadline > start0) return `報名截止不能晚於活動開始（${tpText(start0)}）`;
  if (e.signup_start && e.signup_start >= signupEnd(e)) return '報名開始要早於報名截止與活動開始';
  if (create && e.deadline && e.deadline <= now) return '報名截止時間已經過了';
  return null;
}
