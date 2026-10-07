// 推薦人 SQL（src/referral.js）：用 node:sqlite 跑全部 migrations、外鍵開啟，實際執行每一句
//   自己、循環、推薦人不存在、64 層上限；髒資料的環也會停；往下用索引；管理員連結跳過會成環的；刪除帳號的順序；登入時清掉別人身上相同的查詢碼
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BIND_SQL, UP_SQL, DOWN_SQL, RELINK_SQL, CLEAR_SQL, DENY_SQL, ACK_SQL, FOCUS_SQL, SUMMARY_SQL, SEARCH_SQL, NAMES_SQL, NAMED_SQL, NAME_SQL, COOLDOWN_SQL, LOGIN_SQL, LINK_SQL, CLEAR_HOLDER_SQL } from '../src/referral.js';
import { ERASE_MEMBER } from '../src/erase.js';

const dir = new URL('../migrations/', import.meta.url);
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
const add = (db, ...ids) => { for (const id of ids) db.prepare('INSERT INTO members (id, name) VALUES (?, ?)').run(id, `名${id}`); };
const bind = (db, me, to) => db.prepare(BIND_SQL).all(me, to, 'self').length;
const refOf = (db, id) => db.prepare('SELECT referrer_id FROM members WHERE id = ?').get(id).referrer_id;

test('BIND_SQL：可以綁、循環與自己與不存在都擋（不丟外鍵錯誤）、重複綁回 0 列', () => {
  const db = freshDb();
  add(db, 'a', 'b', 'c');
  assert.equal(bind(db, 'b', 'a'), 1);
  assert.equal(bind(db, 'c', 'b'), 1);
  assert.equal(bind(db, 'a', 'c'), 0, 'a→c 會成環');
  assert.equal(bind(db, 'a', 'a'), 0, '自己');
  assert.equal(bind(db, 'a', 'zz'), 0, '推薦人不存在');
  assert.equal(refOf(db, 'a'), null);
  assert.equal(bind(db, 'b', 'a'), 0, '已經是同一位');
  const r = db.prepare('SELECT referrer_by, referrer_ack, referrer_gone, referrer_name FROM members WHERE id = ?').get('b');
  assert.deepEqual({ ...r }, { referrer_by: 'self', referrer_ack: null, referrer_gone: 0, referrer_name: null });
});

test('BIND_SQL：64 層上限', () => {
  const db = freshDb();
  const ids = Array.from({ length: 65 }, (_, i) => `m${i}`);
  add(db, ...ids, 'x');
  for (let i = 1; i < ids.length; i++) db.prepare('UPDATE members SET referrer_id = ? WHERE id = ?').run(ids[i - 1], ids[i]);
  assert.equal(bind(db, 'x', 'm64'), 0, '上面已經 64 層');
  assert.equal(bind(db, 'x', 'm10'), 1);
});

test('UP_SQL／DOWN_SQL：髒資料的環也會停；往下用 members_referrer 索引', () => {
  const db = freshDb();
  add(db, 'a', 'b', 'c', 'd');
  bind(db, 'b', 'a'); bind(db, 'c', 'b'); bind(db, 'd', 'b');
  const up = db.prepare(UP_SQL).all('c', 10);
  assert.deepEqual(up.map((r) => [r.d, r.id]), [[1, 'b'], [2, 'a']]);
  const down = db.prepare(DOWN_SQL).all('a', 3);
  assert.deepEqual(down.map((r) => [r.d, r.id, r.parent, r.kids]), [[1, 'b', 'a', 2], [2, 'c', 'b', 0], [2, 'd', 'b', 0]]);
  // 用原始 UPDATE 做出 a→c 的環（正常寫入做不到）
  db.prepare("UPDATE members SET referrer_id = 'c' WHERE id = 'a'").run();
  assert.ok(db.prepare(UP_SQL).all('c', 10).length <= 10);
  assert.ok(db.prepare(DOWN_SQL).all('a', 3).length <= 301);
  assert.ok(db.prepare(UP_SQL).all('c', 100).length <= 4, '環在 path 擋住');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${DOWN_SQL}`).all('a', 3).map((r) => r.detail).join('\n');
  assert.match(plan, /members_referrer/);
  const f = db.prepare(FOCUS_SQL).get('b');
  assert.equal(f.kids, 2);
});

test('RELINK_SQL：只填名字的連到帳號，會成環的那位跳過', () => {
  const db = freshDb();
  add(db, 'p', 'q', 'r', 'to');
  for (const id of ['p', 'q', 'r']) db.prepare(NAME_SQL).run(id, '王大明');
  db.prepare("UPDATE members SET referrer_name = NULL, referrer_id = 'q' WHERE id = 'to'").run();   // to 是 q 推薦來的
  db.prepare("UPDATE members SET referrer_name = '王大明' WHERE id = 'q'").run();
  const named = db.prepare(NAMED_SQL).all('王大明').map((r) => r.id).sort();
  assert.deepEqual(named, ['p', 'q', 'r']);
  const out = db.prepare(RELINK_SQL).all(JSON.stringify(named), '王大明', 'to').map((r) => r.id).sort();
  assert.deepEqual(out, ['p', 'r'], 'q 是 to 的推薦人，連過去會成環');
  assert.equal(db.prepare("SELECT referrer_by FROM members WHERE id = 'p'").get().referrer_by, 'admin');
  assert.equal(refOf(db, 'q'), null);
  assert.equal(db.prepare(RELINK_SQL).all(JSON.stringify(['p']), '王大明', 'zz').length, 0, '帳號不存在');
});

test('確認、「不是我」、移除、摘要與搜尋', () => {
  const db = freshDb();
  add(db, 'a', 'b', 'c');
  bind(db, 'b', 'a');
  assert.equal(db.prepare(ACK_SQL).all('b', 'a').length, 1);
  assert.equal(db.prepare(ACK_SQL).all('b', 'a').length, 0, '已經確認');
  assert.equal(db.prepare(ACK_SQL).all('b', 'c').length, 0, '不是他的推薦人');
  assert.equal(db.prepare(DENY_SQL).all('b', 'c').length, 0);
  assert.equal(db.prepare(DENY_SQL).all('b', 'a').length, 1);
  assert.deepEqual({ ...db.prepare("SELECT referrer_id, referrer_ack FROM members WHERE id = 'b'").get() }, { referrer_id: null, referrer_ack: 'denied' });
  assert.equal(db.prepare(CLEAR_SQL).all('b').length, 1, '「不是我」的標記也清得掉');
  assert.equal(db.prepare(CLEAR_SQL).all('b').length, 0, '沒有可以清的');
  db.prepare(NAME_SQL).run('c', '陳小華');
  const s = db.prepare(SUMMARY_SQL).get();
  assert.deepEqual({ linked: s.linked, named: s.named, pending: s.pending, total: s.total }, { linked: 0, named: 1, pending: 0, total: 3 });
  assert.deepEqual(db.prepare(SEARCH_SQL).all('名a').map((r) => r.id), ['a']);
  assert.deepEqual(db.prepare(NAMES_SQL).all('小華').map((r) => [r.name, r.n]), [['陳小華', 1]]);
  db.prepare(COOLDOWN_SQL).run('refno:b:a');
  assert.ok(db.prepare("SELECT 1 AS x FROM rate_limits WHERE key = 'refno:b:a' AND window_end > datetime('now', '+179 days')").get());
});

test('刪除帳號：先標「推薦人已刪除」再刪；順序反過來標記就不見了', () => {
  const setup = () => {
    const db = freshDb();
    add(db, 'r', 'k1', 'k2');
    bind(db, 'k1', 'r'); bind(db, 'k2', 'r');
    db.prepare("INSERT INTO notifications (id, member_id, kind, category, ref, title) VALUES ('n1', 'k1', 'membership', 'membership', 'rf:r', '推薦人沒有確認'), ('n2', 'k1', 'event', 'event', 'rf:r', '別類')").run();
    return db;
  };
  const db = setup();
  for (const q of ERASE_MEMBER) db.prepare(q).run('r');
  assert.deepEqual(db.prepare('SELECT id, referrer_id, referrer_gone FROM members ORDER BY id').all().map((r) => [r.id, r.referrer_id, r.referrer_gone]), [['k1', null, 1], ['k2', null, 1]]);
  assert.deepEqual(db.prepare('SELECT id FROM notifications ORDER BY id').all().map((r) => r.id), ['n2'], '只刪推薦通知');
  const rev = setup();
  const i = ERASE_MEMBER.findIndex((q) => q.startsWith('DELETE FROM members'));
  for (const q of [ERASE_MEMBER[i], ...ERASE_MEMBER.filter((_, k) => k !== i)]) rev.prepare(q).run('r');
  assert.deepEqual(rev.prepare('SELECT referrer_gone FROM members ORDER BY id').all().map((r) => r.referrer_gone), [0, 0], '外鍵先清掉 referrer_id，標記就找不到人');
});

test('登入時把別人身上相同的查詢碼清掉（同一句）', () => {
  const db = freshDb();
  add(db, 'e', 'f');
  db.prepare("UPDATE members SET email_h = 'H' WHERE id = 'e'").run();
  const sql = LOGIN_SQL;
  db.prepare(sql).run('f', null, 'H', 1);
  assert.deepEqual(db.prepare('SELECT id, email_h FROM members ORDER BY id').all().map((r) => [r.id, r.email_h]), [['e', null], ['f', 'H']]);
  db.prepare(sql).run('e', null, null, 0);
  assert.equal(db.prepare("SELECT email_h FROM members WHERE id = 'f'").get().email_h, 'H', '沒有要改查詢碼時不動別人');
  db.prepare(LINK_SQL).run('e', 'https://lh3.googleusercontent.com/x', 'H', 1, 'sub-e');
  assert.deepEqual(db.prepare('SELECT id, email_h, google_sub FROM members ORDER BY id').all().map((r) => [r.id, r.email_h, r.google_sub]), [['e', 'H', 'sub-e'], ['f', null, null]]);
  db.prepare(CLEAR_HOLDER_SQL).run('H');
  db.prepare(CLEAR_HOLDER_SQL).run(null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members WHERE email_h IS NOT NULL").get().n, 0);
});
