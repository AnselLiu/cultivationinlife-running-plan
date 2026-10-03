// 耕跑團 PWA — photo.js：從 app.js 拆出來、用到才載入的畫面（第一次開 App 不用下載）
import * as S from './studio.js';
import * as Run from './run.js';
import { $, allow, api, cfg, esc, feat, group, IC, largeTitle, me, route, row, studio, toast, view } from './app.js';

// ---------- 拍照分享（手動／Apple 健康／檔案／跑步記錄 → 照片合成 → 分享 IG）----------
const TEMPLATES = { minimal: '極簡', route: '路線', bib: '號碼布' };
function defaultStats() {
  return { title: '週四團練', date: new Date().toISOString().slice(0, 10), distance: 10000, seconds: 3300, elevation: 42, avg_hr: null, route: [] };
}
// 拍照的流程偏好：直接進 AR 相機（先拍、數據之後再改），或先填成績再拍（記在這台手機）
const arFirst = { get() { try { return localStorage.getItem('cil-ar-first') === '1'; } catch { return false; } }, set(v) { try { v ? localStorage.setItem('cil-ar-first', '1') : localStorage.removeItem('cil-ar-first'); } catch {} } };
async function studioView() {
  // 手機上有剛跑完、還沒清掉的跑步記錄：直接帶進來（距離、時間、爬升、路線）
  if (!studio.stats && Run.session()?.status === 'done') {
    const r = Run.summary();
    studio.stats = { title: '今天的跑步', date: r.date, distance: r.distance, seconds: r.seconds, elevation: r.gain, avg_hr: null, route: r.route };
    if (r.route.length > 1) studio.template = 'route';
  }
  studio.stats ||= defaultStats();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('km')) {
    // 從 iPhone 捷徑或其他 App 帶進來的數據；只接受數字與日期，其餘忽略
    const num = (k, max) => { const v = parseFloat(String(q.get(k) || '').replace(',', '.')); return v > 0 && v < max ? v : 0; };
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : new Date().toISOString().slice(0, 10);
    studio.stats = { title: (q.get('title') || '今天的跑步').slice(0, 20), date, distance: num('km', 400) * 1000,
      seconds: num('sec', 200000) || num('min', 3000) * 60, elevation: Math.round(num('elev', 9000)), avg_hr: Math.round(num('hr', 230)) || null, route: [] };
    studio.source = 'manual';
    history.replaceState(null, '', '#/studio');
    setTimeout(() => toast(q.get('src') === 'health' ? '已帶入 Apple 健康的跑步數據' : '已帶入跑步數據'), 300);
  }
  // 從其他 App 分享 GPX／TCX 過來（Service Worker 先暫存）
  if (q.get('shared')) {
    history.replaceState(null, '', '#/studio');
    try {
      const c = await caches.open('cil-share'), res = await c.match('/shared-track');
      if (res) {
        studio.stats = S.parseTrack(await res.text(), decodeURIComponent(res.headers.get('x-name') || 'track.gpx'));
        studio.source = 'manual'; await c.delete('/shared-track');
        setTimeout(() => toast(`已匯入 ${(studio.stats.distance / 1000).toFixed(2)} 公里`), 300);
      }
    } catch (e) { setTimeout(() => toast(e.message || '這個檔案讀不出來'), 300); }
  }
  if ((studio.source === 'health' && !feat('health')) || (studio.source === 'file' && !feat('file'))) studio.source = 'manual';
  view.innerHTML = `
    ${largeTitle('拍照分享', '把今天的距離、時間和配速放進照片，分享到 IG')}
    ${feat('gps') ? `<a class="card tight lit" href="#/run"><div class="row spread"><span class="row" style="gap:10px">${IC.runner}<span><b>${Run.active() ? '正在記錄跑步' : '用手機記錄這次跑步'}</b><span class="tiny" style="display:block">計時加上 GPS，跑完直接拍照分享</span></span></span><span class="tiny">›</span></div></a>` : ''}
    <div class="dash studio">
      <section class="card stage-card">
        <div class="frame ${studio.size}"><canvas id="cv" aria-label="照片預覽"></canvas></div>
        <div class="seg" role="group" aria-label="尺寸">${Object.entries(S.SIZES).map(([k, v]) => `<button data-size="${k}" aria-pressed="${studio.size === k}">${v[2]}</button>`).join('')}</div>
      </section>
      <div style="display:grid;gap:14px">
        <section class="card">
          <h3>1　跑步成績</h3>
          <div class="seg" role="group" aria-label="資料來源">
            ${[['manual', '手動'], ...(feat('health') ? [['health', 'Apple 健康']] : []), ...(feat('file') ? [['file', '匯入檔案']] : [])].map(([k, v]) => `<button data-src="${k}" aria-pressed="${studio.source === k}">${v}</button>`).join('')}
          </div>
          <div id="srcPanel"></div>
        </section>
        <section class="card">
          <h3>2　照片</h3>
          <div class="row">
            <label class="btn ghost sm filebtn">選照片／拍照<input type="file" accept="image/*" id="photoIn" hidden></label>
            <button class="btn sm" id="arBtn">AR 相機</button>
            ${studio.bg ? '<button class="btn ghost sm" id="noPhoto">移除照片</button>' : ''}
          </div>
          <label class="switch"><span>打開拍照就直接進 AR 相機<span class="tiny" style="display:block">先拍，距離、時間之後再改，照片上的數字會跟著更新；正在記錄跑步時數字即時跳動</span></span><input type="checkbox" id="arFirst" ${arFirst.get() ? 'checked' : ''}><i></i></label>
          <p class="tiny" style="margin:0">照片只在你的手機裡合成，不會上傳。</p>
        </section>
        <section class="card">
          <h3>3　版型</h3>
          <div class="tpls">${Object.entries(TEMPLATES).map(([k, v]) => `<button class="tpl" data-tpl="${k}" aria-pressed="${studio.template === k}">${v}</button>`).join('')}</div>
        </section>
        <section class="card actions">
          <button class="btn block" id="shareImg">分享圖片</button>
          <button class="btn ghost block" id="toLog">存到訓練紀錄</button>
          <button class="btn ghost block" id="makeReel">產生 Reels 短片（6 秒）</button>
          <p class="tiny center" style="margin:0">分享時選 Instagram，就能發到限時動態、貼文或 Reels。</p>
        </section>
      </div>
    </div>`;
  for (const b of document.querySelectorAll('[data-size]')) b.onclick = () => { studio.size = b.dataset.size; studioView(); };
  for (const b of document.querySelectorAll('[data-src]')) b.onclick = () => { studio.source = b.dataset.src; studioView(); };
  for (const b of document.querySelectorAll('[data-tpl]')) b.onclick = () => { studio.template = b.dataset.tpl; studioView(); };
  $('#photoIn').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    studio.bg = await createImageBitmap(f).catch(() => null);
    if (!studio.bg) return toast('這張照片讀不出來，換一張試試');
    studioView();
  };
  $('#noPhoto')?.addEventListener('click', () => { studio.bg = null; studioView(); });
  $('#arBtn').onclick = () => arCamera();
  $('#arFirst').onchange = (e) => { arFirst.set(e.target.checked); toast(e.target.checked ? '下次打開拍照會直接進 AR 相機' : '改回先填成績再拍'); };
  // 把這次的成績帶到訓練紀錄（自動對上那天的課表）
  $('#toLog').onclick = () => {
    const x = studio.stats, p = new URLSearchParams({ date: x.date, km: (x.distance / 1000).toFixed(2), sec: String(Math.round(x.seconds || 0)), src: studio.source === 'manual' ? 'manual' : studio.source });
    if (x.avg_hr) p.set('hr', String(x.avg_hr));
    location.hash = `#/log?${p}`;
  };
  $('#shareImg').onclick = async () => {
    const blob = await S.toBlob($('#cv'));
    const r = await S.shareFile(blob, `耕跑團-${studio.stats.date}.jpg`, studio.stats.title);
    if (r === 'downloaded') toast('已下載圖片，可以從相簿分享到 IG');
  };
  $('#makeReel').onclick = async () => {
    const btn = $('#makeReel'); btn.disabled = true; btn.textContent = '錄製中…';
    try {
      const blob = await S.recordVideo($('#cv'), studio.bg, studio.stats, opts());
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const r = await S.shareFile(blob, `耕跑團-${studio.stats.date}.${ext}`, studio.stats.title);
      if (r === 'downloaded') toast(ext === 'mp4' ? '已下載短片' : '已下載短片（webm 格式，IG 可能不支援，建議用手機操作）');
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = '產生 Reels 短片（6 秒）';
    draw();
  };
  await sourcePanel();
  draw();
  // 偏好「直接進 AR」：每次從別的頁面進來、還沒有照片時自動開相機（從相機回來不會再開）
  if (arFirst.get() && !studio.bg && !studio.arShown && navigator.mediaDevices?.getUserMedia) { studio.arShown = true; arCamera(); }
}
addEventListener('hashchange', () => { if (!location.hash.startsWith('#/studio')) studio.arShown = false; });
const opts = () => ({ template: studio.template, size: studio.size, name: me?.nickname || me?.name || '' });
const draw = () => S.render($('#cv'), studio.bg, studio.stats, opts());

async function sourcePanel() {
  const box = $('#srcPanel'), st = studio.stats;
  if (studio.source === 'manual') {
    box.innerHTML = `<form id="mform" class="mform">
      <label>標題<input name="title" value="${esc(st.title)}" maxlength="20"></label>
      <div class="grid2">
        <label>距離（公里）<input name="km" inputmode="decimal" value="${(st.distance / 1000).toFixed(2)}"></label>
        <label>時間<input name="time" value="${S.fmtDuration(st.seconds)}" placeholder="55:00"></label>
      </div>
      <div class="grid2">
        <label>爬升（公尺）<input name="elev" inputmode="numeric" value="${st.elevation || ''}"></label>
        <label>日期<input type="date" name="date" value="${esc(st.date)}"></label>
      </div></form>`;
    $('#mform').oninput = (e) => {
      const f = e.currentTarget;
      Object.assign(studio.stats, { title: f.title.value, distance: (parseFloat(f.km.value) || 0) * 1000,
        seconds: S.parseHMS(f.time.value), elevation: parseInt(f.elev.value, 10) || 0, date: f.date.value });
      draw();
    };
  } else if (studio.source === 'health') {
    box.innerHTML = `<div class="howto">
      ${cfg.shortcut ? `<a class="btn block" href="${esc(cfg.shortcut)}" target="_blank" rel="noopener">加入「耕跑團記錄」捷徑</a>` : '<p class="notice" style="margin:0">幹部還沒提供捷徑連結，可以先用「手動」或「匯入檔案」。</p>'}
      <ol class="steps">
        <li>第一次執行時，允許捷徑讀取「健康」的體能訓練</li>
        <li>跑完步，打開捷徑 App 點「耕跑團記錄」，或對 Siri 說「耕跑團記錄」</li>
        <li>會自動打開這裡，帶入最新一筆跑步的距離與時間；按「存到訓練紀錄」就會對上當天的課表</li>
      </ol>
      <p class="tiny" style="margin:0">想跳過拍照、直接存成訓練紀錄：幹部可以另外做一個網址改成 <code>#/log</code> 的捷徑，做法見協會文件的「Apple 健康捷徑製作說明」。</p>
      <p class="tiny" style="margin:0">資料只在你的 iPhone 和這個頁面之間傳遞，不會經過協會的伺服器。Android 或手錶請改用「匯入檔案」。</p>
      ${allow('event') ? `<details><summary class="tiny" style="cursor:pointer">幹部：設定捷徑連結</summary>
        <form id="scForm" class="row" style="gap:8px;margin-top:8px">
          <input name="url" placeholder="https://www.icloud.com/shortcuts/…" value="${esc(cfg.shortcut || '')}" style="flex:1;min-width:200px">
          <button class="btn sm">儲存</button></form></details>` : ''}
    </div>`;
    $('#scForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/settings/shortcut', { method: 'POST', body: { url: e.target.url.value.trim() } }); cfg.shortcut = e.target.url.value.trim() || null; toast('已儲存捷徑連結'); sourcePanel(); }
      catch (err) { toast(err.message); }
    });
  } else if (studio.source === 'file') {
    box.innerHTML = `<label class="drop"><input type="file" accept=".gpx,.tcx,application/gpx+xml" id="trackIn" hidden>
        <b>選擇 GPX 或 TCX 檔</b><span class="tiny">Garmin Connect：活動 → 齒輪 → 匯出 GPX／TCX<br>Apple 健康：個人頭像 → 輸出所有健康資料（workout-routes 裡的 GPX）</span></label>`;
    $('#trackIn').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { studio.stats = S.parseTrack(await f.text(), f.name); studio.source = 'manual'; toast(`已匯入 ${(studio.stats.distance / 1000).toFixed(2)} 公里`); studioView(); }
      catch (err) { toast(err.message); }
    };
  }
}

// AR 相機：鏡頭畫面上即時疊數據，按快門把當下畫面當成照片
async function arCamera() {
  const host = document.createElement('div');
  host.className = 'ar';
  host.innerHTML = `<canvas id="arCv"></canvas>
    <div class="arbar">
      <button class="btn ghost sm" id="arClose">取消</button>
      <button class="shutter" id="arShot" aria-label="拍照"></button>
      <button class="btn ghost sm" id="arFlip">翻轉</button>
    </div>`;
  document.body.append(host);
  document.body.style.overflow = 'hidden';
  const video = document.createElement('video');
  video.playsInline = true; video.muted = true;
  let facing = 'environment', stream = null, live = true;
  const start = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream; await video.play();
    } catch { toast('無法開啟相機，請確認已允許相機權限'); close(); }
  };
  const close = () => { live = false; stream?.getTracks().forEach((t) => t.stop()); host.remove(); document.body.style.overflow = ''; };
  // 正在記錄跑步：疊上即時的距離、時間與爬升
  const liveStats = () => {
    const x = Run.session();
    if (!Run.active() || !x) return studio.stats;
    const r = Run.summary();
    return { ...studio.stats, title: studio.stats.title || '跑步中', distance: r.distance, seconds: r.seconds, elevation: r.gain, route: r.route };
  };
  const loop = async () => {
    if (!live) return;
    if (video.readyState >= 2) await S.render($('#arCv'), video, liveStats(), opts());
    requestAnimationFrame(loop);
  };
  $('#arClose').onclick = close;
  $('#arFlip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; start(); };
  $('#arShot').onclick = async () => {
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    studio.bg = await createImageBitmap(c);
    if (Run.active()) studio.stats = liveStats();   // 跑步中拍的：把當下的數字留在照片上
    host.classList.add('flash');
    setTimeout(() => { close(); studioView(); }, 180);
  };
  await start();
  loop();
}

export { draw, opts, studioView };
