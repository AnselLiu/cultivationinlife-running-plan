// 耕跑團 PWA — 畫面：團練列表、活動詳情與報名、我的課表、課表教練、幹部的新增活動與公告產生器
import * as P from './plan.js';
import * as Party from './party.js';
import { qrSVG, canScan, scan } from './qr.js';
import * as S from './studio.js';
import * as Run from './run.js';
import * as Guide from './guide.js';
import { quote, charges } from './pricing.js';
import * as I18N from './i18n.js';
import { CATS, CHIPS } from './notif-cats.js';
import { tpNow, signupState, signupEnd, evStart, tpText, tpShort, STATE_LABEL, SIGNUP_DEFAULTS } from './signup-window.js';
// 用到才下載的模組：管理後台、拍照、報表、活動表單與統計、分團
// 剛部署的那幾秒可能拿到舊檔：載入失敗就等一下、加版本參數再試一次，仍失敗才顯示錯誤
const calendarView = (...a) => lazy('./calendar.js', 'calendarView')(...a);
const mapView = (...a) => lazy('./map.js', 'mapView')(...a);
const challengeView = (...a) => lazy('./challenge.js', 'challengeView')(...a);
// 課表教練（課表頁的用語說明、詳細內容、提醒、滑動換週）：課表畫好、閒下來才載入，首頁不會下載
const coachWeekExtras = (...a) => lazy('./coach.js', 'weekExtras')(...a);
// 課表的全季、賽事準備、配速與用語、課表設定（回傳離開頁面時要做的清理，例如賽事倒數的計時器）
const coachView = (...a) => lazy('./coach.js', 'coachView')(...a);
// 分享與匯出（複製、PDF、行事曆）：按了分享鈕才載入；PDF 的繪製另外放在 coachpdf.js，選 PDF 才下載
const coachShare = (...a) => lazy('./coach.js', 'shareSheet')(...a);
// 新舊版本混在一起（畫面還是舊版、用到才載入的模組已經是新版）會 import 失敗：
//   重新載入整個 App 換成同一版；30 秒內不重複，避免一直重整
const VERSION_SKEW = /Importing binding name|does not provide an export named|requested module .* does not provide/i;
function reloadForUpdate() {
  try {
    if (Date.now() - Number(sessionStorage.getItem('cil-skew') || 0) < 30000) return false;
    sessionStorage.setItem('cil-skew', String(Date.now()));
  } catch { return false; }
  location.reload();
  return true;
}
const lazy = (file, name) => async (...a) => {
  let m;
  try { m = await import(file); } catch (e) {
    if ((e?.name === 'SyntaxError' || VERSION_SKEW.test(e?.message || '')) && reloadForUpdate()) return new Promise(() => {});
    await new Promise((r) => setTimeout(r, 800)); m = await import(`${file}?r=${Date.now()}`);
  }
  if (typeof m[name] !== 'function' && reloadForUpdate()) return new Promise(() => {});
  return m[name](...a);
};

// 對外公開的乾淨網址（Google 同意畫面等會連到這裡）：/privacy → #/privacy
if (location.pathname === '/privacy' && !location.hash) history.replaceState(null, '', '/#/privacy');
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
// 分頁按鈕（.seg）多到要左右滑時：加上 .scrolls 讓兩側淡出，並把選中的那一個捲到中間（不會被切一半）
let segQueued = false;
const fitSegs = () => {
  segQueued = false;
  for (const s of view.querySelectorAll('.seg')) {
    const over = s.scrollWidth > s.clientWidth + 1;
    s.classList.toggle('scrolls', over);
    const on = over && !s.dataset.fit && s.querySelector('[aria-pressed="true"]');
    if (on) { s.dataset.fit = '1'; s.scrollLeft += on.getBoundingClientRect().left - s.getBoundingClientRect().left - (s.clientWidth - on.offsetWidth) / 2; }
  }
};
new MutationObserver(() => { if (!segQueued) { segQueued = true; requestAnimationFrame(fitSegs); } }).observe(view, { childList: true, subtree: true });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 寫入中的請求數：送出表單時按鈕先停用，等所有寫入完成才恢復（避免連點送出兩次）
let writes = 0;
const idleWaiters = [];
let formDirty = false, hiddenAt = 0;   // 表單填到一半、App 進背景的時間（決定能不能自動換新版）
const apiTimes = [];   // [路徑, 總毫秒, 伺服器毫秒]，送速度紀錄時整理成中位數
let skewMs = 0;       // 伺服器時間 − 手機時間（毫秒）
// 現在的台北牆上時間 'YYYY-MM-DDTHH:MM'（經伺服器校正）
const nowTp = () => tpNow(Date.now() + skewMs);
const signupDefaults = () => ({ ...SIGNUP_DEFAULTS, ...(cfg.settings?.signup || {}) });
const isOffline = () => !!document.getElementById('offline');
const api = async (path, opt = {}, retried = false) => {
  const method = opt.method || 'GET';
  if (method !== 'GET') writes++;
  let res;
  const t0 = performance.now();
  try {
    res = await fetch(`/api${path}`, {
      method,
      // 寫入類請求一律帶 JSON（伺服器用這個擋 CSRF）
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(opt.body ?? {}),
    });
  } catch {
    // 連不上網路：維持 TypeError（離線佇列靠這個判斷），訊息改成看得懂的
    throw new TypeError(navigator.onLine === false ? '目前沒有網路，連上後再試一次' : '連不上伺服器，請稍後再試');
  } finally {
    if (method !== 'GET' && --writes === 0) idleWaiters.splice(0).forEach((f) => f());
  }
  // 讀取類記錄花多久（不含離線暫存的結果）：路徑的代碼換成 :id，只記路徑不記參數
  if (method === 'GET' && !res.headers.get('x-cil-offline')) {
    const p = `/${path.split('?')[0].split('/').filter(Boolean).map((x) => (/^[\w-]{8,}$/.test(x) && /\d/.test(x) ? ':id' : x)).join('/')}`.slice(0, 48);
    const srv = Number((res.headers.get('server-timing') || '').match(/dur=([\d.]+)/)?.[1]);
    if (apiTimes.length < 300) apiTimes.push([p, performance.now() - t0, Number.isFinite(srv) ? srv : null]);
  }
  if (res.status >= 500 && res.status !== 503) throw new Error('伺服器忙碌，請稍後再試');
  const data = await res.json().catch(() => ({}));
  if (method === 'GET') offlineBar(res.headers.get('x-cil-offline') === '1');
  // 伺服器時間校正：報名期間用伺服器的時間判斷（手機時鐘不準、在其他時區都一樣）；離線暫存的回應不算
  if (method === 'GET' && typeof data.serverNow === 'number' && res.headers.get('x-cil-offline') !== '1') skewMs = data.serverNow - Date.now();
  // 高風險操作要先用通行金鑰驗證：跳出 Face ID／指紋，驗證完自動再送一次
  if (res.status === 403 && data.stepup && !retried && !/新增通行金鑰/.test(data.error || '')) {
    try { await passkey('stepup'); } catch (e) { throw new Error(e.message === '已取消' ? '已取消驗證' : data.error); }
    return api(path, opt, true);
  }
  if (!res.ok) throw new Error(data.error || `錯誤 ${res.status}`);
  return data;
};
// 即時搜尋：<form data-live> 打字停 0.3 秒、或改了下拉選單，就自動查（不用再按「搜尋」）。
//   注音、倉頡選字中不查；沒有任何條件時不查（名冊一律要有條件），data-live="empty" 的表單清空也會重查
const liveTimers = new WeakMap();
const liveGo = (f) => {
  if (!f.isConnected) return;
  const q = (f.q?.value || '').trim(), sel = [...f.querySelectorAll('select')].some((x) => x.value);
  if (!q && !sel && f.dataset.live !== 'empty') return;
  if (f.dataset.lastLive === `${q}|${new URLSearchParams(new FormData(f))}`) return;
  f.dataset.lastLive = `${q}|${new URLSearchParams(new FormData(f))}`;
  f.requestSubmit();
};
document.addEventListener('input', (e) => {
  const f = e.target.closest?.('form[data-live]');
  if (!f || e.isComposing || e.target.tagName === 'SELECT') return;
  clearTimeout(liveTimers.get(f)); liveTimers.set(f, setTimeout(() => liveGo(f), 300));
});
document.addEventListener('compositionend', (e) => { const f = e.target.closest?.('form[data-live]'); if (f) { clearTimeout(liveTimers.get(f)); liveTimers.set(f, setTimeout(() => liveGo(f), 300)); } });
document.addEventListener('change', (e) => { const f = e.target.closest?.('form[data-live]'); if (f && e.target.tagName === 'SELECT') liveGo(f); });
// 只採用最後一次查詢的結果：打字很快時，比較早送出、比較晚回來的結果不會蓋掉新的
const latest = () => { let n = 0; return (p) => { const my = ++n; return p.then((v) => (my === n ? v : new Promise(() => {}))); }; };
// 送出表單：送出鍵先停用並顯示「處理中」，所有寫入完成（或驗證沒過）才恢復（即時搜尋自動送出的不算）
document.addEventListener('submit', (e) => {
  if (e.target.matches('[data-live]')) { e.target.dataset.lastLive = `${(e.target.q?.value || '').trim()}|${new URLSearchParams(new FormData(e.target))}`; if (!e.submitter) return; }
  const btns = [...e.target.querySelectorAll('button:not([type="button"]), input[type="submit"]')].filter((b) => !b.disabled);
  if (!btns.length) return;
  for (const b of btns) { b.disabled = true; b.classList.add('busy'); b.setAttribute('aria-busy', 'true'); }
  const done = () => { for (const b of btns) if (b.isConnected) { b.disabled = false; b.classList.remove('busy'); b.removeAttribute('aria-busy'); } };
  setTimeout(() => (writes ? idleWaiters.push(done) : done()), 0);
  setTimeout(done, 20000);
}, true);
// 按鈕版：click 處理期間停用（沒有表單的「我要報名」「確認收款」等）
const once = (btn, fn) => async (...a) => { if (btn.disabled) return; btn.disabled = true; btn.classList.add('busy'); try { return await fn(...a); } finally { if (btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); } } };
// 三選一的確認面板（取代「確定／取消」容易按錯的 confirm）：回傳選到的 value，關掉回傳 null
function choose(title, message, options) {
  return new Promise((done) => {
    const host = document.createElement('div');
    host.className = 'sheet'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); host.setAttribute('aria-label', title);
    host.innerHTML = `<div class="sheet-bg" data-v=""></div><div class="sheet-card card"><h3>${esc(title)}</h3>${message ? `<p class="muted" style="margin:0">${message}</p>` : ''}
      <div class="choices">${options.map((o) => `<button type="button" class="btn block ${o.danger ? 'danger' : o.primary ? '' : 'ghost'}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join('')}
      <button type="button" class="btn ghost block" data-v="">取消</button></div></div>`;
    document.body.append(host);
    host.querySelector('.choices button')?.focus();
    host.addEventListener('click', (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v === undefined) return; host.remove(); done(v || null); });
  });
}
// 婉拒原因面板：常用理由 chips＋自由填寫（最多 120 字）；回傳 { note } 或 null（取消）
//   who：團員自己填的姓名，一律當純文字、不翻譯；lines：說明句（純文字，空字串略過）；ok：確認鍵文字（婉拒／移出）
//   開著的時候 Tab 只在面板裡循環，關掉後焦點回到原本的按鈕
function askReason(title, { who = '', lines = [], chips = [], ok = '婉拒' } = {}) {
  return new Promise((done) => {
    const back = document.activeElement;
    const host = document.createElement('div');
    host.className = 'sheet'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); host.setAttribute('aria-label', title);
    const text = lines.filter(Boolean);
    host.innerHTML = `<div class="sheet-bg" data-x="1"></div><div class="sheet-card card"><h3>${esc(title)}</h3>
      ${who ? `<p style="margin:0"><b translate="no">${esc(who)}</b></p>` : ''}
      ${text.map((x) => `<p class="muted" style="margin:0">${esc(x)}</p>`).join('')}
      ${chips.length ? `<div class="chips" role="group" aria-label="常用原因">${chips.map((c) => `<button type="button" class="chip" data-c="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('')}</div>` : ''}
      <label>原因（選填）<textarea maxlength="120" rows="3" aria-describedby="reasonHint"></textarea></label>
      <p class="tiny" id="reasonHint" style="margin:0">原因只有本人看得到，推播不會顯示原因</p>
      <div class="choices"><button type="button" class="btn danger block" data-ok="1">${esc(ok)}</button><button type="button" class="btn ghost block" data-x="1">取消</button></div></div>`;
    document.body.append(host);
    const ta = host.querySelector('textarea');
    const close = (v) => { host.remove(); if (back?.isConnected) back.focus(); done(v); };
    host.querySelector('.chip, textarea')?.focus();
    host.addEventListener('click', (e) => {
      const c = e.target.closest('[data-c]');
      if (c) {
        host.querySelectorAll('[data-c]').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
        ta.value = c.dataset.c === '其他' ? ta.value : c.dataset.c;
        if (c.dataset.c === '其他') ta.focus();
        return;
      }
      if (e.target.closest('[data-ok]')) { close({ note: ta.value.trim().slice(0, 120) }); return; }
      if (e.target.closest('[data-x]')) close(null);
    });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(null); return; }
      if (e.key !== 'Tab') return;
      const f = [...host.querySelectorAll('button, textarea')].filter((x) => !x.disabled);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });
  });
}
// 報名按鈕的文字：依活動類型、自己的狀態、是否額滿、是否需要審核
function submitLabel(ev, myStatus, full) {
  if (ev.kind === 'survey' || ev.survey) return myStatus ? '更新回覆' : '送出回覆';
  if (myStatus === 'pending') return '更新申請';
  if (myStatus === 'in' || myStatus === 'wait') return '更新報名';
  if (ev.require_approval && !ev.manage) return full ? '送出申請（額滿，核准後排候補）' : '送出申請';   // 主辦幹部本人報名＝核准
  if (full) return '排候補';
  return '我要報名';
}
// 報名送出後的提示
function signupToast(r, ev) {
  if (ev.kind === 'survey') return '已送出，謝謝你的回覆';
  if (r.status === 'pending') return r.full ? '已送出申請，目前額滿，核准後會排入候補' : '已送出申請，等主辦幹部審核，結果會通知你';
  if (r.status === 'wait') return `人數已滿，已排入候補第 ${r.position || 1} 位，有人取消會自動遞補並通知你`;
  if (r.amount) return `報名完成，應繳 ${money(r.amount)}`;
  return ev.kind === 'party' ? '報名完成，入場券在上方' : `報名完成，${dstr(ev.date)} 見`;
}
// 分享與公告用的報名期間文字；只有開放或即將開放時才附連結
const windowLine = (ev) => `報名期間：${ev.signup_start ? tpShort(ev.signup_start) : '即日起'} – ${tpShort(signupEnd(ev))}${ev.require_approval ? '（需主辦審核）' : ''}`;
const shareable = (ev) => ['open', 'soon'].includes(signupState(ev, nowTp()));
// 需要驗證的下載（例如含身分證字號的團體報名資料）：先過通行金鑰驗證，再把檔案存到手機
async function downloadAuthed(url, filename) {
  let res = await fetch(url);
  if (res.status === 403) {
    const d = await res.json().catch(() => ({}));
    if (!d.stepup) throw new Error(d.error || '沒有權限');
    await passkey('stepup');
    res = await fetch(url);
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `錯誤 ${res.status}`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob()); a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
// 斷線時顯示「離線中，畫面是上次的資料」；恢復連線自動消失
function offlineBar(on) {
  let el = document.getElementById('offline');
  if (!on) { el?.remove(); return; }
  if (el) return;
  el = document.createElement('div');
  el.id = 'offline'; el.className = 'offline'; el.role = 'status';
  el.textContent = '離線中，顯示的是上次的資料；入場券 QR Code 仍然可以使用';
  document.body.append(el);
}
addEventListener('online', () => { offlineBar(false); flushLogQueue(); });
// 前端錯誤回報：送到伺服器記錄（Cloudflare 後台 Logs 看得到），每個頁面最多回報 5 次，不含個資
let errSent = 0;
const reportError = (message, source, line) => {
  if (errSent++ >= 5) return;
  fetch('/api/client-error', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 300), source: String(source || '').replace(location.origin, '').slice(0, 120), line: line || 0, page: location.hash.split('?')[0].slice(0, 60) }) }).catch(() => {});
};
addEventListener('error', (e) => reportError(e.message, e.filename, e.lineno));
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r?.name === 'AbortError' || /Transition was aborted/.test(r?.message || '')) return;
  reportError(`unhandled: ${r?.message || r}`, '', 0);
  // 沒接住的操作失敗（例如刪除、登出時斷線）：至少讓使用者知道沒成功
  if (r?.message && !/^(Script error|undefined|null)/.test(r.message)) toast(/[\u4e00-\u9fff]/.test(r.message) ? r.message : '操作沒有成功，請再試一次');
});
addEventListener('offline', () => offlineBar(true));
// 開啟速度：從點開到第一個畫面可以用（ready），加上瀏覽器的 FCP、LCP、INP、CLS、TTFB；每次開啟只送一次，不含身分
const vitals = { warm: false };
try {
  const po = (type, fn, extra = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra }); } catch {} };
  po('largest-contentful-paint', (e) => { vitals.lcp = e.startTime; });
  po('layout-shift', (e) => { if (!e.hadRecentInput) vitals.cls = (vitals.cls || 0) + e.value; });
  po('event', (e) => { if (e.interactionId) vitals.inp = Math.max(vitals.inp || 0, e.duration); }, { durationThreshold: 40 });
  po('paint', (e) => { if (e.name === 'first-contentful-paint') vitals.fcp = e.startTime; });
} catch {}
let vitalsSent = false;
// 每種 API 的中位數，最慢的 10 種
const apiSummary = () => {
  const by = {};
  for (const [p, ms, srv] of apiTimes) (by[p] ||= []).push([ms, srv]);
  const mid = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return Object.entries(by).map(([p, v]) => ({ p, ms: Math.round(mid(v.map((x) => x[0]))), srv: v.some((x) => x[1] != null) ? Math.round(mid(v.filter((x) => x[1] != null).map((x) => x[1]))) : undefined }))
    .sort((a, b) => b.ms - a.ms).slice(0, 10);
};
const sendVitals = () => {
  if (vitalsSent || vitals.ready == null) return;
  vitalsSent = true;
  const nav = performance.getEntriesByType('navigation')[0];
  const r = (v) => (v == null ? undefined : Math.round(v));
  fetch('/api/vitals', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ready: r(vitals.ready), fcp: r(vitals.fcp), lcp: r(vitals.lcp), inp: r(vitals.inp), cls: vitals.cls == null ? undefined : Math.round(vitals.cls * 1000) / 1000,
      ttfb: r(nav?.responseStart), page: vitals.page, warm: vitals.warm, api: apiSummary(), standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true }) }).catch(() => {});
};
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendVitals(); });
addEventListener('pagehide', sendVitals);
// 切回前景：鈴鐺數字馬上更新
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') bell(true); });
// 登出、刪除帳號：清掉這台裝置暫存的個人資料
const clearDeviceData = () => {
  navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DATA' });
  try { localStorage.removeItem('cil-log-queue'); localStorage.removeItem('cil-coach'); localStorage.removeItem(OWNER_KEY); } catch {}
  navigator.clearAppBadge?.().catch(() => {});
  bellAt = 0; bellFor = null; bellState = { badge: 0, unread: 0 };
};
// 這台裝置的課表設定（身體資料）與離線暫存屬於哪個帳號：登入狀態過期、從別台裝置登出所有裝置後，
//   換另一個人在這台登入時，先清掉上一位的資料（不只靠按「登出」）
const OWNER_KEY = 'cil-device-owner';
function bindDeviceData(id) {
  if (!id) return;
  try {
    const cur = localStorage.getItem(OWNER_KEY);
    if (cur === id) return;
    if (cur) { localStorage.removeItem('cil-log-queue'); localStorage.removeItem('cil-coach'); }
    localStorage.setItem(OWNER_KEY, id);
  } catch {}
}
// 登出前：這台裝置的推播訂閱先從伺服器刪掉，再取消瀏覽器端的訂閱（登出後不再收到這個帳號的推播）
async function dropPush(server = true) {
  try {
    const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 1500))]);
    const sub = await reg?.pushManager?.getSubscription().catch(() => null);
    if (!sub) return;
    if (server) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  } catch {}
}
// 提示：可以帶一個動作（例如刪除後的「復原」）；focus 把焦點移到動作按鈕
// 時間到或被下一則提示取代時呼叫 onExpire（參數：焦點當時是否在提示裡）；滑鼠停在上面或焦點在裡面時先不關
function toast(msg, { action, onAction, onExpire, focus = false, ms = 2600 } = {}) {
  const prev = $('.toast'); if (prev) { prev.remove(); prev.expire?.(); }
  const el = document.createElement('div');
  el.className = 'toast';
  el.role = 'status';
  el.textContent = msg;
  let done = false;
  el.expire = () => { if (done) return; done = true; const had = el.contains(document.activeElement); el.remove(); onExpire?.(had); };
  let b;
  if (action) {
    b = document.createElement('button');
    b.type = 'button'; b.className = 'toastbtn'; b.textContent = action;
    b.onclick = () => { if (done) return; done = true; el.remove(); onAction?.(); };
    el.append(b);
  }
  document.body.append(el);
  if (focus) b?.focus();
  const later = () => { if (done) return; if (el.matches(':hover, :focus-within')) setTimeout(later, 1500); else el.expire(); };
  setTimeout(later, ms);
}
// 課表設定（只存在這台裝置，不會上傳；登出時清除）：每週天數、週四團練、跑量、成績、身體資料、起跑時間、畫面偏好
const COACH_DEFAULT = { v: 1, plan: { days: 6, club: true, vol: null }, pb: { dist: '10', time: '' },
  body: { age: null, sex: null, kg: null, rest: null, sweat: null }, start: {}, ui: { explain: false, exportPersonal: false }, legacy: null };
const NESTED = ['plan', 'pb', 'body', 'start', 'ui'];
function coachPrefs() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem('cil-coach') || 'null'); } catch {}
  const d = JSON.parse(JSON.stringify(COACH_DEFAULT));
  if (!v || typeof v !== 'object') return d;
  const out = { ...d, ...v };
  for (const k of NESTED) out[k] = { ...d[k], ...(v[k] && typeof v[k] === 'object' ? v[k] : {}) };
  return out;
}
// patch 的物件欄位只合併改到的鍵，例如 setCoachPrefs({ ui: { explain: true } })
function setCoachPrefs(patch) {
  const cur = coachPrefs(), next = { ...cur, ...patch, v: 1 };
  for (const k of NESTED) if (patch?.[k]) next[k] = { ...cur[k], ...patch[k] };
  try { localStorage.setItem('cil-coach', JSON.stringify(next)); } catch {}
  return next;
}
// 舊版課表教練（/coach）存在這台裝置的資料：設定 gengCoachModel、完成紀錄與倒數 gengCoachDash
//   不屬於任何帳號；搬完或下載備份後刪除才從這台裝置拿掉；登出時先問（清除這台裝置的資料也不會動它）
const LEGACY_KEYS = ['gengCoachModel', 'gengCoachDash'];
function legacyData() {
  const out = { model: {}, dash: {} };
  let found = false;
  for (const [k, f] of [['gengCoachModel', 'model'], ['gengCoachDash', 'dash']]) {
    try {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      found = true;
      const j = JSON.parse(v);
      if (j && typeof j === 'object' && !Array.isArray(j)) out[f] = j;
    } catch {}
  }
  return found ? out : null;
}
const removeLegacy = () => { try { for (const k of LEGACY_KEYS) localStorage.removeItem(k); } catch {} };
// 舊版有完成紀錄或倒數（只打開過舊版頁面也會留下設定，那不算）
const legacyHasDash = (d) => Object.keys(d?.dash?.log || {}).length > 0 || (Array.isArray(d?.dash?.cds) && d.dash.cds.length > 0);
// 還沒回答：沒有搬完、也沒有下載備份後刪除；搬完以後又在舊版記了新的完成紀錄或倒數也算
function legacyOpen() {
  const d = legacyData();
  return !!d && (!['done', 'skipped'].includes(coachPrefs().legacy?.state) || legacyHasDash(d));
}
// 課表頁的提醒：沒回答過、選「稍後再說」超過 7 天，或搬完以後舊版又有新的資料
function legacyDue() {
  if (!feat('coach')) return false;
  const d = legacyData();
  if (!d) return false;
  const l = coachPrefs().legacy;
  if (!l) return true;
  if (l.state === 'later') return !(Date.now() - (Date.parse(l.at) || 0) < 7 * 864e5);
  return legacyHasDash(d);
}
// 登出、刪除帳號前：還有沒搬的舊版資料就先問要保留（之後登入可以再搬）還是刪除；按取消回傳 false（不登出）
async function askLegacyOnLeave() {
  if (!legacyOpen()) return true;
  const v = await choose('這台裝置還有舊版課表教練資料', '設定、完成紀錄與倒數只存在這台裝置，還沒搬進 App。',
    [{ value: 'keep', label: '保留（之後登入可搬移）', primary: true }, { value: 'drop', label: '刪除', danger: true }]);
  if (v === 'drop') removeLegacy();
  return !!v;
}
const copy = async (text) => {
  try { await navigator.clipboard.writeText(text); toast('已複製'); }
  catch { toast('複製失敗，請長按文字手動複製'); }
};

// 導航：Apple 裝置開 Apple 地圖，其他開 Google 地圖（只帶地點文字，不帶個人資料）
const mapsUrl = (q) => (/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? `https://maps.apple.com/?q=${encodeURIComponent(q)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`);
// 地址欄位（跟郵局一樣）：選縣市 → 鄉鎮市區（帶出 3 碼郵遞區號）→ 填路名門牌；填好就送中華郵政核對，
//   換成郵局的寫法並顯示 6 碼郵遞區號，查不到就提示（存檔時伺服器會再查一次）。縣市與鄉鎮市區清單來自郵局的 3+3 服務
let zip3P = null;
const zip3 = () => (zip3P ||= fetch('/data/zip3.json').then((r) => r.json()).catch(() => { zip3P = null; return {}; }));
function addrField(name, label = '地址', hint = '') {
  return `<fieldset class="addrfield" data-addr="${name}"><legend>${label}${hint ? `<span class="tiny">${hint}</span>` : ''}</legend>
    <div class="addrsel"><select data-a="city" aria-label="縣市"><option value="">縣市</option></select>
      <select data-a="dist" aria-label="鄉鎮市區" disabled><option value="">鄉鎮市區</option></select></div>
    <div class="addrstreet"><output class="zip num" data-a="zip" aria-label="郵遞區號"></output><input data-a="street" maxlength="100" autocomplete="off" placeholder="路名、段、巷、弄、號、樓" aria-label="路名與門牌"></div>
    <input type="hidden" name="${name}"><span class="addrcheck" role="status" hidden></span></fieldset>`;
}
async function bindAddrField(form, name, value = '', zip6 = '') {
  const box = form.querySelector(`.addrfield[data-addr="${name}"]`);
  if (!box) return;
  const Z = await zip3(), q = (k) => box.querySelector(`[data-a="${k}"]`);
  const city = q('city'), dist = q('dist'), street = q('street'), zipEl = q('zip'), hidden = box.querySelector(`[name="${name}"]`), out = box.querySelector('.addrcheck');
  city.insertAdjacentHTML('beforeend', Object.keys(Z).map((c) => `<option>${c}</option>`).join(''));
  const fillDist = () => {
    const list = Z[city.value] || [];
    dist.innerHTML = `<option value="">鄉鎮市區</option>${list.map(([d, z]) => `<option value="${d}" data-zip="${z}">${d}</option>`).join('')}`;
    dist.disabled = !list.length;
  };
  const show = (cls, html) => { out.className = `addrcheck ${cls}`; out.innerHTML = html; out.hidden = !html; };
  // 帶入原本的地址：拆成縣市、鄉鎮市區、其餘
  const split = (v) => {
    v = String(v || '').replace(/^台/, '臺');
    const c = Object.keys(Z).find((k) => v.startsWith(k)), d = c && (Z[c] || []).find(([x]) => v.slice(c.length).startsWith(x));
    return { c: c || '', d: d ? d[0] : '', rest: v.slice((c || '').length + (d ? d[0].length : 0)) };
  };
  const put = (v) => { const x = split(v); city.value = x.c; fillDist(); dist.value = x.d; street.value = x.c ? x.rest : v; };
  put(value);
  hidden.value = value || '';
  zipEl.textContent = zip6 || dist.selectedOptions[0]?.dataset.zip || '';
  if (zip6 && value) show('ok', `${IC.check}<span>郵局核對通過</span>`);
  let last = value || '', seq = 0;
  const compose = async () => {
    const full = city.value && dist.value && street.value.trim() ? `${city.value}${dist.value}${street.value.trim().replace(/\s+/g, '')}` : '';
    zipEl.textContent = dist.selectedOptions[0]?.dataset.zip || '';
    hidden.value = full || `${city.value}${dist.value}${street.value.trim()}`;   // 填一半也照送：伺服器核對時會擋下並說明
    if (!full) { show(street.value.trim() && !dist.value ? 'bad' : '', street.value.trim() && !dist.value ? '請先選縣市與鄉鎮市區' : ''); last = ''; return; }
    if (full === last && out.classList.contains('ok')) return;
    last = full; const my = ++seq;
    show('wait', '郵局核對中…');
    try {
      const r = await api('/address/check', { method: 'POST', body: { address: full } });
      if (my !== seq) return;
      put(r.address); hidden.value = r.address; last = r.address; zipEl.textContent = r.zip;
      show('ok', `${IC.check}<span>郵局核對通過${r.notServed ? '（不按址投遞區域）' : ''}</span>`);
    } catch (e) { if (my === seq) show('bad', esc(e.message)); }
  };
  city.addEventListener('change', () => { fillDist(); compose(); });
  dist.addEventListener('change', compose);
  street.addEventListener('change', compose);
}
const KIND_NAME = { track: '田徑場團練', core: '核心日', long: '長跑團練', race: '賽事', party: '餐敘聚會', survey: '問卷調查', buy: '團購', other: '活動' };
const ROLE_NAME = { chair: '理事長', director: '理事', supervisor: '監事', staff: '行政人員', coach: '教練', member: '團員' };
const allow = (p) => !!me?.can?.includes(p);
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const d2 = (d) => new Date(`${d}T00:00:00`);
const dayLabel = (s) => s.replace('週五或週六', '週五／六').replace('週一或週三', '週一／三').replace('週二或週三', '週二／三').replace('週四或週五', '週四／五').replace('週三或週五', '週三／五').replace('週三或週六', '週三／六');
const fixText = (s) => s.replace(/\brep(\d)/g, 'rpe$1');
const dstr = (d) => { const x = d2(d); return `${x.getMonth() + 1}/${x.getDate()}（${WD[x.getDay()]}）`; };
const avatar = (s) => s.avatar
  ? `<img class="av" src="${esc(s.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="av" aria-hidden="true">${esc((s.name || '?').slice(0, 1))}</span>`;

let me = null, cfg = {};
// 開啟 App 時 /api/me?boot=1 一起帶回的首頁資料（活動、今天的訓練紀錄），各用一次就丟掉
let bootData = null;
const takeBoot = (k) => { if (!bootData || bootData.today !== ymd(new Date()) || bootData[k] == null) return null; const v = bootData[k]; bootData[k] = null; return v; };
// 先畫後抓：上次的 /api/me?boot=1 還在手機裡（Service Worker 暫存）就先用它畫，網路回來再悄悄更新
async function peekBoot() {
  try { const hit = await (await caches.open('cil-api')).match('/api/me?boot=1'); return hit ? await hit.json() : null; } catch { return null; }
}
// 管理者在後台設定的內容（協會資訊、功能開關、文件、隱私權政策）
const org = () => cfg.settings?.org || {};
const feat = (k) => cfg.settings?.features?.[k] !== false;
// 我的課表週期（/api/me 的 planCycle）：協會賽季，或跟自己的一場比賽排 20 週；同一份 cfg 只算一次
//   /api/me 由 Service Worker 暫存，所以離線也知道是哪個週期
let cycMemo = null;
function myCycle() {
  if (cycMemo?.cfg === cfg) return cycMemo.c;
  const r = cfg.planCycle?.kind === 'race' ? cfg.planCycle.race : null;
  const c = r && P.parseISO(r.date) ? P.cycleOf(r.date, { kind: 'race', raceId: r.id, name: r.name, dist: r.dist, goal: r.goal }) : P.CLUB;
  cycMemo = { cfg, c };
  return c;
}
// 賽事準備看哪一場：個人週期的那一場 → 右上角倒數的那一場 → 我的主要賽事 → 最近的一場 → 協會賽季
//   data：/api/races 的結果（沒傳就去抓一次）；回傳 { race: { id?, name, date, dist?, goal? } | null, src, data }
async function raceTarget(data = null) {
  const today = ymd(new Date()), c = myCycle();
  const d = data || await api('/races').catch(() => ({ races: [] }));
  const mine = (d.races || []).filter((r) => r.date >= today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (c.kind === 'race') return { race: mine.find((r) => r.id === c.raceId) || { id: c.raceId, name: c.name, date: c.anchor, dist: c.dist, goal: c.goal }, src: 'cycle', data: d };
  if (cfg.race?.date >= today) return { race: mine.find((r) => r.name === cfg.race.name && r.date === cfg.race.date) || { ...cfg.race }, src: 'countdown', data: d };
  const r = mine.find((x) => x.is_primary) || mine[0];
  if (r) return { race: r, src: r.is_primary ? 'primary' : 'nearest', data: d };
  const club = d.club?.date >= today ? d.club : P.RACE_ISO >= today ? { name: P.CLUB.name, date: P.RACE_ISO } : null;
  return { race: club ? { ...club, club: true } : null, src: 'club', data: d };
}
// 起跑時間存在這台裝置，依比賽（日期＋名稱）分開記，換一場比賽不會帶錯
const startKey = (r) => `${r.date}|${r.name}`;
// 課表頁上方的分段：單週｜全季｜賽事｜參考（沒開課表教練就不顯示）；切換用 replace，Android 返回鍵不會在分段之間來回
const PLAN_SEG = [['/plan', '單週'], ['/plan/season', '全季'], ['/plan/race', '賽事'], ['/plan/guide', '參考']];
const planSeg = (active) => (feat('coach') ? `<div class="seg planseg" role="group" aria-label="課表頁面">${PLAN_SEG.map(([h, l]) =>
  `<button type="button" data-pseg="${h}" aria-pressed="${h === active}">${l}</button>`).join('')}</div>` : '');
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-pseg]');
  if (!b || b.getAttribute('aria-pressed') === 'true') return;
  // 上一頁就是要去的分段（例如從單週點「工具 › 全季課表」進來）：直接返回，不然歷史裡會有兩個一樣的頁面，返回鍵按了像沒反應
  if (navStack[navStack.length - 2] === b.dataset.pseg) history.back();
  else location.replace(`#${b.dataset.pseg}`);
});
// 課表頁網址：個人週期的會員在看協會賽季時帶 ?c=club（只能看）
const planHref = (c, n) => `#/plan${n ? `/${n}` : ''}${c.kind === 'club' && myCycle().kind !== 'club' ? '?c=club' : ''}`;
// 分團：自己在各分團的身分由 /api/me 帶回；伺服器每次都會再檢查一次，這裡只決定要不要顯示按鈕
// 分團沒有另外上傳圖示時，用內建的正式小圖（耕跑團本團用原本的 logo）
const TEAM_ICONS = { main: '/icons/icon-192.png', youth: '/teams/youth.webp', kids: '/teams/kids.webp', core: '/teams/core.webp', geng: '/teams/geng.webp' };
const teams = () => (cfg.teams || []).map((t) => (!t.icon && TEAM_ICONS[t.id] ? { ...t, icon: TEAM_ICONS[t.id] } : t));
const teamOf = (id) => teams().find((t) => t.id === id);
const myTeams = () => teams().filter((t) => t.my_status === 'active');
const TEAM_PERMS = { lead: ['event', 'checkin', 'lottery', 'layout', 'roster', 'approve', 'appoint'], officer: ['event', 'checkin', 'lottery', 'roster', 'approve'] };
const TEAM_ROLE_NAME = { lead: '團長', officer: '幹部', member: '團員' };
const teamAllow = (tid, p) => allow(p) || (!!tid && teamOf(tid)?.my_status === 'active' && !!TEAM_PERMS[teamOf(tid).my_role]?.includes(p));
const anyTeamAllow = (p) => allow(p) || teams().some((t) => teamAllow(t.id, p));
const teamTag = (t) => (t ? `<span class="pill team" style="--tc:${esc(t.color || '#1C4698')}">${t.icon ? `<img class="ticon xs" src="${esc(t.icon)}" alt="">` : ''}<span translate="no">${esc(t.name)}</span></span>` : '');
// 分團小圖：有上傳就用圖，沒有就用團色＋第一個字
const teamIcon = (t, cls = '') => (t.icon ? `<img class="ticon ${cls}" src="${esc(t.icon)}" alt="" decoding="async">`
  : `<span class="ticon ${cls}" style="background:${esc(t.color || '#1C4698')}" aria-hidden="true"><span translate="no">${esc(t.name.slice(0, 1))}</span></span>`);
// 上傳前在手機上縮成 256px 正方形（置中裁切），WebP 不支援就用 JPEG
async function squareIcon(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const k = Math.max(256 / bmp.width, 256 / bmp.height), w = bmp.width * k, h = bmp.height * k;
  c.getContext('2d').drawImage(bmp, (256 - w) / 2, (256 - h) / 2, w, h);
  let url = c.toDataURL('image/webp', 0.86);
  if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.88);
  return url;
}
const refreshMe = async () => { const r = await api('/me'); me = r.member; cfg = r; };
// 分享活動：手機跳出分享選單（LINE、訊息…），不支援就複製文字＋連結
const eventUrl = (id) => `${location.origin}/#/e/${id}`;
async function shareEvent(ev, link = eventUrl(ev.id)) {
  const text = `${ev.title}｜${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}` : ''}${ev.place ? `・${ev.place}` : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: ev.title, text, url: link }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(`${text}\n${ev.kind === 'survey' ? '填寫' : '報名'}：${link}`);
}

// 大標題：頁面最上方的 Large Title；捲出畫面後，標題縮到頂部列中間（iOS 行為）
function largeTitle(title, sub = '', action = '') {
  $('#ctitle').textContent = title;
  return `<header class="lt"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${action}</header>`;
}
const ICONS = {
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/></svg>',
  runner: '<svg viewBox="0 0 24 24"><circle cx="14" cy="4.6" r="1.6"/><path d="M6 20.5l2.6-5 2.4-1.6-1-4.2 3.6-1.4 1.8 3.2 3.4 1"/><path d="M11 13.9l1.3 3.2 3.4 2.6"/></svg>',
};
// 介面圖示：一律用同一套線條 SVG（不用 emoji），顏色跟著文字
const ic = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  pin: ic('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>'),
  lock: ic('<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/>'),
  megaphone: ic('<path d="M4 10v4a1 1 0 0 0 1 1h2l6 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>'),
  calendar: ic('<rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/>'),
  checkCircle: ic('<circle cx="12" cy="12" r="8.6"/><path d="M8 12.3l2.8 2.8L16.2 9.6"/>'),
  check: ic('<path d="M5 12.5l4.2 4.2L19 7"/>'),
  half: ic('<circle cx="12" cy="12" r="7.6"/><path d="M12 4.4a7.6 7.6 0 0 1 0 15.2Z" fill="currentColor" stroke="none"/>'),
  minus: ic('<path d="M6.5 12h11"/>'),
  plus: ic('<path d="M12 6.5v11M6.5 12h11"/>'),
  gift: ic('<rect x="3.6" y="8.4" width="16.8" height="4.2" rx="1.2"/><path d="M5.2 12.6v6.4a1.4 1.4 0 0 0 1.4 1.4h10.8a1.4 1.4 0 0 0 1.4-1.4v-6.4M12 8.4v12M12 8.4S10.6 3.8 8.2 4.5c-2 .6-1.1 3.9 3.8 3.9ZM12 8.4s1.4-4.6 3.8-3.9c2 .6 1.1 3.9-3.8 3.9Z"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>'),
  runner: ic('<circle cx="14" cy="4.6" r="1.6"/><path d="M6 20.5l2.6-5 2.4-1.6-1-4.2 3.6-1.4 1.8 3.2 3.4 1"/><path d="M11 13.9l1.3 3.2 3.4 2.6"/>'),
  scan: ic('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16"/>'),
  doc: ic('<path d="M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5Z"/><path d="M13.5 3.5V8H18M9 12.5h6M9 16h4"/>'),
  external: ic('<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7h4"/>'),
  // 通知分類（放在 IC 裡：MI 宣告得比較晚，頂層物件引用會觸發 TDZ）
  shieldAlert: ic('<path d="M12 3 5 6v5.5c0 4.4 3 8 7 9.5 4-1.5 7-5.1 7-9.5V6Z"/><path d="M12 8.5v4.3M12 16v.1"/>'),
  calAlert: ic('<path d="M20.8 11.4V8.2a3.4 3.4 0 0 0-3.4-3.4H6.6a3.4 3.4 0 0 0-3.4 3.4v8.6a3.4 3.4 0 0 0 3.4 3.4h5.6"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/><path d="M17.6 14.4v3.2M17.6 20.6v.1"/>'),
  calClock: ic('<path d="M11.2 20.2H6.6a3.4 3.4 0 0 1-3.4-3.4V8.2a3.4 3.4 0 0 1 3.4-3.4h10.8a3.4 3.4 0 0 1 3.4 3.4v2.6"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/><circle cx="17" cy="17" r="4.2"/><path d="M17 15v2.2l1.5 1"/>'),
  ticket: ic('<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M14 6v12" stroke-dasharray="2 2.5"/>'),
  idcard: ic('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14.5 10h4M14.5 13.5h3"/>'),
  clipCheck: ic('<path d="M9 4.6H7.4A2.4 2.4 0 0 0 5 7v11.6A2.4 2.4 0 0 0 7.4 21h9.2a2.4 2.4 0 0 0 2.4-2.4V7a2.4 2.4 0 0 0-2.4-2.4H15"/><rect x="9" y="3" width="6" height="3.4" rx="1.2"/><path d="M8.8 13.6l2.2 2.2 4.4-4.6"/>'),
  bell: ic('<path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/>'),
  // 介面
  sliders: ic('<path d="M4 7.5h9M17.5 7.5H20M4 16.5h2.5M11 16.5h9"/><circle cx="15.2" cy="7.5" r="2.2"/><circle cx="8.8" cy="16.5" r="2.2"/>'),
  more: ic('<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
  envOpen: ic('<path d="M3.5 10 12 4.2 20.5 10v8.4a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6Z"/><path d="m3.8 10.3 8.2 5.5 8.2-5.5"/>'),
  envDot: ic('<path d="M20.5 11v6.4a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6V7.6A1.6 1.6 0 0 1 5.1 6H14"/><path d="m3.8 7.4 8.2 5.6 4-2.7"/><circle cx="19" cy="6" r="2.4" fill="currentColor" stroke="none"/>'),
  trash: ic('<path d="M4.5 6.6h15M9.6 6.6V4.9a1.1 1.1 0 0 1 1.1-1.1h2.6a1.1 1.1 0 0 1 1.1 1.1v1.7M6.6 6.6l.8 12.2a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-12.2M10.2 10.6v5.8M13.8 10.6v5.8"/>'),
  bellSlash: ic('<path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0M4.5 4.5l15 15"/>'),
  filter: ic('<path d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2Z"/>'),
};
const emptyState = (icon, text) => `<div class="empty">${String(icon).startsWith('<') ? icon : ICONS[icon] || ''}<span>${text}</span></div>`;
function avatarStack(peek, total) {
  if (!total) return '<span class="stack empty">還沒有人</span>';
  return `<span class="stack">${peek.slice(0, 3).map((p) => avatar({ name: p.n, avatar: p.a })).join('')}${total > 3 ? `<span class="more">+${total - 3}</span>` : ''}</span>`;
}
const todayLabel = () => { const d = new Date(); return `${d.getMonth() + 1}月${d.getDate()}日 星期${WD[d.getDay()]}`; };

// ---------- 通行金鑰（Face ID／指紋）----------
const pkSupported = () => !!window.PublicKeyCredential && !!navigator.credentials?.create;
const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// purpose：register 新增、login 登入、stepup 幹部再次驗證
async function passkey(purpose, name) {
  if (!pkSupported()) throw new Error('這個瀏覽器不支援通行金鑰，請用 iPhone 的 Safari 或 Chrome');
  const { cid, publicKey: o } = await api('/passkey/options', { method: 'POST', body: { purpose } });
  const pk = { ...o, challenge: b64uToBuf(o.challenge) };
  if (o.user) pk.user = { ...o.user, id: b64uToBuf(o.user.id) };
  if (o.excludeCredentials) pk.excludeCredentials = o.excludeCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  if (o.allowCredentials) pk.allowCredentials = o.allowCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  let cred;
  try { cred = purpose === 'register' ? await navigator.credentials.create({ publicKey: pk }) : await navigator.credentials.get({ publicKey: pk, mediation: 'optional' }); }
  catch (e) { throw new Error(e.name === 'NotAllowedError' ? '已取消' : e.name === 'InvalidStateError' ? '這台裝置已經有通行金鑰了' : '通行金鑰沒有完成'); }
  const r = cred.response;
  const credential = { id: cred.id, type: cred.type, response: purpose === 'register'
    ? { clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject) }
    : { clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature), userHandle: r.userHandle ? bufToB64u(r.userHandle) : null } };
  return api('/passkey/verify', { method: 'POST', body: { cid, credential, name } });
}
// 幹部開了強制兩步驟、這次登入還沒驗證：顯示提示列
const mfaBanner = () => (me?.mfaPending ? `<section class="card mfabar"><div><b>請驗證身分</b><span class="tiny" style="display:block">你是<span translate="no">${esc(me.realRoleName || '幹部')}</span>，協會規定用通行金鑰再驗證一次才能使用管理功能。</span></div>
  <button class="btn sm" data-stepup>${IC.lock}驗證</button></section>` : '');
function bindStepup() {
  for (const b of document.querySelectorAll('[data-stepup]')) b.onclick = async () => {
    try { await passkey('stepup'); toast('驗證完成'); me = null; render(); }
    catch (e) { if (/還沒有通行金鑰/.test(e.message)) { toast('先新增通行金鑰'); location.hash = '#/me/security'; } else if (e.message !== '已取消') toast(e.message); }
  };
}

// Google 標誌（依 Google 品牌規範使用原色 G）
const GOOGLE_G = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
// Google 不允許在 App 內建瀏覽器登入（LINE、Facebook、Instagram）：LINE 可以用 openExternalBrowser=1 直接跳到 Safari／Chrome
const inAppBrowser = () => (/Line\//i.test(navigator.userAgent) ? 'line' : /FBAN|FBAV|Instagram/i.test(navigator.userAgent) ? 'meta' : '');
const googleHref = (link) => {
  const path = `/api/google/start${link ? '?link=1' : ''}`;
  return inAppBrowser() === 'line' ? `${location.origin}/?openExternalBrowser=1${location.hash || '#/'}` : path;
};

// ---------- 登入 ----------
function loginView() {
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('err');
  const shared = location.hash.match(/^#\/e\/([\w-]+)/)?.[1];
  const sharedTok = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  const feat = [[IC.megaphone, '團練報名', '公告、接龍、候補自動遞補'], [IC.calendar, '分組課表', '照組別換算配速'], [IC.runner, 'GPS 跑步', '自動暫停、分段、GPX'], [ic('<path d="M4 8.2a2 2 0 0 1 2-2h1.9l1.5-2h5.2l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.6" r="3.6"/>'), '拍照分享', '成績與路線放進照片']];
  view.innerHTML = `
    <section class="welcome">
      <img class="wmark" src="/icons/icon-192.png" alt="" width="96" height="96">
      <h1 class="wtitle">${esc(org().short || '耕跑團')}</h1>
      <p class="wsub" translate="no">CULTIVATION IN LIFE RUN</p>
      <p class="wlead">一起練，跑得更遠</p>
      <ul class="wfeat">${feat.map(([i, t, d]) => `<li><span class="wic">${i}</span><b>${t}</b><span class="tiny">${d}</span></li>`).join('')}</ul>
    </section>
    <div id="sharedEv"></div>
    ${err ? `<div class="notice">${esc(err)}</div>` : ''}
    <section class="card authcard">
      ${cfg.googleLogin ? `<a class="btn google block" href="${googleHref()}">${GOOGLE_G}<span>${inAppBrowser() === 'line' ? '用瀏覽器開啟並以 Google 登入' : '使用 Google 帳號登入'}</span></a>
      ${inAppBrowser() === 'line' ? '<p class="tiny center" style="margin:0">Google 不允許在 LINE 裡登入，按上面的按鈕會改用 Safari 或 Chrome 打開這個網站。</p>' : ''}
      ${inAppBrowser() === 'meta' ? '<p class="notice" style="margin:0">Google 不允許在 Facebook／Instagram 裡登入：請點右上角「⋯」選「在瀏覽器開啟」。</p>' : ''}
      ${pkSupported() ? `<button class="btn ghost block iconbtn" id="pkLogin">${IC.lock}用通行金鑰登入</button>` : ''}
      <p class="tiny center">只取得你的 Google 名稱和大頭貼，不會取得 Email、不會讀取你的信件或雲端資料。<br>登入即表示你已閱讀並同意<a href="#/privacy">隱私權政策</a>。</p>` : ''}
      <details ${cfg.googleLogin ? '' : 'open'}>
        <summary class="muted" style="cursor:pointer">用邀請碼加入</summary>
        <form id="joinForm" style="margin-top:12px">
          <label>邀請碼<input name="code" required autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="LINE 群公告的代碼"></label>
          <label>姓名<input name="name" required maxlength="20" autocomplete="name" placeholder="報名時顯示的名字"></label>
          <div class="grid2">
            <label>項目<select name="dist"><option value="fm">全馬</option><option value="hm">半馬</option></select></label>
            <label>組別<select name="grp"></select></label>
          </div>
          <label class="inline"><input type="checkbox" name="consent" required> 我已閱讀並同意<a href="#/privacy">隱私權政策</a></label>
          <button class="btn block">加入</button>
        </form>
      </details>
    </section>
    ${org().parent ? `<p class="tiny center" style="margin:0">${esc(org().parent_note || `${org().parent} 支持`)}</p>` : ''}
    <section class="card">
      <h3>${esc(org().name || '台灣耕跑團協會')}</h3>
      <p class="muted" style="margin:0">入會申請使用協會的 Google 表單。</p>
      ${org().join_form ? `<a class="btn ghost block" href="${esc(org().join_form)}" target="_blank" rel="noopener">開啟入會表單</a>` : ''}
    </section>
    <div class="seg langseg" role="group" aria-label="Language" translate="no"><button data-lang="zh" aria-pressed="${I18N.lang === 'zh'}">中文</button><button data-lang="en" aria-pressed="${I18N.lang === 'en'}">English</button></div>`;
  for (const b of document.querySelectorAll('[data-lang]')) b.onclick = () => { if (b.dataset.lang !== I18N.lang) I18N.setLang(b.dataset.lang); };
  // 從分享連結進來：記住要去的活動，登入後直接帶過去
  if (shared) {
    try { sessionStorage.setItem('cil-after-login', `#/e/${shared}${sharedTok ? `?t=${encodeURIComponent(sharedTok)}` : ''}`); } catch {}
    api(`/public/e/${shared}${sharedTok ? `?t=${encodeURIComponent(sharedTok)}` : ''}`).then(({ event: e }) => {
      $('#sharedEv').innerHTML = `<section class="card shared">
        <span class="tiny">${e.visibility === 'invite' ? `${IC.lock} 你收到一個邀請制活動的邀請` : `有人邀請你${e.kind === 'survey' ? '填寫問卷' : '報名'}`}</span>
        <div class="row" style="gap:6px">${e.team ? `<span class="pill">${esc(e.team)}</span>` : ''}<span class="pill ${e.kind}">${KIND_NAME[e.kind] || '活動'}</span></div>
        <h2 style="margin:0"><span translate="no">${esc(e.title)}</span></h2>
        <p class="muted" style="margin:0">${dstr(e.date)}${e.gather_time ? ` ${e.gather_time}` : ''}${e.place ? `・<span translate="no">${esc(e.place)}</span>` : ''}</p>
        <p class="tiny" style="margin:0">先登入，登入後會直接回到這個活動。</p></section>`;
    }).catch(() => {});
  }
  $('#pkLogin')?.addEventListener('click', async () => {
    try { await passkey('login'); toast('登入成功'); me = null; render(); }
    catch (e) { if (e.message !== '已取消') toast(e.message); }
  });
  const f = $('#joinForm');
  if (!f) return;
  const sync = () => {
    f.grp.innerHTML = Object.entries(P.groups(f.dist.value)).map(([g, v]) => `<option value="${g}">${g} 組・${v[0]}</option>`).join('');
    f.grp.value = f.dist.value === 'hm' ? 'C' : 'D';
  };
  f.dist.onchange = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = (await api('/join', { method: 'POST', body: { code: f.code.value, name: f.name.value, dist: f.dist.value, grp: f.grp.value, consent: f.consent.checked } })).member;
      me = null; location.hash = '#/?welcome=1'; render();
    } catch (err) { toast(err.message); }
  };
}


// 依功能開關顯示或隱藏分頁
// 下方分頁列：管理員可以改名稱，每個人可以選只顯示圖示
const TAB_DEFAULT = { home: '團練', plan: '課表', run: '跑步', map: '地圖', studio: '拍照', me: '我的' };
// 附近即時影像的省流量：打開後地點卡的影像不自動載入、大圖不自動更新（只存在這支手機）
const camLazy = { get() { try { return localStorage.getItem('cil-cam-lazy') === '1'; } catch { return false; } }, set(v) { try { v ? localStorage.setItem('cil-cam-lazy', '1') : localStorage.removeItem('cil-cam-lazy'); } catch {} } };
const iconsOnly = { get() { try { return localStorage.getItem('cil-tab-icons') === '1'; } catch { return false; } }, set(v) { try { v ? localStorage.setItem('cil-tab-icons', '1') : localStorage.removeItem('cil-tab-icons'); } catch {} } };
function applyTabs() {
  const names = { ...TAB_DEFAULT, ...(cfg.settings?.tabs || {}) };
  for (const el of document.querySelectorAll('.tabs .tl')) { el.textContent = names[el.dataset.tl] || el.textContent; el.closest('a').setAttribute('aria-label', names[el.dataset.tl]); }
  document.body.classList.toggle('iconsonly', iconsOnly.get());
}
function applyFeatures() {
  applyTabs();
  const s = document.querySelector('.tabs a[data-tab="/studio"]'), r = document.querySelector('.tabs a[data-tab="/run"]');
  if (s) s.hidden = !feat('studio');
  if (r) r.hidden = !feat('gps');
}

// 倒數：自己的主要賽事 → 最近的自己的賽事 → 協會預設
function paintCountdown() {
  const r = cfg.race, el = $('#countdown');
  el.hidden = !me;
  if (!r?.date) { el.innerHTML = me ? '<small>設定倒數</small>' : ''; el.title = '選擇要倒數的比賽'; return; }
  const t = new Date(`${r.date}T00:00:00`), now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((t - now) / 864e5);
  const short = r.name.replace(/^20\d\d\s*/, '').replace('馬拉松', '馬').slice(0, 7);
  $('#countdown').innerHTML = days > 0 ? `<b class="num">${days}</b>天到${esc(short)}` : days === 0 ? `<b>今天</b>${esc(short)}` : '';
  $('#countdown').title = `${r.name}（${r.date}），點一下可以換`;
}
// 點右上角倒數：選要倒數哪一場（自己的賽事、常用賽事清單、協會預設，或不顯示）
async function countdownPicker() {
  if (!me) return;
  $('#cdSheet')?.remove();
  const d = await api('/races');
  const days = (date) => Math.round((new Date(`${date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const upcoming = d.races.filter((r) => days(r.date) >= 0);
  const mineIds = new Set(d.races.map((r) => `${r.name}|${r.date}`));
  const sheet = document.createElement('div');
  sheet.id = 'cdSheet'; sheet.className = 'sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', '選擇倒數的比賽');
  sheet.innerHTML = `<div class="sheet-bg" data-close></div><section class="card sheet-card">
    <div class="row spread"><h3>倒數哪一場比賽</h3><button class="btn ghost sm" data-close>完成</button></div>
    <div class="cdlist">
      ${upcoming.map((r) => `<button class="cdopt ${d.mode === 'mine' && r.is_primary ? 'on' : ''}" data-race="${r.id}"><span><b><span translate="no">${esc(r.name)}</span></b><span class="tiny">${esc(r.date)}${r.dist ? `・${esc(r.dist)}` : ''}${r.goal ? `・目標 ${esc(r.goal)}` : ''}</span></span><span class="num">${days(r.date)} 天</span></button>`).join('')}
      ${d.club ? `<button class="cdopt ${d.mode === 'club' ? 'on' : ''}" data-mode="club"><span><b><span translate="no">${esc(d.club.name)}</span></b><span class="tiny">協會預設・${esc(d.club.date)}</span></span><span class="num">${days(d.club.date)} 天</span></button>` : ''}
      <button class="cdopt ${d.mode === 'off' ? 'on' : ''}" data-mode="off"><span><b>不顯示倒數</b></span></button>
    </div>
    ${d.presets.filter((p) => !mineIds.has(`${p.name}|${p.date}`)).length ? `<h3 style="margin-top:6px">常用賽事</h3><div class="cdlist">${d.presets.filter((p) => !mineIds.has(`${p.name}|${p.date}`)).map((p, i) => `<button class="cdopt" data-preset="${i}"><span><b><span translate="no">${esc(p.name)}</span></b><span class="tiny">${esc(p.date)}${p.dist ? `・${esc(p.dist)}` : ''}</span></span><span class="tiny">加入並倒數</span></button>`).join('')}</div>` : ''}
    <details><summary class="tiny" style="cursor:pointer">自己新增一場</summary>
      <form id="cdAdd" class="filters" style="margin-top:8px">
        <input name="name" maxlength="30" placeholder="比賽名稱，例如 2027 東京馬拉松" required aria-label="比賽名稱">
        <div class="grid2"><input type="date" name="date" required aria-label="比賽日期"><input name="goal" maxlength="10" placeholder="目標成績（選填）" aria-label="目標成績"></div>
        <button class="btn sm">加入並倒數</button></form></details>
  </section>`;
  document.body.append(sheet);
  const presets = d.presets.filter((p) => !mineIds.has(`${p.name}|${p.date}`));
  const done = async (msg) => { const r = await api('/me'); cfg = r; me = r.member; paintCountdown(); toast(msg); sheet.remove(); };
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-close],[data-race],[data-mode],[data-preset]'); if (!t) return;
    try {
      if (t.dataset.close != null) { sheet.remove(); return; }
      if (t.dataset.race) { await api(`/races/${t.dataset.race}/primary`, { method: 'POST' }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); return done('已換成這場比賽'); }
      if (t.dataset.mode) { await api('/me/countdown', { method: 'POST', body: { mode: t.dataset.mode } }); return done(t.dataset.mode === 'off' ? '已關閉倒數' : '已換成協會預設'); }
      if (t.dataset.preset) { const p = presets[Number(t.dataset.preset)]; await api('/races', { method: 'POST', body: { ...p, is_primary: true } }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); return done(`開始倒數：${p.name}`); }
    } catch (err) { toast(err.message); }
  });
  $('#cdAdd').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('/races', { method: 'POST', body: { name: f.name.value, date: f.date.value, goal: f.goal.value, is_primary: true } }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); done(`開始倒數：${f.name.value}`); }
    catch (err) { toast(err.message); }
  };
  addEventListener('keydown', function esc0(e) { if (e.key === 'Escape') { sheet.remove(); removeEventListener('keydown', esc0); } });
}
$('#countdown').addEventListener('click', countdownPicker);

// ---------- 隱私權政策（個人資料保護法第 8 條告知事項）----------
// 協會名稱、聯絡方式、保存期限、政策內容都由後台「系統設定」管理
const PRIVACY = {
  get org() { return org().name ? `${org().name}（${org().short || '耕跑團'}）` : '台灣耕跑團協會（耕跑團）'; },
  get contact() { return org().contact || '請透過 LINE 群組聯絡協會行政人員'; },
  get retention() { return org().retention || '帳號存續期間'; },
  get version() { return cfg.privacyVersion || ''; },
};
// 管理者自訂的政策內容：「## 」開頭是標題、「- 」開頭是清單、空行分段；一律跳脫，不接受 HTML
function richText(src) {
  return esc(src).split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => l.startsWith('- '))) return `<ul>${lines.map((l) => `<li>${l.slice(2)}</li>`).join('')}</ul>`;
    if (block.startsWith('## ')) return `<h3>${block.slice(3)}</h3>`;
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');
}
// 隱私權政策每次改版的重點：要重新同意時放在最上面，不用整篇讀完才知道改了什麼
const PRIVACY_CHANGES = {
  '2026-10-03.4': ['你填的通訊地址（選填）會送到中華郵政的郵遞區號服務核對寫法、補上郵遞區號，只送地址文字，不含姓名'],
  '2026-10-03.3': ['新增「賽事報名資料」：只有要幹部代為團體報名時才填，加密保存，逐場同意後才提供給主辦幹部', '記錄 App 的開啟速度與錯誤訊息，只記裝置類型與頁面，不記是誰'],
};
function privacyView() {
  const custom = cfg.settings?.privacy?.body;
  const asking = !!(me && cfg.needConsent);
  document.body.classList.toggle('consent', asking);
  const changes = PRIVACY_CHANGES[PRIVACY.version];
  view.innerHTML = `
    ${largeTitle('隱私權政策', `版本 ${PRIVACY.version}`)}
    ${asking ? `<section class="card notice-card"><b>${changes ? '這次更新了什麼' : '請閱讀並同意'}</b>
      ${changes ? `<ul class="steps">${changes.map((c) => `<li>${c}</li>`).join('')}</ul>` : '<p class="tiny" style="margin:0">使用前請先閱讀下面的個人資料告知事項。</p>'}
      <p class="tiny" style="margin:0">全文在下方，同意後就會回到剛才的頁面。</p></section>` : ''}
    ${custom ? `<section class="card prose">${richText(custom)}</section>` : `<section class="card prose">
      <p>依個人資料保護法第 8 條，${esc(PRIVACY.org)}在蒐集您的個人資料前，告知以下事項。</p>
      <h3>一、蒐集目的</h3>
      <p>〇五二 法人或團體對會員之內部管理（團練報名、分組課表、會籍管理）；〇六九 契約、類似契約或其他法律關係事務（活動報名、入場與抽獎）；一三五 資（通）訊服務（通知推播）。</p>
      <h3>二、蒐集的資料</h3>
      <p>識別類（C001）：姓名、暱稱、Google 帳號的顯示名稱與大頭貼（不取得 Email）、電話（選填）。<br>
         活動相關：項目與組別、所屬跑團、加入的分團與分團身分、餐點偏好、報名與報到紀錄、活動問卷的回答、中獎紀錄。<br>
         系統紀錄：登入時間、裝置型號摘要、IP 位址的單向雜湊值（無法還原）；App 的開啟速度與錯誤訊息只記裝置類型與頁面，不記是誰，保留 90 天。<br>
         個人賽事：你自己加入的賽事名稱、日期與目標成績（用於倒數）。<br>
         訓練紀錄：你照課表記錄的日期、距離、時間、心率、自覺強度、感覺與備註；預設只有你看得到，你打開分享後，教練與分團幹部只看得到完成率、里程與平均強度，看不到備註。<br>
         照片：拍照分享的照片在你的手機上合成，不會上傳到我們的伺服器。<br>
         賽事報名資料（選填）：只有你需要幹部代為報名馬拉松等賽事時才填，包含中英文姓名、身分證字號或護照號碼、生日、性別、電話、Email、地址、緊急聯絡人與衣服尺寸；<b>加密後保存</b>，只有你自己看得到完整內容。<br>
         協會入會申請另以協會的 Google 表單辦理。</p>
      <h3>三、利用期間、地區、對象與方式</h3>
      <p>期間：${esc(PRIVACY.retention)}。<br>
         地區：台灣，以及雲端服務（Cloudflare）的資料中心所在地。<br>
         對象：依職務最小權限開放給協會幹部；分團團長與幹部可以看自己分團的名冊（不含電話）與該分團活動的報名及問卷結果；電話完整號碼只有行政人員看得到。賽事報名資料只在你報名「代為團體報名」的活動並勾選同意後，提供給該活動的主辦幹部，用來向賽事主辦單位送出團體報名，每次下載都留有稽核紀錄。通訊地址存檔前會送到中華郵政的 3+3 郵遞區號服務核對寫法並補上郵遞區號，只傳送地址文字。練跑地圖的「附近即時影像」由本站伺服器向政府公開攝影機取得畫面再轉給你，你的 IP 與位置不會傳給影像來源，本站也不保存影像。不提供給第三方行銷使用。<br>
         方式：以電子方式處理，全程加密傳輸。</p>
      <h3>四、您的權利</h3>
      <p>您可以隨時行使個人資料保護法第 3 條的權利：</p>
      <ul>
        <li>查詢、閱覽、製給複本：「我的 → 隱私 → 下載我的資料」</li>
        <li>補充或更正：「我的 → 個人資料」直接修改</li>
        <li>停止蒐集、處理、利用及刪除：「我的 → 隱私 → 刪除帳號」</li>
      </ul>
      <h3>五、不提供資料的影響</h3>
      <p>姓名與組別是報名與排課表的必要資料；不提供就無法報名活動。賽事報名資料只在報名「代為團體報名」的活動時需要，不填不影響其他功能。其他欄位都是選填。</p>
      <h3>六、安全措施</h3>
      <p>存取控制依職務分級、特權操作留有稽核紀錄、登入權杖只存雜湊值，並設有嘗試次數限制。詳見專案的資訊安全設計說明。</p>
      <h3>七、聯絡方式</h3>
      <p>${esc(PRIVACY.contact)}。</p>
    </section>`}
    ${asking ? `<div class="consentbar"><span class="tiny">同意後才能繼續使用</span><button class="btn" id="consentBtn">同意並繼續</button></div>` : ''}`;
  $('#consentBtn')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api('/me/consent', { method: 'POST' }); } catch (err) { e.target.disabled = false; return toast(err.message); }
    cfg.needConsent = false; document.body.classList.remove('consent'); toast('已同意，謝謝');
    let back = '#/'; try { back = sessionStorage.getItem('cil-after-consent') || '#/'; sessionStorage.removeItem('cil-after-consent'); } catch {}
    location.hash = back.startsWith('#/privacy') ? '#/' : back;
  });
}

// ---------- 團練列表 ----------
// 首頁的分團篩選（記在這台裝置）
const teamFilter = {
  get() { try { return localStorage.getItem('cil-team') || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem('cil-team', v) : localStorage.removeItem('cil-team'); } catch {} },
};
async function listView() {
  const all = takeBoot('events') || (await api('/events')).events;
  const mine = myTeams();
  let pick = teamFilter.get();
  if (pick && pick !== 'assoc' && !mine.some((t) => t.id === pick)) pick = '';
  const events = !pick ? all : pick === 'assoc' ? all.filter((e) => !e.team_id) : all.filter((e) => e.team_id === pick);
  const next = events[0];
  const [strip, today] = await Promise.all([weekStrip(), todayCard(all)]);
  const chips = mine.length ? `<div class="chipbar" role="tablist" aria-label="依分團篩選">
      <button role="tab" data-tf="" aria-selected="${!pick}">全部</button>
      <button role="tab" data-tf="assoc" aria-selected="${pick === 'assoc'}">全協會</button>
      ${mine.map((t) => `<button role="tab" data-tf="${esc(t.id)}" aria-selected="${pick === t.id}" style="--tc:${esc(t.color)}">${t.icon ? `<img class="ticon xs" src="${esc(t.icon)}" alt="">` : '<i></i>'}<span translate="no">${esc(t.name)}</span></button>`).join('')}
    </div>` : '';
  const teamLink = `<a class="chiplink" href="#/teams">${mine.length ? `${IC.plus}分團` : '加入分團 ›'}</a>`;
  // 第二次打開以後才提示安裝，不要一進來就打擾
  let visits = 0;
  try {
    visits = Number(localStorage.getItem('cil-visits') || 0);
    if (!sessionStorage.getItem('cil-counted')) { visits += 1; localStorage.setItem('cil-visits', String(visits)); sessionStorage.setItem('cil-counted', '1'); }
  } catch {}
  const welcome = new URLSearchParams(location.hash.split('?')[1] || '').get('welcome');
  view.innerHTML = `
    ${largeTitle('團練', todayLabel())}
    ${welcome ? '<div class="notice">歡迎加入耕跑團！先看看今天的課表和接下來的團練；主團會由管理員幫你設定，也可以到「我的 → 主團與分團」申請加入分團。</div>' : ''}
    ${mfaBanner()}
    ${visits >= 2 ? installCard('home') : ''}
    <div class="chiprow">${chips}${teamLink}</div>
    <div class="dash"><div style="display:grid;gap:14px">
    ${today}
    <section class="card" id="reviewCard" hidden></section>
    <a class="card tight wxmini" id="homeWx" hidden></a>
    ${strip}
    ${next ? heroCard(next) : `<section class="card hero"><span class="sweep"></span><h2>還沒有排定的團練</h2><p class="muted" style="margin:0">幹部發布後，這裡就會出現，也會推播通知你。</p></section>`}
    </div><div style="display:grid;gap:12px">
    <div class="section-h">
      <h2>接下來</h2>
      ${anyTeamAllow('event') ? `<a class="btn ghost sm iconbtn" href="#/new${pick && pick !== 'assoc' ? `?team=${esc(pick)}` : ''}">${IC.plus}新增活動</a>` : ''}
    </div>
    <div class="evgrid">${events.slice(1).map(eventCard).join('') || `<div class="card">${emptyState('calendar', '目前沒有其他排定的活動')}</div>`}</div>
    <div class="row center" style="gap:18px;justify-content:center"><a class="tiny" href="#/calendar" style="padding:4px">${IC.calendar} 行事曆</a><a class="tiny" href="#/past" style="padding:4px">看過去的團練 ›</a></div>
    </div></div>`;
  for (const b of document.querySelectorAll('[data-tf]')) b.onclick = () => { teamFilter.set(b.dataset.tf); listView(); };
  homeWeather(all);
  bindTodayCard();
  if (anyTeamAllow('event')) reviewCard();
  bindInstall();
  bindStepup();
  flushLogQueue();
  if (!me.mfaPending) Guide.maybeStart();   // 第一次登入：使用說明導覽
}
// 幹部：報名待審核（畫面畫好後才載入，有資料才顯示）
async function reviewCard() {
  const r = await api('/me/reviews').catch(() => null), box = $('#reviewCard');
  if (!r?.events?.length || !box?.isConnected) return;
  box.innerHTML = `<h3>報名待審核</h3>${r.events.map((e) => `<a class="todayev" href="#/e/${esc(e.id)}/stats?f=pending">${IC.calendar}<span><b><span translate="no">${esc(e.title)}</span></b><span class="tiny" style="display:block">${dstr(e.date)}・${e.n} 筆${e.seatsLeft != null ? `・剩 ${e.seatsLeft} 個名額` : ''}</span></span><span class="tiny">›</span></a>`).join('')}`;
  box.hidden = false;
}
// 首頁天氣：今天報名的活動有指定地點就用那裡，否則用「常跑地點」；畫面畫好後才載入，不拖慢開啟
async function homeWeather(events) {
  const box = $('#homeWx'); if (!box) return;
  const t = ymd(new Date()), ev = events.find((e) => e.date === t && e.mine === 'in' && e.spot_id);
  let spot = cfg.homeSpot;
  if (ev) spot = (await api('/spots').catch(() => ({ spots: [] }))).spots.find((x) => x.id === ev.spot_id) || spot;
  if (!spot) return;
  try {
    const W = await import('./weather.js'), w = await W.load(spot.lat, spot.lng);
    const hour = ev?.gather_time ? `${t}T${ev.gather_time.slice(0, 2)}:00` : `${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13)}:00`;
    const x = W.at(w, hour);
    if (!x || !box.isConnected) return;
    box.href = `#/map?spot=${encodeURIComponent(spot.id)}`;
    box.className = `card tight wxmini ${x.advice.level}`;
    box.innerHTML = `<span class="wxt num">${Math.round(x.temp)}°</span><span><b><span translate="no">${esc(spot.name)}</span>${ev ? `・${esc(ev.gather_time)}` : ''}</b><span class="tiny" style="display:block">${esc(x.text)}・體感 ${Math.round(x.feel)}°・降雨 ${x.rain ?? 0}%${x.aqi != null ? `・AQI ${x.aqi}` : ''}</span></span><span class="pill">${x.advice.label}</span>`;
    box.hidden = false;
  } catch {}
}
// 今天：照我的課表週期，今天要練的課、今天報名的活動、一鍵記錄完成（打開 App 第一眼就知道今天要做什麼）
//   擇一天的課（週末、週五或週六）每個候選日都會出現，直到記錄為止
let todayTick = null;   // 「完成了」要記的那一列：{ c, n, row, date }
async function todayCard(events) {
  const t = ymd(new Date()), c = myCycle(), personal = c.kind !== 'club', wi = P.weekIndexOf(t, c);
  // 離線時先存在手機、還沒上傳的紀錄也算（剛按「完成了」就看得到，不會再按一次）
  const pend = (from) => logQueue.get().filter((x) => x.date >= from && x.date <= t).map((x) => ({ ...x, id: null, pending: true }));
  // 開 App 時一起帶回這週一到今天的紀錄（boot）：擇一天的課不必再等一輪網路才畫得出來
  const wk = takeBoot('weekLogs'), bootToday = takeBoot('todayLogs');
  const logs = [...notQueued(wk ? wk.logs.filter((l) => l.date === t) : bootToday || (await api(`/logs?from=${t}&to=${t}`).catch(() => ({ logs: [] }))).logs), ...pend(t)];
  const done = logs.find((l) => l.status !== 'skip') || logs[0];
  const todays = events.filter((e) => e.date === t && ['in', 'wait', 'pending'].includes(e.mine));
  todayTick = null;
  let main = '', act = '';
  if (wi < 1) {
    main = `<h2>${w1Line(c, t)}</h2><div class="row" style="gap:16px"><a class="tiny" href="#/plan/1">看 W1 ›</a>${personal ? '<a class="tiny" href="#/plan?c=club">先看協會課表 ›</a>' : ''}</div>`;
  } else if (wi > 21) {
    main = `<h2>這個週期結束了</h2><a class="tiny" href="${feat('plan_cycle') ? '#/plan/setup?go=cycle' : '#/me/races'}">設定下一場 ›</a>`;
  } else if (!(await P.weekPlan(wi, me.dist, me.grp))) {
    // 這週還沒有課表資料（W1 還沒公告；個人週期也照同一份範本）
    main = `<h2>W${wi} 課表還沒公告</h2>${personal ? '<a class="tiny" href="#/plan?c=club">先看協會課表 ›</a>' : ''}`;
  } else {
    const rows = P.markOptional(await P.weekPlan(wi, me.dist, me.grp), feat('coach') ? coachPrefs().plan : undefined, wi);
    let ses = P.todaySessions(t, wi, rows, [], c);
    // 擇一天的課：前幾天已經記錄過就不再出現（要多查這週前幾天的紀錄）
    const firstDate = ses.map((r) => P.dayDates(wi, r.d, c, r)[0]).sort()[0];
    let weekLogs = logs;
    if (firstDate && firstDate < t) {
      weekLogs = wk?.from <= firstDate ? [...notQueued(wk.logs.filter((l) => l.date >= firstDate)), ...pend(firstDate)]
        : [...notQueued((await api(`/logs?from=${firstDate}&to=${t}`).catch(() => ({ logs: logs.filter((l) => !l.pending) }))).logs), ...pend(firstDate)];
    }
    const logOf = (r) => weekLogs.filter((l) => P.logMatches(l, c, wi, r));
    ses = ses.filter((r) => !logOf(r).some((l) => l.date < t));
    const race = ses.find((r) => P.isRaceDay(r, wi));
    const runs = ses.filter((r) => r.kind !== 'rest');
    if (race) main = `<h2 class="race">今天就是 <span translate="no">${esc(c.name)}</span>，加油</h2>${feat('coach') ? '<a class="tiny" href="#/plan/race">比賽日計劃 ›</a>' : ''}`;
    else if (ses.length && !runs.length) main = '<h2>今天休息</h2><p class="muted" style="margin:0">好好睡、補充水分，明天再練。</p>';
    else main = runs.map((r) => {
      const hint = P.paceHint(r.t, me.dist, me.grp), multi = P.dayDates(wi, r.d, c, r).length > 1;
      return `<h2 class="${r.kind}">${esc(fixText(r.t))}</h2><p class="muted" style="margin:0">${P.KIND_LABEL[r.kind]}${r.opt ? '・可省略' : ''}${hint ? `・${hint}` : ''}${multi ? '・擇一天' : ''}</p>`;
    }).join('');
    const next = runs.find((r) => !logOf(r).length), logged = runs.map((r) => logOf(r)[0]).find(Boolean);
    if (next) {
      todayTick = { c, n: wi, row: next, date: t };
      act = `<div class="grid2">${feat('gps') ? `<a class="btn iconbtn" href="#/run" style="justify-content:center">${IC.runner}開始跑步</a>` : ''}<button type="button" class="btn ${feat('gps') ? 'ghost ' : ''}iconbtn" id="tdDone" style="justify-content:center${feat('gps') ? '' : ';grid-column:1/-1'}">${IC.check}完成了</button></div>
        <a class="tiny" href="#/log?w=${wi}&i=${next.i}${personal ? '&c=r' : ''}">填寫詳細 ›</a>`;
    } else if (logged?.pending) {
      act = '<p class="tiny" style="margin:0">待上傳：連上網路會自動上傳</p>';
    } else if (logged) {
      act = logged.km || logged.seconds || logged.status === 'skip' ? `<a class="btn ghost sm" href="#/log?id=${logged.id}">看今天的紀錄</a>` : `<a class="btn ghost sm" href="#/log?id=${logged.id}">補填距離</a>`;
    }
  }
  if (!main && !todays.length && !done) return '';
  return `<section class="card todaycard">
    <div class="row spread"><span class="tiny">今天・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組${personal && wi >= 1 && wi <= 21 ? `・個人 W${wi}` : ''}</span>${done ? `<span class="pill solid">${LOG_ICON[done.status]}${LOG_STATUS_NAME[done.status]}</span>` : ''}</div>
    ${main}
    ${todays.map((e) => `<a class="todayev" href="#/e/${e.id}">${IC.calendar}<span><b><span translate="no">${esc(e.title)}</span></b><span class="tiny" style="display:block">${e.gather_time ? `${e.gather_time} 集合` : ''}${e.place ? `・<span translate="no">${esc(e.place)}</span>` : ''}${e.mine === 'wait' ? '・候補中' : e.mine === 'pending' ? '・審核中' : ''}</span></span><span class="tiny">›</span></a>`).join('')}
    ${act}
  </section>`;
}
// 首頁「完成了」：記下今天這一課（不必填距離），可以復原
function bindTodayCard() {
  const b = $('#tdDone');
  if (b && todayTick) b.onclick = () => quickTick(b, todayTick.c, todayTick.n, todayTick.row, todayTick.date);
}
// 本週在整季的哪裡：階段（顏色）、週次進度與三堂重點課；個人週期照自己的 21 週
async function weekStrip() {
  const c = myCycle(), personal = c.kind !== 'club', t = ymd(new Date()), wi = P.weekIndexOf(t, c);
  const w = Math.min(21, Math.max(1, wi)), all = await P.weeks(), info = all[w - 1];
  const days = await P.weekPlan(w, me.dist, me.grp);
  const key = (days || []).filter((d) => d.kind === 'quality' || d.kind === 'long' || d.kind === 'race').slice(0, 3);
  return `<section class="card weekstrip">
    <div class="row spread">
      <span class="hd"><b>W${w}</b><span class="muted">${info?.phase || ''}${info?.recovery && w !== 21 ? '・恢復週' : ''}${personal ? '・個人週期' : ''}</span></span>
      <a class="tiny" href="#/plan">完整課表 ›</a>
    </div>
    ${wi < 1 ? `<p class="muted" style="margin:0">${w1Line(c, t)}</p>`
      : `<div class="dots" aria-hidden="true">${all.slice(0, 21).map((x, i) =>
        `<i data-ph="${P.PHASES[x.phase] || 'base'}" class="${i + 1 < wi ? 'done' : i + 1 === wi ? 'now' : ''}"></i>`).join('')}</div>`}
    <div class="keys">${key.map((d) => `<div><span class="d">${esc(dayLabel(d.d))}</span><span>${P.isRaceDay(d, w) && personal ? `比賽日：<span translate="no">${esc(c.name)}</span>` : esc(fixText(d.t))} <span class="hint">${P.paceHint(d.t, me.dist, me.grp)}</span></span></div>`).join('')
      || '<div class="muted">這週沒有重點課。</div>'}</div>
  </section>`;
}

// 首頁大卡右下角：先看自己的狀態，再看報名期間
function heroPill(e) {
  const glass = (t) => `<span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${t}</span>`;
  if (e.mine === 'in') return '<span class="pill" style="background:#fff;color:#1C4698">已報名</span>';
  if (e.mine === 'wait') return '<span class="pill wait">候補中</span>';
  if (e.mine === 'pending') return '<span class="pill wait">審核中</span>';
  if (e.mine === 'rejected') return '<span class="pill no">未通過</span>';
  const st = signupState(e, nowTp());
  if (st === 'cancelled') return glass('已取消');
  if (st === 'off') return glass('未開放報名');
  if (st === 'soon') return glass(`${tpShort(e.signup_start)} 開放`);
  if (st === 'ended') return glass('報名已截止');
  return glass(e.capacity && e.signed >= e.capacity ? '額滿・可候補' : '去報名 ›');
}
function heroCard(e) {
  const d = d2(e.date), days = Math.round((d - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return `<a class="card hero" href="#/e/${e.id}">
    <span class="sweep" aria-hidden="true"></span>
    <div class="row spread">
      <span class="row" style="gap:6px"><span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${KIND_NAME[e.kind]}</span>${e.team_id && teamOf(e.team_id) ? `<span class="pill" style="background:rgba(255,255,255,.14);color:#fff"><span translate="no">${esc(teamOf(e.team_id).name)}</span></span>` : ''}</span>
      <span class="tiny">${days <= 0 ? '就是今天' : days === 1 ? '明天' : `${days} 天後`}</span>
    </div>
    <h2><span translate="no">${esc(e.title)}</span></h2>
    <p class="muted" style="margin:0">${dstr(e.date)}${e.gather_time ? ` ${e.gather_time} 集合` : ''}${e.place ? `・<span translate="no">${esc(e.place)}</span>` : ''}</p>
    <div class="row spread">
      <span class="row" style="gap:8px">${avatarStack(e.peek || [], e.signed)}<span class="tiny">${e.signed} 人報名${e.waiting ? `・候補 ${e.waiting}` : ''}${e.capacity ? `／${e.capacity}` : ''}</span></span>
      ${heroPill(e)}
    </div>
  </a>`;
}
function eventCard(e) {
  const pct = e.capacity ? Math.min(100, Math.round(e.signed / e.capacity * 100)) : 0;
  return `<a class="card lit" href="#/e/${e.id}">
    <div class="ev">
      <span class="cal"><u>${d2(e.date).getMonth() + 1}月</u><b class="num">${e.date.slice(8)}</b><span>週${WD[d2(e.date).getDay()]}</span></span>
      <span class="body">
        <span class="pills"><span class="pill ${e.kind}">${KIND_NAME[e.kind] || '活動'}</span>${teamTag(teamOf(e.team_id))}${e.visibility === 'invite' ? `<span class="pill lock">${IC.lock}邀請制</span>` : ''}</span>
        <span class="t"><span translate="no">${esc(e.title)}</span></span>
        <span class="tiny">${e.gather_time ? `${e.gather_time}　` : ''}<span translate="no">${esc(e.place || '')}</span>${(() => { const ps = [...(e.options || []), ...(e.kind === 'buy' ? e.items || [] : [])].map((o) => o.price).filter(Boolean); return ps.length ? `　${money(Math.min(...ps))} 起` : e.fee ? `　${money(e.fee)}` : ''; })()}${!e.mine && e.signup_start && signupState(e, nowTp()) === 'soon' ? `　${tpShort(e.signup_start)} 開放` : ''}</span>
        ${e.capacity ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}
      </span>
      <span class="evright">${e.mine === 'in' ? `<span class="mine">${IC.check}已報名</span>` : e.mine === 'wait' ? '<span class="mine wait">候補中</span>'
        : e.mine === 'pending' ? '<span class="mine wait">審核中</span>' : e.mine === 'rejected' ? '<span class="mine no">未通過</span>' : ''}
        ${e.pending ? `<span class="pill wait">待審核 ${e.pending}</span>` : ''}
        ${e.signed ? `${avatarStack(e.peek || [], e.signed)}<span class="tiny num">${e.signed}${e.capacity ? `/${e.capacity}` : ' 人'}</span>` : ''}</span>
    </div>
  </a>`;
}
async function pastView(month) {
  month ||= new Date().toISOString().slice(0, 7);
  const { events } = await api(`/events?past=1&month=${month}`);
  const shift = (n) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const isNow = month >= new Date().toISOString().slice(0, 7);
  view.innerHTML = `${largeTitle('過去的團練')}
    <div class="monthbar"><button class="btn ghost sm" data-m="${shift(-1)}" aria-label="上個月">‹</button>
      <input type="month" id="pm" aria-label="選擇月份" value="${month}" max="${new Date().toISOString().slice(0, 7)}">
      <button class="btn ghost sm" data-m="${shift(1)}" aria-label="下個月" ${isNow ? 'disabled' : ''}>›</button></div>
    <div class="evgrid">${events.map(eventCard).join('') || `<div class="card">${emptyState('calendar', '這個月沒有紀錄')}</div>`}</div>`;
  for (const b of document.querySelectorAll('[data-m]')) b.onclick = () => pastView(b.dataset.m);
  $('#pm').onchange = (e) => e.target.value && pastView(e.target.value);
}

// ---------- 活動詳情 ----------
async function eventView(id) {
  // 從邀請連結進來：先把自己加進受邀名單
  const tok = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  if (tok) {
    try { await api(`/events/${id}/accept`, { method: 'POST', body: { t: tok } }); } catch (e) { toast(e.message); }
    history.replaceState(null, '', `#/e/${id}`);
  }
  const ev = await api(`/events/${id}`);
  // 打開活動頁＝這個活動的通知都看過了（伺服器會排除幹部待辦與帳號安全）
  if (bellState.unread > 0) api('/notifications/read', { method: 'POST', body: { ref: `e:${id}` } }).then(applyCounts).catch(() => {});
  const inviteOnly = ev.visibility === 'invite';
  const admin = ev.manage;
  const survey = ev.kind === 'survey', qs = ev.questions || [];
  const useForm = ev.kind === 'party' || qs.length > 0 || (ev.options || []).length > 0 || !!ev.group_reg || (ev.items || []).length > 0 || charges(ev);
  const ins = ev.signups.filter((s) => s.status === 'in'), waits = ev.signups.filter((s) => s.status === 'wait');
  // 自己的狀態一律從 myStatus 取（待審核、未通過不在公開的 signups 裡）
  const myStatus = ev.myStatus, live = ['in', 'wait', 'pending'].includes(myStatus);
  const now = nowTp(), st = signupState(ev, now), full = !!ev.capacity && ins.length >= ev.capacity;
  const canSubmit = st === 'open' && myStatus !== 'rejected', started = now >= evStart(ev);
  const party = ev.kind === 'party';
  // 入場券、座位、當週課表同時載入
  const [myTicket, seatInfo, plan] = await Promise.all([
    party ? api('/my/tickets').then((r) => r.tickets.find((t) => t.event_id === ev.id)) : null,
    party ? api(`/events/${id}/seats`) : { seats: [], layout: null },
    ev.week_no ? P.weekPlan(ev.week_no, me.dist, me.grp) : null]);
  const seatData = seatInfo.seats;
  const myDay = plan?.find((d) => new RegExp(dayPattern(ev.date)).test(d.d));
  // 個人週期：團練是協會的課，另外列出自己課表這天要練什麼
  const cyc = myCycle(), cw = cyc.kind !== 'club' && P.inCycle(ev.date, cyc) ? P.weekIndexOf(ev.date, cyc) : null;
  const myOwn = cw ? (await P.weekPlan(cw, me.dist, me.grp))?.find((d) => P.dayDates(cw, d.d, cyc, d).includes(ev.date)) : null;

  view.innerHTML = `
    <section class="card hero">
      <div class="row spread">
        <span class="row" style="gap:6px"><span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${KIND_NAME[ev.kind]}</span>${ev.team ? `<a class="pill" style="background:rgba(255,255,255,.14);color:#fff" href="#/t/${esc(ev.team.id)}"><span translate="no">${esc(ev.team.name)}</span></a>` : ''}${inviteOnly ? `<span class="pill" style="background:rgba(255,255,255,.14);color:#fff">${IC.lock}邀請制</span>` : ''}</span>
        <span class="tiny">${survey ? `${dstr(ev.date)} 前` : dstr(ev.date)}</span>
      </div>
      <h2><span translate="no">${esc(ev.title)}</span></h2>
      <p class="muted" style="margin:0">${ev.gather_time ? `${ev.gather_time} ${party ? '開始' : '集合'}` : ''}${ev.end_time ? `－${ev.end_time}` : ''}${ev.place ? `　<span translate="no">${esc(ev.place)}</span>` : ''}${ev.lead ? `　帶團：<span translate="no">${esc(ev.lead)}</span>` : ''}</p>
      ${ev.address || (ev.place && !ev.spot) ? `<a class="navlink" href="${mapsUrl(ev.address || ev.place)}" target="_blank" rel="noopener">${IC.pin}<span>${ev.address ? `${ev.address_zip ? `<span class="num">${esc(ev.address_zip)}</span> ` : ''}<span translate="no">${esc(ev.address)}</span>` : '在地圖上查看'}</span><b>導航</b></a>` : ''}
      ${(ev.options || []).length || (ev.items || []).length ? `<div class="pricechips">${[...(ev.options || []), ...(ev.items || [])].map((o) => `<span><b><span translate="no">${esc(o.name)}</span></b>${o.price ? `<span class="num">${money(o.price)}</span>` : ''}</span>`).join('')}</div>`
        : ev.fee ? `<div class="pricechips"><span><b>費用</b><span class="num">${money(ev.fee)}</span></span></div>` : ''}
      ${ev.pricing?.early_off && ev.pricing.early_until >= ymd(new Date()) ? `<p class="tiny" style="margin:0;color:rgba(255,255,255,.9)">早鳥 ${esc(ev.pricing.early_until.slice(5).replace('-', '/'))} 前報名折 ${money(ev.pricing.early_off)}${ev.pricing.member_off ? `・協會會員再折 ${money(ev.pricing.member_off)}` : ''}</p>`
        : ev.pricing?.member_off ? `<p class="tiny" style="margin:0;color:rgba(255,255,255,.9)">協會會員折 ${money(ev.pricing.member_off)}</p>` : ''}
      ${ev.cancelled ? '<p class="cancelled">這場已取消</p>' : `<p class="tiny" style="margin:0;color:rgba(255,255,255,.9)">${survey ? `回覆截止 ${tpText(signupEnd(ev))}`
        : `報名期間 ${ev.signup_start ? tpText(ev.signup_start) : '即日起'} – ${tpText(signupEnd(ev))}${ev.require_approval ? '・需主辦審核' : ''}`}</p>`}
      ${ev.group_reg ? '<p class="tiny" style="margin:0;color:rgba(255,255,255,.85)">由幹部代為團體報名</p>' : ''}
      ${(ev.series || []).length > 1 ? `<div class="serieschips" aria-label="定期揪跑的其他場次">${ev.series.filter((x) => x.date >= ymd(new Date())).slice(0, 8).map((x) => `<a class="${x.id === ev.id ? 'on' : ''}" href="#/e/${esc(x.id)}">${esc(dstr(x.date))}</a>`).join('')}</div>` : ''}
      ${ev.note ? `<p class="muted" style="margin:0;white-space:pre-wrap"><span translate="no">${esc(ev.note)}</span></p>` : ''}
      ${ev.link_url ? `<a class="btn block" style="background:#fff;color:#1C4698" href="${esc(ev.link_url)}" target="_blank" rel="noopener">${esc(ev.link_label || '前往登記')} ${IC.external}</a>` : ''}
      ${inviteOnly && !admin ? '' : `<div class="row sharebar">
        <button class="btn sm glassbtn" id="shareEv"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/></svg>分享</button>
        <a class="btn sm glassbtn" id="shareLine" href="#" rel="noopener">分享到 LINE</a>
        <button class="btn sm glassbtn" id="copyLink">${inviteOnly ? '複製邀請連結' : '複製報名連結'}</button>
        ${admin ? `<a class="btn sm glassbtn" href="#/e/${ev.id}/stats">統計 ›</a>` : ''}
      </div>`}
    </section>
    ${inviteOnly && admin ? inviteCard(ev) : ''}

    ${myDay ? `<section class="card">
      <div class="row spread"><h3>${cyc.kind !== 'club' ? `協會 W${ev.week_no} 課表` : '你這天的課表'}</h3><span class="pill">${me.dist === 'hm' ? '半馬' : '全馬'} ${me.grp} 組</span></div>
      <div class="day ${myDay.kind}">
        <span class="dl"><span>${esc(myDay.d)}</span><span class="k">${P.KIND_LABEL[myDay.kind]}</span></span>
        <span class="t">${esc(myDay.t)} <span class="hint">${P.paceHint(myDay.t, me.dist, me.grp)}</span></span>
      </div>${cyc.kind !== 'club' ? `<p class="tiny" style="margin:0">你的課表這天：${myOwn ? (P.isRaceDay(myOwn, cw) ? `比賽日：<span translate="no">${esc(cyc.name)}</span>` : esc(fixText(myOwn.t))) : '沒有排課'}</p>` : ''}</section>` : ''}
    ${ev.plan_text ? `<section class="card"><h3>課表</h3><pre class="out">${esc(ev.plan_text)}</pre></section>` : ''}
    ${ev.spot ? `<section class="card"><div class="row spread"><h3>場地天氣</h3><a class="tiny" href="#/map?spot=${esc(ev.spot.id)}"><span translate="no">${esc(ev.spot.name)}</span> ›</a></div><div id="evWx"><p class="tiny" style="margin:0">載入中…</p></div></section>` : ''}
    ${ev.route ? `<section class="card"><div class="row spread"><h3>路線・${(ev.route.distance / 1000).toFixed(1)} 公里</h3><a class="tiny" href="#/map?route=${esc(ev.route.id)}">在地圖上看 ›</a></div>
      ${routeSvg(ev.route.points)}<div class="row" style="gap:8px"><button class="btn ghost sm" id="evGpx">下載 GPX</button></div></section>` : ''}

    ${party && myTicket ? ticketCard(myTicket, ev) : ''}
    ${myStatus === 'in' && (ev.myAmount || (ev.myAmount == null && charges(ev))) ? payCard(ev) : ''}

    <section class="card">
      <div class="row spread">
        <h3>${survey ? '已回覆' : '報名'} ${ins.length}${ev.capacity ? ` / ${ev.capacity}` : ''} 人</h3>
        ${live
          ? `<span class="row" style="gap:6px">${myStatus === 'in' && started ? '<span class="tiny">活動已開始</span>' : ''}<button class="btn danger sm" id="cancel" ${myStatus === 'in' && started ? 'disabled' : ''}>${myStatus === 'pending' ? '撤回申請' : survey ? '撤回回覆' : '取消報名'}</button></span>`
          : myStatus === 'rejected' ? '<span class="tiny">未通過審核</span>'
          : !canSubmit ? `<span class="tiny">${STATE_LABEL[st](ev)}</span>` : (useForm ? '' : `<button class="btn sm" id="signup">${submitLabel(ev, null, full)}</button>`)}
      </div>
      ${useForm && canSubmit ? signupForm(ev, myStatus, full) : ''}
      ${isOffline() && (canSubmit || live) ? '<p class="tiny" style="margin:0">目前離線，連上網路後再報名</p>' : ''}
      ${party && (ev.fee || ev.guest_max || ev.meal_options) ? `<p class="tiny">${ev.fee ? `費用 ${ev.fee} 元　` : ''}${ev.guest_max ? `可攜伴 ${ev.guest_max} 位　` : ''}${ev.meal_options ? `餐點：${esc(ev.meal_options)}` : ''}</p>` : ''}
      ${myStatus === 'pending' ? `<p class="notice" style="margin:0">你的報名在等主辦幹部審核，結果會通知你${charges(ev) ? '；核准後再繳費' : ''}。</p>`
        : myStatus === 'rejected' ? `<p class="notice" style="margin:0">主辦未通過這筆報名${ev.myReviewNote ? `：<span translate="no">${esc(ev.myReviewNote)}</span>` : ''}。有疑問請聯絡主辦人。</p>`
        : myStatus === 'wait' ? `<p class="notice" style="margin:0">你在候補第 ${ev.myPosition || 1} 位，有人取消會自動遞補並通知你。</p>`
        : st === 'soon' && !myStatus ? '<p class="notice" id="openCountdown" style="margin:0"></p>' : ''}
      ${!myStatus && canSubmit && ev.require_approval && !admin && (ev.capacity || (ev.items || []).some((i) => i.stock)) ? '<p class="tiny" style="margin:0">審核期間不保留名額與庫存</p>' : ''}
      ${live && ev.myAttended ? `<div class="row" style="gap:6px"><span class="pill solid">${IC.check}已出席</span></div>` : ''}
      <div class="roster">
        ${ins.map((s) => `<div class="r">${avatar(s)}<span><span translate="no">${esc(s.name)}</span>${s.note ? ` <span class="tiny"><span translate="no">${esc(s.note)}</span></span>` : ''}</span><span class="pill">${esc(s.grp)}</span></div>`).join('')
          || '<p class="muted" style="margin:0">還沒有人報名，當第一個吧。</p>'}
        ${waits.map((s) => `<div class="r">${avatar(s)}<span><span translate="no">${esc(s.name)}</span></span><span class="pill wait">候補</span></div>`).join('')}
      </div>
      ${admin ? '<button class="btn ghost sm" id="copyRoster">複製名單</button>' : ''}
    </section>

    ${party ? Party.seatSection(seatData, seatInfo.layout) : ''}
    ${party && ev.checkin ? await partyAdmin(ev) : ''}

    ${admin ? `<section class="card">
      <div class="row spread"><h3>管理</h3><span class="tiny">${ev.team ? `<span translate="no">${esc(ev.team.name)}</span>的活動` : '全協會活動'}</span></div>
      <div class="row">
        ${ev.pendingCount > 0 ? `<a class="btn sm" href="#/e/${ev.id}/stats?f=pending">待審核 ${ev.pendingCount} ›</a>` : ''}
        <a class="btn sm" href="#/e/${ev.id}/stats">報名統計${qs.length ? '與問卷' : ''}</a>
        ${ev.cancelled ? `<a class="btn sm" href="#/edit/${ev.id}?reopen=1">恢復這場活動</a>` : ''}
        <a class="btn ghost sm" href="#/edit/${ev.id}">編輯</a>
        <a class="btn ghost sm" href="#/new?from=${ev.id}">複製成新活動</a>
        ${ev.group_reg ? `<button class="btn sm" data-regcsv="${ev.id}">下載團體報名資料</button>` : ''}
        ${ev.arrived ? '<button class="btn sm" id="pickScanEv" type="button">掃描領取</button>' : ''}
        <button class="btn danger sm" id="del">刪除</button>
      </div>
      ${ev.cancelled ? '' : `<details id="noticeWrap"><summary class="tiny" style="cursor:pointer">發布通知或異動（改時間、改地點、取消）</summary>
        <form id="noticeForm" class="noticeform">
          <div class="chips">${[['time', '改時間'], ['place', '改地點'], ['other', '提醒或通知'], ['cancel', '取消活動']].map(([k, v], i) => `<label class="chip"><input type="radio" name="type" value="${k}" ${i ? '' : 'checked'}><span>${v}</span></label>`).join('')}</div>
          <div class="grid2" data-nt="time"><label>新的日期<input type="date" name="date" value="${esc(ev.date)}"></label><label>${party ? '新的開始時間' : '新的集合時間'}<input type="time" name="gather_time" value="${esc(ev.gather_time || '')}"></label></div>
          <div data-nt="place" hidden style="display:grid;gap:12px"><label>新的地點<input name="place" maxlength="120" placeholder="例如 改到大佳河濱公園"></label>${addrField('address', '地址', '選填・送郵局核對')}</div>
          <label>說明（會一起推播）<textarea name="message" maxlength="300" placeholder="例如 下雨改室內，帶瑜珈墊"></textarea></label>
          <fieldset class="qset"><legend>通知誰</legend><div class="chips">
            <label class="chip"><input type="radio" name="audience" value="signed" ${ev.signups.length + (ev.pendingCount || 0) ? 'checked' : ''}><span>已報名的人（${ev.signups.length + (ev.pendingCount || 0)}）</span></label>
            <label class="chip"><input type="radio" name="audience" value="all" ${ev.signups.length + (ev.pendingCount || 0) ? '' : 'checked'}><span>${inviteOnly ? '所有受邀的人' : ev.team ? '整個分團' : '全協會'}</span></label></div>
            <span class="tiny">用外部表單登記的活動（例如慶功宴）沒有人在 App 報名，要選第二個。</span></fieldset>
          <button class="btn sm">送出並通知</button>
        </form></details>`}
      ${party || survey ? '' : `<details id="attendWrap" ${ev.attendToken ? 'open' : ''}><summary class="tiny" style="cursor:pointer">現場報到 QR（團員自己掃）</summary>
        ${ev.attendToken ? `<div class="qrbox" id="attendQR"></div><p class="tiny center" style="margin:0">請團員用手機相機掃描，登入後就完成報到；沒報名的人掃了會自動加入。只在活動當天有效。</p>
          <div class="row"><button class="btn ghost sm" id="attendRotate">換一組 QR</button><button class="btn ghost sm" id="attendOff">關閉</button></div>`
          : '<button class="btn sm" id="attendOn">開啟現場報到 QR</button>'}
      </details>`}
      <details><summary class="tiny" style="cursor:pointer">整批匯入（從 Excel 貼上姓名）</summary>
        <form id="bulkForm" style="display:grid;gap:10px;margin-top:10px">
          <textarea name="names" placeholder="一行一個姓名或暱稱，可以直接從 Excel 複製一整欄貼上" style="min-height:120px"></textarea>
          <div class="row" style="gap:8px"><select name="action" style="width:auto"><option value="signup">代為報名</option><option value="invite">只邀請（邀請制）</option></select>
          <button class="btn sm">匯入</button></div>
          <div id="bulkOut" class="tiny"></div>
        </form>
      </details>
      <details><summary class="tiny" style="cursor:pointer">LINE 公告文字</summary>
        <pre class="out" id="announce">產生中…</pre>
        <button class="btn sm" id="copyAnn">複製公告</button>
      </details>
    </section>` : ''}`;
  // 邀請制：分享出去的一定是帶邀請代碼的連結；沒開邀請連結就提醒先開
  const shareUrl = () => (inviteOnly ? (ev.invite?.token ? `${eventUrl(ev.id)}?t=${ev.invite.token}` : null) : eventUrl(ev.id));
  const attendLink = ev.attendToken ? `${eventUrl(ev.id)}/attend?t=${ev.attendToken}` : '';
  if (attendLink && $('#attendQR')) qrSVG(attendLink, { size: 220, dark: '#0B1B33', light: '#fff' }).then((svg) => { $('#attendQR').innerHTML = svg; }).catch(() => {});
  const setAttend = async (on) => { try { await api(`/events/${ev.id}/attend-token`, { method: 'POST', body: { on } }); eventView(ev.id); } catch (e) { toast(e.message); } };
  $('#attendOn')?.addEventListener('click', () => setAttend(true));
  $('#attendRotate')?.addEventListener('click', () => setAttend(true));
  $('#attendOff')?.addEventListener('click', () => setAttend(false));
  $('#bulkForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/events/${ev.id}/bulk`, { method: 'POST', body: { names: f.names.value, action: f.action.value } });
      $('#bulkOut').innerHTML = `完成 ${r.added} 人。${r.unmatched.length ? `<br>找不到：${r.unmatched.map(esc).join('、')}` : ''}${r.ambiguous.length ? `<br>同名需要手動處理：${r.ambiguous.map(esc).join('、')}` : ''}${r.failed.length ? `<br>沒報成：${r.failed.map(esc).join('、')}` : ''}`;
      if (r.added) { toast(`已處理 ${r.added} 人`); setTimeout(() => eventView(id), 1200); }
    } catch (err) { toast(err.message); }
  });
  $('#shareEv')?.addEventListener('click', () => (shareUrl() ? shareEvent(ev, shareUrl()) : toast('先在下方「邀請連結」開啟，才能分享')));
  $('#copyLink')?.addEventListener('click', () => (shareUrl() ? copy(shareUrl()) : toast('先在下方「邀請連結」開啟，才能分享')));
  // 分享到 LINE：帶活動摘要（時間、地點、價格）與報名連結，點了直接到報名頁，報名人數自動統計
  $('#shareLine')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!shareUrl()) return toast('先在下方「邀請連結」開啟，才能分享');
    const price = (ev.options || []).length ? ev.options.map((o) => `${o.name}${o.price ? ` ${money(o.price)}` : ''}`).join('／') : ev.fee ? money(ev.fee) : '';
    const text = [`【${KIND_NAME[ev.kind] || '活動'}】${ev.title}`, `${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}` : ''}${ev.place ? `・${ev.place}` : ''}`,
      price ? `費用：${price}` : '', ev.cancelled ? '' : windowLine(ev), shareable(ev) ? `${ev.kind === 'survey' ? '填寫' : '報名'}：${shareUrl()}` : ''].filter(Boolean).join('\n');
    open(`https://line.me/R/share?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });
  if (inviteOnly && admin) bindInviteCard(ev);

  // 離線：報名、取消都不排進離線佇列，按鈕直接停用
  if (isOffline()) for (const b of [$('#signup'), $('#cancel'), $('#pform button:not([type=button])')]) if (b) b.disabled = true;
  const sb = $('#signup');
  sb?.addEventListener('click', once(sb, async () => {
    try {
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: { name: me.name, grp: me.grp, dist: me.dist } });
      toast(signupToast(r, ev)); render();
    } catch (e) { toast(e.message); }
  }));
  $('#cancel')?.addEventListener('click', async () => {
    const paidMsg = ev.myPaid === 'paid' ? '你已經繳費，取消後的退費由主辦幹部處理。' : ev.myPayReported ? '你已經回報繳費，取消後請跟主辦幹部聯絡退費。' : '';
    const lateMsg = myStatus === 'in' && now > signupEnd(ev) ? '截止後取消請先聯絡主辦，費用依主辦規定。' : '';
    if (!confirm(myStatus === 'pending' ? '撤回這筆申請？' : survey ? '確定撤回回覆？' : `${lateMsg}${paidMsg}確定取消報名？`)) return;
    try { await api(`/events/${id}/signup`, { method: 'DELETE' }); toast(myStatus === 'pending' ? '已撤回申請' : survey ? '已撤回回覆' : '已取消報名'); render(); } catch (e) { toast(e.message); }
  });
  // 尚未開放：倒數；剩不到 6 小時改成時間到再向伺服器重新讀取（按鈕由伺服器的狀態決定，前端不自己打開）
  const cd = $('#openCountdown');   // #countdown 是上方的賽事倒數，不能重複
  if (cd && ev.signup_start) {
    const left = () => Math.max(0, Date.parse(`${ev.signup_start}:00Z`) - Date.parse(`${nowTp()}:00Z`));
    const paint = () => { const m = Math.ceil(left() / 60e3), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
      cd.textContent = d || h ? `${d ? `${d} 天 ` : ''}${h} 小時後開放報名` : `${m % 60} 分鐘後開放報名`; };
    // 頁面開著跨過 6 小時門檻也要排上重新讀取（每分鐘檢查一次，只排一次）
    let armed = false;
    const arm = () => { if (armed || left() >= 6 * 3600e3) return; armed = true; setTimeout(() => { if (cd.isConnected) render(); }, left() + 1500); };
    paint(); arm();
    const t = setInterval(() => { if (!cd.isConnected) return clearInterval(t); paint(); arm(); }, 60e3);
  }
  if (ev.spot) import('./weather.js').then((W) => W.load(ev.spot.lat, ev.spot.lng).then((w) => { if ($('#evWx')) $('#evWx').innerHTML = W.forEvent(w, ev.date, ev.gather_time); }))
    .catch((e) => { if ($('#evWx')) $('#evWx').innerHTML = `<p class="tiny" style="margin:0">${esc(e.message)}</p>`; });
  $('#evGpx')?.addEventListener('click', async () => (await import('./map.js')).downloadGpx(ev.route.name, ev.route.points));
  if ($('#pform')) bindQuote($('#pform'), ev);
  bindPayCard(ev);
  $('#pickScanEv')?.addEventListener('click', () => scanSheet({ title: '掃描領取 QR', hint: '把團員的領取 QR 對準框內', placeholder: '或輸入 6 碼領取代碼',
    onCode: async (code) => { const r = await api(`/events/${id}/pickup`, { method: 'POST', body: { code: code.toUpperCase() } }); return `${r.already ? '已經領過：' : '領取完成：'}${r.name}・${(r.items || []).map((x) => `${(ev.items.find((d) => d.id === x.id) || {}).name || ''}${x.size ? ` ${x.size}` : ''}×${x.qty}`).join('、')}`; } }));
  for (const b of document.querySelectorAll('[data-regcsv]')) b.onclick = () => downloadAuthed(`/api/events/${b.dataset.regcsv}/registrations.csv`, `${ev.title}-團體報名資料.csv`).catch((e) => toast(e.message));
  const nf = $('#noticeForm');
  if (nf) {
    const sync = () => { const t = nf.querySelector('[name=type]:checked').value; for (const el of nf.querySelectorAll('[data-nt]')) el.hidden = el.dataset.nt !== t; };
    nf.addEventListener('change', sync); sync();
    bindAddrField(nf, 'address');
    nf.onsubmit = async (e) => {
      e.preventDefault();
      const t = nf.querySelector('[name=type]:checked').value;
      if (t === 'cancel' && !confirm('確定取消這場活動？選的通知對象都會收到通知。')) return;
      try {
        const r = await api(`/events/${ev.id}/notice`, { method: 'POST', body: { type: t, date: nf.date.value, gather_time: nf.gather_time.value, place: nf.place.value.trim(), address: nf.address.value.trim(), message: nf.message.value.trim(), audience: nf.querySelector('[name=audience]:checked')?.value } });
        toast(r.count ? `已通知 ${r.count} 人` : '已更新，沒有需要通知的人'); render();
      }
      catch (err) { toast(err.message); }
    };
  }
  // 要先填賽事報名資料：記住填到一半的報名（組別、商品、備註），填完會帶回來（按連結或按報名都一樣）
  const goReg = () => {
    const f = $('#pform');
    try { sessionStorage.setItem('cil-after-reg', JSON.stringify({ ev: id, option: f?.querySelector('[name=option]:checked')?.value || null, items: f ? readItems(f) : [], note: f?.note?.value || '' })); } catch {}
    location.hash = '#/me/reg'; toast('先填好賽事報名資料，填完會帶你回來報名');
  };
  $('#goReg')?.addEventListener('click', (e) => { e.preventDefault(); goReg(); });
  $('#pform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const answers = readQuestionFields(f, qs);
      const miss = qs.find((q) => q.required && (Array.isArray(answers[q.id]) ? !answers[q.id].length : !answers[q.id]));
      if (miss) return toast(`請回答「${miss.label}」`);
      if (ev.group_reg && ev.regProfile !== 'ok') { goReg(); return; }
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: {
        name: me.name, grp: me.grp, dist: me.dist, note: f.note?.value || '', answers,
        option: f.querySelector('[name=option]:checked')?.value || null, reg_consent: !!f.reg_consent?.checked,
        guests: Number(f.guests?.value || 0), meal: f.meal?.value || '', items: readItems(f) } });
      toast(signupToast(r, ev)); render();
    } catch (err) { toast(err.message); }
  });
  $('#cform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/events/${id}/checkin`, { method: 'POST', body: { code: f.code.value, seat: f.seat.value } });
      toast(r.already ? `${r.name} 已經報到過了` : `${r.name} 報到完成${r.guests ? `（攜伴 ${r.guests}）` : ''}`);
      f.code.value = ''; render();
    } catch (err) { toast(err.message); }
  });
  for (const b of document.querySelectorAll('[data-ci]')) b.onclick = async () => {
    try { const r = await api(`/events/${id}/checkin`, { method: 'POST', body: { code: b.dataset.ci } }); toast(`${r.name} 報到完成`); render(); }
    catch (err) { toast(err.message); }
  };
  for (const b of document.querySelectorAll('[data-claim]')) b.onclick = async () => {
    try { await api(`/draws/${b.dataset.claim}/claim`, { method: 'POST' }); toast('已確認領獎'); render(); }
    catch (err) { toast(err.message); }
  };
  for (const b of document.querySelectorAll('[data-draw]')) b.onclick = async () => {
    b.disabled = true; b.textContent = '抽獎中…';
    try {
      const r = await api(`/events/${id}/draw`, { method: 'POST', body: { prize_id: b.dataset.draw, count: 1 } });
      toast(`抽出 ${r.prize}：${r.winners.join('、')}`); render();
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = '抽出 1 位'; }
  };
  $('#prizeForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/events/${id}/prizes`, { method: 'POST', body: {
        name: f.name.value, qty: Number(f.qty.value), stage: f.stage.value, sponsor: f.sponsor.value } });
      toast('已新增獎項'); render();
    } catch (err) { toast(err.message); }
  });
  $('#bulkPrize')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api(`/events/${id}/prizes`, { method: 'POST', body: { text: e.target.text.value } }); toast(`已匯入 ${r.added} 項`); render(); }
    catch (err) { toast(err.message); }
  });
  if (party && myTicket) paintQR(ev, myTicket.code);
  if (party && $('#seatCard')) {
    const seated = seatData.filter((s) => s.table_no);
    const show = (t) => { $('#tableDetail').innerHTML = Party.tableList(seated, Number(t));
      for (const b of document.querySelectorAll('.tbl')) b.classList.toggle('on', b.dataset.table === String(t));
      $('#tableDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
    const bindTables = () => { for (const b of document.querySelectorAll('[data-table]')) b.onclick = () => show(b.dataset.table); };
    $('#seatResult').innerHTML = Party.seatResults(seated, '');
    $('#seatQ').oninput = (e) => { $('#seatResult').innerHTML = Party.seatResults(seated, e.target.value); bindTables(); };
    $('#tabSearch').onclick = () => { $('#seatSearch').hidden = false; $('#seatMapWrap').hidden = true;
      $('#tabSearch').setAttribute('aria-pressed', 'true'); $('#tabMap').setAttribute('aria-pressed', 'false'); };
    $('#tabMap').onclick = () => { $('#seatSearch').hidden = true; $('#seatMapWrap').hidden = false;
      $('#tabMap').setAttribute('aria-pressed', 'true'); $('#tabSearch').setAttribute('aria-pressed', 'false'); bindTables(); };
    bindTables();
  }
  $('#openStage')?.addEventListener('click', () => lotteryStage(ev));
  $('#seatForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/events/${id}/seats/assign`, { method: 'POST', body: { seats: [{ code: f.code.value, table_no: Number(f.table_no.value), note: f.note.value }] } });
      toast(r.updated ? '已排桌' : '找不到這個代碼'); f.code.value = ''; render();
    } catch (err) { toast(err.message); }
  });
  $('#copyRoster')?.addEventListener('click', async () => copy((await api(`/events/${id}/roster`)).text));
  $('#del')?.addEventListener('click', async () => {
    const later = (ev.series || []).filter((x) => x.date > ev.date).length;
    const n = ev.signups.length + (ev.pendingCount || 0);
    const pick = await choose('刪除活動', `${later ? `這是定期揪跑，之後還有 ${later} 場。` : ''}刪除後無法復原${n ? `，已報名的 ${n} 人會收到通知` : ''}。`,
      later ? [{ value: 'one', label: '只刪這一場', danger: true }, { value: 'after', label: `連同之後 ${later} 場一起刪`, danger: true }] : [{ value: 'one', label: '刪除', danger: true }]);
    if (!pick) return;
    try { const r = await api(`/events/${id}${pick === 'after' ? '?series=after' : ''}`, { method: 'DELETE' }); toast(`已刪除 ${r.count || 1} 場`); location.hash = '#/'; } catch (e) { toast(e.message); }
  });
  if (admin) {
    const text = await announceText(ev);
    $('#announce').textContent = text;
    $('#copyAnn').onclick = () => copy(text);
  }
}

// 依活動資料組出 LINE 公告（格式照團裡原本的貼文）
async function announceText(ev) {
  const L = [`【${KIND_NAME[ev.kind] || '活動'}】${/\d{1,2}\/\d{1,2}/.test(ev.title) ? '' : `${dstr(ev.date)} `}${ev.title}`];
  L.push(`時間：${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}${ev.end_time ? `–${ev.end_time}` : ''} 集合` : ''}`);
  if (ev.place) L.push(`地點：${ev.place}`);
  if ((ev.options || []).length) L.push(`組別與費用：${ev.options.map((o) => `${o.name}${o.price ? ` ${money(o.price)}` : ''}`).join('／')}`);
  else if (ev.fee) L.push(`費用：${money(ev.fee)}`);
  if (!ev.cancelled) L.push(windowLine(ev));
  if (ev.lead) L.push(`帶團：${ev.lead}`);
  if (ev.week_no) {
    const info = await P.weekInfo(ev.week_no);
    L.push('', `【全馬組】W${ev.week_no}・${info?.phase || ''}`);
    for (const r of await P.dayByGroup(ev.week_no, 'fm', dayPattern(ev.date))) L.push(`${r.grp}：${r.text}${r.hint ? `　${r.hint}` : ''}`);
    const hm = await P.dayByGroup(ev.week_no, 'hm', dayPattern(ev.date));
    if (hm.length) { L.push('', '【半馬組】'); for (const r of hm) L.push(`${r.grp}：${r.text}${r.hint ? `　${r.hint}` : ''}`); }
    if (info?.src?.startsWith('推估')) L.push('', '（本週課表教練還沒公告，先參考去年同期）');
  } else if (ev.plan_text) { L.push('', ev.plan_text); }
  if (ev.note) L.push('', ev.note);
  if (ev.link_url) L.push('', `${ev.link_label || '登記'}：${ev.link_url}`);
  if (shareable(ev) && ev.visibility !== 'invite') L.push('', `報名：${location.origin}/#/e/${ev.id}`);
  if (shareable(ev) && ev.visibility === 'invite' && ev.invite?.token) L.push('', `報名（邀請連結）：${location.origin}/#/e/${ev.id}?t=${ev.invite.token}`);
  return L.join('\n');
}
const dayPattern = (date) => { const w = d2(date).getDay(); return w === 0 || w === 6 ? '週末|週日' : `週${WD[w]}`; };


// ---------- 通知中心 ----------
// 分類由伺服器寫入（notif-cats.js 共用登記表）；每類一個實心色磚＋線條圖示＋文字，顏色不是唯一的辨識方式
const NICON = { security: IC.shieldAlert, change: IC.calAlert, signup: IC.ticket, event: IC.calClock, training: IC.runner,
  membership: IC.idcard, announce: IC.megaphone, todo: IC.clipCheck, other: IC.bell };
// 整句都是伺服器範本的標題：英文介面可以翻；夾帶活動或分團名稱的標題、內文一律不翻
const NFIXED = new Set(['新裝置登入', '新增了一把通行金鑰', '移除了一把通行金鑰', '已登出所有裝置', '幹部需要兩步驟驗證', '你已成為理事長', '你已卸任理事長',
  '身分更新', '候補遞補成功', '入會完成', '會籍已到期', '會費今天到期', '有人申請入會', '練跑地圖：有新的地點提議', '每季權限檢視', '跑完了嗎？', '這週練得很兇，注意恢復', '教練回饋了你的訓練']);
// 只接受站內網址；通知中心本身不算（改開詳細內容）
const safeHref = (u) => (/^\/#\/[\w/?=&.%-]*$/.test(u || '') && u !== '/#/notifications' ? u.slice(1) : null);
const nDate = (ts) => new Date(`${ts.replace(' ', 'T')}Z`);
const daysAgo = (d) => Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
// 日期分段：今天、昨天、最近 7 天、更早的每個月一段（用裝置的當地時間）
function nGroup(ts) {
  const d = nDate(ts), k = daysAgo(d);
  if (k <= 0) return ['today', '今天']; if (k === 1) return ['yday', '昨天']; if (k < 7) return ['week', '最近 7 天'];
  return [`m${d.getFullYear()}-${d.getMonth()}`, d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1} 月` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`];
}
// 列上的時間：今天用「N 分鐘前」或時刻、昨天用時刻、一週內用星期、更早用日期（ago() 給其他頁面用，不改）
function ntime(ts) {
  const d = nDate(ts), k = daysAgo(d), m = Math.floor((Date.now() - d) / 6e4), hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (k <= 0) return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : hm;
  if (k === 1) return hm;
  if (k < 7) return `週${'日一二三四五六'[d.getDay()]}`;
  return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
const fullTime = (ts) => { const d = nDate(ts); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const nCat = (n) => (CATS[n.category] ? n.category : 'other');
// eyebrow 依伺服器寫入的分類與 ref 產生，不讀作者寫的文字：幹部群發標題寫「新裝置登入」，畫面上仍是紫色擴音器加「協會公告」
const nEye = (n) => {
  const cat = nCat(n), tid = n.ref?.startsWith('t:') ? n.ref.slice(2) : null, tname = tid ? teamOf(tid)?.name : '';
  return cat === 'announce' ? (tname ? `<span translate="no">${esc(tname)}</span>・分團公告` : tid ? '分團公告' : '協會公告')
    : cat === 'security' ? `${IC.lock}系統通知` : '';
};
// 一則通知一列；按鈕不放在 <a> 裡面（.nmore、.nack 是 <a> 的兄弟元素）
const nrow = (n, pinned = false) => {
  const cat = nCat(n), unread = !n.read_at, href = safeHref(n.url), eye = nEye(n);
  return `<li class="nitem n-${cat}${unread ? ' unread' : ''}" data-id="${esc(n.id)}" data-cat="${cat}"><div class="nwrap">
    <a class="nrow" href="${href ? esc(href) : '#/notifications'}"${href ? '' : ' data-detail'}>
      <span class="ntile" aria-hidden="true">${NICON[cat]}</span>
      <span class="ntext">
        <span class="sr">${CATS[cat]?.zh || '其他'}</span>${unread ? '<span class="sr nsru">未讀</span>' : ''}
        ${eye ? `<span class="neye">${eye}</span>` : ''}
        <span class="nt" id="nt-${esc(n.id)}"${NFIXED.has(n.title) ? '' : ' translate="no"'}>${esc(n.title)}</span>
        ${n.body ? `<span class="nb" translate="no">${esc(n.body)}</span>` : ''}
      </span>
      <span class="nmeta"><time class="num" datetime="${nDate(n.created_at).toISOString()}" data-ts="${esc(n.created_at)}" title="${fullTime(n.created_at)}">${ntime(n.created_at)}</time><i class="ndot" aria-hidden="true"></i></span>
    </a>
    ${pinned && cat === 'security' && unread ? '<div class="nack"><button type="button" class="btn sm" data-ack="me">是我本人</button><button type="button" class="btn ghost sm" data-ack="notme">不是我</button></div>' : ''}
    <button type="button" class="iconx nmore" data-more aria-label="更多動作" aria-describedby="nt-${esc(n.id)}">${IC.more}</button>
  </div></li>`;
};
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
// 通知中心的狀態（同一時間只有一個通知頁）
const NS = { key: 'all', cursor: null, ids: new Set(), data: new Map(), chips: null, lastKey: '', timer: 0, pendingDeletes: [], cats: {}, unread: 0, offline: false, loading: false, seq: 0 };
const curChip = () => CHIPS.find((c) => c.key === NS.key) || CHIPS[0];
const scopeCats = () => { const c = curChip(); return c.q && c.q !== 'unread' ? c.q.split(',') : Object.keys(CATS); };
const chipU = (c) => (c.key === 'all' ? 0 : c.key === 'unread' ? Object.values(NS.cats).reduce((t, x) => t + (x.u || 0), 0) : c.q.split(',').reduce((t, k) => t + (NS.cats[k]?.u || 0), 0));
// 哪些 chip 會出現：全部、未讀一定有；待辦要有待辦通知或待處理摘要；其他類別 180 天內有資料。同一頁面只新增、不拿掉
function addChips(r) {
  NS.chips ||= new Set(['all', 'unread']);
  for (const c of CHIPS) if (c.q && c.q !== 'unread' && (c.key === 'todo' ? r.cats?.todo?.n > 0 || r.todo || r.officer : c.q.split(',').some((k) => r.cats?.[k]?.n > 0))) NS.chips.add(c.key);
}
const chipHTML = (c) => {
  const sel = c.key === NS.key, u = chipU(c);
  return `<button type="button" role="tab" id="nchip-${c.key}" data-nk="${c.key}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}">${c.tc ? `<i${c.key === 'todo' ? ' class="tdot"' : ''} style="--tc:${c.tc}"></i>` : ''}<span>${c.zh}</span>${u ? `<b class="num">${u}</b>` : ''}</button>`;
};
function paintChips() {
  const bar = $('#nchips'); if (!bar) return;
  const focused = document.activeElement?.dataset?.nk;
  bar.innerHTML = CHIPS.filter((c) => NS.chips.has(c.key)).map(chipHTML).join('');
  if (focused) $(`#nchip-${focused}`)?.focus();
}
// 數字變動：只改數字，不重畫 chip（焦點不會跳）
function paintCounts() {
  for (const b of document.querySelectorAll('#nchips [data-nk]')) {
    const u = chipU(CHIPS.find((c) => c.key === b.dataset.nk)); let el = b.querySelector('b.num');
    if (!u) { el?.remove(); continue; }
    if (!el) { el = document.createElement('b'); el.className = 'num'; b.append(el); }
    if (el.textContent !== String(u)) el.textContent = u;
  }
  const sub = $('#nsub'); if (sub) { const t = NS.unread ? `${NS.unread} 則未讀` : ''; if (sub.textContent !== t) sub.textContent = t; }
  const ra = $('#readAll'); if (ra) ra.hidden = !scopeCats().some((k) => k !== 'security' && NS.cats[k]?.u > 0);
}
// 已讀狀態變動：畫面先改，數字跟著加減（鈴鐺在看過之後只算未讀的帳號安全通知）
function adjust(cat, d) {
  const x = NS.cats[cat] ||= { n: 0, u: 0 };
  x.u = Math.max(0, x.u + d); NS.unread = Math.max(0, NS.unread + d);
  bellState.unread = Math.max(0, bellState.unread + d);
  if (cat === 'security' || cat === 'other') bellState.badge = Math.max(0, bellState.badge + d);
  paintBell(); paintCounts();
}
function setUnread(li, unread, count = true) {
  if (!li || li.classList.contains('unread') === unread) return;
  li.classList.toggle('unread', unread);
  const n = NS.data.get(li.dataset.id); if (n) n.read_at = unread ? null : 'now';
  if (unread) li.querySelector('.ntext .sr')?.insertAdjacentHTML('afterend', '<span class="sr nsru">未讀</span>');
  else li.querySelector('.nsru')?.remove();
  if (count) adjust(li.dataset.cat, unread ? 1 : -1);
}
const applyCounts = (r) => {
  if (!r || r.badge == null) return;
  bellState = { badge: r.badge, unread: r.unread }; NS.unread = r.unread; paintBell(); paintCounts();
};
// 單則已讀：畫面立刻改，請求用 keepalive（點了馬上導頁也送得出去）
function markRead(li) {
  if (!li?.classList.contains('unread')) return;
  setUnread(li, false);
  fetch('/api/notifications/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: li.dataset.id }), keepalive: true })
    .then(() => bell(true)).catch(() => toast('目前沒有網路，連上後再試一次'));
}
async function markUnread(li) {
  try {
    const r = await api('/notifications/unread', { method: 'POST', body: { id: li.dataset.id } });
    if (!li.classList.contains('unread')) (NS.cats[li.dataset.cat] ||= { n: 0, u: 0 }).u++;
    setUnread(li, true, false); applyCounts(r); paintCounts();
  }
  catch (e) { toast(e.message); }
}
// 刪除：列先收合，4 秒內可以復原，時間到才真的送出；換頁或離開 App 時立刻送出
const nCommit = (p) => {
  if (!NS.pendingDeletes.includes(p)) return;
  NS.pendingDeletes = NS.pendingDeletes.filter((x) => x !== p);
  fetch(`/api/notifications/${encodeURIComponent(p.id)}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true })
    .then(() => bell(true)).catch(() => toast('目前沒有網路，連上後再試一次'));
};
function nLeave() { clearInterval(NS.timer); for (const p of [...NS.pendingDeletes]) nCommit(p); }
addEventListener('pagehide', () => { for (const p of [...NS.pendingDeletes]) nCommit(p); });
// 刪除後焦點的去處：下一列、上一列，都沒有就回到目前的 chip
const nNeighbor = (li) => {
  const rows = [...document.querySelectorAll('#nfeed .nitem:not(.gone)')], i = rows.indexOf(li), others = rows.filter((x) => x !== li);
  return (others[i] || others[i - 1])?.querySelector('.nrow') || $(`#nchip-${NS.key}`);
};
function nDelete(li, viaKey = false) {
  const ul = li.parentElement, next = li.nextElementSibling, sec = li.closest('section'), near = nNeighbor(li);
  const p = { id: li.dataset.id, cat: li.dataset.cat, unread: li.classList.contains('unread') };
  li.classList.add('gone');
  p.hide = setTimeout(() => { li.remove(); if (sec && !sec.querySelector('.nitem')) sec.hidden = true; }, reduceMotion() ? 0 : 240);
  NS.pendingDeletes.push(p);
  if (p.unread) adjust(p.cat, -1);
  if (NS.cats[p.cat]) NS.cats[p.cat].n = Math.max(0, NS.cats[p.cat].n - 1);
  if (!viaKey) near?.focus();
  toast('已刪除', { action: '復原', ms: 4000, focus: viaKey, onExpire: (had) => { nCommit(p); if (had && near?.isConnected) near.focus(); }, onAction: () => {
    if (!NS.pendingDeletes.includes(p)) return;
    clearTimeout(p.hide); NS.pendingDeletes = NS.pendingDeletes.filter((x) => x !== p);
    if (!li.isConnected) ul.insertBefore(li, next?.isConnected ? next : null);
    if (sec) sec.hidden = false;
    li.classList.remove('gone');
    if (p.unread) adjust(p.cat, 1);
    if (NS.cats[p.cat]) NS.cats[p.cat].n++;
    li.querySelector('.nrow')?.focus();
  } });
}
// 共用 sheet：焦點移到第一個動作、Tab 不會跑出去、Esc 關閉，關閉後焦點回到原本的元素
// labelledby：用 sheet 裡標題的 id 當名稱（標題是作者寫的內容、不翻譯時用這個，不用 aria-label）
function openSheet(label, inner, opener, labelledby = '') {
  const host = document.createElement('div');
  host.className = 'sheet'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true');
  if (labelledby) host.setAttribute('aria-labelledby', labelledby); else host.setAttribute('aria-label', I18N.t(label));
  host.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-card card">${inner}</div>`;
  document.body.append(host);
  const focusables = () => [...host.querySelectorAll('button:not([disabled]),a[href],input:not([disabled])')];
  focusables()[0]?.focus();
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(), i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1]?.focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0]?.focus(); }
  };
  const close = () => { if (!host.isConnected) return; host.remove(); document.removeEventListener('keydown', key, true); if (opener?.isConnected) opener.focus(); };
  document.addEventListener('keydown', key, true);
  host.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  return { host, close };
}
// 動作選單：長按、右鍵、更多按鈕都開這個
function nActions(li) {
  if (!li?.isConnected || $('.sheet.nsheet')) return;
  const n = NS.data.get(li.dataset.id); if (!n) return;
  const cat = li.dataset.cat, unread = li.classList.contains('unread');
  const chip = CHIPS.find((c) => c.q && c.q !== 'unread' && c.q.split(',').includes(cat));
  const acts = [
    [unread ? 'read' : 'unread', unread ? IC.envOpen : IC.envDot, unread ? '標為已讀' : '標為未讀'],
    chip ? ['only', IC.filter, '只看這一類'] : null,
    CATS[cat] && !CATS[cat].locked ? ['mute', IC.bellSlash, '關閉這一類推播'] : null,
    CATS[cat] && cat !== 'security' && !NS.offline ? ['del', IC.trash, '刪除這則通知'] : null,
  ].filter(Boolean);
  const s = openSheet('更多動作', `<div class="nsheethd"><span class="ntile n-${cat}" aria-hidden="true">${NICON[cat]}</span><b${NFIXED.has(n.title) ? '' : ' translate="no"'}>${esc(n.title)}</b></div>
    <div class="nacts">${acts.map(([k, icon, label]) => `<button type="button" class="nact${k === 'del' ? ' danger' : ''}" data-act="${k}">${icon}<span>${label}</span></button>`).join('')}</div>
    <button type="button" class="btn ghost block" data-close>取消</button>`, li.querySelector('.nrow'));
  s.host.classList.add('nsheet');
  s.host.addEventListener('click', (e) => {
    const k = e.target.closest('[data-act]')?.dataset.act; if (!k) return;
    s.close();
    if (k === 'read') markRead(li);
    else if (k === 'unread') markUnread(li);
    else if (k === 'only') { switchChip(chip.key); $(`#nchip-${chip.key}`)?.focus(); }
    else if (k === 'mute') location.hash = `#/me/notify?cat=${cat}`;
    else if (k === 'del') nDelete(li, e.detail === 0);   // detail 0＝鍵盤按下
  });
}
// 詳細內容：沒有站內連結、或內文超過兩行時開這個；打開就算已讀
function nDetail(n, opener) {
  const cat = nCat(n), href = safeHref(n.url), eye = nEye(n);
  openSheet(n.title, `<div class="ndetail"><span class="ntile n-${cat}" aria-hidden="true">${NICON[cat]}</span>
      <span class="neye">${eye || CATS[cat]?.zh || '其他'}</span>
      <h3 id="ndetailh"${NFIXED.has(n.title) ? '' : ' translate="no"'}>${esc(n.title)}</h3>
      ${n.body ? `<p class="ndbody" translate="no">${esc(n.body)}</p>` : ''}
      <time class="tiny num" datetime="${nDate(n.created_at).toISOString()}">${fullTime(n.created_at)}</time></div>
    <div class="choices">${href ? `<a class="btn block" href="${esc(href)}" data-close>前往</a>` : ''}<button type="button" class="btn ghost block" data-close>關閉</button></div>`, opener, 'ndetailh');
}
// 幹部「待處理」摘要（從來源資料表即時計算，不是通知）
const todoBox = (t) => {
  const tile = `<span class="ntile n-todo">${IC.clipCheck}</span>`, num = (v) => `<b class="num ntnum">${v}</b>`;
  return `<section class="setgroup" id="todoBox"><h2 class="sgt">待處理</h2><div class="card setcard">${[
    t.applied ? row('#/admin?tab=members', tile, '入會申請', '', num(t.applied)) : '',
    ...t.joins.map((j) => row(`#/t/${esc(j.tid)}`, tile, `<span translate="no">「${esc(j.name)}」</span>入團申請`, '', num(j.n))),
    ...t.pays.map((p) => row(`#/e/${esc(p.id)}/stats`, tile, `<span translate="no">「${esc(p.title)}」</span>繳費確認`, '', num(p.n))),
    ...(t.reviews || []).map((p) => row(`#/e/${esc(p.id)}/stats?f=pending`, tile, `<span translate="no">「${esc(p.title)}」</span>報名待審核`, '', num(p.n))),
    t.spots ? row('#/map', tile, '地點審核', '', num(t.spots)) : '',
  ].join('')}</div></section>`;
};
const nEmptyCard = (icon, title, desc = '', act = '') => `<div class="card"><div class="empty">${icon}<b class="etitle">${title}</b>${desc ? `<span>${desc}</span>` : ''}${act}</div></div>`;
function nEmpty() {
  const c = curChip();
  if (c.key === 'all') return nEmptyCard(IC.bell, '還沒有通知', '新活動、課表和報名結果會出現在這裡', '<span id="npush"></span>');
  if (c.key === 'unread') return nEmptyCard(IC.checkCircle, '都看完了', '', '<button type="button" class="linkbtn" data-nall>看全部</button>');
  if (c.key === 'todo') return nEmptyCard(IC.clipCheck, '目前沒有待辦');
  return nEmptyCard(NICON[c.q.split(',')[0]], '這一類沒有通知', '', '<button type="button" class="linkbtn" data-nall>看全部</button>');
}
const nError = () => nEmptyCard(IC.bell, '通知載入失敗', '', '<button type="button" class="btn ghost sm" data-nretry>重試</button>');
const nSkel = () => `<div class="card setcard nskelc" role="status" aria-label="載入中">${'<div class="nskel"><i></i><span><b></b><b></b></span></div>'.repeat(4)}</div>`;
// 依日期分段接上新的列：第一列跟目前最後一段同一組就接在原本的清單後面；用 id 去重（伺服器每頁都排除「需要留意」，這是第二道防線）
function appendItems(items) {
  const feed = $('#nfeed'); let head = '', html = '', open = false;
  const last = [...feed.querySelectorAll('section.nday')].pop();
  if (!last) NS.lastKey = '';
  for (const n of items) {
    if (NS.ids.has(n.id)) continue;
    NS.ids.add(n.id); NS.data.set(n.id, n);
    const [k, label] = nGroup(n.created_at);
    if (!open && k === NS.lastKey) { head += nrow(n); continue; }
    if (k !== NS.lastKey || !open) {
      if (open) html += '</ul></div></section>';
      html += `<section class="setgroup nday" data-g="${k}"><h2 class="sgt">${label}</h2><div class="card setcard"><ul class="nlist" role="list">`;
      open = true; NS.lastKey = k;
    }
    html += nrow(n);
  }
  if (open) html += '</ul></div></section>';
  if (head) { last.hidden = false; last.querySelector('ul').insertAdjacentHTML('beforeend', head); }
  if (html) { feed.querySelector(':scope > .card > .empty')?.parentElement.remove(); feed.insertAdjacentHTML('beforeend', html); }
}
function fillFeed(r) {
  const feed = $('#nfeed'), k = NS.key;
  NS.ids = new Set(); NS.data = new Map(); NS.lastKey = ''; NS.cursor = r.next;
  const pinned = (k === 'all' || k === 'unread') ? r.pinned || [] : [], todo = (k === 'all' || k === 'todo') && r.todo?.total > 0 ? r.todo : null;
  for (const n of pinned) { NS.ids.add(n.id); NS.data.set(n.id, n); }
  feed.innerHTML = `${todo ? todoBox(todo) : ''}${pinned.length ? `<section class="setgroup" id="npin"><h2 class="sgt">需要留意</h2><div class="card setcard"><ul class="nlist" role="list">${pinned.map((n) => nrow(n, true)).join('')}</ul></div></section>` : ''}`;
  appendItems(r.items);
  if (!feed.querySelector('.nitem') && !todo) feed.innerHTML = nEmpty();
  feed.setAttribute('aria-labelledby', `nchip-${k}`);
  paintFoot();
  pushHint();
}
// 空狀態的「開啟手機推播」：只有這台裝置真的沒有推播訂閱時才出現
async function pushHint() {
  const box = $('#npush'); if (!box || !cfg.vapid) return;
  const reg = await Promise.race([navigator.serviceWorker?.ready.catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  const sub = await reg?.pushManager?.getSubscription().catch(() => null);
  if (!sub && box.isConnected) box.outerHTML = '<a class="btn sm" href="#/me/notify">開啟手機推播</a>';
}
function paintFoot() {
  const foot = $('#nfoot'); if (!foot) return;
  const readN = Object.entries(NS.cats).reduce((t, [k, x]) => t + (k === 'security' || k === 'other' ? 0 : (x.n || 0) - (x.u || 0)), 0);
  foot.innerHTML = `${NS.cursor ? '<button type="button" class="btn ghost sm block" id="nmore">載入更早的通知</button>' : ''}
    ${readN > 0 && !NS.offline ? '<button type="button" class="linkbtn" id="nclear">清除已讀通知</button>' : ''}
    <p class="nfoot">通知保留 180 天，幹部待辦保留 60 天；帳號安全通知無法刪除。</p>`;
}
const nQuery = (before) => { const c = curChip(), p = new URLSearchParams(); if (c.q) p.set('cat', c.q); if (before) p.set('before', before); const s = p.toString(); return `/notifications${s ? `?${s}` : ''}`; };
// 切換 chip：只重抓清單，不重畫整頁
async function loadFeed() {
  const feed = $('#nfeed'); if (!feed) return;
  const my = ++NS.seq;
  NS.loading = false;
  feed.innerHTML = nSkel(); $('#npill')?.replaceChildren();
  try {
    const r = await api(nQuery());
    if (my !== NS.seq || !feed.isConnected) return;
    NS.cats = r.cats || {}; NS.unread = r.unread || 0;
    const before = NS.chips.size; addChips(r); if (NS.chips.size !== before) paintChips();
    fillFeed(r); paintCounts();
    feed.classList.remove('swap'); void feed.offsetWidth; feed.classList.add('swap');
  } catch { if (my === NS.seq && feed.isConnected) { feed.innerHTML = nError(); paintFoot(); } }
}
function switchChip(key) {
  if (!CHIPS.some((c) => c.key === key)) return;
  if (!NS.chips.has(key)) { NS.chips.add(key); paintChips(); }
  NS.key = key; lsSet('cil-ncat', key);
  for (const b of document.querySelectorAll('#nchips [data-nk]')) { const on = b.dataset.nk === key; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  $(`#nchip-${key}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  loadFeed();
}
async function nMore(btn) {
  if (NS.loading || !NS.cursor) return;
  NS.loading = true; btn.disabled = true; btn.textContent = '載入中…';
  const my = NS.seq, key = NS.key;
  try {
    const r = await api(nQuery(NS.cursor));
    if (my !== NS.seq || key !== NS.key) return;
    appendItems(r.items); NS.cursor = r.next;
    const live = $('#nlive'); if (live) { live.textContent = ''; setTimeout(() => { live.textContent = '已載入更多通知'; }, 50); }
  } catch (e) { toast(e.message); }
  NS.loading = false;
  if (!btn.isConnected) return;
  if (NS.cursor) { btn.disabled = false; btn.textContent = '載入更早的通知'; btn.focus(); }
  else { const last = [...document.querySelectorAll('#nfeed .nrow')].pop(); btn.remove(); last?.focus(); }
}
// 按鈕消失後焦點的去處（焦點原本在那顆按鈕、或已經掉到 body 時）：清單第一列，沒有就回到目前的 chip
const nRefocus = (gone) => {
  const a = document.activeElement;
  if (a && a !== document.body && a !== gone && a.isConnected) return;
  ($('#nfeed .nitem:not(.gone) .nrow') || $(`#nchip-${NS.key}`))?.focus();
};
// 全部已讀：只到目前載入最新的那一列為止（頁面打開之後才進來的維持未讀），就地更新，捲動位置不動
async function readAll(btn) {
  const rows = [...NS.data.values()]; if (!rows.length) return;
  const top = rows.reduce((a, b) => (b.created_at > a.created_at || (b.created_at === a.created_at && b.id > a.id) ? b : a));
  const c = curChip(), scope = scopeCats();
  btn.disabled = true;
  try {
    const r = await api('/notifications/read', { method: 'POST', body: { all: true, ...(c.q && c.q !== 'unread' ? { cat: c.q } : {}), upto: `${top.created_at}|${top.id}` } });
    for (const li of document.querySelectorAll('#nfeed .nitem.unread')) if (scope.includes(li.dataset.cat) && li.dataset.cat !== 'security') setUnread(li, false, false);
    for (const k of scope) if (k !== 'security' && NS.cats[k]) NS.cats[k].u = 0;
    applyCounts(r); paintFoot();
  } catch (e) { toast(e.message); }
  if (btn.isConnected) btn.disabled = false;
  if (btn.hidden) nRefocus(btn);
}
function clearRead(btn) {
  const s = openSheet('清除所有已讀通知？', `<h3>清除所有已讀通知？</h3><p class="tiny" style="margin:0">帳號安全通知會保留到期滿。</p>
    <div class="choices"><button type="button" class="btn danger block" data-yes>清除</button><button type="button" class="btn ghost block" data-close>取消</button></div>`, btn);
  s.host.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-yes]')) return;
    s.close();
    try {
      await api('/notifications/clear-read', { method: 'POST' });
      for (const li of document.querySelectorAll('#nfeed .nitem:not(.unread)')) if (!['security', 'other'].includes(li.dataset.cat)) li.remove();
      for (const sec of document.querySelectorAll('#nfeed section.nday, #npin')) if (!sec.querySelector('.nitem')) sec.hidden = true;
      for (const [k, x] of Object.entries(NS.cats)) if (k !== 'security' && k !== 'other') x.n = x.u;
      if (!$('#nfeed .nitem') && !$('#todoBox')) { $('#nfeed').innerHTML = nEmpty(); NS.lastKey = ''; }
      paintFoot(); bell(true); nRefocus(btn);
    } catch (err) { toast(err.message); }
  });
}
// 「今天」那一段的時間每 60 秒重算
function tickToday() {
  if (!$('#nfeed')) { clearInterval(NS.timer); return; }
  for (const t of document.querySelectorAll('#nfeed time[data-ts]')) { const v = ntime(t.dataset.ts); if (t.textContent !== v) t.textContent = v; }
}
// 停在通知頁時有新推播：顯示「有新通知」，點了重抓目前篩選的第一頁
function showNewPill() {
  const box = $('#npill'); if (!box || box.firstChild) return;
  box.innerHTML = '<button type="button" class="btn sm npill">有新通知</button>';
}
async function notificationsView() {
  nLeave();
  NS.chips = null; NS.seq++; NS.loading = false;
  const my = NS.seq;
  let chip = CHIPS.find((c) => c.key === lsGet('cil-ncat')) || CHIPS[0], r;
  NS.key = chip.key;
  try {
    r = await api(nQuery());
    addChips(r);
    // 記住的 chip 這次沒有出現，就回到「全部」
    if (!NS.chips.has(chip.key)) { chip = CHIPS[0]; NS.key = 'all'; r = await api(nQuery()); }
  } catch {
    view.innerHTML = `${largeTitle('通知')}${nError()}`;
    view.querySelector('[data-nretry]').onclick = () => render();
    return;
  }
  if (my !== NS.seq) return;
  NS.cats = r.cats || {}; NS.unread = r.unread || 0; NS.offline = !!$('#offline');
  const hint = !lsGet('cil-nhint');
  view.innerHTML = `${largeTitle('通知', `<span id="nsub"></span>`, `<div class="ltact"><button type="button" class="btn ghost sm" id="readAll" hidden${NS.offline ? ' disabled' : ''}>全部已讀</button>
      <a class="themebtn" href="#/me/notify" aria-label="通知設定" title="通知設定">${IC.sliders}</a></div>`)}
    <div class="nwrap-page">
      ${NS.offline ? '<p class="notice" style="margin:0">目前離線，顯示的是上次的通知</p>' : ''}
      ${hint ? `<p class="tiny nhint" id="nhint">${matchMedia('(pointer:coarse)').matches ? '長按通知可以標為未讀或刪除' : '在通知上按右鍵或右邊的更多按鈕，可以標為未讀或刪除'}<button type="button" class="linkbtn" id="nhintOk">知道了</button></p>` : ''}
      <div id="npill" class="npillbox"></div>
      <div class="chipbar" id="nchips" role="tablist" aria-label="通知分類" aria-controls="nfeed"></div>
      <div id="nfeed" class="nfeed" role="tabpanel"></div>
      <div id="nfoot" class="nfootbox"></div>
    </div>`;
  paintChips(); fillFeed(r); paintCounts();
  bindNotif($('.nwrap-page'));
  // 進入通知中心＝看過了：鈴鐺的「新通知」歸零（未讀的帳號安全通知仍然算），每一列的未讀點不變
  if (!NS.offline) api('/notifications/seen', { method: 'POST' }).then(applyCounts).catch(() => {});
  NS.timer = setInterval(tickToday, 60000);
}
function bindNotif(page) {
  let lp = null;
  const cancel = () => { if (lp && !lp.fired) { clearTimeout(lp.t); lp.li.classList.remove('pressing'); lp = null; } };
  // 觸控裝置長按 500ms 開動作選單；移動超過 8px 或放開就取消
  page.addEventListener('pointerdown', (e) => {
    // 長按觸發後 Android 不會送出 click，lp 留著會吞掉下一次點擊：新的一次按下一律先清掉
    if (lp?.fired) lp = null;
    const li = e.target.closest('.nitem');
    if (!li || e.pointerType === 'mouse' || e.target.closest('button')) return;
    cancel();
    li.classList.add('pressing');
    lp = { li, x: e.clientX, y: e.clientY, t: setTimeout(() => { li.classList.remove('pressing'); lp.fired = true; navigator.vibrate?.(10); nActions(li); }, 500) };
  });
  page.addEventListener('pointermove', (e) => { if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) cancel(); });
  page.addEventListener('pointerup', cancel);
  page.addEventListener('pointercancel', cancel);
  page.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('.nitem'); if (!li) return;
    e.preventDefault();
    if (lp) { if (lp.fired) return; clearTimeout(lp.t); li.classList.remove('pressing'); lp.fired = true; }
    nActions(li);
  });
  page.addEventListener('click', (e) => {
    if (lp?.fired) { e.preventDefault(); e.stopPropagation(); lp = null; return; }
    const t = e.target;
    const chipBtn = t.closest('[data-nk]'); if (chipBtn) { if (chipBtn.getAttribute('aria-selected') !== 'true') switchChip(chipBtn.dataset.nk); return; }
    const more = t.closest('[data-more]'); if (more) { nActions(more.closest('.nitem')); return; }
    const ack = t.closest('[data-ack]');
    if (ack) {
      const li = ack.closest('.nitem'); markRead(li); const notme = ack.dataset.ack === 'notme'; ack.parentElement.remove();
      if (notme) location.hash = '#/me/security'; else li.querySelector('.nrow')?.focus();
      return;
    }
    const a = t.closest('a.nrow');
    if (a) {
      const li = a.closest('.nitem'), n = NS.data.get(li.dataset.id), nb = li.querySelector('.nb');
      markRead(li);
      if (n && (a.hasAttribute('data-detail') || (nb && nb.scrollHeight > nb.clientHeight + 1))) { e.preventDefault(); nDetail(n, a); }
      return;
    }
    if (t.closest('[data-nall]')) { switchChip('all'); return; }
    if (t.closest('[data-nretry]')) { loadFeed(); return; }
    if (t.closest('.npill')) { $(`#nchip-${NS.key}`)?.focus(); loadFeed(); return; }
    if (t.closest('#nmore')) { nMore(t.closest('#nmore')); return; }
    if (t.closest('#nclear')) { clearRead(t.closest('#nclear')); return; }
    if (t.closest('#nhintOk')) { lsSet('cil-nhint', '1'); $('#nhint')?.remove(); }
  });
  // 全部已讀在大標題列（.nwrap-page 外面）
  $('#readAll')?.addEventListener('click', (e) => readAll(e.currentTarget));
  // chip：左右方向鍵移動焦點（roving tabindex）
  $('#nchips').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const bs = [...document.querySelectorAll('#nchips [data-nk]')], i = bs.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
    for (const b of bs) b.tabIndex = -1;
    bs[j].tabIndex = 0; bs[j].focus();
  });
}
function ago(ts) {
  const m = Math.floor((Date.now() - new Date(`${ts.replace(' ', 'T')}Z`)) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小時前`;
  return `${Math.floor(m / 1440)} 天前`;
}
// 鈴鐺顯示「新通知」（上次打開通知中心之後的＋未讀的帳號安全通知）；30 秒內不重抓，強制更新用 bell(true)
// 換了帳號（通行金鑰登入不重新載入頁面）一律重抓，不沿用上一個帳號的數字
let bellAt = 0, bellFor = null, bellState = { badge: 0, unread: 0 };
async function bell(force = false) {
  if (!me || (!force && me.id === bellFor && Date.now() - bellAt < 30000)) return;
  if (me.id !== bellFor) { bellFor = me.id; bellState = { badge: 0, unread: 0 }; paintBell(); }
  bellAt = Date.now();
  try {
    const r = await api('/notifications/count');
    bellState = { badge: r.badge ?? r.unread, unread: r.unread };
    paintBell();
  } catch {}
}
function paintBell() {
  const b = $('#bellCount'), a = $('#bell'), n = bellState.badge;
  b.textContent = n > 99 ? '99+' : n; b.hidden = !n;
  a.setAttribute('aria-label', I18N.t(n ? `通知，${n} 則新通知` : '通知'));
  if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ---------- 教練發布課表 ----------
const planTeams = () => teams().filter((t) => allow('plan') || teamAllow(t.id, 'appoint'));
const canPublishPlan = () => allow('plan') || teams().some((t) => teamAllow(t.id, 'appoint'));
async function planNewView() {
  if (!canPublishPlan()) { view.innerHTML = '<div class="card"><p class="muted">只有教練與分團團長可以發布課表。</p></div>'; return; }
  const preset = new URLSearchParams(location.hash.split('?')[1] || '').get('team') || '';
  view.innerHTML = `<section class="card">
    <h2>發布課表</h2>
    <p class="muted" style="margin:0">把 LINE 記事本的課表原文貼進來就好，團員會在通知中心看到，也會收到推播。</p>
    <form id="pf">
      <div class="grid2">
        <label>週次（選填）<input type="number" name="week_no" min="1" max="21" placeholder="例如 10"></label>
        <label>階段（選填）<input name="phase" maxlength="10" placeholder="強化期"></label>
      </div>
      <label>標題<input name="title" required maxlength="40" placeholder="2026 台北馬 W10 課表"></label>
      <label>課表內容<textarea name="body" required style="min-height:220px" placeholder="全馬組&#10;S SUB 2:55~03:00&#10;週一:…"></textarea></label>
      <label>給誰看<select name="team_id">${allow('plan') ? '<option value="">全協會</option>' : ''}${planTeams().map((t) => `<option value="${esc(t.id)}" ${preset === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" name="notify" checked> 發布後通知（選了分團就只通知那個分團）</label>
      <button class="btn block">發布</button>
    </form>
  </section>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/plans', { method: 'POST', body: {
        title: f.title.value, body: f.body.value, phase: f.phase.value, team_id: f.team_id.value || null,
        week_no: f.week_no.value ? Number(f.week_no.value) : null, notify: f.notify.checked } });
      toast('已發布'); location.hash = '#/plan';
    } catch (err) { toast(err.message); }
  };
}


// ---------- admin.js（用到才載入）----------
const adminView = lazy('./admin.js', 'adminView');
const rosterView = lazy('./admin.js', 'rosterView');
// ---------- 春酒：入場券、報到、抽獎 ----------
// ---------- 邀請制：受邀名單與邀請連結 ----------
const VIA_NAME = { manual: '個別邀請', team: '分團', link: '邀請連結' };
function inviteCard(ev) {
  const link = ev.invite?.token ? `${eventUrl(ev.id)}?t=${ev.invite.token}` : '';
  const teamOpts = teams().filter((t) => teamAllow(t.id, 'roster'));
  return `<section class="card" id="invCard">
    <div class="row spread"><h3 class="row" style="gap:6px">${IC.lock}受邀名單</h3><span class="tiny"><b class="num">${ev.invite?.count || 0}</b> 人受邀</span></div>
    <p class="tiny" style="margin:0">只有名單上的人看得到這個活動。移出名單會一併取消他的報名與入場券。</p>
    <form id="invSearch" class="row" style="gap:8px" role="search" data-live><input name="q" placeholder="搜尋姓名或暱稱邀請" aria-label="搜尋要邀請的人" style="flex:1" autocomplete="off"><button class="btn ghost sm">搜尋</button></form>
    <div class="roster" id="invHits"></div>
    ${teamOpts.length ? `<form id="invTeam" class="row" style="gap:8px"><select name="team" style="flex:1">${teamOpts.map((t) => `<option value="${esc(t.id)}">整個${esc(t.name)}（${t.count} 人）</option>`).join('')}</select><button class="btn ghost sm">邀請整團</button></form>` : ''}
    <div class="invlink">
      <div class="row spread"><b>邀請連結</b><label class="switch" style="border:0;padding:0"><input type="checkbox" id="invLinkOn" ${link ? 'checked' : ''}><i></i></label></div>
      ${link ? `<div class="row" style="gap:8px"><input readonly value="${esc(link)}" aria-label="邀請連結" style="flex:1;font-size:13px" onfocus="this.select()">
        <button class="btn sm" id="invCopy">複製</button></div>
        <div class="row" style="gap:8px"><button class="btn ghost sm" id="invRotate">重新產生（舊連結失效）</button></div>`
        : '<p class="tiny" style="margin:0">打開後會產生一條連結，拿到連結的人登入就自動加入受邀名單；不想再讓人加入時關掉即可。</p>'}
    </div>
    <details id="invListWrap"><summary class="tiny" style="cursor:pointer">看受邀名單</summary><div class="roster" id="invList"><p class="muted">載入中…</p></div></details>
  </section>`;
}
function bindInviteCard(ev) {
  const reload = () => eventView(ev.id);
  const add = async (body, msg) => { try { const r = await api(`/events/${ev.id}/invites`, { method: 'POST', body }); toast(r.added ? `${msg}（新增 ${r.added} 人，已通知）` : '他們都已經在名單上'); reload(); } catch (e) { toast(e.message); } };
  const invOnly = latest();
  $('#invSearch').onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return toast('請輸入姓名');
    // 協會幹部從全體名冊找；分團幹部從自己分團找
    const r = await invOnly(allow('roster') ? api(`/members?q=${encodeURIComponent(q)}`)
      : ev.team_id ? api(`/teams/${ev.team_id}/members?q=${encodeURIComponent(q)}`) : Promise.resolve({ members: [] }));
    $('#invHits').innerHTML = r.members.map((m) => `<div class="r">${avatar(m)}<span><span translate="no">${esc(m.name)}</span>${m.nickname ? ` <span class="tiny"><span translate="no">${esc(m.nickname)}</span></span>` : ''}</span>
      <button class="btn ghost sm" data-inv="${m.id}">邀請</button></div>`).join('') || '<p class="muted" style="margin:0">找不到</p>';
    for (const b of document.querySelectorAll('[data-inv]')) b.onclick = () => add({ member_ids: [b.dataset.inv] }, '已邀請');
  };
  $('#invTeam')?.addEventListener('submit', (e) => { e.preventDefault(); add({ team_id: e.target.team.value }, '已邀請整團'); });
  const setLink = async (on) => { try { await api(`/events/${ev.id}/invite-link`, { method: 'POST', body: { on } }); toast(on ? '邀請連結已開啟' : '邀請連結已關閉'); reload(); } catch (e) { toast(e.message); } };
  $('#invLinkOn').onchange = (e) => setLink(e.target.checked);
  $('#invRotate')?.addEventListener('click', () => confirm('重新產生後，舊的邀請連結會失效。確定？') && setLink(true));
  $('#invCopy')?.addEventListener('click', () => copy(`${ev.invite?.token ? `${eventUrl(ev.id)}?t=${ev.invite.token}` : ''}`));
  $('#invListWrap').ontoggle = async (e) => {
    if (!e.target.open) return;
    const { invites } = await api(`/events/${ev.id}/invites`);
    $('#invList').innerHTML = invites.map((m) => `<div class="r">${avatar(m)}
      <span><span translate="no">${esc(m.name)}</span><span class="tiny" style="display:block">${VIA_NAME[m.via] || ''}${m.status === 'in' ? '・已報名' : m.status === 'wait' ? '・候補' : ''}</span></span>
      <button class="btn danger sm" data-uninv="${m.id}" data-name="${esc(m.name)}">移出</button></div>`).join('') || '<p class="muted" style="margin:0">還沒有邀請任何人</p>';
    for (const b of document.querySelectorAll('[data-uninv]')) b.onclick = async () => {
      if (!confirm(`把 ${b.dataset.name} 移出受邀名單？他的報名與入場券也會取消。`)) return;
      try { await api(`/events/${ev.id}/invites/${b.dataset.uninv}`, { method: 'DELETE' }); toast('已移出'); reload(); } catch (err) { toast(err.message); }
    };
  };
}

// 報名表：春酒的攜伴與餐點、活動自訂問卷；基本資料一律帶入「我的」設定
function signupForm(ev, myStatus, full) {
  // 從「先填賽事報名資料」回來：把剛才選的組別、商品、備註帶回來
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem('cil-after-reg') || 'null'); if (draft?.ev === ev.id) sessionStorage.removeItem('cil-after-reg'); else draft = null; } catch {}
  if (draft) { ev = { ...ev, myOption: draft.option || ev.myOption, myItems: draft.items?.length ? draft.items : ev.myItems, draftNote: draft.note }; }
  const party = ev.kind === 'party', survey = ev.kind === 'survey';
  const meals = party ? (ev.meal_options || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  return `<form id="pform" class="signup">
    ${!survey ? `<p class="tiny" style="margin:0">以 <span translate="no">${esc(me.name)}</span>${me.nickname ? `（<span translate="no">${esc(me.nickname)}</span>）` : ''}・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組報名，<a href="#/me/profile">修改個人資料</a></p>` : ''}
    ${party && ev.guest_max ? `<label>攜伴人數<select name="guests">${Array.from({ length: ev.guest_max + 1 }, (_, i) => `<option value="${i}">${i ? `${i} 位` : '不帶'}</option>`).join('')}</select></label>` : ''}
    ${meals.length ? `<label>餐點<select name="meal">${meals.map((m) => `<option ${m === me.meal_pref ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : ''}
    ${(ev.options || []).length ? `<fieldset class="qset"><legend>報名組別 <span class="req">必填</span></legend><div class="chips">${ev.options.map((o) => `<label class="chip"><input type="radio" name="option" value="${esc(o.name)}" ${ev.myOption === o.name ? 'checked' : ''} required><span><span translate="no">${esc(o.name)}</span>${o.price ? `<small class="num">　${money(o.price)}</small>` : ''}</span></label>`).join('')}</div></fieldset>` : ''}
    ${ev.group_reg ? (ev.regProfile === 'ok'
      ? `<label class="inline consent"><input type="checkbox" name="reg_consent" ${ev.myRegConsent ? 'checked' : ''} required> 同意把我的賽事報名資料（含身分證字號）提供給主辦幹部，只用於這場的團體報名</label>`
      : `<p class="notice" style="margin:0">這場由幹部代為團體報名，需要你的報名資料（姓名、身分證字號、生日、緊急聯絡人等）。填一次之後每場都能用。<a href="#/me/reg" id="goReg">去填寫 ›</a></p>`) : ''}
    ${(ev.items || []).length ? `<fieldset class="qset items"><legend>${ev.kind === 'buy' ? '要訂的商品' : '加購（選填）'}</legend>${ev.items.map((it) => itemPicker(it, ev)).join('')}</fieldset>` : ''}
    ${charges(ev) ? '<div class="quote" id="quote" aria-live="polite"></div>' : ''}
    ${questionFields(ev.questions || [], ev.myAnswers || {})}
    ${draft ? '<p class="notice" style="margin:0">已帶回你剛才選的內容，確認後送出報名。</p>' : ''}
    ${survey ? '' : `<label>備註（選填）<input name="note" maxlength="40" value="${esc(ev.draftNote || '')}" placeholder="${party ? '素食、座位需求…' : '晚到、只跑前半段…'}"></label>`}
    <button class="btn block">${submitLabel(ev, myStatus, full)}</button>
  </form>`;
}
// 團購／加購：每個尺寸一列，數量用 − ＋ 調整；顯示剩餘庫存
function itemPicker(it, ev) {
  const mineQ = (size) => (ev.myItems || []).find((x) => x.id === it.id && (x.size || '') === size)?.qty || 0;
  const left = it.stock ? Math.max(0, it.stock - (ev.sold?.[it.id] || 0) + (ev.myItems || []).filter((x) => x.id === it.id).reduce((n, x) => n + x.qty, 0)) : null;
  const rows = (it.sizes.length ? it.sizes : ['']).map((z) => `<div class="stepper" data-item="${esc(it.id)}" data-size="${esc(z)}">
      <span>${z ? esc(z) : '數量'}</span><button type="button" data-step="-1" aria-label="${esc(it.name)} ${esc(z)} 減一">−</button>
      <output class="num">${mineQ(z)}</output><button type="button" data-step="1" aria-label="${esc(it.name)} ${esc(z)} 加一">＋</button></div>`).join('');
  return `<div class="itempick" data-max="${it.max}" data-left="${left ?? ''}"><div class="row spread"><b><span translate="no">${esc(it.name)}</span></b><span class="tiny"><span class="num">${money(it.price)}</span>${left != null ? `・剩 ${left}` : ''}${it.max < 10 ? `・每人最多 ${it.max}` : ''}</span></div>
    <div class="steppers">${rows}</div></div>`;
}
const readItems = (f) => [...f.querySelectorAll('.stepper')].map((s) => ({ id: s.dataset.item, size: s.dataset.size, qty: Number(s.querySelector('output').value || s.querySelector('output').textContent) || 0 })).filter((x) => x.qty > 0);
// 報名表即時算金額（預覽；實際以伺服器算的為準）
function bindQuote(f, ev) {
  const box = f.querySelector('#quote');
  const paint = () => {
    if (!box) return;
    const signedOn = ev.mySignedOn || nowTp().slice(0, 10);   // 早鳥看這次報名的日期（台北時間）
    const q = quote(ev, { option: f.querySelector('[name=option]:checked')?.value || null, guests: Number(f.guests?.value || 0), items: readItems(f), membership: ev.myMembership, signedOn });
    box.innerHTML = q.lines.length ? `${q.lines.map((l) => `<div class="ql ${l.amount < 0 ? 'off' : ''}"><span><span translate="no">${esc(l.label)}</span>${l.qty > 1 ? ` × ${l.qty}` : ''}</span><span class="num">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</span></div>`).join('')}
      <div class="ql total"><span>合計</span><b class="num">${money(q.total)}</b></div>` : '';
  };
  for (const st of f.querySelectorAll('.stepper')) for (const b of st.querySelectorAll('[data-step]')) b.onclick = () => {
    const out = st.querySelector('output'), pick = st.closest('.itempick'), max = Number(pick.dataset.max) || 10, left = pick.dataset.left === '' ? Infinity : Number(pick.dataset.left);
    const inItem = [...pick.querySelectorAll('output')].reduce((n, o) => n + Number(o.textContent), 0);
    const next = Number(out.textContent) + Number(b.dataset.step);
    if (next < 0) return;
    if (Number(b.dataset.step) > 0 && inItem >= Math.min(max, left)) return toast(left < max ? `只剩 ${left} 件` : `每人最多 ${max} 件`);
    out.textContent = String(next); navigator.vibrate?.(8); paint();
  };
  f.addEventListener('change', paint);
  paint();
}
// 我的繳費：金額明細、收款帳戶、回報轉帳後五碼；幹部確認後顯示已繳
function payCard(ev) {
  const pi = ev.payInfo || {}, amount = ev.myAmount ?? 0, paid = ev.myPaid === 'paid' || ev.myPaid === 'waived';
  const methods = (pi.methods && pi.methods.length ? pi.methods : ['transfer']);
  const M = { transfer: '銀行轉帳', cash: '現金', linepay: 'LINE Pay' };
  return `<section class="card paycard ${paid ? 'paid' : ev.myPayReported ? 'reported' : ''}" id="payCard">
    <div class="row spread"><h3>${paid ? '已完成繳費' : ev.myPayReported ? '已回報，等幹部確認' : '繳費'}</h3><b class="num amount">${money(amount)}</b></div>
    ${(ev.myLines || []).length ? `<div class="quote">${ev.myLines.map((l) => `<div class="ql ${l.amount < 0 ? 'off' : ''}"><span><span translate="no">${esc(l.label)}</span>${l.qty > 1 ? ` × ${l.qty}` : ''}</span><span class="num">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</span></div>`).join('')}</div>` : ''}
    ${ev.myPaidNote && !paid ? `<p class="notice" style="margin:0"><span translate="no">${esc(ev.myPaidNote)}</span></p>` : ''}
    ${ev.myPickCode && !ev.myPicked ? `<div class="pickbox"><div class="qrbox" id="pickQR" data-code="${esc(ev.myPickCode)}"></div><div><b>領取 QR</b><span class="tiny" style="display:block">${ev.pickupNote ? `<span translate="no">${esc(ev.pickupNote)}</span>・` : ''}領取時出示給幹部掃描</span><span class="code num">${esc(ev.myPickCode)}</span></div></div>` : ''}
    ${paid ? `<p class="tiny" style="margin:0">${ev.myPaid === 'waived' ? '這筆免繳。' : '幹部已經確認收到款項，謝謝。'}${ev.myPicked ? '商品已領取。' : (ev.items || []).length && !ev.arrived ? '商品到貨後幹部會通知領取。' : ''}</p>`
      : ev.myPayReported ? `<p class="tiny" style="margin:0">${M[ev.myPayMethod] || ''}${ev.myPayRef ? `・後五碼 ${esc(ev.myPayRef)}` : ''}・${ago(ev.myPayReported)}回報</p><button class="btn ghost sm" id="payUndo">回報錯了，重新填</button>`
      : `${pi.account ? `<div class="acct"><span class="tiny">收款帳戶</span><pre>${esc(pi.account)}</pre><button type="button" class="btn ghost sm" id="copyAcct">複製</button></div>` : ''}
        ${pi.due ? `<p class="tiny" style="margin:0">請在 ${esc(pi.due)} 前完成繳費${pi.note ? `・<span translate="no">${esc(pi.note)}</span>` : ''}</p>` : pi.note ? `<p class="tiny" style="margin:0"><span translate="no">${esc(pi.note)}</span></p>` : ''}
        <form id="payForm" class="row" style="gap:8px;align-items:end">
          ${methods.length > 1 ? `<label style="flex:1;min-width:110px">方式<select name="method">${methods.map((m) => `<option value="${m}">${M[m]}</option>`).join('')}</select></label>` : `<input type="hidden" name="method" value="${methods[0]}">`}
          <label style="flex:1;min-width:120px" data-ref>轉帳後五碼<input name="ref" inputmode="numeric" maxlength="6" pattern="\\d{4,6}" autocomplete="off" placeholder="12345"></label>
          <button class="btn sm">我已繳費</button></form>`}
  </section>`;
}
function bindPayCard(ev) {
  $('#copyAcct')?.addEventListener('click', () => copy(ev.payInfo.account));
  const pq = $('#pickQR');
  if (pq) qrSVG(pq.dataset.code).then((svg) => { pq.innerHTML = svg; }).catch(() => {});
  const f = $('#payForm');
  if (f) {
    const sync = () => { const t = f.method.value === 'transfer'; f.querySelector('[data-ref]').hidden = !t; f.ref.required = t; };
    f.method.onchange = sync; sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/events/${ev.id}/pay-report`, { method: 'POST', body: { method: f.method.value, ref: f.ref.value.trim() } }); toast('已回報，幹部確認後會更新'); render(); }
      catch (err) { toast(err.message); }
    };
  }
  $('#payUndo')?.addEventListener('click', async () => { try { await api(`/events/${ev.id}/pay-report`, { method: 'POST', body: { cancel: true } }); render(); } catch (err) { toast(err.message); } });
}
function questionFields(qs, ans) {
  return qs.map((q) => {
    const v = ans[q.id], req = q.required ? '<span class="req">必填</span>' : '';
    if (q.type === 'text') return `<label><span translate="no">${esc(q.label)}</span> ${req}<input data-q="${esc(q.id)}" maxlength="300" value="${esc(v || '')}" ${q.required ? 'required' : ''}></label>`;
    const multi = q.type === 'multi';
    return `<fieldset class="qset"><legend><span translate="no">${esc(q.label)}</span> ${req}${multi ? '<span class="tiny">可複選</span>' : ''}</legend>
      <div class="chips">${q.options.map((o) => `<label class="chip"><input type="${multi ? 'checkbox' : 'radio'}" name="q_${esc(q.id)}" value="${esc(o)}"
        ${(multi ? (v || []).includes(o) : v === o) ? 'checked' : ''} ${!multi && q.required ? 'required' : ''}><span>${esc(o)}</span></label>`).join('')}</div></fieldset>`;
  }).join('');
}
function readQuestionFields(form, qs) {
  const out = {};
  for (const q of qs) {
    if (q.type === 'text') { out[q.id] = form.querySelector(`[data-q="${CSS.escape(q.id)}"]`)?.value.trim() || ''; continue; }
    const picked = [...form.querySelectorAll(`input[name="q_${CSS.escape(q.id)}"]:checked`)].map((i) => i.value);
    out[q.id] = q.type === 'multi' ? picked : picked[0];
  }
  return out;
}
function ticketCard(t, ev, title = '我的入場券') {
  return `<section class="card ticket">
    <div class="row spread"><h3><span translate="no">${esc(title)}</span></h3>${t.checked_in_at ? '<span class="pill solid">已報到</span>' : '<span class="pill">未報到</span>'}</div>
    <div class="qrbox" ${title === '我的入場券' ? 'id="qrBox"' : ''} data-code="${esc(t.code)}" data-ev="${esc(ev.id)}"></div>
    <div class="code num"><span translate="no">${esc(t.code)}</span></div>
    <div class="trow">
      <span><u>桌次</u>${t.table_no ? `第 ${t.table_no} 桌` : '未排桌'}</span>
      <span><u>餐點</u>${t.meal ? esc(t.meal) : '—'}</span>
      <span><u>攜伴</u>${t.guests || 0} 位</span>
    </div>
    <p class="tiny center">入場時出示這個 QR Code，工作人員掃描即可報到</p>
  </section>`;
}
async function paintQR(ev, code) {
  const box = $('#qrBox');
  if (!box) return;
  try { box.innerHTML = await qrSVG(`${location.origin}/#/e/${ev.id}/in/${code}`, { size: 200, dark: '#0B1B33', light: '#fff' }); }
  catch { box.innerHTML = '<p class="tiny">QR 產生失敗，請用下方代碼報到</p>'; }
}

// 現場自助報到：掃主辦人出示的 QR 進來
async function attendView(id) {
  const t = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  view.innerHTML = '<p class="loading">報到中…</p>';
  try {
    const r = await api(`/events/${id}/attend`, { method: 'POST', body: { t } });
    history.replaceState(null, '', `#/e/${id}/attend`);
    view.innerHTML = `<section class="card ok attendok"><span class="big">${IC.checkCircle}</span><h2>報到完成</h2>
      <p class="muted" style="margin:0">${r.walkIn ? '你原本沒有報名，已經幫你加入名單。' : '今天也辛苦了，練完記得記錄訓練。'}</p>
      <a class="btn block" href="#/e/${esc(id)}">回活動頁</a><a class="btn ghost block" href="#/log?event=${esc(id)}">記錄今天的訓練</a></section>`;
  } catch (e) {
    view.innerHTML = `<section class="card"><h2>報到沒有成功</h2><p class="muted">${esc(e.message)}</p><a class="btn ghost block" href="#/e/${esc(id)}">回活動頁</a></section>`;
  }
}

// 我的入場券：所有即將到來的入場券集中在一頁（主畫面捷徑直達，離線也能出示）
async function ticketsView() {
  const [{ tickets }, { pickups = [] }, { prizes = [] }] = await Promise.all([api('/my/tickets'), api('/my/pickups').catch(() => ({})), api('/my/prizes').catch(() => ({}))]);
  view.innerHTML = `${largeTitle('入場券與領取', tickets.length || pickups.length ? '把 QR Code 給工作人員掃描' : '')}
    ${pickups.map((p) => `<section class="card"><div class="row spread"><h3><span translate="no">${esc(p.title)}</span></h3><span class="pill solid">待領取</span></div>
      <div class="pickbox"><div class="qrbox" data-pick="${esc(p.code)}"></div><div><b>領取 QR</b><span class="tiny" style="display:block">${p.note ? `<span translate="no">${esc(p.note)}</span>` : '領取時出示給幹部掃描'}</span><span class="code num">${esc(p.code)}</span></div></div>
      <a class="tiny" href="#/e/${esc(p.event_id)}">活動頁 ›</a></section>`).join('')}
    ${tickets.map((t) => `${ticketCard(t, { id: t.event_id }, t.title)}<p class="tiny center" style="margin:-6px 0 8px">${dstr(t.date)}${t.gather_time ? ` ${t.gather_time}` : ''}${t.place ? `・<span translate="no">${esc(t.place)}</span>` : ''}　<a href="#/e/${esc(t.event_id)}">活動頁 ›</a></p>`).join('')}
    ${!tickets.length && !pickups.length ? `<div class="card">${emptyState('calendar', '目前沒有入場券或待領取的團購。')}<a class="btn ghost sm" href="#/" style="justify-self:center">看接下來的活動</a></div>` : ''}
    ${prizes.length ? `<section class="card"><h3>中獎紀錄</h3><div class="roster">${prizes.map((x) => `<a class="r" href="#/e/${esc(x.event_id)}"><span class="av">${IC.gift}</span><span><b><span translate="no">${esc(x.prize)}</span></b><span class="tiny" style="display:block"><span translate="no">${esc(x.title)}</span>${x.sponsor ? `・<span translate="no">${esc(x.sponsor)}</span> 贊助` : ''}${x.claimed_at ? '・已領取' : ''}</span></span><span class="tiny">›</span></a>`).join('')}</div></section>` : ''}`;
  for (const box of document.querySelectorAll('.qrbox[data-pick]')) qrSVG(box.dataset.pick).then((svg) => { box.innerHTML = svg; }).catch(() => {});
  for (const box of document.querySelectorAll('.qrbox[data-code]')) {
    try { box.innerHTML = await qrSVG(`${location.origin}/#/e/${box.dataset.ev}/in/${box.dataset.code}`, { size: 200, dark: '#0B1B33', light: '#fff' }); }
    catch { box.innerHTML = '<p class="tiny">QR 產生失敗，請用下方代碼報到</p>'; }
  }
}

// 安裝到主畫面：iPhone 要手動「分享 → 加入主畫面」，Android／桌機用瀏覽器的安裝提示
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SHARE_IC = ic('<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/>');
const ADD_IC = ic('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>');
function installCard(where) {
  if (isStandalone()) return '';
  try { if (where === 'home' && localStorage.getItem('cil-install-dismiss')) return ''; } catch {}
  const ios = isIOS();
  return `<section class="card tight installcard">
    <div class="instrow"><img src="/icons/icon-192.png" alt="" width="40" height="40">
      <span><b>把耕跑團加到主畫面</b><span class="tiny">才收得到團練通知，入場券沒網路也能出示</span></span>
      ${where === 'home' ? '<button class="iconx" id="installX" aria-label="不再顯示">' + ic('<path d="M7 7l10 10M17 7 7 17"/>') + '</button>' : ''}</div>
    ${ios ? `<details ${where === 'me' ? 'open' : ''}><summary class="tiny">怎麼加？三個步驟</summary><ol class="steps">
        <li>點 Safari 下方的分享按鈕 ${SHARE_IC}</li>
        <li>往下滑，選「加入主畫面」${ADD_IC}</li>
        <li>按「新增」，之後從主畫面的耕跑團圖示打開</li></ol>
        <p class="tiny" style="margin:0">在 LINE 裡打開的話，先點右下角選單選「用預設瀏覽器開啟」。</p></details>`
      : `<button class="btn sm block" data-install ${installEvt ? '' : 'hidden'}>安裝 App</button>
         <p class="tiny" style="margin:0" ${installEvt ? 'hidden' : ''}>點瀏覽器右上角選單，選「安裝應用程式」或「加到主畫面」。</p>`}
  </section>`;
}
function bindInstall() {
  for (const b of document.querySelectorAll('[data-install]')) b.onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    const { outcome } = await installEvt.userChoice.catch(() => ({}));
    if (outcome === 'accepted') toast('安裝完成，之後從主畫面打開');
    installEvt = null;
  };
  $('#installX')?.addEventListener('click', () => { try { localStorage.setItem('cil-install-dismiss', '1'); } catch {} $('.installcard')?.remove(); });
}

// 掃碼／連結報到：/#/e/<id>/in/<code>
async function checkinView(eventId, code) {
  const ok = allow('checkin') || (await api(`/events/${eventId}`).catch(() => ({}))).checkin;
  if (!ok) {
    view.innerHTML = `<section class="card"><h2>入場代碼</h2><p class="muted">這是入場券連結，請把畫面出示給工作人員。</p>
      <div class="code num" style="font-size:40px;letter-spacing:.2em;text-align:center">${esc(code)}</div>
      <a class="btn ghost block" href="#/e/${esc(eventId)}">回活動頁</a></section>`;
    return;
  }
  view.innerHTML = '<p class="loading">報到中…</p>';
  try {
    const r = await api(`/events/${eventId}/checkin`, { method: 'POST', body: { code } });
    view.innerHTML = `<section class="card ${r.already ? '' : 'ok'}">
      <h2>${r.already ? '這張票已經報到過' : '報到完成'}</h2>
      <p style="font-size:30px;font-weight:700;margin:4px 0"><span translate="no">${esc(r.name)}</span></p>
      <p class="muted" style="margin:0">${r.table_no ? `第 ${r.table_no} 桌・` : ''}${r.guests ? `攜伴 ${r.guests} 位・` : ''}${r.meal ? esc(r.meal) : ''}</p>
      <a class="btn block" href="#/e/${esc(eventId)}/scan">繼續掃下一位</a>
      <a class="btn ghost block" href="#/e/${esc(eventId)}">回活動頁</a></section>`;
  } catch (e) {
    view.innerHTML = `<section class="card"><h2>報到失敗</h2><p class="muted">${esc(e.message)}</p>
      <a class="btn block" href="#/e/${esc(eventId)}/scan">再掃一次</a></section>`;
  }
}

// 掃描台：有相機就用相機掃（iPhone 也可以，第一次會詢問相機權限），也可以手動輸入代碼
let stopScan = null;
// 掃碼面板（團購領取、會籍卡驗證共用）：打開就啟動相機（第一次會詢問相機權限），也可以手動輸入代碼
//   onCode(code) 回傳要顯示的結果文字；連續掃描時 1.8 秒內不重複處理
function scanSheet({ title, hint, placeholder = '手動輸入代碼', onCode }) {
  const host = document.createElement('div');
  host.className = 'sheet'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); host.setAttribute('aria-label', title);
  host.innerHTML = `<div class="sheet-bg" data-bg></div><div class="sheet-card card"><div class="row spread"><h3>${esc(title)}</h3><button class="btn ghost sm" data-close>完成</button></div>
    ${canScan() ? '<video playsinline muted class="cam" aria-label="相機畫面"></video>' : '<p class="notice" style="margin:0">這台裝置沒有可以用的相機，請手動輸入代碼。</p>'}
    <p class="tiny center scanmsg" aria-live="polite">${esc(hint)}</p>
    <form class="row" style="gap:8px"><input name="code" placeholder="${esc(placeholder)}" style="flex:1" autocomplete="off" aria-label="${esc(placeholder)}"><button class="btn sm">送出</button></form></div>`;
  document.body.append(host);
  let stop = null, busy = false;
  const close = () => { stop?.(); host.remove(); };
  const msg = host.querySelector('.scanmsg');
  const run = async (code) => {
    if (busy) return; busy = true;
    try { msg.textContent = await onCode(code.trim()); navigator.vibrate?.(30); } catch (e) { msg.textContent = e.message; }
    setTimeout(() => { busy = false; }, 1800);
  };
  host.querySelector('[data-close]').onclick = close;
  host.querySelector('[data-bg]').onclick = close;
  host.querySelector('form').onsubmit = (e) => { e.preventDefault(); run(e.target.code.value); e.target.code.value = ''; };
  if (canScan()) {
    msg.textContent = '正在打開相機…';
    scan(host.querySelector('video'), (v) => run(v)).then((s0) => { if (host.isConnected) { stop = s0; msg.textContent = hint; } else s0(); })
      .catch((e) => { msg.textContent = e.message; host.querySelector('video')?.remove(); });
  }
  return close;
}
async function scanView(eventId) {
  if (!allow('checkin') && !(await api(`/events/${eventId}`).catch(() => ({}))).checkin) { view.innerHTML = '<div class="card"><p class="muted">只有幹部可以掃碼報到。</p></div>'; return; }
  view.innerHTML = `<section class="card">
    <div class="row spread"><h2>掃碼報到</h2><a class="tiny" href="#/e/${esc(eventId)}">完成</a></div>
    ${canScan() ? '<video id="cam" playsinline muted class="cam" aria-label="相機畫面"></video><p class="tiny center" id="scanMsg" aria-live="polite">正在打開相機…</p>'
      : '<p class="notice">這台裝置沒有可以用的相機。請在報到台手動輸入代碼，或用手機內建相機 App 掃 QR 開啟報到頁。</p>'}
    <form id="manual" class="row" style="gap:8px">
      <input name="code" placeholder="手動輸入代碼" style="flex:1;text-transform:uppercase" autocomplete="off">
      <button class="btn sm">報到</button>
    </form>
  </section>`;
  $('#manual').onsubmit = (e) => { e.preventDefault(); location.hash = `#/e/${eventId}/in/${e.target.code.value.trim().toUpperCase()}`; };
  if (!canScan()) return;
  try {
    let busy = false;
    const stopper = await scan($('#cam'), async (value) => {
      if (busy) return;
      const code = (value.match(/\/in\/([A-Z0-9]{4,10})/i)?.[1] || value).trim().toUpperCase();
      busy = true;
      try {
        const r = await api(`/events/${eventId}/checkin`, { method: 'POST', body: { code } });
        $('#scanMsg').textContent = `${r.already ? '已報到過：' : '報到完成：'}${r.name}${r.table_no ? `・第 ${r.table_no} 桌` : ''}`;
        toast(`${r.name} 報到完成`);
      } catch (err) { $('#scanMsg').textContent = err.message; }
      setTimeout(() => { busy = false; }, 1800);
    });
    // 等相機的時候已經離開這頁：直接關掉相機
    if (!$('#cam')) { stopper(); return; }
    stopScan = stopper;
    $('#scanMsg').textContent = '把入場券的 QR 對準框內';
  } catch (e) { if ($('#scanMsg')) { $('#scanMsg').textContent = e.message; $('#cam')?.remove(); } }
}
async function partyAdmin(ev) {
  const [{ tickets, checkedIn, people }, { prizes, draws }] = await Promise.all([
    api(`/events/${ev.id}/tickets`), api(`/events/${ev.id}/prizes`),
  ]);
  const won = new Map(draws.map((d) => [d.member_id, d]));
  return `
    <section class="card">
      <div class="row spread"><h3>排桌</h3><span class="tiny">輸入入場代碼指定桌次</span></div>
      <form id="seatForm" class="row" style="gap:8px">
        <input name="code" placeholder="入場代碼" style="flex:1;min-width:120px;text-transform:uppercase" autocomplete="off">
        <input name="table_no" type="number" min="1" max="31" placeholder="桌次" style="width:84px">
        <input name="note" placeholder="備註" style="width:110px">
        <button class="btn sm">儲存</button>
      </form>
    </section>

    <section class="card">
      <div class="row spread"><h3>報到台</h3><span class="tiny">${checkedIn}/${tickets.length} 人報到・含攜伴 ${people} 位</span></div>
      <a class="btn sm iconbtn" href="#/e/${ev.id}/scan">${IC.scan}掃碼報到</a>
      <form id="cform" class="row" style="gap:8px">
        <input name="code" placeholder="輸入入場代碼" style="flex:1;min-width:150px;text-transform:uppercase" autocomplete="off">
        <input name="seat" placeholder="桌次" style="width:90px">
        <button class="btn sm">報到</button>
      </form>
      <div class="roster">${tickets.map((t) => `
        <div class="r">${avatar(t)}
          <span><span translate="no">${esc(t.name)}</span>${t.nickname ? ` <span class="tiny"><span translate="no">${esc(t.nickname)}</span></span>` : ''}<span class="tiny" style="display:block"><span translate="no">${esc(t.code)}</span>${t.table_no ? `・第 ${t.table_no} 桌` : ''}${t.guests ? `・攜伴 ${t.guests}` : ''}${t.meal ? `・${esc(t.meal)}` : ''}</span></span>
          ${t.checked_in_at ? '<span class="pill solid">到</span>' : `<button class="btn ghost sm" data-ci="${esc(t.code)}">報到</button>`}
        </div>`).join('') || '<p class="muted">還沒有人報名。</p>'}</div>
    </section>

    <section class="card">
      <h3>抽獎</h3>
      ${prizes.map((p) => {
        const w = draws.filter((d) => d.prize_id === p.id);
        return `<div class="prize">
          <div class="row spread"><b>${p.stage ? `<span class="pill">${esc(p.stage)}</span> ` : ''}<span translate="no">${esc(p.name)}</span></b><span class="tiny">${w.length}/${p.qty}${p.sponsor ? `・${esc(p.sponsor)}` : ''}</span></div>
          ${w.length ? `<div class="winners">${w.map((d) => `<button class="pill ${d.claimed_at ? 'solid' : 'wait'}" data-claim="${d.id}" title="${d.claimed_at ? '已領獎' : '點一下確認領獎'}"><span translate="no">${esc(d.name)}</span>${d.claimed_at ? IC.check : ''}</button>`).join('')}</div>` : ''}
          ${w.length < p.qty ? `<button class="btn sm" data-draw="${p.id}">抽出 1 位</button>` : '<span class="tiny">已抽完</span>'}
        </div>`;
      }).join('') || '<p class="muted" style="margin:0">還沒有獎項。</p>'}
      <form id="prizeForm" class="row" style="gap:8px">
        <input name="name" placeholder="獎項名稱" style="flex:1;min-width:140px">
        <select name="stage" style="width:110px"><option value="">階段</option>${Party.STAGES.map((s) => `<option>${s}</option>`).join('')}</select>
        <input name="qty" type="number" min="1" max="400" value="1" style="width:70px">
        <input name="sponsor" placeholder="贊助商" style="width:110px">
        <button class="btn ghost sm">新增獎項</button>
      </form>
      <details><summary class="tiny" style="cursor:pointer">批次匯入獎項（每行一項：[階段] 名稱 x數量 / 贊助商）</summary>
        <form id="bulkPrize" style="margin-top:8px">
          <textarea name="text" placeholder="[暖身] NAUTICA 毛巾 x30&#10;[R1] 按摩槍 x2 / 贊助商&#10;[R2(大)] JBL Pace 運動耳機 x1 / JBL"></textarea>
          <button class="btn ghost sm">匯入</button>
        </form></details>
      <button class="btn block" id="openStage">進入抽獎舞台</button>
      <p class="tiny">預設從「已報到」的人裡面抽，而且一個人只會中一次。</p>
    </section>`;
}


// 全螢幕抽獎舞台（投影用）
async function lotteryStage(ev) {
  const { prizes, draws } = await api(`/events/${ev.id}/prizes`);
  if (!prizes.length) return toast('請先新增獎項');
  const host = document.createElement('div');
  host.innerHTML = Party.stageHTML(prizes, draws);
  document.body.append(host);
  document.body.style.overflow = 'hidden';
  const close = () => { host.remove(); document.body.style.overflow = ''; render(); };
  $('#lClose').onclick = close;
  $('#lCsv').onclick = () => open(`/api/events/${ev.id}/draws.csv`, '_blank');
  $('#lPrize').onchange = () => {
    const p = prizes.find((x) => x.id === $('#lPrize').value);
    $('#lStage').textContent = p?.stage ? `[${p.stage}]` : '抽獎';
    $('#lName').textContent = '準備開始'; $('#lSub').textContent = p ? p.name : '';
  };
  $('#lPrize').onchange();
  // 大螢幕操作：空白鍵或 Enter 抽獎、F 全螢幕、Esc 關閉
  const onKey = (e) => {
    if (e.target.closest('select,input')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); $('#lGo')?.click(); }
    else if (e.key === 'f' || e.key === 'F') (document.fullscreenElement ? document.exitFullscreen() : host.firstElementChild.requestFullscreen?.())?.catch?.(() => {});
    else if (e.key === 'Escape' && !document.fullscreenElement) { removeEventListener('keydown', onKey); close(); }
  };
  addEventListener('keydown', onKey);
  $('#lClose').onclick = () => { removeEventListener('keydown', onKey); document.fullscreenElement && document.exitFullscreen().catch(() => {}); close(); };
  $('#lGo').onclick = async () => {
    const btn = $('#lGo'); btn.disabled = true;
    try {
      const prizeId = $('#lPrize').value;
      const r = await api(`/events/${ev.id}/draw`, { method: 'POST', body: {
        prize_id: prizeId, count: 1,
        onlyCheckedIn: $('#lCheckedIn').checked, allowRepeat: $('#lRepeat').checked } });
      const w = r.winners[0];
      const { tickets } = await api(`/events/${ev.id}/tickets`).catch(() => ({ tickets: [] }));
      await Party.spin($('#lName'), tickets.map((t) => t.name), w.name);
      $('#lSub').textContent = `${r.prize}${w.nickname ? `・${w.nickname}` : ''}${w.table_no ? `・第 ${w.table_no} 桌` : ''}`;
      $('#lLog').insertAdjacentHTML('afterbegin', `<div class="lrow"><span><span translate="no">${esc(w.name)}</span></span><span class="tiny">${esc(r.prize)}</span></div>`);
      confetti();
      // 這個獎項抽完了：自動切到下一個還有名額的獎項
      const p = prizes.find((x) => x.id === prizeId);
      p.done = (p.done ?? draws.filter((d) => d.prize_id === prizeId).length) + 1;
      if (p.done >= p.qty) {
        const next = prizes.find((x) => (x.done ?? draws.filter((d) => d.prize_id === x.id).length) < x.qty);
        if (next) setTimeout(() => { $('#lPrize').value = next.id; $('#lPrize').onchange(); toast(`${p.name} 抽完了，下一個：${next.name}`); }, 2200);
      }
    } catch (e) { toast(e.message); }
    btn.disabled = false;
  };
}
// 彩帶：用 canvas 畫，不載外部套件
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti'; c.width = innerWidth; c.height = innerHeight;
  document.body.append(c);
  const ctx = c.getContext('2d');
  const colors = ['#FDF36D', '#B9D04C', '#1C4698', '#E8691A', '#fff'];
  const bits = Array.from({ length: 120 }, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height * .5,
    r: 4 + Math.random() * 6, vy: 2 + Math.random() * 4, vx: -1 + Math.random() * 2,
    rot: Math.random() * 6, vr: -.2 + Math.random() * .4, color: colors[Math.floor(Math.random() * colors.length)],
  }));
  let t = 0;
  (function frame() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
      ctx.fillStyle = b.color; ctx.fillRect(-b.r / 2, -b.r / 2, b.r, b.r * 1.6); ctx.restore();
    }
    if (++t < 180) requestAnimationFrame(frame); else c.remove();
  })();
}


// ---------- photo.js（用到才載入）----------
const studioView = lazy('./photo.js', 'studioView');
const studio = { stats: null, bg: null, template: 'minimal', size: 'story', source: 'manual', acts: null };
// ---------- 我的課表 ----------
// 週期：預設照我的課表週期（協會賽季或個人比賽日）；?c=club 是個人週期的會員看協會賽季（只能看，不能記錄）
const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
// 「W1 8/3（一）開始，還有 N 天」：整句放在同一段文字，英文介面才對得上句型
const w1Line = (c, today) => `${c.kind === 'club' ? 'W1 ' : '你的 W1 從 '}${md(c.w1)}（一）開始，還有 ${P.dayDiff(c.w1, P.parseISO(today))} 天`;
let viewCleanup = null;   // 課表頁加強功能（用語、滑動換週）離開時要清掉的監聽
const whenIdle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200));
async function planView(n) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const mine = myCycle(), c = q.get('c') === 'club' ? P.CLUB : mine, other = c !== mine, personal = c.kind !== 'club';
  const coach = feat('coach'), today = ymd(new Date()), wi = P.weekIndexOf(today, c);
  const week = n ? Math.min(21, Math.max(1, n)) : P.currentWeek(new Date(), c);
  const cq = other ? '?c=club' : '';
  const all = await P.weeks(), info = all[week - 1] || null;
  const raw = await P.weekPlan(week, me.dist, me.grp);
  // 每週能練的天數（課表設定）不夠時，輕鬆跑標成可省略；沒開課表教練就照原本每週 6 天
  const days = raw ? P.markOptional(raw, coach ? coachPrefs().plan : undefined, week) : null;
  const s = P.weekStart(week, c), e = P.addDays(s, 6), from = ymd(s), to = ymd(e);
  // 教練公告是協會週次：個人週期看同一個星期一開始的協會週（賽季外沒有）
  const postWeek = personal ? P.clubWeekOf(from) : week;
  const [posts, got] = await Promise.all([
    postWeek ? api(`/plans?week=${postWeek}`).then((r) => r.plans).catch(() => []) : [],
    api(`/logs?from=${from}&to=${to}`).then((r) => r.logs).catch(() => [])]);
  // 離線時先存在手機、還沒上傳的紀錄也算進來（打勾後馬上看得到）
  const logs = [...notQueued(got), ...logQueue.get().filter((x) => x.date >= from && x.date <= to).map((x) => ({ ...x, id: null, pending: true }))];
  const isNow = week === wi;
  // 這週的訓練紀錄：一律用 P.logMatches 對到每一列（同一個週期、同一週、同一天）
  const logOf = (d) => logs.filter((l) => P.logMatches(l, c, week, d));
  const extras = logs.filter((l) => l.status === 'extra' || !l.plan_day);
  const others = P.otherCycleLogs(logs, c, week, days);
  const wc = P.weekCompletion(days, logOf);
  const km = logs.reduce((x, l) => x + (l.km || 0), 0);
  const rpes = logs.filter((l) => l.rpe), avgRpe = rpes.length ? rpes.reduce((x, l) => x + l.rpe, 0) / rpes.length : 0;
  const started = from <= today;
  const venue = org().thu_venue || '';
  if (coach && personal && coachPrefs().cycleSeen?.anchor !== c.anchor) setCoachPrefs({ cycleSeen: { anchor: c.anchor, at: today } });
  // 賽前階段：個人週期跟著自己的比賽（倒數關掉也顯示）；協會賽季跟右上角倒數那一場
  const stageISO = !coach || other ? null : personal ? c.anchor : cfg.race?.date;
  const stage = stageISO ? P.raceStage(today, stageISO) : null;
  const stageName = personal ? c.name : cfg.race?.name || '';
  const weekday = personal && !P.weekendRace(c);
  const notices = [];
  if (other) notices.push(`<span>這是協會賽季 W${week}，只能看</span><span>；你的課表跟著 <span translate="no">${esc(mine.name)}</span>。</span><a href="#/plan">回我的課表 ›</a>`);
  if (wi < 1 && week === 1) notices.push(`<b>${w1Line(c, today)}</b><br><span>這段時間照平常的量跑${personal ? '，或' : '。'}</span>${personal ? '<a href="#/plan?c=club">先看協會課表 ›</a>' : ''}`);
  if (info?.src?.startsWith('推估') && (personal || !posts.length)) notices.push(personal ? '個人週期照協會課表範本排課；W9 以後是依 2025 同期推估。' : '教練還沒公告這週課表，先參考去年同期。');
  if (weekday && week === 20) notices.push('你的比賽不在週末，賽事週的課請跟教練確認');
  const NOTE = { club: `週四團練${venue ? `・<span translate="no">${esc(venue)}</span>` : ''}`, self: '自己練：團體熱身改 10 分鐘自主熱身', opt: '天數不夠時先省略',
    rd: '<a class="notelink" href="#/plan/race">比賽日計劃 ›</a>' };
  const hdrBtns = [canPublishPlan() && c.kind === 'club' ? '<a class="btn ghost sm" href="#/plan/new">發布這週課表</a>' : '',
    // 全部展開：畫面一出來就在（閒下來才綁定），避免之後才冒出來把下面每一列往下推
    coach && days?.some((d) => d.kind !== 'rest') ? `<button class="btn ghost sm" id="xall" aria-pressed="${coachPrefs().ui.explain === true}">全部展開</button>` : ''].filter(Boolean);
  const pace = `${me.dist === 'hm' ? 'HMP' : 'MP'} ${P.fmtPace(P.goalPace(me.dist, me.grp))}/km`;
  const postCards = posts.map((po) => `<section class="card">
      <div class="row spread"><h3><span translate="no">${esc(po.title)}</span></h3>${po.team_id ? teamTag(teamOf(po.team_id)) : '<span class="pill">教練發布</span>'}</div>
      <p class="tiny"><span translate="no">${esc(po.author || '')}</span>・${ago(po.created_at)}</p>
      <pre class="out">${esc(po.body)}</pre>
      ${allow('plan') || (po.team_id && teamAllow(po.team_id, 'appoint')) ? `<button class="btn danger sm" data-delplan="${po.id}">刪除</button>` : ''}
    </section>`).join('');
  view.innerHTML = `
    ${largeTitle('課表', `${me.dist === 'hm' ? '半馬' : '全馬'} ${me.grp} 組・${pace}${personal ? '・個人週期' : ''}`,
      feat('plan_export') ? `<button type="button" class="ltshare" id="planShare" aria-label="分享與匯出">${MI.share}</button>` : '')}
    ${planSeg('/plan')}
    ${coach ? `<nav class="wkline" aria-label="選擇週次">${all.slice(0, 21).map((x, i) => {
      const k = i + 1, d = P.weekStart(k, c);
      return `<a class="wk" href="#/plan/${k}${cq}" data-ph="${P.PHASES[x.phase] || 'base'}"${k === week ? ' aria-current="page"' : ''}><i aria-hidden="true"></i><b>${k === 21 ? 'R' : `W${k}`}</b><span class="num">${md(d)}</span>${k === wi ? '<em>本週</em>' : ''}</a>`;
    }).join('')}</nav>` : ''}
    <section class="card">
      <div class="row spread">
        <div>
          <h2>${week === 21 ? '賽後恢復' : `W${week}`}${isNow ? ' <span class="pill">本週</span>' : ''}</h2>
          <p class="muted" style="margin:2px 0 0">${info?.phase || ''}${info?.recovery && week !== 21 ? '・恢復週' : ''}　${md(s)}–${md(e)}</p>
          ${personal ? `<p class="tiny" style="margin:2px 0 0">跟著 <span translate="no">${esc(c.name)}</span>・比賽日 ${dstr(c.anchor)}</p>` : ''}
        </div>
        <div class="row" style="gap:6px">
          <button class="btn ghost sm" id="prev" ${week === 1 ? 'disabled' : ''} aria-label="上一週">‹</button>
          <button class="btn ghost sm" id="next" ${week === 21 ? 'disabled' : ''} aria-label="下一週">›</button>
        </div>
      </div>
      ${notices.map((x) => `<p class="notice" style="margin:0">${x}</p>`).join('')}
      ${hdrBtns.length ? `<div class="row" style="gap:8px">${hdrBtns.join('')}</div>` : ''}
    </section>
    ${stage ? `<section class="card stagecard ${stage}">
      ${stage === 'prep' ? `<h3>${MI.flag}賽前 ${P.dayDiff(P.parseISO(stageISO), P.parseISO(today))} 天</h3><p class="tiny" style="margin:0"><span translate="no">${esc(stageName)}</span>・${dstr(stageISO)}</p>
        <ul class="tl-list"><li>前一晚：準備號碼布、晶片、衣物、能量膠、別針，設好兩個鬧鐘</li><li>${me.dist === 'hm' ? '前 24–36 小時：輕度超補' : '前 36–48 小時：肝醣超補'}</li></ul>
        <a class="tiny" href="#/plan/race">比賽日計劃 ›</a>`
      : stage === 'race' ? `<h3>${MI.flag}今天比賽，加油</h3><p style="margin:0"><b><span translate="no">${esc(stageName)}</span></b></p>
        <ol class="tl-list" id="stageTl" hidden></ol><a class="tiny" href="#/plan/race">完整比賽日計劃 ›</a>`
      : `<h3>${MI.flag}辛苦了</h3><p class="muted" style="margin:0">賽後一週以恢復為主，照課表的恢復週慢慢跑。</p><div class="row" style="gap:16px"><a class="tiny" href="#/plan/season">全季回顧 ›</a><a class="tiny" href="${feat('plan_cycle') ? '#/plan/setup?go=cycle' : '#/me/races'}">設定下一場 ›</a></div>`}
      ${weekday && stage !== 'recover' ? '<p class="notice" style="margin:0">你的比賽不在週末，賽事週的課請跟教練確認</p>' : ''}
    </section>` : ''}
    ${coach && !other && legacyDue() ? `<section class="setgroup legacynote"><div class="card setcard">${row('#/plan/setup?migrate=1', IC.runner, '舊版課表教練的資料可以搬進 App', '設定、完成紀錄與倒數；勾選的才會搬')}</div></section>` : ''}
    ${personal && posts.length ? `<details class="card clubposts"><summary>協會 W${postWeek} 公告（你的課表照個人週期排，內容可能不同）</summary>${postCards}</details>` : postCards}
    ${days && started && !other ? `<section class="card logsum">
      <div class="lsumtop">
        <div class="ring" style="--p:${wc.pct}" role="img" aria-label="本週完成 ${wc.pct}%"><b class="num">${wc.pct}<small>%</small></b></div>
        <div class="lsum"><span class="tiny">本週訓練</span>
          <div class="lstats"><span><b class="num">${wc.full}</b>/${wc.req} 堂</span>${wc.extra ? `<span>+${wc.extra} 加練</span>` : ''}<span><b class="num">${km.toFixed(1)}</b> km</span>${avgRpe ? `<span>RPE <b class="num">${avgRpe.toFixed(1)}</b></span>` : ''}</div>
          ${allow('plan') || teams().some((t) => teamAllow(t.id, 'roster')) ? '<a class="tiny" href="#/logs/team">看團員的訓練 ›</a>' : ''}</div>
      </div>
      <div class="lsumact">${feat('gps') ? `<a class="btn iconbtn" href="#/run">${IC.runner}開始跑步</a>` : ''}<a class="btn ghost iconbtn" href="#/log?extra=1">${IC.plus}自主加練</a><a class="btn ghost" href="#/report">報表</a></div>
      <p class="tiny" style="margin:0">${me.share_logs ? '教練與分團幹部看得到你的完成率與里程，看不到備註。' : '紀錄只有你看得到；想讓教練看到，到「我的 → 隱私」打開分享。'}</p>
    </section>` : ''}
    <div class="days${other ? '' : ' ticks'}">${days ? days.map((d, i) => {
      const L = logOf(d), top = L.find((l) => l.status === 'done') || L.find((l) => l.status === 'partial') || L[0];
      const race = P.isRaceDay(d, week), tdate = P.tickDate(week, d, c, today);
      const canLog = !other && d.kind !== 'rest' && !!tdate;
      const st = top?.status;
      const text = race && personal ? `比賽日：<span translate="no">${esc(c.name)}</span>` : esc(fixText(d.t));
      const hint = race && personal ? '' : P.paceHint(d.t, me.dist, me.grp);
      const notes = coach ? d.noteKeys.filter((k) => NOTE[k]).map((k) => `<span class="note">${NOTE[k]}</span>`).join('') : '';
      const tick = other ? '' : d.kind === 'rest' ? '<span class="tick none" aria-hidden="true"></span>'
        // 還沒記錄是勾選框（點了記「完成」）；已經有紀錄點了是打開那筆修改，就當一般按鈕念出狀態
        : `<button type="button" class="tick${st ? ` ${st}` : ''}" ${top ? `aria-label="修改紀錄（${LOG_STATUS_NAME[st]}）：` : 'role="checkbox" aria-checked="false" aria-label="標記完成：'}${esc(dayLabel(d.d))} ${race && personal ? '比賽日' : esc(fixText(d.t))}" data-tick="${i}" ${(!top && !canLog) || top?.pending ? 'disabled' : ''}>${st ? LOG_ICON[st] : ''}</button>`;
      return `<div class="day ${d.kind}${d.opt ? ' opt' : ''}${top ? ` logged ${st}` : ''}" data-i="${i}">
        ${tick}
        <span class="dl"><span>${esc(dayLabel(d.d))}</span><span class="k">${P.KIND_LABEL[d.kind]}</span>${d.opt ? '<span class="pill opt">可省略</span>' : ''}</span>
        <div class="t"><span class="tx">${text}</span> <span class="hint">${hint}</span>
          ${notes}
          ${top ? `<span class="logline">${top.pending ? '待上傳・' : ''}${LOG_STATUS_NAME[st]}${top.km ? `・${top.km} km` : ''}${top.seconds ? `・${S.fmtDuration(top.seconds)}` : ''}${top.rpe ? `・RPE ${top.rpe}` : ''}${L.some((l) => l.unread) ? '<span class="pill solid" style="margin-left:6px">教練回饋</span>' : L.some((l) => l.comments) ? '・有回饋' : ''}</span>` : ''}
          ${coach && d.kind !== 'rest' ? `<details class="xd" data-xd="${i}"><summary>詳細內容</summary><div class="xdb"></div></details>` : ''}
        </div>
        ${top?.pending ? `<span class="logbtn done" role="img" aria-label="待上傳">${LOG_ICON.done}</span>`
          : top ? `<a class="logbtn ${st}" href="#/log?id=${top.id}" aria-label="修改紀錄">${LOG_ICON[st]}</a>`
          : canLog ? `<a class="logbtn" href="#/log?w=${week}&i=${i}${personal ? '&c=r' : ''}" aria-label="記錄${esc(d.d)}">記錄</a>` : ''}
      </div>`; }).join('') : `<div class="card"><p class="muted">${info?.missing ? `W${week} 課表還沒公告` : '這週沒有課表資料。'}</p></div>`}</div>
    ${coach && days && !other ? '<div class="warnslot" hidden></div>' : ''}
    ${extras.length || others.length ? `<section class="card"><h3>${others.length ? '自主加練與其他週期的紀錄' : '自主加練'}</h3><div class="roster">${[...others, ...extras].map((l) => `<a class="r" ${l.id ? `href="#/log?id=${l.id}"` : ''}><span class="av">${l.status === 'extra' || !l.plan_day ? '＋' : LOG_ICON[l.status] || '＋'}</span>
      <span>${esc(dstr(l.date))}${l.plan_day && l.status !== 'extra' ? `・${esc(P.logWeekLabel(l))} ${esc(dayLabel(l.plan_day))}` : ''}${l.km ? `・${l.km} km` : ''}${l.seconds ? `・${S.fmtDuration(l.seconds)}` : ''}${l.pending ? '・待上傳' : ''}<span class="tiny" style="display:block"><span translate="no">${esc(l.note || '')}</span></span></span><span class="tiny">›</span></a>`).join('')}</div>
      ${others.length ? '<p class="tiny" style="margin:0">其他週期的紀錄只算里程，不算這週的完成率。</p>' : ''}</section>` : ''}
    <section class="setgroup"><h3 class="sgt">工具</h3><div class="card setcard">
      ${coach ? `${row('#/plan/season', MI.plan, '全季課表', '20 週一覽、每週完成率')}${row('#/plan/race', MI.flag, '賽事準備', '比賽日計劃、補給、心率、年齡分級')}
        ${row('#/plan/guide', MI.help, '配速與用語', '你的配速、課表用語、各階段')}${row('#/plan/setup', IC.sliders, '課表設定', '組別、課表週期、每週天數、身體資料')}
        <a class="setrow" href="/coach"><span class="sic">${IC.runner}</span><span class="st"><b>舊版課表教練</b><span class="tiny">舊版的完成紀錄與倒數，可以到課表設定搬進 App</span></span><span class="chev" aria-hidden="true"></span></a>` : ''}
      <a class="setrow" href="#/report"><span class="sic">${MI.report}</span><span class="st"><b>訓練報表</b><span class="tiny">週里程、完成率、個人最佳</span></span><span class="chev" aria-hidden="true"></span></a>
      <a class="setrow" href="#/challenge"><span class="sic">${MI.flag}</span><span class="st"><b>每月里程挑戰</b><span class="tiny">徽章、分團對抗、排行榜</span></span><span class="chev" aria-hidden="true"></span></a>
    </div><p class="tiny center">課表來源：耕跑團記事本・實際以教練每週公告為準</p></section>`;
  for (const b of document.querySelectorAll('[data-delplan]')) b.onclick = async () => {
    if (!confirm('確定刪除這則課表？')) return;
    await api(`/plans/${b.dataset.delplan}`, { method: 'DELETE' }); toast('已刪除'); render();
  };
  $('#planShare')?.addEventListener('click', (e) => coachShare({ week, cycle: c, from: e.currentTarget }));
  $('#prev').onclick = () => { location.hash = `#/plan/${week - 1}${cq}`; };
  $('#next').onclick = () => { location.hash = `#/plan/${week + 1}${cq}`; };
  // 快速打勾：還沒記錄就記「完成」；已經有紀錄就打開那筆修改
  for (const b of view.querySelectorAll('[data-tick]')) b.onclick = () => {
    const d = days[Number(b.dataset.tick)], L = logOf(d), top = L.find((l) => l.status === 'done') || L.find((l) => l.status === 'partial') || L[0];
    if (top?.id) { location.hash = `#/log?id=${top.id}`; return; }
    if (top) return;
    const date = P.tickDate(week, d, c, today);
    if (date) quickTick(b, c, week, d, date);
  };
  // 週次列：選到的那一週捲到中間
  const wl = view.querySelector('.wkline'), cur = wl?.querySelector('[aria-current]');
  if (cur) wl.scrollLeft += cur.getBoundingClientRect().left - wl.getBoundingClientRect().left - (wl.clientWidth - cur.offsetWidth) / 2;
  // 比賽當天：有設定起跑時間就列出接下來三件事（閒下來才載入計算模組）
  if (stage === 'race') whenIdle(async () => {
    const st = coachPrefs().start[startKey({ date: stageISO, name: stageName })];
    if (!st || !$('#stageTl')) return;
    const { createCoach } = await import('./coachcalc.js');
    const tl = createCoach({ dist: me.dist, grp: me.grp, start: st, cycle: { kind: 'race', anchor: stageISO, name: stageName } }).raceDayPlan().timeline;
    const now = new Date(), hm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, el = $('#stageTl');
    const next = tl.filter(([t]) => t >= hm).slice(0, 3);
    if (!el || !next.length) return;
    el.innerHTML = next.map(([t, a]) => `<li><b class="num">${esc(t)}</b> ${esc(a)}</li>`).join('');
    el.hidden = false;
  });
  // 用語說明、詳細內容、提醒、滑動換週：畫面畫好、閒下來才載入（第一次畫面只需要 plan.js）
  if (coach && days) {
    const mark = {}; view.planMark = mark;
    whenIdle(async () => {
      const fresh = () => view.planMark === mark;
      if (!fresh()) return;   // 已經換頁或重畫
      try {
        const done = await coachWeekExtras(view, { week, cycle: c, other, rows: days, venue, hl: q.get('hl'), wi, alive: fresh });
        // 載入期間換了頁：這次的監聽馬上拿掉，不蓋掉新頁面的清理
        if (fresh()) viewCleanup = done; else done?.();
      } catch {}
    });
  }
}

// ---------- 訓練紀錄 ----------
const LOG_STATUS_NAME = { done: '完成', partial: '部分完成', skip: '沒練', extra: '自主加練' };
const LOG_ICON = { done: IC.check, partial: IC.half, skip: IC.minus, extra: IC.plus };
const FEEL = ['', '很累', '有點累', '普通', '不錯', '很好'];
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// 課表上的「週二」「週五或週六」「週末」→ 那一週實際的日期：P.dayDates（比賽那一列只在比賽日）
async function logView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  let log = null, day = null, week = Number(q.get('w')) || null;
  // 這筆紀錄屬於哪個課表週期：修改時看紀錄本身；從課表某一列進來時 c=r 表示個人週期（沒有就是協會賽季）
  let lc = q.get('c') === 'r' ? myCycle() : P.CLUB;
  if (q.get('id')) {
    // 修改：從最近 120 天找這筆
    const { logs } = await api(`/logs?from=${ymd(new Date(Date.now() - 119 * 864e5))}&to=${ymd(new Date())}`);
    log = logs.find((l) => l.id === q.get('id'));
    if (!log) { view.innerHTML = `<div class="card">${emptyState('runner', '找不到這筆紀錄（只能修改 120 天內的紀錄）')}<a class="btn ghost sm" href="#/plan" style="justify-self:center">回課表</a></div>`; return; }
    lc = log.cycle_anchor ? (log.cycle_anchor === myCycle().anchor ? myCycle() : P.cycleOf(log.cycle_anchor)) : P.CLUB;
    week = log.cycle_anchor ? log.cycle_week : log.week_no;
  } else if (week) {
    day = (await P.weekPlan(week, me.dist, me.grp))?.[Number(q.get('i'))] || null;
  }
  // 從拍照分享、跑步記錄或捷徑帶進來的數據
  const num = (k, max) => { const v = parseFloat(String(q.get(k) || '').replace(',', '.')); return v > 0 && v < max ? v : null; };
  const incoming = q.get('km') ? { km: num('km', 400), seconds: num('sec', 200000) || (num('min', 3000) ? Math.round(num('min', 3000) * 60) : null), hr: num('hr', 230),
    date: /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : null, source: ['health', 'gps'].includes(q.get('src')) ? q.get('src') : 'manual' } : null;
  const today = ymd(new Date());
  // 從「跑完了嗎？」通知進來：帶入那場團練的日期與名稱
  const fromEv = q.get('event') ? await api(`/events/${q.get('event')}`).catch(() => null) : null;
  let date = log?.date || incoming?.date || (fromEv?.date <= today ? fromEv.date : null) || (day ? P.dayDates(week, day.d, lc, day).reduce((a, d) => (d <= today ? d : a), P.dayDates(week, day.d, lc, day)[0]) : today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) date = today;
  // 沒有指定課表日：用日期去找我的課表週期那週同一天的課（從拍照分享、跑步記錄或團練通知進來時自動對上）
  if (!log && !day && !q.get('extra')) {
    const c = myCycle();
    if (P.inCycle(date, c)) {
      const w = P.weekIndexOf(date, c), plan = await P.weekPlan(w, me.dist, me.grp);
      const hit = plan?.find((d) => d.kind !== 'rest' && P.dayDates(w, d.d, c, d).includes(date));
      if (hit) { day = hit; week = w; lc = c; }
    }
  }
  const personal = lc.kind !== 'club';
  // 個人週期的會員從團練通知進來：也顯示協會這天的團練內容，方便誠實記「部分完成」
  const evDay = fromEv?.week_no && personal ? (await P.weekPlan(fromEv.week_no, me.dist, me.grp))?.find((d) => new RegExp(dayPattern(fromEv.date)).test(d.d)) : null;
  const extra = !log && !day;
  const v = { status: extra ? 'extra' : 'done', km: '', seconds: null, hr: '', rpe: 5, feel: 3, note: '', ...log, ...(incoming || {}) };
  // 個人週期的比賽那一列只記「比賽日」（教練看得到課表內容，看不到你的比賽名稱）
  const planText = log?.plan_text || (day && personal && P.isRaceDay(day, week) ? '比賽日' : day?.t) || '';
  const label = log?.plan_day || day?.d || '';
  const statuses = extra || v.status === 'extra' ? ['extra'] : ['done', 'partial', 'skip'];
  view.innerHTML = `
    ${largeTitle(log ? '修改紀錄' : extra ? '自主加練' : '記錄訓練', [fromEv ? `<span translate="no">${esc(fromEv.title)}</span>` : '', week && label ? `${personal ? '個人 W' : 'W'}${week}・${esc(dayLabel(label))}` : ''].filter(Boolean).join('・'))}
    ${planText ? `<section class="card plancard ${log?.kind || day?.kind || ''}"><span class="tiny">當天課表</span><p style="margin:0;font-weight:600">${esc(fixText(planText))}</p>
      <span class="hint">${P.paceHint(planText, me.dist, me.grp)}</span>
      ${evDay ? `<span class="tiny">團練內容：${esc(fixText(evDay.t))}</span>` : ''}</section>` : ''}
    ${incoming ? `<div class="notice">已帶入${incoming.source === 'health' ? ' Apple 健康' : incoming.source === 'gps' ? '這次 GPS 跑步' : ''}的數據，確認後按儲存。</div>` : ''}
    <section class="card">
      <form id="lf" class="logform">
        ${statuses.length > 1 ? `<div class="chips status">${statuses.map((k) => `<label class="chip"><input type="radio" name="status" value="${k}" ${v.status === k ? 'checked' : ''}><span>${LOG_ICON[k]} ${LOG_STATUS_NAME[k]}</span></label>`).join('')}</div>`
          : '<input type="hidden" name="status" value="extra">'}
        <label>日期<input type="date" name="date" value="${esc(date)}" max="${today}" required></label>
        <div class="grid2" data-run>
          <label>距離（km）<input name="km" inputmode="decimal" value="${v.km ?? ''}" placeholder="10.0"></label>
          <label>時間（時:分:秒）<input name="time" inputmode="numeric" value="${v.seconds ? S.fmtDuration(v.seconds) : ''}" placeholder="0:55:00"></label>
        </div>
        <p class="tiny pace" data-run id="paceOut"></p>
        <div class="grid2" data-run>
          <label>平均心率（選填）<input name="hr" inputmode="numeric" value="${v.hr ?? ''}" placeholder="152"></label>
          <label>RPE 自覺強度 <b class="num" id="rpeOut">${v.rpe || 5}</b><input type="range" name="rpe" min="1" max="10" value="${v.rpe || 5}"></label>
        </div>
        <fieldset class="qset"><legend>身體感覺</legend><div class="chips feel">${[1, 2, 3, 4, 5].map((n) => `<label class="chip"><input type="radio" name="feel" value="${n}" ${Number(v.feel) === n ? 'checked' : ''}><span>${FEEL[n]}</span></label>`).join('')}</div></fieldset>
        <label>備註（只有你看得到）<input name="note" maxlength="300" value="${esc(v.note || '')}" placeholder="腳踝有點緊、風很大…"></label>
        <button class="btn block">儲存</button>
        ${log ? '<button type="button" class="btn danger block" id="delLog">刪除這筆紀錄</button>' : ''}
      </form>
      <div class="row" style="gap:8px">${feat('studio') ? `<a class="btn ghost sm" href="#/studio">從 Apple 健康或檔案匯入 ›</a>` : ''}</div>
    </section>
    ${log?.comments ? `<section class="card"><details data-cm="${log.id}" open><summary><h3 style="display:inline">教練回饋</h3></summary><div class="cmts"></div></details></section>` : ''}`;
  bindComments();
  const f = $('#lf');
  const sync = () => {
    const skip = f.status.value === 'skip' || f.querySelector('[name=status]:checked')?.value === 'skip';
    for (const el of f.querySelectorAll('[data-run]')) el.hidden = skip;
    const km = parseFloat(f.km.value), sec = S.parseHMS(f.time.value);
    $('#paceOut').textContent = km > 0 && sec > 0 ? `平均配速 ${S.fmtPace(km * 1000, sec)}` : '';
    $('#rpeOut').textContent = f.rpe.value;
  };
  f.oninput = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const st = f.querySelector('[name=status]:checked')?.value || f.status.value;
    // 週期欄位：照課表的紀錄帶協會週次（week_no）或個人週期（cycle_anchor、cycle_week）；修改時原樣送回
    const cyc = label && week ? P.cycleFields(lc, week) : { week_no: null };
    const body = { id: log?.id, date: f.date.value, status: st, ...cyc, plan_day: label || null, kind: log?.kind || day?.kind || null,
      plan_text: planText || null, km: parseFloat(f.km.value) || null, seconds: S.parseHMS(f.time.value) || null, hr: Number(f.hr.value) || null,
      rpe: Number(f.rpe.value), feel: Number(f.querySelector('[name=feel]:checked')?.value) || null, note: f.note.value,
      source: log?.source || incoming?.source || 'manual' };
    // 照課表記錄（完成、部分完成）可以不填距離與時間；自主加練才一定要填
    if (st === 'extra' && !body.km && !body.seconds) return toast('填一下距離或時間');
    try {
      await api('/logs', { method: 'POST', body });
      if (body.source === 'gps' && Run.session()?.status === 'done') Run.discard();   // 已存成紀錄，清掉手機上的這次跑步
      if (st === 'skip' || log) { toast(st === 'skip' ? '已記下，休息也是訓練的一部分' : '已更新'); location.hash = planHref(lc, week); return; }
      // 記完接著拍照分享：把剛記的距離、時間帶到拍照
      const p = new URLSearchParams({ km: String(body.km || 0), sec: String(body.seconds || 0), date: body.date, title: (fromEv?.title || planText || '今天的跑步').slice(0, 20), logged: '1' });
      view.innerHTML = `<section class="card donecard"><span class="donemark">${IC.check}</span><h2>已記錄，辛苦了</h2>
        <p class="muted" style="margin:0">${body.km ? `${body.km} 公里` : ''}${body.km && body.seconds ? '・' : ''}${body.seconds ? S.fmtDuration(body.seconds) : ''}${body.km && body.seconds ? `・配速 ${S.fmtPace(body.km * 1000, body.seconds)}` : ''}</p>
        ${feat('studio') ? `<a class="btn block iconbtn" href="#/studio?${p}">${ic('<path d="M4 8.2a2 2 0 0 1 2-2h1.9l1.5-2h5.2l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.6" r="3.6"/>')}拍照分享</a>` : ''}
        <a class="btn ghost block" href="${planHref(lc, week)}">回課表</a></section>`;
    }
    catch (err) {
      // 斷線（fetch 本身失敗）：先存在手機，連上網路後自動上傳
      if (!navigator.onLine || err instanceof TypeError) { queueLog(body); toast('目前離線，已先存在手機，連上網路會自動上傳'); location.hash = planHref(lc, week); }
      else toast(err.message);
    }
  };
  $('#delLog')?.addEventListener('click', async () => {
    if (!confirm('刪除這筆紀錄？')) return;
    await api(`/logs/${log.id}`, { method: 'DELETE' }); toast('已刪除'); location.hash = planHref(lc, week);
  });
}
// 離線時的訓練紀錄暫存區（只放在這台裝置，上傳成功就刪除）
const logQueue = {
  get() { try { return JSON.parse(localStorage.getItem('cil-log-queue') || '[]'); } catch { return []; } },
  set(v) { try { v.length ? localStorage.setItem('cil-log-queue', JSON.stringify(v)) : localStorage.removeItem('cil-log-queue'); } catch {} },
};
// 每筆有一個裝置端的 qid（之後「復原」用來從暫存區刪掉）；回傳 qid。
//   修改既有紀錄時保留 id，連上網路後是更新那一筆，不會變成新增（也不會被 if_absent 當成重複丟掉）
const queueLog = (body) => {
  const qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  logQueue.set([...logQueue.get(), { ...body, qid, queued: Date.now() }].slice(-30));
  return qid;
};
// 伺服器的紀錄裡，離線時改過、還在暫存區的那幾筆先不列（改用暫存區那筆「待上傳」的新內容，不會一天出現兩筆）
const notQueued = (list) => { const ids = new Set(logQueue.get().map((x) => x.id).filter(Boolean)); return ids.size ? list.filter((l) => !ids.has(l.id)) : list; };
// 這次開 App 期間補傳過的離線紀錄：qid → 伺服器回傳（{ id, existed }），「復原」時暫存區已經清掉就用這個刪
const flushed = new Map();
// ---------- 快速打勾：照課表記「完成」（不必填距離），6 秒內可以復原 ----------
const ticking = new Set();
// 回傳 { id, existed }，離線時先存在手機回傳 { qid }；個人週期的比賽那一列只記「比賽日」，不記比賽名稱
async function tickPlanRow(c, n, row, date) {
  const body = { date, status: 'done', plan_day: row.d, kind: row.kind || null, plan_text: c.kind !== 'club' && P.isRaceDay(row, n) ? '比賽日' : row.t,
    source: 'manual', if_absent: true, ...P.cycleFields(c, n) };
  try { return await api('/logs', { method: 'POST', body }); }
  catch (e) { if (navigator.onLine === false || e instanceof TypeError) return { qid: queueLog(body) }; throw e; }
}
// 復原：線上的刪掉剛新增的那筆（原本就有的不刪）；離線的從暫存區拿掉
async function undoTick(r) {
  if (r.qid) {
    const q = logQueue.get();
    if (q.some((x) => x.qid === r.qid)) { logQueue.set(q.filter((x) => x.qid !== r.qid)); return; }
    // 復原前剛好連上網路、已經補傳：改刪伺服器上的那一筆（原本就有的不刪）
    r = flushed.get(r.qid) || {};
  }
  if (r.id && !r.existed) await api(`/logs/${r.id}`, { method: 'DELETE' });
}
// 同一列處理中不重複送（連點兩下也只有一筆）；記好後重畫，提示可以復原
async function quickTick(btn, c, n, row, date) {
  const key = `${P.cycleKey(c, n)}|${row.d}`;
  if (ticking.has(key)) return;
  ticking.add(key);
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try {
    const r = await tickPlanRow(c, n, row, date);
    const i = btn.dataset.tick;
    await render();
    // 重畫後焦點回到同一列，鍵盤與 VoiceOver 不會跳回頁首
    const again = view.querySelector(`[data-tick="${i}"]`);
    if (again && !again.disabled) again.focus({ preventScroll: true });
    if (r.existed) { toast('這一天已經記錄過了'); return; }
    toast(r.qid ? '目前離線，已先存在手機' : '已記錄完成', { action: '復原', ms: 6000, onAction: async () => {
      try { await undoTick(r); toast('已復原'); } catch (e) { toast(e.message); }
      render();
    } });
  } catch (e) {
    toast(e.message);
    if (btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  } finally { ticking.delete(key); }
}
async function flushLogQueue() {
  if (!me) return;
  bindDeviceData(me.id);   // 暫存區是上一位登入者的就先清掉，不會傳到這個帳號
  const q = logQueue.get();
  if (!q.length) return;
  const left = [];
  let up = 0, dup = 0;
  // 原樣送出：只有快速打勾的那幾筆本來就帶 if_absent（同一週、同一天已經有紀錄就不重複新增）；
  //   修改既有紀錄帶 id 是更新；那一筆已經在別的裝置刪掉，就改成新增，不讓這次的修改不見
  for (const { queued, qid, ...b } of q) {
    try {
      let r;
      try { r = await api('/logs', { method: 'POST', body: b }); }
      catch (e) { if (b.id && !(e instanceof TypeError) && /找不到這筆紀錄/.test(e.message)) r = await api('/logs', { method: 'POST', body: { ...b, id: undefined } }); else throw e; }
      if (qid) flushed.set(qid, r);
      if (r?.existed) dup++; else up++;
    } catch (e) { if (e instanceof TypeError) left.push({ ...b, qid, queued }); }
  }
  logQueue.set(left);
  if (up) toast(`已上傳 ${up} 筆離線時的訓練紀錄`);
  else if (dup) toast('離線時打勾的那幾天已經記錄過了');
}

// ---------- report.js（用到才載入）----------
const logsTeamView = lazy('./report.js', 'logsTeamView');
const memberLogsView = lazy('./report.js', 'memberLogsView');
const reportView = lazy('./report.js', 'reportView');
function barChart(items, { unit = '', h = 150, color = 'var(--accent)', fmt = (v) => v, max: fixedMax } = {}) {
  if (!items.length) return '<p class="muted" style="margin:0">這段期間沒有紀錄</p>';
  // 柱子最寬 72（項目少時不會撐滿整張圖）
  const W = 600, pad = 24, bw = Math.min((W - pad) / items.length, 72), max = fixedMax || Math.max(1, ...items.map((x) => x.v));
  return `<svg class="chart" viewBox="0 0 ${W} ${h + 34}" role="img" aria-label="${esc(items.map((x) => `${x.l} ${fmt(x.v)}${unit}`).join('，'))}">
    ${[0.5, 1].map((k) => `<line x1="${pad}" x2="${W}" y1="${h - h * k * 0.9}" y2="${h - h * k * 0.9}" class="grid"/><text x="0" y="${h - h * k * 0.9 + 4}" class="axis">${fmt(Math.round(max * k))}</text>`).join('')}
    ${items.map((x, i) => { const bh = Math.max(x.v ? 3 : 0, (x.v / max) * h * 0.9), xx = pad + i * bw + bw * 0.18;
      return `<rect x="${xx}" y="${h - bh}" width="${bw * 0.64}" height="${bh}" rx="${Math.min(6, bw * 0.2)}" style="fill:${x.c || color}"><title>${esc(x.l)}：${fmt(x.v)}${unit}</title></rect>
        ${items.length <= 16 || i % Math.ceil(items.length / 12) === 0 ? `<text x="${xx + bw * 0.32}" y="${h + 20}" text-anchor="middle" class="axis">${esc(x.l)}</text>` : ''}`; }).join('')}
  </svg>`;
}
function bindComments() {
  for (const d of document.querySelectorAll('details[data-cm]')) {
    const load = async () => {
      const { comments } = await api(`/logs/${d.dataset.cm}/comments`);
      d.querySelector('.cmts').innerHTML = comments.map((c) => `<div class="cmt"><b>${esc(c.author_name || '教練')}</b><span><span translate="no">${esc(c.body)}</span></span><span class="tiny">${ago(c.created_at)}</span></div>`).join('');
    };
    d.ontoggle = () => d.open && load();
    const f = d.querySelector('form');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/logs/${d.dataset.cm}/comments`, { method: 'POST', body: { body: f.body.value } }); f.body.value = ''; toast('已送出回饋'); load(); }
      catch (err) { toast(err.message); }
    };
    if (d.open) load();
  }
}
// ---------- 跑步記錄：計時器＋GPS ----------
const hms = (sec) => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60; return `${h ? `${h}:` : ''}${h ? pad2(m) : m}:${pad2(x)}`; };
const paceStr = (secPerKm) => (secPerKm && secPerKm < 1800 ? `${Math.floor(secPerKm / 60)}'${pad2(Math.round(secPerKm % 60))}"` : '—');
const GPS_NAME = { waiting: '正在定位…', good: 'GPS 良好', ok: 'GPS 普通', weak: 'GPS 訊號弱', denied: '沒有定位權限', off: '只計時' };
let runTick = null;
// 路線預覽（SVG，不載地圖圖資，路線不離開手機）
function routeSvg(route) {
  if (route.length < 2) return '';
  const lats = route.map((p) => p[0]), lons = route.map((p) => p[1]);
  const mid = (Math.min(...lats) + Math.max(...lats)) / 2, kx = Math.cos(mid * Math.PI / 180);
  const minX = Math.min(...lons) * kx, maxX = Math.max(...lons) * kx, minY = Math.min(...lats), maxY = Math.max(...lats);
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6), sc = Math.min(560 / w, 260 / h);
  const P = ([la, lo]) => `${(20 + (lo * kx - minX) * sc + (560 - w * sc) / 2).toFixed(1)},${(20 + (maxY - la) * sc + (260 - h * sc) / 2).toFixed(1)}`;
  return `<svg class="routesvg" viewBox="0 0 600 300" role="img" aria-label="這次跑步的路線"><polyline points="${route.map(P).join(' ')}"/>
    <circle cx="${P(route[0]).split(',')[0]}" cy="${P(route[0]).split(',')[1]}" r="8" class="st"/><circle cx="${P(route[route.length - 1]).split(',')[0]}" cy="${P(route[route.length - 1]).split(',')[1]}" r="8" class="en"/></svg>`;
}
async function runView() {
  clearInterval(runTick);
  const x = Run.session();
  // 結束後的成績頁
  if (x?.status === 'done') {
    const r = Run.summary(x);
    const t = ymd(new Date());
    const { logs } = await api(`/logs?from=${r.date}&to=${r.date}`).catch(() => ({ logs: [] }));
    const dayKm = logs.filter((l) => l.status !== 'skip').reduce((n, l) => n + (l.km || 0), 0), daySec = logs.reduce((n, l) => n + (l.seconds || 0), 0);
    view.innerHTML = `${largeTitle('跑完了', `${r.date === t ? '今天' : dstr(r.date)} ${r.start} 開始`)}
      <section class="kpis">
        <div class="card kpi"><span class="tiny">距離</span><b class="num">${(r.distance / 1000).toFixed(2)}<small> km</small></b></div>
        <div class="card kpi"><span class="tiny">時間</span><b class="num">${hms(r.seconds)}</b></div>
        <div class="card kpi"><span class="tiny">平均配速</span><b class="num">${paceStr(r.pace)}</b></div>
        <div class="card kpi"><span class="tiny">爬升</span><b class="num">${r.gain ? `${r.gain}<small> m</small>` : '—'}</b></div>
      </section>
      ${!r.gps || r.distance < 50 ? `<section class="card"><h3>距離</h3><p class="tiny" style="margin:0">${r.gps ? 'GPS 沒有記到距離（可能在室內或訊號太弱），' : '這次沒有開 GPS，'}請填實際跑的距離，例如跑步機上的數字或操場圈數。</p>
        <form id="manDist" class="row" style="gap:8px"><input name="km" inputmode="decimal" placeholder="例如 8.0" aria-label="實際距離（公里）" style="flex:1" value="${x.manualDist ? (x.manualDist / 1000).toFixed(2) : ''}"><span>km</span><button class="btn sm">更新</button></form></section>` : ''}
      ${r.route.length > 1 ? `<section class="card"><div class="row spread"><h3>路線</h3><span class="tiny">只留在你的手機上</span></div>${routeSvg(r.route)}</section>` : ''}
      <div class="statgrid">
        ${r.splits.length ? `<section class="card"><h3>每公里分段</h3><div class="splits">${r.splits.map((sp) => `<div><span>${sp.km} km</span><b class="num">${paceStr(sp.sec)}</b></div>`).join('')}</div></section>` : ''}
        ${r.laps.length ? `<section class="card"><h3>計圈</h3><div class="splits">${r.laps.map((l) => `<div><span>第 ${l.n} 圈・${l.m} m</span><b class="num">${hms(l.sec)}${l.m >= 100 ? `<small>　${paceStr(l.sec / (l.m / 1000))}</small>` : ''}</b></div>`).join('')}</div></section>` : ''}
      </div>
      <section class="card"><div class="row spread"><h3>${r.date === t ? '今天' : dstr(r.date)}累計</h3><span class="tiny">包含這一次</span></div>
        <div class="lstats"><span><b class="num">${(dayKm + r.distance / 1000).toFixed(1)}</b> km</span><span><b class="num">${hms(daySec + r.seconds)}</b></span><span><b class="num">${logs.filter((l) => l.status !== 'skip').length + 1}</b> 次</span></div></section>
      <section class="card actions">
        <a class="btn block iconbtn" style="justify-content:center" href="#/log?${new URLSearchParams({ date: r.date, km: (r.distance / 1000).toFixed(2), sec: String(r.seconds), src: 'gps' })}">${IC.check}存到訓練紀錄</a>
        ${feat('studio') ? '<button class="btn ghost block" id="toStudio">拍照分享到 IG</button>' : ''}
        ${r.route.length > 1 ? '<button class="btn ghost block" id="dlGpx">下載 GPX 檔</button>' : ''}
        <button class="btn danger block" id="runDiscard">刪除這次記錄</button>
      </section>`;
    $('#manDist')?.addEventListener('submit', (e) => { e.preventDefault(); Run.setDistance(parseFloat(e.target.km.value) * 1000); runView(); });
    $('#toStudio')?.addEventListener('click', () => {
      studio.stats = { title: '今天的跑步', date: r.date, distance: r.distance, seconds: r.seconds, elevation: r.gain, avg_hr: null, route: r.route };
      studio.source = 'manual'; studio.template = r.route.length > 1 ? 'route' : studio.template; location.hash = '#/studio';
    });
    $('#dlGpx')?.addEventListener('click', async () => {
      const res = await S.shareFile(new Blob([Run.gpx(x)], { type: 'application/gpx+xml' }), `耕跑團-${r.date}.gpx`, '跑步軌跡');
      if (res === 'downloaded') toast('已下載 GPX');
    });
    $('#runDiscard').onclick = () => { if (confirm('刪除這次跑步記錄？還沒存成訓練紀錄的話就不見了。')) { Run.discard(); runView(); } };
    return;
  }
  // 開始前
  if (!x) {
    view.innerHTML = `${largeTitle('跑步記錄', '計時加上 GPS，跑完自動算出今天的成績')}
      <a class="card tight lit maplink" href="#/map"><div class="row spread"><span class="row" style="gap:10px"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6Z"/><path d="M9 4v14M15 6v14"/></svg><span><b>練跑地圖</b><span class="tiny" style="display:block">地點、現場回報、天氣，畫路線存 GPX、開揪跑</span></span></span><span class="tiny">›</span></div></a>
      <section class="card runstart">
        <button class="runbtn go" id="runGo" aria-label="開始跑步記錄"><span>開始</span></button>
        <p class="tiny center" style="margin:0">第一次使用會詢問定位權限。跑步時螢幕會保持亮著；如果鎖上螢幕，iPhone 會暫停定位，解鎖後再接著記錄。</p>
        <button class="btn ghost block" id="runNoGps">不用 GPS，只計時（跑步機、操場）</button>
      </section>
      <section class="card"><h3>小提醒</h3><ol class="steps">
        <li>到戶外等「GPS 良好」再開始，距離會比較準</li><li>練間歇或在操場跑，可以按「計圈」把每一趟分開記</li>
        <li>跑完按「結束」，再按「存到訓練紀錄」，系統會自動對上今天的課表</li></ol>
        <p class="tiny" style="margin:0">路線只留在你的手機上，協會只會收到你存下來的距離和時間。</p></section>`;
    const goal = await todayGoal();
    if (goal) $('.runstart').insertAdjacentHTML('afterbegin', `<span class="pill">今天的課表：${esc(goal.text)}</span>`);
    $('#runGo').onclick = () => { Run.start({ useGps: true, goal }); runView(); };
    $('#runNoGps').onclick = () => { Run.start({ useGps: false, goal }); runView(); };
    return;
  }
  // 記錄中
  view.innerHTML = `<section class="card runlive ${x.status}">
      <div class="row spread"><span class="pill gps ${x.gps}">${GPS_NAME[x.gps] || ''}${x.acc ? `・±${x.acc} m` : ''}</span><span class="tiny" id="rState">${x.status === 'paused' ? (x.auto ? '停下來了，自動暫停' : '已暫停') : '記錄中'}</span></div>
      <div class="bigtime num" id="rTime">${hms(Run.elapsed() / 1000)}</div>
      <div class="runstats">
        <div><span class="tiny">距離</span><b class="num" id="rDist">${(x.dist / 1000).toFixed(2)}</b><span class="tiny">km</span></div>
        <div><span class="tiny">目前配速</span><b class="num" id="rPace">—</b><span class="tiny">/km</span></div>
        <div><span class="tiny">平均配速</span><b class="num" id="rAvg">—</b><span class="tiny">/km</span></div>
      </div>
      <div class="runbtns">
        ${x.status === 'running'
          ? '<button class="runbtn lap" id="rLap">計圈</button><button class="runbtn pause" id="rPause">暫停</button>'
          : '<button class="runbtn go" id="rResume">繼續</button><button class="runbtn stop" id="rStop">結束</button>'}
      </div>
      ${x.goal ? `<div class="goalbar"><span class="tiny">今天的課表：${esc(x.goal.text)}</span><span class="bar big"><i id="rGoal" style="width:0%"></i></span></div>` : ''}
      <div id="rLaps" class="splits"></div>
    </section>
    <div id="askDone"></div>`;
  const paint = () => {
    const y = Run.session(); if (!y || location.hash.split('?')[0] !== '#/run') { clearInterval(runTick); return; }
    const sec = Run.elapsed() / 1000, d = y.dist;
    $('#rTime').textContent = hms(sec);
    $('#rDist').textContent = (d / 1000).toFixed(2);
    $('#rPace').textContent = paceStr(Run.currentPace());
    $('#rAvg').textContent = d > 50 ? paceStr(sec / (d / 1000)) : '—';
    const g = $('.pill.gps'); if (g) { g.className = `pill gps ${y.gps}`; g.textContent = `${GPS_NAME[y.gps] || ''}${y.acc ? `・±${y.acc} m` : ''}`; }
    $('#rLaps').innerHTML = y.laps.map((l, i) => `<div><span>第 ${i + 1} 圈</span><b class="num">${hms((l.at - (i ? y.laps[i - 1].at : 0)) / 1000)}</b></div>`).reverse().join('');
    if (y.goal && $('#rGoal')) $('#rGoal').style.width = `${Math.min(100, y.goal.km ? d / (y.goal.km * 10) : sec / (y.goal.min * 0.6))}%`;
    // 自動暫停或自動繼續時，按鈕要跟著換
    if ((y.status === 'paused') !== !!$('#rResume')) { runView(); return; }
    if ($('#rState')) $('#rState').textContent = y.status === 'paused' ? (y.auto ? '停下來了，自動暫停' : '已暫停') : '記錄中';
  };
  paint();
  runTick = setInterval(paint, 1000);
  showAsk();
  $('#rLap')?.addEventListener('click', () => { Run.lap(); navigator.vibrate?.(60); paint(); });
  $('#rPause')?.addEventListener('click', () => { Run.pause(); runView(); });
  $('#rResume')?.addEventListener('click', () => { Run.resume(); runView(); });
  $('#rStop')?.addEventListener('click', () => { Run.finish(); runView(); });
}
// 問「跑完了嗎？」：停太久或課表目標到了；畫面在背景時也用通知提醒
function askFinish(kind) {
  const y = Run.session(); if (!y) return;
  const msg = kind === 'goal' ? `今天的課表（${y.goal.text}）完成了，要結束這次記錄嗎？` : '已經停下來 3 分鐘了，跑完了嗎？';
  navigator.vibrate?.([200, 100, 200]);
  if (document.visibilityState === 'hidden' && window.Notification?.permission === 'granted')
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification('跑完了嗎？', { body: msg, tag: 'run-ask', data: { url: '/#/run' }, icon: '/icons/icon-192.png' })).catch(() => {});
  pendingAsk = { kind, msg };
  if (location.hash.split('?')[0] !== '#/run') location.hash = '#/run'; else showAsk();
}
let pendingAsk = null;
function showAsk() {
  const box = $('#askDone'); if (!box || !pendingAsk) return;
  const { kind, msg } = pendingAsk;
  box.innerHTML = `<section class="card askcard" role="alertdialog" aria-label="跑完了嗎"><b>${esc(msg)}</b>
    <div class="grid2"><button class="btn" id="askEnd">結束，看成績</button><button class="btn ghost" id="askGo">還沒，繼續</button></div></section>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#askEnd').onclick = () => { pendingAsk = null; Run.finish(); runView(); };
  $('#askGo').onclick = () => { pendingAsk = null; Run.dismissAsk(); if (Run.session()?.status === 'paused' && kind === 'finish') Run.resume(); runView(); };
}
// 每秒檢查自動暫停與提醒（在其他頁面時也會檢查）
setInterval(() => { const k = Run.check(); if (k) askFinish(k); }, 1000);
// 今天課表的目標：「11K jog」取距離、「60' easyjog」取分鐘，間歇課不設目標
async function todayGoal() {
  const t = ymd(new Date()), c = myCycle();
  if (!P.inCycle(t, c)) return null;
  const w = P.weekIndexOf(t, c);
  const day = ((await P.weekPlan(w, me.dist, me.grp)) || []).find((d) => d.kind !== 'rest' && P.dayDates(w, d.d, c, d).includes(t));
  if (!day || day.kind === 'quality') return null;
  const km = day.t.match(/(\d+(?:\.\d+)?)\s*(?:[~～-]\s*\d+(?:\.\d+)?)?\s*K(?![a-z])/i), min = day.t.match(/^(\d{2,3})\s*['’]/);
  if (km) return { km: Number(km[1]), text: `${km[1]} 公里` };
  if (min) return { min: Number(min[1]), text: `${min[1]} 分鐘` };
  return null;
}
// 在別的頁面時，畫面下方顯示「記錄中」，點了回到跑步記錄
function runBar() {
  let bar = document.getElementById('runbar');
  const onRun = location.hash.split('?')[0] === '#/run';
  if (!me || !Run.active() || onRun) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('a'); bar.id = 'runbar'; bar.className = 'runbar'; bar.href = '#/run';
    document.body.append(bar);
  }
  const y = Run.session();
  bar.innerHTML = `<i class="${y.status}"></i><span>${y.status === 'paused' ? '已暫停' : '記錄中'}</span><b class="num">${hms(Run.elapsed() / 1000)}</b><b class="num">${(y.dist / 1000).toFixed(2)} km</b>`;
}
setInterval(runBar, 1000);


// ---------- manage.js（用到才載入）----------
const formView = lazy('./manage.js', 'formView');
const statsView = lazy('./manage.js', 'statsView');
const money = (n) => `NT$${Number(n || 0).toLocaleString('zh-TW')}`;
const PAID_NAME = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
const bars = (entries, total) => {
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return `<div class="bars">${entries.map(([k, n]) => `<div class="bar-row"><span class="k">${esc(k)}</span>
    <span class="track"><i style="width:${Math.round(n / max * 100)}%"></i></span>
    <span class="n num">${n}${total ? `<span class="tiny"> ${Math.round(n / total * 100)}%</span>` : ''}</span></div>`).join('') || '<p class="muted" style="margin:0">還沒有資料</p>'}</div>`;
};
// ---------- teams.js（用到才載入）----------
const teamView = lazy('./teams.js', 'teamView');
const teamsView = lazy('./teams.js', 'teamsView');
// ---------- 我的 ----------
// ---------- 我的：像 iPhone 設定一樣分組，每一列點進去是一頁 ----------
const ME_SECTIONS = {
  profile: '個人資料', races: '我的賽事與倒數', reg: '賽事報名資料', teams: '主團與分團', notify: '通知與裝置',
  security: '帳號與安全', privacy: '隱私', assoc: '協會', card: '會籍卡',
};
const row = (href, icon, title, sub = '', badge = '') => `<a class="setrow" href="${href}"><span class="sic">${icon}</span><span class="st"><b>${title}</b>${sub ? `<span class="tiny">${sub}</span>` : ''}</span>${badge}<span class="chev" aria-hidden="true"></span></a>`;
const btnRow = (id, icon, title, sub = '') => `<button class="setrow" id="${id}"><span class="sic">${icon}</span><span class="st"><b>${title}</b>${sub ? `<span class="tiny">${sub}</span>` : ''}</span><span class="chev" aria-hidden="true"></span></button>`;
const group = (title, rows) => (rows.filter(Boolean).length ? `<section class="setgroup">${title ? `<h2 class="sgt">${title}</h2>` : ''}<div class="card setcard">${rows.filter(Boolean).join('')}</div></section>` : '');
const subTitle = (title, sub = '') => largeTitle(title, sub);
const MI = {
  person: IC.runner, report: ic('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'), flag: ic('<path d="M5.5 21V4M5.5 4.5h11l-2 3.7 2 3.8h-11"/>'),
  idcard: ic('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14.5 10h4M14.5 13.5h3"/>'),
  ticket: ic('<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M14 6v12" stroke-dasharray="2 2.5"/>'),
  team: ic('<circle cx="8" cy="9" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M2.8 19c.5-3 2.6-4.6 5.2-4.6s4.7 1.6 5.2 4.6M14 14.6c2.6-.4 5 .9 5.7 4.4"/>'),
  bell: ic('<path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/>'), phone: ic('<rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M11 18h2"/>'), cal: IC.calendar,
  shield: ic('<path d="M12 3 5 6v5.5c0 4.4 3 8 7 9.5 4-1.5 7-5.1 7-9.5V6Z"/><path d="M9 12l2 2 4-4"/>'), lock: IC.lock,
  eye: ic('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  building: ic('<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3"/>'),
  admin: IC.gear, roster: ic('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  plan: IC.calendar, help: ic('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17.2v.1"/>'),
  share: ic('<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/>'),
  out: ic('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4"/>'),
};
async function meView(section) {
  const welcome = new URLSearchParams(location.hash.split('?')[1] || '').get('welcome');
  const googleMsg = new URLSearchParams(location.hash.split('?')[1] || '').get('google');
  if (googleMsg) section = 'security';
  if (!section) return meHome(welcome);
  if (!ME_SECTIONS[section]) { location.hash = '#/me'; return; }
  return ({ profile: meProfile, races: meRaces, reg: meReg, teams: meTeams, notify: meNotify, security: meSecurity, privacy: mePrivacy, assoc: meAssoc, card: meCard })[section](googleMsg);
}
async function meHome(welcome) {
  const main = teamOf(me.main_team);
  const staff = allow('members') || allow('roles') || allow('settings') || allow('roster') || canPublishPlan();
  view.innerHTML = `
    ${largeTitle('我的')}
    ${welcome ? '<div class="notice">歡迎加入！先到「個人資料」確認項目和組別；主團會由管理員設定。</div>' : ''}
    ${mfaBanner()}
    <a class="card mecard" href="#/me/profile">
      ${avatar(me)}
      <span class="mi"><b><span translate="no">${esc(me.name)}</span></b>${me.nickname ? ` <span class="tiny"><span translate="no">${esc(me.nickname)}</span></span>` : ''}
        <span class="tiny" style="display:block">${me.title ? `<span translate="no">${esc(me.title)}</span>` : esc(me.roleName || ROLE_NAME[me.role] || '團員')}・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組</span></span>
      ${main ? `<span class="pill team" style="--tc:${esc(main.color)}">${teamIcon(main, 'xs')}<span translate="no">${esc(main.name)}</span></span>` : '<span class="pill">主團未設定</span>'}
    </a>
    ${group('我的跑步', [
      row('#/report', MI.report, '訓練報表', '週里程、完成率、個人最佳'),
      row('#/challenge', MI.flag, '每月里程挑戰', '徽章、分團對抗、排行榜'),
      row('#/me/races', MI.flag, '我的賽事與倒數', '右上角倒數哪一場'),
      row('#/me/reg', MI.idcard, '賽事報名資料', '幹部代為團體報名時使用', '<span id="regBadge"></span>'),
      row('#/tickets', MI.ticket, '入場券、團購領取與中獎紀錄'),
    ])}
    ${group('分團', [row('#/me/teams', MI.team, '主團與分團', main ? `主團：<span translate="no">${esc(main.name)}</span>` : '主團由管理員設定')])}
    ${group('設定', [
      row('#/me/notify', MI.bell, '通知與裝置', '推播、加到主畫面、行事曆、分頁列、語言 Language'),
      row('#/me/security', MI.shield, '帳號與安全', `${me.google ? 'Google 已綁定' : '綁定 Google'}、通行金鑰、登出`),
      row('#/me/privacy', MI.eye, '隱私', '分享給教練、排行榜、下載或刪除資料'),
    ])}
    ${group('協會', [row('#/me/assoc', MI.building, esc(org().name || '台灣耕跑團協會'), `${esc(me.membershipName || '跑友')}・入會、章程與文件`),
      me.membership === 'active' ? row('#/me/card', MI.idcard, '會籍卡', me.paid_until ? `會費繳至 ${esc(me.paid_until)}` : '出示給幹部掃描') : ''])}
    ${staff ? group('幹部專區', [
      (allow('members') || allow('roles') || allow('settings')) ? row('#/admin', MI.admin, '管理後台', '總覽、會員、權限、分團、系統設定') : '',
      allow('roster') ? row('#/roster', MI.roster, '團員名冊') : '',
      canPublishPlan() ? row('#/plan/new', MI.plan, '發布課表', allow('plan') ? '教練' : '分團團長') : '',
    ]) : ''}
    ${group('', [btnRow('shareApp', MI.share, '分享耕跑團 App', '用 LINE、QR Code 邀朋友一起跑'), btnRow('openGuide', MI.help, '使用說明', '一分鐘帶你看過每個功能')])}`;
  bindStepup();
  $('#openGuide').onclick = () => Guide.start();
  $('#shareApp').onclick = () => shareApp();
  // 賽事報名資料填好了沒：畫面先出來，狀態晚一點補上（要解密，不要擋住整頁）
  api('/me/race-profile').then((r) => { const b = $('#regBadge'); if (b) b.outerHTML = r?.complete ? '<span class="pill solid">已填好</span>' : r?.profile ? '<span class="pill wait">未填完</span>' : ''; }).catch(() => {});
}
function meProfile() {
  view.innerHTML = `${subTitle('個人資料', '報名時會直接帶入，不用每次重填')}
    <section class="card">
      <div class="row">${avatar(me)}<div style="flex:1"><b><span translate="no">${esc(me.name)}</span></b><div class="tiny">${me.title ? `<span translate="no">${esc(me.title)}</span>` : esc(me.roleName || ROLE_NAME[me.role] || '團員')}</div></div></div>
      <form id="mf">
        <div class="grid2"><label>姓名<input name="name" value="${esc(me.name)}" maxlength="20"></label>
          <label>暱稱<input name="nickname" value="${esc(me.nickname || '')}" maxlength="20" placeholder="團裡怎麼叫你"></label></div>
        <div class="grid2"><label>項目<select name="dist"><option value="fm" ${me.dist === 'fm' ? 'selected' : ''}>全馬</option><option value="hm" ${me.dist === 'hm' ? 'selected' : ''}>半馬</option></select></label>
          <label>組別<select name="grp"></select></label></div>
        ${feat('coach') ? '<a class="tiny" href="#/plan/setup?go=pb">不知道選哪組？用成績推算 ›</a>' : ''}
        <div class="field"><span class="flabel">所屬跑團</span><span class="fvalue"><span translate="no">${esc(teamOf(me.main_team)?.name || '等待管理員設定')}</span></span><span class="tiny">跟著主團，由管理員設定</span></div>
        <div class="grid2"><label>餐點偏好<select name="meal_pref"><option value="" ${!me.meal_pref ? 'selected' : ''}>未指定</option>
            <option ${me.meal_pref === '葷食' ? 'selected' : ''}>葷食</option><option ${me.meal_pref === '素食' ? 'selected' : ''}>素食</option></select></label>
          <label>電話（選填）<input name="phone" value="${esc(me.phone || '')}" maxlength="20" inputmode="tel" placeholder="餐會聯絡用"></label></div>
        <label>常跑地點（首頁顯示這裡的天氣）<select name="home_spot"><option value="">（不指定）</option></select></label>
        <button class="btn block">儲存</button>
      </form>
    </section>
    ${feat('plan_cycle') || cfg.planCycle?.suspended ? group('', [row('#/plan/setup?go=cycle', MI.cal, myCycle().kind === 'race' ? `課表週期：<span translate="no">${esc(myCycle().name)}</span>` : '課表週期：協會賽季',
      cfg.planCycle?.suspended ? '個人週期目前暫停，課表先照協會賽季' : '跟協會賽季，或跟自己的一場比賽排 20 週')]) : ''}`;
  const f = $('#mf');
  const sync = () => {
    f.grp.innerHTML = Object.entries(P.groups(f.dist.value)).map(([g, v]) => `<option value="${g}">${g} 組・${v[0]}</option>`).join('');
    f.grp.value = Object.keys(P.groups(f.dist.value)).includes(me.grp) ? me.grp : (f.dist.value === 'hm' ? 'C' : 'D');
  };
  f.dist.onchange = sync; sync();
  api('/spots').then(({ spots }) => { f.home_spot.innerHTML += spots.filter((x) => x.status === 'approved').map((x) => `<option value="${esc(x.id)}" ${me.home_spot === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join(''); }).catch(() => {});
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { me = (await api('/me', { method: 'PUT', body: { name: f.name.value, dist: f.dist.value, grp: f.grp.value, nickname: f.nickname.value, meal_pref: f.meal_pref.value, phone: f.phone.value, home_spot: f.home_spot.value || null } })).member;
      refreshMe().catch(() => {}); toast('已儲存'); }
    catch (err) { toast(err.message); }
  };
}
async function meRaces() {
  view.innerHTML = `${subTitle('我的賽事與倒數', '右上角倒數主要賽事；點右上角倒數也能直接換')}
    <section class="card"><div id="raceList" class="roster"></div></section>
    <section class="card"><h3>加一場比賽</h3>
      <form id="raceForm">
        <div class="grid2"><label>賽事名稱<input name="name" maxlength="30" placeholder="2026 臺北馬拉松" required></label><label>日期<input type="date" name="date" required></label></div>
        <div class="grid2"><label>距離<select name="dist"><option>全馬</option><option>半馬</option><option>10K</option><option>5K</option><option>超馬</option><option>其他</option></select></label>
          <label>目標成績<input name="goal" maxlength="10" placeholder="3:39:59"></label></div>
        <button class="btn block">加入賽事</button>
      </form></section>
    <button class="btn ghost block" id="pickCd">從常用賽事挑，或改成協會預設／不顯示</button>`;
  const refreshCfg = async () => { const r = await api('/me'); me = r.member; cfg = r; paintCountdown(); };
  const load = async () => {
    const { races } = await api('/races');
    if (!$('#raceList')) return;
    $('#raceList').innerHTML = races.map((r) => {
      const d = Math.round((new Date(`${r.date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
      return `<div class="r"><span class="av num" style="font-size:11px">${d >= 0 ? d : IC.check}</span>
        <span><b><span translate="no">${esc(r.name)}</span></b>${r.is_primary ? ' <span class="pill solid">倒數中</span>' : ''}
          <span class="tiny" style="display:block">${esc(r.date)}・${esc(r.dist || '')}${r.goal ? `・目標 ${esc(r.goal)}` : ''}${d >= 0 ? `・還有 ${d} 天` : '・已完賽'}</span></span>
        <span class="row" style="gap:6px">${r.is_primary ? '' : `<button class="btn ghost sm" data-prim="${r.id}">倒數這場</button>`}<button class="btn danger sm" data-delrace="${r.id}" aria-label="刪除">刪除</button></span></div>`;
    }).join('') || '<p class="tiny" style="margin:0">還沒有賽事，加一場吧。</p>';
    for (const b of document.querySelectorAll('[data-prim]')) b.onclick = async () => { await api(`/races/${b.dataset.prim}/primary`, { method: 'POST' }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); await load(); await refreshCfg(); toast('右上角改成倒數這場'); };
    for (const b of document.querySelectorAll('[data-delrace]')) b.onclick = async () => {
      // 這場是課表週期：先說清楚刪掉後課表會改回協會賽季
      if (myCycle().kind === 'race' && myCycle().raceId === b.dataset.delrace) {
        if (await choose('刪除這場賽事？', '這場是你的課表週期。刪掉後課表改回協會賽季，以前的紀錄不會改。', [{ value: 'del', label: '刪除', danger: true }]) !== 'del') return;
      } else if (!confirm('刪除這場賽事？')) return;
      try {
        const r = await api(`/races/${b.dataset.delrace}`, { method: 'DELETE' });
        await load(); await refreshCfg();
        if (r?.cycleReset) toast('已刪除，課表改回協會賽季');
      } catch (err) { toast(err.message); }
    };
  };
  load();
  $('#raceForm').onsubmit = async (e) => { e.preventDefault(); const f = e.target;
    try { await api('/races', { method: 'POST', body: { name: f.name.value, date: f.date.value, dist: f.dist.value, goal: f.goal.value } }); f.reset(); await load(); await refreshCfg(); toast('已加入賽事'); } catch (err) { toast(err.message); } };
  $('#pickCd').onclick = () => countdownPicker();
}
// 賽事報名資料：加密保存，只有自己看得到；報名「代為團體報名」的活動並同意後，那場的主辦幹部才能下載
async function meReg() {
  const d = await api('/me/race-profile');
  const p = d.profile || {}, F = d.fields;
  const lt = (k, label) => `<span class="lt">${label || F[k].label}${F[k].req ? '<span class="req">必填</span>' : ''}</span>`;
  const input = (k, type = 'text', extra = '', label = '') => `<label>${lt(k, label)}<input name="${k}" type="${type}" maxlength="${F[k].max}" value="${esc(p[k] || '')}" ${extra}></label>`;
  const select = (k, opts) => `<label>${lt(k)}<select name="${k}"><option value="">請選擇</option>${opts.map((g) => `<option ${p[k] === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>`;
  view.innerHTML = `${subTitle('賽事報名資料', '填一次，之後幹部代為團體報名都用這份')}
    <section class="card notice-card"><b>${IC.lock} 這份資料怎麼保護</b>
      <ul class="steps"><li>加密後才存進資料庫，只有你自己看得到完整內容</li>
        <li>只有在你報名「由幹部代為團體報名」的活動、並勾選同意時，那一場的主辦幹部才能下載</li>
        <li>每次下載都會留下稽核紀錄；你可以隨時修改或刪除</li>
        <li>通訊地址會送到中華郵政的郵遞區號服務核對，補上 6 碼郵遞區號（只送地址，不含姓名）</li></ul></section>
    <form id="regForm" class="card regform">
      <div class="grid2">${input('name_zh')}${input('name_en', 'text', 'autocapitalize="characters" placeholder="WANG DA-MING"')}</div>
      <p class="tiny" style="margin:0">身分證字號與護照號碼至少填一個；外籍跑友填居留證號或護照號碼。</p>
      <label><span class="lt">${F.id_no.label}</span><span class="idwrap"><input name="id_no" maxlength="${F.id_no.max}" value="${esc(p.id_no || '')}" autocomplete="off" autocapitalize="characters" spellcheck="false" type="password" placeholder="A123456789"><button type="button" class="btn ghost sm" id="idShow" aria-label="顯示身分證字號">顯示</button></span></label>
      <label><span class="lt">${F.passport_no.label}</span><input name="passport_no" maxlength="${F.passport_no.max}" value="${esc(p.passport_no || '')}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="臺灣護照 9 碼數字"></label>
      <div class="grid2">${input('birthday', 'date')}${select('gender', ['男', '女', '其他'])}</div>
      <div class="grid2">${input('phone', 'tel', 'inputmode="tel" autocomplete="tel"')}${select('shirt', ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'])}</div>
      ${input('email', 'email', 'autocomplete="email"')}
      ${addrField('address', '通訊地址', '選填・送郵局核對')}
      <fieldset class="group"><legend>緊急聯絡人</legend>
        <div class="grid2">${input('emergency_name', 'text', '', '姓名')}${input('emergency_phone', 'tel', 'inputmode="tel"', '電話')}</div>
        ${input('emergency_rel', 'text', 'placeholder="配偶、父母…"', '關係')}</fieldset>
      ${input('note', 'text', 'placeholder="外籍、身障組、其他需求"')}
      <button class="btn block">儲存</button>
      ${d.profile ? '<button type="button" class="btn danger block" id="regDel">刪除我的賽事報名資料</button>' : ''}
      ${d.updated_at ? `<p class="tiny center" style="margin:0">上次更新：${ago(d.updated_at)}</p>` : ''}
    </form>`;
  bindAddrField($('#regForm'), 'address', p.address, p.address_zip);
  $('#idShow').onclick = () => { const i = $('#regForm').id_no; i.type = i.type === 'password' ? 'text' : 'password'; $('#idShow').textContent = i.type === 'password' ? '顯示' : '隱藏'; };
  $('#regForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).trim()]));
    if (!body.id_no && !body.passport_no) return toast('身分證字號或護照號碼至少填一個');
    try {
      const r = await api('/me/race-profile', { method: 'PUT', body });
      let back = null; try { back = JSON.parse(sessionStorage.getItem('cil-after-reg') || 'null'); } catch {}
      if (r.complete && back?.ev) { toast('已儲存，回到報名'); location.hash = `#/e/${back.ev}`; return; }
      toast(r.complete ? '已儲存，可以報名代為團體報名的活動了' : '已儲存，還有必填欄位沒填'); meReg();
    } catch (err) { toast(err.message); }
  };
  $('#regDel')?.addEventListener('click', async () => {
    if (!confirm('刪除後，已經同意提供的活動也會一併撤回。確定刪除？')) return;
    await api('/me/race-profile', { method: 'DELETE' }); toast('已刪除'); meReg();
  });
}
function meTeams() {
  const main = teamOf(me.main_team), led = teams().filter((t) => t.id !== me.main_team && (t.my_status === 'active' || t.my_status === 'pending'));
  view.innerHTML = `${subTitle('主團與分團', '主團由管理員設定；想加入其他分團，申請後由該團幹部核准')}
    <section class="card">
      <h3>主團</h3>
      ${main ? `<a class="teamchip active" href="#/t/${esc(main.id)}" style="--tc:${esc(main.color)}">${teamIcon(main, 'xs')}<span><span translate="no">${esc(main.name)}</span></span><span class="tiny">主團</span></a>`
        : '<p class="notice" style="margin:0">管理員還沒幫你設定主團，設定好之後就會收到分團的活動與公告。</p>'}
      ${led.length ? `<h3>其他分團</h3><div class="teamrow">${led.map((t) => `<a class="teamchip ${t.my_status}" href="#/t/${esc(t.id)}" style="--tc:${esc(t.color)}">${teamIcon(t, 'xs')}<span><span translate="no">${esc(t.name)}</span></span><span class="tiny">${t.my_status === 'pending' ? '申請中' : esc(t.my_title || TEAM_ROLE_NAME[t.my_role])}</span></a>`).join('')}</div>` : ''}
    </section>
    <a class="btn ghost block" href="#/teams">看全部分團</a>`;
}
// 推播哪些通知：每個類別一列；帳號安全與活動異動一律推播
const NPREF = [
  ['security', '新裝置登入、通行金鑰、身分變更'], ['change', '已報名的活動取消、改時間、改地點、候補轉正'],
  ['signup', '前一晚與集合前提醒、天氣、到貨、中獎'], ['event', '新團練、揪跑、問卷、邀請與賽事提醒'],
  ['training', '新課表、教練回饋、跑後記錄提醒、每月里程'], ['membership', '入團結果、主團、入會與會費到期'],
  ['announce', '協會與分團公告'], ['todo', '入團入會申請、繳費確認、地點審核、天氣調整'],
];
const prefRows = (p) => NPREF.filter(([k]) => k !== 'todo' || p.officer).map(([k, desc]) => {
  const locked = p.locked.includes(k);
  return `<label class="setrow nprefrow" id="pref-${k}"><span class="ntile n-${k}" aria-hidden="true">${NICON[k]}</span>
    <span class="st"><b>${CATS[k].zh}</b><span class="tiny">${desc}</span>${locked ? '<span class="tiny">一律推播</span>' : ''}${k === 'todo' && p.reviewForced ? '<span class="tiny">每季權限檢視一律推播</span>' : ''}</span>
    <span class="switch"><input type="checkbox" data-pref="${k}" ${locked || !p.mute.includes(k) ? 'checked' : ''}${locked ? ' disabled' : ''}><i></i></span></label>`;
});
async function meNotify() {
  const reg = await Promise.race([navigator.serviceWorker?.ready.catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  const [sub, prefs] = await Promise.all([reg?.pushManager?.getSubscription().catch(() => null), api('/me/notify-prefs').catch(() => null)]);
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  view.innerHTML = `${subTitle('通知與裝置')}
    <section class="card">
      <div class="row spread"><h3>這支手機的推播</h3>${cfg.vapid ? `<span class="pill${sub ? ' solid' : ''}">${sub ? '已開啟' : denied ? '已被封鎖' : '未開啟'}</span>` : ''}</div>
      ${cfg.vapid ? `<p class="muted" style="margin:0">依照下方類別推播到這支手機，通知中心一律保留紀錄。${isStandalone() ? '' : '在 iPhone 上要先「加到主畫面」，再從主畫面打開才收得到。'}</p>
        ${denied && !sub ? `<p class="notice" style="margin:0">${ios ? '到 iPhone 設定 → 通知 → 耕跑團，打開「允許通知」' : '長按主畫面的耕跑團圖示 → 應用程式資訊 → 通知'}</p>` : ''}
        <p class="notice" id="pushStale" style="margin:0" hidden>這支手機的推播已失效，請重新開啟</p>
        <div class="row"><button class="btn sm" id="pushBtn">${sub ? '關閉通知' : '開啟通知'}</button>${sub ? '<button class="btn ghost sm" id="pushTest">發測試通知</button>' : ''}</div>`
        : '<p class="muted" style="margin:0">推播功能尚未啟用。</p>'}
    </section>
    ${prefs ? `${!sub && cfg.vapid ? '<p class="tiny" style="margin:0 6px">這支手機還沒開啟推播，設定會在開啟後生效</p>' : ''}
      ${group('推播哪些通知', prefRows(prefs))}
      <p class="tiny" style="margin:-4px 6px 0">關掉的類別仍會留在通知中心，只是不推播到手機。設定跟著帳號，換手機也一樣。</p>` : ''}
    ${installCard('me')}
    <section class="card" id="calCard">
      <div class="row spread"><h3>訂閱到手機行事曆</h3>${cfg.calendarOn ? '<span class="pill solid">已開啟</span>' : ''}</div>
      <p class="tiny" style="margin:0">團練、揪跑與幹部設定的賽事提醒會自動出現在 iPhone、Google 行事曆，有變動也會跟著更新。訂閱網址等同你的個人鑰匙，不要分享給別人。</p>
      <label class="switch"><span>包含所有開團活動與賽事提醒<span class="tiny" style="display:block">關掉就只有自己報名的</span></span><input type="checkbox" id="calScope" ${cfg.calScope !== 'mine' ? 'checked' : ''}><i></i></label>
      <div id="calBox" class="row" style="gap:8px">${cfg.calendarOn ? '<button class="btn ghost sm" id="calNew">重新產生網址</button><button class="btn ghost sm" id="calOff">停用</button>' : '<button class="btn sm" id="calNew">產生訂閱網址</button>'}</div>
    </section>
    <section class="card"><h3>顯示</h3>
      <label class="switch"><span>分頁列只顯示圖示<span class="tiny" style="display:block">隱藏下方圖示底下的文字</span></span><input type="checkbox" id="iconsOnly" ${iconsOnly.get() ? 'checked' : ''}><i></i></label>
      ${cfg.settings?.features?.cams === true ? `<label class="switch"><span>省流量：影像不自動載入<span class="tiny" style="display:block">地點卡的附近即時影像點了才載入、不自動更新</span></span><input type="checkbox" id="camLazy" ${camLazy.get() ? 'checked' : ''}><i></i></label>` : ''}
      <div class="row spread"><span>語言<span class="tiny" style="display:block" translate="no">Language</span></span>
        <div class="seg" role="group" aria-label="Language" translate="no"><button data-lang="zh" aria-pressed="${I18N.lang === 'zh'}">中文</button><button data-lang="en" aria-pressed="${I18N.lang === 'en'}">English</button></div></div></section>`;
  $('#pushBtn')?.addEventListener('click', () => togglePush(sub));
  $('#pushTest')?.addEventListener('click', async () => { try { await api('/push/test', { method: 'POST' }); toast('已送出測試通知'); } catch (e) { toast(e.message); } });
  // 切換時先改畫面再存；失敗就切回去
  for (const inp of document.querySelectorAll('[data-pref]')) inp.onchange = async () => {
    const mute = [...document.querySelectorAll('[data-pref]:not(:checked):not(:disabled)')].map((x) => x.dataset.pref);
    try { await api('/me/notify-prefs', { method: 'PUT', body: { mute } }); }
    catch { inp.checked = !inp.checked; toast('設定沒有存成功'); }
  };
  // 從通知的「關閉這一類推播」過來：捲到那一列並亮一下
  const focusCat = new URLSearchParams(location.hash.split('?')[1] || '').get('cat');
  const pr = focusCat && /^\w+$/.test(focusCat) && $(`#pref-${focusCat}`);
  if (pr) { pr.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); pr.classList.add('flash'); setTimeout(() => pr.classList.remove('flash'), 1200); }
  // 伺服器已經刪掉這支手機的訂閱（推播服務回 404／410）：權限還在就悄悄重新訂閱
  if (sub && cfg.vapid) api('/push/check', { method: 'POST', body: { endpoint: sub.endpoint } }).then(async ({ known }) => {
    if (known) return;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { const j = sub.toJSON(); await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } }); toast('已重新連上推播'); return; } catch {}
    }
    const el = $('#pushStale'); if (el) el.hidden = false;
  }).catch(() => {});
  bindInstall();
  $('#iconsOnly').onchange = (e) => { iconsOnly.set(e.target.checked); applyTabs(); };
  $('#camLazy')?.addEventListener('change', (e) => camLazy.set(e.target.checked));
  for (const b of document.querySelectorAll('[data-lang]')) b.onclick = () => { if (b.dataset.lang !== I18N.lang) I18N.setLang(b.dataset.lang); };
  $('#calNew').onclick = async () => {
    if (cfg.calendarOn && !confirm('重新產生後，已經訂閱的舊網址會失效，要在行事曆重新訂閱。確定？')) return;
    try {
      const { url } = await api('/me/calendar', { method: 'POST' });
      cfg.calendarOn = true;
      $('#calBox').outerHTML = `<div style="display:grid;gap:8px"><a class="btn block" href="${esc(url.replace(/^https:/, 'webcal:'))}">加到 iPhone／Mac 行事曆</a>
        <div class="row" style="gap:8px"><input readonly value="${esc(url)}" aria-label="行事曆訂閱網址" style="flex:1;font-size:13px" onfocus="this.select()"><button class="btn ghost sm" id="calCopy">複製</button></div>
        <p class="tiny" style="margin:0">Google 行事曆：電腦版左側「其他日曆 → 透過網址新增」，貼上這個網址。這個網址只會顯示這一次。</p></div>`;
      $('#calCopy').onclick = () => copy(url);
    } catch (e) { toast(e.message); }
  };
  $('#calScope').onchange = async (e) => { try { const r = await api('/me/calendar-scope', { method: 'POST', body: { scope: e.target.checked ? 'all' : 'mine' } }); cfg.calScope = r.scope; toast(e.target.checked ? '行事曆會包含所有活動' : '行事曆只放自己報名的'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#calOff')?.addEventListener('click', async () => { await api('/me/calendar', { method: 'DELETE' }); cfg.calendarOn = false; toast('已停用行事曆訂閱'); meNotify(); });
}
async function meSecurity(googleMsg) {
  view.innerHTML = `${subTitle('帳號與安全')}
    ${googleMsg === 'linked' ? '<div class="notice">已綁定 Google，之後可以直接用 Google 登入。</div>' : googleMsg === 'taken' ? '<div class="notice">這個 Google 帳號已經綁定另一個帳號了。如果那個帳號也是你的，請聯絡行政人員合併。</div>'
      : googleMsg === 'stepup' ? '<div class="notice">綁定 Google 前，請先按下方「驗證一次」用通行金鑰確認是你本人，再重新綁定。</div>' : ''}
    ${mfaBanner()}
    ${cfg.googleLogin ? `<section class="card"><div class="row spread"><div><h3>Google 帳號</h3><span class="tiny">${me.google ? '已綁定，可以用 Google 登入' : '綁定後換手機或清掉瀏覽器資料，也能用 Google 回到同一個帳號'}</span></div>
      ${me.google ? '<span class="pill solid">已綁定</span>' : `<a class="btn google sm" href="${googleHref(true)}">${GOOGLE_G}<span>綁定</span></a>`}</div></section>` : ''}
    <section class="card" id="pkCard">
      <div class="row spread"><h3>通行金鑰</h3>${me.mfa ? `<span class="pill solid">${IC.check}這次已驗證</span>` : ''}</div>
      <p class="tiny" style="margin:0">用 Face ID、Touch ID 或手機指紋登入，不用密碼。${['chair', 'director', 'supervisor', 'staff', 'coach'].includes(me.realRole || me.role) ? '幹部建議至少新增一把，協會開啟兩步驟驗證後要用它驗證。' : ''}</p>
      <div id="pkList" class="roster"></div>
      <div class="row" style="gap:8px">${pkSupported() ? `<button class="btn sm" id="pkAdd">${IC.plus}新增通行金鑰</button>` : '<span class="tiny">這個瀏覽器不支援通行金鑰</span>'}
        <button class="btn ghost sm" data-stepup id="pkTest" hidden>驗證一次</button></div>
    </section>
    ${me.role !== 'member' ? '' : `<details class="card tight"><summary class="tiny">系統初始設定（只限第一位理事長）</summary>
      <p class="tiny">幹部身分一律由理事長在後台指派。這裡只用在系統剛建立、還沒有理事長的時候。</p>
      <form id="af" class="row" style="gap:8px"><input name="code" placeholder="初始設定碼" autocapitalize="none" autocorrect="off" spellcheck="false" type="password" aria-label="初始設定碼" style="flex:1;min-width:140px" autocomplete="off"><button class="btn sm">設定</button></form></details>`}
    ${group('', [btnRow('logout', MI.out, '登出'), btnRow('logoutAll', MI.lock, '登出所有裝置', '手機掉了或懷疑被別人登入時')])}`;
  bindStepup();
  const loadPk = async () => {
    const { passkeys } = await api('/passkeys');
    if (!$('#pkList')) return;
    $('#pkList').innerHTML = passkeys.map((p) => `<div class="r">${IC.lock}<span><span translate="no">${esc(p.name || '通行金鑰')}</span><span class="tiny" style="display:block">新增於 ${esc(p.created_at.slice(0, 10))}${p.last_used_at ? `・上次使用 ${ago(p.last_used_at)}` : ''}</span></span>
      <button class="btn ghost sm" data-pkdel="${esc(p.id)}">移除</button></div>`).join('');
    $('#pkTest').hidden = !passkeys.length || (me.mfa && googleMsg !== 'stepup');
    for (const b of document.querySelectorAll('[data-pkdel]')) b.onclick = async () => { if (!confirm('移除這把通行金鑰？之後這台裝置就不能用它登入。')) return; await api(`/passkeys/${encodeURIComponent(b.dataset.pkdel)}`, { method: 'DELETE' }); toast('已移除'); loadPk(); };
  };
  loadPk().catch(() => {});
  $('#pkAdd')?.addEventListener('click', async () => {
    try { await passkey('register'); toast('已新增通行金鑰'); try { await passkey('stepup'); me = null; render(); return; } catch {} loadPk(); }
    catch (e) { if (e.message !== '已取消') toast(e.message); }
  });
  $('#af')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { me = (await api('/me/admin', { method: 'POST', body: { code: e.target.code.value } })).member; toast('已設定為理事長'); render(); } catch (err) { toast(err.message); }
  });
  $('#logout').onclick = async () => { if (!await askLegacyOnLeave()) return; await dropPush(); await api('/logout', { method: 'POST' }); clearDeviceData(); me = null; location.hash = '#/'; render(); };
  $('#logoutAll').onclick = async () => { if (!confirm('要登出所有裝置嗎？包含這一台。') || !await askLegacyOnLeave()) return; await api('/logout', { method: 'POST', body: { all: true } }); await dropPush(false); clearDeviceData(); me = null; location.hash = '#/'; render(); };
}
function mePrivacy() {
  view.innerHTML = `${subTitle('隱私')}
    <section class="card">
      <label class="switch"><span>把訓練完成率與里程分享給教練與分團幹部<span class="tiny" style="display:block">備註永遠只有你看得到</span></span><input type="checkbox" id="shareLogs" ${me.share_logs ? 'checked' : ''}><i></i></label>
      <label class="switch"><span>出現在分團里程排行榜<span class="tiny" style="display:block">只有同分團的人看得到你的名字與里程</span></span><input type="checkbox" id="showRank" ${me.show_rank ? 'checked' : ''}><i></i></label>
    </section>
    <section class="card"><h3>我們存了什麼</h3>
      <p class="tiny" style="margin:0">姓名、暱稱、組別、主團、餐點偏好、報名與訓練紀錄；賽事報名資料加密保存；電話只有行政人員看得到完整號碼。</p>
      <div class="row"><a class="btn ghost sm" href="#/privacy">隱私權政策</a><a class="btn ghost sm" href="/api/me/export" download>下載我的資料</a></div></section>
    ${feat('coach') ? group('', [row('#/plan/setup?go=device', MI.phone, '這台裝置上的課表設定與身體資料', '只存在這台裝置，不會上傳；登出時清除')]) : ''}
    <section class="card"><h3>刪除帳號</h3><p class="tiny" style="margin:0">報名、入場券、通知與訓練紀錄都會刪除，中獎紀錄只留獎項給協會對帳。</p>
      <button class="btn danger block" id="delAcct">刪除我的帳號</button></section>`;
  $('#showRank').onchange = async (e) => { try { await api('/me/show-rank', { method: 'POST', body: { on: e.target.checked } }); me.show_rank = e.target.checked; toast(e.target.checked ? '已加入排行榜' : '已退出排行榜'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#shareLogs').onchange = async (e) => { try { await api('/me/share-logs', { method: 'POST', body: { share: e.target.checked } }); me.share_logs = e.target.checked; toast(e.target.checked ? '已分享給教練' : '已停止分享'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#delAcct').onclick = async () => {
    if (!confirm('刪除後無法復原。確定刪除帳號？') || !await askLegacyOnLeave()) return;
    try { await api('/me', { method: 'DELETE' }); clearDeviceData(); me = null; toast('帳號已刪除'); location.hash = '#/'; render(); } catch (e) { toast(e.message); }
  };
}
// 分享 App：當面掃 QR、手機分享選單、LINE、複製連結。只分享網址（用 Google 登入加入），不帶邀請碼
function shareApp() {
  const url = `${location.origin}/`, name = org().short || '耕跑團';
  const text = `一起加入${name}！團練報名、分組課表、GPS 跑步記錄和拍照分享都在這裡。用 Google 帳號登入，加到主畫面就像 App 一樣：${url}`;
  const host = document.createElement('div');
  host.className = 'sheet'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); host.setAttribute('aria-label', '分享 App');
  host.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-card card shareapp">
    <div class="row spread"><h3>分享${esc(name)} App</h3><button class="btn ghost sm" data-close>完成</button></div>
    <div class="shareqr"><div class="qrbox" id="appQR"></div><span class="tiny">請朋友用手機相機掃描</span></div>
    <div class="${navigator.share ? 'grid2' : 'grid1'}">${navigator.share ? `<button class="btn iconbtn" id="saNative">${MI.share}分享…</button>` : ''}
      <a class="btn ${navigator.share ? 'ghost ' : ''}iconbtn" href="https://line.me/R/share?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">分享到 LINE</a></div>
    <button class="btn ghost block" id="saCopy">複製連結</button>
    <p class="tiny" style="margin:0">朋友打開後用 Google 帳號登入就能加入成為跑友；要成為協會會員另外申請。</p></div>`;
  document.body.append(host);
  const close = () => host.remove();
  for (const b of host.querySelectorAll('[data-close]')) b.onclick = close;
  qrSVG(url, { size: 220, dark: '#0B1B33', light: '#fff' }).then((svg) => { const q = host.querySelector('#appQR'); if (q) q.innerHTML = svg; }).catch(() => {});
  host.querySelector('#saNative')?.addEventListener('click', async () => { try { await navigator.share({ title: name, text, url }); } catch {} });
  host.querySelector('#saCopy').onclick = () => copy(text);
}
// 會籍卡：協會會員的電子卡，QR 有簽章，幹部掃了看得到會籍狀態
async function meCard() {
  const c = await api('/me/card');
  const member = c.membership === 'active', valid = member && (!c.paid_until || c.paid_until >= ymd(new Date()));
  const state = valid ? '有效' : member ? '已到期' : '尚未入會';
  view.innerHTML = `${subTitle('會籍卡', '活動報到或優惠時出示給幹部掃描')}
    <section class="membercard ${valid ? '' : 'expired'}">
      <div class="mc-top"><img src="/icons/icon-192.png" alt="" width="44" height="44"><span><b translate="no">${esc(c.org)}</b><small translate="no">CULTIVATION IN LIFE RUN</small></span></div>
      <div class="mc-mid"><div><span class="tiny">會員</span><b translate="no">${esc(c.name)}</b>${c.member_no ? `<span class="num">No. <span translate="no">${esc(c.member_no)}</span></span>` : ''}</div><div class="qrbox" id="cardQR"></div></div>
      <div class="mc-foot"><span>${esc(member ? c.member_type || '會員' : '跑友')}</span>${member ? `<span>${c.paid_until ? `有效至 ${esc(c.paid_until)}` : '長期有效'}</span>` : ''}<span class="pill ${valid ? 'solid' : 'wait'}">${state}</span></div>
    </section>
    ${valid ? '' : member ? '<p class="notice">會費已到期，續繳後行政人員更新會籍，卡片就會恢復有效。</p>' : '<p class="notice">你還不是協會會員。想加入協會，到「我的 → 協會」填入會表單。<a href="#/me/assoc">前往 ›</a></p>'}
    <p class="tiny center">卡上的 QR 有防偽簽章，截圖分享給別人也只會顯示你的名字。</p>`;
  qrSVG(c.qr, { size: 180, dark: '#0B1B33', light: '#fff' }).then((svg) => { if ($('#cardQR')) $('#cardQR').innerHTML = svg; }).catch(() => {});
}
function meAssoc() {
  view.innerHTML = `${subTitle(esc(org().name || '台灣耕跑團協會'))}
    <section class="card">
      <div class="row spread"><h3>會籍</h3><span class="pill ${me.membership === 'active' ? 'solid' : me.membership === 'applied' ? 'wait' : ''}">${esc(me.membershipName || '跑友')}</span></div>
      ${me.membership === 'active'
        ? `<p class="muted" style="margin:0">${esc(me.member_type || '會員')}${me.member_no ? `・編號 ${esc(me.member_no)}` : ''}${me.paid_until ? `・會費繳至 ${esc(me.paid_until)}` : ''}</p>`
        : `<p class="muted" style="margin:0">跑友可以報名所有團練；想加入協會，先填官方入會表單，再按下方按鈕通知行政人員。</p>
           ${org().join_form ? `<a class="btn ghost block" href="${esc(org().join_form)}" target="_blank" rel="noopener">開啟入會表單 ${IC.external}</a>` : ''}
           ${me.membership === 'applied' ? '<p class="notice" style="margin:0">已送出申請，等行政人員確認。</p>' : '<button class="btn block" id="applyBtn">我已填表，送出申請</button>'}`}
    </section>
    ${(cfg.settings?.docs || []).length || org().contact || org().parent ? `<section class="card"><h3>協會資訊</h3>
      ${org().parent ? `<p class="tiny" style="margin:0">所屬企業：${org().parent_url ? `<a href="${esc(org().parent_url)}" target="_blank" rel="noopener">${esc(org().parent)} ${IC.external}</a>` : esc(org().parent)}${org().parent_note ? `・${esc(org().parent_note)}` : ''}</p>` : ''}
      ${org().contact ? `<p class="tiny" style="margin:0">聯絡方式：${esc(org().contact)}</p>` : ''}
      <div class="doclist">${(cfg.settings?.docs || []).map((d) => `<a class="docrow" href="${esc(d.url)}" target="_blank" rel="noopener"><span class="docic">${IC.doc}</span><span><b><span translate="no">${esc(d.title)}</span></b>${d.note ? `<span class="tiny" style="display:block"><span translate="no">${esc(d.note)}</span></span>` : ''}</span><span class="tiny">${IC.external}</span></a>`).join('')}</div>
    </section>` : ''}`;
  $('#applyBtn')?.addEventListener('click', async () => { try { me = (await api('/me/apply', { method: 'POST' })).member; toast('已送出申請'); meAssoc(); } catch (e) { toast(e.message); } });
}

async function togglePush(sub) {
  try {
    const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!reg || typeof Notification === 'undefined') return toast('這個瀏覽器不支援通知，請用 Safari 或 Chrome 打開，並加到主畫面');
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
      toast('已關閉通知'); render(); return;
    }
    // 第一次開啟前先說明會推播什麼（權限請求要在使用者按下按鈕時發出）
    const perm = Notification.permission === 'granted' ? 'granted' : await pushExplainer();
    if (perm === null) return;
    if (perm !== 'granted') return toast('瀏覽器沒有允許通知');
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(cfg.vapid) });
    const j = s.toJSON();
    await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
    toast('已開啟通知'); render();
  } catch (e) { toast(e.message || '通知設定失敗'); }
}
// 開啟推播前的說明 sheet：回傳權限結果；按「先不要」或關掉回傳 null
function pushExplainer() {
  return new Promise((done) => {
    let picked = false;
    const s = openSheet('要開啟推播嗎？', `<h3>要開啟推播嗎？</h3><p class="muted" style="margin:0">推播會通知你活動異動、報名提醒和帳號安全，類別可以之後在這裡調整。</p>
      <div class="choices"><button type="button" class="btn block" data-go>開啟推播</button><button type="button" class="btn ghost block" data-close>先不要</button></div>`, $('#pushBtn'));
    s.host.addEventListener('click', (e) => {
      if (e.target.closest('[data-go]')) { picked = true; s.close(); Notification.requestPermission().then(done, () => done('denied')); }
    });
    new MutationObserver((_, o) => { if (!s.host.isConnected) { o.disconnect(); if (!picked) done(null); } }).observe(document.body, { childList: true });
  });
}
const urlB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

// ---------- 路由 ----------
// 畫面一次只畫一個：還在載入時又換頁（例如剛登入就點「我的」），等這次畫完再畫最新的網址，
// 避免比較慢的舊畫面最後才完成、把新畫面蓋掉
let rendering = null, renderAgain = false, firstLoad = true;
async function render() {
  if (rendering) { renderAgain = true; return rendering; }
  rendering = (async () => { do { renderAgain = false; await renderOnce(); } while (renderAgain); })();
  try { await rendering; } finally { rendering = null; }
}
// 返回鍵：分頁以外的頁面在左上角顯示「‹ 上一層」。App 裡有上一頁就退回上一頁（保留捲動與篩選），
//   從通知或分享連結直接打開的就回到它的上一層（加到主畫面後沒有瀏覽器的返回鍵）
const TOP_PAGES = ['/', '/plan', '/plan/season', '/plan/race', '/plan/guide', '/run', '/map', '/studio', '/me'];
function parentOf(h) {
  const p = h.split('/');
  if (h.startsWith('/me/')) return ['#/me', '我的'];
  if (h.startsWith('/e/') && p.length > 3) return [`#/e/${p[2]}`, '活動'];
  if (h.startsWith('/edit/')) return [`#/e/${p[2]}`, '活動'];
  if (['/challenge', '/report', '/log', '/plan/new', '/logs/team'].includes(h) || h.startsWith('/plan/')) return ['#/plan', '課表'];
  if (h.startsWith('/t/')) return ['#/teams', '分團'];
  if (['/teams', '/tickets', '/admin', '/roster'].includes(h) || h.startsWith('/m/')) return ['#/me', '我的'];
  return ['#/', '團練'];
}
// 這一頁屬於哪個分頁：本身是分頁就是自己，不然沿著上一層往上找（最多找 4 層）
function tabOf(h) {
  const TOP = ['/', '/plan', '/run', '/map', '/studio', '/me'];
  for (let i = 0; i < 4 && !TOP.includes(h); i++) h = parentOf(h)[0].slice(1);
  return h;
}
// 頁面名稱（返回鍵顯示「‹ 上一頁的名稱」）
function nameOf(h) {
  const N = { '/': '團練', '/plan': '課表', '/run': '跑步', '/studio': '拍照', '/me': '我的', '/calendar': '行事曆', '/map': '地圖', '/challenge': '挑戰', '/admin': '管理後台',
    '/teams': '分團', '/report': '報表', '/tickets': '入場券', '/notifications': '通知', '/past': '過去的團練', '/roster': '名冊', '/logs/team': '團員訓練',
    '/plan/season': '全季課表', '/plan/race': '賽事準備', '/plan/guide': '配速與用語', '/plan/setup': '課表設定' };
  if (N[h]) return N[h];
  if (h.startsWith('/me/')) return ME_SECTIONS[h.slice(4)] || '我的';
  if (h.startsWith('/e/')) return h.endsWith('/stats') ? '統計' : '活動';
  if (h.startsWith('/t/')) return '分團';
  if (h.startsWith('/plan/')) return '課表';
  return '返回';
}
const navStack = [];
function paintBack(hash) {
  if (navStack[navStack.length - 2] === hash) navStack.pop(); else if (navStack[navStack.length - 1] !== hash) navStack.push(hash);
  if (navStack.length > 30) navStack.shift();
  const btn = $('#backBtn'), detail = !!me && !TOP_PAGES.includes(hash) && !cfg.needConsent;
  document.body.classList.toggle('detail', detail);
  btn.hidden = !detail;
  if (!detail) return;
  const [href, parentLabel] = parentOf(hash);
  const label = navStack.length > 1 ? nameOf(navStack[navStack.length - 2].split('?')[0]) : parentLabel;
  $('#backLabel').textContent = label;
  btn.setAttribute('aria-label', `返回${label}`);
  btn.onclick = () => { if (navStack.length > 1) history.back(); else location.hash = href; };
}
async function renderOnce() {
  formDirty = false;
  if (stopScan) { stopScan(); stopScan = null; }
  view.planMark = null;
  if (viewCleanup) { try { viewCleanup(); } catch {} viewCleanup = null; }
  const raw = location.hash.replace(/^#/, '') || '/';
  const hash = raw.split('?')[0];
  // 練跑地圖是滿版地圖：整頁不捲動
  document.body.classList.toggle('fullmap', hash === '/map');
  document.documentElement.classList.toggle('fullmap', hash === '/map');
  // 子頁面（管理後台、名冊、活動統計…）也亮起它所屬的分頁
  const tab = tabOf(hash);
  for (const a of document.querySelectorAll('.tabs a')) a.toggleAttribute('aria-current', a.dataset.tab === tab);
  paintCountdown();
  if (!me && firstLoad) {
    firstLoad = false;
    const fresh = api('/me?boot=1');
    const stale = await peekBoot();
    if (stale?.member && !stale.needConsent) {
      // 先用上次的資料畫出來，網路回來後資料有變才重畫（不重播進場動畫、使用者正在輸入就不打擾）
      me = stale.member; cfg = stale; bootData = stale.boot || null; vitals.warm = true;
      fresh.then((r) => {
        const same = (x) => JSON.stringify({ ...x, serverNow: 0 });   // 伺服器時間每次都不同，不算資料有變
        const changed = same(r) !== same(stale);
        me = r.member; cfg = r; bootData = r.boot || null;
        if (!changed && me) return;
        const typing = document.activeElement?.matches?.('input, textarea, select') && view.contains(document.activeElement);
        if (me && typing) return;
        document.body.classList.add('quiet');
        render().finally(() => setTimeout(() => document.body.classList.remove('quiet'), 50));
      }).catch(() => {});
    } else {
      try { const r = await fresh; me = r.member; cfg = r; bootData = r.boot || null; } catch { me = null; }
    }
  }
  if (!me) {
    try { const r = await api('/me'); me = r.member; cfg = r; } catch { me = null; }
  }
  bindDeviceData(me?.id);
  paintCountdown();
  applyFeatures();
  $('#bell').hidden = !me;
  document.body.classList.toggle('guest', !me);
  if (hash === '/privacy') { if (!me) { try { const r = await api('/me'); me = r.member; cfg = r; } catch {} } return privacyView(); }
  if (!me) return loginView();
  if (cfg.needConsent) {
    // 記住原本要去的頁面（例如捷徑帶數據進來），同意後再回去
    try { sessionStorage.setItem('cil-after-consent', location.hash); } catch {}
    location.hash = '#/privacy'; return;
  }
  // 登入前點的是分享連結：登入後回到那個活動
  try {
    const after = sessionStorage.getItem('cil-after-login');
    if (after) { sessionStorage.removeItem('cil-after-login'); if (after !== location.hash) { location.hash = after; return; } }
  } catch {}
  nLeave();
  bell();
  paintBack(hash);
  $('#ctitle').textContent = '';
  // 150 毫秒內還沒畫出新畫面才顯示骨架（先畫外框再載資料的頁面，例如地圖，不會被蓋掉）
  const before = view.innerHTML;
  const skel = setTimeout(() => { if (view.innerHTML === before) view.innerHTML = skeleton(hash); }, 150);
  try { await route(hash); } finally { clearTimeout(skel); }
  // 第一個畫面畫好了：記下開啟到可用的時間，20 秒後（或離開時）送出
  if (vitals.ready == null) { vitals.ready = performance.now(); vitals.page = hash.replace(/\/[\w-]{8,}/g, '/:id').slice(0, 40); setTimeout(sendVitals, 20000); }
  $('.top').classList.toggle('titled', false);
}

// 載入中的骨架：照每一頁實際的版面畫灰色輪廓，資料回來時位置不會跳
function skeleton(hash) {
  const box = (h) => `<i style="height:${h}px"></i>`;
  const shape = hash === '/' ? [150, 92, 190, 120, 120]
    : hash.startsWith('/plan') ? [110, 210, 64, 64, 64, 64, 64]
    : hash === '/me' ? [96, 'u', 250, 'u', 80, 'u', 160]
    : hash.startsWith('/me/') ? [240, 180]
    : hash.startsWith('/e/') ? [220, 160, 120]
    : hash === '/run' ? [300, 120] : [150, 110, 110];
  if (hash === '/notifications') return `<div class="skel" role="status" aria-label="載入中"><b></b></div>${nSkel()}`;
  return `<div class="skel" role="status" aria-label="載入中"><b></b>${shape.map((x) => (x === 'u' ? '<u></u>' : box(x))).join('')}</div>`;
}
async function route(hash) {
  try {
    if (hash === '/') return await listView();
    if (hash === '/past') return await pastView();
    if (hash === '/calendar') return await calendarView();
    if (hash === '/map') return await mapView();
    if (hash === '/challenge') return await challengeView();
    if (hash === '/coach') { location.replace('#/plan'); return; }
    if (hash === '/studio') return feat('studio') ? await studioView() : (view.innerHTML = `<div class="card">${emptyState('runner', '這個功能目前沒有開放')}</div>`);
    if (hash === '/notifications') return await notificationsView();
    if (hash === '/roster') return await rosterView();
    if (hash === '/admin') return await adminView();
    if (hash === '/plan/new') return planNewView();
    if (hash === '/me') return await meView();
    const mesec = hash.match(/^\/me\/(\w+)$/);
    if (mesec) return await meView(mesec[1]);
    if (hash === '/teams') return await teamsView();
    if (hash === '/tickets') return await ticketsView();
    if (hash === '/log') return await logView();
    if (hash === '/run') return feat('gps') ? await runView() : (view.innerHTML = `<div class="card">${emptyState('runner', '這個功能目前沒有開放')}</div>`);
    if (hash === '/logs/team') return await logsTeamView();
    if (hash === '/report') return await reportView();
    const lm = hash.match(/^\/logs\/m\/([\w-]+)$/);
    if (lm) return await memberLogsView(lm[1]);
    const tm = hash.match(/^\/t\/([\w-]+)$/);
    if (tm) return await teamView(tm[1]);
    const st = hash.match(/^\/e\/([\w-]+)\/stats$/);
    if (st) return await statsView(st[1]);
    if (hash === '/new') return await formView(null);
    const edit = hash.match(/^\/edit\/([\w-]+)$/);
    if (edit) return await formView(edit[1]);
    const at = hash.match(/^\/e\/([\w-]+)\/attend$/);
    if (at) return await attendView(at[1]);
    const ci = hash.match(/^\/e\/([\w-]+)\/in\/([\w-]+)$/);
    if (ci) return await checkinView(ci[1], ci[2].toUpperCase());
    const sc = hash.match(/^\/e\/([\w-]+)\/scan$/);
    if (sc) return await scanView(sc[1]);
    const ev = hash.match(/^\/e\/([\w-]+)$/);
    if (ev) return await eventView(ev[1]);
    // 課表的全季、賽事準備、配速與用語、課表設定：課表教練關掉時不開放（課表設定仍可以改課表週期）
    const pc = hash.match(/^\/plan\/(season|race|guide|setup)$/);
    if (pc) {
      if (feat('coach') || (pc[1] === 'setup' && (feat('plan_cycle') || cfg.planCycle?.suspended))) { viewCleanup = await coachView(pc[1]); return; }
      view.innerHTML = `<div class="card">${emptyState('runner', '這個功能目前沒有開放')}<p class="tiny center" style="margin:0">管理員可以在「功能與畫面」打開課表教練</p></div>`;
      return;
    }
    const pl = hash.match(/^\/plan(?:\/(\d+))?$/);
    if (pl) return await planView(pl[1] ? Number(pl[1]) : 0);
    view.innerHTML = `<div class="card">${emptyState('runner', '找不到這個頁面')}</div>`;
  } catch (e) {
    view.innerHTML = `<div class="card">${emptyState('runner', esc(e.message))}<div class="row" style="justify-content:center;gap:8px"><button class="btn sm" id="retryBtn">重試</button><a class="btn ghost sm" href="#/">回首頁</a></div></div>`;
    // 版本混在一起的錯誤：重試要重新載入整個 App，只重畫這一頁還是會用到舊程式
    $('#retryBtn').onclick = () => (VERSION_SKEW.test(e.message || '') ? location.reload() : render());
    if (VERSION_SKEW.test(e.message || '')) reloadForUpdate();
  }
}

// 深淺色：跟隨系統，按鈕可以手動覆寫並記住
const theme = {
  get() { try { return localStorage.getItem('cil-theme'); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem('cil-theme', v) : localStorage.removeItem('cil-theme'); } catch {} },
};
const THEME_COLOR = { light: '#EEF2F9', dark: '#060F1C' };
const applyTheme = () => {
  const t = theme.get();
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  // 狀態列顏色：手動選了主題就兩個 meta 都用那個主題的顏色，否則照系統
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = THEME_COLOR[t || (/dark/.test(m.media) ? 'dark' : 'light')];
};
applyTheme();
$('#theme').onclick = () => {
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light')) === 'dark';
  theme.set(dark ? 'light' : 'dark');
  applyTheme();
};

// 捲動：超過一點點就讓頂部列變成玻璃；大標題捲出畫面就把標題顯示在頂部列；往下捲時分頁列縮小
let lastY = 0;
addEventListener('scroll', () => {
  const y = scrollY, top = $('.top'), lt = $('.lt h1');
  top.classList.toggle('stuck', y > 4);
  top.classList.toggle('titled', !!lt && lt.getBoundingClientRect().bottom < top.offsetHeight);
  $('#tabs').classList.toggle('mini', y > lastY && y > 120);
  lastY = y;
}, { passive: true });

// 滑鼠反光：只在有游標的裝置，追蹤游標在卡片上的位置
if (matchMedia('(hover:hover) and (pointer:fine)').matches) {
  addEventListener('pointermove', (e) => {
    const c = e.target.closest?.('.card.lit');
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`);
    c.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}

// 換頁用 View Transition（支援的瀏覽器才有）
const go = () => { render(); scrollTo({ top: 0, behavior: 'instant' }); };
addEventListener('hashchange', () => {
  // 不支援或使用者設定「減少動態效果」：直接換頁，不做轉場
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
  // 連續換頁時前一個轉場會被中斷；三個 promise 都會 reject，全部接住
  const t = document.startViewTransition(go);
  for (const p of [t.ready, t.updateCallbackDone, t.finished]) p.catch(() => {});
});
// 英文介面：先載入字典再畫第一個畫面，避免先閃一下中文
I18N.init().catch(() => {}).finally(() => render());
// Service Worker：新版本裝好後先等待；剛打開 App、或在背景放了 3 分鐘以上回來，而且沒有填到一半的表單、沒在跑步時，
//   直接換新版（不然一直不關 App 的人會停在舊版）；其他時候跳出提示讓使用者決定
document.addEventListener('input', (e) => { if (e.target.closest?.('#view form')) formDirty = true; }, true);
const busyRunning = () => { try { return ['running', 'paused'].includes(Run.session()?.status); } catch { return false; } };
const quietMoment = () => !formDirty && !busyRunning() && (performance.now() < 15000 || (hiddenAt && Date.now() - hiddenAt > 180000));
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const ask = (w) => {
      if (!w) return;
      if (!hadController || quietMoment()) { w.postMessage({ type: 'SKIP_WAITING' }); return; }   // 第一次安裝、或現在換版不會打斷人
      if (document.getElementById('updbar')) return;
      const bar = document.createElement('div');
      bar.id = 'updbar'; bar.className = 'updbar'; bar.role = 'status';
      bar.innerHTML = '<span>耕跑團有新版本</span><button class="btn sm">更新</button><button class="btn ghost sm" aria-label="稍後">稍後</button>';
      bar.querySelector('.btn').onclick = () => { w.postMessage({ type: 'SKIP_WAITING' }); bar.remove(); };
      bar.querySelector('.ghost').onclick = () => bar.remove();
      document.body.append(bar);
    };
    if (reg.waiting) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') ask(w); });
    });
    // 打開 App、切回前景時檢查有沒有新版本
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      reg.update().catch(() => {}).finally(() => { if (reg.waiting) ask(reg.waiting); hiddenAt = 0; });
    });
  }).catch(() => {});
  // Service Worker 的訊息：點推播導頁（只接受站內網址）；收到推播只當作「去重抓」的訊號，不顯示 payload 內容
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'go' && typeof m.url === 'string' && /^\/(#\/[\w/?=&.%-]*)?$/.test(m.url)) location.hash = m.url.slice(1) || '#/';
    if (m.type === 'notif') { bell(true); if (location.hash.startsWith('#/notifications')) showNewPill(); }
  });
  navigator.serviceWorker.startMessages?.();
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
}
// 記住安裝提示（Android／桌機 Chrome），在「我的」與首頁顯示安裝按鈕
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = false; }); });
addEventListener('appinstalled', () => { installEvt = null; try { localStorage.setItem('cil-installed', '1'); } catch {} document.querySelectorAll('.installcard').forEach((c) => c.remove()); });

// 拆出去的模組（admin.js、photo.js…）從這裡拿共用的工具與狀態
export { legacyData, removeLegacy, addrField, bindAddrField, latest, $, cfg, downloadAuthed, scanSheet, FEEL, IC, KIND_NAME, LOG_ICON, LOG_STATUS_NAME, MI, PAID_NAME, ROLE_NAME, TAB_DEFAULT, TEAM_PERMS, TEAM_ROLE_NAME, ago, allow, api, applyFeatures, avatar, barChart, bars, bindComments, bindStepup, btnRow, choose, coachPrefs, copy, countdownPicker, dayLabel, dstr, emptyState, esc, eventCard, feat, fixText, group, ic, largeTitle, me, mfaBanner, money, myCycle, nrow, org, pad2, paintCountdown, passkey, planSeg, queueLog, raceTarget, refreshMe, render, route, row, setCoachPrefs, squareIcon, startKey, studio, subTitle, teamAllow, teamIcon, teamOf, teams, toast, view, ymd, askReason, isOffline, nowTp, signupDefaults, submitLabel, camLazy, openSheet };
