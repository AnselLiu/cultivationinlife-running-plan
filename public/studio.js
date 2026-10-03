// 拍照分享：把跑步成績疊在照片上，輸出成 IG 限時動態、貼文或 Reels
// 資料來源：手動輸入、Apple 健康捷徑、GPX／TCX 檔（Garmin Connect、Apple 健康、各家錶都能匯出）
// 全部在瀏覽器裡用 canvas 合成，照片不會上傳到伺服器

// ---------- 資料解析 ----------
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function parseTrack(text, filename = '') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('檔案格式看不懂，請確認是 GPX 或 TCX');
  const tcx = /\.tcx$/i.test(filename) || doc.querySelector('Trackpoint');
  const pts = [];
  if (tcx) {
    for (const tp of doc.querySelectorAll('Trackpoint')) {
      const lat = tp.querySelector('LatitudeDegrees')?.textContent, lon = tp.querySelector('LongitudeDegrees')?.textContent;
      pts.push({ ll: lat && lon ? [+lat, +lon] : null, ele: +(tp.querySelector('AltitudeMeters')?.textContent || NaN),
        t: Date.parse(tp.querySelector('Time')?.textContent || ''), hr: +(tp.querySelector('HeartRateBpm Value')?.textContent || NaN),
        dist: +(tp.querySelector('DistanceMeters')?.textContent || NaN) });
    }
  } else {
    for (const tp of doc.querySelectorAll('trkpt, rtept')) {
      const hr = tp.getElementsByTagNameNS('*', 'hr')[0]?.textContent;
      pts.push({ ll: [+tp.getAttribute('lat'), +tp.getAttribute('lon')], ele: +(tp.querySelector('ele')?.textContent || NaN),
        t: Date.parse(tp.querySelector('time')?.textContent || ''), hr: +(hr || NaN), dist: NaN });
    }
  }
  if (pts.length < 2) throw new Error('檔案裡沒有軌跡點');
  const route = pts.map((p) => p.ll).filter(Boolean);
  let distance = 0, gain = 0;
  const lastDist = [...pts].reverse().find((p) => !Number.isNaN(p.dist))?.dist;
  if (lastDist) distance = lastDist;
  else for (let i = 1; i < route.length; i++) distance += haversine(route[i - 1], route[i]);
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].ele - pts[i - 1].ele;
    if (d > 0.5 && d < 50) gain += d;           // 過濾 GPS 高度雜訊
  }
  const times = pts.map((p) => p.t).filter((t) => !Number.isNaN(t));
  const hrs = pts.map((p) => p.hr).filter((h) => h > 30 && h < 230);
  const name = doc.querySelector('trk > name, metadata > name, Activity > Notes')?.textContent?.trim();
  return {
    title: name || '今天的跑步', date: times.length ? new Date(times[0]).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    distance, seconds: times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0,
    elevation: Math.round(gain), avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null, route,
  };
}

// ---------- 格式 ----------
export const fmtDuration = (s) => {
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
export const fmtPace = (dist, s) => {
  if (!dist || !s) return '—';
  const p = s / (dist / 1000); return `${Math.floor(p / 60)}'${String(Math.round(p % 60)).padStart(2, '0')}"`;
};
export const parseHMS = (str) => {
  const p = String(str).trim().split(':').map(Number);
  if (p.some(Number.isNaN)) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
};

// ---------- 合成 ----------
export const SIZES = { story: [1080, 1920, '限時動態／Reels'], post: [1080, 1350, '貼文 4:5'], square: [1080, 1080, '方形 1:1'] };
const FONT = '-apple-system, "SF Pro Display", "PingFang TC", "Noto Sans TC", sans-serif';
const ROUND = 'ui-rounded, "SF Pro Rounded", -apple-system, "PingFang TC", sans-serif';
let logo;
const loadLogo = () => logo || (logo = new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = '/icons/icon-192.png'; }));

function cover(ctx, img, W, H) {
  const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height;
  const s = Math.max(W / iw, H / ih), w = iw * s, h = ih * s;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}
// 沒有照片時的背景：深藍漸層＋田徑場八條跑道的橢圓線（耕跑團週四團練的臺北田徑場）
function brandBackground(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, W * .4, H);
  g.addColorStop(0, '#0B1B33'); g.addColorStop(.6, '#163A7A'); g.addColorStop(1, '#1C4698');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * .78, H * .18, 0, W * .78, H * .18, W * .9);
  glow.addColorStop(0, 'rgba(253,243,109,.20)'); glow.addColorStop(1, 'rgba(253,243,109,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // 跑道：同心的「操場形」，直道＋兩端半圓
  ctx.save();
  ctx.translate(W * .62, H * .3); ctx.rotate(-0.42);
  for (let lane = 0; lane < 8; lane++) {
    const r = W * .2 + lane * W * .028, straight = W * .55;
    ctx.beginPath();
    ctx.arc(-straight / 2, 0, r, Math.PI / 2, Math.PI * 1.5);
    ctx.lineTo(straight / 2, -r);
    ctx.arc(straight / 2, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.strokeStyle = lane === 0 ? 'rgba(185,208,76,.42)' : `rgba(255,255,255,${.13 - lane * .011})`;
    ctx.lineWidth = lane === 0 ? 3 : 2;
    ctx.stroke();
  }
  ctx.restore();
}
function scrim(ctx, W, H, from = .38) {
  const g = ctx.createLinearGradient(0, H * from, 0, H);
  g.addColorStop(0, 'rgba(6,15,28,0)'); g.addColorStop(1, 'rgba(6,15,28,.82)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
// 路線：把經緯度縮放進指定方框，progress 0–1 用在影片的「畫出路線」
function drawRoute(ctx, route, box, progress = 1, width = 10) {
  if (route.length < 2) return;
  const lats = route.map((p) => p[0]), lons = route.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kx = Math.cos(rad((minLat + maxLat) / 2));
  const w = (maxLon - minLon) * kx || 1e-6, h = maxLat - minLat || 1e-6;
  const s = Math.min(box.w / w, box.h / h);
  const ox = box.x + (box.w - w * s) / 2, oy = box.y + (box.h - h * s) / 2;
  const P = (p) => [ox + (p[1] - minLon) * kx * s, oy + (maxLat - p[0]) * s];
  const n = Math.max(2, Math.floor(route.length * progress));
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(253,243,109,.7)'; ctx.shadowBlur = width * 2.4;
  ctx.strokeStyle = '#FDF36D'; ctx.lineWidth = width;
  ctx.beginPath();
  route.slice(0, n).forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // 起點與目前位置
  ctx.shadowBlur = 0;
  const [sx, sy] = P(route[0]), [ex, ey] = P(route[n - 1]);
  ctx.fillStyle = '#B9D04C'; ctx.beginPath(); ctx.arc(sx, sy, width * 1.2, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey, width * 1.3, 0, 7); ctx.fill();
  ctx.restore();
}
function text(ctx, str, x, y, size, { weight = 700, color = '#fff', align = 'left', font = FONT, spacing = 0, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.font = `${weight} ${size}px ${font}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(str, x, y);
  ctx.restore();
}
function glassPanel(ctx, x, y, w, h, r = 36) {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); ctx.stroke();
  ctx.restore();
}

// stats：{title,date,distance,seconds,elevation,avg_hr,route}；opts：{template,size,name,group,club,p}
export async function render(canvas, bg, stats, opts) {
  const [W, H] = SIZES[opts.size || 'story'];
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const p = opts.p ?? 1;                                   // 影片動畫進度
  const ease = 1 - (1 - Math.min(1, p * 1.25)) ** 3;
  if (bg) cover(ctx, bg, W, H); else brandBackground(ctx, W, H);
  const km = (stats.distance || 0) / 1000;
  const shownKm = (km * ease).toFixed(2);
  const pace = fmtPace(stats.distance, stats.seconds), time = fmtDuration(stats.seconds || 0);
  const M = 72;
  const footerY = H - M;
  const tpl = opts.template || 'minimal';

  if (tpl === 'route') {
    if (bg) { ctx.fillStyle = 'rgba(6,15,28,.35)'; ctx.fillRect(0, 0, W, H); }
    drawRoute(ctx, stats.route || [], { x: M * 1.4, y: H * .12, w: W - M * 2.8, h: H * .5 }, ease, W / 90);
    scrim(ctx, W, H, .5);
    text(ctx, (stats.title || '').slice(0, 18), M, H * .7, 54, { weight: 700 });
    const cols = [['距離', `${shownKm}`, 'km'], ['配速', pace, '/km'], ['時間', time, '']];
    const cw = (W - M * 2) / 3;
    cols.forEach(([k, v, u], i) => {
      const x = M + cw * i;
      text(ctx, k, x, H * .77, 34, { weight: 600, alpha: .75 });
      text(ctx, v, x, H * .77 + 96, 84, { font: ROUND, weight: 800 });
      if (u) text(ctx, u, x, H * .77 + 142, 30, { weight: 600, alpha: .7 });
    });
  } else if (tpl === 'bib') {
    scrim(ctx, W, H, .3);
    const bw = W - M * 2, bh = Math.min(H * .42, 760), bx = M, by = H - bh - M * 2.2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 20;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 40); ctx.fill();
    ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 40); ctx.clip();
    ctx.fillStyle = '#1C4698'; ctx.fillRect(bx, by, bw, 150);
    ctx.fillStyle = '#FDF36D'; ctx.fillRect(bx, by + 150, bw, 14);
    ctx.restore();
    // 四角別針孔
    for (const [px, py] of [[bx + 34, by + 194], [bx + bw - 34, by + 194], [bx + 34, by + bh - 34], [bx + bw - 34, by + bh - 34]]) {
      ctx.fillStyle = 'rgba(11,27,51,.12)'; ctx.beginPath(); ctx.arc(px, py, 11, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(11,27,51,.25)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 11, 0, 7); ctx.stroke();
    }
    // 撕線
    ctx.save(); ctx.setLineDash([10, 10]); ctx.strokeStyle = 'rgba(11,27,51,.18)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx + 30, by + bh - 130); ctx.lineTo(bx + bw - 30, by + bh - 130); ctx.stroke(); ctx.restore();
    text(ctx, (stats.title || '耕跑團').slice(0, 16), bx + 50, by + 96, 52, { weight: 800 });
    text(ctx, stats.date || '', bx + bw - 50, by + 96, 36, { weight: 600, align: 'right', alpha: .85 });
    text(ctx, shownKm, bx + bw / 2, by + bh * .58, Math.min(300, bw / 3.2), { font: ROUND, weight: 900, color: '#0B1B33', align: 'center' });
    text(ctx, 'KM', bx + bw / 2, by + bh * .58 + 70, 44, { weight: 800, color: '#1C4698', align: 'center', spacing: 10 });
    const line = `${time}　·　${pace}/km${stats.elevation ? `　·　↑${stats.elevation}m` : ''}`;
    text(ctx, line, bx + bw / 2, by + bh - 60, 42, { weight: 700, color: '#0B1B33', align: 'center' });
  } else {
    scrim(ctx, W, H, .45);
    text(ctx, (stats.title || '').slice(0, 20), M, H - 520, 50, { weight: 700, alpha: .95 });
    text(ctx, shownKm, M - 6, H - 300, 260, { font: ROUND, weight: 800, spacing: -6 });
    ctx.font = `800 260px ${ROUND}`;
    const kmW = ctx.measureText(shownKm).width;
    text(ctx, 'km', M + kmW + 18, H - 300, 64, { weight: 700, alpha: .85 });
    glassPanel(ctx, M, H - 250, W - M * 2, 140);
    const cells = [['配速', `${pace}`], ['時間', time], [stats.avg_hr ? '心率' : '爬升', stats.avg_hr ? `${stats.avg_hr}` : `${stats.elevation || 0}m`]];
    const cw = (W - M * 2) / 3;
    cells.forEach(([k, v], i) => {
      const x = M + cw * i + 36;
      text(ctx, k, x, H - 202, 30, { weight: 600, alpha: .72 });
      text(ctx, v, x, H - 140, 56, { font: ROUND, weight: 800 });
    });
    if (stats.route?.length > 1) drawRoute(ctx, stats.route, { x: W - M - 260, y: M + 120, w: 260, h: 260 }, ease, 7);
  }

  // 頁尾：跑團 logo＋名稱＋日期
  const lg = await loadLogo();
  const y0 = tpl === 'minimal' ? M + 10 : footerY - 64;
  if (lg) {
    ctx.save(); ctx.beginPath(); ctx.roundRect(M, y0, 64, 64, 16); ctx.clip(); ctx.drawImage(lg, M, y0, 64, 64); ctx.restore();
  }
  text(ctx, '耕跑團', M + 82, y0 + 30, 34, { weight: 800 });
  text(ctx, `${opts.name ? `${opts.name}・` : ''}${stats.date || ''}`, M + 82, y0 + 62, 26, { weight: 600, alpha: .8 });
}

// ---------- 輸出與分享 ----------
export const toBlob = (canvas, type = 'image/jpeg', q = .92) => new Promise((res) => canvas.toBlob(res, type, q));

export async function shareFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancel'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}

// Reels 短片：6 秒，數字往上跳＋路線畫出來
export async function recordVideo(canvas, bg, stats, opts, seconds = 6) {
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported?.(m));
  if (!mime) throw new Error('這個瀏覽器不支援錄製短片');
  await render(canvas, bg, stats, { ...opts, p: 0 });
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start(200);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const frame = async () => {
      const p = (performance.now() - t0) / (seconds * 1000);
      await render(canvas, bg, stats, { ...opts, p: Math.min(1, p / .6) });
      if (p < 1) requestAnimationFrame(frame); else resolve();
    };
    frame();
  });
  rec.stop();
  await done;
  return new Blob(chunks, { type: mime.split(';')[0] });
}
