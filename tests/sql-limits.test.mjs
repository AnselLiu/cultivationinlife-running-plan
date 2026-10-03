// D1 的 SQL 限制：本機 SQLite 沒有這些限制，測試會過、到正式站才失敗（0036 曾因此整個遷移失敗）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const files = (dir, ext) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);

test('LIKE／GLOB 樣式不超過 D1 上限 50 位元組', () => {
  const bad = [];
  for (const f of [...files('migrations', '.sql'), ...files('src', '.js')]) {
    const s = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const m of s.matchAll(/\b(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi)) if (Buffer.byteLength(m[1]) > 50) bad.push(`${f}：${m[0].slice(0, 60)}`);
  }
  assert.deepEqual(bad, []);
});
