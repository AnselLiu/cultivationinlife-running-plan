// 還原備份：備份之後刪除的帳號與本人的撤回（刪除賽事報名資料、停止分享、退出排行榜、通知分類、推播、通行金鑰、登出所有裝置），
//   匯入後要重做，不能跟著舊備份回來（tools/restore-sql.mjs、src/erase.js）；D1 Time Travel 之後用同一份重做 SQL
//   用 node:sqlite 跑全部 migrations 建一份跟 D1 一樣的資料庫，實際執行還原工具輸出的 SQL
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { toSql, erasedFrom, erasedQuery, auditRowsFrom, replayQuery, replaySql, REPLAY_ACTIONS } from '../tools/restore-sql.mjs';

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

// ---- 撤回：x2 在備份之後停止分享、退出排行榜、刪除賽事報名資料、關掉通知分類、取消推播、移除通行金鑰；x3 登出所有裝置 ----
function backupWithPrivacy() {
  const db = freshDb();
  db.exec(`INSERT INTO members (id, name, share_logs, show_rank, notif_mute) VALUES ('x2', '撤回的人', 1, 1, NULL), ('x3', '換手機的人', 1, 1, NULL), ('x4', '沒動的人', 1, 1, 'event');
    INSERT INTO member_private (member_id, enc, complete) VALUES ('x2', 'cipher2', 1), ('x4', 'cipher4', 1);
    INSERT INTO events (id, kind, title, date) VALUES ('e2', 'race', '代報名賽事', '2026-11-01');
    INSERT INTO signups (id, event_id, member_id, name, grp, reg_consent_at) VALUES ('s2', 'e2', 'x2', '撤回的人', 'D', '2026-09-30 10:00:00'), ('s4', 'e2', 'x4', '沒動的人', 'D', '2026-09-30 10:00:00');
    INSERT INTO push_subs (endpoint, member_id, p256dh, auth) VALUES ('https://push.example/x2', 'x2', 'p', 'a'), ('https://push.example/x3', 'x3', 'p', 'a'), ('https://push.example/x4', 'x4', 'p', 'a');
    INSERT INTO passkeys (id, member_id, public_jwk) VALUES ('pkLostPhone0001', 'x2', '{}'), ('pkStillMine00002', 'x2', '{}'), ('pkOther000000003', 'x4', '{}');`);
  const tables = {};
  for (const t of ['members', 'member_private', 'events', 'signups', 'push_subs', 'passkeys']) tables[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => ({ ...r }));
  return { format: 'cil-backup', version: 2, at: '2026-10-01T19:00:00.000Z', tables };
}
const A = (id, at, action, target_id, detail = null, extra = {}) => ({ id, at, actor_id: target_id, actor_name: '某人', actor_role: 'member', action, target_type: 'member', target_id, detail, ip_hash: 'h', mac: `mac-${id}`, ...extra });
const WITHDRAWALS = [
  A('a0', '2026-09-30 08:00:00', 'privacy.show_rank', 'x4', '關閉'),                  // 備份之前：不重做
  A('a1', '2026-10-02 08:00:00', 'privacy.share_logs', 'x2', '關閉'),
  A('a2', '2026-10-02 08:00:00', 'privacy.show_rank', 'x2', '關閉'),
  A('a3', '2026-10-02 08:01:00', 'privacy.race_profile_delete', 'x2', null),
  A('a4', '2026-10-02 08:02:00', 'notif.prefs', 'x2', 'mute=event,training,security'), // security 不能關，略過
  A('a5', '2026-10-02 08:03:00', 'push.unsubscribe', 'x2', 'iPhone・Safari'),
  A('a6', '2026-10-02 08:04:00', 'passkey.remove', 'x2', 'id=pkLostPhone0001'),
  A('a7', '2026-10-02 09:00:00', 'session.revoke_all', 'x3', 'Android・Chrome'),
  A('a8', '2026-10-02 09:00:00', 'privacy.share_logs', 'x3', '關閉'),                  // 同一秒又開又關：以關閉為準
  A('a9', '2026-10-02 09:00:00', 'privacy.share_logs', 'x3', '開啟'),
  A('b1', '2026-10-02 10:00:00', 'privacy.show_rank', 'x3', '關閉'),                   // 關了又開：照最後一次（開啟）
  A('b2', '2026-10-02 11:00:00', 'privacy.show_rank', 'x3', '開啟'),
  A('b3', '2026-10-02 11:00:00', 'event.delete', 'x3', '不是撤回'),
];
const wranglerJson = (rows) => JSON.stringify([{ results: rows, success: true }]);

test('還原備份後重做撤回：分享、排行榜、賽事報名資料、通知分類、推播、通行金鑰；別人與備份之前的不動', () => {
  const data = backupWithPrivacy();
  const audit = auditRowsFrom(wranglerJson(WITHDRAWALS), data.at);
  assert.ok(!audit.some((r) => r.id === 'a0' || r.id === 'b3'), '備份之前的、不是撤回的不算');
  const db = freshDb();
  db.exec(`BEGIN;\n${toSql(data, { audit }).join('\n')}\nCOMMIT;`);
  const m = (id) => ({ ...one(db, `SELECT share_logs, show_rank, notif_mute FROM members WHERE id = '${id}'`) });
  assert.deepEqual(m('x2'), { share_logs: 0, show_rank: 0, notif_mute: 'event,training' });
  assert.deepEqual(m('x3'), { share_logs: 0, show_rank: 1, notif_mute: null }, '同一秒有關閉以關閉為準；排行榜最後是開啟');
  assert.deepEqual(m('x4'), { share_logs: 1, show_rank: 1, notif_mute: 'event' }, '沒撤回的人不動');
  assert.equal(one(db, "SELECT 1 AS x FROM member_private WHERE member_id = 'x2'"), undefined, '刪掉的賽事報名資料不會回來');
  assert.equal(one(db, "SELECT reg_consent_at FROM signups WHERE id = 's2'").reg_consent_at, null);
  assert.ok(one(db, "SELECT 1 AS x FROM member_private WHERE member_id = 'x4'"));
  assert.ok(one(db, "SELECT reg_consent_at FROM signups WHERE id = 's4'").reg_consent_at);
  assert.deepEqual(db.prepare('SELECT member_id FROM push_subs ORDER BY member_id').all().map((r) => r.member_id), ['x4'], '取消推播、登出所有裝置的訂閱不會回來');
  assert.deepEqual(db.prepare('SELECT id FROM passkeys ORDER BY id').all().map((r) => r.id), ['pkOther000000003', 'pkStillMine00002'], '只刪移除的那一把');
  // 稽核紀錄原樣補回（簽章欄位照抄）
  assert.equal(one(db, "SELECT mac FROM audit_log WHERE id = 'a3'").mac, 'mac-a3');
  assert.equal(one(db, "SELECT COUNT(*) AS n FROM audit_log").n, audit.length);
});

test('D1 Time Travel 之後：重做撤回、撤銷的登入失效、清掉倒回來的推播佇列；跑兩次結果一樣', () => {
  // Time Travel 把整個資料庫倒回去：撤回前的狀態、工作階段與推播佇列都回來了，audit_log 也沒有之後的紀錄
  const db = freshDb();
  const data = backupWithPrivacy();
  db.exec(`BEGIN;\n${toSql(data, { only: null, erased: [] }).join('\n')}\nCOMMIT;`);
  db.exec(`INSERT INTO sessions (token_hash, member_id, expires_at) VALUES ('t2', 'x2', '2026-12-01'), ('t3', 'x3', '2026-12-01'), ('t4', 'x4', '2026-12-01');
    INSERT INTO push_queue (endpoint, payload, expires_at) VALUES ('https://push.example/x4', '{}', '2026-12-01');`);
  const rows = auditRowsFrom(wranglerJson([...WITHDRAWALS, A('c1', '2026-10-02 12:00:00', 'privacy.delete', 'x4', '本人刪除帳號')]), '2026-10-01T19:00:00.000Z');
  const sql = ['PRAGMA defer_foreign_keys = true;', ...replaySql(rows, { timeTravel: true }).lines].join('\n');
  for (let i = 0; i < 2; i++) db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
  assert.deepEqual(db.prepare('SELECT member_id FROM sessions ORDER BY member_id').all().map((r) => r.member_id), ['x2'], 'x3 登出所有裝置、x4 刪除帳號');
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM push_queue').n, 0);
  assert.equal(one(db, "SELECT 1 AS x FROM members WHERE id = 'x4'"), undefined);
  assert.equal(one(db, "SELECT share_logs FROM members WHERE id = 'x2'").share_logs, 0);
  assert.equal(one(db, "SELECT COUNT(*) AS n FROM audit_log").n, rows.length, '補回的稽核紀錄不會重複');
  // 舊版的通行金鑰移除紀錄（沒有金鑰 id）：讓他的登入失效
  const old = replaySql(auditRowsFrom(wranglerJson([A('d1', '2026-10-02 08:00:00', 'passkey.remove', 'x2', null)]))).lines;
  assert.ok(old.includes("DELETE FROM sessions WHERE member_id = 'x2';"));
  assert.ok(!old.some((l) => l.startsWith('DELETE FROM passkeys')));
  // 理事長移交：雙方的登入都失效
  const ho = replaySql([A('h1', '2026-10-02 08:00:00', 'role.handover', 'x3', null, { actor_id: 'x2' })]).lines;
  assert.ok(ho.includes("DELETE FROM sessions WHERE member_id = 'x2';") && ho.includes("DELETE FROM sessions WHERE member_id = 'x3';"));
});

test('撤回紀錄：讀得懂新備份的 audit_log、舊的 --erased 格式；欄位被改過就擋下；查詢只讀', () => {
  const newer = { format: 'cil-backup', tables: { audit_log: WITHDRAWALS } };
  assert.deepEqual(auditRowsFrom(JSON.stringify(newer), '2026-10-01T19:00:00.000Z').map((r) => r.id), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'b1', 'b2']);
  assert.deepEqual(auditRowsFrom(JSON.stringify([{ results: [{ target_id: 'x1' }] }])).map((r) => [r.action, r.target_id]), [['privacy.delete', 'x1']]);
  assert.throws(() => auditRowsFrom(wranglerJson([A('z', '2026-10-02 08:00:00', 'privacy.share_logs', "x2' OR 1=1 --", '關閉')])));
  assert.throws(() => auditRowsFrom(wranglerJson([A('z', "2026-10-02'; DROP TABLE members; --", 'privacy.share_logs', 'x2', '關閉')])));
  assert.throws(() => auditRowsFrom(wranglerJson([A('z', '2026-10-02 08:00:00', 'notif.prefs', 'x2', 'x'.repeat(301))])));
  // 通行金鑰前綴不是安全字元：不產生刪除金鑰的 SQL，改成讓登入失效
  const pk = replaySql([A('p', '2026-10-02 08:00:00', 'passkey.remove', 'x2', "id=abc'); DELETE FROM members; --")]).lines;
  assert.ok(!pk.some((l) => l.startsWith('DELETE FROM passkeys')) && pk.includes("DELETE FROM sessions WHERE member_id = 'x2';"));
  // 補回的稽核紀錄裡的字串一律跳脫，在資料庫裡執行也只是一列文字
  const db = freshDb();
  db.exec(`BEGIN;\n${pk.join('\n')}\nCOMMIT;`);
  assert.equal(one(db, "SELECT detail FROM audit_log WHERE id = 'p'").detail, "id=abc'); DELETE FROM members; --");
  const q = replayQuery('2026-10-01T19:00:00.000Z');
  assert.match(q, /^SELECT id, at, actor_id, actor_name, actor_role, action, target_type, target_id, detail, ip_hash, mac FROM audit_log WHERE action IN \(/);
  assert.match(q, /AND at >= '2026-10-01 19:00:00' ORDER BY at, id$/);
  for (const a of REPLAY_ACTIONS) assert.ok(q.includes(`'${a}'`));
  assert.ok(!q.includes(';') && !/\b(INSERT|UPDATE|DELETE|DROP)\b/.test(q), '只有一句 SELECT');
});
