// 跑者休息站：飲水、廁所、淋浴置物、補給（政府開放資料定期同步，加上幹部整理與新增的清單）
//   第一批來源（都不需要金鑰）：
//     twd  臺北市所屬直飲臺（data.gov.tw 128640）       tpt  臺北市公廁點位（138798）
//     tprv 臺北市河濱廁所（143903）                      ntrv 新北市河濱公園景觀廁所（124796，度分秒座標）
//     tpbk 臺北市河濱自行車租借站（143894，免費飲水）     cpct 中油獨立無障礙公廁（59744，座標用 6065 站點清單對）
//     sav  全國運動場館（22849：國民運動中心＋對外開放的游泳池；不收管理人姓名與電話）
//     tbk  臺灣騎跡補給站（taiwanbike.tw 前端 JSON，依政府網站資料開放宣告使用並顯名；分頁同步）
//     cur  幹部整理清單（migration 0041）              man  幹部在地圖上新增
//   原則：來源主機白名單寫在程式碼裡（只收 https、預設埠）；同步只寫有變的列；幹部的 fix、note、hidden 同步不會動；
//   不存任何電話與個人姓名；顯名文字放在登錄表，不存在每一列。整個功能由 settings.features 的 rest 控制，預設關閉。
import { parseHours } from '../public/hours.js';
import * as Mock from './rest-mock.js';

const UA = 'cil-run rest-stop sync (+https://cil-run.anselliu7.workers.dev)';
const LICENSE = '政府資料開放授權條款第1版';
const LICENSE_URL = 'https://data.gov.tw/license';
const gov = (provider) => `資料來源：${provider}，依政府資料開放授權條款第1版提供`;
const TP = (rid, offset = 0) => `https://data.taipei/api/v1/dataset/${rid}?scope=resourceAquire&limit=1000&offset=${offset}`;
const MB = 1024 * 1024;
export const ALLOWED_HOURS = [1, 2, 6];   // 台北時間：避開 03:00 備份與清理、04–05 點的攝影機同步

// 來源登錄表：網址、解析、主機白名單、顯名、節奏（hour 最早幾點跑；every 每天／每週／每月）、radius（null＝全收；第二批的環境部、Cool map 才用）
//   local：在電腦上同步（tools/rest-sync.mjs 產生 SQL，再用 wrangler 寫進 D1），Worker 的排程與「立即同步」都不跑。
//     Workers 免費方案每次執行只有 10 ms CPU、50 個子請求（D1 查詢也算）：大檔或多檔的來源第一次解析就超過
//     （2026-10-03 在開發機實測冷啟動的解析＋清理：直飲臺 680 KB 11.6 ms、臺北公廁兩頁 14 ms、中油 XML＋1.3 MB JSON 13 ms，
//      運動場館 10 MB CSV、騎跡 49 個路線檔更多）；留在 Worker 的三個都在 4 ms 以內（河濱廁所 3.8、租借站 2.8、新北河濱 2.0）
export const SOURCES = {
  twd: {
    name: '臺北市直飲臺', provider: '臺北自來水事業處', license: LICENSE, attribution: gov('臺北自來水事業處'),
    dataset: 'https://data.gov.tw/dataset/128640', url: [TP('181097e0-c171-4bcd-ad41-c7b55dbc616e')], parse: parseTwd,
    hosts: [/^data\.taipei$/], hour: 1, every: 'day', radius: null, local: true,
  },
  tpt: {
    name: '臺北市公廁', provider: '臺北市政府環境保護局', license: LICENSE, attribution: gov('臺北市政府環境保護局'),
    dataset: 'https://data.gov.tw/dataset/138798',
    url: [TP('9e0e6ad4-b9f9-4810-8551-0cffd1b915b3'), TP('9e0e6ad4-b9f9-4810-8551-0cffd1b915b3', 1000)], parse: parseTpt,
    hosts: [/^data\.taipei$/], hour: 1, every: 'week', radius: null, local: true,
  },
  tprv: {
    name: '臺北市河濱廁所', provider: '臺北市政府工務局水利工程處', license: LICENSE, attribution: gov('臺北市政府工務局水利工程處'),
    dataset: 'https://data.gov.tw/dataset/143903', url: [TP('4b33aa03-cf03-459d-888b-865ee7ea16db')], parse: parseTprv,
    hosts: [/^data\.taipei$/], hour: 1, every: 'week', radius: null,
  },
  tpbk: {
    name: '臺北市河濱自行車租借站', provider: '臺北市政府工務局水利工程處', license: LICENSE, attribution: gov('臺北市政府工務局水利工程處'),
    dataset: 'https://data.gov.tw/dataset/143894', url: [TP('22a8d6c4-54c3-4ca9-b12e-9b827f2c0ca3')], parse: parseTpbk,
    hosts: [/^data\.taipei$/], hour: 2, every: 'week', radius: null,
  },
  cpct: {
    name: '中油加油站無障礙公廁', provider: '台灣中油股份有限公司', license: LICENSE, attribution: gov('台灣中油股份有限公司'),
    dataset: 'https://data.gov.tw/dataset/59744',
    url: ['https://vipmbr.cpc.com.tw/CPCSTN/Accessibletoilets.asmx/getAccessibletoiletsData_XML', 'https://vipmbr.cpc.com.tw/opendata/getstationinfo'],
    max: 4 * MB, parse: parseCpct, hosts: [/^vipmbr\.cpc\.com\.tw$/], hour: 2, every: 'week', radius: null, local: true,
  },
  ntrv: {
    name: '新北市河濱景觀廁所', provider: '新北市政府水利局', license: LICENSE, attribution: gov('新北市政府水利局'),
    dataset: 'https://data.gov.tw/dataset/124796', url: ['https://data.ntpc.gov.tw/api/datasets/ef526dd1-a39c-4186-8905-3ac4726051b5/json?page=0&size=1000'],
    parse: parseNtrv, hosts: [/^data\.ntpc\.gov\.tw$/], hour: 6, every: 'month', radius: null,
  },
  sav: {
    name: '全國運動場館', provider: '運動部', license: LICENSE, attribution: gov('運動部'),
    dataset: 'https://data.gov.tw/dataset/22849', url: ['https://ws.sports.gov.tw/FS01/FilePath/1/relfile/164/10269/5a511d68-e6b8-42ee-a449-acc395135268.csv'],
    max: 16 * MB, parse: parseSav, hosts: [/^ws\.sports\.gov\.tw$/], hour: 6, every: 'month', radius: null, local: true,
  },
  // 分頁來源：一次處理 per 條路線，跑完一整輪才停用消失的列（免費方案改在電腦上一次跑完全部頁數）
  tbk: {
    name: '臺灣騎跡補給站', provider: '交通部 臺灣騎跡', license: '政府網站資料開放宣告', license_url: 'https://taiwanbike.tw/gov', attribution: '資料來源：交通部 臺灣騎跡',
    dataset: 'https://taiwanbike.tw/bikeRoute/search', pages: { index: 'https://taiwanbike.tw/data/zh/bikeRoute.json', list: tbkRoutes, url: tbkRouteUrl, per: 10, gap: 500 },
    max: 8 * MB, parse: parseTbk, hosts: [/^taiwanbike\.tw$/], hour: 2, every: 'month', radius: null, local: true,
  },
  cur: { name: '幹部整理清單', provider: '耕跑團', license: '', attribution: '資料整理：耕跑團', manual: true, hosts: [] },
  man: { name: '幹部新增', provider: '耕跑團', license: '', attribution: '資料整理：耕跑團幹部', manual: true, hosts: [] },
};

// ---- 欄位白名單 ----
export const TYPES = ['water', 'toilet', 'shower', 'supply'];
export const SUBTYPES = {
  water: ['fountain', 'indoor', 'cool', 'refill', 'shop'],
  toilet: ['public', 'river', 'station', 'store'],
  shower: ['center', 'pool', 'runbase', 'shop', 'locker'],
  supply: ['store', 'vending', 'kiosk', 'bike', 'station'],
};
export const ACCESS = ['public', 'paid', 'customer', 'unverified'];
// svc 位元：1 飲水｜2 廁所｜4 淋浴｜8 置物｜16 補給｜32 無障礙廁所｜64 親子｜128 座位遮蔭冷氣｜256 打氣維修｜512 24 小時
export const SVC = { water: 1, toilet: 2, shower: 4, locker: 8, supply: 16, accessible: 32, family: 64, seat: 128, repair: 256, allday: 512 };
export const SVC_ALL = 1023;
// 地圖 chip 對應的位元（一處可以同時屬於好幾類）
export const GROUPS = { water: 1, toilet: 2 | 32, shower: 4 | 8, supply: 16 };
// 每個主要類型至少有的服務位元（幹部新增時沒勾也會帶上）
const BASE_SVC = { water: 1, toilet: 2, shower: 0, supply: 16 };

const MAX = 4 * MB;
// 測試模式（REST_MOCK=1 而且 DEV_LOGIN=1）：所有來源都用假資料，不連外
export const mocked = (env) => env?.REST_MOCK === '1' && env?.DEV_LOGIN === '1';
const restFetch = (env, url, init) => (mocked(env) ? Promise.resolve(Mock.fetchMock(url)) : fetch(url, init));
export const mockControl = (q) => Mock.control(q);

// ---- 小工具 ----
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const num = (v) => { const n = Number(String(v ?? '').replace(/\s+/g, '')); return String(v ?? '').trim() && Number.isFinite(n) ? n : NaN; };
const r6 = (n) => Math.round(n * 1e6) / 1e6;
export const inTaiwan = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= 21.8 && lat <= 26.4 && lng >= 118.1 && lng <= 122.1;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const city = (s) => { const m = String(s || '').replace(/^台/, '臺').match(/^(..[縣市])/); return m ? m[1].replace(/^台/, '臺') : null; };
// 電話一律不存：來源的文字欄位（位置描述、開放時間原文）先拿掉看起來像電話的片段
const PHONE = /(?<![\d:.])(?:\(0\d{1,3}\)|0\d{1,3})[\s-]?\d{3,4}[\s-]?\d{3,4}(?:\s*#\s*\d+)?(?![\d:：])|(?<![\d:.])09\d{2}-?\d{3}-?\d{3}(?![\d:：])/g;
export const hasPhone = (s) => { PHONE.lastIndex = 0; const r = PHONE.test(String(s ?? '')); PHONE.lastIndex = 0; return r; };
export const noPhone = (s) => String(s ?? '').replace(PHONE, '').replace(/(電話|TEL|Tel|tel)[:：]?\s*(?=$|[，,；;。\s])/g, '').replace(/\s+/g, ' ').trim();
export const sourceOf = (k) => (typeof k === 'string' && Object.hasOwn(SOURCES, k) ? SOURCES[k] : null);
// 0.02 度一格：floor(lat/0.02)_floor(lng/0.02)，例如 1252_6077（加一點點避免浮點誤差把 25.04 算成 1251）
export const cellOf = (lat, lng) => `${Math.floor(lat * 50 + 1e-9)}_${Math.floor(lng * 50 + 1e-9)}`;
export const CELL_RE = /^\d{3,4}_\d{4,5}$/;
// 白名單：https、沒有帳密、預設埠、主機在該來源的清單裡
export const hostOk = (source, u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && x.port === '' && (sourceOf(source)?.hosts || []).some((re) => re.test(x.hostname)); } catch { return false; }
};
// 外連網址（來源給的水質頁、官網）：只收 https、不能有帳密；北水處水質頁只在 8443 埠，所以外連允許指定埠
export const linkOk = (u, max = 300) => {
  try {
    const s = String(u || '').trim();
    const x = new URL(s);
    return x.protocol === 'https:' && !x.username && !x.password && /\.[a-z]{2,}$/i.test(x.hostname) && s.length <= max && !/[\s<>"']/.test(s) ? s : '';
  } catch { return ''; }
};
export const featureOn = (raw) => { try { return JSON.parse(raw || '{}')?.rest === true; } catch { return false; } };

// ---- 座標轉換 ----
// 度分秒「121°26'14.50"E」→ 十進位；南緯、西經是負的（反正會被臺灣範圍檢查擋掉）
export function dms(s) {
  const t = String(s ?? '').trim();
  const m = t.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  if (!m) return NaN;
  const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  return /[SW]\s*$/i.test(t) ? -v : v;
}
// TWD97 TM2（中央經線 121 度）→ WGS84（GRS80 與 WGS84 在這個精度下可視為相同）
export function twd97(x, y) {
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const a = 6378137, f = 1 / 298.257222101, b = a * (1 - f), k0 = 0.9999, lng0 = 121 * Math.PI / 180, dx = 250000;
  const e2 = 1 - (b * b) / (a * a), e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const fp = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const ep2 = e2 / (1 - e2), C1 = ep2 * Math.cos(fp) ** 2, T1 = Math.tan(fp) ** 2;
  const R1 = a * (1 - e2) / (1 - e2 * Math.sin(fp) ** 2) ** 1.5, N1 = a / Math.sqrt(1 - e2 * Math.sin(fp) ** 2), D = (x - dx) / (N1 * k0);
  const lat = fp - (N1 * Math.tan(fp) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lng = lng0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(fp);
  return { lat: lat * 180 / Math.PI, lng: lng * 180 / Math.PI };
}
// WGS84 優先；壞掉或不在臺灣才改用 TWD97（例如關渡輕食的 TWD97 是壞值，所以不能反過來）
function pickCoord(lat, lng, x97, y97) {
  const la = num(lat), lo = num(lng);
  if (inTaiwan(la, lo)) return { lat: la, lng: lo };
  const t = twd97(num(x97), num(y97));
  return t && inTaiwan(t.lat, t.lng) ? t : { lat: NaN, lng: NaN };
}

// ---- 開放時間：整理成 public/hours.js 看得懂的標準寫法；看不懂就不填 hours，只留原文 ----
const TIME_RANGE = /(\d{1,2})[:：](\d{2})(?:[:：]\d{2})?\s*[~～\-–—至到]\s*(\d{1,2})[:：](\d{2})(?:[:：]\d{2})?/g;
const pad = (h) => String(Number(h)).padStart(2, '0');
export const normTimes = (s) => String(s ?? '').replace(TIME_RANGE, (_, a, b, c, d) => `${pad(a)}:${b}–${pad(c)}:${d}`);
const ALL_DAY = /^\s*0?0[:：]00\s*[~～\-–—至到]\s*24[:：]00\s*$|^\s*24\s*(小時|H)\s*$/i;
const ALLDAY_TEXT = '24 小時';
// 標準寫法要 parseHours 解析得出才收；原文最多 120 字，只顯示
function hoursOf(std, raw) {
  const s = std ? String(std).trim() : '';
  const r = clip(noPhone(raw), 120);
  if (s && s.length <= 80 && parseHours(s)) return { hours: s, hours_raw: r && normTimes(r) !== s ? r : null };
  return { hours: null, hours_raw: r || null };
}
const WD = '日一二三四五六';
// 「一二三四五」這類星期清單 → 「週一至週五」「每日」「週六、週日」
function daysText(s) {
  const set = [...new Set([...String(s || '')].filter((c) => WD.includes(c)).map((c) => WD.indexOf(c)))].sort();
  if (!set.length || set.length === 7) return set.length ? '每日' : '';
  const order = set.map((d) => (d + 6) % 7).sort((a, b) => a - b).map((d) => (d + 1) % 7);   // 週一開頭排序
  const contiguous = order.every((d, i) => i === 0 || d === (order[i - 1] + 1) % 7);
  const w = (d) => `週${WD[d]}`;
  return contiguous && order.length > 2 ? `${w(order[0])}至${w(order[order.length - 1])}` : order.map(w).join('、');
}

// ---- 解析：每個來源回傳「原始列」，再由 finalize 統一清理 ----
// data.taipei v1 JSON：多頁合併，筆數要對得上 count（避免分頁上限改變時悄悄漏資料）
function taipei(texts, meta) {
  const all = [];
  let count = null;
  for (const t of texts) {
    const j = JSON.parse(t);
    if (!j?.result || !Array.isArray(j.result.results)) throw new Error('清單格式不對');
    count = Number(j.result.count);
    all.push(...j.result.results);
  }
  if (Number.isFinite(count) && all.length < count) throw new Error('資料不完整（分頁不夠）');
  // 資料日期：取各列匯入時間的最大值
  const d = all.map((r) => String(r?._importdate?.date || '').slice(0, 10)).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort().pop();
  if (d) meta.date = d;
  return all;
}
// 欄位名稱用「|」串成一個字串再拆開（中文欄名不是介面文字，不用翻譯）
const [TW_ID, TW_NAME, TW_PLACE, TW_ADDR, TW_CITY, TW_HOURS, TW_LNG, TW_LAT, TW_STATUS, TW_URL, TW_OK, TW_PAUSE] =
  '直飲臺編號|場所名稱|設置地點|地址|市別|場所開放時間|經度|緯度|狀態|水質及維護資訊網址|正常|暫停'.split('|');
function parseTwd(texts, meta) {
  return taipei(texts, meta).map((r) => {
    const st = clip(r[TW_STATUS], 10);
    if (st !== TW_OK && st !== TW_PAUSE) return null;        // 只收正常與暫停（暫停的顯示成 paused，不出現在地圖上）
    const raw = clip(r[TW_HOURS], 120), all = ALL_DAY.test(raw);
    return { sid: r[TW_ID], type: 'water', subtype: 'fountain', svc: SVC.water | (all ? SVC.allday : 0), access: 'public',
      name: r[TW_NAME], place: r[TW_PLACE], address: r[TW_ADDR], city: r[TW_CITY], lat: num(r[TW_LAT]), lng: num(r[TW_LNG]),
      ...hoursOf(all ? ALLDAY_TEXT : normTimes(raw), all ? '' : raw), ref_url: r[TW_URL], status: st === TW_PAUSE ? 'paused' : 'ok' };
  });
}
const [TT_NAME, TT_ADDR, TT_KIND, TT_LNG, TT_LAT, TT_ACC, TT_FAM, TT_DIST] = '公廁名稱|公廁地址|公廁類別|經度|緯度|無障礙廁座數|親子廁座數|行政區'.split('|');
// 連鎖餐飲、量販、加油站的廁所：店家廁所（建議先詢問）
const TPT_STORE = /連鎖餐飲|綜合零售|加油站|超商|便利商店/;
function parseTpt(texts, meta) {
  return taipei(texts, meta).map((r) => {
    const store = TPT_STORE.test(String(r[TT_KIND] || ''));
    return { sid: fnv(`${clip(r[TT_NAME], 60)}|${clip(r[TT_ADDR], 100)}`), type: 'toilet', subtype: store ? 'store' : 'public',
      svc: SVC.toilet | (Number(r[TT_ACC]) > 0 ? SVC.accessible : 0) | (Number(r[TT_FAM]) > 0 ? SVC.family : 0), access: store ? 'customer' : 'public',
      name: r[TT_NAME], address: r[TT_ADDR], city: city(r[TT_ADDR]) || '臺北市', lat: num(r[TT_LAT]), lng: num(r[TT_LNG]) };
  });
}
// 河濱廁所一列一間：依「公園＋位置描述」合併成一處，座標取平均，有無障礙就加旗標
const ACCESSIBLE = /無障礙/;
function parseTprv(texts, meta) {
  const groups = new Map();
  for (const r of taipei(texts, meta)) {
    const park = clip(r['riverside park'], 40), loc = clip(r.location, 60);
    const c = pickCoord(r.latitude, r.longitude, r.long_twd97, r.lat_wd97 ?? r.lat_twd97);
    if (!park || !inTaiwan(c.lat, c.lng)) continue;
    const k = `${park}|${loc}`, g = groups.get(k) || { park, loc, lat: 0, lng: 0, n: 0, acc: false };
    g.lat += c.lat; g.lng += c.lng; g.n += 1; g.acc ||= ACCESSIBLE.test(String(r.type || ''));
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ sid: fnv(`${g.park}|${g.loc}`), type: 'toilet', subtype: 'river', svc: SVC.toilet | (g.acc ? SVC.accessible : 0),
    access: 'public', name: g.park, place: g.loc, city: '臺北市', lat: g.lat / g.n, lng: g.lng / g.n }));
}
function parseNtrv(texts) {
  const list = JSON.parse(texts[0]);
  if (!Array.isArray(list)) throw new Error('清單格式不對');
  return list.map((r) => ({ sid: fnv(`${clip(r.name, 60)}|${clip(r.district, 10)}`), type: 'toilet', subtype: 'river', svc: SVC.toilet, access: 'public',
    name: r.name, place: r.district, city: '新北市', lat: dms(r.latitude), lng: dms(r.longitude) }));
}
// 河濱租借站：營業時間原文是「假日：08:00~21:00 (中午不休息) ====== 平日：08:00~21:00 (12:00-14:00休息)」，
//   整理成「平日 08:00–12:00、14:00–21:00；假日 08:00–21:00」；平日不開放就只寫假日
const [BK_NAME, BK_PARK, BK_PLACE, BK_HOURS, BK_LAT, BK_LNG, BK_Y97, BK_X97, BK_WEEKDAY, BK_WEEKEND] =
  '名稱|河濱公園|位置|營業時間|緯度wgs84|經度wgs84|緯度twd97|經度twd97|平日|假日'.split('|');
const BREAK = /(\d{1,2}[:：]\d{2})\s*[-~～–]\s*(\d{1,2}[:：]\d{2})\s*休息/;
const RENTAL_ONLY = /租車[^)）]*止/;
export function bikeHours(text) {
  const out = {};
  for (const block of String(text || '').split(/={3,}/)) {
    const label = block.includes(BK_WEEKDAY) ? 'wd' : block.includes(BK_WEEKEND) ? 'we' : null;
    if (!label) continue;
    // 只看「平日：」「假日：」後面的時間（括號裡的租車截止時間不算營業時間）
    const main = block.replace(/[（(][^）)]*[）)]/g, (m) => (BREAK.test(m) || RENTAL_ONLY.test(m) ? ' ' : m));
    const m = [...normTimes(main).matchAll(/(\d{2}:\d{2})–(\d{2}:\d{2})/g)][0];
    if (!m) { out[label] = null; continue; }
    const br = block.match(BREAK);
    if (br) {
      const [b1, b2] = normTimes(`${br[1]}–${br[2]}`).split('–');
      out[label] = b1 > m[1] && b2 < m[2] ? `${m[1]}–${b1}、${b2}–${m[2]}` : `${m[1]}–${m[2]}`;
    } else out[label] = `${m[1]}–${m[2]}`;
  }
  if (!out.wd && !out.we) return null;
  if (out.wd && out.we) return `${BK_WEEKDAY} ${out.wd}；${BK_WEEKEND} ${out.we}`;
  return out.we ? `${BK_WEEKEND} ${out.we}` : `${BK_WEEKDAY} ${out.wd}`;
}
function parseTpbk(texts, meta) {
  return taipei(texts, meta).map((r) => {
    const c = pickCoord(r[BK_LAT], r[BK_LNG], r[BK_X97], r[BK_Y97]);
    const raw = String(r[BK_HOURS] || '').replace(/={3,}/g, '／').replace(/\s*\n\s*/g, ' ');
    // 營運商公告提供免費飲水、打氣與簡易維修；不寫 AED（查不到來源）
    return { sid: fnv(clip(r[BK_NAME], 40)), type: 'supply', subtype: 'bike', svc: SVC.water | SVC.supply | SVC.repair, access: 'public',
      name: r[BK_NAME], place: clip(r[BK_PARK], 40) || null, address: clip(r[BK_PLACE], 100), city: '臺北市', lat: c.lat, lng: c.lng,
      ...hoursOf(bikeHours(r[BK_HOURS]), raw) };
  });
}
// 中油：無障礙公廁 XML（站代號、站名、地址、服務時段）＋站點 JSON（經緯度、營業中）；電話欄位不讀
const [CP_ID, CP_NAME, CP_ADDR, CP_HOURS, CP_LNG, CP_LAT, CP_OPEN, CP_BRAND] = '站代號|站名|地址|提供服務時段|經度|緯度|營業中|中油'.split('|');
const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
function xmlTables(text) {
  const out = [];
  let i = 0;
  for (;;) {
    const a = text.indexOf('<Table', i);
    if (a < 0) break;
    const b = text.indexOf('</Table>', a);
    if (b < 0) break;
    const seg = text.slice(a, b), o = {};
    for (const m of seg.matchAll(/<([^\s<>/]+)>([^<]*)<\/\1>/g)) o[m[1]] = unxml(m[2]).trim();
    out.push(o);
    i = b + 8;
  }
  return out;
}
function parseCpct(texts) {
  const toilets = xmlTables(texts[0]);
  if (!toilets.length && !/<Dataset/.test(texts[0])) throw new Error('清單格式不對');
  const stations = JSON.parse(texts[1]);
  if (!Array.isArray(stations)) throw new Error('站點清單格式不對');
  const st = new Map(stations.map((s) => [String(s[CP_ID] || '').trim(), s]));
  return toilets.map((t) => {
    const s = st.get(String(t[CP_ID] || '').trim());
    if (!s || String(s[CP_OPEN] ?? '1') === '0') return null;     // 對不到站點或已停止營業
    const raw = clip(t[CP_HOURS], 60), all = ALL_DAY.test(raw);
    return { sid: t[CP_ID], type: 'toilet', subtype: 'station', svc: SVC.toilet | SVC.accessible | (all ? SVC.allday : 0), access: 'public',
      name: `${CP_BRAND}${clip(t[CP_NAME], 30)}`, address: t[CP_ADDR], city: city(t[CP_ADDR]), lat: num(s[CP_LAT]), lng: num(s[CP_LNG]),
      ...hoursOf(all ? ALLDAY_TEXT : normTimes(raw), all ? '' : raw) };
  });
}
// 全國運動場館 CSV（約 10 MB，一個設施一列）：國民運動中心（前綴比對）＋對外開放的游泳池，依「名稱＋地址」合併成場館
//   「場館實際管理人姓名」「場館實際管理人電話」在這裡就不讀（只取需要的欄位索引）
export function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const CITY_CODE = { 63000: '臺北市', 64000: '高雄市', 65000: '新北市', 66000: '臺中市', 67000: '臺南市', 68000: '桃園市', 10002: '宜蘭縣', 10004: '新竹縣',
  10005: '苗栗縣', 10007: '彰化縣', 10008: '南投縣', 10009: '雲林縣', 10010: '嘉義縣', 10013: '屏東縣', 10014: '臺東縣', 10015: '花蓮縣', 10016: '澎湖縣',
  10017: '基隆市', 10018: '新竹市', 10020: '嘉義市', 9007: '連江縣', 9020: '金門縣' };
const [SV_CITY, SV_NAME, SV_ATTR, SV_ADDR, SV_LAT, SV_LNG, SV_FAC, SV_OPEN, SV_DAYS, SV_NOTE, SV_WEB, SV_PAID, SV_CLOSED, SV_NULL, SV_NONE] =
  '縣市|場館名稱|場館隸屬機關屬性|地址|緯度|經度|設施項目|開放情形|開放時間|開放及休館時間補充說明|場館官方網站|付費|不對外開放使用|NULL|無'.split('|');
const NSC = /^國民運動中心/, POOL = /游泳/;
function parseSav(texts) {
  const rows = parseCsv(texts[0]);
  const head = rows.shift() || [];
  const ix = Object.fromEntries([SV_CITY, SV_NAME, SV_ATTR, SV_ADDR, SV_LAT, SV_LNG, SV_FAC, SV_OPEN, SV_DAYS, SV_NOTE, SV_WEB].map((k) => [k, head.findIndex((h) => h.trim() === k)]));
  if (Object.values(ix).some((i) => i < 0)) throw new Error('欄位名稱改了');
  const venues = new Map();
  for (const r of rows) {
    const g = (k) => String(r[ix[k]] ?? '').trim();
    const attr = g(SV_ATTR), open = g(SV_OPEN), nsc = NSC.test(attr), pool = POOL.test(g(SV_FAC));
    if ((!nsc && !pool) || open === SV_CLOSED || !open || open === SV_NULL) continue;
    const name = g(SV_NAME).replace(/委由.*$|委託.*經營$/, '').trim(), addr = g(SV_ADDR), k = `${name}|${addr}`;
    const v = venues.get(k) || { name, addr, nsc: false, pool: false, paid: false, city: CITY_CODE[Number(g(SV_CITY))] || city(addr), lat: num(g(SV_LAT)), lng: num(g(SV_LNG)), days: g(SV_DAYS), note: g(SV_NOTE), web: g(SV_WEB) };
    v.nsc ||= nsc; v.pool ||= pool; v.paid ||= open.includes(SV_PAID);
    if (!v.note || v.note === SV_NULL) v.note = g(SV_NOTE);
    venues.set(k, v);
  }
  return [...venues.values()].map((v) => {
    const note = v.note === SV_NULL || v.note === SV_NONE ? '' : v.note;
    // 時間只在補充說明剛好寫了一段時間、而且沒有提到星期時才整理（其他寫法太多樣，留給畫面顯示「依場館公告」）
    const times = [...normTimes(note).matchAll(/(\d{2}:\d{2})–(\d{2}:\d{2})/g)];
    const days = daysText(v.days);
    const std = times.length === 1 && days && !/週|星期|假日/.test(note) ? `${days} ${times[0][1]}–${times[0][2]}` : null;
    return { sid: fnv(`${v.name}|${v.addr}`), type: 'shower', subtype: v.nsc ? 'center' : 'pool',
      svc: v.nsc ? SVC.water | SVC.toilet | SVC.shower | SVC.locker : SVC.toilet | SVC.shower, access: v.paid ? 'paid' : 'public',
      name: v.name, address: v.addr, city: v.city, lat: v.lat, lng: v.lng, ...hoursOf(std, note), ref_url: v.web };
  });
}
// 臺灣騎跡：路線索引裡「環島挑戰」「多元路線」的路線檔，local[] 中 Type=REST 那一組是補給站
const TBK_GRADE = /^(環島挑戰|多元路線)$/;
function tbkRoutes(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('路線索引格式不對');
  return list.filter((r) => TBK_GRADE.test(String(r.grades || '')) && /^\d{6,16}$/.test(String(r.id || ''))).map((r) => String(r.id));
}
function tbkRouteUrl(id) { return /^\d{6,16}$/.test(id) ? `https://taiwanbike.tw/data/zh/bikeRoute/${id}.json` : null; }
const [TB_WC, TB_AWC, TB_WATER, TB_FOOD, TB_FIX, TB_SHOWER] = '廁所|無障礙廁所|飲水|餐飲|維修|淋浴'.split('|');
const STORE_NAME = /7-?ELEVEN|統一超商|全家|萊爾富|OK\s*(超商|便利|mart)|便利商店|超商/i;
function parseTbk(texts) {
  const out = [];
  for (const t of texts) {
    const j = JSON.parse(t);
    const rest = (Array.isArray(j?.local) ? j.local : []).filter((x) => x?.Type === 'REST').flatMap((x) => (Array.isArray(x.Data) ? x.Data : []));
    for (const r of rest) {
      const sv = new Set(String(r.Service || '').split(/[,，、]/).map((s) => s.trim()));
      const lat = num(r.Lat), lng = num(r.Lng), name = clip(r.Name, 60);
      const svc = SVC.supply | (sv.has(TB_WC) ? SVC.toilet : 0) | (sv.has(TB_AWC) ? SVC.toilet | SVC.accessible : 0) | (sv.has(TB_WATER) ? SVC.water : 0)
        | (sv.has(TB_FIX) ? SVC.repair : 0) | (sv.has(TB_SHOWER) ? SVC.shower : 0) | (sv.has(TB_FOOD) ? SVC.seat : 0);
      out.push({ sid: fnv(`${name}|${lat.toFixed(4)}|${lng.toFixed(4)}`), type: 'supply', subtype: 'station', svc,
        access: STORE_NAME.test(name) ? 'customer' : 'public', name, lat, lng, ref_url: r.Url });
    }
  }
  return out;
}

// ---- 清理：統一欄位、座標檢查、開放時間、雜湊；同一來源裡重複的代碼合併 ----
const RAD = Math.PI / 180;
export const haversine = (a, b) => {
  const x = Math.sin((b.lat - a.lat) * RAD / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin((b.lng - a.lng) * RAD / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
};
// 輸出列只有這些欄位（不會有電話、管理人等來源欄位）
export const ROW_KEYS = ['id', 'type', 'subtype', 'svc', 'access', 'name', 'place', 'address', 'city', 'lat', 'lng', 'cell', 'hours', 'hours_raw', 'ref_url', 'status', 'h'];
export function finalize(source, raws) {
  const out = [], byId = new Map();
  const bad = { skipped: 0, coord: 0, other: 0 };   // skipped＝來源條件不收（例如狀態、對不到站點）；coord＝座標不在臺灣
  for (const x of raws) {
    if (!x) { bad.skipped++; continue; }
    const sid = String(x.sid ?? '').trim();
    const lat = num(x.lat), lng = num(x.lng);
    if (!inTaiwan(lat, lng)) { bad.coord++; continue; }
    const name = clip(noPhone(x.name), 60);
    if (!/^[\w.-]{1,48}$/.test(sid) || !TYPES.includes(x.type) || !SUBTYPES[x.type].includes(x.subtype) || !name) { bad.other++; continue; }
    const r = { id: `${source}:${sid}`, type: x.type, subtype: x.subtype, svc: (Number(x.svc) || 0) & SVC_ALL, access: ACCESS.includes(x.access) ? x.access : 'public',
      name, place: clip(noPhone(x.place), 60) || null, address: clip(noPhone(x.address), 100) || null, city: city(x.city) || city(x.address) || null,
      lat: r6(lat), lng: r6(lng), cell: cellOf(lat, lng), hours: x.hours ?? null, hours_raw: x.hours_raw ?? null,
      ref_url: linkOk(x.ref_url) || null, status: x.status === 'paused' ? 'paused' : 'ok' };
    // 同一來源裡同一個代碼：60 公尺內當同一處（服務旗標合併），太遠就加序號分開
    const prev = byId.get(r.id);
    if (prev) {
      if (haversine(prev, r) <= 60) { prev.svc |= r.svc; continue; }
      let n = 2; while (byId.has(`${r.id}~${n}`)) n++;
      r.id = `${r.id}~${n}`;
    }
    byId.set(r.id, r);
    out.push(r);
  }
  for (const r of out) r.h = fnv(JSON.stringify(ROW_KEYS.slice(1, -1).map((k) => r[k])));
  return { rows: out, dropped: bad.skipped + bad.coord + bad.other, bad };
}

// ---- 抓資料：20 秒逾時、大小上限、只跟同一台主機的 https 轉址（最多一次）、白名單外一律不連 ----
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) { try { await res.body?.cancel(); } catch {} return null; }
  if (!res.body) { const b = new Uint8Array(await res.arrayBuffer()); return b.byteLength > max ? null : b; }
  const reader = res.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch {} return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
const sameHost = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.protocol === 'https:' && x.hostname === y.hostname && x.port === y.port; } catch { return false; } };
// 回 { status, bytes, etag, modified }；304 時 bytes 是 null
export async function fetchBytes(env, source, url, { max = MAX, cond = null } = {}) {
  if (!hostOk(source, url)) throw new Error('來源網址不在白名單');
  const headers = { 'user-agent': UA, accept: 'application/json, application/xml, text/xml, text/csv, */*;q=0.5' };
  if (cond?.e) headers['if-none-match'] = cond.e;
  if (cond?.m) headers['if-modified-since'] = cond.m;
  const init = { redirect: 'manual', signal: AbortSignal.timeout(20000), headers };
  let res = await restFetch(env, url, init);
  const loc = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
  if (loc) {
    try { await res.body?.cancel(); } catch {}
    const next = new URL(loc, url).href;
    if (!sameHost(next, url) || !hostOk(source, next)) throw new Error('來源轉址到別的主機');
    res = await restFetch(env, next, { ...init, signal: AbortSignal.timeout(20000) });
  }
  if (res.status === 304) { try { await res.body?.cancel(); } catch {} return { status: 304, bytes: null }; }
  if (!res.ok) { try { await res.body?.cancel(); } catch {} throw new Error(`來源回應 ${res.status}`); }
  const bytes = await readCapped(res, max);
  if (!bytes) throw new Error('資料太大');
  return { status: 200, bytes, etag: res.headers.get('etag') || null, modified: res.headers.get('last-modified') || null };
}
const hex = async (parts) => {
  const n = parts.reduce((s, p) => s + p.byteLength, 0), all = new Uint8Array(n);
  let o = 0; for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
};
const dateOf = (httpDate) => { const t = Date.parse(httpDate || ''); return Number.isFinite(t) ? new Date(t + 8 * 3600e3).toISOString().slice(0, 10) : null; };
const decode = (b) => new TextDecoder().decode(b);

// 抓＋解析一個非分頁來源（不碰資料庫；tools/rest-check.mjs 也用這個）
//   prev：上次的 { e, m, h }；沒變時回 { same: true }
export async function collect(env, source, prev = null, { raw = false } = {}) {
  const S = sourceOf(source);
  if (!S?.url) throw new Error('這個來源不能同步');
  const single = S.url.length === 1;
  const got = [];
  for (const u of S.url) got.push(await fetchBytes(env, source, u, { max: S.max || MAX, cond: single ? prev : null }));
  if (got[0].status === 304) return { same: true, tag: prev };
  const tag = { e: single ? got[0].etag : null, m: single ? got[0].modified : null, h: await hex(got.map((g) => g.bytes)) };
  if (prev?.h && prev.h === tag.h) return { same: true, tag };
  const meta = {};
  const raws = S.parse(got.map((g) => decode(g.bytes)), meta);
  const { rows, dropped, bad } = finalize(source, raws);
  return { rows, dropped, bad, tag, date: meta.date || dateOf(got[0].modified), texts: raw ? got.map((g) => decode(g.bytes)) : undefined };
}
// 分頁來源的一頁（tbk：一頁＝per 條路線）
export async function collectPage(env, source, page) {
  const S = sourceOf(source);
  if (!S?.pages) throw new Error('這個來源不能同步');
  const idx = await fetchBytes(env, source, S.pages.index, { max: MAX });
  const ids = S.pages.list(decode(idx.bytes));
  if (!ids.length) throw new Error('路線索引是空的');
  const pages = Math.ceil(ids.length / S.pages.per);
  if (page >= pages) page = 0;
  const texts = [];
  for (const id of ids.slice(page * S.pages.per, (page + 1) * S.pages.per)) {
    const u = S.pages.url(id);
    if (!u) continue;
    // 路線檔之間稍微停一下，不要連續猛抓（測試模式不等）
    if (texts.length && S.pages.gap && !mocked(env)) await new Promise((r) => setTimeout(r, S.pages.gap));
    texts.push(decode((await fetchBytes(env, source, u, { max: S.max || MAX })).bytes));
  }
  const { rows, dropped, bad } = finalize(source, S.parse(texts, {}));
  return { rows, dropped, bad, page, pages, date: dateOf(idx.modified) };
}
// 分頁來源一次抓完全部頁數（在電腦上同步用；頁之間停 gap 毫秒）：不同頁的同一處合併服務旗標
export async function collectAll(env, source, { gap = 1000 } = {}) {
  const byId = new Map(), bad = { skipped: 0, coord: 0, other: 0 };
  let date = null, dropped = 0;
  for (let p = 0, pages = 1; p < pages; p++) {
    if (p && gap) await new Promise((r) => setTimeout(r, gap));
    const g = await collectPage(env, source, p);
    pages = g.pages; date = g.date; dropped += g.dropped;
    for (const k of Object.keys(bad)) bad[k] += g.bad[k];
    for (const r of g.rows) { const prev = byId.get(r.id); if (prev) prev.svc |= r.svc; else byId.set(r.id, r); }
  }
  const rows = [...byId.values()];
  for (const r of rows) r.h = fnv(JSON.stringify(ROW_KEYS.slice(1, -1).map((k) => r[k])));
  return { rows, dropped, bad, date };
}

// ---- 同步（寫入 D1）----
export const UPSERT = `INSERT INTO rest_stops (id, source, type, subtype, svc, access, name, place, address, city, lat, lng, cell, hours, hours_raw, ref_url, status, seen_gen, hash)
  SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.type'), json_extract(value, '$.subtype'), json_extract(value, '$.svc'), json_extract(value, '$.access'),
    json_extract(value, '$.name'), json_extract(value, '$.place'), json_extract(value, '$.address'), json_extract(value, '$.city'), json_extract(value, '$.lat'),
    json_extract(value, '$.lng'), json_extract(value, '$.cell'), json_extract(value, '$.hours'), json_extract(value, '$.hours_raw'), json_extract(value, '$.ref_url'),
    json_extract(value, '$.status'), ?3, json_extract(value, '$.h')
  FROM json_each(?2) WHERE true
  ON CONFLICT(id) DO UPDATE SET type = excluded.type, subtype = excluded.subtype, svc = excluded.svc, access = excluded.access, name = excluded.name,
    place = excluded.place, address = excluded.address, city = excluded.city, lat = excluded.lat, lng = excluded.lng,
    cell = CASE WHEN json_extract(rest_stops.fix, '$.lat') IS NULL THEN excluded.cell ELSE rest_stops.cell END,
    hours = excluded.hours, hours_raw = excluded.hours_raw, ref_url = excluded.ref_url,
    status = CASE WHEN rest_stops.status = 'reported' AND excluded.status = 'ok' THEN 'reported' ELSE excluded.status END,
    seen_gen = excluded.seen_gen, hash = excluded.hash, enabled = 1, updated_at = datetime('now')
  WHERE rest_stops.manual = 0 AND (rest_stops.hash IS NOT excluded.hash OR rest_stops.enabled = 0 OR rest_stops.seen_gen IS NOT excluded.seen_gen)`;
// 來源清單不再出現的列：停用（不刪除，幹部的修正留著）
export const DISABLE = `UPDATE rest_stops SET enabled = 0, updated_at = datetime('now')
  WHERE source = ?1 AND manual = 0 AND enabled = 1 AND id NOT IN (SELECT value FROM json_each(?2))`;
const DISABLE_GEN = `UPDATE rest_stops SET enabled = 0, updated_at = datetime('now') WHERE source = ?1 AND manual = 0 AND enabled = 1 AND seen_gen < ?2`;

export const SYNCING = '同步中';
const setError = (env, source, error) => env.DB.prepare("UPDATE rest_sources SET last_sync_at = datetime('now'), last_error = ? WHERE source = ?").bind(error, source).run();
export const markFailed = (env, source, error) => setError(env, source, String(error || '同步失敗').slice(0, 120)).catch(() => {});
const errText = (e) => (e?.name === 'TimeoutError' ? '來源逾時' : String(e?.message || e).slice(0, 120));
const upserts = (env, source, rows, gen) => {
  const out = [];
  for (let i = 0; i < rows.length; i += 400) out.push(env.DB.prepare(UPSERT).bind(source, JSON.stringify(rows.slice(i, i + 400)), gen));
  return out;
};
const changes = (res, n) => res.slice(0, n).reduce((s, r) => s + (r.meta?.changes || 0), 0);
const parseTag = (s) => { try { const o = JSON.parse(s || 'null'); return o && typeof o === 'object' ? o : null; } catch { return null; } };

// 同步一個來源：標成同步中 → 抓 → 沒變就只標成功 → 清理 → 完整性檢查（少於上次 70% 就不寫、不停用）→ 寫有變的列 → 停用消失的列 → rev 加 1
export async function syncSource(env, source) {
  const S = sourceOf(source);
  if (!S || S.manual) return { error: '這個來源不能同步' };
  const src = await env.DB.prepare('SELECT enabled, last_count, etag, cursor, gen FROM rest_sources WHERE source = ?').bind(source).first();
  if (!src?.enabled) return { error: '來源沒有開啟' };   // 關閉的來源不發出任何連線
  await setError(env, source, SYNCING);
  if (S.pages) return syncPaged(env, source, src);
  let got;
  try { got = await collect(env, source, parseTag(src.etag)); } catch (e) { const error = errText(e); await markFailed(env, source, error); return { error }; }
  const ok = (extra = '') => env.DB.prepare(`UPDATE rest_sources SET last_sync_at = datetime('now'), last_ok_at = datetime('now'), last_error = NULL${extra} WHERE source = ?`);
  if (got.same) { await ok().bind(source).run(); return { count: src.last_count || 0, changed: 0, disabled: 0, same: true }; }
  const rows = got.rows;
  let error = null;
  if (!rows.length) error = '清單是空的';
  else if (src.last_count && rows.length < src.last_count * 0.7) error = `筆數從 ${src.last_count} 掉到 ${rows.length}，這次不更新`;
  if (error) { await markFailed(env, source, error); return { error }; }
  const stmts = upserts(env, source, rows, src.gen || 0), nUp = stmts.length;
  stmts.push(env.DB.prepare(DISABLE).bind(source, JSON.stringify(rows.map((r) => r.id))));
  stmts.push(ok(', last_count = ?, etag = ?, data_date = COALESCE(?, data_date)').bind(rows.length, JSON.stringify(got.tag), got.date || null, source));
  let res;
  try { res = await env.DB.batch(stmts); } catch (e) {
    const msg = `寫入資料庫失敗：${String(e?.message || e).slice(0, 80)}`;
    await markFailed(env, source, msg);
    return { error: msg };
  }
  const changed = changes(res, nUp), disabled = res[nUp].meta?.changes || 0;
  if (changed || disabled) await env.DB.prepare('UPDATE rest_sources SET rev = rev + 1 WHERE source = ?').bind(source).run();
  return { count: rows.length, changed, disabled, dropped: got.dropped };
}
// 分頁來源：cursor 是下一頁（NULL＝不在同步中）；新的一輪 gen 加 1；中途失敗 cursor 不動，下次從同一頁續跑
async function syncPaged(env, source, src) {
  const start = src.cursor == null;
  const gen = start ? (src.gen || 0) + 1 : src.gen || 1;
  let got;
  try { got = await collectPage(env, source, start ? 0 : src.cursor); } catch (e) { const error = errText(e); await markFailed(env, source, error); return { error }; }
  const stmts = upserts(env, source, got.rows, gen), nUp = stmts.length;
  const done = got.page + 1 >= got.pages;
  if (!done) stmts.push(env.DB.prepare("UPDATE rest_sources SET cursor = ?, gen = ?, last_sync_at = datetime('now'), last_error = NULL WHERE source = ?").bind(got.page + 1, gen, source));
  let res;
  try { res = await env.DB.batch(stmts); } catch (e) {
    const msg = `寫入資料庫失敗：${String(e?.message || e).slice(0, 80)}`;
    await markFailed(env, source, msg);
    return { error: msg };
  }
  let changed = changes(res, nUp);
  const page = { page: got.page + 1, pages: got.pages };
  if (!done) {
    if (changed) await env.DB.prepare('UPDATE rest_sources SET rev = rev + 1 WHERE source = ?').bind(source).run();
    return { ...page, count: got.rows.length, changed, disabled: 0, done: false };
  }
  // 整輪跑完：這一輪看到的列數做完整性檢查，通過才停用沒看到的列
  const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM rest_stops WHERE source = ? AND seen_gen = ? AND manual = 0').bind(source, gen).first())?.n || 0;
  if (!count || (src.last_count && count < src.last_count * 0.7)) {
    const error = count ? `筆數從 ${src.last_count} 掉到 ${count}，這次不更新` : '清單是空的';
    await env.DB.prepare("UPDATE rest_sources SET cursor = NULL, gen = ?, last_sync_at = datetime('now'), last_error = ? WHERE source = ?").bind(gen, error, source).run();
    if (changed) await env.DB.prepare('UPDATE rest_sources SET rev = rev + 1 WHERE source = ?').bind(source).run();
    return { error };
  }
  const r2 = await env.DB.batch([
    env.DB.prepare(DISABLE_GEN).bind(source, gen),
    env.DB.prepare(`UPDATE rest_sources SET cursor = NULL, gen = ?, last_count = ?, last_sync_at = datetime('now'), last_ok_at = datetime('now'), last_error = NULL,
      data_date = COALESCE(?, data_date) WHERE source = ?`).bind(gen, count, got.date || null, source),
  ]);
  const disabled = r2[0].meta?.changes || 0;
  if (changed || disabled) await env.DB.prepare('UPDATE rest_sources SET rev = rev + 1 WHERE source = ?').bind(source).run();
  return { ...page, count, changed, disabled, done: true };
}

// ---- 讀取 ----
// 幹部修正（fix）在讀取時蓋過來源值
export const FIX_KEYS = ['lat', 'lng', 'name', 'place', 'hours', 'hours_raw', 'note', 'access'];
export function applyFix(r) {
  let f = null;
  try { f = r.fix ? JSON.parse(r.fix) : null; } catch {}
  if (!f || typeof f !== 'object') return r;
  const o = { ...r };
  for (const k of FIX_KEYS) if (Object.hasOwn(f, k)) o[k] = f[k] === '' ? null : f[k];
  return o;
}
// 讀取時合併：同一類、60 公尺內、名稱去掉「男廁、女、無障礙、1F」後相同 → 一筆；優先順序 man > cur > 官方 > 店家，服務旗標取聯集
const RANK = (r) => (r.source === 'man' ? 0 : r.source === 'cur' ? 1 : r.access === 'customer' ? 3 : 2);
export const normName = (s) => String(s || '').toLowerCase().replace(/男廁|女廁|男|女|無障礙|親子|廁所|化妝室|\b[b]?\d+f\b|\d+樓|[\s・·\-－_()（）]/g, '');
export function mergeRows(rows) {
  const sorted = [...rows].sort((a, b) => RANK(a) - RANK(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const keep = [], groups = new Map();
  for (const r of sorted) {
    const k = `${r.type}|${normName(r.name)}`, list = groups.get(k) || [];
    const hit = list.find((x) => haversine(x, r) <= 60);
    if (hit) { hit.svc |= r.svc; if (!hit.also.includes(r.source)) hit.also.push(r.source); continue; }
    const o = { ...r, also: [] };
    list.push(o); groups.set(k, list); keep.push(o);
  }
  return keep;
}
// 啟用中的來源與總版本（各來源 rev 加總，只會增加）：快取 key 跟著換
export async function sourceState(env) {
  const rows = (await env.DB.prepare('SELECT source, enabled, rev, data_date, last_ok_at FROM rest_sources').all()).results.filter((s) => sourceOf(s.source));
  const on = rows.filter((s) => s.enabled);
  return { rows, on: new Set(on.map((s) => s.source)), rev: rows.reduce((n, s) => n + (s.rev || 0), 0) };
}
const LIVE = "enabled = 1 AND hidden = 0 AND status != 'paused'";
const COLS = 'id, source, type, subtype, svc, access, name, place, lat, lng, hours, hours_raw, status, fix, manual';
// box：只取這個範圍內的列（地點附近、詳情的同一處）。臺北市中心 3×3 格約 800 列，框到 1 公里內約 170 列：
//   Worker 少解析八成的列（免費方案每次執行只有 10 ms CPU）；幹部修正過位置的列用修正後的座標
const BOX = " AND COALESCE(json_extract(fix, '$.lat'), lat) BETWEEN ? AND ? AND COALESCE(json_extract(fix, '$.lng'), lng) BETWEEN ? AND ?";
export const boxOf = (p, m) => { const dl = m / 111320, dg = m / (111320 * Math.cos(p.lat * RAD)); return [p.lat - dl, p.lat + dl, p.lng - dg, p.lng + dg]; };
async function cellRows(env, cells, on, box = null) {
  const ph = cells.map(() => '?').join(',');
  const rows = (await env.DB.prepare(`SELECT ${COLS} FROM rest_stops WHERE cell IN (${ph}) AND ${LIVE}${box ? BOX : ''} LIMIT 3000`).bind(...cells, ...(box || [])).all()).results;
  return rows.filter((r) => on.has(r.source)).map(applyFix);
}
const cachePut = (env, key, body, ttl) => {
  const put = globalThis.caches?.default?.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } }));
  if (put) env.ctx?.waitUntil ? env.ctx.waitUntil(put.catch(() => {})) : put.catch(() => {});
};
const cacheGet = async (key) => { try { const hit = await globalThis.caches?.default?.match(key); return hit ? await hit.text() : null; } catch { return null; } };
// 一格的精簡陣列：[id, type, subtype, svc, access, lat, lng, name, hours]，不含停用、隱藏、暫停的列
export async function cellStops(env, key) {
  const st = await sourceState(env);
  const ck = new Request(`https://cil-run.internal/rest/cell/v1/${key}/${st.rev}`);
  const hit = await cacheGet(ck);
  if (hit) return { body: hit, rev: st.rev, hit: true };
  const stops = mergeRows(await cellRows(env, [key], st.on)).map((r) => [r.id, r.type, r.subtype, r.svc, r.access, r.lat, r.lng, r.name, r.hours || null]);
  const body = JSON.stringify({ cell: key, rev: st.rev, stops });
  cachePut(env, ck, body, 86400);
  return { body, rev: st.rev, hit: false };
}
// 地點附近：周圍 3×3 格、1 公里內，每類最多 2 處，用「距離 × 權重」排序
export const NEAR_RADIUS = 1000, PER_GROUP = 2;
export const WEIGHT = { public: 1.0, paid: 1.1, customer: 1.3, unverified: 1.6 };
const weightOf = (r) => (r.status === 'reported' ? 2.0 : WEIGHT[r.access] ?? 1.6);
export async function nearSpot(env, spot) {
  const st = await sourceState(env);
  const ck = new Request(`https://cil-run.internal/rest/spot/v1/${encodeURIComponent(spot.id)}/${spot.lat},${spot.lng}/${st.rev}`);
  const hit = await cacheGet(ck);
  if (hit) return JSON.parse(hit);
  const [cy, cx] = cellOf(spot.lat, spot.lng).split('_').map(Number), cells = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.push(`${cy + dy}_${cx + dx}`);
  const all = mergeRows(await cellRows(env, cells, st.on, boxOf(spot, NEAR_RADIUS + 60))).map((r) => ({ ...r, dist: Math.round(haversine(spot, r)) })).filter((r) => r.dist <= NEAR_RADIUS)
    .map((r) => ({ ...r, score: Math.max(r.dist, 10) * weightOf(r) })).sort((a, b) => a.score - b.score);
  const groups = {};
  for (const [g, bits] of Object.entries(GROUPS)) {
    groups[g] = all.filter((r) => r.svc & bits).slice(0, PER_GROUP).map((r) => ({ id: r.id, type: r.type, subtype: r.subtype, svc: r.svc, access: r.access, status: r.status,
      name: r.name, place: r.place || null, hours: r.hours || null, hours_raw: r.hours_raw || null, lat: r.lat, lng: r.lng, dist: r.dist }));
  }
  const out = { enabled: true, rev: st.rev, radius: NEAR_RADIUS, groups };
  cachePut(env, ck, JSON.stringify(out), 3600);
  return out;
}
// 來源的顯名與授權（詳情卡與「休息站資料來源」清單用）
export const credit = (k, row = {}) => {
  const S = sourceOf(k) || {};
  return { source: k, source_name: S.name || '', provider: S.provider || '', attribution: S.attribution || '', license: S.license || '',
    license_url: S.license ? S.license_url || LICENSE_URL : null, dataset: S.dataset || null, data_date: row.data_date || null, last_ok_at: row.last_ok_at || null };
};
// 詳情：原文時間、收費、補充說明、外連、顯名與資料日期；合併到同一處的其他來源也列出顯名
export async function detail(env, id, editor) {
  const r0 = await env.DB.prepare('SELECT r.*, COALESCE(m.nickname, m.name) AS creator FROM rest_stops r LEFT JOIN members m ON m.id = r.created_by WHERE r.id = ?').bind(id).first();
  if (!r0) return null;
  const st = await sourceState(env);
  const live = r0.enabled && !r0.hidden && st.on.has(r0.source);
  if (!live && !editor) return null;
  const r = applyFix(r0);
  const srow = st.rows.find((s) => s.source === r.source) || {};
  // 同一處的其他來源（同類、60 公尺內、名稱相同）
  const [cy, cx] = cellOf(r.lat, r.lng).split('_').map(Number), cells = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.push(`${cy + dy}_${cx + dx}`);
  const near = (await cellRows(env, cells, st.on, boxOf(r, 80))).filter((x) => x.id !== r.id && x.type === r.type && normName(x.name) === normName(r.name) && haversine(x, r) <= 60);
  const also = [...new Set(near.map((x) => x.source))].filter((k) => k !== r.source).map((k) => credit(k, st.rows.find((s) => s.source === k)));
  const stop = { id: r.id, type: r.type, subtype: r.subtype, svc: near.reduce((n, x) => n | x.svc, r.svc), access: r.access, status: r.status, name: r.name, place: r.place,
    address: r.address, city: r.city, lat: r.lat, lng: r.lng, hours: r.hours || null, hours_raw: r.hours_raw || null, fee: r.fee || null, note: r.note || null,
    ref_url: linkOk(r.ref_url) || null, manual: !!r.manual, checked_at: r.checked_at || null, ...credit(r.source, srow) };
  const out = { stop, also, editor: !!editor };
  if (editor) {
    let fix = null; try { fix = r0.fix ? JSON.parse(r0.fix) : null; } catch {}
    out.edit = { fix, hidden: !!r0.hidden, enabled: !!r0.enabled, source_enabled: st.on.has(r0.source), added_by: r0.creator || null,
      original: { lat: r0.lat, lng: r0.lng, name: r0.name, place: r0.place, hours: r0.hours, hours_raw: r0.hours_raw, access: r0.access } };
  }
  return out;
}

// ---- 幹部輸入的檢查 ----
const coordIn = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? r6(n) : NaN; };
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
// 開放時間：parseHours 看得懂才放 hours，看不懂就只存原文（最多 80 字）
function hoursInput(v) {
  const s = text(v, 200);
  if (s.length > 80) return { error: '開放時間最多 80 字' };
  if (!s) return { hours: null, hours_raw: null };
  const n = normTimes(s);
  return parseHours(n) ? { hours: n, hours_raw: null } : { hours: null, hours_raw: s };
}
// 新增或整筆修改（man、cur）：回 { value } 或 { error }
export function readStop(b) {
  if (!b || typeof b !== 'object') return { error: '資料格式不對' };
  const name = text(b.name);
  if (!name) return { error: '請填名稱' };
  if (name.length > 40) return { error: '名稱最多 40 字' };
  const lat = coordIn(b.lat), lng = coordIn(b.lng);
  if (!inTaiwan(lat, lng)) return { error: '位置要在臺灣' };
  if (!TYPES.includes(b.type)) return { error: '類型不正確' };
  if (!SUBTYPES[b.type].includes(b.subtype)) return { error: '細項不正確' };
  const svc = b.svc === undefined ? 0 : b.svc;
  if (!Number.isInteger(svc) || svc < 0 || svc > SVC_ALL) return { error: '服務項目不正確' };
  const access = b.access === undefined ? 'public' : b.access;
  if (!ACCESS.includes(access)) return { error: '使用方式不正確' };
  const h = hoursInput(b.hours);
  if (h.error) return h;
  const note = text(b.note), fee = text(b.fee), place = text(b.place), address = text(b.address);
  if (note.length > 200) return { error: '補充說明最多 200 字' };
  if (fee.length > 80 || place.length > 60 || address.length > 100) return { error: '欄位太長' };
  // 幹部輸入的網址比照其他欄位：https、一般網域、不帶埠號
  const ref = typeof b.ref_url === 'string' ? b.ref_url.trim() : '';
  if (ref && !(/^https:\/\/[\w.-]+\.[a-z]{2,}(\/[^\s<>"']*)?$/i.test(ref) && ref.length <= 300 && linkOk(ref))) return { error: '詳細資訊網址要是 https:// 開頭' };
  return { value: { name, lat, lng, cell: cellOf(lat, lng), type: b.type, subtype: b.subtype, svc: svc | BASE_SVC[b.type] | (b.type === 'shower' && !(svc & (SVC.shower | SVC.locker)) ? (['locker', 'shop'].includes(b.subtype) ? SVC.locker : SVC.shower) : 0), access, ...h,
    note: noPhone(note) || null, fee: noPhone(fee) || null, place: noPhone(place) || null, address: address || null, city: city(address), ref_url: ref || null } };
}
// 官方資料的修正（fix）：只收白名單欄位；null 表示清掉修正
export function readFix(f) {
  if (f === null) return { value: null };
  if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: '修正格式不對' };
  const out = {};
  if (f.lat !== undefined || f.lng !== undefined) {
    const lat = coordIn(f.lat), lng = coordIn(f.lng);
    if (!inTaiwan(lat, lng)) return { error: '位置要在臺灣' };
    out.lat = lat; out.lng = lng;
  }
  if (f.name !== undefined) { const s = text(f.name); if (!s || s.length > 40) return { error: '名稱要 1–40 字' }; out.name = s; }
  if (f.place !== undefined) { const s = text(f.place); if (s.length > 60) return { error: '位置描述最多 60 字' }; out.place = noPhone(s); }
  if (f.note !== undefined) { const s = text(f.note); if (s.length > 200) return { error: '補充說明最多 200 字' }; out.note = noPhone(s); }
  if (f.access !== undefined) { if (!ACCESS.includes(f.access)) return { error: '使用方式不正確' }; out.access = f.access; }
  if (f.hours !== undefined) {
    const h = hoursInput(f.hours);
    if (h.error) return h;
    out.hours = h.hours || ''; out.hours_raw = h.hours_raw || '';
  }
  return { value: Object.keys(out).length ? out : null };
}
