// 耕跑團 PWA — reststops.js：練跑地圖的「跑者休息站」圖層（飲水、廁所、淋浴置物、補給）
//   開關收在右上「底圖」選單裡（預設關閉，記在這台裝置），不另外加浮動按鈕；打開後地圖上方出現類型 chip（可以多選）
//   地圖針：22 px 灰色圓點＋白色線條圖示，點擊範圍 44×44；放在獨立的圖層，不跟練跑地點合併成同一顆；縮放 16 級以上不合併
//   資料：縮放 13 級以上才抓，一次最多 16 格（每格 0.02 度、約 2 公里）；伺服器只收到格子代碼，不收位置；「離我多遠」在手機上算
//   地點卡：「附近休息站」每類最近 2 處（伺服器算好，離線時用上次的資料）；點了打開休息站卡（同一個抽屜）
//   幹部（權限同地點管理）：官方資料可以修正、補充說明、隱藏；自己新增的可以整筆修改或刪除，選位置的方式跟新增地點一樣
//   功能開關 features.rest 預設關閉；關閉時這裡什麼都不顯示、也不連線
import { api, cfg, esc, IC, openSheet, toast } from './app.js';
import { hoursNow, parseHours } from './hours.js';

// 線條圖示（跟地點針同一個 24×24、圓頭線條風格）
const RGLYPH = {
  water: '<path d="M12 3.6s-5.8 6.4-5.8 10.6a5.8 5.8 0 0 0 11.6 0C17.8 10 12 3.6 12 3.6Z"/><path d="M9.3 14.6a2.8 2.8 0 0 0 2.4 2.6"/>',
  toilet: '<path d="M6.5 3.8h5.2v6.6H6.5Z"/><path d="M5 10.4h14a7 7 0 0 1-5.4 6.8l.6 3H9.4l.6-3.1A7 7 0 0 1 5 10.4Z"/>',
  shower: '<path d="M5.2 20.5V8.2a3.7 3.7 0 0 1 7.4 0v.6"/><path d="M8.8 12.2a3.8 3.8 0 0 1 7.6 0Z"/><path d="M10.2 15.4l-.5 1.4M12.6 15.6v1.6M15 15.4l.5 1.4M11.2 19.2l-.3.9M14 19.2l.3.9"/>',
  supply: '<path d="M5.6 8.6h12.8l-1 11.4H6.6Z"/><path d="M9 8.6V7.2a3 3 0 0 1 6 0v1.4"/>',
  open: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.9"/>',
};
const rglyph = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${RGLYPH[k] || RGLYPH.supply}</svg>`;
const TYPE = { water: '飲水', toilet: '廁所', shower: '淋浴置物', supply: '補給' };
// 地圖 chip 對應的服務位元（跟 src/rest.js 的 GROUPS 一樣）：一處可以同時屬於好幾類
const GROUPS = { water: 1, toilet: 2 | 32, shower: 4 | 8, supply: 16 };
const SUB = {
  water: { fountain: '直飲臺', indoor: '室內飲水機', cool: '涼適點', refill: '加水站', shop: '店家奉茶' },
  toilet: { public: '公廁', river: '河濱廁所', station: '加油站廁所', store: '店家廁所' },
  shower: { center: '運動中心', pool: '游泳池', runbase: '跑站', shop: '跑步用品店', locker: '寄物服務' },
  supply: { store: '超商', vending: '販賣機', kiosk: '輕食站', bike: '自行車租借站', station: '補給站' },
};
const ACCESS = { public: '免費公共', paid: '付費入場', customer: '店家（建議先詢問）', unverified: '待確認' };
// 服務標籤（地點卡、休息站卡）
const SVC = [[1, '飲水'], [2, '廁所'], [4, '淋浴'], [8, '置物櫃'], [16, '補給'], [32, '無障礙'], [64, '親子'], [128, '座位'], [256, '打氣維修'], [512, '24 小時']];
const subOf = (t, s) => SUB[t]?.[s] || TYPE[t] || '';
// 使用說明：依使用方式與細項
function usage(x) {
  const sub = subOf(x.type, x.subtype);
  if (x.access === 'paid') return '付費入場後可用';
  if (x.access === 'unverified') return `${sub}（待確認），請先詢問`;
  if (x.access === 'customer') return x.type === 'toilet' ? '店家廁所，依營業時間，建議先詢問' : x.type === 'water' ? '店家提供，依營業時間，建議先詢問' : '店家，依營業時間，建議先詢問';
  return { fountain: '免費・公共直飲臺', indoor: '免費・室內飲水機', public: '免費・公共廁所', river: '免費・河濱公園廁所', station: x.type === 'toilet' ? '免費・加油站廁所' : '免費・補給站',
    bike: '免費補水與打氣・河濱自行車租借站', locker: '寄物服務' }[x.subtype] || `免費・${sub}`;
}
const MIN_ZOOM = 13, MAX_CELLS = 16, NO_CLUSTER = 16;
const feat = () => cfg.settings?.features?.rest === true;
const cellOf = (lat, lng) => `${Math.floor(lat * 50 + 1e-9)}_${Math.floor(lng * 50 + 1e-9)}`;
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
const hav = (a, b) => { const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const distTxt = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} 公尺` : `${(m / 1000).toFixed(1)} 公里`);
// 開放時間解析一次就記住（同一段文字很多處共用）
const parsed = new Map();
const openOf = (h) => { if (!h) return null; if (!parsed.has(h)) parsed.set(h, parseHours(h)); const p = parsed.get(h); return p ? hoursNow(p) : null; };
const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

// ---- 狀態 ----
let ctx = null, layer = null, meta = null, metaP = null, cur = null, timer = 0, painting = 0, warned = false;
const cells = new Map();     // 格子代碼 → { rev, stops }
const loading = new Map();   // 格子代碼 → Promise
let on = false, types = new Set(), openNow = false;
const readPrefs = () => {
  on = ctx.pref.get('rest', '0') === '1';
  const v = ctx.pref.get('rest-types', '').split(',');
  types = new Set(v.filter((k) => k in TYPE)); openNow = v.includes('open');
};
const savePrefs = () => ctx.pref.set('rest-types', [...types, ...(openNow ? ['open'] : [])].join(','));

// ---- 給 map.js 用的 HTML 片段 ----
// 底圖選單裡的項目（分隔線、圖層開關、資料來源；幹部多一個新增）
export const menuHtml = () => (feat() ? `<div class="msep" role="separator"></div>
  <button role="menuitemcheckbox" id="restTog" aria-checked="false">休息站</button>
  <button role="menuitem" id="restSrc">休息站資料來源</button>
  <button role="menuitem" id="restAdd" hidden>新增休息站</button>` : '');
// 地圖上方的類型 chip（打開圖層才出現）
export const barHtml = () => (feat() ? `<div class="restbar" id="restBar" hidden>
  <div class="restchips" id="restChips" role="group" aria-label="休息站類型">${Object.entries(TYPE).map(([k, v]) => `<button type="button" class="rchip" data-rt="${k}" aria-pressed="false">${rglyph(k)}<span>${v}</span></button>`).join('')}<button type="button" class="rchip" data-rt="open" aria-pressed="false">${rglyph('open')}<span>現在開放</span></button></div>
  <p class="resthint" id="restHint" role="status" hidden>放大地圖看休息站</p></div>` : '');

// ---- 掛到地圖上（map.js 建好地圖後呼叫）----
export function attach(c) {
  ctx = c; cells.clear(); loading.clear(); meta = null; metaP = null; cur = null;
  if (!feat()) return;
  readPrefs();
  layer = c.L.layerGroup().addTo(c.map);
  const tog = document.getElementById('restTog');
  tog?.setAttribute('aria-checked', String(on));
  for (const b of document.querySelectorAll('#restChips [data-rt]')) b.onclick = () => {
    const k = b.dataset.rt;
    if (k === 'open') openNow = !openNow; else types.has(k) ? types.delete(k) : types.add(k);
    savePrefs(); paintChips(); paint();
  };
  paintChips();
  c.map.on('moveend', schedule);
  c.map.on('zoomend', schedule);
  if (on) { show(true); schedule(); }
}
// 底圖選單的項目（map.js 的 closeMenu 關掉選單、焦點回到底圖按鈕）
export function bindMenu(close) {
  const tog = document.getElementById('restTog');
  if (!tog) return;
  tog.onclick = () => { setOn(!on); close(); };
  document.getElementById('restSrc').onclick = () => { close(); sourcesSheet(document.getElementById('baseBtn')); };
  document.getElementById('restAdd').onclick = () => { close(); ctx.startPick((pt) => stopForm(null, pt)); };
}
// 地點資料回來後才知道是不是幹部
export function ready() {
  const add = document.getElementById('restAdd');
  if (add) add.hidden = !ctx?.editor();
}
export function setOn(v) {
  if (!feat() || !ctx) return;
  on = !!v; ctx.pref.set('rest', on ? '1' : '0');
  document.getElementById('restTog')?.setAttribute('aria-checked', String(on));
  show(on);
  if (on) schedule(); else { layer?.clearLayers(); }
}
export const isOn = () => on;
function show(v) {
  const bar = document.getElementById('restBar');
  if (bar) bar.hidden = !v;
  document.getElementById('amap')?.classList.toggle('rest-on', !!v);
  if (v) hint();
}
function paintChips() {
  for (const b of document.querySelectorAll('#restChips [data-rt]')) b.setAttribute('aria-pressed', String(b.dataset.rt === 'open' ? openNow : types.has(b.dataset.rt)));
}
// 縮放不夠：只顯示「放大地圖看休息站」，不抓資料
function hint() {
  const z = ctx.map.getZoom(), low = z < MIN_ZOOM, h = document.getElementById('restHint'), ch = document.getElementById('restChips');
  if (!h || !ch) return low;
  if (h.hidden !== !low) h.hidden = !low;
  ch.hidden = low;
  return low;
}

// ---- 資料 ----
async function getMeta(fresh) {
  if (meta && !fresh) return meta;
  // fresh：幹部剛改過資料，略過瀏覽器快取（meta 有 5 分鐘的 max-age）拿新的版本
  if (!metaP || fresh) metaP = api(`/rest/meta${fresh ? `?t=${Date.now()}` : ''}`).then((m) => (meta = m)).catch((e) => { metaP = null; throw e; });
  return metaP;
}
// 看得到的地圖範圍（扣掉上方列、類型 chip、抽屜或左側面板）裡的格子，離中心近的先抓，最多 16 格
function wanted() {
  const r = ctx.visRect(), m = ctx.map;
  const a = m.containerPointToLatLng([r.x0, r.y1]), b = m.containerPointToLatLng([r.x1, r.y0]);
  const [y0, x0] = cellOf(a.lat, a.lng).split('_').map(Number), [y1, x1] = cellOf(b.lat, b.lng).split('_').map(Number);
  const c = m.containerPointToLatLng([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]), cy = c.lat * 50, cx = c.lng * 50;
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ k: `${y}_${x}`, d: (y + 0.5 - cy) ** 2 + (x + 0.5 - cx) ** 2 });
  return out.sort((p, q) => p.d - q.d).slice(0, MAX_CELLS).map((p) => p.k);
}
function schedule() {
  if (!on || !ctx) return;
  clearTimeout(timer);
  timer = setTimeout(refresh, 180);
}
async function refresh() {
  if (!on || !ctx?.map || !document.getElementById('restBar')) return;
  if (hint()) { layer.clearLayers(); return; }
  paint();
  let m;
  try { m = await getMeta(); } catch (e) {
    if (/找不到/.test(e.message)) { setOn(false); return; }   // 伺服器的功能開關已關閉
    return warn(e);
  }
  const need = wanted().filter((k) => cells.get(k)?.rev !== m.rev && !loading.has(k));
  // 一次最多 4 個請求；一格回來就畫（同一個畫面影格裡合併）
  let i = 0;
  const next = async () => {
    while (i < need.length) {
      const k = need[i++];
      const p = api(`/rest/cell/${k}?v=${m.rev}`).then((r) => { cells.set(k, { rev: m.rev, stops: r.stops || [] }); }).catch(warn).finally(() => loading.delete(k));
      loading.set(k, p);
      await p;
      if (!painting) painting = requestAnimationFrame(() => { painting = 0; paint(); });
    }
  };
  await Promise.all([next(), next(), next(), next()]);
}
function warn(e) { if (!warned) { warned = true; toast(e?.message || '暫時讀不到休息站資料'); } }
// 幹部改過資料：版本會變，重新抓
async function reload() {
  cells.clear();
  try { await getMeta(true); } catch {}
  if (on) refresh();
}
const match = (s) => (!types.size || [...types].some((k) => s[3] & GROUPS[k])) && (!openNow || openOf(s[8])?.open === true);

// ---- 地圖針 ----
const pinHtml = (s, sel) => {
  const o = openOf(s[8]);
  return `<div class="rpin t-${s[1]}${s[4] === 'customer' ? ' cust' : ''}${s[4] === 'unverified' ? ' unv' : ''}${o?.open === false ? ' closed' : ''}${sel ? ' sel' : ''}" data-rid="${esc(s[0])}">${rglyph(s[1])}</div>`;
};
function paint() {
  if (!layer || !ctx?.map) return;
  layer.clearLayers();
  if (!on || ctx.map.getZoom() < MIN_ZOOM) return;
  const m = ctx.map, z = m.getZoom(), L = ctx.L, bounds = m.getBounds().pad(0.1), seen = new Set(), list = [];
  for (const { stops } of cells.values()) for (const s of stops) {
    if (seen.has(s[0]) || !bounds.contains([s[5], s[6]]) || !match(s)) continue;
    seen.add(s[0]); list.push(s);
  }
  // 44 px 的格子分組（跟練跑地點分開）；16 級以上不合併；正在看的那一處不合併
  const groups = new Map();
  for (const s of list) {
    const pt = m.project([s[5], s[6]], z), k = z >= NO_CLUSTER || s[0] === cur?.id ? s[0] : `${Math.floor(pt.x / 44)}_${Math.floor(pt.y / 44)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(s);
  }
  for (const g of groups.values()) {
    if (g.length === 1) {
      const s = g[0], sel = s[0] === cur?.id;
      const icon = L.divIcon({ className: 'rpin-host', iconSize: [44, 44], iconAnchor: [22, 22], html: pinHtml(s, sel) });
      L.marker([s[5], s[6]], { icon, title: `${s[7]}・${subOf(s[1], s[2])}`, keyboard: true, zIndexOffset: sel ? 900 : -500, riseOnHover: true }).addTo(layer)
        .on('click', () => pinClick(s));
      continue;
    }
    const lat = g.reduce((n, s) => n + s[5], 0) / g.length, lng = g.reduce((n, s) => n + s[6], 0) / g.length;
    const icon = L.divIcon({ className: 'rpin-host', iconSize: [44, 44], iconAnchor: [22, 22], html: `<div class="rclus"><b class="num">${g.length}</b></div>` });
    L.marker([lat, lng], { icon, keyboard: true, title: `${g.length} 處休息站，點一下放大`, zIndexOffset: -600 }).addTo(layer)
      .on('click', () => m.fitBounds(L.latLngBounds(g.map((s) => [s[5], s[6]])).pad(0.4), { maxZoom: NO_CLUSTER + 1 }));
  }
}
// 畫路線、選位置時：點到休息站就當成點地圖那個位置（不打開卡片）
function pinClick(s) {
  if (ctx.mode() !== 'browse') return ctx.mapClick([s[5], s[6]]);
  openStop(s[0], { fly: 'pan', opener: null });
}

// ---- 休息站卡（同一個抽屜，半開）----
export const isOpen = () => !!cur;
export function deselect() { if (!cur) return; cur = null; paint(); }
const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>';
const backTo = (from) => (from ? `<button type="button" class="restback" id="restBack">${CHEV_L}<span>回到</span><span translate="no">「${esc(from.name)}」</span></button>` : '');
function credits(x) {
  const lic = x.license && x.license_url ? `<a href="${esc(x.license_url)}" target="_blank" rel="noopener noreferrer">${esc(x.license)}</a>` : '';
  // 顯名整句連到授權條款（整句一個文字節點，英文介面才翻得完整）；顯名裡沒有提到授權的（臺灣騎跡）在後面加授權連結
  let a = esc(x.attribution);
  if (lic && x.attribution.includes(x.license)) a = `<a href="${esc(x.license_url)}" target="_blank" rel="noopener noreferrer">${a}</a>`; else if (lic) a += `（${lic}）`;
  const when = x.source === 'cur' && x.checked_at ? `・最後查證 ${esc(x.checked_at)}` : x.source === 'man' && x.checked_at ? `・最後更新 ${esc(x.checked_at)}` : x.data_date ? `・資料日期 ${esc(x.data_date)}` : '';
  return `${a}${when}`;
}
// 開放時間那一行：看得懂就顯示開放狀態，看不懂只顯示原文；店家、場館沒有時間時寫「依…」
function hoursLine(x) {
  const o = openOf(x.hours), raw = x.hours_raw || (x.hours && !o ? x.hours : '');
  const fallback = x.access === 'customer' ? '依店家營業時間' : x.type === 'shower' && ['center', 'pool'].includes(x.subtype) ? '依場館公告' : '';
  if (!o && !raw && !fallback) return '';
  return `<p class="ohours"><span class="ostat ${o ? (o.open ? 'on' : 'off') : ''}">${o ? esc(o.label) : raw ? '開放時間' : fallback}</span>${o && x.hours ? `<span class="tiny"><span translate="no">${esc(x.hours)}</span></span>` : ''}${raw ? `<span class="tiny"><span translate="no">${esc(raw)}</span></span>` : ''}</p>`;
}
export async function openStop(id, opt = {}) {
  if (!ctx) return;
  const from = opt.from || null;
  let d;
  try { d = await api(`/rest/${encodeURIComponent(id)}`); } catch (e) { toast(e.message); return; }
  const x = d.stop;
  ctx.leave();   // 關掉地點卡的即時影像、取消地點選取
  cur = { id: x.id, from, opener: opt.opener || null, lat: x.lat, lng: x.lng };
  history.replaceState(null, '', `#/map?rest=${encodeURIComponent(x.id)}`);
  if (!opt.keep) ctx.setDetent('half');   // 幹部改完回到卡片：維持原本的高度
  if (opt.fly) ctx.focusOn([x.lat, x.lng], opt.fly === 'pan' ? ctx.map.getZoom() : Math.max(ctx.map.getZoom(), 16), opt.fly);
  if (!on) setOn(true);
  paint();
  const me = ctx.myPos();
  const dist = from ? `<span>從</span><span translate="no">「${esc(from.name)}」</span><span>直線 ${distTxt(hav([from.lat, from.lng], [x.lat, x.lng]))}</span>`
    : me ? `<span>離我直線 ${distTxt(hav(me, [x.lat, x.lng]))}</span>` : '';
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${x.lat},${x.lng}&travelmode=walking`;
  const tags = SVC.filter(([b]) => x.svc & b).map(([, t]) => `<span class="pill">${t}</span>`).join('');
  const e = d.edit;
  ctx.panel().innerHTML = `<section class="card spotcard restcard" aria-labelledby="restName">
      <div class="resthead">${backTo(from)}
      <div class="row spread" style="flex-wrap:nowrap;align-items:flex-start"><div class="row" style="gap:12px;align-items:center;flex-wrap:nowrap;min-width:0">
        <span class="rtile t-${x.type}${x.access === 'customer' ? ' cust' : ''}" aria-hidden="true">${rglyph(x.type)}</span>
        <div style="min-width:0"><span class="tiny">${TYPE[x.type]}・${subOf(x.type, x.subtype)}</span>${e?.hidden ? ' <span class="pill wait">已隱藏</span>' : ''}${e && !e.enabled ? ' <span class="pill wait">來源已停用</span>' : ''}
          <h2 id="restName" tabindex="-1" style="margin:2px 0 0"><span translate="no">${esc(x.name)}</span></h2></div></div>
        <button class="xbtn" id="restClose" aria-label="關閉，回地點清單">${X_SVG}</button></div></div>
      ${hoursLine(x)}
      <p class="restuse">${usage(x)}${x.status === 'paused' ? '・<span class="ostat off">來源標示暫停使用</span>' : ''}</p>
      ${x.place || x.address ? `<p class="tiny" style="margin:0"><span translate="no">${esc([x.place, x.address].filter(Boolean).join('・'))}</span></p>` : ''}
      ${tags ? `<div class="resttags">${tags}</div>` : ''}
      ${x.fee ? `<p style="margin:0"><span class="tiny">收費</span> <span translate="no">${esc(x.fee)}</span></p>` : ''}
      ${x.note ? `<p style="margin:0"><span class="tiny">補充</span> <span translate="no">${esc(x.note)}</span></p>` : ''}
      ${dist ? `<p class="tiny restdist" style="margin:0">${dist}</p>` : ''}
      <div class="row" style="gap:8px"><a class="btn sm" href="${nav}" target="_blank" rel="noopener noreferrer">導航 ${IC.external}</a>${x.ref_url ? `<a class="btn ghost sm" href="${esc(x.ref_url)}" target="_blank" rel="noopener noreferrer">詳細資訊 ${IC.external}</a>` : ''}</div>
      ${d.editor ? `<div class="row restedit" style="gap:8px">${x.manual ? '<button type="button" class="btn ghost sm" id="restEdit">編輯</button><button type="button" class="btn danger sm" id="restDel">刪除</button>'
        : `<button type="button" class="btn ghost sm" id="restFix">修正</button><button type="button" class="btn ghost sm" id="restHide">${e?.hidden ? '取消隱藏' : '隱藏'}</button>${e?.fix ? '<button type="button" class="btn ghost sm" id="restUnfix">還原來源資料</button>' : ''}`}</div>
        ${e?.added_by ? `<p class="tiny" style="margin:0">新增：<span translate="no">${esc(e.added_by)}</span></p>` : ''}${e?.fix ? '<p class="tiny" style="margin:0">幹部修正過，同步時不會被來源資料蓋掉</p>' : ''}` : ''}
      <div class="restcredit">
        <p class="tiny" style="margin:0">${credits(x)}</p>
        ${(d.also || []).map((a) => `<p class="tiny" style="margin:0">${credits(a)}</p>`).join('')}
        <p class="tiny" style="margin:0">資料可能與現況不同，以現場與官方公告為準</p>
      </div>
    </section>`;
  const close = () => { closeStop(); ctx.closeCard(); };
  document.getElementById('restClose').onclick = close;
  document.getElementById('restBack')?.addEventListener('click', () => back());
  document.getElementById('restEdit')?.addEventListener('click', () => stopForm(x, [x.lat, x.lng]));
  document.getElementById('restFix')?.addEventListener('click', () => fixForm(x, d.edit));
  document.getElementById('restDel')?.addEventListener('click', async () => {
    if (!confirm('刪除這個休息站？')) return;
    try { await api(`/rest/${encodeURIComponent(x.id)}`, { method: 'DELETE' }); toast('已刪除'); await reload(); close(); } catch (err) { toast(err.message); }
  });
  document.getElementById('restHide')?.addEventListener('click', async () => {
    const hide = !e?.hidden;
    if (hide && !confirm('隱藏後跑友看不到這一處，同步也不會讓它再出現。確定隱藏？')) return;
    try { await api(`/rest/${encodeURIComponent(x.id)}`, { method: 'PUT', body: { hidden: hide } }); toast(hide ? '已隱藏' : '已取消隱藏'); await reload(); openStop(x.id, { from, keep: true }); } catch (err) { toast(err.message); }
  });
  document.getElementById('restUnfix')?.addEventListener('click', async () => {
    if (!confirm('清掉幹部的修正，改回來源資料？')) return;
    try { await api(`/rest/${encodeURIComponent(x.id)}`, { method: 'PUT', body: { fix: null } }); toast('已還原'); await reload(); openStop(x.id, { from, keep: true }); } catch (err) { toast(err.message); }
  });
  if (opt.focus !== false) document.getElementById('restName')?.focus({ preventScroll: true });
}
// 關掉休息站卡：焦點回到打開它的地方（地圖上的針、地點卡的那一列）
function closeStop() {
  const c = cur;
  cur = null; paint();
  if (!c) return;
  if (c.opener?.isConnected) c.opener.focus();
  else document.querySelector(`.rpin[data-rid="${CSS.escape(c.id)}"]`)?.closest('.leaflet-marker-icon')?.focus();
}
export function close() { const c = cur; closeStop(); return c; }
// 回到地點卡，焦點回到剛才點的那一列
async function back() {
  const c = cur;
  cur = null;
  await ctx.openSpot(c.from.id);
  await nearP;
  paint();
  (document.querySelector(`#restNear [data-rest="${CSS.escape(c.id)}"]`) || document.getElementById('restNearH'))?.focus();
}

// ---- 地點卡的「附近休息站」----
export const nearHtml = () => (feat() ? `<section class="card restnear" id="restNear" aria-labelledby="restNearH" hidden>
    <div class="row spread"><h3 id="restNearH" tabindex="-1">附近休息站</h3><button type="button" class="btn ghost sm" id="restShow" hidden>在地圖上顯示</button></div>
    <div id="restNearBox"><p class="tiny" style="margin:0">載入中…</p></div>
  </section>` : '');
let nearP = null;
export const loadNear = (s, editor) => (nearP = nearLoad(s, editor));
async function nearLoad(s, editor) {
  const card = document.getElementById('restNear'), box = document.getElementById('restNearBox');
  if (!card) return;
  let r;
  try { r = await api(`/spots/${encodeURIComponent(s.id)}/rest`); } catch (e) {
    if (!card.isConnected) return;
    if (/找不到休息站/.test(e.message)) { card.remove(); return; }   // 伺服器的功能開關已關閉
    card.hidden = false;
    box.innerHTML = `<p class="tiny" style="margin:0">${esc(e.message)}</p>`;
    return;
  }
  if (!card.isConnected || ctx.selected() !== s.id) return;
  card.hidden = false;
  const g = r.groups || {}, all = Object.values(g).flat();
  // 地點自己的「飲水」「廁所」說明：當成幹部補充，放在對應的類型下面（上面的說明卡片就不重複列）
  const notes = { water: s.info?.water || '', toilet: s.info?.toilet || '' };
  for (const k of ['water', 'toilet']) if (notes[k]) document.querySelector(`.infochips [data-info="${k}"]`)?.remove();
  if (document.querySelector('.infochips') && !document.querySelector('.infochips > span')) document.querySelector('.infochips').remove();
  const row = (x) => { const o = openOf(x.hours); return `<button type="button" class="rnitem" data-rest="${esc(x.id)}"><span class="rnname">${subOf(x.type, x.subtype)}・<span translate="no">${esc(x.name)}${x.place ? ` ${esc(x.place)}` : ''}</span></span>
      <span class="tiny">${distTxt(x.dist)}${o ? `・<span class="ostat ${o.open ? 'on' : 'off'}">${o.open ? '開放中' : '目前未開放'}</span>` : ''}${x.access === 'customer' ? '・店家' : x.access === 'paid' ? '・付費' : x.access === 'unverified' ? '・待確認' : ''}</span></button>`; };
  box.innerHTML = `<div class="rngroups">${Object.entries(TYPE).map(([k, v]) => `<div class="rng"><span class="rtile t-${k}" aria-hidden="true">${rglyph(k)}</span><div class="rngbody"><b>${v}</b>
      ${(g[k] || []).length ? (g[k] || []).map(row).join('') : '<p class="tiny" style="margin:0">1 公里內沒有資料</p>'}
      ${notes[k] ? `<p class="tiny rnnote" style="margin:0">幹部補充：<span translate="no">${esc(notes[k])}</span></p>` : ''}</div></div>`).join('')}</div>
    <p class="tiny" style="margin:0">直線距離；資料來自政府開放資料與幹部整理，以現場為準</p>
    ${editor ? `<div><button type="button" class="btn ghost sm iconbtn" id="restAddNear">${IC.plus}新增休息站</button></div>` : ''}`;
  const show = document.getElementById('restShow');
  show.hidden = !all.length;
  show.onclick = () => {
    setOn(true);
    ctx.fitVisible([[s.lat, s.lng], ...all.map((x) => [x.lat, x.lng])]);
  };
  for (const b of box.querySelectorAll('[data-rest]')) b.onclick = () => openStop(b.dataset.rest, { from: { id: s.id, name: s.name, lat: s.lat, lng: s.lng }, opener: null, fly: 'pan' });
  document.getElementById('restAddNear')?.addEventListener('click', () => ctx.startPick((pt) => stopForm(null, pt)));
}
// 離線地圖：附近休息站一起先抓（Service Worker 會存起來）
export const prefetchNear = (id) => (feat() ? api(`/spots/${encodeURIComponent(id)}/rest`).catch(() => {}) : null);

// ---- 資料來源清單（地圖選單）----
async function sourcesSheet(opener) {
  let m;
  try { m = await getMeta(true); } catch (e) { toast(e.message); return; }
  const { host } = openSheet('休息站資料來源', `<div class="row spread"><h3 style="margin:0">休息站資料來源</h3><button type="button" class="xbtn" data-close aria-label="關閉">${X_SVG}</button></div>
    <ul class="restsrc">${(m.sources || []).map((x) => `<li><b>${esc(x.source_name)}</b><span class="tiny">${credits(x)}</span>
      ${x.dataset ? `<a class="tiny" href="${esc(x.dataset)}" target="_blank" rel="noopener noreferrer">資料集 ${IC.external}</a>` : ''}</li>`).join('')}</ul>
    <p class="tiny" style="margin:0">查詢休息站時只會送出約 2 公里的格子代碼，不會送出你的位置；離你多遠在這支手機上計算。資料可能與現況不同，以現場與官方公告為準。</p>`, opener);
  host.classList.add('restsheet');
}

// ---- 幹部：新增與整筆修改（整理清單、幹部新增）----
const SVC_FORM = [[1, '飲水'], [2, '廁所'], [4, '淋浴'], [8, '置物櫃'], [16, '買得到補給'], [32, '無障礙廁所'], [64, '親子廁所'], [128, '座位或遮蔭'], [256, '打氣維修'], [512, '24 小時']];
function stopForm(x, pt) {
  const v = x || { type: 'water', subtype: 'fountain', access: 'public', svc: 0 };
  ctx.setDetent('full');
  ctx.panel().innerHTML = `<form class="card" id="rsf">
    <h3>${x ? '編輯休息站' : '新增休息站'}</h3>
    <div class="grid2"><label>名稱<input name="name" maxlength="40" required value="${esc(v.name || '')}" placeholder="例如 大佳河濱公園 9 號水門"></label>
      <label>使用方式<select name="access">${Object.entries(ACCESS).map(([k, t]) => `<option value="${k}" ${v.access === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
    <div class="grid2"><label>類型<select name="type">${Object.entries(TYPE).map(([k, t]) => `<option value="${k}" ${v.type === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>細項<select name="subtype"></select></label></div>
    <div class="row spread"><span class="tiny">位置 <span class="num" id="rsfPt">${pt[0].toFixed(5)}, ${pt[1].toFixed(5)}</span></span><button type="button" class="btn ghost sm" id="rsfPick">重新選位置</button></div>
    <fieldset class="group"><legend>服務</legend><div class="chips">${SVC_FORM.map(([b, t]) => `<label class="chip"><input type="checkbox" name="svc" value="${b}" ${v.svc & b ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div></fieldset>
    <label>開放時間<input name="hours" maxlength="80" value="${esc(v.hours || v.hours_raw || '')}" placeholder="例如 每日 05:00–22:00、週一休館"></label>
    <div class="grid2"><label>位置描述<input name="place" maxlength="60" value="${esc(v.place || '')}" placeholder="例如 近 3 號門"></label>
      <label>收費<input name="fee" maxlength="80" value="${esc(v.fee || '')}" placeholder="例如 寄物一次 20 元"></label></div>
    <label>補充說明<input name="note" maxlength="200" value="${esc(v.note || '')}" placeholder="自己的話，不要貼電話或個人姓名"></label>
    <label>詳細資訊網址<input name="ref_url" type="url" value="${esc(v.ref_url || '')}" placeholder="https://（官網或公告）"></label>
    <div class="row"><button class="btn sm">${x ? '儲存' : '新增'}</button><button type="button" class="btn ghost sm" id="rsfX">取消</button></div>
    <p class="tiny" style="margin:0">開放時間用「每日 06:00–22:00」「平日…；假日…」這類寫法，地圖才判斷得出現在有沒有開；看不懂的寫法只顯示原文。</p></form>`;
  const f = document.getElementById('rsf');
  const subs = () => { const t = f.type.value; f.subtype.innerHTML = Object.entries(SUB[t]).map(([k, s]) => `<option value="${k}" ${v.type === t && v.subtype === k ? 'selected' : ''}>${s}</option>`).join(''); };
  subs(); f.type.onchange = subs;
  let at = pt;
  const mk = ctx.L.circleMarker(at, { radius: 9, color: '#fff', weight: 3, fillColor: '#8E8E93', fillOpacity: 1 }).addTo(ctx.drawLayer);
  ctx.focusOn(at, Math.max(ctx.map.getZoom(), 17));
  document.getElementById('rsfPick').onclick = () => ctx.startPick((p) => { at = p; mk.setLatLng(p); document.getElementById('rsfPt').textContent = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`; });
  const done = () => { ctx.drawLayer.clearLayers(); };
  document.getElementById('rsfX').onclick = () => { done(); x ? openStop(x.id, { keep: true }) : ctx.closeCard(); };
  f.name.focus();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { name: f.name.value.trim(), type: f.type.value, subtype: f.subtype.value, access: f.access.value, lat: at[0], lng: at[1],
      svc: [...f.querySelectorAll('[name=svc]:checked')].reduce((n, c) => n | Number(c.value), 0), hours: f.hours.value.trim(), place: f.place.value.trim(),
      fee: f.fee.value.trim(), note: f.note.value.trim(), ref_url: f.ref_url.value.trim() };
    try {
      const r = x ? await api(`/rest/${encodeURIComponent(x.id)}`, { method: 'PUT', body }) : await api('/rest', { method: 'POST', body });
      done(); toast(x ? '已儲存' : '已新增'); await reload(); setOn(true); openStop(x ? x.id : r.id, { fly: 'pan', keep: true });
    } catch (err) { toast(err.message); }
  };
}
// ---- 幹部：修正官方資料（同步不會蓋掉）----
function fixForm(x, e) {
  const o = e?.original || {}, fx = e?.fix || {};
  ctx.setDetent('full');
  ctx.panel().innerHTML = `<form class="card" id="rff">
    <h3>修正休息站</h3>
    <p class="tiny" style="margin:0">官方資料只修正需要的欄位；留空就用來源的資料。同步時不會蓋掉修正。</p>
    <label>名稱<input name="name" maxlength="40" value="${esc(fx.name || '')}" placeholder="${esc(o.name || '')}"></label>
    <div class="grid2"><label>位置描述<input name="place" maxlength="60" value="${esc(fx.place || '')}" placeholder="${esc(o.place || '例如 在對岸、近 5 號出口')}"></label>
      <label>使用方式<select name="access"><option value="">（跟來源一樣）</option>${Object.entries(ACCESS).map(([k, t]) => `<option value="${k}" ${fx.access === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
    <label>開放時間<input name="hours" maxlength="80" value="${esc(fx.hours || fx.hours_raw || '')}" placeholder="${esc(o.hours || o.hours_raw || '例如 每日 05:00–22:00')}"></label>
    <label>補充說明<input name="note" maxlength="200" value="${esc(x.note || '')}" placeholder="例如 在河的對岸、要從 9 號水門進去"></label>
    <div class="row spread"><span class="tiny">位置 <span class="num" id="rffPt">${x.lat.toFixed(5)}, ${x.lng.toFixed(5)}</span></span><button type="button" class="btn ghost sm" id="rffPick">修正位置</button></div>
    <div class="row"><button class="btn sm">儲存修正</button><button type="button" class="btn ghost sm" id="rffX">取消</button></div></form>`;
  const f = document.getElementById('rff');
  let at = null;
  const mk = ctx.L.circleMarker([x.lat, x.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#8E8E93', fillOpacity: 1 }).addTo(ctx.drawLayer);
  ctx.focusOn([x.lat, x.lng], Math.max(ctx.map.getZoom(), 17));
  document.getElementById('rffPick').onclick = () => ctx.startPick((p) => { at = p; mk.setLatLng(p); document.getElementById('rffPt').textContent = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`; });
  document.getElementById('rffX').onclick = () => { ctx.drawLayer.clearLayers(); openStop(x.id, { keep: true }); };
  f.name.focus();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const fix = {};
    for (const k of ['name', 'place', 'hours']) { const s = f[k].value.trim(); if (s) fix[k] = s; }
    if (f.access.value) fix.access = f.access.value;
    if (at) { fix.lat = at[0]; fix.lng = at[1]; } else if (fx.lat != null) { fix.lat = fx.lat; fix.lng = fx.lng; }
    try {
      await api(`/rest/${encodeURIComponent(x.id)}`, { method: 'PUT', body: { fix: Object.keys(fix).length ? fix : null, note: f.note.value.trim() } });
      ctx.drawLayer.clearLayers(); toast('已儲存修正'); await reload(); openStop(x.id, { fly: 'pan', keep: true });
    } catch (err) { toast(err.message); }
  };
}
