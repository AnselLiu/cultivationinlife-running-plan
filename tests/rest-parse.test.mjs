// 跑者休息站：來源解析與讀取合併的單元測試（src/rest.js），不需要伺服器、不連外
//   用真實資料的寫法（2026-10-03 抓的樣本）當回歸案例：補充說明裡的「不開放」時段、超商名稱、捷運站的 24 小時、河濱廁所的分群、跨來源同一間廁所
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, finalize, mergeRows, readFix, readStop, closedHint, savHours, STORE_NAME, collect, collectPage, haversine, nearSpots, yes, keyOf } from '../src/rest.js';
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
