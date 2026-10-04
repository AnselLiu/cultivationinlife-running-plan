// 跑步記錄：計時器＋GPS 軌跡
//   軌跡只存在這支手機（localStorage），伺服器只會收到「存成訓練紀錄」時的距離與時間
//   重新整理或切到別的頁面都不會中斷；畫面保持常亮（Wake Lock）
//   空檔：iPhone 鎖定螢幕或切到背景時網頁會停住、收不到定位；訊號弱時定位點也不能用
//     空檔期間計時照走，不自動暫停、不問「跑完了嗎」；等到第一個好的定位點，再看這段的平均速度：
//     像在跑（約 1.2–7 m/s）→ 用直線補上距離，標成估算（est）；像站著（慢於 1.2 m/s 又不到 30 公尺）→ 照一般規則從最後移動的時間自動暫停；
//     快得不合理（超過 7 m/s，例如搭車）→ 路線斷開、距離不算，計時照走，之後照一般規則判斷
//   GPS 雜訊處理：精度差於 40 公尺的點不用、相鄰點小於 3 公尺不算、換算時速超過 32 公里的跳點丟掉
//   自動暫停：最近 20 秒的好定位點都在 10 公尺內（真的停下來：等紅燈、補給）才暫停，收不到定位點不算停下來；
//     再移動 15 公尺自動繼續；停超過 3 分鐘問「跑完了嗎？」
//   課表目標：開始時帶入今天課表的距離或時間，到了就問要不要結束
const AUTO_PAUSE_MS = 20000, ASK_FINISH_MS = 180000, ASK_AGAIN_MS = 300000;
const FREEZE_MS = 5000;                    // 每秒檢查一次；兩次檢查隔超過 5 秒＝網頁被凍結過（螢幕鎖定、切到背景）
const NOFIX_MS = 10000;                    // 超過 10 秒沒有好的定位點＝空檔
const FRESH_MS = 5000, STILL_FIXES = 3;    // 自動暫停：5 秒內有好的定位點，而且最後一次移動之後至少 3 個點都在原地
const GOOD_ACC = 40;                       // 精度（公尺）在這以內才用
const EST_MIN_V = 1.2, EST_MAX_V = 7, STILL_M = 30;   // 空檔怎麼補：平均速度（m/s）與「站著」的距離上限
const JOIN_M = 60;                         // 自動繼續時離暫停前最後一點在這以內就接起來
const WOKE_MS = 60000;                     // 剛從凍結回來、還沒收到好的定位點：1 分鐘內先不問「跑完了嗎」

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
// 舊版存下來、跑到一半的紀錄沒有這些欄位
if (s && (s.status === 'running' || s.status === 'paused')) { s.estM ??= 0; s.estS ??= 0; s.stillN ??= 0; s.fixAt ??= Date.now(); s.gap ??= null; }

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
// GPS 要繼續接：跑步中，或自動暫停中（等著自動繼續）
const tracking = () => !!s && s.useGps && (s.status === 'running' || (s.status === 'paused' && s.auto));
// 切到背景、鎖定螢幕：記下時間；回來時離開超過 5 秒就是空檔（這段收不到定位），重新要 Wake Lock、重設 GPS
document.addEventListener('visibilitychange', () => {
  if (!active()) return;
  if (document.visibilityState === 'hidden') { s.hiddenAt = Date.now(); save(true); return; }
  if (s.hiddenAt && Date.now() - s.hiddenAt > FREEZE_MS) woke();
  s.hiddenAt = 0;
  if (tracking()) { lock(); unwatch(); watch(); }
});
// 從凍結回來：跑步中就開一段空檔，等下一個好的定位點再決定怎麼補
function woke() {
  s.wokeAt = Date.now();
  if (s.status === 'running') openGap('frozen');
}
function openGap(why) {
  if (!s.useGps || s.gps === 'denied' || s.gap || !s.points.some((p) => !p.brk)) return;
  s.gap = { at: Date.now(), why };
  save(true); emit();
}
const lastPt = () => s.points[s.points.length - 1];
// 每個好的定位點都拿來判斷有沒有在動：離開錨點 10 公尺＝有在動，否則算一個「在原地」的點
function seen(p) {
  if (!s.anchor || hav(s.anchor, p) >= 10) { s.anchor = { lat: p.lat, lon: p.lon }; s.lastMoveAt = Date.now(); s.stillN = 0; }
  else s.stillN = (s.stillN || 0) + 1;
}
const moved = (p) => { s.anchor = { lat: p.lat, lon: p.lon }; s.lastMoveAt = Date.now(); s.stillN = 0; };
function addPoint(p) {
  p.d = Math.round(s.dist);
  p.m = elapsed();                                   // 跑步中的累計時間（扣掉暫停），算分段用
  s.points.push(p);
}

function onPosition(pos) {
  if (!s) return;
  const now = Date.now();
  const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt, altitudeAccuracy: altAcc } = pos.coords;
  const p = { t: pos.timestamp || now, lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
  if (alt != null && altAcc != null && altAcc < 15) p.alt = Math.round(alt * 10) / 10;
  if (!tracking()) return;
  s.gps = acc <= 20 ? 'good' : acc <= GOOD_ACC ? 'ok' : 'weak';
  s.acc = Math.round(acc);
  // 自動暫停中：還在接 GPS，離開暫停點 15 公尺就自動繼續
  if (s.status === 'paused') {
    if (acc <= GOOD_ACC) {
      s.fixAt = now; s.wokeAt = 0;
      const d = s.anchor ? hav(s.anchor, p) : 0;
      if (d >= 15) { autoResume(p); return; }
      s.leftAt = d >= 5 ? s.leftAt || now : 0;       // 開始離開暫停點的時間：自動繼續時從這裡起算
    }
    emit();
    return;
  }
  if (acc > GOOD_ACC) { emit(); return; }            // 訊號弱：這個點不用（空檔由 check() 判斷）
  const inGap = !!s.gap || now - (s.fixAt || now) > NOFIX_MS;
  s.fixAt = now; s.wokeAt = 0; s.gap = null;
  const last = lastPt();
  if (last && !last.brk) {
    const d = hav(last, p), dt = Math.max(0.5, (p.t - last.t) / 1000);
    // 空檔後的第一個好點：看這段的平均速度決定怎麼補
    if (inGap && dt * 1000 > NOFIX_MS) {
      const v = d / dt;
      if (v > EST_MAX_V) {                           // 快得不合理：路線斷開、距離不算，計時照走
        s.points.push({ brk: true, t: p.t });
        addPoint(p); moved(p);
      } else if (v < EST_MIN_V && d < STILL_M) {     // 像站著：照一般規則，從最後一次移動的時間自動暫停
        seen(p);
        if (now - (s.lastMoveAt || 0) > AUTO_PAUSE_MS) { autoPause(); if (hav(s.anchor, p) >= 15) autoResume(p); return; }
      } else {                                       // 像在跑：用直線補上，標成估算（實際路線通常比直線長，這是下限）
        s.dist += d; s.estM = (s.estM || 0) + d; s.estS = (s.estS || 0) + (p.t - last.t);
        p.est = true;
        addPoint(p); moved(p);
      }
      save(true); emit(); return;
    }
    if (d < 3) { seen(p); emit(); return; }          // 原地晃動
    if (d / dt > 9) { emit(); return; }              // 跳點
    s.dist += d;
    // 爬升：比最近的低點高出 2 公尺才算一次（緩坡也算得到，GPS 高度雜訊不會一直累加）
    if (p.alt != null) {
      if (s.altRef == null || p.alt < s.altRef) s.altRef = p.alt;
      else if (p.alt - s.altRef >= 2 && p.alt - s.altRef < 40) { s.gain += p.alt - s.altRef; s.altRef = p.alt; }
    }
  }
  addPoint(p);
  seen(p);
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
  const now = Date.now();
  s = { status: 'running', startedAt: now, elapsedMs: 0, resumedAt: now, points: [], dist: 0, gain: 0, laps: [],
    useGps: useGps && !!navigator.geolocation, gps: useGps ? 'waiting' : 'off', acc: null,
    goal, goalAsked: false, auto: false, lastMoveAt: now, anchor: null, askedAt: 0,
    fixAt: now, tickAt: now, stillN: 0, gap: null, estM: 0, estS: 0 };
  if (s.useGps) watch();
  lock(); save(true); emit();
}
export function pause() {
  if (!s || s.status !== 'running') return;
  s.elapsedMs += Date.now() - s.resumedAt;
  s.status = 'paused'; s.gap = null;
  if (s.points.length) s.points.push({ brk: true, t: Date.now() });   // 暫停的空檔不連線、不算距離
  unwatch(); unlock(); save(true); emit();
}
export function resume() {
  if (!s || s.status !== 'paused') return;
  const now = Date.now();
  s.status = 'running'; s.resumedAt = now; s.auto = false; s.lastMoveAt = now; s.askedAt = 0;
  s.fixAt = now; s.tickAt = now; s.stillN = 0; s.gap = null; s.wokeAt = 0;
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
  s.status = 'done'; s.endedAt = Date.now(); s.gap = null;
  unwatch(); unlock(); save(true); emit();
}
export function discard() {
  unwatch(); unlock(); s = null;
  try { localStorage.removeItem(KEY); } catch {}
  emit();
}
// 自動暫停：從最後一次移動的時間點起算暫停（停下來的那 20 秒不算進跑步時間）
function autoPause() {
  const stopAt = Math.min(Date.now(), Math.max(s.resumedAt, s.lastMoveAt || s.resumedAt));
  s.elapsedMs += stopAt - s.resumedAt;
  s.status = 'paused'; s.auto = true; s.pausedAt = stopAt; s.gap = null; s.leftAt = 0;
  const last = lastPt();
  if (last && !last.brk) s.points.push({ brk: true, t: Date.now(), auto: true });
  save(true); emit();
}
// 自動繼續：觸發的這個點也記進軌跡；離暫停前最後一點不遠（站著等紅燈）就接起來、距離照算
function autoResume(p) {
  const now = Date.now();
  s.status = 'running'; s.auto = false; s.askedAt = 0;
  s.resumedAt = s.leftAt && now - s.leftAt < 10000 ? s.leftAt : now;   // 走出 15 公尺之前那幾秒也算
  s.fixAt = now; s.gap = null; s.wokeAt = 0; s.leftAt = 0;
  moved(p);
  const end = lastPt(), prev = [...s.points].reverse().find((q) => !q.brk);
  if (end?.brk && end.auto && prev && hav(prev, p) <= JOIN_M) { s.points.pop(); s.dist += hav(prev, p); }
  addPoint(p);
  save(true); emit();
}
// 每秒檢查一次（GPS 停著不動時手機常常不回報新位置，所以不能只靠 onPosition）
//   回傳要問使用者的事：'finish'（停太久，跑完了嗎）、'goal'（課表目標到了）
//   收不到定位點不等於停下來：只有最近的好定位點都在原地才自動暫停
export function check() {
  if (!s) return null;
  const now = Date.now();
  if (active()) {
    if (s.tickAt && now - s.tickAt > FREEZE_MS) woke();
    s.tickAt = now;
  }
  if (s.status === 'running' && s.useGps && s.gps !== 'denied') {
    if (!s.gap && now - (s.fixAt || now) > NOFIX_MS) openGap('nofix');
    if (!s.gap && s.points.length && now - (s.lastMoveAt || 0) > AUTO_PAUSE_MS && now - (s.fixAt || 0) < FRESH_MS && (s.stillN || 0) >= STILL_FIXES) autoPause();
  }
  const waking = s.wokeAt && now - s.wokeAt < WOKE_MS;
  if (s.status === 'paused' && s.auto && !waking && now - s.pausedAt > ASK_FINISH_MS && now - (s.askedAt || 0) > ASK_AGAIN_MS) { s.askedAt = now; save(true); return 'finish'; }
  if (s.status === 'running' && s.goal && !s.goalAsked) {
    const done = s.goal.km ? s.dist >= s.goal.km * 1000 : s.goal.min ? elapsed() >= s.goal.min * 60000 : false;
    if (done) { s.goalAsked = true; save(true); return 'goal'; }
  }
  save();
  return null;
}
// 「還沒跑完」：清掉這次詢問，3 分鐘後才會再問
export function dismissAsk() { if (s) { s.askedAt = Date.now(); save(true); } }

// 沒有 GPS（跑步機、操場）時，結束後手動填距離
export function setDistance(m) { if (s) { s.manualDist = m > 0 ? m : null; save(true); emit(); } }
// 重新整理後回到記錄中（或自動暫停中）：繼續接 GPS
if (tracking()) { watch(); lock(); }

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
    route: pts.map((p) => [p.lat, p.lon]), splits, laps, date: tp.slice(0, 10), start: tp.slice(11, 16), gps: x.useGps, points: pts.length,
    est: x.manualDist ? 0 : Math.round(x.estM || 0), estSec: Math.round((x.estS || 0) / 1000) };
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
