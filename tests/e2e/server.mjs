// 端到端測試用的伺服器：獨立的本機資料庫（.wrangler/e2e-state），灌測試帳號後啟動 wrangler dev
//   node tests/e2e/server.mjs [port] [https]：Safari（WebKit）連 localhost 也會把資源升級成 https，所以 Safari 測試用 https 版
import { spawn, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
const PORT = process.argv[2] || '8796', HTTPS = process.argv[3] === 'https';
// 不要互動式確認、不送使用統計（不然 migration 會停在那邊等）
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
const STATE = PORT === '8796' ? '.wrangler/e2e-state' : `.wrangler/e2e-state-${PORT}`;
rmSync(STATE, { recursive: true, force: true });
execSync(`npx wrangler d1 migrations apply cil-run --local --persist-to ${STATE}`, { stdio: ['ignore', 'ignore', 'inherit'], env });
execSync(`npx wrangler d1 execute cil-run --local --persist-to ${STATE} --file tests/seed.sql`, { stdio: ['ignore', 'ignore', 'inherit'], env });
const vars = { DEV_LOGIN: '1', POST_MOCK: '1', CAM_MOCK: '1', REST_MOCK: '1', JOIN_CODE: 'test-join', HASH_SALT: 'test-salt', AUDIT_KEY: 'test-audit-key',
  RACE_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', BACKUP_KEY: 'HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4' };
const dev = spawn('npx', ['wrangler', 'dev', '--port', PORT, ...(HTTPS ? ['--local-protocol', 'https'] : []), '--inspector-port', '0', '--persist-to', STATE, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { stdio: 'inherit' });
const stop = () => { try { dev.kill(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
