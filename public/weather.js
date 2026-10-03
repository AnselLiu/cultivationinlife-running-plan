// 耕跑團 PWA — weather.js：跑步天氣（練跑地圖、活動場地共用，用到才載入）
//   資料：Open-Meteo 預報與空氣品質，經伺服器 /api/weather 快取 30 分鐘
//   跑步建議依體感溫度、降雨、空氣品質、紫外線與風速，給「適合／注意／不建議」與原因
import { api, esc } from './app.js';

const WX = (c) => (c === 0 ? '晴' : c <= 2 ? '晴時多雲' : c === 3 ? '陰' : c <= 48 ? '有霧' : c <= 57 ? '毛毛雨' : c <= 67 ? '下雨' : c <= 77 ? '下雪' : c <= 82 ? '陣雨' : '雷雨');
const memo = new Map();
export async function load(lat, lng) {
  const k = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`, hit = memo.get(k);
  if (hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
  const v = await api(`/weather?lat=${lat}&lng=${lng}`);
  memo.set(k, { t: Date.now(), v });
  return v;
}
// 某個小時的天氣與跑步建議
export function at(w, isoHour) {
  const i = w.hourly.time.indexOf(isoHour);
  if (i < 0) return null;
  const h = (k) => w.hourly[k]?.[i];
  const ai = w.air ? w.air.time.indexOf(isoHour) : -1;
  const x = { time: isoHour, temp: h('temperature_2m'), feel: h('apparent_temperature'), hum: h('relative_humidity_2m'), rain: h('precipitation_probability'),
    mm: h('precipitation'), code: h('weather_code'), wind: h('wind_speed_10m'), uv: h('uv_index'), aqi: ai >= 0 ? w.air.us_aqi[ai] : null, pm25: ai >= 0 ? w.air.pm2_5[ai] : null };
  x.text = WX(x.code);
  x.advice = advice(x);
  return x;
}
export function advice(x) {
  const why = [], warn = [];
  if (x.feel >= 33) why.push(`體感 ${Math.round(x.feel)}°，熱傷害風險高`);
  else if (x.feel >= 28) warn.push(`體感 ${Math.round(x.feel)}°，放慢配速、多補水`);
  if (x.aqi >= 151) why.push(`空氣品質不良（AQI ${x.aqi}）`);
  else if (x.aqi >= 101) warn.push(`空氣品質對敏感族群不佳（AQI ${x.aqi}）`);
  if (x.code >= 95) why.push('雷雨');
  else if (x.rain >= 70 && x.mm >= 2) warn.push(`降雨機率 ${x.rain}%，路面濕滑`);
  if (x.wind >= 10) warn.push(`風很大（${Math.round(x.wind)} m/s）`);
  if (x.uv >= 8) warn.push(`紫外線 ${Math.round(x.uv)}，做好防曬`);
  if (x.feel != null && x.feel <= 8) warn.push(`體感 ${Math.round(x.feel)}°，注意保暖`);
  return why.length ? { level: 'poor', label: '不建議', why: [...why, ...warn] } : warn.length ? { level: 'ok', label: '注意', why: warn } : { level: 'good', label: '適合跑步', why: ['天氣條件良好'] };
}
const hh = (t) => t.slice(11, 13);
// 地點卡片用：現在起 12 小時＋今天概況
export function strip(w) {
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13) + ':00';
  const start = Math.max(0, w.hourly.time.indexOf(now));
  const hours = w.hourly.time.slice(start, start + 12).map((t) => at(w, t));
  const cur = hours[0];
  const d0 = w.daily;
  return `<div class="wx">
    ${cur ? `<div class="wxnow ${cur.advice.level}"><div><b class="num">${Math.round(cur.temp)}°</b><span>${esc(cur.text)}・體感 ${Math.round(cur.feel)}°</span></div>
      <div class="wxadv"><span class="pill">${cur.advice.label}</span><span class="tiny">${esc(cur.advice.why.join('；'))}</span></div></div>` : ''}
    <div class="wxhours" role="list">${hours.map((x) => `<div role="listitem" class="${x.advice.level}"><span class="tiny">${hh(x.time)} 時</span><b class="num">${Math.round(x.temp)}°</b><span class="tiny num">${x.rain ?? 0}%</span></div>`).join('')}</div>
    ${d0 ? `<div class="lstats tiny"><span>今天 ${Math.round(d0.temperature_2m_min[0])}–${Math.round(d0.temperature_2m_max[0])}°</span><span>降雨 ${d0.precipitation_probability_max[0] ?? 0}%</span><span>紫外線 ${Math.round(d0.uv_index_max[0] ?? 0)}</span>${cur?.aqi != null ? `<span>AQI ${cur.aqi}</span>` : ''}<span>日出 ${d0.sunrise[0].slice(11)}・日落 ${d0.sunset[0].slice(11)}</span></div>` : ''}
    <p class="tiny" style="margin:0">預報：Open-Meteo（含空氣品質），每 30 分鐘更新</p>
  </div>`;
}
// 活動用：集合時間前後的天氣（7 天內才有預報）
export function forEvent(w, date, time) {
  const t = /^\d{2}:\d{2}$/.test(time || '') ? time.slice(0, 2) : '07';
  const x = at(w, `${date}T${t}:00`);
  if (!x) return '<p class="tiny" style="margin:0">活動前 7 天會顯示場地天氣預報。</p>';
  const di = w.daily.time.indexOf(date);
  const later = [1, 2].map((n) => at(w, `${date}T${String(Number(t) + n).padStart(2, '0')}:00`)).filter(Boolean);
  return `<div class="wx"><div class="wxnow ${x.advice.level}"><div><b class="num">${Math.round(x.temp)}°</b><span>${t} 時・${esc(x.text)}・體感 ${Math.round(x.feel)}°・降雨 ${x.rain ?? 0}%</span></div>
      <div class="wxadv"><span class="pill">${x.advice.label}</span><span class="tiny">${esc(x.advice.why.join('；'))}</span></div></div>
    ${later.length ? `<div class="wxhours">${[x, ...later].map((y) => `<div class="${y.advice.level}"><span class="tiny">${hh(y.time)} 時</span><b class="num">${Math.round(y.temp)}°</b><span class="tiny num">${y.rain ?? 0}%</span></div>`).join('')}</div>` : ''}
    ${di >= 0 ? `<div class="lstats tiny"><span>當天 ${Math.round(w.daily.temperature_2m_min[di])}–${Math.round(w.daily.temperature_2m_max[di])}°</span><span>紫外線 ${Math.round(w.daily.uv_index_max[di] ?? 0)}</span><span>日出 ${w.daily.sunrise[di].slice(11)}</span></div>` : ''}
  </div>`;
}
