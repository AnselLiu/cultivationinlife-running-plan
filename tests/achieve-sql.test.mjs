// 成績與挑戰的 SQL 積木（src/achieve.js）：用 node:sqlite 跑全部 migrations、外鍵開啟，實際執行每一句
//   核准快照（第一筆／刷新／追平／補登更早的）、破 PB 的基準要「發布前登錄」、時間門檻與首次、速度上升的邊界、里程凍結（updated_at 是 NULL 的也算）、
//   出席只算指定的團練、團服名額依達成先後與候補、之後才排的接在最後、同款團服一人一件（dup、DUPMARK、遞補跳過）、恭喜榜與排行只列打開的人
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as Q from '../src/achieve.js';

const dir = new URL('../migrations/', import.meta.url);
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec("INSERT INTO members (id, name) VALUES ('a', '甲'), ('b', '乙'), ('c', '丙'), ('d', '丁'), ('rv', '審核者')");
  return db;
}
let n = 0;
const pb = (db, m, d, sec, date, { status = 'approved', created = '2026-01-01 00:00:00', km = { '5k': 5, '10k': 10, hm: 21.0975, fm: 42.195 }[d] } = {}) => {
  const id = `p${++n}`;
  db.prepare(`INSERT INTO pb_records (id, member_id, dist_key, km, seconds, race_name, race_date, status, created_at, review_at) VALUES (?, ?, ?, ?, ?, '賽', ?, ?, ?, ?)`)
    .run(id, m, d, km, sec, date, status, created, status === 'approved' ? created : null);
  return id;
};
const camp = (db, id, kind, o = {}) => db.prepare(`INSERT INTO ach_campaigns (id, title, kind, dist_key, target, opts, confirm, rewards, team_id, start_date, end_date, join_by, status, opened_at, settled_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, id, kind, o.dist ?? null, o.target ?? null, JSON.stringify(o.opts || {}), o.confirm ? 1 : 0, JSON.stringify(o.rewards || { badge: 'medal' }),
  o.team ?? null, o.start || '2026-10-01', o.end || '2026-12-31', o.join || '2026-12-31', o.status || 'open', o.opened || '2026-06-01 00:00:00', o.settled ?? null);
const join = (db, id, cid, m, o = {}) => db.prepare(`INSERT INTO ach_entries (id, campaign_id, member_id, status, joined_at, rank_key, reward_state) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(id, cid, m, o.status || 'joined', o.joined || '2026-10-01 00:00:00', o.rank ?? null, o.reward ?? null);
const st = (db, id) => ({ ...db.prepare('SELECT status, evidence, rank_key, reward_state, reward_rank FROM ach_entries WHERE id = ?').get(id) });

test('APPROVE：第一筆 first、更快 break（prev_seconds）、追平與更慢 none；補登更早的比賽是 first、之後的快照不變；不能審自己的', () => {
  const db = freshDb(), ap = (id, by = 'rv') => db.prepare(Q.APPROVE).all(id, by)[0];
  const p1 = pb(db, 'a', 'fm', 14000, '2025-03-01', { status: 'pending' });
  assert.equal(ap(p1, 'a'), undefined, '自己的不能審');
  assert.equal(ap(p1).pb_kind, 'first');
  const p2 = pb(db, 'a', 'fm', 13500, '2025-12-01', { status: 'pending' });
  assert.deepEqual({ ...ap(p2) }, { id: p2, member_id: 'a', dist_key: 'fm', km: 42.195, seconds: 13500, race_name: '賽', pb_kind: 'break' });
  assert.equal(db.prepare('SELECT prev_seconds FROM pb_records WHERE id = ?').get(p2).prev_seconds, 14000);
  assert.equal(ap(pb(db, 'a', 'fm', 13500, '2026-01-01', { status: 'pending' })).pb_kind, 'none', '追平');
  assert.equal(ap(pb(db, 'a', 'fm', 15000, '2026-02-01', { status: 'pending' })).pb_kind, 'none');
  assert.equal(ap(pb(db, 'a', 'fm', 16000, '2024-01-01', { status: 'pending' })).pb_kind, 'first', '補登更早、更慢的比賽');
  assert.equal(db.prepare('SELECT pb_kind FROM pb_records WHERE id = ?').get(p2).pb_kind, 'break', '之後的快照不變');
  assert.equal(ap(p2), undefined, '已經核准的不能再核准');
  // 同一場同距離的有效紀錄只能一筆（pb_once）；婉拒的可以重送
  assert.throws(() => pb(db, 'a', 'fm', 13000, '2025-12-01', { status: 'pending' }), /UNIQUE/);
  db.prepare("UPDATE pb_records SET status = 'rejected' WHERE id = ?").run(p2);
  pb(db, 'a', 'fm', 13000, '2025-12-01', { status: 'pending' });
});

test('PB_EVAL：破 PB 的基準要有一筆是挑戰發布前登錄的、嚴格小於；first_ok 不能靠補登；證據取比賽日最早的', () => {
  const db = freshDb(), ev = (scope = Q.SCOPE.campaign, arg = 'c1') => db.prepare(Q.PB_EVAL(scope)).all(arg);
  camp(db, 'c1', 'pb', { dist: 'fm', opened: '2026-09-01 00:00:00' });
  camp(db, 'c2', 'pb', { dist: null, opts: { first_ok: 1 }, opened: '2026-09-01 00:00:00' });
  // a：發布前登錄的基準 4:00:00；期間內 3:59:59 達成、4:00:00 追平不算
  pb(db, 'a', 'fm', 14400, '2026-04-01', { created: '2026-05-01 00:00:00' });
  join(db, 'ea', 'c1', 'a');
  pb(db, 'a', 'fm', 14400, '2026-10-10');
  assert.equal(ev().length, 0, '追平不算');
  const later = pb(db, 'a', 'fm', 14000, '2026-11-20'), early = pb(db, 'a', 'fm', 14399, '2026-11-01');
  assert.deepEqual(ev().map((r) => r.id), ['ea']);
  assert.equal(st(db, 'ea').evidence, early, '比賽日最早的那一筆');
  assert.match(st(db, 'ea').rank_key, /^2026-11-01 /);
  assert.ok(later);
  // b：開始前的成績都是發布後才登錄的 → 沒有基準；first_ok 也不能變成「第一次」
  pb(db, 'b', 'fm', 20000, '2026-05-01', { created: '2026-09-15 00:00:00' });
  join(db, 'eb', 'c1', 'b'); join(db, 'eb2', 'c2', 'b');
  pb(db, 'b', 'fm', 15000, '2026-10-20');
  assert.equal(ev(Q.SCOPE.member, 'b').length, 0);
  // 有一筆發布前登錄的 → 基準是全部開始前已核准成績的 MIN（補登更快的讓基準變快）
  pb(db, 'b', 'fm', 19000, '2026-03-01', { created: '2026-08-01 00:00:00' });
  pb(db, 'b', 'fm', 14000, '2026-02-01', { created: '2026-09-20 00:00:00' });
  assert.equal(ev(Q.SCOPE.member, 'b').length, 0, '基準跟著補登變快：15000 沒有比 14000 快');
  pb(db, 'b', 'fm', 13999, '2026-12-01');
  assert.deepEqual(ev(Q.SCOPE.member, 'b').map((r) => r.id).sort(), ['eb', 'eb2']);
  // c：完全沒有開始前的成績 → first_ok 的挑戰期間內完賽就算（任一標準距離）
  join(db, 'ec', 'c2', 'c');
  pb(db, 'c', '10k', 3600, '2026-10-05');
  assert.deepEqual(ev(Q.SCOPE.member, 'c').map((r) => r.id), ['ec']);
  // 已結算 60 天內：not_met 的也會補算；超過 60 天不算
  camp(db, 'c3', 'pb', { dist: 'fm', status: 'settled', settled: '2027-01-08 00:00:00', opened: '2026-09-01 00:00:00' });
  join(db, 'ed', 'c3', 'd', { status: 'not_met' });
  pb(db, 'd', 'fm', 20000, '2026-01-01');
  pb(db, 'd', 'fm', 19000, '2026-10-01');
  db.prepare("UPDATE ach_campaigns SET settled_at = datetime('now', '-61 days') WHERE id = 'c3'").run();
  assert.equal(ev(Q.SCOPE.member, 'd').length, 0);
  db.prepare("UPDATE ach_campaigns SET settled_at = datetime('now', '-59 days') WHERE id = 'c3'").run();
  assert.deepEqual(ev(Q.SCOPE.member, 'd').map((r) => r.id), ['ed']);
});

test('PB_EVAL：時間門檻嚴格小於、first_time；速度上升 3.0% 剛好算、2.99% 不算、沒有基準不算', () => {
  const db = freshDb(), ev = (m) => db.prepare(Q.PB_EVAL(Q.SCOPE.member)).all(m).map((r) => r.id);
  camp(db, 't1', 'time', { dist: 'fm', target: 14400 });
  camp(db, 't2', 'time', { dist: 'fm', target: 14400, opts: { first_time: 1 } });
  join(db, 'ta', 't1', 'a'); join(db, 'ta2', 't2', 'a');
  pb(db, 'a', 'fm', 14400, '2026-10-10');
  assert.deepEqual(ev('a'), [], '4:00:00 不算');
  pb(db, 'a', 'fm', 14399, '2026-11-10');
  assert.deepEqual(ev('a').sort(), ['ta', 'ta2']);
  join(db, 'tb', 't2', 'b');
  pb(db, 'b', 'fm', 14000, '2026-01-01');   // 開始前已經破 4
  pb(db, 'b', 'fm', 13000, '2026-10-10');
  assert.deepEqual(ev('b'), [], '限第一次跑進');
  camp(db, 'v1', 'pace', { dist: 'hm', target: 3 });
  join(db, 'va', 'v1', 'c'); join(db, 'vb', 'v1', 'd');
  pb(db, 'c', 'hm', 12000, '2026-01-01');
  pb(db, 'c', 'hm', 11641, '2026-10-10');
  assert.deepEqual(ev('c'), [], '2.99%');
  pb(db, 'c', 'hm', 11640, '2026-10-11');
  assert.deepEqual(ev('c'), ['va'], '剛好 3.0%');
  pb(db, 'd', 'hm', 9000, '2026-10-10');
  assert.deepEqual(ev('d'), [], '沒有基準');
});

test('BASE_DEL：挑戰發布後刪掉會讓比較變容易的開始前成績 → 記下挑戰、之後判定達成改成待確認（met）；不影響的、發布後才登錄的、還沒核准的不記', () => {
  const db = freshDb(), ev = (m) => db.prepare(Q.PB_EVAL(Q.SCOPE.member)).all(m).map((r) => [r.id, r.status]);
  const del = (id, m) => { db.prepare(Q.BASE_DEL).run(id, m); db.prepare('DELETE FROM pb_records WHERE id = ?').run(id); };
  const flags = (m) => db.prepare('SELECT campaign_id FROM ach_base_del WHERE member_id = ? ORDER BY campaign_id').all(m).map((r) => r.campaign_id);
  camp(db, 'b1', 'pb', { dist: 'fm', opened: '2026-09-01 00:00:00' });   // 開始 2026-10-01
  camp(db, 'b2', 'pb', { dist: null, opts: { first_ok: 1 }, opened: '2026-09-01 00:00:00' });
  camp(db, 'b3', 'time', { dist: 'fm', target: 14400, opts: { first_time: 1 }, opened: '2026-09-01 00:00:00' });
  camp(db, 'b4', 'pace', { dist: 'fm', target: 3, status: 'draft', opened: null });
  camp(db, 'b5', 'pb', { dist: 'fm', status: 'settled', settled: '2020-01-01 00:00:00', opened: '2026-09-01 00:00:00' });
  // a：發布前登錄的 3:30、3:45、3:50；期間內 3:40 沒有破 3:30
  const p330 = pb(db, 'a', 'fm', 12600, '2026-03-01', { created: '2026-04-01 00:00:00' });
  pb(db, 'a', 'fm', 13500, '2026-05-01', { created: '2026-05-02 00:00:00' });
  const p350 = pb(db, 'a', 'fm', 13800, '2026-06-01', { created: '2026-06-02 00:00:00' });
  const late = pb(db, 'a', 'fm', 12000, '2026-02-01', { created: '2026-09-10 00:00:00' });   // 發布後才補登的開始前成績（只會讓基準更難）
  const pend = pb(db, 'a', 'fm', 11000, '2026-01-01', { status: 'pending', created: '2026-04-01 00:00:00' });
  join(db, 'ba', 'b1', 'a');
  pb(db, 'a', 'fm', 13200, '2026-10-10');
  assert.deepEqual(ev('a'), []);
  del(p350, 'a'); del(pend, 'a'); del(late, 'a');
  assert.deepEqual(flags('a'), [], '刪較慢的、還沒核准的、發布後才登錄的：基準不會變容易');
  assert.deepEqual(ev('a'), []);
  del(p330, 'a');
  assert.deepEqual(flags('a'), ['b1', 'b2'], '破 PB（全馬與任一距離：基準變慢）；首次破 4 還有 3:45 不受影響；草稿與已結算超過 60 天的不記；參加了沒有都記');
  assert.deepEqual(ev('a'), [['ba', 'met']], '基準變成 3:45，3:40 判定達成但要幹部確認');
  assert.equal(db.prepare("SELECT achieved_at FROM ach_entries WHERE id = 'ba'").get().achieved_at, null);
  // b：first_ok 的挑戰裡唯一一筆開始前的成績 → 記下（不然刪掉就變成「第一次」）；還有別筆就不影響
  const only = pb(db, 'b', '10k', 3000, '2026-05-01', { created: '2026-05-01 00:00:00' });
  join(db, 'bb', 'b2', 'b');
  pb(db, 'b', '10k', 3100, '2026-10-05');
  assert.deepEqual(ev('b'), [], '沒有破 10K 的基準');
  del(only, 'b');
  assert.deepEqual(flags('b'), ['b2']);
  assert.deepEqual(ev('b'), [['bb', 'met']], '刪掉之後變成「第一次」：要幹部確認');
  // c：開始前有兩筆破 4 → 刪掉快的那筆，首次破 4 不受影響（還有一筆）；破 PB 的基準變慢了照樣記
  const c1 = pb(db, 'c', 'fm', 14000, '2026-03-01', { created: '2026-04-01 00:00:00' });
  pb(db, 'c', 'fm', 14200, '2026-04-01', { created: '2026-04-02 00:00:00' });
  del(c1, 'c');
  assert.deepEqual(flags('c'), ['b1', 'b2']);
  // d：唯一一筆開始前就破 4 的被刪 → 首次破 4 也記（刪掉就變成「第一次」）
  const d1 = pb(db, 'd', 'fm', 14000, '2026-03-01', { created: '2026-04-01 00:00:00' });
  pb(db, 'd', 'fm', 15000, '2026-02-01', { created: '2026-04-01 00:00:00' });
  del(d1, 'd');
  assert.deepEqual(flags('d'), ['b1', 'b2', 'b3']);
});

test('KMA_EVAL：里程凍結（結束後第 4 天 00:00 台北之後新增或修改的不算；沒改過的 updated_at 是 NULL 也算）、單筆 100 公里；出席只算指定的團練與分團', () => {
  const db = freshDb();
  camp(db, 'k1', 'km', { target: 150, confirm: true, start: '2026-10-01', end: '2026-10-31', rewards: { shirt: { sizes: ['M'], quota: 1 } } });
  camp(db, 'k2', 'km', { target: 150, start: '2026-10-01', end: '2026-10-31' });
  join(db, 'ka', 'k1', 'a'); join(db, 'kb', 'k2', 'b'); join(db, 'kc', 'k2', 'c');
  const log = (m, id, date, km, created = '2026-10-31 00:00:00', updated = null, status = 'done') => db.prepare(`INSERT INTO training_logs (id, member_id, date, status, km, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, m, date, status, km, created, updated);
  log('a', 'l1', '2026-10-05', 120);      // 只算 100
  log('a', 'l2', '2026-10-09', 50);       // 到這天累積 150
  log('a', 'l3', '2026-10-20', 30, '2026-11-03 15:59:59');   // F＝2026-11-03 16:00:00（UTC）之前補記：算
  log('b', 'l4', '2026-10-10', 100);
  log('b', 'l5', '2026-10-11', 49);
  log('b', 'l6', '2026-10-12', 10, '2026-11-03 16:00:00');   // F 之後新增：不算
  log('b', 'l7', '2026-10-13', 10, '2026-10-20 00:00:00', '2026-11-04 00:00:00');   // F 之後修改：不算
  log('b', 'l8', '2026-10-14', 10, '2026-10-20 00:00:00', null, 'skip');
  log('c', 'l9', '2026-10-01', 150);      // 只算 100
  db.prepare(Q.KMA_EVAL).run('k1');
  db.prepare(Q.KMA_EVAL).run('k2');
  assert.deepEqual(st(db, 'ka'), { status: 'met', evidence: '180.0', rank_key: '2026-10-09 00:00:00', reward_state: null, reward_rank: null }, '要確認的是 met');
  assert.deepEqual(st(db, 'kb'), { status: 'not_met', evidence: '149.0', rank_key: null, reward_state: null, reward_rank: null });
  assert.equal(st(db, 'kc').evidence, '100.0');
  // 出席：只算 track／core／long（預設）、分團挑戰只算那個分團
  camp(db, 'a1', 'attend', { target: 2, start: '2026-10-01', end: '2026-10-31', team: 'youth' });
  join(db, 'aa', 'a1', 'd');
  const ev = (id, kind, date, team = 'youth') => { db.prepare("INSERT INTO events (id, kind, title, date, status, team_id) VALUES (?, ?, '團練', ?, 'open', ?)").run(id, kind, date, team);
    db.prepare("INSERT INTO signups (id, event_id, member_id, name, grp, status, attended_at) VALUES (?, ?, 'd', '丁', 'D', 'in', '2026-10-02 00:00:00')").run(`s${id}`, id); };
  ev('x1', 'track', '2026-10-03'); ev('x2', 'party', '2026-10-04'); ev('x3', 'claim', '2026-10-05'); ev('x4', 'long', '2026-10-06', 'main'); ev('x5', 'core', '2026-10-07');
  db.prepare(Q.KMA_EVAL).run('a1');
  assert.deepEqual(st(db, 'aa'), { status: 'achieved', evidence: '2', rank_key: '2026-10-07 00:00:00', reward_state: null, reward_rank: null });
});

test('RANK／PROMOTE／DUPMARK：依達成先後分配、名額滿候補、之後才排的接在最後；放棄遞補；同款團服一人一件', () => {
  const db = freshDb(), shirt = (pool = null, quota = 2) => ({ shirt: { sizes: ['M'], quota, size_by: '2027-01-15', chart: null, pool } });
  camp(db, 's1', 'km', { status: 'settled', rewards: shirt('團服') });
  join(db, 'e1', 's1', 'a', { status: 'achieved', rank: '2026-10-05 00:00:00' });
  join(db, 'e2', 's1', 'b', { status: 'met', rank: '2026-10-03 00:00:00' });
  join(db, 'e3', 's1', 'c', { status: 'achieved', rank: '2026-10-04 00:00:00' });
  join(db, 'e4', 's1', 'd', { status: 'not_met' });
  db.prepare(Q.RANK(Q.SCOPE.campaign)).run('s1');
  assert.deepEqual([st(db, 'e2'), st(db, 'e3'), st(db, 'e1')].map((r) => [r.reward_state, r.reward_rank]), [['granted', 1], ['granted', 2], ['waitlist', 3]]);
  assert.equal(st(db, 'e4').reward_state, null);
  // 之後才達成的（例如補核准）接在最後、有人在候補時不插隊
  db.prepare("UPDATE ach_entries SET status = 'achieved', rank_key = '2026-10-01 00:00:00' WHERE id = 'e4'").run();
  db.prepare(Q.RANK(Q.SCOPE.member)).run('d');
  assert.deepEqual([st(db, 'e4').reward_state, st(db, 'e4').reward_rank], ['waitlist', 4]);
  // 放棄名額 → 遞補第一位候補
  db.prepare("UPDATE ach_entries SET reward_state = 'declined' WHERE id = 'e2'").run();
  assert.deepEqual(db.prepare(Q.PROMOTE(Q.SCOPE.campaigns)).all(JSON.stringify(['s1'])).map((r) => r.id), ['e1']);
  assert.equal(st(db, 'e4').reward_state, 'waitlist');
  // 同款團服：在 s1 拿到名額的人，在同 pool 的 s2 是 dup（不佔名額）
  camp(db, 's2', 'km', { status: 'settled', rewards: shirt('團服', 1) });
  join(db, 'f1', 's2', 'a', { status: 'achieved', rank: '2026-10-01 00:00:00' });
  join(db, 'f2', 's2', 'd', { status: 'achieved', rank: '2026-10-02 00:00:00' });
  join(db, 'f3', 's2', 'b', { status: 'achieved', rank: '2026-10-03 00:00:00' });
  db.prepare(Q.RANK(Q.SCOPE.campaign)).run('s2');
  assert.deepEqual(['f1', 'f2', 'f3'].map((x) => st(db, x).reward_state), ['dup', 'granted', 'waitlist'], 'a 已在 s1 拿到；d 拿 s2 的名額');
  // d 在 s1 的候補：之後 s1 有名額時 PROMOTE 跳過他（已在 s2 拿到），DUPMARK 改成 dup
  db.prepare("UPDATE ach_entries SET reward_state = 'declined' WHERE id = 'e3'").run();
  assert.deepEqual(db.prepare(Q.PROMOTE(Q.SCOPE.all)).all().map((r) => r.id), [], 'e4（d）跳過');
  db.prepare(Q.DUPMARK()).run();
  assert.equal(st(db, 'e4').reward_state, 'dup');
  // dup 的人「我還是想要這一件」：回到 NULL、重新排在最後
  db.prepare("UPDATE ach_entries SET reward_state = NULL, reward_rank = NULL WHERE id = 'f1'").run();
  db.prepare("UPDATE ach_entries SET reward_state = 'declined' WHERE id = 'e1'").run();
  db.prepare(Q.RANK(Q.SCOPE.member)).run('a');
  assert.deepEqual([st(db, 'f1').reward_state, st(db, 'f1').reward_rank], ['waitlist', 4]);
  // 同一句 PROMOTE 裡同一位跑友在兩個同款挑戰都輪到：只補結算早的那一邊，另一邊等 DUPMARK 改成 dup 後補給下一位
  camp(db, 'p1', 'km', { status: 'settled', settled: '2026-11-01 00:00:00', rewards: shirt('同款', 1) });
  camp(db, 'p2', 'km', { status: 'settled', settled: '2026-11-02 00:00:00', rewards: shirt('同款', 1) });
  const w = (id, cid, m, rk) => { join(db, id, cid, m, { status: 'achieved', rank: '2026-10-01 00:00:00', reward: 'waitlist' }); db.prepare('UPDATE ach_entries SET reward_rank = ? WHERE id = ?').run(rk, id); };
  w('h1', 'p1', 'c', 1); w('h2', 'p1', 'd', 2);
  w('h3', 'p2', 'c', 1); w('h4', 'p2', 'b', 2);
  assert.deepEqual(db.prepare(Q.PROMOTE(Q.SCOPE.all)).all().map((r) => r.id).sort(), ['h1'], 'c 只拿 p1 的；p2 這一句不補');
  assert.equal(st(db, 'h3').reward_state, 'waitlist');
  db.prepare(Q.DUPMARK()).run();
  assert.equal(st(db, 'h3').reward_state, 'dup');
  assert.deepEqual(db.prepare(Q.PROMOTE(Q.SCOPE.all)).all().map((r) => r.id), ['h4']);
  // 不限量
  camp(db, 's3', 'km', { status: 'settled', rewards: shirt(null, null) });
  for (const [i, m] of ['a', 'b', 'c'].entries()) join(db, `g${i}`, 's3', m, { status: 'achieved', rank: `2026-10-0${i + 1} 00:00:00` });
  db.prepare(Q.RANK(Q.SCOPE.campaign)).run('s3');
  assert.deepEqual(['g0', 'g1', 'g2'].map((x) => st(db, x).reward_state), ['granted', 'granted', 'granted']);
});

test('恭喜榜與排行：只列打開恭喜榜的人、排行另外同意；私密分團的主團只回給同團的人；同秒同日並列', () => {
  const db = freshDb();
  db.exec(`UPDATE members SET cheer_board = 1, cheer_rank = 1 WHERE id IN ('a', 'b');
    UPDATE members SET cheer_board = 1, cheer_rank = 0 WHERE id = 'c';
    UPDATE members SET main_team = 'core' WHERE id = 'a';
    UPDATE teams SET private = 1 WHERE id = 'core';`);
  const ok = (m, sec, date) => db.prepare(`INSERT INTO pb_records (id, member_id, dist_key, km, seconds, race_name, race_date, status, pb_kind, review_at)
    VALUES (?, ?, 'fm', 42.195, ?, '賽', ?, 'approved', 'break', datetime('now', '-1 days'))`).run(`r${++n}`, m, sec, date);
  const recent = date('now');
  ok('a', 12000, recent); ok('b', 12000, recent); ok('c', 11000, recent); ok('d', 10000, recent);
  const rows = db.prepare(Q.BOARD_RECENT).all('b', null, null, null);
  assert.deepEqual(rows.map((r) => r.mid).sort(), ['a', 'b', 'c'], '沒打開的 d 不出現');
  assert.equal(rows.find((r) => r.mid === 'a').main_team, null, '私密分團 core 的 id 不回給別團的人');
  db.exec("INSERT INTO team_members (team_id, member_id, status) VALUES ('core', 'b', 'active')");
  assert.equal(db.prepare(Q.BOARD_RECENT).all('b', null, null, null).find((r) => r.mid === 'a').main_team, 'core');
  const rank = db.prepare(Q.BOARD_RANK).all('fm', 'c', null, null);
  assert.deepEqual(rank.map((r) => [r.member_id, r.rk]), [['a', 1], ['b', 1]], '同秒同日並列；c 沒有同意排行');
  // 游標：比 (at, item) 小的
  const all = db.prepare(Q.BOARD_RECENT).all('b', null, null, null);
  const next = db.prepare(Q.BOARD_RECENT).all('b', all[0].at, all[0].item, null);
  assert.equal(next.length, all.length - 1);
  // 按恭喜前的判斷
  const p = db.prepare("SELECT id FROM pb_records WHERE member_id = 'd'").get().id;
  assert.deepEqual({ ...db.prepare(Q.CHEER_PB).get('a', p) }, { owner: 'd', seen: 0 });
});
function date(x) { return new DatabaseSync(':memory:').prepare(`SELECT date(?, '+8 hours', '-10 days') AS d`).get(x).d; }

test('每日清理：RETENTION 四句與每小時那一句的 ach_ret 位元一致（沒東西要清就不送）', () => {
  const db = freshDb(), probe = () => db.prepare(`SELECT ${Q.RETENTION_PROBE} AS r`).get().r;
  assert.equal(probe(), 0);
  camp(db, 'x1', 'weight', { status: 'cancelled', opts: { verify: 'witness' } });
  db.prepare("INSERT INTO ach_private (campaign_id, member_id, enc) VALUES ('x1', 'a', 'v1.x.y')").run();
  db.prepare(`INSERT INTO pb_records (id, member_id, dist_key, km, seconds, race_name, race_date, status, note, review_at)
    VALUES ('old', 'b', 'fm', 42.195, 14000, '賽', '2025-01-01', 'rejected', '說明', datetime('now', '-181 days'))`).run();
  db.prepare("INSERT INTO pb_proofs (pb_id, img) VALUES ('old', 'data:image/webp;base64,AA')").run();
  assert.equal(probe(), 15);
  const n = Q.RETENTION.map(([, sql]) => db.prepare(sql).run().changes);
  assert.deepEqual(n, [1, 1, 1, 1]);
  assert.equal(probe(), 0);
});
