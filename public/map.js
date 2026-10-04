// 耕跑團 PWA — map.js：練跑地圖（用到才載入）
//   地點：田徑場、河濱、公園、山徑…，有說明、一圈距離、照明、飲水、廁所、停車、開放時間；幹部新增，團員提議要審核
//   現場回報：人潮、路況、照明、天氣，24 小時內顯示、不顯示是誰
//   天氣：每個地點的 12 小時預報、空氣品質與跑步建議
//   畫路線：在地圖上點出路線，即時算距離，可以存起來分享、下載 GPX、直接開揪跑
//   附近即時影像：1.5 公里內（沒有就 3 公里內最近一支）的政府公開攝影機，畫面由本站轉送、不保存；幹部可以加官方直播的外連；功能開關預設關閉
//   跑者休息站：飲水、廁所、淋浴置物、補給（reststops.js）；開關收在底圖選單，功能開關預設關閉
//   底圖：內政部國土測繪中心電子地圖與正射影像（政府資料開放授權）、OpenStreetMap；Leaflet 放在 /vendor（不從外部載入程式）
import { $, allow, api, camLazy, cfg, esc, IC, largeTitle, openSheet, teamAllow, teams, toast, view } from './app.js';
// 開揪跑要有建立活動的權限（協會或分團幹部）；團員改成在 LINE 揪人、請幹部開團
const canCreate = () => allow('event') || teams().some((t) => teamAllow(t.id, 'event'));
const lineShare = (text) => `https://line.me/R/share?text=${encodeURIComponent(text)}`;
import * as W from './weather.js';
import { lang, t } from './i18n.js';
import { hoursNow } from './hours.js';
import * as RS from './reststops.js';
// 標記加到地圖時標成不翻譯（i18n.js 的 MutationObserver 在之後才處理新節點）
const noTr = (e) => e.target.getElement()?.setAttribute('translate', 'no');

const KIND = { track: '田徑場', river: '河濱', park: '公園', trail: '山徑', road: '道路', other: '其他' };
// 地圖針：水滴形的針頭，裡面是類型的線條圖示（跟系統圖示同一個風格，不用文字）
const GLYPH = {
  track: '<rect x="3.5" y="6.5" width="17" height="11" rx="5.5"/><rect x="7.5" y="10" width="9" height="4" rx="2"/>',
  river: '<path d="M3 8.5c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0 3-1.3 4.5 0 3 1.3 4.5 0M3 13c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0 3-1.3 4.5 0 3 1.3 4.5 0M3 17.5c1.5-1.3 3-1.3 4.5 0s3 1.3 4.5 0 3-1.3 4.5 0 3 1.3 4.5 0"/>',
  park: '<path d="M12 20.5v-4.5"/><path d="M12 3.5a5 5 0 0 0-4.6 7A4 4 0 0 0 9 18h6a4 4 0 0 0 1.6-7.5A5 5 0 0 0 12 3.5Z"/>',
  trail: '<path d="M2.5 19.5 9 9l3.6 5.6L15 11l6.5 8.5Z"/><path d="M9 9l1.4 2.3"/>',
  road: '<path d="M8.5 20.5 10.6 3.5M15.5 20.5 13.4 3.5M12 6.2v1.6M12 10.7v1.8M12 15.6v2.2"/>',
  other: '<circle cx="14.5" cy="4.8" r="1.7"/><path d="M7 21l2.8-5.4 2.6-1.7-1.1-4.5 3.9-1.5 1.9 3.4 3.6 1.1M10.9 14.4 7.9 11.3 5.2 12.6"/>',
};
const glyph = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[k] || GLYPH.other}</svg>`;
// 地圖上的針（36×46）：kind 決定顏色與圖示；pending 是虛線（待審核）；reports 有現場回報時右上角亮燈
const pinHtml = (s, warn) => `<div class="mpin k-${s.kind}${s.status !== 'approved' ? ' pending' : ''}${s.id === selected ? ' sel' : ''}${openOf(s)?.open === false ? ' closed' : ''}">
  <svg class="mpin-shape" viewBox="0 0 36 46" aria-hidden="true"><path d="M18 44.5C18 44.5 3.5 30 3.5 18a14.5 14.5 0 0 1 29 0c0 12-14.5 26.5-14.5 26.5Z"/></svg>
  <span class="mpin-glyph">${glyph(s.kind)}</span>${s.reports ? `<i class="${warn ? 'warn' : ''}"></i>` : ''}</div>`;
// 清單、卡片用的圓角方塊圖示（同一套圖示）
const kindTile = (k, extra = '') => `<span class="ktile k-${k} ${extra}" aria-hidden="true">${glyph(k)}</span>`;
const CITIES = ['臺北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'];
const INFO = { lap: '一圈', surface: '路面', light: '夜間照明', water: '飲水', toilet: '廁所', parking: '停車', hours: '開放時間' };
// 資訊值是團員寫的，不翻譯；只有「有／無」這種值換成介面文字（字典裡單獨的「有」是句子片段，翻出來會變成怪字）
const infoVal = (x) => { const yn = RS.yesNo(x); return yn === null ? `<b translate="no">${esc(x)}</b>` : `<b translate="no">${yn ? (lang === 'en' ? 'Yes' : '有') : (lang === 'en' ? 'No' : '無')}</b>`; };
const REP = { crowd: ['人潮', ['少', '普通', '多']], surface: ['路況', ['乾燥', '濕滑', '積水', '施工', '封閉']], light: ['照明', ['充足', '偏暗', '沒有']], weather: ['天氣', ['晴', '陰', '小雨', '大雨', '悶熱', '強風']] };
const BASES = {
  emap: ['電子地圖', 'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', 18, '© 內政部國土測繪中心'],
  photo: ['衛星', 'https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}', 19, '© 內政部國土測繪中心'],
  osm: ['OSM', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', 19, '© OpenStreetMap'],
};
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => { const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const lenOf = (pts) => pts.reduce((n, p, i) => (i ? n + hav(pts[i - 1], p) : 0), 0);
const km = (m) => `${(m / 1000).toFixed(2)} 公里`;
const pref = { get(k, d) { try { return localStorage.getItem(`cil-map-${k}`) || d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(`cil-map-${k}`, v); } catch {} } };

// Leaflet 第一次用到才載入
let leaflet = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leaflet ||= new Promise((ok, no) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet.css'; document.head.append(css);
    const js = document.createElement('script'); js.src = '/vendor/leaflet.js'; js.onload = () => ok(window.L); js.onerror = () => { leaflet = null; no(new Error('地圖載入失敗，請檢查網路')); };
    document.head.append(js);
  });
  return leaflet;
}

// GPX：只有路線的點（沒有時間），Garmin、Strava、手錶都讀得到
export function gpx(name, pts) {
  const x = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="耕跑團 cil-run" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${x(name)}</name></metadata>\n<trk><name>${x(name)}</name><type>running</type><trkseg>\n${pts.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"></trkpt>`).join('\n')}\n</trkseg></trk>\n</gpx>`;
}
export function downloadGpx(name, pts) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx(name, pts)], { type: 'application/gpx+xml' }));
  a.download = `${name.replace(/[\\/:*?"<>|]/g, '')}.gpx`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// 清單與地圖共用的篩選：關鍵字、類型、縣市、離我最近（類型與縣市記在這台裝置）
const filt = { q: '', kind: pref.get('kind', ''), city: pref.get('city', ''), near: false, openNow: false };
// 開放狀態（依「開放時間」文字判斷；看不懂的是 null，不反灰）
const openOf = (s) => (s.hours ? hoursNow(s.hours) : null);
let myPos = null, selected = null;
let map = null, layer = null, spotsLayer = null, routeLayer = null, drawLayer = null, me = null, data = { spots: [], editor: false }, mode = 'browse', draft = [], pickCb = null;

async function mapView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  $('#ctitle').textContent = '練跑地圖';
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  view.innerHTML = `
    <h1 class="sr">練跑地圖</h1>
    <div class="amap" id="amap">
      <div id="map" role="application" aria-label="練跑地圖"></div>
      <div class="mapctl" role="toolbar" aria-label="地圖工具">
        <div class="ctlgroup">
          <button class="fab" id="baseBtn" disabled aria-label="底圖" aria-haspopup="menu" aria-expanded="false">${svg('<path d="m12 3.5 8.5 4.3L12 12 3.5 7.8Z"/><path d="m3.5 12 8.5 4.2 8.5-4.2M3.5 16.2 12 20.5l8.5-4.3"/>')}</button>
          <button class="fab" id="locBtn" disabled aria-label="移到我的位置">${svg('<path d="M20 4 3.5 10.6l7 2.9 2.9 7Z"/>')}</button>
        </div>
        <div class="ctlgroup">
          <button class="fab" id="drawBtn" disabled aria-label="畫路線">${svg('<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M6.6 16.6C10 13 8 9.5 12 8.5s4.6-1 5.4-1.2"/>')}</button>
          <button class="fab" id="addBtn" disabled aria-label="新增地點">${svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z"/><path d="M12 7.5v5M9.5 10h5"/>')}</button>
        </div>
      </div>
      <div class="basemenu" id="baseMenu" role="menu" aria-label="底圖" hidden>${Object.entries(BASES).map(([k, v]) => `<button role="menuitemradio" data-base="${k}" aria-checked="${pref.get('base', 'emap') === k}">${v[0]}</button>`).join('')}${RS.menuHtml()}</div>
      ${RS.barHtml()}
      <div class="drawbar dbar" id="drawBar" role="toolbar" aria-label="畫路線" hidden>
        <span class="dlen"><b class="num" id="drawLen">0.00 公里</b><span class="tiny" id="drawPts">點地圖加上路線的點</span></span>
        <span class="dmain"><button class="btn ghost sm" id="drawCancel">取消</button><button class="btn sm" id="drawDone">完成</button></span>
        <span class="dtools"><button class="btn ghost sm" id="drawFree" aria-pressed="false" title="打開後用手指拖就是畫線；Apple Pencil 隨時都能直接畫">手繪</button><button class="btn ghost sm" id="drawUndo">復原</button><button class="btn ghost sm" id="drawLoop">繞回起點</button></span>
      </div>
      <div class="drawbar" id="pickBar" hidden><span class="tiny">點地圖選地點的位置</span><button class="btn ghost sm" id="pickCancel">取消</button></div>
      <section class="msheet" id="msheet" aria-label="地點與路線" data-detent="peek">
        <button class="grab" id="grab" type="button" aria-label="展開清單" aria-expanded="false" aria-controls="msheetScroll"><i></i></button>
        <div class="msheet-scroll" id="msheetScroll"><div id="panel"><section class="card"><p class="tiny" style="margin:0">載入中…</p></section></div></div>
      </section>
    </div>`;
  bindSheet();
  // 這次畫的容器：載入 Leaflet 的期間畫面可能已經換掉（例如背景更新重畫），換掉了就交給新的那次
  const el = $('#map');
  let L;
  try { L = await loadLeaflet(); } catch (e) { if (el.isConnected) $('#panel').innerHTML = `<section class="card"><p class="notice" style="margin:0">${esc(e.message)}</p></section>`; return; }
  if (!el.isConnected) return;
  try { map?.remove(); } catch {}
  map = L.map(el, { zoomControl: false, attributionControl: false, tap: true }).setView(JSON.parse(pref.get('view', '[25.05,121.54,12]')).slice(0, 2), JSON.parse(pref.get('view', '[25.05,121.54,12]'))[2]);
  // 手機用雙指縮放（不放 ± 按鈕）；圖資版權放在不會被抽屜蓋住的地方
  if (wide()) L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.attribution({ position: wide() ? 'bottomright' : 'topleft', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(map);
  setBase(pref.get('base', 'emap'));
  spotsLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup().addTo(map); drawLayer = L.layerGroup().addTo(map);
  // 跑者休息站圖層（獨立的圖層與群集，不跟練跑地點合併）
  RS.attach({ map, L, pref, focusOn, setDetent, visRect, fitVisible, drawLayer, startPick, openSpot, closeCard, panel: () => $('#panel'),
    leave: () => { camReset(); selected = null; paintPins(); }, selected: () => selected, mode: () => mode, mapClick: onMapClick, myPos: () => myPos, editor: () => data.editor });
  map.on('moveend', () => { const c = map.getCenter(); pref.set('view', JSON.stringify([+c.lat.toFixed(4), +c.lng.toFixed(4), map.getZoom()])); });
  map.on('zoomend', paintPins);
  map.on('click', (e) => onMapClick([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]));
  // 底圖選單（像 Apple 地圖右上角的「地圖」按鈕）
  const menu = $('#baseMenu'), baseBtn = $('#baseBtn');
  const closeMenu = () => { menu.hidden = true; baseBtn.setAttribute('aria-expanded', 'false'); };
  baseBtn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; baseBtn.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('[aria-checked="true"]')?.focus(); };
  for (const b of menu.querySelectorAll('[data-base]')) b.onclick = () => { setBase(b.dataset.base); for (const x of menu.querySelectorAll('[data-base]')) x.setAttribute('aria-checked', String(x === b)); closeMenu(); baseBtn.focus(); };
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); baseBtn.focus(); } });
  map.on('movestart', closeMenu);
  RS.bindMenu(() => { closeMenu(); baseBtn.focus(); });
  $('#locBtn').onclick = locate;
  // 地圖準備好才能按（載入 Leaflet 前點了不會有反應，所以先停用）；新增地點、畫路線要等地點資料回來（才知道是不是幹部）
  $('#baseBtn').disabled = false; $('#locBtn').disabled = false;
  $('#drawBtn').onclick = () => startDraw();
  $('#addBtn').onclick = () => startPick((pt) => spotForm(null, pt));
  $('#drawUndo').onclick = () => { draft.length = strokes.length ? strokes.pop() : Math.max(0, draft.length - 1); paintDraft(); };
  $('#drawFree').onclick = () => { freehand = !freehand; $('#drawFree').setAttribute('aria-pressed', String(freehand)); el.classList.toggle('freehand', freehand); toast(freehand ? '手繪：用手指拖就是畫線，兩指移動地圖' : '點選：點一下加一個點'); };
  bindFreehand(el);
  $('#drawLoop').onclick = () => { if (draft.length > 1) { draft.push(draft[0]); paintDraft(); } };
  $('#drawCancel').onclick = endDraw;
  $('#drawDone').onclick = () => (draft.length < 2 ? toast('至少點兩個點') : routeForm());
  $('#pickCancel').onclick = endPick;
  await loadSpots();
  if (!el.isConnected) return;
  RS.ready();
  $('#drawBtn').disabled = false; $('#addBtn').disabled = false;
  // 載入期間已經打開新增地點或路線的表單（手快的人）：不要用清單把表單蓋掉
  if ($('#panel form')) return;
  if (q.get('spot')) openSpot(q.get('spot'), 'jump');
  else if (q.get('route')) showRoute(q.get('route'), 'jump');
  else if (q.get('rest')) RS.openStop(q.get('rest'), { fly: 'jump', focus: false });
  else listPanel();
}

// ---------- 底部抽屜（Apple 地圖式）：三段高度 peek／half／full，拖曳或點把手切換；iPad 與桌機改成左側面板 ----------
const wide = () => matchMedia('(min-width: 820px)').matches;
// 把某個點移到「看得到的地圖」中間：手機扣掉上方列與抽屜，iPad／桌機扣掉左側面板
function focusOn(ll, zoom, how) {
  const z = zoom ?? map.getZoom(), amap = $('#amap'), sh = $('#msheet');
  if (!amap || !sh) return map.setView(ll, z);
  const W = amap.clientWidth, H = amap.clientHeight, top = parseFloat(amap.style.getPropertyValue('--toph')) || 60;
  let cx = W / 2, cy = H / 2;
  if (wide()) { const r = sh.getBoundingClientRect(), a = amap.getBoundingClientRect(); cx = (r.right - a.left + W) / 2; cy = (top + H) / 2; }
  else cy = (top + (H - (sheetH[detent] || 0))) / 2;
  const pt = map.project(ll, z).subtract([cx - W / 2, cy - H / 2]), target = map.unproject(pt, z);
  if (how === 'jump') map.setView(target, z, { animate: false }); else map.flyTo(target, z, { duration: 0.6 });
}
// 看得到的地圖範圍（容器座標）：扣掉上方列、休息站類型列、抽屜（手機）或左側面板（iPad／桌機）
function visRect() {
  const amap = $('#amap'), sh = $('#msheet'), W = amap?.clientWidth || map.getSize().x, H = amap?.clientHeight || map.getSize().y;
  let top = (parseFloat(amap?.style.getPropertyValue('--toph')) || 60) + ($('#restBar') && !$('#restBar').hidden ? 52 : 0), x0 = 0, y1 = H;
  if (wide() && sh) x0 = Math.max(0, sh.getBoundingClientRect().right - amap.getBoundingClientRect().left);
  else y1 = Math.max(top + 80, H - (sheetH[detent] || 0));
  top = Math.min(top, y1 - 80);
  return { x0, y0: top, x1: W, y1 };
}
// 把幾個點或一個範圍縮放到「看得到的地圖」（visRect），右邊留給控制按鈕
// b：[[lat, lng], …] 或 LatLngBounds；o：fitBounds 選項，數字或 o.minZoom＝框不下時改成以中心放大到這一級（休息站 13 級以上才畫得出針）
function fitVisible(b, o = {}) {
  const L = window.L;
  if (typeof o === 'number') o = { minZoom: o };
  if (Array.isArray(b)) { if (!b.length) return; b = L.latLngBounds(b); }
  const { minZoom = 0, ...fo } = o;
  if (!$('#amap') || !$('#msheet')) return map.fitBounds(b, { maxZoom: 17, ...fo });
  const r = visRect(), s = map.getSize(), pad = 24;
  const tl = [r.x0 + pad, r.y0 + pad], br = [Math.max(70, s.x - r.x1 + pad), s.y - r.y1 + pad];
  if (minZoom && map.getBoundsZoom(b, false, L.point(tl).add(br)) < minZoom) return focusOn(b.getCenter(), minZoom);
  map.fitBounds(b, { maxZoom: 17, ...fo, paddingTopLeft: tl, paddingBottomRight: br });
}
let sheetH = {}, detent = 'peek';
function measure() {
  const amap = $('#amap'); if (!amap) return;
  const H = amap.clientHeight, top = ($('.top')?.getBoundingClientRect().bottom || 60);
  // 1024 以下分頁列浮在下方（抽屜、iPad 面板都要讓開）；1024 以上分頁列在左側
  const tabs = $('.tabs'), tabTop = tabs && innerWidth < 1024 ? tabs.getBoundingClientRect().top : H;
  const below = Math.max(0, H - tabTop + 8);   // 浮動分頁列與下方安全區
  amap.style.setProperty('--toph', `${Math.round(top)}px`);
  amap.style.setProperty('--below', `${Math.round(below)}px`);
  const full = Math.round(H - top - 10), ctl = ($('.mapctl')?.getBoundingClientRect().bottom || top + 210) - amap.getBoundingClientRect().top;
  // 半開盡量露出搜尋列、篩選和前兩列清單（iPhone SE 也一樣），但不蓋到右邊的地圖按鈕
  sheetH = { peek: below + 142, half: Math.min(full, Math.max(Math.round(H * 0.52), Math.min(below + 142 + 190, Math.round(H - ctl - 8)))), full };
}
// 抽屜蓋到右上的地圖按鈕（全開、或拖到按鈕的高度）時把按鈕與休息站 chip 收起來（Apple 地圖全開時也會藏地圖控制），
//   不然毛玻璃底下透出按鈕的影子、看起來疊在拉桿與搜尋列上；y＝抽屜往下移的距離（translateY）
function coverCtl(y) {
  const amap = $('#amap'), ctl = $('.mapctl'); if (!amap || !ctl) return;
  const off = !wide() && amap.clientHeight - sheetH.full + y < ctl.getBoundingClientRect().bottom - amap.getBoundingClientRect().top + 6;
  amap.classList.toggle('ctl-off', off);
  const menu = $('#baseMenu');
  if (off && menu && !menu.hidden) { menu.hidden = true; $('#baseBtn')?.setAttribute('aria-expanded', 'false'); }
}
function setDetent(d, opt = {}) {
  const sh = $('#msheet'); if (!sh) return;
  detent = d; sh.dataset.detent = d; $('#amap').dataset.detent = d;
  const g = $('#grab'); g?.setAttribute('aria-expanded', String(d !== 'peek')); g?.setAttribute('aria-label', t(d === 'full' ? '收合清單' : '展開清單'));
  if (wide()) { sh.style.transform = ''; sh.style.height = ''; $('#amap').classList.remove('ctl-off'); return; }
  measure();
  sh.style.height = `${sheetH.full}px`;
  sh.classList.toggle('anim', !opt.instant);
  sh.style.transform = `translateY(${sheetH.full - sheetH[d]}px)`;
  sh.style.setProperty('--hid', `${sheetH.full - sheetH[d]}px`);   // 抽屜在畫面外的高度：內容在分頁列上方淡出（style.css）
  coverCtl(sheetH.full - sheetH[d]);
  if (d !== 'full') $('#msheetScroll').scrollTop = 0;
  if (map && map.getContainer() === $('#map')) RS.viewChanged();   // 抽屜收起來露出的地圖：休息站補抓那幾格（畫面重建時舊的地圖不算）
}
function bindSheet() {
  const sh = $('#msheet'), sc = $('#msheetScroll');
  setDetent('peek', { instant: true });
  const order = ['peek', 'half', 'full'];
  $('#grab').onclick = () => setDetent(order[(order.indexOf(detent) + 1) % 3]);
  let y0 = 0, t0 = 0, base = 0, dragging = false, pid = null, last = [];
  sh.addEventListener('pointerdown', (e) => {
    if (wide() || e.button > 0 || mode !== 'browse' && detent === 'peek' && e.target.closest('input,textarea,select')) return;
    if (detent === 'full' && sc.scrollTop > 0 && !e.target.closest('#grab')) return;   // 全開時先捲清單
    pid = e.pointerId; y0 = e.clientY; t0 = performance.now(); last = [[t0, y0]]; dragging = false;
    base = sheetH.full - sheetH[detent];
  });
  sh.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const dy = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(dy) < 7) return;
      if (detent === 'full' && dy < 0 && !e.target.closest('#grab')) { pid = null; return; }   // 全開往上滑＝捲清單
      dragging = true; sh.classList.remove('anim'); sh.setPointerCapture?.(e.pointerId);
    }
    const y = Math.min(sheetH.full - sheetH.peek + 40, Math.max(-20, base + dy));
    sh.style.transform = `translateY(${y}px)`;
    sh.style.setProperty('--hid', `${Math.max(0, y)}px`);
    coverCtl(y);
    last.push([performance.now(), e.clientY]); if (last.length > 5) last.shift();
    e.preventDefault();
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (!dragging) return;
    dragging = false;
    // 放手時：滑得快就往那個方向跳一段，不然停在最近的高度
    const [[ta, ya], [tb, yb]] = [last[0], last[last.length - 1]], v = (yb - ya) / Math.max(1, tb - ta);
    const cur = sheetH.full - (base + (e.clientY - y0));
    let d = order.reduce((a, k) => (Math.abs(sheetH[k] - cur) < Math.abs(sheetH[a] - cur) ? k : a), 'peek');
    if (v < -0.45) d = order[Math.min(2, order.indexOf(detent) + 1)];
    else if (v > 0.45) d = order[Math.max(0, order.indexOf(detent) - 1)];
    setDetent(d);
    // 拖曳後不要觸發底下按鈕的點擊
    sh.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
  };
  sh.addEventListener('pointerup', end);
  sh.addEventListener('pointercancel', end);
  const re = () => { if (!$('#msheet')) return removeEventListener('resize', re); setDetent(detent, { instant: true }); map?.invalidateSize(); };
  addEventListener('resize', re);
}

function setBase(k) {
  const b = BASES[k] || BASES.emap;
  if (layer) map.removeLayer(layer);
  // crossOrigin：圖磚用 CORS 抓，Service Worker 才能存起來離線用
  layer = window.L.tileLayer(b[1], { maxNativeZoom: b[2], maxZoom: 20, attribution: b[3], crossOrigin: 'anonymous', className: `base-${k in BASES ? k : 'emap'}` }).addTo(map);
  pref.set('base', k);
}
function locate() {
  if (!navigator.geolocation) return toast('這個瀏覽器不能定位');
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    me?.remove();
    me = window.L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#0A84FF', fillOpacity: 1 }).addTo(map);
    myPos = ll;   // 只留在這支手機上（休息站卡的「離我多遠」也在這裡算）
    map.flyTo(ll, Math.max(map.getZoom(), 15), { duration: 0.6 });
  }, (e) => toast(e.code === 1 ? '請允許定位權限' : '暫時定位不到'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

async function loadSpots() {
  data = await api('/spots');
  paintPins();
}
// 依目前的搜尋與篩選畫針；縮小時距離太近的針合成一顆（顯示數量，點了放大到那一區）
function shown() {
  const q = filt.q.trim().toLowerCase();
  return data.spots.filter((s) => (s.status === 'approved' || data.editor || s.mine)
    && (!filt.kind || s.kind === filt.kind) && (!filt.city || s.city === filt.city)
    && (!q || `${s.name} ${KIND[s.kind]} ${s.city || ''}`.toLowerCase().includes(q)) && (!filt.openNow || openOf(s)?.open === true));
}
function paintPins() {
  if (!map || !spotsLayer) return;
  spotsLayer.clearLayers();
  const list = shown(), z = map.getZoom(), groups = [];
  // 15 級以上（街道）不合併；其他用 52px 的格子把針分組
  for (const s of list) {
    const pt = map.project([s.lat, s.lng], z);
    const g = z >= 15 || s.id === selected ? null : groups.find((x) => !x.items.some((y) => y.id === selected) && Math.abs(x.pt.x - pt.x) < 52 && Math.abs(x.pt.y - pt.y) < 52);
    if (g) g.items.push(s); else groups.push({ pt, items: [s] });
  }
  for (const g of groups) {
    if (g.items.length === 1) {
      const s = g.items[0], warn = s.latest && (['積水', '施工', '封閉'].includes(s.latest.surface) || s.latest.crowd === '多');
      const icon = window.L.divIcon({ className: 'mpin-host', iconSize: [36, 46], iconAnchor: [18, 45], html: pinHtml(s, warn) });
      // 地點名稱是團員取的，英文介面不翻：標記整個標 translate="no"（title、alt 才不會被拆成中英夾雜），種類先用 t() 換好
      window.L.marker([s.lat, s.lng], { icon, title: s.name, keyboard: true, alt: `${s.name}・${t(KIND[s.kind])}`, riseOnHover: true, zIndexOffset: s.id === selected ? 1000 : 0 })
        .on('add', noTr).addTo(spotsLayer)
        .bindTooltip(`<span translate="no">${esc(s.name)}</span>`, { direction: 'top', offset: [0, -44], className: 'pintip' })
        .on('click', () => openSpot(s.id, 'pan'));
      continue;
    }
    const lat = g.items.reduce((n, s) => n + s.lat, 0) / g.items.length, lng = g.items.reduce((n, s) => n + s.lng, 0) / g.items.length;
    const kinds = [...new Set(g.items.map((s) => s.kind))].slice(0, 3);
    const icon = window.L.divIcon({ className: 'mpin-host', iconSize: [44, 44], iconAnchor: [22, 22],
      html: `<div class="mclus"><b class="num">${g.items.length}</b><span>${kinds.map((k) => `<i class="k-${k}"></i>`).join('')}</span></div>` });
    window.L.marker([lat, lng], { icon, keyboard: true, title: `${g.items.length} 個地點`, alt: `${g.items.length} 個地點，點一下放大` }).addTo(spotsLayer)
      .on('click', () => fitVisible(window.L.latLngBounds(g.items.map((s) => [s.lat, s.lng])).pad(0.3), { maxZoom: 16 }));
  }
}

function onMapClick(pt) {
  if (mode === 'draw') { if (Date.now() < quietUntil) return; strokes.push(draft.length); draft.push(pt); paintDraft(); return; }
  if (mode === 'pick') { const cb = pickCb; endPick(); cb?.(pt); return; }
  // 一般瀏覽：點空白處關掉地點卡或休息站卡（像 Apple 地圖），清單收合讓地圖露出來
  if (RS.isOpen() && !$('#panel form')) { RS.close(); closeCard(); }
  else if (selected && !$('#panel form')) closeCard();
  else if (!wide() && detent !== 'peek' && !$('#panel form')) setDetent('peek');
}
// 關掉地點或路線卡，回到清單
function closeCard() {
  camReset(); RS.deselect();
  selected = null; history.replaceState(null, '', '#/map');
  paintPins(); listPanel(); setDetent(wide() ? 'half' : 'peek');
}
function startPick(cb) { endDraw(); RS.deselect(); mode = 'pick'; pickCb = cb; $('#pickBar').hidden = false; $('#map').classList.add('picking'); tasking(true); setDetent('peek'); toast('點地圖選位置'); }
function endPick() { mode = 'browse'; pickCb = null; $('#pickBar').hidden = true; $('#map')?.classList.remove('picking'); tasking(false); }
// 畫路線、選地點時收起分頁列（body.tasking 用 transform 收到畫面下方，measure() 量得到）；收起或恢復後重新量抽屜
function tasking(on) {
  if (document.body.classList.contains('tasking') === on) return;
  document.body.classList.toggle('tasking', on);
  setTimeout(() => { if ($('#msheet') && !wide()) setDetent(detent, { instant: true }); }, 450);
}
// 再點一次「地圖」分頁：清掉選的地點、抽屜收回（畫路線、選地點時不打斷）
addEventListener('tabreselect', () => { if ($('#msheet') && mode === 'browse') closeCard(); });
// iPad 畫路線：Apple Pencil 隨時直接畫（手指照樣移動、縮放地圖）；打開「手繪」後單指拖也能畫，兩指移動地圖
let freehand = false, strokes = [], quietUntil = 0;
function bindFreehand(el) {
  let pid = null, last = null, start = 0;
  const draws = (e) => mode === 'draw' && (e.pointerType === 'pen' || (freehand && e.isPrimary));
  el.addEventListener('pointerdown', (e) => {
    if (!draws(e) || pid != null) return;
    pid = e.pointerId; last = [e.clientX, e.clientY]; start = draft.length;
    strokes.push(draft.length);
    map.dragging.disable();
    el.setPointerCapture?.(e.pointerId);
    addAt(e); e.preventDefault(); e.stopPropagation();
  }, { capture: true });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    // 每移動 6 像素取一個點，畫得快也不會太多點
    if (Math.hypot(e.clientX - last[0], e.clientY - last[1]) < 6) return;
    last = [e.clientX, e.clientY]; addAt(e); e.preventDefault(); e.stopPropagation();
  }, { capture: true });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null; map.dragging.enable(); quietUntil = Date.now() + 350;
    if (draft.length - start < 2 && strokes.length) { draft.length = strokes.pop(); }   // 只是點一下，交給點選處理
    else simplify(start);
    paintDraft();
  };
  el.addEventListener('pointerup', end, { capture: true });
  el.addEventListener('pointercancel', end, { capture: true });
  // 兩指時把畫到一半的線收掉，讓地圖可以移動
  el.addEventListener('touchstart', (e) => { if (e.touches.length > 1 && pid != null) { pid = null; map.dragging.enable(); } }, { passive: true });
}
function addAt(e) {
  const r = $('#map').getBoundingClientRect(), ll = map.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]);
  draft.push([+ll.lat.toFixed(6), +ll.lng.toFixed(6)]);
  if (draft.length % 3 === 0) paintDraft(true);
}
// 手繪的點太密：相鄰小於 4 公尺的併掉
function simplify(from) {
  const out = draft.slice(0, from + 1);
  for (const p of draft.slice(from + 1)) if (hav(out[out.length - 1], p) >= 4) out.push(p);
  draft = out;
}
function startDraw(seed = []) {
  endPick(); RS.deselect(); mode = 'draw'; draft = [...seed]; strokes = []; routeLayer.clearLayers();
  $('#drawBar').hidden = false; $('#map').classList.add('picking'); tasking(true); paintDraft(); setDetent('peek');
  $('#panel').innerHTML = `<section class="card"><h3>畫路線</h3><p class="tiny" style="margin:0">沿著要跑的路依序點地圖，轉彎處多點幾下比較準；iPad 可以用 Apple Pencil 直接畫，或打開「手繪」用手指畫。完成後可以存起來分享、下載 GPX，或直接開揪跑。</p></section>`;
}
function endDraw() { mode = 'browse'; draft = []; strokes = []; freehand = false; $('#drawFree')?.setAttribute('aria-pressed', 'false'); $('#map')?.classList.remove('freehand'); drawLayer?.clearLayers(); if ($('#drawBar')) $('#drawBar').hidden = true; $('#map')?.classList.remove('picking'); tasking(false); }
function paintDraft(quick) {
  drawLayer.clearLayers();
  if (draft.length) {
    window.L.polyline(draft, { color: '#0A84FF', weight: 5, opacity: 0.9, interactive: false }).addTo(drawLayer);
    // 點選畫的路線顯示每個點；手繪點很多時只標起點與目前終點
    const dots = draft.length <= 25 ? draft.map((p, i) => [p, i]) : [[draft[0], 0], [draft[draft.length - 1], draft.length - 1]];
    if (!quick) for (const [p, i] of dots) window.L.circleMarker(p, { radius: i === 0 ? 7 : 4, color: '#fff', weight: 2, fillColor: i === 0 ? '#34C759' : '#0A84FF', fillOpacity: 1, interactive: false }).addTo(drawLayer);
  }
  $('#drawLen').textContent = km(lenOf(draft));
  $('#drawPts').textContent = draft.length ? `${draft.length} 個點` : '點地圖加上路線的點';
}

// 地點清單（沒選地點時）
async function listPanel() {
  const { routes } = await api('/routes').catch(() => ({ routes: [] }));
  if (!$('#panel')) return;
  const pend = data.spots.filter((s) => s.status === 'pending');
  $('#panel').innerHTML = `
    <div class="sheethead">
      <div class="spotsearch" role="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
        <input id="spotQ" type="search" placeholder="搜尋地點，例如 河濱、田徑場、大安" aria-label="搜尋練跑地點" autocomplete="off" enterkeyhint="search" value="${esc(filt.q)}"></div>
      <div class="chips kindchips" role="group" aria-label="類型" id="kindChips"></div>
    </div>
    ${pend.length && data.editor ? `<section class="card"><h2 class="h3">待審核的地點</h2><div class="roster">${pend.map((s) => `<button class="r spotrow" data-open="${esc(s.id)}">${kindTile(s.kind, 'pending')}<span><b><span translate="no">${esc(s.name)}</span></b></span><span class="tiny">審核 ›</span></button>`).join('')}</div></section>` : ''}
    <section class="card spotlist">
      <div class="row spread"><h2 class="h3">練跑地點</h2><span class="tiny" id="spotCount"></span></div>
      <div class="row spotopts"><select id="spotCity" aria-label="縣市"><option value="">全部縣市</option></select>
        <button type="button" class="btn ghost sm" id="spotOpen" aria-pressed="${filt.openNow}">現在開放</button>
        <button type="button" class="btn ghost sm iconbtn" id="spotNear" aria-pressed="${filt.near}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4 3.5 10.6l7 2.9 2.9 7Z"/></svg>離我最近</button></div>
      <div class="roster" id="spotList"></div>
    </section>
    <section class="card"><div class="row spread"><h2 class="h3">路線</h2><button class="btn ghost sm iconbtn" id="newRoute">${IC.plus}畫一條</button></div>
      ${routes.length ? `<div class="roster">${routes.map((r) => `<button class="r spotrow" data-route="${esc(r.id)}"><span class="av num" style="font-size:11px">${(r.distance / 1000).toFixed(1)}</span><span><b><span translate="no">${esc(r.name)}</span></b><span class="tiny" style="display:block"><span translate="no">${esc(r.author || '')}</span>${r.shared ? '' : '・只有我看得到'}</span></span><i class="chev" aria-hidden="true"></i></button>`).join('')}</div>`
        : '<p class="muted" style="margin:0">還沒有路線。畫一條常跑的路線，分享給大家或拿來開揪跑。</p>'}
    </section>`;
  for (const b of document.querySelectorAll('[data-route]')) b.onclick = () => showRoute(b.dataset.route, true);
  $('#newRoute').onclick = () => startDraw();
  bindSpotFilters();
}
// 搜尋與篩選：打字就篩（只在這台裝置上篩，不用連線）；地圖上的針跟著一起篩
function bindSpotFilters() {
  const approved = data.spots.filter((s) => s.status === 'approved');
  const cities = [...new Set(approved.map((s) => s.city).filter(Boolean))];
  cities.sort((a, b) => CITIES.indexOf(a) - CITIES.indexOf(b));
  const sel = $('#spotCity');
  sel.insertAdjacentHTML('beforeend', cities.map((c) => `<option ${filt.city === c ? 'selected' : ''}>${c}</option>`).join(''));
  if (filt.city && !cities.includes(filt.city)) filt.city = '';
  const paint = () => {
    const base = approved.filter((s) => (!filt.city || s.city === filt.city));
    const q = filt.q.trim().toLowerCase();
    const hit = (s) => !q || `${s.name} ${KIND[s.kind]} ${s.city || ''}`.toLowerCase().includes(q);
    // 類型膠囊上的數字：目前縣市與關鍵字下，每種類型有幾個
    const n = (k) => base.filter((s) => (!k || s.kind === k) && hit(s)).length;
    $('#kindChips').innerHTML = [['', '全部'], ...Object.entries(KIND).filter(([k]) => approved.some((s) => s.kind === k))]
      .map(([k, v]) => `<button type="button" class="chip kchip${k ? ` k-${k}` : ''}${n(k) ? '' : ' empty'}" aria-pressed="${filt.kind === k}" data-kind="${k}">${k ? glyph(k) : ''}<span>${v}</span><b class="num">${n(k)}</b></button>`).join('');
    for (const b of $('#kindChips').querySelectorAll('[data-kind]')) b.onclick = () => { filt.kind = b.dataset.kind; pref.set('kind', filt.kind); paint(); paintPins(); };
    let list = base.filter((s) => (!filt.kind || s.kind === filt.kind) && hit(s) && (!filt.openNow || openOf(s)?.open === true));
    if (filt.near && myPos) list = list.map((s) => ({ ...s, d: hav(myPos, [s.lat, s.lng]) })).sort((a, b) => a.d - b.d);
    $('#spotCount').textContent = list.length === approved.length ? `${approved.length} 個` : `${list.length} / ${approved.length} 個`;
    $('#spotList').innerHTML = list.slice(0, 200).map((s) => { const o = openOf(s); return `<button class="r spotrow${o?.open === false ? ' closed' : ''}" data-open="${esc(s.id)}">${kindTile(s.kind)}
        <span><b><span translate="no">${esc(s.name)}</span></b><span class="tiny" style="display:block">${[o && `<span class="ostat ${o.open ? 'on' : 'off'}">${esc(o.label)}</span>`, KIND[s.kind], s.city && esc(s.city), s.d != null && (s.d < 1000 ? `${Math.round(s.d)} 公尺` : `${(s.d / 1000).toFixed(1)} 公里`)].filter(Boolean).map((x) => `<span class="nw">${x}</span>`).join('・')}${s.reports ? `・24 小時內 ${s.reports} 則回報${s.latest ? `：${esc(Object.entries(s.latest).filter(([k, v]) => v && k !== 'note').map(([, v]) => v).join('、'))}` : ''}` : ''}</span></span><i class="chev" aria-hidden="true"></i></button>`; }).join('')
      || `<p class="muted" style="margin:0">${approved.length ? '沒有符合的地點，換個關鍵字或類型看看。' : data.editor ? '還沒有地點。按地圖右上的地標按鈕，在地圖上點位置新增。' : '還沒有地點。按地圖右上的地標按鈕，提議一個常跑的地方，幹部審核後就會出現。'}</p>`;
    for (const b of document.querySelectorAll('#spotList [data-open], #panel .card:first-child [data-open]')) b.onclick = () => openSpot(b.dataset.open, true);
  };
  let t;
  $('#spotQ').oninput = (e) => { if (e.isComposing) return; clearTimeout(t); t = setTimeout(() => { filt.q = $('#spotQ').value; paint(); paintPins(); }, 120); };
  $('#spotQ').addEventListener('compositionend', () => { filt.q = $('#spotQ').value; paint(); paintPins(); });
  // 點搜尋列：抽屜全開（像 Apple 地圖），結果直接在下面
  $('#spotQ').addEventListener('focus', () => { if (!wide() && detent !== 'full') setDetent('full'); });
  sel.onchange = () => {
    filt.city = sel.value; pref.set('city', filt.city); paint(); paintPins();
    // 選了縣市就把地圖移過去
    const pts = approved.filter((s) => !filt.city || s.city === filt.city).map((s) => [s.lat, s.lng]);
    if (filt.city && pts.length) fitVisible(window.L.latLngBounds(pts).pad(0.15), { maxZoom: 14 });
  };
  $('#spotOpen').onclick = () => { filt.openNow = !filt.openNow; $('#spotOpen').setAttribute('aria-pressed', String(filt.openNow)); paint(); paintPins(); };
  $('#spotNear').onclick = () => {
    if (filt.near) { filt.near = false; $('#spotNear').setAttribute('aria-pressed', 'false'); return paint(); }
    if (!navigator.geolocation) return toast('這台裝置沒有定位功能');
    $('#spotNear').classList.add('busy');
    navigator.geolocation.getCurrentPosition((p) => {
      $('#spotNear')?.classList.remove('busy');
      myPos = [p.coords.latitude, p.coords.longitude]; filt.near = true; $('#spotNear')?.setAttribute('aria-pressed', 'true'); paint();
    }, (e) => { $('#spotNear')?.classList.remove('busy'); toast(e.code === 1 ? '請允許定位權限，才能找離你最近的地點' : '暫時定位不到'); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  };
  for (const b of document.querySelectorAll('#panel [data-open]')) b.onclick = () => openSpot(b.dataset.open, true);
  paint();
}

// 地點卡片：說明、天氣、現場回報、路線、接下來在這裡的活動
async function openSpot(id, fly) {
  endDraw(); endPick(); camReset(); RS.deselect();
  const d = await api(`/spots/${id}`).catch((e) => { toast(e.message); return null; });
  if (!d) return listPanel();
  const s = d.spot;
  history.replaceState(null, '', `#/map?spot=${id}`);
  // 地點卡一律半開（像 Apple 地圖的地點卡）：從搜尋結果點、或填完回報回來都一樣
  selected = id; paintPins(); setDetent('half');
  // 剛打開頁面直接跳過去；在地圖上點選才用飛的
  // 點地圖上的針：不改縮放，只把針移到看得到的地方；從清單點：放大到 15 級
  if (fly) focusOn([s.lat, s.lng], fly === 'pan' ? map.getZoom() : Math.max(map.getZoom(), 15), fly);
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=walking`;
  $('#panel').innerHTML = `<section class="card spotcard">
      <div class="row spread" style="flex-wrap:nowrap;align-items:flex-start"><div class="row" style="gap:12px;align-items:center;flex-wrap:nowrap;min-width:0">${kindTile(s.kind)}<div style="min-width:0"><span class="tiny">${KIND[s.kind]}${s.city ? `・${esc(s.city)}` : ''}</span>${s.status === 'pending' ? ' <span class="pill wait">審核中</span>' : ''}<h2 style="margin:2px 0 0"><span translate="no">${esc(s.name)}</span></h2></div></div>
        <button class="xbtn" id="backList" aria-label="關閉，回地點清單"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>
      <div class="spotacts"><a class="btn sm" href="${nav}" target="_blank" rel="noopener">導航 ${IC.external}</a><button class="btn ghost sm" id="offBtn">下載離線地圖</button>${s.status !== 'approved' ? '' : canCreate() ? `<a class="btn ghost sm" href="#/new?spot=${esc(s.id)}">在這裡開揪跑</a>`
        : `<a class="btn ghost sm" href="${lineShare(`我想在「${s.name}」揪跑，有人要一起嗎？ ${location.origin}/#/map?spot=${s.id}`)}" target="_blank" rel="noopener">在 LINE 揪人</a>`}
        ${data.editor || (s.mine && s.status === 'pending') ? '<button class="btn ghost sm" id="editSpot">編輯</button>' : ''}</div>
      ${s.status === 'pending' && d.editor ? '<div class="row" style="gap:8px"><button class="btn sm" id="approve">通過</button><button class="btn danger sm" id="reject">不通過</button></div>' : ''}
      ${(() => { const o = s.info?.hours ? hoursNow(s.info.hours) : null; return s.info?.hours ? `<p class="ohours"><span class="ostat ${o ? (o.open ? 'on' : 'off') : ''}">${o ? esc(o.label) : '開放時間'}</span><span class="tiny">${o ? esc(s.info.hours) : `<span translate="no">${esc(s.info.hours)}</span>`}</span></p>` : ''; })()}
      ${camSection(d.editor)}
      ${s.intro ? `<p class="muted" style="margin:0;white-space:pre-wrap"><span translate="no">${esc(s.intro)}</span></p>` : ''}
      ${Object.keys(s.info || {}).length ? `<div class="infochips">${Object.entries(INFO).filter(([k]) => k !== 'hours' && s.info[k]).map(([k, v]) => `<span data-info="${k}"><span class="tiny">${v}</span>${infoVal(s.info[k])}</span>`).join('')}</div>` : ''}
    </section>
    <section class="card"><h3>天氣</h3><div id="wxBox"><p class="tiny" style="margin:0">載入中…</p></div></section>
    ${RS.nearHtml()}
    ${s.status === 'approved' ? `<section class="card"><div class="row spread"><h3>現場回報</h3><button class="btn sm" id="repBtn">回報現場</button></div>
      <div id="repForm"></div>
      ${d.reports.length ? `<div class="reports">${d.reports.map((r) => `<div class="rep"><div>${Object.keys(REP).filter((k) => r[k]).map((k) => `<span class="pill ${['積水', '施工', '封閉', '多', '大雨', '沒有'].includes(r[k]) ? 'wait' : ''}">${REP[k][0]} ${esc(r[k])}</span>`).join('')}</div>
        ${r.note ? `<p style="margin:4px 0 0"><span translate="no">${esc(r.note)}</span></p>` : ''}<span class="tiny">${agoShort(r.at)}${r.mine ? '・我' : ''}</span>${r.mine || d.editor ? ` <button class="linkbtn tiny" data-delrep="${esc(r.id)}">刪除</button>` : ''}</div>`).join('')}</div>`
        : '<p class="muted" style="margin:0">24 小時內還沒有人回報。剛跑完？告訴大家現在的狀況。</p>'}
      ${d.week.length ? `<p class="tiny" style="margin:0">最近 7 天共 ${d.week.reduce((n, x) => n + x.n, 0)} 則回報</p>` : ''}</section>` : ''}
    ${d.events.length ? `<section class="card"><h3>接下來在這裡</h3>${d.events.map((e) => `<a class="todayev" href="#/e/${esc(e.id)}">${IC.calendar}<span><b><span translate="no">${esc(e.title)}</span></b><span class="tiny" style="display:block">${esc(e.date)}${e.gather_time ? ` ${esc(e.gather_time)}` : ''}</span></span><span class="tiny">›</span></a>`).join('')}</section>` : ''}
    <section class="card"><div class="row spread"><h3>這裡的路線</h3><button class="btn ghost sm iconbtn" id="drawHere">${IC.plus}畫一條</button></div>
      ${d.routes.length ? `<div class="roster">${d.routes.map((r) => `<button class="r spotrow" data-route="${esc(r.id)}"><span class="av num" style="font-size:11px">${(r.distance / 1000).toFixed(1)}</span><span><b><span translate="no">${esc(r.name)}</span></b></span><i class="chev" aria-hidden="true"></i></button>`).join('')}</div>` : '<p class="muted" style="margin:0">還沒有路線。</p>'}</section>`;
  $('#backList').onclick = closeCard;
  $('#editSpot')?.addEventListener('click', () => spotForm(s, [s.lat, s.lng]));
  $('#offBtn').onclick = () => saveOffline(s);
  for (const [b, ok] of [[$('#approve'), true], [$('#reject'), false]]) b?.addEventListener('click', async () => {
    try { await api(`/spots/${s.id}/review`, { method: 'POST', body: { approve: ok } }); toast(ok ? '已通過' : '已退回'); await loadSpots(); ok ? openSpot(s.id) : listPanel(); } catch (e) { toast(e.message); }
  });
  $('#repBtn')?.addEventListener('click', () => reportForm(s.id));
  for (const b of document.querySelectorAll('[data-delrep]')) b.onclick = async () => { if (!confirm('刪除這則回報？')) return; await api(`/spots/${s.id}/reports/${b.dataset.delrep}`, { method: 'DELETE' }); openSpot(s.id); };
  for (const b of document.querySelectorAll('[data-route]')) b.onclick = () => showRoute(b.dataset.route, true);
  $('#drawHere').onclick = () => { startDraw([[s.lat, s.lng]]); spotForRoute = s.id; };
  bindCams(s, d.editor);
  RS.loadNear(s, d.editor);
  W.load(s.lat, s.lng).then((w) => { if ($('#wxBox')) $('#wxBox').innerHTML = W.strip(w); }).catch((e) => { if ($('#wxBox')) $('#wxBox').innerHTML = `<p class="tiny" style="margin:0">${esc(e.message)}</p>`; });
}
// ---- 附近即時影像 ----
// 畫面由本站轉送（/api/cams/:id/frame）：跑友的 IP 不會送到影像來源，本站也不保存影像
//   功能開關 features.cams 預設關閉（要明確打開）；關閉或所有來源都關掉時整段不顯示
//   位置：地點卡開放時間下面，可以收合（記在這支手機）；收合時不載入影像
//   縮圖：一列三格，段落看得見時才載入，而且只載一次、不自動更新；別的 isolate 剛抓過（503）就照 Retry-After 再試一次
//   大圖：點縮圖打開；每 60 秒更新，只在畫面看得見時更新，App 進背景就暫停，10 分鐘後自動停止
//   省流量（「我的 → 外觀與語言」的開關、系統的省數據模式或 2G 網路）：都不自動載入，點了才載
const CAM_NOTE = '影像為政府公開攝影機畫面，由本站即時轉送、不保存，你的 IP 與位置不會傳給影像來源。僅供參考天氣與路況，實際狀況以現場與官方公告為準。';
const CAM_NOTE_SHORT = '政府公開攝影機畫面，由本站轉送、不保存；僅供參考天氣與路況，以現場與官方公告為準。';
const CAM_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/></svg>';
const LIVE_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="4"/><path d="M10 9v6l5-3Z"/></svg>';
const camsFeat = () => cfg.settings?.features?.cams === true;
const saveData = () => { if (camLazy.get()) return true; const c = navigator.connection; return !!(c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))); };
const camFold = { get() { try { return localStorage.getItem('cil-cam-fold') === '1'; } catch { return false; } }, set(v) { try { v ? localStorage.setItem('cil-cam-fold', '1') : localStorage.removeItem('cil-cam-fold'); } catch {} } };
let camIO = null, camUrls = [], camClose = null, camAfter = null;
function camReset() {
  camIO?.disconnect(); camIO = null;
  camClose?.(); camClose = null;
  for (const u of camUrls) URL.revokeObjectURL(u);
  camUrls = [];
}
// 換頁（例如點上方的通知、標誌）時一定關掉大圖，不讓它蓋在下一頁上、也不再繼續抓畫面
addEventListener('hashchange', () => { camClose?.(); camClose = null; });
const distTxt = (m) => (m < 50 ? '就在附近' : m < 1000 ? `${Math.round(m / 10) * 10} 公尺` : `${(m / 1000).toFixed(1)} 公里`);
const hhmm = (iso) => { const d = new Date(iso); return !iso || Number.isNaN(+d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ageTxt = (iso) => (hhmm(iso) ? `${hhmm(iso)} 擷取${Date.now() - +new Date(iso) > 15 * 60e3 ? '・畫面可能延遲' : ''}` : '');
const camAlt = (c, at) => (lang === 'en' ? `${c.name} live camera image${hhmm(at) ? `, captured ${hhmm(at)}` : ''}` : `${c.name} 即時影像${hhmm(at) ? `，${hhmm(at)} 擷取` : ''}`);
// 取一張畫面：用 fetch 拿回來轉成 blob 網址（CSP 允許 blob:），才讀得到擷取時間與錯誤狀態
//   回 { url, at, t }；別的地方剛抓過、要等一下（503）回 { wait: 秒 }；其他錯誤丟出例外
async function camFrame(id) {
  const r = await fetch(`/api/cams/${encodeURIComponent(id)}/frame`);
  if (r.status === 503) return { wait: Math.min(Math.max(Number(r.headers.get('retry-after')) || 10, 1), 120) };
  if (!r.ok) throw new Error(r.status === 429 ? '影像看得太頻繁，請稍後再試' : '暫時無法取得畫面');
  const url = URL.createObjectURL(await r.blob());
  camUrls.push(url);
  return { url, at: r.headers.get('x-cam-at') || '', t: Date.now() };
}
const dropUrl = (u) => { if (!u) return; URL.revokeObjectURL(u); camUrls = camUrls.filter((x) => x !== u); };
// 地點卡裡的段落（功能開關打開時才有）：標題列可以收合；幹部可以加官方直播的外連
const camSection = (editor) => (camsFeat() ? `<div class="camsec" id="camCard"${editor ? '' : ' hidden'}>
    <div class="row spread"><h3 class="camh"><button type="button" id="camTog" aria-expanded="${!camFold.get()}" aria-controls="camBody">附近即時影像<span class="chev" aria-hidden="true"></span></button></h3>
      ${editor ? `<button type="button" class="btn ghost sm iconbtn" id="camAdd" hidden>${IC.plus}${lang === 'en' ? 'Add link' : '直播連結'}</button>` : ''}</div>
    <div id="camBody"${camFold.get() ? ' hidden' : ''}>
      <div id="camAddForm"></div>
      <div id="camBox"><p class="tiny" style="margin:0">載入中…</p></div>
      <p class="camvh" id="camStat" role="status"></p>
    </div></div>` : '');
function bindCams(s, editor) {
  const card = $('#camCard');
  if (!card) return;
  let list = null;
  $('#camAdd')?.addEventListener('click', () => camLinkForm(s, editor));
  $('#camTog').onclick = (e) => {
    const open = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    e.currentTarget.setAttribute('aria-expanded', String(open));
    $('#camBody').hidden = !open; camFold.set(!open);
    if (open && list) watch();
  };
  // 段落看得見而且展開時才載入縮圖
  const watch = () => {
    if (camIO || $('#camBody')?.hidden) return;
    const go = () => { camIO?.disconnect(); camIO = null; if (!$('#camBody')?.hidden) thumbs(); };
    if (!('IntersectionObserver' in window)) return go();
    camIO = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) go(); });
    camIO.observe(card);
  };
  const thumbs = () => { if (saveData()) return; for (const b of document.querySelectorAll('#camBox [data-cam]')) if (!b.dataset.url && !b._p) camThumb(b, list.find((x) => x.id === b.dataset.cam)); };
  camAfter = (cams) => { list = cams; watch(); };
  loadCams(s, editor, false, camAfter);
}
async function loadCams(s, editor, fresh, done) {
  const box = $('#camBox'), card = $('#camCard'), stat = $('#camStat');
  if (!box) return;
  let r;
  try { r = await api(`/spots/${encodeURIComponent(s.id)}/cams${fresh ? `?r=${Date.now()}` : ''}`); } catch (e) {
    if (!box.isConnected) return;
    card.hidden = false;
    box.innerHTML = `<p class="tiny" style="margin:0">${esc(e.message)}</p><button type="button" class="btn ghost sm" id="camRetry">再試一次</button>`;
    $('#camRetry').onclick = () => loadCams(s, editor, true, done);
    return;
  }
  if (!box.isConnected || selected !== s.id) return;
  // 功能或所有來源都關掉：整段不顯示
  if (!r.enabled) { card.remove(); return; }
  const cams = r.cams || [], lazy = saveData();
  const add = $('#camAdd'); if (add) add.hidden = !r.link;
  // 附近沒有鏡頭：一般跑友不顯示這段，幹部看得到（可以加直播連結）
  card.hidden = !cams.length && !editor;
  if (!cams.length) { box.innerHTML = '<p class="muted" style="margin:0">附近 3 公里內沒有公開的攝影機。</p>'; stat.textContent = ''; done?.(cams); return; }
  const far = cams.find((c) => c.far);
  const attrs = [...new Set(cams.map((c) => (c.media === 'link'
    ? (c.label ? `「<span translate="no">${esc(c.label)}</span>」官方直播` : esc(c.attribution)) : esc(c.attribution))).filter(Boolean))];
  box.innerHTML = `<div class="camgrid">${cams.map((c) => (c.media === 'link'
    ? `<div class="camtile"><a href="${esc(c.page_url || '#')}" target="_blank" rel="noopener noreferrer"><span class="camimg"><span class="camph">${LIVE_SVG}</span></span>
        <span class="camcap"><b translate="no">${esc(c.name)}</b><span class="tiny">${distTxt(c.dist)}</span><span class="tiny">${c.label ? `<span translate="no">${esc(c.label)}</span>` : '官方直播'} ${IC.external}</span></span></a></div>`
    : `<button type="button" class="camtile" data-cam="${esc(c.id)}"><span class="camimg"><span class="camph">${CAM_SVG}${lazy ? '<span class="tiny">點一下載入</span>' : ''}</span></span>
        <span class="camcap"><b translate="no">${esc(c.name)}</b><span class="tiny">${distTxt(c.dist)}</span><span class="tiny camat"></span></span></button>`)).join('')}</div>
    ${far ? `<p class="tiny" style="margin:0">較遠（${distTxt(far.dist)}），僅供參考天氣</p>` : ''}
    <p class="tiny camattr" style="margin:0">${attrs.join('<br>')}</p>
    ${lazy ? '<p class="tiny" style="margin:0">省流量模式：點一下才載入影像（每張約 20–250 KB）。</p>' : ''}
    <p class="tiny" style="margin:0">${CAM_NOTE_SHORT}</p>
    ${editor && cams.some((c) => c.media === 'link') ? `<div class="camlinks">${cams.filter((c) => c.media === 'link').map((c) => `<button type="button" class="btn ghost sm" data-delcam="${esc(c.id)}">刪除直播連結：<span translate="no">${esc(c.name)}</span></button>`).join('')}</div>` : ''}`;
  stat.textContent = `${cams.length} 支鏡頭`;
  for (const b of box.querySelectorAll('[data-cam]')) {
    const c = cams.find((x) => x.id === b.dataset.cam);
    b.onclick = () => camViewer(c, b);
  }
  for (const b of box.querySelectorAll('[data-delcam]')) b.onclick = async () => {
    if (!confirm('刪除這個直播連結？')) return;
    try { await api(`/cams/${encodeURIComponent(b.dataset.delcam)}`, { method: 'DELETE' }); toast('已刪除'); $('#camTog')?.focus(); loadCams(s, editor, true, done); } catch (e) { toast(e.message); }
  };
  done?.(cams);
}
// 縮圖放進格子（大圖在省流量模式下載到的畫面也寫回來，不用再下載一次）
function camPut(b, c, f) {
  // alt 已經依介面語言寫好（含鏡頭名稱），標 translate="no" 不要再被翻譯一次
  b.querySelector('.camimg').innerHTML = `<img translate="no" alt="${esc(camAlt(c, f.at))}" src="${f.url}">`;
  b.querySelector('.camat').textContent = ageTxt(f.at);
  Object.assign(b.dataset, { url: f.url, at: f.at, t: String(f.t) });
}
async function camThumb(b, c, retried) {
  const box = b.querySelector('.camimg');
  b._p = camFrame(c.id);
  try {
    const f = await b._p;
    if (!b.isConnected) return f.url && dropUrl(f.url);
    if (f.wait) {
      box.innerHTML = `<span class="camph"><span class="tiny">畫面更新中</span></span>`;
      if (!retried) setTimeout(() => { if (b.isConnected && !b.dataset.url) camThumb(b, c, true); }, f.wait * 1000);
      return;
    }
    camPut(b, c, f);
  } catch (e) { if (b.isConnected) box.innerHTML = `<span class="camph"><span class="tiny">${esc(e.message)}</span></span>`; }
  finally { b._p = null; }
}
// 大圖：在畫面看得見時每 interval 秒（至少 60 秒）更新；隱藏時暫停、回來時補一張；10 分鐘後停止；連續失敗 3 次停止
//   別的地方剛抓過（503）：繼續顯示上一張，照 Retry-After 再試，不算失敗
async function camViewer(c, opener) {
  camClose?.();
  const lazy = saveData(), iv = Math.max(60, c.interval || 60) * 1000, STOP = 10 * 60e3;
  const { host, close } = openSheet('即時影像', `<div class="row spread"><h3 id="camvT" style="margin:0"><span translate="no">${esc(c.name)}</span></h3>
      <button type="button" class="xbtn" data-close aria-label="關閉"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>
    <div class="camview"><span class="camph" id="camvPh">${CAM_SVG}<span class="tiny" id="camvPhT">載入中…</span></span><img id="camvImg" alt="" hidden></div>
    <p class="tiny" style="margin:0">${distTxt(c.dist)}${c.far ? '（較遠，僅供參考天氣）' : ''}・${esc(c.source_name)}</p>
    <p class="tiny" style="margin:0" id="camvAt"></p>
    <div class="row camvbar"><p class="tiny" style="margin:0" id="camvState" role="status"></p><button type="button" class="btn ghost sm" id="camvGo" hidden></button></div>
    <p class="tiny" style="margin:0">${esc(c.attribution)}</p>
    ${c.page_url ? `<div><a class="btn ghost sm" href="${esc(c.page_url)}" target="_blank" rel="noopener noreferrer">官方頁面 ${IC.external}</a></div>` : ''}
    <p class="tiny" style="margin:0">${CAM_NOTE}</p>`, opener, 'camvT');
  host.classList.add('camsheet');
  camClose = close;
  const img = host.querySelector('#camvImg'), ph = host.querySelector('#camvPh'), phT = host.querySelector('#camvPhT'), st = host.querySelector('#camvState'), atEl = host.querySelector('#camvAt'), go = host.querySelector('#camvGo');
  let timer = 0, last = 0, fails = 0, started = Date.now(), stopped = false, busy = false, cur = null;
  const alive = () => host.isConnected;
  const show = (f) => {
    const old = cur;
    cur = f.url; img.src = f.url; img.alt = camAlt(c, f.at); img.hidden = false; ph.hidden = true;
    atEl.textContent = ageTxt(f.at);
    if (old && old !== opener.dataset.url) dropUrl(old);
  };
  // 狀態文字與按鈕：按鈕只建一次、只換字（焦點不會掉）；文字有變才寫（讀螢幕軟體不會每分鐘重唸）
  const put = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  const setState = () => {
    put(st, stopped ? (fails >= 3 ? '暫時無法取得畫面' : '已暫停更新') : lazy ? '省流量模式：不自動更新' : '每 60 秒自動更新，畫面隱藏時暫停');
    put(go, lazy ? '更新畫面' : stopped ? '繼續' : '暫停更新');
    go.hidden = false;
  };
  // 回傳下一次要等幾毫秒
  const refresh = async () => {
    if (busy || !alive()) return iv;
    busy = true;
    try {
      const f = await camFrame(c.id);
      if (!alive()) { if (f.url) dropUrl(f.url); return iv; }
      if (f.wait) { if (!cur) put(phT, '畫面更新中，稍後自動重試'); return f.wait * 1000; }
      const pre = new Image(); pre.src = f.url;
      await pre.decode().catch(() => {});   // 先在背景解碼再換，避免閃一下
      show(f); fails = 0; last = Date.now();
      // 縮圖還沒有畫面（省流量或載入失敗）：把這張寫回縮圖，不用再下載一次
      if (opener.isConnected && !opener.dataset.url) camPut(opener, c, f);
      return iv;
    } catch (e) {
      fails++;
      if (!cur) put(phT, e.message);
      if (fails >= 3) stopped = true;
      return iv;
    } finally { busy = false; }
  };
  const schedule = (ms = iv) => { clearTimeout(timer); if (!lazy && !stopped && alive()) timer = setTimeout(tick, ms); };
  async function tick() {
    if (!alive()) return cleanup();
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - started >= STOP) { stopped = true; return setState(); }
    const next = await refresh(); setState(); schedule(next);
  }
  go.onclick = async () => {
    if (lazy) { const next = await refresh(); if (next !== iv) put(st, '畫面更新中，請稍後再試'); else setState(); return; }
    if (stopped) { stopped = false; fails = 0; started = Date.now(); setState(); tick(); return; }
    stopped = true; clearTimeout(timer); setState();
  };
  const onVis = () => {
    if (!alive()) return cleanup();
    if (document.visibilityState !== 'visible') { clearTimeout(timer); return; }
    if (stopped || lazy) return;
    const since = Date.now() - last;
    if (since >= iv) tick(); else schedule(iv - since);
  };
  const mo = new MutationObserver(() => { if (!alive()) cleanup(); });
  function cleanup() {
    clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); mo.disconnect();
    if (camClose === close) camClose = null;
    if (cur && cur !== opener.dataset.url) dropUrl(cur);
  }
  document.addEventListener('visibilitychange', onVis);
  mo.observe(document.body, { childList: true });
  setState();
  // 縮圖還在載入：等它（同一支鏡頭 60 秒內只會向來源抓一次，不要重複要）
  if (opener._p) await opener._p.catch(() => {});
  if (!alive()) return;
  // 縮圖剛載過就先用它，等滿一個間隔再更新
  const t0 = Number(opener.dataset.t || 0);
  if (opener.dataset.url && t0) { cur = opener.dataset.url; show({ url: cur, at: opener.dataset.at }); last = t0; schedule(Math.max(0, iv - (Date.now() - t0))); }
  else if (lazy) refresh().then((next) => { if (next !== iv && alive()) put(st, '畫面更新中，請稍後再試'); else setState(); });
  else tick();
}
// 幹部：新增官方直播連結（例如 YouTube 直播頁），位置用這個地點的座標；只顯示成外連
function camLinkForm(s, editor) {
  const box = $('#camAddForm');
  if (!box) return;
  if ($('#camBody')?.hidden) $('#camTog')?.click();
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = `<form id="camLinkF" class="grid2" style="margin:4px 0 8px">
      <label>名稱<input name="name" maxlength="40" required placeholder="例如 大佳河濱公園直播"></label>
      <label>來源名稱<input name="label" maxlength="30" placeholder="例如 臺北市觀光傳播局"></label>
      <label style="grid-column:1/-1">直播網址<input name="page_url" type="url" required placeholder="https://www.youtube.com/…"></label>
      <p class="tiny" style="grid-column:1/-1;margin:0">位置用這個地點的座標。只顯示成外連、不嵌入播放；請只加政府或場館的官方直播。</p>
      <div class="row" style="gap:8px;grid-column:1/-1"><button class="btn sm">新增</button><button type="button" class="btn ghost sm" id="camLinkX">取消</button></div>
    </form>`;
  $('#camLinkX').onclick = () => { box.innerHTML = ''; $('#camAdd')?.focus(); };
  $('#camLinkF').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, kind = { river: 'river', road: 'road', trail: 'sky' }[s.kind] || 'park';
    try {
      await api('/cams', { method: 'POST', body: { name: f.name.value.trim(), label: f.label.value.trim(), page_url: f.page_url.value.trim(), lat: s.lat, lng: s.lng, kind } });
      toast('已新增直播連結'); box.innerHTML = ''; $('#camAdd')?.focus();
      loadCams(s, editor, true, camAfter);
    } catch (err) { toast(err.message); }
  };
}
// 離線地圖：把地點附近約 1.5 公里、縮放 13–17 級的圖磚存在手機（目前的底圖），沒訊號時也看得到地圖與路線
async function saveOffline(s) {
  const b = BASES[pref.get('base', 'emap')] || BASES.emap, urls = [];
  const tx = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z), ty = (lat, z) => Math.floor(((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * 2 ** z);
  for (let z = 13; z <= Math.min(17, b[2]); z++) {
    for (let x = tx(s.lng - 0.016, z); x <= tx(s.lng + 0.016, z); x++) for (let y = ty(s.lat + 0.014, z); y <= ty(s.lat - 0.014, z); y++) urls.push(b[1].replace('{z}', z).replace('{x}', x).replace('{y}', y));
  }
  const btn = $('#offBtn'), cache = await caches.open('cil-tiles');
  let done = 0, fail = 0;
  btn.disabled = true;
  for (let i = 0; i < urls.length; i += 6) {
    await Promise.all(urls.slice(i, i + 6).map(async (u) => {
      try { if (!(await cache.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await cache.put(u, r); else fail++; } } catch { fail++; }
      done++; if (btn.isConnected) btn.textContent = `下載中 ${Math.round((done / urls.length) * 100)}%`;
    }));
  }
  await RS.prefetchNear(s.id);   // 附近休息站也存一份（Service Worker 的離線資料）
  if (btn.isConnected) { btn.textContent = fail ? `完成（${fail} 張失敗）` : '已存離線地圖'; }
  toast(`已存 ${urls.length - fail} 張地圖，沒有網路也看得到這附近`);
}
const agoShort = (ts) => { const m = Math.round((Date.now() - Date.parse(`${ts.replace(' ', 'T')}Z`)) / 60000); return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : `${Math.round(m / 60)} 小時前`; };
let spotForRoute = null;

function reportForm(id) {
  setDetent('full');
  $('#repForm').innerHTML = `<form id="rf" class="repform">
    ${Object.entries(REP).map(([k, [label, opts]]) => `<fieldset class="qset"><legend>${label}</legend><div class="chips">${opts.map((o) => `<label class="chip"><input type="radio" name="${k}" value="${o}"><span>${o}</span></label>`).join('')}</div></fieldset>`).join('')}
    <label>補充（選填）<input name="note" maxlength="200" placeholder="例如 內圈積水、北側路燈壞了"></label>
    <div class="row"><button class="btn sm">送出</button><button type="button" class="btn ghost sm" id="rfc">取消</button></div>
    <p class="tiny" style="margin:0">回報 24 小時後就不再顯示，別人看不到是誰回報的。</p></form>`;
  const f = $('#rf');
  $('#rfc').onclick = () => { $('#repForm').innerHTML = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.keys(REP).map((k) => [k, f.querySelector(`[name=${k}]:checked`)?.value]));
    body.note = f.note.value.trim();
    try { await api(`/spots/${id}/reports`, { method: 'POST', body }); toast('謝謝回報'); await loadSpots(); openSpot(id); } catch (err) { toast(err.message); }
  };
}

function spotForm(s, pt) {
  const v = s || { kind: 'track', info: {} };
  setDetent('full');
  $('#panel').innerHTML = `<form class="card" id="sf">
    <h3>${s ? '編輯地點' : data.editor ? '新增地點' : '提議地點'}</h3>
    ${!s && !data.editor ? '<p class="tiny" style="margin:0">幹部審核通過後，大家就看得到。</p>' : ''}
    <div class="grid2"><label>名稱<input name="name" maxlength="40" required value="${esc(v.name || '')}" placeholder="例如 臺北田徑場"></label>
      <label>類型<select name="kind">${Object.entries(KIND).map(([k, t]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
    <label>縣市<select name="city"><option value="">（請選擇）</option>${CITIES.map((c) => `<option ${v.city === c || (!v.city && filt.city === c) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <div class="row spread"><span class="tiny">位置 <span class="num" id="ptText">${pt[0].toFixed(5)}, ${pt[1].toFixed(5)}</span></span><button type="button" class="btn ghost sm" id="repick">重新選位置</button></div>
    <label>說明<textarea name="intro" maxlength="600" placeholder="怎麼去、適合什麼課表、要注意什麼">${esc(v.intro || '')}</textarea></label>
    <div class="grid2">${Object.entries(INFO).map(([k, t]) => `<label>${t}<input name="i_${k}" maxlength="60" value="${esc(v.info?.[k] || '')}" placeholder="${{ lap: '400 公尺', surface: 'PU 跑道', light: '有，到 22:00', water: '有飲水機', toilet: '有，入口旁', parking: '路邊停車', hours: '05:00–22:00' }[k]}"></label>`).join('')}</div>
    <div class="row"><button class="btn sm">${s ? '儲存' : data.editor ? '新增' : '送出提議'}</button><button type="button" class="btn ghost sm" id="sfc">取消</button>
      ${s ? '<button type="button" class="btn danger sm" id="sfd">刪除</button>' : ''}</div></form>`;
  let cur = pt;
  const mk = window.L.circleMarker(cur, { radius: 9, color: '#fff', weight: 3, fillColor: '#FF9F0A', fillOpacity: 1 }).addTo(drawLayer);
  focusOn(cur, Math.max(map.getZoom(), 16));
  // 選位置會清掉 drawLayer（連同這個點）：選好後再放回去
  $('#repick').onclick = () => startPick((p) => { cur = p; mk.setLatLng(p).addTo(drawLayer); $('#ptText').textContent = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`; });
  $('#sfc').onclick = () => { drawLayer.clearLayers(); s ? openSpot(s.id) : listPanel(); };
  $('#sfd')?.addEventListener('click', async () => { if (!confirm('刪除這個地點？回報也會一起刪除。')) return; await api(`/spots/${s.id}`, { method: 'DELETE' }); drawLayer.clearLayers(); toast('已刪除'); await loadSpots(); listPanel(); });
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value, kind: f.kind.value, city: f.city.value, lat: cur[0], lng: cur[1], intro: f.intro.value, info: Object.fromEntries(Object.keys(INFO).map((k) => [k, f[`i_${k}`].value.trim()])) };
    try {
      const r = s ? await api(`/spots/${s.id}`, { method: 'PUT', body }) : await api('/spots', { method: 'POST', body });
      drawLayer.clearLayers(); await loadSpots();
      toast(s ? '已儲存' : r.status === 'pending' ? '已送出，等幹部審核' : '已新增');
      openSpot(s ? s.id : r.id);
    } catch (err) { toast(err.message); }
  };
}

function routeForm() {
  const pts = [...draft], dist = lenOf(pts);
  setDetent('full');
  const near = data.spots.filter((s) => s.status === 'approved').map((s) => ({ s, d: hav([s.lat, s.lng], pts[0]) })).sort((a, b) => a.d - b.d)[0];
  $('#panel').innerHTML = `<form class="card" id="rtf"><h3>存路線・${km(dist)}</h3>
    <label>名稱<input name="name" maxlength="40" value="${esc(near && near.d < 1500 ? `${near.s.name} ${(dist / 1000).toFixed(1)}K` : `${(dist / 1000).toFixed(1)} 公里路線`)}"></label>
    <label>起點附近的地點<select name="spot"><option value="">（不指定）</option>${data.spots.filter((s) => s.status === 'approved').map((s) => `<option value="${esc(s.id)}" ${(spotForRoute || (near && near.d < 1500 && near.s.id)) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label class="inline"><input type="checkbox" name="shared" checked> 分享給全團</label>
    <div class="row"><button class="btn sm">儲存</button><button type="button" class="btn ghost sm" id="rtGpx">只下載 GPX</button><button type="button" class="btn ghost sm" id="rtBack">繼續畫</button></div></form>`;
  $('#rtBack').onclick = () => { startDraw(pts); };
  $('#rtGpx').onclick = () => downloadGpx($('#rtf').name.value || '路線', pts);
  $('#rtf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/routes', { method: 'POST', body: { name: f.name.value, points: pts, spot_id: f.spot.value || null, shared: f.shared.checked } });
      spotForRoute = null; endDraw(); toast('已儲存路線'); showRoute(r.id, false);
    } catch (err) { toast(err.message); }
  };
}

async function showRoute(id, fly) {
  endDraw(); RS.deselect();
  const { route: r } = await api(`/routes/${id}`).catch((e) => { toast(e.message); return {}; });
  if (!r) return listPanel();
  history.replaceState(null, '', `#/map?route=${id}`);
  routeLayer.clearLayers();
  const line = window.L.polyline(r.points, { color: '#0A84FF', weight: 5, opacity: 0.9 }).addTo(routeLayer);
  window.L.circleMarker(r.points[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#34C759', fillOpacity: 1 }).addTo(routeLayer);
  window.L.circleMarker(r.points[r.points.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#FF3B30', fillOpacity: 1 }).addTo(routeLayer);
  // 先把抽屜拉到半開，再依看得到的範圍縮放（路線不會被面板或抽屜蓋住）
  selected = null; paintPins(); setDetent('half', { instant: fly === 'jump' });
  if (fly) fitVisible(line.getBounds(), { animate: fly !== 'jump' });
  $('#panel').innerHTML = `<section class="card"><div class="row spread"><div><span class="pill">路線</span><h2 style="margin:6px 0 0"><span translate="no">${esc(r.name)}</span></h2></div><button class="xbtn" id="backList" aria-label="關閉，回地點清單"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>
    <div class="lstats"><span><b class="num">${(r.distance / 1000).toFixed(2)}</b> 公里</span><span>${r.points.length} 個點</span>${r.shared ? '' : '<span>只有我看得到</span>'}</div>
    <div class="row" style="gap:8px">${canCreate() ? `<a class="btn sm" href="#/new?route=${esc(r.id)}${r.spot_id ? `&spot=${esc(r.spot_id)}` : ''}">用這條路線開揪跑</a>`
      : `<a class="btn sm" href="${lineShare(`一起跑這條路線：${r.name}（${(r.distance / 1000).toFixed(1)} 公里） ${location.origin}/#/map?route=${r.id}`)}" target="_blank" rel="noopener">在 LINE 揪人</a>`}<button class="btn ghost sm" id="gpxBtn">下載 GPX</button>
      <button class="btn ghost sm" id="shareRt">分享</button>${r.mine || data.editor ? '<button class="btn danger sm" id="delRt">刪除</button>' : ''}</div>
    <p class="tiny" style="margin:0">GPX 可以匯入 Garmin Connect、COROS、Strava 的路線功能，跑的時候在手錶上導航。</p></section>`;
  $('#backList').onclick = () => { routeLayer.clearLayers(); closeCard(); };
  $('#gpxBtn').onclick = () => downloadGpx(r.name, r.points);
  $('#shareRt').onclick = async () => {
    const url = `${location.origin}/#/map?route=${r.id}`, text = `耕跑團路線：${r.name}（${(r.distance / 1000).toFixed(1)} 公里）`;
    if (navigator.share) { try { await navigator.share({ title: r.name, text, url }); } catch {} } else { await navigator.clipboard?.writeText(`${text}\n${url}`); toast('已複製連結'); }
  };
  $('#delRt')?.addEventListener('click', async () => { if (!confirm('刪除這條路線？')) return; await api(`/routes/${r.id}`, { method: 'DELETE' }); routeLayer.clearLayers(); toast('已刪除'); listPanel(); });
}

export { mapView };
