// 使用說明導覽（聚光）：參照潛圖的做法——在真正的畫面上一步一步介紹，畫面變暗、只亮出要介紹的地方，旁邊一個玻璃說明框。
// 導覽會實際帶到每個功能（首頁、課表、跑步記錄、拍照分享、我的），結束或略過時回到開始前的頁面，不會新增任何資料。
// 第一次登入後自動出現一次（localStorage cil-guide）；之後從「我的 → 使用說明」再看。

const KEY = 'cil-guide', VER = '2';   // 改版本號時 app.js 的 Guide.maybeStart 也要一起改
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ic = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  map: ic('<path d="M9 4.5 3.5 6.6v13l5.5-2.1 6 2.1 5.5-2.1v-13L15 6.6Z"/><path d="M9 4.5v13M15 6.6v13"/>'),
  calendar: ic('<rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/>'),
  sun: ic('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M5.2 18.8l1.4-1.4M17.4 6.6l1.4-1.4"/>'),
  megaphone: ic('<path d="M4 10v4a1 1 0 0 0 1 1h2l6 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>'),
  flag: ic('<path d="M5.5 21V4M5.5 4.5h11l-2 3.7 2 3.8h-11"/>'),
  bell: ic('<path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/>'),
  plan: ic('<rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M7.6 13.4h3M7.6 16.6h8.8"/>'),
  runner: ic('<circle cx="14" cy="4.6" r="1.6"/><path d="M6 20.5l2.6-5 2.4-1.6-1-4.2 3.6-1.4 1.8 3.2 3.4 1"/><path d="M11 13.9l1.3 3.2 3.4 2.6"/>'),
  camera: ic('<path d="M4 8.2a2 2 0 0 1 2-2h1.9l1.5-2h5.2l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.6" r="3.6"/>'),
  person: ic('<circle cx="12" cy="8.4" r="3.6"/><path d="M4.8 20.2c.7-3.6 3.6-5.6 7.2-5.6s6.5 2 7.2 5.6"/>'),
  check: ic('<path d="M5 12.5l4.2 4.2L19 7"/>'),
  plus: ic('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>'),
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.closest('[hidden]'); };
const pick = (...sels) => sels.map((s) => (typeof s === 'string' ? document.querySelector(s) : s)).find(shown) || null;
const tab = (t) => document.querySelector(`.tabs a[data-tab="${t}"]`);
// 功能開關看分頁列就知道（app.js 的 applyFeatures 設好的）：GPS 開著時跑步分頁看得到；拍照開著時，不是分頁就是側邊欄的「拍照分享」
const gpsOn = () => !tab('/run')?.hidden;
const studioOn = () => !tab('/studio')?.hidden || !document.querySelector('.navmore a[data-nav="/studio"]')?.hidden;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 換頁後等畫面畫好（找得到目標或最多 3 秒）
async function go(hash, ready) {
  if (location.hash.split('?')[0] !== hash) location.hash = hash;
  for (let i = 0; i < 30; i++) { await wait(100); if (!ready || pick(...[].concat(ready))) break; }
  scrollTo({ top: 0, behavior: 'instant' });
}
const scrollInto = (el) => { if (!el) return; const r = el.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight - 110) scrollBy({ top: r.top - Math.max(80, (innerHeight - r.height) / 3), behavior: 'instant' }); };

// ---------- 步驟 ----------
// t 標題｜l 說明（每個元素一行）｜go 要準備的畫面｜at 要聚光的元素（找不到就略過）｜ring 聚光裡再圈起來的重點
const STEPS = [
  { id: 'hello', center: true, hero: true, t: '歡迎來到耕跑團', l: ['一分鐘帶你看過真正的畫面：', '團練報名、課表、跑步記錄與拍照分享。'] },
  { id: 'today', icon: I.sun, t: '今天要練什麼', l: ['打開 App 第一眼就是今天的課表與配速，', '練完按一下就記錄。'],
    go: () => go('#/', '.todaycard'), at: () => pick('.todaycard'), ring: () => pick('.todaycard .btn') },
  { id: 'events', icon: I.megaphone, t: '團練與報名', l: ['幹部發布的團練、揪跑、團購都在這裡，點進去就能報名。', '上方可以只看自己的分團，下方有行事曆。'],
    go: () => go('#/', ['.card.hero', '.evgrid']), at: () => [pick('.chipbar'), pick('a.card.hero', '.evgrid .card')].filter(Boolean) },
  { id: 'countdown', icon: I.flag, t: '倒數你的比賽', l: ['右上角倒數到你報名的比賽，', '點一下就能換一場，或從常用賽事挑。'],
    go: () => go('#/', '#countdown'), at: () => pick('#countdown') },
  { id: 'bell', icon: I.bell, t: '通知', l: ['新團練、候補遞補、教練回饋都會通知你。', '加到主畫面後，手機也收得到推播。'],
    at: () => pick('#bell') },
  { id: 'plan', icon: I.plan, t: '課表與訓練紀錄', l: ['照你的組別換算配速；每天練完按「記錄」，', '本週完成率、里程與強度自動算好。'],
    go: () => go('#/plan', ['.logsum', '.days']), at: () => [pick('.logsum'), pick('.days .day')].filter(Boolean), ring: () => pick('.days .logbtn') },
  { id: 'run', icon: I.runner, t: '跑步記錄', l: ['手機計時加上 GPS，跑完算好距離、配速與分段。', '可以邊跑邊看今天的課表。'],
    need: () => shown(tab('/run')), go: () => go('#/run', ['.runstart', '.runlive', '.kpis']), at: () => pick('.runstart', '.runlive', '.kpis'), ring: () => pick('#runGo') },
  { id: 'map', icon: I.map, t: '練跑地圖', l: ['全台常用的田徑場、河濱、公園與步道，可以搜尋、依類型和縣市篩選。', '看現場回報與天氣，也能畫路線、存 GPX、開揪跑。'],
    need: () => shown(tab('/map')), go: () => go('#/map', ['.mapwrap', '.spotlist']), at: () => pick('.mapwrap'), ring: () => pick(tab('/map')) },
  // 拍照分享：GPS 跑步開著時收在「跑步」裡（聚光「拍照分享」那一列），關掉 GPS 時是分頁列的一格
  { id: 'studio', icon: I.camera, t: '拍照分享', l: () => (gpsOn() ? ['跑完在「跑步」裡拍照分享到 IG，', '距離、時間和路線會放進照片。'] : ['把今天的距離、時間和路線放進照片，', '直接分享到 IG 限時動態或 Reels。']),
    need: () => studioOn(), go: () => (gpsOn() ? go('#/run', '.runshare') : go('#/studio', '.stage-card')), at: () => (gpsOn() ? pick('.runshare') : pick(tab('/studio'))) },
  { id: 'me', icon: I.person, t: '我的', l: ['個人資料、賽事報名資料、主團、通知與安全，', '分組放在這裡，點一列就進去設定。'],
    go: () => go('#/me', '.setgroup'), at: () => [pick('.mecard'), pick('.setgroup')].filter(Boolean) },
  { id: 'done', center: true, icon: I.check, t: '準備好了', l: ['之後可以在「我的 → 使用說明」再看一次。'] },
];

// ---------- 畫面元件 ----------
let box, tip, spot, ring, T = { on: false, i: 0, steps: [], back: '#/' };
function build() {
  if (box) return;
  box = document.createElement('div');
  box.id = 'guide'; box.className = 'guide'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'gTitle'); box.hidden = true;
  box.innerHTML = `<div class="g-block"></div><div class="g-spot" aria-hidden="true"></div><div class="g-ring" aria-hidden="true"></div>
    <section class="g-tip" tabindex="-1"><span class="g-caret" aria-hidden="true"></span>
      <div class="g-head"><span class="g-ic" id="gIc" aria-hidden="true"></span><span class="g-count num" id="gCount"></span><button type="button" class="g-skip" id="gSkip">略過</button></div>
      <div class="g-hero" id="gHero" aria-hidden="true"></div>
      <div class="g-live" id="gLive" aria-live="polite"><h2 id="gTitle"></h2><div class="g-body" id="gBody"></div></div>
      <div id="gExtra"></div>
      <div class="g-foot"><div class="g-dots" id="gDots" aria-hidden="true"></div>
        <div class="g-nav"><button type="button" class="btn ghost sm" id="gPrev">上一步</button><button type="button" class="btn sm" id="gNext">下一步</button></div></div>
    </section>`;
  document.body.append(box);
  tip = box.querySelector('.g-tip'); spot = box.querySelector('.g-spot'); ring = box.querySelector('.g-ring');
  $('#gSkip').onclick = () => end(true);
  $('#gPrev').onclick = () => step(T.i - 1);
  $('#gNext').onclick = () => (T.i >= T.steps.length - 1 ? end(true) : step(T.i + 1));
  box.querySelector('.g-block').onclick = () => tip.animate?.([{ transform: tip.style.transform + ' scale(1)' }, { transform: tip.style.transform + ' scale(1.02)' }, { transform: tip.style.transform + ' scale(1)' }], 260);
  addEventListener('keydown', (e) => {
    if (!T.on) return;
    if (e.key === 'Escape') end(true);
    else if (e.key === 'ArrowRight') $('#gNext').click();
    else if (e.key === 'ArrowLeft' && T.i > 0) $('#gPrev').click();
  });
  addEventListener('resize', () => T.on && layout());
  // 手機左右滑也能換步驟
  let sx = null;
  tip.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  tip.addEventListener('touchend', (e) => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50) (dx < 0 ? $('#gNext') : T.i > 0 && $('#gPrev'))?.click(); }, { passive: true });
}

// ---------- 版面 ----------
const PAD = 8;
function hole(els) {
  const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rs.length) return null;
  const l = Math.max(4, Math.min(...rs.map((r) => r.left)) - PAD), t = Math.max(4, Math.min(...rs.map((r) => r.top)) - PAD);
  const r = Math.min(innerWidth - 4, Math.max(...rs.map((x) => x.right)) + PAD), b = Math.min(innerHeight - 4, Math.max(...rs.map((x) => x.bottom)) + PAD);
  if (r - l < 8 || b - t < 8) return null;
  const rad = Math.max(14, Math.min(30, (parseFloat(getComputedStyle(els[0]).borderTopLeftRadius) || 0) + PAD));
  return { l, t, r, b, w: r - l, h: b - t, rad };
}
function setSpot(h) {
  if (!h) { spot.classList.add('off'); Object.assign(spot.style, { width: '0px', height: '0px', transform: `translate(${innerWidth / 2}px, ${innerHeight / 2}px)` }); return; }
  spot.classList.remove('off');
  Object.assign(spot.style, { width: `${h.w}px`, height: `${h.h}px`, transform: `translate(${h.l}px, ${h.t}px)`, borderRadius: `${h.rad}px` });
}
function setRing(el) {
  if (!el) { ring.classList.remove('on'); return; }
  const r = el.getBoundingClientRect(), p = 3;
  Object.assign(ring.style, { width: `${r.width + p * 2}px`, height: `${r.height + p * 2}px`, transform: `translate(${r.left - p}px, ${r.top - p}px)`, borderRadius: `${(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 14) + p}px` });
  ring.classList.add('on');
}
function placeTip(h) {
  const vw = innerWidth, vh = innerHeight, m = 12, gap = 14, w = tip.offsetWidth, ht = tip.offsetHeight;
  let x, y, side = 'none';
  if (!h) { x = (vw - w) / 2; y = Math.max(m, (vh - ht) / 2); }
  else {
    const cx = (h.l + h.r) / 2, cy = (h.t + h.b) / 2;
    const fit = { below: vh - h.b - gap - m >= ht, above: h.t - gap - m >= ht, right: vw - h.r - gap - m >= w, left: h.l - gap - m >= w };
    const order = vw >= 900 && h.r < vw * 0.4 ? ['right', 'below', 'above', 'left'] : ['below', 'above', 'right', 'left'];
    side = order.find((s) => fit[s]) || 'none';
    const cX = (v) => Math.max(m, Math.min(vw - w - m, v)), cY = (v) => Math.max(m, Math.min(vh - ht - m, v));
    if (side === 'below') { x = cX(cx - w / 2); y = h.b + gap; }
    else if (side === 'above') { x = cX(cx - w / 2); y = h.t - gap - ht; }
    else if (side === 'right') { x = h.r + gap; y = cY(cy - ht / 2); }
    else if (side === 'left') { x = h.l - gap - w; y = cY(cy - ht / 2); }
    else { x = cX(cx - w / 2); y = cy > vh / 2 ? m : vh - ht - m; }
    const caret = tip.querySelector('.g-caret'), cs = 9;
    if (side === 'below' || side === 'above') { caret.style.left = `${Math.max(22, Math.min(w - 22, cx - x)) - cs}px`; caret.style.top = ''; }
    if (side === 'right' || side === 'left') { caret.style.top = `${Math.max(22, Math.min(ht - 22, cy - y)) - cs}px`; caret.style.left = ''; }
  }
  tip.dataset.side = side;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function layout() {
  const s = T.steps[T.i]; if (!T.on || !s) return;
  if (s.center) { setSpot(null); setRing(null); placeTip(null); return; }
  const els = [].concat(s.at?.() || []).filter(Boolean);
  if (!els.length) { setSpot(null); setRing(null); placeTip(null); return; }
  const h = hole(els); setSpot(h); setRing(s.ring?.() || null); placeTip(h);
}

// ---------- 顯示 ----------
const HERO = '<span class="g-app"><img src="/icons/icon-192.png" alt="" width="76" height="76"></span>';
function installTip() {
  if (isStandalone()) return '';
  return `<p class="g-note">${I.plus}<span>${isIOS() ? '在 Safari 按「分享」→「加入主畫面」，像 App 一樣打開，也收得到通知。' : '在瀏覽器選單選「安裝應用程式」，像 App 一樣打開，也收得到通知。'}</span></p>`;
}
function render() {
  const s = T.steps[T.i], n = T.steps.length, last = T.i === n - 1;
  tip.className = `g-tip${s.center ? ' center' : ''}`;
  $('#gHero').innerHTML = s.hero ? HERO : s.center ? `<span class="g-badge">${s.icon || ''}</span>` : '';
  $('#gIc').innerHTML = s.center ? '' : s.icon || '';
  $('#gCount').textContent = s.center ? '' : `${T.i} / ${n - 2}`;
  $('#gTitle').textContent = s.t;
  $('#gBody').innerHTML = (typeof s.l === 'function' ? s.l() : s.l).map((x) => `<p>${esc(x)}</p>`).join('');
  $('#gExtra').innerHTML = s.id === 'done' ? installTip() : '';
  $('#gDots').innerHTML = T.steps.map((_, k) => `<i class="${k === T.i ? 'on' : ''}"></i>`).join('');
  $('#gPrev').hidden = T.i === 0;
  $('#gNext').textContent = T.i === 0 ? '開始看看' : last ? '開始使用' : '下一步';
  $('#gSkip').hidden = last;
  const live = $('#gLive'); live.classList.remove('swap'); void live.offsetWidth; live.classList.add('swap');
}
let gen = 0;
async function step(i) {
  const my = ++gen;
  // 跳過畫面上沒有的步驟（例如功能被關掉）
  const dir = i >= T.i ? 1 : -1;
  T.i = Math.max(0, Math.min(T.steps.length - 1, i));
  const s = T.steps[T.i];
  if (s.need && !s.need()) { if (T.i > 0 && T.i < T.steps.length - 1) return step(T.i + dir); }
  box.classList.add('busy');
  if (s.go) await s.go();
  if (my !== gen) return;
  const els = [].concat(s.at?.() || []).filter(Boolean);
  if (!s.center && !els.length && T.i > 0 && T.i < T.steps.length - 1) { box.classList.remove('busy'); return step(T.i + dir); }
  if (els[0]) scrollInto(els[0]);
  render();
  await wait(30);
  layout();
  // 卡片有進場動畫（約 0.4 秒），動畫結束後再量一次，聚光才會貼準
  setTimeout(() => { if (my === gen) layout(); }, 480);
  box.classList.remove('busy');
  tip.focus({ preventScroll: true });
}
export function start() {
  build();
  T = { on: true, i: 0, steps: STEPS, back: location.hash || '#/' };
  box.hidden = false; box.classList.add('in');
  document.documentElement.classList.add('guiding');
  step(0);
}
function end(done) {
  T.on = false; gen++;
  box.hidden = true; box.classList.remove('in');
  document.documentElement.classList.remove('guiding');
  try { if (done) localStorage.setItem(KEY, VER); } catch {}
  if (location.hash !== T.back) location.hash = T.back;
}
// 第一次登入後自動開始（只一次）
export function maybeStart() {
  try { if (localStorage.getItem(KEY) === VER) return; } catch { return; }
  if (T.on) return;
  setTimeout(() => { if (!T.on && (location.hash === '' || location.hash === '#/')) start(); }, 900);
}
