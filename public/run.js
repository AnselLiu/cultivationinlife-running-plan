// 跑步記錄：計時器＋GPS 軌跡
//   軌跡只存在這支手機（localStorage），伺服器只會收到「存成訓練紀錄」時的距離與時間
//   重新整理或切到別的頁面都不會中斷；畫面保持常亮（Wake Lock），螢幕鎖定時 iPhone 會暫停 GPS，回來後接著記
//   GPS 雜訊處理：精度差於 40 公尺的點不用、相鄰點小於 3 公尺不算、換算時速超過 32 公里的跳點丟掉
//   自動暫停：20 秒沒有移動 10 公尺就自動暫停（等紅燈、補給），再移動 15 公尺自動繼續；停超過 3 分鐘問「跑完了嗎？」
//   課表目標：開始時帶入今天課表的距離或時間，到了就問要不要結束
const AUTO_PAUSE_MS = 20000, ASK_FINISH_MS = 180000, ASK_AGAIN_MS = 300000;

const KEY = 'cil-run-session';
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

let s = null;             // 目前這次跑步
let watchId = null, wake = null, lastSave = 0;
const listeners = new Set();
try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { s = null; }

export const session = () => s;
export const active = () => !!s && (s.status === 'running' || s.status === 'paused');
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) { try { fn(s); } catch {} } };
const save = (force) => {
  if (!s) return;
  if (!force && Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
};

// 經過時間：累計的＋這一段跑步中的
export const elapsed = (x = s) => (x ? x.elapsedMs + (x.status === 'running' ? Date.now() - x.resumedAt : 0) : 0);

async function lock() {
  try { if (navigator.wakeLock && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch { wake = null; }
}
const unlock = () => { try { wake?.release(); } catch {} wake = null; };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && s?.status === 'running') { lock(); if (s.useGps && watchId == null) watch(); } });

function onPosition(pos) {
  if (!s) return;
  // 自動暫停中：還在接 GPS，離開暫停點 15 公尺就自動繼續
  if (s.status === 'paused' && s.auto) {
    const { latitude: la, longitude: lo, accuracy: ac } = pos.coords;
    if (ac <= 40 && s.anchor && hav(s.anchor, { lat: la, lon: lo }) >= 15) autoResume({ lat: la, lon: lo });
    return;
  }
  if (s.status !== 'running') return;
  const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt, altitudeAccuracy: altAcc } = pos.coords;
  s.gps = acc <= 20 ? 'good' : acc <= 40 ? 'ok' : 'weak';
  s.acc = Math.round(acc);
  if (acc > 40) { emit(); return; }
  const p = { t: pos.timestamp || Date.now(), lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
  if (alt != null && altAcc != null && altAcc < 15) p.alt = Math.round(alt * 10) / 10;
  const last = s.points[s.points.length - 1];
  if (last && !last.brk) {
    const d = hav(last, p), dt = Math.max(0.5, (p.t - last.t) / 1000);
    if (d < 3) { emit(); return; }                 // 原地晃動
    if (d / dt > 9) { emit(); return; }             // 跳點
    s.dist += d;
    // 爬升：比最近的低點高出 2 公尺才算一次（緩坡也算得到，GPS 高度雜訊不會一直累加）
    if (p.alt != null) {
      if (s.altRef == null || p.alt < s.altRef) s.altRef = p.alt;
      else if (p.alt - s.altRef >= 2 && p.alt - s.altRef < 40) { s.gain += p.alt - s.altRef; s.altRef = p.alt; }
    }
  }
  p.d = Math.round(s.dist);
  p.m = elapsed();                                   // 跑步中的累計時間（扣掉暫停），算分段用
  s.points.push(p);
  // 有在移動：更新移動錨點
  if (!s.anchor || hav(s.anchor, p) >= 10) { s.anchor = { lat: p.lat, lon: p.lon }; s.lastMoveAt = Date.now(); }
  save();
  emit();
}
function onError(err) {
  if (!s) return;
  s.gps = err.code === 1 ? 'denied' : 'weak';
  emit();
}
function watch() {
  if (!navigator.geolocation || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
const unwatch = () => { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; };

export function start({ useGps = true, goal = null } = {}) {
  s = { status: 'running', startedAt: Date.now(), elapsedMs: 0, resumedAt: Date.now(), points: [], dist: 0, gain: 0, laps: [],
    useGps: useGps && !!navigator.geolocation, gps: useGps ? 'waiting' : 'off', acc: null,
    goal, goalAsked: false, auto: false, lastMoveAt: Date.now(), anchor: null, askedAt: 0 };
  if (s.useGps) watch();
  lock(); save(true); emit();
}
export function pause() {
  if (!s || s.status !== 'running') return;
  s.elapsedMs += Date.now() - s.resumedAt;
  s.status = 'paused';
  if (s.points.length) s.points.push({ brk: true, t: Date.now() });   // 暫停的空檔不連線、不算距離
  unwatch(); unlock(); save(true); emit();
}
export function resume() {
  if (!s || s.status !== 'paused') return;
  s.status = 'running'; s.resumedAt = Date.now(); s.auto = false; s.lastMoveAt = Date.now(); s.askedAt = 0;
  if (s.useGps) watch();
  lock(); save(true); emit();
}
export function lap() {
  if (!s || s.status !== 'running') return;
  s.laps.push({ at: elapsed(), d: Math.round(s.dist) });
  save(true); emit();
}
export function finish() {
  if (!s) return;
  if (s.status === 'running') s.elapsedMs += Date.now() - s.resumedAt;
  s.status = 'done'; s.endedAt = Date.now();
  unwatch(); unlock(); save(true); emit();
}
export function discard() {
  unwatch(); unlock(); s = null;
  try { localStorage.removeItem(KEY); } catch {}
  emit();
}
// 自動暫停：從最後一次移動的時間點起算暫停（停下來的那 20 秒不算進跑步時間）
function autoPause() {
  const stopAt = Math.max(s.resumedAt, s.lastMoveAt || s.resumedAt);
  s.elapsedMs += stopAt - s.resumedAt;
  s.status = 'paused'; s.auto = true; s.pausedAt = stopAt;
  if (s.points.length) s.points.push({ brk: true, t: Date.now() });
  save(true); emit();
}
function autoResume(p) {
  s.status = 'running'; s.auto = false; s.resumedAt = Date.now(); s.lastMoveAt = Date.now(); s.askedAt = 0;
  s.anchor = { lat: p.lat, lon: p.lon };
  save(true); emit();
}
// 每秒檢查一次（GPS 停著不動時手機常常不回報新位置，所以不能只靠 onPosition）
//   回傳要問使用者的事：'finish'（停太久，跑完了嗎）、'goal'（課表目標到了）
export function check() {
  if (!s) return null;
  if (s.status === 'running' && s.useGps && s.gps !== 'denied' && s.points.length && Date.now() - (s.lastMoveAt || 0) > AUTO_PAUSE_MS) autoPause();
  if (s.status === 'paused' && s.auto && Date.now() - s.pausedAt > ASK_FINISH_MS && Date.now() - (s.askedAt || 0) > ASK_AGAIN_MS) { s.askedAt = Date.now(); save(true); return 'finish'; }
  if (s.status === 'running' && s.goal && !s.goalAsked) {
    const done = s.goal.km ? s.dist >= s.goal.km * 1000 : s.goal.min ? elapsed() >= s.goal.min * 60000 : false;
    if (done) { s.goalAsked = true; save(true); return 'goal'; }
  }
  return null;
}
// 「還沒跑完」：清掉這次詢問，3 分鐘後才會再問
export function dismissAsk() { if (s) { s.askedAt = Date.now(); save(true); } }

// 沒有 GPS（跑步機、操場）時，結束後手動填距離
export function setDistance(m) { if (s) { s.manualDist = m > 0 ? m : null; save(true); emit(); } }
// 重新整理後回到記錄中：繼續接 GPS
if (s?.status === 'running' && s.useGps) { watch(); lock(); }

// 目前配速：最近 30 秒的距離換算（秒／公里）
export function currentPace() {
  if (!s || s.status !== 'running') return null;
  const pts = s.points.filter((p) => !p.brk), last = pts[pts.length - 1];
  if (!last || Date.now() - last.t > 15000) return null;
  const from = pts.find((p) => last.t - p.t <= 30000);
  if (!from || from === last || last.d - from.d < 20) return null;
  return ((last.t - from.t) / 1000) / ((last.d - from.d) / 1000);
}

// 整理成這次跑步的成績（距離、時間、配速、每公里分段、計圈、路線）
export function summary(x = s) {
  if (!x) return null;
  const distance = x.manualDist || x.dist, seconds = Math.round(elapsed(x) / 1000);
  const pts = x.points.filter((p) => !p.brk);
  // 每公里分段：在跨過整公里的兩點之間內插跑步時間（暫停時間不算）
  const splits = [];
  let km = 1, prev = null, lastM = 0;
  for (const p of pts) {
    if (prev && p.m != null && prev.m != null) {
      while (p.d >= km * 1000) {
        const f = (km * 1000 - prev.d) / Math.max(1, p.d - prev.d), m = prev.m + f * (p.m - prev.m);
        splits.push({ km, sec: Math.round((m - lastM) / 1000) });
        lastM = m; km += 1;
      }
    }
    prev = p;
  }
  const laps = x.laps.map((l, i) => ({ n: i + 1, sec: Math.round((l.at - (i ? x.laps[i - 1].at : 0)) / 1000), m: l.d - (i ? x.laps[i - 1].d : 0) }));
  const tp = new Date(x.startedAt + 8 * 3600e3).toISOString();
  return { distance, seconds, pace: distance > 0 ? seconds / (distance / 1000) : null, gain: Math.round(x.gain || 0),
    route: pts.map((p) => [p.lat, p.lon]), splits, laps, date: tp.slice(0, 10), start: tp.slice(11, 16), gps: x.useGps, points: pts.length };
}

// 匯出 GPX（存到手機或給其他 App）
export function gpx(x = s) {
  if (!x) return '';
  const seg = [];
  let cur = [];
  for (const p of x.points) {
    if (p.brk) { if (cur.length) seg.push(cur); cur = []; continue; }
    cur.push(`<trkpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`);
  }
  if (cur.length) seg.push(cur);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="耕跑團 cil-run" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><time>${new Date(x.startedAt).toISOString()}</time></metadata>
<trk><name>耕跑團跑步記錄</name><type>running</type>
${seg.map((pts) => `<trkseg>\n${pts.join('\n')}\n</trkseg>`).join('\n')}
</trk></gpx>`;
}
