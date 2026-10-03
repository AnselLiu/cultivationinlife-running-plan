// 跑者休息站：維護工具，在電腦上同步大型或多檔的來源（Workers 免費方案每次執行只有 10 ms CPU、50 個子請求，這些來源在 Worker 解析不完）
//   哪些來源只由這個工具同步：src/rest.js 的 SOURCES 標 local: true（量測數字寫在那裡）；Worker 的排程與「立即同步」都不跑它們
//   流程：在這台電腦用 src/rest.js 同一套解析程式抓來源 → 同一套清理（臺灣範圍、不收電話與姓名、開放時間要 parseHours 看得懂）
//     → 再檢查一次每一列（欄位白名單、座標、電話、開放時間）→ 產生 SQL 檔 → 檢查 D1 限制 →（--apply 時）用 wrangler 寫進 D1，不經過 Worker
//   SQL 自己帶完整性檢查，不用先讀資料庫：
//     來源在管理後台關閉 → 什麼都不寫；內容跟上次一樣 → 只記同步時間；筆數掉到上次的 70% 以下 → 不寫、不停用，記錯誤
//     其他情況 → 只寫有變的列（雜湊比對）、停用清單不再出現的列、版本（rev）加 1、記下筆數與資料日期；幹部的修正、補充說明、隱藏、幹部新增的列都不動
//   D1 限制：每個 SQL 指令不超過 100 KB（大量列自動分批）、LIKE／GLOB 樣式不超過 50 bytes；整份檔案在 D1 裡依序執行
//   不讀任何金鑰或密碼：只連公開的開放資料網址；寫進 D1 用 wrangler 自己的登入
//   用法（在專案根目錄）：
//     node tools/rest-sync.mjs                                   預設只試跑：抓全部只由維護工具同步的來源、產生 SQL、印出筆數，不寫資料庫
//     node tools/rest-sync.mjs twd tpt                           只處理這幾個來源
//     node tools/rest-sync.mjs --apply --env staging             產生後寫進測試站（cil-run-staging）
//     node tools/rest-sync.mjs --apply --env production          產生後寫進正式站（cil-run）；wrangler 要先登入（npx wrangler login）
//     node tools/rest-sync.mjs --apply=local [--persist-to=.wrangler/state]   寫進本機開發用的資料庫
//     node tools/rest-sync.mjs --mock                            用測試假資料（不連外），檢查產生的 SQL（只能試跑或配 --apply=local）
//     --out=目錄                                                 SQL 檔放的位置（預設 .wrangler/rest-sync/）
//   建議頻率：直飲臺每週（暫停的直飲臺才會盡快消失），其他每月一次；管理後台的「休息站資料來源」看得到上次同步的時間，太久沒同步會提醒
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SOURCES, UPSERT, DISABLE, ROW_KEYS, TYPES, collect, collectAll, inTaiwan, hasPhone, CELL_RE } from '../src/rest.js';
import { parseHours } from '../public/hours.js';

const MAX_STMT = 90000;   // D1 單一 SQL 指令上限 100 KB，留一點空間給指令本身
export const D1_STMT = 100000, D1_PATTERN = 50;   // D1：單一指令 100 KB、LIKE／GLOB 樣式 50 bytes
export const DBS = { staging: 'cil-run-staging', production: 'cil-run' };
export const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const bytes = (s) => Buffer.byteLength(s, 'utf8');
// ?1、?2…一次換完（換進去的 JSON 裡就算有「?3」也不會再被換）
const sub = (sql, map) => sql.replace(/\?(\d)\b/g, (m, d) => (Object.hasOwn(map, d) ? map[d] : m));
export const localSources = () => Object.entries(SOURCES).filter(([, S]) => S.local).map(([k]) => k);

// 抓＋解析一個來源（不碰資料庫）：回 { rows, tag, date, dropped }；tag 是解析後各列雜湊的摘要（來源每天換匯入時間也不會被當成有變）
export async function gather(env, k) {
  const S = SOURCES[k];
  if (!S || S.manual) throw new Error(`沒有這個來源：${k}`);
  const g = S.pages ? await collectAll(env, k, { gap: env.REST_MOCK === '1' ? 0 : 1000 }) : await collect(env, k, null);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(g.rows.map((r) => `${r.id}:${r.h}`).sort().join('\n'))))]
    .slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { rows: g.rows, dropped: g.dropped || 0, date: g.date || null, tag: JSON.stringify({ h: digest, by: 'local' }) };
}

// 寫入前再檢查一次每一列（清理程式已經做過，這裡是第二道防線）：欄位白名單、臺灣範圍、格子、沒有電話、開放時間 parseHours 看得懂
export function checkRows(k, rows) {
  const keys = new Set(ROW_KEYS);
  for (const r of rows) {
    const extra = Object.keys(r).filter((x) => !keys.has(x));
    if (extra.length) throw new Error(`${k}：${r.id} 有不該存的欄位 ${extra.join('、')}`);
    if (!String(r.id).startsWith(`${k}:`) || !TYPES.includes(r.type)) throw new Error(`${k}：${r.id} 代碼或類型不對`);
    if (!inTaiwan(r.lat, r.lng) || !CELL_RE.test(r.cell)) throw new Error(`${k}：${r.id} 座標不在臺灣或格子不對`);
    if (['name', 'place', 'address', 'hours_raw'].some((f) => hasPhone(r[f]))) throw new Error(`${k}：${r.id} 文字裡有電話`);
    if (r.hours != null && !parseHours(r.hours)) throw new Error(`${k}：${r.id} 開放時間看不懂：${r.hours}`);
    if (r.ref_url != null && !/^https:\/\//.test(r.ref_url)) throw new Error(`${k}：${r.id} 外連不是 https`);
  }
  return rows;
}
// D1 限制：每個指令 100 KB 以內；LIKE／GLOB 的樣式字串 50 bytes 以內（正式站曾因 GLOB 太長整批還原，見 migration 0036）
export function checkSql(stmts) {
  for (const s of stmts) {
    if (s.startsWith('--')) continue;
    const b = bytes(s);
    if (b > D1_STMT) throw new Error(`SQL 指令 ${b} bytes，超過 D1 上限 ${D1_STMT}`);
    for (const m of s.matchAll(/\b(?:LIKE|GLOB)\s+'((?:[^']|'')*)'/gi)) {
      const p = m[1].replace(/''/g, "'");
      if (bytes(p) > D1_PATTERN) throw new Error(`LIKE／GLOB 樣式 ${bytes(p)} bytes，超過 D1 上限 ${D1_PATTERN}：${p.slice(0, 20)}…`);
    }
  }
  return stmts;
}

// 一個來源的 SQL 指令（陣列，依序執行）
export function buildSql(k, { rows, tag, date }) {
  if (!SOURCES[k] || SOURCES[k].manual) throw new Error(`沒有這個來源：${k}`);
  if (!rows.length) throw new Error(`${k}：清單是空的，不產生 SQL`);
  checkRows(k, rows);
  const n = rows.length, src = lit(k), etag = lit(tag);
  // 寫入條件：來源開著、內容跟上次不同、筆數沒有掉到上次的 70% 以下
  const G = `EXISTS (SELECT 1 FROM rest_sources WHERE source = ${src} AND enabled = 1 AND etag IS NOT ${etag} AND (COALESCE(last_count, 0) = 0 OR ${n} >= last_count * 0.7))`;
  const gen = `COALESCE((SELECT gen FROM rest_sources WHERE source = ${src}), 0)`;
  const tpl = UPSERT.replace(/FROM json_each\(\?2\) WHERE true\b/, 'FROM json_each(?2) WHERE ?4');
  if (tpl === UPSERT) throw new Error('UPSERT 的格式變了，請更新 tools/rest-sync.mjs');
  const head = (json) => sub(tpl, { 1: src, 2: lit(json), 3: gen, 4: G });
  const out = [`-- ${k}（${SOURCES[k].name}）：${n} 處`];
  // 依大小分批：每批的 JSON 加上指令本身不超過上限
  const base = bytes(head('[]'));
  let batch = [], size = 0;
  const flush = () => { if (batch.length) out.push(`${head(`[${batch.join(',')}]`)};`); batch = []; size = 0; };
  for (const r of rows) {
    const j = JSON.stringify(r), b = bytes(lit(j)) + 1;
    if (base + b > MAX_STMT) throw new Error(`${k}：${r.id} 這一列太大`);
    if (base + size + b > MAX_STMT) flush();
    batch.push(j); size += b;
  }
  flush();
  const ids = lit(JSON.stringify(rows.map((r) => r.id)));
  const dis = `${sub(DISABLE, { 1: src, 2: ids })} AND ${G};`;
  if (bytes(dis) > MAX_STMT) throw new Error(`${k}：代碼清單超過 D1 單一指令上限，要改成分批停用`);
  out.push(dis);
  // 版本加 1、記下筆數與摘要（要放在上面兩個之後：條件會讀到更新前的值）
  out.push(`UPDATE rest_sources SET rev = rev + 1, last_count = ${n}, etag = ${etag}, data_date = COALESCE(${lit(date)}, data_date), cursor = NULL,
  last_sync_at = datetime('now'), last_ok_at = datetime('now'), last_error = NULL WHERE source = ${src} AND ${G};`);
  // 內容跟上次一樣：只記同步時間
  out.push(`UPDATE rest_sources SET last_sync_at = datetime('now'), last_ok_at = datetime('now'), last_error = NULL WHERE source = ${src} AND enabled = 1 AND etag IS ${etag};`);
  // 筆數掉太多：不寫、不停用，記錯誤（管理後台看得到）
  out.push(`UPDATE rest_sources SET last_sync_at = datetime('now'), last_error = '筆數從 ' || last_count || ' 掉到 ${n}，這次不更新'
  WHERE source = ${src} AND enabled = 1 AND etag IS NOT ${etag} AND COALESCE(last_count, 0) > 0 AND ${n} < last_count * 0.7;`);
  return checkSql(out);
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
// 參數：--apply（要配 --env staging|production）、--apply=local、--env、--out、--persist-to、--db、--mock；其他是來源代碼
export function parseArgs(argv) {
  const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, v = '1'] = a.slice(2).split('='); return [k, v]; }));
  const want = argv.filter((a) => !a.startsWith('--'));
  let target = null;
  if (opt.apply === 'local') target = { local: true, db: opt.db || DBS.production };
  else if (opt.apply) {
    if (!Object.hasOwn(DBS, opt.env || '')) throw new Error('寫進資料庫要指定 --env staging 或 --env production');
    target = { local: false, env: opt.env, db: opt.db || DBS[opt.env] };
  }
  // 測試假資料只能試跑或寫進本機資料庫：第一次同步時（還沒有上次筆數）70% 檢查擋不住，假資料會整批寫進正式站
  if (opt.mock && target && !target.local) throw new Error('--mock 是測試假資料，只能試跑或配 --apply=local，不能寫進測試站或正式站');
  return { opt, want, target };
}
// wrangler 指令：正式站是設定檔的頂層（不帶 --env），測試站帶 --env staging
export function wranglerArgs(target, file, persist) {
  if (target.local) return ['wrangler', 'd1', 'execute', target.db, '--local', ...(persist ? ['--persist-to', persist] : []), '--file', file];
  return ['wrangler', 'd1', 'execute', target.db, '--remote', ...(target.env === 'staging' ? ['--env', 'staging'] : []), '--file', file];
}

async function main() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--env' && argv[i + 1] && !argv[i + 1].startsWith('--')) argv.splice(i, 2, `--env=${argv[i + 1]}`);
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); process.exit(2); }
  const { opt, want, target } = a;
  const all = localSources();
  const bad = want.filter((k) => !SOURCES[k] || SOURCES[k].manual);
  if (bad.length) { console.error(`沒有這些來源：${bad.join('、')}（可以同步的：${Object.keys(SOURCES).filter((k) => !SOURCES[k].manual).join(' ')}）`); process.exit(2); }
  const list = want.length ? want : all;
  const env = opt.mock ? { REST_MOCK: '1', DEV_LOGIN: '1' } : {};
  const sql = [`-- 跑者休息站同步（tools/rest-sync.mjs），${new Date().toISOString()}${opt.mock ? '，測試假資料' : ''}`];
  let failed = 0, total = 0, nStmt = 0, maxStmt = 0;
  console.log(`${target ? `產生 SQL 後寫進 ${target.local ? '本機資料庫' : target.env === 'staging' ? '測試站' : '正式站'}（${target.db}）` : '試跑：只產生 SQL、不寫資料庫'}；來源 ${list.join(' ')}\n`);
  for (const [i, k] of list.entries()) {
    if (i && !opt.mock) await new Promise((r) => setTimeout(r, 1000));   // 來源之間停一下，不要連續猛抓
    const t0 = Date.now();
    try {
      const g = await gather(env, k);
      const stmts = buildSql(k, g), body = stmts.filter((s) => !s.startsWith('--'));
      sql.push(...stmts);
      const types = Object.entries(g.rows.reduce((o, r) => ({ ...o, [r.type]: (o[r.type] || 0) + 1 }), {})).map(([t, n]) => `${t} ${n}`).join('、');
      const big = Math.max(...body.map(bytes));
      total += g.rows.length; nStmt += body.length; maxStmt = Math.max(maxStmt, big);
      console.log(`${k.padEnd(5)} ${SOURCES[k].name}：${g.rows.length} 處（${types}）${g.dropped ? `・丟掉 ${g.dropped} 筆` : ''}${g.date ? `・資料日期 ${g.date}` : ''}・SQL ${body.length} 個指令、最大 ${kb(big)}・${Date.now() - t0} ms`);
    } catch (e) { failed++; console.error(`${k.padEnd(5)} ${SOURCES[k].name}：失敗，${e?.message || e}（這個來源這次不寫入）`); }
  }
  if (sql.length === 1) { console.error('沒有任何來源成功，不產生 SQL'); process.exit(1); }
  const dir = opt.out || '.wrangler/rest-sync';
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/rest-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}.sql`;
  const text = `${sql.join('\n')}\n`;
  writeFileSync(file, text);
  console.log(`\n合計 ${total} 處、${nStmt} 個 SQL 指令（最大 ${kb(maxStmt)}，上限 ${kb(D1_STMT)}）、檔案 ${kb(bytes(text))}${failed ? `；${failed} 個來源失敗` : ''}`);
  console.log(`SQL：${file}`);
  if (!target) {
    console.log('檢查沒問題後寫進資料庫：node tools/rest-sync.mjs --apply --env staging（測試站）或 --apply --env production（正式站）');
    process.exit(failed ? 1 : 0);
  }
  const cmd = wranglerArgs(target, file, opt['persist-to']);
  console.log(`執行：npx ${cmd.join(' ')}`);
  execFileSync('npx', ['--yes', ...cmd], { stdio: 'inherit', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  console.log('已寫入。管理後台的「休息站資料來源」可以看到這次的時間與筆數；有錯誤（例如筆數掉太多）也會顯示在那裡。');
  process.exit(failed ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e?.message || e); process.exit(1); });
