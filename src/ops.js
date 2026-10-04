// 耕跑團 — 營運三項的純函式（推播摘要、系統健康告警、幹部週報）：不碰 D1、不碰網路，worker 與單元測試共用
//   推播摘要：holdable（這則能不能延到每日摘要）、eventLatest（活動最晚要在什麼時候推到）、digestText（摘要的文字）
//   系統告警：opsConditions（六個條件，輸入是每小時 CRON_PROBE 那一句查出來的 ops 欄）
//   幹部週報：reportPush（鎖定畫面的文字）、reportFor（依身分剝掉看不到的區塊）
//   鎖定畫面一律只有分類、則數、人數、百分比：不放人名、金額、RPE、公里數
import { CATS } from '../public/notif-cats.js';

// ---- 推播摘要 ----
export const DIGEST_HOURS = Array.from({ length: 16 }, (_, i) => i + 7);   // 07–22 點
export const DIGEST_DEFAULT = 20;
export const DIGEST_SPAN = 3;              // 摘要整點 H 起，到 H+3 之前的整點都可以補做（額度不夠、備份佔用整點時）
export const DIGEST_BATCH = 400;           // 一次執行最多送幾個人的摘要，剩下的下個整點做
export const DIGEST_MIN_TTL = 6 * 3600;    // 時效短於 6 小時的一律即時
export const DIGEST_TTL = 6 * 3600;        // 摘要推播本身的 TTL
export const isDigestHour = (h) => Number.isInteger(h) && h >= 7 && h <= 22;
const LATEST_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// 這一則可不可以延到每日摘要：{ hold: 0|1, latest: 'YYYY-MM-DD HH:MM'（台北）| null }
//   hold＝1 只是「可以延後」：收件人有沒有選摘要、有沒有訂閱、有沒有關掉這一類、下一次摘要來不來得及，在 SQL 逐人判斷（worker.js 的 NOTE_SQL）
//   不延後（任何一個成立就即時）：
//     1. 分類的 digest 是 false（帳號安全、幹部待辦、系統狀態）
//     2. opt.force，或分類 locked 但不是 'timed'
//     3. msg.now（呼叫端明確要求，例如有名額上限的開放報名：先搶先贏）
//     4. urgency high 而且沒有 latest（集合前提醒等時效短的）
//     5. TTL 短於 6 小時
//     6. 'timed' 但沒有 latest（不知道活動時間就即時，安全的那一邊）
export function holdable(cat, msg = {}, opt = {}) {
  const def = CATS[cat], no = { hold: 0, latest: null };
  if (!def || !def.digest) return no;
  if (opt.force || (def.locked && def.digest !== 'timed')) return no;
  if (msg.now === true) return no;
  const latest = typeof msg.latest === 'string' && LATEST_RE.test(msg.latest) ? msg.latest : null;
  const urgency = msg.urgency ?? def.urgency, ttl = Number(msg.ttl ?? def.ttl);
  if (urgency === 'high' && !latest) return no;
  if (!(ttl >= DIGEST_MIN_TTL)) return no;
  if (def.digest === 'timed' && !latest) return no;
  return { hold: 1, latest };
}

// 活動相關通知最晚要在什麼時候推到手機：集合時間（沒有就當天 06:00）往前 3 小時，台北時間 'YYYY-MM-DD HH:MM'
//   活動日期是今天、明天（台北）、已經過了，或這則是取消：回 null（一律即時）
const tpDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
export function eventLatest(ev, now = new Date(), { cancel = false } = {}) {
  if (cancel || !ev || ev.status === 'cancelled' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) return null;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (ev.date <= tpDay(t + 864e5)) return null;
  const hm = /^\d{2}:\d{2}$/.test(ev.gather_time || '') ? ev.gather_time : '06:00';
  // 台北的牆上時間當成 UTC 來加減（只拿來算字串，不當成真的時刻）
  return new Date(Date.parse(`${ev.date}T${hm}:00Z`) - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}

// 摘要的文字：只有分類名稱與則數（依 CATS 的順序，最多列 4 類，其餘併成「其他 N」）；不含任何通知的標題或內文
//   cats：{ 分類: 則數 }（不認得的分類算在「其他」）
export function digestText(cats = {}) {
  const known = Object.keys(CATS).filter((k) => Number(cats[k]) > 0).map((k) => [CATS[k].zh, Math.floor(Number(cats[k]))]);
  const unknown = Object.entries(cats).filter(([k]) => !Object.hasOwn(CATS, k)).reduce((t, [, v]) => t + (Math.floor(Number(v)) || 0), 0);
  const shown = known.slice(0, 4), rest = known.slice(4).reduce((t, [, n]) => t + n, 0) + unknown;
  const parts = shown.map(([zh, n]) => `${zh} ${n}`);
  if (rest > 0) parts.push(`其他 ${rest}`);
  const n = known.reduce((t, [, x]) => t + x, 0) + unknown;
  return { title: '今天的通知摘要', body: `${parts.join('、')}。點開看全部`, n };
}

// ---- 系統健康告警 ----
// 門檻都在這裡，之後要調只改一處
export const OPS = {
  quotaPct: 0.8,          // 每日額度用到 80%
  backupHours: 26,        // 每日備份超過 26 小時沒有完成
  errMin: 20,             // 今天前端錯誤至少 20 次
  errRatio: 3,            // 而且錯誤率是前 7 天的 3 倍以上
  errFloor: 0.02,         //   門檻最低 2%（前 7 天幾乎沒有錯誤時）
  errOpensMin: 20,        // 開啟次數少於 20 時當成 20（避免一兩次開啟就算出很高的比例）
  pushMin: 20,            // 推播暫時性失敗＋丟棄至少 20
  pushRatio: 0.25,        //   而且佔送出嘗試的 25% 以上
  pushAgeHours: 6,        // 或推播佇列最早一則已經等了 6 小時
  stops: 2,               // 同一個排程工作今天因額度停下 2 次以上
};
export const OPS_CONDS = ['backup', 'quota', 'stops', 'errors', 'push', 'cron'];
export const OPS_NAME = { backup: '每日備份', quota: '每日額度', stops: '排程工作停下', errors: '前端錯誤', push: '推播', cron: '排程工作失敗' };
// ops_daily 的欄位 → 每日額度（budget.js 的 PLANS.free.daily）的鍵與中文名稱
export const QUOTA_COLS = [['req', 'req', 'Worker 請求'], ['d1_read', 'd1Read', 'D1 讀取'], ['d1_write', 'd1Write', 'D1 寫入'],
  ['kv_read', 'kvRead', 'KV 讀取'], ['kv_write', 'kvWrite', 'KV 寫入'], ['kv_list', 'kvList', 'KV 列出'], ['kv_del', 'kvDel', 'KV 刪除']];
const SEE = '請到管理後台「總覽」查看';
// D1 的 datetime（'YYYY-MM-DD HH:MM:SS'，UTC）或 ISO 字串 → 毫秒
const msOf = (s) => { if (!s) return null; const t = Date.parse(/T/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`); return Number.isFinite(t) ? t : null; };
const pct = (x) => Math.round(x * 100);

// 每日額度用量（usage）：{ day, values: { 欄位: 數字 }, quota: { 欄位: 上限 }, pct: { 欄位: 百分比 } }；付費方案（daily＝null）沒有 quota
export function quotaUsage(daily, quota) {
  const values = {}, q = {}, p = {};
  for (const [col, key] of QUOTA_COLS) {
    values[col] = Number(daily?.[col]) || 0;
    if (quota?.[key]) { q[col] = quota[key]; p[col] = Math.floor((values[col] / quota[key]) * 100); }
  }
  return { values, quota: quota ? q : null, pct: quota ? p : null };
}

// 現在成立的條件：[{ cond, detail, text }]（text 是鎖定畫面的內文，detail 寫進 ops_alerts 與稽核；都不含個資與錯誤原文）
//   p：CRON_PROBE 的 ops 欄（已 JSON.parse）
//     daily：今天（UTC）ops_daily 那一列｜bk：[每日備份 done_at, 第一次佔用時間]｜stops：今天（UTC）停下 ≥ 2 次的工作名稱
//     err、opens：今天（台北）前端錯誤數與開啟次數｜base：[前 7 天錯誤數, 開啟次數]（只有 err ≥ 20 才查）
//     pq：推播佇列最早一則的建立時間｜gave：已放棄（失敗 3 次）的排程工作
//   cfg：{ backupOn：有沒有設定每日備份, quota：每日額度（付費方案 null）, nowMs：真實的現在（done_at 等是資料庫的真實時間） }
export function opsConditions(p, cfg = {}) {
  const out = [], o = p || {}, now = cfg.nowMs ?? Date.now();
  // 1. 每日備份：最後一次完成超過 26 小時（從沒完成過就看第一次佔用時間）
  if (cfg.backupOn) {
    const [done, first] = Array.isArray(o.bk) ? o.bk : [];
    const ref = msOf(done) ?? msOf(first);
    if (ref != null && now - ref > OPS.backupHours * 3600e3) {
      const h = Math.floor((now - ref) / 3600e3);
      out.push({ cond: 'backup', detail: `${done ? '上次完成' : '開始'}於 ${new Date(ref).toISOString().slice(0, 16).replace('T', ' ')} UTC（${h} 小時前）`,
        text: `每日備份超過 ${OPS.backupHours} 小時沒有完成。${SEE}` });
    }
  }
  // 2. 每日額度：任一項 ≥ 80%（付費方案不檢查）
  if (cfg.quota && o.daily) {
    const u = quotaUsage(o.daily, cfg.quota);
    const ratio = (col) => u.values[col] / u.quota[col];
    const top = QUOTA_COLS.filter(([col]) => u.quota[col] && ratio(col) >= OPS.quotaPct).sort((a, b) => ratio(b[0]) - ratio(a[0]))[0];
    if (top) out.push({ cond: 'quota', detail: `${top[1]} ${u.pct[top[0]]}%`, text: `今天的 ${top[2]} 用量已到每日額度的 ${u.pct[top[0]]}%。${SEE}` });
  }
  // 3. 排程工作連續因額度停下：同一個名稱今天停下 ≥ 2 次；本來就分段做的（每日備份、推播佇列）不算
  const stops = (Array.isArray(o.stops) ? o.stops : []).filter((n) => typeof n === 'string' && !n.split(':').some((x) => /^(backup|push|drain)/.test(x)));
  if (stops.length) out.push({ cond: 'stops', detail: stops.slice(0, 3).join('、').slice(0, 120), text: `有排程工作連續因額度停下。${SEE}` });
  // 4. 前端錯誤暴增：今天錯誤 ≥ 20，而且錯誤率 ≥ 前 7 天的 3 倍（門檻最低 2%）
  const E = Number(o.err) || 0;
  if (E >= OPS.errMin) {
    const rate = E / Math.max(Number(o.opens) || 0, OPS.errOpensMin);
    const [bE, bO] = Array.isArray(o.base) ? o.base.map(Number) : [0, 0];
    const baseRate = bO > 0 ? (bE || 0) / bO : 0;
    const need = Math.max(baseRate * OPS.errRatio, OPS.errFloor);
    if (rate >= need) out.push({ cond: 'errors', detail: `${E} 次，錯誤率 ${pct(rate)}%（前 7 天 ${pct(baseRate)}%）`, text: `今天的前端錯誤比平常多很多。${SEE}` });
  }
  // 5. 推播：暫時性失敗＋丟棄 ≥ 20 而且 ≥ 送出嘗試的 25%；或佇列最早一則等了 6 小時
  const d = o.daily || {};
  const bad = (Number(d.push_err) || 0) + (Number(d.push_drop) || 0), tries = (Number(d.push_sent) || 0) + (Number(d.push_err) || 0) + (Number(d.push_gone) || 0);
  const oldest = msOf(o.pq);
  if ((bad >= OPS.pushMin && bad >= Math.max(tries, bad) * OPS.pushRatio) || (oldest != null && now - oldest > OPS.pushAgeHours * 3600e3)) {
    out.push({ cond: 'push', detail: oldest != null && now - oldest > OPS.pushAgeHours * 3600e3 ? `佇列最早一則等了 ${Math.floor((now - oldest) / 3600e3)} 小時` : `失敗 ${bad}／嘗試 ${tries}`,
      text: `推播送不出去的比例偏高。${SEE}` });
  }
  // 6. 排程工作已放棄：失敗 3 次、已停止重試（同管理後台 gave_up 的判斷）
  const gave = (Array.isArray(o.gave) ? o.gave : []).filter((x) => typeof x === 'string');
  if (gave.length) out.push({ cond: 'cron', detail: gave.slice(0, 3).join('、').slice(0, 120), text: `有排程工作連續失敗 3 次、已停止重試。${SEE}` });
  return out;
}

// ---- 幹部週報 ----
export const REPORT_MIN_SHARE = { assoc: 5, team: 3 };   // 分享訓練紀錄的人少於這個數字，訓練區塊整塊不顯示
const pctText = (x) => (x == null ? '—' : `${x}%`);
// 鎖定畫面的文字：只有數字
export function reportPush(data) {
  if (!data) return '';
  const a = `報名 ${data.signups?.new ?? 0}、出席率 ${pctText(data.attendance?.pct)}`;
  if (data.scope !== 'assoc') return `${a}、新團員 ${data.newcomers?.members ?? 0}`;
  const h = data.health || {};
  const bk = h.backup ? (h.backup.days >= 7 ? '備份正常' : `備份 ${h.backup.days}/7 天`) : '備份未設定';
  const al = Object.values(h.alerts || {}).reduce((t, n) => t + (Number(n) || 0), 0);
  return `${a}、新成員 ${data.newcomers?.runners ?? 0}。系統：${bk}、${al ? `告警 ${al} 次` : '沒有告警'}`;
}
// 依身分剝掉看不到的區塊（資料只存一份）：training＝看得到訓練完成率；health＝看得到系統健康
export function reportFor(data, { training = false, health = false } = {}) {
  const out = { ...data };
  if (!training) { delete out.training; delete out.trainingHidden; }
  if (!health) delete out.health;
  return out;
}
