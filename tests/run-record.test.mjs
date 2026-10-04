// 跑步記錄（public/run.js）：螢幕鎖定、訊號弱、等紅燈、連按計圈
//   用假的時鐘、定位、localStorage 與 document 載入 run.js，每秒呼叫一次 check()（跟 app.js 的 setInterval 一樣）
//   路線是 L 形：往北 600 公尺再往東，所以空檔用直線補的距離會比實際短一點（下限）
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LAT0 = 25.05, LON0 = 121.5, MLAT = 111320, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const T0 = Date.UTC(2026, 9, 4, 21, 50, 0);
let now = T0;
Date.now = () => now;
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const docListeners = [];
globalThis.document = { visibilityState: 'visible', addEventListener: (t, f) => docListeners.push([t, f]) };
let geoCb = null, wakeDeny = false;
const geo = { watchPosition(ok) { geoCb = ok; return 1; }, clearWatch() { geoCb = null; } };
// 假的 Wake Lock：release() 會通知 release 事件（系統放掉時也一樣）；wakeDeny 時拒絕（像低電量模式）
const sentinels = [];
const wakeLock = { request: async () => {
  if (wakeDeny) throw new DOMException('denied', 'NotAllowedError');
  const w = { released: false, fns: [], addEventListener(t, f) { if (t === 'release') this.fns.push(f); }, release() { if (this.released) return; this.released = true; for (const f of this.fns) f(); } };
  sentinels.push(w); return w;
} };
Object.defineProperty(globalThis, 'navigator', { value: { geolocation: geo, wakeLock }, configurable: true });
const flush = () => new Promise((r) => setImmediate(r));

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const jit = (m) => (rnd() * 2 - 1) * m;
const at = (m) => (m <= 600 ? { n: m, e: 0 } : { n: 600, e: m - 600 });
const toLL = ({ n, e }) => ({ lat: LAT0 + n / MLAT, lon: LON0 + e / MLON });

let caseNo = 0;
async function load({ keep = false } = {}) {
  if (!keep) { store.clear(); now = T0; }
  docListeners.length = 0; geoCb = null; seed = 7;
  return import(new URL(`../public/run.js?case=${++caseNo}`, import.meta.url).href);
}
// 模擬的世界：跑者在 L 形路線上的位置、GPS 精度、畫面上的計時
function world(Run) {
  const w = { Run, m: 0, acc: 5, noise: 1.5, moving: 0, asks: [], shown: [] };
  w.fix = () => {
    if (!geoCb) return;
    const off = w.acc > 40 ? 120 : w.noise, ll = toLL({ n: at(w.m).n + jit(off), e: at(w.m).e + jit(off) });
    geoCb({ timestamp: now, coords: { latitude: ll.lat, longitude: ll.lon, accuracy: w.acc, altitude: null, altitudeAccuracy: null } });
  };
  w.tick = () => { const k = Run.check(); if (k) w.asks.push(k); w.shown.push(Run.elapsed()); };
  // 網頁醒著：每秒移動、check()、收到一個定位點
  w.run = (sec, speed, { fixes = true } = {}) => {
    for (let i = 0; i < sec; i++) { now += 1000; w.m += speed; if (speed > 0) w.moving += 1000; w.tick(); if (fixes) w.fix(); }
  };
  // 螢幕鎖定：時間在走、人在跑，程式完全不動
  w.freeze = (sec, speed) => { now += sec * 1000; w.m += speed * sec; if (speed > 0) w.moving += sec * 1000; };
  w.wake = () => { for (const [t, f] of docListeners) if (t === 'visibilitychange') f(); };
  w.backwards = () => { let b = 0; for (let i = 1; i < w.shown.length; i++) b = Math.max(b, w.shown[i - 1] - w.shown[i]); return b; };
  return w;
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a}，應該接近 ${b}（±${tol}）`);

test('(a) 跑步中鎖定螢幕 5 分鐘，解鎖後先跑 check()：計時照走、距離用直線補上，不暫停也不問跑完了嗎', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 1000 / 300;
  w.run(120, v);
  w.freeze(300, v);
  w.tick();                                  // 解鎖：計時器先跑
  assert.equal(Run.session().status, 'running', '解鎖當下不能自動暫停');
  assert.ok(Run.session().gap, '要記下這段空檔');
  w.run(120, v);
  assert.deepEqual(w.asks, [], '不應該問「跑完了嗎」');
  assert.equal(w.backwards(), 0, '計時不能倒退');
  Run.finish();
  const r = Run.summary();
  near(r.seconds, w.moving / 1000, 3, '時間');
  assert.ok(r.distance >= 1550 && r.distance <= w.m + 20, `距離 ${Math.round(r.distance)} 要接近實際 ${Math.round(w.m)}（直線補的是下限）`);
  assert.ok(r.est > 700 && r.est < 1100, `估算距離 ${r.est}`);
  near(r.estSec, 300, 3, '估算時間');
});

test("(a') 鎖定螢幕 5 分鐘，解鎖後定位點先到：結果一樣", async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 1000 / 300;
  w.run(120, v);
  w.freeze(300, v);
  w.wake();
  w.fix(); w.tick();
  w.run(120, v);
  Run.finish();
  const r = Run.summary();
  assert.deepEqual(w.asks, []);
  near(r.seconds, w.moving / 1000, 3, '時間');
  assert.ok(r.est > 700, `估算距離 ${r.est}`);
  assert.ok(r.distance >= 1550, `距離 ${Math.round(r.distance)}`);
});

test('(b) 移動中 2 分鐘訊號弱（±240 m）：不自動暫停，訊號回來後用直線補', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 1000 / 360;
  w.run(120, v);
  w.acc = 240;
  w.run(120, v);
  assert.equal(Run.session().status, 'running', '訊號弱不等於停下來');
  assert.equal(Run.session().gps, 'weak');
  w.acc = 5;
  w.run(120, v);
  Run.finish();
  const r = Run.summary();
  assert.equal(w.backwards(), 0, '計時不能倒退');
  near(r.seconds, w.moving / 1000, 3, '時間');
  near(r.distance, w.m, 80, '距離');
  assert.ok(r.est > 250 && r.est < 360, `估算距離 ${r.est}`);
});

test('(c) 等紅燈 60 秒、GPS 良好：照常自動暫停、自動繼續，接起來的那段距離照算', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 1000 / 330;
  w.run(120, v);
  w.run(60, 0);
  assert.equal(Run.session().status, 'paused');
  assert.equal(Run.session().auto, true);
  w.run(120, v);
  assert.equal(Run.session().status, 'running');
  Run.finish();
  const r = Run.summary();
  near(r.seconds, w.moving / 1000, 6, '時間（停下來的 60 秒不算）');
  near(r.distance, w.m, 35, '距離（±1.5 m 雜訊會多算一點）');
  assert.equal(r.est, 0, '沒有空檔，不用估算');
  assert.deepEqual(w.asks, []);
});

test('站著沒有定位點（手機不回報），回來的點還在原地：從最後一次移動起自動暫停', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3;
  w.run(60, v);
  w.run(90, 0, { fixes: false });
  assert.equal(Run.session().status, 'running', '沒有定位點時不暫停');
  w.run(1, 0);
  assert.equal(Run.session().status, 'paused');
  w.run(30, v);
  Run.finish();
  const r = Run.summary();
  near(r.seconds, w.moving / 1000, 4, '時間');
  assert.equal(r.est, 0);
});

test('空檔後快得不合理（搭車）：路線斷開、距離不算，計時照走', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run);
  w.run(60, 3);
  const d0 = Run.session().dist;
  w.freeze(60, 0); w.m += 2000;              // 1 分鐘「移動」2 公里
  w.tick(); w.fix();
  assert.equal(Run.session().status, 'running');
  near(Run.session().dist, d0, 1, '距離不算');
  assert.ok(Run.session().points.some((p) => p.brk), '路線斷開');
  w.run(30, 3);
  Run.finish();
  near(Run.summary().seconds, 151, 2, '時間');
});

test('空檔中重新整理頁面：存下來的狀態接著用，回來的點照樣補上', async () => {
  let Run = await load(); Run.start({ useGps: true });
  let w = world(Run);
  const v = 1000 / 300;
  w.run(120, v);
  w.freeze(30, v); w.tick();                  // 凍結回來，空檔開著
  assert.ok(Run.session().gap);
  w.freeze(60, v);
  const m = w.m, moving = w.moving;
  Run = await load({ keep: true });          // 重新整理：重新載入模組，從 localStorage 讀回來
  w = world(Run); w.m = m; w.moving = moving;
  assert.ok(Run.session().gap, '空檔要存起來');
  assert.ok(geoCb, '重新整理後繼續接 GPS');
  w.run(60, v);
  Run.finish();
  const r = Run.summary();
  near(r.seconds, w.moving / 1000, 3, '時間');
  assert.ok(r.est > 200, `估算距離 ${r.est}`);   // 400→(600 北, 100 東) 的直線約 224 公尺
});

test('(d) 0.6 秒內連按兩次計圈：只算一圈，進行中的這一圈即時算', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run);
  now += 1000; assert.equal(Run.lap(), false, '剛開始 3 秒內不算');
  w.run(90, 3);
  assert.equal(Run.currentLap(), null, '還沒記過圈：沒有進行中的圈');
  assert.equal(Run.lap(), true);
  now += 600; assert.equal(Run.lap(), false, '0.6 秒後再按不算');
  w.run(60, 3);
  assert.equal(Run.session().laps.length, 1);
  const c = Run.currentLap();
  assert.equal(c.n, 2);
  near(c.sec, 60.6, 0.01, '進行中這一圈的時間');
  near(c.m, 180, 15, '進行中這一圈的距離');
  w.run(5, 3);
  assert.equal(Run.lap(), true, '超過 3 秒可以再記');
  Run.finish();
  assert.deepEqual(Run.summary().laps.map((l) => l.n), [1, 2], '成績只留完成的圈');
});

test('Wake Lock：被系統放掉時狀態變成 off，回到前景再要一次；被拒絕時是 denied', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run);
  await flush();
  assert.equal(Run.awake(), 'on');
  sentinels.at(-1).release();                // 系統放掉（切到背景、省電）
  assert.equal(Run.awake(), 'off');
  document.visibilityState = 'hidden'; w.wake();
  document.visibilityState = 'visible'; w.wake();
  await flush();
  assert.equal(Run.awake(), 'on', '回到前景再要一次');
  wakeDeny = true;
  sentinels.at(-1).release();
  Run.keepAwake(); await flush();
  assert.equal(Run.awake(), 'denied');
  wakeDeny = false;
  Run.pause();
  assert.equal(Run.awake(), 'off', '暫停時放掉');
});
