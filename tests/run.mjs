// 測試流程：用獨立的本機資料庫（.wrangler/test-state）啟動 wrangler dev，灌測試帳號，跑全部測試，最後關掉
// 用法：npm run test:ci（本機或 GitHub Actions 都一樣）
import { spawn, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = Number(process.env.TEST_PORT) || 8799, STATE = '.wrangler/test-state';
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
rmSync(STATE, { recursive: true, force: true });
sh(`npx wrangler d1 migrations apply cil-run --local --persist-to ${STATE}`);
sh(`npx wrangler d1 execute cil-run --local --persist-to ${STATE} --file tests/seed.sql`);

// PLAN＝free、BUDGET_STRICT＝1：每次執行超過免費方案的 50 個子請求就丟錯並記下（/api/dev/budget-violations）
const vars = { DEV_LOGIN: '1', POST_MOCK: '1', CAM_MOCK: '1', PLAN: 'free', BUDGET_STRICT: '1', JOB_DISPATCH: 'inline', JOIN_CODE: 'test-join', CHAIR_CODE: 'test-chair', HASH_SALT: 'test-salt', AUDIT_KEY: 'test-audit-key',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-google-secret',
  RACE_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', BACKUP_KEY: 'HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4' };
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
const t = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/hours.test.mjs', 'tests/sql-limits.test.mjs', 'tests/signup-window.test.mjs', 'tests/api.test.mjs', 'tests/passkey.test.mjs', 'tests/budget.test.mjs'], { stdio: 'inherit', env: { ...process.env, BASE: base } });
t.on('exit', (code) => { stop(); process.exit(code ?? 1); });
