// Service Worker 預先快取：public 裡每個 JS 模組（含用到才載入的）都要在 SHELL，不然離線打不開
//   （合併分支時曾經整行換掉、漏了課表教練的三個模組）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('public 的 JS 模組都在 Service Worker 的 SHELL', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const shell = new Set([...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const mods = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.js') && f !== 'sw.js');
  assert.deepEqual(mods.filter((f) => !shell.has(`/${f}`)), []);
});

test('推播摘要：點摘要（nr）不標成已讀；快取版本換新', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  // 版本號只要比推播摘要上線前（cil-v63）新就好，不寫死，之後升版本不用改測試
  assert.ok(Number(sw.match(/const CACHE = 'cil-v(\d+)';/)?.[1]) > 63, '快取版本要換新');
  assert.match(sw, /data: \{[^}]*nr: !!d\.nr/, 'push 事件把 nr 帶進通知的 data');
  assert.match(sw, /if \(id && !nr\) await fetch\('\/api\/notifications\/read'/, 'nr 時不呼叫已讀');
});

test('分享連結 /e/:id 的頁面導覽用存好的首頁回應（不會每個活動各存一份）', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /e\.request\.mode === 'navigate' && url\.pathname\.startsWith\('\/e\/'\)\) \{\s*e\.respondWith\(caches\.match\('\/'\)/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /location\.pathname\.match\(\/\^\\\/e\\\/\(\[\\w-\]\{1,32\}\)\\\/\?\$\/\)/, '前端開機時把 /e/:id 轉成 /#/e/:id');
});

test('恢復連結的代碼在網址的 # 後面（不送到伺服器、不進 Service Worker 的快取與 Workers Logs）：沒有 /r/ 路徑；錯誤回報與開啟速度的頁面不帶代碼', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.ok(!sw.includes("'/r/'"), 'Service Worker 不用特別處理恢復連結');
  const wr = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(wr, /"run_worker_first": \["\/api\/\*", "\/e\/\*"\]/, '恢復連結不經過 Worker');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /location\.hash\.match\(\/\^#\\\/recover\\\/\(\[\^\?\]\*\)\/\)/, '代碼從 #/recover/<代碼> 拿');
  assert.match(app, /page: recPage\(location\.hash\.split\('\?'\)\[0\]\)/, '錯誤回報的頁面拿掉代碼');
  assert.match(app, /vitals\.page = recPage\(hash\)/, '開啟速度的頁面拿掉代碼');
  // recPage 的行為（照 app.js 的寫法）
  const recPage = new Function(`return ${app.match(/const recPage = (\(h\) => [^\n]+);/)[1]}`)();
  assert.equal(recPage(`#/recover/${'A'.repeat(43)}`), '#/recover/…');
  assert.equal(recPage('/recover/abc?err=x'), '/recover/…?err=x');
  assert.equal(recPage('#/recover?err=x'), '#/recover?err=x');
  assert.equal(recPage('#/me/security'), '#/me/security');
});
