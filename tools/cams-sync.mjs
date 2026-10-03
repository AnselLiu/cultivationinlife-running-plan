// 附近即時影像：在電腦上同步 offline 來源（公路局）的鏡頭清單，產生要匯入 D1 的 SQL 檔
//   公路局清單約 1.7 MB、2300 多筆，解析與寫入超過 Workers 免費方案一次執行的 CPU（10 ms）與子請求（50 個），所以改在電腦上跑。
//   解析、白名單、臺灣座標範圍檢查與 SQL 都和 Worker 共用 src/cams.js（parseList、syncPlan），結果一樣。
// 用法：node tools/cams-sync.mjs thb [--staging] [--out .wrangler/cams-sync/cams-thb.sql] [--last-count N]
//   1. 用和 Worker 一樣的 UA 抓清單（4 MB 上限、同一台主機最多轉址一次）
//   2. 完整性檢查：筆數少於上次的 70% 就停下，不產生 SQL。上次的筆數讀 --last-count；
//      沒給就執行唯讀查詢 npx wrangler d1 execute <db> --remote --json --command "SELECT last_count FROM cam_sources WHERE source = 'thb'"
//   3. 產生 SQL 檔（UPSERT 每 150 筆一句、每句 100 KB 以內；停用消失的鏡頭；重設 down；更新來源狀態）
//   4. 印出匯入指令，但不自動執行（會寫正式站的 D1，每次由主持人執行或同意後才跑）
// 這支工具不讀任何 secret、不需要 .dev.vars，產生的 SQL 也不含個資
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sourceOf, parseList, syncPlan } from '../src/cams.js';

const UA = 'cil-run camera relay (+https://cil-run.anselliu7.workers.dev)';
const MAX_LIST = 4 * 1024 * 1024, MAX_STMT = 100 * 1024;
const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
// 參數（?1、?2…）換成 SQL 字串常值（單引號重複一次）
const render = (sql, params) => `${sql.replace(/\?(\d+)/g, (_, n) => lit(params[Number(n) - 1]))};`;

// 清單文字 → SQL 陳述式（每句都在 100 KB 以內；太大就把那一段再切小）
export function buildSql(source, text, { lastCount = null, chunk = 150 } = {}) {
  const rows = parseList(source, text);
  if (!rows.length) throw new Error('清單是空的');
  if (lastCount && rows.length < lastCount * 0.7) throw new Error(`筆數從 ${lastCount} 掉到 ${rows.length}，這次不更新`);
  // 每一句都帶條件（跟 tools/rest-sync.mjs 一樣，不靠產生 SQL 時讀到的狀態）：來源在管理後台關閉、或匯入前 last_count 變了而筆數掉到 70% 以下，就什麼都不寫
  const G = `EXISTS (SELECT 1 FROM cam_sources WHERE source = ?1 AND enabled = 1 AND (COALESCE(last_count, 0) = 0 OR ${rows.length} >= last_count * 0.7))`;
  const guard = (sql) => (sql.includes('FROM json_each(?2) WHERE true') ? sql.replace('FROM json_each(?2) WHERE true', `FROM json_each(?2) WHERE ${G}`) : `${sql} AND ${G}`);
  for (let size = chunk; size >= 10; size = Math.floor(size / 2)) {
    const stmts = syncPlan(source, rows, size).map(([sql, p]) => render(guard(sql), p));
    if (stmts.every((x) => Buffer.byteLength(x) < MAX_STMT)) return { rows, stmts };
  }
  throw new Error('單筆資料太大，產生不了 100 KB 以內的 SQL');
}

async function fetchList(url) {
  const sameHost = (a, b) => { const x = new URL(a), y = new URL(b); return x.protocol === 'https:' && x.host === y.host; };
  const get = (u) => fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'user-agent': UA, accept: 'application/xml, text/xml, application/json' } });
  let res = await get(url);
  const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  if (loc) {
    const next = new URL(loc, url).href;
    if (!sameHost(next, url)) throw new Error('來源轉址到別的主機');
    res = await get(next);
  }
  if (!res.ok) throw new Error(`來源回應 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_LIST) throw new Error('清單太大');
  return buf.toString('utf8');
}

function lastCountRemote(source, staging) {
  const args = ['wrangler', 'd1', 'execute', staging ? 'cil-run-staging' : 'cil-run', ...(staging ? ['--env', 'staging'] : []), '--remote', '--json',
    '--command', `SELECT last_count FROM cam_sources WHERE source = '${source}'`];
  const out = execFileSync('npx', args, { encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  return JSON.parse(out)?.[0]?.results?.[0]?.last_count ?? null;
}

async function main() {
  const [source, ...flags] = process.argv.slice(2);
  const opt = (k) => (flags.includes(k) ? flags[flags.indexOf(k) + 1] : null);
  const S = sourceOf(source);
  if (!S?.offline) { console.error('用法：node tools/cams-sync.mjs thb [--staging] [--out .wrangler/cams-sync/cams-thb.sql] [--last-count N]（只處理 offline 的來源）'); process.exit(1); }
  const staging = flags.includes('--staging'), out = opt('--out') || `.wrangler/cams-sync/cams-${source}.sql`;   // 預設放在 .wrangler（不進 git）
  // --last-count 打錯（不是正整數）就停下：NaN 或 0 會讓 70% 完整性檢查失效
  const lc = opt('--last-count');
  if (flags.includes('--last-count') && !/^[1-9]\d*$/.test(lc || '')) { console.error('--last-count 要是正整數（上次的鏡頭支數）'); process.exit(1); }
  const lastCount = lc != null ? Number(lc) : lastCountRemote(source, staging);
  console.log(`上次的筆數：${lastCount ?? '（沒有紀錄）'}`);
  const { rows, stmts } = buildSql(source, await fetchList(S.list), { lastCount });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${stmts.join('\n')}\n`);
  console.log(`${S.name}：${rows.length} 支鏡頭，${stmts.length} 句 SQL → ${out}`);
  console.log('確認沒問題之後，由主持人執行（會寫入 D1）：');
  console.log(staging ? `  npx wrangler d1 execute cil-run-staging --env staging --remote --file ${out}` : `  npx wrangler d1 execute cil-run --remote --file ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(`沒有產生 SQL：${e.message}`); process.exit(1); });
