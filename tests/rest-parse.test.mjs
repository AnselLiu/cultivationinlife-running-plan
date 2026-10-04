// 跑者休息站：來源解析與讀取合併的單元測試（src/rest.js），不需要伺服器、不連外
//   用真實資料的寫法（2026-10-03 抓的樣本）當回歸案例：補充說明裡的「不開放」時段、超商名稱、捷運站的 24 小時、河濱廁所的分群、跨來源同一間廁所
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, finalize, mergeRows, readFix, readStop, closedHint, savHours, STORE_NAME, collect, collectPage, haversine, nearSpots, yes, keyOf, riskyHours, placeName, samePlace } from '../src/rest.js';
import { control } from '../src/rest-mock.js';
import { hoursNow } from '../public/hours.js';

const env = { REST_MOCK: '1', DEV_LOGIN: '1' };
const at = (s) => new Date(`${s}+08:00`);   // 台北時間
const page = (rows) => [JSON.stringify({ result: { limit: 1000, offset: 0, count: rows.length, results: rows } })];
const parse = (k, texts) => finalize(k, SOURCES[k].parse(texts, {})).rows;

test('開放時間：有「不開放」類字樣就只存原文，不會變成反過來的開放時間（幹部輸入與來源都一樣）', () => {
  for (const s of ['08:00~18:00 假日不開放', '08:00~18:00 例假日休息', '08:00~17:00 中午12:00~13:00休息', '08:00~17:00，12:00~13:00休息', '07:00-21:00(12:00-13:00休息)', '06:00–22:00 不對外開放']) {
    assert.ok(closedHint(s), s);
    const h = readFix({ hours: s }).value;
    assert.equal(h.hours, '', `${s} 不能存成 hours`); assert.equal(h.hours_raw, s);
    const v = readStop({ name: '測試', type: 'water', subtype: 'shop', lat: 25.07, lng: 121.54, hours: s }).value;
    assert.equal(v.hours, null); assert.equal(v.hours_raw, s);
  }
  // parseHours 看得懂的休館寫法照常收
  for (const s of ['08:30–21:00（週一及國定假日休館）', '週二至週六 08:30–21:00；週日、週一 09:00–17:00', '每日 05:00–22:00', '05:00–22:00 週一休館']) {
    assert.ok(!closedHint(s), s);
    assert.ok(readFix({ hours: s }).value.hours, `${s} 要收`);
  }
});

test('運動場館：補充說明的時間多半是不開放時段，只有明確寫開放時間的才整理（真實資料的寫法）', () => {
  // 反例：學生游泳課、清場、午休、施工
  for (const note of ['除寒暑假外，平日08:30~17:30為學生游泳課時間，故不對外開放。', '每日10：00~10：30清場，除夕及初一休館不對外開放。', '清場時間：10:00-10:30，暫停售票、入場。',
    '中午12:00~13:30休息 每月第四個禮拜一為場地維護整理時間，停止開放。', '開放5-10月,除暑假外，平日08:30~17:30為學生游泳課時間，故不對外開放。 目前施工中不對外開放',
    '開放時間: 06:00~22:00 清場清潔時間：上午10:00~10:30； 休館時間：除夕、初一休館']) assert.equal(savHours(note, '一二三四五六日'), null, note);
  // 正例
  assert.equal(savHours('開放時間: 06:00~22:00 休館時間：除夕、初一休館及經人事行政局公告之停止上班上課日(時間)', '一二三四五六日'), '每日 06:00–22:00');
  assert.equal(savHours('每日開放6:00-22:00', '一二三四五六日'), '每日 06:00–22:00');
});

test('運動場館（假資料）：游泳課不對外開放、清場時段都不會變成開放時間，原文照樣留著', async () => {
  control(new URLSearchParams('reset=1'));
  const { rows } = await collect(env, 'sav', null);
  const by = (n) => rows.find((r) => r.name === n);
  assert.equal(by('臺北市大安運動中心').hours, '每日 06:00–22:00');
  const school = by('測試國中游泳池');
  assert.equal(school.hours, null); assert.match(school.hours_raw, /游泳課/);
  const nsc = by('測試國民運動中心');
  assert.equal(nsc.hours, null, '以游泳池那一列的補充說明為準（清場），不用健身房那一列'); assert.match(nsc.hours_raw, /清場/);
  assert.equal(hoursNow(nsc.hours, at('2026-10-07T10:15:00')), null, '不判斷，畫面顯示「依場館公告」');
});

test('臺灣騎跡：真實資料的超商名稱是店家；「買得到補給」只給超商與有餐飲的站；付費淋浴也算淋浴', async () => {
  for (const n of ['7-11瑞權門市', '7-ELEVEN 測試門市', 'OK大溪中華店', '全家便利商店', '萊爾富']) assert.ok(STORE_NAME.test(n), n);
  for (const n of ['大溪派出所', '中油加油站', '單車驛站']) assert.ok(!STORE_NAME.test(n), n);
  control(new URLSearchParams('reset=1'));
  const all = [];
  for (let p = 0; p < 3; p++) all.push(...(await collectPage(env, 'tbk', p)).rows);
  const by = (n) => all.find((r) => r.name === n);
  for (const n of ['7-11測試門市', 'OK測試中華店', '7-ELEVEN 測試門市']) { assert.equal(by(n).access, 'customer', n); assert.ok(by(n).svc & 16, `${n} 買得到補給`); }
  const police = by('測試派出所');
  assert.equal(police.access, 'public'); assert.equal(police.svc & 16, 0, '只有廁所飲水不算補給'); assert.ok(police.svc & 1 && police.svc & 2);
  assert.ok(by('測試單車驛站').svc & 4, '「淋浴(付費)」也有淋浴旗標');
  assert.equal(by('7-ELEVEN 測試門市').svc & 128, 0, '餐飲不再當成座位');
});

test('直飲臺：捷運站寫 0:00~24:00 的不當成 24 小時（車站會關門），其他場所照常', () => {
  const f = (id, kind, hours) => ({ 直飲臺編號: id, 場所別: kind, 場所名稱: `測試${id}`, 設置地點: '詢問處旁', 地址: '新北市三重區', 市別: '新北市', 場所開放時間: hours, 經度: '121.49', 緯度: '25.06', 狀態: '正常', 水質及維護資訊網址: '' });
  const rows = parse('twd', page([f('M1', '捷運站', '0:00~24:00'), f('M2', '捷運站', '06:00~23:00'), f('P1', '公園步道', '0:00~24:00')]));
  const by = (id) => rows.find((r) => r.id === `twd:${id}`);
  assert.equal(by('M1').hours, null); assert.equal(by('M1').hours_raw, '0:00~24:00'); assert.equal(by('M1').svc & 512, 0);
  assert.equal(hoursNow(by('M1').hours, at('2026-10-07T03:00:00')), null, '凌晨 3 點不顯示開放中');
  assert.equal(by('M2').hours, '06:00–23:00');
  assert.equal(by('P1').hours, '24 小時'); assert.ok(by('P1').svc & 512);
});

test('河濱廁所：同一個位置描述涵蓋好幾處時依距離分開，針不會落在沒有廁所的地方；只有一處時代碼不變', () => {
  const t = (park, loc, lat, lng, type = '景觀') => ({ 'riverside park': park, location: loc, type, longitude: String(lng), latitude: String(lat), long_twd97: '', lat_wd97: '' });
  // 百齡右岸「體育局球場」：三群相距數百公尺（真實資料是 9 間分在 4 處、約 1.3 公里）
  const raw = [t('百齡右岸河濱公園', '體育局球場', 25.0920, 121.5160), t('百齡右岸河濱公園', '體育局球場', 25.0921, 121.5161, '無障礙'),
    t('百齡右岸河濱公園', '體育局球場', 25.0960, 121.5175), t('百齡右岸河濱公園', '體育局球場', 25.1010, 121.5190), t('大佳河濱公園', '9號水門', 25.0747, 121.5402)];
  const rows = parse('tprv', page(raw));
  const bl = rows.filter((r) => r.name === '百齡右岸河濱公園');
  assert.equal(bl.length, 3, '分成三處');
  for (const r of bl) assert.ok(raw.some((x) => x.location === '體育局球場' && haversine(r, { lat: Number(x.latitude), lng: Number(x.longitude) }) <= 60), `${r.lat},${r.lng} 60 公尺內有廁所`);
  assert.equal(bl.filter((r) => r.svc & 32).length, 1, '無障礙只標在那一處');
  assert.equal(new Set(bl.map((r) => r.id)).size, 3);
  const dj = rows.find((r) => r.name === '大佳河濱公園');
  assert.equal(parse('tprv', page([raw[4]]))[0].id, dj.id, '只有一處：代碼跟以前一樣（幹部修正對得上）');
});

test('河濱租借站：營運商列為假日站的木柵站不主張平日有開（開放資料與營運商不一致）', async () => {
  control(new URLSearchParams('reset=1'));
  const { rows } = await collect(env, 'tpbk', null);
  const mz = rows.find((r) => r.name === '木柵站'), dj = rows.find((r) => r.name === '大佳站');
  assert.equal(mz.hours, '假日 08:00–21:00'); assert.equal(mz.hours_raw, null);
  assert.equal(hoursNow(mz.hours, at('2026-10-07T10:00:00')).open, false, '週三不開');
  assert.equal(hoursNow(mz.hours, at('2026-10-10T10:00:00')).open, true, '週六開');
  assert.equal(dj.hours, '平日 08:00–12:00、14:00–21:00；假日 08:00–21:00');
  assert.equal(rows.find((r) => r.name === '彩虹站').hours, '假日 08:00–18:00');
});

test('Worker 同步的來源有 64 KB 上限：資料意外變大時在下載階段就停，不會解析', async () => {
  for (const k of Object.keys(SOURCES).filter((x) => !SOURCES[x].manual && !SOURCES[x].local)) assert.ok(SOURCES[k].max <= 64 * 1024, `${k} 上限 ${SOURCES[k].max}`);
  control(new URLSearchParams('reset=1&big=1'));
  await assert.rejects(collect(env, 'tpbk', null), /資料太大/);
  control(new URLSearchParams('reset=1'));
  assert.equal((await collect(env, 'tpbk', null)).rows.length, 3);
});

test('讀取合併：同一間廁所在不同來源名稱不同也合併（30 公尺內），以官方免費的為準；不同類、太遠的不合併', () => {
  const r = (id, source, name, lat, lng, access = 'public', type = 'toilet', svc = 2) => ({ id, source, type, subtype: 'public', svc, access, name, lat, lng });
  const out = mergeRows([
    r('tpt:a', 'tpt', '中油中崙加油站', 25.04800, 121.55000, 'customer'), r('cpct:a', 'cpct', '中油中崙站', 25.04830, 121.55040, 'public', 'toilet', 34),   // 約 52 公尺、名稱整理後相同
    r('tpt:b', 'tpt', '百齡右岸景觀', 25.09000, 121.51600), r('tprv:b', 'tprv', '百齡右岸河濱公園', 25.09020, 121.51610),                                   // 約 25 公尺
    r('tpt:c', 'tpt', '某某公廁', 25.06000, 121.53000), r('tprv:c', 'tprv', '某某河濱公園', 25.06020, 121.53015),                                         // 約 27 公尺、名稱不同
    r('tpt:d', 'tpt', '遠的公廁', 25.07000, 121.53000), r('tprv:d', 'tprv', '另一處', 25.07040, 121.53000),                                               // 約 44 公尺、名稱不同 → 不合併
    r('twd:e', 'twd', '某某公廁', 25.06001, 121.53001, 'public', 'water', 1),                                                                         // 不同類
  ]);
  const ids = out.map((x) => x.id).sort();
  assert.deepEqual(ids, ['cpct:a', 'tprv:b', 'tprv:c', 'tprv:d', 'tpt:d', 'twd:e']);
  const cp = out.find((x) => x.id === 'cpct:a');
  assert.equal(cp.access, 'public', '以中油無障礙公廁（免費）為準'); assert.deepEqual(cp.also, ['tpt']); assert.ok(cp.svc & 32);
});

test('第二批：半徑篩選只留跑點 1 公里內、是／否的各種寫法、金鑰只從環境讀、店家與待確認在合併時排在官方後面', () => {
  const spot = { lat: 25.013897, lng: 121.457759 };
  const at = (m) => ({ id: `x:${m}`, lat: spot.lat + m / 111320, lng: spot.lng, cell: '' });
  assert.deepEqual(nearSpots([at(900), at(1100), at(-990)], [spot], 1000).map((r) => r.id), ['x:900', 'x:-990']);
  // 跨格子邊界（0.02 度）也找得到
  const edge = { lat: 25.0199, lng: 121.4599 };
  assert.equal(nearSpots([{ id: 'e', lat: 25.0201, lng: 121.4601 }], [edge], 1000).length, 1);
  assert.equal(nearSpots([at(10)], [], 1000).length, 0, '沒有跑點就一筆都不留');
  assert.throws(() => nearSpots([], [spot], 5000), /2 公里/);
  for (const v of ['是', '有', 'Y', 'yes', 'TRUE', '1', 'V', ' 是 ']) assert.ok(yes(v), v);
  for (const v of ['否', '無', 'N', '0', '', null, undefined, '不確定']) assert.ok(!yes(v), String(v));
  assert.equal(keyOf({}, SOURCES.cool), '', '正式環境沒有設定就是空的');
  assert.equal(keyOf({ MOENV_KEY: 'k-12345678' }, SOURCES.moenv), 'k-12345678');
  assert.equal(keyOf({ MOENV_KEY: 'k-12345678' }, SOURCES.twd), '', '第一批不用金鑰');
  for (const k of ['cool', 'moenv']) {
    const S = SOURCES[k];
    assert.ok(S.local && S.radius === 1000 && S.firstOn && S.key === 'MOENV_KEY' && /data\.gov\.tw\/dataset\//.test(S.dataset) && /環境部/.test(S.attribution), k);
  }
  // 同一處：官方的公廁優先於「待確認」的店家廁所
  const m = mergeRows([
    { id: 'cool:a', source: 'cool', type: 'toilet', subtype: 'store', svc: 2, access: 'unverified', name: '某銀行', lat: 25.0139, lng: 121.4577 },
    { id: 'moenv:b', source: 'moenv', type: 'toilet', subtype: 'public', svc: 34, access: 'public', name: '板橋公廁', lat: 25.01391, lng: 121.45771 },
  ]);
  assert.equal(m.length, 1); assert.equal(m[0].id, 'moenv:b'); assert.deepEqual(m[0].also, ['cool']);
});

test('第二批的開放時間：括號裡的星期、跨夜的時段只存原文（parseHours 會讀成每天開放或整天未開放）；「24小時營業」是 24 小時', () => {
  const cool = (hours) => parse('cool', [{ datasetid: '室內', recordid: 'H1', coolingtype: '新北市政府', stationtype: '公有涼爽點', placename: '測試圖書館', city: '新北市',
    address: '新北市板橋區測試路1號', longitude: '121.4580', latitude: '25.0142', openinghours: hours, restroom: '0', waterdispenser: '1', seats: '1', airconditioning: '1', isaccessible: '0' }])[0];
  // 2026-10-04 Cool map 的真實寫法
  for (const s of ['(二)~(六) 08:00–17:00', '(二)~(日) 08:00–17:00', '09:00–17:00(二~日)', '08:30–20:30(二~日)', '08:00–17:30(一~五)', '(二)~(五) 08:00–21:00，六、日 08:00–17:00',
    '08:00–12:00，13:00–17:00，(一二三四五)', '09:00-17:00(週三-週日)', '08:00-17:30 (例假日休息)', '06:00–01:00', '每日06:00–01:00', '10:30–02:00', '09:30–05:30', '06:00-13:00 (週一休市)']) {
    assert.ok(riskyHours(s), s);
    const r = cool(s);
    assert.equal(r.hours, null, `${s} 不能存成 hours`); assert.ok(r.hours_raw, s);
    assert.equal(readFix({ hours: s }).value.hours, '', `幹部輸入 ${s}`);
  }
  // 看得懂的照收：括號裡只有休館日、只寫國定假日、括號外已經有星期
  for (const s of ['08:30–21:00（週一及國定假日休館）', '11:00–21:00(週一休館)', '09:00–17:00（國定假日休館）', '週一至週五8:30-17:30(例假日及國定假日除外)', '08:00–20:00 (每日)', '06:00–24:00', '06:00–00:00']) {
    assert.ok(!riskyHours(s), s);
  }
  assert.equal(hoursNow(cool('(二)~(六) 08:00–17:00').hours, at('2026-10-05T10:00:00')), null, '週一不顯示開放中');
  for (const s of ['24小時營業', '24 小時營業', '24小時']) { const r = cool(s); assert.equal(r.hours, '24 小時', s); assert.ok(r.svc & 512, s); assert.equal(r.hours_raw, null); }
});

test('Cool map：公有先看設施類型與店家種類（「東門市場」不是店家），合作涼爽點不算公有', () => {
  const row = (placename, coolingtype, stationtype, city = '新北市') => ({ datasetid: '室內', recordid: placename, coolingtype, stationtype, placename, city, address: `${city}測試路`,
    longitude: city === '臺北市' ? '121.5400' : '121.4580', latitude: city === '臺北市' ? '25.0735' : '25.0142', openinghours: '', restroom: '1', waterdispenser: '1', seats: '1', airconditioning: '1', isaccessible: '0' });
  const out = Object.fromEntries(parse('cool', [row('東門市場', '台北市政府', '公有涼爽點', '臺北市'), row('西門商場', '台北市政府', '公有涼爽點', '臺北市'), row('河濱一商場', '新北市政府', '公有涼爽點'),
    row('某某大學', '某某大學', '合作涼爽點'), row('某某醫院', '某某醫院', '合作涼爽點'), row('統一超商測試門市', '統一超商', '合作涼爽點')]).map((r) => [r.name, `${r.type}/${r.subtype}/${r.access}`]));
  assert.deepEqual(out, { 河濱一商場: 'water/cool/public', 某某大學: 'water/cool/unverified', 某某醫院: 'water/cool/unverified', 統一超商測試門市: 'supply/store/unverified' });
});

test('環境部公廁：名稱去掉廁間與樓層；同一地址的廁間合併成一處；飯店、影城、休閒娛樂是店家；加油站看名稱；縣市是代碼', () => {
  // 真實資料的名稱
  const cases = { '博愛公園-女廁': '博愛公園', '民生加油站男廁': '民生加油站', '西屯區潮洋公園-女廁': '西屯區潮洋公園', '前金運動中心-3F男廁': '前金運動中心',
    '耐斯王子大飯店1F女廁': '耐斯王子大飯店', '統一超商三重日揚門市-混合廁所': '統一超商三重日揚門市', '新園鄉圖書館4F混合廁': '新園鄉圖書館',
    'j-Mall食尚廣場-2F(無障礙廁)': 'j-Mall食尚廣場', '新光醫院聖賢樓B1男': '新光醫院聖賢樓', '成功鎮立圖書館一樓女廁': '成功鎮立圖書館', '聖馬爾定1樓親子廁': '聖馬爾定',
    '中壢區文化公園性別友善廁': '中壢區文化公園', '亞洲大學附屬醫院(2樓婦兒科旁)-男廁': '亞洲大學附屬醫院', '自來水園區大門旁男': '自來水園區大門旁',
    '三峽老街景觀公廁': '三峽老街景觀公廁', '板橋大漢A停車場-混合廁所': '板橋大漢A停車場', '某某公園女廁2': '某某公園', '青少年服務中心': '青少年服務中心' };
  for (const [raw, want] of Object.entries(cases)) assert.equal(placeName(raw), want, raw);
  const mo = (number, name, f = {}) => ({ county: f.county || '65000', areacode: '65000010', village: '測試里', number, name, address: f.addr ?? '新北市板橋區測試路1號',
    administration: '測試區公所', latitude: String(f.lat || 25.0139), longitude: String(f.lng || 121.4577), grade: f.grade || '特優級', type2: f.kind || '公園', type: f.type || '男廁所', exec: '測試區公所', diaper: '0' });
  const rows = parse('moenv', [mo('1', '測試公園-男廁'), mo('2', '測試公園-女廁', { type: '女廁所' }), mo('3', '測試公園2F無障礙廁所', { type: '無障礙廁所' }), mo('4', '測試公園-女廁', { lat: 25.0150 }),
    mo('5', '香格里拉測試大飯店1F女廁', { addr: '高雄市測試路2號', county: '64000', lat: 22.62, lng: 120.30, kind: '其他' }), mo('6', '測試影城-男廁', { addr: '高雄市測試路3號', county: '64000', lat: 22.63, lng: 120.30, kind: '休閒娛樂場所' }),
    mo('7', '台塑測試加油站-男廁', { addr: '高雄市測試路4號', county: '64000', lat: 22.64, lng: 120.30, kind: '商業營業場所' }),
    mo('8', '臺北測試公園-男廁', { addr: '中山區測試路5號', county: '63000', lat: 25.07, lng: 121.54 }), mo('9', '不合格測試公廁', { addr: '新北市測試路6號', grade: '不合格', lat: 25.02 })]);
  const by = Object.fromEntries(rows.map((r) => [`${r.name}@${r.lat.toFixed(3)}`, `${r.subtype}/${r.access}/${r.city}/${r.svc}`]));
  assert.deepEqual(by, { '測試公園@25.014': 'public/public/新北市/34', '測試公園@25.015': 'public/public/新北市/2', '香格里拉測試大飯店@22.620': 'store/customer/高雄市/2',
    '測試影城@22.630': 'store/customer/高雄市/2', '台塑測試加油站@22.640': 'station/customer/高雄市/2' });
});

test('讀取合併：Cool map 有廁所的連鎖店（補給）與同一間店的店家廁所 30 公尺內合併；店家不併進公廁、不同店不合併', () => {
  const r = (id, source, type, subtype, svc, access, name, lat, lng) => ({ id, source, type, subtype, svc, access, name, lat, lng });
  const out = mergeRows([
    r('cool:a', 'cool', 'supply', 'store', 2 | 16 | 1, 'unverified', '全家便利商店-台中學友店', 24.10000, 120.60000),
    r('moenv:a', 'moenv', 'toilet', 'store', 2, 'customer', '全家台中學友店', 24.10001, 120.60001),
    r('cool:b', 'cool', 'supply', 'store', 16 | 1, 'unverified', '7-11 沒有廁所', 24.20000, 120.60000),
    r('moenv:b', 'moenv', 'toilet', 'store', 2, 'customer', '某某餐廳', 24.20001, 120.60001),
    r('cool:c', 'cool', 'supply', 'store', 2 | 16, 'unverified', '萊爾富某店', 24.30000, 120.60000),
    r('moenv:c', 'moenv', 'toilet', 'public', 2, 'public', '某某公園', 24.30001, 120.60001),
    r('cool:d', 'cool', 'supply', 'store', 2 | 16, 'unverified', '全聯某店', 24.40000, 120.60000),
    r('cool:e', 'cool', 'supply', 'store', 2 | 16, 'unverified', '家樂福某店', 24.40001, 120.60001),
  ]);
  const ids = out.map((x) => x.id).sort();
  assert.deepEqual(ids, ['cool:a', 'cool:b', 'cool:c', 'cool:d', 'cool:e', 'moenv:b', 'moenv:c']);
  assert.deepEqual(out.find((x) => x.id === 'cool:a').also, ['moenv']);
  assert.ok(samePlace(out.find((x) => x.id === 'cool:a'), { type: 'toilet', subtype: 'store', svc: 2, lat: 24.10001, lng: 120.60001, name: 'x' }));
});
