// 耕跑團 PWA — 畫面：團練列表、活動詳情與報名、我的課表、課表教練、幹部的新增活動與公告產生器
import * as P from './plan.js';
import * as Party from './party.js';
import { qrSVG, canScan, scan } from './qr.js';
import * as S from './studio.js';
import * as Run from './run.js';
import * as Guide from './guide.js';

// 對外公開的乾淨網址（Google 同意畫面等會連到這裡）：/privacy → #/privacy
if (location.pathname === '/privacy' && !location.hash) history.replaceState(null, '', '/#/privacy');
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (path, opt = {}) => {
  const method = opt.method || 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    // 寫入類請求一律帶 JSON（伺服器用這個擋 CSRF）
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(opt.body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (method === 'GET') offlineBar(res.headers.get('x-cil-offline') === '1');
  if (!res.ok) throw new Error(data.error || `錯誤 ${res.status}`);
  return data;
};
// 斷線時顯示「離線中，畫面是上次的資料」；恢復連線自動消失
function offlineBar(on) {
  let el = document.getElementById('offline');
  if (!on) { el?.remove(); return; }
  if (el) return;
  el = document.createElement('div');
  el.id = 'offline'; el.className = 'offline'; el.role = 'status';
  el.textContent = '離線中，顯示的是上次的資料；入場券 QR Code 仍然可以使用';
  document.body.append(el);
}
addEventListener('online', () => { offlineBar(false); flushLogQueue(); });
// 前端錯誤回報：送到伺服器記錄（Cloudflare 後台 Logs 看得到），每個頁面最多回報 5 次，不含個資
let errSent = 0;
const reportError = (message, source, line) => {
  if (errSent++ >= 5) return;
  fetch('/api/client-error', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 300), source: String(source || '').replace(location.origin, '').slice(0, 120), line: line || 0, page: location.hash.split('?')[0].slice(0, 60) }) }).catch(() => {});
};
addEventListener('error', (e) => reportError(e.message, e.filename, e.lineno));
addEventListener('unhandledrejection', (e) => { const r = e.reason; if (r?.name === 'AbortError' || /Transition was aborted/.test(r?.message || '')) return; reportError(`unhandled: ${r?.message || r}`, '', 0); });
addEventListener('offline', () => offlineBar(true));
// 登出、刪除帳號：清掉這台裝置暫存的個人資料
const clearDeviceData = () => {
  navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DATA' });
  try { localStorage.removeItem('cil-log-queue'); } catch {}
  navigator.clearAppBadge?.().catch(() => {});
};
function toast(msg) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.role = 'status';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}
const copy = async (text) => {
  try { await navigator.clipboard.writeText(text); toast('已複製'); }
  catch { toast('複製失敗，請長按文字手動複製'); }
};

const KIND_NAME = { track: '田徑場團練', core: '核心日', long: '長跑團練', race: '賽事', party: '春酒餐敘', survey: '問卷調查', other: '活動' };
const ROLE_NAME = { chair: '理事長', director: '理事', supervisor: '監事', staff: '行政人員', coach: '教練', member: '團員' };
const allow = (p) => !!me?.can?.includes(p);
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const d2 = (d) => new Date(`${d}T00:00:00`);
const dayLabel = (s) => s.replace('週五或週六', '週五／六').replace('週一或週三', '週一／三').replace('週二或週三', '週二／三').replace('週四或週五', '週四／五').replace('週三或週五', '週三／五').replace('週三或週六', '週三／六');
const fixText = (s) => s.replace(/\brep(\d)/g, 'rpe$1');
const dstr = (d) => { const x = d2(d); return `${x.getMonth() + 1}/${x.getDate()}（${WD[x.getDay()]}）`; };
const avatar = (s) => s.avatar
  ? `<img class="av" src="${esc(s.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="av" aria-hidden="true">${esc((s.name || '?').slice(0, 1))}</span>`;

let me = null, cfg = {};
// 管理者在後台設定的內容（協會資訊、功能開關、文件、隱私權政策）
const org = () => cfg.settings?.org || {};
const feat = (k) => cfg.settings?.features?.[k] !== false;
// 分團：自己在各分團的身分由 /api/me 帶回；伺服器每次都會再檢查一次，這裡只決定要不要顯示按鈕
// 分團沒有另外上傳圖示時，用內建的正式小圖（耕跑團本團用原本的 logo）
const TEAM_ICONS = { main: '/icons/icon-192.png', youth: '/teams/youth.webp', kids: '/teams/kids.webp', core: '/teams/core.webp', geng: '/teams/geng.webp' };
const teams = () => (cfg.teams || []).map((t) => (!t.icon && TEAM_ICONS[t.id] ? { ...t, icon: TEAM_ICONS[t.id] } : t));
const teamOf = (id) => teams().find((t) => t.id === id);
const myTeams = () => teams().filter((t) => t.my_status === 'active');
const TEAM_PERMS = { lead: ['event', 'checkin', 'lottery', 'layout', 'roster', 'approve', 'appoint'], officer: ['event', 'checkin', 'lottery', 'roster', 'approve'] };
const TEAM_ROLE_NAME = { lead: '團長', officer: '幹部', member: '團員' };
const teamAllow = (tid, p) => allow(p) || (!!tid && teamOf(tid)?.my_status === 'active' && !!TEAM_PERMS[teamOf(tid).my_role]?.includes(p));
const anyTeamAllow = (p) => allow(p) || teams().some((t) => teamAllow(t.id, p));
const teamTag = (t) => (t ? `<span class="pill team" style="--tc:${esc(t.color || '#1C4698')}">${t.icon ? `<img class="ticon xs" src="${esc(t.icon)}" alt="">` : ''}${esc(t.name)}</span>` : '');
// 分團小圖：有上傳就用圖，沒有就用團色＋第一個字
const teamIcon = (t, cls = '') => (t.icon ? `<img class="ticon ${cls}" src="${esc(t.icon)}" alt="" loading="lazy">`
  : `<span class="ticon ${cls}" style="background:${esc(t.color || '#1C4698')}" aria-hidden="true">${esc(t.name.slice(0, 1))}</span>`);
// 上傳前在手機上縮成 256px 正方形（置中裁切），WebP 不支援就用 JPEG
async function squareIcon(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const k = Math.max(256 / bmp.width, 256 / bmp.height), w = bmp.width * k, h = bmp.height * k;
  c.getContext('2d').drawImage(bmp, (256 - w) / 2, (256 - h) / 2, w, h);
  let url = c.toDataURL('image/webp', 0.86);
  if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.88);
  return url;
}
const refreshMe = async () => { const r = await api('/me'); me = r.member; cfg = r; };
// 分享活動：手機跳出分享選單（LINE、訊息…），不支援就複製文字＋連結
const eventUrl = (id) => `${location.origin}/#/e/${id}`;
async function shareEvent(ev, link = eventUrl(ev.id)) {
  const text = `${ev.title}｜${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}` : ''}${ev.place ? `・${ev.place}` : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: ev.title, text, url: link }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(`${text}\n${ev.kind === 'survey' ? '填寫' : '報名'}：${link}`);
}

// 大標題：頁面最上方的 Large Title；捲出畫面後，標題縮到頂部列中間（iOS 行為）
function largeTitle(title, sub = '', action = '') {
  $('#ctitle').textContent = title;
  return `<header class="lt"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${action}</header>`;
}
const ICONS = {
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/></svg>',
  runner: '<svg viewBox="0 0 24 24"><circle cx="14" cy="4.6" r="1.6"/><path d="M6 20.5l2.6-5 2.4-1.6-1-4.2 3.6-1.4 1.8 3.2 3.4 1"/><path d="M11 13.9l1.3 3.2 3.4 2.6"/></svg>',
};
// 介面圖示：一律用同一套線條 SVG（不用 emoji），顏色跟著文字
const ic = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  lock: ic('<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/>'),
  megaphone: ic('<path d="M4 10v4a1 1 0 0 0 1 1h2l6 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>'),
  calendar: ic('<rect x="3.2" y="4.8" width="17.6" height="15.4" rx="3.4"/><path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4"/>'),
  checkCircle: ic('<circle cx="12" cy="12" r="8.6"/><path d="M8 12.3l2.8 2.8L16.2 9.6"/>'),
  check: ic('<path d="M5 12.5l4.2 4.2L19 7"/>'),
  half: ic('<circle cx="12" cy="12" r="7.6"/><path d="M12 4.4a7.6 7.6 0 0 1 0 15.2Z" fill="currentColor" stroke="none"/>'),
  minus: ic('<path d="M6.5 12h11"/>'),
  plus: ic('<path d="M12 6.5v11M6.5 12h11"/>'),
  gift: ic('<rect x="3.6" y="8.4" width="16.8" height="4.2" rx="1.2"/><path d="M5.2 12.6v6.4a1.4 1.4 0 0 0 1.4 1.4h10.8a1.4 1.4 0 0 0 1.4-1.4v-6.4M12 8.4v12M12 8.4S10.6 3.8 8.2 4.5c-2 .6-1.1 3.9 3.8 3.9ZM12 8.4s1.4-4.6 3.8-3.9c2 .6 1.1 3.9-3.8 3.9Z"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>'),
  runner: ic('<circle cx="14" cy="4.6" r="1.6"/><path d="M6 20.5l2.6-5 2.4-1.6-1-4.2 3.6-1.4 1.8 3.2 3.4 1"/><path d="M11 13.9l1.3 3.2 3.4 2.6"/>'),
  scan: ic('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16"/>'),
  doc: ic('<path d="M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5Z"/><path d="M13.5 3.5V8H18M9 12.5h6M9 16h4"/>'),
  external: ic('<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7h4"/>'),
};
const emptyState = (icon, text) => `<div class="empty">${ICONS[icon] || ''}<span>${text}</span></div>`;
function avatarStack(peek, total) {
  if (!total) return '<span class="stack empty">還沒有人</span>';
  return `<span class="stack">${peek.slice(0, 3).map((p) => avatar({ name: p.n, avatar: p.a })).join('')}${total > 3 ? `<span class="more">+${total - 3}</span>` : ''}</span>`;
}
const todayLabel = () => { const d = new Date(); return `${d.getMonth() + 1}月${d.getDate()}日 星期${WD[d.getDay()]}`; };

// ---------- 通行金鑰（Face ID／指紋）----------
const pkSupported = () => !!window.PublicKeyCredential && !!navigator.credentials?.create;
const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// purpose：register 新增、login 登入、stepup 幹部再次驗證
async function passkey(purpose, name) {
  if (!pkSupported()) throw new Error('這個瀏覽器不支援通行金鑰，請用 iPhone 的 Safari 或 Chrome');
  const { cid, publicKey: o } = await api('/passkey/options', { method: 'POST', body: { purpose } });
  const pk = { ...o, challenge: b64uToBuf(o.challenge) };
  if (o.user) pk.user = { ...o.user, id: b64uToBuf(o.user.id) };
  if (o.excludeCredentials) pk.excludeCredentials = o.excludeCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  if (o.allowCredentials) pk.allowCredentials = o.allowCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  let cred;
  try { cred = purpose === 'register' ? await navigator.credentials.create({ publicKey: pk }) : await navigator.credentials.get({ publicKey: pk, mediation: 'optional' }); }
  catch (e) { throw new Error(e.name === 'NotAllowedError' ? '已取消' : e.name === 'InvalidStateError' ? '這台裝置已經有通行金鑰了' : '通行金鑰沒有完成'); }
  const r = cred.response;
  const credential = { id: cred.id, type: cred.type, response: purpose === 'register'
    ? { clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject) }
    : { clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature), userHandle: r.userHandle ? bufToB64u(r.userHandle) : null } };
  return api('/passkey/verify', { method: 'POST', body: { cid, credential, name } });
}
// 幹部開了強制兩步驟、這次登入還沒驗證：顯示提示列
const mfaBanner = () => (me?.mfaPending ? `<section class="card mfabar"><div><b>請驗證身分</b><span class="tiny" style="display:block">你是${esc(me.realRoleName || '幹部')}，協會規定用通行金鑰再驗證一次才能使用管理功能。</span></div>
  <button class="btn sm" data-stepup>${IC.lock}驗證</button></section>` : '');
function bindStepup() {
  for (const b of document.querySelectorAll('[data-stepup]')) b.onclick = async () => {
    try { await passkey('stepup'); toast('驗證完成'); me = null; render(); }
    catch (e) { if (/還沒有通行金鑰/.test(e.message)) { toast('先新增通行金鑰'); location.hash = '#/me/security'; } else if (e.message !== '已取消') toast(e.message); }
  };
}

// Google 標誌（依 Google 品牌規範使用原色 G）
const GOOGLE_G = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
// Google 不允許在 App 內建瀏覽器登入（LINE、Facebook、Instagram）：LINE 可以用 openExternalBrowser=1 直接跳到 Safari／Chrome
const inAppBrowser = () => (/Line\//i.test(navigator.userAgent) ? 'line' : /FBAN|FBAV|Instagram/i.test(navigator.userAgent) ? 'meta' : '');
const googleHref = (link) => {
  const path = `/api/google/start${link ? '?link=1' : ''}`;
  return inAppBrowser() === 'line' ? `${location.origin}/?openExternalBrowser=1${location.hash || '#/'}` : path;
};

// ---------- 登入 ----------
function loginView() {
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('err');
  const shared = location.hash.match(/^#\/e\/([\w-]+)/)?.[1];
  const sharedTok = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  view.innerHTML = `
    <div id="sharedEv"></div>
    <section class="card hero">
      <h2>一起練，跑得更遠</h2>
      <p class="muted" style="margin:0">團練公告、報名接龍和每週課表，都收在這裡。用 Google 登入就會記得你的組別，報名不用再打名字。</p>
      ${org().parent ? `<p class="tiny" style="margin:0;color:rgba(255,255,255,.78)">${esc(org().parent_note || `${org().parent} 支持`)}</p>` : ''}
    </section>
    ${err ? `<div class="notice">${esc(err)}</div>` : ''}
    <section class="card">
      ${cfg.googleLogin ? `<a class="btn google block" href="${googleHref()}">${GOOGLE_G}<span>${inAppBrowser() === 'line' ? '用瀏覽器開啟並以 Google 登入' : '使用 Google 帳號登入'}</span></a>
      ${inAppBrowser() === 'line' ? '<p class="tiny center" style="margin:0">Google 不允許在 LINE 裡登入，按上面的按鈕會改用 Safari 或 Chrome 打開這個網站。</p>' : ''}
      ${inAppBrowser() === 'meta' ? '<p class="notice" style="margin:0">Google 不允許在 Facebook／Instagram 裡登入：請點右上角「⋯」選「在瀏覽器開啟」。</p>' : ''}
      <p class="tiny center">只取得你的 Google 名稱和大頭貼，不會取得 Email、不會讀取你的信件或雲端資料。<br>登入即表示你已閱讀並同意<a href="#/privacy">隱私權政策</a>。</p>` : ''}
      <details ${cfg.googleLogin ? '' : 'open'}>
        <summary class="muted" style="cursor:pointer">用邀請碼加入</summary>
        <form id="joinForm" style="margin-top:12px">
          <label>邀請碼<input name="code" required autocomplete="one-time-code" placeholder="LINE 群公告的代碼"></label>
          <label>姓名<input name="name" required maxlength="20" autocomplete="name" placeholder="報名時顯示的名字"></label>
          <div class="grid2">
            <label>項目<select name="dist"><option value="fm">全馬</option><option value="hm">半馬</option></select></label>
            <label>組別<select name="grp"></select></label>
          </div>
          <label class="inline"><input type="checkbox" name="consent" required> 我已閱讀並同意<a href="#/privacy">隱私權政策</a></label>
          <button class="btn block">加入</button>
        </form>
      </details>
    </section>
    <section class="card">
      <h3>台灣耕跑團協會</h3>
      <p class="muted" style="margin:0">個人入會申請使用協會的 Google 表單，網站不會存身分證字號等資料。</p>
      ${org().join_form ? `<a class="btn ghost block" href="${esc(org().join_form)}" target="_blank" rel="noopener">開啟入會表單</a>` : ''}
    </section>`;
  // 從分享連結進來：記住要去的活動，登入後直接帶過去
  if (shared) {
    try { sessionStorage.setItem('cil-after-login', `#/e/${shared}${sharedTok ? `?t=${encodeURIComponent(sharedTok)}` : ''}`); } catch {}
    api(`/public/e/${shared}${sharedTok ? `?t=${encodeURIComponent(sharedTok)}` : ''}`).then(({ event: e }) => {
      $('#sharedEv').innerHTML = `<section class="card shared">
        <span class="tiny">${e.visibility === 'invite' ? `${IC.lock} 你收到一個邀請制活動的邀請` : `有人邀請你${e.kind === 'survey' ? '填寫問卷' : '報名'}`}</span>
        <div class="row" style="gap:6px">${e.team ? `<span class="pill">${esc(e.team)}</span>` : ''}<span class="pill ${e.kind}">${KIND_NAME[e.kind] || '活動'}</span></div>
        <h2 style="margin:0">${esc(e.title)}</h2>
        <p class="muted" style="margin:0">${dstr(e.date)}${e.gather_time ? ` ${e.gather_time}` : ''}${e.place ? `・${esc(e.place)}` : ''}</p>
        <p class="tiny" style="margin:0">先登入，登入後會直接回到這個活動。</p></section>`;
    }).catch(() => {});
  }
  $('#pkLogin')?.addEventListener('click', async () => {
    try { await passkey('login'); toast('登入成功'); me = null; render(); }
    catch (e) { if (e.message !== '已取消') toast(e.message); }
  });
  const f = $('#joinForm');
  if (!f) return;
  const sync = () => {
    f.grp.innerHTML = Object.entries(P.groups(f.dist.value)).map(([g, v]) => `<option value="${g}">${g} 組・${v[0]}</option>`).join('');
    f.grp.value = f.dist.value === 'hm' ? 'C' : 'D';
  };
  f.dist.onchange = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = (await api('/join', { method: 'POST', body: { code: f.code.value, name: f.name.value, dist: f.dist.value, grp: f.grp.value, consent: f.consent.checked } })).member;
      me = null; location.hash = '#/me?welcome=1'; render();
    } catch (err) { toast(err.message); }
  };
}


// 依功能開關顯示或隱藏分頁
// 下方分頁列：管理員可以改名稱，每個人可以選只顯示圖示
const TAB_DEFAULT = { home: '團練', plan: '課表', run: '跑步', studio: '拍照', me: '我的' };
const iconsOnly = { get() { try { return localStorage.getItem('cil-tab-icons') === '1'; } catch { return false; } }, set(v) { try { v ? localStorage.setItem('cil-tab-icons', '1') : localStorage.removeItem('cil-tab-icons'); } catch {} } };
function applyTabs() {
  const names = { ...TAB_DEFAULT, ...(cfg.settings?.tabs || {}) };
  for (const el of document.querySelectorAll('.tabs .tl')) { el.textContent = names[el.dataset.tl] || el.textContent; el.closest('a').setAttribute('aria-label', names[el.dataset.tl]); }
  document.body.classList.toggle('iconsonly', iconsOnly.get());
}
function applyFeatures() {
  applyTabs();
  const s = document.querySelector('.tabs a[data-tab="/studio"]'), r = document.querySelector('.tabs a[data-tab="/run"]');
  if (s) s.hidden = !feat('studio');
  if (r) r.hidden = !feat('gps');
}

// 倒數：自己的主要賽事 → 最近的自己的賽事 → 協會預設
function paintCountdown() {
  const r = cfg.race, el = $('#countdown');
  el.hidden = !me;
  if (!r?.date) { el.innerHTML = me ? '<small>設定倒數</small>' : ''; el.title = '選擇要倒數的比賽'; return; }
  const t = new Date(`${r.date}T00:00:00`), now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((t - now) / 864e5);
  const short = r.name.replace(/^20\d\d\s*/, '').replace('馬拉松', '馬').slice(0, 7);
  $('#countdown').innerHTML = days > 0 ? `<b class="num">${days}</b>天到${esc(short)}` : days === 0 ? `<b>今天</b>${esc(short)}` : '';
  $('#countdown').title = `${r.name}（${r.date}），點一下可以換`;
}
// 點右上角倒數：選要倒數哪一場（自己的賽事、常用賽事清單、協會預設，或不顯示）
async function countdownPicker() {
  if (!me) return;
  $('#cdSheet')?.remove();
  const d = await api('/races');
  const days = (date) => Math.round((new Date(`${date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const upcoming = d.races.filter((r) => days(r.date) >= 0);
  const mineIds = new Set(d.races.map((r) => `${r.name}|${r.date}`));
  const sheet = document.createElement('div');
  sheet.id = 'cdSheet'; sheet.className = 'sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', '選擇倒數的比賽');
  sheet.innerHTML = `<div class="sheet-bg" data-close></div><section class="card sheet-card">
    <div class="row spread"><h3>倒數哪一場比賽</h3><button class="btn ghost sm" data-close>完成</button></div>
    <div class="cdlist">
      ${upcoming.map((r) => `<button class="cdopt ${d.mode === 'mine' && r.is_primary ? 'on' : ''}" data-race="${r.id}"><span><b>${esc(r.name)}</b><span class="tiny">${esc(r.date)}${r.dist ? `・${esc(r.dist)}` : ''}${r.goal ? `・目標 ${esc(r.goal)}` : ''}</span></span><span class="num">${days(r.date)} 天</span></button>`).join('')}
      ${d.club ? `<button class="cdopt ${d.mode === 'club' ? 'on' : ''}" data-mode="club"><span><b>${esc(d.club.name)}</b><span class="tiny">協會預設・${esc(d.club.date)}</span></span><span class="num">${days(d.club.date)} 天</span></button>` : ''}
      <button class="cdopt ${d.mode === 'off' ? 'on' : ''}" data-mode="off"><span><b>不顯示倒數</b></span></button>
    </div>
    ${d.presets.filter((p) => !mineIds.has(`${p.name}|${p.date}`)).length ? `<h3 style="margin-top:6px">常用賽事</h3><div class="cdlist">${d.presets.filter((p) => !mineIds.has(`${p.name}|${p.date}`)).map((p, i) => `<button class="cdopt" data-preset="${i}"><span><b>${esc(p.name)}</b><span class="tiny">${esc(p.date)}${p.dist ? `・${esc(p.dist)}` : ''}</span></span><span class="tiny">加入並倒數</span></button>`).join('')}</div>` : ''}
    <details><summary class="tiny" style="cursor:pointer">自己新增一場</summary>
      <form id="cdAdd" class="filters" style="margin-top:8px">
        <input name="name" maxlength="30" placeholder="比賽名稱，例如 2027 東京馬拉松" required aria-label="比賽名稱">
        <div class="grid2"><input type="date" name="date" required aria-label="比賽日期"><input name="goal" maxlength="10" placeholder="目標成績（選填）" aria-label="目標成績"></div>
        <button class="btn sm">加入並倒數</button></form></details>
  </section>`;
  document.body.append(sheet);
  const presets = d.presets.filter((p) => !mineIds.has(`${p.name}|${p.date}`));
  const done = async (msg) => { const r = await api('/me'); cfg = r; me = r.member; paintCountdown(); toast(msg); sheet.remove(); };
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-close],[data-race],[data-mode],[data-preset]'); if (!t) return;
    try {
      if (t.dataset.close != null) { sheet.remove(); return; }
      if (t.dataset.race) { await api(`/races/${t.dataset.race}/primary`, { method: 'POST' }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); return done('已換成這場比賽'); }
      if (t.dataset.mode) { await api('/me/countdown', { method: 'POST', body: { mode: t.dataset.mode } }); return done(t.dataset.mode === 'off' ? '已關閉倒數' : '已換成協會預設'); }
      if (t.dataset.preset) { const p = presets[Number(t.dataset.preset)]; await api('/races', { method: 'POST', body: { ...p, is_primary: true } }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); return done(`開始倒數：${p.name}`); }
    } catch (err) { toast(err.message); }
  });
  $('#cdAdd').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('/races', { method: 'POST', body: { name: f.name.value, date: f.date.value, goal: f.goal.value, is_primary: true } }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); done(`開始倒數：${f.name.value}`); }
    catch (err) { toast(err.message); }
  };
  addEventListener('keydown', function esc0(e) { if (e.key === 'Escape') { sheet.remove(); removeEventListener('keydown', esc0); } });
}
$('#countdown').addEventListener('click', countdownPicker);

// ---------- 隱私權政策（個人資料保護法第 8 條告知事項）----------
// 協會名稱、聯絡方式、保存期限、政策內容都由後台「系統設定」管理
const PRIVACY = {
  get org() { return org().name ? `${org().name}（${org().short || '耕跑團'}）` : '台灣耕跑團協會（耕跑團）'; },
  get contact() { return org().contact || '請透過 LINE 群組聯絡協會行政人員'; },
  get retention() { return org().retention || '帳號存續期間'; },
  get version() { return cfg.privacyVersion || ''; },
};
// 管理者自訂的政策內容：「## 」開頭是標題、「- 」開頭是清單、空行分段；一律跳脫，不接受 HTML
function richText(src) {
  return esc(src).split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => l.startsWith('- '))) return `<ul>${lines.map((l) => `<li>${l.slice(2)}</li>`).join('')}</ul>`;
    if (block.startsWith('## ')) return `<h3>${block.slice(3)}</h3>`;
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');
}
function privacyView() {
  const custom = cfg.settings?.privacy?.body;
  view.innerHTML = `
    ${largeTitle('隱私權政策', `版本 ${PRIVACY.version}`)}
    ${custom ? `<section class="card prose">${richText(custom)}</section>` : `<section class="card prose">
      <p>依個人資料保護法第 8 條，${esc(PRIVACY.org)}在蒐集您的個人資料前，告知以下事項。</p>
      <h3>一、蒐集目的</h3>
      <p>〇五二 法人或團體對會員之內部管理（團練報名、分組課表、會籍管理）；〇六九 契約、類似契約或其他法律關係事務（活動報名、入場與抽獎）；一三五 資（通）訊服務（通知推播）。</p>
      <h3>二、蒐集的資料</h3>
      <p>識別類（C001）：姓名、暱稱、Google 帳號的顯示名稱與大頭貼（不取得 Email）、電話（選填）。<br>
         活動相關：項目與組別、所屬跑團、加入的分團與分團身分、餐點偏好、報名與報到紀錄、活動問卷的回答、中獎紀錄。<br>
         系統紀錄：登入時間、裝置型號摘要、IP 位址的單向雜湊值（無法還原）。<br>
         個人賽事：你自己加入的賽事名稱、日期與目標成績（用於倒數）。<br>
         訓練紀錄：你照課表記錄的日期、距離、時間、心率、自覺強度、感覺與備註；預設只有你看得到，你打開分享後，教練與分團幹部只看得到完成率、里程與平均強度，看不到備註。<br>
         照片：拍照分享的照片在你的手機上合成，不會上傳到我們的伺服器。<br>
         賽事報名資料（選填）：只有你需要幹部代為報名馬拉松等賽事時才填，包含中英文姓名、身分證字號或護照號碼、生日、性別、電話、Email、地址、緊急聯絡人與衣服尺寸；<b>加密後保存</b>，只有你自己看得到完整內容。<br>
         協會入會申請另以協會的 Google 表單辦理。</p>
      <h3>三、利用期間、地區、對象與方式</h3>
      <p>期間：${esc(PRIVACY.retention)}。<br>
         地區：台灣，以及雲端服務（Cloudflare）的資料中心所在地。<br>
         對象：依職務最小權限開放給協會幹部；分團團長與幹部可以看自己分團的名冊（不含電話）與該分團活動的報名及問卷結果；電話完整號碼只有行政人員看得到。賽事報名資料只在你報名「代為團體報名」的活動並勾選同意後，提供給該活動的主辦幹部，用來向賽事主辦單位送出團體報名，每次下載都留有稽核紀錄。不提供給第三方行銷使用。<br>
         方式：以電子方式處理，全程加密傳輸。</p>
      <h3>四、您的權利</h3>
      <p>您可以隨時行使個人資料保護法第 3 條的權利：</p>
      <ul>
        <li>查詢、閱覽、製給複本：「我的 → 隱私 → 下載我的資料」</li>
        <li>補充或更正：「我的 → 個人資料」直接修改</li>
        <li>停止蒐集、處理、利用及刪除：「我的 → 隱私 → 刪除帳號」</li>
      </ul>
      <h3>五、不提供資料的影響</h3>
      <p>姓名與組別是報名與排課表的必要資料；不提供就無法報名活動。賽事報名資料只在報名「代為團體報名」的活動時需要，不填不影響其他功能。其他欄位都是選填。</p>
      <h3>六、安全措施</h3>
      <p>存取控制依職務分級、特權操作留有稽核紀錄、登入權杖只存雜湊值，並設有嘗試次數限制。詳見專案的資訊安全設計說明。</p>
      <h3>七、聯絡方式</h3>
      <p>${esc(PRIVACY.contact)}。</p>
    </section>`}
    ${me && cfg.needConsent ? '<button class="btn block" id="consentBtn">我已閱讀並同意</button>' : ''}`;
  $('#consentBtn')?.addEventListener('click', async () => {
    await api('/me/consent', { method: 'POST' }); cfg.needConsent = false; toast('已同意');
    let back = '#/'; try { back = sessionStorage.getItem('cil-after-consent') || '#/'; sessionStorage.removeItem('cil-after-consent'); } catch {}
    location.hash = back.startsWith('#/privacy') ? '#/' : back;
  });
}

// ---------- 團練列表 ----------
// 首頁的分團篩選（記在這台裝置）
const teamFilter = {
  get() { try { return localStorage.getItem('cil-team') || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem('cil-team', v) : localStorage.removeItem('cil-team'); } catch {} },
};
async function listView() {
  const { events: all } = await api('/events');
  const mine = myTeams();
  let pick = teamFilter.get();
  if (pick && pick !== 'assoc' && !mine.some((t) => t.id === pick)) pick = '';
  const events = !pick ? all : pick === 'assoc' ? all.filter((e) => !e.team_id) : all.filter((e) => e.team_id === pick);
  const next = events[0];
  const [strip, today] = await Promise.all([weekStrip(), todayCard(all)]);
  const chips = mine.length ? `<div class="chipbar" role="tablist" aria-label="依分團篩選">
      <button role="tab" data-tf="" aria-selected="${!pick}">全部</button>
      <button role="tab" data-tf="assoc" aria-selected="${pick === 'assoc'}">全協會</button>
      ${mine.map((t) => `<button role="tab" data-tf="${esc(t.id)}" aria-selected="${pick === t.id}" style="--tc:${esc(t.color)}">${t.icon ? `<img class="ticon xs" src="${esc(t.icon)}" alt="">` : '<i></i>'}${esc(t.name)}</button>`).join('')}
    </div>` : '';
  // 第二次打開以後才提示安裝，不要一進來就打擾
  let visits = 0;
  try {
    visits = Number(localStorage.getItem('cil-visits') || 0);
    if (!sessionStorage.getItem('cil-counted')) { visits += 1; localStorage.setItem('cil-visits', String(visits)); sessionStorage.setItem('cil-counted', '1'); }
  } catch {}
  view.innerHTML = `
    ${largeTitle('團練', todayLabel())}
    ${mfaBanner()}
    ${visits >= 2 ? installCard('home') : ''}
    ${chips}
    <div class="dash"><div style="display:grid;gap:14px">
    ${today}
    ${strip}
    ${next ? heroCard(next) : `<section class="card hero"><span class="sweep"></span><h2>還沒有排定的團練</h2><p class="muted" style="margin:0">幹部發布後，這裡就會出現，也會推播通知你。</p></section>`}
    </div><div style="display:grid;gap:12px">
    <div class="section-h">
      <h2>接下來</h2>
      ${anyTeamAllow('event') ? `<a class="btn ghost sm iconbtn" href="#/new${pick && pick !== 'assoc' ? `?team=${esc(pick)}` : ''}">${IC.plus}新增活動</a>` : ''}
    </div>
    <div class="evgrid">${events.slice(1).map(eventCard).join('') || `<div class="card">${emptyState('calendar', '目前沒有其他排定的活動')}</div>`}</div>
    <a class="tiny center" href="#/past" style="padding:4px">看過去的團練 ›</a>
    </div></div>`;
  for (const b of document.querySelectorAll('[data-tf]')) b.onclick = () => { teamFilter.set(b.dataset.tf); listView(); };
  bindInstall();
  bindStepup();
  flushLogQueue();
  if (!me.mfaPending) Guide.maybeStart();   // 第一次登入：使用說明導覽
}
// 今天：我這組今天的課表、今天報名的活動、一鍵記錄（打開 App 第一眼就知道今天要做什麼）
async function todayCard(events) {
  const t = ymd(new Date()), w = P.currentWeek();
  const plan = (await P.weekPlan(w, me.dist, me.grp)) || [];
  const idx = plan.findIndex((d) => dayDates(w, d.d).includes(t));
  const day = idx >= 0 ? plan[idx] : null;
  const { logs } = await api(`/logs?from=${t}&to=${t}`).catch(() => ({ logs: [] }));
  const done = logs.find((l) => l.status !== 'skip') || logs[0];
  const todays = events.filter((e) => e.date === t && (e.mine === 'in' || e.mine === 'wait'));
  if (!day && !todays.length && !done) return '';
  return `<section class="card todaycard">
    <div class="row spread"><span class="tiny">今天・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組</span>${done ? `<span class="pill solid">${LOG_ICON[done.status]}${LOG_STATUS_NAME[done.status]}</span>` : ''}</div>
    ${day ? (day.kind === 'rest' ? '<h2>今天休息</h2><p class="muted" style="margin:0">好好睡、補充水分，明天再練。</p>'
      : `<h2 class="${day.kind}">${esc(fixText(day.t))}</h2><p class="muted" style="margin:0">${P.KIND_LABEL[day.kind]}${P.paceHint(day.t, me.dist, me.grp) ? `・${P.paceHint(day.t, me.dist, me.grp)}` : ''}</p>`) : ''}
    ${todays.map((e) => `<a class="todayev" href="#/e/${e.id}">${IC.calendar}<span><b>${esc(e.title)}</b><span class="tiny" style="display:block">${e.gather_time ? `${e.gather_time} 集合` : ''}${e.place ? `・${esc(e.place)}` : ''}${e.mine === 'wait' ? '・候補中' : ''}</span></span><span class="tiny">›</span></a>`).join('')}
    ${day && day.kind !== 'rest' ? (done ? `<a class="btn ghost sm" href="#/log?id=${done.id}">看今天的紀錄</a>`
      : `<div class="grid2">${feat('gps') ? `<a class="btn iconbtn" href="#/run" style="justify-content:center">${IC.runner}開始跑步</a>` : ''}<a class="btn ${feat('gps') ? 'ghost ' : ''}iconbtn" href="#/log?w=${w}&i=${idx}" style="justify-content:center${feat('gps') ? '' : ';grid-column:1/-1'}">${IC.check}練完了，記錄</a></div>`) : ''}
  </section>`;
}
// 本週在整季的哪裡：階段、週次進度與三堂重點課
async function weekStrip() {
  const w = P.currentWeek(), info = await P.weekInfo(w);
  const days = await P.weekPlan(w, me.dist, me.grp);
  const key = (days || []).filter((d) => d.kind === 'quality' || d.kind === 'long' || d.kind === 'race').slice(0, 3);
  return `<section class="card weekstrip">
    <div class="row spread">
      <span class="hd"><b>W${w}</b><span class="muted">${info?.phase || ''}${info?.recovery && w !== 21 ? '・恢復週' : ''}</span></span>
      <a class="tiny" href="#/plan">完整課表 ›</a>
    </div>
    <div class="dots" aria-hidden="true">${Array.from({ length: 21 }, (_, i) =>
      `<i class="${i + 1 < w ? 'done' : i + 1 === w ? 'now' : ''}"></i>`).join('')}</div>
    <div class="keys">${key.map((d) => `<div><span class="d">${esc(dayLabel(d.d))}</span><span>${esc(fixText(d.t))} <span class="hint">${P.paceHint(d.t, me.dist, me.grp)}</span></span></div>`).join('')
      || '<div class="muted">這週沒有重點課。</div>'}</div>
  </section>`;
}

function heroCard(e) {
  const d = d2(e.date), days = Math.round((d - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return `<a class="card hero" href="#/e/${e.id}">
    <span class="sweep" aria-hidden="true"></span>
    <div class="row spread">
      <span class="row" style="gap:6px"><span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${KIND_NAME[e.kind]}</span>${e.team_id && teamOf(e.team_id) ? `<span class="pill" style="background:rgba(255,255,255,.14);color:#fff">${esc(teamOf(e.team_id).name)}</span>` : ''}</span>
      <span class="tiny">${days <= 0 ? '就是今天' : days === 1 ? '明天' : `${days} 天後`}</span>
    </div>
    <h2>${esc(e.title)}</h2>
    <p class="muted" style="margin:0">${dstr(e.date)}${e.gather_time ? ` ${e.gather_time} 集合` : ''}${e.place ? `・${esc(e.place)}` : ''}</p>
    <div class="row spread">
      <span class="row" style="gap:8px">${avatarStack(e.peek || [], e.signed)}<span class="tiny">${e.signed} 人報名${e.waiting ? `・候補 ${e.waiting}` : ''}${e.capacity ? `／${e.capacity}` : ''}</span></span>
      ${e.mine === 'in' ? '<span class="pill" style="background:#fff;color:#1C4698">已報名</span>'
        : e.mine === 'wait' ? '<span class="pill wait">候補中</span>' : '<span class="pill" style="background:rgba(255,255,255,.22);color:#fff">去報名 ›</span>'}
    </div>
  </a>`;
}
function eventCard(e) {
  const pct = e.capacity ? Math.min(100, Math.round(e.signed / e.capacity * 100)) : 0;
  return `<a class="card lit" href="#/e/${e.id}">
    <div class="ev">
      <span class="cal"><u>${d2(e.date).getMonth() + 1}月</u><b class="num">${e.date.slice(8)}</b><span>週${WD[d2(e.date).getDay()]}</span></span>
      <span class="body">
        <span class="pills"><span class="pill ${e.kind}">${KIND_NAME[e.kind] || '活動'}</span>${teamTag(teamOf(e.team_id))}${e.visibility === 'invite' ? `<span class="pill lock">${IC.lock}邀請制</span>` : ''}</span>
        <span class="t">${esc(e.title)}</span>
        <span class="tiny">${e.gather_time ? `${e.gather_time}　` : ''}${esc(e.place || '')}${(e.options || []).some((o) => o.price) ? `　${money(Math.min(...e.options.filter((o) => o.price).map((o) => o.price)))} 起` : e.fee ? `　${money(e.fee)}` : ''}</span>
        ${e.capacity ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}
      </span>
      <span class="evright">${e.mine === 'in' ? `<span class="mine">${IC.check}已報名</span>` : e.mine === 'wait' ? '<span class="mine wait">候補中</span>' : ''}
        ${e.signed ? `${avatarStack(e.peek || [], e.signed)}<span class="tiny num">${e.signed}${e.capacity ? `/${e.capacity}` : ' 人'}</span>` : ''}</span>
    </div>
  </a>`;
}
async function pastView(month) {
  month ||= new Date().toISOString().slice(0, 7);
  const { events } = await api(`/events?past=1&month=${month}`);
  const shift = (n) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const isNow = month >= new Date().toISOString().slice(0, 7);
  view.innerHTML = `${largeTitle('過去的團練')}
    <div class="monthbar"><button class="btn ghost sm" data-m="${shift(-1)}" aria-label="上個月">‹</button>
      <input type="month" id="pm" value="${month}" max="${new Date().toISOString().slice(0, 7)}">
      <button class="btn ghost sm" data-m="${shift(1)}" aria-label="下個月" ${isNow ? 'disabled' : ''}>›</button></div>
    <div class="evgrid">${events.map(eventCard).join('') || `<div class="card">${emptyState('calendar', '這個月沒有紀錄')}</div>`}</div>`;
  for (const b of document.querySelectorAll('[data-m]')) b.onclick = () => pastView(b.dataset.m);
  $('#pm').onchange = (e) => e.target.value && pastView(e.target.value);
}

// ---------- 活動詳情 ----------
async function eventView(id) {
  // 從邀請連結進來：先把自己加進受邀名單
  const tok = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  if (tok) {
    try { await api(`/events/${id}/accept`, { method: 'POST', body: { t: tok } }); } catch (e) { toast(e.message); }
    history.replaceState(null, '', `#/e/${id}`);
  }
  const ev = await api(`/events/${id}`);
  const inviteOnly = ev.visibility === 'invite';
  const admin = ev.manage;
  const survey = ev.kind === 'survey', qs = ev.questions || [];
  const useForm = ev.kind === 'party' || qs.length > 0 || (ev.options || []).length > 0 || !!ev.group_reg;
  const ins = ev.signups.filter((s) => s.status === 'in');
  const waits = ev.signups.filter((s) => s.status === 'wait');
  const mine = ev.signups.find((s) => s.member_id === me.id);
  const closed = !ev.signup_open || ev.status !== 'open' || (ev.deadline && new Date(ev.deadline) < new Date());
  const party = ev.kind === 'party';
  const myTicket = party ? (await api('/my/tickets')).tickets.find((t) => t.event_id === ev.id) : null;
  const seatInfo = party ? await api(`/events/${id}/seats`) : { seats: [], layout: null };
  const seatData = seatInfo.seats;
  const plan = ev.week_no ? await P.weekPlan(ev.week_no, me.dist, me.grp) : null;
  const myDay = plan?.find((d) => new RegExp(dayPattern(ev.date)).test(d.d));

  view.innerHTML = `
    <section class="card hero">
      <div class="row spread">
        <span class="row" style="gap:6px"><span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${KIND_NAME[ev.kind]}</span>${ev.team ? `<a class="pill" style="background:rgba(255,255,255,.14);color:#fff" href="#/t/${esc(ev.team.id)}">${esc(ev.team.name)}</a>` : ''}${inviteOnly ? `<span class="pill" style="background:rgba(255,255,255,.14);color:#fff">${IC.lock}邀請制</span>` : ''}</span>
        <span class="tiny">${survey ? `${dstr(ev.date)} 前` : dstr(ev.date)}</span>
      </div>
      <h2>${esc(ev.title)}</h2>
      <p class="muted" style="margin:0">${ev.gather_time ? `${ev.gather_time} 集合` : ''}${ev.end_time ? `－${ev.end_time}` : ''}${ev.place ? `　${esc(ev.place)}` : ''}${ev.lead ? `　帶團：${esc(ev.lead)}` : ''}</p>
      ${(ev.options || []).length ? `<div class="pricechips">${ev.options.map((o) => `<span><b>${esc(o.name)}</b>${o.price ? `<span class="num">${money(o.price)}</span>` : ''}</span>`).join('')}</div>`
        : ev.fee ? `<div class="pricechips"><span><b>費用</b><span class="num">${money(ev.fee)}</span></span></div>` : ''}
      ${ev.group_reg ? '<p class="tiny" style="margin:0;color:rgba(255,255,255,.85)">由幹部代為團體報名</p>' : ''}
      ${ev.note ? `<p class="muted" style="margin:0;white-space:pre-wrap">${esc(ev.note)}</p>` : ''}
      ${ev.link_url ? `<a class="btn block" style="background:#fff;color:#1C4698" href="${esc(ev.link_url)}" target="_blank" rel="noopener">${esc(ev.link_label || '前往登記')} ${IC.external}</a>` : ''}
      ${inviteOnly && !admin ? '' : `<div class="row sharebar">
        <button class="btn sm glassbtn" id="shareEv"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/></svg>分享</button>
        <a class="btn sm glassbtn" id="shareLine" href="#" rel="noopener">分享到 LINE</a>
        <button class="btn sm glassbtn" id="copyLink">${inviteOnly ? '複製邀請連結' : '複製報名連結'}</button>
        ${admin ? `<a class="btn sm glassbtn" href="#/e/${ev.id}/stats">統計 ›</a>` : ''}
      </div>`}
    </section>
    ${inviteOnly && admin ? inviteCard(ev) : ''}

    ${myDay ? `<section class="card">
      <div class="row spread"><h3>你這天的課表</h3><span class="pill">${me.dist === 'hm' ? '半馬' : '全馬'} ${me.grp} 組</span></div>
      <div class="day ${myDay.kind}">
        <span class="dl"><span>${esc(myDay.d)}</span><span class="k">${P.KIND_LABEL[myDay.kind]}</span></span>
        <span class="t">${esc(myDay.t)} <span class="hint">${P.paceHint(myDay.t, me.dist, me.grp)}</span></span>
      </div></section>` : ''}
    ${ev.plan_text ? `<section class="card"><h3>課表</h3><pre class="out">${esc(ev.plan_text)}</pre></section>` : ''}

    ${party && myTicket ? ticketCard(myTicket, ev) : ''}

    <section class="card">
      <div class="row spread">
        <h3>${survey ? '已回覆' : '報名'} ${ins.length}${ev.capacity ? ` / ${ev.capacity}` : ''} 人</h3>
        ${mine && mine.status !== 'cancel'
          ? `<button class="btn danger sm" id="cancel">${survey ? '撤回回覆' : '取消報名'}</button>`
          : closed ? `<span class="tiny">${survey ? '問卷已截止' : '未開放報名'}</span>` : (useForm ? '' : `<button class="btn sm" id="signup">我要報名</button>`)}
      </div>
      ${useForm && !closed ? signupForm(ev, mine && mine.status !== 'cancel') : ''}
      ${party && (ev.fee || ev.guest_max || ev.meal_options) ? `<p class="tiny">${ev.fee ? `費用 ${ev.fee} 元　` : ''}${ev.guest_max ? `可攜伴 ${ev.guest_max} 位　` : ''}${ev.meal_options ? `餐點：${esc(ev.meal_options)}` : ''}</p>` : ''}
      ${mine?.status === 'wait' ? '<p class="notice" style="margin:0">你在候補名單，有人取消會自動遞補並通知你。</p>' : ''}
      ${mine && mine.status !== 'cancel' && (ev.fee || ev.myAttended) ? `<div class="row" style="gap:6px">${ev.fee ? `<span class="pill ${ev.myPaid === 'paid' ? 'solid' : ev.myPaid === 'unpaid' ? 'wait' : ''}">費用 ${ev.fee} 元・${PAID_NAME[ev.myPaid] || '未繳'}</span>` : ''}${ev.myAttended ? `<span class="pill solid">${IC.check}已出席</span>` : ''}</div>` : ''}
      <div class="roster">
        ${ins.map((s) => `<div class="r">${avatar(s)}<span>${esc(s.name)}${s.note ? ` <span class="tiny">${esc(s.note)}</span>` : ''}</span><span class="pill">${esc(s.grp)}</span></div>`).join('')
          || '<p class="muted" style="margin:0">還沒有人報名，當第一個吧。</p>'}
        ${waits.map((s) => `<div class="r">${avatar(s)}<span>${esc(s.name)}</span><span class="pill wait">候補</span></div>`).join('')}
      </div>
      ${admin ? '<button class="btn ghost sm" id="copyRoster">複製名單</button>' : ''}
    </section>

    ${party ? Party.seatSection(seatData, seatInfo.layout) : ''}
    ${party && ev.checkin ? await partyAdmin(ev) : ''}

    ${admin ? `<section class="card">
      <div class="row spread"><h3>管理</h3><span class="tiny">${ev.team ? `${esc(ev.team.name)}的活動` : '全協會活動'}</span></div>
      <div class="row">
        <a class="btn sm" href="#/e/${ev.id}/stats">報名統計${qs.length ? '與問卷' : ''}</a>
        <a class="btn ghost sm" href="#/edit/${ev.id}">編輯</a>
        <a class="btn ghost sm" href="#/new?from=${ev.id}">複製成新活動</a>
        ${ev.group_reg ? `<a class="btn sm" href="/api/events/${ev.id}/registrations.csv" download>下載團體報名資料</a>` : ''}
        <button class="btn danger sm" id="del">刪除</button>
      </div>
      ${party || survey ? '' : `<details id="attendWrap" ${ev.attendToken ? 'open' : ''}><summary class="tiny" style="cursor:pointer">現場報到 QR（團員自己掃）</summary>
        ${ev.attendToken ? `<div class="qrbox" id="attendQR"></div><p class="tiny center" style="margin:0">請團員用手機相機掃描，登入後就完成報到；沒報名的人掃了會自動加入。只在活動當天有效。</p>
          <div class="row"><button class="btn ghost sm" id="attendRotate">換一組 QR</button><button class="btn ghost sm" id="attendOff">關閉</button></div>`
          : '<button class="btn sm" id="attendOn">開啟現場報到 QR</button>'}
      </details>`}
      <details><summary class="tiny" style="cursor:pointer">整批匯入（從 Excel 貼上姓名）</summary>
        <form id="bulkForm" style="display:grid;gap:10px;margin-top:10px">
          <textarea name="names" placeholder="一行一個姓名或暱稱，可以直接從 Excel 複製一整欄貼上" style="min-height:120px"></textarea>
          <div class="row" style="gap:8px"><select name="action" style="width:auto"><option value="signup">代為報名</option><option value="invite">只邀請（邀請制）</option></select>
          <button class="btn sm">匯入</button></div>
          <div id="bulkOut" class="tiny"></div>
        </form>
      </details>
      <details><summary class="tiny" style="cursor:pointer">LINE 公告文字</summary>
        <pre class="out" id="announce">產生中…</pre>
        <button class="btn sm" id="copyAnn">複製公告</button>
      </details>
    </section>` : ''}`;
  // 邀請制：分享出去的一定是帶邀請代碼的連結；沒開邀請連結就提醒先開
  const shareUrl = () => (inviteOnly ? (ev.invite?.token ? `${eventUrl(ev.id)}?t=${ev.invite.token}` : null) : eventUrl(ev.id));
  const attendLink = ev.attendToken ? `${eventUrl(ev.id)}/attend?t=${ev.attendToken}` : '';
  if (attendLink && $('#attendQR')) qrSVG(attendLink, { size: 220, dark: '#0B1B33', light: '#fff' }).then((svg) => { $('#attendQR').innerHTML = svg; }).catch(() => {});
  const setAttend = async (on) => { try { await api(`/events/${ev.id}/attend-token`, { method: 'POST', body: { on } }); eventView(ev.id); } catch (e) { toast(e.message); } };
  $('#attendOn')?.addEventListener('click', () => setAttend(true));
  $('#attendRotate')?.addEventListener('click', () => setAttend(true));
  $('#attendOff')?.addEventListener('click', () => setAttend(false));
  $('#bulkForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/events/${ev.id}/bulk`, { method: 'POST', body: { names: f.names.value, action: f.action.value } });
      $('#bulkOut').innerHTML = `完成 ${r.added} 人。${r.unmatched.length ? `<br>找不到：${r.unmatched.map(esc).join('、')}` : ''}${r.ambiguous.length ? `<br>同名需要手動處理：${r.ambiguous.map(esc).join('、')}` : ''}${r.failed.length ? `<br>沒報成：${r.failed.map(esc).join('、')}` : ''}`;
      if (r.added) toast(`已處理 ${r.added} 人`);
    } catch (err) { toast(err.message); }
  });
  $('#shareEv')?.addEventListener('click', () => (shareUrl() ? shareEvent(ev, shareUrl()) : toast('先在下方「邀請連結」開啟，才能分享')));
  $('#copyLink')?.addEventListener('click', () => (shareUrl() ? copy(shareUrl()) : toast('先在下方「邀請連結」開啟，才能分享')));
  // 分享到 LINE：帶活動摘要（時間、地點、價格）與報名連結，點了直接到報名頁，報名人數自動統計
  $('#shareLine')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!shareUrl()) return toast('先在下方「邀請連結」開啟，才能分享');
    const price = (ev.options || []).length ? ev.options.map((o) => `${o.name}${o.price ? ` ${money(o.price)}` : ''}`).join('／') : ev.fee ? money(ev.fee) : '';
    const text = [`【${KIND_NAME[ev.kind] || '活動'}】${ev.title}`, `${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}` : ''}${ev.place ? `・${ev.place}` : ''}`,
      price ? `費用：${price}` : '', ev.deadline ? `報名截止：${ev.deadline.replace('T', ' ')}` : '', `${ev.kind === 'survey' ? '填寫' : '報名'}：${shareUrl()}`].filter(Boolean).join('\n');
    open(`https://line.me/R/share?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });
  if (inviteOnly && admin) bindInviteCard(ev);

  $('#signup')?.addEventListener('click', async () => {
    try {
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: { name: me.name, grp: me.grp, dist: me.dist } });
      toast(r.status === 'wait' ? '人數已滿，已排入候補' : '報名完成，週四見！'); render();
    } catch (e) { toast(e.message); }
  });
  $('#cancel')?.addEventListener('click', async () => {
    if (!confirm(survey ? '確定撤回回覆？' : '確定取消報名？')) return;
    try { await api(`/events/${id}/signup`, { method: 'DELETE' }); toast('已取消報名'); render(); } catch (e) { toast(e.message); }
  });
  $('#pform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const answers = readQuestionFields(f, qs);
      const miss = qs.find((q) => q.required && (Array.isArray(answers[q.id]) ? !answers[q.id].length : !answers[q.id]));
      if (miss) return toast(`請回答「${miss.label}」`);
      if (ev.group_reg && ev.regProfile !== 'ok') { location.hash = '#/me/reg'; return toast('請先填好賽事報名資料'); }
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: {
        name: me.name, grp: me.grp, dist: me.dist, note: f.note?.value || '', answers,
        option: f.querySelector('[name=option]:checked')?.value || null, reg_consent: !!f.reg_consent?.checked,
        guests: Number(f.guests?.value || 0), meal: f.meal?.value || '' } });
      toast(r.status === 'wait' ? '人數已滿，已排入候補' : survey ? '已送出，謝謝你的回覆' : party ? '報名完成，入場券在上方' : '報名完成'); render();
    } catch (err) { toast(err.message); }
  });
  $('#cform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/events/${id}/checkin`, { method: 'POST', body: { code: f.code.value, seat: f.seat.value } });
      toast(r.already ? `${r.name} 已經報到過了` : `${r.name} 報到完成${r.guests ? `（攜伴 ${r.guests}）` : ''}`);
      f.code.value = ''; render();
    } catch (err) { toast(err.message); }
  });
  for (const b of document.querySelectorAll('[data-ci]')) b.onclick = async () => {
    try { const r = await api(`/events/${id}/checkin`, { method: 'POST', body: { code: b.dataset.ci } }); toast(`${r.name} 報到完成`); render(); }
    catch (err) { toast(err.message); }
  };
  for (const b of document.querySelectorAll('[data-claim]')) b.onclick = async () => {
    try { await api(`/draws/${b.dataset.claim}/claim`, { method: 'POST' }); toast('已確認領獎'); render(); }
    catch (err) { toast(err.message); }
  };
  for (const b of document.querySelectorAll('[data-draw]')) b.onclick = async () => {
    b.disabled = true; b.textContent = '抽獎中…';
    try {
      const r = await api(`/events/${id}/draw`, { method: 'POST', body: { prize_id: b.dataset.draw, count: 1 } });
      toast(`抽出 ${r.prize}：${r.winners.join('、')}`); render();
    } catch (err) { toast(err.message); b.disabled = false; b.textContent = '抽出 1 位'; }
  };
  $('#prizeForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/events/${id}/prizes`, { method: 'POST', body: {
        name: f.name.value, qty: Number(f.qty.value), stage: f.stage.value, sponsor: f.sponsor.value } });
      toast('已新增獎項'); render();
    } catch (err) { toast(err.message); }
  });
  $('#bulkPrize')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api(`/events/${id}/prizes`, { method: 'POST', body: { text: e.target.text.value } }); toast(`已匯入 ${r.added} 項`); render(); }
    catch (err) { toast(err.message); }
  });
  if (party && myTicket) paintQR(ev, myTicket.code);
  if (party && $('#seatCard')) {
    const seated = seatData.filter((s) => s.table_no);
    const show = (t) => { $('#tableDetail').innerHTML = Party.tableList(seated, Number(t));
      for (const b of document.querySelectorAll('.tbl')) b.classList.toggle('on', b.dataset.table === String(t));
      $('#tableDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
    const bindTables = () => { for (const b of document.querySelectorAll('[data-table]')) b.onclick = () => show(b.dataset.table); };
    $('#seatResult').innerHTML = Party.seatResults(seated, '');
    $('#seatQ').oninput = (e) => { $('#seatResult').innerHTML = Party.seatResults(seated, e.target.value); bindTables(); };
    $('#tabSearch').onclick = () => { $('#seatSearch').hidden = false; $('#seatMapWrap').hidden = true;
      $('#tabSearch').setAttribute('aria-pressed', 'true'); $('#tabMap').setAttribute('aria-pressed', 'false'); };
    $('#tabMap').onclick = () => { $('#seatSearch').hidden = true; $('#seatMapWrap').hidden = false;
      $('#tabMap').setAttribute('aria-pressed', 'true'); $('#tabSearch').setAttribute('aria-pressed', 'false'); bindTables(); };
    bindTables();
  }
  $('#openStage')?.addEventListener('click', () => lotteryStage(ev));
  $('#seatForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/events/${id}/seats/assign`, { method: 'POST', body: { seats: [{ code: f.code.value, table_no: Number(f.table_no.value), note: f.note.value }] } });
      toast(r.updated ? '已排桌' : '找不到這個代碼'); f.code.value = ''; render();
    } catch (err) { toast(err.message); }
  });
  $('#copyRoster')?.addEventListener('click', async () => copy((await api(`/events/${id}/roster`)).text));
  $('#del')?.addEventListener('click', async () => {
    if (!confirm('刪除後無法復原，確定刪除這個活動？')) return;
    await api(`/events/${id}`, { method: 'DELETE' }); location.hash = '#/';
  });
  if (admin) {
    const text = await announceText(ev);
    $('#announce').textContent = text;
    $('#copyAnn').onclick = () => copy(text);
  }
}

// 依活動資料組出 LINE 公告（格式照團裡原本的貼文）
async function announceText(ev) {
  const L = [`【${KIND_NAME[ev.kind] || '活動'}】${/\d{1,2}\/\d{1,2}/.test(ev.title) ? '' : `${dstr(ev.date)} `}${ev.title}`];
  L.push(`時間：${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}${ev.end_time ? `–${ev.end_time}` : ''} 集合` : ''}`);
  if (ev.place) L.push(`地點：${ev.place}`);
  if ((ev.options || []).length) L.push(`組別與費用：${ev.options.map((o) => `${o.name}${o.price ? ` ${money(o.price)}` : ''}`).join('／')}`);
  else if (ev.fee) L.push(`費用：${money(ev.fee)}`);
  if (ev.deadline) L.push(`報名截止：${ev.deadline.replace('T', ' ')}`);
  if (ev.lead) L.push(`帶團：${ev.lead}`);
  if (ev.week_no) {
    const info = await P.weekInfo(ev.week_no);
    L.push('', `【全馬組】W${ev.week_no}・${info?.phase || ''}`);
    for (const r of await P.dayByGroup(ev.week_no, 'fm', dayPattern(ev.date))) L.push(`${r.grp}：${r.text}${r.hint ? `　${r.hint}` : ''}`);
    const hm = await P.dayByGroup(ev.week_no, 'hm', dayPattern(ev.date));
    if (hm.length) { L.push('', '【半馬組】'); for (const r of hm) L.push(`${r.grp}：${r.text}${r.hint ? `　${r.hint}` : ''}`); }
    if (info?.src?.startsWith('推估')) L.push('', '（本週課表教練還沒公告，先參考去年同期）');
  } else if (ev.plan_text) { L.push('', ev.plan_text); }
  if (ev.note) L.push('', ev.note);
  if (ev.link_url) L.push('', `${ev.link_label || '登記'}：${ev.link_url}`);
  if (ev.signup_open && ev.visibility !== 'invite') L.push('', `報名：${location.origin}/#/e/${ev.id}`);
  if (ev.signup_open && ev.visibility === 'invite' && ev.invite?.token) L.push('', `報名（邀請連結）：${location.origin}/#/e/${ev.id}?t=${ev.invite.token}`);
  return L.join('\n');
}
const dayPattern = (date) => { const w = d2(date).getDay(); return w === 0 || w === 6 ? '週末|週日' : `週${WD[w]}`; };


// ---------- 通知中心 ----------
async function notificationsView() {
  const { items, next, unread } = await api('/notifications');
  view.innerHTML = `
    ${largeTitle('通知', '', unread ? '<button class="btn ghost sm" id="readAll">全部已讀</button>' : '')}
    <div id="nlist">${items.length ? items.map(notifRow).join('') : `<div class="card">${emptyState('bell', '還沒有通知，新活動與課表發布時會出現在這裡')}</div>`}</div>
    ${next ? '<button class="btn ghost sm block" id="nmore">載入更早的通知</button>' : ''}`;
  let cursor = next;
  $('#nmore')?.addEventListener('click', async (e) => {
    const r = await api(`/notifications?before=${encodeURIComponent(cursor)}`);
    $('#nlist').insertAdjacentHTML('beforeend', r.items.map(notifRow).join(''));
    cursor = r.next; if (!cursor) e.target.remove();
  });
  $('#readAll')?.addEventListener('click', async () => { await api('/notifications/read', { method: 'POST' }); bell(); render(); });
  // 進到通知頁就當作看過了
  if (unread) setTimeout(async () => { await api('/notifications/read', { method: 'POST' }); bell(); }, 1200);
}
const NICON = { event: IC.megaphone, plan: IC.calendar, signup: IC.checkCircle, lottery: IC.gift, system: IC.gear, log: IC.runner };
const notifRow = (n) => `
      <a class="card tight notif ${n.read_at ? '' : 'unread'}" href="${esc(n.url || '#/')}">
        <div class="row" style="gap:12px;align-items:flex-start">
          <span class="nicon" aria-hidden="true">${NICON[n.kind] || '•'}</span>
          <span style="flex:1;min-width:0">
            <b>${esc(n.title)}</b>
            ${n.body ? `<span class="muted" style="display:block">${esc(n.body)}</span>` : ''}
            <span class="tiny">${ago(n.created_at)}</span>
          </span>
        </div>
      </a>`;
function ago(ts) {
  const m = Math.floor((Date.now() - new Date(`${ts.replace(' ', 'T')}Z`)) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小時前`;
  return `${Math.floor(m / 1440)} 天前`;
}
async function bell() {
  try {
    const { unread } = await api('/notifications/count');
    const b = $('#bellCount');
    b.textContent = unread > 99 ? '99+' : unread;
    b.hidden = !unread;
    if (navigator.setAppBadge) (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {});
  } catch {}
}

// ---------- 教練發布課表 ----------
const planTeams = () => teams().filter((t) => allow('plan') || teamAllow(t.id, 'appoint'));
const canPublishPlan = () => allow('plan') || teams().some((t) => teamAllow(t.id, 'appoint'));
async function planNewView() {
  if (!canPublishPlan()) { view.innerHTML = '<div class="card"><p class="muted">只有教練與分團團長可以發布課表。</p></div>'; return; }
  const preset = new URLSearchParams(location.hash.split('?')[1] || '').get('team') || '';
  view.innerHTML = `<section class="card">
    <h2>發布課表</h2>
    <p class="muted" style="margin:0">把 LINE 記事本的課表原文貼進來就好，團員會在通知中心看到，也會收到推播。</p>
    <form id="pf">
      <div class="grid2">
        <label>週次（選填）<input type="number" name="week_no" min="1" max="21" placeholder="例如 10"></label>
        <label>階段（選填）<input name="phase" maxlength="10" placeholder="強化期"></label>
      </div>
      <label>標題<input name="title" required maxlength="40" placeholder="2026 台北馬 W10 課表"></label>
      <label>課表內容<textarea name="body" required style="min-height:220px" placeholder="全馬組&#10;S SUB 2:55~03:00&#10;週一:…"></textarea></label>
      <label>給誰看<select name="team_id">${allow('plan') ? '<option value="">全協會</option>' : ''}${planTeams().map((t) => `<option value="${esc(t.id)}" ${preset === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" name="notify" checked> 發布後通知（選了分團就只通知那個分團）</label>
      <button class="btn block">發布</button>
    </form>
  </section>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/plans', { method: 'POST', body: {
        title: f.title.value, body: f.body.value, phase: f.phase.value, team_id: f.team_id.value || null,
        week_no: f.week_no.value ? Number(f.week_no.value) : null, notify: f.notify.checked } });
      toast('已發布'); location.hash = '#/plan';
    } catch (err) { toast(err.message); }
  };
}


// ---------- 管理介面（RBAC、會籍、座位圖）----------
const MEMBERSHIP_NAME = { none: '跑友', applied: '申請中', active: '協會會員', expired: '會籍到期' };
async function adminView(tab) {
  tab ||= new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'overview';
  if (me.mfaPending) { view.innerHTML = `${largeTitle('管理後台')}${mfaBanner()}`; bindStepup(); return; }
  if (!allow('members') && !allow('roles') && !allow('settings')) { view.innerHTML = '<div class="card"><p class="muted">沒有管理權限。</p></div>'; return; }
  const tabs = [['overview', '總覽'], ['members', '會員'], ['roles', '權限'], ['teams', '分團'], ['events', '活動'], ...(allow('settings') ? [['settings', '系統設定']] : []), ...(allow('audit') ? [['audit', '稽核']] : [])];
  // 只拿統計數字，名單要下條件才查
  const meta = await api('/members?role=officers');
  view.innerHTML = `
    ${largeTitle('管理後台', `${meta.total} 位跑友`)}
    <div class="seg">${tabs.map(([k, v]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${v}</button>`).join('')}</div>
    <div id="panel">${tab === 'overview' ? await overviewPanel()
      : tab === 'members' ? await membersPanel(meta)
      : tab === 'roles' ? rolesPanel(meta)
      : tab === 'teams' ? adminTeamsPanel()
      : tab === 'audit' ? auditPanel()
      : tab === 'settings' ? settingsPanel()
      : await eventsPanel()}</div>`;
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => adminView(b.dataset.tab);
  if (tab === 'overview') bindOverview();
  if (tab === 'members') bindMembers();
  if (tab === 'roles') for (const b of document.querySelectorAll('[data-role]')) b.onclick = () => roleDialog(b.dataset.role, b.dataset.name, b.dataset.cur);
  if (tab === 'teams') bindAdminTeams();
  if (tab === 'audit') bindAudit();
  if (tab === 'events') bindEventsPanel();
  if (tab === 'settings') bindSettings();
}

// 總覽：只有統計數字，不列名單
async function overviewPanel() {
  const o = await api('/admin/overview');
  const months = []; for (let i = 11; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`); }
  const g = Object.fromEntries(o.growth.map((x) => [x.m, x.n]));
  const k = (label, v, sub = '') => `<div class="card kpi"><span class="tiny">${label}</span><b class="num">${v ?? '—'}</b>${sub ? `<span class="tiny">${sub}</span>` : ''}</div>`;
  return `<section class="card" id="pendingTop" hidden></section>
    <section class="kpis">
      ${k('跑友', o.members, `本月新加入 ${o.newThisMonth}`)}${k('30 天內活躍', o.active30, o.members ? `${Math.round(o.active30 / o.members * 100)}%` : '')}
      ${k('協會會員', o.association, `待審核 ${o.applied}・30 天內到期 ${o.expiring}`)}${k('團練出席率', o.attendance == null ? '—' : `${o.attendance}%`, '最近 30 天')}
      ${k('近 30 天活動', o.events30, `接下來 30 天 ${o.upcoming} 場`)}${k('近 30 天報名', o.signups30)}
      ${k('7 天訓練紀錄', o.logs7)}${k('開啟推播', o.pushSubs, '人')}
    </section>
    <section class="card"><h3>每月新加入</h3>${barChart(months.map((m) => ({ l: `${Number(m.slice(5))}月`, v: g[m] || 0 })), { unit: ' 人', h: 120 })}</section>
    <section class="card"><h3>分團人數</h3>${bars(o.teamSizes.map((t) => [t.name, t.n]))}</section>
    ${allow('settings') || (allow('members') && me.role !== 'supervisor') ? `<section class="card"><h3>群發通知</h3>
      <form id="bcForm" class="filters">
        <input name="title" maxlength="60" placeholder="標題，例如：週六團練改到河濱" required>
        <textarea name="body" maxlength="300" placeholder="內容（選填）"></textarea>
        <fieldset class="qset"><legend>對象（不選就是全部跑友）</legend>
          <div class="chips">${teams().map((t) => `<label class="chip"><input type="checkbox" name="teams" value="${esc(t.id)}"><span>${esc(t.name)}</span></label>`).join('')}</div>
          <div class="chips">${Object.entries(ROLE_NAME).filter(([r]) => r !== 'member').map(([r, v]) => `<label class="chip"><input type="checkbox" name="roles" value="${r}"><span>${v}</span></label>`).join('')}
            <label class="chip"><input type="checkbox" name="membership" value="active"><span>協會會員</span></label></div></fieldset>
        <input name="url" placeholder="點通知後開啟的頁面（選填，例如 /#/e/活動代碼）">
        <div class="row"><button type="button" class="btn ghost sm" id="bcCount">算一下人數</button><button class="btn sm">送出</button><span class="tiny" id="bcOut"></span></div>
      </form>
      <p class="tiny" style="margin:0">同時勾分團和身分時，要兩個條件都符合。會寫入稽核紀錄；一小時最多 10 次。</p></section>` : ''}`;
}
function bindOverview() {
  loadPending($('#pendingTop'), { hideEmpty: true });
  const f = $('#bcForm'); if (!f) return;
  const body = () => ({ title: f.title.value, body: f.body.value, url: f.url.value.trim(),
    teams: [...f.querySelectorAll('[name=teams]:checked')].map((x) => x.value), roles: [...f.querySelectorAll('[name=roles]:checked')].map((x) => x.value),
    membership: [...f.querySelectorAll('[name=membership]:checked')].map((x) => x.value) });
  $('#bcCount').onclick = async () => { try { const r = await api('/admin/broadcast', { method: 'POST', body: { ...body(), title: body().title || '試算', dryRun: true } }); $('#bcOut').textContent = `會送給 ${r.count} 人`; } catch (e) { toast(e.message); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { const { count } = await api('/admin/broadcast', { method: 'POST', body: { ...body(), dryRun: true } });
      if (!confirm(`要送出通知給 ${count} 人嗎？`)) return;
      const r = await api('/admin/broadcast', { method: 'POST', body: body() }); toast(`已送出給 ${r.count} 人`); f.reset(); $('#bcOut').textContent = '';
    } catch (err) { toast(err.message); }
  };
}

// 名冊查詢：一律下條件（關鍵字、會籍、身分、分團），一次 50 筆
const memberCache = new Map();
function memberFilterForm(id, { membership = true } = {}) {
  return `<form id="${id}" class="filters">
    <input name="q" placeholder="姓名、暱稱、跑團或會員編號" aria-label="搜尋跑友" autocomplete="off" enterkeyhint="search">
    <div class="grid3">
      ${membership ? `<select name="membership" aria-label="會籍"><option value="">所有會籍</option>${Object.entries(MEMBERSHIP_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>` : ''}
      <select name="role" aria-label="身分"><option value="">所有身分</option><option value="officers">所有幹部</option>${Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select name="team" aria-label="分團"><option value="">所有分團</option><option value="none">未設定主團</option>${teams().map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
    </div>
    <button class="btn sm">查詢</button>
  </form>`;
}
// 綁定查詢表單：結果寫進 listEl，可以「載入更多」
function bindMemberSearch(form, listEl, rowFn, after) {
  let params = null, next = null;
  const load = async (more) => {
    const qs = new URLSearchParams({ ...params, ...(more ? { after: next } : {}) });
    const r = await api(`/members?${qs}`);
    for (const m of r.members) memberCache.set(m.id, m);
    next = r.next;
    const html = r.members.map(rowFn).join('');
    if (more) listEl.querySelector('.more')?.remove();
    if (!more) listEl.innerHTML = r.needFilter ? '<p class="muted" style="margin:0">請輸入至少一個條件。</p>'
      : `<p class="tiny" style="margin:0">符合 ${r.matched} 人</p>${html || '<p class="muted" style="margin:0">沒有符合的跑友</p>'}`;
    else listEl.insertAdjacentHTML('beforeend', html);
    if (next) listEl.insertAdjacentHTML('beforeend', '<button type="button" class="btn ghost sm block more">載入更多</button>');
    listEl.querySelector('.more')?.addEventListener('click', () => load(true));
    after?.();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    params = Object.fromEntries([...new FormData(form)].filter(([, v]) => v));
    load(false).catch((err) => toast(err.message));
  };
  return (p) => { params = p; return load(false); };
}
async function membersPanel(meta) {
  const chips = Object.entries(MEMBERSHIP_NAME).map(([k, v]) => `<span class="pill ${k === 'active' ? 'solid' : k === 'applied' ? 'wait' : ''}">${v} ${meta.counts[k] || 0}</span>`).join('');
  return `
    <section class="card"><div class="row" style="gap:6px">${chips}</div>
      <p class="tiny" style="margin:0">跑友只要加入就能報名團練；協會會員要另外申請與繳費，兩者分開管理。</p></section>
    ${meta.counts.applied ? `<section class="card"><h3>待審核入會（${meta.counts.applied}）</h3><div class="roster" id="appliedList"></div></section>` : ''}
    <section class="card"><h3>查詢跑友</h3>${memberFilterForm('mf2')}<div class="roster" id="mlist"></div></section>
    <div class="bulkbar" id="bulkBar" hidden><span>已選 <b id="bulkN">0</b> 人</span>
      <select id="bulkTeam" aria-label="設定主團">${['<option value="">清除主團</option>', ...teams().filter((t) => !t.self_managed || teamAllow(t.id, 'approve')).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)].join('')}</select>
      <button class="btn sm" id="bulkApply">設為主團</button></div>`;
}
const memberRow = (m) => `<div class="r mrow">
    <label class="pick"><input type="checkbox" data-pick="${m.id}" aria-label="選取 ${esc(m.name)}"><i>${IC.check}</i></label>
    <span><b>${esc(m.name)}</b>${m.nickname ? ` <span class="tiny">${esc(m.nickname)}</span>` : ''}
      <span class="tiny" style="display:block">${esc(m.club || '未填跑團')}・${m.roleName}${(m.teams || []).filter((x) => x.s === 'active').map((x) => `・${esc(teamOf(x.t)?.name || x.t)}`).join('')}${m.member_no ? `・編號 ${esc(m.member_no)}` : ''}${m.paid_until ? `・繳費至 ${esc(m.paid_until)}` : ''}</span></span>
    <span class="mact"><select data-main="${m.id}" aria-label="${esc(m.name)} 的主團" class="mainsel" ${teamOf(m.main_team)?.self_managed && !teamAllow(m.main_team, 'approve') ? 'disabled title="由該團幹部處理"' : ''}>${['<option value="">未設定主團</option>', ...teams().filter((t) => !t.self_managed || teamAllow(t.id, 'approve') || t.id === m.main_team).map((t) => `<option value="${esc(t.id)}" ${m.main_team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`)].join('')}</select>
      <button class="btn ghost sm" data-ms="${m.id}">${MEMBERSHIP_NAME[m.membership]}</button></span>
  </div>`;
function bindMembers() {
  const setMain = async (ids, team) => {
    try { const r = await api('/members/main-team', { method: 'POST', body: { member_ids: ids, team_id: team || null } }); toast(`已設定 ${r.count} 人的主團`); }
    catch (e) { toast(e.message); }
  };
  const syncBulk = () => { const n = document.querySelectorAll('[data-pick]:checked').length; $('#bulkBar').hidden = !n; $('#bulkN').textContent = n; };
  const bind = () => {
    for (const b of document.querySelectorAll('[data-ms]')) b.onclick = () => membershipDialog(b.dataset.ms);
    for (const sel of document.querySelectorAll('[data-main]')) sel.onchange = () => setMain([sel.dataset.main], sel.value);
    for (const c of document.querySelectorAll('[data-pick]')) c.onchange = syncBulk;
  };
  $('#bulkApply').onclick = async () => {
    const ids = [...document.querySelectorAll('[data-pick]:checked')].map((c) => c.dataset.pick);
    await setMain(ids, $('#bulkTeam').value);
    for (const id of ids) { const sel = document.querySelector(`[data-main="${id}"]`); if (sel) sel.value = $('#bulkTeam').value; }
    for (const c of document.querySelectorAll('[data-pick]:checked')) c.checked = false; syncBulk();
  };
  bindMemberSearch($('#mf2'), $('#mlist'), memberRow, bind);
  if ($('#appliedList')) bindMemberSearch(document.createElement('form'), $('#appliedList'), memberRow, bind)({ membership: 'applied' });
}
async function membershipDialog(id) {
  const m = memberCache.get(id), memberTypes = ['一般會員', '永久會員', '贊助會員'];
  if (!m) return;
  $('#msd')?.remove();
  view.insertAdjacentHTML('afterbegin', `<section class="card" id="msd">
    <h3>${esc(m.name)} 的會籍</h3>
    <form id="msf">
      <div class="grid2">
        <label>狀態<select name="membership">${Object.entries(MEMBERSHIP_NAME).map(([k, v]) => `<option value="${k}" ${m.membership === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>會員類別<select name="member_type"><option value="">—</option>${memberTypes.map((t) => `<option ${m.member_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <div class="grid2">
        <label>會員編號<input name="member_no" value="${esc(m.member_no || '')}" maxlength="20"></label>
        <label>入會日期<input type="date" name="joined_on" value="${esc(m.joined_on || '')}"></label>
      </div>
      <div class="grid2">
        <label>會費繳至<input type="date" name="paid_until" value="${esc(m.paid_until || '')}"></label>
        <label>備註<input name="membership_note" value="${esc(m.membership_note || '')}" maxlength="60"></label>
      </div>
      <div class="row"><button class="btn sm">儲存</button><button type="button" class="btn ghost sm" id="msc">取消</button></div>
    </form></section>`);
  $('#msd').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#msc').onclick = () => $('#msd').remove();
  $('#msf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/members/${id}/membership`, { method: 'POST', body: {
        membership: f.membership.value, member_type: f.member_type.value, member_no: f.member_no.value,
        joined_on: f.joined_on.value, paid_until: f.paid_until.value, membership_note: f.membership_note.value } });
      toast('已更新會籍'); adminView('members');
    } catch (err) { toast(err.message); }
  };
}
function rolesPanel(data) {
  const PERM_NAME = { event: '建立活動', plan: '發布課表', checkin: '報到', lottery: '抽獎', roster: '看名冊', members: '會員管理', roles: '指派身分', layout: '座位圖設定' };
  const order = ['chair', 'director', 'supervisor', 'staff', 'coach', 'member'];
  const byRole = {};
  for (const m of data.members) (byRole[m.role] ||= []).push(m);
  return `<section class="card">
      <h3>權限對照</h3>
      <div class="permtable">
        <div class="hd"><span>身分</span>${Object.values(PERM_NAME).map((p) => `<span>${p}</span>`).join('')}</div>
        ${order.map((r) => `<div class="rw"><span>${data.roles[r]}</span>${Object.keys(PERM_NAME).map((p) =>
          `<span>${data.perms[r].includes(p) ? '●' : '·'}</span>`).join('')}</div>`).join('')}
      </div>
      <p class="tiny">監事可以看名冊與會籍，但不能修改。身分由理事長在名冊指派。</p>
    </section>
    ${order.filter((r) => byRole[r]?.length).map((r) => `<section class="card">
      <div class="row spread"><h3>${data.roles[r]}</h3><span class="tiny">${byRole[r].length} 人</span></div>
      <div class="roster">${byRole[r].map((m) => `<div class="r">${avatar(m)}
        <span><b>${esc(m.name)}</b>${m.title ? ` <span class="tiny">${esc(m.title)}</span>` : ''}</span>
        ${allow('roles') ? `<button class="btn ghost sm" data-role="${m.id}" data-name="${esc(m.name)}" data-cur="${m.role}">變更</button>` : ''}</div>`).join('')}</div>
    </section>`).join('')}`;
}
async function eventsPanel() {
  const { events } = await api('/events');
  const parties = events.filter((e) => e.kind === 'party');
  return `<section class="card">
    <h3>座位圖設定</h3>
    <p class="tiny">每年場地不一樣，這裡可以自己排。每行用逗號分隔桌號，空白代表走道或空位。</p>
    ${parties.length ? `<form id="lyf">
      <label>活動<select name="event">${parties.map((e) => `<option value="${e.id}">${esc(e.title)}（${e.date}）</option>`).join('')}</select></label>
      <label>座位佈局<textarea name="rows" style="min-height:150px;font-family:ui-monospace,Menlo,monospace" placeholder="1,2,3,,4,5,
7,8,9,,10,11,6"></textarea></label>
      <div class="grid2">
        <label>上方標示<input name="stage" value="舞台"></label>
        <label>下方標示<input name="foot" placeholder="IBM 產品體驗區 ×7"></label>
      </div>
      <button class="btn block">儲存座位圖</button>
    </form>` : '<p class="muted" style="margin:0">還沒有春酒類型的活動。</p>'}
  </section>`;
}
const AUDIT_NAME = {
  'role.change': '變更身分', 'membership.update': '更新會籍', checkin: '報到', 'lottery.draw': '抽獎', 'lottery.claim': '確認領獎',
  'lottery.undo': '取消中獎', 'event.create': '建立活動', 'event.delete': '刪除活動', 'plan.publish': '發布課表', 'plan.delete': '刪除課表',
  'layout.update': '修改座位圖', 'account.create': '建立帳號', login: '登入', 'join.denied': '邀請碼錯誤', 'bootstrap.chair': '初始理事長',
  'bootstrap.denied': '初始設定被拒', 'privacy.export': '下載個資', 'privacy.delete': '刪除帳號', 'privacy.consent': '同意隱私權政策',
  'settings.org': '修改協會資訊', 'settings.tabs': '修改分頁列名稱', 'settings.features': '修改功能開關', 'settings.docs': '修改協會文件', 'settings.privacy': '修改隱私權政策',
  'settings.club_race': '修改預設倒數', 'settings.race_presets': '修改常用賽事清單', 'event.update': '編輯活動', 'event.export': '匯出報名名單',
  'team.create': '新增分團', 'team.update': '修改分團', 'team.delete': '刪除分團', 'team.join': '加入分團', 'team.leave': '退出分團',
  'team.approve': '通過入團', 'team.reject': '婉拒入團', 'team.remove': '移出分團', 'team.role': '變更分團身分', 'team.add': '加進分團', 'team.icon': '更新分團圖示', 'team.main': '設定主團', 'event.invite': '邀請參加活動', 'event.uninvite': '移出受邀名單', 'event.invite_link': '設定邀請連結',
  'event.invite_accept': '用邀請連結加入', 'review.reminder': '每季權限檢視提醒', 'event.payment': '更新繳費狀態', 'event.attend_token': '設定現場報到', 'event.bulk': '整批匯入',
  'privacy.race_profile': '更新賽事報名資料', 'privacy.race_profile_delete': '刪除賽事報名資料', 'event.reg_export': '下載團體報名資料',
  'calendar.on': '產生行事曆訂閱', 'calendar.off': '停用行事曆訂閱',
  'passkey.add': '新增通行金鑰', 'passkey.remove': '移除通行金鑰', 'passkey.denied': '通行金鑰驗證失敗', 'mfa.verify': '兩步驟驗證', 'login.new_device': '新裝置登入',
  'settings.security': '修改兩步驟驗證設定', 'audit.verify': '稽核完整性檢查',
  'google.link': '綁定 Google', 'login.denied': '登入驗證失敗', 'team.post': '發布分團公告', 'team.post_delete': '刪除分團公告', 'privacy.show_rank': '排行榜設定', broadcast: '群發通知', 'retention.cleanup': '資料保存期限清理', 'event.invite_denied': '邀請連結無效', 'privacy.share_logs': '訓練紀錄分享設定', 'settings.shortcut': '修改捷徑連結',
};
// 稽核紀錄：一定要選時間區間（預設最近 7 天），再依類型、操作者、對象縮小；一次 50 筆
const AUDIT_GROUPS = { '': '所有類型', role: '身分變更', membership: '會籍', team: '分團', event: '活動', checkin: '報到', lottery: '抽獎',
  settings: '系統設定', privacy: '個資', login: '登入', passkey: '通行金鑰', mfa: '兩步驟驗證', account: '帳號', 'join.denied': '邀請碼錯誤', bootstrap: '初始設定', plan: '課表' };
function auditPanel() {
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  return `<section class="card">
    <h3>稽核紀錄</h3>
    <p class="tiny" style="margin:0">所有特權操作都會留下紀錄，應用程式內無法修改或刪除。IP 只存雜湊值。查詢區間最長一年。</p>
    <form id="auf" class="filters">
      <div class="grid2"><label>從<input type="date" name="from" value="${from}" required></label><label>到<input type="date" name="to" value="${to}" required></label></div>
      <div class="grid2">
        <label>類型<select name="action">${Object.entries(AUDIT_GROUPS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>操作者<input name="actor" maxlength="20" placeholder="姓名"></label>
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn ghost sm" data-range="0">今天</button><button type="button" class="btn ghost sm" data-range="6">7 天</button>
        <button type="button" class="btn ghost sm" data-range="29">30 天</button><button type="button" class="btn ghost sm" data-range="89">90 天</button>
        <button class="btn sm" style="margin-left:auto">查詢</button>
      </div>
    </form>
    <div class="audit" id="auList"></div>
  </section>
  <section class="card"><div class="row spread"><h3>完整性檢查</h3><button class="btn ghost sm" id="auVerify">檢查最近 30 天</button></div>
    <p class="tiny" style="margin:0">每筆紀錄都有只有系統知道的簽章，每天再串成一條摘要鏈。有人直接改或刪資料庫裡的紀錄，這裡就會顯示異常。</p>
    <div id="auVerifyOut" class="tiny"></div></section>`;
}
function bindAudit() {
  const f = $('#auf'), list = $('#auList');
  let next = null, params = null;
  const row = (x) => `<div class="arow">
      <span class="num tiny">${esc(x.at.slice(5, 16))}</span>
      <span><b>${esc(AUDIT_NAME[x.action] || x.action)}</b>
        <span class="tiny" style="display:block">${esc(x.actor_name || '未登入')}${x.actor_role ? `（${esc(ROLE_NAME[x.actor_role] || x.actor_role)}）` : ''}${x.detail ? `・${esc(x.detail)}` : ''}</span></span>
    </div>`;
  const load = async (more) => {
    const r = await api(`/audit?${new URLSearchParams({ ...params, ...(more ? { before: next } : {}) })}`);
    next = r.next;
    list.querySelector('.more')?.remove();
    if (!more) list.innerHTML = `<p class="tiny" style="margin:0">${r.from} ～ ${r.to}</p>`;
    list.insertAdjacentHTML('beforeend', r.items.map(row).join('') || (more ? '' : '<p class="muted">這段期間沒有紀錄。</p>'));
    if (next) { list.insertAdjacentHTML('beforeend', '<button class="btn ghost sm block more">載入更早的紀錄</button>'); list.querySelector('.more').onclick = () => load(true); }
  };
  f.onsubmit = (e) => { e.preventDefault(); params = Object.fromEntries([...new FormData(f)].filter(([, v]) => v)); load(false).catch((err) => toast(err.message)); };
  for (const b of f.querySelectorAll('[data-range]')) b.onclick = () => {
    f.to.value = new Date().toISOString().slice(0, 10);
    f.from.value = new Date(Date.now() - Number(b.dataset.range) * 864e5).toISOString().slice(0, 10);
    f.requestSubmit();
  };
  f.requestSubmit();
  $('#auVerify').onclick = async () => {
    $('#auVerifyOut').textContent = '檢查中…';
    try {
      const r = await api('/audit/verify');
      $('#auVerifyOut').innerHTML = `${r.from} ～ ${r.to}：檢查 ${r.checked} 筆${r.unsigned ? `（其中 ${r.unsigned} 筆是功能上線前的舊紀錄，沒有簽章）` : ''}。<br>
        ${r.modified || r.brokenDays.length ? `<b style="color:var(--race)">發現異常：被改動 ${r.modified} 筆${r.brokenDays.length ? `，摘要對不上的日期 ${r.brokenDays.join('、')}` : ''}。請立刻通知理事長與監事。</b>` : `<b>${IC.check} 沒有發現竄改</b>（每日摘要 ${r.days} 天）`}`;
    } catch (e) { $('#auVerifyOut').textContent = e.message; }
  };
}

// 分團管理（理事長、行政人員）：新增分團；細節在各分團頁編輯
// 待審核的入團申請：管理後台的總覽與分團頁共用
async function loadPending(box, { hideEmpty = false } = {}) {
  if (!box) return;
  const { pending, needLead } = await api('/teams/pending').catch(() => ({ pending: [], needLead: [] }));
  if (!box.isConnected) return;
  if (hideEmpty && !pending.length && !needLead.length) { box.hidden = true; return; }
  box.hidden = false;
  const byTeam = (tid) => teamOf(tid);
  box.innerHTML = `<div class="row spread"><h3>待審核的入團申請</h3>${pending.length ? `<span class="pill solid">${pending.length}</span>` : ''}</div>
    ${needLead.map((tid) => `<p class="notice" style="margin:0">${esc(byTeam(tid)?.name || tid)}還沒有團長，申請只能由該團幹部核准。請先到<a href="#/t/${esc(tid)}">分團頁</a>指派團長。</p>`).join('')}
    ${pending.length ? `<div class="roster">${pending.map((r) => `<div class="r">${avatar(r)}
      <span><b>${esc(r.name)}</b>${r.nickname ? ` <span class="tiny">${esc(r.nickname)}</span>` : ''}
        <span class="tiny" style="display:block">申請加入 ${esc(r.team_name)}・${r.dist === 'hm' ? '半馬' : '全馬'} ${esc(r.grp)} 組・${ago(r.created_at)}${r.main_team ? '' : '・還沒有主團，核准後就是主團'}</span></span>
      <span class="row" style="gap:6px"><button class="btn sm" data-pa="approve" data-t="${esc(r.team_id)}" data-m="${esc(r.id)}">核准</button><button class="btn ghost sm" data-pa="remove" data-t="${esc(r.team_id)}" data-m="${esc(r.id)}">婉拒</button></span></div>`).join('')}</div>`
      : '<p class="tiny" style="margin:0">目前沒有待審核的申請。</p>'}`;
  for (const b of box.querySelectorAll('[data-pa]')) b.onclick = async () => {
    if (b.dataset.pa === 'remove' && !confirm('婉拒這筆申請？')) return;
    b.disabled = true;
    try { await api(`/teams/${b.dataset.t}/members`, { method: 'POST', body: { member_id: b.dataset.m, action: b.dataset.pa } }); toast(b.dataset.pa === 'approve' ? '已核准' : '已婉拒'); await refreshMe(); loadPending(box, { hideEmpty }); }
    catch (err) { b.disabled = false; toast(err.message); }
  };
}
function adminTeamsPanel() {
  return `<section class="card" id="pendingBox"><h3>待審核的入團申請</h3><p class="tiny" style="margin:0">載入中…</p></section>
    <section class="card">
      <h3>分團</h3>
      <p class="tiny" style="margin:0">每個分團有自己的團長、幹部與 LINE 群組。團長由理事長在分團頁指派，團長再指派分團幹部。</p>
      <div class="roster">${teams().map((t) => `<a class="r" href="#/t/${esc(t.id)}">${teamIcon(t, 'av')}
        <span><b>${esc(t.name)}</b><span class="tiny" style="display:block">${t.count} 人${t.private ? '・私密' : ''}${t.line_url ? '・已設 LINE 群組' : ''}</span></span><span class="tiny">›</span></a>`).join('')}</div>
    </section>
    ${allow('settings') ? `<section class="card"><h3>新增分團</h3>
      <form id="newTeam">
        <div class="grid2"><label>名稱<input name="name" maxlength="20" required placeholder="例如 耕跑週末團"></label><label>顏色<input type="color" name="color" value="#1C4698"></label></div>
        <button class="btn sm">新增</button>
      </form></section>` : ''}
    <section class="card"><h3>分團權限</h3>
      <div class="permtable">
        <div class="hd"><span>分團身分</span><span>建立活動</span><span>報到</span><span>抽獎</span><span>座位圖</span><span>看名冊</span><span>審核入團</span><span>指派幹部</span></div>
        ${[['lead', '團長'], ['officer', '幹部'], ['member', '團員']].map(([k, v]) => `<div class="rw"><span>${v}</span>${['event', 'checkin', 'lottery', 'layout', 'roster', 'approve', 'appoint'].map((p) => `<span>${TEAM_PERMS[k]?.includes(p) ? '●' : '·'}</span>`).join('')}</div>`).join('')}
      </div>
      <p class="tiny" style="margin:0">分團權限只作用在自己分團的活動；分團名冊不顯示電話。</p></section>`;
}
function bindAdminTeams() {
  loadPending($('#pendingBox'));
  $('#newTeam')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try { const { id } = await api('/teams', { method: 'POST', body: { name: f.name.value, color: f.color.value, join_policy: 'approve' } });
      await refreshMe(); toast('已新增'); location.hash = `#/t/${id}`; } catch (err) { toast(err.message); }
  });
}
function bindEventsPanel() {
  const f = $('#lyf');
  if (!f) return;
  // 載入目前設定
  const load = async () => {
    const { layout } = await api(`/events/${f.event.value}/layout`);
    f.rows.value = (layout?.rows || Party.SEAT_ROWS).map((r) => r.map((x) => x || '').join(',')).join('\n');
    f.stage.value = layout?.stage || '舞台';
    f.foot.value = layout?.foot || '';
  };
  f.event.onchange = load; load();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const rows = f.rows.value.split('\n').map((line) => line.split(',').map((x) => (x.trim() ? Number(x.trim()) : null)));
    try { await api(`/events/${f.event.value}/layout`, { method: 'POST', body: { rows, stage: f.stage.value, foot: f.foot.value } }); toast('已儲存座位圖'); }
    catch (err) { toast(err.message); }
  };
}


// ---------- 系統設定（理事長、行政人員）----------
const FEATURE_NAME = { gps: '跑步記錄（計時＋GPS）', studio: '拍照分享', health: 'Apple 健康匯入', file: 'GPX／TCX 檔匯入', coach: '課表教練', party: '春酒餐敘活動' };
function settingsPanel() {
  const o = org(), f = cfg.settings?.features || {}, docs = cfg.settings?.docs || [], pv = cfg.settings?.privacy || {};
  return `
  <h3 class="sgt">協會</h3>
  <section class="card">
    <h3>協會資訊</h3>
    <form id="orgForm">
      <div class="grid2">
        <label>協會名稱<input name="name" maxlength="40" value="${esc(o.name || '')}" required></label>
        <label>簡稱<input name="short" maxlength="12" value="${esc(o.short || '')}"></label>
      </div>
      <div class="grid2">
        <label>所屬企業<input name="parent" maxlength="30" value="${esc(o.parent || '')}" placeholder="耕建築"></label>
        <label>企業網站<input name="parent_url" type="url" value="${esc(o.parent_url || '')}" placeholder="https://"></label>
      </div>
      <label>企業說明（登入頁與「我的」會顯示）<input name="parent_note" maxlength="80" value="${esc(o.parent_note || '')}" placeholder="耕建築企業支持的跑團"></label>
      <label>入會表單連結<input name="join_form" type="url" value="${esc(o.join_form || '')}" placeholder="https://docs.google.com/forms/…"></label>
      <label>聯絡方式<input name="contact" maxlength="200" value="${esc(o.contact || '')}" placeholder="Email 或 LINE 官方帳號"></label>
      <label>個資保存期限（寫進隱私權政策的文字）<input name="retention" maxlength="200" value="${esc(o.retention || '')}"></label>
      <fieldset class="group"><legend>自動清理（每天 03:00 執行）</legend>
        <div class="grid3">
          <label>活動報名資料保存<select name="event_data_years">${[0, 1, 2, 3, 5].map((y) => `<option value="${y}" ${Number(o.event_data_years || 0) === y ? 'selected' : ''}>${y ? `${y} 年` : '不自動刪除'}</option>`).join('')}</select></label>
          <label>訓練紀錄保存<select name="log_years">${[0, 1, 2, 3, 5].map((y) => `<option value="${y}" ${Number(o.log_years || 0) === y ? 'selected' : ''}>${y ? `${y} 年` : '不自動刪除'}</option>`).join('')}</select></label>
          <label>稽核紀錄保存<select name="audit_years">${[1, 2, 3, 5, 7].map((y) => `<option value="${y}" ${Number(o.audit_years || 3) === y ? 'selected' : ''}>${y} 年</option>`).join('')}</select></label>
        </div>
        <p class="tiny" style="margin:0">活動超過保存年限後，報名、入場券與受邀名單會刪除，中獎紀錄只留獎項不留姓名。過期的登入工作階段、180 天前的通知每天都會清掉。</p>
      </fieldset>
      <button class="btn sm">儲存協會資訊</button>
    </form>
  </section>
  <section class="card">
    <div class="row spread"><h3>協會文件</h3><button class="btn ghost sm" id="addDoc">＋ 新增</button></div>
    <p class="tiny" style="margin:0">章程、組織說明、會費說明等，跑友在「我的 → 協會」看得到。連結要是 https:// 開頭。</p>
    <div id="docRows" class="docedit">${docs.map(docRow).join('')}</div>
    <button class="btn sm" id="saveDocs">儲存文件清單</button>
  </section>
  <h3 class="sgt">功能與畫面</h3>
  <section class="card">
    <h3>功能開關</h3>
    <form id="featForm" class="toggles">
      ${Object.entries(FEATURE_NAME).map(([k, v]) => `<label class="switch"><span>${v}</span><input type="checkbox" name="${k}" ${f[k] !== false ? 'checked' : ''}><i></i></label>`).join('')}
      <button class="btn sm">儲存功能開關</button>
    </form>
    <p class="tiny" style="margin:0">關掉後，跑友的畫面上就看不到這個功能；已存的資料不會刪除。</p>
  </section>
  <section class="card">
    <h3>分頁列名稱</h3>
    <form id="tabsForm" class="grid3">${Object.entries(TAB_DEFAULT).map(([k, v]) => `<label>${v}<input name="${k}" maxlength="4" placeholder="${v}" value="${esc(cfg.settings?.tabs?.[k] || '')}"></label>`).join('')}
      <button class="btn sm" style="grid-column:1/-1">儲存名稱</button></form>
    <p class="tiny" style="margin:0">每個最多 4 個字，留空就用預設。每個人也可以在「我的 → 通知與裝置」選擇只顯示圖示。</p>
  </section>
  <section class="card">
    <h3>倒數與捷徑</h3>
    <form id="clubRace2" class="grid2">
      <label>協會預設賽事<input name="name" maxlength="30" value="${esc(cfg.race && !cfg.race.mine ? cfg.race.name : '')}"></label>
      <label>日期<input type="date" name="date" value="${esc(cfg.race && !cfg.race.mine ? cfg.race.date : '')}"></label>
      <button class="btn ghost sm" style="grid-column:1/-1">儲存預設倒數</button>
    </form>
    <details id="presetBox"><summary class="tiny" style="cursor:pointer">常用賽事清單（團員點右上角倒數就能直接挑）</summary>
      <div id="presetRows" class="docedit" style="margin-top:8px"></div>
      <div class="row" style="gap:8px"><button type="button" class="btn ghost sm" id="presetAdd">${IC.plus}新增一場</button><button type="button" class="btn sm" id="presetSave">儲存清單</button></div>
    </details>
    <form id="scForm2" class="row" style="gap:8px">
      <input name="url" placeholder="Apple 健康捷徑 iCloud 連結" aria-label="Apple 健康捷徑 iCloud 連結" value="${esc(cfg.shortcut || '')}" style="flex:1;min-width:200px">
      <button class="btn ghost sm">儲存捷徑</button>
    </form>
  </section>
  <h3 class="sgt">安全與隱私</h3>
  ${(me.realRole || me.role) === 'chair' ? `<section class="card">
    <h3>幹部兩步驟驗證</h3>
    <label class="switch"><span>幹部要用通行金鑰驗證才能使用管理功能<span class="tiny" style="display:block">理事、監事、行政人員、教練都適用；一般跑友不受影響</span></span>
      <input type="checkbox" id="mfaToggle" ${cfg.requireMfa ? 'checked' : ''}><i></i></label>
    <p class="tiny" style="margin:0">開啟前請先在「我的 → 帳號與安全」新增通行金鑰並驗證一次，也請其他幹部先新增，否則他們會暫時只能用一般跑友的功能。</p>
  </section>` : ''}
  <section class="card">
    <h3>隱私權政策</h3>
    <p class="tiny" style="margin:0">目前版本：${esc(pv.version || '')}。留空就使用系統預設的個資法第 8 條告知內容。<b>內容一改就會自動升版，所有人下次開啟都要重新同意。</b></p>
    <form id="pvForm">
      <textarea name="body" style="min-height:240px" placeholder="## 一、蒐集目的&#10;…&#10;&#10;- 清單項目">${esc(pv.body || '')}</textarea>
      <p class="tiny" style="margin:0">格式：「## 」開頭是標題、「- 」開頭是清單、空一行分段。</p>
      <div class="row"><button class="btn sm">儲存並升版</button><a class="btn ghost sm" href="#/privacy">預覽</a></div>
    </form>
  </section>`;
}
const docRow = (d = {}) => `<div class="drow">
  <input data-k="title" placeholder="文件名稱" maxlength="40" value="${esc(d.title || '')}">
  <input data-k="url" type="url" placeholder="https://" value="${esc(d.url || '')}">
  <input data-k="note" placeholder="說明（選填）" maxlength="80" value="${esc(d.note || '')}">
  <button type="button" class="btn danger sm" data-rmdoc aria-label="移除">移除</button></div>`;
function bindSettings() {
  const reload = async (msg) => { const r = await api('/me'); me = r.member; cfg = r; toast(msg); applyFeatures(); paintCountdown(); adminView('settings'); };
  const save = async (key, body, msg) => { try { await api(`/settings/${key}`, { method: 'POST', body }); await reload(msg); } catch (e) { toast(e.message); } };
  $('#orgForm').onsubmit = (e) => { e.preventDefault(); const f = e.target;
    save('org', { name: f.name.value, short: f.short.value, join_form: f.join_form.value.trim(), contact: f.contact.value, retention: f.retention.value,
      parent: f.parent.value, parent_url: f.parent_url.value.trim(), parent_note: f.parent_note.value,
      event_data_years: Number(f.event_data_years.value), log_years: Number(f.log_years.value), audit_years: Number(f.audit_years.value) }, '已儲存協會資訊'); };
  $('#mfaToggle')?.addEventListener('change', async (e) => {
    try { await api('/settings/security', { method: 'POST', body: { require_mfa: e.target.checked } }); await reload(e.target.checked ? '已開啟幹部兩步驟驗證' : '已關閉幹部兩步驟驗證'); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
  });
  $('#tabsForm').onsubmit = (e) => { e.preventDefault(); const f = e.target;
    save('tabs', Object.fromEntries(Object.keys(TAB_DEFAULT).map((k) => [k, f[k].value.trim()])), '已儲存分頁列名稱'); };
  $('#featForm').onsubmit = (e) => { e.preventDefault(); const f = e.target, body = {};
    for (const k of Object.keys(FEATURE_NAME)) body[k] = f[k].checked;
    save('features', body, '已儲存功能開關'); };
  const bindRm = () => { for (const b of document.querySelectorAll('[data-rmdoc]')) b.onclick = () => b.closest('.drow').remove(); };
  bindRm();
  $('#addDoc').onclick = () => { $('#docRows').insertAdjacentHTML('beforeend', docRow()); bindRm(); };
  $('#saveDocs').onclick = () => {
    const docs = [...document.querySelectorAll('.drow')].map((r) => Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()])))
      .filter((d) => d.title || d.url);
    if (docs.some((d) => !/^https:\/\//.test(d.url) || !d.title)) return toast('每份文件都要有名稱，連結要是 https:// 開頭');
    save('docs', { docs }, '已儲存文件清單');
  };
  $('#pvForm').onsubmit = (e) => { e.preventDefault();
    if (!confirm('儲存後政策會升版，所有人下次開啟都要重新同意。確定嗎？')) return;
    save('privacy', { body: e.target.body.value, bump: true }, '已儲存隱私權政策'); };
  $('#clubRace2').onsubmit = async (e) => { e.preventDefault(); const f = e.target;
    try { await api('/settings/club-race', { method: 'POST', body: { name: f.name.value, date: f.date.value } }); await reload('已更新預設倒數'); } catch (err) { toast(err.message); } };
  // 常用賽事清單
  const presetRow = (p = {}) => `<div class="drow"><input data-k="name" placeholder="比賽名稱" maxlength="40" aria-label="比賽名稱" value="${esc(p.name || '')}">
    <input data-k="date" type="date" aria-label="比賽日期" value="${esc(p.date || '')}"><input data-k="dist" placeholder="全馬／半馬／10K" maxlength="10" aria-label="距離" value="${esc(p.dist || '')}">
    <button type="button" class="btn danger sm" data-rmpre>移除</button></div>`;
  const bindPre = () => { for (const b of document.querySelectorAll('[data-rmpre]')) b.onclick = () => b.closest('.drow').remove(); };
  $('#presetBox').addEventListener('toggle', async (e) => {
    if (!e.target.open || $('#presetRows').dataset.loaded) return;
    const r = await api('/races'); $('#presetRows').dataset.loaded = '1';
    $('#presetRows').innerHTML = r.presets.map(presetRow).join(''); bindPre();
  });
  $('#presetAdd').onclick = () => { $('#presetRows').insertAdjacentHTML('beforeend', presetRow()); bindPre(); };
  $('#presetSave').onclick = async () => {
    const presets = [...document.querySelectorAll('#presetRows .drow')].map((r) => Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()]))).filter((p) => p.name || p.date);
    if (presets.some((p) => !p.name || !p.date)) return toast('每一場都要有名稱和日期');
    try { const r = await api('/settings/race-presets', { method: 'POST', body: { presets } }); toast(`已儲存 ${r.presets.length} 場`); } catch (err) { toast(err.message); }
  };
  $('#scForm2').onsubmit = async (e) => { e.preventDefault();
    try { await api('/settings/shortcut', { method: 'POST', body: { url: e.target.url.value.trim() } }); await reload('已儲存捷徑連結'); } catch (err) { toast(err.message); } };
}

// ---------- 名冊與角色 ----------
async function rosterView() {
  view.innerHTML = `
    ${largeTitle('團員名冊', '輸入條件查詢')}
    <section class="card">${memberFilterForm('rf2', { membership: false })}<div class="roster" id="rlist"></div></section>`;
  const row = (m) => `<div class="r">${avatar(m)}
      <span>${esc(m.name)}${m.title ? ` <span class="tiny">${esc(m.title)}</span>` : ''}
        <span class="tiny" style="display:block">${esc(m.roleName)}・${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)} 組</span></span>
      ${allow('roles') ? `<button class="btn ghost sm" data-role="${m.id}" data-name="${esc(m.name)}" data-cur="${m.role}">變更</button>` : ''}
    </div>`;
  bindMemberSearch($('#rf2'), $('#rlist'), row, () => {
    for (const b of document.querySelectorAll('[data-role]')) b.onclick = () => roleDialog(b.dataset.role, b.dataset.name, b.dataset.cur);
  })({ role: 'officers' });
}
function roleDialog(id, name, cur) {
  const opts = Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
  $('#rd')?.remove();
  view.insertAdjacentHTML('afterbegin', `<section class="card" id="rd">
    <h3>變更 ${esc(name)} 的身分</h3>
    <form id="rf">
      <label>身分<select name="role">${opts}</select></label>
      <label>職稱（選填）<input name="title" maxlength="12" placeholder="例如 副理事長、活動組長"></label>
      <div class="row"><button class="btn sm">儲存</button><button type="button" class="btn ghost sm" id="rc">取消</button></div>
    </form>
  </section>`);
  $('#rd').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#rc').onclick = () => $('#rd').remove();
  $('#rf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/members/${id}/role`, { method: 'POST', body: { role: e.target.role.value, title: e.target.title.value } }); toast('已更新'); render(); }
    catch (err) { toast(err.message); }
  };
}

// ---------- 春酒：入場券、報到、抽獎 ----------
// ---------- 邀請制：受邀名單與邀請連結 ----------
const VIA_NAME = { manual: '個別邀請', team: '分團', link: '邀請連結' };
function inviteCard(ev) {
  const link = ev.invite?.token ? `${eventUrl(ev.id)}?t=${ev.invite.token}` : '';
  const teamOpts = teams().filter((t) => teamAllow(t.id, 'roster'));
  return `<section class="card" id="invCard">
    <div class="row spread"><h3 class="row" style="gap:6px">${IC.lock}受邀名單</h3><span class="tiny"><b class="num">${ev.invite?.count || 0}</b> 人受邀</span></div>
    <p class="tiny" style="margin:0">只有名單上的人看得到這個活動。移出名單會一併取消他的報名與入場券。</p>
    <form id="invSearch" class="row" style="gap:8px" role="search"><input name="q" placeholder="搜尋姓名或暱稱邀請" aria-label="搜尋要邀請的人" style="flex:1" autocomplete="off"><button class="btn ghost sm">搜尋</button></form>
    <div class="roster" id="invHits"></div>
    ${teamOpts.length ? `<form id="invTeam" class="row" style="gap:8px"><select name="team" style="flex:1">${teamOpts.map((t) => `<option value="${esc(t.id)}">整個${esc(t.name)}（${t.count} 人）</option>`).join('')}</select><button class="btn ghost sm">邀請整團</button></form>` : ''}
    <div class="invlink">
      <div class="row spread"><b>邀請連結</b><label class="switch" style="border:0;padding:0"><input type="checkbox" id="invLinkOn" ${link ? 'checked' : ''}><i></i></label></div>
      ${link ? `<div class="row" style="gap:8px"><input readonly value="${esc(link)}" aria-label="邀請連結" style="flex:1;font-size:13px" onfocus="this.select()">
        <button class="btn sm" id="invCopy">複製</button></div>
        <div class="row" style="gap:8px"><button class="btn ghost sm" id="invRotate">重新產生（舊連結失效）</button></div>`
        : '<p class="tiny" style="margin:0">打開後會產生一條連結，拿到連結的人登入就自動加入受邀名單；不想再讓人加入時關掉即可。</p>'}
    </div>
    <details id="invListWrap"><summary class="tiny" style="cursor:pointer">看受邀名單</summary><div class="roster" id="invList"><p class="muted">載入中…</p></div></details>
  </section>`;
}
function bindInviteCard(ev) {
  const reload = () => eventView(ev.id);
  const add = async (body, msg) => { try { const r = await api(`/events/${ev.id}/invites`, { method: 'POST', body }); toast(r.added ? `${msg}（新增 ${r.added} 人，已通知）` : '他們都已經在名單上'); reload(); } catch (e) { toast(e.message); } };
  $('#invSearch').onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return toast('請輸入姓名');
    // 協會幹部從全體名冊找；分團幹部從自己分團找
    const r = allow('roster') ? await api(`/members?q=${encodeURIComponent(q)}`)
      : ev.team_id ? await api(`/teams/${ev.team_id}/members?q=${encodeURIComponent(q)}`) : { members: [] };
    $('#invHits').innerHTML = r.members.map((m) => `<div class="r">${avatar(m)}<span>${esc(m.name)}${m.nickname ? ` <span class="tiny">${esc(m.nickname)}</span>` : ''}</span>
      <button class="btn ghost sm" data-inv="${m.id}">邀請</button></div>`).join('') || '<p class="muted" style="margin:0">找不到</p>';
    for (const b of document.querySelectorAll('[data-inv]')) b.onclick = () => add({ member_ids: [b.dataset.inv] }, '已邀請');
  };
  $('#invTeam')?.addEventListener('submit', (e) => { e.preventDefault(); add({ team_id: e.target.team.value }, '已邀請整團'); });
  const setLink = async (on) => { try { await api(`/events/${ev.id}/invite-link`, { method: 'POST', body: { on } }); toast(on ? '邀請連結已開啟' : '邀請連結已關閉'); reload(); } catch (e) { toast(e.message); } };
  $('#invLinkOn').onchange = (e) => setLink(e.target.checked);
  $('#invRotate')?.addEventListener('click', () => confirm('重新產生後，舊的邀請連結會失效。確定？') && setLink(true));
  $('#invCopy')?.addEventListener('click', () => copy(`${ev.invite?.token ? `${eventUrl(ev.id)}?t=${ev.invite.token}` : ''}`));
  $('#invListWrap').ontoggle = async (e) => {
    if (!e.target.open) return;
    const { invites } = await api(`/events/${ev.id}/invites`);
    $('#invList').innerHTML = invites.map((m) => `<div class="r">${avatar(m)}
      <span>${esc(m.name)}<span class="tiny" style="display:block">${VIA_NAME[m.via] || ''}${m.status === 'in' ? '・已報名' : m.status === 'wait' ? '・候補' : ''}</span></span>
      <button class="btn danger sm" data-uninv="${m.id}" data-name="${esc(m.name)}">移出</button></div>`).join('') || '<p class="muted" style="margin:0">還沒有邀請任何人</p>';
    for (const b of document.querySelectorAll('[data-uninv]')) b.onclick = async () => {
      if (!confirm(`把 ${b.dataset.name} 移出受邀名單？他的報名與入場券也會取消。`)) return;
      try { await api(`/events/${ev.id}/invites/${b.dataset.uninv}`, { method: 'DELETE' }); toast('已移出'); reload(); } catch (err) { toast(err.message); }
    };
  };
}

// 報名表：春酒的攜伴與餐點、活動自訂問卷；基本資料一律帶入「我的」設定
function signupForm(ev, mine) {
  const party = ev.kind === 'party', survey = ev.kind === 'survey';
  const meals = party ? (ev.meal_options || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  return `<form id="pform" class="signup">
    ${!survey ? `<p class="tiny" style="margin:0">以 ${esc(me.name)}${me.nickname ? `（${esc(me.nickname)}）` : ''}・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組報名，<a href="#/me/profile">修改個人資料</a></p>` : ''}
    ${party && ev.guest_max ? `<label>攜伴人數<select name="guests">${Array.from({ length: ev.guest_max + 1 }, (_, i) => `<option value="${i}">${i ? `${i} 位` : '不帶'}</option>`).join('')}</select></label>` : ''}
    ${meals.length ? `<label>餐點<select name="meal">${meals.map((m) => `<option ${m === me.meal_pref ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : ''}
    ${(ev.options || []).length ? `<fieldset class="qset"><legend>報名組別 <span class="req">必填</span></legend><div class="chips">${ev.options.map((o) => `<label class="chip"><input type="radio" name="option" value="${esc(o.name)}" ${ev.myOption === o.name ? 'checked' : ''} required><span>${esc(o.name)}${o.price ? `<small class="num">　${money(o.price)}</small>` : ''}</span></label>`).join('')}</div></fieldset>` : ''}
    ${ev.group_reg ? (ev.regProfile === 'ok'
      ? `<label class="inline consent"><input type="checkbox" name="reg_consent" ${ev.myRegConsent ? 'checked' : ''} required> 同意把我的賽事報名資料（含身分證字號）提供給主辦幹部，只用於這場的團體報名</label>`
      : `<p class="notice" style="margin:0">這場由幹部代為團體報名，需要你的報名資料（姓名、身分證字號、生日、緊急聯絡人等）。填一次之後每場都能用。<a href="#/me/reg">去填寫 ›</a></p>`) : ''}
    ${questionFields(ev.questions || [], ev.myAnswers || {})}
    ${survey ? '' : `<label>備註（選填）<input name="note" maxlength="40" placeholder="${party ? '素食、座位需求…' : '晚到、只跑前半段…'}"></label>`}
    <button class="btn block">${survey ? (mine ? '更新回覆' : '送出回覆') : mine ? '更新報名' : '我要報名'}</button>
  </form>`;
}
function questionFields(qs, ans) {
  return qs.map((q) => {
    const v = ans[q.id], req = q.required ? '<span class="req">必填</span>' : '';
    if (q.type === 'text') return `<label>${esc(q.label)} ${req}<input data-q="${esc(q.id)}" maxlength="300" value="${esc(v || '')}" ${q.required ? 'required' : ''}></label>`;
    const multi = q.type === 'multi';
    return `<fieldset class="qset"><legend>${esc(q.label)} ${req}${multi ? '<span class="tiny">可複選</span>' : ''}</legend>
      <div class="chips">${q.options.map((o) => `<label class="chip"><input type="${multi ? 'checkbox' : 'radio'}" name="q_${esc(q.id)}" value="${esc(o)}"
        ${(multi ? (v || []).includes(o) : v === o) ? 'checked' : ''} ${!multi && q.required ? 'required' : ''}><span>${esc(o)}</span></label>`).join('')}</div></fieldset>`;
  }).join('');
}
function readQuestionFields(form, qs) {
  const out = {};
  for (const q of qs) {
    if (q.type === 'text') { out[q.id] = form.querySelector(`[data-q="${CSS.escape(q.id)}"]`)?.value.trim() || ''; continue; }
    const picked = [...form.querySelectorAll(`input[name="q_${CSS.escape(q.id)}"]:checked`)].map((i) => i.value);
    out[q.id] = q.type === 'multi' ? picked : picked[0];
  }
  return out;
}
function ticketCard(t, ev, title = '我的入場券') {
  return `<section class="card ticket">
    <div class="row spread"><h3>${esc(title)}</h3>${t.checked_in_at ? '<span class="pill solid">已報到</span>' : '<span class="pill">未報到</span>'}</div>
    <div class="qrbox" ${title === '我的入場券' ? 'id="qrBox"' : ''} data-code="${esc(t.code)}" data-ev="${esc(ev.id)}"></div>
    <div class="code num">${esc(t.code)}</div>
    <div class="trow">
      <span><u>桌次</u>${t.table_no ? `第 ${t.table_no} 桌` : '未排桌'}</span>
      <span><u>餐點</u>${t.meal ? esc(t.meal) : '—'}</span>
      <span><u>攜伴</u>${t.guests || 0} 位</span>
    </div>
    <p class="tiny center">入場時出示這個 QR Code，工作人員掃描即可報到</p>
  </section>`;
}
async function paintQR(ev, code) {
  const box = $('#qrBox');
  if (!box) return;
  try { box.innerHTML = await qrSVG(`${location.origin}/#/e/${ev.id}/in/${code}`, { size: 200, dark: '#0B1B33', light: '#fff' }); }
  catch { box.innerHTML = '<p class="tiny">QR 產生失敗，請用下方代碼報到</p>'; }
}

// 現場自助報到：掃主辦人出示的 QR 進來
async function attendView(id) {
  const t = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  view.innerHTML = '<p class="loading">報到中…</p>';
  try {
    const r = await api(`/events/${id}/attend`, { method: 'POST', body: { t } });
    history.replaceState(null, '', `#/e/${id}/attend`);
    view.innerHTML = `<section class="card ok attendok"><span class="big">${IC.checkCircle}</span><h2>報到完成</h2>
      <p class="muted" style="margin:0">${r.walkIn ? '你原本沒有報名，已經幫你加入名單。' : '今天也辛苦了，練完記得記錄訓練。'}</p>
      <a class="btn block" href="#/e/${esc(id)}">回活動頁</a><a class="btn ghost block" href="#/plan">記錄今天的訓練</a></section>`;
  } catch (e) {
    view.innerHTML = `<section class="card"><h2>報到沒有成功</h2><p class="muted">${esc(e.message)}</p><a class="btn ghost block" href="#/e/${esc(id)}">回活動頁</a></section>`;
  }
}

// 我的入場券：所有即將到來的入場券集中在一頁（主畫面捷徑直達，離線也能出示）
async function ticketsView() {
  const { tickets } = await api('/my/tickets');
  view.innerHTML = `${largeTitle('我的入場券', tickets.length ? '入場時把 QR Code 給工作人員掃描' : '')}
    ${tickets.map((t) => `${ticketCard(t, { id: t.event_id }, t.title)}<p class="tiny center" style="margin:-6px 0 8px">${dstr(t.date)}${t.gather_time ? ` ${t.gather_time}` : ''}${t.place ? `・${esc(t.place)}` : ''}　<a href="#/e/${esc(t.event_id)}">活動頁 ›</a></p>`).join('')
      || `<div class="card">${emptyState('calendar', '目前沒有入場券。報名春酒等需要入場的活動後，入場券會出現在這裡。')}</div>`}`;
  for (const box of document.querySelectorAll('.qrbox[data-code]')) {
    try { box.innerHTML = await qrSVG(`${location.origin}/#/e/${box.dataset.ev}/in/${box.dataset.code}`, { size: 200, dark: '#0B1B33', light: '#fff' }); }
    catch { box.innerHTML = '<p class="tiny">QR 產生失敗，請用下方代碼報到</p>'; }
  }
}

// 安裝到主畫面：iPhone 要手動「分享 → 加入主畫面」，Android／桌機用瀏覽器的安裝提示
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SHARE_IC = ic('<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/>');
const ADD_IC = ic('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>');
function installCard(where) {
  if (isStandalone()) return '';
  try { if (where === 'home' && localStorage.getItem('cil-install-dismiss')) return ''; } catch {}
  const ios = isIOS();
  return `<section class="card tight installcard">
    <div class="instrow"><img src="/icons/icon-192.png" alt="" width="40" height="40">
      <span><b>把耕跑團加到主畫面</b><span class="tiny">才收得到團練通知，入場券沒網路也能出示</span></span>
      ${where === 'home' ? '<button class="iconx" id="installX" aria-label="不再顯示">' + ic('<path d="M7 7l10 10M17 7 7 17"/>') + '</button>' : ''}</div>
    ${ios ? `<details ${where === 'me' ? 'open' : ''}><summary class="tiny">怎麼加？三個步驟</summary><ol class="steps">
        <li>點 Safari 下方的分享按鈕 ${SHARE_IC}</li>
        <li>往下滑，選「加入主畫面」${ADD_IC}</li>
        <li>按「新增」，之後從主畫面的耕跑團圖示打開</li></ol>
        <p class="tiny" style="margin:0">在 LINE 裡打開的話，先點右下角選單選「用預設瀏覽器開啟」。</p></details>`
      : `<button class="btn sm block" data-install ${installEvt ? '' : 'hidden'}>安裝 App</button>
         <p class="tiny" style="margin:0" ${installEvt ? 'hidden' : ''}>點瀏覽器右上角選單，選「安裝應用程式」或「加到主畫面」。</p>`}
  </section>`;
}
function bindInstall() {
  for (const b of document.querySelectorAll('[data-install]')) b.onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    const { outcome } = await installEvt.userChoice.catch(() => ({}));
    if (outcome === 'accepted') toast('安裝完成，之後從主畫面打開');
    installEvt = null;
  };
  $('#installX')?.addEventListener('click', () => { try { localStorage.setItem('cil-install-dismiss', '1'); } catch {} $('.installcard')?.remove(); });
}

// 掃碼／連結報到：/#/e/<id>/in/<code>
async function checkinView(eventId, code) {
  const ok = allow('checkin') || (await api(`/events/${eventId}`).catch(() => ({}))).checkin;
  if (!ok) {
    view.innerHTML = `<section class="card"><h2>入場代碼</h2><p class="muted">這是入場券連結，請把畫面出示給工作人員。</p>
      <div class="code num" style="font-size:40px;letter-spacing:.2em;text-align:center">${esc(code)}</div>
      <a class="btn ghost block" href="#/e/${esc(eventId)}">回活動頁</a></section>`;
    return;
  }
  view.innerHTML = '<p class="loading">報到中…</p>';
  try {
    const r = await api(`/events/${eventId}/checkin`, { method: 'POST', body: { code } });
    view.innerHTML = `<section class="card ${r.already ? '' : 'ok'}">
      <h2>${r.already ? '這張票已經報到過' : '報到完成'}</h2>
      <p style="font-size:30px;font-weight:700;margin:4px 0">${esc(r.name)}</p>
      <p class="muted" style="margin:0">${r.table_no ? `第 ${r.table_no} 桌・` : ''}${r.guests ? `攜伴 ${r.guests} 位・` : ''}${r.meal ? esc(r.meal) : ''}</p>
      <a class="btn block" href="#/e/${esc(eventId)}/scan">繼續掃下一位</a>
      <a class="btn ghost block" href="#/e/${esc(eventId)}">回活動頁</a></section>`;
  } catch (e) {
    view.innerHTML = `<section class="card"><h2>報到失敗</h2><p class="muted">${esc(e.message)}</p>
      <a class="btn block" href="#/e/${esc(eventId)}/scan">再掃一次</a></section>`;
  }
}

// 掃描台（Android Chrome／桌機 Chrome 可用相機；iPhone 請用相機 App 掃）
let stopScan = null;
async function scanView(eventId) {
  if (!allow('checkin') && !(await api(`/events/${eventId}`).catch(() => ({}))).checkin) { view.innerHTML = '<div class="card"><p class="muted">只有幹部可以掃碼報到。</p></div>'; return; }
  view.innerHTML = `<section class="card">
    <div class="row spread"><h2>掃碼報到</h2><a class="tiny" href="#/e/${esc(eventId)}">完成</a></div>
    ${canScan() ? '<video id="cam" playsinline muted class="cam"></video><p class="tiny center" id="scanMsg">把入場券的 QR 對準框內</p>'
      : '<p class="notice">這台裝置不支援相機掃描（iPhone 的 Safari 沒有這個功能）。請用手機內建相機 App 掃 QR，會直接開啟報到頁；或在報到台手動輸入代碼。</p>'}
    <form id="manual" class="row" style="gap:8px">
      <input name="code" placeholder="手動輸入代碼" style="flex:1;text-transform:uppercase" autocomplete="off">
      <button class="btn sm">報到</button>
    </form>
  </section>`;
  $('#manual').onsubmit = (e) => { e.preventDefault(); location.hash = `#/e/${eventId}/in/${e.target.code.value.trim().toUpperCase()}`; };
  if (!canScan()) return;
  try {
    let busy = false;
    stopScan = await scan($('#cam'), async (value) => {
      if (busy) return;
      const code = (value.match(/\/in\/([A-Z0-9]{4,10})/i)?.[1] || value).trim().toUpperCase();
      busy = true;
      try {
        const r = await api(`/events/${eventId}/checkin`, { method: 'POST', body: { code } });
        $('#scanMsg').textContent = `${r.already ? '已報到過：' : '報到完成：'}${r.name}${r.table_no ? `・第 ${r.table_no} 桌` : ''}`;
        toast(`${r.name} 報到完成`);
      } catch (err) { $('#scanMsg').textContent = err.message; }
      setTimeout(() => { busy = false; }, 1800);
    });
  } catch (e) { toast(e.message); }
}
async function partyAdmin(ev) {
  const [{ tickets, checkedIn, people }, { prizes, draws }] = await Promise.all([
    api(`/events/${ev.id}/tickets`), api(`/events/${ev.id}/prizes`),
  ]);
  const won = new Map(draws.map((d) => [d.member_id, d]));
  return `
    <section class="card">
      <div class="row spread"><h3>排桌</h3><span class="tiny">輸入入場代碼指定桌次</span></div>
      <form id="seatForm" class="row" style="gap:8px">
        <input name="code" placeholder="入場代碼" style="flex:1;min-width:120px;text-transform:uppercase" autocomplete="off">
        <input name="table_no" type="number" min="1" max="31" placeholder="桌次" style="width:84px">
        <input name="note" placeholder="備註" style="width:110px">
        <button class="btn sm">儲存</button>
      </form>
    </section>

    <section class="card">
      <div class="row spread"><h3>報到台</h3><span class="tiny">${checkedIn}/${tickets.length} 人報到・含攜伴 ${people} 位</span></div>
      <a class="btn sm iconbtn" href="#/e/${ev.id}/scan">${IC.scan}掃碼報到</a>
      <form id="cform" class="row" style="gap:8px">
        <input name="code" placeholder="輸入入場代碼" style="flex:1;min-width:150px;text-transform:uppercase" autocomplete="off">
        <input name="seat" placeholder="桌次" style="width:90px">
        <button class="btn sm">報到</button>
      </form>
      <div class="roster">${tickets.map((t) => `
        <div class="r">${avatar(t)}
          <span>${esc(t.name)}${t.nickname ? ` <span class="tiny">${esc(t.nickname)}</span>` : ''}<span class="tiny" style="display:block">${esc(t.code)}${t.table_no ? `・第 ${t.table_no} 桌` : ''}${t.guests ? `・攜伴 ${t.guests}` : ''}${t.meal ? `・${esc(t.meal)}` : ''}</span></span>
          ${t.checked_in_at ? '<span class="pill solid">到</span>' : `<button class="btn ghost sm" data-ci="${esc(t.code)}">報到</button>`}
        </div>`).join('') || '<p class="muted">還沒有人報名。</p>'}</div>
    </section>

    <section class="card">
      <h3>抽獎</h3>
      ${prizes.map((p) => {
        const w = draws.filter((d) => d.prize_id === p.id);
        return `<div class="prize">
          <div class="row spread"><b>${p.stage ? `<span class="pill">${esc(p.stage)}</span> ` : ''}${esc(p.name)}</b><span class="tiny">${w.length}/${p.qty}${p.sponsor ? `・${esc(p.sponsor)}` : ''}</span></div>
          ${w.length ? `<div class="winners">${w.map((d) => `<button class="pill ${d.claimed_at ? 'solid' : 'wait'}" data-claim="${d.id}" title="${d.claimed_at ? '已領獎' : '點一下確認領獎'}">${esc(d.name)}${d.claimed_at ? IC.check : ''}</button>`).join('')}</div>` : ''}
          ${w.length < p.qty ? `<button class="btn sm" data-draw="${p.id}">抽出 1 位</button>` : '<span class="tiny">已抽完</span>'}
        </div>`;
      }).join('') || '<p class="muted" style="margin:0">還沒有獎項。</p>'}
      <form id="prizeForm" class="row" style="gap:8px">
        <input name="name" placeholder="獎項名稱" style="flex:1;min-width:140px">
        <select name="stage" style="width:110px"><option value="">階段</option>${Party.STAGES.map((s) => `<option>${s}</option>`).join('')}</select>
        <input name="qty" type="number" min="1" max="400" value="1" style="width:70px">
        <input name="sponsor" placeholder="贊助商" style="width:110px">
        <button class="btn ghost sm">新增獎項</button>
      </form>
      <details><summary class="tiny" style="cursor:pointer">批次匯入獎項（每行一項：[階段] 名稱 x數量 / 贊助商）</summary>
        <form id="bulkPrize" style="margin-top:8px">
          <textarea name="text" placeholder="[暖身] NAUTICA 毛巾 x30&#10;[R1] 按摩槍 x2 / 贊助商&#10;[R2(大)] JBL Pace 運動耳機 x1 / JBL"></textarea>
          <button class="btn ghost sm">匯入</button>
        </form></details>
      <button class="btn block" id="openStage">進入抽獎舞台</button>
      <p class="tiny">預設從「已報到」的人裡面抽，而且一個人只會中一次。</p>
    </section>`;
}


// 全螢幕抽獎舞台（投影用）
async function lotteryStage(ev) {
  const { prizes, draws } = await api(`/events/${ev.id}/prizes`);
  if (!prizes.length) return toast('請先新增獎項');
  const host = document.createElement('div');
  host.innerHTML = Party.stageHTML(prizes, draws);
  document.body.append(host);
  document.body.style.overflow = 'hidden';
  const close = () => { host.remove(); document.body.style.overflow = ''; render(); };
  $('#lClose').onclick = close;
  $('#lCsv').onclick = () => open(`/api/events/${ev.id}/draws.csv`, '_blank');
  $('#lPrize').onchange = () => {
    const p = prizes.find((x) => x.id === $('#lPrize').value);
    $('#lStage').textContent = p?.stage ? `[${p.stage}]` : '抽獎';
    $('#lName').textContent = '準備開始'; $('#lSub').textContent = p ? p.name : '';
  };
  $('#lPrize').onchange();
  // 大螢幕操作：空白鍵或 Enter 抽獎、F 全螢幕、Esc 關閉
  const onKey = (e) => {
    if (e.target.closest('select,input')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); $('#lGo')?.click(); }
    else if (e.key === 'f' || e.key === 'F') (document.fullscreenElement ? document.exitFullscreen() : host.firstElementChild.requestFullscreen?.())?.catch?.(() => {});
    else if (e.key === 'Escape' && !document.fullscreenElement) { removeEventListener('keydown', onKey); close(); }
  };
  addEventListener('keydown', onKey);
  $('#lClose').onclick = () => { removeEventListener('keydown', onKey); document.fullscreenElement && document.exitFullscreen().catch(() => {}); close(); };
  $('#lGo').onclick = async () => {
    const btn = $('#lGo'); btn.disabled = true;
    try {
      const prizeId = $('#lPrize').value;
      const r = await api(`/events/${ev.id}/draw`, { method: 'POST', body: {
        prize_id: prizeId, count: 1,
        onlyCheckedIn: $('#lCheckedIn').checked, allowRepeat: $('#lRepeat').checked } });
      const w = r.winners[0];
      const { tickets } = await api(`/events/${ev.id}/tickets`).catch(() => ({ tickets: [] }));
      await Party.spin($('#lName'), tickets.map((t) => t.name), w.name);
      $('#lSub').textContent = `${r.prize}${w.nickname ? `・${w.nickname}` : ''}${w.table_no ? `・第 ${w.table_no} 桌` : ''}`;
      $('#lLog').insertAdjacentHTML('afterbegin', `<div class="lrow"><span>${esc(w.name)}</span><span class="tiny">${esc(r.prize)}</span></div>`);
      confetti();
      // 這個獎項抽完了：自動切到下一個還有名額的獎項
      const p = prizes.find((x) => x.id === prizeId);
      p.done = (p.done ?? draws.filter((d) => d.prize_id === prizeId).length) + 1;
      if (p.done >= p.qty) {
        const next = prizes.find((x) => (x.done ?? draws.filter((d) => d.prize_id === x.id).length) < x.qty);
        if (next) setTimeout(() => { $('#lPrize').value = next.id; $('#lPrize').onchange(); toast(`${p.name} 抽完了，下一個：${next.name}`); }, 2200);
      }
    } catch (e) { toast(e.message); }
    btn.disabled = false;
  };
}
// 彩帶：用 canvas 畫，不載外部套件
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti'; c.width = innerWidth; c.height = innerHeight;
  document.body.append(c);
  const ctx = c.getContext('2d');
  const colors = ['#FDF36D', '#B9D04C', '#1C4698', '#E8691A', '#fff'];
  const bits = Array.from({ length: 120 }, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height * .5,
    r: 4 + Math.random() * 6, vy: 2 + Math.random() * 4, vx: -1 + Math.random() * 2,
    rot: Math.random() * 6, vr: -.2 + Math.random() * .4, color: colors[Math.floor(Math.random() * colors.length)],
  }));
  let t = 0;
  (function frame() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
      ctx.fillStyle = b.color; ctx.fillRect(-b.r / 2, -b.r / 2, b.r, b.r * 1.6); ctx.restore();
    }
    if (++t < 180) requestAnimationFrame(frame); else c.remove();
  })();
}


// ---------- 拍照分享（手動／Apple 健康／檔案／跑步記錄 → 照片合成 → 分享 IG）----------
const studio = { stats: null, bg: null, template: 'minimal', size: 'story', source: 'manual', acts: null };
const TEMPLATES = { minimal: '極簡', route: '路線', bib: '號碼布' };
function defaultStats() {
  return { title: '週四團練', date: new Date().toISOString().slice(0, 10), distance: 10000, seconds: 3300, elevation: 42, avg_hr: null, route: [] };
}
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
}
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
  const loop = async () => {
    if (!live) return;
    if (video.readyState >= 2) await S.render($('#arCv'), video, studio.stats, opts());
    requestAnimationFrame(loop);
  };
  $('#arClose').onclick = close;
  $('#arFlip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; start(); };
  $('#arShot').onclick = async () => {
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    studio.bg = await createImageBitmap(c);
    host.classList.add('flash');
    setTimeout(() => { close(); studioView(); }, 180);
  };
  await start();
  loop();
}

// ---------- 我的課表 ----------
async function planView(n) {
  const week = n || P.currentWeek();
  const info = await P.weekInfo(week);
  const days = await P.weekPlan(week, me.dist, me.grp);
  const posts = (await api(`/plans?week=${week}`).catch(() => ({ plans: [] }))).plans;
  const s = P.weekStart(week), e = new Date(s.getTime() + 6 * 864e5);
  const isNow = week === P.currentWeek();
  // 這週的訓練紀錄：照「週次＋課表那一天」對到每一列
  const { logs } = await api(`/logs?from=${ymd(s)}&to=${ymd(e)}`).catch(() => ({ logs: [] }));
  const logOf = (d) => logs.filter((l) => l.week_no === week && l.plan_day === d.d);
  const extras = logs.filter((l) => l.status === 'extra' || !l.plan_day);
  const planned = (days || []).filter((d) => d.kind !== 'rest');
  const doneN = planned.filter((d) => logOf(d).some((l) => l.status === 'done')).length;
  const partN = planned.filter((d) => logOf(d).some((l) => l.status === 'partial') && !logOf(d).some((l) => l.status === 'done')).length;
  const km = logs.reduce((n, l) => n + (l.km || 0), 0);
  const rpes = logs.filter((l) => l.rpe), avgRpe = rpes.length ? rpes.reduce((n, l) => n + l.rpe, 0) / rpes.length : 0;
  const pct = planned.length ? Math.round((doneN + partN * 0.5) / planned.length * 100) : 0;
  const started = ymd(s) <= ymd(new Date());
  view.innerHTML = `
    ${largeTitle('課表', `${me.dist === 'hm' ? '半馬' : '全馬'} ${me.grp} 組・${me.dist === 'hm' ? 'HMP' : 'MP'} ${P.fmtPace(P.goalPace(me.dist, me.grp))}/km`)}
    <section class="card">
      <div class="row spread">
        <div>
          <h2>${week === 21 ? '賽後恢復' : `W${week}`}${isNow ? ' <span class="pill">本週</span>' : ''}</h2>
          <p class="muted" style="margin:2px 0 0">${info?.phase || ''}${info?.recovery && week !== 21 ? '・恢復週' : ''}　${s.getMonth() + 1}/${s.getDate()}–${e.getMonth() + 1}/${e.getDate()}</p>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn ghost sm" id="prev" ${week === 1 ? 'disabled' : ''} aria-label="上一週">‹</button>
          <button class="btn ghost sm" id="next" ${week === 21 ? 'disabled' : ''} aria-label="下一週">›</button>
        </div>
      </div>
      ${posts.length ? '' : info?.src?.startsWith('推估') ? '<p class="notice" style="margin:0">這週的課表教練還沒公告，先參考去年同期。</p>' : ''}
      ${canPublishPlan() ? '<a class="btn ghost sm" href="#/plan/new">發布這週課表</a>' : ''}
    </section>
    ${posts.map((po) => `<section class="card">
      <div class="row spread"><h3>${esc(po.title)}</h3>${po.team_id ? teamTag(teamOf(po.team_id)) : '<span class="pill">教練發布</span>'}</div>
      <p class="tiny">${esc(po.author || '')}・${ago(po.created_at)}</p>
      <pre class="out">${esc(po.body)}</pre>
      ${allow('plan') || (po.team_id && teamAllow(po.team_id, 'appoint')) ? `<button class="btn danger sm" data-delplan="${po.id}">刪除</button>` : ''}
    </section>`).join('')}
    ${days && started ? `<section class="card logsum">
      <div class="lsumtop">
        <div class="ring" style="--p:${pct}" role="img" aria-label="本週完成 ${pct}%"><b class="num">${pct}<small>%</small></b></div>
        <div class="lsum"><span class="tiny">本週訓練</span>
          <div class="lstats"><span><b class="num">${doneN}</b>/${planned.length} 堂</span><span><b class="num">${km.toFixed(1)}</b> km</span>${avgRpe ? `<span>RPE <b class="num">${avgRpe.toFixed(1)}</b></span>` : ''}</div>
          ${allow('plan') || teams().some((t) => teamAllow(t.id, 'roster')) ? '<a class="tiny" href="#/logs/team">看團員的訓練 ›</a>' : ''}</div>
      </div>
      <div class="lsumact">${feat('gps') ? `<a class="btn iconbtn" href="#/run">${IC.runner}開始跑步</a>` : ''}<a class="btn ghost iconbtn" href="#/log?extra=1">${IC.plus}自主加練</a><a class="btn ghost" href="#/report">報表</a></div>
      <p class="tiny" style="margin:0">${me.share_logs ? '教練與分團幹部看得到你的完成率與里程，看不到備註。' : '紀錄只有你看得到；想讓教練看到，到「我的 → 隱私」打開分享。'}</p>
    </section>` : ''}
    <div class="days">${days ? days.map((d, i) => {
      const L = logOf(d), top = L.find((l) => l.status === 'done') || L.find((l) => l.status === 'partial') || L[0];
      const dates = dayDates(week, d.d), canLog = d.kind !== 'rest' && dates[0] <= ymd(new Date());
      return `<div class="day ${d.kind}${top ? ` logged ${top.status}` : ''}">
        <span class="dl"><span>${esc(dayLabel(d.d))}</span><span class="k">${P.KIND_LABEL[d.kind]}</span></span>
        <span class="t">${esc(fixText(d.t))} <span class="hint">${P.paceHint(d.t, me.dist, me.grp)}</span>
          ${top ? `<span class="logline">${LOG_STATUS_NAME[top.status]}${top.km ? `・${top.km} km` : ''}${top.seconds ? `・${S.fmtDuration(top.seconds)}` : ''}${top.rpe ? `・RPE ${top.rpe}` : ''}${L.some((l) => l.unread) ? '<span class="pill solid" style="margin-left:6px">教練回饋</span>' : L.some((l) => l.comments) ? '・有回饋' : ''}</span>` : ''}</span>
        ${top ? `<a class="logbtn ${top.status}" href="#/log?id=${top.id}" aria-label="修改紀錄">${LOG_ICON[top.status]}</a>`
          : canLog ? `<a class="logbtn" href="#/log?w=${week}&i=${i}" aria-label="記錄${esc(d.d)}">記錄</a>` : ''}
      </div>`; }).join('') : '<div class="card"><p class="muted">這週沒有課表資料。</p></div>'}</div>
    ${extras.length ? `<section class="card"><h3>自主加練</h3><div class="roster">${extras.map((l) => `<a class="r" href="#/log?id=${l.id}"><span class="av">＋</span>
      <span>${esc(dstr(l.date))}${l.km ? `・${l.km} km` : ''}${l.seconds ? `・${S.fmtDuration(l.seconds)}` : ''}<span class="tiny" style="display:block">${esc(l.note || '')}</span></span><span class="tiny">›</span></a>`).join('')}</div></section>` : ''}
    <section class="setgroup"><h3 class="sgt">工具</h3><div class="card setcard">
      ${feat('coach') ? `<a class="setrow" href="/coach.html"><span class="sic">${IC.runner}</span><span class="st"><b>課表教練</b><span class="tiny">逐週課表、配速換算、年齡分級、補給試算</span></span><span class="chev" aria-hidden="true"></span></a>` : ''}
      <a class="setrow" href="#/report"><span class="sic">${MI.report}</span><span class="st"><b>訓練報表</b><span class="tiny">週里程、完成率、個人最佳</span></span><span class="chev" aria-hidden="true"></span></a>
    </div><p class="tiny center">課表來源：耕跑團記事本</p></section>`;
  for (const b of document.querySelectorAll('[data-delplan]')) b.onclick = async () => {
    if (!confirm('確定刪除這則課表？')) return;
    await api(`/plans/${b.dataset.delplan}`, { method: 'DELETE' }); toast('已刪除'); render();
  };
  $('#prev').onclick = () => { location.hash = `#/plan/${week - 1}`; };
  $('#next').onclick = () => { location.hash = `#/plan/${week + 1}`; };
}

// ---------- 訓練紀錄 ----------
const LOG_STATUS_NAME = { done: '完成', partial: '部分完成', skip: '沒練', extra: '自主加練' };
const LOG_ICON = { done: IC.check, partial: IC.half, skip: IC.minus, extra: IC.plus };
const FEEL = ['', '很累', '有點累', '普通', '不錯', '很好'];
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// 課表上的「週二」「週五或週六」「週末」→ 那一週實際的日期
const WD_IDX = { 一: [0], 二: [1], 三: [2], 四: [3], 五: [4], 六: [5], 日: [6], 末: [5, 6] };
function dayDates(week, label) {
  const s = P.weekStart(week);
  const idx = [...String(label).matchAll(/[週周]([一二三四五六日末])/g)].flatMap((m) => WD_IDX[m[1]]);
  return (idx.length ? idx : [0]).map((i) => ymd(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i)));
}
async function logView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  let log = null, day = null, week = Number(q.get('w')) || null;
  if (q.get('id')) {
    // 修改：從最近 120 天找這筆
    const { logs } = await api(`/logs?from=${ymd(new Date(Date.now() - 119 * 864e5))}&to=${ymd(new Date())}`);
    log = logs.find((l) => l.id === q.get('id'));
    if (!log) { view.innerHTML = `<div class="card">${emptyState('runner', '找不到這筆紀錄')}</div>`; return; }
    week = log.week_no;
  } else if (week) {
    day = (await P.weekPlan(week, me.dist, me.grp))?.[Number(q.get('i'))] || null;
  }
  // 從拍照分享、跑步記錄或捷徑帶進來的數據
  const num = (k, max) => { const v = parseFloat(String(q.get(k) || '').replace(',', '.')); return v > 0 && v < max ? v : null; };
  const incoming = q.get('km') ? { km: num('km', 400), seconds: num('sec', 200000) || (num('min', 3000) ? Math.round(num('min', 3000) * 60) : null), hr: num('hr', 230),
    date: /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : null, source: ['health', 'gps'].includes(q.get('src')) ? q.get('src') : 'manual' } : null;
  const today = ymd(new Date());
  let date = log?.date || incoming?.date || (day ? dayDates(week, day.d).reduce((a, d) => (d <= today ? d : a), dayDates(week, day.d)[0]) : today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) date = today;
  // 沒有指定課表日：用日期去找那週同一天的課表（從拍照分享或跑步記錄進來時自動對上）
  if (!log && !day && !q.get('extra')) {
    const w = P.weekOf(date), plan = await P.weekPlan(w, me.dist, me.grp);
    const hit = plan?.find((d) => d.kind !== 'rest' && dayDates(w, d.d).includes(date));
    if (hit) { day = hit; week = w; }
  }
  const extra = !log && !day;
  const v = { status: extra ? 'extra' : 'done', km: '', seconds: null, hr: '', rpe: 5, feel: 3, note: '', ...log, ...(incoming || {}) };
  const planText = log?.plan_text || day?.t || '';
  const label = log?.plan_day || day?.d || '';
  const statuses = extra || v.status === 'extra' ? ['extra'] : ['done', 'partial', 'skip'];
  view.innerHTML = `
    ${largeTitle(log ? '修改紀錄' : extra ? '自主加練' : '記錄訓練', week && label ? `W${week}・${esc(dayLabel(label))}` : '')}
    ${planText ? `<section class="card plancard ${log?.kind || day?.kind || ''}"><span class="tiny">當天課表</span><p style="margin:0;font-weight:600">${esc(fixText(planText))}</p>
      <span class="hint">${P.paceHint(planText, me.dist, me.grp)}</span></section>` : ''}
    ${incoming ? `<div class="notice">已帶入${incoming.source === 'health' ? ' Apple 健康' : incoming.source === 'gps' ? '這次 GPS 跑步' : ''}的數據，確認後按儲存。</div>` : ''}
    <section class="card">
      <form id="lf" class="logform">
        ${statuses.length > 1 ? `<div class="chips status">${statuses.map((k) => `<label class="chip"><input type="radio" name="status" value="${k}" ${v.status === k ? 'checked' : ''}><span>${LOG_ICON[k]} ${LOG_STATUS_NAME[k]}</span></label>`).join('')}</div>`
          : '<input type="hidden" name="status" value="extra">'}
        <label>日期<input type="date" name="date" value="${esc(date)}" max="${today}" required></label>
        <div class="grid2" data-run>
          <label>距離（km）<input name="km" inputmode="decimal" value="${v.km ?? ''}" placeholder="10.0"></label>
          <label>時間（時:分:秒）<input name="time" inputmode="numeric" value="${v.seconds ? S.fmtDuration(v.seconds) : ''}" placeholder="0:55:00"></label>
        </div>
        <p class="tiny pace" data-run id="paceOut"></p>
        <div class="grid2" data-run>
          <label>平均心率（選填）<input name="hr" inputmode="numeric" value="${v.hr ?? ''}" placeholder="152"></label>
          <label>RPE 自覺強度 <b class="num" id="rpeOut">${v.rpe || 5}</b><input type="range" name="rpe" min="1" max="10" value="${v.rpe || 5}"></label>
        </div>
        <fieldset class="qset"><legend>身體感覺</legend><div class="chips feel">${[1, 2, 3, 4, 5].map((n) => `<label class="chip"><input type="radio" name="feel" value="${n}" ${Number(v.feel) === n ? 'checked' : ''}><span>${FEEL[n]}</span></label>`).join('')}</div></fieldset>
        <label>備註（只有你看得到）<input name="note" maxlength="300" value="${esc(v.note || '')}" placeholder="腳踝有點緊、風很大…"></label>
        <button class="btn block">儲存</button>
        ${log ? '<button type="button" class="btn danger block" id="delLog">刪除這筆紀錄</button>' : ''}
      </form>
      <div class="row" style="gap:8px">${feat('studio') ? `<a class="btn ghost sm" href="#/studio">從 Apple 健康或檔案匯入 ›</a>` : ''}</div>
    </section>
    ${log?.comments ? `<section class="card"><details data-cm="${log.id}" open><summary><h3 style="display:inline">教練回饋</h3></summary><div class="cmts"></div></details></section>` : ''}`;
  bindComments();
  const f = $('#lf');
  const sync = () => {
    const skip = f.status.value === 'skip' || f.querySelector('[name=status]:checked')?.value === 'skip';
    for (const el of f.querySelectorAll('[data-run]')) el.hidden = skip;
    const km = parseFloat(f.km.value), sec = S.parseHMS(f.time.value);
    $('#paceOut').textContent = km > 0 && sec > 0 ? `平均配速 ${S.fmtPace(km * 1000, sec)}` : '';
    $('#rpeOut').textContent = f.rpe.value;
  };
  f.oninput = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const st = f.querySelector('[name=status]:checked')?.value || f.status.value;
    const body = { id: log?.id, date: f.date.value, status: st, week_no: week || null, plan_day: label || null, kind: log?.kind || day?.kind || null,
      plan_text: planText || null, km: parseFloat(f.km.value) || null, seconds: S.parseHMS(f.time.value) || null, hr: Number(f.hr.value) || null,
      rpe: Number(f.rpe.value), feel: Number(f.querySelector('[name=feel]:checked')?.value) || null, note: f.note.value,
      source: log?.source || incoming?.source || 'manual' };
    if (st !== 'skip' && !body.km && !body.seconds) return toast('填一下距離或時間');
    try {
      await api('/logs', { method: 'POST', body });
      if (body.source === 'gps' && Run.session()?.status === 'done') Run.discard();   // 已存成紀錄，清掉手機上的這次跑步
      toast(st === 'skip' ? '已記下，休息也是訓練的一部分' : '已記錄，辛苦了！'); location.hash = `#/plan${week ? `/${week}` : ''}`;
    }
    catch (err) {
      // 斷線（fetch 本身失敗）：先存在手機，連上網路後自動上傳
      if (!navigator.onLine || err instanceof TypeError) { queueLog(body); toast('目前離線，已先存在手機，連上網路會自動上傳'); location.hash = `#/plan${week ? `/${week}` : ''}`; }
      else toast(err.message);
    }
  };
  $('#delLog')?.addEventListener('click', async () => {
    if (!confirm('刪除這筆紀錄？')) return;
    await api(`/logs/${log.id}`, { method: 'DELETE' }); toast('已刪除'); location.hash = `#/plan${week ? `/${week}` : ''}`;
  });
}
// 離線時的訓練紀錄暫存區（只放在這台裝置，上傳成功就刪除）
const logQueue = {
  get() { try { return JSON.parse(localStorage.getItem('cil-log-queue') || '[]'); } catch { return []; } },
  set(v) { try { v.length ? localStorage.setItem('cil-log-queue', JSON.stringify(v)) : localStorage.removeItem('cil-log-queue'); } catch {} },
};
const queueLog = (body) => logQueue.set([...logQueue.get(), { ...body, id: undefined, queued: Date.now() }].slice(-30));
async function flushLogQueue() {
  const q = logQueue.get();
  if (!q.length || !me) return;
  const left = [];
  for (const { queued, ...b } of q) { try { await api('/logs', { method: 'POST', body: b }); } catch (e) { if (e instanceof TypeError) left.push({ ...b, queued }); } }
  logQueue.set(left);
  if (left.length < q.length) toast(`已上傳 ${q.length - left.length} 筆離線時的訓練紀錄`);
}

// ---------- 訓練報表：週里程、完成率、強度趨勢、個人最佳 ----------
// 圖表一律用 SVG 自己畫（不載外部套件），寬度跟著容器縮放
function barChart(items, { unit = '', h = 150, color = 'var(--accent)', fmt = (v) => v, max: fixedMax } = {}) {
  if (!items.length) return '<p class="muted" style="margin:0">這段期間沒有紀錄</p>';
  // 柱子最寬 72（項目少時不會撐滿整張圖）
  const W = 600, pad = 24, bw = Math.min((W - pad) / items.length, 72), max = fixedMax || Math.max(1, ...items.map((x) => x.v));
  return `<svg class="chart" viewBox="0 0 ${W} ${h + 34}" role="img" aria-label="${esc(items.map((x) => `${x.l} ${fmt(x.v)}${unit}`).join('，'))}">
    ${[0.5, 1].map((k) => `<line x1="${pad}" x2="${W}" y1="${h - h * k * 0.9}" y2="${h - h * k * 0.9}" class="grid"/><text x="0" y="${h - h * k * 0.9 + 4}" class="axis">${fmt(Math.round(max * k))}</text>`).join('')}
    ${items.map((x, i) => { const bh = Math.max(x.v ? 3 : 0, (x.v / max) * h * 0.9), xx = pad + i * bw + bw * 0.18;
      return `<rect x="${xx}" y="${h - bh}" width="${bw * 0.64}" height="${bh}" rx="${Math.min(6, bw * 0.2)}" style="fill:${x.c || color}"><title>${esc(x.l)}：${fmt(x.v)}${unit}</title></rect>
        ${items.length <= 16 || i % Math.ceil(items.length / 12) === 0 ? `<text x="${xx + bw * 0.32}" y="${h + 20}" text-anchor="middle" class="axis">${esc(x.l)}</text>` : ''}`; }).join('')}
  </svg>`;
}
function lineChart(items, { h = 120, min = 1, max = 10 } = {}) {
  const pts = items.filter((x) => x.v != null);
  if (pts.length < 2) return '<p class="muted" style="margin:0">紀錄兩週以上才看得出趨勢</p>';
  const W = 600, pad = 24, step = (W - pad) / Math.max(1, items.length - 1), y = (v) => h - ((v - min) / (max - min)) * h * 0.9;
  const d = items.map((x, i) => (x.v == null ? null : `${pad + i * step},${y(x.v)}`)).filter(Boolean).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${h + 30}" role="img" aria-label="自覺強度趨勢">
    ${[4, 7].map((v) => `<line x1="${pad}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="0" y="${y(v) + 4}" class="axis">${v}</text>`).join('')}
    <polyline points="${d}" class="line"/>
    ${items.map((x, i) => (x.v == null ? '' : `<circle cx="${pad + i * step}" cy="${y(x.v)}" r="5" class="dot"><title>${esc(x.l)}：RPE ${x.v.toFixed(1)}</title></circle>`)).join('')}
  </svg>`;
}
const mondayOf = (ds) => { const d = new Date(`${ds}T00:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
// 個人最佳：距離落在區間內、用時最短的一筆
const PR_BUCKETS = [['5K', 4.9, 5.3], ['10K', 9.8, 10.5], ['半馬', 20.9, 21.6], ['全馬', 41.9, 42.8]];
async function reportView(range = '12w') {
  const days = { '12w': 84, '6m': 183, '1y': 365 }[range] || 84;
  const to = ymd(new Date()), from = ymd(new Date(Date.now() - (days - 1) * 864e5));
  const { logs } = await api(`/logs?from=${from}&to=${to}`);
  const runs = logs.filter((l) => l.status !== 'skip');
  // 每週
  const weeks = [];
  for (let d = new Date(`${mondayOf(from)}T00:00:00`); ymd(d) <= to; d.setDate(d.getDate() + 7)) weeks.push(ymd(d));
  const byWeek = Object.fromEntries(weeks.map((w) => [w, []]));
  for (const l of runs) (byWeek[mondayOf(l.date)] ||= []).push(l);
  const wkLabel = (w) => `${Number(w.slice(5, 7))}/${Number(w.slice(8))}`;
  const kmItems = weeks.map((w) => ({ l: wkLabel(w), v: Math.round(byWeek[w].reduce((n, l) => n + (l.km || 0), 0) * 10) / 10 }));
  const rpeItems = weeks.map((w) => { const r = byWeek[w].filter((l) => l.rpe); return { l: wkLabel(w), v: r.length ? r.reduce((n, l) => n + l.rpe, 0) / r.length : null }; });
  // 課表完成率（照課表週次）
  const planWeeks = [...new Set(logs.filter((l) => l.week_no).map((l) => l.week_no))].sort((a, b) => a - b);
  const done = [];
  for (const w of planWeeks) {
    const plan = (await P.weekPlan(w, me.dist, me.grp)) || [];
    const planned = plan.filter((d) => d.kind !== 'rest');
    const L = logs.filter((l) => l.week_no === w);
    const ok = planned.filter((d) => L.some((l) => l.plan_day === d.d && l.status === 'done')).length;
    const half = planned.filter((d) => !L.some((l) => l.plan_day === d.d && l.status === 'done') && L.some((l) => l.plan_day === d.d && l.status === 'partial')).length;
    done.push({ l: `W${w}`, v: planned.length ? Math.round((ok + half * 0.5) / planned.length * 100) : 0, c: '#34C759' });
  }
  // 每月
  const months = {};
  for (const l of runs) { const k = l.date.slice(0, 7); (months[k] ||= { km: 0, n: 0, sec: 0 }); months[k].km += l.km || 0; months[k].n += 1; months[k].sec += l.seconds || 0; }
  // 個人最佳（這段期間）
  const prs = PR_BUCKETS.map(([name, lo, hi]) => {
    const best = runs.filter((l) => l.km >= lo && l.km <= hi && l.seconds).sort((a, b) => a.seconds / a.km - b.seconds / b.km)[0];
    return { name, best };
  });
  const totalKm = runs.reduce((n, l) => n + (l.km || 0), 0), totalSec = runs.reduce((n, l) => n + (l.seconds || 0), 0);
  view.innerHTML = `
    ${largeTitle('訓練報表', `${from.slice(5).replace('-', '/')}–${to.slice(5).replace('-', '/')}`)}
    <div class="seg" role="group" aria-label="期間">${[['12w', '12 週'], ['6m', '6 個月'], ['1y', '1 年']].map(([k, v]) => `<button data-range="${k}" aria-pressed="${range === k}">${v}</button>`).join('')}</div>
    <section class="kpis">
      <div class="card kpi"><span class="tiny">總里程</span><b class="num">${totalKm.toFixed(1)}<small> km</small></b></div>
      <div class="card kpi"><span class="tiny">訓練次數</span><b class="num">${runs.length}</b></div>
      <div class="card kpi"><span class="tiny">總時間</span><b class="num">${S.fmtDuration(totalSec) || '0:00'}</b></div>
      <div class="card kpi"><span class="tiny">平均配速</span><b class="num">${totalKm && totalSec ? S.fmtPace(totalKm * 1000, totalSec) : '—'}</b></div>
    </section>
    <div class="statgrid">
    <section class="card"><h3>每週里程</h3>${barChart(kmItems, { unit: ' km' })}</section>
    ${done.length ? `<section class="card"><h3>課表完成率</h3>${barChart(done, { unit: '%', h: 120, max: 100 })}<p class="tiny" style="margin:0">完成算 1 堂、部分完成算半堂，休息日不算。</p></section>` : ''}
    <section class="card"><h3>自覺強度（RPE）</h3>${lineChart(rpeItems)}<p class="tiny" style="margin:0">一般來說，輕鬆跑 3–4、質量課 7–8；長期都在 7 以上要注意恢復。</p></section>
    <section class="card"><h3>個人最佳</h3><div class="prs">${prs.map((x) => `<div class="pr"><span class="tiny">${x.name}</span>
      ${x.best ? `<b class="num">${S.fmtDuration(Math.round(x.best.seconds / x.best.km * ({ '5K': 5, '10K': 10, 半馬: 21.0975, 全馬: 42.195 }[x.name])))}</b><span class="tiny">${esc(x.best.date)}・${S.fmtPace(x.best.km * 1000, x.best.seconds)}</span>` : '<b class="num muted">—</b>'}</div>`).join('')}</div>
      <p class="tiny" style="margin:0">依距離接近的紀錄換算，比賽成績以官方為準。</p></section>
    </div>
    <section class="card"><h3>每月</h3><div class="mtable">${Object.entries(months).sort().reverse().map(([k, m]) => `<div><span>${k.replace('-', ' 年 ')} 月</span><span class="num">${m.km.toFixed(1)} km</span><span class="num">${m.n} 次</span><span class="num">${S.fmtDuration(m.sec) || '—'}</span></div>`).join('') || '<p class="muted" style="margin:0">這段期間沒有紀錄</p>'}</div></section>`;
  for (const b of document.querySelectorAll('[data-range]')) b.onclick = () => reportView(b.dataset.range);
}

// 教練看單一團員的紀錄並留言（本人要有打開分享）
async function memberLogsView(mid) {
  const to = ymd(new Date()), from = ymd(new Date(Date.now() - 41 * 864e5));
  const r = await api(`/logs/member/${mid}?from=${from}&to=${to}`);
  const m = r.member;
  view.innerHTML = `${largeTitle(m.nickname || m.name, `${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)} 組・最近 6 週`)}
    <section class="card"><div class="roster">${r.logs.map((l) => `<div class="mlog">
      <div class="row spread"><b>${dstr(l.date)}${l.week_no ? ` <span class="tiny">W${l.week_no} ${esc(dayLabel(l.plan_day || ''))}</span>` : ''}</b>
        <span class="pill ${l.status === 'done' ? 'solid' : l.status === 'skip' ? '' : 'wait'}">${LOG_STATUS_NAME[l.status]}</span></div>
      ${l.plan_text ? `<span class="tiny">課表：${esc(fixText(l.plan_text))}</span>` : ''}
      <span>${l.km ? `${l.km} km` : ''}${l.seconds ? `・${S.fmtDuration(l.seconds)}` : ''}${l.km && l.seconds ? `・${S.fmtPace(l.km * 1000, l.seconds)}` : ''}${l.hr ? `・心率 ${l.hr}` : ''}${l.rpe ? `・RPE ${l.rpe}` : ''}${l.feel ? `・${FEEL[l.feel]}` : ''}</span>
      <details data-cm="${l.id}"><summary class="tiny" style="cursor:pointer">回饋${l.comments ? `（${l.comments}）` : ''}</summary><div class="cmts"></div>
        <form class="row cmform" style="gap:8px"><input name="body" maxlength="500" placeholder="給這次訓練一點回饋" style="flex:1"><button class="btn sm">送出</button></form></details>
    </div>`).join('') || '<p class="muted" style="margin:0">這段期間沒有紀錄。</p>'}</div>
    <p class="tiny" style="margin:0">看不到團員的備註；你的回饋只有本人看得到，送出後會通知他。</p></section>`;
  bindComments();
}
function bindComments() {
  for (const d of document.querySelectorAll('details[data-cm]')) {
    const load = async () => {
      const { comments } = await api(`/logs/${d.dataset.cm}/comments`);
      d.querySelector('.cmts').innerHTML = comments.map((c) => `<div class="cmt"><b>${esc(c.author_name || '教練')}</b><span>${esc(c.body)}</span><span class="tiny">${ago(c.created_at)}</span></div>`).join('');
    };
    d.ontoggle = () => d.open && load();
    const f = d.querySelector('form');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/logs/${d.dataset.cm}/comments`, { method: 'POST', body: { body: f.body.value } }); f.body.value = ''; toast('已送出回饋'); load(); }
      catch (err) { toast(err.message); }
    };
    if (d.open) load();
  }
}

// 教練與分團幹部：有開分享的團員，一週的完成次數與里程
async function logsTeamView(week, team) {
  week ||= P.currentWeek();
  const lead = teams().filter((t) => teamAllow(t.id, 'roster'));
  if (!allow('plan') && !team) team = lead[0]?.id || '';
  const s = P.weekStart(week), e = new Date(s.getTime() + 6 * 864e5);
  const r = await api(`/logs/team?from=${ymd(s)}&to=${ymd(e)}${team ? `&team=${team}` : ''}`);
  const days = await P.weekPlan(week, 'fm', 'D'), planned = (days || []).filter((d) => d.kind !== 'rest').length || 1;
  view.innerHTML = `
    ${largeTitle('團員訓練', `W${week}・${s.getMonth() + 1}/${s.getDate()}–${e.getMonth() + 1}/${e.getDate()}`)}
    <section class="card filters">
      <div class="row spread"><div class="row" style="gap:6px"><button class="btn ghost sm" id="wprev" ${week === 1 ? 'disabled' : ''}>‹</button><b>W${week}</b><button class="btn ghost sm" id="wnext" ${week === 21 ? 'disabled' : ''}>›</button></div>
        <select id="tsel" style="width:auto">${allow('plan') ? '<option value="">全部（有分享的人）</option>' : ''}${(allow('plan') ? teams() : lead).map((t) => `<option value="${esc(t.id)}" ${team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <p class="tiny" style="margin:0">只列出自己打開「分享給教練」的團員，看不到備註。完成率以每週 ${planned} 堂課計算。</p>
    </section>
    <section class="card"><div class="roster">${r.members.map((m) => {
      const p = Math.min(100, Math.round(((m.done || 0) + (m.partial || 0) * 0.5) / planned * 100));
      return `<a class="r tlog" href="#/logs/m/${esc(m.id)}">${avatar(m)}<span><b>${esc(m.nickname || m.name)}</b> <span class="tiny">${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)}</span>
        <span class="bar"><i style="width:${p}%"></i></span></span>
        <span class="num tiny" style="text-align:right"><b>${p}%</b><br>${m.km || 0} km${m.rpe ? `・RPE ${m.rpe}` : ''}</span></a>`; }).join('') || '<p class="muted" style="margin:0">這週還沒有分享的紀錄。</p>'}</div></section>`;
  $('#wprev').onclick = () => logsTeamView(week - 1, team);
  $('#wnext').onclick = () => logsTeamView(week + 1, team);
  $('#tsel').onchange = (ev) => logsTeamView(week, ev.target.value);
}

// ---------- 跑步記錄：計時器＋GPS ----------
const hms = (sec) => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60; return `${h ? `${h}:` : ''}${h ? pad2(m) : m}:${pad2(x)}`; };
const paceStr = (secPerKm) => (secPerKm && secPerKm < 1800 ? `${Math.floor(secPerKm / 60)}'${pad2(Math.round(secPerKm % 60))}"` : '—');
const GPS_NAME = { waiting: '正在定位…', good: 'GPS 良好', ok: 'GPS 普通', weak: 'GPS 訊號弱', denied: '沒有定位權限', off: '只計時' };
let runTick = null;
// 路線預覽（SVG，不載地圖圖資，路線不離開手機）
function routeSvg(route) {
  if (route.length < 2) return '';
  const lats = route.map((p) => p[0]), lons = route.map((p) => p[1]);
  const mid = (Math.min(...lats) + Math.max(...lats)) / 2, kx = Math.cos(mid * Math.PI / 180);
  const minX = Math.min(...lons) * kx, maxX = Math.max(...lons) * kx, minY = Math.min(...lats), maxY = Math.max(...lats);
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6), sc = Math.min(560 / w, 260 / h);
  const P = ([la, lo]) => `${(20 + (lo * kx - minX) * sc + (560 - w * sc) / 2).toFixed(1)},${(20 + (maxY - la) * sc + (260 - h * sc) / 2).toFixed(1)}`;
  return `<svg class="routesvg" viewBox="0 0 600 300" role="img" aria-label="這次跑步的路線"><polyline points="${route.map(P).join(' ')}"/>
    <circle cx="${P(route[0]).split(',')[0]}" cy="${P(route[0]).split(',')[1]}" r="8" class="st"/><circle cx="${P(route[route.length - 1]).split(',')[0]}" cy="${P(route[route.length - 1]).split(',')[1]}" r="8" class="en"/></svg>`;
}
async function runView() {
  clearInterval(runTick);
  const x = Run.session();
  // 結束後的成績頁
  if (x?.status === 'done') {
    const r = Run.summary(x);
    const t = ymd(new Date());
    const { logs } = await api(`/logs?from=${r.date}&to=${r.date}`).catch(() => ({ logs: [] }));
    const dayKm = logs.filter((l) => l.status !== 'skip').reduce((n, l) => n + (l.km || 0), 0), daySec = logs.reduce((n, l) => n + (l.seconds || 0), 0);
    view.innerHTML = `${largeTitle('跑完了', `${r.date === t ? '今天' : dstr(r.date)} ${r.start} 開始`)}
      <section class="kpis">
        <div class="card kpi"><span class="tiny">距離</span><b class="num">${(r.distance / 1000).toFixed(2)}<small> km</small></b></div>
        <div class="card kpi"><span class="tiny">時間</span><b class="num">${hms(r.seconds)}</b></div>
        <div class="card kpi"><span class="tiny">平均配速</span><b class="num">${paceStr(r.pace)}</b></div>
        <div class="card kpi"><span class="tiny">爬升</span><b class="num">${r.gain ? `${r.gain}<small> m</small>` : '—'}</b></div>
      </section>
      ${!r.gps || r.distance < 50 ? `<section class="card"><h3>距離</h3><p class="tiny" style="margin:0">${r.gps ? 'GPS 沒有記到距離（可能在室內或訊號太弱），' : '這次沒有開 GPS，'}請填實際跑的距離，例如跑步機上的數字或操場圈數。</p>
        <form id="manDist" class="row" style="gap:8px"><input name="km" inputmode="decimal" placeholder="例如 8.0" aria-label="實際距離（公里）" style="flex:1" value="${x.manualDist ? (x.manualDist / 1000).toFixed(2) : ''}"><span>km</span><button class="btn sm">更新</button></form></section>` : ''}
      ${r.route.length > 1 ? `<section class="card"><div class="row spread"><h3>路線</h3><span class="tiny">只留在你的手機上</span></div>${routeSvg(r.route)}</section>` : ''}
      <div class="statgrid">
        ${r.splits.length ? `<section class="card"><h3>每公里分段</h3><div class="splits">${r.splits.map((sp) => `<div><span>${sp.km} km</span><b class="num">${paceStr(sp.sec)}</b></div>`).join('')}</div></section>` : ''}
        ${r.laps.length ? `<section class="card"><h3>計圈</h3><div class="splits">${r.laps.map((l) => `<div><span>第 ${l.n} 圈・${l.m} m</span><b class="num">${hms(l.sec)}${l.m >= 100 ? `<small>　${paceStr(l.sec / (l.m / 1000))}</small>` : ''}</b></div>`).join('')}</div></section>` : ''}
      </div>
      <section class="card"><div class="row spread"><h3>${r.date === t ? '今天' : dstr(r.date)}累計</h3><span class="tiny">包含這一次</span></div>
        <div class="lstats"><span><b class="num">${(dayKm + r.distance / 1000).toFixed(1)}</b> km</span><span><b class="num">${hms(daySec + r.seconds)}</b></span><span><b class="num">${logs.filter((l) => l.status !== 'skip').length + 1}</b> 次</span></div></section>
      <section class="card actions">
        <a class="btn block iconbtn" style="justify-content:center" href="#/log?${new URLSearchParams({ date: r.date, km: (r.distance / 1000).toFixed(2), sec: String(r.seconds), src: 'gps' })}">${IC.check}存到訓練紀錄</a>
        ${feat('studio') ? '<button class="btn ghost block" id="toStudio">拍照分享到 IG</button>' : ''}
        ${r.route.length > 1 ? '<button class="btn ghost block" id="dlGpx">下載 GPX 檔</button>' : ''}
        <button class="btn danger block" id="runDiscard">刪除這次記錄</button>
      </section>`;
    $('#manDist')?.addEventListener('submit', (e) => { e.preventDefault(); Run.setDistance(parseFloat(e.target.km.value) * 1000); runView(); });
    $('#toStudio')?.addEventListener('click', () => {
      studio.stats = { title: '今天的跑步', date: r.date, distance: r.distance, seconds: r.seconds, elevation: r.gain, avg_hr: null, route: r.route };
      studio.source = 'manual'; studio.template = r.route.length > 1 ? 'route' : studio.template; location.hash = '#/studio';
    });
    $('#dlGpx')?.addEventListener('click', async () => {
      const res = await S.shareFile(new Blob([Run.gpx(x)], { type: 'application/gpx+xml' }), `耕跑團-${r.date}.gpx`, '跑步軌跡');
      if (res === 'downloaded') toast('已下載 GPX');
    });
    $('#runDiscard').onclick = () => { if (confirm('刪除這次跑步記錄？還沒存成訓練紀錄的話就不見了。')) { Run.discard(); runView(); } };
    return;
  }
  // 開始前
  if (!x) {
    view.innerHTML = `${largeTitle('跑步記錄', '計時加上 GPS，跑完自動算出今天的成績')}
      <section class="card runstart">
        <button class="runbtn go" id="runGo" aria-label="開始跑步記錄"><span>開始</span></button>
        <p class="tiny center" style="margin:0">第一次使用會詢問定位權限。跑步時螢幕會保持亮著；如果鎖上螢幕，iPhone 會暫停定位，解鎖後再接著記錄。</p>
        <button class="btn ghost block" id="runNoGps">不用 GPS，只計時（跑步機、操場）</button>
      </section>
      <section class="card"><h3>小提醒</h3><ol class="steps">
        <li>到戶外等「GPS 良好」再開始，距離會比較準</li><li>練間歇或在操場跑，可以按「計圈」把每一趟分開記</li>
        <li>跑完按「結束」，再按「存到訓練紀錄」，系統會自動對上今天的課表</li></ol>
        <p class="tiny" style="margin:0">路線只留在你的手機上，協會只會收到你存下來的距離和時間。</p></section>`;
    const goal = await todayGoal();
    if (goal) $('.runstart').insertAdjacentHTML('afterbegin', `<span class="pill">今天的課表：${esc(goal.text)}</span>`);
    $('#runGo').onclick = () => { Run.start({ useGps: true, goal }); runView(); };
    $('#runNoGps').onclick = () => { Run.start({ useGps: false, goal }); runView(); };
    return;
  }
  // 記錄中
  view.innerHTML = `<section class="card runlive ${x.status}">
      <div class="row spread"><span class="pill gps ${x.gps}">${GPS_NAME[x.gps] || ''}${x.acc ? `・±${x.acc} m` : ''}</span><span class="tiny" id="rState">${x.status === 'paused' ? (x.auto ? '停下來了，自動暫停' : '已暫停') : '記錄中'}</span></div>
      <div class="bigtime num" id="rTime">${hms(Run.elapsed() / 1000)}</div>
      <div class="runstats">
        <div><span class="tiny">距離</span><b class="num" id="rDist">${(x.dist / 1000).toFixed(2)}</b><span class="tiny">km</span></div>
        <div><span class="tiny">目前配速</span><b class="num" id="rPace">—</b><span class="tiny">/km</span></div>
        <div><span class="tiny">平均配速</span><b class="num" id="rAvg">—</b><span class="tiny">/km</span></div>
      </div>
      <div class="runbtns">
        ${x.status === 'running'
          ? '<button class="runbtn lap" id="rLap">計圈</button><button class="runbtn pause" id="rPause">暫停</button>'
          : '<button class="runbtn go" id="rResume">繼續</button><button class="runbtn stop" id="rStop">結束</button>'}
      </div>
      ${x.goal ? `<div class="goalbar"><span class="tiny">今天的課表：${esc(x.goal.text)}</span><span class="bar big"><i id="rGoal" style="width:0%"></i></span></div>` : ''}
      <div id="rLaps" class="splits"></div>
    </section>
    <div id="askDone"></div>`;
  const paint = () => {
    const y = Run.session(); if (!y || location.hash.split('?')[0] !== '#/run') { clearInterval(runTick); return; }
    const sec = Run.elapsed() / 1000, d = y.dist;
    $('#rTime').textContent = hms(sec);
    $('#rDist').textContent = (d / 1000).toFixed(2);
    $('#rPace').textContent = paceStr(Run.currentPace());
    $('#rAvg').textContent = d > 50 ? paceStr(sec / (d / 1000)) : '—';
    const g = $('.pill.gps'); if (g) { g.className = `pill gps ${y.gps}`; g.textContent = `${GPS_NAME[y.gps] || ''}${y.acc ? `・±${y.acc} m` : ''}`; }
    $('#rLaps').innerHTML = y.laps.map((l, i) => `<div><span>第 ${i + 1} 圈</span><b class="num">${hms((l.at - (i ? y.laps[i - 1].at : 0)) / 1000)}</b></div>`).reverse().join('');
    if (y.goal && $('#rGoal')) $('#rGoal').style.width = `${Math.min(100, y.goal.km ? d / (y.goal.km * 10) : sec / (y.goal.min * 0.6))}%`;
    // 自動暫停或自動繼續時，按鈕要跟著換
    if ((y.status === 'paused') !== !!$('#rResume')) { runView(); return; }
    if ($('#rState')) $('#rState').textContent = y.status === 'paused' ? (y.auto ? '停下來了，自動暫停' : '已暫停') : '記錄中';
  };
  paint();
  runTick = setInterval(paint, 1000);
  showAsk();
  $('#rLap')?.addEventListener('click', () => { Run.lap(); navigator.vibrate?.(60); paint(); });
  $('#rPause')?.addEventListener('click', () => { Run.pause(); runView(); });
  $('#rResume')?.addEventListener('click', () => { Run.resume(); runView(); });
  $('#rStop')?.addEventListener('click', () => { Run.finish(); runView(); });
}
// 問「跑完了嗎？」：停太久或課表目標到了；畫面在背景時也用通知提醒
function askFinish(kind) {
  const y = Run.session(); if (!y) return;
  const msg = kind === 'goal' ? `今天的課表（${y.goal.text}）完成了，要結束這次記錄嗎？` : '已經停下來 3 分鐘了，跑完了嗎？';
  navigator.vibrate?.([200, 100, 200]);
  if (document.visibilityState === 'hidden' && window.Notification?.permission === 'granted')
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification('跑完了嗎？', { body: msg, tag: 'run-ask', data: { url: '/#/run' }, icon: '/icons/icon-192.png' })).catch(() => {});
  pendingAsk = { kind, msg };
  if (location.hash.split('?')[0] !== '#/run') location.hash = '#/run'; else showAsk();
}
let pendingAsk = null;
function showAsk() {
  const box = $('#askDone'); if (!box || !pendingAsk) return;
  const { kind, msg } = pendingAsk;
  box.innerHTML = `<section class="card askcard" role="alertdialog" aria-label="跑完了嗎"><b>${esc(msg)}</b>
    <div class="grid2"><button class="btn" id="askEnd">結束，看成績</button><button class="btn ghost" id="askGo">還沒，繼續</button></div></section>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#askEnd').onclick = () => { pendingAsk = null; Run.finish(); runView(); };
  $('#askGo').onclick = () => { pendingAsk = null; Run.dismissAsk(); if (Run.session()?.status === 'paused' && kind === 'finish') Run.resume(); runView(); };
}
// 每秒檢查自動暫停與提醒（在其他頁面時也會檢查）
setInterval(() => { const k = Run.check(); if (k) askFinish(k); }, 1000);
// 今天課表的目標：「11K jog」取距離、「60' easyjog」取分鐘，間歇課不設目標
async function todayGoal() {
  const t = ymd(new Date()), w = P.currentWeek();
  const day = ((await P.weekPlan(w, me.dist, me.grp)) || []).find((d) => d.kind !== 'rest' && dayDates(w, d.d).includes(t));
  if (!day || day.kind === 'quality') return null;
  const km = day.t.match(/(\d+(?:\.\d+)?)\s*(?:[~～-]\s*\d+(?:\.\d+)?)?\s*K(?![a-z])/i), min = day.t.match(/^(\d{2,3})\s*['’]/);
  if (km) return { km: Number(km[1]), text: `${km[1]} 公里` };
  if (min) return { min: Number(min[1]), text: `${min[1]} 分鐘` };
  return null;
}
// 在別的頁面時，畫面下方顯示「記錄中」，點了回到跑步記錄
function runBar() {
  let bar = document.getElementById('runbar');
  const onRun = location.hash.split('?')[0] === '#/run';
  if (!me || !Run.active() || onRun) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('a'); bar.id = 'runbar'; bar.className = 'runbar'; bar.href = '#/run';
    document.body.append(bar);
  }
  const y = Run.session();
  bar.innerHTML = `<i class="${y.status}"></i><span>${y.status === 'paused' ? '已暫停' : '記錄中'}</span><b class="num">${hms(Run.elapsed() / 1000)}</b><b class="num">${(y.dist / 1000).toFixed(2)} km</b>`;
}
setInterval(runBar, 1000);


// ---------- 幹部：新增／編輯活動 ----------
async function formView(id) {
  const qp = new URLSearchParams(location.hash.split('?')[1] || '');
  const from = !id && qp.get('from');
  const src = id ? await api(`/events/${id}`) : from ? await api(`/events/${from}`) : null;
  // 複製活動：沿用內容、問卷與座位圖，日期往後推一年（每年的春酒）或清空
  const d = src ? { ...src, ...(from ? { title: src.title.replace(/20\d\d/, (y) => String(Number(y) + 1)), date: nextYear(src.date), deadline: '' } : {}) }
    : { kind: 'track', date: new Date().toISOString().slice(0, 10), signup_open: 1, team_id: qp.get('team') || null };
  // 分團選項：協會幹部可以選全協會與任何分團；分團幹部只能選自己帶的分團
  const teamOpts = [...(allow('event') ? [['', '全協會']] : []), ...teams().filter((t) => teamAllow(t.id, 'event')).map((t) => [t.id, t.name])];
  if (!teamOpts.length) { view.innerHTML = `<div class="card">${emptyState('calendar', '只有幹部與分團幹部可以建立活動')}</div>`; return; }
  view.innerHTML = `${largeTitle(id ? '編輯活動' : from ? '複製活動' : '新增活動', from ? `從「${esc(src.title)}」複製，座位圖也會一起帶過來` : '')}
  <section class="card">
    <form id="ef">
      <div class="grid2">
        <label>類型<select name="kind">${Object.entries(KIND_NAME).filter(([k]) => k !== 'party' || feat('party') || d.kind === 'party').map(([k, v]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>分團<select name="team_id">${teamOpts.map(([k, v]) => `<option value="${esc(k)}" ${(d.team_id || '') === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      </div>
      <label>標題<input name="title" required maxlength="40" value="${esc(d.title || '')}" placeholder="10/8（四）耕跑團練"></label>
      <fieldset class="qset"><legend>誰看得到</legend><div class="chips">
        <label class="chip"><input type="radio" name="visibility" value="public" ${d.visibility !== 'invite' ? 'checked' : ''}><span>公開</span></label>
        <label class="chip"><input type="radio" name="visibility" value="invite" ${d.visibility === 'invite' ? 'checked' : ''}><span>${IC.lock}邀請制</span></label></div>
        <span class="tiny" id="visHint"></span></fieldset>
      <div class="grid2">
        <label><span data-when="survey">截止日期</span><span data-when="!survey">日期</span><input type="date" name="date" required value="${esc(d.date)}"></label>
        <label data-when="!survey">集合時間<input type="time" name="gather_time" value="${esc(d.gather_time || '')}"></label>
      </div>
      <div data-when="!survey">
        <label>地點<input name="place" maxlength="60" value="${esc(d.place || '')}" placeholder="臺北田徑場 400 場"></label>
        <div class="grid2">
          <label>帶團<input name="lead" maxlength="30" value="${esc(d.lead || '')}" placeholder="教練或領跑員"></label>
          <label>人數上限<input type="number" name="capacity" min="1" max="999" value="${d.capacity || ''}" placeholder="不限"></label>
        </div>
      </div>
      <fieldset class="group" data-when="party">
        <legend>春酒餐敘</legend>
        <div class="grid2">
          <label>費用（元）<input type="number" name="fee" min="0" value="${d.fee ?? ''}" placeholder="0"></label>
          <label>可攜伴人數<input type="number" name="guest_max" min="0" max="9" value="${d.guest_max || ''}" placeholder="不開放"></label>
        </div>
        <label>餐點選項（逗號分隔）<input name="meal_options" maxlength="60" value="${esc(d.meal_options || '')}" placeholder="葷食,素食"></label>
      </fieldset>
      <label>報名截止（選填）<input type="datetime-local" name="deadline" value="${esc(d.deadline || '')}"></label>

      <fieldset class="group">
        <legend>組別與價格</legend>
        <p class="tiny" style="margin:0">例如 全馬 1200、半馬 1000、10K 800。有設定的話，報名時要選一組，統計頁會算好應收金額。</p>
        <div id="optRows" class="qedit">${(d.options || []).map(optRow).join('')}</div>
        <button type="button" class="btn ghost sm" id="addOpt">${IC.plus}新增一組</button>
        <label class="switch"><span>由幹部代為團體報名<span class="tiny" style="display:block">報名的人要先填好賽事報名資料並同意提供，幹部再下載整理送出</span></span><input type="checkbox" name="group_reg" ${d.group_reg ? 'checked' : ''}><i></i></label>
      </fieldset>
      <fieldset class="group">
        <legend>報名問卷</legend>
        <p class="tiny" style="margin:0">想知道大家的尺寸、交通方式、要不要參加慶功宴…都可以加題目。報名時一起填，統計頁會自動算好。</p>
        <div id="qRows" class="qedit">${(d.questions || []).map(qRow).join('')}</div>
        <div class="row" style="gap:8px">
          <button type="button" class="btn ghost sm" data-addq="single">＋ 單選</button>
          <button type="button" class="btn ghost sm" data-addq="multi">＋ 複選</button>
          <button type="button" class="btn ghost sm" data-addq="text">＋ 簡答</button>
        </div>
      </fieldset>

      <details data-when="!survey" ${d.week_no || d.plan_text || d.link_url ? 'open' : ''}>
        <summary class="tiny" style="cursor:pointer">課表與外部連結</summary>
        <label>課表週次<input type="number" name="week_no" min="1" max="21" value="${d.week_no || ''}" placeholder="自動帶課表"></label>
        <div class="grid2">
          <label>外部報名連結<input name="link_url" type="url" value="${esc(d.link_url || '')}" placeholder="https://forms.gle/…"></label>
          <label>按鈕文字<input name="link_label" maxlength="12" value="${esc(d.link_label || '')}" placeholder="索票登記"></label>
        </div>
        <label>自填課表（沒填週次時使用）<textarea name="plan_text" placeholder="S：…">${esc(d.plan_text || '')}</textarea></label>
      </details>
      <label>說明與注意事項<textarea name="note" placeholder="攜帶瑜珈墊、水、彈力帶、毛巾">${esc(d.note || '')}</textarea></label>
      <label class="inline"><input type="checkbox" name="signup_open" ${d.signup_open ? 'checked' : ''}> 開放報名</label>
      ${id ? '' : '<label class="inline"><input type="checkbox" name="notify" checked> 建立後通知（選了分團就只通知那個分團；邀請制只通知受邀的人）</label>'}
      <button class="btn block">${id ? '儲存' : '建立'}</button>
    </form>
  </section>`;
  const f = $('#ef');
  // 依類型顯示欄位：data-when="party"、"survey"、"!survey"
  const sync = () => {
    for (const el of f.querySelectorAll('[data-when]')) {
      const w = el.dataset.when, neg = w.startsWith('!'), k = w.replace('!', '');
      el.hidden = neg ? f.kind.value === k : f.kind.value !== k;
    }
  };
  f.kind.onchange = sync; sync();
  const visHint = () => { $('#visHint').textContent = f.visibility.value === 'invite'
    ? '只有受邀的人看得到，不會出現在其他人的列表，也不會通知其他人。建立後在活動頁邀請人或開邀請連結。'
    : '選了分團就是分團的人看得到（私密分團只有團員），沒選就是全協會。'; };
  for (const r of f.querySelectorAll('[name=visibility]')) r.onchange = visHint;
  visHint();
  const bindQ = () => { for (const b of f.querySelectorAll('[data-rmq]')) b.onclick = () => b.closest('.qrow').remove(); };
  const bindO = () => { for (const b of f.querySelectorAll('[data-rmo]')) b.onclick = () => b.closest('.optrow').remove(); };
  bindO();
  $('#addOpt').onclick = () => { $('#optRows').insertAdjacentHTML('beforeend', optRow()); bindO(); $('#optRows').lastElementChild.querySelector('input').focus(); };
  bindQ();
  for (const b of f.querySelectorAll('[data-addq]')) b.onclick = () => {
    if (f.querySelectorAll('.qrow').length >= 12) return toast('最多 12 題');
    $('#qRows').insertAdjacentHTML('beforeend', qRow({ type: b.dataset.addq })); bindQ();
    $('#qRows').lastElementChild.querySelector('input').focus();
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const num = (el) => (el.value === '' ? null : Number(el.value));
    const questions = [...f.querySelectorAll('.qrow')].map((r) => ({
      id: r.dataset.id || undefined, type: r.dataset.type, label: r.querySelector('[data-k=label]').value.trim(),
      options: (r.querySelector('[data-k=options]')?.value || '').split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean),
      required: r.querySelector('[data-k=required]').checked,
    })).filter((q) => q.label);
    const bad = questions.find((q) => q.type !== 'text' && !q.options.length);
    if (bad) return toast(`「${bad.label}」要有選項`);
    const body = {
      kind: f.kind.value, team_id: f.team_id.value || null, title: f.title.value, date: f.date.value, gather_time: f.gather_time.value,
      place: f.place.value, lead: f.lead.value, note: f.note.value, plan_text: f.plan_text.value,
      link_url: f.link_url.value, link_label: f.link_label.value, deadline: f.deadline.value,
      week_no: num(f.week_no), capacity: num(f.capacity), fee: num(f.fee), guest_max: num(f.guest_max), meal_options: f.meal_options.value,
      signup_open: f.signup_open.checked, questions, visibility: f.visibility.value, group_reg: f.group_reg.checked,
      options: [...f.querySelectorAll('.optrow')].map((r) => ({ name: r.querySelector('[data-k=name]').value.trim(), price: Number(r.querySelector('[data-k=price]').value) || 0 })).filter((o) => o.name), notify: f.notify ? f.notify.checked : undefined, copy_from: from || undefined,
    };
    try {
      if (id) { await api(`/events/${id}`, { method: 'PUT', body }); location.hash = `#/e/${id}`; }
      else { location.hash = `#/e/${(await api('/events', { method: 'POST', body })).id}`; }
      toast('已儲存');
    } catch (err) { toast(err.message); }
  };
}
const optRow = (o = {}) => `<div class="optrow"><input data-k="name" maxlength="20" placeholder="組別，例如 全馬" aria-label="組別名稱" value="${esc(o.name || '')}">
  <input data-k="price" type="number" min="0" max="100000" inputmode="numeric" placeholder="價格" aria-label="價格（元）" value="${o.price ?? ''}"><button type="button" class="btn danger sm" data-rmo>移除</button></div>`;
const nextYear = (date) => { const [y, m, dd] = date.split('-'); return `${Number(y) + 1}-${m}-${dd}`; };
const Q_TYPE_NAME = { single: '單選', multi: '複選', text: '簡答' };
const qRow = (q = {}) => `<div class="qrow" data-type="${q.type || 'single'}" data-id="${esc(q.id || '')}">
  <div class="row spread"><span class="pill">${Q_TYPE_NAME[q.type || 'single']}</span>
    <span class="row" style="gap:10px"><label class="inline tiny"><input type="checkbox" data-k="required" ${q.required ? 'checked' : ''}> 必填</label>
    <button type="button" class="btn danger sm" data-rmq>移除</button></span></div>
  <input data-k="label" maxlength="80" placeholder="題目，例如：團服尺寸" value="${esc(q.label || '')}">
  ${q.type === 'text' ? '' : `<input data-k="options" placeholder="選項用逗號分隔：S, M, L, XL" value="${esc((q.options || []).join(', '))}">`}
</div>`;

// ---------- 活動統計與問卷結果 ----------
const money = (n) => `NT$${Number(n || 0).toLocaleString('zh-TW')}`;
const PAID_NAME = { unpaid: '未繳', paid: '已繳', waived: '免繳', refunded: '已退費' };
const bars = (entries, total) => {
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return `<div class="bars">${entries.map(([k, n]) => `<div class="bar-row"><span class="k">${esc(k)}</span>
    <span class="track"><i style="width:${Math.round(n / max * 100)}%"></i></span>
    <span class="n num">${n}${total ? `<span class="tiny"> ${Math.round(n / total * 100)}%</span>` : ''}</span></div>`).join('') || '<p class="muted" style="margin:0">還沒有資料</p>'}</div>`;
};
async function statsView(id) {
  const st = await api(`/events/${id}/stats`);
  const t = st.total, survey = st.kind === 'survey';
  const kpi = [[survey ? '回覆' : '正取', t.in], ...(survey ? [] : [['候補', t.wait]]), ['取消', t.cancel],
    ...(st.kind === 'party' ? [['攜伴', t.guests], ['已報到', `${t.checkedIn}/${t.in}`]] : survey ? [] : [['出席', `${t.attended}/${t.in}`]]), ['協會會員', t.members]];
  const money = st.money, nf = (n) => n.toLocaleString('zh-TW');
  view.innerHTML = `
    ${largeTitle('統計', `${esc(st.title)}・${dstr(st.date)}`, `<a class="btn ghost sm" href="#/e/${id}">回活動</a>`)}
    <section class="kpis">${kpi.map(([k, v]) => `<div class="card kpi"><span class="tiny">${k}</span><b class="num">${v}</b></div>`).join('')}</section>
    ${st.capacity ? `<section class="card"><div class="row spread"><h3>名額</h3><span class="tiny num">${t.in}/${st.capacity}</span></div>
      <span class="bar big"><i style="width:${Math.min(100, Math.round(t.in / st.capacity * 100))}%"></i></span></section>` : ''}
    ${money ? `<section class="card"><div class="row spread"><h3>繳費</h3><span class="tiny">${st.options.length ? '依報名組別計價' : `每人 ${nf(st.fee)} 元`}（攜伴另計）</span></div>
      <div class="lstats"><span>已收 <b class="num">${nf(money.collected)}</b> / ${nf(money.expected)} 元</span>
        ${Object.entries(PAID_NAME).map(([k, v]) => `<span>${v} <b class="num">${money.counts[k] || 0}</b></span>`).join('')}</div>
      <span class="bar big"><i style="width:${money.expected ? Math.round(money.collected / money.expected * 100) : 0}%"></i></span></section>` : ''}
    ${st.groupReg ? `<section class="card"><div class="row spread"><h3>團體報名資料</h3><span class="tiny">${st.regReady}/${t.in} 人已同意提供</span></div>
      <span class="bar big"><i style="width:${t.in ? Math.round(st.regReady / t.in * 100) : 0}%"></i></span>
      <a class="btn sm" href="/api/events/${id}/registrations.csv" download>下載團體報名資料（含身分證字號）</a>
      <p class="tiny" style="margin:0">只包含已同意提供的人。檔案含身分證字號等個資，送出報名後請立刻刪除，下載紀錄會寫進稽核。</p></section>` : ''}
    <div class="statgrid">
      ${st.byOption ? `<section class="card"><h3>報名組別</h3>${bars(Object.entries(st.byOption), t.in)}</section>` : ''}
      <section class="card"><h3>各分團</h3>${bars(st.byTeam.map((x) => [x.k, x.n]).sort((a, b) => b[1] - a[1]), t.in)}
        <p class="tiny" style="margin:0">同時在兩個分團的人，兩邊都會算到。</p></section>
      ${st.byMeal ? `<section class="card"><h3>餐點</h3>${bars(Object.entries(st.byMeal), t.in)}</section>` : ''}
      ${survey ? '' : `<section class="card"><h3>組別</h3>${bars(Object.entries(st.byGroup).sort(), t.in)}</section>`}
      <section class="card"><h3>每天新增${survey ? '回覆' : '報名'}</h3>${bars(st.byDay.slice(-14).map(([d, n]) => [d.slice(5).replace('-', '/'), n]))}</section>
    </div>
    ${st.questions.map((q) => `<section class="card">
      <div class="row spread"><h3>${esc(q.label)}</h3><span class="tiny">${Q_TYPE_NAME[q.type]}${q.type === 'text' ? `・${q.answers.length} 則` : `・${q.answered}/${t.in} 人回答`}</span></div>
      ${q.type === 'text'
        ? `<div class="answers">${q.answers.map((a) => `<div><b>${esc(a.name)}</b><span>${esc(a.text)}</span></div>`).join('') || '<p class="muted" style="margin:0">還沒有回答</p>'}</div>`
        : bars(q.counts.map((c) => [c.o, c.n]), q.answered)}
    </section>`).join('')}
    ${survey ? '' : `<section class="card">
      <div class="row spread"><h3>名單</h3><span class="tiny">${st.people.length} 人</span></div>
      <input id="pq" placeholder="搜尋姓名" aria-label="搜尋名單" autocomplete="off">
      <div class="roster" id="plist">${st.people.map((x) => `<div class="r prow" data-name="${esc(`${x.name} ${x.nickname || ''}`)}">
        <label class="attend" title="出席"><input type="checkbox" data-att="${esc(x.member_id)}" ${x.attended ? 'checked' : ''} ${st.kind === 'party' ? 'disabled' : ''}><i>${IC.check}</i></label>
        <span><b>${esc(x.name)}</b>${x.nickname ? ` <span class="tiny">${esc(x.nickname)}</span>` : ''}<span class="tiny" style="display:block">${x.option ? `${esc(x.option)}・` : ''}${st.groupReg ? (x.regOk ? '報名資料 OK・' : '報名資料未提供・') : ''}${x.status === 'wait' ? '候補・' : ''}${x.guests ? `攜伴 ${x.guests}・` : ''}${esc(x.paid_note || '')}</span></span>
        ${money ? `<select data-pay="${esc(x.member_id)}" aria-label="繳費狀態" class="paysel ${x.paid}">${Object.entries(PAID_NAME).map(([k, v]) => `<option value="${k}" ${x.paid === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : '<span></span>'}
      </div>`).join('')}</div>
      <p class="tiny" style="margin:0">左邊勾選是點名出席${st.kind === 'party' ? '（春酒以入場券報到為準）' : ''}${money ? '；右邊切換繳費狀態，只做紀錄，不串金流' : ''}。</p>
    </section>`}
    <section class="card">
      <h3>匯出</h3>
      <p class="tiny" style="margin:0">Excel 可以直接開啟的 CSV，含每個人的問卷回答${allow('members') && me.role !== 'supervisor' ? '與電話' : ''}。匯出會留下稽核紀錄，檔案請妥善保管、用完刪除。</p>
      <div class="row"><a class="btn sm" href="/api/events/${id}/export.csv" download>下載 CSV</a>
        <button class="btn ghost sm" id="copyRoster2">複製名單（貼 LINE）</button></div>
    </section>`;
  $('#copyRoster2').onclick = async () => { try { copy((await api(`/events/${id}/roster`)).text); } catch (e) { toast(e.message); } };
  $('#pq')?.addEventListener('input', (e) => { const q = e.target.value.trim(); for (const r of document.querySelectorAll('.prow')) r.hidden = !!q && !r.dataset.name.includes(q); });
  for (const c of document.querySelectorAll('[data-att]')) c.onchange = async () => {
    try { await api(`/events/${id}/attendance`, { method: 'POST', body: { member_id: c.dataset.att, present: c.checked } }); } catch (e) { c.checked = !c.checked; toast(e.message); }
  };
  for (const sel of document.querySelectorAll('[data-pay]')) sel.onchange = async () => {
    try { await api(`/events/${id}/payments`, { method: 'POST', body: { member_ids: [sel.dataset.pay], paid: sel.value } }); sel.className = `paysel ${sel.value}`; toast(`已標記為${PAID_NAME[sel.value]}`); }
    catch (e) { toast(e.message); }
  };
}

// ---------- 分團 ----------
const POLICY_NAME = { open: '直接加入', approve: '需團長或幹部審核' };
async function teamsView() {
  await refreshMe();
  const list = teams();
  view.innerHTML = `
    ${largeTitle('分團', '主團由管理員設定；想加入其他分團，申請後由該團幹部核准')}
    <div class="teamgrid">${list.map((t) => `<a class="card lit teamcard" href="#/t/${esc(t.id)}" style="--tc:${esc(t.color)}">
      <span class="dot" aria-hidden="true"></span>
      <span class="row spread"><span class="row" style="gap:10px">${teamIcon(t, 'md')}<b>${esc(t.name)}</b></span>${t.id === me.main_team ? '<span class="pill solid">我的主團</span>' : t.my_status === 'active' ? `<span class="pill solid">${esc(t.my_title || TEAM_ROLE_NAME[t.my_role])}</span>` : t.my_status === 'pending' ? '<span class="pill wait">申請中</span>' : t.private ? '<span class="pill">私密</span>' : ''}</span>
      ${t.intro ? `<span class="tiny">${esc(t.intro)}</span>` : ''}
      <span class="row spread"><span class="tiny num">${t.count} 人</span><span class="tiny">${t.leaders.filter((l) => l.role === 'lead').map((l) => `團長 ${esc(l.nickname || l.name)}`).join('、')}</span></span>
    </a>`).join('') || `<div class="card">${emptyState('runner', '還沒有分團')}</div>`}</div>
    ${allow('settings') ? '<a class="tiny center" href="#/admin?tab=teams" style="padding:6px">管理分團 ›</a>' : ''}`;
}
async function teamView(tid, q = '') {
  await refreshMe();
  const t = teamOf(tid);
  if (!t) { view.innerHTML = `<div class="card">${emptyState('runner', '找不到這個分團')}</div>`; return; }
  const inTeam = t.my_status === 'active', manage = teamAllow(tid, 'roster');
  const [{ events }, roster] = await Promise.all([api('/events'), manage ? api(`/teams/${tid}/members?q=${encodeURIComponent(q)}`) : null]);
  const evs = events.filter((e) => e.team_id === tid);
  const canEdit = allow('settings') || teamAllow(tid, 'appoint');
  view.innerHTML = `
    <section class="card hero teamhero" style="--tc:${esc(t.color)}">
      <div class="row spread"><span class="pill" style="background:rgba(255,255,255,.2);color:#fff">${t.private ? '私密分團' : '分團'}・${t.count} 人</span>
        ${inTeam ? `<span class="pill" style="background:#fff;color:${esc(t.color)}">${esc(t.my_title || TEAM_ROLE_NAME[t.my_role])}</span>` : ''}</div>
      <div class="row" style="gap:14px">${teamIcon(t, 'lg')}<h2 style="margin:0">${esc(t.name)}</h2></div>
      ${t.intro ? `<p class="muted" style="margin:0;white-space:pre-wrap">${esc(t.intro)}</p>` : ''}
      <div class="leaders">${t.leaders.map((l) => `<span class="ldr">${avatar(l)}<span><b>${esc(l.nickname || l.name)}</b><span class="tiny">${esc(l.title || TEAM_ROLE_NAME[l.role])}</span></span></span>`).join('')}</div>
      <div class="row">
        ${inTeam ? (t.line_url ? `<a class="btn line sm" href="${esc(t.line_url)}" target="_blank" rel="noopener">加入 LINE 群組</a>` : '')
          : t.my_status === 'pending' ? '<span class="pill" style="background:rgba(255,255,255,.2);color:#fff">已申請，等幹部核准</span>'
          : `<button class="btn sm" id="joinTeam" style="background:#fff;color:${esc(t.color)}">申請加入</button>`}
        ${(inTeam && t.id !== me.main_team && t.my_role !== 'lead') || t.my_status === 'pending' ? `<button class="btn sm glassbtn" id="leaveTeam">${inTeam ? '退出' : '取消申請'}</button>` : ''}
      </div>
      ${t.self_managed ? `<p class="tiny" style="margin:0">${esc(t.name)}的成員由${esc(t.name)}的團長與幹部處理。</p>` : ''}
    </section>

    <div class="section-h"><h2>分團活動</h2>${teamAllow(tid, 'event') ? `<a class="btn ghost sm" href="#/new?team=${esc(tid)}">＋ 新增</a>` : ''}</div>
    <div class="evgrid">${evs.map(eventCard).join('') || `<div class="card">${emptyState('calendar', '近期沒有分團活動')}</div>`}</div>

    ${canEdit ? `<section class="card">
      <h3>分團資料</h3>
      <form id="teamEdit">
        ${allow('settings') ? `<div class="grid2"><label>名稱<input name="name" maxlength="20" value="${esc(t.name)}" required></label>
          <label>顏色<input name="color" type="color" value="${esc(t.color)}"></label></div>` : ''}
        <div class="iconedit">${teamIcon(t, 'lg')}<div class="row" style="gap:8px">
          <label class="btn ghost sm filebtn">換分團圖示<input type="file" accept="image/png,image/jpeg,image/webp" id="iconIn" hidden></label>
          ${t.icon?.startsWith('/api/') ? '<button type="button" class="btn ghost sm" id="iconRm">改回預設</button>' : ''}</div>
          <span class="tiny">正方形圖，會自動縮成小圖。生圖指令見 docs/team-icons-prompt.md。</span></div>
        <label>介紹<textarea name="intro" maxlength="300" placeholder="練什麼、什麼時候練、適合誰">${esc(t.intro)}</textarea></label>
        <label>LINE 群組邀請連結<input name="line_url" type="url" value="${esc(t.line_url)}" placeholder="https://line.me/ti/g/…"></label>
        ${allow('settings') ? `<label>排序<input name="sort" type="number" min="0" max="99" value="${t.sort}"></label>
          <label class="switch"><span>私密分團（活動與 LINE 連結只給團員看）</span><input type="checkbox" name="private" ${t.private ? 'checked' : ''}><i></i></label>
          <label class="switch"><span>只由本團幹部管理成員<span class="tiny" style="display:block">例如公司團：協會幹部不能代為加入、核准或設成主團</span></span><input type="checkbox" name="self_managed" ${t.self_managed ? 'checked' : ''}><i></i></label>` : ''}
        <div class="row"><button class="btn sm">儲存</button>${allow('settings') ? '<button type="button" class="btn danger sm" id="delTeam">刪除分團</button>' : ''}</div>
      </form>
      ${allow('settings') ? '' : '<p class="tiny" style="margin:0">名稱、顏色與加入方式由行政人員設定。</p>'}
    </section>` : ''}

    <div class="statgrid">
    ${!t.private || inTeam || manage ? `<section class="card" id="boardCard"><div class="row spread"><h3>公告欄</h3>
      ${teamAllow(tid, 'event') ? '<button class="btn ghost sm" id="newPost">發公告</button>' : ''}</div><div id="board" class="board"><p class="muted" style="margin:0">載入中…</p></div></section>` : ''}
    ${inTeam || manage ? `<section class="card"><div class="row spread"><h3>里程排行榜</h3>
      <div class="seg" style="width:auto"><button data-lb="week" aria-pressed="true">本週</button><button data-lb="month" aria-pressed="false">本月</button></div></div>
      <div id="lb" class="roster"></div>
      <p class="tiny" style="margin:0" id="lbHint"></p></section>` : ''}
    </div>
    <a class="card" href="#/plan/new?team=${esc(tid)}" ${teamAllow(tid, 'appoint') ? '' : 'hidden'}><div class="row spread"><h3>發布分團課表</h3><span class="tiny">團長 ›</span></div></a>
    ${manage ? teamRosterCard(t, roster, q) : ''}`;
  loadBoard(t); if (inTeam || manage) loadBoardRank(tid, 'week');

  $('#joinTeam')?.addEventListener('click', async () => {
    try { await api(`/teams/${tid}/join`, { method: 'POST' }); toast('已送出申請，等幹部核准'); teamView(tid); } catch (e) { toast(e.message); }
  });
  $('#leaveTeam')?.addEventListener('click', async () => {
    if (!confirm(`確定${inTeam ? '退出' : '取消申請'}${t.name}？`)) return;
    try { await api(`/teams/${tid}/leave`, { method: 'POST' }); toast(inTeam ? '已退出' : '已取消申請'); teamView(tid); } catch (e) { toast(e.message); }
  });
  $('#teamEdit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { intro: f.intro.value, line_url: f.line_url.value.trim(),
      ...(f.name ? { name: f.name.value, color: f.color.value, join_policy: 'approve', private: f.private.checked, self_managed: f.self_managed.checked, sort: Number(f.sort.value) || 0 } : {}) };
    try { await api(`/teams/${tid}`, { method: 'PUT', body }); toast('已儲存'); teamView(tid); } catch (err) { toast(err.message); }
  });
  $('#iconIn')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { await api(`/teams/${tid}/icon`, { method: 'PUT', body: { icon: await squareIcon(file) } }); toast('已更新分團圖示'); teamView(tid); }
    catch (err) { toast(err.message || '這張圖讀不出來'); }
  });
  $('#iconRm')?.addEventListener('click', async () => {
    try { await api(`/teams/${tid}/icon`, { method: 'PUT', body: { icon: null } }); toast('已移除'); teamView(tid); } catch (err) { toast(err.message); }
  });
  $('#delTeam')?.addEventListener('click', async () => {
    if (!confirm(`刪除「${t.name}」？分團的活動會改成全協會活動，成員名單會清除。`)) return;
    try { await api(`/teams/${tid}`, { method: 'DELETE' }); toast('已刪除'); location.hash = '#/teams'; } catch (e) { toast(e.message); }
  });
  if (manage) bindTeamRoster(t, roster, q);
}
const teamMemberRow = (r) => (m) => `<div class="r">${avatar(m)}
    <span><b>${esc(m.name)}</b>${m.nickname ? ` <span class="tiny">${esc(m.nickname)}</span>` : ''}
      <span class="tiny" style="display:block">${esc(m.title || TEAM_ROLE_NAME[m.role])}・${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)} 組${m.membership === 'active' ? '・協會會員' : ''}</span></span>
    ${m.status === 'pending'
      ? (r.can.approve ? `<span class="row" style="gap:6px"><button class="btn sm" data-tm="approve" data-id="${m.id}">通過</button><button class="btn ghost sm" data-tm="remove" data-id="${m.id}">婉拒</button></span>` : '')
      : (r.can.appoint && (m.role !== 'lead' || r.can.lead)) || (r.can.approve && m.role === 'member')
        ? `<button class="btn ghost sm" data-tmrole="${m.id}" data-name="${esc(m.name)}" data-role="${m.role}" data-title="${esc(m.title || '')}">管理</button>` : ''}
  </div>`;
// 分團公告欄：置頂在前，一次 20 則
async function loadBoard(t) {
  const box = $('#board'); if (!box) return;
  const { posts, canPost } = await api(`/teams/${t.id}/posts`).catch(() => ({ posts: [] }));
  box.innerHTML = posts.map((p) => `<article class="post ${p.pinned ? 'pinned' : ''}">
    <div class="row spread"><b>${p.pinned ? '<span class="pill">置頂</span> ' : ''}${esc(p.title)}</b>
      ${p.author_id === me.id || teamAllow(t.id, 'appoint') ? `<button class="btn ghost sm" data-delpost="${p.id}" aria-label="刪除公告">刪除</button>` : ''}</div>
    ${p.body ? `<p style="margin:0;white-space:pre-wrap">${esc(p.body)}</p>` : ''}
    <span class="tiny">${esc(p.author_name || '')}・${ago(p.created_at)}</span></article>`).join('') || '<p class="muted" style="margin:0">還沒有公告</p>';
  for (const b of box.querySelectorAll('[data-delpost]')) b.onclick = async () => {
    if (!confirm('刪除這則公告？')) return;
    try { await api(`/teams/${t.id}/posts/${b.dataset.delpost}`, { method: 'DELETE' }); loadBoard(t); } catch (e) { toast(e.message); }
  };
  $('#newPost')?.addEventListener('click', () => {
    if ($('#postForm')) return;
    box.insertAdjacentHTML('beforebegin', `<form id="postForm" class="filters">
      <input name="title" maxlength="60" placeholder="標題" required>
      <textarea name="body" maxlength="3000" placeholder="內容（選填）"></textarea>
      <label class="inline"><input type="checkbox" name="pinned"> 置頂</label>
      <label class="inline"><input type="checkbox" name="notify" checked> 通知分團成員</label>
      <div class="row"><button class="btn sm">發布</button><button type="button" class="btn ghost sm" id="postX">取消</button></div></form>`);
    $('#postX').onclick = () => $('#postForm').remove();
    $('#postForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api(`/teams/${t.id}/posts`, { method: 'POST', body: { title: f.title.value, body: f.body.value, pinned: f.pinned.checked, notify: f.notify.checked } });
        f.remove(); toast('已發布'); loadBoard(t); } catch (err) { toast(err.message); }
    };
  }, { once: true });
  void canPost;
}
async function loadBoardRank(tid, period) {
  const box = $('#lb'); if (!box) return;
  for (const b of document.querySelectorAll('[data-lb]')) { b.setAttribute('aria-pressed', String(b.dataset.lb === period)); b.onclick = () => loadBoardRank(tid, b.dataset.lb); }
  try {
    const r = await api(`/teams/${tid}/leaderboard?period=${period}`);
    box.innerHTML = r.rows.map((x, i) => `<div class="r rank"><span class="no num">${i + 1}</span>${avatar(x)}<span>${esc(x.nickname || x.name)}<span class="tiny" style="display:block">${x.n} 次</span></span><b class="num">${x.km} km</b></div>`).join('')
      || '<p class="muted" style="margin:0">還沒有人上榜</p>';
    $('#lbHint').textContent = r.me ? '你有出現在排行榜上，可以在「我的 → 隱私」關掉。' : '排行榜只顯示自己同意上榜的人；想參加到「我的 → 隱私」打開。';
  } catch (e) { box.innerHTML = `<p class="muted" style="margin:0">${esc(e.message)}</p>`; }
}
function teamRosterCard(t, r, q) {
  const pending = r.pending, active = r.members, row = teamMemberRow(r);
  return `
    ${pending.length ? `<section class="card"><h3>待審核（${pending.length}）</h3><div class="roster">${pending.map(row).join('')}</div></section>` : ''}
    <section class="card">
      <div class="row spread"><h3>分團名冊</h3><span class="tiny">${q ? `符合 ${r.total} 人` : `${r.total} 人`}</span></div>
      <form id="tmq" class="row" style="gap:8px" role="search"><input name="q" value="${esc(q)}" placeholder="搜尋姓名或暱稱" aria-label="搜尋分團名冊" style="flex:1" autocomplete="off"><button class="btn ghost sm">搜尋</button></form>
      <div class="roster" id="tmList">${active.map(row).join('') || '<p class="muted" style="margin:0">沒有符合的團員</p>'}</div>
      ${r.next ? '<button class="btn ghost sm block" id="tmMore">載入更多</button>' : ''}
      <p class="tiny" style="margin:0">團長由理事長指派；團長可以指派分團幹部。分團名冊不顯示電話。</p>
    </section>
    ${r.can.add ? `<section class="card"><h3>把跑友加進${esc(t.name)}</h3>
      <form id="tmAdd" class="row" style="gap:8px" role="search"><input name="q" placeholder="輸入姓名搜尋（至少 1 個字）" aria-label="搜尋要加入的跑友" style="flex:1" autocomplete="off"><button class="btn ghost sm">搜尋</button></form>
      <div id="tmAddList" class="roster"></div></section>` : ''}`;
}
function bindTeamRoster(t, r, q) {
  const act = async (body, msg) => { try { await api(`/teams/${t.id}/members`, { method: 'POST', body }); toast(msg); teamView(t.id, q); } catch (e) { toast(e.message); } };
  for (const b of document.querySelectorAll('[data-tm]')) b.onclick = () => act({ member_id: b.dataset.id, action: b.dataset.tm }, b.dataset.tm === 'approve' ? '已通過' : '已婉拒');
  $('#tmq').onsubmit = (e) => { e.preventDefault(); teamView(t.id, e.target.q.value.trim()); };
  // 分頁：一次 50 人，往下接
  $('#tmMore')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const more = await api(`/teams/${t.id}/members?q=${encodeURIComponent(q)}&after=${r.next}`);
      $('#tmList').insertAdjacentHTML('beforeend', more.members.map(teamMemberRow(r)).join(''));
      r.next = more.next; bindRoles();
      if (r.next) e.target.disabled = false; else e.target.remove();
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });
  const bindRoles = () => { for (const b of document.querySelectorAll('[data-tmrole]')) b.onclick = () => {
    $('#tmDlg')?.remove();
    const opts = Object.entries(TEAM_ROLE_NAME).filter(([k]) => k !== 'lead' || r.can.lead).filter(([k]) => r.can.appoint || k === 'member');
    b.closest('.r').insertAdjacentHTML('afterend', `<form class="card tight" id="tmDlg">
      <div class="grid2"><label>分團身分<select name="role">${opts.map(([k, v]) => `<option value="${k}" ${b.dataset.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>職稱（選填）<input name="title" maxlength="12" value="${b.dataset.title}" placeholder="副團長、活動組"></label></div>
      <div class="row"><button class="btn sm">儲存</button><button type="button" class="btn danger sm" id="tmRm">移出分團</button><button type="button" class="btn ghost sm" id="tmX">取消</button></div></form>`);
    $('#tmX').onclick = () => $('#tmDlg').remove();
    $('#tmRm').onclick = () => confirm(`把 ${b.dataset.name} 移出${t.name}？`) && act({ member_id: b.dataset.tmrole, action: 'remove' }, '已移出');
    $('#tmDlg').onsubmit = (e) => { e.preventDefault(); act({ member_id: b.dataset.tmrole, action: 'role', role: e.target.role.value, title: e.target.title.value }, '已更新'); };
  }; };
  bindRoles();
  $('#tmAdd')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const qq = e.target.q.value.trim();
    if (!qq) return toast('請輸入姓名');
    const { members } = await api(`/members?q=${encodeURIComponent(qq)}`);
    $('#tmAddList').innerHTML = members.map((m) => `<div class="r">${avatar(m)}<span>${esc(m.name)}${m.nickname ? ` <span class="tiny">${esc(m.nickname)}</span>` : ''}</span>
      ${m.teams.some((x) => x.t === t.id && x.s === 'active') ? '<span class="tiny">已在團內</span>' : `<button class="btn ghost sm" data-addm="${m.id}">加入</button>`}</div>`).join('') || '<p class="muted" style="margin:0">找不到</p>';
    for (const x of document.querySelectorAll('[data-addm]')) x.onclick = () => act({ member_id: x.dataset.addm, action: 'add' }, '已加入');
  });
}

// ---------- 我的 ----------
// ---------- 我的：像 iPhone 設定一樣分組，每一列點進去是一頁 ----------
const ME_SECTIONS = {
  profile: '個人資料', races: '我的賽事與倒數', reg: '賽事報名資料', teams: '主團與分團', notify: '通知與裝置',
  security: '帳號與安全', privacy: '隱私', assoc: '協會',
};
const row = (href, icon, title, sub = '', badge = '') => `<a class="setrow" href="${href}"><span class="sic">${icon}</span><span class="st"><b>${title}</b>${sub ? `<span class="tiny">${sub}</span>` : ''}</span>${badge}<span class="chev" aria-hidden="true"></span></a>`;
const btnRow = (id, icon, title, sub = '') => `<button class="setrow" id="${id}"><span class="sic">${icon}</span><span class="st"><b>${title}</b>${sub ? `<span class="tiny">${sub}</span>` : ''}</span><span class="chev" aria-hidden="true"></span></button>`;
const group = (title, rows) => (rows.filter(Boolean).length ? `<section class="setgroup">${title ? `<h3 class="sgt">${title}</h3>` : ''}<div class="card setcard">${rows.filter(Boolean).join('')}</div></section>` : '');
const subTitle = (title, sub = '') => `<a class="backlink" href="#/me">‹ 我的</a>${largeTitle(title, sub)}`;
const MI = {
  person: IC.runner, report: ic('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'), flag: ic('<path d="M5.5 21V4M5.5 4.5h11l-2 3.7 2 3.8h-11"/>'),
  idcard: ic('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14.5 10h4M14.5 13.5h3"/>'),
  ticket: ic('<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M14 6v12" stroke-dasharray="2 2.5"/>'),
  team: ic('<circle cx="8" cy="9" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M2.8 19c.5-3 2.6-4.6 5.2-4.6s4.7 1.6 5.2 4.6M14 14.6c2.6-.4 5 .9 5.7 4.4"/>'),
  bell: ic('<path d="M6.4 9.6a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4Z"/><path d="M10.2 18.4a2 2 0 0 0 3.6 0"/>'), phone: ic('<rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M11 18h2"/>'), cal: IC.calendar,
  shield: ic('<path d="M12 3 5 6v5.5c0 4.4 3 8 7 9.5 4-1.5 7-5.1 7-9.5V6Z"/><path d="M9 12l2 2 4-4"/>'), lock: IC.lock,
  eye: ic('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  building: ic('<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3"/>'),
  admin: IC.gear, roster: ic('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  plan: IC.calendar, help: ic('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17.2v.1"/>'),
  out: ic('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4"/>'),
};
async function meView(section) {
  const welcome = new URLSearchParams(location.hash.split('?')[1] || '').get('welcome');
  const googleMsg = new URLSearchParams(location.hash.split('?')[1] || '').get('google');
  if (googleMsg) section = 'security';
  if (!section) return meHome(welcome);
  if (!ME_SECTIONS[section]) { location.hash = '#/me'; return; }
  return ({ profile: meProfile, races: meRaces, reg: meReg, teams: meTeams, notify: meNotify, security: meSecurity, privacy: mePrivacy, assoc: meAssoc })[section](googleMsg);
}
async function meHome(welcome) {
  const main = teamOf(me.main_team);
  const staff = allow('members') || allow('roles') || allow('settings') || allow('roster') || canPublishPlan();
  const regRow = await api('/me/race-profile').catch(() => null);
  view.innerHTML = `
    ${largeTitle('我的')}
    ${welcome ? '<div class="notice">歡迎加入！先到「個人資料」確認項目和組別；主團會由管理員設定。</div>' : ''}
    ${mfaBanner()}
    <a class="card mecard" href="#/me/profile">
      ${avatar(me)}
      <span class="mi"><b>${esc(me.name)}</b>${me.nickname ? ` <span class="tiny">${esc(me.nickname)}</span>` : ''}
        <span class="tiny" style="display:block">${esc(me.title || me.roleName || ROLE_NAME[me.role] || '團員')}・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組</span></span>
      ${main ? `<span class="pill team" style="--tc:${esc(main.color)}">${teamIcon(main, 'xs')}${esc(main.name)}</span>` : '<span class="pill">主團未設定</span>'}
    </a>
    ${group('我的跑步', [
      row('#/report', MI.report, '訓練報表', '週里程、完成率、個人最佳'),
      row('#/me/races', MI.flag, '我的賽事與倒數', '右上角倒數哪一場'),
      row('#/me/reg', MI.idcard, '賽事報名資料', '幹部代為團體報名時使用', regRow?.complete ? '<span class="pill solid">已填好</span>' : regRow?.profile ? '<span class="pill wait">未填完</span>' : ''),
      row('#/tickets', MI.ticket, '我的入場券與中獎紀錄'),
    ])}
    ${group('分團', [row('#/me/teams', MI.team, '主團與分團', main ? `主團：${esc(main.name)}` : '主團由管理員設定')])}
    ${group('設定', [
      row('#/me/notify', MI.bell, '通知與裝置', '推播、加到主畫面、行事曆、分頁列'),
      row('#/me/security', MI.shield, '帳號與安全', `${me.google ? 'Google 已綁定' : '綁定 Google'}、通行金鑰、登出`),
      row('#/me/privacy', MI.eye, '隱私', '分享給教練、排行榜、下載或刪除資料'),
    ])}
    ${group('協會', [row('#/me/assoc', MI.building, esc(org().name || '台灣耕跑團協會'), `${esc(me.membershipName || '跑友')}・入會、章程與文件`)])}
    ${staff ? group('幹部專區', [
      (allow('members') || allow('roles') || allow('settings')) ? row('#/admin', MI.admin, '管理後台', '總覽、會員、權限、分團、系統設定') : '',
      allow('roster') ? row('#/roster', MI.roster, '團員名冊') : '',
      canPublishPlan() ? row('#/plan/new', MI.plan, '發布課表', allow('plan') ? '教練' : '分團團長') : '',
    ]) : ''}
    ${group('', [btnRow('openGuide', MI.help, '使用說明', '一分鐘帶你看過每個功能')])}`;
  bindStepup();
  $('#openGuide').onclick = () => Guide.start();
}
function meProfile() {
  view.innerHTML = `${subTitle('個人資料', '報名時會直接帶入，不用每次重填')}
    <section class="card">
      <div class="row">${avatar(me)}<div style="flex:1"><b>${esc(me.name)}</b><div class="tiny">${esc(me.title || me.roleName || ROLE_NAME[me.role] || '團員')}</div></div></div>
      <form id="mf">
        <div class="grid2"><label>姓名<input name="name" value="${esc(me.name)}" maxlength="20"></label>
          <label>暱稱<input name="nickname" value="${esc(me.nickname || '')}" maxlength="20" placeholder="團裡怎麼叫你"></label></div>
        <div class="grid2"><label>項目<select name="dist"><option value="fm" ${me.dist === 'fm' ? 'selected' : ''}>全馬</option><option value="hm" ${me.dist === 'hm' ? 'selected' : ''}>半馬</option></select></label>
          <label>組別<select name="grp"></select></label></div>
        <div class="field"><span class="flabel">所屬跑團</span><span class="fvalue">${esc(teamOf(me.main_team)?.name || '等待管理員設定')}</span><span class="tiny">跟著主團，由管理員設定</span></div>
        <div class="grid2"><label>餐點偏好<select name="meal_pref"><option value="" ${!me.meal_pref ? 'selected' : ''}>未指定</option>
            <option ${me.meal_pref === '葷食' ? 'selected' : ''}>葷食</option><option ${me.meal_pref === '素食' ? 'selected' : ''}>素食</option></select></label>
          <label>電話（選填）<input name="phone" value="${esc(me.phone || '')}" maxlength="20" inputmode="tel" placeholder="餐會聯絡用"></label></div>
        <button class="btn block">儲存</button>
      </form>
    </section>`;
  const f = $('#mf');
  const sync = () => {
    f.grp.innerHTML = Object.entries(P.groups(f.dist.value)).map(([g, v]) => `<option value="${g}">${g} 組・${v[0]}</option>`).join('');
    f.grp.value = Object.keys(P.groups(f.dist.value)).includes(me.grp) ? me.grp : (f.dist.value === 'hm' ? 'C' : 'D');
  };
  f.dist.onchange = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { me = (await api('/me', { method: 'PUT', body: { name: f.name.value, dist: f.dist.value, grp: f.grp.value, nickname: f.nickname.value, meal_pref: f.meal_pref.value, phone: f.phone.value } })).member; toast('已儲存'); }
    catch (err) { toast(err.message); }
  };
}
async function meRaces() {
  view.innerHTML = `${subTitle('我的賽事與倒數', '右上角倒數主要賽事；點右上角倒數也能直接換')}
    <section class="card"><div id="raceList" class="roster"></div></section>
    <section class="card"><h3>加一場比賽</h3>
      <form id="raceForm">
        <div class="grid2"><label>賽事名稱<input name="name" maxlength="30" placeholder="2026 臺北馬拉松" required></label><label>日期<input type="date" name="date" required></label></div>
        <div class="grid2"><label>距離<select name="dist"><option>全馬</option><option>半馬</option><option>10K</option><option>5K</option><option>超馬</option><option>其他</option></select></label>
          <label>目標成績<input name="goal" maxlength="10" placeholder="3:39:59"></label></div>
        <button class="btn block">加入賽事</button>
      </form></section>
    <button class="btn ghost block" id="pickCd">從常用賽事挑，或改成協會預設／不顯示</button>`;
  const refreshCfg = async () => { const r = await api('/me'); me = r.member; cfg = r; paintCountdown(); };
  const load = async () => {
    const { races } = await api('/races');
    if (!$('#raceList')) return;
    $('#raceList').innerHTML = races.map((r) => {
      const d = Math.round((new Date(`${r.date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
      return `<div class="r"><span class="av num" style="font-size:11px">${d >= 0 ? d : IC.check}</span>
        <span><b>${esc(r.name)}</b>${r.is_primary ? ' <span class="pill solid">倒數中</span>' : ''}
          <span class="tiny" style="display:block">${esc(r.date)}・${esc(r.dist || '')}${r.goal ? `・目標 ${esc(r.goal)}` : ''}${d >= 0 ? `・還有 ${d} 天` : '・已完賽'}</span></span>
        <span class="row" style="gap:6px">${r.is_primary ? '' : `<button class="btn ghost sm" data-prim="${r.id}">倒數這場</button>`}<button class="btn danger sm" data-delrace="${r.id}" aria-label="刪除">刪除</button></span></div>`;
    }).join('') || '<p class="tiny" style="margin:0">還沒有賽事，加一場吧。</p>';
    for (const b of document.querySelectorAll('[data-prim]')) b.onclick = async () => { await api(`/races/${b.dataset.prim}/primary`, { method: 'POST' }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); await load(); await refreshCfg(); toast('右上角改成倒數這場'); };
    for (const b of document.querySelectorAll('[data-delrace]')) b.onclick = async () => { if (!confirm('刪除這場賽事？')) return; await api(`/races/${b.dataset.delrace}`, { method: 'DELETE' }); await load(); await refreshCfg(); };
  };
  load();
  $('#raceForm').onsubmit = async (e) => { e.preventDefault(); const f = e.target;
    try { await api('/races', { method: 'POST', body: { name: f.name.value, date: f.date.value, dist: f.dist.value, goal: f.goal.value } }); f.reset(); await load(); await refreshCfg(); toast('已加入賽事'); } catch (err) { toast(err.message); } };
  $('#pickCd').onclick = () => countdownPicker();
}
// 賽事報名資料：加密保存，只有自己看得到；報名「代為團體報名」的活動並同意後，那場的主辦幹部才能下載
async function meReg() {
  const d = await api('/me/race-profile');
  const p = d.profile || {}, F = d.fields;
  const lt = (k, label) => `<span class="lt">${label || F[k].label}${F[k].req ? '<span class="req">必填</span>' : ''}</span>`;
  const input = (k, type = 'text', extra = '', label = '') => `<label>${lt(k, label)}<input name="${k}" type="${type}" maxlength="${F[k].max}" value="${esc(p[k] || '')}" ${extra}></label>`;
  const select = (k, opts) => `<label>${lt(k)}<select name="${k}"><option value="">請選擇</option>${opts.map((g) => `<option ${p[k] === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>`;
  view.innerHTML = `${subTitle('賽事報名資料', '填一次，之後幹部代為團體報名都用這份')}
    <section class="card notice-card"><b>${IC.lock} 這份資料怎麼保護</b>
      <ul class="steps"><li>加密後才存進資料庫，只有你自己看得到完整內容</li>
        <li>只有在你報名「由幹部代為團體報名」的活動、並勾選同意時，那一場的主辦幹部才能下載</li>
        <li>每次下載都會留下稽核紀錄；你可以隨時修改或刪除</li></ul></section>
    <form id="regForm" class="card regform">
      <div class="grid2">${input('name_zh')}${input('name_en', 'text', 'autocapitalize="characters" placeholder="WANG DA-MING"')}</div>
      <label>${lt('id_no')}<span class="idwrap"><input name="id_no" maxlength="${F.id_no.max}" value="${esc(p.id_no || '')}" autocomplete="off" autocapitalize="characters" spellcheck="false" type="password"><button type="button" class="btn ghost sm" id="idShow">顯示</button></span></label>
      <div class="grid2">${input('birthday', 'date')}${select('gender', ['男', '女', '其他'])}</div>
      <div class="grid2">${input('phone', 'tel', 'inputmode="tel" autocomplete="tel"')}${select('shirt', ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'])}</div>
      ${input('email', 'email', 'autocomplete="email"')}
      ${input('address', 'text', 'autocomplete="street-address"')}
      <fieldset class="group"><legend>緊急聯絡人</legend>
        <div class="grid2">${input('emergency_name', 'text', '', '姓名')}${input('emergency_phone', 'tel', 'inputmode="tel"', '電話')}</div>
        ${input('emergency_rel', 'text', 'placeholder="配偶、父母…"', '關係')}</fieldset>
      ${input('note', 'text', 'placeholder="外籍、身障組、其他需求"')}
      <button class="btn block">儲存</button>
      ${d.profile ? '<button type="button" class="btn danger block" id="regDel">刪除我的賽事報名資料</button>' : ''}
      ${d.updated_at ? `<p class="tiny center" style="margin:0">上次更新：${ago(d.updated_at)}</p>` : ''}
    </form>`;
  $('#idShow').onclick = () => { const i = $('#regForm').id_no; i.type = i.type === 'password' ? 'text' : 'password'; $('#idShow').textContent = i.type === 'password' ? '顯示' : '隱藏'; };
  $('#regForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).trim()]));
    try { const r = await api('/me/race-profile', { method: 'PUT', body }); toast(r.complete ? '已儲存，可以報名代為團體報名的活動了' : '已儲存，還有必填欄位沒填'); meReg(); } catch (err) { toast(err.message); }
  };
  $('#regDel')?.addEventListener('click', async () => {
    if (!confirm('刪除後，已經同意提供的活動也會一併撤回。確定刪除？')) return;
    await api('/me/race-profile', { method: 'DELETE' }); toast('已刪除'); meReg();
  });
}
function meTeams() {
  const main = teamOf(me.main_team), led = teams().filter((t) => t.id !== me.main_team && (t.my_status === 'active' || t.my_status === 'pending'));
  view.innerHTML = `${subTitle('主團與分團', '主團由管理員設定；想加入其他分團，申請後由該團幹部核准')}
    <section class="card">
      <h3>主團</h3>
      ${main ? `<a class="teamchip active" href="#/t/${esc(main.id)}" style="--tc:${esc(main.color)}">${teamIcon(main, 'xs')}<span>${esc(main.name)}</span><span class="tiny">主團</span></a>`
        : '<p class="notice" style="margin:0">管理員還沒幫你設定主團，設定好之後就會收到分團的活動與公告。</p>'}
      ${led.length ? `<h3>其他分團</h3><div class="teamrow">${led.map((t) => `<a class="teamchip ${t.my_status}" href="#/t/${esc(t.id)}" style="--tc:${esc(t.color)}">${teamIcon(t, 'xs')}<span>${esc(t.name)}</span><span class="tiny">${t.my_status === 'pending' ? '申請中' : esc(t.my_title || TEAM_ROLE_NAME[t.my_role])}</span></a>`).join('')}</div>` : ''}
    </section>
    <a class="btn ghost block" href="#/teams">看全部分團</a>`;
}
async function meNotify() {
  const reg = await Promise.race([navigator.serviceWorker?.ready.catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  const sub = await reg?.pushManager?.getSubscription().catch(() => null);
  view.innerHTML = `${subTitle('通知與裝置')}
    <section class="card">
      <h3>推播通知</h3>
      ${cfg.vapid ? `<p class="muted" style="margin:0">新團練、候補遞補、教練回饋都會通知你。${isStandalone() ? '' : '在 iPhone 上要先「加到主畫面」，再從主畫面打開才收得到。'}</p>
        <div class="row"><button class="btn sm" id="pushBtn">${sub ? '關閉通知' : '開啟通知'}</button>${sub ? '<button class="btn ghost sm" id="pushTest">發測試通知</button>' : ''}</div>`
        : '<p class="muted" style="margin:0">推播功能尚未啟用。</p>'}
    </section>
    ${installCard('me')}
    <section class="card" id="calCard">
      <div class="row spread"><h3>訂閱到手機行事曆</h3>${cfg.calendarOn ? '<span class="pill solid">已開啟</span>' : ''}</div>
      <p class="tiny" style="margin:0">報名的團練與活動會自動出現在 iPhone、Google 行事曆，取消報名也會跟著消失。訂閱網址等同你的個人鑰匙，不要分享給別人。</p>
      <div id="calBox" class="row" style="gap:8px">${cfg.calendarOn ? '<button class="btn ghost sm" id="calNew">重新產生網址</button><button class="btn ghost sm" id="calOff">停用</button>' : '<button class="btn sm" id="calNew">產生訂閱網址</button>'}</div>
    </section>
    <section class="card"><h3>顯示</h3>
      <label class="switch"><span>分頁列只顯示圖示<span class="tiny" style="display:block">隱藏下方圖示底下的文字</span></span><input type="checkbox" id="iconsOnly" ${iconsOnly.get() ? 'checked' : ''}><i></i></label></section>`;
  $('#pushBtn')?.addEventListener('click', () => togglePush(sub));
  $('#pushTest')?.addEventListener('click', async () => { try { await api('/push/test', { method: 'POST' }); toast('已送出測試通知'); } catch (e) { toast(e.message); } });
  bindInstall();
  $('#iconsOnly').onchange = (e) => { iconsOnly.set(e.target.checked); applyTabs(); };
  $('#calNew').onclick = async () => {
    if (cfg.calendarOn && !confirm('重新產生後，已經訂閱的舊網址會失效，要在行事曆重新訂閱。確定？')) return;
    try {
      const { url } = await api('/me/calendar', { method: 'POST' });
      cfg.calendarOn = true;
      $('#calBox').outerHTML = `<div style="display:grid;gap:8px"><a class="btn block" href="${esc(url.replace(/^https:/, 'webcal:'))}">加到 iPhone／Mac 行事曆</a>
        <div class="row" style="gap:8px"><input readonly value="${esc(url)}" aria-label="行事曆訂閱網址" style="flex:1;font-size:13px" onfocus="this.select()"><button class="btn ghost sm" id="calCopy">複製</button></div>
        <p class="tiny" style="margin:0">Google 行事曆：電腦版左側「其他日曆 → 透過網址新增」，貼上這個網址。這個網址只會顯示這一次。</p></div>`;
      $('#calCopy').onclick = () => copy(url);
    } catch (e) { toast(e.message); }
  };
  $('#calOff')?.addEventListener('click', async () => { await api('/me/calendar', { method: 'DELETE' }); cfg.calendarOn = false; toast('已停用行事曆訂閱'); meNotify(); });
}
async function meSecurity(googleMsg) {
  view.innerHTML = `${subTitle('帳號與安全')}
    ${googleMsg === 'linked' ? '<div class="notice">已綁定 Google，之後可以直接用 Google 登入。</div>' : googleMsg === 'taken' ? '<div class="notice">這個 Google 帳號已經綁定另一個帳號了。如果那個帳號也是你的，請聯絡行政人員合併。</div>' : ''}
    ${mfaBanner()}
    ${cfg.googleLogin ? `<section class="card"><div class="row spread"><div><h3>Google 帳號</h3><span class="tiny">${me.google ? '已綁定，可以用 Google 登入' : '綁定後換手機或清掉瀏覽器資料，也能用 Google 回到同一個帳號'}</span></div>
      ${me.google ? '<span class="pill solid">已綁定</span>' : `<a class="btn google sm" href="${googleHref(true)}">${GOOGLE_G}<span>綁定</span></a>`}</div></section>` : ''}
    <section class="card" id="pkCard">
      <div class="row spread"><h3>通行金鑰</h3>${me.mfa ? `<span class="pill solid">${IC.check}這次已驗證</span>` : ''}</div>
      <p class="tiny" style="margin:0">用 Face ID、Touch ID 或手機指紋登入，不用密碼。${['chair', 'director', 'supervisor', 'staff', 'coach'].includes(me.realRole || me.role) ? '幹部建議至少新增一把，協會開啟兩步驟驗證後要用它驗證。' : ''}</p>
      <div id="pkList" class="roster"></div>
      <div class="row" style="gap:8px">${pkSupported() ? `<button class="btn sm" id="pkAdd">${IC.plus}新增通行金鑰</button>` : '<span class="tiny">這個瀏覽器不支援通行金鑰</span>'}
        <button class="btn ghost sm" data-stepup id="pkTest" hidden>驗證一次</button></div>
    </section>
    ${me.role !== 'member' ? '' : `<details class="card tight"><summary class="tiny">系統初始設定（只限第一位理事長）</summary>
      <p class="tiny">幹部身分一律由理事長在後台指派。這裡只用在系統剛建立、還沒有理事長的時候。</p>
      <form id="af" class="row" style="gap:8px"><input name="code" placeholder="初始設定碼" aria-label="初始設定碼" style="flex:1;min-width:140px" autocomplete="off"><button class="btn sm">設定</button></form></details>`}
    ${group('', [btnRow('logout', MI.out, '登出'), btnRow('logoutAll', MI.lock, '登出所有裝置', '手機掉了或懷疑被別人登入時')])}`;
  bindStepup();
  const loadPk = async () => {
    const { passkeys } = await api('/passkeys');
    if (!$('#pkList')) return;
    $('#pkList').innerHTML = passkeys.map((p) => `<div class="r">${IC.lock}<span>${esc(p.name || '通行金鑰')}<span class="tiny" style="display:block">新增於 ${esc(p.created_at.slice(0, 10))}${p.last_used_at ? `・上次使用 ${ago(p.last_used_at)}` : ''}</span></span>
      <button class="btn ghost sm" data-pkdel="${esc(p.id)}">移除</button></div>`).join('');
    $('#pkTest').hidden = !passkeys.length || me.mfa;
    for (const b of document.querySelectorAll('[data-pkdel]')) b.onclick = async () => { if (!confirm('移除這把通行金鑰？之後這台裝置就不能用它登入。')) return; await api(`/passkeys/${encodeURIComponent(b.dataset.pkdel)}`, { method: 'DELETE' }); toast('已移除'); loadPk(); };
  };
  loadPk().catch(() => {});
  $('#pkAdd')?.addEventListener('click', async () => {
    try { await passkey('register'); toast('已新增通行金鑰'); try { await passkey('stepup'); me = null; render(); return; } catch {} loadPk(); }
    catch (e) { if (e.message !== '已取消') toast(e.message); }
  });
  $('#af')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { me = (await api('/me/admin', { method: 'POST', body: { code: e.target.code.value } })).member; toast('已設定為理事長'); render(); } catch (err) { toast(err.message); }
  });
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); clearDeviceData(); me = null; location.hash = '#/'; render(); };
  $('#logoutAll').onclick = async () => { if (!confirm('要登出所有裝置嗎？包含這一台。')) return; await api('/logout', { method: 'POST', body: { all: true } }); clearDeviceData(); me = null; location.hash = '#/'; render(); };
}
function mePrivacy() {
  view.innerHTML = `${subTitle('隱私')}
    <section class="card">
      <label class="switch"><span>把訓練完成率與里程分享給教練與分團幹部<span class="tiny" style="display:block">備註永遠只有你看得到</span></span><input type="checkbox" id="shareLogs" ${me.share_logs ? 'checked' : ''}><i></i></label>
      <label class="switch"><span>出現在分團里程排行榜<span class="tiny" style="display:block">只有同分團的人看得到你的名字與里程</span></span><input type="checkbox" id="showRank" ${me.show_rank ? 'checked' : ''}><i></i></label>
    </section>
    <section class="card"><h3>我們存了什麼</h3>
      <p class="tiny" style="margin:0">姓名、暱稱、組別、主團、餐點偏好、報名與訓練紀錄；賽事報名資料加密保存；電話只有行政人員看得到完整號碼。</p>
      <div class="row"><a class="btn ghost sm" href="#/privacy">隱私權政策</a><a class="btn ghost sm" href="/api/me/export" download>下載我的資料</a></div></section>
    <section class="card"><h3>刪除帳號</h3><p class="tiny" style="margin:0">報名、入場券、通知與訓練紀錄都會刪除，中獎紀錄只留獎項給協會對帳。</p>
      <button class="btn danger block" id="delAcct">刪除我的帳號</button></section>`;
  $('#showRank').onchange = async (e) => { try { await api('/me/show-rank', { method: 'POST', body: { on: e.target.checked } }); me.show_rank = e.target.checked; toast(e.target.checked ? '已加入排行榜' : '已退出排行榜'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#shareLogs').onchange = async (e) => { try { await api('/me/share-logs', { method: 'POST', body: { share: e.target.checked } }); me.share_logs = e.target.checked; toast(e.target.checked ? '已分享給教練' : '已停止分享'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#delAcct').onclick = async () => {
    if (!confirm('刪除後無法復原。確定刪除帳號？')) return;
    try { await api('/me', { method: 'DELETE' }); clearDeviceData(); me = null; toast('帳號已刪除'); location.hash = '#/'; render(); } catch (e) { toast(e.message); }
  };
}
function meAssoc() {
  view.innerHTML = `${subTitle(esc(org().name || '台灣耕跑團協會'))}
    <section class="card">
      <div class="row spread"><h3>會籍</h3><span class="pill ${me.membership === 'active' ? 'solid' : me.membership === 'applied' ? 'wait' : ''}">${esc(me.membershipName || '跑友')}</span></div>
      ${me.membership === 'active'
        ? `<p class="muted" style="margin:0">${esc(me.member_type || '會員')}${me.member_no ? `・編號 ${esc(me.member_no)}` : ''}${me.paid_until ? `・會費繳至 ${esc(me.paid_until)}` : ''}</p>`
        : `<p class="muted" style="margin:0">跑友可以報名所有團練；想加入協會，先填官方入會表單，再按下方按鈕通知行政人員。</p>
           ${org().join_form ? `<a class="btn ghost block" href="${esc(org().join_form)}" target="_blank" rel="noopener">開啟入會表單 ${IC.external}</a>` : ''}
           ${me.membership === 'applied' ? '<p class="notice" style="margin:0">已送出申請，等行政人員確認。</p>' : '<button class="btn block" id="applyBtn">我已填表，送出申請</button>'}`}
    </section>
    ${(cfg.settings?.docs || []).length || org().contact || org().parent ? `<section class="card"><h3>協會資訊</h3>
      ${org().parent ? `<p class="tiny" style="margin:0">所屬企業：${org().parent_url ? `<a href="${esc(org().parent_url)}" target="_blank" rel="noopener">${esc(org().parent)} ${IC.external}</a>` : esc(org().parent)}${org().parent_note ? `・${esc(org().parent_note)}` : ''}</p>` : ''}
      ${org().contact ? `<p class="tiny" style="margin:0">聯絡方式：${esc(org().contact)}</p>` : ''}
      <div class="doclist">${(cfg.settings?.docs || []).map((d) => `<a class="docrow" href="${esc(d.url)}" target="_blank" rel="noopener"><span class="docic">${IC.doc}</span><span><b>${esc(d.title)}</b>${d.note ? `<span class="tiny" style="display:block">${esc(d.note)}</span>` : ''}</span><span class="tiny">${IC.external}</span></a>`).join('')}</div>
    </section>` : ''}`;
  $('#applyBtn')?.addEventListener('click', async () => { try { me = (await api('/me/apply', { method: 'POST' })).member; toast('已送出申請'); meAssoc(); } catch (e) { toast(e.message); } });
}

async function togglePush(sub) {
  try {
    const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!reg) return toast('這個瀏覽器不支援通知，請用 Safari 或 Chrome 打開，並加到主畫面');
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
      toast('已關閉通知'); render(); return;
    }
    if ((await Notification.requestPermission()) !== 'granted') return toast('瀏覽器沒有允許通知');
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(cfg.vapid) });
    const j = s.toJSON();
    await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
    toast('已開啟通知'); render();
  } catch (e) { toast(e.message || '通知設定失敗'); }
}
const urlB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

// ---------- 路由 ----------
// 畫面一次只畫一個：還在載入時又換頁（例如剛登入就點「我的」），等這次畫完再畫最新的網址，
// 避免比較慢的舊畫面最後才完成、把新畫面蓋掉
let rendering = null, renderAgain = false;
async function render() {
  if (rendering) { renderAgain = true; return rendering; }
  rendering = (async () => { do { renderAgain = false; await renderOnce(); } while (renderAgain); })();
  try { await rendering; } finally { rendering = null; }
}
async function renderOnce() {
  if (stopScan) { stopScan(); stopScan = null; }
  const raw = location.hash.replace(/^#/, '') || '/';
  const hash = raw.split('?')[0];
  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === '/' ? hash === '/' : hash.startsWith(a.dataset.tab);
    a.toggleAttribute('aria-current', on);
  }
  paintCountdown();
  if (!me) {
    try { const r = await api('/me'); me = r.member; cfg = r; } catch { me = null; }
  }
  paintCountdown();
  applyFeatures();
  $('#bell').hidden = !me;
  if (hash === '/privacy') { if (!me) { try { const r = await api('/me'); me = r.member; cfg = r; } catch {} } return privacyView(); }
  if (!me) return loginView();
  if (cfg.needConsent) {
    // 記住原本要去的頁面（例如捷徑帶數據進來），同意後再回去
    try { sessionStorage.setItem('cil-after-consent', location.hash); } catch {}
    location.hash = '#/privacy'; return;
  }
  // 登入前點的是分享連結：登入後回到那個活動
  try {
    const after = sessionStorage.getItem('cil-after-login');
    if (after) { sessionStorage.removeItem('cil-after-login'); if (after !== location.hash) { location.hash = after; return; } }
  } catch {}
  bell();
  $('#ctitle').textContent = '';
  const skel = setTimeout(() => { view.innerHTML = '<div class="skel" aria-label="載入中"><i></i><i></i><i></i></div>'; }, 150);
  try { await route(hash); } finally { clearTimeout(skel); }
  $('.top').classList.toggle('titled', false);
}

async function route(hash) {
  try {
    if (hash === '/') return await listView();
    if (hash === '/past') return await pastView();
    if (hash === '/coach') { location.replace('#/plan'); return; }
    if (hash === '/studio') return feat('studio') ? await studioView() : (view.innerHTML = `<div class="card">${emptyState('runner', '這個功能目前沒有開放')}</div>`);
    if (hash === '/notifications') return await notificationsView();
    if (hash === '/roster') return await rosterView();
    if (hash === '/admin') return await adminView();
    if (hash === '/plan/new') return planNewView();
    if (hash === '/me') return await meView();
    const mesec = hash.match(/^\/me\/(\w+)$/);
    if (mesec) return await meView(mesec[1]);
    if (hash === '/teams') return await teamsView();
    if (hash === '/tickets') return await ticketsView();
    if (hash === '/log') return await logView();
    if (hash === '/run') return feat('gps') ? await runView() : (view.innerHTML = `<div class="card">${emptyState('runner', '這個功能目前沒有開放')}</div>`);
    if (hash === '/logs/team') return await logsTeamView();
    if (hash === '/report') return await reportView();
    const lm = hash.match(/^\/logs\/m\/([\w-]+)$/);
    if (lm) return await memberLogsView(lm[1]);
    const tm = hash.match(/^\/t\/([\w-]+)$/);
    if (tm) return await teamView(tm[1]);
    const st = hash.match(/^\/e\/([\w-]+)\/stats$/);
    if (st) return await statsView(st[1]);
    if (hash === '/new') return await formView(null);
    const edit = hash.match(/^\/edit\/([\w-]+)$/);
    if (edit) return await formView(edit[1]);
    const at = hash.match(/^\/e\/([\w-]+)\/attend$/);
    if (at) return await attendView(at[1]);
    const ci = hash.match(/^\/e\/([\w-]+)\/in\/([\w-]+)$/);
    if (ci) return await checkinView(ci[1], ci[2].toUpperCase());
    const sc = hash.match(/^\/e\/([\w-]+)\/scan$/);
    if (sc) return await scanView(sc[1]);
    const ev = hash.match(/^\/e\/([\w-]+)$/);
    if (ev) return await eventView(ev[1]);
    const pl = hash.match(/^\/plan(?:\/(\d+))?$/);
    if (pl) return await planView(pl[1] ? Number(pl[1]) : 0);
    view.innerHTML = `<div class="card">${emptyState('runner', '找不到這個頁面')}</div>`;
  } catch (e) {
    view.innerHTML = `<div class="card">${emptyState('runner', esc(e.message))}</div>`;
  }
}

// 深淺色：跟隨系統，按鈕可以手動覆寫並記住
const theme = {
  get() { try { return localStorage.getItem('cil-theme'); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem('cil-theme', v) : localStorage.removeItem('cil-theme'); } catch {} },
};
const applyTheme = () => {
  const t = theme.get();
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
};
applyTheme();
$('#theme').onclick = () => {
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light')) === 'dark';
  theme.set(dark ? 'light' : 'dark');
  applyTheme();
};

// 捲動：超過一點點就讓頂部列變成玻璃；大標題捲出畫面就把標題顯示在頂部列；往下捲時分頁列縮小
let lastY = 0;
addEventListener('scroll', () => {
  const y = scrollY, top = $('.top'), lt = $('.lt h1');
  top.classList.toggle('stuck', y > 4);
  top.classList.toggle('titled', !!lt && lt.getBoundingClientRect().bottom < top.offsetHeight);
  $('#tabs').classList.toggle('mini', y > lastY && y > 120);
  lastY = y;
}, { passive: true });

// 滑鼠反光：只在有游標的裝置，追蹤游標在卡片上的位置
if (matchMedia('(hover:hover) and (pointer:fine)').matches) {
  addEventListener('pointermove', (e) => {
    const c = e.target.closest?.('.card.lit');
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`);
    c.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}

// 換頁用 View Transition（支援的瀏覽器才有）
const go = () => { render(); scrollTo({ top: 0, behavior: 'instant' }); };
addEventListener('hashchange', () => {
  if (!document.startViewTransition) return go();
  // 連續換頁時前一個轉場會被中斷；三個 promise 都會 reject，全部接住
  const t = document.startViewTransition(go);
  for (const p of [t.ready, t.updateCallbackDone, t.finished]) p.catch(() => {});
});
render();
// Service Worker：新版本裝好後先等待，跳出提示讓使用者決定什麼時候更新
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const ask = (w) => {
      if (!w) return;
      if (!hadController) { w.postMessage({ type: 'SKIP_WAITING' }); return; }   // 第一次安裝直接啟用
      if (document.getElementById('updbar')) return;
      const bar = document.createElement('div');
      bar.id = 'updbar'; bar.className = 'updbar'; bar.role = 'status';
      bar.innerHTML = '<span>耕跑團有新版本</span><button class="btn sm">更新</button><button class="btn ghost sm" aria-label="稍後">稍後</button>';
      bar.querySelector('.btn').onclick = () => { w.postMessage({ type: 'SKIP_WAITING' }); bar.remove(); };
      bar.querySelector('.ghost').onclick = () => bar.remove();
      document.body.append(bar);
    };
    if (reg.waiting) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') ask(w); });
    });
    // 打開 App、切回前景時檢查有沒有新版本
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
}
// 記住安裝提示（Android／桌機 Chrome），在「我的」與首頁顯示安裝按鈕
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = false; }); });
addEventListener('appinstalled', () => { installEvt = null; try { localStorage.setItem('cil-installed', '1'); } catch {} document.querySelectorAll('.installcard').forEach((c) => c.remove()); });
