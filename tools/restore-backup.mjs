// 還原備份：把 KV（或 R2）上的加密備份解開，輸出 JSON 或可以匯入 D1 的 SQL
// 用法：
//   1. 下載備份（檔名用備份的日期，例如 2026-10-04.bin）：
//        存在 KV 時 npx wrangler kv key get "daily/2026-10-04.bin" --binding BACKUP_KV --remote > 2026-10-04.bin
//        存在 R2 時 npx wrangler r2 object get cil-run-backup/daily/2026-10-04.bin --file 2026-10-04.bin --remote
//      新格式（CILB2）的 daily/<日期>.bin 只是目錄（manifest），資料分成好幾段存在 part/<日期>/0000.bin、0001.bin…；
//      工具會列出要下載的指令，加 --fetch 就由工具自己用 wrangler 下載（唯讀，存在同一個資料夾，檔名 <日期>-part-0000.bin）
//   2. 解密：node tools/restore-backup.mjs 2026-10-04.bin            → 2026-10-04.json（檢查內容用）
//            node tools/restore-backup.mjs 2026-10-04.bin --sql      → 2026-10-04.sql（INSERT OR REPLACE，可指定 --table 名稱只還原一張表）
//      金鑰預設讀 ~/.config/cil-run/backup-key（測試環境 --staging 讀 backup-key-staging），也可以用 BACKUP_KEY 環境變數；
//      檔名不是日期時用 --label 2026-10-04 指定（AAD 綁住日期與第幾段，對不上就解不開）
//   3. 匯入（先在測試環境試）：npx wrangler d1 execute cil-run-staging --env staging --remote --file 2026-10-04.sql
// 還原後：
//   - 附近即時影像：水利署、水利處在管理後台「立即同步」一次；公路局的清單要在電腦上執行 node tools/cams-sync.mjs thb，
//     再照工具印出的 wrangler d1 execute 指令匯入（備份只有幹部手動新增的鏡頭連結）
//   - 跑者休息站：備份只有幹部整理清單、幹部新增，與幹部修正、隱藏或寫了補充說明的列（官方開放資料可以重抓）；
//     匯入的 SQL 會清掉各來源的版本標記，匯入後在電腦上執行 node tools/rest-sync.mjs --apply --env production，
//     再到管理後台「休息站資料來源」對 Worker 同步的來源按「立即同步」（或等排程的 01、02、06 點）
//   - 不在備份裡的：遙測（client_metrics、client_errors）、通知中心（notifications，還原後從空的開始）、推播佇列、執行額度紀錄
//   - 資料多時備份分好幾個整點做，每張表是各自讀取時的狀態，不是同一時間點的快照；
//     要還原到某個時間點（例如誤刪）請優先用 D1 Time Travel（免費方案 7 天）：npx wrangler d1 time-travel restore cil-run --timestamp …
// 金鑰跟 Cloudflare 上的 BACKUP_KEY 是同一把；請另外存一份在密碼管理器，不要放進 git 或貼到聊天裡
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { webcrypto as crypto } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [file, ...flags] = process.argv.slice(2);
const opt = (k) => (flags.includes(k) ? flags[flags.indexOf(k) + 1] : null);
const staging = flags.includes('--staging');
const keyFile = `${homedir()}/.config/cil-run/backup-key${staging ? '-staging' : ''}`;
const KEY = process.env.BACKUP_KEY || (() => { try { return readFileSync(keyFile, 'utf8').trim(); } catch { return ''; } })();
if (!file || !KEY) { console.error(`用法：node tools/restore-backup.mjs <備份檔> [--sql] [--table 名稱] [--label 日期] [--fetch] [--r2] [--staging]（金鑰：${keyFile} 或 BACKUP_KEY）`); process.exit(1); }
const key = await crypto.subtle.importKey('raw', Buffer.from(KEY.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), 'AES-GCM', false, ['decrypt']);
async function open(buf, aad) {
  const magic = buf.subarray(0, 5).toString();
  if (magic !== 'CILB1' && magic !== 'CILB2') throw new Error('這不是耕跑團的備份檔');
  const ad = new TextEncoder().encode(magic === 'CILB1' ? 'cil-backup-v1' : `cil-backup-v2|${aad}`);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(5, 17), additionalData: ad }, key, buf.subarray(17)); } catch { throw new Error('解密失敗：金鑰不對、日期（--label）不對，或檔案損壞'); }
  return JSON.parse(gunzipSync(Buffer.from(plain)).toString('utf8'));
}

let data;
try {
  const label = opt('--label') || basename(file).replace(/\.bin$/, '');
  const head = await open(readFileSync(file), `${label}|manifest`);
  if (head.version === 2) {
    // 新格式：manifest＋分段；每一段的 AAD 綁住日期與第幾段，順序或日期不對就解不開
    const dir = dirname(file), partFile = (n) => join(dir, `${label}-part-${String(n).padStart(4, '0')}.bin`);
    const remote = (n) => `part/${label}/${String(n).padStart(4, '0')}.bin`;
    const missing = Array.from({ length: head.parts }, (_, n) => n).filter((n) => !existsSync(partFile(n)));
    // 備份存在 R2（綁了 BACKUP）時加 --r2，從 cil-run-backup 下載；預設從 KV（BACKUP_KV）
    const r2 = flags.includes('--r2');
    if (missing.length && flags.includes('--fetch')) {
      const wenv = { env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 64 * 1024 * 1024 };
      for (const n of missing) {
        if (r2) { execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `cil-run-backup/${remote(n)}`, '--file', partFile(n), '--remote', ...(staging ? ['--env', 'staging'] : [])], wenv); continue; }
        const out = execFileSync('npx', ['wrangler', 'kv', 'key', 'get', remote(n), '--binding', 'BACKUP_KV', '--remote', ...(staging ? ['--env', 'staging'] : [])], wenv);
        writeFileSync(partFile(n), out);
      }
    } else if (missing.length) {
      console.error(`還少 ${missing.length} 段，請先下載（或加 --fetch 讓工具下載）：`);
      for (const n of missing) console.error(r2 ? `  npx wrangler r2 object get cil-run-backup/${remote(n)} --file ${partFile(n)} --remote${staging ? ' --env staging' : ''}`
        : `  npx wrangler kv key get "${remote(n)}" --binding BACKUP_KV --remote${staging ? ' --env staging' : ''} > ${partFile(n)}`);
      process.exit(1);
    }
    data = { format: 'cil-backup', version: 2, at: head.at, done_at: head.done_at, tables: Object.fromEntries(Object.keys(head.tables).map((t) => [t, []])) };
    for (let n = 0; n < head.parts; n++) {
      const p = await open(readFileSync(partFile(n)), `${label}|${n}`);
      if (p.label !== label || p.n !== n) throw new Error(`第 ${n} 段對不上`);
      for (const [t, rows] of p.tables) for (const { _rid, ...r } of rows) (data.tables[t] ||= []).push(r);   // _rid 是分段用的 rowid，不寫回
    }
    for (const [t, n] of Object.entries(head.tables)) if ((data.tables[t] || []).length !== n) throw new Error(`${t} 的筆數對不上：目錄 ${n}、實際 ${(data.tables[t] || []).length}`);
  } else data = head;
} catch (e) { console.error(e.message); process.exit(1); }

const only = opt('--table');
const counts = Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length]));
console.log(`備份時間 ${data.at}${data.done_at ? `（做完 ${data.done_at}）` : ''}，${Object.keys(counts).length} 張表`, counts);
const out = join(dirname(file), basename(file).replace(/\.bin$/, ''));
if (!flags.includes('--sql')) { writeFileSync(`${out}.json`, JSON.stringify(data, null, 1)); console.log('已輸出 JSON'); process.exit(0); }
const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const lines = ['PRAGMA defer_foreign_keys = true;'];
for (const [t, rows] of Object.entries(data.tables)) {
  if (only && t !== only) continue;
  for (const r of rows) { const cols = Object.keys(r); lines.push(`INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`); }
}
// 跑者休息站：備份只有幹部整理、新增、修正、隱藏或補充說明過的列；把來源的版本標記清掉，下次同步（維護工具與排程）才會整份重寫官方資料
if (data.tables.rest_sources && (!only || only === 'rest_sources' || only === 'rest_stops')) lines.push('UPDATE rest_sources SET etag = NULL, cursor = NULL;');
writeFileSync(`${out}.sql`, lines.join('\n'));
console.log(`已輸出 SQL：${lines.length - 1} 筆`);
