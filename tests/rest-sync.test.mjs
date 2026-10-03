// 跑者休息站：在電腦上同步的工具（tools/rest-sync.mjs）產生的 SQL，用本機 SQLite 套 migration 0040、0041 後實際執行
//   不需要伺服器、不連外（REST_MOCK 的假資料）；檢查完整性條件、只寫有變的列、停用消失的列、不動幹部的修正與隱藏、D1 單一指令上限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gather, buildSql, localSources, checkSql, checkRows, parseArgs, wranglerArgs } from '../tools/rest-sync.mjs';
import { control } from '../src/rest-mock.js';
import { SOURCES } from '../src/rest.js';

const env = { REST_MOCK: '1', DEV_LOGIN: '1' };
const mig = (f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT, nickname TEXT);');
  db.exec(mig('0040_rest_stops.sql'));
  db.exec(mig('0041_seed_rest_curated.sql'));
  return db;
}
const run = (db, stmts) => { for (const s of stmts) if (!s.startsWith('--')) db.exec(s); };
const src = (db, k) => db.prepare('SELECT * FROM rest_sources WHERE source = ?').get(k);
const row = (db, id) => db.prepare('SELECT * FROM rest_stops WHERE id = ?').get(id);
const live = (db, k) => db.prepare('SELECT COUNT(*) AS n FROM rest_stops WHERE source = ? AND enabled = 1').get(k).n;

test('只由維護工具同步的來源：大檔與多檔的都在清單上，Worker 排程只留兩個小來源（免費方案）', () => {
  assert.deepEqual(localSources().sort(), ['cpct', 'sav', 'tbk', 'tprv', 'tpt', 'twd']);
  assert.deepEqual(Object.keys(SOURCES).filter((k) => !SOURCES[k].manual && !SOURCES[k].local).sort(), ['ntrv', 'tpbk']);
});

test('維護工具的參數：預設只試跑；寫進資料庫一定要指定測試站或正式站；不讀金鑰', () => {
  assert.equal(parseArgs(['twd']).target, null, '預設試跑');
  assert.throws(() => parseArgs(['--apply']), /--env staging 或 --env production/);
  assert.throws(() => parseArgs(['--apply', '--env=prod']), /--env staging 或 --env production/);
  assert.deepEqual(wranglerArgs(parseArgs(['--apply', '--env=staging']).target, 'x.sql'), ['wrangler', 'd1', 'execute', 'cil-run-staging', '--remote', '--env', 'staging', '--file', 'x.sql']);
  assert.deepEqual(wranglerArgs(parseArgs(['--apply', '--env=production']).target, 'x.sql'), ['wrangler', 'd1', 'execute', 'cil-run', '--remote', '--file', 'x.sql']);
  assert.deepEqual(wranglerArgs(parseArgs(['--apply=local']).target, 'x.sql', '.st'), ['wrangler', 'd1', 'execute', 'cil-run', '--local', '--persist-to', '.st', '--file', 'x.sql']);
  const src = readFileSync(new URL('../tools/rest-sync.mjs', import.meta.url), 'utf8');
  assert.ok(!/process\.env\.[A-Z_]*(TOKEN|KEY|SECRET|PASS)/.test(src) && !/\.dev\.vars/.test(src), '不讀金鑰或 .dev.vars');
});

test('D1 限制與寫入前的第二道檢查：指令 100 KB、LIKE／GLOB 樣式 50 bytes、欄位白名單、電話、座標、開放時間', async () => {
  assert.doesNotThrow(() => checkSql(["SELECT 1 WHERE x LIKE 'rest.%'", "SELECT 1 WHERE x GLOB '[0-9]*'"]));
  assert.throws(() => checkSql([`SELECT 1 WHERE x GLOB '${'[0-9]'.repeat(11)}'`]), /LIKE／GLOB 樣式 55 bytes/);
  assert.throws(() => checkSql([`SELECT '${'臺'.repeat(34000)}'`]), /超過 D1 上限/);
  control(new URLSearchParams('reset=1'));
  const { rows } = await gather(env, 'twd');
  assert.doesNotThrow(() => checkRows('twd', rows));
  assert.throws(() => checkRows('twd', [{ ...rows[0], phone: '0223456789' }]), /不該存的欄位 phone/);
  assert.throws(() => checkRows('twd', [{ ...rows[0], place: '服務台 02-2345-6789' }]), /電話/);
  assert.throws(() => checkRows('twd', [{ ...rows[0], lat: 35, lng: 139 }]), /不在臺灣/);
  assert.throws(() => checkRows('twd', [{ ...rows[0], hours: '看天氣' }]), /開放時間看不懂/);
  assert.throws(() => checkRows('twd', [{ ...rows[0], id: 'tpt:x' }]), /代碼或類型不對/);
  assert.throws(() => buildSql('twd', { rows: [{ ...rows[0], manager: '王小明' }], tag: 'x' }), /不該存的欄位/, '有問題就不產生 SQL');
});

test('直飲臺：第一次寫入、沒變只記時間、少一筆照常更新並停用、掉到 70% 以下不寫、來源關閉不寫', async () => {
  control(new URLSearchParams('reset=1'));
  const db = fresh();
  const g1 = await gather(env, 'twd');
  run(db, buildSql('twd', g1));
  assert.equal(live(db, 'twd'), 5);
  let s = src(db, 'twd');
  assert.equal(s.last_count, 5); assert.equal(s.rev, 1); assert.equal(s.last_error, null); assert.equal(s.data_date, '2026-08-14');
  assert.equal(row(db, 'twd:D3').status, 'paused');
  assert.equal(row(db, 'twd:FAR1'), undefined, '國外座標不收');
  // 幹部的修正、補充說明、隱藏：同步不動
  db.exec(`UPDATE rest_stops SET fix = '{"name":"幹部改的名字"}', note = '在對岸', hidden = 1 WHERE id = 'twd:D2'`);
  // 一樣的內容：不寫、版本不變
  const before = db.prepare('SELECT updated_at, hash FROM rest_stops WHERE id = ?').get('twd:D1');
  run(db, buildSql('twd', await gather(env, 'twd')));
  s = src(db, 'twd');
  assert.equal(s.rev, 1, '沒變不加版本'); assert.ok(s.last_ok_at);
  assert.deepEqual(db.prepare('SELECT updated_at, hash FROM rest_stops WHERE id = ?').get('twd:D1'), before);
  // 少一筆（80%）：照常更新，停用消失的列
  control(new URLSearchParams('drop=1'));
  run(db, buildSql('twd', await gather(env, 'twd')));
  assert.equal(row(db, 'twd:D4').enabled, 0, '清單不再出現的停用（不刪除）');
  assert.equal(src(db, 'twd').rev, 2); assert.equal(src(db, 'twd').last_count, 4);
  const d2 = row(db, 'twd:D2');
  assert.equal(d2.fix, '{"name":"幹部改的名字"}'); assert.equal(d2.note, '在對岸'); assert.equal(d2.hidden, 1);
  // 掉到 70% 以下：不寫、不停用，記錯誤
  control(new URLSearchParams('drop=0&shrink=1'));
  run(db, buildSql('twd', await gather(env, 'twd')));
  s = src(db, 'twd');
  assert.match(s.last_error, /筆數從 4 掉到 1，這次不更新/);
  assert.equal(s.rev, 2); assert.equal(s.last_count, 4);
  assert.equal(live(db, 'twd'), 4, '一筆都沒有停用');
  // 恢復正常：清掉錯誤，D4 重新啟用
  control(new URLSearchParams('shrink=0'));
  run(db, buildSql('twd', await gather(env, 'twd')));
  assert.equal(src(db, 'twd').last_error, null); assert.equal(row(db, 'twd:D4').enabled, 1);
  // 管理後台關掉來源：什麼都不寫
  db.exec("UPDATE rest_sources SET enabled = 0 WHERE source = 'twd'");
  control(new URLSearchParams('drop=1'));
  const rev = src(db, 'twd').rev;
  run(db, buildSql('twd', await gather(env, 'twd')));
  assert.equal(row(db, 'twd:D4').enabled, 1); assert.equal(src(db, 'twd').rev, rev);
  control(new URLSearchParams('reset=1'));
});

test('臺灣騎跡（多檔）：一次抓完全部路線、跨路線同一處合併；整理清單與其他來源不受影響', async () => {
  control(new URLSearchParams('reset=1'));
  const db = fresh();
  const g = await gather(env, 'tbk');
  assert.equal(g.rows.length, 28);
  run(db, buildSql('tbk', g));
  assert.equal(live(db, 'tbk'), 28);
  const shared = db.prepare("SELECT svc FROM rest_stops WHERE source = 'tbk' AND name = '共用補給站'").all();
  assert.equal(shared.length, 1); assert.ok(shared[0].svc & 256, '兩條路線的服務旗標合併');
  assert.equal(db.prepare("SELECT access FROM rest_stops WHERE name LIKE '7-ELEVEN%'").get().access, 'customer');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rest_stops WHERE source = 'cur'").get().n, 3, '整理清單不動');
  control(new URLSearchParams('drop=1'));
  run(db, buildSql('tbk', await gather(env, 'tbk')));
  assert.equal(live(db, 'tbk'), 27);
  assert.equal(src(db, 'tbk').cursor, null);
  control(new URLSearchParams('reset=1'));
});

test('運動場館：不收管理人姓名與電話；每個 SQL 指令都在 D1 的 100 KB 上限內（大量列會分批）', async () => {
  control(new URLSearchParams('reset=1'));
  const g = await gather(env, 'sav');
  const sql = buildSql('sav', g).join('\n');
  assert.ok(!/王小明|2345-6789|2377-0300|管理人/.test(sql));
  // 3,000 列假資料：每批都不超過上限，全部寫得進去
  const many = Array.from({ length: 3000 }, (_, i) => ({ ...g.rows[0], id: `sav:x${i}`, name: `測試場館「${i}」O'Neil`, h: `h${i}` }));
  const stmts = buildSql('sav', { rows: many, tag: '{"h":"x"}', date: null });
  for (const s of stmts) assert.ok(Buffer.byteLength(s) <= 100000, `指令 ${Buffer.byteLength(s)} bytes`);
  assert.ok(stmts.filter((s) => s.startsWith('INSERT')).length > 1, '有分批');
  const db = fresh();
  run(db, stmts);
  assert.equal(live(db, 'sav'), 3000);
  assert.equal(row(db, 'sav:x7').name, "測試場館「7」O'Neil", '單引號有跳脫');
  // 空清單不產生 SQL；不能同步的來源
  assert.throws(() => buildSql('sav', { rows: [], tag: 'x' }), /清單是空的/);
  assert.throws(() => buildSql('cur', { rows: many, tag: 'x' }), /沒有這個來源/);
});
