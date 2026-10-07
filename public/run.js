// 跑步記錄：計時器＋GPS 軌跡
//   軌跡只存在這支手機（localStorage），伺服器只會收到「存成訓練紀錄」時的距離與時間
//   重新整理或切到別的頁面都不會中斷；畫面保持常亮（Wake Lock）
//   空檔：iPhone 鎖定螢幕或切到背景時網頁會停住、收不到定位；訊號弱時定位點也不能用
//     空檔期間計時照走，不自動暫停、不問「跑完了嗎」；等到第一個好的定位點，再看這段的平均速度（只看速度，不看距離）：
//     像在跑（1.2–7 m/s）→ 用直線補上距離，標成估算（est）；
//     大多停著（慢於 1.2 m/s）→ 從最後移動的時間自動暫停；已經離開的話接著自動繼續，離開的那一小段用平常的速度換算時間補上
//       （60 公尺內，或平均還有 0.3 m/s 以上；更慢的像走回家、坐咖啡店，就斷開不算）；
//     快得不合理（超過 7 m/s，例如搭車）→ 路線斷開、距離不算，計時照走，之後照一般規則判斷
//   自動暫停中也一樣：暫停中鎖定螢幕或訊號弱，回來的第一個好的定位點已經離開了，就回頭用平常的速度估算什麼時候開始跑
//   空檔超過 5 分鐘還收不到好的定位點（忘了按結束、走進室內）：當成停下來，從最後移動的時間自動暫停並問「跑完了嗎」；之後定位回來照上面的規則回頭補
//   空檔中按暫停或結束：再接 30 秒 GPS，收到好的定位點就照上面的規則補上最後那段；收不到就記下來，成績頁提醒這段沒有距離
//   GPS 雜訊處理：精度差於 40 公尺的點不用、相鄰點小於 3 公尺不算、換算時速超過 32 公里的跳點丟掉
//   自動暫停：最近 20 秒的好定位點都在 10 公尺內（真的停下來：等紅燈、補給）才暫停，收不到定位點不算停下來；
//     再移動 15 公尺自動繼續；停超過 3 分鐘問「跑完了嗎？」
//   課表目標：開始時帶入今天課表的距離或時間，到了就問要不要結束
const AUTO_PAUSE_MS = 20000, ASK_FINISH_MS = 180000, ASK_AGAIN_MS = 300000;
const FREEZE_MS = 5000;                    // 每秒檢查一次；兩次檢查隔超過 5 秒＝網頁被凍結過（螢幕鎖定、切到背景）
const NOFIX_MS = 10000;                    // 超過 10 秒沒有好的定位點＝空檔
const FRESH_MS = 5000, STILL_FIXES = 3;    // 自動暫停：5 秒內有好的定位點，而且最後一次移動之後至少 3 個點都在原地
const GOOD_ACC = 40;                       // 精度（公尺）在這以內才用
const EST_MIN_V = 1.2, EST_MAX_V = 7;      // 空檔怎麼補：平均速度（m/s）在這之間算在跑
const JOIN_M = 60;                         // 自動繼續時離暫停前最後一點在這以內就接起來
const LAP_GAP_MS = 3000;                   // 計圈：3 秒內再按一次不算
const WOKE_MS = 60000;                     // 剛從凍結回來、還沒收到好的定位點：1 分鐘內先不問「跑完了嗎」
const GAP_MAX_MS = 300000;                 // 空檔（醒著的時間）超過 5 分鐘還沒有好的定位點：當成停下來
const LEAD_MAX_M = 60, EST_SLOW_V = 0.3;   // 大多停著的空檔：離開多遠以內、或平均多快以上，才補離開的那一小段
const SETTLE_MS = 30000;                   // 空檔中按暫停或結束：再等多久的定位點

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
// 平常的速度（m/s）：用來換算空檔裡跑了多久；記到的太少就當 3 m/s（每公里 5:33）
function vRef() {
  const sec = elapsed() / 1000, v = sec > 60 && s.dist > 100 ? s.dist / sec : 3;
  return Math.min(5, Math.max(2, v));
}

// Wake Lock（螢幕保持亮著）：iPhone 鎖定螢幕時網頁會停住、收不到定位，所以跑步中一直要著
//   系統可能拒絕（低電量模式）或中途放掉（切到背景）：聽 release，狀態給畫面顯示提醒，回到前景再要一次
//   wakeState：'on' 亮著、'pending' 要求中、'off' 沒有（被放掉）、'denied' 被拒絕、'unsupported' 這個瀏覽器不支援
let wakeState = 'off';
export const awake = () => wakeState;
async function lock() {
  if (!navigator.wakeLock) { wakeState = 'unsupported'; emit(); return; }
  if (document.visibilityState !== 'visible' || wakeState === 'pending') return;
  if (wake && !wake.released) { wakeState = 'on'; return; }
  wakeState = 'pending';
  let w = null;
  try { w = await navigator.wakeLock.request('screen'); } catch { wake = null; wakeState = 'denied'; emit(); return; }
  if (!live()) { try { w.release(); } catch {} wakeState = 'off'; return; }   // 要到的時候已經暫停或結束了
  wake = w; wakeState = 'on';
  w.addEventListener?.('release', () => { if (wake === w) { wake = null; wakeState = 'off'; emit(); } });
  emit();
}
// 使用者按按鈕（開口袋模式）時再要一次 Wake Lock：有使用者手勢，iPhone 比較願意給
export const keepAwake = () => { if (live()) lock(); };
const unlock = () => { const w = wake; wake = null; wakeState = 'off'; try { w?.release(); } catch {} };
// GPS 要繼續接：跑步中，或自動暫停中（等著自動繼續）
const live = () => !!s && (s.status === 'running' || (s.status === 'paused' && s.auto));   // 計時中或自動暫停中：螢幕要亮著
const tracking = () => live() && s.useGps;
// 切到背景、鎖定螢幕：記下時間；回來時離開超過 5 秒就是空檔（這段收不到定位），重新要 Wake Lock、重設 GPS
document.addEventListener('visibilitychange', () => {
  if (!active()) return;
  if (document.visibilityState === 'hidden') { s.hiddenAt = Date.now(); save(true); return; }
  if (s.hiddenAt && Date.now() - s.hiddenAt > FREEZE_MS) woke();
  s.hiddenAt = 0;
  if (live()) lock();
  if (tracking()) { unwatch(); watch(); }
});
// 從凍結回來：跑步中就開一段空檔，等下一個好的定位點再決定怎麼補
//   已經有空檔（凍結前訊號就弱了）：5 分鐘上限從醒來重新算，凍結的時間本來就收不到定位
function woke() {
  s.wokeAt = Date.now();
  if (s.gap) s.gap.at = s.wokeAt;
  if (s.status === 'running') openGap('frozen');
}
function openGap(why) {
  if (!s.useGps || s.gps === 'denied' || s.gap || !s.points.some((p) => !p.brk)) return;
  s.gap = { at: Date.now(), why };
  save(true); emit();
}
const lastPt = () => s.points[s.points.length - 1];
const lastGood = () => { for (let i = s.points.length - 1; i >= 0; i--) if (!s.points[i].brk) return s.points[i]; return null; };
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
// 直線估算的一段：距離與時間都記成估算，這一點畫虛線
function addEst(p, d, ms) {
  s.dist += d; s.estM = (s.estM || 0) + d; s.estS = (s.estS || 0) + ms;
  p.est = true; addPoint(p);
}
// 空檔結束（收到第一個好的定位點）時怎麼補：看從空檔前最後一點到這一點、ms 毫秒的平均速度
//   lead：離開的那一段用平常的速度換算要多久（不超過整個空檔）；0＝不補
function gapKind(prev, p, ms) {
  const d = hav(prev, p), v = d / Math.max(1, ms / 1000), lead = Math.min(ms, (d / vRef()) * 1000);
  if (v > EST_MAX_V) return { kind: 'fast', d, lead: 0 };
  if (v >= EST_MIN_V) return { kind: 'run', d, lead };
  return { kind: 'stop', d, lead: d <= LEAD_MAX_M || v >= EST_SLOW_V ? lead : 0 };
}
// 時間往回退（自動暫停從最後移動起算、空檔判斷為停著）：之後才記的圈不能超過新的時間
const clampLaps = () => { for (const l of s.laps) if (l.at > s.elapsedMs) l.at = s.elapsedMs; };

function onPosition(pos) {
  if (!s) return;
  const now = Date.now();
  const { latitude: lat, longitude: lon, accuracy: acc, altitude: alt, altitudeAccuracy: altAcc } = pos.coords;
  const p = { t: pos.timestamp || now, lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
  if (alt != null && altAcc != null && altAcc < 15) p.alt = Math.round(alt * 10) / 10;
  if (s.settle && s.status !== 'running') { if (acc <= GOOD_ACC) endSettle(p); return; }
  if (!tracking()) return;
  s.gps = acc <= 20 ? 'good' : acc <= GOOD_ACC ? 'ok' : 'weak';
  s.acc = Math.round(acc);
  // 自動暫停中：還在接 GPS，離開暫停點 15 公尺就自動繼續
  //   暫停中有一段收不到好的定位點（鎖定螢幕、訊號弱）才離開：回頭用平常的速度估算什麼時候開始跑
  if (s.status === 'paused') {
    if (acc <= GOOD_ACC) {
      const quiet = now - (s.fixAt || now), prev = lastGood();
      s.fixAt = now; s.wokeAt = 0;
      const d = s.anchor ? hav(s.anchor, p) : 0;
      if (d >= 15) { autoResume(p, quiet > NOFIX_MS && prev ? gapKind(prev, p, quiet).lead : undefined); return; }
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
    const g = inGap && dt * 1000 > NOFIX_MS ? gapKind(last, p, p.t - last.t) : null;
    if (g && (g.kind !== 'stop' || now - (s.lastMoveAt || 0) > AUTO_PAUSE_MS)) {
      if (g.kind === 'fast') {                       // 快得不合理：路線斷開、距離不算，計時照走
        s.points.push({ brk: true, t: p.t });
        addPoint(p); moved(p);
      } else if (g.kind === 'run') {                 // 像在跑：用直線補上，標成估算（實際路線通常比直線長，這是下限）
        addEst(p, g.d, p.t - last.t); moved(p);
      } else {                                       // 大多停著：從最後一次移動的時間自動暫停；已經離開了就接著自動繼續
        autoPause();
        if (s.anchor && hav(s.anchor, p) >= 15) { autoResume(p, g.lead); return; }
        seen(p);
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
// 空檔中（還沒補上距離）按暫停或結束：GPS 再接一下，等一個好的定位點把最後那段補上（endSettle）
function settle() {
  const now = Date.now();
  if (!s.useGps || s.gps === 'denied' || !lastGood() || !(s.gap || now - (s.fixAt || now) > NOFIX_MS)) return false;
  s.settle = { at: now, until: now + SETTLE_MS, resumedAt: s.resumedAt };
  return true;
}
function endSettle(p) {
  const st = s.settle, prev = lastGood();
  s.settle = null;
  if (s.status !== 'running') unwatch();
  if (!st || !prev) return;
  const ms = Math.max(0, st.at - prev.t), g = p ? gapKind(prev, p, ms) : null;
  // 補的點放在暫停的斷點前面（暫停後的路不算）
  const put = (fn) => { const brk = lastPt()?.brk ? s.points.pop() : null; fn(); if (brk) s.points.push(brk); };
  if (g?.kind === 'run') put(() => addEst(p, g.d, ms));
  else if (g?.kind === 'stop') {
    // 大多停著：時間退回最後一次移動，再加上離開的那一小段
    const back = Math.max(0, st.at - Math.max(st.resumedAt, s.lastMoveAt || 0) - g.lead);
    s.elapsedMs = Math.max(0, s.elapsedMs - back); clampLaps();
    if (g.lead > 0) put(() => { if (g.d <= JOIN_M) { s.dist += g.d; addPoint(p); } else addEst(p, g.d, g.lead); });
  } else s.lostMs = (s.lostMs || 0) + ms;            // 收不到、或快得不合理：這段沒有距離，成績頁提醒
  save(true); emit();
}
export function pause() {
  if (!s || s.status !== 'running') return;
  s.elapsedMs += Date.now() - s.resumedAt;
  const wait = settle();
  s.status = 'paused'; s.gap = null;
  if (s.points.length) s.points.push({ brk: true, t: Date.now() });   // 暫停的空檔不連線、不算距離
  if (!wait) unwatch();
  unlock(); save(true); emit();
}
export function resume() {
  if (!s || s.status !== 'paused') return;
  if (s.settle) endSettle();                         // 暫停前那段還沒等到定位點就繼續：記成沒有距離
  const now = Date.now();
  s.status = 'running'; s.held = 0; s.resumedAt = now; s.auto = false; s.lastMoveAt = now; s.askedAt = 0;
  s.fixAt = now; s.tickAt = now; s.stillN = 0; s.gap = null; s.wokeAt = 0;
  if (s.useGps) watch();
  lock(); save(true); emit();
}
// 計圈：3 秒內（剛開始或剛記過一圈，看實際的時間）再按不算，避免連按多出一圈 0:01；有記到回傳 true
//   不用跑步時間比：自動暫停會把時間往回退，剛自動繼續時按的圈會被誤擋
export function lap() {
  if (!s || s.status !== 'running') return false;
  const now = Date.now(), at = elapsed(), prev = s.laps[s.laps.length - 1];
  const from = prev ? prev.w ?? now - LAP_GAP_MS : s.startedAt;
  if (now - from < LAP_GAP_MS) return false;
  s.laps.push({ at, d: Math.round(s.dist), w: now });
  save(true); emit();
  return true;
}
// 進行中的這一圈（記過至少一圈才有）：第幾圈、經過時間（秒）、距離（公尺）
export function currentLap(x = s) {
  const prev = x?.laps[x.laps.length - 1];
  if (!prev) return null;
  return { n: x.laps.length + 1, sec: Math.max(0, (elapsed(x) - prev.at) / 1000), m: Math.max(0, Math.round(x.dist - prev.d)) };
}
export function finish() {
  if (!s) return;
  const wait = !!s.settle || (s.status === 'running' && settle());   // 暫停時開始等的也繼續等（結束按鈕只在暫停時出現）
  if (s.status === 'running') s.elapsedMs += Date.now() - s.resumedAt;
  s.status = 'done'; s.endedAt = Date.now(); s.gap = null;
  if (!wait) unwatch();
  unlock(); save(true); emit();
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
  clampLaps();
  const last = lastPt();
  if (last && !last.brk) s.points.push({ brk: true, t: Date.now(), auto: true });
  save(true); emit();
}
// 自動繼續：觸發的這個點也記進軌跡；離暫停前最後一點不遠（站著等紅燈）就接起來、距離照算
//   lead（空檔後才收到定位）：從 lead 毫秒前起算；有 lead 就接起來，超過 60 公尺的那段標成直線估算；lead 0＝斷開、從現在起算
function autoResume(p, lead) {
  const now = Date.now(), gap = lead != null;
  s.status = 'running'; s.auto = false; s.askedAt = 0; s.held = 0;
  s.resumedAt = gap ? now - lead : s.leftAt && now - s.leftAt < 10000 ? s.leftAt : now;   // 走出 15 公尺之前那幾秒也算
  s.fixAt = now; s.gap = null; s.wokeAt = 0; s.leftAt = 0;
  moved(p);
  const end = lastPt(), prev = lastGood(), d = prev ? hav(prev, p) : 0;
  const join = end?.brk && end.auto && prev && (gap ? lead > 0 : d <= JOIN_M);
  if (join) s.points.pop();
  if (join && d > JOIN_M) addEst(p, d, lead);
  else { if (join) s.dist += d; addPoint(p); }
  save(true); emit();
}
// 每秒檢查一次（GPS 停著不動時手機常常不回報新位置，所以不能只靠 onPosition）
//   回傳要問使用者的事：'finish'（停太久，跑完了嗎）、'goal'（課表目標到了）
//   收不到定位點不等於停下來：只有最近的好定位點都在原地才自動暫停
export function check() {
  if (!s) return null;
  const now = Date.now();
  if (s.settle && now > s.settle.until) endSettle();
  if (active()) {
    if (s.tickAt && now - s.tickAt > FREEZE_MS) woke();
    s.tickAt = now;
  }
  if (s.status === 'running' && s.useGps && s.gps !== 'denied') {
    if (!s.gap && now - (s.fixAt || now) > NOFIX_MS) openGap('nofix');
    // 空檔太久（走進室內忘了按結束、一直收不到）：當成停下來，下面照常問「跑完了嗎」；定位回來再回頭補
    if (s.gap && now - s.gap.at > GAP_MAX_MS) { autoPause(); s.held = 1; }
    else if (!s.gap && s.points.length && now - (s.lastMoveAt || 0) > AUTO_PAUSE_MS && now - (s.fixAt || 0) < FRESH_MS && (s.stillN || 0) >= STILL_FIXES) autoPause();
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
// 按「開始」時今天的課表還沒讀到：讀到後補上目標（記錄中才補、已經有目標的不改）；有補上回傳 true
export function setGoal(goal) {
  if (!goal || !active() || s.goal) return false;
  s.goal = goal; s.goalAsked = false; save(true); emit();
  return true;
}
// 重新整理後回到記錄中（或自動暫停中、按了暫停或結束還在等最後那段的定位點）：繼續接 GPS、螢幕保持亮著
if (tracking() || (s?.settle && s.useGps)) watch();
if (live()) lock();

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
  // 路線：[緯度, 經度, 記號]，記號 1＝從上一點到這點是空檔的直線估算（畫虛線）、2＝跟上一點斷開（暫停、搭車），沒有＝一般連線
  const route = [];
  let cut = false;
  for (const p of x.points) {
    if (p.brk) { cut = route.length > 0; continue; }
    route.push(cut ? [p.lat, p.lon, 2] : p.est ? [p.lat, p.lon, 1] : [p.lat, p.lon]);
    cut = false;
  }
  const tp = new Date(x.startedAt + 8 * 3600e3).toISOString();
  return { distance, seconds, pace: distance > 0 ? seconds / (distance / 1000) : null, gain: Math.round(x.gain || 0),
    route, splits, laps, date: tp.slice(0, 10), start: tp.slice(11, 16), gps: x.useGps, points: pts.length,
    est: x.manualDist ? 0 : Math.round(x.estM || 0), estSec: Math.round((x.estS || 0) / 1000),
    lost: x.manualDist ? 0 : Math.round((x.lostMs || 0) / 1000), settling: !!x.settle };
}

// 匯出 GPX（存到手機或給其他 App）
//   暫停、搭車斷開的地方分成不同的 <trkseg>；空檔的直線估算自己一段（兩個點），其他 App 也看得出來
export function gpx(x = s) {
  if (!x) return '';
  const pt = (p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`;
  const seg = [];
  let cur = [], prev = null;
  for (const p of x.points) {
    if (p.brk) { if (cur.length) seg.push(cur); cur = []; prev = null; continue; }
    if (p.est && prev) { if (cur.length) seg.push(cur); seg.push([pt(prev), pt(p)]); cur = []; }
    cur.push(pt(p)); prev = p;
  }
  if (cur.length) seg.push(cur);
  const est = Math.round(x.estM || 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="耕跑團 cil-run" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><time>${new Date(x.startedAt).toISOString()}</time></metadata>
<trk><name>耕跑團跑步記錄</name>${est ? `<desc>螢幕鎖定或訊號弱時以直線估算 ${est} 公尺</desc>` : ''}<type>running</type>
${seg.map((pts) => `<trkseg>\n${pts.join('\n')}\n</trkseg>`).join('\n')}
</trk></gpx>`;
}
