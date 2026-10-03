// 跑步天氣規則：伺服器（前一晚壞天氣提醒）與畫面（天氣卡片）共用同一份判斷
//   不建議：體感 33° 以上、AQI 151 以上、雷雨；注意：體感 28° 以上、AQI 101 以上、大雨、強風、紫外線 8 以上、體感 8° 以下
export const WX = (c) => (c === 0 ? '晴' : c <= 2 ? '晴時多雲' : c === 3 ? '陰' : c <= 48 ? '有霧' : c <= 57 ? '毛毛雨' : c <= 67 ? '下雨' : c <= 77 ? '下雪' : c <= 82 ? '陣雨' : '雷雨');
// 從 Open-Meteo 的回應取出某個小時（isoHour：YYYY-MM-DDTHH:00）
export function hourOf(w, isoHour) {
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
