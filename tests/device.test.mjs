// 共用裝置換人：上一位的離線暫存、API 暫存、分享暫存與推播訂閱都要清掉（public/device.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindOwner, bootFor, sessionEnded, OWNER_KEY } from '../public/device.js';

const mkStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const mkDeps = (init) => {
  const deleted = [], dropped = [];
  return { deleted, dropped, storage: mkStorage(init), caches: { delete: async (k) => { deleted.push(k); return true; } }, dropPush: async () => { dropped.push(1); } };
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
