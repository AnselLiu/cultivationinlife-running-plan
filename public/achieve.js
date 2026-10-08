// 耕跑團 PWA — achieve.js：成績與挑戰的團員畫面（用到才載入）
//   #/pb 我的成績（官方 PB、登錄與審核狀態、徽章）、#/pb/new 與 #/pb/<id>/edit 登錄成績、
//   #/ach 目標挑戰、#/ach/c/<id> 挑戰詳細（進度、見證量測的 QR、榮譽制的本機紀錄、團服）、#/cheers 恭喜榜
//   規則（距離、時間格式、條件句、圖示）在 achrule.js，跟伺服器同一份；共用的工具與狀態從 app.js 拿
//   個資最少：成績截圖在手機上用 canvas 重新編碼（去掉 EXIF 與定位）；榮譽制的體重只存在這台裝置（cil-ach，登出清掉）；
//   見證碼面板的體重數字預設遮住；恭喜只顯示人數；分享只分享自己的成就
import {
  api, avatar, btnRow, choose, coachPrefs, copy, emptyState, esc, fieldError, focusEl, ic, largeTitle, me, nowTp, once, openSheet, org, qrSVG, row,
  scanSheet, teams, toast, view, achOn, achRankOn, announce
} from './app.js';
import * as I18N from './i18n.js';
import {
  DISTS, STD, distLabel, distFromRace, kmOf, kmOk, parseTime, fmtTime, fmtPace, timeOk, pctDown, x10, kgOk, addDays, daysBetween,
  ACH_ICONS, KIND_ICON, ruleLines, LIMITS
} from './achrule.js';

// ---------- 共用 ----------
// 這台裝置上的紀錄（登出、換人時由 device.js 清掉）：seen 看過的已通過成績（新 PB 的光帶只出現一次）、honor 榮譽制體重挑戰的本機紀錄
const STORE = 'cil-ach';
const local = {
  get() { try { const v = JSON.parse(localStorage.getItem(STORE) || 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } },
  set(patch) { try { localStorage.setItem(STORE, JSON.stringify({ ...local.get(), ...patch })); } catch {} },
};
const today = () => nowTp().slice(0, 10);
const md = (s) => (s ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : '');
const slash = (s) => (s ? String(s).slice(0, 10).replace(/-/g, '/') : '');
// 伺服器的時間是 UTC 'YYYY-MM-DD HH:MM:SS'：換成毫秒、台北日期
const utcMs = (s) => (s ? Date.parse(String(s).includes('T') ? s : `${String(s).replace(' ', 'T')}Z`) : NaN);
const tpDay = (s) => { const t = utcMs(s); return Number.isFinite(t) ? new Date(t + 8 * 3600e3).toISOString().slice(0, 10) : ''; };
const dname = (p) => distLabel(p.dist_key, p.km);
const who = (m) => m?.nickname || m?.name || '';
const $id = (id) => document.getElementById(id);
const hashQ = () => new URLSearchParams(location.hash.split('?')[1] || '');
const onPage = (h) => location.hash.split('?')[0] === h;
// 類型的色磚（跟後台同一組）
const KIND_TILE = { pb: 'orange', time: 'indigo', pace: 'green', weight: 'teal', km: 'blue', attend: 'purple' };
const kindTile = (kind, cls = '') => `<span class="sic ${cls}" style="--sc:var(--tile-${KIND_TILE[kind] || 'gray'})" aria-hidden="true">${ic(ACH_ICONS[KIND_ICON[kind]] || ACH_ICONS.trophy)}</span>`;
const teamPill = (t) => (t ? `<span class="pill team" style="--tc:${esc(t.color || '#1C4698')}"><span translate="no">${esc(t.name)}</span></span>` : '');
const scopePill = (c) => (c.team ? teamPill(c.team) : `<span class="pill">${c.members_only ? '協會會員' : '全協會'}</span>`);
const isWitness = (c) => c.kind === 'weight' && c.opts?.verify === 'witness';
const joinedOf = (m) => (m && m.status !== 'left' ? m : null);
// 我的參加狀態
const STATE = { joined: ['', '已參加'], met: ['wait', '待確認'], achieved: ['solid', '已達成'], not_met: ['', '沒有達成'], rejected: ['', '沒有通過確認'], revoked: ['', '達成已撤銷'] };
const statePill = (m) => (STATE[m.status] ? `<span class="pill ${STATE[m.status][0]}">${STATE[m.status][1]}</span>` : '');
// 團服名額的排序規則（挑戰頁固定寫出來，名額依這個順序分配）
const RANK_RULE = { pb: '名額依比賽日期先後；同一天依登錄先後', time: '名額依比賽日期先後；同一天依登錄先後', pace: '名額依比賽日期先後；同一天依登錄先後',
  km: '名額依累積到目標的日期先後', attend: '名額依達到目標次數那場團練的日期先後', weight: '名額依結束量測見證的時間先後' };

// LINE 分享：只分享自己的成就；網址加 openExternalBrowser=1（LINE 內建瀏覽器不能用 Google 登入）
const lineHref = (text) => `https://line.me/R/share?text=${encodeURIComponent(text)}`;
const forLine = (u) => `${u}${u.includes('?') ? '&' : '?'}openExternalBrowser=1`;
// 分享的句子：整句一個字典鍵（英文介面分享英文），{…} 換成內容
const SHARE = { pbBreak: '我在{race}跑出{dist}新 PB：{time}', pbFirst: '我完成了{race}{dist}：{time}', club: '和{org}一起練跑', ach: '我完成了{org}的「{title}」挑戰' };
const fill = (tpl, v) => I18N.t(tpl).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const clubName = () => org().short || '耕跑團';
const appUrl = () => forLine(`${location.origin}/`);
function pbShareText(p) {
  const v = { race: p.race_name, dist: I18N.t(distLabel(p.dist_key, p.km)), time: fmtTime(p.seconds), org: clubName() };
  return `${fill(p.pb_kind === 'break' ? SHARE.pbBreak : SHARE.pbFirst, v)}\n${fill(SHARE.club, v)}\n${appUrl()}`;
}
const achShareText = (title) => `${fill(SHARE.ach, { org: clubName(), title })}\n${appUrl()}`;
// 分享面板（照「分享耕跑團 App」）：LINE、其他 App（手機的分享選單）、複製文字；不產生公開頁、不帶別人的資料
export function shareSheet(text, opener = document.activeElement) {
  const s = openSheet('分享', `<div class="row spread"><h3 id="achShareT">分享</h3><button type="button" class="btn ghost sm" data-close>完成</button></div>
    <p class="ach-sharetext" translate="no">${esc(text)}</p>
    <div class="${navigator.share ? 'grid2' : 'grid1'}"><a class="btn iconbtn" id="achLine" href="${esc(lineHref(text))}" target="_blank" rel="noopener">LINE</a>
      ${navigator.share ? '<button type="button" class="btn ghost iconbtn" id="achNative">其他 App</button>' : ''}</div>
    <button type="button" class="btn ghost block" id="achCopy">複製文字</button>`, opener, 'achShareT');
  s.host.querySelector('#achNative')?.addEventListener('click', async () => { try { await navigator.share({ text }); } catch {} });
  s.host.querySelector('#achCopy').onclick = () => copy(text);
  return s;
}

// 成績截圖：手機上用 canvas 重新編碼（去掉 EXIF 與定位），長邊縮到 1280px（不放大），WebP，不支援就用 JPEG；
//   太大再降畫質、再縮到 1080px，還是太大就請使用者裁切
export async function proofImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('截圖格式不對或太大'); }
  const enc = (edge, q) => {
    const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const u = c.toDataURL('image/webp', q);
    return u.startsWith('data:image/webp') ? u : c.toDataURL('image/jpeg', q > 0.6 ? 0.8 : q);
  };
  try {
    for (const [edge, q] of [[1280, 0.72], [1280, 0.55], [1080, 0.55]]) { const u = enc(edge, q); if (u.length <= LIMITS.proofChars) return u; }
  } finally { bmp.close?.(); }
  throw new Error('截圖太大，請裁切後再試');
}
// 截圖只給本人與審核者看（private, no-store）：fetch 成 blob 再顯示，關掉時釋放
async function proofUrl(id) {
  const res = await fetch(`/api/pb/${encodeURIComponent(id)}/proof`, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? '截圖已刪除' : '截圖載入失敗');
  return URL.createObjectURL(await res.blob());
}
function viewProof(id, opener) {
  const s = openSheet('成績截圖', `<div class="row spread"><h3 id="pbProofT">成績截圖</h3><button type="button" class="btn ghost sm" data-close>關閉</button></div>
    <div class="pb-proofbig" aria-live="polite"><span class="tiny">載入中…</span></div>`, opener, 'pbProofT', { onClose: () => { if (url) URL.revokeObjectURL(url); } });
  let url = null;
  proofUrl(id).then((u) => {
    url = u; const box = s.host.querySelector('.pb-proofbig'); if (!box) { URL.revokeObjectURL(u); return; }
    box.innerHTML = `<img src="${u}" alt="成績截圖">`;
  }).catch((e) => { const box = s.host.querySelector('.pb-proofbig'); if (box) box.innerHTML = `<span class="tiny">${esc(e.message)}</span>`; });
}

// ---------- #/pb 我的成績 ----------
const PB_GROUPS = [['pending', '審核中'], ['approved', '已通過'], ['rejected', '沒有通過'], ['revoked', '已撤銷']];
const PB_PILL = { pending: '<span class="pill wait">審核中</span>', approved: '<span class="pill solid">已通過</span>', rejected: '<span class="pill">沒有通過</span>', revoked: '<span class="pill">已撤銷</span>' };
const kindPill = (p) => (p.status !== 'approved' ? '' : p.pb_kind === 'break' ? '<span class="pill solid">刷新 PB</span>' : p.pb_kind === 'first' ? '<span class="pill">第一筆</span>' : '');
let pbOnly = '';   // 點 PB 卡片＝清單只看這個距離（再點一次取消）
export async function pbView() {
  const on = achOn();
  const [d, races] = await Promise.all([api('/pb'), on ? api('/races').then((r) => r.races || []).catch(() => []) : []]);
  if (!onPage('#/pb')) return;
  const t = today(), past = races.filter((r) => r.date && r.date <= t);
  const items = d.items || [], best = d.best || {};
  if (!d.on && !items.length && !d.badges?.length) {
    view.innerHTML = `${largeTitle('我的成績')}<div class="card">${emptyState(ic(ACH_ICONS.trophy), '這個功能目前沒有開放')}</div>`;
    return;
  }
  // 新 PB：剛通過審核、第一次打開這一頁才有光帶（第一次來這一頁時把已通過的都當成看過）
  const store = local.get(), approved = items.filter((p) => p.status === 'approved').map((p) => p.id);
  const seen = new Set(Array.isArray(store.seen) ? store.seen : approved);
  const fresh = new Set(STD.filter((k) => best[k] && !seen.has(best[k].id) && ['break', 'first'].includes(best[k].pb_kind)));
  local.set({ seen: [...new Set([...seen, ...approved])].slice(-300) });
  if (pbOnly && !items.some((p) => p.dist_key === pbOnly)) pbOnly = '';
  const cell = (k) => {
    const p = best[k], name = DISTS[k].zh;
    if (!p) {
      const inner = `<span class="pb-d">${name}</span><span class="pb-t pb-none">還沒有</span>${on ? '<span class="tiny pb-go">登錄 ›</span>' : ''}`;
      return on ? `<a class="card pb-cell" href="#/pb/new?dist=${k}">${inner}</a>` : `<div class="card pb-cell">${inner}</div>`;
    }
    return `<button type="button" class="card pb-cell${fresh.has(k) ? ' pb-new' : ''}" data-dist="${k}" aria-pressed="${pbOnly === k}">
      <span class="pb-d">${name}${fresh.has(k) ? '<span class="pill solid">新 PB</span>' : ''}</span>
      <b class="pb-t num">${fmtTime(p.seconds)}</b><span class="tiny">配速 ${fmtPace(p.seconds, p.km)}</span>
      <span class="tiny pb-race"><span translate="no">${esc(p.race_name)}</span>・${slash(p.race_date)}</span></button>`;
  };
  const others = (best.other || []).map((p) => `<span class="chip pb-ochip"><span>${esc(dname(p))}</span> <b class="num">${fmtTime(p.seconds)}</b></span>`).join('');
  view.innerHTML = `${largeTitle('我的成績', '通過審核的最佳成績')}
    ${me.ach?.needSize > 0 ? `<a class="notice ach-note" href="#/ach">${ic(ACH_ICONS.shirt)}<span>你有團服名額，記得選尺寸 ›</span></a>` : ''}
    <div class="pb-grid">${STD.map(cell).join('')}</div>
    ${others ? `<div class="chips pb-others" aria-label="其他距離">${others}</div>` : ''}
    ${on ? `<div class="pb-acts"><a class="btn block iconbtn" href="#/pb/new">${ic('<path d="M12 6.5v11M6.5 12h11"/>')}登錄比賽成績</a>
      ${past.length ? '<button type="button" class="btn ghost block" id="pbFromRace">從我的賽事帶入</button>' : ''}</div>` : ''}
    ${d.pending >= (d.maxPending || LIMITS.pending) ? '<p class="tiny center">審核中的成績已經有 5 筆，等審核完再登錄新的</p>' : ''}
    <div id="pbList"></div>
    ${d.badges?.length ? `<section class="setgroup"><h2 class="sgt">我的徽章</h2><div class="card"><div class="badges">${d.badges.map((b) => `<a class="badge got" href="#/ach/c/${esc(b.cid)}">
      <span class="bi">${ic(ACH_ICONS[b.badge] || ACH_ICONS.trophy)}</span><b translate="no">${esc(b.title)}</b><span class="tiny num">${slash(tpDay(b.achieved_at))}</span></a>`).join('')}</div></div></section>` : ''}
    <p class="tiny center pb-foot">成績只有你和審核的幹部看得到；打開「恭喜榜」後，登入的跑友才看得到你的 PB。<a href="#/me/privacy">隱私設定 ›</a></p>`;
  const paintList = () => {
    const list = pbOnly ? items.filter((p) => p.dist_key === pbOnly) : items;
    $id('pbList').innerHTML = PB_GROUPS.map(([st, label]) => {
      const rows = list.filter((p) => p.status === st);
      return rows.length ? `<section class="setgroup"><h2 class="sgt">${label}</h2><ul class="card setcard pb-list" role="list">${rows.map(pbRow).join('')}</ul></section>` : '';
    }).join('') || (items.length ? '' : `<div class="card">${emptyState(ic(ACH_ICONS.medal), on ? '還沒有登錄過成績' : '沒有成績紀錄')}</div>`);
  };
  paintList();
  for (const b of view.querySelectorAll('.pb-cell[data-dist]')) b.onclick = () => {
    pbOnly = pbOnly === b.dataset.dist ? '' : b.dataset.dist;
    for (const x of view.querySelectorAll('.pb-cell[data-dist]')) x.setAttribute('aria-pressed', String(x.dataset.dist === pbOnly));
    paintList();
  };
  $id('pbFromRace')?.addEventListener('click', (e) => {
    openSheet('從我的賽事帶入', `<div class="row spread"><h3 id="pbRaceT">從我的賽事帶入</h3><button type="button" class="btn ghost sm" data-close>關閉</button></div>
      <div class="card setcard">${past.slice().reverse().map((r) => `<a class="setrow" href="#/pb/new?race=${esc(r.id)}" data-close><span class="sic" style="--sc:var(--tile-red)">${ic(ACH_ICONS.medal)}</span>
        <span class="st"><b translate="no">${esc(r.name)}</b><span class="sr">，</span><span class="tiny">${slash(r.date)}${r.dist ? `・<span translate="no">${esc(r.dist)}</span>` : ''}</span></span><span class="chev" aria-hidden="true"></span></a>`).join('')}</div>`, e.currentTarget, 'pbRaceT');
  });
  $id('pbList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pb]'); if (!b) return;
    const p = items.find((x) => x.id === b.dataset.pb); if (!p) return;
    const opts = {
      pending: [{ value: 'edit', label: '修改', primary: true }, ...(p.proof ? [{ value: 'proof', label: '看截圖' }] : []), { value: 'del', label: '撤回', danger: true }],
      approved: [{ value: 'share', label: '分享到 LINE', primary: true }, { value: 'del', label: '刪除', danger: true }],
      rejected: [{ value: 'edit', label: '修改後重送', primary: true }, { value: 'del', label: '刪除', danger: true }],
      revoked: [{ value: 'del', label: '刪除', danger: true }],
    }[p.status] || [];
    const v = await choose(`${dname(p)} ${fmtTime(p.seconds)}`, `<span translate="no">${esc(p.race_name)}</span>・${slash(p.race_date)}`, opts);
    if (v === 'edit') { location.hash = `#/pb/${p.id}/edit`; return; }
    if (v === 'proof') { viewProof(p.id, b); return; }
    if (v === 'share') { shareSheet(pbShareText(p), b); return; }
    if (v !== 'del') return;
    const pend = p.status === 'pending';
    const ok = await choose(pend ? '撤回這筆成績？' : '刪除這筆成績？', pend ? '撤回後幹部就不會審核；之後可以重新登錄。' : '刪除後恭喜榜上的這一則也會消失；已經完成的挑戰不受影響。',
      [{ value: 'y', label: pend ? '撤回' : '刪除', danger: true }], { cancel: '保留' });
    if (ok !== 'y') return;
    try { await api(`/pb/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); toast(pend ? '已撤回' : '已刪除'); await pbView(); focusEl(view.querySelector('h1')); } catch (err) { toast(err.message); }
  });
}
function pbRow(p) {
  return `<li><button type="button" class="pb-row" data-pb="${esc(p.id)}">
    <span class="pill pb-dist">${esc(dname(p))}</span>
    <span class="pb-main"><b class="num pb-rt">${fmtTime(p.seconds)}</b><span class="tiny"><span translate="no">${esc(p.race_name)}</span>・${slash(p.race_date)}</span>
      ${p.status === 'rejected' && p.review_note ? `<span class="tiny pb-why"><span>原因：</span><span translate="no">${esc(p.review_note)}</span></span>` : ''}
      ${p.status === 'approved' && p.cheers > 0 && me.cheer_board ? `<span class="tiny">${p.cheers} 位跑友恭喜你</span>` : ''}</span>
    <span class="pb-pills">${PB_PILL[p.status] || ''}${kindPill(p)}</span><span class="chev" aria-hidden="true"></span></button></li>`;
}

// ---------- #/pb/new、#/pb/<id>/edit 登錄成績 ----------
const COACH_DIST = { 5: '5k', 10: '10k', 21.0975: 'hm', 42.195: 'fm' };
export async function pbFormView(id) {
  const q = hashQ();
  const [d, races] = await Promise.all([api('/pb'), api('/races').then((r) => r.races || []).catch(() => [])]);
  const here = location.hash.split('?')[0];
  if (here !== (id ? `#/pb/${id}/edit` : '#/pb/new')) return;
  const p = id ? (d.items || []).find((x) => x.id === id) : null;
  const title = id ? '修改成績' : '登錄比賽成績';
  if (!achOn() || (id && (!p || !['pending', 'rejected'].includes(p.status)))) {
    view.innerHTML = `${largeTitle(title)}<div class="card">${emptyState(ic(ACH_ICONS.medal), !achOn() ? '這個功能目前沒有開放' : !p ? '這筆成績已經不在了' : '通過審核的成績不能修改，可以刪除後重新登錄')}<a class="btn block" href="#/pb">回到我的成績</a></div>`;
    return;
  }
  const t = today(), race = q.get('race') ? races.find((r) => r.id === q.get('race')) : null;
  let dist = p?.dist_key || (race ? distFromRace(race.dist) : '') || (STD.includes(q.get('dist')) ? q.get('dist') : '');
  let proof;   // undefined＝不動、字串＝換新的、null＝移除
  const raceId = p ? p.race_id : race?.id || null;
  const sec = p?.seconds || 0, hh = sec >= 3600 ? Math.floor(sec / 3600) : '', mm = sec ? Math.floor((sec % 3600) / 60) : '', ss = sec ? sec % 60 : '';
  const two = (v) => (v === '' ? '' : String(v).padStart(2, '0'));
  // 課表設定填過的成績（只存在這台裝置）：這個距離還沒有通過審核的成績時提示帶入（只帶時間與距離，不當基準）
  const cp = coachPrefs().pb || {}, cd = COACH_DIST[Number(cp.dist)], cs = parseTime(cp.time);
  const coachHint = !id && cd && cs && !d.best?.[cd] ? `<section class="card tight pb-coach"><p style="margin:0"><span>你在課表設定填過</span> <b><span>${DISTS[cd].zh}</span> <span class="num">${fmtTime(cs)}</span></b><span>（只存在這台裝置）。要登錄成正式成績嗎？</span></p>
    <button type="button" class="btn ghost sm" id="pbCoach">帶入</button></section>` : '';
  const names = [...new Set(races.map((r) => r.name).filter(Boolean))];
  view.innerHTML = `${largeTitle(title)}
    ${p?.status === 'rejected' ? `<div class="notice"><b>沒有通過審核</b>${p.review_note ? ` <span translate="no">${esc(p.review_note)}</span>` : ''}<br><span>修改後按「重新送出審核」</span></div>` : ''}
    ${coachHint}
    <form class="card pb-form" id="pbForm" novalidate>
      <fieldset class="pb-fs" id="pbDistFs"><legend>距離</legend>
        <div class="seg pb-seg" role="group" aria-label="距離">${[...STD, 'other'].map((k) => `<button type="button" data-d="${k}" aria-pressed="${dist === k}">${k === 'other' ? '其他' : DISTS[k].zh}</button>`).join('')}</div>
        <div class="pb-km" ${dist === 'other' ? '' : 'hidden'}><label>距離（公里）<input name="km" inputmode="decimal" autocomplete="off" value="${p?.dist_key === 'other' ? esc(p.km) : ''}" aria-describedby="pbKmHint"></label>
          <p class="tiny" id="pbKmHint" style="margin:0">越野賽與非標準距離請選「其他」，不列入 PB 排行與挑戰</p></div>
      </fieldset>
      <fieldset class="pb-fs" id="pbTimeFs"><legend>完賽時間（晶片時間）</legend>
        <div class="pb-hms">
          <label><input name="h" inputmode="numeric" maxlength="2" autocomplete="off" value="${hh === '' ? '' : hh}" aria-describedby="pbTimeHint"><span>小時</span></label><span class="pb-colon" aria-hidden="true">:</span>
          <label><input name="m" inputmode="numeric" maxlength="2" autocomplete="off" value="${two(mm)}" aria-describedby="pbTimeHint"><span>分鐘</span></label><span class="pb-colon" aria-hidden="true">:</span>
          <label><input name="s" inputmode="numeric" maxlength="2" autocomplete="off" value="${two(ss)}" aria-describedby="pbTimeHint"><span>秒</span></label></div>
        <p class="tiny" id="pbTimeHint" style="margin:0">請填晶片時間（淨時間）；沒有晶片時間就填大會時間</p>
        <p class="pb-pace num" id="pbPace" aria-live="polite"></p>
      </fieldset>
      <label>賽事名稱<input name="race_name" maxlength="${LIMITS.raceName}" list="pbRaceNames" autocomplete="off" value="${esc(p?.race_name || race?.name || '')}"></label>
      <datalist id="pbRaceNames">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label>比賽日期<input name="race_date" type="date" max="${t}" value="${esc(p?.race_date || (race && race.date <= t ? race.date : ''))}"></label>
      <label>號碼布（選填）<input name="bib" maxlength="${LIMITS.bib}" autocomplete="off" value="${esc(p?.bib || '')}" aria-describedby="pbBibHint"></label>
      <p class="tiny pb-hint" id="pbBibHint">方便幹部在成績網站找到你</p>
      <label>官方成績連結<input name="result_url" type="url" inputmode="url" placeholder="https://" autocomplete="off" value="${esc(p?.result_url || '')}" aria-describedby="pbUrlHint"></label>
      <p class="tiny pb-hint" id="pbUrlHint">賽事官網或計時公司的個人成績頁</p>
      <div class="pb-proof" id="pbProofBox"><span class="pb-flabel" id="pbProofL">成績截圖</span>
        <div class="pb-proofrow" id="pbProofPrev"></div>
        <label class="btn ghost sm pb-filebtn">${ic(ACH_ICONS.image)}<span id="pbFileLabel">選擇截圖</span><input type="file" id="pbFile" class="sr" accept="image/*" aria-describedby="pbProofHint"></label>
        <p class="tiny" id="pbProofHint" style="margin:0">截圖會在審核完成 7 天後自動刪除；記得不要拍到別人的資料</p></div>
      <label>給審核的說明（選填）<textarea name="note" maxlength="${LIMITS.note}" rows="2">${esc(p?.note || '')}</textarea></label>
      <button class="btn block" id="pbSubmit">${!id ? '送出審核' : p.status === 'rejected' ? '重新送出審核' : '儲存'}</button>
    </form>`;
  const f = $id('pbForm'), seg = f.querySelector('.pb-seg');
  const kmNow = () => (dist === 'other' ? kmOf('other', Number(String(f.km.value).replace(',', '.'))) : DISTS[dist]?.km || 0);
  const hms = () => {
    const [h, m, s] = ['h', 'm', 's'].map((k) => f[k].value.trim());
    if (![h, m, s].every((v) => v === '' || /^\d{1,2}$/.test(v)) || (m === '' && s === '')) return null;
    const H = Number(h || 0), M = Number(m || 0), S = Number(s || 0);
    return M > 59 || S > 59 ? null : H * 3600 + M * 60 + S || null;
  };
  const pace = () => {
    const s = hms(), km = kmNow();
    $id('pbPace').textContent = s && km > 0 && timeOk(s, km) ? `配速 ${fmtPace(s, km)}` : '';
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    dist = b.dataset.d;
    for (const x of seg.querySelectorAll('[data-d]')) x.setAttribute('aria-pressed', String(x === b));
    f.querySelector('.pb-km').hidden = dist !== 'other';
    if (dist === 'other') f.km.focus();
    pace();
  });
  // 時、分、秒：只收數字，打滿兩位跳下一格
  const boxes = ['h', 'm', 's'].map((k) => f[k]);
  boxes.forEach((el, i) => el.addEventListener('input', () => {
    const v = el.value.replace(/\D/g, '').slice(0, 2); if (v !== el.value) el.value = v;
    if (v.length === 2 && boxes[i + 1]) boxes[i + 1].focus();
    pace();
  }));
  f.km.addEventListener('input', pace);
  pace();
  // 截圖預覽：新選的用本機的 data URI；修改時原本的截圖從伺服器讀（只有本人與審核者）
  let prevUrl = null;
  const paintProof = () => {
    const box = $id('pbProofPrev');
    if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = null; }
    const has = typeof proof === 'string' || (proof === undefined && p?.proof);
    $id('pbFileLabel').textContent = has ? '換一張截圖' : '選擇截圖';
    if (!has) { box.innerHTML = ''; return; }
    box.innerHTML = `<img class="pb-thumb" alt="成績截圖預覽"${typeof proof === 'string' ? ` src="${proof}"` : ''}><button type="button" class="btn ghost sm" id="pbProofRm">移除</button>`;
    if (proof === undefined) proofUrl(p.id).then((u) => { const img = box.querySelector('img'); if (img) { prevUrl = u; img.src = u; } else URL.revokeObjectURL(u); }).catch(() => { box.querySelector('img')?.remove(); });
    $id('pbProofRm').onclick = () => { proof = null; paintProof(); $id('pbFile').focus(); };
  };
  paintProof();
  $id('pbFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    try { proof = await proofImage(file); paintProof(); announce('已加上截圖'); } catch (err) { fieldError($id('pbFile'), err.message, { anchor: $id('pbProofHint') }); }
  });
  $id('pbCoach')?.addEventListener('click', () => {
    dist = cd;
    for (const x of seg.querySelectorAll('[data-d]')) x.setAttribute('aria-pressed', String(x.dataset.d === dist));
    f.querySelector('.pb-km').hidden = true;
    f.h.value = cs >= 3600 ? Math.floor(cs / 3600) : ''; f.m.value = two(Math.floor((cs % 3600) / 60)); f.s.value = two(cs % 60);
    pace(); f.race_name.focus();
  });
  const btn = $id('pbSubmit');
  f.onsubmit = (e) => { e.preventDefault(); go(); };
  const go = once(btn, async () => {
    if (!dist) return fieldError(seg.querySelector('button'), '請選距離', { anchor: seg });
    const km = kmNow();
    if (dist === 'other' && !kmOk('other', km)) return fieldError(f.km, '其他距離請填 1–250 公里');
    const s = hms();
    if (!s || !timeOk(s, km)) return fieldError(f.h, '時間看起來不對，請用 時:分:秒（例如 3:28:41）', { also: [f.m, f.s], anchor: $id('pbTimeHint') });
    const name = f.race_name.value.trim(), date = f.race_date.value, url = f.result_url.value.trim();
    if (!name) return fieldError(f.race_name, '請填賽事名稱');
    if (!date) return fieldError(f.race_date, '請選比賽日期');
    if (date > t) return fieldError(f.race_date, '比賽日期不能晚於今天');
    if (url && !/^https:\/\/\S+$/i.test(url)) return fieldError(f.result_url, '成績連結要是 https:// 開頭的網址');
    const hasProof = typeof proof === 'string' || (proof === undefined && !!p?.proof);
    if (!url && !hasProof) return fieldError(f.result_url, '請附上官方成績連結或截圖');
    const body = { dist_key: dist, seconds: s, race_name: name, race_date: date, bib: f.bib.value.trim() || null, result_url: url || null, note: f.note.value.trim() || null, race_id: raceId };
    if (dist === 'other') body.km = km;
    if (!id) { if (typeof proof === 'string') body.proof = proof; } else if (proof !== undefined) body.proof = proof;
    try {
      await api(id ? `/pb/${encodeURIComponent(id)}` : '/pb', { method: id ? 'PUT' : 'POST', body });
      toast(!id ? '已送出，審核通過後會通知你' : p.status === 'rejected' ? '已重新送出審核' : '已更新');
      location.hash = '#/pb';
    } catch (err) { toast(err.message); }
  });
}

// ---------- #/ach 目標挑戰 ----------
const phaseOf = (c, t) => (c.status === 'settled' ? 'settled' : c.status === 'cancelled' ? 'cancelled' : t < c.start_date ? 'soon' : t > c.end_date ? 'ending' : 'live');
function whenText(c, t) {
  const ph = phaseOf(c, t);
  if (ph === 'live') { const n = daysBetween(t, c.end_date); return n > 0 ? `還有 ${n} 天` : '今天是最後一天'; }
  if (ph === 'soon') return `${md(c.start_date)} 開始`;
  return { ending: '已結束・結算中', settled: '已結算', cancelled: '已取消' }[ph];
}
// 獎勵的小圖示列：徽章、團服（限量或不限量）、恭喜榜
function rewardIcons(c) {
  const rw = c.rewards || {}, sh = rw.shirt;
  return [rw.badge ? `<span class="ach-rw">${ic(ACH_ICONS[rw.badge] || ACH_ICONS.trophy)}<span class="sr">完成徽章</span></span>` : '',
    sh ? `<span class="ach-rw">${ic(ACH_ICONS.shirt)}<span>${sh.quota ? `限量 ${sh.quota} 件` : '團服不限量'}</span></span>` : '',
    rw.board ? `<span class="ach-rw">${ic(ACH_ICONS.sparkle)}<span class="sr">上恭喜榜</span></span>` : ''].join('');
}
// 小進度環（km、attend）：role=img＋說明
const ring = (p, label, inner = '', cls = '') => `<span class="ach-ring ${cls}" style="--p:${Math.max(0, Math.min(100, Math.round(p)))}" role="img" aria-label="${esc(label)}">${inner}</span>`;
function miniProgress(c, pr) {
  if (!pr) return '';
  if (c.kind === 'km') return `<span class="ach-mini">${ring(((pr.km || 0) / c.target) * 100, `已跑 ${pr.km || 0} 公里，目標 ${c.target} 公里`, '', 'sm')}<span class="tiny num">${pr.km || 0} / ${c.target} km</span></span>`;
  if (c.kind === 'attend') return `<span class="ach-mini">${ring(((pr.att || 0) / c.target) * 100, `已出席 ${pr.att || 0} 次，目標 ${c.target} 次`, '', 'sm')}<span class="tiny"><span class="num">${pr.att || 0} / ${c.target}</span> <span>次</span></span></span>`;
  if (['pb', 'time', 'pace'].includes(c.kind)) return pr.best ? `<span class="ach-mini tiny"><span>期間內最佳</span> <b class="num">${fmtTime(pr.best)}</b></span>` : `<span class="ach-mini tiny">${pr.pending_pb ? '成績審核中' : '等你的成績'}</span>`;
  return '';
}
function achCard(c, t) {
  const m = joinedOf(c.me);
  return `<a class="card ach-card" href="#/ach/c/${esc(c.id)}">
    ${kindTile(c.kind, 'ach-tile')}
    <span class="ach-cbody">
      <span class="ach-ctop"><b translate="no">${esc(c.title)}</b>${scopePill(c)}</span>
      <span class="ach-rule">${esc(ruleLines(c)[0] || '')}</span>
      <span class="tiny"><span class="num">${md(c.start_date)}–${md(c.end_date)}</span>・<span>${whenText(c, t)}</span></span>
      <span class="ach-meta">${rewardIcons(c)}${m ? statePill(m) : ''}${m?.reward_state === 'granted' && !m.shirt_size ? '<span class="pill wait">選團服尺寸</span>' : ''}</span>
      ${m ? miniProgress(c, c.progress) : ''}
    </span><span class="chev" aria-hidden="true"></span></a>`;
}
export async function achView() {
  const [d, pb] = await Promise.all([api('/ach'), api('/pb').catch(() => null)]);
  if (!onPage('#/ach')) return;
  const t = today(), list = d.campaigns || [];
  const cheersBtn = achOn() ? `<a class="ach-roundbtn" href="#/cheers" aria-label="恭喜榜">${ic(ACH_ICONS.sparkle)}</a>` : '';
  if (!d.on && !list.length) {
    view.innerHTML = `${largeTitle('目標挑戰')}<div class="card">${emptyState(ic(ACH_ICONS.medal), '這個功能目前沒有開放')}</div>`;
    return;
  }
  const best = pb?.best || {};
  const chips = `<a class="card tight ach-pbs" href="#/pb"><span class="tiny">我的 PB</span><span class="ach-pbchips">${STD.map((k) => `<span class="chip"><span>${DISTS[k].zh}</span> <b class="num">${best[k] ? fmtTime(best[k].seconds) : '—'}</b></span>`).join('')}</span><span class="chev" aria-hidden="true"></span></a>`;
  // 有團服名額還沒選尺寸的排最上面（首頁的提醒卡連到這裡）
  const needSize = (c) => { const m = joinedOf(c.me); return m?.reward_state === 'granted' && !m.shirt_size; };
  const top = list.filter(needSize), rest = list.filter((c) => !needSize(c));
  const live = rest.filter((c) => phaseOf(c, t) === 'live'), soon = rest.filter((c) => phaseOf(c, t) === 'soon'), done = rest.filter((c) => ['ending', 'settled', 'cancelled'].includes(phaseOf(c, t)));
  const sec = (title, cs) => (cs.length ? `<section class="setgroup"><h2 class="sgt">${title}</h2><div class="ach-cards">${cs.map((c) => achCard(c, t)).join('')}</div></section>` : '');
  view.innerHTML = `${largeTitle('目標挑戰', '完成目標拿徽章、團服', cheersBtn)}
    ${chips}
    ${sec('要選團服尺寸', top)}
    ${sec('進行中', live)}
    ${sec('即將開始', soon)}
    ${!top.length && !live.length && !soon.length ? `<div class="card"><div class="empty">${ic(ACH_ICONS.medal)}<b class="etitle">目前沒有進行中的挑戰</b><span>協會發布新的挑戰時會通知你</span></div></div>` : ''}
    ${done.length ? `<details class="ach-done"><summary class="sgt">已結束（${done.length}）</summary><div class="ach-cards">${done.map((c) => achCard(c, t)).join('')}</div></details>` : ''}`;
}

// ---------- #/ach/c/<id> 挑戰詳細 ----------
const CONSENT = [
  '這個挑戰要在團練現場量起始與結束體重：你先在自己手機輸入體重計上的數字，再請一位在場的幹部看體重計輸入，兩邊對得上才算。',
  '見證的幹部當下會看到體重計；系統把數字加密保存，只用來判定是否達成，其他幹部與跑友都查不到，幹部也不會知道你有沒有達成。',
  '挑戰結束 30 天後自動刪除；你隨時可以在挑戰頁刪除體重資料或退出，都會立即刪除。',
  '這個挑戰不會出現在恭喜榜。',
  '健康的減重大約每週不超過體重的 1%。身體不舒服請先停下來，必要時諮詢醫師。',
];
const HEALTH = '健康的減重大約每週不超過體重的 1%。身體不舒服請先停下來，必要時諮詢醫師。';
export async function achCampaignView(id, focusSel) {
  const d = await api(`/ach/${encodeURIComponent(id)}`);
  const c = d.campaign;
  const pbData = ['pb', 'pace'].includes(c.kind) ? await api('/pb').catch(() => null) : null;
  if (!onPage(`#/ach/c/${id}`)) return;
  const t = today(), m = joinedOf(d.me), pr = d.progress || {}, rw = c.rewards || {}, sh = rw.shirt, witness = isWitness(c);
  const again = (sel) => achCampaignView(id, sel);
  // 能不能參加（伺服器會再檢查一次）；不能時寫出原因
  const myTeam = !c.team_id || teams().some((x) => x.id === c.team_id && x.my_status === 'active');
  const why = m ? '' : !achOn() ? '協會目前沒有開放成績與挑戰' : c.status !== 'open' ? '' : t > c.join_by ? '這個挑戰已經截止報名'
    : !myTeam ? '這個挑戰只限分團團員' : c.members_only && me.membership !== 'active' ? '這個挑戰只限協會會員' : witness && d.raceKey === false ? '體重挑戰暫時無法使用' : '';
  const canJoin = !m && c.status === 'open' && !why;
  const lines = ruleLines(c);
  const full = sh?.quota && (d.stats?.done || 0) >= sh.quota;
  // 頁首：標題是協會幹部寫的內容（不翻譯），所以自己畫大標題
  const head = `<header class="lt ach-head">${kindTile(c.kind, 'ach-htile')}<div><h1 tabindex="-1"><span translate="no">${esc(c.title)}</span></h1>
    <p class="ach-hsub">${scopePill(c)}<span class="tiny"><span class="num">${md(c.start_date)}–${md(c.end_date)}</span>・<span>${whenText(c, t)}</span></span></p></div></header>`;
  const stats = d.stats ? `<div class="ach-stats" role="group" aria-label="參加人數"><span><b class="num">${d.stats.joined}</b><span>參加</span></span><span><b class="num">${d.stats.done}</b><span>達成</span></span>
    ${sh ? `<span><b class="num">${(d.stats.granted || 0) + (d.stats.issued || 0)}</b><span>團服名額已給</span></span>` : ''}</div>` : '';
  view.innerHTML = `${head}
    ${c.status === 'cancelled' ? `<div class="notice"><b>這個挑戰已經取消</b>${c.cancel_note ? ` <span translate="no">${esc(c.cancel_note)}</span>` : ''}</div>` : ''}
    <section class="card ach-sec">
      ${c.intro ? `<p class="ach-intro" translate="no">${esc(c.intro)}</p>` : ''}
      <h2 class="h3">達成條件</h2>
      <ul class="ach-rules">${lines.map((x, i) => `<li>${i ? esc(x) : `<b>${esc(x)}</b>`}</li>`).join('')}</ul>
      ${c.kind === 'weight' ? `<p class="tiny ach-health">${HEALTH}</p>` : ''}
      ${stats}
    </section>
    <section class="card ach-sec"><h2 class="h3">獎勵</h2>
      <ul class="ach-rewards">
        ${rw.badge ? `<li><span class="ach-rwic">${ic(ACH_ICONS[rw.badge] || ACH_ICONS.trophy)}</span><span>完成徽章</span></li>` : ''}
        ${sh ? `<li><span class="ach-rwic">${ic(ACH_ICONS.shirt)}</span><span class="ach-rwbody"><span>${sh.quota ? `限量 ${sh.quota} 件，依達成先後` : '團服不限量'}</span>
          <span class="chips ach-sizechips" aria-label="尺寸">${sh.sizes.map((z) => `<span class="chip" translate="no">${esc(z)}</span>`).join('')}</span>
          ${sh.quota ? `<span class="tiny">${RANK_RULE[c.kind] || ''}</span>` : ''}
          ${sh.chart ? `<a class="tiny" href="${esc(sh.chart)}" target="_blank" rel="noopener">尺寸表 ›</a>` : ''}</span></li>` : ''}
        ${c.kind === 'weight' ? '<li><span class="ach-rwic">' + ic(ACH_ICONS.sparkle) + '</span><span>這個挑戰不上恭喜榜</span></li>'
    : rw.board ? `<li><span class="ach-rwic">${ic(ACH_ICONS.sparkle)}</span><span>完成後出現在恭喜榜（要先在隱私打開）</span></li>` : ''}
      </ul>
    </section>
    ${m ? myProgress(c, m, pr, d, pbData, t) : ''}
    ${m && sh ? shirtCard(c, m, t) : ''}
    ${m || canJoin || why ? `<section class="card ach-sec ach-joinbox" id="achJoinBox">
      ${m ? `<div class="row spread"><span class="ach-mystate">${statePill(m)}${m.status === 'met' ? '<span class="tiny">達成了，等幹部確認</span>' : ''}</span>
          ${['joined', 'met'].includes(m.status) ? '<button type="button" class="btn ghost sm" id="achLeave">退出挑戰</button>' : ''}</div>
          ${m.status === 'achieved' ? '<button type="button" class="btn block iconbtn" id="achShare">分享到 LINE</button>' : ''}
          ${m.status === 'not_met' ? '<p class="tiny" style="margin:0">這次沒有達成，謝謝你一起努力</p>' : ''}`
    : canJoin ? `${full ? `<p class="tiny" style="margin:0">已經有 ${d.stats.done} 位達成，現在參加會排在候補</p>` : ''}<button type="button" class="btn block" id="achJoin">參加挑戰</button>`
      : `<p class="muted" style="margin:0">${why}</p>`}
    </section>` : ''}
    ${d.canWitness || d.canIssue ? `<section class="setgroup"><h2 class="sgt">幹部工具</h2><div class="card setcard">
      ${d.canWitness ? btnRow('achWit', ic(ACH_ICONS.qr), '見證體重量測', '掃跑友手機上的見證碼') : ''}
      ${d.canIssue ? row(`#/admin/ach/c/${esc(c.id)}`, ic(ACH_ICONS.shirt), '團服發放', '名單、已發放、通知領取') : ''}</div></section>` : ''}`;
  const h1 = view.querySelector('h1');
  if (focusSel) focusEl(view.querySelector(focusSel) || h1);
  // 參加：見證制先開同意書；有團服可以先選尺寸（選填）
  $id('achJoin')?.addEventListener('click', (e) => joinSheet(c, e.currentTarget, again));
  $id('achLeave')?.addEventListener('click', async () => {
    const ok = await choose('退出這個挑戰？', witness ? '你的體重資料會立即刪除。' : '', [{ value: 'y', label: '退出', danger: true }], { cancel: '不退出' });
    if (ok !== 'y') return;
    try { await api(`/ach/${encodeURIComponent(c.id)}/leave`, { method: 'POST' }); toast('已退出挑戰'); await again('#achJoinBox .btn, h1'); } catch (err) { toast(err.message); }
  });
  $id('achShare')?.addEventListener('click', (e) => shareSheet(achShareText(c.title), e.currentTarget));
  $id('achWit')?.addEventListener('click', (e) => witnessScan(e.currentTarget));
  bindProgress(c, m, d, t, again);
  if (m && sh) bindShirt(c, m, t, again);
}
// 參加面板
function joinSheet(c, opener, again) {
  const witness = isWitness(c), sh = c.rewards?.shirt;
  const send = async (body) => {
    await api(`/ach/${encodeURIComponent(c.id)}/join`, { method: 'POST', body });
    toast('已參加');
    await again('.ach-mystate');
  };
  if (!witness && !sh) { once(opener, () => send({}).catch((err) => toast(err.message)))(); return; }
  let size = null;
  const s = openSheet(witness ? '參加前請確認' : '參加挑戰', `<h3 id="achJoinT">${witness ? '參加前請確認' : '參加挑戰'}</h3>
    ${witness ? `<ol class="steps ach-consent">${CONSENT.map((x) => `<li>${x}</li>`).join('')}</ol>
      <label class="inline ach-agree"><input type="checkbox" id="achAgree"><span>我同意協會為了這個挑戰加密保存我的體重</span></label>` : ''}
    ${sh ? `<fieldset class="group"><legend>團服尺寸（選填，之後也可以改）</legend><div class="chips ach-sizes">${sh.sizes.map((z) => `<button type="button" class="chip" data-size="${esc(z)}" aria-pressed="false" translate="no">${esc(z)}</button>`).join('')}</div>
      ${sh.chart ? `<a class="tiny" href="${esc(sh.chart)}" target="_blank" rel="noopener">尺寸表 ›</a>` : ''}</fieldset>` : ''}
    <div class="choices"><button type="button" class="btn block" id="achJoinGo"${witness ? ' disabled' : ''}>${witness ? '同意並參加' : '參加'}</button><button type="button" class="btn ghost block" data-close>取消</button></div>`, opener, 'achJoinT');
  const go = s.host.querySelector('#achJoinGo');
  s.host.querySelector('#achAgree')?.addEventListener('change', (e) => { go.disabled = !e.target.checked; });
  s.host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]'); if (!b) return;
    size = b.getAttribute('aria-pressed') === 'true' ? null : b.dataset.size;
    for (const x of s.host.querySelectorAll('[data-size]')) x.setAttribute('aria-pressed', String(x.dataset.size === size));
  });
  go.onclick = once(go, async () => {
    try { await send({ ...(witness ? { consent: true } : {}), ...(size ? { shirt_size: size } : {}) }); s.close(); } catch (err) { toast(err.message); }
  });
}
// 我的進度：依類型
function myProgress(c, m, pr, d, pbData, t) {
  let body = '';
  if (c.kind === 'km') {
    const km = pr.km || 0, left = Math.max(0, Math.round((c.target - km) * 10) / 10);
    body = `<div class="ach-big">${ring((km / c.target) * 100, `已跑 ${km} 公里，目標 ${c.target} 公里`, `<b class="num">${km}</b><small class="num">/ ${c.target} km</small>`, 'lg')}
      <div class="ach-bigtx">${left > 0 ? `<b>還差 ${left} 公里</b>` : '<b>已經達到目標</b>'}<span class="tiny">結束後 3 天內補記的也算</span></div></div>`;
  } else if (c.kind === 'attend') {
    const n = pr.att || 0, left = Math.max(0, c.target - n);
    body = `<div class="ach-big">${ring((n / c.target) * 100, `已出席 ${n} 次，目標 ${c.target} 次`, `<b class="num">${n}</b><small class="num">/ ${c.target}</small>`, 'lg')}
      <div class="ach-bigtx">${left > 0 ? `<b>還差 ${left} 次</b>` : '<b>已經達到目標</b>'}<span class="tiny">以現場報到為準</span></div></div>`;
  } else if (['pb', 'time', 'pace'].includes(c.kind)) {
    const kv = (k, v, sub = '') => `<div class="ach-kv"><span>${k}</span><span><b class="num">${v}</b>${sub}</span></div>`;
    const rows = [];
    if (c.kind !== 'time') {
      // 基準：比賽日在開始前、已通過的最佳成績（伺服器算好的秒數），從我的成績找出是哪一場
      const bp = pr.base ? (pbData?.items || []).find((p) => p.status === 'approved' && p.seconds === pr.base && p.race_date < c.start_date && (!c.dist_key || p.dist_key === c.dist_key)) : null;
      if (pr.base) rows.push(kv('基準', fmtTime(pr.base), bp ? `<span class="tiny"><span translate="no">${esc(bp.race_name)}</span>・${slash(bp.race_date)}</span>` : ''));
      else if (!(c.kind === 'pb' && c.opts?.first_ok)) {
        rows.push(`<p class="tiny ach-nobase">${pr.base_late ? '挑戰發布後才登錄的成績不能當基準' : '還沒有挑戰開始前的成績'}</p>`);
        if (!pr.base_late && achOn()) rows.push('<a class="btn ghost sm" href="#/pb/new">登錄之前的成績</a>');
      }
    }
    rows.push(kv('期間內最佳', pr.best ? fmtTime(pr.best) : '—'));
    if (c.kind === 'time') rows.push(kv('目標', fmtTime(c.target)));
    if (c.kind === 'pace' && pr.base && pr.best) rows.push(`<p class="ach-pct">進步 ${Math.max(0, pctDown(pr.base, pr.best))}%，目標 ${c.target}%</p>`);
    if (pr.pending_pb) rows.push('<p class="tiny">你有成績正在審核，通過後會自動算進來</p>');
    body = rows.join('');
  } else if (c.kind === 'weight') body = weightProgress(c, m, d, t);
  return `<section class="card ach-sec ach-prog" id="achProg"><h2 class="h3">我的進度</h2>${body}</section>`;
}
// 見證制體重：起始與結束兩張步驟卡；量測期間外不能量
const baseOpen = (c, t) => t >= addDays(c.start_date, -7) && t <= c.join_by;
const lastOpen = (c, m, t) => !!m.w_base_at && t >= addDays(c.end_date, -14) && t <= addDays(c.end_date, 3) && daysBetween(tpDay(m.w_base_at), t) >= 21;
function weightProgress(c, m, d, t) {
  if (c.opts?.verify !== 'witness') return honorProgress(c, m, t);
  const step = (which, label, rule) => {
    const at = which === 'base' ? m.w_base_at : m.w_last_at, pend = m.w_pending === which;
    const can = m.status === 'joined' && (which === 'base' ? baseOpen(c, t) : lastOpen(c, m, t));
    const state = at ? `<span class="ach-ok">${ic('<path d="M5 12.5l4.2 4.2L19 7"/>')}<span>已見證</span></span>・<span class="num">${md(tpDay(at))}</span>` : pend ? '<span>等幹部見證</span>' : '<span>還沒量</span>';
    return `<li class="ach-step${at ? ' ok' : ''}"><div class="ach-stephd"><b>${label}</b><span class="tiny">${state}</span></div>
      <span class="tiny">${rule}</span>
      ${can ? `<button type="button" class="btn sm" data-weigh="${which}">${pend ? '重新產生見證碼' : at ? '重新量' : '量體重'}</button>` : ''}</li>`;
  };
  const both = m.w_base_at && m.w_last_at && d.weight?.pct != null;
  const hasData = !!(d.weight || m.w_base_at || m.w_last_at || m.w_pending);
  return `<ol class="ach-steps">${step('base', '起始量測', '開始前 7 天到報名截止之間，在團練現場量')}${step('last', '結束量測', '結束前 14 天到結束後 3 天之間，距起始量測至少 21 天')}</ol>
    ${both ? `<p class="ach-pct">減少 ${d.weight.pct}%</p><p class="tiny" style="margin:0">只有你看得到這個數字</p>` : ''}
    ${hasData ? '<button type="button" class="linkbtn tiny ach-delw" id="achDelW">刪除我的體重資料</button>' : ''}`;
}
// 榮譽制體重：只存在這台裝置的紀錄；期間內可以送出達成聲明（不上傳數字）
const claimOpen = (c, t) => t >= addDays(c.end_date, -14) && t <= addDays(c.end_date, 3);
const honorLog = (cid) => { const h = local.get().honor; return Array.isArray(h?.[cid]) ? h[cid] : []; };
const setHonor = (cid, list) => { const h = { ...(local.get().honor || {}) }; if (list.length) h[cid] = list.slice(-60); else delete h[cid]; local.set({ honor: h }); };
function honorProgress(c, m, t) {
  const log = honorLog(c.id), pct = log.length >= 2 ? pctDown(log[0].kg10, log[log.length - 1].kg10) : null;
  return `<div class="ach-honor"><h3 class="ach-subh">只存在這台裝置的體重紀錄</h3>
    <p class="tiny" style="margin:0">不會上傳，換手機或登出就不見了</p>
    <form class="ach-hform" id="achHForm"><label>體重（公斤）<input name="kg" inputmode="decimal" autocomplete="off"></label><button class="btn ghost sm">記一筆</button></form>
    ${log.length ? `<ul class="ach-hlist" role="list">${log.map((x, i) => `<li><span class="num">${slash(x.d)}</span><b class="num">${(x.kg10 / 10).toFixed(1)}</b><span>公斤</span>
      <button type="button" class="iconx" data-hdel="${i}" aria-label="刪除這筆紀錄">${ic('<path d="M7 7l10 10M17 7 7 17"/>')}</button></li>`).join('')}</ul>` : ''}
    ${pct > 0 ? `<p class="ach-pct">比開始時減少 ${pct}%</p>` : ''}</div>
    ${m.status === 'joined' && claimOpen(c, t) ? '<button type="button" class="btn block" id="achClaim">送出達成聲明</button>' : ''}`;
}
function bindProgress(c, m, d, t, again) {
  if (!m || c.kind !== 'weight') return;
  if (c.opts?.verify === 'witness') {
    for (const b of view.querySelectorAll('[data-weigh]')) b.onclick = () => weighSheet(c, m, b.dataset.weigh, b, again);
    $id('achDelW')?.addEventListener('click', async () => {
      const ok = await choose('刪除我的體重資料？', m.status === 'achieved' ? '刪除後不影響已完成的挑戰。' : '刪除後要重新量起始體重；起始量測期間已經過了的話，這個挑戰就無法完成。',
        [{ value: 'y', label: '刪除', danger: true }], { cancel: '保留' });
      if (ok !== 'y') return;
      try { await api(`/ach/${encodeURIComponent(c.id)}/weight`, { method: 'DELETE' }); toast('體重資料已刪除'); await again('#achProg h2'); } catch (err) { toast(err.message); }
    });
    return;
  }
  $id('achHForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const kg = Number(String(e.target.kg.value).replace(',', '.'));
    if (!kgOk(kg)) { fieldError(e.target.kg, '體重請填 30–250 公斤'); return; }
    const log = [...honorLog(c.id).filter((x) => x.d !== t), { d: t, kg10: x10(kg) }].sort((a, b) => (a.d < b.d ? -1 : 1));
    setHonor(c.id, log); toast('已記在這台裝置'); again('#achHForm input');
  });
  for (const b of view.querySelectorAll('[data-hdel]')) b.onclick = () => { const log = honorLog(c.id); log.splice(Number(b.dataset.hdel), 1); setHonor(c.id, log); again('#achHForm input'); };
  $id('achClaim')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await choose('送出達成聲明', `我確認體重比挑戰開始時減少了 ${c.target}% 以上。這是榮譽制聲明，不會上傳數字。`, [{ value: 'y', label: '送出聲明', primary: true }]);
    if (ok !== 'y') return;
    await once(btn, async () => {
      try { await api(`/ach/${encodeURIComponent(c.id)}/claim`, { method: 'POST', body: {} }); toast('恭喜完成挑戰'); await again('.ach-mystate'); } catch (err) { toast(err.message); }
    })();
  });
}
// 量體重：先在自己手機輸入體重計上的數字 → 伺服器暫存（加密）、回傳一次性見證碼 → QR 面板
function weighSheet(c, m, which, opener, again) {
  const label = which === 'base' ? '起始量測' : '結束量測';
  const s = openSheet(label, `<h3 id="achWeighT">${label}</h3>
    <form id="achWeighF" class="ach-wform" novalidate><label>體重（公斤）<input name="kg" inputmode="decimal" autocomplete="off" aria-describedby="achWeighHint"></label>
      <p class="tiny" id="achWeighHint" style="margin:0">請在團練現場、幹部在旁邊時再量</p>
      <div class="choices"><button class="btn block">請幹部見證</button><button type="button" class="btn ghost block" data-close>取消</button></div></form>`, opener, 'achWeighT');
  const f = s.host.querySelector('form'), btn = f.querySelector('.btn.block');
  f.onsubmit = (e) => { e.preventDefault(); go(); };
  const go = once(btn, async () => {
    const kg = Math.round(Number(String(f.kg.value).replace(',', '.')) * 10) / 10;
    if (!kgOk(kg)) { fieldError(f.kg, '體重請填 30–250 公斤'); return; }
    try {
      const r = await api(`/ach/${encodeURIComponent(c.id)}/weigh`, { method: 'POST', body: { which, kg } });
      s.close(); qrPanel(c, m, which, r, kg, opener, again);
    } catch (err) { fieldError(f.kg, err.message); }
  });
}
// 見證碼面板：QR＋分成 4 組的代碼（data-code 放完整代碼）、倒數；體重數字預設遮住（旁邊的人看不到），按「顯示數字」才出現
//   輪詢 M17（只讀一列、不解密）：前 2 分鐘每 4 秒、之後每 10 秒；見證碼過期、已見證、作廢或面板關掉就停；頁面看不到時不問
function qrPanel(c, m, which, r, kg, opener, again) {
  const code = String(r.token || ''), groups = code.match(/.{1,4}/g)?.join(' ') || code;
  const start = Date.now(), exp = Number.isFinite(utcMs(r.expires_at)) ? utcMs(r.expires_at) : start + 600e3;
  const before = which === 'base' ? m.w_base_at : m.w_last_at;
  let stop = false, timer = null;
  const s = openSheet('請幹部見證', `<div class="row spread"><h3 id="achQrT">請幹部見證</h3><button type="button" class="btn ghost sm" data-close>關閉</button></div>
    <div class="ach-kgline"><b class="num ach-kgv" id="achKgV">●●.●</b> <span>公斤</span><button type="button" class="btn ghost sm" id="achKgShow" aria-pressed="false">顯示數字</button></div>
    <div class="qrbox ach-qr" id="achQR" role="img" aria-label="見證碼的 QR Code"></div>
    <p class="ach-code num" data-code="${esc(code)}" translate="no">${esc(groups)}</p>
    <p class="tiny center" style="margin:0">請在場的幹部用 App 掃這個碼，並對照體重計上的數字</p>
    <p class="tiny center" id="achLeftP"><span>見證碼的有效時間</span> <span class="num" id="achLeft">10:00</span></p>
    <p class="ach-wstate center" id="achWState" aria-live="polite"></p>`, opener, 'achQrT', { onClose: () => { stop = true; clearInterval(timer); again('#achProg h2'); } });
  const host = s.host, kgv = host.querySelector('#achKgV'), show = host.querySelector('#achKgShow'), live = host.querySelector('#achWState');
  show.onclick = () => {
    const on = show.getAttribute('aria-pressed') !== 'true';
    show.setAttribute('aria-pressed', String(on));
    kgv.textContent = on ? kg.toFixed(1) : '●●.●';
    show.textContent = on ? '隱藏數字' : '顯示數字';
  };
  qrSVG(`cil-wit:${code}`, { size: 220, dark: '#0B1B33', light: '#fff' }).then((svg) => { const q = host.querySelector('#achQR'); if (q) q.innerHTML = svg; }).catch(() => {});
  const finish = (ok, msg) => {
    stop = true; clearInterval(timer);
    host.querySelector('#achLeftP')?.remove();
    live.innerHTML = ok ? `<span class="ach-ok">${ic('<path d="M5 12.5l4.2 4.2L19 7"/>')}<span>已見證</span></span>` : `<span>${msg}</span>`;
    if (ok) { host.querySelector('#achQR')?.classList.add('ach-qrdone'); navigator.vibrate?.(30); }
  };
  const left = () => {
    const ms = exp - Date.now(), el = host.querySelector('#achLeft');
    if (ms <= 0) { finish(false, '見證碼過期了，請重新產生'); return; }
    if (el) el.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  };
  timer = setInterval(() => { if (!host.isConnected) { stop = true; clearInterval(timer); return; } left(); }, 1000);
  left();
  const poll = async () => {
    if (stop || !host.isConnected) return;
    if (!document.hidden) {
      try {
        const w = await api(`/ach/${encodeURIComponent(c.id)}/wit`);
        if (stop) return;
        const at = which === 'base' ? w.base_at : w.last_at;
        if (at && at !== before && w.pending !== which) { finish(true); return; }
        if (!w.pending) { finish(false, Date.now() >= exp - 5000 ? '見證碼過期了，請重新產生' : '見證碼已經作廢，請重新產生'); return; }
      } catch {}
    }
    if (Date.now() >= exp) return;
    setTimeout(poll, Date.now() - start < 120e3 ? 4000 : 10000);
  };
  setTimeout(poll, 4000);
}
// 幹部：見證跑友的量測。掃碼（或手動輸入）→ 看著體重計輸入讀數 → 伺服器比對；不回傳任何數字，也不回傳有沒有達成
function witnessScan(opener) {
  let close = null;
  close = scanSheet({
    title: '見證體重量測', hint: '掃跑友手機上的見證碼，數字以體重計為準', placeholder: '手動輸入見證碼',
    onCode: async (raw) => {
      const code = String(raw).replace(/^cil-wit:/i, '').replace(/[\s-]/g, '').toLowerCase();
      if (!/^[bl][0-9a-z]{15}$/.test(code)) return '這不是見證碼';
      close?.(); setTimeout(() => witnessKg(code, opener), 0);
      return '';
    },
  });
}
function witnessKg(code, opener) {
  const s = openSheet('見證體重量測', `<h3 id="achWkT">見證體重量測</h3><p class="tiny" style="margin:0">看著體重計，輸入上面顯示的數字</p>
    <form class="ach-wform" novalidate><label>體重計上的數字（公斤）<input name="kg" inputmode="decimal" autocomplete="off"></label>
      <p class="ach-wkmsg" aria-live="polite"></p>
      <div class="choices"><button class="btn block">送出見證</button><button type="button" class="btn ghost block" data-close>關閉</button></div></form>`, opener, 'achWkT');
  const f = s.host.querySelector('form'), btn = f.querySelector('.btn.block'), msg = f.querySelector('.ach-wkmsg');
  f.onsubmit = (e) => { e.preventDefault(); go(); };
  const go = once(btn, async () => {
    const kg = Math.round(Number(String(f.kg.value).replace(',', '.')) * 10) / 10;
    if (!kgOk(kg)) { fieldError(f.kg, '體重請填 30–250 公斤'); return; }
    try {
      const r = await api('/ach/witness', { method: 'POST', body: { code, kg } });
      msg.innerHTML = `<span class="ach-ok">${ic('<path d="M5 12.5l4.2 4.2L19 7"/>')}<span>已見證</span></span> <b translate="no">${esc(r.name || '')}</b><span>${/^b/.test(String(r.which)) ? '的起始量測' : '的結束量測'}</span>`;
      f.kg.value = ''; f.kg.disabled = true; btn.hidden = true;
      f.querySelector('[data-close]').textContent = '完成';
      f.querySelector('[data-close]').focus();
    } catch (err) {
      msg.textContent = err.message;
      if (err.status === 400 && !/數字/.test(err.message)) { f.kg.disabled = true; btn.hidden = true; }
      else f.kg.select();
    }
  });
}
// 團服卡：名額、候補、已領取、同款已拿、不需要；尺寸（44px chips）、尺寸表、用報名資料的尺寸、不需要／又想要
function shirtCard(c, m, t) {
  const sh = c.rewards.shirt, st = m.reward_state, by = sh.size_by;
  const head = st === 'issued' ? `<b>已領取</b>・<span class="num">${md(tpDay(m.issued_at))}</span>`
    : st === 'granted' ? '<b>你有團服名額</b>'
      : st === 'waitlist' ? `<b>候補第 ${m.reward_rank} 位</b>`
        : st === 'dup' ? '<b>你已經在其他挑戰拿到同款團服</b>'
          : st === 'declined' ? '<b>你選了不需要團服</b>'
            : m.position && sh.quota ? `<b>目前第 ${m.position} 位，名額 ${sh.quota} 件</b>`
              : ['achieved', 'met'].includes(m.status) ? '<b>團服名額會在挑戰結算時依達成先後分配</b>' : '<b>完成挑戰就有機會拿到團服</b>';
  const can = st !== 'issued' && st !== 'dup' && st !== 'declined' && (!m.shirt_size || !by || t <= by);
  return `<section class="card ach-sec ach-shirt" id="achShirt" aria-labelledby="achShirtT"><h2 class="h3" id="achShirtT">團服</h2>
    <p class="ach-shst">${ic(ACH_ICONS.shirt)}<span>${head}</span></p>
    ${st === 'granted' && c.pickup ? `<p class="tiny" style="margin:0"><span>領取方式：</span><span translate="no">${esc(c.pickup)}</span></p>` : ''}
    ${st !== 'dup' && st !== 'declined' ? `<fieldset class="ach-sizefs"><legend>尺寸</legend>
      <div class="chips ach-sizes">${sh.sizes.map((z) => `<button type="button" class="chip" data-shirt="${esc(z)}" aria-pressed="${m.shirt_size === z}" translate="no"${can ? '' : ' disabled'}>${esc(z)}</button>`).join('')}</div></fieldset>
      <div class="ach-shacts"><span id="achRpSize"></span>${sh.chart ? `<a class="tiny" href="${esc(sh.chart)}" target="_blank" rel="noopener">尺寸表 ›</a>` : ''}</div>
      ${by && st !== 'issued' ? (t <= by ? `<p class="tiny" style="margin:0">尺寸選到 ${md(by)}</p>` : m.shirt_size ? '<p class="tiny" style="margin:0">尺寸選擇已截止，要改請聯絡幹部</p>' : '<p class="tiny" style="margin:0">尺寸截止了，還是可以第一次選尺寸</p>') : ''}` : ''}
    ${st === 'dup' ? '<button type="button" class="btn ghost sm" id="achShirtBack">我還是想要這一件</button>'
    : st === 'declined' ? '<button type="button" class="btn ghost sm" id="achShirtBack">我又想要了</button>'
      : st !== 'issued' ? '<button type="button" class="linkbtn tiny" id="achShirtNo">我不需要團服</button>' : ''}
  </section>`;
}
function bindShirt(c, m, t, again) {
  const cid = encodeURIComponent(c.id), sh = c.rewards.shirt;
  const post = async (body, msg, sel) => {
    try { await api(`/ach/${cid}/shirt`, { method: 'POST', body }); toast(msg); await again(sel); } catch (err) { toast(err.message); }
  };
  for (const b of view.querySelectorAll('[data-shirt]')) b.onclick = once(b, () => (b.getAttribute('aria-pressed') === 'true' ? null : post({ size: b.dataset.shirt }, '已選好尺寸', `[data-shirt="${CSS.escape(b.dataset.shirt)}"]`)));
  $id('achShirtNo')?.addEventListener('click', async () => {
    const ok = await choose('放棄團服名額？', '名額會給下一位候補的跑友。', [{ value: 'y', label: '我不需要團服', danger: true }], { cancel: '保留名額' });
    if (ok === 'y') await post({ decline: true }, '已放棄團服名額', '#achShirtT');
  });
  $id('achShirtBack')?.addEventListener('click', () => post({ decline: false }, '已重新排隊', '#achShirtT'));
  // 用我報名資料裡的尺寸：只讀本人自己的資料（伺服器沒有新的讀取路徑），由本人按下才帶入
  const slot = $id('achRpSize');
  const can = !view.querySelector('[data-shirt]')?.disabled;
  if (!slot || !can) return;
  api('/me/race-profile').then((r) => {
    const z = String(r?.profile?.shirt || '').trim().toUpperCase(), hit = sh.sizes.find((x) => x.toUpperCase() === z);
    if (!hit || hit === m.shirt_size || !slot.isConnected) return;
    slot.innerHTML = `<button type="button" class="btn ghost sm" id="achRpBtn">用我報名資料裡的尺寸<span translate="no">（${esc(hit)}）</span></button>`;
    $id('achRpBtn').onclick = () => post({ size: hit }, '已選好尺寸', `[data-shirt="${CSS.escape(hit)}"]`);
  }).catch(() => {});
}

// ---------- #/cheers 恭喜榜 ----------
const CHEER_PATH = '#/cheers';
export async function cheersView() {
  const q = hashQ();
  const st = { tab: q.get('tab') === 'rank' ? 'rank' : 'recent', team: q.get('team') || '', dist: STD.includes(q.get('dist')) ? q.get('dist') : 'fm' };
  return cheersPaint(st);
}
async function cheersPaint(st, focusSel) {
  if (!achOn()) { view.innerHTML = `${largeTitle('恭喜榜')}<div class="card">${emptyState(ic(ACH_ICONS.sparkle), '這個功能目前沒有開放')}</div>`; return; }
  if (st.tab === 'rank' && !achRankOn()) st.tab = 'recent';
  const mine = teams().filter((x) => x.my_status === 'active');
  if (st.team && !mine.some((x) => x.id === st.team)) st.team = '';
  const qs = `tab=${st.tab}${st.tab === 'rank' ? `&dist=${st.dist}` : ''}${st.team ? `&team=${encodeURIComponent(st.team)}` : ''}`;
  const d = await api(`/ach/board?${qs}`);
  if (!onPage(CHEER_PATH)) return;
  try { history.replaceState(null, '', `${CHEER_PATH}?${qs}`); } catch {}
  if (d.on === false) { view.innerHTML = `${largeTitle('恭喜榜')}<div class="card">${emptyState(ic(ACH_ICONS.sparkle), '這個功能目前沒有開放')}</div>`; return; }
  const meOn = d.me ? !!d.me.cheer_board : !!me.cheer_board, rankOn = d.me ? !!d.me.cheer_rank : !!me.cheer_rank;
  const tabs = achRankOn() ? `<div class="seg cheer-tabs" role="group" aria-label="恭喜榜">${[['recent', '最新'], ['rank', 'PB 排行']].map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${st.tab === k}">${l}</button>`).join('')}</div>` : '';
  const chips = mine.length ? `<div class="chips cheer-teams" role="group" aria-label="依分團篩選"><button type="button" class="chip" data-team="" aria-pressed="${!st.team}">全部</button>
    ${mine.map((x) => `<button type="button" class="chip" data-team="${esc(x.id)}" aria-pressed="${st.team === x.id}"><span translate="no">${esc(x.name)}</span></button>`).join('')}</div>` : '';
  const intro = !meOn ? `<section class="card cheer-intro"><p style="margin:0">你目前不在恭喜榜上。打開後，登入的跑友看得到你的名字、通過審核的 PB 成績與完成的挑戰；體重挑戰不會上榜。</p>
      <div class="row"><button type="button" class="btn sm" id="cheerJoin">出現在恭喜榜</button><a class="tiny" href="#/me/privacy">隱私設定 ›</a></div></section>`
    : st.tab === 'rank' && !rankOn ? `<section class="card cheer-intro"><p style="margin:0">PB 排行要另外同意：打開後，登入的跑友看得到你在各距離 PB 排行的名次與成績。</p>
      <div class="row"><button type="button" class="btn sm" id="cheerRank">也列入 PB 排行</button><a class="tiny" href="#/me/privacy">隱私設定 ›</a></div></section>` : '';
  const body = st.tab === 'rank' ? rankBody(d, st) : `<ul class="cheer-list" role="list" id="cheerList">${(d.items || []).map(cheerItem).join('')}</ul>
    ${d.items?.length ? '' : `<div class="card"><div class="empty">${ic(ACH_ICONS.sparkle)}<b class="etitle">還沒有人上榜</b><span>通過審核的 PB 與完成的挑戰會出現在這裡</span></div></div>`}
    ${d.next ? '<button type="button" class="btn ghost block" id="cheerMore">看更多</button>' : ''}`;
  view.innerHTML = `${largeTitle('恭喜榜', '通過審核的 PB 與完成的挑戰')}${intro}${tabs}${chips}${body}`;
  if (focusSel) focusEl(view.querySelector(focusSel));
  const repaint = (patch, sel) => cheersPaint({ ...st, ...patch }, sel);
  for (const b of view.querySelectorAll('[data-tab]')) b.onclick = () => repaint({ tab: b.dataset.tab }, `[data-tab="${b.dataset.tab}"]`);
  for (const b of view.querySelectorAll('[data-team]')) b.onclick = () => repaint({ team: b.dataset.team }, `[data-team="${CSS.escape(b.dataset.team)}"]`);
  for (const b of view.querySelectorAll('[data-dist]')) b.onclick = () => repaint({ dist: b.dataset.dist }, `[data-dist="${b.dataset.dist}"]`);
  $id('cheerJoin')?.addEventListener('click', once($id('cheerJoin'), async () => {
    try { await api('/me/cheer-board', { method: 'POST', body: { on: true } }); me.cheer_board = true; toast('已加入恭喜榜'); await repaint({}, 'h1'); } catch (err) { toast(err.message); }
  }));
  $id('cheerRank')?.addEventListener('click', once($id('cheerRank'), async () => {
    try { await api('/me/cheer-board', { method: 'POST', body: { rank: true } }); me.cheer_rank = true; me.cheer_board = true; toast('已列入 PB 排行'); await repaint({}, 'h1'); } catch (err) { toast(err.message); }
  }));
  let next = d.next, items = [...(d.items || [])];
  $id('cheerMore')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    await once(btn, async () => {
      try {
        const r = await api(`/ach/board?${qs}&before=${encodeURIComponent(next)}`);
        const list = $id('cheerList'), n0 = list.children.length;
        list.insertAdjacentHTML('beforeend', (r.items || []).map(cheerItem).join(''));
        items = [...items, ...(r.items || [])]; next = r.next;
        list.children[n0]?.querySelector('button, a')?.focus();
        if (!next) btn.remove();
      } catch (err) { toast(err.message); }
    })();
  });
  // 恭喜：先在畫面上換，失敗再換回來；只顯示人數
  view.querySelector('#cheerList')?.addEventListener('click', async (e) => {
    const share = e.target.closest('[data-share]'), b = e.target.closest('[data-cheer]');
    const li = e.target.closest('[data-item]'), x = li && items.find((i) => i.item === li.dataset.item);
    if (share && x) { shareSheet(x.type === 'pb' ? pbShareText(x.pb) : achShareText(x.ach.title), share); return; }
    if (!b || !x || b.dataset.busy) return;
    const on = b.getAttribute('aria-pressed') !== 'true', n = b.querySelector('.num');
    const set = (pressed, count) => { b.setAttribute('aria-pressed', String(pressed)); n.textContent = count > 0 ? String(count) : ''; };
    const prev = [x.cheered, x.cheers];
    b.dataset.busy = '1'; set(on, Math.max(0, (x.cheers || 0) + (on ? 1 : -1)));
    try { const r = await api('/ach/cheer', { method: 'POST', body: { item: x.item, on } }); x.cheered = r.cheered; x.cheers = r.cheers; set(r.cheered, r.cheers); }
    catch (err) { set(prev[0], prev[1]); toast(err.message); } finally { delete b.dataset.busy; }
  });
}
function cheerItem(x) {
  const m = x.member || {}, name = who(m);
  const what = x.type === 'pb'
    ? `<p class="cheer-what">${x.pb.pb_kind === 'break' ? `刷新 ${distLabel(x.pb.dist_key, x.pb.km)} PB` : `完賽 ${distLabel(x.pb.dist_key, x.pb.km)}`}</p>
      <p class="cheer-time"><b class="num">${fmtTime(x.pb.seconds)}</b>${x.pb.pb_kind === 'break' && x.pb.prev_seconds > x.pb.seconds ? `<span class="pill solid">快 ${fmtTime(x.pb.prev_seconds - x.pb.seconds)}</span>` : ''}</p>
      <p class="tiny cheer-race"><span translate="no">${esc(x.pb.race_name)}</span>・${md(x.pb.race_date)}</p>`
    : `<p class="cheer-what">完成挑戰</p><a class="cheer-ach" href="#/ach/c/${esc(x.ach.cid)}">${ic(ACH_ICONS[x.ach.badge] || ACH_ICONS[KIND_ICON[x.ach.kind]] || ACH_ICONS.trophy)}<b translate="no">${esc(x.ach.title)}</b></a>`;
  return `<li class="card cheer-card" data-item="${esc(x.item)}">
    <div class="cheer-head">${avatar(m)}<span class="cheer-who"><b translate="no">${esc(name)}</b>${teamPill(m.team)}</span>
      ${x.self ? '' : `<button type="button" class="cheer-btn" data-cheer aria-pressed="${!!x.cheered}">${ic(ACH_ICONS.sparkle)}<span>恭喜</span><span class="sr" translate="no">${esc(name)}</span><b class="num">${x.cheers > 0 ? x.cheers : ''}</b></button>`}</div>
    ${what}
    ${x.self ? `<div class="cheer-self"><span class="tiny">${x.cheers > 0 ? `${x.cheers} 位跑友恭喜你` : ''}</span><button type="button" class="btn ghost sm" data-share>分享到 LINE</button></div>` : ''}
  </li>`;
}
function rankBody(d, st) {
  const rows = d.rank || [];
  const tie = (r, i) => rows.some((o, j) => j !== i && o.rk === r.rk);
  const li = (r, i) => `<li class="${r.self ? 'me' : ''}"><span class="cheer-rk">${i >= 0 && tie(r, i) ? '<span class="tiny">並列</span>' : ''}<b class="num">${r.rk}</b></span>${avatar(r.member || {})}
    <span class="cheer-rwho"><b translate="no">${esc(who(r.member))}</b><span class="tiny"><span translate="no">${esc(r.race_name)}</span>・${slash(r.race_date)}</span></span><b class="num cheer-rt">${fmtTime(r.seconds)}</b></li>`;
  const mineExtra = d.mine && !rows.some((r) => r.self) ? `<li class="cheer-gap" aria-hidden="true">⋯</li>${li(d.mine, -1)}` : '';
  return `<div class="seg cheer-dists" role="group" aria-label="距離">${STD.map((k) => `<button type="button" data-dist="${k}" aria-pressed="${st.dist === k}">${DISTS[k].zh}</button>`).join('')}</div>
    <p class="tiny">近三年通過審核的成績，不分性別年齡，只是參考。</p>
    ${rows.length ? `<ol class="card cheer-rank" role="list">${rows.map(li).join('')}${mineExtra}</ol>` : `<div class="card"><div class="empty">${ic(ACH_ICONS.stopwatch)}<span>這個距離還沒有人列入排行</span></div></div>`}`;
}
