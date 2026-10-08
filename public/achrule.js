// 耕跑團 — 成績與挑戰的共用規則（worker.js、achieve.js、admin.js 共用；純資料與純函式，不碰 DOM、不 import 其他模組）
//   距離、時間解析與格式、挑戰類型、團服尺寸、線條圖示、達成條件的句子、挑戰設定檢查；
//   達成判斷一律整數運算（百分比 ×10、體重 ×10），邊界不受浮點誤差影響

export const DISTS = {
  '5k': { zh: '5K', km: 5 },
  '10k': { zh: '10K', km: 10 },
  hm: { zh: '半馬', km: 21.0975 },
  fm: { zh: '全馬', km: 42.195 },
  other: { zh: '其他距離', km: null },
};
export const STD = ['5k', '10k', 'hm', 'fm'];
export const isDist = (d) => typeof d === 'string' && Object.hasOwn(DISTS, d);
// other：1–250 公里、一位小數；標準距離固定
export const kmOf = (d, km) => (d === 'other' ? Math.round(Number(km) * 10) / 10 : DISTS[d]?.km ?? null);
export const kmOk = (d, km) => (d === 'other' ? Number.isFinite(km) && km >= 1 && km <= 250 : STD.includes(d));
export const distLabel = (d, km) => (d === 'other' ? `${kmOf(d, km)} 公里` : DISTS[d]?.zh || '');
// 我的賽事（races.dist 是自由文字：全馬／半馬／10K／5K／超馬／其他）→ 距離代碼
export const distFromRace = (s) => ({ 全馬: 'fm', 半馬: 'hm', '10K': '10k', '5K': '5k' })[String(s || '').trim()] || 'other';

export const KINDS = ['pb', 'time', 'pace', 'weight', 'km', 'attend'];
export const KIND_ZH = { pb: '破 PB', time: '時間門檻', pace: '速度上升', weight: '體重降低', km: '累積里程', attend: '團練出席' };
export const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
export const ATTEND_KINDS = ['track', 'core', 'long', 'race', 'other'];
export const ATTEND_DEFAULT = ['track', 'core', 'long'];
// 天數：結算延後、補記期限、體重結束量測寬限、結算後補核准、截圖保存、沒審的截圖保存、體重保存、婉拒保存、見證碼分鐘、兩次量測間隔、體重報名截止距結束；
//   見證比對容許差（0.1 公斤為單位）與次數
export const GRACE = { settle: 7, logs: 3, weighLate: 3, lateApprove: 60, proofDays: 7, proofPendingDays: 180, weightDays: 30, rejectDays: 180,
  witnessMin: 10, weighGap: 21, weighJoinGap: 18, witnessTol: 3, witnessTries: 3 };
export const LIMITS = { pending: 5, proofChars: 200000, bodyBytes: 210000, raceName: 40, bib: 10, note: 100, title: 30, intro: 300, sizeLen: 6, sizes: 12, pool: 20, pickupNote: 60 };

// 時間 → 秒：h:mm:ss 或 m:ss／mm:ss（沒有小時時分鐘可以超過 59，例如 75:30）；看不懂回 null
export function parseTime(s) {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = Number(m[1] || 0), mi = Number(m[2]), se = Number(m[3]);
  if (se > 59 || (m[1] !== undefined && mi > 59)) return null;
  const t = h * 3600 + mi * 60 + se;
  return t > 0 ? t : null;
}
// 秒 → h:mm:ss（不到一小時 m:ss）
export function fmtTime(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export const fmtPace = (sec, km) => `${fmtTime(Math.round(sec / km))}/km`;
// 合理範圍：每公里 2:40（比世界紀錄還快）到 20:00
export const timeOk = (sec, km) => Number.isInteger(sec) && km > 0 && sec >= Math.ceil(km * 160) && sec <= Math.floor(km * 1200);
export const x10 = (v) => Math.round(Number(v) * 10);
// 進步／減少的百分比（顯示用）：無條件捨去到 0.1，不會顯示 3.0% 卻沒達成
export const pctDown = (from, to) => (from > 0 ? Math.floor(((from - to) * 1000) / from) / 10 : 0);
export const paceMet = (base, best, target) => base > 0 && best > 0 && (base - best) * 1000 >= base * x10(target);
export const weightMet = (b10, l10, target) => b10 > 0 && l10 > 0 && (b10 - l10) * 1000 >= b10 * x10(target);
export const kgOk = (kg) => Number.isFinite(kg) && kg >= 30 && kg <= 250;

// 日期（YYYY-MM-DD，台北日期字串）
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
// 時間門檻的快捷（秒）
export const TIME_PRESETS = { fm: [10800, 12600, 14400, 16200, 18000], hm: [5400, 6300, 7200], '10k': [2400, 3000, 3600], '5k': [1200, 1500, 1800] };

// 線條圖示（24×24、stroke、不填色）：類型與徽章；畫面用 app.js 的 ic() 包起來
export const ACH_ICONS = {
  trophy: '<path d="M7 4h10v4a5 5 0 0 1-10 0Z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 3M17 6h2.5a2.5 2.5 0 0 1-2.6 3M12 13v4M8.5 20h7M10 17h4"/>',
  medal: '<circle cx="12" cy="15" r="5.5"/><path d="M8 10.5 5.5 3h4.2L12 8.2 14.3 3h4.2L16 10.5"/><path d="M12 12.6v4.8M10.4 14l1.6-1.4"/>',
  stopwatch: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 2.5h5M12 2.5V6M18.4 7.1l1.6-1.6"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  scale: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8.5 9a5 5 0 0 1 7 0l-2.2 2.2a1.9 1.9 0 0 0-2.6 0Z"/>',
  road: '<path d="M8 3 4 21M16 3l4 18M12 4v2.5M12 10v3M12 16.5V20"/>',
  calcheck: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M9 15l2 2 4-4"/>',
  shirt: '<path d="M8.5 3.5 4 6l-1.5 4.5 3 1.2v8.8h13v-8.8l3-1.2L20 6l-4.5-2.5a3.5 3.5 0 0 1-7 0Z"/>',
  flame: '<path d="M12 21a6.5 6.5 0 0 0 6.5-6.5c0-4.5-4.5-6.5-4-11.5-3 1.5-5.5 4.5-5.5 8-1-.8-1.5-2-1.5-3-1.6 1.7-2 3.8-2 6.5A6.5 6.5 0 0 0 12 21Z"/>',
  mountain: '<path d="M2.5 19.5 9 8l4 7 2.5-4 6 8.5Z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/>',
  sparkle: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17.5 5-4.5 4 3.5 3-2.5 4 3.5"/>',
  qr: '<path d="M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h2v2h-2ZM18 18h2v2h-2ZM14 18h2M18 14h2"/>',
};
export const KIND_ICON = { pb: 'medal', time: 'stopwatch', pace: 'trend', weight: 'scale', km: 'road', attend: 'calcheck' };
export const BADGES = ['trophy', 'medal', 'stopwatch', 'flame', 'mountain', 'heart', 'star', 'shirt'];

// 達成條件的句子：第一句是主句，其他是補充；每一句是一整個文字節點（英文介面靠 i18n.js 的 PATTERNS 整句換）
export function ruleLines(c) {
  const D = c.dist_key ? DISTS[c.dist_key]?.zh : null, o = c.opts || {}, out = [];
  if (c.kind === 'pb') {
    out.push(D ? `期間內跑出比挑戰開始前更快的${D}成績` : '期間內任一距離跑出比挑戰開始前更快的成績');
    out.push('基準是比賽日在開始前的最佳成績，而且至少要有一筆是挑戰發布前就登錄的');
    if (o.first_ok) out.push('之前沒有成績的人，期間內完賽就算');
  } else if (c.kind === 'time') {
    out.push(`期間內${D}跑進 ${fmtTime(c.target)}`);
    if (o.first_time) out.push('限第一次跑進');
  } else if (c.kind === 'pace') {
    out.push(`${D || '任一距離'}成績比挑戰開始前的 PB 快 ${c.target}% 以上`);
    out.push('基準是比賽日在開始前的最佳成績，而且至少要有一筆是挑戰發布前就登錄的');
  } else if (c.kind === 'weight') {
    out.push(o.verify === 'witness' ? `在團練現場量起始與結束體重（幹部見證），減少 ${c.target}% 以上` : `挑戰結束前自主聲明體重比開始時減少 ${c.target}% 以上`);
    out.push(o.verify === 'witness' ? '幹部看著體重計輸入讀數；體重加密保存，系統裡只有你看得到數字' : '榮譽制：體重不會上傳');
  } else if (c.kind === 'km') {
    out.push(`期間內訓練紀錄累積 ${c.target} 公里`);
    out.push('結束後 3 天內補記的也算，之後新增或修改的不算');
  } else if (c.kind === 'attend') {
    out.push(`期間內出席 ${c.target} 次團練`);
    out.push('以現場報到為準');
  }
  if (['pb', 'time', 'pace'].includes(c.kind)) out.push('比賽成績要先登錄並通過審核');
  if (c.confirm && c.kind === 'km') out.push('達成後由幹部確認');
  return out;
}

// 挑戰設定檢查（worker 存檔與後台表單共用）：c 已經整理成正確型別；回傳中文錯誤或 null
export function checkCampaign(c) {
  if (!c.title) return '請填挑戰名稱';
  if (!KINDS.includes(c.kind)) return '請選挑戰類型';
  if (!isDay(c.start_date) || !isDay(c.end_date) || c.end_date < c.start_date) return '請選開始與結束日期';
  const len = daysBetween(c.start_date, c.end_date) + 1;
  if (len > 366) return '挑戰期間最長一年';
  if (!isDay(c.join_by) || c.join_by < addDays(c.start_date, -30) || c.join_by > c.end_date) return '報名截止要在開始前 30 天到結束日之間';
  const std = (d) => STD.includes(d);
  if (c.kind === 'pb' && c.dist_key != null && !std(c.dist_key)) return '請選距離';
  if (c.kind === 'time' && (!std(c.dist_key) || !timeOk(c.target, DISTS[c.dist_key]?.km || 0))) return std(c.dist_key) ? '目標時間看起來不對' : '請選距離';
  if (c.kind === 'pace' && c.dist_key != null && !std(c.dist_key)) return '請選距離';
  if (c.kind === 'pace' && !(c.target >= 0.5 && c.target <= 20)) return '進步幅度請填 0.5–20%';
  if (c.kind === 'weight') {
    if (!(c.target >= 1 && c.target <= 10)) return '減少幅度請填 1–10%';
    if (len < 28) return '體重挑戰至少要 4 週';
    if (len > 180) return '體重挑戰最長 6 個月';
    if (!['honor', 'witness'].includes(c.opts?.verify)) return '請選體重的確認方式';
    if (c.join_by > addDays(c.end_date, -GRACE.weighJoinGap)) return '體重挑戰的報名截止要在結束日 18 天以前';
    if (c.opts.verify === 'honor' && c.rewards?.shirt) return '自主聲明的體重挑戰不能送團服（沒辦法驗證）';
  }
  if (c.kind === 'km' && !(c.target >= 10 && c.target <= 5000)) return '目標里程請填 10–5000 公里';
  if (c.kind === 'attend' && !(Number.isInteger(c.target) && c.target >= 1 && c.target <= 200)) return '出席次數請填 1–200 次';
  if (c.kind === 'attend' && !(Array.isArray(c.opts?.kinds) && c.opts.kinds.length && c.opts.kinds.every((k) => ATTEND_KINDS.includes(k)))) return '請選要算哪些團練';
  const s = c.rewards?.shirt;
  if (s) {
    if (!Array.isArray(s.sizes) || !s.sizes.length || s.sizes.length > LIMITS.sizes || s.sizes.some((z) => !z || z.length > LIMITS.sizeLen)) return '團服尺寸請選 1–12 種';
    if (s.quota != null && !(Number.isInteger(s.quota) && s.quota >= 1 && s.quota <= 2000)) return '團服名額請填 1–2000';
    if (s.size_by != null && (!isDay(s.size_by) || s.size_by < c.end_date)) return '尺寸截止要在結束日以後';
    if (s.pool != null && (typeof s.pool !== 'string' || !s.pool.trim() || s.pool.length > LIMITS.pool)) return '同款團服的名稱最多 20 字';
  }
  if (c.rewards?.badge != null && !BADGES.includes(c.rewards.badge)) return '請選徽章圖示';
  if (!c.rewards?.badge && !s && !c.rewards?.board) return '請至少選一種獎勵';
  return null;
}

// 發布後的修改檢查（worker A6 與後台表單共用）：old／next 是整理好型別的挑戰；today 台北日期；回傳中文錯誤或 null
export const LOCKED = ['kind', 'dist_key', 'target', 'opts', 'confirm', 'start_date', 'team_id', 'members_only'];
export function checkEdit(old, next, today) {
  if (old.status === 'draft') return null;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const ro = old.rewards || {}, rn = next.rewards || {}, so = ro.shirt, sn = rn.shirt;
  if (LOCKED.some((k) => !same(old[k], next[k])) || !same(ro.badge, rn.badge) || !same(ro.board, rn.board) || !!so !== !!sn || !same(so?.pool, sn?.pool)) return '挑戰開始後不能改條件';
  if (next.end_date < old.end_date) return '挑戰開始後不能改條件';
  if (next.end_date > old.end_date && today > old.end_date) return '挑戰已經結束，不能再延長';
  if (next.join_by < today && next.join_by !== old.join_by) return '報名截止要在開始前 30 天到結束日之間';
  if (so && sn) {
    if (so.quota === null ? sn.quota !== null : sn.quota !== null && sn.quota < so.quota) return '名額只能增加';
    if (so.sizes.some((z) => !sn.sizes.includes(z))) return '尺寸只能增加';
    if ((so.size_by || '') > (sn.size_by || '9999-12-31')) return '尺寸截止只能延後';
  }
  return null;
}
