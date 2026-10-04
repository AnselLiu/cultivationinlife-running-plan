// 五個分頁的導覽（聚光）：參照潛圖的做法——在真正的畫面上一步一步介紹，畫面變暗、只亮出要介紹的地方，旁邊一個玻璃說明框。
// 導覽會實際帶到每個分頁（團練、課表、跑步或拍照、地圖、我的），結束或略過時回到開始前的頁面，不會新增任何資料。
// 不會自動跳出來：「開始使用」卡做完三步後問要不要看，或從「我的 → 使用說明」打開。

import { focusAfterRender } from './app.js';

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

// 換頁後等畫面畫好（找得到目標或最多 3 秒）
async function go(hash, ready) {
  if (location.hash.split('?')[0] !== hash) location.hash = hash;
  for (let i = 0; i < 30; i++) { await wait(100); if (!ready || pick(...[].concat(ready))) break; }
  scrollTo({ top: 0, behavior: 'instant' });
}
const scrollInto = (el) => { if (!el) return; const r = el.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight - 110) scrollBy({ top: r.top - Math.max(80, (innerHeight - r.height) / 3), behavior: 'instant' }); };

// ---------- 步驟 ----------
// 對齊下方 5 格分頁：歡迎 → 團練 → 課表 → 跑步（GPS 關掉時這格是拍照）→ 地圖 → 我的 → 完成；每一步圈出那一格分頁
// t 標題｜l 說明（每個元素一行）｜go 要準備的畫面｜at 要聚光的元素（找不到就略過）｜ring 聚光裡再圈起來的重點｜tab 這一步對應的分頁
const STEPS = [
  { id: 'hello', center: true, hero: true, t: '歡迎來到耕跑團', l: ['一分鐘看過下方的五個分頁，', '之後在「我的 → 使用說明」可以再看一次。'] },
  { id: 'home', tab: '/', icon: I.sun, t: '團練', l: ['今天的課表與配速、接下來的團練與報名。', '右上角倒數你的比賽，鈴鐺看通知。'],
    go: () => go('#/', ['.todaycard', '.card.hero']), at: () => pick('.todaycard', '.card.hero'), ring: () => pick(tab('/')) },
  { id: 'plan', tab: '/plan', icon: I.plan, t: '課表', l: ['照你的組別換算配速；練完按一下就記錄，', '本週完成率、里程與強度自動算好。'],
    go: () => go('#/plan', ['.logsum', '.days']), at: () => [pick('.logsum'), pick('.days .day')].filter(Boolean), ring: () => pick(tab('/plan')) },
  { id: 'run', tab: '/run', icon: I.runner, t: '跑步', l: ['手機計時加上 GPS，跑完算好距離、配速與分段，', '存成訓練紀錄，或拍照分享到 IG。'],
    need: () => gpsOn(), go: () => go('#/run', ['.runstart', '.runlive', '.kpis']), at: () => pick('.runstart', '.runlive', '.kpis'), ring: () => pick(tab('/run')) },
  // GPS 跑步關掉時，第 3 格是拍照
  { id: 'studio', tab: '/studio', icon: I.camera, t: '拍照', l: ['把今天的距離、時間和路線放進照片，', '直接分享到 IG 限時動態或 Reels。'],
    need: () => !gpsOn() && shown(tab('/studio')), go: () => go('#/studio', '.stage-card'), at: () => pick('.stage-card'), ring: () => pick(tab('/studio')) },
  { id: 'map', tab: '/map', icon: I.map, t: '地圖', l: ['田徑場、河濱、公園與步道，看天氣、現場回報與休息站，', '也能畫路線、存 GPX、開揪跑。'],
    need: () => shown(tab('/map')), go: () => go('#/map', ['.msheet', '.amap']), at: () => pick('.msheet', '.amap'), ring: () => pick(tab('/map')) },
  { id: 'me', tab: '/me', icon: I.person, t: '我的', l: ['個人資料、賽事與報名、跑團，', '通知、帳號與安全等設定都在這裡。'],
    go: () => go('#/me', '.setgroup'), at: () => [pick('.mecard'), pick('.setgroup')].filter(Boolean), ring: () => pick(tab('/me')) },
  { id: 'done', center: true, icon: I.check, t: '準備好了', l: ['之後可以在「我的 → 使用說明」再看一次。'] },
];

// ---------- 畫面元件 ----------
let box, tip, spot, ring, T = { on: false, i: 0, steps: [], back: '#/' };
function build() {
  if (box) return;
  box = document.createElement('div');
  box.id = 'guide'; box.className = 'guide'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'gTitle'); box.hidden = true;
  box.innerHTML = `<div class="g-block"></div><div class="g-spot" aria-hidden="true"></div><div class="g-ring" aria-hidden="true"></div>
    <section class="g-tip" tabindex="-1" role="group" aria-labelledby="gTitle" aria-describedby="gBody"><span class="g-caret" aria-hidden="true"></span>
      <div class="g-head"><span class="g-ic" id="gIc" aria-hidden="true"></span><span class="g-count num" id="gCount"></span><button type="button" class="g-skip" id="gSkip">略過</button></div>
      <div class="g-hero" id="gHero" aria-hidden="true"></div>
      <div class="g-live" id="gLive"><h2 id="gTitle"></h2><div class="g-body" id="gBody"></div></div>
      <div id="gExtra"></div>
      <div class="g-foot"><div class="g-dots" id="gDots" aria-hidden="true"></div>
        <div class="g-nav"><button type="button" class="btn ghost sm" id="gPrev">上一步</button><button type="button" class="btn sm" id="gNext">下一步</button></div></div>
    </section>`;
  document.body.append(box);
  tip = box.querySelector('.g-tip'); spot = box.querySelector('.g-spot'); ring = box.querySelector('.g-ring');
  $('#gSkip').onclick = () => end();
  $('#gPrev').onclick = () => step(T.i - 1);
  $('#gNext').onclick = () => (T.i >= T.steps.length - 1 ? end() : step(T.i + 1));
  box.querySelector('.g-block').onclick = () => tip.animate?.([{ transform: tip.style.transform + ' scale(1)' }, { transform: tip.style.transform + ' scale(1.02)' }, { transform: tip.style.transform + ' scale(1)' }], 260);
  addEventListener('keydown', (e) => {
    if (!T.on) return;
    if (e.key === 'Escape') end();
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
function render() {
  const s = T.steps[T.i], n = T.steps.length, last = T.i === n - 1;
  tip.className = `g-tip${s.center ? ' center' : ''}`;
  $('#gHero').innerHTML = s.hero ? HERO : s.center ? `<span class="g-badge">${s.icon || ''}</span>` : '';
  $('#gIc').innerHTML = s.center ? '' : s.icon || '';
  $('#gCount').textContent = s.center ? '' : `${T.i} / ${n - 2}`;
  $('#gTitle').textContent = s.t;
  $('#gBody').innerHTML = (typeof s.l === 'function' ? s.l() : s.l).map((x) => `<p>${esc(x)}</p>`).join('');
  $('#gExtra').innerHTML = '';
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
  // 步驟數字只算這次真的會出現的（功能關掉的步驟先拿掉，不會從 6 / 9 跳到 8 / 9）
  T = { on: true, i: 0, steps: STEPS.filter((s) => !s.need || s.need()), back: location.hash || '#/', opener: document.activeElement };
  box.hidden = false; box.classList.add('in');
  document.documentElement.classList.add('guiding');
  // 背景設 inert：導覽是 aria-modal，Tab 與 VoiceOver 都不能跑到被蓋住的頁面
  for (const el of document.querySelectorAll('#view, .top, #tabs')) el.inert = true;
  step(0);
}
function end() {
  T.on = false; gen++;
  box.hidden = true; box.classList.remove('in');
  document.documentElement.classList.remove('guiding');
  for (const el of document.querySelectorAll('#view, .top, #tabs')) el.inert = false;
  // 焦點回到打開導覽的地方（「我的 → 使用說明」那一列）；那一列重畫過就找同一個 id，找不到就是新頁面的大標題
  const back = T.opener, id = back?.id;
  const restore = () => { const el = back?.isConnected ? back : id && document.getElementById(id); if (el) el.focus(); else document.querySelector('#view h1')?.focus(); };
  if (location.hash !== T.back) { focusAfterRender(id ? [`#${id}`, 'h1'] : ['h1']); location.hash = T.back; } else restore();
}
