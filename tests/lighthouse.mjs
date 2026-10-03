// 上線前品質檢查：用 Lighthouse 量主要畫面的效能、無障礙、最佳做法，低於門檻就失敗（CI 會擋下部署）
// 用法：npm run test:lh（需要 Chrome；GitHub Actions 的 ubuntu-latest 已內建）
// 測的是本機 wrangler dev（沒有 CDN 壓縮），效能分數會比正式站低一些，門檻已經考慮進去
import { spawn, execSync, execFileSync } from 'node:child_process';
import { rmSync, readFileSync, mkdirSync } from 'node:fs';

const PORT = 8797, STATE = '.wrangler/lh-state', OUT = '.wrangler/lighthouse';
const LIMITS = { performance: 0.8, accessibility: 0.95, 'best-practices': 0.95 };
const PAGES = [
  { name: '登入頁', path: '/', login: false },
  { name: '團練（首頁）', path: '/#/', login: true },
  { name: '課表', path: '/#/plan', login: true },
  { name: '我的', path: '/#/me', login: true },
  { name: '活動詳情', path: '/#/past', login: true },
];

const sh = (cmd) => execSync(cmd, { stdio: 'inherit' });
rmSync(STATE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
sh(`npx wrangler d1 migrations apply cil-run --local --persist-to ${STATE}`);
sh(`npx wrangler d1 execute cil-run --local --persist-to ${STATE} --file tests/seed.sql`);
const vars = { DEV_LOGIN: '1', JOIN_CODE: 'test-join', HASH_SALT: 'test-salt', AUDIT_KEY: 'test-audit-key', RACE_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' };
const dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--inspector-port', '0', '--persist-to', STATE, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
  { stdio: ['ignore', 'ignore', 'inherit'], detached: process.platform !== 'win32' });
const stop = () => { try { process.kill(-dev.pid); } catch { try { dev.kill(); } catch {} } };
process.on('exit', stop);

const base = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/me`)).ok) break; } catch {}
  if (i > 120) { console.error('伺服器沒有起來'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
// 測試帳號的登入 cookie（只存在這個暫時的測試資料庫）
const cookie = (await fetch(`${base}/api/dev/login?id=t_runner`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];

let failed = 0;
const rows = [];
for (const p of PAGES) {
  const file = `${OUT}/${p.name}.json`;
  const args = ['-y', 'lighthouse@12', base + p.path, '--quiet', '--output=json', `--output-path=${file}`, '--form-factor=mobile',
    '--only-categories=performance,accessibility,best-practices', '--chrome-flags=--headless=new --no-sandbox'];
  if (p.login) args.push(`--extra-headers=${JSON.stringify({ Cookie: cookie })}`);
  try { execFileSync('npx', args, { stdio: ['ignore', 'ignore', 'inherit'] }); } catch { console.error(`${p.name}：Lighthouse 執行失敗`); failed++; continue; }
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const score = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, r.categories[k]?.score ?? 0]));
  const bad = Object.entries(LIMITS).filter(([k, min]) => score[k] < min);
  if (bad.length) {
    failed++;
    // 列出拖分數的項目，方便直接修
    for (const [k] of bad) for (const ref of r.categories[k].auditRefs) {
      const a = r.audits[ref.id];
      if (ref.weight > 0 && a.score != null && a.score < 0.9) console.error(`  ${p.name}｜${k}｜${a.title}${a.displayValue ? `（${a.displayValue}）` : ''}`);
    }
  }
  rows.push({ 頁面: p.name, 效能: Math.round(score.performance * 100), 無障礙: Math.round(score.accessibility * 100), 最佳做法: Math.round(score['best-practices'] * 100),
    LCP: r.audits['largest-contentful-paint']?.displayValue, CLS: r.audits['cumulative-layout-shift']?.displayValue, 結果: bad.length ? '未達標' : '通過' });
}
console.table(rows);
console.log(`門檻：效能 ${LIMITS.performance * 100}、無障礙 ${LIMITS.accessibility * 100}、最佳做法 ${LIMITS['best-practices'] * 100}`);
stop();
process.exit(failed ? 1 : 0);
