// 耕跑團 PWA — map.js：練跑地圖（用到才載入）
//   地點：田徑場、河濱、公園、山徑…，有說明、一圈距離、照明、飲水、廁所、停車、開放時間；幹部新增，團員提議要審核
//   現場回報：人潮、路況、照明、天氣，24 小時內顯示、不顯示是誰
//   天氣：每個地點的 12 小時預報、空氣品質與跑步建議
//   畫路線：在地圖上點出路線，即時算距離，可以存起來分享、下載 GPX、直接開揪跑
//   底圖：內政部國土測繪中心電子地圖與正射影像（政府資料開放授權）、OpenStreetMap；Leaflet 放在 /vendor（不從外部載入程式）
import { $, api, esc, IC, largeTitle, toast, view } from './app.js';
import * as W from './weather.js';
import { lang } from './i18n.js';

const KIND = { track: '田徑場', river: '河濱', park: '公園', trail: '山徑', road: '道路', other: '其他' };
// 地圖圖釘上的字：中文取類型第一個字，英文用縮寫
const GLYPH = lang === 'en' ? { track: 'T', river: 'R', park: 'P', trail: 'M', road: 'S', other: '·' } : Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, v.slice(0, 1)]));
const INFO = { lap: '一圈', surface: '路面', light: '夜間照明', water: '飲水', toilet: '廁所', parking: '停車', hours: '開放時間' };
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

let map = null, layer = null, spotsLayer = null, routeLayer = null, drawLayer = null, me = null, data = { spots: [], editor: false }, mode = 'browse', draft = [], pickCb = null;

async function mapView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  view.innerHTML = `
    ${largeTitle('練跑地圖', '地點、現場回報、天氣與路線')}
    <div class="seg mapbase" role="group" aria-label="底圖">${Object.entries(BASES).map(([k, v]) => `<button data-base="${k}" aria-pressed="${pref.get('base', 'emap') === k}">${v[0]}</button>`).join('')}</div>
    <section class="mapwrap card">
      <div id="map" role="application" aria-label="練跑地圖"></div>
      <div class="mapfab">
        <button class="fab" id="locBtn" aria-label="移到我的位置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7"/></svg></button>
        <button class="fab" id="drawBtn" aria-label="畫路線"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M6.6 16.6C10 13 8 9.5 12 8.5s4.6-1 5.4-1.2"/></svg></button>
        <button class="fab" id="addBtn" aria-label="${'新增地點'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z"/><path d="M12 7.5v5M9.5 10h5"/></svg></button>
      </div>
      <div class="drawbar" id="drawBar" hidden>
        <span><b class="num" id="drawLen">0.00 公里</b><span class="tiny" id="drawPts">點地圖加上路線的點</span></span>
        <span class="row" style="gap:6px"><button class="btn ghost sm" id="drawUndo">復原</button><button class="btn ghost sm" id="drawLoop">繞回起點</button><button class="btn sm" id="drawDone">完成</button><button class="btn ghost sm" id="drawCancel">取消</button></span>
      </div>
      <div class="drawbar" id="pickBar" hidden><span class="tiny">點地圖選地點的位置</span><button class="btn ghost sm" id="pickCancel">取消</button></div>
    </section>
    <div id="panel"><section class="card"><p class="tiny" style="margin:0">載入中…</p></section></div>`;
  // 這次畫的容器：載入 Leaflet 的期間畫面可能已經換掉（例如背景更新重畫），換掉了就交給新的那次
  const el = $('#map');
  let L;
  try { L = await loadLeaflet(); } catch (e) { if (el.isConnected) $('#panel').innerHTML = `<section class="card"><p class="notice" style="margin:0">${esc(e.message)}</p></section>`; return; }
  if (!el.isConnected) return;
  try { map?.remove(); } catch {}
  map = L.map(el, { zoomControl: false, attributionControl: true, tap: true }).setView(JSON.parse(pref.get('view', '[25.05,121.54,12]')).slice(0, 2), JSON.parse(pref.get('view', '[25.05,121.54,12]'))[2]);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  setBase(pref.get('base', 'emap'));
  spotsLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup().addTo(map); drawLayer = L.layerGroup().addTo(map);
  map.on('moveend', () => { const c = map.getCenter(); pref.set('view', JSON.stringify([+c.lat.toFixed(4), +c.lng.toFixed(4), map.getZoom()])); });
  map.on('click', (e) => onMapClick([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]));
  for (const b of document.querySelectorAll('[data-base]')) b.onclick = () => { setBase(b.dataset.base); for (const x of document.querySelectorAll('[data-base]')) x.setAttribute('aria-pressed', String(x === b)); };
  $('#locBtn').onclick = locate;
  $('#drawBtn').onclick = () => startDraw();
  $('#addBtn').onclick = () => startPick((pt) => spotForm(null, pt));
  $('#drawUndo').onclick = () => { draft.pop(); paintDraft(); };
  $('#drawLoop').onclick = () => { if (draft.length > 1) { draft.push(draft[0]); paintDraft(); } };
  $('#drawCancel').onclick = endDraw;
  $('#drawDone').onclick = () => (draft.length < 2 ? toast('至少點兩個點') : routeForm());
  $('#pickCancel').onclick = endPick;
  await loadSpots();
  if (!el.isConnected) return;
  if (q.get('spot')) openSpot(q.get('spot'), 'jump');
  else if (q.get('route')) showRoute(q.get('route'), 'jump');
  else listPanel();
}

function setBase(k) {
  const b = BASES[k] || BASES.emap;
  if (layer) map.removeLayer(layer);
  layer = window.L.tileLayer(b[1], { maxNativeZoom: b[2], maxZoom: 20, attribution: b[3] }).addTo(map);
  pref.set('base', k);
}
function locate() {
  if (!navigator.geolocation) return toast('這個瀏覽器不能定位');
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    me?.remove();
    me = window.L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#0A84FF', fillOpacity: 1 }).addTo(map);
    map.flyTo(ll, Math.max(map.getZoom(), 15), { duration: 0.6 });
  }, (e) => toast(e.code === 1 ? '請允許定位權限' : '暫時定位不到'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

async function loadSpots() {
  data = await api('/spots');
  spotsLayer.clearLayers();
  for (const s of data.spots) {
    const warn = s.latest && (['積水', '施工', '封閉'].includes(s.latest.surface) || s.latest.crowd === '多');
    const icon = window.L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="pin k-${s.kind} ${s.status !== 'approved' ? 'pending' : ''}"><span>${esc(GLYPH[s.kind] || GLYPH.other)}</span>${s.reports ? `<i class="${warn ? 'warn' : ''}"></i>` : ''}</div>` });
    window.L.marker([s.lat, s.lng], { icon, title: s.name, keyboard: true, alt: s.name }).addTo(spotsLayer)
      .bindTooltip(esc(s.name), { direction: 'right', offset: [14, 0], className: 'pintip' })
      .on('click', () => openSpot(s.id));
  }
}

function onMapClick(pt) {
  if (mode === 'draw') { draft.push(pt); paintDraft(); return; }
  if (mode === 'pick') { const cb = pickCb; endPick(); cb?.(pt); }
}
function startPick(cb) { endDraw(); mode = 'pick'; pickCb = cb; $('#pickBar').hidden = false; $('#map').classList.add('picking'); toast('點地圖選位置'); }
function endPick() { mode = 'browse'; pickCb = null; $('#pickBar').hidden = true; $('#map')?.classList.remove('picking'); }
function startDraw(seed = []) {
  endPick(); mode = 'draw'; draft = [...seed]; routeLayer.clearLayers();
  $('#drawBar').hidden = false; $('#map').classList.add('picking'); paintDraft();
  $('#panel').innerHTML = `<section class="card"><h3>畫路線</h3><p class="tiny" style="margin:0">沿著要跑的路依序點地圖，轉彎處多點幾下比較準。完成後可以存起來分享、下載 GPX，或直接開揪跑。</p></section>`;
}
function endDraw() { mode = 'browse'; draft = []; drawLayer?.clearLayers(); if ($('#drawBar')) $('#drawBar').hidden = true; $('#map')?.classList.remove('picking'); }
function paintDraft() {
  drawLayer.clearLayers();
  if (draft.length) {
    window.L.polyline(draft, { color: '#0A84FF', weight: 5, opacity: 0.9 }).addTo(drawLayer);
    for (const [i, p] of draft.entries()) window.L.circleMarker(p, { radius: i === 0 ? 7 : 4, color: '#fff', weight: 2, fillColor: i === 0 ? '#34C759' : '#0A84FF', fillOpacity: 1 }).addTo(drawLayer);
  }
  $('#drawLen').textContent = km(lenOf(draft));
  $('#drawPts').textContent = draft.length ? `${draft.length} 個點` : '點地圖加上路線的點';
}

// 地點清單（沒選地點時）
async function listPanel() {
  const { routes } = await api('/routes').catch(() => ({ routes: [] }));
  const pend = data.spots.filter((s) => s.status === 'pending');
  $('#panel').innerHTML = `
    ${pend.length && data.editor ? `<section class="card"><h3>待審核的地點</h3><div class="roster">${pend.map((s) => `<button class="r spotrow" data-open="${esc(s.id)}"><span class="pin k-${s.kind} pending small"><span>${esc(GLYPH[s.kind] || GLYPH.other)}</span></span><span><b><span translate="no">${esc(s.name)}</span></b></span><span class="tiny">審核 ›</span></button>`).join('')}</div></section>` : ''}
    <section class="card"><div class="row spread"><h3>練跑地點</h3><span class="tiny">${data.spots.filter((s) => s.status === 'approved').length} 個</span></div>
      ${data.spots.length ? `<div class="roster">${data.spots.filter((s) => s.status === 'approved').map((s) => `<button class="r spotrow" data-open="${esc(s.id)}"><span class="pin k-${s.kind} small"><span>${esc(GLYPH[s.kind] || GLYPH.other)}</span></span>
        <span><b><span translate="no">${esc(s.name)}</span></b><span class="tiny" style="display:block">${KIND[s.kind]}${s.reports ? `・24 小時內 ${s.reports} 則回報${s.latest ? `：${esc(Object.entries(s.latest).filter(([k, v]) => v && k !== 'note').map(([, v]) => v).join('、'))}` : ''}` : ''}</span></span><span class="tiny">›</span></button>`).join('')}</div>`
        : `<p class="muted" style="margin:0">還沒有地點。${data.editor ? '按地圖右上的地標按鈕，在地圖上點位置新增。' : '按地圖右上的地標按鈕，提議一個常跑的地方，幹部審核後就會出現。'}</p>`}
    </section>
    <section class="card"><div class="row spread"><h3>路線</h3><button class="btn ghost sm iconbtn" id="newRoute">${IC.plus}畫一條</button></div>
      ${routes.length ? `<div class="roster">${routes.map((r) => `<button class="r spotrow" data-route="${esc(r.id)}"><span class="av num" style="font-size:11px">${(r.distance / 1000).toFixed(1)}</span><span><b><span translate="no">${esc(r.name)}</span></b><span class="tiny" style="display:block"><span translate="no">${esc(r.author || '')}</span>${r.shared ? '' : '・只有我看得到'}</span></span><span class="tiny">›</span></button>`).join('')}</div>`
        : '<p class="muted" style="margin:0">還沒有路線。畫一條常跑的路線，分享給大家或拿來開揪跑。</p>'}
    </section>`;
  for (const b of document.querySelectorAll('[data-open]')) b.onclick = () => openSpot(b.dataset.open, true);
  for (const b of document.querySelectorAll('[data-route]')) b.onclick = () => showRoute(b.dataset.route, true);
  $('#newRoute').onclick = () => startDraw();
}

// 地點卡片：說明、天氣、現場回報、路線、接下來在這裡的活動
async function openSpot(id, fly) {
  endDraw(); endPick();
  const d = await api(`/spots/${id}`).catch((e) => { toast(e.message); return null; });
  if (!d) return listPanel();
  const s = d.spot;
  history.replaceState(null, '', `#/map?spot=${id}`);
  // 剛打開頁面直接跳過去；在地圖上點選才用飛的
  if (fly === 'jump') map.setView([s.lat, s.lng], Math.max(map.getZoom(), 15), { animate: false });
  else if (fly) map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=walking`;
  $('#panel').innerHTML = `<section class="card spotcard">
      <div class="row spread"><div><span class="pill">${KIND[s.kind]}</span>${s.status === 'pending' ? ' <span class="pill wait">審核中</span>' : ''}<h2 style="margin:6px 0 0"><span translate="no">${esc(s.name)}</span></h2></div>
        <button class="btn ghost sm" id="backList" aria-label="回地點清單">全部</button></div>
      ${s.intro ? `<p class="muted" style="margin:0;white-space:pre-wrap"><span translate="no">${esc(s.intro)}</span></p>` : ''}
      ${Object.keys(s.info || {}).length ? `<div class="infochips">${Object.entries(INFO).filter(([k]) => s.info[k]).map(([k, v]) => `<span><span class="tiny">${v}</span><b>${esc(s.info[k])}</b></span>`).join('')}</div>` : ''}
      <div class="row" style="gap:8px"><a class="btn sm" href="${nav}" target="_blank" rel="noopener">導航 ${IC.external}</a>${s.status === 'approved' ? `<a class="btn ghost sm" href="#/new?spot=${esc(s.id)}">在這裡開揪跑</a>` : ''}
        ${data.editor || (s.mine && s.status === 'pending') ? '<button class="btn ghost sm" id="editSpot">編輯</button>' : ''}</div>
      ${s.status === 'pending' && d.editor ? '<div class="row" style="gap:8px"><button class="btn sm" id="approve">通過</button><button class="btn danger sm" id="reject">不通過</button></div>' : ''}
    </section>
    <section class="card"><h3>天氣</h3><div id="wxBox"><p class="tiny" style="margin:0">載入中…</p></div></section>
    ${s.status === 'approved' ? `<section class="card"><div class="row spread"><h3>現場回報</h3><button class="btn sm" id="repBtn">回報現場</button></div>
      <div id="repForm"></div>
      ${d.reports.length ? `<div class="reports">${d.reports.map((r) => `<div class="rep"><div>${Object.keys(REP).filter((k) => r[k]).map((k) => `<span class="pill ${['積水', '施工', '封閉', '多', '大雨', '沒有'].includes(r[k]) ? 'wait' : ''}">${REP[k][0]} ${esc(r[k])}</span>`).join('')}</div>
        ${r.note ? `<p style="margin:4px 0 0"><span translate="no">${esc(r.note)}</span></p>` : ''}<span class="tiny">${agoShort(r.at)}${r.mine ? '・我' : ''}</span>${r.mine || d.editor ? ` <button class="linkbtn tiny" data-delrep="${esc(r.id)}">刪除</button>` : ''}</div>`).join('')}</div>`
        : '<p class="muted" style="margin:0">24 小時內還沒有人回報。剛跑完？告訴大家現在的狀況。</p>'}
      ${d.week.length ? `<p class="tiny" style="margin:0">最近 7 天共 ${d.week.reduce((n, x) => n + x.n, 0)} 則回報</p>` : ''}</section>` : ''}
    ${d.events.length ? `<section class="card"><h3>接下來在這裡</h3>${d.events.map((e) => `<a class="todayev" href="#/e/${esc(e.id)}">${IC.calendar}<span><b><span translate="no">${esc(e.title)}</span></b><span class="tiny" style="display:block">${esc(e.date)}${e.gather_time ? ` ${esc(e.gather_time)}` : ''}</span></span><span class="tiny">›</span></a>`).join('')}</section>` : ''}
    <section class="card"><div class="row spread"><h3>這裡的路線</h3><button class="btn ghost sm iconbtn" id="drawHere">${IC.plus}畫一條</button></div>
      ${d.routes.length ? `<div class="roster">${d.routes.map((r) => `<button class="r spotrow" data-route="${esc(r.id)}"><span class="av num" style="font-size:11px">${(r.distance / 1000).toFixed(1)}</span><span><b><span translate="no">${esc(r.name)}</span></b></span><span class="tiny">›</span></button>`).join('')}</div>` : '<p class="muted" style="margin:0">還沒有路線。</p>'}</section>`;
  $('#backList').onclick = () => { history.replaceState(null, '', '#/map'); listPanel(); };
  $('#editSpot')?.addEventListener('click', () => spotForm(s, [s.lat, s.lng]));
  for (const [b, ok] of [[$('#approve'), true], [$('#reject'), false]]) b?.addEventListener('click', async () => {
    try { await api(`/spots/${s.id}/review`, { method: 'POST', body: { approve: ok } }); toast(ok ? '已通過' : '已退回'); await loadSpots(); ok ? openSpot(s.id) : listPanel(); } catch (e) { toast(e.message); }
  });
  $('#repBtn')?.addEventListener('click', () => reportForm(s.id));
  for (const b of document.querySelectorAll('[data-delrep]')) b.onclick = async () => { if (!confirm('刪除這則回報？')) return; await api(`/spots/${s.id}/reports/${b.dataset.delrep}`, { method: 'DELETE' }); openSpot(s.id); };
  for (const b of document.querySelectorAll('[data-route]')) b.onclick = () => showRoute(b.dataset.route, true);
  $('#drawHere').onclick = () => { startDraw([[s.lat, s.lng]]); spotForRoute = s.id; };
  W.load(s.lat, s.lng).then((w) => { if ($('#wxBox')) $('#wxBox').innerHTML = W.strip(w); }).catch((e) => { if ($('#wxBox')) $('#wxBox').innerHTML = `<p class="tiny" style="margin:0">${esc(e.message)}</p>`; });
}
const agoShort = (ts) => { const m = Math.round((Date.now() - Date.parse(`${ts.replace(' ', 'T')}Z`)) / 60000); return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : `${Math.round(m / 60)} 小時前`; };
let spotForRoute = null;

function reportForm(id) {
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
  $('#panel').innerHTML = `<form class="card" id="sf">
    <h3>${s ? '編輯地點' : data.editor ? '新增地點' : '提議地點'}</h3>
    ${!s && !data.editor ? '<p class="tiny" style="margin:0">幹部審核通過後，大家就看得到。</p>' : ''}
    <div class="grid2"><label>名稱<input name="name" maxlength="40" required value="${esc(v.name || '')}" placeholder="例如 臺北田徑場"></label>
      <label>類型<select name="kind">${Object.entries(KIND).map(([k, t]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
    <div class="row spread"><span class="tiny">位置 <span class="num" id="ptText">${pt[0].toFixed(5)}, ${pt[1].toFixed(5)}</span></span><button type="button" class="btn ghost sm" id="repick">重新選位置</button></div>
    <label>說明<textarea name="intro" maxlength="600" placeholder="怎麼去、適合什麼課表、要注意什麼">${esc(v.intro || '')}</textarea></label>
    <div class="grid2">${Object.entries(INFO).map(([k, t]) => `<label>${t}<input name="i_${k}" maxlength="60" value="${esc(v.info?.[k] || '')}" placeholder="${{ lap: '400 公尺', surface: 'PU 跑道', light: '有，到 22:00', water: '有飲水機', toilet: '有', parking: '路邊停車', hours: '05:00–22:00' }[k]}"></label>`).join('')}</div>
    <div class="row"><button class="btn sm">${s ? '儲存' : data.editor ? '新增' : '送出提議'}</button><button type="button" class="btn ghost sm" id="sfc">取消</button>
      ${s ? '<button type="button" class="btn danger sm" id="sfd">刪除</button>' : ''}</div></form>`;
  let cur = pt;
  const mk = window.L.circleMarker(cur, { radius: 9, color: '#fff', weight: 3, fillColor: '#FF9F0A', fillOpacity: 1 }).addTo(drawLayer);
  map.flyTo(cur, Math.max(map.getZoom(), 16), { duration: 0.5 });
  $('#repick').onclick = () => startPick((p) => { cur = p; mk.setLatLng(p); $('#ptText').textContent = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`; });
  $('#sfc').onclick = () => { drawLayer.clearLayers(); s ? openSpot(s.id) : listPanel(); };
  $('#sfd')?.addEventListener('click', async () => { if (!confirm('刪除這個地點？回報也會一起刪除。')) return; await api(`/spots/${s.id}`, { method: 'DELETE' }); drawLayer.clearLayers(); toast('已刪除'); await loadSpots(); listPanel(); });
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value, kind: f.kind.value, lat: cur[0], lng: cur[1], intro: f.intro.value, info: Object.fromEntries(Object.keys(INFO).map((k) => [k, f[`i_${k}`].value.trim()])) };
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
  endDraw();
  const { route: r } = await api(`/routes/${id}`).catch((e) => { toast(e.message); return {}; });
  if (!r) return listPanel();
  history.replaceState(null, '', `#/map?route=${id}`);
  routeLayer.clearLayers();
  const line = window.L.polyline(r.points, { color: '#0A84FF', weight: 5, opacity: 0.9 }).addTo(routeLayer);
  window.L.circleMarker(r.points[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#34C759', fillOpacity: 1 }).addTo(routeLayer);
  window.L.circleMarker(r.points[r.points.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#FF3B30', fillOpacity: 1 }).addTo(routeLayer);
  if (fly) map.fitBounds(line.getBounds(), { padding: [30, 30], animate: fly !== 'jump' });
  $('#panel').innerHTML = `<section class="card"><div class="row spread"><div><span class="pill">路線</span><h2 style="margin:6px 0 0"><span translate="no">${esc(r.name)}</span></h2></div><button class="btn ghost sm" id="backList">全部</button></div>
    <div class="lstats"><span><b class="num">${(r.distance / 1000).toFixed(2)}</b> 公里</span><span>${r.points.length} 個點</span>${r.shared ? '' : '<span>只有我看得到</span>'}</div>
    <div class="row" style="gap:8px"><a class="btn sm" href="#/new?route=${esc(r.id)}${r.spot_id ? `&spot=${esc(r.spot_id)}` : ''}">用這條路線開揪跑</a><button class="btn ghost sm" id="gpxBtn">下載 GPX</button>
      <button class="btn ghost sm" id="shareRt">分享</button>${r.mine || data.editor ? '<button class="btn danger sm" id="delRt">刪除</button>' : ''}</div>
    <p class="tiny" style="margin:0">GPX 可以匯入 Garmin Connect、COROS、Strava 的路線功能，跑的時候在手錶上導航。</p></section>`;
  $('#backList').onclick = () => { routeLayer.clearLayers(); history.replaceState(null, '', '#/map'); listPanel(); };
  $('#gpxBtn').onclick = () => downloadGpx(r.name, r.points);
  $('#shareRt').onclick = async () => {
    const url = `${location.origin}/#/map?route=${r.id}`, text = `耕跑團路線：${r.name}（${(r.distance / 1000).toFixed(1)} 公里）`;
    if (navigator.share) { try { await navigator.share({ title: r.name, text, url }); } catch {} } else { await navigator.clipboard?.writeText(`${text}\n${url}`); toast('已複製連結'); }
  };
  $('#delRt')?.addEventListener('click', async () => { if (!confirm('刪除這條路線？')) return; await api(`/routes/${r.id}`, { method: 'DELETE' }); routeLayer.clearLayers(); toast('已刪除'); listPanel(); });
}

export { mapView };
