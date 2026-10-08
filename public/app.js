// 耕跑團 PWA — 畫面：團練列表、我的課表、訓練紀錄、跑步記錄、通知、「我的」第一層、路由與共用工具
//   活動詳情與報名在 event.js、「我的」的子頁在 me.js（用到才載入，從這裡 import 共用的工具與狀態）
import * as P from './plan.js';
import * as I18N from './i18n.js';
import { CATS, CHIPS } from './notif-cats.js';
import * as Device from './device.js';
import { ACH_ICONS } from './achrule.js';
import { tpNow, signupState, tpShort, SIGNUP_DEFAULTS, evPhase, PHASE_LABEL } from './signup-window.js';
// 用到才下載的模組：管理後台、拍照、報表、活動頁、「我的」子頁、活動表單與統計、分團
// 剛部署的那幾秒可能拿到舊檔：載入失敗就等一下、加版本參數再試一次，仍失敗才顯示錯誤
const calendarView = (...a) => lazy('./calendar.js', 'calendarView')(...a);
const mapView = (...a) => lazy('./map.js', 'mapView')(...a);
const challengeView = (...a) => lazy('./challenge.js', 'challengeView')(...a);
// QR code 與掃描（入場券、報到、App 連結）、使用說明導覽：第一次開 App 用不到，畫面要用時才下載
const qrSVG = (...a) => lazy('./qr.js', 'qrSVG')(...a);
const scan = (...a) => lazy('./qr.js', 'scan')(...a);
const canScan = () => !!navigator.mediaDevices?.getUserMedia;
// 導覽看過就不用下載 guide.js（版本號要跟 guide.js 的 VER 一致）
// 五個分頁的導覽：不再自動跳出來，從「開始使用」卡做完三步後、或「我的 → 使用說明」打開
const Guide = { start: () => lazy('./guide.js', 'start')() };
// 課表頁的加強功能（用語說明、詳細內容、提醒、滑動換週）：課表畫好、閒下來才載入，首頁不會下載；
//   在小的 coachweek.js，完整的課表教練（coach.js）只有全季、賽事準備、配速與用語、課表設定、分享才載入
const coachWeekExtras = (...a) => lazy('./coachweek.js', 'weekExtras')(...a);
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
// 載入整個模組（同樣處理剛部署時的新舊版本混用）；lazy 是只要其中一個函式的簡寫
const load = async (file, name) => {
  let m;
  try { m = await import(file); } catch (e) {
    if ((e?.name === 'SyntaxError' || VERSION_SKEW.test(e?.message || '')) && reloadForUpdate()) return new Promise(() => {});
    await new Promise((r) => setTimeout(r, 800)); m = await import(`${file}?r=${Date.now()}`);
  }
  if (name && typeof m[name] !== 'function' && reloadForUpdate()) return new Promise(() => {});
  return m;
};
const lazy = (file, name) => async (...a) => (await load(file, name))[name](...a);
// 跑步記錄（run.js）：有跑到一半或跑完還沒存的紀錄、或直接打開跑步頁才在開機時載入；其他時候點進跑步頁才下載
//   記錄中的計時列與分頁列的小點靠它，所以有紀錄就一開始載入（每一頁都要看得到）
let Run = null, runP = null;
const loadRun = () => (runP ??= load('./run.js', 'session').then((m) => (Run = m), (e) => { runP = null; throw e; }));
// 拍照分享（studio.js）的時間格式：課表、訓練紀錄也要用，放在這裡（studio.js 從這裡拿），開機不用下載 studio.js
const fmtDuration = (s) => {
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const fmtDistPace = (dist, s) => {
  if (!dist || !s) return '—';
  const p = s / (dist / 1000); return `${Math.floor(p / 60)}'${String(Math.round(p % 60)).padStart(2, '0')}"`;
};
const parseHMS = (str) => {
  const p = String(str).trim().split(':').map(Number);
  if (p.some(Number.isNaN)) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
};

// 對外公開的乾淨網址（Google 同意畫面等會連到這裡）：/privacy → #/privacy
if (location.pathname === '/privacy' && !location.hash) history.replaceState(null, '', '/#/privacy');
// 分享連結 /e/:id（伺服器只是幫 LINE 等的連結預覽加上活動摘要）：轉成 App 的網址 /#/e/:id，邀請代碼 t 留著，openExternalBrowser（給 LINE 看的）拿掉
{
  const m = location.pathname.match(/^\/e\/([\w-]{1,32})\/?$/);
  if (m) {
    const t = new URLSearchParams(location.search).get('t');
    history.replaceState(null, '', location.hash.startsWith('#/') ? `/${location.hash}` : `/#/e/${m[1]}${t ? `?t=${encodeURIComponent(t)}` : ''}`);
  }
}
// 地圖：先連到圖磚主機、下載地圖模組（map.js 一載入就開始抓 Leaflet），跟登入資料同時進行，不用等 /api/me 回來才開始
let mapWarm = false;
// 先抓的圖磚：map.js 讓其他圖磚等這幾張到了（或最多 1.2 秒）才開始抓，畫面中間先出來
const tilePreload = { urls: new Set(), ready: Promise.resolve() };
const warmMap = () => {
  if (mapWarm) return; mapWarm = true;
  const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'https://wmts.nlsc.gov.tw'; l.crossOrigin = 'anonymous'; document.head.append(l);
  import('./map.js').catch(() => { mapWarm = false; });
};
// 直接打開活動頁、入場券、「我的」子頁（分享連結、推播、捷徑）：那一頁的模組跟登入資料同時下載，不用等 /api/me 回來
//   index.html 只預載每一頁第一屏都要的模組；這裡只下載不執行（modulepreload），畫面要用時才 import
{
  const pre = (f) => { const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = f; document.head.append(l); };
  const h = location.hash;
  if (/^#\/(e\/|tickets)/.test(h)) ['/event.js', '/pricing.js', '/party.js'].forEach(pre);   // event.js 靜態 import 的兩個一起抓，不用等 event.js 解析完才發現
  else if (/^#\/me\/\w/.test(h)) pre('/me.js');
}
if (location.hash.startsWith('#/map')) {
  warmMap();
  // 直接打開地圖：上次位置的中心那幾張圖磚先抓（不用等 Leaflet 載完才知道要哪幾張）；網址格式跟 map.js 的 BASES 一樣
  try {
    const base = localStorage.getItem('cil-map-base') || 'emap', layerId = { emap: 'EMAP', photo: 'PHOTO2' }[base];
    const [lat, lng, z0] = JSON.parse(localStorage.getItem('cil-map-view') || '[25.05,121.54,12]'), z = Math.min(Math.round(z0), base === 'emap' ? 18 : 19), n = 2 ** z;
    const fx = (lng + 180) / 360 * n, fy = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), sx = fx - x0 < 0.5 ? -1 : 1, sy = fy - y0 < 0.5 ? -1 : 1;   // 中心那張，加上離中心最近的三張
    const waits = [];
    if (layerId && Number.isFinite(fx + fy)) for (const [x, y] of [[x0, y0], [x0 + sx, y0], [x0, y0 + sy], [x0 + sx, y0 + sy]]) {
      const t = document.createElement('link'); t.rel = 'preload'; t.as = 'image'; t.crossOrigin = 'anonymous'; t.fetchPriority = 'high';
      t.href = `https://wmts.nlsc.gov.tw/wmts/${layerId}/default/GoogleMapsCompatible/${z}/${y}/${x}`;
      waits.push(new Promise((ok) => { t.onload = t.onerror = ok; }));
      tilePreload.urls.add(t.href); document.head.append(t);
    }
    tilePreload.ready = Promise.race([Promise.all(waits), new Promise((ok) => setTimeout(ok, 1200))]);
  } catch {}
}
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
// 分頁按鈕（.seg）多到要左右滑時：加上 .scrolls 讓兩側淡出，並把選中的那一個捲到中間（不會被切一半）
let segQueued = false;
const fitSegs = () => {
  segQueued = false;
  for (const s of view.querySelectorAll('.seg')) {
    // 管理後台的分頁放不下（英文）：改成兩列，不左右滑（藏在右邊的「設定」「稽核」找不到）；先拿掉兩列再量原本的寬度
    const wraps = s.classList.contains('adminseg');
    if (wraps) s.classList.remove('wrap2');
    const over = s.scrollWidth > s.clientWidth + 1;
    if (wraps) { s.classList.toggle('wrap2', over); continue; }
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
  // data：伺服器回的其他欄位（例如新增通行金鑰被擋下時的 officer、google，確認逾時的 expired）
  if (!res.ok) throw Object.assign(new Error(data.error || `錯誤 ${res.status}`), { status: res.status, data });
  return data;
};
// 大量輸入分段處理：伺服器一次執行的額度有限（免費方案 50 個子請求），處理不完會回 more（剩下的輸入）。
//   看到 more 就把它合併進 body（GET 合併進網址參數）再送一次，最多 20 輪；結果加總：陣列接起來、sum 列出的數字相加、其他取最後一輪
//   20 輪還沒做完時，回傳值保留 more，呼叫端提示「請再按一次」
const apiAll = async (path, opt = {}, sum = []) => {
  const method = opt.method || 'GET';
  let body = { ...(opt.body || {}) }, extra = '', out = null;
  for (let i = 0; i < 20; i++) {
    const r = await api(`${path}${extra}`, method === 'GET' ? opt : { ...opt, body });
    if (!out) out = r;
    else for (const [k, v] of Object.entries(r)) {
      if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...out[k], ...v];
      else if (sum.includes(k) && typeof v === 'number') out[k] = (out[k] || 0) + v;
      else out[k] = v;
    }
    if (!r.more) { delete out.more; break; }
    if (method === 'GET') extra = `${path.includes('?') ? '&' : '?'}${new URLSearchParams(r.more)}`;
    else body = { ...body, ...r.more };
  }
  return out;
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
// 三選一的確認面板（取代「確定／取消」容易按錯的 confirm）：回傳選到的 value，關掉（取消、Esc、點背景）回傳 null
//   用共用的 openSheet：焦點移到第一個選項、Tab 不會跑出去、關掉後焦點回到原本的按鈕
function choose(title, message, options, { cancel = '取消' } = {}) {
  return new Promise((done) => {
    let picked = null;
    const s = openSheet(title, `<h3 id="chooseT">${esc(title)}</h3>${message ? `<p class="muted" style="margin:0">${message}</p>` : ''}
      <div class="choices">${options.map((o) => `<button type="button" class="btn block ${o.danger ? 'danger' : o.primary ? '' : 'ghost'}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join('')}
      <button type="button" class="btn ghost block" data-close>${esc(cancel)}</button></div>`, document.activeElement, '', { onClose: () => done(picked) });
    s.host.addEventListener('click', (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v === undefined) return; picked = v || null; s.close(); });
  });
}
// 婉拒原因面板：常用理由 chips＋自由填寫（最多 max 字，預設 120；跟伺服器存的長度一致）；回傳 { note } 或 null（取消）
//   who：團員自己填的姓名，一律當純文字、不翻譯；lines：說明句（純文字，空字串略過）；ok：確認鍵文字（婉拒／移出）
//   開著的時候 Tab 只在面板裡循環，關掉後焦點回到原本的按鈕
// alt：第二個動作（例如「移出（可再報名）」），選了回傳 { note, alt: true }
function askReason(title, { who = '', lines = [], chips = [], ok = '婉拒', alt = '', max = 120 } = {}) {
  return new Promise((done) => {
    const back = document.activeElement;
    const host = document.createElement('div');
    host.className = 'sheet'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); host.setAttribute('aria-label', title);
    const text = lines.filter(Boolean);
    host.innerHTML = `<div class="sheet-bg" data-x="1"></div><div class="sheet-card card"><h3>${esc(title)}</h3>
      ${who ? `<p style="margin:0"><b translate="no">${esc(who)}</b></p>` : ''}
      ${text.map((x) => `<p class="muted" style="margin:0">${esc(x)}</p>`).join('')}
      ${chips.length ? `<div class="chips" role="group" aria-label="常用原因">${chips.map((c) => `<button type="button" class="chip" data-c="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('')}</div>` : ''}
      <label>原因（選填）<textarea maxlength="${Number(max) || 120}" rows="3" aria-describedby="reasonHint"></textarea></label>
      <p class="tiny" id="reasonHint" style="margin:0">原因只有本人看得到，推播不會顯示原因</p>
      <div class="choices"><button type="button" class="btn danger block" data-ok="1">${esc(ok)}</button>${alt ? `<button type="button" class="btn block" data-alt="1">${esc(alt)}</button>` : ''}<button type="button" class="btn ghost block" data-x="1">取消</button></div></div>`;
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
      if (e.target.closest('[data-ok]')) { close({ note: ta.value.trim().slice(0, max) }); return; }
      if (e.target.closest('[data-alt]')) { close({ note: ta.value.trim().slice(0, max), alt: true }); return; }
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
  if (ev.kind === 'claim' && (myStatus === 'in' || myStatus === 'wait')) return '更新索票';
  if (myStatus === 'in' || myStatus === 'wait') return '更新報名';
  if (ev.require_approval && !ev.manage) return full ? '送出申請（額滿，核准後排候補）' : '送出申請';   // 主辦幹部本人報名＝核准
  if (full) return '排候補';
  return ev.kind === 'claim' ? '我要索票' : '我要報名';
}
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
// 連上網路：先跟伺服器確認目前登入的是誰（開 App 時離線，用的是上次的資料），再補傳離線時的紀錄
addEventListener('online', async () => {
  offlineBar(false);
  if (me && meStale) {
    try { const r = await api('/me'); me = r.member; cfg = r; meStale = false; } catch { return; }
    if (!me) { render(); return; }
    resumePush();
  }
  flushLogQueue();
});
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
  // 還沒有 Service Worker 控制這一頁（第一次開、強制重新整理）也要清：頁面直接刪
  for (const c of [Device.API_CACHE, Device.SHARE_CACHE]) globalThis.caches?.delete(c).catch(() => {});
  // 未送出的訓練紀錄、課表設定、跑步中的 GPS 軌跡、地圖位置、草稿等（清單見 device.js 的 LOCAL_KEYS、SESSION_KEYS）
  Device.clearLocal(deviceDeps());
  navigator.clearAppBadge?.().catch(() => {});
  bellAt = 0; bellFor = null; bellState = { badge: 0, unread: 0 };
};
// 這台裝置的課表設定（身體資料）、離線暫存與推播訂閱屬於哪個帳號：登入狀態過期、被撤銷後，
//   換另一個人在這台登入時，先清掉上一位的資料並取消推播訂閱（不只靠按「登出」，見 device.js）
//   reset：換人時把已經讀進記憶體的這次跑步（run.js）也丟掉
const deviceDeps = () => {
  let storage = null, session = null;
  try { storage = localStorage; } catch {}
  try { session = sessionStorage; } catch {}
  return { storage, session, caches: globalThis.caches, dropPush: () => dropPush(false), reset: () => { if (Run) Run.discard(); else runP?.then((m) => m.discard()).catch(() => {}); }, priorOwner: cachedBootOwner,
    ask: () => confirm('這台裝置上有之前留下的課表設定、未送出的訓練紀錄或跑到一半的紀錄，不確定是誰的。\n\n是你的嗎？按「確定」保留，按「取消」清除。') };
};
// 上次 /api/me?boot=1 的暫存是誰的（主人不明的裝置用來認出主人；只讀不用它畫畫面）
async function cachedBootOwner() {
  try { const hit = await (await caches.open(Device.API_CACHE)).match('/api/me?boot=1'); return hit ? (await hit.json())?.member?.id || null : null; } catch { return null; }
}
const lsOrNull = () => { try { return localStorage; } catch { return null; } };
// guest：伺服器明確回覆「沒有登入」（不是斷線）時才清 API 暫存，一次載入只清一次
//   回傳 bindOwner 的結果（'same'｜'adopted'｜'bound'｜'switched'｜'none'）
function bindDeviceData(id, guest = false) {
  if (id) {
    sessionPurged = false;
    return Device.bindOwner(id, deviceDeps()).catch(() => 'none');
  }
  if (guest && !sessionPurged) { sessionPurged = true; Device.sessionEnded(deviceDeps()).catch(() => {}); }
  return Promise.resolve('none');
}
let sessionPurged = false;
// 登入狀態過期時關掉的推播（device.js 的 sessionEnded）：同一個人重新登入、通知權限還在，就自動重新開啟
//   Safari 要使用者按一下才能訂閱：自動開不成功就提示一次，按「重新開啟」再開
let resuming = false;
async function resumePush() {
  if (resuming || !me || meStale || !cfg.vapid) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !Device.takeResume(lsOrNull(), me.id)) return;
  resuming = true;
  try {
    await Device.pushReady();
    const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!reg?.pushManager) return;
    try {
      const s = (await reg.pushManager.getSubscription().catch(() => null)) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(cfg.vapid) });
      const j = s.toJSON();
      await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
      Device.markPush(lsOrNull(), me.id);
    } catch {
      toast('登入過期時關掉了這支手機的推播', { action: '重新開啟', ms: 10000, onAction: () => togglePush(null) });
    }
  } finally { resuming = false; }
}
// 登出前：這台裝置的推播訂閱先從伺服器刪掉，再取消瀏覽器端的訂閱（登出後不再收到這個帳號的推播）
//   回傳這台原本有沒有推播訂閱（登入過期時 device.js 用來決定之後要不要自動重新開啟）
async function dropPush(server = true) {
  try {
    const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 1500))]);
    const sub = await reg?.pushManager?.getSubscription().catch(() => null);
    if (!sub) return false;
    if (server) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    Device.markPush(lsOrNull(), null);
    return true;
  } catch { return false; }
}
// 提示：可以帶一個動作（例如刪除後的「復原」）；focus 把焦點移到動作按鈕
// 時間到或被下一則提示取代時呼叫 onExpire（參數：焦點當時是否在提示裡）；滑鼠停在上面或焦點在裡面時先不關
// 句子裡夾著使用者的名字：名字標 translate="no"，英文模式只翻固定的字，名字照原樣（toast 用 textContent，不能直接放 HTML）
// 用法：rich('已移出 2 人，待退費：', names(['王小明', '李大華']))；相鄰的字串併成同一段，句型才比對得到
const keep = (name) => ({ keep: String(name) });
const names = (list, sep = '、', fmt = (x) => [keep(x)]) => list.flatMap((x, i) => [...(i ? [sep] : []), ...fmt(x)]);
function rich(...parts) {
  const f = document.createDocumentFragment();
  let buf = '';
  const flush = () => { if (buf) f.append(buf); buf = ''; };
  for (const p of parts.flat(Infinity)) {
    if (p == null || p === '' || p === false) continue;
    if (typeof p === 'object' && 'keep' in p) { flush(); const b = document.createElement('bdi'); b.translate = false; b.textContent = p.keep; f.append(b); } else buf += String(p);
  }
  flush();
  return f;
}
// 提示泡泡：放進常駐的播報區（#toasts，role=status，頁面一載入就在）——iPhone VoiceOver 對「插入時就帶文字的 live region」常常不唸，
//   放進已經存在的播報區才唸得到。say：只給螢幕閱讀器多唸的補充（例如「6 秒內可以按復原」），畫面上不顯示
function toast(msg, { action, onAction, onExpire, focus = false, ms = 2600, say = '' } = {}) {
  const host = $('#toasts') || document.body;
  const prev = host.querySelector('.toast'); if (prev) { prev.remove(); prev.expire?.(); }
  const el = document.createElement('div');
  el.className = 'toast';
  const m = document.createElement('span');
  if (msg instanceof Node) m.append(msg); else m.textContent = msg;
  el.append(m);
  // 補充播報前加句號（自己一個文字節點，英文介面照樣翻）：VoiceOver 在訊息與說明之間會停一下，不會連成一句
  if (say) { const sr = document.createElement('span'); sr.className = 'sr'; sr.append('。', document.createTextNode(say)); el.append(sr); }
  let done = false;
  el.expire = () => { if (done) return; done = true; const had = el.contains(document.activeElement); el.remove(); onExpire?.(had); };
  let b;
  if (action) {
    b = document.createElement('button');
    b.type = 'button'; b.className = 'toastbtn'; b.textContent = action;
    b.onclick = () => { if (done) return; done = true; el.remove(); onAction?.(); };
    el.append(b);
  }
  host.append(el);
  if (focus) b?.focus();
  const later = () => { if (done) return; if (el.matches(':hover, :focus-within')) setTimeout(later, 1500); else el.expire(); };
  setTimeout(later, ms);
}
// 只給螢幕閱讀器的播報（換頁的頁名、畫路線的說明…）：先清空、稍後再寫，同一句話連續兩次也會唸
function announce(msg) {
  const live = $('#nlive'); if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 60);
}
// 表單欄位的錯誤：錯誤文字放在欄位下方並用 aria-describedby 綁上、欄位標 aria-invalid、焦點移過去；改了欄位就清掉
//   el：要拿焦點的欄位；also：同一個錯誤也要標紅的其他欄位（例如距離與時間）；anchor：錯誤文字放在誰後面（預設欄位的 label 或 fieldset）
function fieldError(el, msg, { also = [], anchor } = {}) {
  if (!el) { toast(msg); return; }
  const id = `${el.name || el.dataset.q || 'f'}Err`.replace(/[^\w-]/g, '');
  // chip 型的單選、複選：錯誤放在整組選項（fieldset 或 .chips）後面，不會擠在第一個選項後面
  const box = anchor || (el.closest('.chip') && (el.closest('fieldset') || el.closest('.chips'))) || el.closest('fieldset, label') || el;
  let p = document.getElementById(id);
  if (!p) { p = document.createElement('p'); p.id = id; p.className = 'ferr'; box.after(p); }
  p.textContent = msg;
  const all = [el, ...also].filter(Boolean);
  for (const x of all) {
    x.setAttribute('aria-invalid', 'true');
    const d = (x.getAttribute('aria-describedby') || '').split(' ').filter((v) => v && v !== id);
    x.setAttribute('aria-describedby', [...d, id].join(' '));
  }
  const clear = () => { p.remove(); for (const x of all) { x.removeAttribute('aria-invalid'); const d = (x.getAttribute('aria-describedby') || '').split(' ').filter((v) => v && v !== id); if (d.length) x.setAttribute('aria-describedby', d.join(' ')); else x.removeAttribute('aria-describedby'); } };
  for (const x of all) x.addEventListener(x.type === 'radio' || x.type === 'checkbox' ? 'change' : 'input', clear, { once: true });
  el.focus();
  if (!el.matches(':focus')) el.closest('fieldset')?.querySelector('input')?.focus();
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
  return `<fieldset class="addrfield" data-addr="${name}"><legend><span>${label}</span>${hint ? `<span class="tiny">${hint}</span>` : ''}</legend>
    <div class="addrsel"><select data-a="city" aria-label="縣市"><option value="">縣市</option></select>
      <select data-a="dist" aria-label="鄉鎮市區" disabled><option value="">鄉鎮市區</option></select></div>
    <div class="addrstreet"><output class="zip num" data-a="zip" aria-label="郵遞區號" data-ph="${esc(I18N.t('郵遞區號'))}"></output><input data-a="street" maxlength="100" autocomplete="off" placeholder="路名、段、巷、弄、號、樓" aria-label="路名與門牌"></div>
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
const KIND_NAME = { track: '田徑場團練', core: '核心日', long: '長跑團練', race: '賽事', party: '餐敘聚會', survey: '問卷調查', buy: '團購', claim: '索票', other: '活動' };
// 時間暫定：自成一個元素（英文介面靠字典整句翻譯）；索票不加「集合」、餐敘是「開始」；索票的數量單位是「張」
const tbdTag = (e) => (e.time_tbd ? '<span class="tbdtag">（暫定）</span>' : '');
const gatherVerb = (e) => (e.kind === 'claim' ? '' : e.kind === 'party' ? '開始' : '集合');
const unitOf = (e) => (e.kind === 'claim' ? '張' : '人');
// 時間：「19:15 集合（暫定）」（標示放在動詞後面，英文才會是 Meet at 19:15 (tentative)）；沒填時間但勾了暫定＝「時間待定」
//   verb 傳 '' 不加動詞（卡片的時間地點列、分享預覽）
const timeHtml = (e, verb = gatherVerb(e)) => (e.gather_time ? `${esc(e.gather_time)}${verb ? ` ${verb}` : ''}${tbdTag(e)}`
  : e.time_tbd && e.kind !== 'survey' ? '<span class="tbdtag">時間待定</span>' : '');
// 自己的報名狀態：索票說「已登記」
const signedWord = (e) => (e.kind === 'claim' ? '已登記' : '已報名');
// 伺服器的時間（UTC 'YYYY-MM-DD HH:MM:SS'）→ 台北「10/5 21:03」
const tpAt = (ts) => (ts ? tpShort(new Date(Date.parse(`${ts.replace(' ', 'T')}Z`) + 8 * 3600e3).toISOString().slice(0, 16)) : '');
const ROLE_NAME = { chair: '理事長', director: '理事', supervisor: '監事', staff: '行政人員', coach: '教練', member: '團員' };
const allow = (p) => !!me?.can?.includes(p);
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const d2 = (d) => new Date(`${d}T00:00:00`);
const dayLabel = (s) => s.replace('週五或週六', '週五／六').replace('週一或週三', '週一／三').replace('週二或週三', '週二／三').replace('週四或週五', '週四／五').replace('週三或週五', '週三／五').replace('週三或週六', '週三／六');
const fixText = (s) => s.replace(/\brep(\d)/g, 'rpe$1');
const dstr = (d, meta) => { const x = d2(d); return meta ? `${x.getMonth() + 1}/${x.getDate()} 週${WD[x.getDay()]}` : `${x.getMonth() + 1}/${x.getDate()}（${WD[x.getDay()]}）`; };
// meta：接在「・」前面的精簡日期（10/10 週六）。Safari 不會把「）・」兩個全形標點的空白收掉，中間會空一大格
const avatar = (s) => s.avatar
  ? `<img class="av" src="${esc(s.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="av" aria-hidden="true">${esc((s.name || '?').slice(0, 1))}</span>`;

let me = null, cfg = {};
// me 是開 App 時先畫用的上次資料（還沒跟伺服器確認）：這段時間不補傳離線紀錄、不自動重新開啟推播
let meStale = false;
// 開啟 App 時 /api/me?boot=1 一起帶回的首頁資料（活動、今天的訓練紀錄），各用一次就丟掉
let bootData = null;
const takeBoot = (k) => { if (!bootData || bootData.today !== ymd(new Date()) || bootData[k] == null) return null; const v = bootData[k]; bootData[k] = null; return v; };
// 先畫後抓：上次的 /api/me?boot=1 還在手機裡（Service Worker 暫存）就先用它畫，網路回來再悄悄更新
//   只用屬於這台裝置目前主人的那份（上一位的登入狀態過期後，不會用他的首頁先畫出來）
async function peekBoot() {
  try { const hit = await (await caches.open(Device.API_CACHE)).match('/api/me?boot=1'); return hit ? Device.bootFor(await hit.json(), localStorage) : null; } catch { return null; }
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
// 團員揪團（功能開關 meetup，預設關閉）：沒有建立活動權限的團員，可以在自己參加的分團發起（伺服器會再檢查一次）
const meetupTeams = () => (cfg.settings?.features?.meetup === true ? myTeams().filter((t) => !teamAllow(t.id, 'event')) : []);
// 推薦人（協會在功能開關打開才有）：首頁卡、開始使用的第 4 步、登入頁的說明、「我的 → 推薦人」的表單
//   關掉後已經填的推薦人、我推薦的跑友照樣看得到，也照樣可以移除、按「不是我」
const refOn = () => cfg.settings?.features?.referral === true;
// 成績與挑戰（功能開關 achieve、achieve_rank，預設關閉；不能用預設開的 feat()）：關掉後已有的成績、挑戰照樣看得到、可以刪除
const achOn = () => cfg.settings?.features?.achieve === true;
const achRankOn = () => achOn() && cfg.settings?.features?.achieve_rank === true;
// 審核成績、設定挑戰（理事長、行政人員）；監事只看挑戰清單與彙總
const achApprover = () => allow('achieve') && me?.role !== 'supervisor';
const achViewer = () => achApprover() || me?.role === 'supervisor';
const canMeetup = (tid) => meetupTeams().some((t) => !tid || t.id === tid);
// 活動類型的標籤：團員發起的揪團標「揪團」
const kindLabel = (e) => (e.owner_managed && e.kind === 'other' ? '揪團' : KIND_NAME[e.kind] || '活動');
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
// 拆出去的模組（me.js）改登入狀態：import 進去的 me、cfg 是唯讀的，要經過這裡改；只給 m 就只改 me
const setMe = (m, c) => { me = m; if (c !== undefined) cfg = c; };

// 大標題：頁面最上方的 Large Title；捲出畫面後，標題縮到頂部列中間（iOS 行為）
function largeTitle(title, sub = '', action = '') {
  $('#ctitle').textContent = title;
  // tabindex=-1：收起卡片、導覽結束時可以把焦點放回大標題（VoiceOver 從頁首開始唸）
  return `<header class="lt"><div><h1 tabindex="-1">${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${action}</header>`;
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
  chevL: ic('<path d="M14.5 5.5 8 12l6.5 6.5"/>'), chevR: ic('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
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
//   hints：['hybrid'] 先出現「用其他裝置」的 QR Code（舊手機不在身邊時；不支援的瀏覽器忽略，照樣可以在選單裡選）
async function passkey(purpose, name, { hints } = {}) {
  if (!pkSupported()) throw new Error('這個瀏覽器不支援通行金鑰，請用 iPhone 的 Safari 或 Chrome');
  const { cid, publicKey: o } = await api('/passkey/options', { method: 'POST', body: { purpose } });
  const pk = { ...o, challenge: b64uToBuf(o.challenge) };
  if (o.user) pk.user = { ...o.user, id: b64uToBuf(o.user.id) };
  if (o.excludeCredentials) pk.excludeCredentials = o.excludeCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  if (o.allowCredentials) pk.allowCredentials = o.allowCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  if (hints) pk.hints = hints;
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
// 協會開了幹部兩步驟驗證、這次登入還沒驗證的幹部：用 Google 登入回來（#/?mfa=1 有通行金鑰｜#/?mfa=add 還沒有），
//   或這個分頁第一次打開時，跳出說明（每個分頁一次）。WebKit 的通行金鑰要使用者手勢：一定等他按「用通行金鑰驗證」；按「稍後」留著首頁的提示列
async function mfaSheet() {
  const [path, qs] = location.hash.split('?'), sp = new URLSearchParams(qs || ''), q = sp.get('mfa');
  if (q) { sp.delete('mfa'); try { history.replaceState(null, '', `${path || '#/'}${sp.toString() ? `?${sp}` : ''}`); } catch {} }
  if (!me?.mfaPending || document.querySelector('.sheet')) return;
  try { if (!q && sessionStorage.getItem('cil-mfa-sheet')) return; sessionStorage.setItem('cil-mfa-sheet', '1'); } catch {}
  const has = q === '1' || (q !== 'add' && !!(await api('/passkeys').catch(() => ({ passkeys: [] }))).passkeys?.length);
  if (!me?.mfaPending || document.querySelector('.sheet')) return;
  const why = `你是<span translate="no">${esc(me.realRoleName || '幹部')}</span>。協會要求幹部用通行金鑰再確認一次，驗證後才有管理權限。`;
  const s = openSheet(has ? '完成登入：用通行金鑰驗證' : '完成登入：先新增一把通行金鑰', has
    ? `<h3 id="mfaT">完成登入：用通行金鑰驗證</h3><p class="muted" style="margin:0">${why}</p>
      <div class="choices gstep"><button type="button" class="btn block" data-go>${IC.lock}用通行金鑰驗證</button><button type="button" class="btn ghost block" data-close>稍後</button></div>`
    : `<h3 id="mfaT">完成登入：先新增一把通行金鑰</h3><p class="muted" style="margin:0">${why}你還沒有通行金鑰，先到「帳號與安全」新增一把。</p>
      <div class="choices gstep"><a class="btn block" href="#/me/security" data-close>前往帳號與安全</a><button type="button" class="btn ghost block" data-close>稍後</button></div>`, null, 'mfaT',
    // 按「稍後」關掉：焦點移到首頁提示列的「驗證」（VoiceOver 不會停在空白處）
    { onClose: () => setTimeout(() => { if (document.activeElement === document.body || !document.activeElement) $('.mfabar [data-stepup]')?.focus(); }) });
  const go = s.host.querySelector('[data-go]');
  go?.addEventListener('click', async () => {
    go.disabled = true;
    try { await passkey('stepup'); s.close(); toast('驗證完成，可以使用管理功能了'); me = null; render(); }
    catch (e) {
      if (go.isConnected) go.disabled = false;
      if (/還沒有通行金鑰/.test(e.message)) { s.close(); location.hash = '#/me/security'; } else if (e.message !== '已取消') toast(e.message);
    }
  });
}
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
// from: 'ref'＝從推薦人頁綁定或確認（登入後回到推薦人頁）；basic：只用名稱與大頭貼登入（不給 Email）
const googleHref = (link, { from, basic } = {}) => {
  const q = [link && 'link=1', link && from && `from=${encodeURIComponent(from)}`, basic && 'basic=1'].filter(Boolean).join('&');
  const path = `/api/google/start${q ? `?${q}` : ''}`;
  return inAppBrowser() === 'line' ? `${location.origin}/?openExternalBrowser=1${location.hash || '#/'}` : path;
};

// ---------- 登入 ----------
function loginView() {
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('err');
  // 從分享連結進來（#/e/:id）：t 是邀請代碼；入場報到（#/e/:id/attend?t=）等活動底下的頁面，t 是報到代碼，不能當邀請代碼，登入後回到原本那一頁
  const sm = location.hash.match(/^#\/e\/([\w-]+)(\/[^?]*)?/), shared = sm?.[1], sharedPage = !!sm && !sm[2];
  const sharedTok = sharedPage ? new URLSearchParams(location.hash.split('?')[1] || '').get('t') : null;
  const feat = [[IC.megaphone, '團練報名', '公告、接龍、候補自動遞補'], [IC.calendar, '分組課表', '照組別換算配速'], [IC.runner, 'GPS 跑步', '自動暫停、分段、GPX'], [ic('<path d="M4 8.2a2 2 0 0 1 2-2h1.9l1.5-2h5.2l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.6" r="3.6"/>'), '拍照分享', '成績與路線放進照片']];
  const compact = !!(shared || err);
  const lead = `<div id="sharedEv"></div>
    ${err ? `<div class="notice err" role="alert">${esc(err)}</div>` : ''}`;
  view.innerHTML = `
    <section class="welcome${compact ? ' compact' : ''}">
      <img class="wmark" src="/icons/icon-192.png" alt="" width="96" height="96">
      <h1 class="wtitle">${esc(org().short || '耕跑團')}</h1>
      <p class="wsub" translate="no">CULTIVATION IN LIFE RUN</p>
      <p class="wlead">一起練，跑得更遠</p>
      ${compact ? '' : `<ul class="wfeat">${feat.map(([i, t, d]) => `<li><span class="wic">${i}</span><b>${t}</b><span class="tiny">${d}</span></li>`).join('')}</ul>`}
    </section>
    ${lead}
    <section class="card authcard">
      ${cfg.googleLogin ? `<a class="btn google block" href="${googleHref()}">${GOOGLE_G}<span>${inAppBrowser() === 'line' ? '用瀏覽器開啟並以 Google 登入' : '使用 Google 帳號登入'}</span></a>
      ${refOn() && /取消/.test(err || '') ? `<p class="tiny center" style="margin:0">不想提供 Email 也可以只用名稱與大頭貼登入；之前已經用 Google 確認過的話，要到「我的 → 隱私」關閉「讓我推薦的跑友用 Gmail 找到我」。</p><a class="btn ghost block" href="${googleHref(false, { basic: true })}">只用名稱與大頭貼登入</a>` : ''}
      ${inAppBrowser() === 'line' ? '<p class="tiny center" style="margin:0">Google 不允許在 LINE 裡登入，按上面的按鈕會改用 Safari 或 Chrome 打開這個網站。</p>' : ''}
      ${inAppBrowser() === 'meta' ? '<p class="notice" style="margin:0">Google 不允許在 Facebook／Instagram 裡登入：請點右上角「⋯」選「在瀏覽器開啟」。</p>' : ''}
      ${pkSupported() ? `<button class="btn ghost block iconbtn" id="pkLogin">${IC.lock}用通行金鑰登入</button>` : ''}
      <p class="tiny center">${refOn() ? '只取得你的 Google 名稱和大頭貼；Email 只拿來算一組無法還原的查詢碼，讓你推薦的跑友找得到你，Email 本身不保存。不會讀取你的信件或雲端資料。' : '只取得你的 Google 名稱和大頭貼，不會取得 Email、不會讀取你的信件或雲端資料。'}<br>登入即表示你已閱讀並同意<a href="#/privacy">隱私權政策</a>。</p>` : ''}
      <details ${cfg.googleLogin ? '' : 'open'}>
        <summary class="muted" style="cursor:pointer">用邀請碼加入</summary>
        <form id="joinForm" style="margin-top:12px">
          <label>邀請碼<input name="code" required autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="LINE 群公告的代碼"></label>
          <label>姓名<input name="name" required maxlength="20" autocomplete="name" placeholder="報名時顯示的名字"></label>
          <div class="grid2 g-dist">
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
      <h2 class="h3">${esc(org().name || '台灣耕跑團協會')}</h2>
      <p class="muted" style="margin:0">入會申請使用協會的 Google 表單。</p>
      ${org().join_form ? `<a class="btn ghost block" href="${esc(org().join_form)}" target="_blank" rel="noopener">開啟入會表單</a>` : ''}
    </section>
    <div class="seg langseg themeseg" role="group" aria-label="Language" translate="no"><button data-lang="zh" aria-pressed="${I18N.lang === 'zh'}">中文</button><button data-lang="en" aria-pressed="${I18N.lang === 'en'}">English</button></div>`;
  for (const b of document.querySelectorAll('[data-lang]')) b.onclick = () => { if (b.dataset.lang !== I18N.lang) I18N.setLang(b.dataset.lang); };
  // 從分享連結進來：記住要去的活動，登入後直接帶過去
  if (shared) {
    try { sessionStorage.setItem('cil-after-login', sharedPage ? `#/e/${shared}${sharedTok ? `?t=${encodeURIComponent(sharedTok)}` : ''}` : location.hash); } catch {}
    api(`/public/e/${shared}${sharedTok ? `?t=${encodeURIComponent(sharedTok)}` : ''}`).then(({ event: e }) => {
      $('#sharedEv').innerHTML = `<section class="card shared">
        <span class="tiny">${e.visibility === 'invite' ? `${IC.lock} 你收到一個邀請制活動的邀請` : `有人邀請你${e.kind === 'survey' ? '填寫問卷' : '報名'}`}</span>
        <div class="row" style="gap:6px">${e.team ? `<span class="pill">${esc(e.team)}</span>` : ''}<span class="pill ${e.kind}">${kindLabel(e)}</span>${phasePill(e, e.full)}</div>
        <h2 style="margin:0"><span translate="no">${esc(e.title)}</span></h2>
        <p class="muted" style="margin:0">${dstr(e.date)}${timeHtml(e, '') ? ` ${timeHtml(e, '')}` : ''}${e.place ? `・<span translate="no">${esc(e.place)}</span>` : ''}</p>
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
    f.grp.innerHTML = Object.entries(P.groups(f.dist.value)).map(([g, v]) => `<option value="${g}">${g} 組 ${v[0]}</option>`).join('');
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
// 改成 5 格後清掉一次舊的「只顯示圖示」（那是 6 格太擠時選的）：每個人先看到一次有文字的版本，想要可以再打開
try { if (!localStorage.getItem('cil-nav-v2')) { localStorage.removeItem('cil-tab-icons'); localStorage.setItem('cil-nav-v2', '1'); } } catch {}
// 分頁的 aria-label：名稱，加上小點的狀態（跑步記錄中、我的需要處理）；值沒變就不重設（英文介面翻好的不會被蓋回中文）
//   英文介面一律用預設名稱：管理員改的名稱只有中文，逐段翻出來會很長（例如「Training training plan」）而且放不下
const tabNames = () => (I18N.lang === 'en' ? TAB_DEFAULT : { ...TAB_DEFAULT, ...(cfg.settings?.tabs || {}) });
function tabLabel(a) {
  const n = tabNames()[a.querySelector('.tl')?.dataset.tl] || '';
  const v = a.dataset.live === 'paused' ? `${n}，已暫停` : a.dataset.live ? `${n}，記錄中` : a.hasAttribute('data-alert') ? `${n}，需要處理` : n;
  if (a.dataset.lbl !== v) { a.dataset.lbl = v; a.setAttribute('aria-label', I18N.t(v)); }
}
function applyTabs() {
  const names = tabNames();
  for (const el of document.querySelectorAll('.tabs .tl')) el.textContent = names[el.dataset.tl] || el.textContent;
  document.querySelector('.tabs a[data-tab="/me"]')?.toggleAttribute('data-alert', !!me?.mfaPending);
  for (const a of document.querySelectorAll('.tabs > a[data-tab]')) tabLabel(a);
  document.body.classList.toggle('iconsonly', iconsOnly.get());
}
function applyFeatures() {
  applyTabs();
  const s = document.querySelector('.tabs a[data-tab="/studio"]'), r = document.querySelector('.tabs a[data-tab="/run"]');
  if (s) s.hidden = !feat('studio') || feat('gps');   // GPS 開：拍照收進跑步
  if (r) r.hidden = !feat('gps');
  applyNav();
  paintTabs();
}
// 側邊欄的次要項目：拍照分享只在 GPS 開時放這裡（關掉 GPS 時拍照已經是主要分頁）；幹部項目各自檢查權限，一列都沒有就整區不顯示
// 團員訓練：課表教練，或分團團長、幹部（協會層級的名冊權限不算，對齊分享同意書的「教練與分團幹部」）
const coachTeam = (tid) => teamOf(tid)?.my_status === 'active' && !!TEAM_PERMS[teamOf(tid).my_role]?.includes('roster');
const canTeamLogs = () => allow('plan') || teams().some((t) => coachTeam(t.id));
// 週報（#/weekly）：理事長、行政人員（有系統設定權限）看協會版；分團團長看自己帶的第一個分團（有好幾個時頁面上可以切換）；其他人沒有
//   伺服器另外依身分檢查（/api/ops/reports），這裡只決定要不要放入口
function weeklyHref() {
  if (!me) return '';
  if (allow('settings')) return '#/weekly';
  const lead = myTeams().find((t) => t.my_role === 'lead');
  return lead ? `#/weekly?team=${encodeURIComponent(lead.id)}` : '';
}
function applyNav() {
  document.querySelector('.navmore a[data-nav="/studio"]').hidden = !(feat('studio') && feat('gps'));
  const wk = weeklyHref(), wa = document.querySelector('.navmore a[data-nav="/weekly"]');
  if (wa && wk) wa.setAttribute('href', wk);
  const ok = { admin: allow('members') || allow('roles') || allow('settings'), settings: allow('settings'), weekly: !!wk, roster: allow('roster'), logs: !!me && canTeamLogs(), publish: !!me && canPublishPlan() };
  for (const a of document.querySelectorAll('.navmore a[data-perm]')) a.hidden = !ok[a.dataset.perm];
  $('#navStaff').hidden = !document.querySelector('.navmore a[data-perm]:not([hidden])');
  document.documentElement.style.setProperty('--n', document.querySelectorAll('.tabs > a[data-tab]:not([hidden])').length);
  fitTabs();
}
// 側邊欄（1024 以上）放不下、還沒捲到底：下緣淡出，看得出下面還有項目
function fitTabs() {
  const t = $('#tabs');
  t.classList.toggle('more', wideNav.matches && t.scrollTop + t.clientHeight < t.scrollHeight - 4);
}
// 分頁的選取狀態：1024 以下用 tabOf；側邊欄在主要與次要項目裡找最精確的那一個（沿著上一層往上找，例如 /t/youth 亮「分團」）。
//   通知頁沿用上一次亮著的分頁；選取膠囊用 --i 滑過去；換頁時縮小的分頁列展開
//   aria-current：這一項就是目前這一頁才用 "page"；子頁的上一層、通知頁沿用的分頁用 "true"（仍唸「目前」，樣式一樣）
const wideNav = matchMedia('(min-width:1024px)');
const curHash = () => location.hash.replace(/^#/, '').split('?')[0] || '/';
let lastHash = '/';
function paintTabs(hash = curHash()) {
  if (hash === '/notifications') hash = lastHash; else lastHash = hash;
  const nav = $('#tabs'), tabs = [...nav.querySelectorAll(':scope > a[data-tab]:not([hidden])')];
  const i = tabs.findIndex((a) => a.dataset.tab === tabOf(hash));
  let cur = tabs[i];
  if (wideNav.matches) {
    const links = [...tabs, ...nav.querySelectorAll('.navmore a:not([hidden])')].filter((a) => !a.closest('[hidden]'));
    cur = null;
    for (let h = hash, k = 0; k < 5 && !cur; k++, h = parentOf(h)[0].slice(1)) cur = links.find((a) => (a.dataset.tab || a.dataset.nav) === h);
  }
  const real = curHash();
  for (const a of nav.querySelectorAll('a[data-tab], a[data-nav]')) { if (a === cur) a.setAttribute('aria-current', (a.dataset.tab || a.dataset.nav) === real ? 'page' : 'true'); else a.removeAttribute('aria-current'); }
  nav.style.setProperty('--i', Math.max(i, 0));
  nav.classList.toggle('nosel', i < 0);
  nav.classList.remove('mini');
  document.body.classList.remove('tasking');   // 地圖畫路線到一半就換頁：分頁列回來
  untype();
}
wideNav.addEventListener?.('change', () => paintTabs());

// 倒數：自己的主要賽事 → 最近的自己的賽事 → 協會預設
//   按鈕的名稱就是畫面上的字（「77天到臺北馬」），後面接一段只給螢幕閱讀器的「，換倒數的比賽」（WCAG 2.5.3：名稱要包含看得到的字）
function paintCountdown() {
  const r = cfg.race, el = $('#countdown');
  el.hidden = !me;
  const hint = '<span class="sr">，換倒數的比賽</span>';
  if (!r?.date) { el.innerHTML = me ? '<small>設定倒數</small>' : ''; el.title = I18N.t('選擇要倒數的比賽'); return; }
  const t = new Date(`${r.date}T00:00:00`), now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((t - now) / 864e5);
  const short = r.name.replace(/^20\d\d\s*/, '').replace('馬拉松', '馬').slice(0, 7);
  // 比賽名稱是使用者或賽事資料的原文：英文介面不翻（translate="no"），只翻固定的字
  const nm = `<span translate="no">${esc(short)}</span>`;
  el.innerHTML = days > 0 ? `<b class="num">${days}</b>天到${nm}${hint}` : days === 0 ? `<b>今天</b>${nm}${hint}` : '<small>設定倒數</small>';
  el.title = I18N.lang === 'en' ? `${r.name} (${r.date}). ${I18N.t('點一下可以換')}` : `${r.name}（${r.date}），點一下可以換`;
}
// 點右上角倒數：選要倒數哪一場（自己的賽事、常用賽事清單、協會預設，或不顯示）
//   共用 openSheet：焦點移到目前倒數的那一場、Tab 不會跑到後面、Esc 關閉，關掉後焦點回到倒數按鈕
async function countdownPicker() {
  if (!me) return;
  $('#cdSheet')?.remove();
  const opener = document.activeElement?.closest?.('button, a') || $('#countdown');
  const d = await api('/races');
  const days = (date) => Math.round((new Date(`${date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const upcoming = d.races.filter((r) => days(r.date) >= 0);
  const mineIds = new Set(d.races.map((r) => `${r.name}|${r.date}`));
  const presets = d.presets.filter((p) => !mineIds.has(`${p.name}|${p.date}`));
  const on = (x) => (x ? ' on" aria-current="true' : '');
  const s = openSheet('選擇倒數的比賽', `
    <div class="row spread"><h3 id="cdT">倒數哪一場比賽</h3><button type="button" class="btn ghost sm" data-close>完成</button></div>
    <div class="cdlist">
      ${upcoming.map((r) => `<button type="button" class="cdopt${on(d.mode === 'mine' && r.is_primary)}" data-race="${r.id}"><span><b><span translate="no">${esc(r.name)}</span></b><span class="tiny">${esc(r.date)}${r.dist ? `・${esc(r.dist)}` : ''}${r.goal ? `・目標 ${esc(r.goal)}` : ''}</span></span><span class="num">${days(r.date)} 天</span></button>`).join('')}
      ${d.club ? `<button type="button" class="cdopt${on(d.mode === 'club')}" data-mode="club"><span><b><span translate="no">${esc(d.club.name)}</span></b><span class="tiny">協會預設・${esc(d.club.date)}</span></span><span class="num">${days(d.club.date)} 天</span></button>` : ''}
      <button type="button" class="cdopt${on(d.mode === 'off')}" data-mode="off"><span><b>不顯示倒數</b></span></button>
    </div>
    ${presets.length ? `<h3 style="margin-top:6px">常用賽事</h3><div class="cdlist">${presets.map((p, i) => `<button type="button" class="cdopt" data-preset="${i}"><span><b><span translate="no">${esc(p.name)}</span></b><span class="tiny">${esc(p.date)}${p.dist ? `・${esc(p.dist)}` : ''}</span></span><span class="tiny">加入並倒數</span></button>`).join('')}</div>` : ''}
    <details><summary class="tiny" style="cursor:pointer">自己新增一場</summary>
      <form id="cdAdd" class="filters" style="margin-top:8px">
        <input name="name" maxlength="30" placeholder="比賽名稱，例如 2027 東京馬拉松" required aria-label="比賽名稱">
        <div class="grid2"><input type="date" name="date" required aria-label="比賽日期"><input name="goal" maxlength="10" placeholder="目標成績（選填）" aria-label="目標成績"></div>
        <button class="btn sm">加入並倒數</button></form></details>`, opener, 'cdT');
  const sheet = s.host;
  sheet.id = 'cdSheet';
  sheet.querySelector('.cdopt.on')?.focus();
  const done = async (msg) => { const r = await api('/me'); cfg = r; me = r.member; s.close(); paintCountdown(); toast(msg); };
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-race],[data-mode],[data-preset]'); if (!t) return;
    try {
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
    if (block.startsWith('## ')) return `<h2 class="h3">${block.slice(3)}</h2>`;
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');
}
// 隱私權政策每次改版的重點：要重新同意時放在最上面，不用整篇讀完才知道改了什麼
const PRIVACY_CHANGES = {
  '2026-10-08.1': ['協會開放「成績與挑戰」時，可以登錄比賽成績（距離、時間、賽事名稱、日期、官方成績連結或截圖），由理事長或行政人員審核；截圖在審核完成 7 天後自動刪除，只留成績連結',
    '參加需要在現場量體重的挑戰時要逐場同意：見證的幹部在現場會看到體重計；系統把體重加密保存，只用來判定是否達成，其他幹部與跑友都查不到數字，挑戰結束 30 天後自動刪除，你隨時可以刪除或退出、立即刪除；自主聲明的體重挑戰不上傳體重',
    '「恭喜榜」預設不出現；在「我的 → 隱私」打開後，登入的跑友才看得到你的名字、通過審核的 PB 成績與完成的挑戰；各距離的 PB 排行要另外打開；體重挑戰一律不上榜'],
  '2026-10-07.1': ['報名時可以替同行的親友填攜伴姓名（選填），只有該活動的主辦看得到，公開名單只顯示「＋人數」；請先徵得對方同意', '報名時給主辦的備註改成只有主辦看得到，不再出現在公開名單',
    '協會開放「團員揪團」時，團員自己發起的揪團，發起人就是主辦：看得到報名者的姓名、給主辦的備註與攜伴姓名',
    '協會開放「推薦人」時，可以填是誰介紹你來的：選跑友帳號（對方會收到通知，可以按「不是我」移除），或只填名字（最多 20 字）；推薦關係只有會員管理權限的協會幹部看得到，每次查看都有稽核紀錄',
    '用 Google 登入時，Email 只拿來算一組無法還原的查詢碼，讓你推薦的跑友用 Gmail 找到你；Email 本身不保存，可以在「我的 → 隱私」關閉'],
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
      <h2 class="h3">一、蒐集目的</h2>
      <p>〇五二 法人或團體對會員之內部管理（團練報名、分組課表、會籍管理）；〇六九 契約、類似契約或其他法律關係事務（活動報名、入場與抽獎）；一三五 資（通）訊服務（通知推播）。</p>
      <h2 class="h3">二、蒐集的資料</h2>
      <p>識別類（C001）：姓名、暱稱、Google 帳號的顯示名稱與大頭貼、電話（選填）；協會開放「推薦人」時，另外保存一組由你的 Google Email 算出、無法還原的查詢碼（不保存 Email 本身），讓你推薦的跑友輸入你的 Gmail 時找得到你，可以在「我的 → 隱私」關閉，關閉後立即刪除。<br>
         活動相關：項目與組別、所屬跑團、加入的分團與分團身分、餐點偏好、報名與報到紀錄、給主辦的備註、活動問卷的回答、中獎紀錄。<br>
         攜伴姓名（選填）：你報名時替同行親友填的姓名，只有該活動的主辦看得到，公開名單只顯示攜伴人數；請先徵得對方同意。<br>
         推薦人（選填）：誰介紹你加入，可以選跑友帳號或只填名字；用途是團購或活動聯絡不上時，協會幹部能透過介紹人協助聯繫。選跑友帳號時，對方會收到通知並看得到你的名字，對方可以按「不是我」移除；推薦人刪除帳號後只顯示「已刪除」，不留名字。<br>
         系統紀錄：登入時間、裝置型號摘要、IP 位址的單向雜湊值（無法還原）；App 的開啟速度與錯誤訊息只記裝置類型與頁面，不記是誰，保留 90 天。<br>
         個人賽事：你自己加入的賽事名稱、日期與目標成績（用於倒數）。<br>
         訓練紀錄：你照課表記錄的日期、距離、時間、心率、自覺強度、感覺與備註；預設只有你看得到，你打開分享後，教練與分團幹部只看得到完成率、里程與平均強度，看不到備註。<br>
         比賽成績（選填）：你登錄的比賽距離、完賽時間、賽事名稱與日期、號碼布、官方成績連結或截圖，以及給審核的說明；只有你自己與審核的協會幹部看得到，你打開「恭喜榜」後，登入的跑友才看得到你的 PB 與完成的挑戰，另外打開「PB 排行」才會列入排名。截圖與給審核的說明在審核完成 7 天後自動刪除；沒有通過或被撤銷的成績 180 天後刪除。<br>
         挑戰紀錄（選填）：參加的挑戰、是否達成、團服尺寸與發放紀錄；挑戰發布後刪掉會影響比較基準的成績時，只記下是哪個挑戰（不留成績），那個挑戰的達成改由幹部確認；分團挑戰的團長與幹部看得到團員的參加狀態與團服尺寸，看不到成績與體重；體重挑戰只看得到有團服名額的人。<br>
         體重（選填，敏感資料）：只有參加需要在團練現場量體重的挑戰、並逐場勾選同意時才蒐集；量測時由你選一位在場的幹部看體重計輸入讀數，那位幹部當下會看到數字；系統<b>加密後保存</b>，只用來判定是否達成，幹部與其他跑友都無法查詢，也不會知道你有沒有達成；挑戰結束 30 天後自動刪除，你隨時可以在挑戰頁刪除或退出，立即刪除。自主聲明的體重挑戰只記錄你是否聲明達成，不上傳體重。<br>
         照片：拍照分享的照片在你的手機上合成，不會上傳到我們的伺服器。<br>
         賽事報名資料（選填）：只有你需要幹部代為報名馬拉松等賽事時才填，包含中英文姓名、身分證字號或護照號碼、生日、性別、電話、Email、地址、緊急聯絡人與衣服尺寸；<b>加密後保存</b>，只有你自己看得到完整內容。<br>
         協會入會申請另以協會的 Google 表單辦理。</p>
      <h2 class="h3">三、利用期間、地區、對象與方式</h2>
      <p>期間：${esc(PRIVACY.retention)}。<br>
         地區：台灣，以及雲端服務（Cloudflare）的資料中心所在地。<br>
         對象：依職務最小權限開放給協會幹部；分團團長與幹部可以看自己分團的名冊（不含電話）與該分團活動的報名及問卷結果；協會開放團員揪團時，團員自己發起的揪團由發起人擔任主辦，看得到報名者的姓名、給主辦的備註與攜伴姓名（不含電話與繳費資料）；電話完整號碼只有行政人員看得到。賽事報名資料只在你報名「代為團體報名」的活動並勾選同意後，提供給該活動的主辦幹部，用來向賽事主辦單位送出團體報名，每次下載都留有稽核紀錄。通訊地址存檔前會送到中華郵政的 3+3 郵遞區號服務核對寫法並補上郵遞區號，只傳送地址文字。練跑地圖的「附近即時影像」由本站伺服器向政府公開攝影機取得畫面再轉給你，你的 IP 與位置不會傳給影像來源，本站也不保存影像。推薦關係（誰推薦誰）只有具會員管理權限的協會幹部（理事長、理事、監事、行政人員）在管理後台看得到，監事只能查看，每次查看都留有稽核紀錄；分團幹部看不到。<span>比賽成績由具「成績與挑戰」權限的協會幹部（預設為理事長與行政人員）審核；團服名單（姓名、暱稱、分團與尺寸）只提供給負責發放的協會幹部與該分團幹部；給廠商訂製的只有各尺寸的件數，不含姓名。</span>不提供給第三方行銷使用。<br>
         方式：以電子方式處理，全程加密傳輸。</p>
      <h2 class="h3">四、您的權利</h2>
      <p>您可以隨時行使個人資料保護法第 3 條的權利：</p>
      <ul>
        <li>查詢、閱覽、製給複本：「我的 → 隱私 → 下載我的資料」</li>
        <li>補充或更正：「我的 → 個人資料」直接修改</li>
        <li>停止蒐集、處理、利用及刪除：「我的 → 隱私 → 刪除帳號」</li>
      </ul>
      <h2 class="h3">五、不提供資料的影響</h2>
      <p>姓名與組別是報名與排課表的必要資料；不提供就無法報名活動。賽事報名資料只在報名「代為團體報名」的活動時需要，不填不影響其他功能。其他欄位都是選填。<span>比賽成績、挑戰與體重都是選填，不提供只是不能參加對應的挑戰。</span></p>
      <h2 class="h3">六、安全措施</h2>
      <p>存取控制依職務分級、特權操作留有稽核紀錄、登入權杖只存雜湊值，並設有嘗試次數限制。詳見專案的資訊安全設計說明。</p>
      <h2 class="h3">七、聯絡方式</h2>
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
  // 英文的分團名稱比較長：窄螢幕只留「＋」圖示，讓分團 chip 多一點空間（aria-label 照樣唸）
  const teamLink = mine.length ? `<a class="chiplink" href="#/teams" aria-label="分團">${IC.plus}<span class="cltx">分團</span></a>` : '<a class="chiplink" href="#/teams">加入分團 ›</a>';
  // 新帳號（邀請碼加入是 #/?welcome=1）與還沒加到主畫面、還沒開推播的人：最上面是「開始使用」卡（取代以前的歡迎文字與安裝提示卡）
  const welcome = new URLSearchParams(location.hash.split('?')[1] || '').get('welcome');
  // 開始使用卡已經有「填推薦人」這一步：推薦人卡就不再問一次
  const start = startShown(welcome) ? startCard() : '';
  view.innerHTML = `
    ${largeTitle('團練', todayLabel())}
    ${mfaBanner()}
    ${start}
    ${refCard(start.includes('data-step="ref"'))}
    ${me.ach?.needSize > 0 ? `<a class="card tight ach-homecard" href="#/ach"><span class="sic" style="--sc:var(--tile-orange)">${MI.shirt}</span><span class="st"><b>選團服尺寸</b><span class="sr">，</span><span class="tiny">你有團服名額，記得選尺寸</span></span><span class="chev" aria-hidden="true"></span></a>` : ''}
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
      ${anyTeamAllow('event') ? `<a class="btn ghost sm iconbtn" href="#/new${pick && pick !== 'assoc' ? `?team=${esc(pick)}` : ''}">${IC.plus}新增活動</a>`
        : canMeetup() ? `<a class="btn ghost sm iconbtn" href="#/new?meetup=1${pick && canMeetup(pick) ? `&team=${esc(pick)}` : ''}">${IC.plus}發起揪團</a>` : ''}
    </div>
    <div class="evgrid">${events.slice(1).map(eventCard).join('') || `<div class="card">${emptyState('calendar', '目前沒有其他排定的活動')}</div>`}</div>
    <div class="row center" style="gap:18px;justify-content:center"><a class="tiny footlink" href="#/calendar">${IC.calendar} 行事曆</a><a class="tiny footlink" href="#/past">看過去的團練 ›</a></div>
    </div></div>`;
  for (const b of document.querySelectorAll('[data-tf]')) b.onclick = () => { teamFilter.set(b.dataset.tf); listView(); };
  homeWeather(all);
  bindTodayCard();
  if (anyTeamAllow('event')) reviewCard();
  bindStart();
  bindRefCard();
  bindStepup();
  flushLogQueue();
  mfaSheet();
}
// 幹部：報名待審核（畫面畫好後才載入，有資料才顯示）
async function reviewCard() {
  const r = await api('/me/reviews').catch(() => null), box = $('#reviewCard');
  if (!r?.events?.length || !box?.isConnected) return;
  box.innerHTML = `<h3>報名待審核</h3>${r.events.map((e) => `<a class="todayev" href="#/e/${esc(e.id)}/stats?f=pending">${IC.calendar}<span><b><span translate="no">${esc(e.title)}</span></b><span class="tiny" style="display:block">${dstr(e.date, 1)}・${e.n} 筆${e.seatsLeft != null ? `・剩 ${e.seatsLeft} 個名額` : ''}</span></span><span class="tiny">›</span></a>`).join('')}`;
  box.hidden = false;
}
// 首頁「推薦人」卡（協會開放推薦人才有）：用 /api/me 帶的 referral 直接畫，不另外讀資料；一列都不適用就不出現
//   A 還沒填推薦人（開始使用卡已經有這一步就不重複）　B 讓推薦的跑友用 Gmail 找到你（要先用 Google 確認一次）　C 有跑友把你設為推薦人，等你確認
//   A、B 可以收起（記在伺服器，換手機也不會再出現）；C 只要還有人等確認就會出現
function refCard(skipA) {
  const r = me?.referral;
  if (!refOn() || !r) return '';
  const rows = [];
  if (!r.has && !(r.hide & 1) && !skipA) rows.push(['A', MI.referral, '是誰介紹你來耕跑團的？', '填上推薦人，團購或活動聯絡不上時，協會幹部找得到人幫忙。',
    '<a class="btn sm" href="#/me/referral">填推薦人</a><button type="button" class="linkbtn tiny" data-refhide="1">沒有推薦人</button>']);
  if (cfg.googleLogin && r.findable && !r.emailLinked && !(r.hide & 2)) rows.push(['B', MI.shield, '讓你推薦的跑友找得到你',
    me.google ? '用 Google 確認一次，跑友輸入你的 Gmail 就能找到你；只存一組無法還原的查詢碼，不存 Email。' : '用 Google 確認一次，跑友輸入你的 Gmail 就能找到你；只存一組無法還原的查詢碼，不存 Email。也會把 Google 綁到你的帳號。',
    `<a class="btn google sm" href="${googleHref(true, { from: 'ref' })}">${GOOGLE_G}<span>用 Google 確認</span></a><button type="button" class="linkbtn tiny" data-refhide="2">不用了</button>`]);
  if (r.pending > 0) rows.push(['C', MI.team, `${r.pending} 位跑友把你設為推薦人`, '看看是不是你認識的人。', '<a class="btn sm" href="#/me/referral">去確認</a>']);
  if (!rows.length) return '';
  return `<section class="card refcard" id="refCard" aria-labelledby="refTitle">
    <div class="sthead"><h2 id="refTitle" class="h3" tabindex="-1">推薦人</h2>${rows.some(([k]) => k !== 'C') ? `<button type="button" class="iconx" id="refX" aria-label="收起推薦人提示">${ic('<path d="M7 7l10 10M17 7 7 17"/>')}</button>` : ''}</div>
    <ul class="reflist">${rows.map(([k, icon, title, sub, acts]) => `<li data-row="${k}"><span class="stic" aria-hidden="true">${icon}</span>
      <div class="stbody"><b>${title}</b><span class="tiny">${sub}</span><div class="stacts">${acts}</div></div></li>`).join('')}</ul></section>`;
}
// 收起 A（沒有推薦人）、B（不用了）或整張卡的 ✕（A＋B）：先記到伺服器，成功才拿掉；最後一列拿掉時整張卡收起，焦點回到頁面標題
function bindRefCard() {
  const card = $('#refCard');
  card?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-refhide], #refX'); if (!b) return;
    const bits = b.id === 'refX' ? 3 : Number(b.dataset.refhide);
    try { await api('/me/referral/hide', { method: 'POST', body: { bits } }); } catch (err) { toast(err.message); return; }
    if (me?.referral) me.referral.hide = (me.referral.hide || 0) | bits;
    for (const li of card.querySelectorAll('li[data-row]')) if ((li.dataset.row === 'A' && bits & 1) || (li.dataset.row === 'B' && bits & 2)) li.remove();
    announce('已收起，之後可以在「我的 → 推薦人」填寫');
    if (!card.querySelector('li[data-row]')) { card.remove(); focusEl(view.querySelector('h1')); return; }
    if (!card.querySelector('li[data-row="A"], li[data-row="B"]')) $('#refX')?.remove();
    focusEl(card.querySelector('.stacts > :is(a,button)') || $('#refTitle'));
  });
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
    ${todays.map((e) => `<a class="todayev" href="#/e/${e.id}">${IC.calendar}<span><b><span translate="no">${esc(e.title)}</span></b><span class="tiny" style="display:block">${timeHtml(e)}${e.place ? `${timeHtml(e) ? '・' : ''}<span translate="no">${esc(e.place)}</span>` : ''}${e.mine === 'wait' ? '・候補中' : e.mine === 'pending' ? '・審核中' : ''}</span></span><span class="tiny">›</span></a>`).join('')}
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
  if (e.rc) return '<span class="pill wait">請確認</span>';   // 活動有異動，主辦請已報名的人重新確認
  if (e.mine === 'in') return `<span class="pill" style="background:#fff;color:#1C4698">${signedWord(e)}</span>`;
  if (e.mine === 'wait') return '<span class="pill wait">候補中</span>';
  if (e.mine === 'pending') return '<span class="pill wait">審核中</span>';
  if (e.mine === 'rejected') return '<span class="pill no">未通過</span>';
  const st = signupState(e, nowTp());
  if (st === 'cancelled') return glass('已取消');
  if (st === 'off') return glass(e.link_url ? '前往登記 ›' : '未開放報名');   // 用外部連結登記的（例如慶功宴表單）不說「未開放報名」
  if (st === 'soon') return glass(`${tpShort(e.signup_start)} 開放`);
  if (st === 'ended') return glass(e.kind === 'claim' ? '索票已截止' : '報名已截止');
  return glass(e.capacity && e.signed >= e.capacity ? '額滿・可候補' : e.kind === 'claim' ? '去索票 ›' : '去報名 ›');
}
function heroCard(e) {
  const d = d2(e.date), days = Math.round((d - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return `<a class="card hero" href="#/e/${e.id}">
    <span class="sweep" aria-hidden="true"></span>
    <div class="row spread">
      <span class="row" style="gap:6px"><span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${kindLabel(e)}</span>${e.team_id && teamOf(e.team_id) ? `<span class="pill" style="background:rgba(255,255,255,.14);color:#fff"><span translate="no">${esc(teamOf(e.team_id).name)}</span></span>` : ''}</span>
      <span class="tiny">${days <= 0 ? '就是今天' : days === 1 ? '明天' : `${days} 天後`}</span>
    </div>
    <h2><span translate="no">${esc(e.title)}</span></h2>
    <p class="muted" style="margin:0">${dstr(e.date)}${timeHtml(e) ? ` ${timeHtml(e)}` : ''}${e.place ? `・<span translate="no">${esc(e.place)}</span>` : ''}</p>
    <div class="row spread">
      <span class="row" style="gap:8px">${avatarStack(e.peek || [], e.signed)}<span class="tiny"><span>${e.kind === 'claim' ? `已登記 ${e.signed}${e.capacity ? ` / ${e.capacity}` : ''} 張` : `報名 ${e.signed}${e.capacity ? ` / ${e.capacity}` : ''} 人`}</span>${e.waiting ? `<span>・候補 ${e.waiting}</span>` : ''}</span></span>
      ${heroPill(e)}
    </div>
  </a>`;
}
// 報名狀態標籤（活動卡片、沒登入的分享預覽）：報名中、即將開放、額滿可候補、報名已截止、已結束、已取消（索票活動是開放索票、索票已截止）
function phasePill(e, full) { const ph = evPhase(e, nowTp(), full); return `<span class="pill reg-${ph}">${PHASE_LABEL[ph](e)}</span>`; }
//   opt.past：過去的團練（每一張都已結束，不再標「已結束」）；teams.js 用 map(eventCard) 時第二個參數是索引，不影響
function eventCard(e, opt) {
  const pct = e.capacity ? Math.min(100, Math.round(e.signed / e.capacity * 100)) : 0;
  // 自己已經報名（右邊有狀態）：只在活動結束或取消時另外標示；取消過的報名當成沒報名
  const mine = e.mine === 'cancel' ? null : e.mine;
  const full = !!e.capacity && e.signed >= e.capacity, ph = evPhase(e, nowTp(), full), showPh = (!mine || ph === 'over' || ph === 'cancelled') && !(opt?.past === true && ph === 'over');
  // 報名狀態放在時間地點那一行（可以換行）：放在上面的標籤列會把類型、分團、邀請制擠出畫面（手機卡片很窄、標籤列不換行）
  return `<a class="card lit" href="#/e/${e.id}">
    <div class="ev">
      <span class="cal"><u>${d2(e.date).getMonth() + 1}月</u><b class="num">${e.date.slice(8)}</b><span>週${WD[d2(e.date).getDay()]}</span></span>
      <span class="body">
        <span class="pills"><span class="pill ${e.kind}">${kindLabel(e)}</span>${teamTag(teamOf(e.team_id))}${e.visibility === 'invite' ? `<span class="pill lock">${IC.lock}邀請制</span>` : ''}</span>
        <span class="t"><span translate="no">${esc(e.title)}</span></span>
        <span class="tiny meta">${[showPh && phasePill(e, full), timeHtml(e, ''), e.place && `<span translate="no">${esc(e.place)}</span>`,
          (() => { const ps = [...(e.options || []), ...(e.kind === 'buy' ? e.items || [] : [])].map((o) => o.price).filter(Boolean); return ps.length ? `${money(Math.min(...ps))} 起` : e.fee ? money(e.fee) : ''; })()].filter(Boolean).map((x) => `<span>${x}</span>`).join('')}</span>
        ${e.capacity ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}
      </span>
      <span class="evright">${e.rc ? '<span class="mine wait">請確認</span>' : mine === 'in' ? `<span class="mine">${IC.check}${signedWord(e)}</span>` : mine === 'wait' ? '<span class="mine wait">候補中</span>'
        : mine === 'pending' ? '<span class="mine wait">審核中</span>' : mine === 'rejected' ? '<span class="mine no">未通過</span>' : ''}
        ${e.pending ? `<span class="pill wait">待審核 ${e.pending}</span>` : ''}
        ${e.signed ? `${avatarStack(e.peek || [], e.signed)}<span class="tiny num">${e.signed}${e.capacity ? `/${e.capacity}` : ` ${unitOf(e)}`}</span>` : ''}</span>
    </div>
  </a>`;
}
async function pastView(month) {
  month ||= new Date().toISOString().slice(0, 7);
  const { events } = await api(`/events?past=1&month=${month}`);
  const shift = (n) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const isNow = month >= new Date().toISOString().slice(0, 7);
  view.innerHTML = `${largeTitle('過去的團練')}
    <div class="monthbar"><button class="btn ghost sm navbtn" data-m="${shift(-1)}" aria-label="上個月">${IC.chevL}</button>
      <input type="month" id="pm" aria-label="選擇月份" value="${month}" max="${new Date().toISOString().slice(0, 7)}">
      <button class="btn ghost sm navbtn" data-m="${shift(1)}" aria-label="下個月" ${isNow ? 'disabled' : ''}>${IC.chevR}</button></div>
    <div class="evgrid">${events.map((e) => eventCard(e, { past: true })).join('') || `<div class="card">${emptyState('calendar', '這個月沒有紀錄')}</div>`}</div>`;
  for (const b of document.querySelectorAll('[data-m]')) b.onclick = () => pastView(b.dataset.m);
  $('#pm').onchange = (e) => e.target.value && pastView(e.target.value);
}

// ---------- 活動頁（event.js，用到才載入）：活動詳情與報名、邀請、繳費、入場券、報到與掃碼、春酒抽獎 ----------
const eventView = lazy('./event.js', 'eventView');
const attendView = lazy('./event.js', 'attendView');
const ticketsView = lazy('./event.js', 'ticketsView');
const checkinView = lazy('./event.js', 'checkinView');
const scanView = lazy('./event.js', 'scanView');
const dayPattern = (date) => { const w = d2(date).getDay(); return w === 0 || w === 6 ? '週末|週日' : `週${WD[w]}`; };


// ---------- 通知中心 ----------
// 分類由伺服器寫入（notif-cats.js 共用登記表）；每類一個實心色磚＋線條圖示＋文字，顏色不是唯一的辨識方式
const NICON = { security: IC.shieldAlert, change: IC.calAlert, signup: IC.ticket, event: IC.calClock, training: IC.runner,
  membership: IC.idcard, announce: IC.megaphone, todo: IC.clipCheck, other: IC.bell, ops: ic('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'), report: ic('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>') };
// 整句都是伺服器範本的標題：英文介面可以翻；夾帶活動或分團名稱的標題、內文一律不翻
const NFIXED = new Set(['新裝置登入', '新增了一把通行金鑰', '移除了一把通行金鑰', '已登出所有裝置', '幹部需要兩步驟驗證', '你已成為理事長', '你已卸任理事長',
  '身分更新', '候補遞補成功', '入會完成', '會籍已到期', '會費今天到期', '有人申請入會', '練跑地圖：有新的地點提議', '每季權限檢視', '跑完了嗎？', '這週練得很兇，注意恢復', '教練回饋了你的訓練', '每日備份還沒做完',
  '上週幹部週報', '有跑友把你設為推薦人', '推薦人已連到帳號', '推薦人沒有確認', '推薦人已移除', ...['每日備份', '每日額度', '排程工作停下', '前端錯誤', '推播', '排程工作失敗'].map((x) => `系統狀態：${x}`)]);
// 夾帶活動名稱的範本：開頭的範本字（「待審核：」）英文介面可以翻，後面的名稱不翻；內文只有固定句型可以翻
const NPREFIX = /^(待審核：|還有 \d+ 筆待審核：|上週分團週報：)/, NBODY = [/^目前 \d+ 筆報名等你核准$/];
const nTitle = (t) => { if (NFIXED.has(t)) return esc(t); const m = t.match(NPREFIX); return m ? `${esc(m[1])}<span translate="no">${esc(t.slice(m[1].length))}</span>` : `<span translate="no">${esc(t)}</span>`; };
const nBody = (b) => (NBODY.some((re) => re.test(b)) ? esc(b) : `<span translate="no">${esc(b)}</span>`);
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
        <span class="nt" id="nt-${esc(n.id)}">${nTitle(n.title)}</span>
        ${n.body ? `<span class="nb">${nBody(n.body)}</span>` : ''}
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
// onClose：關掉時（按鈕、Esc、點背景都算）呼叫一次，例如 choose() 回傳 null、掃碼面板關相機
const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
function openSheet(label, inner, opener, labelledby = '', { onClose } = {}) {
  const host = document.createElement('div');
  host.className = 'sheet'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true');
  if (labelledby) host.setAttribute('aria-labelledby', labelledby); else host.setAttribute('aria-label', I18N.t(label));
  host.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-card card">${inner}</div>`;
  document.body.append(host);
  // 收合的 <details> 裡的欄位、hidden 的按鈕不算（Tab 本來就到不了，算進來會讓焦點跑出面板）
  const focusables = () => [...host.querySelectorAll(FOCUSABLE)].filter((x) => x.getClientRects().length && (x.matches('summary') || !x.closest('details:not([open])')));
  // 有危險選項（取消報名、刪除）：焦點先放在安全的那一顆（data-close，例如「保留報名」），VoiceOver 打開後直接點兩下不會誤刪
  const fs0 = focusables(), safe = host.querySelector('.btn.danger') && fs0.find((x) => x.matches('[data-close]'));
  (safe || fs0[0])?.focus();
  const key = (e) => {
    if (!host.isConnected) { document.removeEventListener('keydown', key, true); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(), i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1]?.focus(); } else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0]?.focus(); }
  };
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    host.remove(); document.removeEventListener('keydown', key, true);
    if (opener?.isConnected) opener.focus();
    onClose?.();
  };
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
  const s = openSheet('更多動作', `<div class="nsheethd"><span class="ntile n-${cat}" aria-hidden="true">${NICON[cat]}</span><b>${nTitle(n.title)}</b></div>
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
      <h3 id="ndetailh">${nTitle(n.title)}</h3>
      ${n.body ? `<p class="ndbody">${nBody(n.body)}</p>` : ''}
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
    ...(t.reviews || []).map((p) => row(`#/e/${esc(p.id)}/stats?f=pending`, tile, `<span translate="no">「${esc(p.title)}」</span><span class="nw">報名待審核</span>`, '', num(p.n))),
    t.spots ? row('#/map', tile, '地點審核', '', num(t.spots)) : '',
    t.pb ? row('#/admin/ach', tile, '成績待審核', '', num(t.pb)) : '',
    t.achMet ? row('#/admin/ach?tab=met', tile, '挑戰達成待確認', '', num(t.achMet)) : '',
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
  await Device.pushReady();
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
  // 網址帶 ?cat=（例如點每日摘要推播的「未讀」）優先，不改記住的篩選；沒帶才用上次選的
  const qcat = new URLSearchParams(location.hash.split('?')[1] || '').get('cat');
  let chip = CHIPS.find((c) => c.key === qcat) || CHIPS.find((c) => c.key === lsGet('cil-ncat')) || CHIPS[0], r;
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
const settingsPage = lazy('./admin.js', 'settingsPage');
// 安裝到主畫面：iPhone 要手動「分享 → 加入主畫面」，Android／桌機用瀏覽器的安裝提示
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SHARE_IC = ic('<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/>');
const ADD_IC = ic('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>');
// iPhone Safari 加到主畫面的步驟：「開始使用」卡與通知設定頁的說明卡共用同一份（以前四個入口的說明不一樣）
//   iOS 26 起分享按鈕收在網址列旁的「⋯」裡；iOS 27 的實際按鈕文字要用實機再對一次
const iosAddSteps = () => `<ol class="steps">
    <li>點 Safari 網址列旁的「⋯」${SHARE_IC}，選「分享」</li>
    <li>往下滑，選「加入主畫面」${ADD_IC}</li>
    <li>打開「以網頁 App 打開」，按「加入」</li>
    <li>之後從主畫面的耕跑團打開（要再登入一次）</li></ol>`;
// 通知設定頁的說明卡（查詢用）：還沒加到主畫面才顯示
function installCard() {
  if (isStandalone()) return '';
  return `<section class="card tight installcard">
    <div class="instrow"><img src="/icons/icon-192.png" alt="" width="40" height="40">
      <span><b>把耕跑團加到主畫面</b><span class="tiny">才收得到團練通知，入場券沒網路也能出示</span></span></div>
    ${isIOS() ? `<details open><summary class="tiny">怎麼加？</summary>${iosAddSteps()}
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
    if (outcome === 'accepted') { toast('安裝完成，之後從主畫面打開'); saveStart({ install: 'done' }); }
    installEvt = null;
  };
}

// ---------- 開始使用（第一次使用的三步）----------
// 不是彈出視窗：首頁與「我的」最上面同一張卡（像 iPhone 設定最上面的「完成設定」），三步各自可以做、可以略過，整張卡可以「稍後再說」
//   ① 加到主畫面 ② 開啟推播（iPhone 要先從主畫面打開）③ 選距離與組別；全部完成才問要不要看五個分頁的導覽
//   進度只記在這台裝置（cil-start）：主畫面 App 一律算 ①完成；② 以「這支手機現在有沒有推播訂閱」為準；③ 在這台裝置確認或存過組別
//   iPhone 主畫面 App 跟 Safari 的儲存空間是分開的：在 Safari 做完 ①，從主畫面打開會自然從 ② 接著做
//   共用手機換人登入：新帳號、稍後再說、組別是帳號的（記著是誰的 who，換人就從頭算）；加到主畫面、推播是這台裝置的
const START_KEY = 'cil-start';
const ACCT_START = ['fresh', 'dismissed', 'group'];
const startState = () => {
  let st; try { st = JSON.parse(localStorage.getItem(START_KEY) || '{}') || {}; } catch { st = {}; }
  if (st.who && me?.id && st.who !== me.id) for (const k of ACCT_START) delete st[k];
  return { v: 1, ...st };
};
const saveStart = (patch) => { const st = { ...startState(), ...patch, who: me?.id || startState().who }; try { localStorage.setItem(START_KEY, JSON.stringify(st)); } catch {} return st; };
// 推播這一步在這台裝置能不能做：沒有推播金鑰（na）、iPhone 還沒從主畫面打開（ios）、瀏覽器不支援（no）、被封鎖（denied）、可以（ok）
function pushMode() {
  if (!cfg.vapid) return 'na';
  if (isIOS() && !isStandalone()) return 'ios';
  if (!('serviceWorker' in navigator) || typeof Notification === 'undefined' || !('PushManager' in window)) return 'no';
  return Notification.permission === 'denied' ? 'denied' : 'ok';
}
// 每一步的狀態：done／skip／na（這台裝置不適用，算完成）／null（還沒做）
//   ④ 填推薦人（選填，協會開放推薦人才有）：狀態以伺服器為準（已填＝完成、按過「沒有推薦人」＝略過），不記在 cil-start
//      這次打開已經出現過就一直留著（填好打勾，不會做完就整步消失）；refStepSeen 記是誰的，共用手機換人登入重新判斷
let refStepSeen = null;
function startSteps(st = startState()) {
  const s = { install: isStandalone() ? 'done' : st.install || null, push: pushMode() === 'na' ? 'na' : st.push || null, group: st.group || null };
  const r = me?.referral;
  if (refOn() && r && ((!r.has && !(r.hide & 1)) || (me.id && refStepSeen === me.id))) s.ref = r.has ? 'done' : r.hide & 1 ? 'skip' : null;
  return s;
}
const startLeft = (steps) => Object.values(steps).filter((v) => !v).length;
// 要不要出現：按過「稍後」或 ✕ 就不出現；新帳號（?welcome=1）一定出現；舊帳號只有 ① 或 ② 還沒做才出現
function startShown(welcome) {
  let st = startState();
  if (welcome && !st.fresh) st = saveStart({ fresh: 1, dismissed: 0 });
  if (st.dismissed) return false;
  const k = startSteps(st);
  if (st.fresh) return true;
  // 已經允許通知、這台還沒查過訂閱（更新後第一次打開的舊使用者）：先不出現，等背景查完訂閱（bindStart）再決定，卡片不會閃一下又消失
  if (k.install && !k.push && st.pushOff == null && pushMode() === 'ok' && Notification.permission === 'granted') return false;
  return !k.install || !k.push;
}
const ST_LABEL = { done: '已完成', skip: '已略過', na: '不需要' };
const REF_IC = ic('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5M17.5 8v6M14.5 11h6"/>');
const STEP_IC = { ref: REF_IC, install: ADD_IC, push: ic('<path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/>'), group: ic('<path d="M5.5 21V4M5.5 4.5h11l-2 3.7 2 3.8h-11"/>') };
function startCard() {
  const steps = startSteps(), left = startLeft(steps), total = Object.keys(steps).length, n = total - left;
  if ('ref' in steps && me?.id) refStepSeen = me.id;
  if (!left) return `<section class="card startcard alldone" id="startCard" aria-labelledby="startTitle">
    <div class="sthead"><h2 id="startTitle" tabindex="-1">都設定好了</h2><button type="button" class="iconx" id="startX" aria-label="收起開始使用">${ic('<path d="M7 7l10 10M17 7 7 17"/>')}</button></div>
    <p class="muted" style="margin:0">要不要用一分鐘看看五個分頁？</p>
    <div class="row" style="gap:8px"><button type="button" class="btn sm" id="startTour">看看五個分頁</button></div></section>`;
  const pm = pushMode(), app = inAppBrowser(), ios = isIOS();
  const stateTx = (k) => `<span class="ststate">${steps[k] ? ST_LABEL[steps[k]] : '還沒做'}</span>`;
  const SKIP = { install: '略過「加到主畫面」', push: '略過「開啟推播」', group: '略過「選距離與組別」' };
  const skip = (k) => `<button type="button" class="linkbtn tiny" data-stskip="${k}">${SKIP[k]}</button>`;
  // ① 加到主畫面：LINE／Facebook 的內建瀏覽器要先換 Safari；iPhone Safari 三步；Android／電腦用瀏覽器的安裝提示
  const install = steps.install ? '' : app ? `<p class="tiny">${app === 'line' ? '現在是在 LINE 裡打開：點右下角的選單，選「用預設瀏覽器開啟」，再到 Safari 加到主畫面。' : '現在是在 Facebook 或 Instagram 裡打開：點右上角「⋯」，選「在瀏覽器開啟」，再加到主畫面。'}</p>
      <div class="stacts">${app === 'line' ? `<a class="btn sm" href="${esc(`${location.origin}/?openExternalBrowser=1#/`)}">用瀏覽器打開</a>` : '<button type="button" class="btn sm" id="stCopy">複製網址</button>'}${skip('install')}</div>`
    : ios ? `<details class="sthow"><summary>怎麼加？</summary>${iosAddSteps()}</details>
      <div class="stacts"><button type="button" class="btn sm ghost" data-stdone="install">我加好了</button>${skip('install')}</div>`
    : `<div class="stacts">${installEvt ? '<button type="button" class="btn sm" id="stInstall">安裝 App</button>' : ''}<button type="button" class="btn sm ghost" data-stdone="install">我加好了</button>${skip('install')}</div>
      ${installEvt ? '' : '<p class="tiny">點瀏覽器的選單，選「安裝應用程式」或「加到主畫面」。</p>'}`;
  // ② 開啟推播：iPhone Safari 先停用並說明原因（aria-disabled，VoiceOver 唸得到）
  const pushWhy = pm === 'ios' ? '先加到主畫面，從主畫面的耕跑團打開後再開推播' : pm === 'no' ? '這個瀏覽器不支援推播，請用 Safari 或 Chrome 打開並加到主畫面'
    : pm === 'denied' ? (ios ? '推播被關掉了：到 iPhone 設定 → 通知 → 耕跑團，打開「允許通知」' : '推播被封鎖了：到瀏覽器的網站設定打開通知') : '';
  const push = steps.push ? '' : `<div class="stacts"><button type="button" class="btn sm" id="stPush"${pushWhy ? ' aria-disabled="true" aria-describedby="stPushWhy"' : ''}>開啟推播</button>${skip('push')}</div>
      ${pushWhy ? `<p class="tiny" id="stPushWhy">${pushWhy}</p>` : ''}`;
  // ③ 選距離與組別：確認目前的，或到課表設定改（存好自動回來打勾）
  const grp = `${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組`;
  const group = steps.group ? '' : `<div class="stacts"><button type="button" class="btn sm" data-stdone="group">確認 ${grp}</button><a class="btn sm ghost" id="stGroupEdit" href="#/plan/setup?go=grp&from=start" aria-label="修改距離與組別">修改 ›</a>${skip('group')}</div>`;
  const item = (k, title, sub, body) => `<li class="ststep${steps[k] ? ' ok' : ''}" data-step="${k}"><span class="stic" aria-hidden="true">${steps[k] ? IC.check : STEP_IC[k]}</span>
      <div class="stbody"><span class="sttl"><b>${title}</b><span class="sr">，</span>${stateTx(k)}</span>${steps[k] ? '' : `<span class="tiny">${sub}</span>${body}`}</div></li>`;
  return `<section class="card startcard" id="startCard" aria-labelledby="startTitle">
    <div class="sthead"><h2 id="startTitle" tabindex="-1">開始使用</h2><span class="tiny num" id="startProg">${n} / ${total} 完成</span></div>
    <div class="stbar" aria-hidden="true"><i style="width:${Math.round(n / total * 100)}%"></i></div>
    <ol class="ststeps" role="list">
      ${item('install', '加到主畫面', '像 App 一樣打開，入場券沒網路也能出示', install)}
      ${item('push', '開啟推播', '團練異動、候補遞補、帳號安全第一時間通知你', push)}
      ${item('group', '選距離與組別', `課表的配速照組別換算・<span class="nw">目前：${grp}</span>`, group)}
      ${'ref' in steps ? item('ref', '填推薦人', '選填・團購或活動聯絡不上時，協會幹部找得到人幫忙', steps.ref ? '' : `<div class="stacts"><a class="btn sm" id="stRefGo" href="#/me/referral?from=start" aria-label="填寫推薦人">填寫</a><button type="button" class="linkbtn tiny" data-stskip="ref">沒有推薦人</button></div>`) : ''}
    </ol>
    <div class="stfoot"><button type="button" class="btn ghost sm" id="startLater">稍後再說</button><button type="button" class="btn ghost sm" id="startTour">看看五個分頁</button></div></section>`;
}
// 換掉卡片內容（不重畫整頁）；使用者按了卡片上的按鈕（有 msg）才把焦點移到下一步的第一個按鈕（全部完成時移到卡片標題）
//   背景查訂閱的更新（沒有 msg）只換內容、不動焦點；查完發現不該出現（主畫面 App、已經有推播）就安靜地收起
function repaintStart(msg) {
  const el = $('#startCard'); if (!el) return;
  const had = el.contains(document.activeElement);   // 焦點本來就在卡片裡：換掉內容後放回卡片裡（不會掉到 body）
  if (!msg && !startShown()) { el.remove(); if (had) focusEl(view.querySelector('h1')); return; }
  el.outerHTML = startCard();
  bindStart(false);
  if (!msg && !had) return;
  const next = $('#startCard .ststep:not(.ok) .stacts > :is(button,a)') || $('#startTitle');
  next?.focus({ preventScroll: true });
  if (!msg) return;
  const left = startLeft(startSteps()); announce(left ? `${msg}，還剩 ${left} 步` : `${msg}，都設定好了`);
}
const STEP_DONE = { install: '已加到主畫面', push: '已開啟推播', group: '已確認組別', ref: '已填推薦人' };
function bindStart(check = true) {
  const card = $('#startCard');
  card?.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-stdone]')?.dataset.stdone, k = e.target.closest('[data-stskip]')?.dataset.stskip;
    if (d) { saveStart({ [d]: 'done' }); repaintStart(STEP_DONE[d]); return; }
    // 推薦人這一步記在伺服器（跟首頁推薦人卡的「沒有推薦人」同一個）
    if (k === 'ref') {
      try { await api('/me/referral/hide', { method: 'POST', body: { bits: 1 } }); } catch (err) { toast(err.message); return; }
      if (me?.referral) me.referral.hide = (me.referral.hide || 0) | 1;
      repaintStart('已略過'); return;
    }
    if (k) { saveStart({ [k]: 'skip' }); repaintStart('已略過'); return; }
    if (e.target.closest('#startLater, #startX')) {
      saveStart({ dismissed: 1 });
      card.remove();
      announce('已收起，之後可以在「我的 → 使用說明」再打開');
      focusEl(view.querySelector('h1'));
      return;
    }
    // 導覽隨時可以看（不用先做完三步）；三步都做完的「都設定好了」卡看完導覽就收起
    if (e.target.closest('#startTour')) { if (!startLeft(startSteps())) saveStart({ dismissed: 1 }); Guide.start(); return; }
    if (e.target.closest('#stCopy')) { copy(`${location.origin}/`); return; }
    if (e.target.closest('#stGroupEdit, #stRefGo')) { try { sessionStorage.setItem('cil-start-back', location.hash || '#/'); } catch {} return; }
    const pb = e.target.closest('#stPush');
    if (pb) {
      if (pb.getAttribute('aria-disabled') === 'true') { toast($('#stPushWhy')?.textContent || ''); return; }
      // quiet：不跳「已開啟通知」、不重畫整頁（焦點才不會掉到 body，VoiceOver 只唸一次「已開啟推播，還剩 N 步」）
      if (await togglePush(null, { quiet: true }) && await pushSub()) {
        saveStart({ push: 'done', pushOff: null }); repaintStart(STEP_DONE.push);
        const ps = $('#pushSub'); if (ps) ps.textContent = '推播已開啟';
      }
      return;
    }
    const ib = e.target.closest('#stInstall');
    if (ib && installEvt) {
      installEvt.prompt();
      const { outcome } = await installEvt.userChoice.catch(() => ({}));
      installEvt = null;
      if (outcome === 'accepted') { saveStart({ install: 'done' }); repaintStart(STEP_DONE.install); } else repaintStart();
    }
  });
  // 推播以這支手機現在的訂閱為準：有訂閱就打勾；記成完成但訂閱不見了（換手機、重新安裝）就回到還沒做
  //   pushOff 記下「查過，沒有訂閱」：startShown 等這個結果才決定要不要出現；這裡只換內容，不移動焦點
  if (!check || !cfg.vapid || pushMode() !== 'ok') return;
  pushSub().then((sub) => {
    const st = startState(), had = !!$('#startCard');
    if (sub) { if (st.push !== 'done' || st.pushOff != null) { saveStart({ push: 'done', pushOff: null }); if (had) repaintStart(); } return; }
    if (st.push === 'done' || st.pushOff == null) saveStart({ push: st.push === 'done' ? null : st.push, pushOff: 1 });
    if (had && st.push === 'done') repaintStart();
  });
}
// 課表設定改好組別、從「開始使用」來的：打勾，回到原本的頁面
function startGroupSaved() {
  saveStart({ group: 'done' });
  startBack();
}
// 從「開始使用」卡去別頁做完一步（課表設定的組別、推薦人）：回到原本的頁面，焦點放到下一步
function startBack() {
  let back = '#/'; try { back = sessionStorage.getItem('cil-start-back') || '#/'; sessionStorage.removeItem('cil-start-back'); } catch {}
  focusAfterRender(['#startCard .ststep:not(.ok) .stacts > :is(button,a)', '#startTitle']);
  location.hash = back;
}
// 「我的 → 使用說明」：重新打開「開始使用」卡（狀態還在）
function reopenStart() {
  saveStart({ dismissed: 0, fresh: 1 });
  focusAfterRender('#startTitle');
  if (location.hash.split('?')[0] === '#/me') render(); else location.hash = '#/me';
}

// 掃描台：有相機就用相機掃（iPhone 也可以，第一次會詢問相機權限），也可以手動輸入代碼
let stopScan = null;
const setStopScan = (fn) => { stopScan = fn; };   // event.js 的掃碼台：換頁時由 renderOnce 關掉相機
// 掃碼面板（團購領取、會籍卡驗證共用）：打開就啟動相機（第一次會詢問相機權限），也可以手動輸入代碼
//   onCode(code) 回傳要顯示的結果文字；連續掃描時 1.8 秒內不重複處理
function scanSheet({ title, hint, placeholder = '手動輸入代碼', onCode }) {
  let stop = null, busy = false;
  // 共用 openSheet：焦點移進面板、Tab 不跑出去、Esc 關閉（同時關相機），關掉後焦點回到開啟的按鈕
  const s = openSheet(title, `<div class="row spread"><h3 id="scanT">${esc(title)}</h3><button type="button" class="btn ghost sm" data-close>完成</button></div>
    ${canScan() ? '<video playsinline muted class="cam" aria-label="相機畫面"></video>' : '<p class="notice" style="margin:0">這台裝置沒有可以用的相機，請手動輸入代碼。</p>'}
    <p class="tiny center scanmsg" aria-live="polite">${esc(hint)}</p>
    <form class="row" style="gap:8px"><input name="code" placeholder="${esc(placeholder)}" style="flex:1" autocomplete="off" aria-label="${esc(placeholder)}"><button class="btn sm">送出</button></form>`,
    document.activeElement, 'scanT', { onClose: () => stop?.() });
  const host = s.host;
  const msg = host.querySelector('.scanmsg');
  const run = async (code) => {
    if (busy) return; busy = true;
    // onCode 回傳文字，或已經分好段的節點（名字要 translate="no" 的訊息）
    try { const out = await onCode(code.trim()); if (out instanceof Node) msg.replaceChildren(out); else msg.textContent = out; navigator.vibrate?.(30); } catch (e) { msg.textContent = e.message; }
    setTimeout(() => { busy = false; }, 1800);
  };
  host.querySelector('form').onsubmit = (e) => { e.preventDefault(); run(e.target.code.value); e.target.code.value = ''; };
  if (canScan()) {
    msg.textContent = '正在打開相機…';
    scan(host.querySelector('video'), (v) => run(v)).then((s0) => { if (host.isConnected) { stop = s0; msg.textContent = hint; } else s0(); })
      .catch((e) => { msg.textContent = e.message; host.querySelector('video')?.remove(); });
  }
  return s.close;
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
          <button class="btn ghost sm navbtn" id="prev" ${week === 1 ? 'disabled' : ''} aria-label="上一週">${IC.chevL}</button>
          <button class="btn ghost sm navbtn" id="next" ${week === 21 ? 'disabled' : ''} aria-label="下一週">${IC.chevR}</button>
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
          ${canTeamLogs() ? '<a class="tiny" href="#/logs/team">看團員的訓練 ›</a>' : ''}</div>
      </div>
      <div class="lsumact">${feat('gps') ? `<a class="btn iconbtn" href="#/run">${IC.runner}開始跑步</a>` : ''}<a class="btn ghost iconbtn" href="#/log?extra=1">${IC.plus}自主加練</a><a class="btn ghost" href="#/report">報表</a></div>
      <p class="tiny" style="margin:0">${me.share_logs ? '教練與分團幹部看得到你的完成率、里程與平均強度；每次的時間、心率、強度、感覺與備註只有你看得到。' : '紀錄只有你看得到；想讓教練看到，到「我的 → 隱私」打開分享。'}</p>
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
          ${top ? `<span class="logline">${top.pending ? '待上傳・' : ''}${LOG_STATUS_NAME[st]}${top.km ? `・${top.km} km` : ''}${top.seconds ? `・${fmtDuration(top.seconds)}` : ''}${top.rpe ? `・RPE ${top.rpe}` : ''}${L.some((l) => l.unread) ? '<span class="pill solid" style="margin-left:6px">教練回饋</span>' : L.some((l) => l.comments) ? '・有回饋' : ''}</span>` : ''}
          ${coach && d.kind !== 'rest' ? `<details class="xd" data-xd="${i}"><summary>詳細內容</summary><div class="xdb"></div></details>` : ''}
        </div>
        ${top?.pending ? `<span class="logbtn done" role="img" aria-label="待上傳">${LOG_ICON.done}</span>`
          : top ? `<a class="logbtn ${st}" href="#/log?id=${top.id}" aria-label="修改紀錄">${LOG_ICON[st]}</a>`
          : canLog ? `<a class="logbtn" href="#/log?w=${week}&i=${i}${personal ? '&c=r' : ''}" aria-label="記錄${esc(d.d)}">記錄</a>` : ''}
      </div>`; }).join('') : `<div class="card"><p class="muted">${info?.missing ? `W${week} 課表還沒公告` : '這週沒有課表資料。'}</p></div>`}</div>
    ${coach && days && !other ? '<div class="warnslot" hidden></div>' : ''}
    ${extras.length || others.length ? `<section class="card"><h3>${others.length ? '自主加練與其他週期的紀錄' : '自主加練'}</h3><div class="roster">${[...others, ...extras].map((l) => `<a class="r" ${l.id ? `href="#/log?id=${l.id}"` : ''}><span class="av">${l.status === 'extra' || !l.plan_day ? '＋' : LOG_ICON[l.status] || '＋'}</span>
      <span>${esc(dstr(l.date))}${l.plan_day && l.status !== 'extra' ? `・${esc(P.logWeekLabel(l))} ${esc(dayLabel(l.plan_day))}` : ''}${l.km ? `・${l.km} km` : ''}${l.seconds ? `・${fmtDuration(l.seconds)}` : ''}${l.pending ? '・待上傳' : ''}<span class="tiny" style="display:block"><span translate="no">${esc(l.note || '')}</span></span></span><span class="tiny">›</span></a>`).join('')}</div>
      ${others.length ? '<p class="tiny" style="margin:0">其他週期的紀錄只算里程，不算這週的完成率。</p>' : ''}</section>` : ''}
    <section class="setgroup"><h3 class="sgt">工具</h3><div class="card setcard">
      ${coach ? `${row('#/plan/season', MI.plan, '全季課表', '20 週一覽、每週完成率')}${row('#/plan/race', MI.flag, '賽事準備', '比賽日計劃、補給、心率、年齡分級')}
        ${row('#/plan/guide', MI.help, '配速與用語', '你的配速、課表用語、各階段')}${row('#/plan/setup', IC.sliders, '課表設定', '組別、課表週期、每週天數、身體資料')}
        <a class="setrow" href="/coach"><span class="sic" style="--sc:var(--tile-gray)">${IC.runner}</span><span class="st"><b>舊版課表教練</b><span class="tiny">舊版的完成紀錄與倒數，可以到課表設定搬進 App</span></span><span class="chev" aria-hidden="true"></span></a>` : ''}
      <a class="setrow" href="#/report"><span class="sic" style="--sc:var(--tile-green)">${MI.report}</span><span class="st"><b>訓練報表</b><span class="tiny">週里程、完成率、個人最佳</span></span><span class="chev" aria-hidden="true"></span></a>
      <a class="setrow" href="#/challenge"><span class="sic" style="--sc:var(--tile-orange)">${MI.trophy}</span><span class="st"><b>每月里程挑戰</b><span class="tiny">徽章、分團對抗、排行榜</span></span><span class="chev" aria-hidden="true"></span></a>
      ${achOn() || me.ach?.needSize > 0 ? row('#/ach', MI.medal, '目標挑戰', '破 PB、完成目標拿團服') : ''}
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
// RPE 自覺強度的文字（滑桿的 aria-valuetext）
const RPE_WORD = ['', '很輕鬆', '輕鬆', '輕鬆', '中等', '有點吃力', '有點吃力', '吃力', '很吃力', '非常吃力', '全力'];
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
    date: /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : null, source: ['health', 'gps'].includes(q.get('src')) ? q.get('src') : 'manual',
    ...(q.get('src') === 'gps' && q.get('note') ? { note: q.get('note').slice(0, 40) } : {}) } : null;
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
  // 跑步記錄帶來的備註（含直線估算多少）：這天已經有備註就接在後面，不蓋掉
  if (log?.note && incoming?.note && !log.note.includes(incoming.note)) v.note = `${log.note}；${incoming.note}`.slice(0, 300);
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
        ${statuses.length > 1 ? `<fieldset class="qset"><legend class="sr">狀態</legend><div class="chips status">${statuses.map((k) => `<label class="chip"><input type="radio" name="status" value="${k}" ${v.status === k ? 'checked' : ''}><span>${LOG_ICON[k]} ${LOG_STATUS_NAME[k]}</span></label>`).join('')}</div></fieldset>`
          : '<input type="hidden" name="status" value="extra">'}
        <label>日期<input type="date" name="date" value="${esc(date)}" max="${today}" required></label>
        <div class="grid2" data-run>
          <label>距離（km）<input name="km" inputmode="decimal" value="${v.km ?? ''}" placeholder="10.0"></label>
          <label>時間（時:分:秒）<input name="time" inputmode="numeric" value="${v.seconds ? fmtDuration(v.seconds) : ''}" placeholder="0:55:00"></label>
        </div>
        <p class="tiny pace" data-run id="paceOut"></p>
        <div class="grid2" data-run>
          <label>平均心率（選填）<input name="hr" inputmode="numeric" value="${v.hr ?? ''}" placeholder="152"></label>
          <label><span class="lrow"><span>RPE 自覺強度</span><b class="num" id="rpeOut" aria-hidden="true">${v.rpe || 5}</b></span><input type="range" name="rpe" min="1" max="10" value="${v.rpe || 5}"></label>
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
    const km = parseFloat(f.km.value), sec = parseHMS(f.time.value);
    $('#paceOut').textContent = km > 0 && sec > 0 ? `平均配速 ${fmtDistPace(km * 1000, sec)}` : '';
    $('#rpeOut').textContent = f.rpe.value;
    // 滑桿只唸數字聽不出強度：加上文字（「5，有點吃力」）
    const rv = Number(f.rpe.value), word = RPE_WORD[rv] || '';
    if (f.rpe.dataset.vt !== String(rv)) { f.rpe.dataset.vt = String(rv); f.rpe.setAttribute('aria-valuetext', I18N.lang === 'en' ? `${rv}, ${I18N.t(word)}` : `${rv}，${word}`); }
  };
  f.oninput = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const st = f.querySelector('[name=status]:checked')?.value || f.status.value;
    // 週期欄位：照課表的紀錄帶協會週次（week_no）或個人週期（cycle_anchor、cycle_week）；修改時原樣送回
    const cyc = label && week ? P.cycleFields(lc, week) : { week_no: null };
    const body = { id: log?.id, date: f.date.value, status: st, ...cyc, plan_day: label || null, kind: log?.kind || day?.kind || null,
      plan_text: planText || null, km: parseFloat(f.km.value) || null, seconds: parseHMS(f.time.value) || null, hr: Number(f.hr.value) || null,
      rpe: Number(f.rpe.value), feel: Number(f.querySelector('[name=feel]:checked')?.value) || null, note: f.note.value,
      source: log?.source || incoming?.source || 'manual' };
    // 照課表記錄（完成、部分完成）可以不填距離與時間；自主加練才一定要填
    if (st === 'extra' && !body.km && !body.seconds) return fieldError(f.km, '填一下距離或時間', { also: [f.time], anchor: f.km.closest('.grid2') });
    try {
      await api('/logs', { method: 'POST', body });
      if (body.source === 'gps') { const R = await loadRun().catch(() => null); if (R?.session()?.status === 'done') R.discard(); }   // 已存成紀錄，清掉手機上的這次跑步
      if (st === 'skip' || log) { toast(st === 'skip' ? '已記下，休息也是訓練的一部分' : '已更新'); location.hash = planHref(lc, week); return; }
      // 記完接著拍照分享：把剛記的距離、時間帶到拍照
      const p = new URLSearchParams({ km: String(body.km || 0), sec: String(body.seconds || 0), date: body.date, title: (fromEv?.title || planText || '今天的跑步').slice(0, 20), logged: '1' });
      view.innerHTML = `<section class="card donecard"><span class="donemark">${IC.check}</span><h1 class="h2" id="doneH" tabindex="-1">已記錄，辛苦了</h1>
        <p class="muted" style="margin:0">${body.km ? `${body.km} 公里` : ''}${body.km && body.seconds ? '・' : ''}${body.seconds ? fmtDuration(body.seconds) : ''}${body.km && body.seconds ? `・配速 ${fmtDistPace(body.km * 1000, body.seconds)}` : ''}</p>
        ${feat('studio') ? `<a class="btn block iconbtn" href="#/studio?${p}">${ic('<path d="M4 8.2a2 2 0 0 1 2-2h1.9l1.5-2h5.2l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.6" r="3.6"/>')}拍照分享</a>` : ''}
        <a class="btn ghost block" href="${planHref(lc, week)}">回課表</a></section>`;
      // 表單換成完成卡：焦點移到完成卡的標題（VoiceOver 唸「已記錄，辛苦了」，不會掉回頁首）
      document.title = `${I18N.t('已記錄，辛苦了')} – ${I18N.t('耕跑團')}`;
      $('#doneH').focus();
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
    toast(r.qid ? '目前離線，已先存在手機' : '已記錄完成', { action: '復原', ms: 6000, say: '要復原，6 秒內按「復原」，或點這一列修改', onAction: async () => {
      try { await undoTick(r); toast('已復原'); } catch (e) { toast(e.message); }
      render();
    } });
  } catch (e) {
    toast(e.message);
    if (btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  } finally { ticking.delete(key); }
}
//   只在伺服器確認過目前登入的是誰之後才送（上次的資料可能是過期的登入，或 cookie 已經是別人）；同時只跑一個
let flushing = false;
async function flushLogQueue() {
  if (!me || meStale || flushing) return;
  flushing = true;
  try { await flushLogQueue0(me.id); } finally { flushing = false; }
}
async function flushLogQueue0(who) {
  await bindDeviceData(who);   // 暫存區是上一位登入者的就先清掉，不會傳到這個帳號
  if (me?.id !== who || Device.ownerOf(lsOrNull()) !== who) return;
  const q = logQueue.get();
  if (!q.length) return;
  const left = [];
  let up = 0, dup = 0;
  // 原樣送出：只有快速打勾的那幾筆本來就帶 if_absent（同一週、同一天已經有紀錄就不重複新增）；
  //   修改既有紀錄帶 id 是更新；那一筆已經在別的裝置刪掉，就改成新增，不讓這次的修改不見
  let rate = false;
  for (const { queued, qid, ...b } of q) {
    // 伺服器的次數限制、登入過期（401）：這一筆和後面的都留在暫存區，下次再傳（不能當成失敗丟掉；同一個人重新登入後接著送）
    if (rate) { left.push({ ...b, qid, queued }); continue; }
    try {
      let r;
      try { r = await api('/logs', { method: 'POST', body: b }); }
      catch (e) { if (b.id && !(e instanceof TypeError) && /找不到這筆紀錄/.test(e.message)) r = await api('/logs', { method: 'POST', body: { ...b, id: undefined } }); else throw e; }
      if (qid) flushed.set(qid, r);
      if (r?.existed) dup++; else up++;
    } catch (e) { const hold = e.status === 429 || e.status === 401; if (e instanceof TypeError || hold) left.push({ ...b, qid, queued }); if (hold) rate = true; }
  }
  // 送的時候換了人（暫存區已經清掉）：不把上一位的寫回去；送的時候新加進暫存區的保留
  if (me?.id !== who || Device.ownerOf(lsOrNull()) !== who) return;
  const sent = new Set(q.map((x) => x.qid));
  logQueue.set([...left, ...logQueue.get().filter((x) => !sent.has(x.qid))]);
  if (up) toast(`已上傳 ${up} 筆離線時的訓練紀錄`);
  else if (dup) toast('離線時打勾的那幾天已經記錄過了');
}

// ---------- report.js（用到才載入）----------
const logsTeamView = lazy('./report.js', 'logsTeamView');
const memberLogsView = lazy('./report.js', 'memberLogsView');
const reportView = lazy('./report.js', 'reportView');
// 圖表的刻度字：SVG 用固定寬度的座標，手機上字會跟著縮到 8px。依實際寬度換算（--k），刻度字永遠約 12px
const chartRO = 'ResizeObserver' in window ? new ResizeObserver((es) => {
  for (const e of es) { const w = e.contentRect.width, vb = e.target.viewBox?.baseVal?.width; if (w && vb) { e.target.style.setProperty('--k', (vb / w).toFixed(3)); thinAxis(e.target, vb / w); } }
}) : null;
// X 軸標籤：依實際字寬與柱距決定隔幾根標一次，標籤之間至少留 8px，不會黏成一串
function thinAxis(svg, k) {
  const ls = [...svg.querySelectorAll('text.xl')], bw = Number(svg.dataset.bw);
  if (!ls.length || !bw) return;
  for (const t of ls) t.style.display = '';
  const need = Math.max(...ls.map((t) => { try { return t.getComputedTextLength(); } catch { return 0; } })) + 8 * k;
  const s0 = Number(svg.dataset.s) || 1, every = Math.max(1, Math.ceil(Math.ceil(need / bw) / s0)) * s0;
  for (const t of ls) t.style.display = Number(t.dataset.i) % every ? 'none' : '';
}
if (chartRO) new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) for (const c of n.matches('svg.chart') ? [n] : n.querySelectorAll('svg.chart')) chartRO.observe(c); })
  .observe(document.body, { childList: true, subtree: true });
function barChart(items, { unit = '', h = 150, color = 'var(--accent)', fmt = (v) => v, max: fixedMax } = {}) {
  if (!items.length) return '<p class="muted" style="margin:0">這段期間沒有紀錄</p>';
  // 柱子最寬 72（項目少時不會撐滿整張圖）；刻度用整數步距，格線的位置跟標籤一致
  const step = Math.max(1, Math.ceil(Math.max(1, ...items.map((x) => x.v)) / 2));
  const W = 600, pad = 34, bw = Math.min((W - pad) / items.length, 72), max = fixedMax || step * 2;
  return `<svg class="chart" data-bw="${bw.toFixed(2)}" data-s="${items.length <= 16 ? 1 : Math.ceil(items.length / 12)}" viewBox="0 0 ${W} ${h + 34}" role="img" aria-label="${esc(items.map((x) => `${x.l} ${fmt(x.v)}${unit}`).join('，'))}">
    <line x1="${pad}" x2="${W}" y1="${h}" y2="${h}" class="grid"/>
    ${[0.5, 1].map((k) => `<line x1="${pad}" x2="${W}" y1="${h - h * k * 0.9}" y2="${h - h * k * 0.9}" class="grid"/><text x="0" y="${h - h * k * 0.9 + 4}" class="axis">${fmt(Math.round(max * k))}</text>`).join('')}
    ${items.map((x, i) => { const bh = Math.max(x.v ? 3 : 0, (x.v / max) * h * 0.9), xx = pad + i * bw + bw * 0.18;
      return `<rect x="${xx}" y="${h - bh}" width="${bw * 0.64}" height="${bh}" rx="${Math.min(6, bw * 0.2)}" style="fill:${x.c || color}"><title>${esc(x.l)}：${fmt(x.v)}${unit}</title></rect>
        ${items.length <= 16 || i % Math.ceil(items.length / 12) === 0 ? `<text x="${xx + bw * 0.32}" y="${h + 20}" text-anchor="middle" class="axis xl" data-i="${i}">${esc(x.l)}</text>` : ''}`; }).join('')}
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
let runTick = null, lapMsgT = 0, wakeBadAt = 0, settleOff = null;
// 螢幕保持亮著要不到、或被系統放掉：跑步中超過 2 秒才提醒（記錄中的畫面與口袋模式共用）
function wakeWarn(y) {
  const bad = y.status === 'running' && ['off', 'denied', 'unsupported'].includes(Run.awake()) && document.visibilityState === 'visible';
  wakeBadAt = bad ? wakeBadAt || Date.now() : 0;
  return !!wakeBadAt && Date.now() - wakeBadAt >= 2000;
}
// 「跑完了嗎？」問的時候停著，之後自動繼續跑了：這個問題就不用再顯示
function staleAsk(y) { if (pendingAsk?.kind === 'finish' && y.status === 'running') { pendingAsk = null; const b = $('#askDone'); if (b) b.innerHTML = ''; } }
// 路線預覽（SVG，不載地圖圖資，路線不離開手機）
//   點是 [緯度, 經度, 記號]：記號 1＝空檔的直線估算（虛線、淡一點）、2＝跟上一點斷開（不連線）
function routeSvg(route) {
  if (route.length < 2) return '';
  const lats = route.map((p) => p[0]), lons = route.map((p) => p[1]);
  const mid = (Math.min(...lats) + Math.max(...lats)) / 2, kx = Math.cos(mid * Math.PI / 180);
  const minX = Math.min(...lons) * kx, maxX = Math.max(...lons) * kx, minY = Math.min(...lats), maxY = Math.max(...lats);
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6), sc = Math.min(560 / w, 260 / h);
  const P = ([la, lo]) => `${(20 + (lo * kx - minX) * sc + (560 - w * sc) / 2).toFixed(1)},${(20 + (maxY - la) * sc + (260 - h * sc) / 2).toFixed(1)}`;
  // 估算的路段：每一段自己算點距（短的空檔縮小後只有幾十個單位，點距跟著縮，至少看得到 3–4 個點，不會像路線斷掉）
  let line = '', est = '';
  route.forEach((p, i) => {
    if (!i || p[2] === 2) line += `M${P(p)}`;
    else if (p[2] === 1) {
      const a = P(route[i - 1]), b = P(p), [ax, ay] = a.split(',').map(Number), [bx, by] = b.split(',').map(Number);
      const per = Math.max(6, Math.min(12, Math.hypot(bx - ax, by - ay) / 4));
      est += `<path class="est" d="M${a}L${b}" stroke-dasharray="2 ${(per - 2).toFixed(1)}"/>`; line += `M${b}`;
    }
    else line += `L${P(p)}`;
  });
  const [sx, sy] = P(route[0]).split(','), [ex, ey] = P(route[route.length - 1]).split(',');
  return `<svg class="routesvg" viewBox="0 0 600 300" role="img" aria-label="這次跑步的路線"><path d="${line}"/>${est}
    <circle cx="${sx}" cy="${sy}" r="8" class="st"/><circle cx="${ex}" cy="${ey}" r="8" class="en"/></svg>`;
}
// 空檔的估算：「螢幕鎖定或訊號弱時以直線估算 620 公尺」
const estText = (m) => `螢幕鎖定或訊號弱時以直線估算 ${Math.round(m)} 公尺`;
// 記錄中的今天課表目標進度條（寬度由 paint 每秒更新）
const goalBar = (g) => `<div class="goalbar"><span class="tiny">今天的課表：${esc(g.text)}</span><span class="bar big"><i id="rGoal" style="width:0%"></i></span></div>`;
async function runView() {
  clearInterval(runTick);
  await loadRun();
  const x = Run.session();
  if (!Run.active()) pocketOff();
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
      ${r.settling ? '<p class="tiny estnote" role="status">正在等 GPS 補上最後一段（最多 30 秒）…</p>' : ''}
      ${r.lost >= 10 ? `<p class="tiny estnote">有 ${hms(r.lost)} 收不到定位（螢幕鎖定或訊號弱），這段沒有算到距離，平均配速會偏慢；知道實際距離可以在下面填。</p>` : ''}
      ${!r.gps || r.distance < 50 || x.lostMs >= 10000 ? `<section class="card"><h3>距離</h3><p class="tiny" style="margin:0">${!r.gps || r.distance < 50 ? `${r.gps ? 'GPS 沒有記到距離（可能在室內或訊號太弱），' : '這次沒有開 GPS，'}請填實際跑的距離，例如跑步機上的數字或操場圈數。` : '知道實際距離的話填在這裡，會取代 GPS 算的距離。'}</p>
        <form id="manDist" class="row" style="gap:8px"><input name="km" inputmode="decimal" placeholder="例如 8.0" aria-label="實際距離（公里）" style="flex:1" value="${x.manualDist ? (x.manualDist / 1000).toFixed(2) : ''}"><span>km</span><button class="btn sm">更新</button></form></section>` : ''}
      ${r.est ? `<p class="tiny estnote">${estText(r.est)}，路線上畫成虛線；實際跑的通常比直線長一點。</p>` : ''}
      ${r.route.length > 1 ? `<section class="card"><div class="row spread"><h3>路線</h3><span class="tiny">只留在你的手機上</span></div>${routeSvg(r.route)}</section>` : ''}
      <div class="statgrid">
        ${r.splits.length ? `<section class="card"><h3>每公里分段</h3><div class="splits">${r.splits.map((sp) => `<div><span>${sp.km} km</span><b class="num">${paceStr(sp.sec)}</b></div>`).join('')}</div></section>` : ''}
        ${r.laps.length ? `<section class="card"><h3>計圈</h3><div class="splits">${r.laps.map((l) => `<div><span>第 ${l.n} 圈・${l.m} m</span><b class="num">${hms(l.sec)}${l.m >= 100 ? `<small>　${paceStr(l.sec / (l.m / 1000))}</small>` : ''}</b></div>`).join('')}</div></section>` : ''}
      </div>
      <section class="card"><div class="row spread"><h3>${r.date === t ? '今天' : dstr(r.date)}累計</h3><span class="tiny">包含這一次</span></div>
        <div class="lstats"><span><b class="num">${(dayKm + r.distance / 1000).toFixed(1)}</b> km</span><span><b class="num">${hms(daySec + r.seconds)}</b></span><span><b class="num">${logs.filter((l) => l.status !== 'skip').length + 1}</b> 次</span></div></section>
      <section class="card actions">
        <a class="btn block iconbtn" href="#/log?${new URLSearchParams({ date: r.date, km: (r.distance / 1000).toFixed(2), sec: String(r.seconds), src: 'gps', ...(r.est ? { note: I18N.lang === 'en' ? `Includes ${r.est} m straight-line estimate` : `含直線估算 ${r.est} 公尺` } : {}) })}">${IC.check}存到訓練紀錄</a>
        ${feat('studio') ? '<button class="btn ghost block" id="toStudio">拍照分享到 IG</button>' : ''}
        ${r.route.length > 1 ? '<button class="btn ghost block" id="dlGpx">下載 GPX 檔</button>' : ''}
        <button class="btn danger block" id="runDiscard">刪除這次記錄</button>
      </section>`;
    $('#manDist')?.addEventListener('submit', (e) => { e.preventDefault(); Run.setDistance(parseFloat(e.target.km.value) * 1000); runView(); });
    // 還在等最後那段的定位點：等到（或 30 秒到了）就重畫成績
    settleOff?.(); settleOff = null;
    if (r.settling) settleOff = Run.on((y) => { if (y?.settle) return; settleOff?.(); settleOff = null; if (y?.status === 'done' && location.hash.split('?')[0] === '#/run') runView(); });
    $('#toStudio')?.addEventListener('click', () => {
      studio.stats = { title: '今天的跑步', date: r.date, distance: r.distance, seconds: r.seconds, elevation: r.gain, avg_hr: null, route: r.route };
      studio.source = 'manual'; studio.template = r.route.length > 1 ? 'route' : studio.template; location.hash = '#/studio';
    });
    $('#dlGpx')?.addEventListener('click', async () => {
      const res = await (await load('./studio.js', 'shareFile')).shareFile(new Blob([Run.gpx(x)], { type: 'application/gpx+xml' }), `耕跑團-${r.date}.gpx`, '跑步軌跡');
      if (res === 'downloaded') toast('已下載 GPX');
    });
    $('#runDiscard').onclick = () => { if (confirm('刪除這次跑步記錄？還沒存成訓練紀錄的話就不見了。')) { Run.discard(); runView(); } };
    return;
  }
  // 開始前
  if (!x) {
    // 練跑地圖就是隔壁的分頁，這裡不再放連結卡；拍照分享收進「跑完之後」（GPS 開著時拍照不在分頁列）
    view.innerHTML = `${largeTitle('跑步', '計時加上 GPS，跑完自動算出今天的成績')}
      <section class="card runstart">
        <button class="runbtn go" id="runGo" aria-label="開始跑步記錄"><span>開始</span></button>
        <p class="tiny center" style="margin:0">第一次使用會詢問定位權限。跑步時螢幕會保持亮著；iPhone 鎖定螢幕時收不到定位（計時照走），解鎖後空白的那段用直線估算（路線畫成虛線）。手機放口袋可以開「口袋模式」防誤觸。</p>
        <button class="btn ghost block" id="runNoGps">不用 GPS，只計時（跑步機、操場）</button>
        <label class="switch pkpref"><span>開始後直接進入口袋模式<span class="tiny" style="display:block">手機放口袋時畫面全黑、點了沒反應，會盡量讓螢幕保持亮著</span></span><input type="checkbox" id="pkPref" ${pocketPref.get() ? 'checked' : ''}><i></i></label>
      </section>
      ${group('跑完之後', [
        feat('studio') ? row('#/studio', MI.camera, '拍照分享', '距離、時間和路線放進照片，分享到 IG').replace('class="setrow"', 'class="setrow runshare"') : '',
        row('#/log?extra=1&from=run', IC.check, '手動記一筆', '沒帶手機跑？手動記錄這次訓練'),
      ])}
      <section class="card"><h3>小提醒</h3><ol class="steps">
        <li>到戶外等「GPS 良好」再開始，距離會比較準</li><li>練間歇或在操場跑，可以按「計圈」把每一趟分開記</li>
        <li>跑完按「結束」，再按「存到訓練紀錄」，系統會自動對上今天的課表</li></ol>
        <p class="tiny" style="margin:0">路線只留在你的手機上，協會只會收到你存下來的距離和時間。</p></section>`;
    // 按鈕先接好再讀今天的課表：讀課表第一次要下載整季的資料，網路慢時要好幾秒；以前讀完才接上，這段時間按「開始」沒反應
    //   還沒讀到就按了開始：照樣開始記錄，讀到了再補上今天的目標（Run.setGoal）
    let goal = null, started = false;
    const go = (useGps) => { started = true; Run.start({ useGps, goal }); runView(); if (pocketPref.get()) pocketOn(); };
    $('#pkPref').onchange = (e) => pocketPref.set(e.target.checked);
    $('#runGo').onclick = () => go(true);
    $('#runNoGps').onclick = () => go(false);
    const box = $('.runstart');
    goal = await todayGoal().catch(() => null);
    if (!goal) return;
    if (!started) { if (box.isConnected) box.insertAdjacentHTML('afterbegin', `<span class="pill">今天的課表：${esc(goal.text)}</span>`); return; }
    // 記錄中的畫面已經畫好：補上目標進度條（寬度由每秒的 paint 更新）；還沒畫好的話，畫的時候就會帶目標
    if (Run.setGoal?.(goal) && !$('#rGoal')) $('.runlive .runbtns')?.insertAdjacentHTML('afterend', goalBar(goal));
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
      ${x.goal ? goalBar(x.goal) : ''}
      <div class="notice wakenote" id="rWake" role="status" hidden><b>螢幕可能會自動關掉</b>
        <p>iPhone 鎖定螢幕時網頁會停住、收不到定位，解鎖後空白的那段只能用直線估算。想記完整：把「設定 › 螢幕顯示與亮度 › 自動鎖定」暫時設為「永不」；低電量模式下要先關掉低電量模式才能改。</p>
        <p id="rWakeAgain">也可以再試一次，或開口袋模式（開的時候會再要一次）。</p>
        <button type="button" class="linkbtn" id="rWakeRetry">再試一次讓螢幕保持亮著</button></div>
      <button type="button" class="btn ghost sm iconbtn" id="rPocket">${IC.lock}口袋模式</button>
      <p class="tiny gapline" id="rGap" hidden></p>
      <p class="tiny lapmsg" id="rLapMsg" role="status"></p>
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
    // 計圈：最上面是進行中的這一圈（記過一圈才有），下面是完成的圈（新的在上）
    const cur = Run.currentLap();
    $('#rLaps').innerHTML = (cur ? `<div class="cur"><span>第 ${cur.n} 圈・進行中</span><b class="num">${hms(cur.sec)}</b></div>` : '')
      + y.laps.map((l, i) => `<div><span>第 ${i + 1} 圈</span><b class="num">${hms((l.at - (i ? y.laps[i - 1].at : 0)) / 1000)}</b></div>`).reverse().join('');
    if (y.goal && $('#rGoal')) $('#rGoal').style.width = `${Math.min(100, y.goal.km ? d / (y.goal.km * 10) : sec / (y.goal.min * 0.6))}%`;
    // 空檔：等 GPS 回來再用直線補；補過的話說一下補了多少
    const gl = $('#rGap'), gt = y.gap ? '收不到定位，等 GPS 回來後這段用直線估算' : y.estM >= 1 ? estText(y.estM) : '';
    if (gl && gl.dataset.t !== gt) { gl.dataset.t = gt; gl.textContent = gt; gl.hidden = !gt; }
    // 螢幕保持亮著要不到、或被系統放掉：跑步中超過 2 秒就提醒（不擋畫面）
    //   這個瀏覽器不支援的話，再試一次或口袋模式都沒用，只講自動鎖定
    const wk = $('#rWake');
    if (wk) {
      wk.hidden = !wakeWarn(y);
      $('#rWakeRetry').hidden = $('#rWakeAgain').hidden = Run.awake() === 'unsupported';
    }
    staleAsk(y);
    // 自動暫停或自動繼續時，按鈕要跟著換
    if ((y.status === 'paused') !== !!$('#rResume')) { runView(); return; }
    if ($('#rState')) $('#rState').textContent = y.status === 'paused' ? (y.auto ? '停下來了，自動暫停' : '已暫停') : '記錄中';
  };
  paint();
  runTick = setInterval(paint, 1000);
  showAsk();
  // 計圈：3 秒內再按不算（口袋裡誤觸、連按），只輕輕提示、不震動
  $('#rLap')?.addEventListener('click', () => {
    const ok = Run.lap(), y = Run.session(), msg = $('#rLapMsg'), btn = $('#rLap');
    if (ok) {
      navigator.vibrate?.(60);
      const l = y.laps[y.laps.length - 1], prev = y.laps[y.laps.length - 2];
      msg.textContent = `已記第 ${y.laps.length} 圈 ${hms((l.at - (prev ? prev.at : 0)) / 1000)}`;
    } else {
      msg.textContent = y?.status !== 'running' ? '暫停中不能記圈' : y.laps.length ? '剛記過一圈，這次不算' : '剛開始，3 秒後再記圈';
      btn.classList.remove('nudge'); void btn.offsetWidth; btn.classList.add('nudge');
    }
    clearTimeout(lapMsgT); lapMsgT = setTimeout(() => { msg.textContent = ''; }, 2500);
    paint();
  });
  $('#rPocket')?.addEventListener('click', pocketOn);
  // 再試一次：1 秒後還是要不到，就改口請他用自動鎖定設定
  $('#rWakeRetry')?.addEventListener('click', (e) => {
    const b = e.currentTarget; Run.keepAwake();
    setTimeout(() => { if (Run.awake() !== 'on' && b.isConnected) b.textContent = '還是沒辦法，請改用自動鎖定設定'; }, 1000);
  });
  $('#rPause')?.addEventListener('click', () => { Run.pause(); runView(); });
  $('#rResume')?.addEventListener('click', () => { Run.resume(); runView(); });
  $('#rStop')?.addEventListener('click', () => { Run.finish(); runView(); });
}
// 口袋模式：跑步時手機放口袋，全黑畫面只顯示時間、距離、目前配速，點了沒反應（防誤觸），滑到右邊才解鎖
//   螢幕保持亮著（Wake Lock 不放），黑底在 OLED 螢幕上很省電；VoiceOver 與鍵盤用「解鎖口袋模式」按鈕（看不到、口袋裡也碰不到）
//   「開始後直接進入口袋模式」記在這台手機
const pocketPref = { get() { try { return localStorage.getItem('cil-run-pocket') === '1'; } catch { return false; } }, set(v) { try { v ? localStorage.setItem('cil-run-pocket', '1') : localStorage.removeItem('cil-run-pocket'); } catch {} } };
let pocketTick = null, pocketInert = [];
function pocketOn() {
  if (!Run?.active() || document.getElementById('pocket')) return;
  Run.keepAwake();
  const el = document.createElement('div');
  el.id = 'pocket'; el.className = 'pocket';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'pkT');
  el.innerHTML = `<h2 id="pkT" class="sr" tabindex="-1">口袋模式</h2>
    <p class="pkstate" id="pkState"></p>
    <div class="pktime num" id="pkTime"></div>
    <div class="pkstats"><div><b class="num" id="pkDist"></b><span>km</span></div><div><b class="num" id="pkPace"></b><span>目前配速 /km</span></div></div>
    <p class="pkask" id="pkAsk" hidden></p>
    <p class="pkask" id="pkWake" hidden>螢幕可能會自動關掉，解鎖後再試一次</p>
    <div class="pkslide" id="pkSlide" aria-hidden="true"><span>滑到右邊解鎖</span><i id="pkKnob"></i></div>
    <button type="button" class="sr" id="pkUnlock">解鎖口袋模式</button>`;
  document.body.append(el);
  // iPhone 主畫面 App 的狀態列跟著 theme-color：口袋模式時整片黑（離開時還原）
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) { m.dataset.c = m.content; m.content = '#000000'; }
  // 後面的畫面不能點、VoiceOver 也不會跑出去
  pocketInert = [...document.body.children].filter((c) => c !== el && !c.inert);
  for (const c of pocketInert) c.inert = true;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#pkUnlock').onclick = () => pocketOff(true);
  // 滑動解鎖：按住圓鈕往右拖到底（90%）才算，中途放開會彈回去
  const knob = $('#pkKnob'), track = $('#pkSlide');
  let pid = null, x0 = 0, dx = 0, max = 1;
  const move = (v) => { dx = Math.min(max, Math.max(0, v)); knob.style.transform = `translateX(${dx}px)`; };
  knob.addEventListener('pointerdown', (e) => {
    pid = e.pointerId; x0 = e.clientX; max = Math.max(1, track.clientWidth - knob.offsetWidth - 8);
    try { knob.setPointerCapture(pid); } catch {}
    track.classList.add('drag');
  });
  knob.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e.clientX - x0); });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null; track.classList.remove('drag');
    if (e.type === 'pointerup' && dx >= max * 0.9) pocketOff(true); else move(0);
  };
  knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end);
  paintPocket();
  pocketTick = setInterval(paintPocket, 1000);
  $('#pkT').focus();
}
function pocketOff(focus) {
  clearInterval(pocketTick); pocketTick = null;
  const el = document.getElementById('pocket'); if (!el) return;
  el.remove();
  for (const m of document.querySelectorAll('meta[name="theme-color"][data-c]')) { m.content = m.dataset.c; delete m.dataset.c; }
  for (const c of pocketInert) c.inert = false;
  pocketInert = [];
  if (focus) $('#rPocket')?.focus();
}
function paintPocket() {
  const el = document.getElementById('pocket'); if (!el) return;
  const y = Run?.session();
  if (!y || !Run.active()) { pocketOff(); return; }
  $('#pkTime').textContent = hms(Run.elapsed() / 1000);
  $('#pkDist').textContent = (y.dist / 1000).toFixed(2);
  $('#pkPace').textContent = paceStr(Run.currentPace());
  $('#pkState').textContent = y.status === 'paused' ? (y.auto ? '停下來了，自動暫停' : '已暫停') : '記錄中';
  el.classList.toggle('paused', y.status === 'paused');
  $('#pkWake').hidden = !wakeWarn(y);
  staleAsk(y);
  const ask = $('#pkAsk');
  ask.hidden = !pendingAsk;
  if (pendingAsk && ask.textContent !== pendingAsk.msg) ask.textContent = pendingAsk.msg;
}
// 問「跑完了嗎？」：停太久或課表目標到了；畫面在背景時也用通知提醒
function askFinish(kind) {
  const y = Run.session(); if (!y) return;
  const msg = kind === 'goal' ? `今天的課表（${y.goal.text}）完成了，要結束這次記錄嗎？` : y.held ? '已經 5 分鐘收不到定位了，跑完了嗎？' : '已經停下來 3 分鐘了，跑完了嗎？';
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
setInterval(() => { const k = Run?.check(); if (k) askFinish(k); }, 1000);
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
  // 分頁列「跑步」的小點：記錄中綠色呼吸燈、暫停橘色（每一頁都看得到，包含跑步頁本身）
  const rt = document.querySelector('.tabs a[data-tab="/run"]'), live = me && Run?.active() ? Run.session()?.status || '' : '';
  if (rt && (rt.dataset.live || '') !== live) { if (live) rt.dataset.live = live; else delete rt.dataset.live; tabLabel(rt); }
  document.body.classList.toggle('runbar-on', !!live && !onRun);
  if (!me || !Run?.active() || onRun) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('a'); bar.id = 'runbar'; bar.className = 'runbar'; bar.href = '#/run';
    document.body.append(bar);
  }
  const y = Run.session();
  bar.innerHTML = `<i class="${y.status}"></i><span>${y.status === 'paused' ? '已暫停' : '記錄中'}</span><b class="num">${hms(Run.elapsed() / 1000)}</b><b class="num">${(y.dist / 1000).toFixed(2)} km</b><span class="sr">，回到跑步記錄</span>`;
}
setInterval(runBar, 1000);
try { if (localStorage.getItem('cil-run-session') || /^#\/run(\?|$)/.test(location.hash)) loadRun().then(runBar, () => {}); } catch {}


// ---------- manage.js（用到才載入）----------
const formView = lazy('./manage.js', 'formView');
const statsView = lazy('./manage.js', 'statsView');
const money = (n) => `NT$${Number(n || 0).toLocaleString('zh-TW')}`;
const PAID_NAME = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
const bars = (entries, total, user = false) => {
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return `<div class="bars">${entries.map(([k, n]) => `<div class="bar-row"><span class="k"${user ? ' translate="no"' : ''}>${esc(k)}</span>
    <span class="track"><i style="width:${Math.round(n / max * 100)}%"></i></span>
    <span class="n num">${n}${total ? `<span class="tiny"> ${Math.round(n / total * 100)}%</span>` : ''}</span></div>`).join('') || '<p class="muted" style="margin:0">還沒有資料</p>'}</div>`;
};
// ---------- teams.js（用到才載入）----------
const teamView = lazy('./teams.js', 'teamView');
const teamsView = lazy('./teams.js', 'teamsView');
// ---------- 我的 ----------
// ---------- 我的：像 iPhone 設定一樣分組，每一列點進去是一頁 ----------
const ME_SECTIONS = {
  profile: '個人資料', races: '我的賽事與倒數', reg: '團體報名資料', teams: '主團與分團', notify: '通知設定',
  calendar: '行事曆訂閱', display: '外觀與語言', security: '帳號與安全', privacy: '隱私', assoc: '協會', card: '會籍卡', referral: '推薦人',
};
// 設定列的色磚：跟 iPhone 設定一樣每一項一個顏色（深色模式也不會是一整排亮黃方塊）
const ROW_TILE = { '#/report': 'green', '#/challenge': 'orange', '#/me/races': 'red', '#/me/reg': 'indigo', '#/tickets': 'purple', '#/me/teams': 'teal', '#/me/referral': 'orange',
  '#/me/notify': 'red', '#/me/calendar': 'orange', '#/me/display': 'indigo', '#/me/security': 'gray', '#/me/privacy': 'blue', '#/me/assoc': 'indigo', '#/me/card': 'teal',
  '#/admin': 'gray', '#/admin/settings': 'gray', '#/roster': 'blue', '#/logs/team': 'green', '#/plan/new': 'green', '#/plan/season': 'green', '#/plan/race': 'red', '#/plan/guide': 'teal', '#/plan/setup': 'gray', '#/admin/tree': 'gray',
  '#/ach': 'orange', '#/pb': 'red', '#/cheers': 'purple', '#/admin/ach': 'gray' };
// 標題與副標中間放一個只給螢幕閱讀器的「，」：VoiceOver 唸「通知設定，推播類別」，不會連成一串沒有停頓
const rowText = (title, sub) => `<span class="st"><b>${title}</b>${sub ? `<span class="sr">，</span><span class="tiny">${sub}</span>` : ''}</span>`;
const row = (href, icon, title, sub = '', badge = '') => `<a class="setrow" href="${href}"><span class="sic"${ROW_TILE[href] ? ` style="--sc:var(--tile-${ROW_TILE[href]})"` : ''}>${icon}</span>${rowText(title, sub)}${badge}<span class="chev" aria-hidden="true"></span></a>`;
const btnRow = (id, icon, title, sub = '') => `<button class="setrow" id="${id}"><span class="sic">${icon}</span>${rowText(title, sub)}<span class="chev" aria-hidden="true"></span></button>`;
const group = (title, rows) => (rows.filter(Boolean).length ? `<section class="setgroup">${title ? `<h2 class="sgt">${title}</h2>` : ''}<div class="card setcard">${rows.filter(Boolean).join('')}</div></section>` : '');
const subTitle = (title, sub = '') => largeTitle(title, sub);
const MI = {
  person: IC.runner, trophy: ic('<path d="M7 4h10v4a5 5 0 0 1-10 0Z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 3M17 6h2.5a2.5 2.5 0 0 1-2.6 3M12 13v4M8.5 20h7M10 17h4"/>'), report: ic('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'), flag: ic('<path d="M5.5 21V4M5.5 4.5h11l-2 3.7 2 3.8h-11"/>'),
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
  form: ic('<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4V3h6v1M8.5 10h7M8.5 13.5h7M8.5 17h4"/>'),
  camera: ic('<path d="M4 8.2a2 2 0 0 1 2-2h1.9l1.5-2h5.2l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.6" r="3.6"/>'),
  trend: ic('<path d="M3 20h18M4 16l5-5 4 3 7-8"/>'),
  calsub: ic('<rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4M12 12.5v5M9.8 15.3 12 17.5l2.2-2.2"/>'),
  display: ic('<circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 8h6.5M12 12h8M12 16h6.5"/>'),
  addhome: ic('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>'),
  sliders: IC.sliders,
  referral: REF_IC,
  tree: ic('<rect x="9" y="3" width="6" height="5" rx="1.5"/><rect x="3" y="16" width="6" height="5" rx="1.5"/><rect x="15" y="16" width="6" height="5" rx="1.5"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>'),
  // 成績與挑戰（圖示在 achrule.js，後台與團員頁共用）
  medal: ic(ACH_ICONS.medal), sparkle: ic(ACH_ICONS.sparkle), shirt: ic(ACH_ICONS.shirt),
};
async function meView(section) {
  const welcome = new URLSearchParams(location.hash.split('?')[1] || '').get('welcome');
  const googleMsg = new URLSearchParams(location.hash.split('?')[1] || '').get('google');
  // Google 綁定回來（?google=）：沒指定子頁的是帳號與安全；從推薦人頁去確認的回到 #/me/referral
  if (googleMsg && !section) section = 'security';
  if (!section) return meHome(welcome);
  if (!ME_SECTIONS[section]) { location.hash = '#/me'; return; }
  return meSection(section, googleMsg);
}
// 「我的賽事與倒數」的副標：目前倒數哪一場、還有幾天
function raceSub() {
  const r = cfg.race; if (!r?.date) return '選擇右上角倒數哪一場';
  const days = Math.round((new Date(`${r.date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  if (days < 0) return '選擇右上角倒數哪一場';
  return `倒數：<span translate="no">${esc(r.name.replace(/^20\d\d\s*/, '').replace('馬拉松', '馬'))}</span>・${days ? `${days} 天` : '今天'}`;
}
// 「通知」的副標：這支手機有沒有開推播（主畫面 App 才看得到真的狀態；讀不到就寫一般說明）
async function pushSub() {
  try { const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 800))]); return reg ? await reg.pushManager?.getSubscription() : null; } catch { return null; }
}
// 分組：跟側邊欄同一套名稱（賽事與報名、跑團、幹部、設定）；常用的在上面，每一項從「我的」最多兩下就到
//   訓練報表與里程挑戰的上一層是課表，不放這裡（點進去分頁列會跳到課表）
//   幹部組的「週報」：理事長、行政人員看協會版（可切換分團），分團團長看自己的分團（weeklyHref）
async function meHome(welcome) {
  const main = teamOf(me.main_team);
  const admin = allow('members') || allow('roles') || allow('settings');
  const weekly = weeklyHref();
  const staff = admin || allow('roster') || canTeamLogs() || canPublishPlan() || !!weekly || achViewer();
  view.innerHTML = `
    ${largeTitle('我的')}
    ${mfaBanner()}
    ${startShown(welcome) ? startCard() : ''}
    <a class="card mecard" href="#/me/profile">
      ${avatar(me)}
      <span class="mi"><b><span translate="no">${esc(me.name)}</span></b>${me.nickname ? ` <span class="tiny"><span translate="no">${esc(me.nickname)}</span></span>` : ''}
        <span class="tiny" style="display:block">${me.title ? `<span translate="no">${esc(me.title)}</span>` : esc(me.roleName || ROLE_NAME[me.role] || '團員')}・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組</span></span>
      ${main ? `<span class="pill team" style="--tc:${esc(main.color)}">${teamIcon(main, 'xs')}<span translate="no">${esc(main.name)}</span></span>` : '<span class="pill">主團未設定</span>'}
    </a>
    ${group('賽事與報名', [
      row('#/me/races', MI.flag, '我的賽事與倒數', raceSub()),
      achOn() || me.cheer_board || me.ach?.needSize > 0 ? row('#/pb', MI.medal, '我的成績', 'PB 登錄與審核', me.ach?.needSize > 0 ? '<span class="pill wait">選團服尺寸</span>' : '') : '',
      row('#/tickets', MI.ticket, '入場券與團購', '領取 QR Code、中獎紀錄'),
      row('#/me/reg', MI.form, '團體報名資料', '幹部代為報名馬拉松時使用', '<span id="regBadge"></span>'),
    ])}
    ${group('跑團', [
      row('#/me/teams', MI.team, '主團與分團', main ? `主團：<span translate="no">${esc(main.name)}</span>` : '主團由管理員設定'),
      refOn() || me.referral?.has || me.referral?.pending ? row('#/me/referral', MI.referral, '推薦人', me.referral?.has ? '已填・你推薦的跑友' : '誰介紹你來的、你推薦的跑友',
        me.referral?.pending ? `<span class="pill wait">${me.referral.pending} 位待確認</span>` : '') : '',
      row('#/me/assoc', MI.building, esc(org().name || '台灣耕跑團協會'), `${esc(me.membershipName || '跑友')}・入會、章程與文件`),
      me.membership === 'active' ? row('#/me/card', MI.idcard, '會籍卡', me.paid_until ? `會費繳至 ${esc(me.paid_until)}` : '出示給幹部掃描') : '',
    ])}
    ${staff ? group('幹部', [
      admin ? row('#/admin', MI.admin, '管理後台', allow('settings') ? '總覽、週報、會員、權限、分團、稽核' : '總覽、會員、權限、分團、稽核') : '',
      allow('settings') ? row('#/admin/settings', MI.sliders, '系統設定', '活動報名預設、協會、地圖資料、功能開關') : '',
      achViewer() ? row('#/admin/ach', MI.medal, '成績與挑戰', achApprover() ? '審核成績、設定挑戰與團服' : '挑戰與團服的統計', achApprover() && me.ach?.queue > 0 ? `<span class="pill wait">${me.ach.queue}</span>` : '') : '',
      weekly ? row(weekly, MI.trend, '週報', allow('settings') ? '上週的活動、報名、出席與系統健康' : '上週分團的活動、報名與出席') : '',
      allow('roster') ? row('#/roster', MI.roster, '團員名冊') : '',
      canTeamLogs() ? row('#/logs/team', MI.trend, '團員訓練', '分享給教練的團員每週完成率') : '',
      canPublishPlan() ? row('#/plan/new', MI.plan, '發布課表', allow('plan') ? '教練' : '分團團長') : '',
    ]) : ''}
    ${group('設定', [
      row('#/me/notify', MI.bell, '通知設定', `<span id="pushSub">${cfg.vapid ? '推播類別、這支手機的推播' : '推播類別'}</span>`),
      row('#/me/security', MI.shield, '帳號與安全', `${me.google ? 'Google 已綁定' : '綁定 Google'}、通行金鑰、登出`),
      row('#/me/display', MI.display, '外觀與語言', '深淺色、分頁列、語言 Language'),
      row('#/me/calendar', MI.calsub, '行事曆訂閱', '團練與賽事自動出現在手機行事曆', cfg.calendarOn ? '<span class="pill solid">已開啟</span>' : ''),
      row('#/me/privacy', MI.eye, '隱私', '分享給教練、排行榜、下載或刪除資料'),
    ])}
    ${group('', [btnRow('shareApp', MI.share, '分享耕跑團 App', '用 LINE、QR Code 邀朋友一起跑'), btnRow('openGuide', MI.help, '使用說明', '開始使用、五個分頁的導覽')])}`;
  bindStepup();
  bindStart();
  // 使用說明：重新打開「開始使用」卡（加到主畫面、推播、組別的進度還在），做完可以看五個分頁的導覽
  $('#openGuide').onclick = () => reopenStart();
  $('#shareApp').onclick = () => shareApp();
  // 團體報名資料填好了沒：畫面先出來，狀態晚一點補上（要解密，不要擋住整頁）
  api('/me/race-profile').then((r) => { const b = $('#regBadge'); if (b) b.outerHTML = r?.complete ? '<span class="pill solid">已填好</span>' : r?.profile ? '<span class="pill wait">未填完</span>' : ''; }).catch(() => {});
  // 通知的副標：這支手機的推播狀態
  if (cfg.vapid) pushSub().then((sub) => { const el = $('#pushSub'); if (el) el.textContent = sub ? '推播已開啟' : '還沒開推播'; });
}
// 「我的」的子頁（me.js，用到才載入）：個人資料、賽事、報名資料、分團、通知、行事曆、外觀、安全、隱私、協會、會籍卡、分享 App
const meSection = lazy('./me.js', 'meSection');
const shareApp = lazy('./me.js', 'shareApp');

// quiet：「開始使用」卡自己更新畫面與播報（不跳提示、不重畫整頁）；成功開啟回傳 true
async function togglePush(sub, { quiet = false } = {}) {
  // 說明 sheet 關掉後焦點回到按下的那顆（通知設定的 #pushBtn 或開始使用卡的 #stPush）；Safari 點按鈕不會聚焦，用目前頁面上的那顆
  const act = document.activeElement, opener = act && act !== document.body ? act : $('#pushBtn') || $('#stPush');
  try {
    await Device.pushReady();
    const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!reg || typeof Notification === 'undefined') return toast('這個瀏覽器不支援通知，請用 Safari 或 Chrome 打開，並加到主畫面');
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
      Device.markPush(lsOrNull(), null);
      toast('已關閉通知'); render(); return;
    }
    // 第一次開啟前先說明會推播什麼（權限請求要在使用者按下按鈕時發出）
    const perm = Notification.permission === 'granted' ? 'granted' : await pushExplainer(opener);
    if (perm === null) return;
    if (perm !== 'granted') return toast('瀏覽器沒有允許通知');
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(cfg.vapid) });
    const j = s.toJSON();
    await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
    Device.markPush(lsOrNull(), me?.id);
    if (quiet) return true;
    toast('已開啟通知'); render();
  } catch (e) { toast(e.message || '通知設定失敗'); }
  return false;
}
// 開啟推播前的說明 sheet：回傳權限結果；按「先不要」或關掉回傳 null
function pushExplainer(opener) {
  return new Promise((done) => {
    let picked = false;
    const s = openSheet('要開啟推播嗎？', `<h3>要開啟推播嗎？</h3><p class="muted" style="margin:0">推播會通知你活動異動、報名提醒和帳號安全。類別與推播時間（即時或每日摘要）可以之後在「我的 › 通知設定」調整。</p>
      <div class="choices"><button type="button" class="btn block" data-go>開啟推播</button><button type="button" class="btn ghost block" data-close>先不要</button></div>`, opener);
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
  if (h === '/studio') return feat('gps') ? ['#/run', '跑步'] : ['#/', '團練'];
  const p = h.split('/');
  if (h.startsWith('/me/')) return ['#/me', '我的'];
  // 從跑步頁進來的記錄（手動記一筆、跑完存到訓練紀錄）：留在「跑步」分頁，不跳到課表
  if (h === '/log' && /[?&](from=run|src=gps)(&|$)/.test(location.hash)) return ['#/run', '跑步'];
  if (h.startsWith('/e/') && p.length > 3) return [`#/e/${p[2]}`, '活動'];
  if (h.startsWith('/edit/')) return [`#/e/${p[2]}`, '活動'];
  if (h.startsWith('/logs/m/')) return ['#/logs/team', '團員訓練'];
  // 成績與挑戰：目標挑戰在課表的工具裡、我的成績在「我的」；後台頁回到管理後台
  if (h === '/ach') return ['#/plan', '課表'];
  if (h.startsWith('/ach/') || h === '/cheers') return ['#/ach', '目標挑戰'];
  if (h === '/pb') return ['#/me', '我的'];
  if (h.startsWith('/pb/')) return ['#/pb', '我的成績'];
  if (h === '/admin/ach') return ['#/admin', '管理後台'];
  if (h.startsWith('/admin/ach/')) return ['#/admin/ach', '成績與挑戰'];
  if (h.startsWith('/admin/settings/')) return ['#/admin/settings', '系統設定'];
  if (h === '/admin/settings') return ['#/admin', '管理後台'];
  if (h === '/admin/tree') return ['#/admin?tab=members', '管理後台'];   // 推薦族譜：回到管理後台的會員分頁
  if (['/challenge', '/report', '/log', '/plan/new', '/logs/team'].includes(h) || h.startsWith('/plan/')) return ['#/plan', '課表'];
  if (h.startsWith('/t/')) return ['#/teams', '分團'];
  // 分團週報（#/weekly?team=）：回到那個分團；沒帶分團（理事長、行政人員）回管理後台
  if (h === '/weekly') { const t = new URLSearchParams(location.hash.split('?')[1] || '').get('team'); return /^[\w-]{1,16}$/.test(t || '') ? [`#/t/${t}`, '分團'] : ['#/admin', '管理後台']; }
  if (['/teams', '/tickets', '/admin', '/roster'].includes(h) || h.startsWith('/m/')) return ['#/me', '我的'];
  return ['#/', '團練'];
}
// 這一頁屬於哪個分頁：本身是分頁就是自己，不然沿著上一層往上找（最多找 4 層）
function tabOf(h) {
  const TOP = feat('gps') ? ['/', '/plan', '/run', '/map', '/me'] : ['/', '/plan', '/run', '/map', '/studio', '/me'];
  for (let i = 0; i < 4 && !TOP.includes(h); i++) h = parentOf(h)[0].slice(1).split('?')[0];   // 上一層可能帶分頁參數（#/admin?tab=members）
  return h;
}
// 頁面名稱（返回鍵顯示「‹ 上一頁的名稱」）
function nameOf(h) {
  const N = { '/': '團練', '/plan': '課表', '/run': '跑步', '/studio': '拍照', '/me': '我的', '/calendar': '行事曆', '/map': '地圖', '/challenge': '挑戰', '/admin': '管理後台',
    '/teams': '分團', '/report': '報表', '/tickets': '入場券', '/notifications': '通知', '/past': '過去的團練', '/roster': '名冊', '/logs/team': '團員訓練',
    '/plan/season': '全季課表', '/plan/race': '賽事準備', '/plan/guide': '配速與用語', '/plan/setup': '課表設定', '/weekly': '週報', '/admin/tree': '推薦族譜',
    '/ach': '目標挑戰', '/pb': '我的成績', '/cheers': '恭喜榜', '/admin/ach': '成績與挑戰' };
  if (N[h]) return N[h];
  if (h.startsWith('/me/')) return ME_SECTIONS[h.slice(4)] || '我的';
  if (h.startsWith('/e/')) return h.endsWith('/stats') ? '統計' : '活動';
  if (h.startsWith('/admin/settings')) return '系統設定';
  if (h.startsWith('/ach/')) return '挑戰';
  if (h.startsWith('/pb/')) return '我的成績';
  if (h.startsWith('/admin/ach/')) return '成績與挑戰';
  if (h.startsWith('/t/')) return '分團';
  if (h.startsWith('/plan/')) return '課表';
  return '返回';
}
// GPS 跑步開著時，拍照收進「跑步」：是跑步的子頁（返回鍵「‹ 跑步」、分頁列亮跑步）；關掉 GPS 時拍照才是分頁
const isTop = (h) => TOP_PAGES.includes(h) && !(h === '/studio' && feat('gps'));
const navStack = [];
function paintBack(hash) {
  if (navStack[navStack.length - 2] === hash) navStack.pop(); else if (navStack[navStack.length - 1] !== hash) navStack.push(hash);
  if (navStack.length > 30) navStack.shift();
  const btn = $('#backBtn'), detail = !!me && !isTop(hash) && !cfg.needConsent;
  document.body.classList.toggle('detail', detail);
  btn.hidden = !detail;
  if (!detail) return;
  const [href, parentLabel] = parentOf(hash);
  const label = navStack.length > 1 ? nameOf(navStack[navStack.length - 2].split('?')[0]) : parentLabel;
  $('#backLabel').textContent = label;
  btn.setAttribute('aria-label', I18N.lang === 'en' ? `Back to ${I18N.t(label)}` : `返回${label}`);   // 屬性改了 MutationObserver 不會再翻：直接給英文
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
  // 寬螢幕依頁面決定內容欄寬度（style.css 的 body[data-page]）
  document.body.dataset.page = hash.split('/')[1] || 'home';
  // 子頁面（管理後台、名冊、活動統計…）也亮起它所屬的分頁
  paintTabs(hash);
  paintCountdown();
  // asked：這次已經問過伺服器（第一次開 App 的 /me?boot=1），沒登入就不用再問一次 /me
  let guest = false, asked = false;
  if (!me && firstLoad) {
    firstLoad = false;
    const fresh = api('/me?boot=1');
    const stale = await peekBoot();
    if (stale?.member && !stale.needConsent) {
      // 先用上次的資料畫出來，網路回來後資料有變才重畫（不重播進場動畫、使用者正在輸入就不打擾）
      me = stale.member; cfg = stale; bootData = stale.boot || null; vitals.warm = true; meStale = true;
      fresh.then((r) => {
        const same = (x) => JSON.stringify({ ...x, serverNow: 0 });   // 伺服器時間每次都不同，不算資料有變
        const changed = same(r) !== same(stale);
        me = r.member; cfg = r; bootData = r.boot || null; meStale = false;
        // 伺服器確認是同一個人：這時才補傳離線紀錄、重新開啟登入過期時關掉的推播
        if (!changed && me) { bindDeviceData(me.id).then((b) => { if (b === 'same' || b === 'adopted') resumePush(); }); flushLogQueue(); return; }
        const typing = document.activeElement?.matches?.('input, textarea, select') && view.contains(document.activeElement);
        if (me && typing) return;
        document.body.classList.add('quiet');
        render().finally(() => setTimeout(() => document.body.classList.remove('quiet'), 50));
      }).catch(() => {});
    } else {
      try { const r = await fresh; me = r.member; cfg = r; bootData = r.boot || null; guest = !me; asked = true; } catch { me = null; }
    }
  }
  if (!me && !asked) {
    try { const r = await api('/me'); me = r.member; cfg = r; guest = !me; meStale = false; } catch { me = null; }
  }
  // 主人不明時（要認出主人或問本人）先等它做完再畫，不會先把別人的課表設定畫出來；換人時清除是同步的，不用等
  const bound = bindDeviceData(me?.id, guest);
  if (me && Device.ownerOf(lsOrNull()) !== me.id) await bound;
  if (me && !meStale) bound.then((b) => { if (b === 'same' || b === 'adopted') resumePush(); });
  paintCountdown();
  applyFeatures();
  $('#bell').hidden = !me;
  document.body.classList.toggle('guest', !me);
  // 隱私權政策與登入畫面也要換分頁標題、消耗換頁的焦點設定（不然 title 停在上一頁、焦點掉到 body）
  if (hash === '/privacy') { if (!me) { try { const r = await api('/me'); me = r.member; cfg = r; } catch {} } $('#ctitle').textContent = ''; privacyView(); return pageSettled(); }
  if (!me) { $('#ctitle').textContent = ''; loginView(); return pageSettled(); }
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
  untype();   // iPhone Safari 移除還有焦點的欄位時不送 focusout：換完畫面馬上再檢查一次，分頁列才不會一直收著
  // 第一個畫面畫好了：記下開啟到可用的時間，20 秒後（或離開時）送出
  if (vitals.ready == null) { vitals.ready = performance.now(); vitals.page = hash.replace(/\/[\w-]{8,}/g, '/:id').slice(0, 40); setTimeout(sendVitals, 20000); }
  $('.top').classList.toggle('titled', false);
  pageSettled();
}
// 換頁後：分頁標題換成這一頁的名稱；使用者自己換頁時，焦點移到新頁面的大標題（VoiceOver 才知道已經換頁、現在在哪一頁）
//   點分頁列換頁：焦點留在分頁上，只唸一次頁名；第一次打開、資料回來後的重畫（不是使用者換頁）不動焦點
//   focusAfterRender(selector)：這次重畫完要把焦點放到指定的地方（例如報名後的「我的報名狀態」）
let navKind = null, focusNext = null;
//   nav：只有使用者換頁時才移焦點（頁面裡改設定後的重畫不搶焦點）
const focusAfterRender = (sel, { nav = false } = {}) => { focusNext = nav ? { nav, sel } : sel; };
function focusEl(el) {
  if (!el) return false;
  if (!el.matches(FOCUSABLE)) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: el.tagName === 'H1' });
  return document.activeElement === el;
}
function pageSettled() {
  const h1 = view.querySelector('h1');
  const name = ($('#ctitle').textContent || h1?.textContent || '').trim();
  const app = I18N.t('耕跑團');
  document.title = name && name !== app ? `${name} – ${app}` : app;
  const kind = navKind, want = focusNext; navKind = null; focusNext = null;
  if (document.documentElement.classList.contains('guiding')) return;   // 使用說明導覽換頁：焦點留在導覽的說明框
  const sels = want?.nav ? (kind ? want.sel : null) : want;
  if (sels && [].concat(sels).some((sel) => focusEl(view.querySelector(sel)))) return;
  if (kind === 'go' && h1 && focusEl(h1)) return;
  if (kind && name) announce(name);
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
    if (hash === '/weekly') return await lazy('./admin.js', 'weeklyView')();   // 分團頁的「上週分團週報」（畫面在 admin.js）
    if (hash === '/admin/tree') return await lazy('./admin.js', 'treeView')();   // 推薦族譜（畫面在 admin.js）
    // 成績與挑戰：團員頁在 achieve.js、後台在 admin.js（都是用到才下載）
    if (hash === '/ach') return await lazy('./achieve.js', 'achView')();
    const mach = hash.match(/^\/ach\/c\/([\w-]{1,16})$/); if (mach) return await lazy('./achieve.js', 'achCampaignView')(mach[1]);
    if (hash === '/pb') return await lazy('./achieve.js', 'pbView')();
    if (hash === '/pb/new') return await lazy('./achieve.js', 'pbFormView')();
    const mpb = hash.match(/^\/pb\/([\w-]{1,16})\/edit$/); if (mpb) return await lazy('./achieve.js', 'pbFormView')(mpb[1]);
    if (hash === '/cheers') return await lazy('./achieve.js', 'cheersView')();
    if (hash === '/admin/ach') return await lazy('./admin.js', 'achAdminView')();
    if (hash === '/admin/ach/new') return await lazy('./admin.js', 'achAdminView')('new');
    const maa = hash.match(/^\/admin\/ach\/c\/([\w-]{1,16})(\/edit)?$/); if (maa) return await lazy('./admin.js', 'achAdminView')(maa[2] ? 'edit' : 'c', maa[1]);
    // 系統設定：清單（等於 #/admin?tab=settings）與子頁
    if (hash === '/admin/settings') return await settingsPage();
    const aset = hash.match(/^\/admin\/settings\/(\w+)$/);
    if (aset) return await settingsPage(aset[1]);
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
    // 課表的全季、賽事準備、配速與用語：課表教練關掉時不開放；課表設定一律開放（項目與組別是帳號資料，課表週期也在這裡）
    const pc = hash.match(/^\/plan\/(season|race|guide|setup)$/);
    if (pc) {
      if (feat('coach') || pc[1] === 'setup') { viewCleanup = await coachView(pc[1]); return; }
      view.innerHTML = `<div class="card">${emptyState('runner', '這個功能目前沒有開放')}<p class="tiny center" style="margin:0">管理員可以在「功能與畫面」打開課表教練</p></div>`;
      return;
    }
    const pl = hash.match(/^\/plan(?:\/(\d+))?$/);
    if (pl) return await planView(pl[1] ? Number(pl[1]) : 0);
    for (const a of document.querySelectorAll('.tabs a')) a.removeAttribute('aria-current');
    view.innerHTML = `${largeTitle('找不到頁面')}<div class="card">${emptyState('runner', '這個連結可能已經失效')}<a class="btn block" href="#/">回到團練</a></div>`;
  } catch (e) {
    // 找不到或沒有權限：重試也沒用，主要動作是回首頁
    const final = e.status === 404 || e.status === 403;
    view.innerHTML = `<div class="card">${emptyState('runner', esc(e.message))}<div class="row" style="justify-content:center;gap:8px">${final ? '<a class="btn sm" href="#/">回首頁</a>'
      : '<button class="btn sm" id="retryBtn">重試</button><a class="btn ghost sm" href="#/">回首頁</a>'}</div></div>`;
    // 版本混在一起的錯誤：重試要重新載入整個 App，只重畫這一頁還是會用到舊程式
    if ($('#retryBtn')) $('#retryBtn').onclick = () => (VERSION_SKEW.test(e.message || '') ? location.reload() : render());
    if (VERSION_SKEW.test(e.message || '')) reloadForUpdate();
  }
}

// 深淺色：跟隨系統，可以在「我的 › 外觀與語言」手動覆寫並記住（選「自動」就清掉，回到跟隨系統）
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

// 捲動：超過一點點就讓頂部列變成玻璃；大標題捲出畫面就把標題顯示在頂部列；
//   往下捲（超過 120）分頁列縮小，往上捲 24 以上、捲到最底、焦點進到分頁列或換頁時展開；地圖、側邊欄、不到 1.5 個螢幕高的頁面不縮小
let lastY = 0, peakY = 0;
addEventListener('scroll', () => {
  const y = scrollY, top = $('.top'), lt = $('.lt h1'), tabs = $('#tabs'), H = document.documentElement.scrollHeight;
  top.classList.toggle('stuck', y > 4);
  top.classList.toggle('titled', !!lt && lt.getBoundingClientRect().bottom < top.offsetHeight);
  if (wideNav.matches || document.body.classList.contains('fullmap') || H < innerHeight * 1.5) tabs.classList.remove('mini');
  else if (y > lastY) { peakY = y; if (y > 120 && !tabs.contains(document.querySelector(':focus-visible'))) tabs.classList.add('mini'); }
  else if (peakY - y >= 24) tabs.classList.remove('mini');
  if (y + innerHeight >= H - 2) tabs.classList.remove('mini');
  lastY = y;
}, { passive: true });
// 鍵盤焦點進到分頁列就展開（點擊造成的焦點不算，不然點過分頁後就再也不會縮小）
$('#tabs').addEventListener('scroll', fitTabs, { passive: true });
// 手指按下地圖分頁就先連線、下載地圖模組（放開才換頁）
$('#tabs').addEventListener('pointerdown', (e) => { if (e.target.closest('a[data-tab="/map"]')) warmMap(); }, { passive: true });
addEventListener('resize', fitTabs, { passive: true });
$('#tabs').addEventListener('focusin', (e) => { if (e.target.matches(':focus-visible')) $('#tabs').classList.remove('mini'); });
// 點分頁：換分頁不做整頁轉場（選取膠囊滑過去）；再點一次目前的分頁，在子頁就回到這個分頁的第一層、在第一層就捲回頂端（地圖收回抽屜）
let navFromTab = false;
$('#tabs').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab], a[data-nav]'); if (!a) return;
  if (matchMedia('(pointer:coarse)').matches) navigator.vibrate?.(8);   // Android 才有；iPhone 網頁沒有震動 API
  const h = curHash(), full = location.hash.replace(/^#/, '') || '/';
  if (a.dataset.tab && h !== '/notifications' && a.dataset.tab === tabOf(h)) {
    e.preventDefault();
    // 只有剛好在分頁本身（沒有子路徑、沒有 ?）才捲回頂端；全季課表、賽事準備、?c=club 這類都回到分頁的第一層
    if (h === '/map') dispatchEvent(new Event('tabreselect'));
    else if (full !== a.dataset.tab) { navStack.length = 0; navFromTab = true; location.hash = a.getAttribute('href'); }
    else scrollTo({ top: 0, behavior: reduceMotion() ? 'instant' : 'smooth' });
    return;
  }
  navFromTab = true; setTimeout(() => { navFromTab = false; }, 400);
});
// 跳到主要分頁（鍵盤）：網址用 # 當路由，所以不讓連結改網址，直接把焦點移到目前的分頁
$('#skipTabs').addEventListener('click', (e) => { e.preventDefault(); ($('.tabs a[aria-current]') || $('.tabs > a[data-tab]:not([hidden])'))?.focus(); });
// 觸控裝置打開鍵盤時收起下方分頁列，避免浮在鍵盤上面擋住欄位（1024 以上是側邊欄，不收）
//   只算會叫出鍵盤的欄位：下拉選單、日期時間用系統選擇器，不收分頁列
const textField = (el) => !!el?.isConnected && !!el.matches?.('textarea, [contenteditable]:not([contenteditable=false]), input:not([type]), input[type=text], input[type=search], input[type=email], input[type=tel], input[type=url], input[type=number], input[type=password]');
function untype() { if (!textField(document.activeElement)) document.body.classList.remove('typing'); }
//   iPhone Safari 移除還有焦點的欄位時不送 focusout（送出表單後畫面重畫）：收著的時候每 0.4 秒檢查一次焦點還在不在欄位上
let typeTimer = 0;
if (matchMedia('(pointer:coarse)').matches) {
  document.addEventListener('focusin', (e) => {
    if (!textField(e.target) || wideNav.matches) return;
    document.body.classList.add('typing');
    clearInterval(typeTimer);
    typeTimer = setInterval(() => { untype(); if (!document.body.classList.contains('typing')) clearInterval(typeTimer); }, 400);
  });
  document.addEventListener('focusout', () => setTimeout(untype, 150));
  wideNav.addEventListener?.('change', () => { if (wideNav.matches) document.body.classList.remove('typing'); });
}

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
  navKind = navFromTab ? 'tab' : 'go';
  // 不支援或使用者設定「減少動態效果」：直接換頁，不做轉場；點分頁列換分頁也不做（選取膠囊滑過去，不被整頁淡入淡出蓋掉）
  if (navFromTab || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { navFromTab = false; return go(); }
  // 連續換頁時前一個轉場會被中斷；三個 promise 都會 reject，全部接住
  const t = document.startViewTransition(go);
  for (const p of [t.ready, t.updateCallbackDone, t.finished]) p.catch(() => {});
});
// 英文介面：先載入字典再畫第一個畫面，避免先閃一下中文
I18N.init().catch(() => {}).finally(() => render());
// Service Worker：新版本裝好後先等待；剛打開 App、或在背景放了 3 分鐘以上回來，而且沒有填到一半的表單、沒在跑步時，
//   直接換新版（不然一直不關 App 的人會停在舊版）；其他時候跳出提示讓使用者決定
document.addEventListener('input', (e) => { if (e.target.closest?.('#view form')) formDirty = true; }, true);
const busyRunning = () => { try { return ['running', 'paused'].includes((Run ? Run.session() : JSON.parse(localStorage.getItem('cil-run-session') || 'null'))?.status); } catch { return false; } };
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
addEventListener('appinstalled', () => { installEvt = null; try { localStorage.setItem('cil-installed', '1'); } catch {} saveStart({ install: 'done' }); document.querySelectorAll('.installcard').forEach((c) => c.remove()); if ($('#startCard')) repaintStart(); });

// 拆出去的模組（admin.js、photo.js…）從這裡拿共用的工具與狀態
export { tbdTag, timeHtml, signedWord, gatherVerb, unitOf, tpAt, canMeetup, meetupTeams, refOn, achOn, achRankOn, kindLabel, tilePreload, focusEl, legacyData, removeLegacy, addrField, bindAddrField, latest, $, cfg, downloadAuthed, scanSheet, FEEL, IC, KIND_NAME, LOG_ICON, LOG_STATUS_NAME, MI, PAID_NAME, ROLE_NAME, TAB_DEFAULT, TEAM_PERMS, coachTeam, TEAM_ROLE_NAME, ago, allow, api, applyFeatures, avatar, barChart, bars, bindComments, bindStepup, btnRow, choose, coachPrefs, copy, countdownPicker, dayLabel, dstr, emptyState, esc, eventCard, feat, fixText, group, ic, largeTitle, me, mfaBanner, money, myCycle, nrow, org, pad2, paintCountdown, passkey, planSeg, queueLog, raceTarget, refreshMe, render, route, row, setCoachPrefs, squareIcon, startKey, studio, subTitle, teamAllow, teamIcon, teamOf, teams, toast, rich, keep, names, view, ymd, askReason, isOffline, nowTp, signupDefaults, submitLabel, camLazy, openSheet, apiAll, fmtDuration, fmtDistPace, parseHMS,
  // event.js、me.js
  applyCounts, bellState, canScan, dayPattern, mapsUrl, once, qrSVG, routeSvg, scan, setStopScan, GOOGLE_G, NICON, applyTabs, applyTheme, askLegacyOnLeave,
  bindInstall, clearDeviceData, dropPush, googleHref, iconsOnly, installCard, isStandalone, lsOrNull, pkSupported, reduceMotion, theme, togglePush, setMe,
  // map.js（休息站用到才載入）
  load,
  // 無障礙共用：播報、表單錯誤、重畫後的焦點
  announce, fieldError, focusAfterRender,
  // coach.js：課表設定從「開始使用」來，存好組別後打勾
  startGroupSaved, startBack };
