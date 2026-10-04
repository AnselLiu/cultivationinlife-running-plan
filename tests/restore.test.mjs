// 還原備份：備份之後刪除的帳號，匯入後要重做刪除，不能跟著舊備份回來（tools/restore-sql.mjs、src/erase.js）
//   用 node:sqlite 跑全部 migrations 建一份跟 D1 一樣的資料庫，實際執行還原工具輸出的 SQL
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { toSql, erasedFrom, erasedQuery } from '../tools/restore-sql.mjs';

const dir = new URL('../migrations/', import.meta.url);
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
// 「備份當時」的資料：兩個會員，x1 之後刪除了帳號
function backupData() {
  const db = freshDb();
  db.exec(`INSERT INTO members (id, name, phone) VALUES ('x1', '要被刪的人', '0912000001'), ('x2', '留下的人', '0912000002');
    INSERT INTO member_private (member_id, enc) VALUES ('x1', 'cipher');
    INSERT INTO training_logs (id, member_id, date, km) VALUES ('l1', 'x1', '2026-10-01', 10), ('l2', 'x2', '2026-10-01', 5);
    INSERT INTO routes (id, name, points, distance, created_by) VALUES ('r1', '私人路線', '[]', 1000, 'x1');
    INSERT INTO events (id, kind, title, date, created_by) VALUES ('e1', 'track', '團練', '2026-10-10', 'x1');
    INSERT INTO prizes (id, event_id, name) VALUES ('p1', 'e1', '獎品');
    INSERT INTO draws (id, event_id, prize_id, name, member_id) VALUES ('d1', 'e1', 'p1', '要被刪的人', 'x1');`);
  const tables = {};
  for (const t of ['members', 'member_private', 'training_logs', 'routes', 'events', 'prizes', 'draws']) tables[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => ({ ...r }));
  return { format: 'cil-backup', version: 2, at: '2026-10-01T19:00:00.000Z', tables };
}
// wrangler d1 execute 把整份檔案當一個交易執行（defer_foreign_keys 到最後才檢查）
const restore = (opts) => { const db = freshDb(); db.exec(`BEGIN;\n${toSql(backupData(), opts).join('\n')}\nCOMMIT;`); return db; };
const one = (db, sql) => db.prepare(sql).get();

test('沒有重做刪除：被刪除的帳號會跟著舊備份回來（對照組）', () => {
  const db = restore({});
  assert.ok(one(db, "SELECT 1 AS x FROM members WHERE id = 'x1'"));
});

test('重做刪除：帳號、私人資料、訓練紀錄、路線都不在，得獎紀錄只匿名化，別人的資料不動', () => {
  const db = restore({ erased: ['x1'] });
  assert.equal(one(db, "SELECT 1 AS x FROM members WHERE id = 'x1'"), undefined);
  assert.equal(one(db, "SELECT 1 AS x FROM member_private WHERE member_id = 'x1'"), undefined);
  assert.equal(one(db, "SELECT 1 AS x FROM training_logs WHERE member_id = 'x1'"), undefined);
  assert.equal(one(db, "SELECT 1 AS x FROM routes WHERE created_by = 'x1'"), undefined);
  assert.deepEqual({ ...one(db, "SELECT name, member_id FROM draws WHERE id = 'd1'") }, { name: '已刪除帳號', member_id: null });
  assert.equal(one(db, "SELECT created_by FROM events WHERE id = 'e1'").created_by, null);
  assert.ok(one(db, "SELECT 1 AS x FROM members WHERE id = 'x2'"));
  assert.ok(one(db, "SELECT 1 AS x FROM training_logs WHERE member_id = 'x2'"));
});

test('刪除名單：讀得懂 wrangler --json、新備份的 audit_log、逗號分隔；看不懂的 id 擋下', () => {
  assert.deepEqual(erasedFrom(JSON.stringify([{ results: [{ target_id: 'x1' }, { target_id: 'x3' }], success: true }])), ['x1', 'x3']);
  const newer = { format: 'cil-backup', tables: { audit_log: [
    { action: 'privacy.delete', target_id: 'old', at: '2026-09-30 10:00:00' },
    { action: 'privacy.delete', target_id: 'x1', at: '2026-10-02 08:00:00' },
    { action: 'role.change', target_id: 'x2', at: '2026-10-02 08:00:00' }] } };
  assert.deepEqual(erasedFrom(JSON.stringify(newer), '2026-10-01T19:00:00.000Z'), ['x1'], '只取備份之後的刪除帳號');
  assert.deepEqual(erasedFrom('x1, x2\nx3'), ['x1', 'x2', 'x3']);
  assert.throws(() => erasedFrom("x1'); DROP TABLE members; --"));
  assert.throws(() => toSql({ tables: {} }, { erased: ["x'1"] }));
  assert.match(erasedQuery('2026-10-01T19:00:00.000Z'), /action IN \('privacy\.delete'\) AND at >= '2026-10-01 19:00:00'/);
});
