// 還原備份：把 R2 上的加密備份解開，輸出 JSON 或可以匯入 D1 的 SQL
// 用法：
//   1. 下載備份：存在 KV 時 npx wrangler kv key get "daily/2026-10-04.bin" --binding BACKUP_KV --remote > backup.bin
//               存在 R2 時 npx wrangler r2 object get cil-run-backup/daily/2026-10-04.bin --file backup.bin --remote
//   2. 解密：node tools/restore-backup.mjs backup.bin            → backup.json（檢查內容用）
//            node tools/restore-backup.mjs backup.bin --sql      → backup.sql（INSERT OR REPLACE，可指定 --table 名稱只還原一張表）
//      金鑰預設讀 ~/.config/cil-run/backup-key（測試環境 --staging 讀 backup-key-staging），也可以用 BACKUP_KEY 環境變數
//   3. 匯入（先在測試環境試）：npx wrangler d1 execute cil-run-staging --env staging --remote --file backup.sql
// 金鑰跟 Cloudflare 上的 BACKUP_KEY 是同一把；請另外存一份在密碼管理器，不要放進 git 或貼到聊天裡
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { webcrypto as crypto } from 'node:crypto';
import { homedir } from 'node:os';

const [file, ...flags] = process.argv.slice(2);
const keyFile = `${homedir()}/.config/cil-run/backup-key${flags.includes('--staging') ? '-staging' : ''}`;
const KEY = process.env.BACKUP_KEY || (() => { try { return readFileSync(keyFile, 'utf8').trim(); } catch { return ''; } })();
if (!file || !KEY) { console.error(`用法：node tools/restore-backup.mjs <備份檔> [--sql] [--table 名稱] [--staging]（金鑰：${keyFile} 或 BACKUP_KEY）`); process.exit(1); }
const buf = readFileSync(file);
if (buf.subarray(0, 5).toString() !== 'CILB1') { console.error('這不是耕跑團的備份檔'); process.exit(1); }
const b64 = KEY.replace(/-/g, '+').replace(/_/g, '/');
const key = await crypto.subtle.importKey('raw', Buffer.from(b64, 'base64'), 'AES-GCM', false, ['decrypt']);
let plain;
try {
  plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(5, 17), additionalData: new TextEncoder().encode('cil-backup-v1') }, key, buf.subarray(17));
} catch { console.error('解密失敗：金鑰不對，或檔案損壞'); process.exit(1); }
const data = JSON.parse(gunzipSync(Buffer.from(plain)).toString('utf8'));
const only = flags.includes('--table') ? flags[flags.indexOf('--table') + 1] : null;
const counts = Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length]));
console.log(`備份時間 ${data.at}，${Object.keys(counts).length} 張表`, counts);
if (!flags.includes('--sql')) { writeFileSync(file.replace(/\.bin$/, '') + '.json', JSON.stringify(data, null, 1)); console.log('已輸出 JSON'); process.exit(0); }
const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const lines = ['PRAGMA defer_foreign_keys = true;'];
for (const [t, rows] of Object.entries(data.tables)) {
  if (only && t !== only) continue;
  for (const r of rows) { const cols = Object.keys(r); lines.push(`INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`); }
}
writeFileSync(file.replace(/\.bin$/, '') + '.sql', lines.join('\n'));
console.log(`已輸出 SQL：${lines.length - 1} 筆`);
