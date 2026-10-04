// 耕跑團 — 執行額度（Workers 免費方案）
//   免費方案每次執行：子請求 50 個（D1 每一句、KV 每次操作、對外 fetch、呼叫自己的 RPC 都算，合計一個計數）、
//   D1 查詢 50 個（batch 裡每一句分開算）、CPU 10 ms、同時連線 6 個。預覽環境量不到，計數一律照官方文件用保守算法。
//   正式環境：計數只拿來決定「做到哪裡就停」（工作自己用 room() 在上限前停下），超過也不丟錯，只記下 over 給 log。
//   測試嚴格模式（DEV_LOGIN=1 且 BUDGET_STRICT=1）：超過上限就丟 BudgetExceeded，並記到 strictViolations。
//   之後改用付費方案，只要把 wrangler.jsonc 的 PLAN 改成 paid，程式不用動。
export const PLANS = {
  free: { sub: 50,   d1: 50,   soft: 44,  pushPerHop: 10,  pushKick: 3,  pushDepth: 20, pushConc: 4, holidayPages: 10, backupSeg: 256 * 1024, backupHops: 4 },
  paid: { sub: 1000, d1: 1000, soft: 900, pushPerHop: 200, pushKick: 20, pushDepth: 25, pushConc: 6, holidayPages: 20, backupSeg: 16 * 1024 * 1024, backupHops: 4 },
};
// 每日額度（Cloudflare 免費方案，00:00 UTC 重置；數字照官方限制頁：Workers 請求 10 萬、D1 讀取 500 萬列與寫入 10 萬列、KV 讀取 10 萬與寫入／列出／刪除各 1,000）
//   系統告警（src/ops.js 的 quota 條件）用到 80% 就通知理事長與行政人員；付費方案的每日額度大很多，不做這個告警（daily＝null）
PLANS.free.daily = { req: 100000, d1Read: 5000000, d1Write: 100000, kvRead: 100000, kvWrite: 1000, kvList: 1000, kvDel: 1000 };
PLANS.paid.daily = null;
// backupSeg：每日備份一段（一次執行）最多處理多少 JSON 字元。CPU 跟資料量成正比（M4 上 stringify＋gzip 約 10 ms／MB），
//   256 KB 約 3 ms，乘 2 換算 Cloudflare 主機還在 10 ms 內；資料多時分好幾段、好幾個整點做完（見 worker.js 的 backupStep）
// backupHops：JOB_DISPATCH=self（staging 驗證過每次呼叫自己都有自己的額度）時，一個整點最多接著做幾段
export const planOf = (env) => PLANS[env?.PLAN] || PLANS.free;   // 沒設定或寫錯，一律當免費方案（安全的那一邊）

export class BudgetExceeded extends Error {}
// 嚴格模式的違規紀錄（模組層級）：waitUntil 裡的錯誤會被吞掉，測試要靠這個陣列才看得到
export const strictViolations = [];

export class Budget {
  constructor(env, { kind = 'request', name = '', inherit = 0 } = {}) {
    this.plan = planOf(env); this.kind = kind; this.name = String(name).slice(0, 80);
    this.d1 = 0; this.rows = 0; this.kv = 0; this.fetch = 0; this.rpc = 0; this.cache = 0;
    // 每日用量估計（ops_daily）用的計數：D1 寫入的列數、KV／R2 各種操作、推播結果（不算額度，只記下來）
    this.wrote = 0; this.kvGet = 0; this.kvPut = 0; this.kvList = 0; this.kvDel = 0;
    this.pushSent = 0; this.pushErr = 0; this.pushGone = 0; this.pushDrop = 0;
    this.inherit = Math.max(0, Number(inherit) || 0);   // 呼叫自己時，父執行已經用掉的（保守算法：假設和父執行共用額度）
    this.sub = this.inherit; this.child = 0;
    this.stopped = []; this.over = false; this.t0 = Date.now();
    this.strict = env?.DEV_LOGIN === '1' && env?.BUDGET_STRICT === '1';
  }
  check() {
    if (this.sub <= this.plan.sub && this.d1 <= this.plan.d1) return;
    this.over = true;
    if (!this.strict) return;
    const v = { kind: this.kind, name: this.name, sub: this.sub, d1: this.d1, at: new Date().toISOString() };
    if (strictViolations.length < 200) strictViolations.push(v);
    throw new BudgetExceeded(`執行額度超過上限：${this.kind} ${this.name} sub=${this.sub} d1=${this.d1}`);
  }
  // D1 回報的讀取列數（meta.rows_read；只有 all／run／batch 有 meta，first 沒有）：不算額度，只記下來看哪支 API 讀得多
  read(res) {
    const sum = (k) => (Array.isArray(res) ? res.reduce((t, r) => t + (Number(r?.meta?.[k]) || 0), 0) : Number(res?.meta?.[k]) || 0);
    this.rows += sum('rows_read'); this.wrote += sum('rows_written');
    return res;
  }
  // 推播佇列送出一段的結果（drainPush 的 out）
  pushed(r) { if (!r) return; this.pushSent += r.sent || 0; this.pushErr += r.err || 0; this.pushGone += r.gone || 0; this.pushDrop += r.dropped || 0; }
  // type：d1 | kv | fetch | rpc | cache，全部都加到 sub
  take(type, n = 1) { this[type] += n; this.sub += n; this.check(); }
  // 子執行（呼叫自己）回報的用量：父執行保守地加回自己的預算
  absorb(n) { const k = Math.max(0, Number(n) || 0); this.child += k; this.sub += k; this.check(); }
  room(n = 1) { return this.sub + n <= this.plan.soft; }
  left() { return this.plan.soft - this.sub; }
  stop(reason) { if (this.stopped.length < 20) this.stopped.push(String(reason).slice(0, 60)); }
  summary() {
    return { kind: this.kind, name: this.name, d1: this.d1, rows: this.rows, kv: this.kv, fetch: this.fetch, rpc: this.rpc, cache: this.cache, child: this.child, inherit: this.inherit,
      sub: this.sub, stopped: this.stopped.join(',') || null, over: this.over, ms: Date.now() - this.t0 };
  }
}

// 一次執行結束時：用量偏高、因額度停下、或超過計數，才寫一行 log（Workers Logs 已開啟）
export function logBudget(b) {
  if (!b || !(b.sub >= 30 || b.stopped.length || b.over)) return;
  console.log(JSON.stringify({ t: 'budget', ...b.summary() }));
}

// ---- 綁定包裝：每次呼叫先記一筆 ----
const RAW = Symbol('raw');
function wrapStmt(st, b) {
  return {
    [RAW]: st,
    bind: (...a) => wrapStmt(st.bind(...a), b),
    first: async (...a) => { b.take('d1'); return st.first(...a); },
    all: async () => { b.take('d1'); return b.read(await st.all()); },
    run: async () => { b.take('d1'); return b.read(await st.run()); },
    raw: async (...a) => { b.take('d1'); return st.raw(...a); },
  };
}
function wrapD1(db, b) {
  return {
    prepare: (sql) => wrapStmt(db.prepare(sql), b),
    // batch 裡每一句分開算（文件的算法）；交給真正的 batch 前把包裝拆回原本的 D1PreparedStatement
    batch: async (list) => { b.take('d1', list.length); return b.read(await db.batch(list.map((s) => s?.[RAW] || s))); },
    exec: async () => { throw new Error('DB.exec 沒有計入執行額度，請改用 prepare'); },
  };
}
// KV（BACKUP_KV）與 R2（BACKUP）：get、put、list、delete 各算 1 個子請求
//   每日用量估計另外依操作分開記（讀取、寫入、列出、刪除各有自己的每日額度）
const STORE_OP = { get: 'kvGet', getWithMetadata: 'kvGet', head: 'kvGet', put: 'kvPut', list: 'kvList', delete: 'kvDel' };
function wrapStore(s, b) {
  const w = (k) => async (...a) => { b.take('kv'); b[STORE_OP[k]]++; return s[k](...a); };
  return { get: w('get'), put: w('put'), list: w('list'), delete: w('delete'), getWithMetadata: w('getWithMetadata'), head: w('head') };
}

// Cache API（caches.default）：官方限制頁寫 put()、match()、delete() 和子請求共用同一份額度，所以各算 1 個（保守算法）
function wrapCache(c, b) {
  const w = (k) => async (...a) => { b.take('cache'); return c[k](...a); };
  return { match: w('match'), put: w('put'), delete: w('delete') };
}
// 沒有這次執行的 env（例如單元測試）時直接用 caches.default
export const cacheOf = (env) => env?.cache || globalThis.caches?.default || null;

// 對外 fetch：一律經過這裡（env.ASSETS.fetch 不算）
export const xfetch = (env, input, init) => {
  try { env?.budget?.take('fetch'); } catch (e) { return Promise.reject(e); }
  return fetch(input, init);
};

// 每次執行一個 env：用 Object.create 讓綁定與 secrets 透過原型鏈讀到，這次執行專用的欄位蓋在上面。
//   以前直接改共用的 env（env.ctx、env.defer），同一個 isolate 同時處理兩個請求時會互相覆蓋。
//   注意：不要用 { ...env } 複製（只會複製自己的欄位，綁定與 secrets 會不見）。
export function invocationEnv(env, ctx, budget) {
  const e = Object.create(env);
  const pending = [];
  e.budget = budget; e.ctx = ctx; e.pending = pending;
  e.defer = (p) => {
    const q = Promise.resolve(p).catch((err) => console.error('defer', err));
    pending.push(q);
    if (ctx?.waitUntil) ctx.waitUntil(q);
    return q;
  };
  if (env.DB) e.DB = wrapD1(env.DB, budget);
  if (env.BACKUP_KV) e.BACKUP_KV = wrapStore(env.BACKUP_KV, budget);
  if (env.BACKUP) e.BACKUP = wrapStore(env.BACKUP, budget);
  if (globalThis.caches?.default) e.cache = wrapCache(globalThis.caches.default, budget);
  e.http = (input, init) => xfetch(e, input, init);
  return e;
}
// 等這次執行排進 defer 的工作都結束（中途又排進來的也等）
export async function settled(e) {
  for (let n = -1; n !== e.pending.length;) { n = e.pending.length; await Promise.allSettled(e.pending.slice()); }
}

// ---- 每日用量估計（ops_daily，UTC 日）----
//   每次執行結束把用量加進這個 isolate 的累加器；寫 D1 的時機由 worker.js 的 finishBudget 決定（請求：距離上次寫入 10 分鐘以上；
//   排程：這個整點有工作跑才寫），一次 1 句、1 列寫入。寫失敗就留在累加器，下次再寫。
//   這是下限估計：isolate 被回收時最多掉 10 分鐘的計數；電腦上用 wrangler 直接寫 D1 的也不算
export const USAGE_COLS = ['req', 'd1_q', 'd1_read', 'd1_write', 'kv_read', 'kv_write', 'kv_list', 'kv_del', 'push_sent', 'push_err', 'push_gone', 'push_drop'];
export const usage = { days: new Map(), last: 0 };   // days：UTC 日 → { 欄位: 數字 }；last：這個 isolate 上次寫入的時間
export const USAGE_EVERY = 10 * 60e3;
export function addUsage(b, day = new Date().toISOString().slice(0, 10)) {
  const v = { req: b.kind === 'request' ? 1 : 0, d1_q: b.d1, d1_read: b.rows, d1_write: b.wrote, kv_read: b.kvGet, kv_write: b.kvPut, kv_list: b.kvList, kv_del: b.kvDel,
    push_sent: b.pushSent, push_err: b.pushErr, push_gone: b.pushGone, push_drop: b.pushDrop };
  const cur = usage.days.get(day) || Object.fromEntries(USAGE_COLS.map((k) => [k, 0]));
  for (const k of USAGE_COLS) cur[k] += Number(v[k]) || 0;
  usage.days.set(day, cur);
  while (usage.days.size > 3) usage.days.delete(usage.days.keys().next().value);   // 寫不出去的舊日子最多留 3 天
}
// 要寫哪一天（最舊的那一天先寫，換日之後前一天的尾巴不會被新的一天蓋掉）；沒有要寫的回 null
export function usageDue(now = Date.now(), force = false) {
  if (!usage.days.size) return null;
  const [day] = usage.days.keys();
  const today = new Date(now).toISOString().slice(0, 10);
  if (!force && day === today && now - usage.last < USAGE_EVERY) return null;
  return day;
}
export const USAGE_SQL = `INSERT INTO ops_daily (day, ${USAGE_COLS.join(', ')}, updated_at) VALUES (?1, ${USAGE_COLS.map((_, i) => `?${i + 2}`).join(', ')}, datetime('now'))
  ON CONFLICT(day) DO UPDATE SET ${USAGE_COLS.map((k) => `${k} = ${k} + excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`;
