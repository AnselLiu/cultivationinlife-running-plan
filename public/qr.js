// QR Code：用自架的 qrcode-generator（MIT，Kazuhiko Arase）產生，不連外部 CDN，離線也能用。
// public/vendor/qrcode.js 是 UMD，載入後掛在 window.qrcode。
let ready;
function load() {
  if (globalThis.qrcode) return Promise.resolve();
  ready ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/qrcode.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('QR 函式庫載入失敗'));
    document.head.append(s);
  });
  return ready;
}

// 產生 SVG 字串。版本自動選，容錯等級預設 M。
export async function qrSVG(text, { size = 220, dark = '#0B1B33', light = '#fff', quiet = 4, ecc = 'M' } = {}) {
  await load();
  const q = globalThis.qrcode(0, ecc);
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), total = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" role="img" aria-label="入場 QR Code" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${light}" rx="1"/><path d="${d}" fill="${dark}"/></svg>`;
}

// 掃描：有相機就能掃。瀏覽器有內建 BarcodeDetector（Android Chrome、桌機 Chrome／Edge）就用它；
//   沒有的（iPhone、iPad 的 Safari 與加到主畫面的 App）改用 jsQR 解析相機畫面，第一次掃描時才下載（/vendor/jsQR.js）。
//   打開相機時系統會詢問相機權限；拒絕過的話告訴使用者去哪裡打開
export const canScan = () => !!navigator.mediaDevices?.getUserMedia;
let jsQRP = null;
const loadJsQR = () => (jsQRP ||= new Promise((ok, bad) => {
  if (globalThis.jsQR) return ok(globalThis.jsQR);
  const el = document.createElement('script');
  el.src = '/vendor/jsQR.js';
  el.onload = () => (globalThis.jsQR ? ok(globalThis.jsQR) : bad(new Error('掃描元件載入失敗，請手動輸入代碼')));
  el.onerror = () => { jsQRP = null; bad(new Error('掃描元件載入失敗，請檢查網路或手動輸入代碼')); };
  document.head.append(el);
}));
const isApple = () => /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
function cameraError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
    return new Error(isApple() ? '沒有相機權限。請到 iPhone「設定 → App → Safari → 相機」（或網站設定）改成「允許」，再回來重新打開掃描' : '沒有相機權限。請在瀏覽器網址列旁的網站設定允許相機，再重新打開掃描');
  }
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return new Error('找不到可以用的相機，請手動輸入代碼');
  if (e?.name === 'NotReadableError') return new Error('相機被其他 App 使用中，關掉之後再試一次');
  return new Error('相機無法啟動，請手動輸入代碼');
}

export async function scan(video, onFound) {
  if (!canScan()) throw new Error('這台裝置沒有可以用的相機，請手動輸入代碼');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
  catch (e) { throw cameraError(e); }
  video.setAttribute('playsinline', ''); video.muted = true;
  video.srcObject = stream;
  try { await video.play(); } catch {}
  let detect;
  const native = 'BarcodeDetector' in globalThis && (await globalThis.BarcodeDetector.getSupportedFormats?.().catch(() => []) || ['qr_code']).includes('qr_code');
  if (native) {
    const det = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => (await det.detect(video))[0]?.rawValue;
  } else {
    let jsQR;
    try { jsQR = await loadJsQR(); } catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; }
    const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return null;
      const k = Math.min(1, 720 / Math.max(w, h));   // 縮到 720px 再解，手機也順
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      ctx.drawImage(video, 0, 0, c.width, c.height);
      return jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' })?.data || null;
    };
  }
  let stop = false, last = 0;
  const tick = async (t) => {
    if (stop) return;
    if (t - last > 140) { last = t; try { const v = await detect(); if (v && !stop) onFound(v); } catch {} }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { stop = true; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
}
