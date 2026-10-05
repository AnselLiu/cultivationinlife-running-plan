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
// 空檔用直線回頭補：時間與距離都不超過實際（容許 GPS 雜訊多算一點），至少八成，平均配速跟實際差不到 8%
const lowerBound = (r, w) => {
  assert.ok(r.seconds <= w.moving / 1000 + 5 && r.seconds >= w.moving / 1000 * 0.8, `時間 ${r.seconds}，實際 ${w.moving / 1000}`);
  assert.ok(r.distance <= w.m + 60 && r.distance >= w.m * 0.8, `距離 ${Math.round(r.distance)}，實際 ${Math.round(w.m)}`);
  const real = w.moving / (w.m / 1000) / 1000;
  assert.ok(Math.abs(r.pace - real) / real < 0.08, `配速 ${Math.round(r.pace)}，實際 ${Math.round(real)} 秒／公里`);
};

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
  assert.equal(r.route.filter((p) => p[2] === 1).length, 1, '路線上有一段估算（虛線）');
  assert.equal(r.route.filter((p) => p[2] === 2).length, 0, '沒有斷開');
  const g = Run.gpx();
  assert.equal((g.match(/<trkseg>/g) || []).length, 3, 'GPX：前段、估算段（兩個點）、後段');
  assert.match(g, /<desc>螢幕鎖定或訊號弱時以直線估算 \d+ 公尺<\/desc>/);
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
  assert.equal(r.route.filter((p) => p[2]).length, 0, '等紅燈前後的路線接起來');
  assert.equal((Run.gpx().match(/<trkseg>/g) || []).length, 1);
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
  assert.equal(Run.summary().route.filter((p) => p[2] === 2).length, 1, '路線斷開一次');
  assert.equal(Run.summary().est, 0);
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

test('(e) 等紅燈自動暫停後鎖定螢幕、繼續跑 5 分鐘才解鎖：回頭估算什麼時候開始跑，時間與距離都補上', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(120, v);
  w.run(40, 0);
  assert.equal(Run.session().status, 'paused', '等紅燈先自動暫停');
  document.visibilityState = 'hidden'; w.wake();
  w.freeze(300, v);
  document.visibilityState = 'visible'; w.wake();
  w.tick(); w.run(60, v);
  Run.finish();
  const r = Run.summary();
  assert.deepEqual(w.asks, []);
  // 轉角那段用直線補，距離是下限；時間用平常的速度換算，所以也略少，但配速跟實際一樣
  lowerBound(r, w);
  assert.ok(r.est > 700, `估算距離 ${r.est}`);
  assert.equal(r.route.filter((p) => p[2] === 2).length, 0, '路線沒有斷開（估算的那段畫虛線）');
});

test("(e') 等紅燈自動暫停後在高架橋下訊號弱 2 分鐘：一樣回頭補上", async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(120, v);
  w.run(40, 0);
  assert.equal(Run.session().status, 'paused');
  w.acc = 240; w.run(120, v);
  w.acc = 5; w.run(60, v);
  Run.finish();
  const r = Run.summary();
  lowerBound(r, w);
  assert.ok(r.est > 250, `估算距離 ${r.est}`);   // 轉角前後的直線約 280 公尺
});

test('(f) 跑完走進室內忘了按結束（一直訊號弱）：5 分鐘後當成停下來，問跑完了嗎，時間不會一直加', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(600, v);
  w.acc = 80; w.run(2400, 0);
  const y = Run.session();
  assert.equal(y.status, 'paused');
  assert.equal(y.held, 1, '因為收不到定位才暫停');
  assert.equal(w.asks[0], 'finish', '要問跑完了嗎');
  near(Run.elapsed() / 1000, 600, 3, '時間停在最後一次移動');
});

test('(g) 跑完鎖定螢幕走 300 公尺回家，40 分鐘後才解鎖：大多停著，不當成在跑', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(600, v);
  w.freeze(2400, 0); w.m += 300;
  w.wake(); w.tick(); w.run(30, 0);
  const r = Run.summary();
  near(r.seconds, 600, 5, '時間');
  assert.equal(r.est, 0, '不用直線補');
});

test("(g') 等紅燈時手機不回報定位，開始跑 10 秒後才回來：從停下來起暫停，只補離開的那一小段", async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(120, v);
  w.run(60, 0, { fixes: false });
  w.run(10, v, { fixes: false });
  w.run(60, v);
  Run.finish();
  const r = Run.summary();
  near(r.seconds, w.moving / 1000, 6, '時間（等紅燈的 60 秒不算）');
  near(r.distance, w.m, 40, '距離');
});

test('(h) 鎖定螢幕跑到最後，解鎖就按暫停、結束：再等一下定位點，把最後那段補上', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(600, v);
  w.freeze(300, v);
  w.wake(); w.tick();
  Run.pause(); Run.finish();
  assert.equal(Run.summary().settling, true, '還在等定位點');
  now += 3000; w.fix();
  const r = Run.summary();
  assert.equal(r.settling, false);
  near(r.seconds, 900, 3, '時間');
  near(r.distance, w.m, 100, '距離（±1.5 m 雜訊跑 10 分鐘會多算一點）');
  assert.ok(r.est > 900, `估算距離 ${r.est}`);
  assert.equal(r.lost, 0);
  assert.equal(r.route.filter((p) => p[2] === 2).length, 0, '最後那段畫虛線，不是斷開');
});

test("(h') 訊號弱時按暫停、結束，30 秒內都沒有好的定位點：記下這段沒有距離，成績頁提醒", async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(120, v);
  w.acc = 200; w.run(120, v);
  Run.pause(); Run.finish();
  w.run(31, 0);
  const r = Run.summary();
  assert.equal(r.settling, false);
  near(r.lost, 120, 3, '沒有距離的時間');
  assert.equal(geoCb, null, '等完就關掉 GPS');
});

test('(i) 等紅燈時按計圈、接著自動暫停：時間往回退後計圈不會是負的，自動繼續後馬上按也算', async () => {
  const Run = await load(); Run.start({ useGps: true });
  const w = world(Run), v = 3.3;
  w.run(300, v);
  w.run(5, 0);
  assert.equal(Run.lap(), true);
  w.run(40, 0);
  assert.equal(Run.session().status, 'paused');
  assert.ok(Run.currentLap().sec >= 0, '進行中這一圈不能是負的');
  w.run(20, v);
  assert.equal(Run.session().status, 'running');
  assert.equal(Run.lap(), true, '自動繼續後按的圈要算');
  Run.finish();
  for (const l of Run.summary().laps) assert.ok(l.sec >= 0, `第 ${l.n} 圈 ${l.sec} 秒`);
});
