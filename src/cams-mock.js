// 測試用的假來源：tests/run.mjs 與 tests/e2e/server.mjs 設 CAM_MOCK=1（而且 DEV_LOGIN=1）時，
//   附近即時影像的清單與畫面都由這裡回應，測試不會連到真的政府主機。
//   座標放在測試資料的「大佳河濱公園」（seed07）與「大安森林公園」（seed04）附近。
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// 32×24 的小圖：水利署回 PNG 卻標 image/jpeg（跟真的一樣），公路局與水利處回 JPEG
const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAALUlEQVR42mOctu8OAy0BEwONwagFoxaMWjBqwWCwgNEtL2A0iEYtGLVgqFsAAJfmA2PmrQQVAAAAAElFTkSuQmCC');
const JPG = b64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDfoqj/AGtYf89//HG/wo/taw/57/8Ajjf4VoRYvUVR/taw/wCe/wD443+FH9rWH/Pf/wAcb/CgLHL0UUVBYUUUUAf/2Q==');

// 狀態：drop＝清單少一支（75%，要停用那一支）；shrink＝只剩一支（25%，完整性檢查要擋下）；hits＝每個網址被抓了幾次
export const state = { drop: false, shrink: false, hits: {} };
export function control(q) {
  if (q.has('reset')) { state.drop = false; state.shrink = false; state.hits = {}; }
  if (q.has('drop')) state.drop = q.get('drop') === '1';
  if (q.has('shrink')) state.shrink = q.get('shrink') === '1';
  return { drop: state.drop, shrink: state.shrink, hits: state.hits };
}

const W = 'https://fmg.wra.gov.tw/109wraweb/getImage.aspx?mode=getNewImageS&CCTV_SN=';
const wraRow = (id, name, lat, lng, url) => ({ cameraid: id, cameraname: name, basinname: '淡水河', tributary: '基隆河', countiesandcitieswherethemonitoringpointsarelocated: '臺北市',
  latitude_4326: lat, longitude_4326: lng, imageurl: url ?? `${W}0xMOCK${id}`, imageformat: 'JPG', status: '1' });
function wraList() {
  const all = [
    wraRow('M1', '大佳測試河川', '25.0745', '121.5420'),
    wraRow('M2', '基隆河測試站', ' 25.0700\n', '121.54 50'),             // 座標夾雜空白與換行（真的資料也有）
    wraRow('M3', '壞掉的鏡頭', '25.0760', '121.5380', `${W}0xBROKEN`),
    wraRow('M4', '遠方測試站', '25.1000', '121.6000'),
    wraRow('M5', '不在白名單的主機', '25.0740', '121.5410', 'https://evil.example/cam.jpg'),
    wraRow('M6', '不是 https', '25.0740', '121.5410', 'http://fmg.wra.gov.tw/x'),
    wraRow('M7', '座標在國外', '35.0', '139.0'),
    wraRow('M8', '非預設埠', '25.0740', '121.5410', 'https://fmg.wra.gov.tw:8443/x'),
  ];
  if (state.shrink) return all.slice(0, 1);
  return state.drop ? all.filter((r) => r.cameraid !== 'M4') : all;
}
const THB = `<?xml version="1.0" encoding="utf-8"?><CCTVList xmlns="http://traffic.transportdata.tw/standard/traffic/schema/"><UpdateInterval>86400</UpdateInterval><CCTVs>
<CCTV><CCTVID>CCTV-T1</CCTVID><VideoImageURL>https://cctv-ss02.thb.gov.tw:443/T1-9K+020/snapshot</VideoImageURL><PositionLon>121.5400</PositionLon><PositionLat>25.0720</PositionLat><SurveillanceDescription>測試省道(大佳段)&amp;(N)</SurveillanceDescription><RoadName>台2甲線</RoadName><LocationMile>9K+020</LocationMile></CCTV>
<CCTV><CCTVID>CCTV-T2</CCTVID><VideoImageURL>https://cctv-ss03.thb.gov.tw/T2(1)/snapshot</VideoImageURL><PositionLon>121.5360</PositionLon><PositionLat>25.0340</PositionLat><SurveillanceDescription>測試省道(大安段)</SurveillanceDescription><RoadName>台1線</RoadName><LocationMile>1K+000</LocationMile></CCTV>
</CCTVs></CCTVList>`;
const HEO = [
  { stn_id: 'H1', stn_name: '大佳河濱公園測試', lat: 25.0738, lon: 121.5405, basin_name: '基隆河', url_snapshot: 'https://heocctv4.gov.taipei/channel11/snapshot', category: '公園', url_resoure_type: 'image', IsLive: 1 },
  { stn_id: 'H2', stn_name: '百齡測試', lat: 25.0742, lon: 121.5395, basin_name: '基隆河', url_snapshot: 'https://video.nvr.taifo.com.tw/ab77d8d8-5abf-46f7-abba-9789b04e64e6.html', category: '其他', url_resoure_type: 'iframe', IsLive: 1 },
  { stn_id: 'H3', stn_name: '沒有直播', lat: 25.07, lon: 121.54, url_snapshot: 'https://heocctv2.gov.taipei/channel1/snapshot', category: '公園', IsLive: 0 },
];

export function fetchMock(url) {
  state.hits[url] = (state.hits[url] || 0) + 1;
  const u = new URL(url);
  if (u.hostname === 'opendata.wra.gov.tw') return new Response(JSON.stringify(wraList()), { headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'cctv-maintain.thb.gov.tw') return new Response(THB, { headers: { 'content-type': 'application/xml' } });
  if (u.hostname === 'heopublic.gov.taipei') return new Response(JSON.stringify(HEO), { headers: { 'content-type': 'application/json' } });
  if (/BROKEN/.test(url)) return new Response('error', { status: 500 });
  // 來源會設 cookie（水利署的 WAF）：代理不能把它轉給跑友
  if (u.hostname === 'fmg.wra.gov.tw') return new Response(PNG, { headers: { 'content-type': 'image/jpeg', 'set-cookie': 'TS01=tracking; Path=/' } });
  return new Response(JPG, { headers: { 'content-type': 'image/jpeg' } });
}
