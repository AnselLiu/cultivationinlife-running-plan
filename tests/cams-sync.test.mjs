// 公路局清單的離線同步工具（tools/cams-sync.mjs）：和 Worker 同一套解析與 SQL；每句 100 KB 以內；完整性檢查
//   tests/fixtures/thb-sample.xml 是公路局 opendataCCTVs.xml 的前 160 筆（影像來源：交通部公路局）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildSql } from '../tools/cams-sync.mjs';
import { parseList } from '../src/cams.js';

const xml = readFileSync(new URL('./fixtures/thb-sample.xml', import.meta.url), 'utf8');

test('離線同步：每句 100 KB 以內、筆數正確、SQL 在 SQLite 跑得起來', () => {
  const rows = parseList('thb', xml);
  assert.ok(rows.length >= 150 && rows.length <= 160, `${rows.length} 筆`);
  const { stmts } = buildSql('thb', xml, { lastCount: rows.length });
  assert.equal(stmts.length, Math.ceil(rows.length / 150) + 3);
  for (const s of stmts) assert.ok(Buffer.byteLength(s) < 100 * 1024);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE members (id TEXT PRIMARY KEY)');   // 0039 參照的表
  db.exec(readFileSync(new URL('../migrations/0039_cams.sql', import.meta.url), 'utf8'));
  db.exec("INSERT OR IGNORE INTO cam_sources (source, enabled) VALUES ('thb', 1)");
  db.exec(stmts.join('\n'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cams WHERE source = 'thb' AND enabled = 1").get().n, rows.length);
  assert.equal(db.prepare("SELECT last_count FROM cam_sources WHERE source = 'thb'").get().last_count, rows.length);
  // 再跑一次（內容沒變）：不重複、不停用
  db.exec(stmts.join('\n'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cams WHERE source = 'thb' AND enabled = 1").get().n, rows.length);
  // 名稱含單引號也照樣跑得起來（字串常值裡的單引號重複一次）
  const q = buildSql('thb', xml.replace('<SurveillanceDescription>', "<SurveillanceDescription>O'Neil "), {}).stmts;
  db.exec(q.join('\n'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cams WHERE name LIKE 'O''Neil%'").get().n, 1);
  // SQL 自帶條件：來源在管理後台關閉就什麼都不寫；匯入前 last_count 變大到筆數低於 70% 也不寫、不停用
  const before = db.prepare("SELECT COUNT(*) AS n FROM cams WHERE source = 'thb' AND enabled = 1").get().n;
  const fewer = buildSql('thb', xml, {}).stmts;
  db.exec("UPDATE cam_sources SET enabled = 0 WHERE source = 'thb'");
  db.exec("UPDATE cams SET name = 'x', hash = 'stale' WHERE source = 'thb'");
  db.exec(fewer.join('\n'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cams WHERE source = 'thb' AND name = 'x'").get().n, before, '關閉時不寫');
  db.exec("UPDATE cam_sources SET enabled = 1, last_count = 10000 WHERE source = 'thb'");
  db.exec(fewer.join('\n'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cams WHERE source = 'thb' AND enabled = 1").get().n, before, '筆數驟減時不停用');
  assert.equal(db.prepare("SELECT last_count FROM cam_sources WHERE source = 'thb'").get().last_count, 10000, '來源狀態不變');
});

test('離線同步：筆數少於上次的 70% 就不產生 SQL', () => {
  assert.throws(() => buildSql('thb', xml, { lastCount: 1000 }), /掉到/);
  assert.throws(() => buildSql('thb', '<CCTVList></CCTVList>', {}), /清單是空的/);
});
