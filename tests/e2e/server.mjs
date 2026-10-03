// 端到端測試用的伺服器：獨立的本機資料庫（.wrangler/e2e-state），灌測試帳號後啟動 wrangler dev（port 8796）
import { spawn, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
const STATE = '.wrangler/e2e-state';
rmSync(STATE, { recursive: true, force: true });
execSync(`npx wrangler d1 migrations apply cil-run --local --persist-to ${STATE}`, { stdio: 'ignore' });
execSync(`npx wrangler d1 execute cil-run --local --persist-to ${STATE} --file tests/seed.sql`, { stdio: 'ignore' });
const vars = { DEV_LOGIN: '1', JOIN_CODE: 'test-join', HASH_SALT: 'test-salt', AUDIT_KEY: 'test-audit-key',
  RACE_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', BACKUP_KEY: 'HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4' };
const dev = spawn('npx', ['wrangler', 'dev', '--port', '8796', '--inspector-port', '0', '--persist-to', STATE, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { stdio: 'inherit' });
const stop = () => { try { dev.kill(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
