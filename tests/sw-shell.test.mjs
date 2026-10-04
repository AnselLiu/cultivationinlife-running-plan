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
  assert.match(sw, /const CACHE = 'cil-v64';/);
  assert.match(sw, /data: \{[^}]*nr: !!d\.nr/, 'push 事件把 nr 帶進通知的 data');
  assert.match(sw, /if \(id && !nr\) await fetch\('\/api\/notifications\/read'/, 'nr 時不呼叫已讀');
});
