// 跑者休息站：在電腦上同步大型或多檔的來源（Workers 免費方案每次執行只有 10 ms CPU，這些來源在 Worker 解析不完）
//   流程：在這台電腦用 src/rest.js 同一套解析程式抓來源 → 產生 SQL 檔 → 用 wrangler 寫進 D1（不經過 Worker）
//   SQL 自己帶完整性檢查，不用先讀資料庫：
//     來源在管理後台關閉 → 什麼都不寫；內容跟上次一樣 → 只記同步時間；筆數掉到上次的 70% 以下 → 不寫、不停用，記錯誤
//     其他情況 → 只寫有變的列（雜湊比對）、停用清單不再出現的列、版本（rev）加 1；幹部的修正、補充說明、隱藏都不動
//   每個 SQL 指令不超過 D1 的 100 KB 上限；整份檔案在 D1 裡依序執行
//   用法：
//     node tools/rest-sync.mjs                       全部在電腦上同步的來源（twd tpt cpct sav tbk），SQL 寫到 .wrangler/rest-sync/
//     node tools/rest-sync.mjs twd tpt                只同步這幾個
//     node tools/rest-sync.mjs --apply=remote         產生後直接寫進正式站（wrangler 要先登入）；--env=staging 寫進測試站
//     node tools/rest-sync.mjs --apply=local [--persist-to=.wrangler/state]   寫進本機開發用的資料庫
//     node tools/rest-sync.mjs --mock                 用測試假資料（不連外），檢查產生的 SQL
//   建議頻率：直飲臺每週（暫停的直飲臺才會盡快消失），其他每月一次；管理後台的「休息站資料來源」看得到上次同步的時間
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SOURCES, UPSERT, DISABLE, collect, collectAll } from '../src/rest.js';

const MAX_STMT = 90000;   // D1 單一 SQL 指令上限 100 KB，留一點空間給指令本身
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

// 一個來源的 SQL 指令（陣列，依序執行）
export function buildSql(k, { rows, tag, date }) {
  if (!SOURCES[k] || SOURCES[k].manual) throw new Error(`沒有這個來源：${k}`);
  if (!rows.length) throw new Error(`${k}：清單是空的，不產生 SQL`);
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
  return out;
}

async function main() {
  const args = process.argv.slice(2), opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v = '1'] = a.slice(2).split('='); return [k, v]; }));
  const all = localSources(), want = args.filter((a) => !a.startsWith('--'));
  const bad = want.filter((k) => !SOURCES[k] || SOURCES[k].manual);
  if (bad.length) { console.error(`沒有這些來源：${bad.join('、')}（可以同步的：${Object.keys(SOURCES).filter((k) => !SOURCES[k].manual).join(' ')}）`); process.exit(2); }
  const list = want.length ? want : all;
  const env = opt.mock ? { REST_MOCK: '1', DEV_LOGIN: '1' } : {};
  const sql = [`-- 跑者休息站同步（tools/rest-sync.mjs），${new Date().toISOString()}${opt.mock ? '，測試假資料' : ''}`];
  let failed = 0;
  for (const [i, k] of list.entries()) {
    if (i && !opt.mock) await new Promise((r) => setTimeout(r, 1000));   // 來源之間停一下，不要連續猛抓
    const t0 = Date.now();
    try {
      const g = await gather(env, k);
      sql.push(...buildSql(k, g));
      console.log(`${k.padEnd(5)} ${SOURCES[k].name}：${g.rows.length} 處${g.dropped ? `（丟掉 ${g.dropped} 筆）` : ''}${g.date ? `・資料日期 ${g.date}` : ''}・${Date.now() - t0} ms`);
    } catch (e) { failed++; console.error(`${k.padEnd(5)} ${SOURCES[k].name}：失敗，${e?.message || e}（這個來源這次不寫入）`); }
  }
  if (sql.length === 1) { console.error('沒有任何來源成功，不產生 SQL'); process.exit(1); }
  const dir = opt.out || '.wrangler/rest-sync';
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/rest-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}.sql`;
  writeFileSync(file, `${sql.join('\n')}\n`);
  const db = opt.db || (opt.env === 'staging' ? 'cil-run-staging' : 'cil-run');
  const where = opt.apply === 'remote' ? ['--remote'] : opt.apply === 'local' ? ['--local', ...(opt['persist-to'] ? ['--persist-to', opt['persist-to']] : [])] : null;
  const cmd = ['wrangler', 'd1', 'execute', db, ...(where || ['--remote']), ...(opt.env ? ['--env', opt.env] : []), '--file', file];
  console.log(`\nSQL：${file}`);
  if (!where) { console.log(`檢查沒問題後，寫進資料庫：npx ${cmd.join(' ')}`); process.exit(failed ? 1 : 0); }
  execFileSync('npx', ['--yes', ...cmd], { stdio: 'inherit', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  console.log('已寫入。管理後台的「休息站資料來源」可以看到這次的時間與筆數；有錯誤（例如筆數掉太多）也會顯示在那裡。');
  process.exit(failed ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e?.message || e); process.exit(1); });
