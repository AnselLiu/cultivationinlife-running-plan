// 測試用的假來源：tests/run.mjs 與 tests/e2e/server.mjs 設 REST_MOCK=1（而且 DEV_LOGIN=1）時，
//   跑者休息站的所有來源都由這裡回應，測試不會連到真的政府主機。格式照實際資料（2026-10-03 抓的樣本）簡化。
//   座標放在測試資料的「大佳河濱公園（9 號水門）」（seed07：25.07358, 121.54011）與「大安森林公園」（seed04：25.03356, 121.53528）附近。

// 狀態：shrink＝直飲臺只剩 1 筆（完整性檢查要擋下）；drop＝直飲臺少 D4、騎跡少「末段補給站」（要停用）；
//   failPage＝騎跡第幾頁的路線檔回 500（測中斷續跑）；change＝臺北公廁的資料變了（測幹部修正不被覆蓋）；
//   big＝租借站回應超過 Worker 來源的 64 KB 上限；kill＝排程拿到這個來源後當成被平台強制中斷（測隔天重試）；hits＝每個網址被抓了幾次
export const state = { shrink: false, drop: false, failPage: 0, change: false, big: false, kill: '', hits: {} };
export function control(q) {
  if (q.has('reset')) Object.assign(state, { shrink: false, drop: false, failPage: 0, change: false, big: false, kill: '', hits: {} });
  for (const k of ['shrink', 'drop', 'change', 'big']) if (q.has(k)) state[k] = q.get(k) === '1';
  if (q.has('kill')) state.kill = /^[a-z]{2,6}$/.test(q.get('kill')) ? q.get('kill') : '';
  if (q.has('failPage')) state.failPage = Number(q.get('failPage')) || 0;
  return { ...state };
}

const imp = { date: '2026-08-14 14:16:26.654690', timezone_type: 3, timezone: 'Asia/Taipei' };
const page = (rows, offset) => JSON.stringify({ result: { limit: 1000, offset, count: rows.length, sort: '', results: offset ? [] : rows.map((r, i) => ({ _id: i + 1, _importdate: imp, ...r })) } });
const fountain = (id, name, lat, lng, hours, status = '正常', url = `https://gismobile.water.gov.taipei:8443/W/S.aspx?SD=${id}`) => ({
  直飲臺編號: id, 轄區分處: '東區', 市別: '臺北市', 場所別: '公園步道', 場所名稱: name, 地址: '臺北市中山區濱江街', 行政區: '中山', 維護單位: '北水處',
  連絡電話: '87335687', 場所開放時間: hours, 設置地點: '近入口', 經度: String(lng), 緯度: String(lat), 狀態: status, 水質及維護資訊網址: url,
  直飲台照片網址: `https://gismobile.water.gov.taipei/WaterMap_drinkImg/${id}.JPG` });
function twd() {
  const all = [
    fountain('D1', '大佳河濱公園 9號水門', 25.0738, 121.5403, '0:00~24:00'),
    fountain('D1', '大佳河濱公園 9號水門', 25.0738, 121.5403, '0:00~24:00'),                 // 重複的編號
    fountain('D2', '大安森林公園 3號門', 25.033, 121.536, '06:00~23:00', '正常', 'http://gismobile.water.gov.taipei/W/S.aspx?SD=D2'),   // 不是 https
    fountain('D3', '大佳河濱公園 暫停', 25.074, 121.541, '0:00~24:00', '暫停'),
    fountain('D4', '遠方直飲臺', 25.1, 121.6, '05:00~22:00'),
    fountain('D5', '市立圖書館', 25.0345, 121.5365, '週二至週六：08:30~21:00；週日、週一：09:00~17:00'),
    fountain('FAR1', '座標在國外', 35.0, 139.0, '0:00~24:00'),
  ];
  if (state.shrink) return all.slice(0, 1);
  return state.drop ? all.filter((r) => r.直飲臺編號 !== 'D4') : all;
}
const toilet = (name, kind, lat, lng, acc = '0', fam = '0') => ({ 行政區: '中山區', 公廁類別: kind, 公廁名稱: name, 公廁地址: `臺北市中山區${name}`, 經度: String(lng), 緯度: String(lat),
  管理單位: '測試管理單位', 座數: '4', 特優級: '0', 優等級: '4', 普通級: '0', '改善級 ': '0', 無障礙廁座數: acc, 親子廁座數: fam, 其他設施: '', 照護床位置: '', 污物盆位置: '' });
const tpt = () => [
  toilet('大佳河濱公園', '公園', 25.07466, 121.54011, '1'),                          // 北邊 120 公尺
  toilet('麥當勞大直店', '連鎖餐飲店', 25.07358, 121.5411),                           // 東邊 100 公尺（店家，權重 1.3）
  toilet('大安森林公園', '公園', 25.033, 121.535, '1', '1'),
  toilet('新生公園', '公園', 25.0705, 121.5325, state.change ? '2' : '0'),            // change：來源多了無障礙廁座
];
const tprv = () => [
  { no: '1', 'administrative district': '中山區', 'riverside park': '大佳河濱公園', location: '9號水門', type: '景觀', remark: '', longitude: '121.5402', latitude: '25.0747', long_twd97: '304500', lat_wd97: '2774150' },
  { no: '2', 'administrative district': '中山區', 'riverside park': '大佳河濱公園', location: '9號水門', type: '無障礙', remark: '', longitude: '121.54022', latitude: '25.07472', long_twd97: '304500', lat_wd97: '2774150' },
  // WGS84 空白，只有 TWD97（要換算成 25.074578, 121.535869）
  { no: '3', 'administrative district': '中山區', 'riverside park': '大佳河濱公園', location: '兒童遊戲區', type: '景觀', remark: '', longitude: '', latitude: '', long_twd97: '304058.4359', lat_wd97: '2774145.154' },
];
const NT = [
  { name: '淡水金色水岸', district: '淡水區', areacode: '65000100', longitude: '121°26\'14.50"E', latitude: ' 25°10\'16.48"N' },
  { name: '座標壞掉', district: '三重區', areacode: '65000200', longitude: 'abc', latitude: 'def' },
];
const BIKE = '假日：08:00~21:00\n(中午不休息)\n(租車服務至20:00止)\n======================\n平日：08:00~21:00\n(12:00-14:00休息)\n(租車服務至20:00止)';
const bike = () => [
  { 名稱: '大佳站', 河濱公園: '大佳站(大佳河濱公園)', 位置: '濱江街八號疏散門旁', 營業時間: BIKE, 電話: '0977-320525', 服務資訊: 'http://www.ukan.com.tw/About', 租借費率: 'http://www.ukan.com.tw/About',
    緯度twd97: '2774100', 經度twd97: '304300', 緯度wgs84: '25.0736', 經度wgs84: '121.5379' },
  { 名稱: '彩虹站', 河濱公園: '彩虹站(彩虹河濱公園)', 位置: '麥帥一橋右岸下', 營業時間: '假日：08:00~18:00\n(中午不休息)\n(租車服務至17:00止)\n======================\n平日：平日不開放',
    電話: '0977-320530', 服務資訊: '', 租借費率: '', 緯度twd97: '', 經度twd97: '', 緯度wgs84: '25.053028', 經度wgs84: '121.57375' },
  // 營運商列為假日站，但開放資料仍寫平日時段（真實資料的寫法）：只能主張假日有開
  { 名稱: '木柵站', 河濱公園: '木柵站(道南左岸河濱公園)', 位置: '動物園前方道南河濱公園廣場上', 營業時間: BIKE, 電話: '0977-320526', 服務資訊: '', 租借費率: '',
    緯度twd97: '', 經度twd97: '', 緯度wgs84: '24.999128', 經度wgs84: '121.579964' },
];
const CPC_XML = `<?xml version="1.0" encoding="utf-8"?>
<Dataset>
  <Table><站代號>D9001</站代號><站名>新生站</站名><郵遞區號>106</郵遞區號><地址>臺北市大安區新生南路一段</地址><電話>(02)23456789</電話><提供服務時段>00:00-24:00</提供服務時段></Table>
  <Table><站代號>D9002</站代號><站名>濱江站</站名><郵遞區號>104</郵遞區號><地址>台北市中山區濱江街</地址><電話>(02)25551234</電話><提供服務時段>07:00-21:00</提供服務時段></Table>
  <Table><站代號>D9003</站代號><站名>對不到站點</站名><郵遞區號>104</郵遞區號><地址>臺北市中山區</地址><電話>(02)25550000</電話><提供服務時段>07:00-21:00</提供服務時段></Table>
</Dataset>`;
const CPC_STN = [
  { 站代號: 'D9001', 類別: '自營站', 站名: '新生', 縣市: '臺北市', 地址: '新生南路一段', 電話: '(02)23456789', 營業中: '1', 經度: 121.5329, 緯度: 25.0352, 營業時間: '00:00-24:00' },
  { 站代號: 'D9002', 類別: '自營站', 站名: '濱江', 縣市: '臺北市', 地址: '濱江街', 電話: '(02)25551234', 營業中: '1', 經度: 121.5455, 緯度: 25.0712, 營業時間: '07:00-21:00' },
];
// 臺灣騎跡：25 條環島挑戰路線（每頁 10 條 → 3 頁），另有 2 條地區休閒（不收）
const ROUTES = Array.from({ length: 25 }, (_, i) => `9100000000${String(i + 1).padStart(2, '0')}`);
const TB_INDEX = [...ROUTES.map((id, i) => ({ name: `環測-${i + 1}`, id, grades: '環島挑戰' })), { name: '地區-1', id: '920000000001', grades: '地區休閒' }, { name: '地區-2', id: '920000000002', grades: '地區休閒' }];
const rest = (Name, Lat, Lng, Service) => ({ Type: 'REST', SubType: '', Name, Lng, Lat, Service, Url: '', City: '', ImageUrl: '' });
function route(i) {
  const data = [rest(`補給站${i}`, 23.5 + i * 0.01, 120.5, '廁所,飲水')];
  if (i === 1 || i === 25) data.push(rest('共用補給站', 23.4, 120.4, '廁所,無障礙廁所,飲水,維修'));   // 兩條路線都有：要合併成一筆
  if (i === 2) data.push(rest('7-ELEVEN 測試門市', 23.41, 120.41, '廁所,飲水,餐飲'));
  // 真實資料的超商寫法（「7-11瑞權門市」「OK大溪中華店」）、只有廁所飲水的派出所（不算買得到補給）、付費淋浴
  if (i === 3) data.push(rest('7-11測試門市', 23.42, 120.42, '廁所,飲水'));
  if (i === 4) data.push(rest('OK測試中華店', 23.43, 120.43, '廁所'));
  if (i === 5) data.push(rest('測試派出所', 23.44, 120.44, '廁所,飲水,急救箱'));
  if (i === 6) data.push(rest('測試單車驛站', 23.45, 120.45, '廁所,淋浴(付費)'));
  if (i === 25 && !state.drop) data.push(rest('末段補給站', 23.3, 120.3, '廁所'));
  return JSON.stringify({ type: 'route', info: {}, local: [{ Type: 'BIKE', Data: [] }, { Type: 'REST', Data: data }] });
}
// 全國運動場館 CSV：管理人姓名與電話欄位有值，解析時不能讀進來
const SAV_HEAD = '縣市,行政區,場館名稱,場館分類,場館隸屬機關,場館實際管理人姓名,場館實際管理人電話,場館官方網站,場館隸屬機關屬性,地址,緯度,經度,設施項目,開放情形,開放時間,租借資訊,開放及休館時間補充說明,停車場種類,運動場館介紹,舉辦賽事經歷,賽事經歷說明,場館啟用年,總運動空間面積_平方公尺';
const NSC = '國民運動中心（名稱具有運動中心）', SINGLE = '單一功能型運動場館（非前三項運動場館型態，且運動場館 僅含一項運動設施）';
const sav = (name, fac, attr, open, lat, lng, note = 'NULL', web = 'https://example.gov.tw/') => ['63000', '大安區', name, fac, '臺北市政府', '王小明', '02-2345-6789', web, attr,
  `臺北市大安區${name}`, String(lat), String(lng), fac, open, '一二三四五六日', '開放對外場地租借', note, '一般停車場', '"介紹文字，有逗號,也有""引號""\n和換行"', '未曾舉辦', 'NULL', '100', '100'].join(',');
const SAV = [SAV_HEAD,
  sav('臺北市大安運動中心', '室內溫水游泳池', NSC, '付費對外開放使用', 25.033, 121.537, '"開放時間: 06:00~22:00 休館時間：除夕、初一休館，洽詢 (02)2377-0300"'),
  sav('臺北市大安運動中心', '健身房', NSC, '付費對外開放使用', 25.033, 121.537),
  sav('臺北市大安運動中心', '羽球場', NSC, '付費對外開放使用', 25.033, 121.537),
  sav('測試市立游泳池', '室外游泳池', SINGLE, '免費對外開放使用', 25.076, 121.542),
  sav('不開放的游泳池', '室內游泳池', SINGLE, '不對外開放使用', 25.034, 121.535),
  // 補充說明裡的時間多半是「不開放」的時段（真實資料的寫法）：不能變成開放時間
  sav('測試國中游泳池', '室內游泳池', SINGLE, '付費對外開放使用', 25.101, 121.601, '除寒暑假外，平日08:30~17:30為學生游泳課時間，故不對外開放。'),
  sav('測試國民運動中心', '健身房', NSC, '付費對外開放使用', 25.103, 121.603, '"開放時間: 06:00~22:00"'),
  sav('測試國民運動中心', '游泳池(館)', NSC, '付費對外開放使用', 25.103, 121.603, '每日10：00~10：30清場，除夕及初一休館不對外開放。'),
  sav('測試籃球場', '籃球場', SINGLE, '免費對外開放使用', 25.034, 121.535),
].join('\r\n');

const json = (v) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
export function fetchMock(url) {
  state.hits[url] = (state.hits[url] || 0) + 1;
  const u = new URL(url), off = Number(u.searchParams.get('offset')) || 0;
  if (u.hostname === 'data.taipei') {
    const rid = u.pathname.split('/').pop();
    if (rid.startsWith('181097e0')) return json(page(twd(), off));
    if (rid.startsWith('9e0e6ad4')) return json(page(tpt(), off));
    if (rid.startsWith('4b33aa03')) return json(page(tprv(), off));
    if (rid.startsWith('22a8d6c4')) return json(state.big ? page(Array.from({ length: 200 }, (_, i) => ({ ...bike()[0], 名稱: `大站${i}`, 位置: '很長的位置描述'.repeat(20) })), off) : page(bike(), off));
  }
  if (u.hostname === 'data.ntpc.gov.tw') return json(NT);
  if (u.hostname === 'vipmbr.cpc.com.tw') return u.pathname.includes('Accessibletoilets') ? new Response(CPC_XML, { headers: { 'content-type': 'text/xml' } }) : json(CPC_STN);
  if (u.hostname === 'taiwanbike.tw') {
    if (u.pathname.endsWith('/bikeRoute.json')) return json(TB_INDEX);
    const i = ROUTES.indexOf(u.pathname.split('/').pop().replace(/\.json$/, '')) + 1;
    if (!i) return new Response('Request Rejected', { status: 404 });
    if (state.failPage && Math.ceil(i / 10) === state.failPage) return new Response('error', { status: 500 });
    return json(route(i));
  }
  if (u.hostname === 'ws.sports.gov.tw') return new Response(SAV, { headers: { 'content-type': 'application/vnd.ms-excel', 'last-modified': 'Sat, 08 Aug 2026 11:32:21 GMT' } });
  return new Response('not found', { status: 404 });
}
