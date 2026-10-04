// 耕跑團 PWA — admin.js：從 app.js 拆出來、用到才載入的畫面（第一次開 App 不用下載）
import * as Party from './party.js';
import { defaultWindow, SIGNUP_DEFAULTS, tpText } from './signup-window.js';
import { $, latest, nowTp, openSheet, scanSheet, ago, allow, api, apiAll, applyFeatures, avatar, barChart, bars, bindStepup, cfg, esc, group, IC, largeTitle, me, mfaBanner, nrow, org, pad2, paintCountdown, passkey, refreshMe, render, ROLE_NAME, row, studio, TAB_DEFAULT, TEAM_PERMS, teamAllow, teamIcon, teamOf, teams, toast, view } from './app.js';

// ---------- 管理介面（RBAC、會籍、座位圖）----------
let adminSeq = 0;
const MEMBERSHIP_NAME = { none: '跑友', applied: '申請中', active: '協會會員', expired: '會籍到期' };
async function adminView(tab) {
  tab ||= new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'overview';
  if (me.mfaPending) { view.innerHTML = `${largeTitle('管理後台')}${mfaBanner()}`; bindStepup(); return; }
  if (!allow('members') && !allow('roles') && !allow('settings')) { view.innerHTML = '<div class="card"><p class="muted">沒有管理權限。</p></div>'; return; }
  const tabs = [['overview', '總覽'], ['members', '會員'], ['roles', '權限'], ['teams', '分團'], ['events', '活動'], ...(allow('settings') ? [['settings', '設定']] : []), ...(allow('audit') ? [['audit', '稽核']] : [])];
  // 只拿統計數字，名單要下條件才查
  const my = ++adminSeq;
  const meta = await api('/members?role=officers');
  if (my !== adminSeq || !location.hash.startsWith('#/admin')) return;   // 等資料的時候已經換頁或換分頁：不要蓋掉
  // 已經在管理後台：只換下面的內容，標題與分頁列不動（不會整頁跳動、捲動位置也保留）
  if (!view.querySelector('.adminseg')) {
    view.innerHTML = `${largeTitle('管理後台', `<span id="adminTotal">${meta.total}</span> 位跑友`)}
      <div class="seg adminseg" role="group" aria-label="管理分頁">${tabs.map(([k, v]) => `<button type="button" data-atab="${k}" aria-pressed="${tab === k}">${v}</button>`).join('')}</div>
      <div id="panel"></div>`;
    // 分頁寫進網址：重新整理或返回時停在同一頁（只綁在管理分頁的按鈕上，不要碰到下方分頁列）
    for (const b of view.querySelectorAll('[data-atab]')) b.onclick = () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      history.replaceState(null, '', `#/admin?tab=${b.dataset.atab}`); adminView(b.dataset.atab);
    };
  }
  $('#adminTotal') && ($('#adminTotal').textContent = meta.total);
  for (const b of view.querySelectorAll('[data-atab]')) b.setAttribute('aria-pressed', String(b.dataset.atab === tab));
  const panel = $('#panel');
  panel.style.minHeight = `${panel.offsetHeight}px`;   // 換內容時先保留高度，畫面不會往上縮再彈回來
  panel.setAttribute('aria-busy', 'true');
  const html = tab === 'overview' ? await overviewPanel()
    : tab === 'members' ? await membersPanel(meta)
    : tab === 'roles' ? rolesPanel(meta)
    : tab === 'teams' ? adminTeamsPanel()
    : tab === 'audit' ? auditPanel()
    : tab === 'settings' ? settingsPanel()
    : await eventsPanel();
  if (my !== adminSeq || !panel.isConnected) return;
  panel.innerHTML = html;
  panel.style.minHeight = ''; panel.removeAttribute('aria-busy');
  if (tab === 'overview') bindOverview();
  if (tab === 'members') bindMembers();
  if (tab === 'roles') { for (const b of document.querySelectorAll('[data-role]')) b.onclick = () => roleDialog(b.dataset.role, b.dataset.name, b.dataset.cur); bindHandover(); }
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
    // 沒有副標也留一行空白，同一列的數字才會對齊
  const k = (label, v, sub = '') => `<div class="card kpi"><span class="tiny">${label}</span><b class="num">${v ?? '—'}</b><span class="tiny">${sub || '&nbsp;'}</span></div>`;
  return `<section class="card" id="pendingTop" hidden></section>
    <section class="kpis">
      ${k('跑友人數', o.members, `本月新加入 ${o.newThisMonth}`)}${k('30 天內活躍', o.active30, o.members ? `${Math.round(o.active30 / o.members * 100)}%` : '')}
      ${k('協會會員數', o.association, `待審 ${o.applied}・將到期 ${o.expiring}`)}${k('團練出席率', o.attendance == null ? '—' : `${o.attendance}%`, '最近 30 天')}
      ${k('近 30 天活動', o.events30, `接下來 30 天 ${o.upcoming} 場`)}${k('近 30 天報名', o.signups30)}
      ${k('7 天訓練紀錄', o.logs7)}${k('已開推播', o.pushSubs == null ? null : `${o.pushSubs}<small> 人</small>`)}
    </section>
    ${allow('settings') || allow('audit') ? '<section class="card" id="healthBox"><h3>開啟速度與錯誤</h3><p class="tiny" style="margin:0">載入中…</p></section>' : ''}
    <section class="card"><h3>每月新加入</h3>${barChart(months.map((m) => ({ l: `${Number(m.slice(5))}月`, v: g[m] || 0 })), { unit: ' 人', h: 120 })}</section>
    <section class="card"><h3>分團人數</h3>${bars(o.teamSizes.map((t) => [t.name, t.n]))}</section>
    ${allow('settings') || (allow('members') && me.role !== 'supervisor') ? `<section class="card"><h3>群發通知</h3>
      <form id="bcForm" class="filters">
        <input name="title" maxlength="60" placeholder="標題，例如：週六團練改到河濱" required>
        <textarea name="body" maxlength="300" placeholder="內容（選填）"></textarea>
        <fieldset class="qset"><legend>對象（不選就是全部跑友）</legend>
          <div class="chips">${teams().map((t) => `<label class="chip"><input type="checkbox" name="teams" value="${esc(t.id)}"><span><span translate="no">${esc(t.name)}</span></span></label>`).join('')}</div>
          <div class="chips">${Object.entries(ROLE_NAME).filter(([r]) => r !== 'member').map(([r, v]) => `<label class="chip"><input type="checkbox" name="roles" value="${r}"><span>${v}</span></label>`).join('')}
            <label class="chip"><input type="checkbox" name="membership" value="active"><span>協會會員</span></label></div></fieldset>
        <label>點通知後開啟的頁面（選填）<input name="url" placeholder="例如 /#/e/活動代碼" aria-describedby="bcUrlHint"></label>
        <span class="tiny" id="bcUrlHint">沒填的話，點通知會打開完整內容</span>
        <div class="row"><button type="button" class="btn ghost sm" id="bcCount">算一下人數</button><button class="btn sm">送出</button><span class="tiny" id="bcOut" role="status"></span></div>
      </form>
      <div id="bcPreview" hidden><h3 class="sgt" style="margin:0 0 6px">會員收到的樣子</h3><div class="card setcard"><ul class="nlist" role="list"></ul></div></div>
      <p class="tiny" style="margin:0">同時勾分團和身分時，要兩個條件都符合。會寫入稽核紀錄；一小時最多 10 次。</p></section>` : ''}`;
}
// 開啟速度與前端錯誤：p75＝四分之三的人比這個快；不含身分
const HEALTH = [['ready', '開啟到可用', 1500, 3000, 'ms'], ['lcp', '主要內容出現', 2500, 4000, 'ms'], ['inp', '點擊反應', 200, 500, 'ms'], ['cls', '畫面跳動', 0.1, 0.25, ''], ['ttfb', '伺服器回應', 800, 1800, 'ms']];
async function loadHealth(days = 7) {
  const box = $('#healthBox'); if (!box) return;
  const h = await api(`/admin/health?days=${days}`).catch(() => null);
  if (!h || !box.isConnected) return;
  const fmt = (v, u) => (v == null ? '—' : u === 'ms' ? (v >= 1000 ? `${(v / 1000).toFixed(1)} 秒` : `${Math.round(v)} 毫秒`) : v.toFixed(v < 0.01 ? 3 : 2));
  const grade = (v, good, poor) => (v == null ? '' : v <= good ? 'good' : v <= poor ? 'ok' : 'poor');
  box.innerHTML = `<div class="row spread"><h3>開啟速度與錯誤</h3><div class="seg" role="group" aria-label="期間">${[7, 30, 90].map((d) => `<button data-hd="${d}" aria-pressed="${h.days === d}">${d} 天</button>`).join('')}</div></div>
    <div class="vitals">${HEALTH.map(([k, label, good, poor, u]) => { const m = h.metrics[k]; return `<div class="vital ${grade(m.p75, good, poor)}"><span class="tiny">${label}</span><b class="num">${fmt(m.p75, u)}</b>
      <span class="tiny">${m.n ? `${m.n} 次${k === 'ready' && m.warmP75 != null ? `・有暫存 ${fmt(m.warmP75, u)}` : ''}` : '還沒有資料'}</span></div>`; }).join('')}</div>
    <p class="tiny" style="margin:0">數字是 p75：四分之三的人比這個快。綠色達到 Google 建議值、橘色要注意、紅色要改善。不記錄是誰。</p>
    <h3>最慢的資料讀取</h3>
    ${(h.apis || []).length ? `<div class="itemtable">${h.apis.map((a) => `<div class="itr"><span><b class="num" style="font-weight:600">${esc(a.page)}</b><span class="tiny" style="display:block">${a.n} 次${a.srv != null ? `・伺服器 ${fmt(a.srv, 'ms')}` : ''}</span></span><b class="num">${fmt(a.p75, 'ms')}</b></div>`).join('')}</div>
      <p class="tiny" style="margin:0">總時間減掉伺服器時間，就是花在網路上的時間。</p>` : '<p class="tiny" style="margin:0">還沒有資料。</p>'}
    <h3>前端錯誤</h3>
    ${h.errors.length ? `<div class="roster">${h.errors.map((e) => `<div class="r"><span class="av num" style="font-size:12px">${e.n}</span><span><b style="word-break:break-word">${esc(e.message)}</b>
      <span class="tiny" style="display:block">${esc(e.page || '')}${e.source ? `・${esc(e.source)}:${e.line}` : ''}・${esc(e.device || '')}・${ago(e.last_at)}</span></span></div>`).join('')}</div>`
      : '<p class="tiny" style="margin:0">這段期間沒有錯誤。</p>'}
    ${budgetHtml(h)}`;
  for (const b of box.querySelectorAll('[data-hd]')) b.onclick = () => loadHealth(Number(b.dataset.hd));
}
// 執行額度（免費方案一次執行 50 個子請求）：排程工作的狀態、推播佇列、最常碰到上限的功能。狀態一律用文字
const JOB_NAME = { backup: '每日備份', retention: '資料清理', month_summary: '每月總結', quarterly_review: '每季權限檢視', fatigue: '疲勞提醒',
  signup_review_digest: '待審核整理', 'cams.wra': '鏡頭清單（水利署）', 'cams.heo': '鏡頭清單（水利處）', 'cams.thb': '鏡頭狀態重設（公路局）',
  backup_manual: '手動備份', events: '活動提醒', signupOpen: '開放報名通知', followups: '跑完接續', weather: '壞天氣提醒', signupReviews: '待審核失效',
  promoteSweep: '候補遞補', renewals: '會費到期提醒', auditDigest: '稽核摘要', monthSummary: '每月總結', review: '每季權限檢視', push: '推播佇列', cams: '鏡頭清單',
  rest: '跑者休息站同步', 'rest.tpbk': '休息站（臺北市河濱自行車租借站）', 'rest.ntrv': '休息站（新北市河濱景觀廁所）' };
function budgetHtml(h) {
  if (!h.jobs) return '';
  const bad = (t) => `<b style="color:var(--race)">${t}</b>`;
  const state = (j) => (j.state === 'gave_up' ? bad(`失敗 ${j.attempts} 次，已停止重試`) : j.state === 'failed' ? bad(`失敗 ${j.attempts} 次`)
    : j.state === 'retry' ? bad('沒有完成，隔天重試') : j.state === 'pending' ? '等下個整點補做' : `完成${j.last_run ? `（${esc(j.last_run)}）` : ''}`);
  const q = h.pushQueue || { n: 0 };
  return `<h3>執行額度</h3>
    <p class="tiny" style="margin:0">免費方案一次執行最多 50 個子請求；做不完的工作會在下個整點接著做。</p>
    ${(h.budget || []).length ? `<div class="itemtable">${h.budget.map((x) => `<div class="itr"><span><b class="num" style="font-weight:600;word-break:break-word">${esc(x.name)}</b>
      <span class="tiny" style="display:block">停下 ${x.stopped} 次${x.over ? `・超過上限 ${x.over} 次` : ''}・單次最高 ${x.max_sub}</span></span><span class="tiny">${ago(x.last_at)}</span></div>`).join('')}</div>
      <p class="tiny" style="margin:0">最常碰到額度上限的功能：停下表示做到一半留到下次，超過上限要檢查。</p>` : '<p class="tiny" style="margin:0">這段期間沒有功能碰到額度上限。</p>'}
    <h4>排程工作</h4>
    ${h.jobs.length ? `<div class="itemtable">${h.jobs.map((j) => `<div class="itr"><span><b style="font-weight:600">${esc(JOB_NAME[j.job] || j.job)}</b>
      ${j.last_error ? `<span class="tiny" style="display:block;word-break:break-word">${esc(j.last_error)}</span>` : ''}</span><span class="tiny">${state(j)}</span></div>`).join('')}</div>` : '<p class="tiny" style="margin:0">排程工作還沒執行過。</p>'}
    <h4>推播佇列</h4>
    <p class="tiny" style="margin:0">${q.n ? `待送 ${q.n} 則・最早一則 ${ago(q.oldest)}` : '沒有待送的推播。'}</p>`;
}
function bindOverview() {
  loadHealth();
  loadPending($('#pendingTop'), { hideEmpty: true });
  const f = $('#bcForm'); if (!f) return;
  const body = () => ({ title: f.title.value, body: f.body.value, url: f.url.value.trim(),
    teams: [...f.querySelectorAll('[name=teams]:checked')].map((x) => x.value), roles: [...f.querySelectorAll('[name=roles]:checked')].map((x) => x.value),
    membership: [...f.querySelectorAll('[name=membership]:checked')].map((x) => x.value) });
  // 伺服器的錯誤（例如標題用了系統安全通知的保留字）就近顯示在按鈕旁
  const showErr = (e) => { $('#bcOut').textContent = e.message; $('#bcOut').classList.add('err'); };
  $('#bcCount').onclick = async () => { try { const r = await api('/admin/broadcast', { method: 'POST', body: { ...body(), title: body().title || '試算', dryRun: true } }); $('#bcOut').classList.remove('err'); $('#bcOut').textContent = `會送給 ${r.count} 人`; } catch (e) { showErr(e); } };
  // 即時預覽：用通知中心同一個 nrow() 畫一列「協會公告」，看到的就是會員收到的樣子
  const preview = () => {
    const b = body(), box = $('#bcPreview'); if (!box) return;
    box.hidden = !b.title.trim();
    if (box.hidden) return;
    box.querySelector('ul').innerHTML = nrow({ id: 'bcpreview', category: 'announce', kind: 'broadcast', ref: null, title: b.title.trim(), body: b.body.trim(), url: b.url || null,
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19), read_at: null });
    box.querySelector('.nmore')?.remove();
    box.querySelector('a.nrow').removeAttribute('href');
  };
  f.addEventListener('input', preview);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { const { count } = await api('/admin/broadcast', { method: 'POST', body: { ...body(), dryRun: true } });
      $('#bcOut').classList.remove('err');
      if (!confirm(`要送出通知給 ${count} 人嗎？`)) return;
      const r = await api('/admin/broadcast', { method: 'POST', body: body() }); toast(`已送出給 ${r.count} 人`); f.reset(); $('#bcOut').textContent = ''; preview();
    } catch (err) { showErr(err); }
  };
}

// 名冊查詢：一律下條件（關鍵字、會籍、身分、分團），一次 50 筆
const memberCache = new Map();
function memberFilterForm(id, { membership = true } = {}) {
  return `<form id="${id}" class="filters" role="search" data-live>
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
  const only = latest();
  const load = async (more) => {
    const qs = new URLSearchParams({ ...params, ...(more ? { after: next } : {}) });
    const r = await only(api(`/members?${qs}`));
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
    <section class="card"><div class="row spread"><div class="row" style="gap:6px">${chips}</div><button class="btn ghost sm" id="verifyCard" type="button">掃描會籍卡</button></div>
      <p class="tiny" style="margin:0">跑友只要加入就能報名團練；協會會員要另外申請與繳費，兩者分開管理。</p></section>
    ${meta.counts.applied ? `<section class="card"><h3>待審核入會（${meta.counts.applied}）</h3><div class="roster" id="appliedList"></div></section>` : ''}
    <section class="card"><h3>查詢跑友</h3>${memberFilterForm('mf2')}<div class="roster" id="mlist"></div></section>
    <div class="bulkbar" id="bulkBar" hidden><span>已選 <b id="bulkN">0</b> 人</span>
      <select id="bulkTeam" aria-label="設定主團">${['<option value="">清除主團</option>', ...teams().filter((t) => !t.self_managed || teamAllow(t.id, 'approve')).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`)].join('')}</select>
      <button class="btn sm" id="bulkApply">設為主團</button></div>`;
}
const memberRow = (m) => `<div class="r mrow">
    <label class="pick"><input type="checkbox" data-pick="${m.id}" aria-label="選取 ${esc(m.name)}"><i>${IC.check}</i></label>
    <span><b><span translate="no">${esc(m.name)}</span></b>${m.nickname ? ` <span class="tiny"><span translate="no">${esc(m.nickname)}</span></span>` : ''}
      <span class="tiny" style="display:block">${esc(m.club || '未填跑團')}・${m.roleName}${(m.teams || []).filter((x) => x.s === 'active').map((x) => `・<span translate="no">${esc(teamOf(x.t)?.name || x.t)}</span>`).join('')}${m.member_no ? `・編號 ${esc(m.member_no)}` : ''}${m.paid_until ? `・繳費至 ${esc(m.paid_until)}` : ''}</span></span>
    <span class="mact"><select data-main="${m.id}" aria-label="${esc(m.name)} 的主團" class="mainsel" ${teamOf(m.main_team)?.self_managed && !teamAllow(m.main_team, 'approve') ? 'disabled title="由該團幹部處理"' : ''}>${['<option value="">未設定主團</option>', ...teams().filter((t) => !t.self_managed || teamAllow(t.id, 'approve') || t.id === m.main_team).map((t) => `<option value="${esc(t.id)}" ${m.main_team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`)].join('')}</select>
      <button class="btn ghost sm" data-ms="${m.id}">${MEMBERSHIP_NAME[m.membership]}</button></span>
  </div>`;
function bindMembers() {
  $('#verifyCard')?.addEventListener('click', () => scanSheet({ title: '驗證會籍卡', hint: '把會員 App 裡的會籍卡 QR 對準框內', placeholder: '或貼上 QR 內容',
    onCode: async (c) => { const r = await api(`/members/verify?c=${encodeURIComponent(c)}`); return `${r.valid ? '有效會員' : '會籍已到期'}：${r.name}${r.member_no ? `・No. ${r.member_no}` : ''}${r.paid_until ? `・繳至 ${r.paid_until}` : ''}`; } }));
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
  // 用底部 sheet（焦點鎖在裡面、Esc 關閉），不要插在頁面最上面被頂部列蓋住
  const opener = document.activeElement;
  const s = openSheet('編輯會籍', `<h3 id="msdT"><span translate="no">${esc(m.name)}</span> 的會籍</h3>
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
      <div class="sheetacts"><button type="button" class="btn ghost" data-close>取消</button><button class="btn">儲存</button></div>
    </form>`, opener, 'msdT');
  s.host.querySelector('#msf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/members/${id}/membership`, { method: 'POST', body: {
        membership: f.membership.value, member_type: f.member_type.value, member_no: f.member_no.value,
        joined_on: f.joined_on.value, paid_until: f.paid_until.value, membership_note: f.membership_note.value } });
      s.close(); toast('已更新會籍'); adminView('members');
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
      <div class="permtable" tabindex="0" role="region" aria-label="權限對照">
        <div class="hd"><span>身分</span>${Object.values(PERM_NAME).map((p) => `<span>${p}</span>`).join('')}</div>
        ${order.map((r) => `<div class="rw"><span>${data.roles[r]}</span>${Object.keys(PERM_NAME).map((p) =>
          `<span>${data.perms[r].includes(p) ? `<i class="yes" role="img" aria-label="有">${IC.check}</i>` : '<i class="no" role="img" aria-label="無"></i>'}</span>`).join('')}</div>`).join('')}
      </div>
      <p class="tiny">監事可以看名冊與會籍，但不能修改。身分由理事長在下方「指派身分」設定。</p>
    </section>
    ${order.filter((r) => byRole[r]?.length).map((r) => `<section class="card">
      <div class="row spread"><h3>${data.roles[r]}</h3><span class="tiny">${byRole[r].length} 人</span></div>
      <div class="roster">${byRole[r].map((m) => `<div class="r">${avatar(m)}
        <span><b><span translate="no">${esc(m.name)}</span></b>${m.title ? ` <span class="tiny"><span translate="no">${esc(m.title)}</span></span>` : ''}</span>
        ${allow('roles') ? `<button class="btn ghost sm" data-role="${m.id}" data-name="${esc(m.name)}" data-cur="${m.role}">變更</button>` : ''}</div>`).join('')}</div>
    </section>`).join('')}
    ${allow('roles') ? `<section class="card"><h3>指派身分</h3>
      <form id="roleSearch" class="row" style="gap:8px" role="search" data-live><input name="q" maxlength="20" placeholder="輸入跑友姓名或暱稱" aria-label="搜尋要指派身分的跑友" style="flex:1;min-width:160px" required><button class="btn ghost sm">搜尋</button></form>
      <div id="roleList" class="roster"></div></section>` : ''}
    ${me.role === 'chair' ? `<section class="card" id="handover">
      <h3>移交理事長</h3>
      <p class="tiny" style="margin:0">新任理事長加入後，在這裡一步移交：對方成為理事長，你同時改成下面選的身分。雙方都要重新登入，並寫入稽核紀錄。</p>
      <form id="hoSearch" class="row" style="gap:8px" role="search" data-live><input name="q" maxlength="20" placeholder="輸入新任理事長的姓名" aria-label="搜尋新任理事長" style="flex:1;min-width:160px" required><button class="btn ghost sm">搜尋</button></form>
      <div id="hoList" class="roster"></div>
    </section>` : ''}`;
}
function bindHandover() {
  const rs = $('#roleSearch'), rsOnly = latest(), hoOnly = latest();
  if (rs) rs.onsubmit = async (e) => {
    e.preventDefault();
    const { members } = await rsOnly(api(`/members?q=${encodeURIComponent(rs.q.value.trim())}`).catch((err) => { toast(err.message); return { members: [] }; }));
    $('#roleList').innerHTML = members.slice(0, 12).map((m) => `<div class="r">${avatar(m)}<span><b><span translate="no">${esc(m.name)}</span></b><span class="tiny" style="display:block">${esc(ROLE_NAME[m.role] || '團員')}</span></span>
      <button class="btn ghost sm" data-role="${esc(m.id)}" data-name="${esc(m.name)}" data-cur="${esc(m.role)}">變更</button></div>`).join('') || '<p class="tiny" style="margin:0">找不到符合的跑友。</p>';
    for (const b of document.querySelectorAll('#roleList [data-role]')) b.onclick = () => roleDialog(b.dataset.role, b.dataset.name, b.dataset.cur);
  };
  const f = $('#hoSearch'); if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { members } = await hoOnly(api(`/members?q=${encodeURIComponent(f.q.value.trim())}`).catch((err) => { toast(err.message); return { members: [] }; }));
    const list = members.filter((m) => m.id !== me.id).slice(0, 10);
    $('#hoList').innerHTML = list.map((m) => `<div class="r">${avatar(m)}<span><b><span translate="no">${esc(m.name)}</span></b><span class="tiny" style="display:block">${esc(ROLE_NAME[m.role] || '')}</span></span>
      <button class="btn sm" data-ho="${esc(m.id)}" data-name="${esc(m.name)}">移交給這位</button></div>`).join('') || '<p class="tiny" style="margin:0">找不到符合的跑友。</p>';
    for (const b of document.querySelectorAll('[data-ho]')) b.onclick = () => handoverDialog(b.dataset.ho, b.dataset.name);
  };
}
function handoverDialog(id, name) {
  $('#hoList').innerHTML = `<form id="hoForm" class="regform" style="display:grid;gap:12px">
    <p class="notice" style="margin:0">把理事長移交給 <b><span translate="no">${esc(name)}</span></b>。移交後你就沒有指派身分的權限了，要改回來得請新任理事長處理。</p>
    <div class="grid2"><label>你移交後的身分<select name="my_role">${Object.entries(ROLE_NAME).filter(([k]) => k !== 'chair').map(([k, v]) => `<option value="${k}" ${k === 'director' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>你的職稱（選填）<input name="my_title" maxlength="12" placeholder="例如 前理事長、顧問"></label></div>
    <label>輸入「<span translate="no">${esc(name)}</span>」確認<input name="confirm" autocomplete="off" required></label>
    <div class="row"><button class="btn danger sm">確定移交</button><button type="button" class="btn ghost sm" id="hoCancel">取消</button></div></form>`;
  $('#hoCancel').onclick = () => { $('#hoList').innerHTML = ''; };
  $('#hoForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/members/${id}/handover`, { method: 'POST', body: { my_role: f.my_role.value, my_title: f.my_title.value, confirm: f.confirm.value.trim() } });
      toast(`已移交給 ${name}`); await refreshMe(); location.hash = '#/me'; render();
    } catch (err) { toast(err.message); }
  };
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
    </form>` : '<p class="muted" style="margin:0">還沒有餐敘類型的活動（春酒、慶功宴、尾牙）。</p>'}
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
  'passkey.add': '新增通行金鑰', 'passkey.remove': '移除通行金鑰', 'session.revoke_all': '登出所有裝置', 'passkey.denied': '通行金鑰驗證失敗', 'mfa.verify': '兩步驟驗證', 'login.new_device': '新裝置登入',
  'settings.security': '修改兩步驟驗證設定', 'audit.verify': '稽核完整性檢查',
  'settings.signup': '修改活動報名預設', 'event.signup_review': '審核報名', 'event.signup_reject': '婉拒或移出報名', 'event.reopen': '恢復活動',
  'signup.expire': '待審核逾期失效', 'event.orders_export': '下載訂購單',
  'google.link': '綁定 Google', 'login.denied': '登入驗證失敗', 'team.post': '發布分團公告', 'team.post_delete': '刪除分團公告', 'privacy.show_rank': '排行榜設定', broadcast: '群發通知', 'retention.cleanup': '資料保存期限清理', 'event.invite_denied': '邀請連結無效', 'privacy.share_logs': '訓練紀錄分享設定', 'settings.shortcut': '修改捷徑連結',
  'backup.daily': '每日備份', 'backup.manual': '手動備份', 'calendar.add': '加入行事曆', 'calendar.delete': '刪除行事曆項目', 'event.arrived': '通知到貨',
  'event.notice': '發布活動異動', 'event.reconcile': '對帳', 'holiday.import': '匯入國定假日', 'member.verify': '驗證會籍卡', 'notif.prefs': '修改推播設定',
  'push.subscribe': '開啟推播', 'push.unsubscribe': '關閉推播', 'push.truncated': '推播分批送出', 'role.handover': '移交理事長', 'route.delete': '刪除路線',
  'spot.add': '新增地點', 'spot.propose': '提議地點', 'spot.approve': '核准地點', 'spot.update': '修改地點', 'spot.delete': '刪除地點', 'spot.report_delete': '刪除現場回報',
  'settings.cams': '附近即時影像來源開關', 'settings.cams_sync': '同步攝影機清單', 'cam.link.add': '新增直播連結', 'cam.link.delete': '刪除直播連結',
};
// 稽核紀錄：一定要選時間區間（預設最近 7 天），再依類型、操作者、對象縮小；一次 50 筆
const AUDIT_GROUPS = { '': '所有類型', role: '身分變更', membership: '會籍', team: '分團', event: '活動', checkin: '報到', lottery: '抽獎',
  settings: '系統設定', signup: '報名審核', privacy: '個資', login: '登入', passkey: '通行金鑰', mfa: '兩步驟驗證', account: '帳號', 'join.denied': '邀請碼錯誤', bootstrap: '初始設定', plan: '課表' };
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
// 稽核細節：JSON 轉成「開：A、B；關：C」，ISO 時間轉成「10/5 22:25」
function auditDetail(d) {
  // 結尾的 ｜team=…｜role=… 是給還原工具看的代碼（tools/restore-sql.mjs），畫面上不顯示
  let t = String(d).replace(/(｜(team|role)=[\w-]+)+$/, '');
  if (/^\{.*\}$/.test(t)) {
    try {
      const o = JSON.parse(t), on = [], off = [], rest = [];
      for (const [k, v] of Object.entries(o)) (v === true ? on : v === false ? off : rest).push(v === true || v === false ? k : `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      t = [on.length && `開：${on.join('、')}`, off.length && `關：${off.join('、')}`, ...rest].filter(Boolean).join('；');
    } catch {}
  }
  return t.replace(/\b20\d\d-(\d\d)-(\d\d)T(\d\d:\d\d)(?::\d\d(?:\.\d+)?Z?)?/g, (_, m, dd, hm) => `${Number(m)}/${Number(dd)} ${hm}`);
}
function bindAudit() {
  const f = $('#auf'), list = $('#auList');
  let next = null, params = null;
  const row = (x) => `<div class="arow">
      <span class="num tiny">${esc(x.at.slice(5, 16))}</span>
      <span><b>${esc(AUDIT_NAME[x.action] || '其他操作')}</b>
        <span class="tiny" style="display:block">${x.actor_name ? `<span translate="no">${esc(x.actor_name)}</span>` : '未登入'}${x.actor_role ? `（${esc(ROLE_NAME[x.actor_role] || x.actor_role)}）` : ''}${x.detail ? `・${esc(auditDetail(x.detail))}` : ''}</span></span>
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
      const r = await apiAll('/audit/verify', {}, ['checked', 'unsigned', 'modified']);   // 紀錄多時伺服器分段檢查
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
    ${needLead.map((tid) => `<p class="notice" style="margin:0"><span translate="no">${esc(byTeam(tid)?.name || tid)}</span>還沒有團長，申請只能由該團幹部核准。請先到<a href="#/t/${esc(tid)}">分團頁</a>指派團長。</p>`).join('')}
    ${pending.length ? `<div class="roster">${pending.map((r) => `<div class="r">${avatar(r)}
      <span><b><span translate="no">${esc(r.name)}</span></b>${r.nickname ? ` <span class="tiny"><span translate="no">${esc(r.nickname)}</span></span>` : ''}
        <span class="tiny" style="display:block">申請加入 <span translate="no">${esc(r.team_name)}</span>・${r.dist === 'hm' ? '半馬' : '全馬'} ${esc(r.grp)} 組・${ago(r.created_at)}${r.main_team ? '' : '・還沒有主團，核准後就是主團'}</span></span>
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
        <span><b><span translate="no">${esc(t.name)}</span></b><span class="tiny" style="display:block">${t.count} 人${t.private ? '・私密' : ''}${t.line_url ? '・已設 LINE 群組' : ''}</span></span><i class="chev" aria-hidden="true"></i></a>`).join('')}</div>
    </section>
    ${allow('settings') ? `<section class="card"><h3>新增分團</h3>
      <form id="newTeam">
        <div class="grid2"><label>名稱<input name="name" maxlength="20" required placeholder="例如 耕跑週末團"></label><label>顏色<input type="color" name="color" value="#1C4698"></label></div>
        <button class="btn">新增</button>
      </form></section>` : ''}
    <section class="card"><h3>分團權限</h3>
      <div class="permtable" tabindex="0" role="region" aria-label="分團權限對照">
        <div class="hd"><span>分團身分</span><span>建立活動</span><span>報到</span><span>抽獎</span><span>座位圖</span><span>看名冊</span><span>審核入團</span><span>指派幹部</span></div>
        ${[['lead', '團長'], ['officer', '幹部'], ['member', '團員']].map(([k, v]) => `<div class="rw"><span>${v}</span>${['event', 'checkin', 'lottery', 'layout', 'roster', 'approve', 'appoint'].map((p) => `<span>${TEAM_PERMS[k]?.includes(p) ? `<i class="yes" role="img" aria-label="有">${IC.check}</i>` : '<i class="no" role="img" aria-label="無"></i>'}</span>`).join('')}</div>`).join('')}
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
const FEATURE_NAME = { gps: '跑步記錄（計時＋GPS）', studio: '拍照分享', health: 'Apple 健康匯入', file: 'GPX／TCX 檔匯入', coach: '課表教練（全季、賽事準備、配速與用語）',
  plan_cycle: '個人課表週期（跟自己的比賽排 20 週）', plan_export: '分享與匯出課表（複製、PDF、行事曆）', party: '餐敘活動（春酒、慶功宴、尾牙）', cams: '附近即時影像（政府公開攝影機）',
  rest: '跑者休息站（飲水、廁所、淋浴置物、補給）' };
// 功能開關的說明：關掉會影響什麼（課表教練與教練身分容易搞混，寫清楚）
const FEATURE_HELP = { coach: '關閉後所有人都看不到這些頁面；不影響每週課表與訓練紀錄',
  plan_cycle: '關閉後所有人都照協會賽季排課；已選的週期會保留，打開後恢復',
  plan_export: '教練已同意分享，預設開啟；關閉後所有人都看不到分享按鈕' };
// 預設關閉的功能（要明確打開才有）
const FEATURE_OFF = new Set(['cams', 'rest']);
function settingsPanel() {
  const o = org(), f = cfg.settings?.features || {}, docs = cfg.settings?.docs || [], pv = cfg.settings?.privacy || {};
  const sd = { ...SIGNUP_DEFAULTS, ...(cfg.settings?.signup || {}) };
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
      <label>週四團練地點（課表的週四備註會顯示）<input name="thu_venue" maxlength="20" value="${esc(o.thu_venue || '')}" placeholder="例如：大佳河濱公園"></label>
      <label>個資保存期限（寫進隱私權政策的文字）<input name="retention" maxlength="200" value="${esc(o.retention || '')}"></label>
      <fieldset class="group"><legend>自動清理（每天 03:00 執行）</legend>
        <div class="grid3">
          <label>活動報名資料保存<select name="event_data_years">${[0, 1, 2, 3, 5].map((y) => `<option value="${y}" ${Number(o.event_data_years || 0) === y ? 'selected' : ''}>${y ? `${y} 年` : '不自動刪除'}</option>`).join('')}</select></label>
          <label>訓練紀錄保存<select name="log_years">${[0, 1, 2, 3, 5].map((y) => `<option value="${y}" ${Number(o.log_years || 0) === y ? 'selected' : ''}>${y ? `${y} 年` : '不自動刪除'}</option>`).join('')}</select></label>
          <label>稽核紀錄保存<select name="audit_years">${[1, 2, 3, 5, 7].map((y) => `<option value="${y}" ${Number(o.audit_years || 3) === y ? 'selected' : ''}>${y} 年</option>`).join('')}</select></label>
        </div>
        <p class="tiny" style="margin:0">活動超過保存年限後，報名、入場券與受邀名單會刪除，中獎紀錄只留獎項不留姓名。過期的登入工作階段、180 天前的通知每天都會清掉。</p>
      </fieldset>
      <button class="btn">儲存協會資訊</button>
    </form>
  </section>
  <section class="card">
    <div class="row spread"><h3>協會文件</h3><button class="btn ghost sm" id="addDoc">${IC.plus}新增</button></div>
    <p class="tiny" style="margin:0">章程、組織說明、會費說明等，跑友在「我的 → 協會」看得到。連結要是 https:// 開頭。</p>
    <div id="docRows" class="docedit">${docs.map(docRow).join('')}</div>
    <button class="btn" id="saveDocs" ${docs.length ? '' : 'hidden'}>儲存文件清單</button>
  </section>
  <h3 class="sgt">功能與畫面</h3>
  <section class="card">
    <h3>功能開關</h3>
    <form id="featForm" class="toggles">
      ${Object.entries(FEATURE_NAME).map(([k, v]) => `<label class="switch"><span>${v}${FEATURE_HELP[k] ? `<span class="tiny" style="display:block">${FEATURE_HELP[k]}</span>` : ''}</span><input type="checkbox" name="${k}" ${(FEATURE_OFF.has(k) ? f[k] === true : f[k] !== false) ? 'checked' : ''}><i></i></label>`).join('')}
      <button class="btn">儲存功能開關</button>
    </form>
    <p class="tiny" style="margin:0">關掉後，跑友的畫面上就看不到這個功能；已存的資料不會刪除。</p>
  </section>
  <section class="card"><h3>活動報名預設</h3>
    <form id="signupDefForm" class="toggles">
      <label class="switch"><span>新活動預設需要審核<span class="tiny" style="display:block">報名後由主辦幹部核准；問卷不適用</span></span><input type="checkbox" name="approval" ${sd.approval ? 'checked' : ''}><i></i></label>
      <label class="switch"><span>新活動預設通知報名者<span class="tiny" style="display:block">報名成功、排入候補、確認收款時推播給本人</span></span><input type="checkbox" name="notify" ${sd.notify ? 'checked' : ''}><i></i></label>
      <div class="grid2 selwide">
        <label>報名開始<select name="open_days"><option value="">建立後立即開放</option>${[1, 2, 3, 5, 7, 10, 14, 21, 30].map((n) => `<option value="${n}" ${sd.open_days === n ? 'selected' : ''}>活動前 ${n} 天</option>`).join('')}</select></label>
        <label>開始時間<input type="time" name="open_time" value="${esc(sd.open_time || '20:00')}"></label>
        <label>報名截止<select name="close_days"><option value="">活動開始時（集合時間）</option><option value="0" ${sd.close_days === 0 ? 'selected' : ''}>活動當天</option>${[1, 2, 3, 5, 7, 14].map((n) => `<option value="${n}" ${sd.close_days === n ? 'selected' : ''}>活動前 ${n} 天</option>`).join('')}</select></label>
        <label>截止時間<input type="time" name="close_time" value="${esc(sd.close_time || '22:00')}"></label>
      </div>
      <p class="tiny" id="sdPreview" aria-live="polite" style="margin:0"></p>
      <button class="btn">儲存報名預設</button>
    </form>
    <p class="tiny" style="margin:0">只影響之後新增的活動；已建立的活動不會改，幹部建立時也可以逐場調整。</p>
  </section>
  <section class="card" id="camSrcCard">
    <h3>附近即時影像</h3>
    <p class="tiny" style="margin:0">地點卡會列出 1.5 公里內的政府公開攝影機（沒有就列 3 公里內最近一支），畫面由本站轉送、不保存，跑友的 IP 不會送到影像來源。功能開關打開後，水利署與水利處的鏡頭清單每天清晨 04:00 起自動同步（每小時只同步一個來源）；公路局的清單由電腦上的同步工具更新。關掉來源後立即不再顯示，也不再連線。</p>
    <div id="camSrcList" class="toggles"><p class="tiny" style="margin:0">載入中…</p></div>
  </section>
  <section class="card" id="restSrcCard">
    <h3>休息站資料來源</h3>
    <p class="tiny" style="margin:0">練跑地圖的「休息站」圖層與地點卡的「附近休息站」：政府開放資料加上幹部整理的清單，每筆都標出處與授權。小的來源由排程在清晨自動同步；檔案大或很多檔的來源（Workers 免費方案每次執行只有 10 ms CPU，跑不完）由維護工具在電腦上同步，這裡只顯示上次同步的時間。關掉來源後立即不再顯示，也不再連線。</p>
    <div id="restSrcList" class="toggles"><p class="tiny" style="margin:0">載入中…</p></div>
  </section>
  <section class="card">
    <h3>分頁列名稱</h3>
    <form id="tabsForm" class="grid3">${Object.entries(TAB_DEFAULT).map(([k, v]) => `<label>${v}<input name="${k}" maxlength="4" placeholder="${v}" value="${esc(cfg.settings?.tabs?.[k] || '')}"></label>`).join('')}
      <button class="btn" style="grid-column:1/-1">儲存名稱</button></form>
    <p class="tiny" style="margin:0">名稱會顯示在下方分頁列與 iPad／電腦的側邊欄，每個最多 4 個字，留空就用預設。「拍照」只有在關閉 GPS 跑步時才會出現在分頁列。</p>
  </section>
  <section class="card">
    <h3>倒數與捷徑</h3>
    <form id="clubRace2" class="grid2">
      <label>協會預設賽事<input name="name" maxlength="30" value="${esc(cfg.race && !cfg.race.mine ? cfg.race.name : '')}"></label>
      <label>日期<input type="date" name="date" value="${esc(cfg.race && !cfg.race.mine ? cfg.race.date : '')}"></label>
      <button class="btn" style="grid-column:1/-1">儲存預設倒數</button>
    </form>
    <details id="presetBox"><summary class="setsum">常用賽事清單<span class="tiny">團員點右上角倒數就能直接挑</span></summary>
      <div id="presetRows" class="docedit" style="margin-top:8px"></div>
      <div class="row" style="gap:8px"><button type="button" class="btn ghost sm" id="presetAdd">${IC.plus}新增一場</button><button type="button" class="btn sm" id="presetSave">儲存清單</button></div>
    </details>
    <form id="scForm2" class="row" style="gap:8px">
      <input name="url" placeholder="Apple 健康捷徑 iCloud 連結" aria-label="Apple 健康捷徑 iCloud 連結" value="${esc(cfg.shortcut || '')}" style="flex:1;min-width:200px">
      <button class="btn ghost sm">儲存捷徑</button>
    </form>
  </section>
  <section class="card" id="holCard">
    <h3>國定假日</h3>
    <p class="tiny" style="margin:0">從新北市政府資料開放平台「政府行政機關辦公日曆表」匯入，行事曆會標出放假與補班，定期揪跑可以選擇遇到國定假日不開。每年公告後（通常前一年 6 月）手動匯入一次。</p>
    <div id="holYears" class="lstats"><span class="tiny">載入中…</span></div>
    <div class="row" style="gap:8px">${[new Date().getFullYear(), new Date().getFullYear() + 1].map((y) => `<button type="button" class="btn ghost sm" data-holy="${y}">匯入 ${y} 年</button>`).join('')}</div>
    <div id="holOut"></div>
  </section>
  <h3 class="sgt">安全與隱私</h3>
  <section class="card" id="bkCard"><div class="row spread"><h3>每日加密備份</h3><button type="button" class="btn ghost sm" id="bkNow">立即備份</button></div>
    <p class="tiny" style="margin:0">每天凌晨 3 點起自動把資料庫加密備份（AES-GCM），保留 35 天；資料多時分成好幾段，在接下來的整點陸續做完。還原用 tools/restore-backup.mjs，金鑰另外保存在理事長的電腦與密碼管理器。</p>
    <div id="bkList" class="roster"><p class="tiny" style="margin:0">載入中…</p></div></section>
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
      <div class="sheetacts"><a class="btn ghost" href="#/privacy">預覽</a><button class="btn">儲存並升版</button></div>
    </form>
  </section>`;
}
const docRow = (d = {}) => `<div class="drow">
  <input data-k="title" placeholder="文件名稱" maxlength="40" value="${esc(d.title || '')}">
  <input data-k="url" type="url" placeholder="https://" value="${esc(d.url || '')}">
  <input data-k="note" placeholder="說明（選填）" maxlength="80" value="${esc(d.note || '')}">
  <button type="button" class="iconx rm" data-rmdoc aria-label="移除">${IC.minus}</button></div>`;
function bindSettings() {
  const loadBk = async () => {
    const r = await api('/backups').catch(() => null);
    if (!$('#bkList')) return;
    // 備份卡住（進行中的超過 24 小時，或最新的超過 36 小時）：舊備份 36 天後會過期，要馬上處理
    const stale = r?.stale ? `<p class="notice err" role="alert" style="margin:0">${r.stale.pending ? `${esc(r.stale.pending)} 的備份開始超過 24 小時還沒做完` : `最新的每日備份是 ${esc(r.stale.newest)}，已經超過 36 小時`}。請檢查資料量是否暴增（例如大量路線），必要時改用 D1 Time Travel 並聯絡維護人員。</p>` : '';
    $('#bkList').innerHTML = stale + (!r ? '<p class="tiny" style="margin:0">沒有權限</p>' : !r.enabled ? '<p class="tiny" style="margin:0">備份還沒設定</p>'
      : r.list.length ? r.list.slice(0, 7).map((b) => `<div class="r"><span class="av num" style="font-size:10px">${esc(String(b.key).slice(11, 16).replace('-', '/'))}</span><span><b>${esc(String(b.key).replace('daily/', '').replace('.bin', ''))}</b><span class="tiny" style="display:block">${b.tables || '—'} 張表・${b.rows || '—'} 筆・${Math.round((Number(b.bytes) || b.size || 0) / 1024)} KB・存在 ${esc(r.where || '')}</span></span></div>`).join('')
      : '<p class="tiny" style="margin:0">還沒有備份，今晚 3 點會自動執行第一次。</p>');
  };
  loadBk();
  $('#bkNow')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await api('/backups', { method: 'POST', body: {} }); toast(r.started ? '資料較多，備份會在接下來的整點分段做完' : `已備份 ${r.tables} 張表、${r.rows} 筆`); loadBk(); } catch (err) { toast(err.message); }
    e.target.disabled = false;
  });
  const loadHol = async () => {
    const { years } = await api('/holidays').catch(() => ({ years: [] }));
    if ($('#holYears')) $('#holYears').innerHTML = years.length ? years.map((y) => `<span>${y.year} 年 <b class="num">${y.named}</b> 個節日</span>`).join('') : '<span class="tiny">還沒有匯入任何一年</span>';
  };
  loadHol();
  for (const b of document.querySelectorAll('[data-holy]')) b.onclick = async () => {
    b.disabled = true; const t = b.textContent; b.textContent = '匯入中…';
    try {
      const r = await api('/holidays/import', { method: 'POST', body: { year: Number(b.dataset.holy) } });
      $('#holOut').innerHTML = `<p class="notice" style="margin:0">已匯入 ${r.year} 年：${r.total} 天（含週末），節日 ${r.holidays.length} 天、補班 ${r.workdays} 天。</p>
        <div class="chips" style="margin-top:8px">${r.holidays.filter((h, i, a) => a.findIndex((x) => x.name === h.name) === i).map((h) => `<span class="pill">${esc(h.date.slice(5).replace('-', '/'))} <span translate="no">${esc(h.name)}</span></span>`).join('')}</div>`;
      toast(`已匯入 ${r.year} 年假日`); loadHol();
    } catch (err) { toast(err.message); }
    b.disabled = false; b.textContent = t;
  };
  // 附近即時影像：來源開關、上次同步、鏡頭數；臺北市水利處要先確認取得書面同意
  const camTime = (t) => { if (!t) return ''; const d = new Date(`${t.replace(' ', 'T')}Z`); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  // refocus：重畫後把焦點放回剛才操作的開關或按鈕
  const loadCamSrc = async (refocus) => {
    const r = await api('/cams/sources').catch(() => null);
    const box = $('#camSrcList');
    if (!box) return;
    if (!r) { box.innerHTML = '<p class="tiny" style="margin:0">讀不到來源狀態</p>'; return; }
    box.innerHTML = (r.feature ? '' : '<p class="notice" style="margin:0 0 6px">功能開關的「附近即時影像」目前關閉：跑友看不到，排程也不會同步。可以先設定來源、按「立即同步」測試。</p>') + r.sources.map((x) => `<div class="camsrc">
      <label class="switch"><span>${esc(x.name)}<span class="tiny" style="display:block">${x.manual ? `幹部在地點卡新增的官方直播外連，目前 ${x.active} 個`
        : `${x.last_ok_at ? `上次同步 ${camTime(x.last_ok_at)}・${x.active} 支鏡頭${x.down ? `（${x.down} 支暫時抓不到）` : ''}` : '還沒有同步過'}${x.last_error ? `・最近一次失敗（${camTime(x.last_sync_at)}）：${esc(x.last_error)}` : ''}`}</span>
        <span class="tiny" style="display:block">${esc(x.attribution)}</span></span>
        <input type="checkbox" data-camsrc="${esc(x.source)}" ${x.enabled ? 'checked' : ''} ${r.editable ? '' : 'disabled'}><i></i></label>
      ${x.consent ? '<p class="tiny" style="margin:0 0 6px">這個來源沒有開放授權聲明，要先取得臺北市水利處的書面同意才能開啟；關閉時不會對水利處發出任何連線。</p>' : ''}
      ${x.offline ? `<p class="tiny" style="margin:0 0 8px">清單由電腦上的同步工具更新（tools/cams-sync.mjs）${x.last_ok_at ? `・上次更新 ${camTime(x.last_ok_at)}` : ''}</p>`
        : !x.manual && x.enabled && r.editable ? `<button type="button" class="btn ghost sm" data-camsync="${esc(x.source)}" style="margin:0 0 8px">立即同步</button>` : ''}</div>`).join('');
    for (const c of box.querySelectorAll('[data-camsrc]')) c.onchange = async () => {
      const x = r.sources.find((s) => s.source === c.dataset.camsrc);
      if (c.checked && x.consent && !confirm(`開啟「${x.name}」前，請確認協會已經取得對方的書面同意。確定已取得嗎？`)) { c.checked = false; return; }
      try { await api('/cams/sources', { method: 'POST', body: { source: x.source, enabled: c.checked, consent: c.checked && x.consent } }); toast(c.checked ? `已開啟${x.name}` : `已關閉${x.name}`); loadCamSrc(`[data-camsrc="${x.source}"]`); }
      catch (err) { c.checked = !c.checked; toast(err.message); }
    };
    for (const b of box.querySelectorAll('[data-camsync]')) b.onclick = async () => {
      b.disabled = true; b.textContent = '同步中…';
      try { const s = await api('/cams/sync', { method: 'POST', body: { source: b.dataset.camsync } }); toast(`已同步 ${s.count} 支鏡頭`); } catch (err) { toast(err.message); }
      loadCamSrc(`[data-camsync="${b.dataset.camsync}"]`);
    };
    if (refocus) (box.querySelector(refocus) || box.querySelector('[data-camsrc]'))?.focus();
  };
  loadCamSrc();
  // 跑者休息站：來源開關、上次同步、筆數、資料日期、錯誤；小來源可以立即同步，大的由維護工具同步（tools/rest-sync.mjs，沒有按鈕）
  const EVERY = { day: 1, week: 7, month: 31 };
  const loadRestSrc = async (refocus) => {
    const r = await api('/rest/sources').catch(() => null);
    const box = $('#restSrcList');
    if (!box) return;
    if (!r) { box.innerHTML = '<p class="tiny" style="margin:0">讀不到來源狀態</p>'; return; }
    const stale = (x) => x.local && x.enabled && x.last_ok_at && (Date.now() - Date.parse(`${x.last_ok_at.replace(' ', 'T')}Z`) > 2 * (EVERY[x.every] || 31) * 864e5);
    box.innerHTML = (r.feature ? '' : '<p class="notice" style="margin:0 0 6px">功能開關的「跑者休息站」目前關閉：跑友看不到，排程也不會同步。可以先設定來源、同步資料。</p>') + r.sources.map((x) => `<div class="camsrc">
      <label class="switch"><span>${esc(x.source_name)}<span class="tiny" style="display:block">${x.manual ? `${x.source === 'cur' ? '幹部整理的跑站與寄物點' : '幹部在地圖上新增'}，目前 ${x.active} 處${x.hidden ? `（隱藏 ${x.hidden} 處）` : ''}`
        : `${x.last_ok_at ? `上次同步 ${camTime(x.last_ok_at)}・${x.active} 處${x.hidden ? `（隱藏 ${x.hidden} 處）` : ''}${x.data_date ? `・資料日期 ${esc(x.data_date)}` : ''}` : '還沒有同步過'}${x.page ? `・同步到第 ${x.page} 頁` : ''}${x.last_error ? `・最近一次失敗（${camTime(x.last_sync_at)}）：${esc(x.last_error)}` : ''}`}</span>
        <span class="tiny" style="display:block">${esc(x.attribution)}</span></span>
        <input type="checkbox" data-restsrc="${esc(x.source)}" ${x.enabled ? 'checked' : ''} ${r.editable ? '' : 'disabled'}><i></i></label>
      ${!x.manual ? `<div class="row restsrcrow">${x.dataset ? `<a class="btn ghost sm" href="${esc(x.dataset)}" target="_blank" rel="noopener noreferrer">資料集 ${IC.external}</a>` : ''}
        ${x.local ? `<span class="tiny">由維護工具同步・${x.last_ok_at ? `上次同步 ${camTime(x.last_ok_at)}` : '還沒有同步過'}${stale(x) ? '・<span class="ostat off">已經很久沒有同步</span>' : ''}</span>`
          : x.enabled && r.editable ? `<button type="button" class="btn ghost sm" data-restsync="${esc(x.source)}">立即同步</button>` : ''}</div>` : ''}</div>`).join('');
    for (const c of box.querySelectorAll('[data-restsrc]')) c.onchange = async () => {
      const x = r.sources.find((s) => s.source === c.dataset.restsrc);
      try { await api('/rest/sources', { method: 'POST', body: { source: x.source, enabled: c.checked } }); toast(c.checked ? `已開啟${x.source_name}` : `已關閉${x.source_name}`); loadRestSrc(`[data-restsrc="${x.source}"]`); }
      catch (err) { c.checked = !c.checked; toast(err.message); }
    };
    for (const b of box.querySelectorAll('[data-restsync]')) b.onclick = async () => {
      b.disabled = true; b.textContent = '同步中…';
      try { const s = await api('/rest/sync', { method: 'POST', body: { source: b.dataset.restsync } }); toast(s.same ? '資料沒有變動' : `已同步 ${s.count} 處`); } catch (err) { toast(err.message); }
      loadRestSrc(`[data-restsync="${b.dataset.restsync}"]`);
    };
    if (refocus) (box.querySelector(refocus) || box.querySelector('[data-restsrc]'))?.focus();
  };
  loadRestSrc();
  const reload = async (msg) => { await refreshMe(); toast(msg); applyFeatures(); paintCountdown(); adminView('settings'); };
  const save = async (key, body, msg) => { try { await api(`/settings/${key}`, { method: 'POST', body }); await reload(msg); } catch (e) { toast(e.message); } };
  $('#orgForm').onsubmit = (e) => { e.preventDefault(); const f = e.target;
    save('org', { name: f.name.value, short: f.short.value, join_form: f.join_form.value.trim(), contact: f.contact.value, retention: f.retention.value, thu_venue: f.thu_venue.value.trim(),
      parent: f.parent.value, parent_url: f.parent_url.value.trim(), parent_note: f.parent_note.value,
      event_data_years: Number(f.event_data_years.value), log_years: Number(f.log_years.value), audit_years: Number(f.audit_years.value) }, '已儲存協會資訊'); };
  $('#mfaToggle')?.addEventListener('change', async (e) => {
    try { await api('/settings/security', { method: 'POST', body: { require_mfa: e.target.checked } }); await reload(e.target.checked ? '已開啟幹部兩步驟驗證' : '已關閉幹部兩步驟驗證'); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
  });
  $('#tabsForm').onsubmit = (e) => { e.preventDefault(); const f = e.target;
    save('tabs', Object.fromEntries(Object.keys(TAB_DEFAULT).map((k) => [k, f[k].value.trim()])), '已儲存分頁列名稱'); };
  // 活動報名預設：即時預覽「下個週六 07:00 的團練」會怎麼算
  const sdf = $('#signupDefForm');
  if (sdf) {
    const readSd = () => ({ approval: sdf.approval.checked, notify: sdf.notify.checked, open_days: sdf.open_days.value === '' ? null : Number(sdf.open_days.value), open_time: sdf.open_time.value || '20:00',
      close_days: sdf.close_days.value === '' ? null : Number(sdf.close_days.value), close_time: sdf.close_time.value || '22:00' });
    const preview = () => {
      const v = readSd(), now = nowTp(), wd = new Date(`${now.slice(0, 10)}T00:00:00Z`).getUTCDay();
      const sat = new Date(Date.parse(`${now.slice(0, 10)}T00:00:00Z`) + ((6 - wd + 7) % 7 || 7) * 864e5).toISOString().slice(0, 10);
      // 預覽規則本身：拿範例活動 40 天前當「現在」，不會因為今天已經過了那個時間就顯示成立即開放（例如週六晚上設「活動前 7 天」）
      const ev = { date: sat, gather_time: '07:00', kind: 'track' }, w = defaultWindow(ev, v, new Date(Date.parse(`${sat}T00:00:00Z`) - 40 * 864e5).toISOString().slice(0, 16));
      sdf.open_time.disabled = v.open_days == null; sdf.close_time.disabled = v.close_days == null;
      $('#sdPreview').textContent = `例：${tpText(`${sat}T07:00`)} 的團練 → ${w.start ? `${tpText(w.start)} 開放` : '建立後立即開放'}、${w.end ? `${tpText(w.end)} 截止` : '集合時截止'}${v.approval ? '，需要審核' : ''}`;
    };
    sdf.addEventListener('input', preview); sdf.addEventListener('change', preview); preview();
    sdf.onsubmit = (e) => { e.preventDefault(); save('signup', readSd(), '已儲存活動報名預設'); };
  }
  $('#featForm').onsubmit = (e) => { e.preventDefault(); const f = e.target, body = {};
    for (const k of Object.keys(FEATURE_NAME)) body[k] = f[k].checked;
    save('features', body, '已儲存功能開關'); };
  const bindRm = () => { for (const b of document.querySelectorAll('[data-rmdoc]')) b.onclick = () => { b.closest('.drow').remove(); $('#saveDocs').hidden = false; }; };
  bindRm();
  $('#addDoc').onclick = () => { $('#docRows').insertAdjacentHTML('beforeend', docRow()); $('#saveDocs').hidden = false; bindRm(); };
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
    <button type="button" class="iconx rm" data-rmpre aria-label="移除">${IC.minus}</button></div>`;
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
      <span><span translate="no">${esc(m.name)}</span>${m.title ? ` <span class="tiny"><span translate="no">${esc(m.title)}</span></span>` : ''}
        <span class="tiny" style="display:block">${esc(m.roleName)}・${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)} 組</span></span>
      ${allow('roles') ? `<button class="btn ghost sm" data-role="${m.id}" data-name="${esc(m.name)}" data-cur="${m.role}">變更</button>` : ''}
    </div>`;
  bindMemberSearch($('#rf2'), $('#rlist'), row, () => {
    for (const b of document.querySelectorAll('[data-role]')) b.onclick = () => roleDialog(b.dataset.role, b.dataset.name, b.dataset.cur);
  })({ role: 'officers' });
}
function roleDialog(id, name, cur) {
  const opts = Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
  const opener = document.activeElement;
  const s = openSheet('變更身分', `<h3 id="rdT">變更 <span translate="no">${esc(name)}</span> 的身分</h3>
    <form id="rf">
      <label>身分<select name="role">${opts}</select></label>
      <label>職稱（選填）<input name="title" maxlength="12" placeholder="例如 副理事長、活動組長"></label>
      <div class="sheetacts"><button type="button" class="btn ghost" data-close>取消</button><button class="btn">儲存</button></div>
    </form>`, opener, 'rdT');
  s.host.querySelector('#rf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/members/${id}/role`, { method: 'POST', body: { role: e.target.role.value, title: e.target.title.value } }); s.close(); toast(`已更新 ${name} 的身分，對方要重新登入`); adminView('roles'); }
    catch (err) { toast(err.message); }
  };
}

export { adminView, rosterView };
