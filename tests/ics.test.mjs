// 行事曆折行與 base64：新版（算術算位元組）和舊版（每個字元 TextEncoder）輸出逐位元組相同
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, b64bytes } from '../src/ics.js';

const old = (line) => { const out = []; let cur = ''; for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 73) { out.push(cur); cur = ` ${ch}`; } else cur += ch; } out.push(cur); return out.join('\r\n'); };
const POOL = ['a', 'Z', ' ', ',', '\\n', 'é', 'ß', '中', '跑', '團', '（', '」', '😀', '🏃‍♀️', '\uD800', '\uDC00', 'ア', '€'];
let seed = 42;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

test('fold：隨機字串（中英混合、emoji、單獨的代理字元）和舊版相同', () => {
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let k = rnd(160); k > 0; k--) s += POOL[rnd(POOL.length)];
    assert.equal(fold(s), old(s), JSON.stringify(s));
  }
});

test('fold：實際的行事曆欄位', () => {
  const lines = ['BEGIN:VEVENT', 'SUMMARY:（已報名）週四團練 400 公尺間歇 × 10 組，配速依分組表', `DESCRIPTION:已報名\\n集合在河濱公園停車場旁，記得帶水${'與能量膠'.repeat(10)}\\nhttps://cil-run.example/#/e/abc123`, 'x'.repeat(200), ''];
  for (const l of lines) assert.equal(fold(l), old(l));
  for (const l of lines) for (const part of fold(l).split('\r\n')) assert.ok(new TextEncoder().encode(part).length <= 75);
});

test('b64bytes：和 Uint8Array.from(atob()) 相同', () => {
  const bytes = new Uint8Array(1000).map((_, i) => (i * 37 + 11) & 255);
  const b64 = btoa(String.fromCharCode(...bytes));
  assert.deepEqual(b64bytes(b64), Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
});
