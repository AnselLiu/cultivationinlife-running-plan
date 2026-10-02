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

// 掃描：優先用瀏覽器內建的 BarcodeDetector（Android Chrome、桌機 Chrome／Edge 有）。
// iPhone 的 Safari 沒有這個 API，改用相機 App 掃 QR 開連結，或在報到台手動輸入代碼。
export const canScan = () => 'BarcodeDetector' in globalThis;

export async function scan(video, onFound) {
  if (!canScan()) throw new Error('這個瀏覽器不支援掃描，請用相機 App 掃或手動輸入代碼');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = stream;
  await video.play();
  const det = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
  let stop = false;
  const tick = async () => {
    if (stop) return;
    try { const hits = await det.detect(video); if (hits.length) onFound(hits[0].rawValue); } catch {}
    requestAnimationFrame(tick);
  };
  tick();
  return () => { stop = true; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
}
