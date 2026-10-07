// 測試流程：用獨立的本機資料庫（.wrangler/test-state）啟動 wrangler dev，灌測試帳號，跑全部測試，最後關掉
// 用法：npm run test:ci（本機或 GitHub Actions 都一樣）
import { spawn, spawnSync, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

// 先跑不需要伺服器的單元測試（課表引擎、課表教練計算、舊版資料搬移、共用裝置換人、還原備份重做刪除與隱私撤回、跑步記錄、Email 查詢碼、推薦人 SQL）；失敗就不用啟動伺服器
const UNIT = ['tests/plan.test.mjs', 'tests/coachcalc.test.mjs', 'tests/migrate.test.mjs', 'tests/device.test.mjs', 'tests/restore.test.mjs', 'tests/run-record.test.mjs', 'tests/email.test.mjs', 'tests/referral-sql.test.mjs'];
const unit = spawnSync(process.execPath, ['--test', ...UNIT], { stdio: 'inherit', env: { ...process.env, TZ: 'Asia/Taipei' } });
if (unit.status !== 0) process.exit(unit.status ?? 1);

const PORT = Number(process.env.TEST_PORT) || 8799, STATE = '.wrangler/test-state';
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
rmSync(STATE, { recursive: true, force: true });
sh(`npx wrangler d1 migrations apply cil-run --local --persist-to ${STATE}`);
sh(`npx wrangler d1 execute cil-run --local --persist-to ${STATE} --file tests/seed.sql`);

// PLAN＝free、BUDGET_STRICT＝1：每次執行超過免費方案的 50 個子請求就丟錯並記下（/api/dev/budget-violations）
// REST_MOCK＝1：休息站同步用固定的假資料，不連政府網站
const vars = { DEV_LOGIN: '1', POST_MOCK: '1', CAM_MOCK: '1', REST_MOCK: '1', PLAN: 'free', BUDGET_STRICT: '1', JOB_DISPATCH: 'inline', NTPC_MOCK: '1', JOIN_CODE: 'test-join', CHAIR_CODE: 'test-chair', HASH_SALT: 'test-salt', AUDIT_KEY: 'test-audit-key',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-google-secret',
  RACE_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', BACKUP_KEY: 'HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4' };
// 推播：PUSH_MOCK=1 不連外；VAPID 測試金鑰每次啟動用 WebCrypto 臨時產生，只存在記憶體
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
Object.assign(vars, { PUSH_MOCK: '1', VAPID_SUBJECT: 'mailto:test@example.com',
  VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url'),
  VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)) });
const dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--inspector-port', '0', '--persist-to', STATE, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
  { stdio: ['ignore', 'pipe', 'inherit'], detached: process.platform !== 'win32' });
let log = '';
dev.stdout.on('data', (d) => { log += d; });
const stop = () => { try { process.kill(-dev.pid); } catch { try { dev.kill(); } catch {} } };
process.on('exit', stop);

// 等伺服器起來（最多 60 秒）
const base = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/me`)).ok) break; } catch {}
  if (i > 120) { console.error(log); stop(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
const t = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/hours.test.mjs', 'tests/ics.test.mjs', 'tests/push.test.mjs', 'tests/cams-sync.test.mjs', 'tests/sql-limits.test.mjs', 'tests/rest-parse.test.mjs', 'tests/rest-sync.test.mjs', 'tests/signup-window.test.mjs', 'tests/sw-shell.test.mjs', 'tests/api.test.mjs', 'tests/passkey.test.mjs', 'tests/referral.test.mjs', 'tests/budget.test.mjs'], { stdio: 'inherit', env: { ...process.env, BASE: base } });
t.on('exit', (code) => { stop(); process.exit(code ?? 1); });
