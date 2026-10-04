// 共用裝置換人：上一位的離線暫存、API 暫存、分享暫存與推播訂閱都要清掉（public/device.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindOwner, bootFor, sessionEnded, clearLocal, pushReady, markPush, mayRebind, takeResume, OWNER_KEY, LOCAL_KEYS, PUSH_RESUME_KEY } from '../public/device.js';

const mkStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const mkDeps = (init, sess = {}) => {
  const deleted = [], dropped = [], resets = [];
  return { deleted, dropped, resets, storage: mkStorage(init), session: mkStorage(sess), caches: { delete: async (k) => { deleted.push(k); return true; } },
    dropPush: async () => { dropped.push(1); }, reset: () => { resets.push(1); } };
};

test('換另一個人登入：清掉上一位的 localStorage、API 與分享暫存，並取消推播訂閱', async () => {
  const d = mkDeps({ [OWNER_KEY]: 'A', 'cil-log-queue': '[1]', 'cil-coach': '{}' });
  const p = bindOwner('B', d);
  // 同步就清掉 localStorage（flushLogQueue 緊接著讀暫存區，不能等非同步）
  assert.equal(d.storage.getItem('cil-log-queue'), null);
  assert.equal(d.storage.getItem('cil-coach'), null);
  assert.equal(await p, 'switched');
  assert.equal(d.storage.getItem(OWNER_KEY), 'B');
  assert.deepEqual(d.deleted.sort(), ['cil-api', 'cil-share']);
  assert.equal(d.dropped.length, 1, '推播訂閱還綁著上一位，要取消');
});

test('同一個人重新登入：什麼都不清', async () => {
  const d = mkDeps({ [OWNER_KEY]: 'A', 'cil-log-queue': '[1]' });
  assert.equal(await bindOwner('A', d), 'same');
  assert.equal(d.storage.getItem('cil-log-queue'), '[1]');
  assert.deepEqual(d.deleted, []);
  assert.equal(d.dropped.length, 0);
});

test('第一次綁定：API 暫存不確定是誰的，清掉；推播與分享暫存不動', async () => {
  const d = mkDeps({});
  assert.equal(await bindOwner('A', d), 'bound');
  assert.deepEqual(d.deleted, ['cil-api']);
  assert.equal(d.dropped.length, 0);
});

test('讀不到 localStorage：不清也不綁', async () => {
  const d = mkDeps({});
  d.storage.getItem = () => { throw new Error('blocked'); };
  assert.equal(await bindOwner('A', d), 'none');
  assert.deepEqual(d.deleted, []);
});

test('先畫後抓：只用目前主人的那份上次資料', () => {
  const s = mkStorage({ [OWNER_KEY]: 'B' });
  assert.equal(bootFor({ member: { id: 'A' } }, s), null, '上一位的首頁不能先畫出來');
  assert.ok(bootFor({ member: { id: 'B' } }, s));
  assert.equal(bootFor({ member: { id: 'A' } }, mkStorage({})), null, '沒有主人標記也不用');
  assert.equal(bootFor({ member: null }, s), null);
});

test('伺服器說沒有登入：清掉 API 暫存', async () => {
  const d = mkDeps({ [OWNER_KEY]: 'A' });
  await sessionEnded(d);
  assert.deepEqual(d.deleted, ['cil-api']);
  assert.equal(d.storage.getItem(OWNER_KEY), 'A', '主人標記保留，換人時才清未送出的紀錄');
});

// ---- 換人與登出要清的其他個人資料（GPS 軌跡、草稿等）、主人不明、推播 ----
const TRACK = JSON.stringify({ status: 'running', points: [{ lat: 25.07, lon: 121.54 }] });

test('換人：跑步中的 GPS 軌跡（位置資料）、分團篩選、地圖位置、推播主人與草稿都清掉，記憶體裡的這次跑步也丟掉', async () => {
  const d = mkDeps({ [OWNER_KEY]: 'A', 'cil-run-session': TRACK, 'cil-team': 'youth', 'cil-map-view': '[25.07,121.54,15]', 'cil-push-owner': 'A', 'cil-lang': 'en' },
    { 'cil-ev-draft': '{}', 'cil-after-reg': '{}', 'cil-after-login': '#/e/x' });
  const p = bindOwner('B', d);
  for (const k of ['cil-run-session', 'cil-team', 'cil-map-view', 'cil-push-owner']) assert.equal(d.storage.getItem(k), null, k);
  assert.equal(d.session.getItem('cil-ev-draft'), null); assert.equal(d.session.getItem('cil-after-reg'), null);
  assert.equal(d.session.getItem('cil-after-login'), '#/e/x', '登入後要回去的頁面保留');
  assert.equal(d.storage.getItem('cil-lang'), 'en', '語言是裝置偏好，不清');
  assert.equal(d.resets.length, 1, 'run.js 已經讀進記憶體的軌跡也要丟掉');
  assert.equal(await p, 'switched');
});

test('沒有主人標記（舊版、登出後）卻有未送出的訓練紀錄：當成別人的，清掉而且不會用新帳號送出', async () => {
  for (const k of ['cil-log-queue', 'cil-coach', 'cil-run-session']) {
    const d = mkDeps({ [k]: k === 'cil-run-session' ? TRACK : '[{"date":"2026-10-01"}]' });
    const p = bindOwner('B', d);
    assert.equal(d.storage.getItem(k), null, `${k} 同步就清掉（flushLogQueue 緊接著讀）`);
    assert.equal(await p, 'switched', k);
    assert.equal(d.storage.getItem(OWNER_KEY), 'B');
    assert.deepEqual(d.deleted.sort(), ['cil-api', 'cil-share']);
    assert.equal(d.dropped.length, 1, '推播訂閱也不知道是誰的，取消');
  }
  // 空的暫存區不算資料
  const e = mkDeps({ 'cil-log-queue': '[]' });
  assert.equal(await bindOwner('B', e), 'bound');
  assert.equal(e.dropped.length, 0);
});

test('伺服器說沒有登入：清掉 API 暫存並取消推播訂閱（主人標記與未送出的紀錄保留給同一個人）', async () => {
  const d = mkDeps({ [OWNER_KEY]: 'A', 'cil-log-queue': '[1]' });
  await sessionEnded(d);
  assert.deepEqual(d.deleted, ['cil-api']);
  assert.equal(d.dropped.length, 1, '上一位的通知不會繼續出現在這台的鎖定畫面');
  assert.equal(d.storage.getItem('cil-log-queue'), '[1]');
});

test('登出：所有屬於帳號的 localStorage、主人標記與草稿都清掉', () => {
  const init = Object.fromEntries([...LOCAL_KEYS, OWNER_KEY].map((k) => [k, 'x']));
  const d = mkDeps({ ...init, 'cil-theme': 'dark' }, { 'cil-ev-draft': '{}' });
  clearLocal(d);
  for (const k of [...LOCAL_KEYS, OWNER_KEY]) assert.equal(d.storage.getItem(k), null, k);
  assert.ok(LOCAL_KEYS.includes('cil-run-session'), 'GPS 軌跡在清單裡');
  assert.equal(d.storage.getItem('cil-theme'), 'dark');
  assert.equal(d.session.getItem('cil-ev-draft'), null);
  assert.equal(d.resets.length, 1);
});

test('換人時取消推播還沒做完：通知設定要等它做完才讀訂閱（不會把上一位的訂閱重新綁到新的人）', async () => {
  let release, done = false;
  const d = mkDeps({ [OWNER_KEY]: 'A' });
  d.dropPush = () => new Promise((r) => { release = () => { done = true; r(); }; });
  const p = bindOwner('B', d);
  let ready = false;
  const w = pushReady().then(() => { ready = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ready, false, '取消訂閱還在進行中');
  release();
  await w; await p;
  assert.equal(done, true);
  assert.equal(ready, true);
});

test('推播訂閱是誰開的：只有開的人才會被悄悄重新綁定', () => {
  const s = mkStorage({});
  assert.equal(mayRebind(s, 'B'), false, '不知道是誰開的（舊版的訂閱）不自動綁');
  markPush(s, 'A');
  assert.equal(mayRebind(s, 'A'), true);
  assert.equal(mayRebind(s, 'B'), false, '上一位開的訂閱不綁到新的人');
  markPush(s, null);
  assert.equal(mayRebind(s, 'A'), false);
});

// ---- 升級（這個版本之前的裝置沒有主人標記）、登入過期後的推播 ----
test('升級後第一次開啟：沒有主人標記，但上次的 /api/me 暫存是同一個人 → 認領，身體資料、跑到一半的軌跡、未送出的紀錄與推播都不動', async () => {
  const d = mkDeps({ 'cil-coach': '{"age":40}', 'cil-run-session': TRACK, 'cil-log-queue': '[{"date":"2026-10-01"}]' });
  let asked = 0;
  d.priorOwner = async () => 'A'; d.ask = async () => { asked++; return false; };
  assert.equal(await bindOwner('A', d), 'adopted');
  for (const k of ['cil-coach', 'cil-run-session', 'cil-log-queue']) assert.notEqual(d.storage.getItem(k), null, k);
  assert.equal(d.storage.getItem(OWNER_KEY), 'A');
  assert.deepEqual(d.deleted, [], 'API 暫存是他自己的，不刪');
  assert.equal(d.dropped.length, 0, '推播不取消');
  assert.equal(d.resets.length, 0);
  assert.equal(asked, 0, '認得出來就不用問');
  assert.equal(await bindOwner('A', d), 'same');
});

test('主人不明、上次的暫存是別人（或沒有暫存）：問本人，回答是自己的才保留；同時呼叫只問一次', async () => {
  const keep = mkDeps({ 'cil-coach': '{"age":40}' });
  let asked = 0;
  keep.priorOwner = async () => 'A'; keep.ask = async () => { asked++; return true; };
  const [r1, r2] = await Promise.all([bindOwner('B', keep), bindOwner('B', keep)]);
  assert.equal(r1, 'adopted'); assert.equal(r2, 'adopted');
  assert.equal(asked, 1, '首頁與離線補傳同時綁定，只問一次');
  assert.equal(keep.storage.getItem('cil-coach'), '{"age":40}');
  assert.equal(keep.storage.getItem(OWNER_KEY), 'B');
  const drop = mkDeps({ 'cil-coach': '{"age":40}', 'cil-log-queue': '[1]' });
  drop.priorOwner = async () => null; drop.ask = async () => false;
  assert.equal(await bindOwner('B', drop), 'switched');
  assert.equal(drop.storage.getItem('cil-coach'), null); assert.equal(drop.storage.getItem('cil-log-queue'), null);
  assert.equal(drop.dropped.length, 1);
  // 沒有資料就不用問
  const none = mkDeps({}); let q = 0;
  none.priorOwner = async () => 'A'; none.ask = async () => { q++; return true; };
  assert.equal(await bindOwner('B', none), 'bound'); assert.equal(q, 0);
});

test('有主人標記而且是別人：不問也不看暫存，直接清掉（換人一定清）', async () => {
  const d = mkDeps({ [OWNER_KEY]: 'A', 'cil-coach': '{}' });
  let asked = 0;
  d.priorOwner = async () => 'B'; d.ask = async () => { asked++; return true; };
  const p = bindOwner('B', d);
  assert.equal(d.storage.getItem('cil-coach'), null, '同步就清掉');
  assert.equal(await p, 'switched'); assert.equal(asked, 0);
});

test('登入過期：主人不明時先用 API 暫存認出主人再刪暫存；推播記下是誰的，同一個人重新登入才自動重新開啟', async () => {
  const d = mkDeps({ 'cil-coach': '{}', 'cil-push-owner': 'A' });
  d.priorOwner = async () => 'A'; d.dropPush = async () => { d.dropped.push(1); return true; };
  await sessionEnded(d);
  assert.equal(d.storage.getItem(OWNER_KEY), 'A', '刪 API 暫存前先記下主人');
  assert.deepEqual(d.deleted, ['cil-api']);
  assert.equal(d.dropped.length, 1, '上一位的通知不會繼續出現在這台的鎖定畫面');
  assert.equal(d.storage.getItem(PUSH_RESUME_KEY), 'A');
  assert.equal(await bindOwner('A', d), 'same', '同一個人重新登入：不清');
  assert.equal(d.storage.getItem('cil-coach'), '{}');
  assert.equal(takeResume(d.storage, 'A'), true, '自動重新開啟推播');
  assert.equal(takeResume(d.storage, 'A'), false, '只回一次');
  // 換人登入：清掉，推播不會幫新的人重新開
  const e = mkDeps({ 'cil-coach': '{}', 'cil-push-owner': 'A' });
  e.priorOwner = async () => 'A'; e.dropPush = async () => true;
  await sessionEnded(e);
  assert.equal(await bindOwner('B', e), 'switched');
  assert.equal(e.storage.getItem(PUSH_RESUME_KEY), null, '換人時清掉');
  assert.equal(takeResume(e.storage, 'B'), false);
  // 原本沒有推播訂閱：不記
  const n = mkDeps({ [OWNER_KEY]: 'A' });
  n.dropPush = async () => false;
  await sessionEnded(n);
  assert.equal(n.storage.getItem(PUSH_RESUME_KEY), null);
  // 自己開啟推播後就不用再重新開
  const m = mkStorage({ [PUSH_RESUME_KEY]: 'A' });
  markPush(m, 'A');
  assert.equal(takeResume(m, 'A'), false);
  assert.ok(LOCAL_KEYS.includes(PUSH_RESUME_KEY), '登出也清');
});
