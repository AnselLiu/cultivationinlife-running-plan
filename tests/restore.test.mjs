// 還原備份：備份之後刪除的帳號與本人的撤回（刪除賽事報名資料、停止分享、退出排行榜、通知分類、推播、通行金鑰、登出所有裝置），
//   匯入後要重做，不能跟著舊備份回來（tools/restore-sql.mjs、src/erase.js）；D1 Time Travel 之後用同一份重做 SQL
//   用 node:sqlite 跑全部 migrations 建一份跟 D1 一樣的資料庫，實際執行還原工具輸出的 SQL
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { toSql, erasedFrom, erasedQuery, auditRowsFrom, replayQuery, replaySql, planSummary, REPLAY_ACTIONS, ROLE_LABELS, TEAM_ROLE_LABELS } from '../tools/restore-sql.mjs';

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
    INSERT INTO events (id, kind, title, date, created_by, lead, owner_managed) VALUES ('e3', 'other', '揪團', '2026-10-11', 'x1', '要被刪的暱稱', 1);
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
  assert.deepEqual({ ...one(db, "SELECT created_by, lead FROM events WHERE id = 'e3'") }, { created_by: null, lead: null }, '團員揪團的發起人暱稱一起匿名');
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
  assert.deepEqual(auditRowsFrom(JSON.stringify([{ results: [{ target_id: 'x1' }], success: true }])).map((r) => [r.action, r.target_id]), [['privacy.delete', 'x1']]);
  // 抓取失敗（wrangler 印出錯誤、success 不是 true、沒有 results）：整份擋下，不能當成「沒有撤回」
  for (const bad of ['{"error":"Authentication error"}', '[{"success":false}]', '[{"results":[]}]', '[{"results":[],"success":true},{"success":false}]', '[]', '{}']) {
    assert.throws(() => auditRowsFrom(bad), /抓取撤回紀錄失敗/, bad);
  }
  assert.deepEqual(auditRowsFrom('[{"results":[],"success":true}]'), [], '成功但真的沒有撤回');
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

test('Time Travel 工具模式：--query 只印唯讀查詢；--replay 從抓下來的檔案產生重做 SQL，時間一定要帶時區', () => {
  const tool = new URL('../tools/restore-backup.mjs', import.meta.url).pathname;
  const run = (...a) => spawnSync(process.execPath, [tool, ...a], { encoding: 'utf8', env: { ...process.env, BACKUP_KEY: '' } });
  const q = run('--query', '2026-10-01T19:00:00Z');
  assert.equal(q.status, 0, q.stderr);
  assert.ok(q.stdout.includes("npx wrangler d1 execute cil-run --remote --json --command \"SELECT id, at,"));
  assert.ok(q.stdout.includes("at >= '2026-10-01 18:50:00'"), '往前多抓 10 分鐘');
  assert.ok(q.stdout.includes('--command "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('), '另外印出筆數查詢，跟 --replay 讀到的筆數比對');
  assert.notEqual(run('--query', '2026-10-01 19:00:00').status, 0, '沒有時區要擋');
  const dir = mkdtempSync(join(tmpdir(), 'cil-restore-'));
  try {
    const f = join(dir, 'withdrawals.json');
    writeFileSync(f, wranglerJson(WITHDRAWALS));
    const r = run('--replay', f, '--since', '2026-10-02T03:00:00+08:00');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('x2') && !r.stdout.includes('某人'), '摘要不印帳號 id 與姓名');
    assert.ok(r.stdout.includes('讀到 11 筆撤回紀錄'), r.stdout);
    // 抓取失敗的檔案：不產生重做 SQL
    const badf = join(dir, 'failed.json');
    writeFileSync(badf, '{"error":"Authentication error"}');
    const fr = run('--replay', badf, '--since', '2026-10-02T03:00:00+08:00');
    assert.notEqual(fr.status, 0); assert.match(fr.stderr, /抓取撤回紀錄失敗/);
    const sql = readFileSync(join(dir, 'withdrawals-replay.sql'), 'utf8').split('\n');
    assert.equal(sql[0], 'PRAGMA defer_foreign_keys = true;');
    assert.ok(sql.includes("UPDATE members SET share_logs = 0 WHERE id = 'x2';") && sql.includes('DELETE FROM push_queue;'));
    assert.ok(!sql.some((l) => l.includes("'a0'")), '還原時間點之前的不重做');
    // 實際在跟 D1 一樣的資料庫跑一次
    const db = freshDb();
    db.exec(`BEGIN;\n${toSql(backupWithPrivacy(), {}).join('\n')}\nCOMMIT;`);
    db.exec(`BEGIN;\n${sql.join('\n')}\nCOMMIT;`);
    assert.equal(one(db, "SELECT share_logs FROM members WHERE id = 'x2'").share_logs, 0);
    assert.notEqual(run('--replay', f).status, 0, '沒有 --since 要擋');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 分團、身分、行事曆訂閱、自己刪掉的紀錄：還原後也要重做 ----
function backupWithTeams() {
  const db = freshDb();
  db.exec(`INSERT INTO members (id, name, role, title, cal_token_hash) VALUES ('y1', '退團的人', 'member', NULL, NULL), ('y2', '被移出的人', 'member', NULL, NULL),
      ('y3', '被降級的幹部', 'staff', '總務', NULL), ('y4', '舊理事長', 'chair', NULL, NULL), ('y5', '新理事長', 'director', '理事', 'oldcalhash'), ('y6', '舊紀錄的人', 'coach', NULL, NULL);
    INSERT INTO teams (id, name) VALUES ('tA', '青年團'), ('tB', '親子團');
    INSERT INTO team_members (team_id, member_id, role, title, status) VALUES ('tA', 'y1', 'member', NULL, 'active'), ('tA', 'y2', 'member', NULL, 'active'),
      ('tB', 'y2', 'member', NULL, 'active'), ('tA', 'y3', 'officer', '活動組', 'active'), ('tB', 'y6', 'officer', NULL, 'active'), ('tB', 'y1', 'member', NULL, 'active');
    INSERT INTO training_logs (id, member_id, date, km, rpe, note) VALUES ('g1', 'y1', '2026-10-01', 5, 8, '膝蓋痛'), ('g2', 'y1', '2026-10-01', 3, 4, '留著');
    INSERT INTO routes (id, name, points, distance, created_by) VALUES ('rt1', '刪掉的路線', '[]', 100, 'y1'), ('rt2', '留著的路線', '[]', 100, 'y1');
    INSERT INTO events (id, kind, title, date, route_id) VALUES ('ev1', 'track', '團練', '2026-10-10', 'rt1');
    INSERT INTO team_posts (id, team_id, author_id, author_name, title) VALUES ('po1', 'tA', 'y3', '幹部', '刪掉的公告'), ('po2', 'tA', 'y3', '幹部', '留著的公告');`);
  const tables = {};
  for (const t of ['members', 'teams', 'team_members', 'training_logs', 'routes', 'events', 'team_posts']) tables[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => ({ ...r }));
  return { format: 'cil-backup', version: 2, at: '2026-10-01T19:00:00.000Z', tables };
}
const B = (id, at, action, actor_id, target_type, target_id, detail = null) => ({ id, at, actor_id, actor_name: '某人', actor_role: 'member', action, target_type, target_id, detail, ip_hash: 'h', mac: `mac-${id}` });
const LATER = [
  B('t1', '2026-10-02 08:00:00', 'team.leave', 'y1', 'team', 'tA', '青年團'),
  B('t2', '2026-10-02 08:01:00', 'team.remove', 'y4', 'member', 'y2', '青年團｜team=tA'),
  B('t3', '2026-10-02 08:02:00', 'team.role', 'y4', 'member', 'y3', '青年團／幹部／活動組｜team=tA｜role=officer'),
  B('t4', '2026-10-02 08:03:00', 'team.role', 'y4', 'member', 'y3', '青年團／團員｜team=tA｜role=member'),    // 最後一次：降為團員
  B('t5', '2026-10-02 08:04:00', 'role.change', 'y4', 'member', 'y3', '團員｜role=member'),
  B('t6', '2026-10-02 08:05:00', 'role.handover', 'y4', 'member', 'y5', '理事長移交給 新理事長；原理事長改為理事｜role=director'),
  B('t7', '2026-10-02 08:06:00', 'calendar.off', 'y5', 'member', 'y5', ''),
  B('t8', '2026-10-02 08:07:00', 'log.delete', 'y1', 'log', 'g1', ''),
  B('t9', '2026-10-02 08:08:00', 'route.delete', 'y1', 'route', 'rt1', ''),
  B('u1', '2026-10-02 08:09:00', 'team.post_delete', 'y3', 'team', 'tA', 'po1'),
  B('u2', '2026-10-02 08:10:00', 'team.remove', 'y4', 'member', 'y6', '親子團'),                              // 舊紀錄：只有分團名稱
  B('u3', '2026-10-02 08:11:00', 'role.change', 'y4', 'member', 'y6', '行政人員／秘書'),                        // 舊紀錄：只有中文名稱
  B('u4', '2026-10-02 08:12:00', 'role.change', 'y4', 'member', 'y1', '教練／x｜role=chair'),                   // 職稱偽造代碼：看不懂，不自動做
];

test('還原後重做：退出與移出分團、分團與協會身分（照最後一次）、行事曆訂閱、自己刪掉的訓練紀錄、路線與公告', () => {
  const rows = auditRowsFrom(wranglerJson(LATER), '2026-10-01T19:00:00.000Z');
  assert.equal(rows.length, LATER.length);
  const { plan } = replaySql(rows);
  assert.equal(plan.unresolved.length, 1, '偽造的身分代碼列出來請人工確認');
  assert.match(planSummary(plan), /要人工確認的身分或分團紀錄 1/);
  for (let i = 0; i < 2; i++) {   // 跑兩次結果一樣
    const db = freshDb();
    db.exec(`BEGIN;\n${toSql(backupWithTeams(), { audit: rows }).join('\n')}\nCOMMIT;`);
    if (i) db.exec(`BEGIN;\n${['PRAGMA defer_foreign_keys = true;', ...replaySql(rows, { timeTravel: true }).lines].join('\n')}\nCOMMIT;`);
    const tm = db.prepare('SELECT team_id, member_id, role, title FROM team_members ORDER BY team_id, member_id').all().map((r) => [r.team_id, r.member_id, r.role, r.title]);
    assert.deepEqual(tm, [['tA', 'y3', 'member', null], ['tB', 'y1', 'member', null], ['tB', 'y2', 'member', null]],
      'y1 只退出青年團、y2 只被移出青年團、y6 照名稱移出親子團、y3 降為團員且職稱清掉');
    const m = (id) => ({ ...one(db, `SELECT role, title, cal_token_hash FROM members WHERE id = '${id}'`) });
    assert.deepEqual(m('y3'), { role: 'member', title: null, cal_token_hash: null }, '協會身分照最後一次（降級）');
    assert.deepEqual(m('y5'), { role: 'chair', title: null, cal_token_hash: null }, '移交：新理事長；停用的行事曆訂閱網址不會復活');
    assert.equal(m('y4').role, 'director', '移交：原理事長改為理事');
    assert.deepEqual(m('y6'), { role: 'staff', title: '秘書', cal_token_hash: null }, '舊紀錄照中文名稱');
    assert.equal(m('y1').role, 'member', '看不懂的不動');
    assert.deepEqual(db.prepare("SELECT id FROM training_logs ORDER BY id").all().map((r) => r.id), ['g2'], '刪掉的訓練紀錄（含備註、強度）不會回來');
    assert.deepEqual(db.prepare('SELECT id FROM routes ORDER BY id').all().map((r) => r.id), ['rt2']);
    assert.equal(one(db, "SELECT route_id FROM events WHERE id = 'ev1'").route_id, null);
    assert.deepEqual(db.prepare('SELECT id FROM team_posts ORDER BY id').all().map((r) => r.id), ['po2']);
  }
  // 沒有做這件事的人（actor_id）的退團、刪紀錄：看起來被改過，整份擋下
  assert.throws(() => auditRowsFrom(wranglerJson([{ ...LATER[0], actor_id: null }])));
  assert.throws(() => auditRowsFrom(wranglerJson([{ ...LATER[7], actor_id: null }])));
  // 公告 id 不是安全字元：不產生 SQL
  assert.ok(!replaySql([B('u9', '2026-10-02 08:00:00', 'team.post_delete', 'y3', 'team', 'tA', "po1' OR 1=1 --")]).lines.some((l) => l.startsWith('DELETE FROM team_posts')));
});

test('身分名稱對照跟 src/worker.js 的 ROLES、TEAM_ROLES 一致', () => {
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const obj = (name) => Object.fromEntries([...new RegExp(`export const ${name} = \\{([^}]*)\\}`).exec(src)[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[2], m[1]]));
  assert.deepEqual(obj('ROLES'), ROLE_LABELS);
  assert.deepEqual(obj('TEAM_ROLES'), TEAM_ROLE_LABELS);
});

// ---- 推薦人：備份之後關掉「用 Gmail 找到我」、移除推薦人、推薦人按「不是我」；members 用更新而不是 REPLACE ----
function backupWithReferral() {
  const db = freshDb();
  db.exec(`INSERT INTO members (id, name, email_h) VALUES ('ra', '推薦人甲', 'HA'), ('rb', '推薦人乙', 'HB'), ('rc', '跑友丙', NULL), ('rd', '跑友丁', NULL), ('re', '跑友戊', NULL), ('rf', '跑友己', 'HF');
    UPDATE members SET referrer_id = 'ra', referrer_by = 'self' WHERE id IN ('rc', 'rd');
    UPDATE members SET referrer_name = '王大明', referrer_by = 'self' WHERE id = 're';
    INSERT INTO events (id, kind, title, date) VALUES ('ev9', 'track', '團練', '2026-10-10');
    INSERT INTO signups (id, event_id, member_id, name, grp) VALUES ('sg9', 'ev9', 'ra', '推薦人甲', 'D');`);
  const tables = {};
  for (const t of ['members', 'events', 'signups']) tables[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => ({ ...r }));
  return { format: 'cil-backup', version: 2, at: '2026-10-01T19:00:00.000Z', tables };
}
const REFERRAL = [
  A('k1', '2026-10-02 08:00:00', 'privacy.email_lookup', 'ra', '關閉'),
  A('k2', '2026-10-02 08:00:00', 'privacy.email_lookup', 'rf', '關閉'),             // 關了又開：開關打開，但刪掉的查詢碼不會從備份回來
  A('k3', '2026-10-02 09:00:00', 'privacy.email_lookup', 'rf', '開啟'),
  A('k4', '2026-10-02 08:01:00', 'referrer.clear', 're'),
  A('k5', '2026-10-02 08:02:00', 'referrer.deny', 'rc', '', { actor_id: 'ra' }),      // 推薦人 ra 對 rc 按「不是我」
  A('k6', '2026-10-02 08:03:00', 'referrer.deny', 'rd', '', { actor_id: 'rb' }),      // 之後 rd 的推薦人換過（備份裡是 ra）：不動
  A('k7', '2026-10-02 08:04:00', 'referrer.admin_clear', 'rf', '', { actor_id: 't_staff' }),
];

test('還原後重做推薦人撤回：Gmail 查詢關閉、移除推薦人、「不是我」與冷卻', () => {
  const rows = auditRowsFrom(wranglerJson(REFERRAL), '2026-10-01T19:00:00.000Z');
  assert.equal(rows.length, REFERRAL.length);
  const { plan } = replaySql(rows);
  assert.match(planSummary(plan), /Gmail 查詢關閉 1/);
  assert.match(planSummary(plan), /推薦人移除 2/);
  assert.match(planSummary(plan), /推薦人「不是我」 2/);
  const db = freshDb();
  db.exec(`BEGIN;\n${toSql(backupWithReferral(), { audit: rows }).join('\n')}\nCOMMIT;`);
  const m = (id) => ({ ...one(db, `SELECT email_h, email_findable, referrer_id, referrer_name, referrer_ack FROM members WHERE id = '${id}'`) });
  assert.deepEqual(m('ra'), { email_h: null, email_findable: 0, referrer_id: null, referrer_name: null, referrer_ack: null });
  assert.equal(m('rf').email_h, null, '關過又打開：刪掉的查詢碼不會從備份回來（要再用 Google 確認一次）');
  assert.equal(m('rf').email_findable, 1, '開關照最後一次（開啟）');
  assert.equal(m('rb').email_h, 'HB', '沒關過的不動');
  assert.match(planSummary(plan), /Gmail 查詢碼刪除（關過又打開） 1/);
  assert.equal(m('re').referrer_name, null, '本人移除的推薦人不會回來');
  assert.deepEqual(m('rc'), { email_h: null, email_findable: 1, referrer_id: null, referrer_name: null, referrer_ack: 'denied' });
  assert.equal(m('rd').referrer_id, 'ra', '「不是我」的是 rb，rd 的推薦人是 ra：不動');
  const cd = (k) => one(db, `SELECT count, window_end FROM rate_limits WHERE key = '${k}'`);
  assert.deepEqual({ ...cd('refno:rc:ra') }, { count: 1000000, window_end: '2027-03-31 08:02:00' }, '冷卻 180 天從按下的時間算');
  assert.ok(cd('refno:rd:rb'));
  // 跑兩次（Time Travel）結果一樣；冷卻不會被縮短
  db.exec("UPDATE rate_limits SET window_end = '2030-01-01 00:00:00' WHERE key = 'refno:rc:ra'");
  db.exec(`BEGIN;\n${['PRAGMA defer_foreign_keys = true;', ...replaySql(rows, { timeTravel: true }).lines].join('\n')}\nCOMMIT;`);
  assert.equal(cd('refno:rc:ra').window_end, '2030-01-01 00:00:00');
  // 「不是我」一定要有推薦人（actor_id）：看起來被改過，整份擋下
  assert.throws(() => auditRowsFrom(wranglerJson([{ ...REFERRAL[4], actor_id: null }])));
  assert.throws(() => replaySql([{ ...REFERRAL[4], at: "2026-10-02'; --" }]));
});

test('備份之前按的「不是我」：rate_limits 沒有備份，冷卻照備份自己的 audit_log 補回（已經過期的不寫）', () => {
  const at = (days) => new Date(Date.now() - days * 86400e3).toISOString().replace('T', ' ').slice(0, 19);
  const data = backupWithReferral();
  data.tables.audit_log = [
    A('b1', at(10), 'referrer.deny', 'rc', '', { actor_id: 'ra' }),      // 10 天前：還在冷卻
    A('b2', at(200), 'referrer.deny', 'rd', '', { actor_id: 'rb' }),     // 200 天前：已經過期
    A('b3', at(5), 'referrer.deny', 're', '', { actor_id: "x'; --" }),    // 看不懂的 id：略過
    A('b4', at(3), 'referrer.clear', 'rf'),
  ];
  const db = freshDb();
  db.exec(`BEGIN;\n${toSql(data, {}).join('\n')}\nCOMMIT;`);
  const keys = db.prepare("SELECT key, count, window_end FROM rate_limits WHERE key LIKE 'refno:%'").all().map((r) => ({ ...r }));
  assert.deepEqual(keys.map((r) => r.key), ['refno:rc:ra']);
  assert.equal(keys[0].count, 1000000);
  assert.equal(keys[0].window_end, one(db, `SELECT datetime('${at(10)}', '+180 days') AS w`).w, '冷卻 180 天從按下的時間算');
  // 已經有比較晚的冷卻：不縮短；只還原別的表時不寫
  db.exec("UPDATE rate_limits SET window_end = '2099-01-01 00:00:00' WHERE key = 'refno:rc:ra'");
  db.exec(`BEGIN;\n${toSql(data, { only: 'members' }).join('\n')}\nCOMMIT;`);
  assert.equal(one(db, "SELECT window_end FROM rate_limits WHERE key = 'refno:rc:ra'").window_end, '2099-01-01 00:00:00');
  assert.ok(!toSql(data, { only: 'signups' }).some((l) => l.includes('rate_limits')));
});

test('還原 members 用更新（不是 REPLACE）：不在備份裡的人推薦關係保留，子表不被 CASCADE 刪掉', () => {
  const db = freshDb();
  db.exec(`BEGIN;\n${toSql(backupWithReferral(), {}).join('\n')}\nCOMMIT;`);
  // 備份之後新加入的 rz，推薦人是備份裡的 rb；還原 --only members 不能讓 rz 的推薦人不見
  db.exec("INSERT INTO members (id, name, referrer_id) VALUES ('rz', '新跑友', 'rb')");
  db.exec(`BEGIN;\n${toSql(backupWithReferral(), { only: 'members' }).join('\n')}\nCOMMIT;`);
  assert.equal(one(db, "SELECT referrer_id FROM members WHERE id = 'rz'").referrer_id, 'rb');
  assert.ok(one(db, "SELECT 1 AS x FROM signups WHERE id = 'sg9'"), '報名不會被 CASCADE 刪掉');
  assert.equal(one(db, "SELECT referrer_id FROM members WHERE id = 'rc'").referrer_id, 'ra', '備份的值照樣寫回');
  const sql = toSql(backupWithReferral(), { only: 'members' }).filter((l) => l.includes('"members"'));
  assert.ok(sql.length && sql.every((l) => /^INSERT INTO "members" .* ON CONFLICT\(id\) DO UPDATE SET /.test(l)) && !sql.some((l) => l.includes('OR REPLACE')));
  assert.ok(toSql(backupWithReferral(), { only: 'signups' }).some((l) => l.startsWith('INSERT OR REPLACE INTO "signups"')), '其他表照舊');
});

test('撤回清單：worker.js 裡的隱私撤回、推薦人移除與「不是我」、退出分團都會在還原時重做', () => {
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const acts = new Set([...src.matchAll(/audit(?:Stmt|ManyStmt)?\(env, \w+, [^,]+, '([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]));
  const NOT_WITHDRAWAL = ['privacy.consent', 'privacy.export', 'privacy.race_profile'];
  const must = [...acts].filter((a) => (a.startsWith('privacy.') && !NOT_WITHDRAWAL.includes(a))
    || ['referrer.clear', 'referrer.deny', 'referrer.admin_clear', 'team.leave', 'session.revoke_all', 'push.unsubscribe', 'passkey.remove', 'calendar.off', 'log.delete', 'route.delete', 'team.post_delete'].includes(a));
  assert.ok(must.includes('privacy.email_lookup') && must.includes('referrer.deny'), '掃描有抓到');
  assert.deepEqual(must.filter((a) => !REPLAY_ACTIONS.includes(a)), []);
});
