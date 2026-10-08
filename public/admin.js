// 耕跑團 PWA — admin.js：從 app.js 拆出來、用到才載入的畫面（第一次開 App 不用下載）
import * as Party from './party.js';
import { defaultWindow, SIGNUP_DEFAULTS, tpText } from './signup-window.js';
import { $, latest, nowTp, openSheet, scanSheet, ago, allow, api, apiAll, applyFeatures, avatar, barChart, bars, bindStepup, cfg, esc, group, IC, KIND_NAME, largeTitle, me, mfaBanner, nrow, org, pad2, paintCountdown, passkey, refreshMe, render, ROLE_NAME, row, studio, TAB_DEFAULT, TEAM_PERMS, teamAllow, teamIcon, teamOf, teams, toast, view, btnRow, MI, ic, emptyState, focusEl, once } from './app.js';
import { askReason, choose } from './app.js';
import * as AR from './achrule.js';
import { FM, HM } from './plan.js';

// ---------- 管理介面（RBAC、會籍、座位圖）----------
let adminSeq = 0;
const MEMBERSHIP_NAME = { none: '跑友', applied: '申請中', active: '協會會員', expired: '會籍到期' };
async function adminView(tab) {
  tab ||= new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'overview';
  if (me.mfaPending) { view.innerHTML = `${largeTitle('管理後台')}${mfaBanner()}`; bindStepup(); return; }
  if (!allow('members') && !allow('roles') && !allow('settings')) { view.innerHTML = '<div class="card"><p class="muted">沒有管理權限。</p></div>'; return; }
  const tabs = [['overview', '總覽'], ['members', '會員'], ['roles', '權限'], ['teams', '分團'], ['events', '活動'], ...(allow('settings') ? [['report', '週報'], ['settings', '設定']] : []), ...(allow('audit') ? [['audit', '稽核']] : [])];
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
    : tab === 'report' && allow('settings') ? '<div id="rptBox"><section class="card"><p class="tiny" style="margin:0">載入中…</p></section></div>'
    : await eventsPanel();
  if (my !== adminSeq || !panel.isConnected) return;
  panel.innerHTML = html;
  panel.style.minHeight = ''; panel.removeAttribute('aria-busy');
  if (tab === 'overview') bindOverview();
  if (tab === 'members') bindMembers();
  if (tab === 'roles') { bindRoleActs(panel); bindHandover(); }
  if (tab === 'teams') bindAdminTeams();
  if (tab === 'audit') bindAudit();
  if (tab === 'events') bindEventsPanel();
  if (tab === 'settings') bindSettings();
  if (tab === 'report' && allow('settings')) loadReport($('#rptBox'), { scope: 'assoc' });
}

// 總覽：只有統計數字，不列名單
async function overviewPanel() {
  const o = await api('/admin/overview');
  const months = []; for (let i = 11; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`); }
  const g = Object.fromEntries(o.growth.map((x) => [x.m, x.n]));
    // 沒有副標也留一行空白，同一列的數字才會對齊
  const k = (label, v, sub = '') => `<div class="card kpi"><span class="tiny">${label}</span><b class="num">${v ?? '—'}</b><span class="tiny">${sub || '&nbsp;'}</span></div>`;
  const bc = allow('settings') || (allow('members') && me.role !== 'supervisor');
  // 群發通知是「動作」：放在總覽最上面一列，點了直接跳到表單（不用捲到最下面）
  // 系統狀態卡：不用 role="alert"（每次回到總覽都會被大聲打斷），告警推播一天已經發過一次；用 status 禮貌地唸一次
  return `<section class="card opsalert" id="opsTop" role="status" hidden></section>
    ${allow('settings') ? '<section class="card" id="weeklyTop" hidden></section>' : ''}
    <section class="card" id="pendingTop" hidden></section>
    ${achApprover() && (featOn('achieve') || me.ach?.queue) ? group('', [row('#/admin/ach', achIc('medal'), '成績與挑戰', '審核成績、設定挑戰與團服', me.ach?.queue ? `<span class="pill wait num">${Number(me.ach.queue)}</span>` : '')]) : ''}
    ${bc ? group('', [btnRow('bcJump', MI.bell, '群發通知', '推播給全部或指定分團、身分')]) : ''}
    <section class="kpis">
      ${k('跑友人數', o.members, `本月新加入 ${o.newThisMonth}`)}${k('30 天內活躍', o.active30, o.members ? `${Math.round(o.active30 / o.members * 100)}%` : '')}
      ${k('協會會員數', o.association, `待審 ${o.applied}・將到期 ${o.expiring}`)}${k('團練出席率', o.attendance == null ? '—' : `${o.attendance}%`, '最近 30 天')}
      ${k('近 30 天活動', o.events30, `接下來 30 天 ${o.upcoming} 場`)}${k('近 30 天報名', o.signups30)}
      ${k('7 天訓練紀錄', o.logs7)}${k('已開推播', o.pushSubs == null ? null : `${o.pushSubs}<small> 人</small>`)}
    </section>
    ${allow('settings') || allow('audit') ? '<section class="card" id="healthBox"><h2 class="h3">開啟速度與錯誤</h2><p class="tiny" style="margin:0">載入中…</p></section>' : ''}
    <section class="card"><h2 class="h3">每月新加入</h2>${barChart(months.map((m) => ({ l: `${Number(m.slice(5))}月`, v: g[m] || 0 })), { unit: ' 人', h: 120 })}</section>
    <section class="card"><h2 class="h3">分團人數</h2>${bars(o.teamSizes.map((t) => [t.name, t.n]))}</section>
    ${bc ? `<section class="card" id="bcCard"><h2 class="h3" id="bcTitle" tabindex="-1">群發通知</h2>
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
  box.innerHTML = `<div class="row spread"><h2 class="h3">開啟速度與錯誤</h2><div class="seg" role="group" aria-label="期間">${[7, 30, 90].map((d) => `<button data-hd="${d}" aria-pressed="${h.days === d}">${d} 天</button>`).join('')}</div></div>
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
    ${budgetHtml(h)}
    ${opsHtml(h)}`;
  for (const b of box.querySelectorAll('[data-hd]')) b.onclick = () => loadHealth(Number(b.dataset.hd));
  // 總覽最上方：今天有發生中的告警就顯示一張卡（文字，不只靠顏色）
  const top = $('#opsTop'), on = (h.conditions || []).filter((c) => c.on);
  if (top) {
    top.hidden = !on.length;
    top.innerHTML = on.length ? `<div class="row spread" style="gap:10px"><span><b>系統狀態：${on.map((c) => esc(OPS_TEXT[c.cond] || c.cond)).join('；')}</b></span>
      <a class="btn ghost sm" href="#/admin?tab=overview" data-opsgo>查看</a></div>` : '';
    // 查看：焦點移到「系統告警」標題（跟群發通知的捷徑一樣），VoiceOver 與鍵盤從那裡接著讀
    top.querySelector('[data-opsgo]')?.addEventListener('click', (e) => { e.preventDefault(); $('#opsTitle')?.focus({ preventScroll: true }); $('#opsBox')?.scrollIntoView({ block: 'start' }); });
  }
}
// ---------- 系統告警與每日額度（估計）----------
const OPS_NAME = { backup: '每日備份', quota: '每日額度', stops: '排程工作停下', errors: '前端錯誤', push: '推播', cron: '排程工作失敗' };
const OPS_TEXT = { backup: '每日備份超過 26 小時沒有完成', quota: '今天的額度用量接近上限', stops: '有排程工作連續因額度停下', errors: '今天的前端錯誤比平常多很多',
  push: '推播送不出去的比例偏高', cron: '有排程工作連續失敗 3 次、已停止重試' };
const QUOTA_NAME = { req: 'Worker 請求', d1_read: 'D1 讀取', d1_write: 'D1 寫入', kv_read: 'KV 讀取', kv_write: 'KV 寫入', kv_list: 'KV 列出', kv_del: 'KV 刪除' };
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : String(n));
const hm = (at) => (at ? new Date(`${at.replace(' ', 'T')}Z`).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) : '');
// 告警細節裡的排程工作名稱（job_runs 與執行額度紀錄的內部名稱）換成中文
//   'hourly:events' → 活動提醒（每小時排程的前綴拿掉）、'month_summary 2036-05' → 每月總結 2036-05
const jobLabel = (x) => x.replace(/^hourly:/, '').split(/([: ])/).map((t) => JOB_NAME[t] || t).join('');
const opsDetail = (cond, d) => (cond === 'stops' || cond === 'cron' ? String(d).split('、').map(jobLabel).join('、') : String(d));
function opsHtml(h) {
  if (!h.conditions) return '';
  const u = h.usage || {};
  // 每日備份這一列連到備份子頁（立即備份、逾時提醒都在那裡）：備份告警推播點進總覽後一下就到
  const bk = allow('settings') ? '<a class="tiny" style="display:block" href="#/admin/settings/backup">每日加密備份設定 ›</a>' : '';
  return `<div id="opsBox"><h3 id="opsTitle" tabindex="-1">系統告警</h3>
    <div class="itemtable">${h.conditions.map((c) => `<div class="itr"><span><b style="font-weight:600">${OPS_NAME[c.cond] || esc(c.cond)}</b>
      ${c.on && c.detail ? `<span class="tiny" style="display:block;word-break:break-word">${esc(opsDetail(c.cond, c.detail))}</span>` : ''}${c.cond === 'backup' ? bk : ''}</span>
      <span class="tiny">${c.on ? `<b style="color:var(--race)">發生中${c.since ? `（今天 ${hm(c.since)} 起）` : ''}</b>` : '正常'}</span></div>`).join('')}</div>
    ${(h.alerts || []).length ? `<h4>最近 14 天的告警</h4><div class="itemtable">${h.alerts.map((a) => `<div class="itr"><span><b class="num" style="font-weight:600">${esc(a.day.slice(5).replace('-', '/'))}</b>
      <span class="tiny" style="display:block;word-break:break-word">${OPS_NAME[a.cond] || esc(a.cond)}${a.detail ? `・${esc(opsDetail(a.cond, a.detail))}` : ''}</span></span><span class="tiny">${hm(a.at)}</span></div>`).join('')}</div>`
      : '<p class="tiny" style="margin:0">最近 14 天沒有告警。</p>'}
    <p class="tiny" style="margin:0">同一個條件一天最多通知一次，理事長與行政人員不能關這類推播。</p>
    <h3>今天的額度用量（估計）</h3>
    ${u.quota ? `<div class="itemtable">${Object.keys(QUOTA_NAME).map((k) => `<div class="itr"><span>${QUOTA_NAME[k]}</span>
      <span class="num">${big(u.values?.[k] || 0)}／${big(u.quota[k])}（${u.pct[k]}%）${u.pct[k] >= 80 ? ' <b>接近上限</b>' : ''}</span></div>`).join('')}</div>`
      : '<p class="tiny" style="margin:0">付費方案：不檢查每日額度。</p>'}
    <p class="tiny" style="margin:0">UTC 日（台北 08:00 重置）。這是估計的下限：每台伺服器最多每 10 分鐘寫一次，電腦上的維護工具直接寫資料庫的不算。</p></div>`;
}

// ---------- 幹部週報（後台「週報」分頁與分團頁共用）----------
//   伺服器依身分剝掉看不到的區塊（例如行政人員沒有訓練完成率），這裡只照有的欄位畫；百分比與狀態一律用文字
const pctT = (x) => (x == null ? '—' : `${x}%`);
const prevT = (x) => (x == null ? '' : `（前一週 ${x}%）`);
function reportHtml(r, { scopes = [] } = {}) {
  const d = r.data || {}, p = r.prev || {};
  const sel = (id, label, opts, cur) => `<label class="row" style="gap:8px"><span class="tiny">${label}</span><select id="${id}" style="flex:1">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  // 卡片標題是 h2（外觀同 h3）：#/weekly 與週報分頁都是 h1 下面直接接卡片，不跳級
  const card = (title, lines) => `<section class="card"><h2 class="h3">${title}</h2>${lines.filter(Boolean).map((l) => `<p style="margin:0">${l}</p>`).join('')}</section>`;
  const kinds = Object.entries(d.events?.kinds || {}).map(([k, n]) => `${KIND_NAME[k] || k} ${n}`).join('、');
  const head = `<section class="card" style="display:grid;gap:8px">
      ${sel('rptWeek', '週次', (r.weeks || []).map((w) => [w, `${w.slice(5).replace('-', '/')} 那週`]), r.week)}
      ${scopes.length > 1 ? sel('rptScope', '對象', scopes, r.scope) : ''}
      <p class="tiny" style="margin:0">上週一到週日的聚合數字，不含任何人的名字與金額。</p></section>`;
  const out = [card('活動', [`${d.events?.n ?? 0} 場（取消 ${d.events?.cancelled ?? 0} 場）`, kinds ? `<span class="tiny">${esc(kinds)}</span>` : '']),
    card('報名', [`新增 ${d.signups?.new ?? 0}${p.signups != null ? `（前一週 ${p.signups}）` : ''}、取消 ${d.signups?.cancel ?? 0}`,
      `候補轉正 ${d.signups?.promoted ?? 0}<span class="tiny" style="display:block">以收到「候補遞補成功」通知的人數計，實際可能更多</span>`]),
    card('出席', [`出席率 ${pctT(d.attendance?.pct)}${prevT(p.attendance)}`, `<span class="tiny">報到 ${d.attendance?.came ?? 0}／正取 ${d.attendance?.in ?? 0}（不含餐敘與問卷）</span>`,
      d.party ? `餐敘報到率 ${pctT(d.party.pct)}（${d.party.in}／${d.party.n}）` : '']),
    card(d.scope === 'assoc' ? '新成員' : '新團員', [d.scope === 'assoc' ? `新跑友 ${d.newcomers?.runners ?? 0}、新協會會員 ${d.newcomers?.assoc ?? 0}` : `新團員 ${d.newcomers?.members ?? 0}`])];
  if ('training' in d) {
    const t = d.training;
    out.push(card('訓練完成率', t ? [`完成率 ${pctT(t.pct)}${prevT(p.training)}`, `<span class="tiny">完成 ${t.done}、部分 ${t.partial}、跳過 ${t.skip}・分享紀錄的 ${t.share} 人中 ${t.who} 人有記錄・共 ${t.km} 公里</span>`]
      : ['分享的人太少，不顯示', '<span class="tiny">只算同意分享訓練紀錄的人</span>']));
  }
  if (d.health) {
    const hh = d.health, top = Object.entries(hh.quota || {}).sort((a, b) => b[1] - a[1])[0];
    const al = Object.entries(hh.alerts || {});
    out.push(card('系統健康', [
      hh.backup ? `備份：${hh.backup.days >= 7 ? '7 天都完成' : `${hh.backup.days}／7 天完成`}${hh.backup.latest ? `・最新一份 ${esc(hh.backup.latest)}` : ''}${hh.backup.stalled ? `・卡住 ${hh.backup.stalled} 次` : ''}` : '備份：還沒設定',
      top ? `額度：最高單日 ${QUOTA_NAME[top[0]] || top[0]} ${top[1]}%${top[1] >= 80 ? ' <b>接近上限</b>' : ''}（估計）` : '',
      `執行額度：停下 ${hh.budget?.stopped ?? 0} 次、超過 ${hh.budget?.over ?? 0} 次${(hh.budget?.top || []).length ? `<span class="tiny" style="display:block">${esc(hh.budget.top.join('、'))}</span>` : ''}`,
      `前端錯誤率：${hh.errors?.rate == null ? '—' : `${hh.errors.rate}%`}${hh.errors?.prev != null ? `（前一週 ${hh.errors.prev}%）` : ''}`,
      `推播：送出 ${hh.push?.sent ?? 0}、失敗 ${hh.push?.err ?? 0}、失效 ${hh.push?.gone ?? 0}、丟棄 ${hh.push?.drop ?? 0}`,
      `告警：${al.length ? al.map(([c, n]) => `${OPS_NAME[c] || esc(c)} ${n} 天`).join('、') : '沒有'}`]));
  }
  return { head, body: out.join('') };
}
// 週報：選單（週次、對象）一張卡＋下面的內容（#rptBox 與 .rptbody 都是 grid，卡片之間有間距）
//   換週次或對象查不到週報（例如上週一之後才建立的分團）：只換下面的內容，選單留著可以換回來；換完焦點回到剛剛的選單
async function loadReport(box, { scope = '', week = '', focus = '' } = {}) {
  if (!box) return;
  const q = new URLSearchParams(); if (scope) q.set('scope', scope); if (week) q.set('week', week);
  let r;
  try { r = await api(`/ops/reports?${q}`); } catch (e) {
    if (!box.isConnected) return;
    const msg = `<section class="card"><p class="muted" style="margin:0">${esc(e.status === 404 ? '還沒有週報：每週一 09:00 產生上週的週報' : e.message)}</p></section>`;
    const body = box.querySelector('.rptbody');
    if (body) body.innerHTML = msg; else box.innerHTML = msg;
    return;
  }
  if (!box.isConnected) return;
  // 對象：理事長與行政人員是協會版與每個分團；團長是自己的分團
  const scopes = r.teams ? r.teams.map((t) => [`team:${t}`, teamOf(t)?.name || t]) : [['assoc', '協會'], ...teams().map((t) => [`team:${t.id}`, t.name])];
  const { head, body } = reportHtml(r, { scopes });
  box.innerHTML = `${head}<div class="rptbody">${body}</div>`;
  // 分團頁（#/weekly）的副標題跟著對象換
  const sub = $('#rptSub');
  if (sub) sub.textContent = r.scope === 'assoc' ? '協會' : (scopes.find(([v]) => v === r.scope)?.[1] || '');
  $('#rptWeek')?.addEventListener('change', (e) => loadReport(box, { scope: $('#rptScope')?.value || r.scope, week: e.target.value, focus: 'rptWeek' }));
  $('#rptScope')?.addEventListener('change', (e) => loadReport(box, { scope: e.target.value, focus: 'rptScope' }));
  if (focus) $(`#${focus}`)?.focus();
}
// 分團頁的「上週分團週報」（#/weekly?team=）：畫面和後台同一份程式
async function weeklyView() {
  const tid = new URLSearchParams(location.hash.split('?')[1] || '').get('team') || '';
  view.innerHTML = `${largeTitle('週報', `<span id="rptSub" translate="no">${tid ? esc(teamOf(tid)?.name || '') : ''}</span>`)}<div id="rptBox"><section class="card"><p class="tiny" style="margin:0">載入中…</p></section></div>`;
  await loadReport($('#rptBox'), { scope: /^[\w-]{1,16}$/.test(tid) ? `team:${tid}` : '' });
}
// 總覽最上方的「上週週報」小卡：三個數字（不寫查看稽核；完整週報才寫）
async function loadWeeklyTop() {
  const box = $('#weeklyTop'); if (!box) return;
  const r = await api('/ops/reports?scope=assoc&brief=1').catch(() => null);
  if (!r?.brief || !box.isConnected) return;
  const b = r.brief;
  box.innerHTML = `<div class="row spread"><h2 class="h3">上週週報</h2><a class="btn ghost sm" href="#/admin?tab=report">看完整週報</a></div>
    <p style="margin:0">報名 ${b.signups}、出席率 ${pctT(b.attendance)}、新成員 ${b.newcomers}</p><span class="tiny">${esc(r.week.slice(5).replace('-', '/'))} 那週</span>`;
  box.hidden = false;
}
// 執行額度（免費方案一次執行 50 個子請求）：排程工作的狀態、推播佇列、最常碰到上限的功能。狀態一律用文字
const JOB_NAME = { backup: '每日備份', retention: '資料清理', month_summary: '每月總結', quarterly_review: '每季權限檢視', fatigue: '疲勞提醒',
  signup_review_digest: '待審核整理', 'cams.wra': '鏡頭清單（水利署）', 'cams.heo': '鏡頭清單（水利處）', 'cams.thb': '鏡頭狀態重設（公路局）',
  backup_manual: '手動備份', events: '活動提醒', signupOpen: '開放報名通知', followups: '跑完接續', weather: '壞天氣提醒', signupReviews: '待審核失效',
  promoteSweep: '候補遞補', renewals: '會費到期提醒', auditDigest: '稽核摘要', monthSummary: '每月總結', review: '每季權限檢視', push: '推播佇列', cams: '鏡頭清單',
  opsAlerts: '系統告警', digest: '推播摘要', weeklyReport: '幹部週報', weekly_report: '幹部週報',
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
  loadWeeklyTop();
  loadPending($('#pendingTop'), { hideEmpty: true });
  const f = $('#bcForm'); if (!f) return;
  $('#bcJump')?.addEventListener('click', () => { $('#bcCard').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); f.title.focus({ preventScroll: true }); });
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
    ${refOn() ? group('', [row('#/admin/tree', TREE_IC, '推薦族譜', '誰推薦誰；團購或活動找不到人時用')]) : ''}
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
  const PERM_NAME = { event: '建立活動', plan: '發布課表', checkin: '報到', lottery: '抽獎', roster: '看名冊', members: '會員管理', roles: '指派身分', layout: '座位圖設定', achieve: '成績與挑戰' };
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
        ${allow('roles') ? roleActs(m) : ''}</div>`).join('')}</div>
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
// 權限分頁每位跑友的動作：「變更」身分；理事長（指派身分權限）另外有「安全」（重設通行金鑰並登出，自己的不顯示：自己的在「帳號與安全」）
//   按鈕裡的 .sr 讓 VoiceOver 讀出是誰的（畫面上同一列已經有名字）
const roleActs = (m) => `<span class="roleacts"><button class="btn ghost sm" data-role="${esc(m.id)}" data-name="${esc(m.name)}" data-cur="${esc(m.role)}">變更<span class="sr">：<span translate="no">${esc(m.name)}</span></span></button>${m.id === me.id ? ''
  : `<button class="btn ghost sm" data-sec="${esc(m.id)}" data-name="${esc(m.name)}">${IC.lock}安全<span class="sr">：<span translate="no">${esc(m.name)}</span></span></button>`}</span>`;
function bindRoleActs(box) {
  if (!box) return;
  for (const b of box.querySelectorAll('[data-role]')) b.onclick = () => roleDialog(b.dataset.role, b.dataset.name, b.dataset.cur);
  for (const b of box.querySelectorAll('[data-sec]')) b.onclick = () => securityDialog(b.dataset.sec, b.dataset.name);
}
// 重設通行金鑰並登出所有裝置（帳號被盜用、幹部第一把不是本人、幹部唯一一把的手機弄丟）：只有理事長
//   打開先讀數字（GET …/security：通行金鑰幾把、登入中的裝置幾個、有沒有綁 Google；不給裝置名稱、IP）；
//   送出要 15 分鐘內用通行金鑰驗證過（api() 會叫出 Face ID）；原因只放在給本人的通知，推播與稽核紀錄都不記
let secSeq = 0;
function securityDialog(id, name) {
  const opener = document.activeElement, my = ++secSeq;
  const s = openSheet('重設通行金鑰並登出', `<h3 id="secT">重設通行金鑰並登出</h3>
    <p style="margin:0"><b translate="no">${esc(name)}</b></p>
    <p class="tiny" id="secN" style="margin:0" aria-live="polite">讀取中…</p>
    <p class="muted" style="margin:0">會刪除這位跑友所有的通行金鑰、登出所有裝置與推播。之後本人重新登入（Google 或邀請碼），再新增通行金鑰。</p>
    <form id="secF" style="display:grid;gap:12px">
      <div id="secG" style="display:grid;gap:4px">
        <label class="inline"><input type="checkbox" name="unlink" aria-describedby="secW"> 同時解除 Google 綁定（Google 帳號被盜用時才勾）</label>
        <p class="tiny" id="secW" style="margin:0">解除後本人不能再用 Google 登入這個帳號，要用邀請碼或請理事長協助。</p>
      </div>
      <label>原因（選填）<textarea name="reason" maxlength="100" rows="2" aria-describedby="secR"></textarea></label>
      <p class="tiny" id="secR" style="margin:0">原因只有本人看得到，推播與稽核紀錄都不會記</p>
      <div class="sheetacts"><button type="button" class="btn ghost" data-close>取消</button><button class="btn danger">重設並登出</button></div>
    </form>`, opener, 'secT');
  const n = s.host.querySelector('#secN');
  api(`/members/${encodeURIComponent(id)}/security`).then((c) => {
    if (my !== secSeq || !n.isConnected) return;
    n.textContent = `通行金鑰 ${Number(c.passkeys) || 0} 把・登入中的裝置 ${Number(c.sessions) || 0} 個${c.google ? '・已綁 Google' : ''}`;
    // 沒有綁 Google：沒有東西可以解除
    if (!c.google) { const g = s.host.querySelector('#secG'); g.hidden = true; g.querySelector('input').checked = false; }
  }).catch((err) => { if (my === secSeq && n.isConnected) n.textContent = err.message; });
  s.host.querySelector('#secF').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/members/${encodeURIComponent(id)}/security-reset`, { method: 'POST', body: { unlink_google: f.unlink.checked, reason: f.reason.value.trim().slice(0, 100) } });
      s.close(); toast(`已重設 ${name} 的通行金鑰並登出所有裝置`);
      await adminView('roles');
      // 重畫後焦點回到同一位跑友的「安全」（在搜尋結果裡的話回到搜尋框）
      focusEl(document.querySelector(`#panel [data-sec="${CSS.escape(id)}"]`) || $('#roleSearch [name=q]'));
    } catch (err) { toast(err.message); }
  };
}
function bindHandover() {
  const rs = $('#roleSearch'), rsOnly = latest(), hoOnly = latest();
  if (rs) rs.onsubmit = async (e) => {
    e.preventDefault();
    const { members } = await rsOnly(api(`/members?q=${encodeURIComponent(rs.q.value.trim())}`).catch((err) => { toast(err.message); return { members: [] }; }));
    $('#roleList').innerHTML = members.slice(0, 12).map((m) => `<div class="r">${avatar(m)}<span><b><span translate="no">${esc(m.name)}</span></b><span class="tiny" style="display:block">${esc(ROLE_NAME[m.role] || '團員')}</span></span>
      ${roleActs(m)}</div>`).join('') || '<p class="tiny" style="margin:0">找不到符合的跑友。</p>';
    bindRoleActs($('#roleList'));
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
  'settings.security': '修改兩步驟驗證設定', 'audit.verify': '稽核完整性檢查', 'security.reset': '重設通行金鑰並登出',
  'settings.signup': '修改活動報名預設', 'event.signup_review': '審核報名', 'event.signup_reject': '婉拒或移出報名', 'event.reopen': '恢復活動',
  'signup.expire': '待審核逾期失效', 'event.orders_export': '下載訂購單',
  'google.link': '綁定 Google', 'login.denied': '登入驗證失敗', 'team.post': '發布分團公告', 'team.post_delete': '刪除分團公告', 'privacy.show_rank': '排行榜設定', broadcast: '群發通知', 'retention.cleanup': '資料保存期限清理', 'event.invite_denied': '邀請連結無效', 'privacy.share_logs': '訓練紀錄分享設定', 'settings.shortcut': '修改捷徑連結',
  'backup.daily': '每日備份', 'backup.manual': '手動備份', 'calendar.add': '加入行事曆', 'calendar.delete': '刪除行事曆項目', 'event.arrived': '通知到貨',
  'event.notice': '發布活動異動', 'event.reconcile': '對帳', 'holiday.import': '匯入國定假日', 'member.verify': '驗證會籍卡', 'notif.prefs': '修改推播設定', 'notif.digest': '修改推播摘要時間', 'notif.team_report': '分團週報推播',
  'ops.report': '產生幹部週報', 'ops.report_view': '查看幹部週報', 'ops.alert': '系統告警',
  'push.subscribe': '開啟推播', 'push.unsubscribe': '關閉推播', 'push.truncated': '推播分批送出', 'role.handover': '移交理事長', 'route.delete': '刪除路線',
  'spot.add': '新增地點', 'spot.propose': '提議地點', 'spot.approve': '核准地點', 'spot.update': '修改地點', 'spot.delete': '刪除地點', 'spot.report_delete': '刪除現場回報',
  'settings.cams': '附近即時影像來源開關', 'settings.cams_sync': '同步攝影機清單', 'cam.link.add': '新增直播連結', 'cam.link.delete': '刪除直播連結',
  'referrer.lookup': '用 Gmail 找推薦人', 'referrer.set': '設定推薦人', 'referrer.clear': '移除推薦人（本人）', 'referrer.ack': '推薦人確認', 'referrer.deny': '推薦人按「不是我」',
  'referrer.view': '查看推薦族譜', 'referrer.relink': '推薦人連到帳號（幹部）', 'referrer.admin_clear': '移除推薦人（幹部）', 'privacy.email_lookup': '用 Gmail 找到我（開關）',
  'google.refresh': '重新確認 Google 帳號',
  'pb.approve': '核准成績', 'pb.reject': '婉拒成績', 'pb.revoke': '撤銷成績', 'pb.delete': '刪除成績（本人）',
  'privacy.cheer_board': '恭喜榜開關', 'privacy.cheer_rank': 'PB 排行開關', 'privacy.ach_weight_delete': '刪除挑戰體重（本人）',
  'ach.join': '參加挑戰', 'ach.leave': '退出挑戰', 'ach.create': '建立挑戰', 'ach.update': '修改挑戰', 'ach.open': '發布挑戰', 'ach.cancel': '取消挑戰', 'ach.delete': '刪除挑戰草稿',
  'ach.confirm': '確認達成', 'ach.reject': '退回達成', 'ach.revoke': '撤銷達成', 'ach.witness': '見證量測', 'ach.issue': '團服發放', 'ach.shirts_export': '下載團服名單',
  'ach.remind_size': '提醒選尺寸', 'ach.notify_pickup': '通知領取團服', 'ach.release_unsized': '讓出沒選尺寸的名額', 'ach.settle': '挑戰結算', 'event.attendance': '出席標記',
};
// 稽核紀錄：一定要選時間區間（預設最近 7 天），再依類型、操作者、對象縮小；一次 50 筆
const AUDIT_GROUPS = { '': '所有類型', role: '身分變更', membership: '會籍', team: '分團', event: '活動', checkin: '報到', lottery: '抽獎',
  settings: '系統設定', signup: '報名審核', privacy: '個資', login: '登入', passkey: '通行金鑰', mfa: '兩步驟驗證', security: '帳號安全重設', account: '帳號', 'join.denied': '邀請碼錯誤', bootstrap: '初始設定', plan: '課表', referrer: '推薦人', pb: '成績', ach: '挑戰' };
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
// 推薦人動作的細節存的是代碼（稽核紀錄寫進去就不改，改了串鏈驗不過），畫面上換成中文
const REF_DETAIL = {
  'referrer.lookup': { found: '找到跑友帳號', none: '沒有找到', self: '填的是自己的 Gmail' },
  'referrer.set': { account: '綁定跑友帳號', name: '只填名字' },
  'referrer.ack': { ok: '確認是推薦人' },
};
function refDetail(action, t) {
  const hit = REF_DETAIL[action]?.[t];
  if (hit) return hit;
  if (action !== 'referrer.view') return t;
  let m = t.match(/^search｜n=(\d+)$/);
  if (m) return `搜尋推薦族譜，${m[1]} 筆結果`;
  m = t.match(/^tree｜up=(\d+)｜down=(\d+)$/);
  if (m) return `看族譜：往上 ${m[1]} 人、往下 ${m[2]} 人`;
  m = t.match(/^named｜n=(\d+)$/);
  return m ? `只填名字的跑友 ${m[1]} 人` : t;
}
// 成績與挑戰的細節也是代碼（d=fm｜r=link、c=<挑戰>｜w=b、on／off…），畫面上換成中文；每個詞都是字典的一個鍵（英文介面逐詞翻）
const ACH_REASON = { link: '連結打不開', mismatch: '成績或姓名對不上', dup: '同一場已經登錄過', unclear: '截圖看不清楚', doubt: '紀錄有疑問', unverified: '沒有見到本人',
  ineligible: '不符合挑戰資格', wrong: '成績有誤', notself: '不是本人', other: '其他' };
const ACH_PB_STATE = { pending: '審核中', approved: '已核准', rejected: '已婉拒', revoked: '已撤銷' };
const ACH_FLAG = { on: '標記已發放', off: '取消發放', consent: '同意保存體重', leave: '退出挑戰' };
const ACH_CODED = new Set(['pb.approve', 'pb.reject', 'pb.revoke', 'privacy.ach_weight_delete', 'ach.join', 'ach.leave', 'ach.confirm', 'ach.reject', 'ach.revoke', 'ach.witness', 'ach.issue']);
function achDetail(action, t) {
  if (action === 'pb.delete') return ACH_PB_STATE[t] || t;
  if (!ACH_CODED.has(action)) return t;
  return t.split('｜').map((p) => {
    const [k, v] = [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)];
    if (!p.includes('=')) return ACH_FLAG[p] || p;
    if (k === 'd') return `距離：${AR.DISTS[v]?.zh || v}`;
    if (k === 'r') return `原因：${ACH_REASON[v] || v}`;
    if (k === 'c') return `挑戰 ${v}`;
    if (k === 'w') return v === 'b' ? '起始量測' : v === 'l' ? '結束量測' : p;
    return p;
  }).join('・');
}
function auditDetail(d, action) {
  // 結尾的 ｜team=…｜role=…｜to=… 是給還原工具看的代碼（tools/restore-sql.mjs），畫面上不顯示
  let t = achDetail(action, refDetail(action, String(d).replace(/(｜(team|role|to)=[\w-]+)+$/, '')));
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
        <span class="tiny" style="display:block">${x.actor_name ? `<span translate="no">${esc(x.actor_name)}</span>` : '未登入'}${x.actor_role ? `（${esc(ROLE_NAME[x.actor_role] || x.actor_role)}）` : ''}${x.detail ? `・<span>${esc(auditDetail(x.detail, x.action))}</span>` : ''}</span></span>
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
  rest: '跑者休息站（飲水、廁所、淋浴置物、補給）', meetup: '團員揪團（團員自己發起活動）', referral: '推薦人（跑友填介紹人、推薦族譜）',
  achieve: '成績與挑戰（PB 登錄、目標挑戰、恭喜榜）', achieve_rank: '恭喜榜的各距離 PB 排行' };
// 功能開關的說明：關掉會影響什麼（課表教練與教練身分容易搞混，寫清楚）
const FEATURE_HELP = { coach: '關閉後所有人都看不到這些頁面；不影響每週課表與訓練紀錄',
  plan_cycle: '關閉後所有人都照協會賽季排課；已選的週期會保留，打開後恢復',
  plan_export: '教練已同意分享，預設開啟；關閉後所有人都看不到分享按鈕',
  meetup: '團員可以在自己參加的分團發起揪團：不能收費、不推播，每人同時最多 3 場；分團與協會幹部可以編輯或刪除。關閉後不能再發起，已經開的照常',
  referral: '跑友可以填是誰介紹他來的（用 Gmail 找跑友帳號，或只填名字）；會員管理權限的幹部在「管理後台 → 會員 → 推薦族譜」查看。打開前請先在 Google Cloud 的 OAuth 同意畫面加上 Email 範圍；打開後 Google 登入會多問一次 Email 授權。關閉後不能新增，已經填的保留，本人仍可移除',
  achieve: '打開前請先看過隱私權政策（新增比賽成績與體重挑戰的說明；用自訂條文的協會要自己補上）。關閉後不能再登錄成績或參加挑戰，已有的資料照樣看得到、可以刪除，審核中的可以審完，進行中的挑戰照樣結算',
  achieve_rank: '只列打開「恭喜榜」並且另外同意「列入 PB 排行」的跑友、近三年通過審核的成績，不分性別年齡，只是參考；關閉時恭喜榜只顯示最新的恭喜' };
// 預設關閉的功能（要明確打開才有）
const FEATURE_OFF = new Set(['cams', 'rest', 'meetup', 'referral', 'achieve', 'achieve_rank']);
// 系統設定：第一層是分組清單（跟「我的」一樣的列，副標是目前的值），點一列進到子頁才是表單；常用的在前、少用但重要的放最後
//   網址：#/admin/settings（等於 #/admin?tab=settings）、#/admin/settings/<段>；表單、儲存 API、稽核名稱都跟拆開前一樣
const yrs = (n, none = '不自動刪除') => (Number(n) ? `${Number(n)} 年` : none);
const SET = {
  signup: { t: '活動報名預設', icon: IC.calClock, sub: () => { const sd = { ...SIGNUP_DEFAULTS, ...(cfg.settings?.signup || {}) };
    return `${sd.open_days == null ? '建立後立即開放' : `活動前 ${sd.open_days} 天 ${esc(sd.open_time || '20:00')} 開放`}${sd.approval ? '・需要審核' : ''}`; }, html: () => signupCard() },
  races: { t: '倒數與常用賽事', icon: MI.flag, sub: () => (cfg.race && !cfg.race.mine ? `協會預設：<span translate="no">${esc(cfg.race.name)}</span>` : '協會預設賽事、常用賽事清單'), html: () => racesCard() },
  holidays: { t: '國定假日', icon: IC.calendar, sub: () => '每年匯入一次，行事曆標出放假與補班', html: () => holidayCard() },
  seats: { t: '座位圖（餐敘）', icon: MI.roster, href: '#/admin?tab=events', show: () => cfg.settings?.features?.party !== false, sub: () => '在「活動」分頁設定' },
  org: { t: '協會資訊', icon: MI.building, sub: () => (org().name ? `<span translate="no">${esc(org().name)}</span>` : '名稱、所屬企業、入會表單、聯絡方式'), html: () => orgCard() },
  docs: { t: '協會文件', icon: IC.doc, sub: () => ((cfg.settings?.docs || []).length ? `${cfg.settings.docs.length} 份文件` : '章程、組織說明、會費說明'), html: () => docsCard() },
  training: { t: '課表與團練', icon: MI.plan, sub: () => (org().thu_venue ? `週四團練：<span translate="no">${esc(org().thu_venue)}</span>` : '週四團練地點、Apple 健康捷徑'), html: () => trainingCard() },
  rest: { t: '跑者休息站來源', icon: IC.pin, sub: () => (cfg.settings?.features?.rest === true ? '已開啟・資料來源與同步狀態' : '功能關閉・可以先設定來源'), html: () => restCard() },
  cams: { t: '附近即時影像來源', icon: MI.camera, sub: () => (cfg.settings?.features?.cams === true ? '已開啟・資料來源與同步狀態' : '功能關閉・可以先設定來源'), html: () => camsCard() },
  features: { t: '功能開關', icon: IC.sliders, sub: () => { const n = Object.keys(FEATURE_NAME).filter((k) => featOn(k)).length; return `${n} / ${Object.keys(FEATURE_NAME).length} 項開啟`; }, html: () => featuresCard() },
  tabs: { t: '分頁列名稱', icon: MI.display, sub: () => { const t = cfg.settings?.tabs || {}; return Object.keys(t).length ? Object.entries(t).map(([k, v]) => `<span translate="no">${esc(v)}</span>`).join('・') : '使用預設名稱'; }, html: () => tabsCard() },
  mfa: { t: '幹部兩步驟驗證', icon: MI.shield, show: () => (me.realRole || me.role) === 'chair', sub: () => (cfg.requireMfa ? '已開啟' : '未開啟'), html: () => mfaCard() },
  backup: { t: '每日加密備份', icon: IC.lock, sub: () => '<span id="bkSub">每天 03:00 自動備份・保留 35 天</span>', badge: '<span id="bkBadge"></span>', html: () => backupCard() },
  privacy: { t: '隱私權政策', icon: MI.eye, sub: () => (cfg.settings?.privacy?.version ? `版本 ${esc(cfg.settings.privacy.version)}` : '個資法第 8 條告知內容'), html: () => privacyCard() },
  // 副標用「項目：期限」：英文逐段換成「Training log: 3 yr」，不會黏成一串
  retention: { t: '資料保存期限', icon: IC.trash, sub: () => `活動報名：${yrs(org().event_data_years)}・訓練紀錄：${yrs(org().log_years)}・稽核紀錄：${yrs(org().audit_years || 3)}`, html: () => retentionCard() },
};
const SET_GROUPS = [['活動與報名', ['signup', 'races', 'holidays', 'seats']], ['協會', ['org', 'docs', 'training']], ['地圖資料', ['rest', 'cams']],
  ['功能與畫面', ['features', 'tabs']], ['安全與隱私', ['mfa', 'backup', 'privacy', 'retention']]];
const groupOf = (k) => SET_GROUPS.find(([, ks]) => ks.includes(k))?.[0] || '';
const featOn = (k) => (FEATURE_OFF.has(k) ? cfg.settings?.features?.[k] === true : cfg.settings?.features?.[k] !== false);
function settingsPanel() {
  return SET_GROUPS.map(([g, ks]) => group(g, ks.filter((k) => !SET[k].show || SET[k].show()).map((k) => row(SET[k].href || `#/admin/settings/${k}`, SET[k].icon, SET[k].t, SET[k].sub(), SET[k].badge || '')))).join('');
}
// 子頁：#/admin/settings/<段>，大標題是這一項、副標是分組；返回鍵回到系統設定清單
//   沒有段（#/admin/settings，從「我的 › 系統設定」來）：清單本身，大標題就是「系統設定」（跟點的那一列同名，VoiceOver 與分頁標題一致）
async function settingsPage(seg) {
  if (me.mfaPending) { view.innerHTML = `${largeTitle('系統設定')}${mfaBanner()}`; bindStepup(); return; }
  const S = SET[seg];
  if (!allow('settings')) { view.innerHTML = `${largeTitle('系統設定')}<div class="card"><p class="muted" style="margin:0">只有理事長與行政人員可以修改系統設定。</p></div>`; return; }
  if (!seg) { view.innerHTML = `${largeTitle('系統設定')}${settingsPanel()}`; bindSettings(); return; }
  if (!S || S.href || (S.show && !S.show())) { location.replace('#/admin/settings'); return; }
  view.innerHTML = `${largeTitle(S.t, groupOf(seg))}${S.html()}`;
  bindSettings();
}
const signupCard = () => { const sd = { ...SIGNUP_DEFAULTS, ...(cfg.settings?.signup || {}) };
  return `<section class="card">
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
  </section>`; };
const racesCard = () => `<section class="card">
    <h2 class="h3">協會預設倒數</h2>
    <form id="clubRace2" class="grid2">
      <label>協會預設賽事<input name="name" maxlength="30" value="${esc(cfg.race && !cfg.race.mine ? cfg.race.name : '')}"></label>
      <label>日期<input type="date" name="date" value="${esc(cfg.race && !cfg.race.mine ? cfg.race.date : '')}"></label>
      <button class="btn" style="grid-column:1/-1">儲存預設倒數</button>
    </form>
    <p class="tiny" style="margin:0">團員自己沒有設定賽事時，右上角倒數這一場。</p>
  </section>
  <section class="card">
    <h2 class="h3">常用賽事清單</h2>
    <p class="tiny" style="margin:0">團員點右上角倒數就能直接挑。</p>
    <div id="presetRows" class="docedit"><p class="tiny" style="margin:0">載入中…</p></div>
    <div class="row" style="gap:8px"><button type="button" class="btn ghost sm" id="presetAdd">${IC.plus}新增一場</button><button type="button" class="btn sm" id="presetSave">儲存清單</button></div>
  </section>`;
const holidayCard = () => `<section class="card" id="holCard">
    <p class="tiny" style="margin:0">從新北市政府資料開放平台「政府行政機關辦公日曆表」匯入，行事曆會標出放假與補班，定期揪跑可以選擇遇到國定假日不開。每年公告後（通常前一年 6 月）手動匯入一次。</p>
    <div id="holYears" class="lstats"><span class="tiny">載入中…</span></div>
    <div class="row" style="gap:8px">${[new Date().getFullYear(), new Date().getFullYear() + 1].map((y) => `<button type="button" class="btn ghost sm" data-holy="${y}">匯入 ${y} 年</button>`).join('')}</div>
    <div id="holOut"></div>
  </section>`;
const orgCard = () => { const o = org();
  return `<section class="card">
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
      <button class="btn">儲存協會資訊</button>
    </form>
    <p class="tiny" style="margin:0">週四團練地點在「課表與團練」，個資保存期限與自動清理在「資料保存期限」。</p>
  </section>`; };
const docsCard = () => { const docs = cfg.settings?.docs || [];
  return `<section class="card">
    <div class="row spread"><p class="tiny" style="margin:0;flex:1">章程、組織說明、會費說明等，跑友在「我的 → 協會」看得到。連結要是 https:// 開頭。</p><button class="btn ghost sm" id="addDoc">${IC.plus}新增</button></div>
    <div id="docRows" class="docedit">${docs.map(docRow).join('')}</div>
    <button class="btn" id="saveDocs" ${docs.length ? '' : 'hidden'}>儲存文件清單</button>
  </section>`; };
const trainingCard = () => `<section class="card">
    <form id="venueForm">
      <label>週四團練地點（課表的週四備註會顯示）<input name="thu_venue" maxlength="20" value="${esc(org().thu_venue || '')}" placeholder="例如：大佳河濱公園"></label>
      <button class="btn">儲存團練地點</button>
    </form>
  </section>
  <section class="card">
    <h2 class="h3">Apple 健康捷徑</h2>
    <p class="tiny" style="margin:0">團員在「拍照分享」用捷徑帶入 Apple 健康的距離與時間。</p>
    <form id="scForm2" class="row" style="gap:8px">
      <input name="url" placeholder="Apple 健康捷徑 iCloud 連結" aria-label="Apple 健康捷徑 iCloud 連結" value="${esc(cfg.shortcut || '')}" style="flex:1;min-width:200px">
      <button class="btn ghost sm">儲存捷徑</button>
    </form>
  </section>`;
const restCard = () => `<section class="card" id="restSrcCard">
    <p class="tiny" style="margin:0">練跑地圖的「休息站」圖層與地點卡的「附近休息站」：政府開放資料加上幹部整理的清單，每筆都標出處與授權。小的來源由排程在清晨自動同步；檔案大或很多檔的來源（Workers 免費方案每次執行只有 10 ms CPU，跑不完）由維護工具在電腦上同步，這裡只顯示上次同步的時間。關掉來源後立即不再顯示，也不再連線。</p>
    <div id="restSrcList" class="toggles"><p class="tiny" style="margin:0">載入中…</p></div>
  </section>`;
const camsCard = () => `<section class="card" id="camSrcCard">
    <p class="tiny" style="margin:0">地點卡會列出 1.5 公里內的政府公開攝影機（沒有就列 3 公里內最近一支），畫面由本站轉送、不保存，跑友的 IP 不會送到影像來源。功能開關打開後，水利署與水利處的鏡頭清單每天清晨 04:00 起自動同步（每小時只同步一個來源）；公路局的清單由電腦上的同步工具更新。關掉來源後立即不再顯示，也不再連線。</p>
    <div id="camSrcList" class="toggles"><p class="tiny" style="margin:0">載入中…</p></div>
  </section>`;
// 功能開關分五組：訓練、活動、地圖（地圖的兩項旁邊有「設定來源 ›」）、會員、成績與挑戰
const FEATURE_GROUPS = [['訓練', ['gps', 'studio', 'health', 'file', 'coach', 'plan_cycle', 'plan_export']], ['活動', ['party', 'meetup']], ['地圖', ['cams', 'rest']], ['會員', ['referral']], ['成績與挑戰', ['achieve', 'achieve_rank']]];
const featuresCard = () => `<section class="card">
    <form id="featForm" class="toggles">
      ${FEATURE_GROUPS.map(([g, ks]) => `<fieldset class="qset featgrp"><legend>${g}</legend>${ks.map((k) => `<label class="switch"><span>${FEATURE_NAME[k]}${FEATURE_HELP[k] ? `<span class="tiny" style="display:block">${FEATURE_HELP[k]}</span>` : ''}</span><input type="checkbox" name="${k}" ${featOn(k) ? 'checked' : ''}><i></i></label>${k === 'cams' || k === 'rest' ? `<a class="tiny tlink featsrc" href="#/admin/settings/${k}">${k === 'cams' ? '設定影像來源 ›' : '設定休息站來源 ›'}</a>` : ''}`).join('')}</fieldset>`).join('')}
      <button class="btn">儲存功能開關</button>
    </form>
    <p class="tiny" style="margin:0">關掉後，跑友的畫面上就看不到這個功能；已存的資料不會刪除。</p>
  </section>`;
const tabsCard = () => `<section class="card">
    <form id="tabsForm" class="grid3">${Object.entries(TAB_DEFAULT).map(([k, v]) => `<label>${v}<input name="${k}" maxlength="4" placeholder="${v}" value="${esc(cfg.settings?.tabs?.[k] || '')}"></label>`).join('')}
      <button class="btn" style="grid-column:1/-1">儲存名稱</button></form>
    <p class="tiny" style="margin:0">名稱會顯示在下方分頁列與 iPad／電腦的側邊欄，每個最多 4 個字，留空就用預設。「拍照」只有在關閉 GPS 跑步時才會出現在分頁列。</p>
  </section>`;
const mfaCard = () => `<section class="card">
    <label class="switch"><span>幹部要用通行金鑰驗證才能使用管理功能<span class="tiny" style="display:block">理事、監事、行政人員、教練都適用；一般跑友不受影響</span></span>
      <input type="checkbox" id="mfaToggle" ${cfg.requireMfa ? 'checked' : ''}><i></i></label>
    <p class="tiny" style="margin:0">開啟前請先在「我的 → 帳號與安全」新增通行金鑰並驗證一次，也請其他幹部先新增，否則他們會暫時只能用一般跑友的功能。</p>
  </section>`;
const backupCard = () => `<section class="card" id="bkCard"><div class="row spread"><p class="tiny" style="margin:0;flex:1">每天凌晨 3 點起自動把資料庫加密備份（AES-GCM），保留 35 天；資料多時分成好幾段，在接下來的整點陸續做完。還原用 tools/restore-backup.mjs，金鑰另外保存在理事長的電腦與密碼管理器。</p><button type="button" class="btn ghost sm" id="bkNow">立即備份</button></div>
    <div id="bkList" class="roster"><p class="tiny" style="margin:0">載入中…</p></div></section>`;
const privacyCard = () => { const pv = cfg.settings?.privacy || {};
  return `<section class="card">
    <p class="tiny" style="margin:0">目前版本：${esc(pv.version || '')}。留空就使用系統預設的個資法第 8 條告知內容。<b>內容一改就會自動升版，所有人下次開啟都要重新同意。</b></p>
    <form id="pvForm">
      <textarea name="body" style="min-height:240px" aria-label="隱私權政策內容" placeholder="## 一、蒐集目的&#10;…&#10;&#10;- 清單項目">${esc(pv.body || '')}</textarea>
      <p class="tiny" style="margin:0">格式：「## 」開頭是標題、「- 」開頭是清單、空一行分段。</p>
      <div class="sheetacts"><a class="btn ghost" href="#/privacy">預覽</a><button class="btn">儲存並升版</button></div>
    </form>
  </section>`; };
const retentionCard = () => { const o = org();
  return `<section class="card">
    <form id="retForm">
      <label>個資保存期限（寫進隱私權政策的文字）<input name="retention" maxlength="200" value="${esc(o.retention || '')}"></label>
      <fieldset class="group"><legend>自動清理（每天 03:00 執行）</legend>
        <div class="grid3">
          <label>活動報名資料保存<select name="event_data_years">${[0, 1, 2, 3, 5].map((y) => `<option value="${y}" ${Number(o.event_data_years || 0) === y ? 'selected' : ''}>${y ? `${y} 年` : '不自動刪除'}</option>`).join('')}</select></label>
          <label>訓練紀錄保存<select name="log_years">${[0, 1, 2, 3, 5].map((y) => `<option value="${y}" ${Number(o.log_years || 0) === y ? 'selected' : ''}>${y ? `${y} 年` : '不自動刪除'}</option>`).join('')}</select></label>
          <label>稽核紀錄保存<select name="audit_years">${[1, 2, 3, 5, 7].map((y) => `<option value="${y}" ${Number(o.audit_years || 3) === y ? 'selected' : ''}>${y} 年</option>`).join('')}</select></label>
        </div>
        <p class="tiny" style="margin:0">活動超過保存年限後，報名、入場券與受邀名單會刪除，中獎紀錄只留獎項不留姓名。過期的登入工作階段、180 天前的通知每天都會清掉。</p>
      </fieldset>
      <button class="btn">儲存保存期限</button>
    </form>
  </section>`; };
const docRow = (d = {}) => `<div class="drow">
  <input data-k="title" placeholder="文件名稱" maxlength="40" value="${esc(d.title || '')}">
  <input data-k="url" type="url" placeholder="https://" value="${esc(d.url || '')}">
  <input data-k="note" placeholder="說明（選填）" maxlength="80" value="${esc(d.note || '')}">
  <button type="button" class="iconx rm" data-rmdoc aria-label="移除">${IC.minus}</button></div>`;
// 子頁的綁定：每一段只有在畫面上才綁（一次只畫一段）
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
  if ($('#bkList')) loadBk();
  // 清單上的「每日加密備份」：卡住時副標直接寫出來、加上「要處理」（不用點進去才知道）；正常時寫上次備份的日期
  if ($('#bkSub')) api('/backups').then((r) => {
    const sub = $('#bkSub'), badge = $('#bkBadge'); if (!sub || !r?.enabled) return;
    if (r.stale) { sub.textContent = r.stale.pending ? `${r.stale.pending} 的備份還沒做完` : '超過 36 小時沒有新的備份'; if (badge) badge.innerHTML = '<span class="pill wait">要處理</span>'; return; }
    const last = r.list.map((b) => /^daily\/(\d{4}-\d{2}-\d{2})\.bin$/.exec(b.key)?.[1]).filter(Boolean).sort().pop();
    if (last) sub.textContent = `每天 03:00 自動備份・上次 ${Number(last.slice(5, 7))}/${Number(last.slice(8))}`;
  }).catch(() => {});
  $('#bkNow')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await api('/backups', { method: 'POST', body: {} }); toast(r.started ? '資料較多，備份會在接下來的整點分段做完' : `已備份 ${r.tables} 張表、${r.rows} 筆`); loadBk(); } catch (err) { toast(err.message); }
    e.target.disabled = false;
  });
  const loadHol = async () => {
    const { years } = await api('/holidays').catch(() => ({ years: [] }));
    if ($('#holYears')) $('#holYears').innerHTML = years.length ? years.map((y) => `<span>${y.year} 年 <b class="num">${y.named}</b> 個節日</span>`).join('') : '<span class="tiny">還沒有匯入任何一年</span>';
  };
  if ($('#holYears')) loadHol();
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
  if ($('#camSrcList')) loadCamSrc();
  // 跑者休息站：來源開關、上次同步、筆數、資料日期、錯誤；小來源可以立即同步，大的由維護工具同步（tools/rest-sync.mjs，沒有按鈕）
  const EVERY = { day: 1, week: 7, month: 31 };
  // 要金鑰、還沒同步過的來源（第二批）：說明要先在維護電腦設定金鑰，開了開關卻沒有資料時才知道原因
  const KEY_NEED = { MOENV_KEY: '需要環境部開放資料平臺的 API 金鑰（MOENV_KEY），由維護工具在電腦上同步' };
  const keyNeed = (x) => KEY_NEED[x.needsKey] || '需要 API 金鑰，由維護工具在電腦上同步';
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
        ${x.local ? `<span class="tiny">${x.needsKey && !x.last_ok_at ? keyNeed(x) : `由維護工具同步・${x.last_ok_at ? `上次同步 ${camTime(x.last_ok_at)}` : '還沒有同步過'}`}${stale(x) ? '・<span class="ostat off">已經很久沒有同步</span>' : ''}</span>`
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
  if ($('#restSrcList')) loadRestSrc();
  // 存好後只更新共用狀態（分頁列名稱、功能開關、倒數），不重畫子頁：焦點留在剛按的儲存鍵
  const reload = async (msg) => { await refreshMe(); toast(msg); applyFeatures(); paintCountdown(); };
  const save = async (key, body, msg) => { try { await api(`/settings/${key}`, { method: 'POST', body }); await reload(msg); } catch (e) { toast(e.message); } };
  // 協會資訊拆成三張表單（協會資訊、課表與團練、資料保存期限），每張只送自己的欄位（伺服器沒送的欄位保留原值）
  $('#orgForm')?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target;
    save('org', { name: f.name.value, short: f.short.value, join_form: f.join_form.value.trim(), contact: f.contact.value,
      parent: f.parent.value, parent_url: f.parent_url.value.trim(), parent_note: f.parent_note.value }, '已儲存協會資訊'); });
  $('#venueForm')?.addEventListener('submit', (e) => { e.preventDefault(); save('org', { thu_venue: e.target.thu_venue.value.trim() }, '已儲存團練地點'); });
  $('#retForm')?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target;
    save('org', { retention: f.retention.value, event_data_years: Number(f.event_data_years.value), log_years: Number(f.log_years.value), audit_years: Number(f.audit_years.value) }, '已儲存保存期限'); });
  $('#mfaToggle')?.addEventListener('change', async (e) => {
    try { await api('/settings/security', { method: 'POST', body: { require_mfa: e.target.checked } }); await reload(e.target.checked ? '已開啟幹部兩步驟驗證' : '已關閉幹部兩步驟驗證'); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
  });
  $('#tabsForm')?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target;
    save('tabs', Object.fromEntries(Object.keys(TAB_DEFAULT).map((k) => [k, f[k].value.trim()])), '已儲存分頁列名稱'); });
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
  $('#featForm')?.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target, body = {};
    for (const k of Object.keys(FEATURE_NAME)) body[k] = f[k].checked;
    save('features', body, '已儲存功能開關'); });
  const bindRm = () => { for (const b of document.querySelectorAll('[data-rmdoc]')) b.onclick = () => { b.closest('.drow').remove(); $('#saveDocs').hidden = false; }; };
  bindRm();
  if ($('#addDoc')) $('#addDoc').onclick = () => { $('#docRows').insertAdjacentHTML('beforeend', docRow()); $('#saveDocs').hidden = false; bindRm(); $('#docRows .drow:last-child input')?.focus(); };
  if ($('#saveDocs')) $('#saveDocs').onclick = () => {
    const docs = [...document.querySelectorAll('.drow')].map((r) => Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()])))
      .filter((d) => d.title || d.url);
    if (docs.some((d) => !/^https:\/\//.test(d.url) || !d.title)) return toast('每份文件都要有名稱，連結要是 https:// 開頭');
    save('docs', { docs }, '已儲存文件清單');
  };
  $('#pvForm')?.addEventListener('submit', (e) => { e.preventDefault();
    if (!confirm('儲存後政策會升版，所有人下次開啟都要重新同意。確定嗎？')) return;
    save('privacy', { body: e.target.body.value, bump: true }, '已儲存隱私權政策'); });
  $('#clubRace2')?.addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target;
    try { await api('/settings/club-race', { method: 'POST', body: { name: f.name.value, date: f.date.value } }); await reload('已更新預設倒數'); } catch (err) { toast(err.message); } });
  // 常用賽事清單
  const presetRow = (p = {}) => `<div class="drow"><input data-k="name" placeholder="比賽名稱" maxlength="40" aria-label="比賽名稱" value="${esc(p.name || '')}">
    <input data-k="date" type="date" aria-label="比賽日期" value="${esc(p.date || '')}"><input data-k="dist" placeholder="全馬／半馬／10K" maxlength="10" aria-label="距離" value="${esc(p.dist || '')}">
    <button type="button" class="iconx rm" data-rmpre aria-label="移除">${IC.minus}</button></div>`;
  const bindPre = () => { for (const b of document.querySelectorAll('[data-rmpre]')) b.onclick = () => b.closest('.drow').remove(); };
  // 常用賽事清單：子頁打開就載入（以前收在 details 裡）
  if ($('#presetRows')) api('/races').then((r) => { const box = $('#presetRows'); if (!box) return; box.innerHTML = r.presets.map(presetRow).join('') || ''; bindPre(); }).catch((e) => toast(e.message));
  if ($('#presetAdd')) $('#presetAdd').onclick = () => { $('#presetRows').insertAdjacentHTML('beforeend', presetRow()); bindPre(); $('#presetRows .drow:last-child input')?.focus(); };
  if ($('#presetSave')) $('#presetSave').onclick = async () => {
    const presets = [...document.querySelectorAll('#presetRows .drow')].map((r) => Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()]))).filter((p) => p.name || p.date);
    if (presets.some((p) => !p.name || !p.date)) return toast('每一場都要有名稱和日期');
    try { const r = await api('/settings/race-presets', { method: 'POST', body: { presets } }); toast(`已儲存 ${r.presets.length} 場`); } catch (err) { toast(err.message); }
  };
  $('#scForm2')?.addEventListener('submit', async (e) => { e.preventDefault();
    try { await api('/settings/shortcut', { method: 'POST', body: { url: e.target.url.value.trim() } }); await reload('已儲存捷徑連結'); } catch (err) { toast(err.message); } });
}

// ---------- 推薦族譜（誰推薦誰）----------
// 會員管理權限的幹部（理事長、理事、監事、行政人員）：先搜尋再看，不一次列出所有人；每次查看伺服器都寫稽核；監事只能看
//   網址：#/admin/tree、#/admin/tree?id=<會員>（以他為中心）、#/admin/tree?name=<只填的名字>（填了同一個名字的跑友）
//   功能開關關掉時入口列不顯示，但已經填的資料還在，這頁照樣能看
const refOn = () => featOn('referral');
const TREE_IC = MI.tree || ic('<circle cx="12" cy="5" r="2.2"/><circle cx="6" cy="18.8" r="2.2"/><circle cx="18" cy="18.8" r="2.2"/><path d="M12 7.2v4.3M6 16.6V14a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2.6"/>');
const TREE_DOWN = 3;   // 往下看幾層（伺服器最多 3 層、300 位）
const refNm = (name, nick) => `<b translate="no">${esc(name)}</b>${nick ? ` <span class="tiny" translate="no">${esc(nick)}</span>` : ''}`;
// 監事看到的是遮掉中間的號碼（0912***678）：只顯示、不給撥號連結
const telOk = (p) => /^[\d+()\s-]{6,}$/.test(p || '');
const telHref = (p) => `tel:${esc(String(p).replace(/[^\d+]/g, ''))}`;
const refWho = (r) => (!r ? '沒有' : r.kind === 'name' ? `只填名字：<span translate="no">${esc(r.name)}</span>`
  : r.kind === 'gone' ? '已刪除帳號' : `<span translate="no">${esc(r.name)}</span>`);
const refPills = (r, ack, by, done = false) => `${r?.kind === 'member' && ack == null ? '<span class="pill wait">等推薦人確認</span>' : ''}${done && r?.kind === 'member' && ack === 'ok' ? '<span class="pill">推薦人已確認</span>' : ''}${by === 'admin' ? '<span class="pill">由管理員設定</span>' : ''}`;
let treeSeq = 0;
async function treeView() {
  if (me.mfaPending) { view.innerHTML = `${largeTitle('推薦族譜')}${mfaBanner()}`; bindStepup(); return; }
  if (!allow('members')) { view.innerHTML = '<div class="card"><p class="muted">沒有查看推薦族譜的權限。</p></div>'; return; }
  const ro = me.role === 'supervisor', my = ++treeSeq;
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let s;
  try { s = await api('/admin/referrals'); }
  catch (e) { if (my === treeSeq) view.innerHTML = `${largeTitle('推薦族譜')}<div class="card"><p class="muted">${esc(e.message)}</p></div>`; return; }
  if (my !== treeSeq || !location.hash.startsWith('#/admin/tree')) return;   // 等資料的時候已經換頁
  const sm = s.summary || {};
  const kpi = (label, v) => `<div class="card kpi"><span class="tiny">${label}</span><b class="num">${v ?? '—'}</b></div>`;
  view.innerHTML = `${largeTitle('推薦族譜', '誰推薦誰・每次查看都會留下稽核紀錄')}${ro ? '<p class="tiny">監事只能查看。</p>' : ''}
    <section class="kpis">${kpi('有推薦人', sm.linked)}${kpi('只填名字', sm.named)}${kpi('等推薦人確認', sm.pending)}${kpi('推薦人已刪除', sm.gone)}</section>
    <p class="tiny">可以用 Gmail 找到的跑友 ${Number(sm.findable) || 0} 位</p>
    <section class="card"><h3>找跑友</h3>
      <form id="rtForm" class="refq" role="search"><input name="q" maxlength="20" placeholder="姓名、暱稱或會員編號" aria-label="搜尋跑友" autocomplete="off" enterkeyhint="search" required><button class="btn sm">搜尋</button></form>
      <p class="tiny" id="rtHint" style="margin:0"${s.needFilter === false ? ' hidden' : ''}>輸入名字開始找。為了保護個資，不會一次列出所有人。也會找只填名字的推薦人。</p></section>
    <div id="rtOut"></div>`;
  const out = $('#rtOut'), only = latest();
  let cur = null;   // 目前顯示的人或名字（按鈕要用）
  const show = (html, sel) => { $('#rtHint').hidden = true; out.innerHTML = html; if (sel) focusEl(out.querySelector(sel)); };
  // 搜尋結果：跑友（點了以他為中心）、只填名字的推薦人（點了看填這個名字的人）
  const search = async (q) => {
    const r = await only(api(`/admin/referrals?q=${encodeURIComponent(q)}`));
    const ms = r.members || [], ns = r.names || [];
    cur = null;
    history.replaceState(null, '', '#/admin/tree');
    if (!ms.length && !ns.length) return show(`<section class="card">${emptyState(MI.roster, '找不到符合的跑友')}</section>`, '.empty');
    show(`${ms.length ? `<section class="card"><h3 tabindex="-1">跑友</h3><div class="roster reflist">${ms.map((m) => `<button type="button" class="r" data-fid="${esc(m.id)}"><span>${refNm(m.name, m.nickname)}
        <span class="tiny" style="display:block">推薦人：${refWho(m.referrer)}・推薦了 ${Number(m.kids) || 0} 位</span>${refPills(m.referrer, m.ack, m.by)}</span><span class="chev" aria-hidden="true"></span></button>`).join('')}</div></section>` : ''}
      ${ns.length ? `<section class="card"><h3 tabindex="-1">只填名字的推薦人</h3><div class="roster reflist">${ns.map((n) => `<button type="button" class="r" data-fname="${esc(n.name)}"><span><b translate="no">${esc(n.name)}</b>
        <span class="tiny" style="display:block">${Number(n.n) || 0} 位跑友填了這個名字</span></span><span class="chev" aria-hidden="true"></span></button>`).join('')}</div></section>` : ''}
      ${r.more?.members || r.more?.names ? '<p class="tiny">結果太多，只顯示前 30 筆，請再縮小條件</p>' : ''}`, 'h3');
  };
  // 以某一位為中心：往上一串推薦人（最近的在上）、他本人、往下可以收合的樹
  const focus = async (id, { quiet = false } = {}) => {
    const t = await only(api(`/admin/referrals/tree?id=${encodeURIComponent(id)}&down=${TREE_DOWN}`));
    const n = t.node, ref = n.referrer ?? null, ack = n.ack !== undefined ? n.ack : n.referrer_ack, by = n.by ?? n.referrer_by, up = t.up || [];
    cur = { kind: 'node', node: n, ref };
    history.replaceState(null, '', `#/admin/tree?id=${encodeURIComponent(n.id)}`);
    const end = t.upEnd || (!up.length && ref && ref.kind !== 'member' ? ref : null);
    const endHtml = !end ? '' : end.kind === 'name' ? `<div class="r"><span class="pill">只填名字</span><b translate="no">${esc(end.name)}</b></div>`
      : end.kind === 'gone' ? '<div class="r"><span class="pill">推薦人已刪除帳號</span></div>' : '<p class="tiny" style="margin:0">還有更上層，點最上面那位繼續看</p>';
    const upHtml = up.length || end ? up.map((u) => `<div class="r"><span class="pill">第 ${Number(u.d)} 層</span>
        <button type="button" class="tname" data-fid="${esc(u.id)}">${refNm(u.name, u.nickname)}<span class="tiny" style="display:block">${esc(u.club || '未填跑團')}・${MEMBERSHIP_NAME[u.membership] || MEMBERSHIP_NAME.none}</span></button>
        ${u.phone ? (telOk(u.phone) ? `<a class="tlink" href="${telHref(u.phone)}" translate="no">${esc(u.phone)}</a>` : `<span class="tiny" translate="no">${esc(u.phone)}</span>`) : ''}</div>`).join('') + endHtml
      : '<p class="muted" style="margin:0">沒有推薦人</p>';
    // 往下：同一位推薦人的跑友放在他底下；第一層先打開，更深的收合；被截掉或超過層數的，給「以他為中心看下一層」
    const kids = new Map();
    for (const d of t.down || []) { if (!kids.has(d.parent)) kids.set(d.parent, []); kids.get(d.parent).push(d); }
    const node = (d) => {
      const ch = kids.get(d.id) || [], k = Number(d.kids) || 0;
      const head = `<b translate="no">${esc(d.name)}</b>${d.nickname ? `<span class="tiny" translate="no">${esc(d.nickname)}</span>` : ''}${d.d > 3 ? `<span class="pill tdepth">第 ${Number(d.d)} 層</span>` : ''}<span class="tiny">推薦了 ${k} 位</span>${d.ack == null ? '<span class="pill wait">待確認</span>' : ''}`;
      const more = k > ch.length ? `<button type="button" class="linkbtn tmore" data-fid="${esc(d.id)}">以他為中心看下一層</button>` : '';
      return ch.length || more ? `<details class="tnode" style="--d:${Number(d.d)}"${d.d === 1 ? ' open' : ''}><summary>${head}</summary>${ch.map(node).join('')}${more}</details>`
        : `<div class="tnode tleaf" style="--d:${Number(d.d)}">${head}</div>`;
    };
    const dial = n.phone ? (telOk(n.phone) ? `<span translate="no">${esc(n.phone)}</span><a class="btn ghost sm" href="${telHref(n.phone)}">撥電話</a>` : `<span translate="no">${esc(n.phone)}</span>`) : '';
    show(`<section class="card"><h3>往上：推薦人</h3><div class="refup">${upHtml}</div></section>
      <section class="card reffocus"><h3 id="rtFocusH" tabindex="-1">${refNm(n.name, n.nickname)}</h3>
        <p class="tiny" style="margin:0">${esc(n.club || '未填跑團')}・${MEMBERSHIP_NAME[n.membership] || MEMBERSHIP_NAME.none}${n.member_no ? `・編號 ${esc(n.member_no)}` : ''}</p>
        ${dial ? `<p class="row" style="margin:0;gap:8px">${dial}</p>` : ''}
        ${refPills(ref, ack, by, true) ? `<div class="row" style="gap:6px">${refPills(ref, ack, by, true)}</div>` : ''}
        ${!ro && ref ? `<div class="row" style="gap:8px">${ref.kind === 'name' ? '<button type="button" class="btn sm" id="rtRelinkOne">連到跑友帳號</button>' : ''}<button type="button" class="btn ghost sm" id="rtClear">移除推薦人</button></div>` : ''}</section>
      <section class="card"><h3>往下：推薦的跑友（${Number(n.kids) || 0} 位）</h3><div class="reftree">${(kids.get(n.id) || []).map(node).join('')}</div>
        ${t.downMore ? '<p class="tiny" style="margin:0">超過 300 位，只顯示前 300 位；點某一位以他為中心繼續看</p>' : ''}</section>`, quiet ? '' : '#rtFocusH');
  };
  // 只填名字：填了同一個名字的跑友；幹部可以勾選後一起連到某位跑友的帳號
  const named = async (name, { quiet = false } = {}) => {
    const r = await only(api(`/admin/referrals/named?name=${encodeURIComponent(name)}`));
    const ms = r.members || r.rows || [];
    cur = { kind: 'name', name };
    history.replaceState(null, '', `#/admin/tree?name=${encodeURIComponent(name)}`);
    show(`<section class="card"><h3 id="rtNameH" tabindex="-1">只填名字：<span translate="no">${esc(name)}</span></h3>
      ${ms.length ? `<div class="roster reflist">${ms.map((m) => `<div class="r${ro ? '' : ' rpick'}">${ro ? '' : `<label class="pick"><input type="checkbox" data-nid="${esc(m.id)}" checked aria-label="選取 ${esc(m.name)}"><i>${IC.check}</i></label>`}
        <span>${refNm(m.name, m.nickname)}<span class="tiny" style="display:block">${esc(m.club || '未填跑團')}・${esc(String(m.at ?? m.referrer_at ?? '').slice(0, 10))}</span>${(m.by ?? m.referrer_by) === 'admin' ? '<span class="pill">由管理員設定</span>' : ''}</span></div>`).join('')}</div>`
        : emptyState(MI.roster, '找不到符合的跑友')}
      ${!ro && ms.length ? '<button type="button" class="btn" id="rtRelink">連到跑友帳號</button>' : ''}</section>`, quiet ? '' : '#rtNameH');
  };
  const fail = (e) => toast(e.message);
  $('#rtForm').onsubmit = (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) search(q).catch(fail); };
  out.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || !out.contains(b)) return;
    if (b.dataset.fid) return focus(b.dataset.fid).catch(fail);
    if (b.dataset.fname) return named(b.dataset.fname).catch(fail);
    if (ro) return;
    if (b.id === 'rtClear' && cur?.kind === 'node') {
      const n = cur.node;
      if (!confirm('移除這位跑友的推薦人？會通知本人。')) return;   // 名字在上面的卡片標題（不放進確認文字，英文介面才翻得到）
      await once(b, async () => { try { await api('/admin/referrals/clear', { method: 'POST', body: { member_id: n.id } }); toast('已移除'); await focus(n.id); } catch (err) { fail(err); } })();
    }
    if (b.id === 'rtRelinkOne' && cur?.kind === 'node') relinkSheet(cur.ref.name, [cur.node.id], b, () => focus(cur.node.id).catch(fail));
    if (b.id === 'rtRelink' && cur?.kind === 'name') {
      const ids = [...out.querySelectorAll('[data-nid]:checked')].map((c) => c.dataset.nid);
      if (!ids.length) return;
      const name = cur.name;
      relinkSheet(name, ids, b, () => named(name).catch(fail));
    }
  });
  const id = qs.get('id'), nm = qs.get('name');
  if (id && /^[\w-]{1,32}$/.test(id)) await focus(id, { quiet: true }).catch(fail);
  else if (nm && [...nm].length <= 20) await named(nm, { quiet: true }).catch(fail);
}
// 把「只填名字」連到某位跑友的帳號：搜尋、選一位、確認後一起連；對方會收到通知，可以按「不是我」移除
function relinkSheet(name, ids, opener, after) {
  const s = openSheet('連到跑友帳號', `<h3 id="rlT">連到跑友帳號</h3>
    <form id="rlF" class="refq" role="search"><input name="q" maxlength="20" placeholder="姓名、暱稱或會員編號" aria-label="搜尋跑友" autocomplete="off" enterkeyhint="search" required><button class="btn sm">搜尋</button></form>
    <div class="roster reflist" id="rlList"></div>
    <p class="tiny" id="rlMsg" role="status" style="margin:0"></p>
    <div class="sheetacts"><button type="button" class="btn ghost" data-close>取消</button><button type="button" class="btn" id="rlGo" disabled>連結</button></div>`, opener, 'rlT');
  const h = s.host, list = h.querySelector('#rlList'), msg = h.querySelector('#rlMsg'), go = h.querySelector('#rlGo'), only = latest();
  let picked = null, found = [];
  h.querySelector('#rlF').onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim(); if (!q) return;
    try {
      const r = await only(api(`/admin/referrals?q=${encodeURIComponent(q)}`));
      found = r.members || []; picked = null; go.disabled = true; msg.textContent = '';
      list.innerHTML = found.length ? found.map((m) => `<label class="r rpick"><input type="radio" name="rlTo" value="${esc(m.id)}">
          <span>${refNm(m.name, m.nickname)}<span class="tiny" style="display:block">${esc(m.club || '未填跑團')}${m.member_no ? `・編號 ${esc(m.member_no)}` : ''}</span></span></label>`).join('')
        : emptyState(MI.roster, '找不到符合的跑友');
    } catch (err) { toast(err.message); }
  };
  list.onchange = (e) => {
    picked = found.find((m) => m.id === e.target.value); if (!picked) return;
    go.disabled = false;
    msg.innerHTML = `把 ${ids.length} 位跑友填的推薦人「<span translate="no">${esc(name)}</span>」連到 <b translate="no">${esc(picked.name)}${picked.nickname ? `（${esc(picked.nickname)}）` : ''}</b> 的帳號？對方會收到通知，可以按「不是我」移除。`;
  };
  go.onclick = once(go, async () => {
    if (!picked) return;
    try {
      const r = await api('/admin/referrals/relink', { method: 'POST', body: { name, to: picked.id, member_ids: ids } });
      s.close();
      toast(`已連結 ${Number(r.linked) || 0} 位${r.skipped ? `，${Number(r.skipped)} 位跳過（已改過或會形成循環）` : ''}`);
      after?.();
    } catch (err) { toast(err.message); }
  });
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

// ---------- 成績與挑戰（後台）：成績審核、待確認、挑戰設定與管理、團服 ----------
//   #/admin/ach（?tab=queue|met|campaigns|shirts）、#/admin/ach/new、#/admin/ach/c/<id>、#/admin/ach/c/<id>/edit
//   審核者＝有 achieve 權限、不是唯讀（預設理事長、行政人員）；監事只看挑戰清單與彙總；分團挑戰的團長／幹部只進得了挑戰管理頁（伺服器回 limited）
//   有變數的整句不寫在這裡：數字放在自己的元素裡，英文介面才翻得到；使用者內容（姓名、賽事、挑戰名稱、說明）一律 translate="no"
const achIc = (k) => ic(AR.ACH_ICONS[k] || '');
const ACH_TILE = { pb: 'orange', time: 'indigo', pace: 'green', weight: 'teal', km: 'blue', attend: 'purple' };
const achApprover = () => allow('achieve') && me.role !== 'supervisor';
const achViewer = () => achApprover() || me.role === 'supervisor';
const achToday = () => nowTp().slice(0, 10);
const achMD = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const achYMD = (d) => (d ? d.slice(0, 10).replace(/-/g, '/') : '');
const achNm = (m) => (m ? `<b translate="no">${esc(m.name)}</b>${m.nickname ? ` <span class="tiny" translate="no">${esc(m.nickname)}</span>` : ''}` : '<span class="tiny">已刪除帳號</span>');
const achTeam = (t) => (t ? `<span class="pill team" style="--tc:${esc(t.color || '#1C4698')}"><span translate="no">${esc(t.name)}</span></span>` : '');
const achN = (label, n, k = '') => `<span class="adm-ach-n"${k ? ` data-n="${k}"` : ''}><span>${label}</span> <b class="num">${Number(n) || 0}</b></span>`;
const achTile = (c) => `<span class="sic" style="--sc:var(--tile-${ACH_TILE[c.kind] || 'gray'})" aria-hidden="true">${achIc(AR.KIND_ICON[c.kind])}</span>`;
const achWho = (c) => (c.team ? achTeam(c.team) : `<span class="pill">${c.members_only ? '協會會員' : '全協會'}</span>`);
const achPeriod = (c) => `<span class="num">${achMD(c.start_date)}–${achMD(c.end_date)}</span>`;
const ACH_STATUS = { draft: '草稿', open: '進行中', settled: '已結算', cancelled: '已取消' };
const ACH_PILL = { 草稿: 'pill wait', 即將開始: 'pill', 進行中: 'pill solid', 結算中: 'pill wait', 已結算: 'pill', 已取消: 'pill reg-cancelled' };
const achPhase = (c, today = achToday()) => (c.status !== 'open' ? ACH_STATUS[c.status] || '' : today < c.start_date ? '即將開始' : today > c.end_date ? '結算中' : '進行中');
const achPhasePill = (c) => { const p = achPhase(c); return `<span class="${ACH_PILL[p] || 'pill'}">${p}</span>`; };
const ACH_ENTRY = { joined: '已參加', met: '待確認', achieved: '已達成', not_met: '沒有達成', rejected: '已退回', revoked: '已撤銷', left: '已退出', ended: '已結束' };
const ACH_ENTRY_PILL = { met: 'pill wait', achieved: 'pill solid', not_met: 'pill', rejected: 'pill reg-cancelled', revoked: 'pill reg-cancelled', left: 'pill', ended: 'pill', joined: 'pill' };
const ACH_REWARD = { granted: '待發放', waitlist: '候補', issued: '已發放', declined: '不需要', dup: '同款已拿' };
const PB_FILTER = { pending: '待審核', approved: '已核准', rejected: '已婉拒', revoked: '已撤銷' };
const PB_EMPTY = { pending: '目前沒有待審核的成績', approved: '沒有已核准的成績', rejected: '沒有已婉拒的成績', revoked: '沒有已撤銷的成績' };
const PB_REJECT = ['連結打不開', '成績或姓名對不上', '同一場已經登錄過', '截圖看不清楚', '其他'];
const ACH_REJECT = ['紀錄有疑問', '沒有見到本人', '不符合挑戰資格', '其他'];
const ACH_REVOKE = ['成績有誤', '不是本人', '其他'];
// 原因代碼：選了常用原因（chip）就用它的代碼，自己寫的一律 other；稽核只存代碼
const achReason = (note) => Object.keys(ACH_REASON).find((k) => ACH_REASON[k] === note) || 'other';
const achRules = (c) => { try { return AR.ruleLines(c); } catch { return []; } };
const achRulesHtml = (c) => `<ul class="adm-ach-rules">${achRules(c).map((l, i) => `<li>${i ? esc(l) : `<b>${esc(l)}</b>`}</li>`).join('')}</ul>`;
const achFail = (box, title, msg) => { box.innerHTML = `${largeTitle(title)}<div class="card"><p class="muted">${esc(msg)}</p></div>`; };
const achFade = (el, done) => { if (matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; } el.classList.add('adm-ach-out'); setTimeout(done, 240); };
let achSeq = 0;
const achUrls = new Set();   // 截圖的 blob 網址：重畫或換頁時收回
const achDropUrls = () => { for (const u of achUrls) URL.revokeObjectURL(u); achUrls.clear(); };

async function achAdminView(sub, id) {
  achDropUrls();
  const title = sub === 'new' ? '新增挑戰' : sub === 'edit' ? '修改挑戰' : sub === 'c' ? '挑戰管理' : '成績與挑戰';
  if (me.mfaPending) { view.innerHTML = `${largeTitle(title)}${mfaBanner()}`; bindStepup(); return; }
  if (sub === 'new' || sub === 'edit') return achEditView(sub === 'edit' ? id : null);
  if (sub === 'c') return achCampView(id);
  return achHomeView();
}

// ---- 首頁：成績審核｜待確認｜挑戰｜團服（監事只有挑戰）----
const ACH_TAB = { queue: '成績審核', met: '待確認', campaigns: '挑戰', shirts: '團服' };
async function achHomeView() {
  const my = ++achSeq, appr = achApprover();
  if (!achViewer()) { achFail(view, '成績與挑戰', '只有理事長與行政人員可以管理挑戰'); return; }
  const tabs = appr ? ['queue', 'met', 'campaigns', 'shirts'] : ['campaigns'];
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
  let data, pend;
  try { [data, pend] = await Promise.all([api('/admin/ach'), appr ? api('/admin/pb?status=pending') : null]); }
  catch (e) { if (my === achSeq) achFail(view, '成績與挑戰', e.message); return; }
  if (my !== achSeq || !/^#\/admin\/ach(\?|$)/.test(location.hash)) return;   // 等資料的時候已經換頁
  const counts = { queue: (pend?.items || []).length, met: (data.met || []).length };
  const badge = (k) => (k in counts ? ` <span class="adm-ach-badge num" data-achcnt="${k}"${counts[k] ? '' : ' hidden'}>${counts[k]}${k === 'queue' && pend?.next ? '+' : ''}</span>` : '');
  view.innerHTML = `${largeTitle('成績與挑戰', appr ? '審核成績、設定挑戰與團服' : '挑戰與團服的統計')}
    ${appr && data.meta?.approvers === 1 ? '<p class="notice">目前只有你一位審核者，你自己的成績要等指派行政人員後才能審核</p>' : ''}
    ${appr ? '' : '<p class="tiny">監事只能看挑戰清單與彙總數字，看不到成績與名單。</p>'}
    ${tabs.length > 1 ? `<div class="seg adm-ach-seg" role="group" aria-label="成績與挑戰分頁">${tabs.map((k) => `<button type="button" data-achtab="${k}"><span>${ACH_TAB[k]}</span>${badge(k)}</button>`).join('')}</div>` : ''}
    <div id="achPanel"></div>`;
  const ctx = {
    data,
    count(k, d) {
      counts[k] = Math.max(0, counts[k] + d);
      const b = view.querySelector(`[data-achcnt="${k}"]`);
      if (b) { b.textContent = counts[k]; b.hidden = !counts[k]; }
    },
  };
  const show = (k) => {
    for (const b of view.querySelectorAll('[data-achtab]')) b.setAttribute('aria-pressed', String(b.dataset.achtab === k));
    history.replaceState(null, '', `#/admin/ach${k === tabs[0] ? '' : `?tab=${k}`}`);
    achDropUrls();
    const panel = $('#achPanel');
    if (k === 'queue') return achQueue(panel, ctx);
    if (k === 'met') return achMetPanel(panel, ctx);
    if (k === 'shirts') return achShirtsPanel(panel, ctx);
    return achCampsPanel(panel, ctx);
  };
  for (const b of view.querySelectorAll('[data-achtab]')) b.onclick = () => { if (b.getAttribute('aria-pressed') !== 'true') show(b.dataset.achtab); };
  await show(tabs.includes(want) ? want : tabs[0]);
}

// ---- 成績審核 ----
async function achProofUrl(id) {
  const r = await fetch(`/api/pb/${encodeURIComponent(id)}/proof`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '截圖已刪除');
  const u = URL.createObjectURL(await r.blob());
  achUrls.add(u);
  return u;
}
// 縮圖：捲到看得到才讀（每張一次請求，不一次讀 50 張）
function achThumbs(root) {
  const load = async (b) => {
    try { const u = await achProofUrl(b.dataset.proof); if (!b.isConnected) return; b.dataset.url = u; b.insertAdjacentHTML('afterbegin', `<img src="${u}" alt="">`); b.classList.add('has'); }
    catch { b.classList.add('gone'); }
  };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); load(e.target); } }, { rootMargin: '200px' }) : null;
  for (const b of root.querySelectorAll('[data-proof]:not([data-seen])')) { b.dataset.seen = '1'; if (io) io.observe(b); else load(b); }
}
// 全螢幕看截圖：Esc 或「關閉」關掉，焦點回到縮圖
async function achProof(b) {
  let u = b.dataset.url;
  try { u ||= await achProofUrl(b.dataset.proof); } catch (e) { toast(e.message); return; }
  const s = openSheet('成績截圖', `<div class="row spread"><h3 id="achPvT">成績截圖</h3><button type="button" class="btn ghost sm" data-close>關閉</button></div>
    <img class="adm-ach-full" src="${u}" alt="成績截圖">`, b, 'achPvT');
  s.host.classList.add('adm-ach-viewer');
}
const achHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const achUrlOk = (u) => /^https:\/\/[^\s<>"]+$/i.test(u || '');   // 伺服器已經檢查過；畫面上再擋一次，不是 https 的不做成連結
function achPbCard(x, st) {
  const self = x.member?.id === me.id, km = AR.kmOf(x.dist_key, x.km) || x.km;
  const cmp = st === 'approved' || st === 'revoked' ? ''
    : x.current_best == null ? '<p class="adm-ach-cmp"><span class="pill">這個距離的第一筆</span></p>'
    : x.seconds < x.current_best ? `<p class="adm-ach-cmp good"><span>比目前 PB 快</span> <b class="num">${AR.fmtTime(x.current_best - x.seconds)}</b></p>`
    : x.seconds === x.current_best ? '<p class="adm-ach-cmp"><span>和目前 PB 一樣，不會刷新 PB</span></p>'
    : `<p class="adm-ach-cmp"><span>比目前 PB 慢</span> <b class="num">${AR.fmtTime(x.seconds - x.current_best)}</b>・<span>不會刷新 PB</span></p>`;
  const acts = self ? `<p class="tiny">${st === 'pending' ? '這是你自己的成績，要由另一位審核者審核' : '這是你自己的成績'}</p>`
    : st === 'pending' ? '<button type="button" class="btn sm" data-pbact="approve">核准</button><button type="button" class="btn ghost sm" data-pbact="reject">婉拒</button>'
    : st === 'approved' ? '<button type="button" class="btn ghost sm" data-pbact="revoke">撤銷</button>'
    : st === 'rejected' ? '<button type="button" class="btn ghost sm" data-pbact="approve">改判核准</button>' : '';
  const url = achUrlOk(x.result_url) ? x.result_url : '', host = url ? achHost(url) : '';
  return `<article class="card adm-ach-pb" data-pb="${esc(x.id)}" data-name="${esc(x.member?.name || '')}">
    <div class="adm-ach-who">${avatar(x.member || {})}<span>${achNm(x.member)} ${achTeam(x.member?.team)}
      <span class="tiny" style="display:block"><span>送出於</span> <span>${ago(x.created_at)}</span>${x.edited ? '・<span>送出後改過</span>' : ''}</span></span></div>
    <p class="adm-ach-res"><span class="pill">${esc(AR.distLabel(x.dist_key, x.km))}</span> <b class="num adm-ach-time">${AR.fmtTime(x.seconds)}</b>
      <span class="tiny"><span>配速</span> <span class="num">${km ? AR.fmtPace(x.seconds, km) : ''}</span></span></p>
    <p class="adm-ach-race"><span translate="no">${esc(x.race_name)}</span>・<span class="num">${achYMD(x.race_date)}</span>${x.bib ? `・<span>號碼布</span> <span class="num" translate="no">${esc(x.bib)}</span>` : ''}</p>
    ${cmp}
    ${url || x.proof ? `<div class="adm-ach-proofrow">
      ${url ? `<a class="adm-ach-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><b translate="no">${esc(host)}</b><span>開官方成績 ›</span></a>` : ''}
      ${x.proof ? `<button type="button" class="adm-ach-thumb" data-proof="${esc(x.id)}" aria-label="看截圖：${esc(x.member?.name || '')}">${achIc('image')}</button>` : ''}</div>` : ''}
    ${!x.proof && !x.result_url && st === 'pending' ? '<p class="notice">截圖已過期，可以婉拒請跑友重新附上</p>' : x.proof && !x.result_url ? '<p class="tiny">只有截圖、沒有官方連結</p>' : ''}
    ${x.note ? `<p class="tiny"><span>說明：</span><span translate="no">${esc(x.note)}</span></p>` : ''}
    ${st !== 'pending' && x.review_at ? `<p class="tiny">${x.review_by_name ? `<span translate="no">${esc(x.review_by_name)}</span>・` : ''}<span>${PB_FILTER[st] || ''}</span>・<span class="num">${achYMD(x.review_at)}</span>${x.review_note ? `・<span>原因：</span><span translate="no">${esc(x.review_note)}</span>` : ''}</p>` : ''}
    ${acts ? `<div class="row adm-ach-acts">${acts}</div>` : ''}
  </article>`;
}
async function achQueue(panel, ctx) {
  let st = 'pending', q = '', next = null;
  panel.innerHTML = `<div class="seg adm-ach-filter" role="group" aria-label="成績狀態">${Object.entries(PB_FILTER).map(([k, v]) => `<button type="button" data-pbst="${k}" aria-pressed="${k === st}">${v}</button>`).join('')}</div>
    <form class="adm-ach-search" id="achPbQ" role="search" data-live="empty"><input name="q" maxlength="20" placeholder="搜尋姓名" aria-label="搜尋姓名" autocomplete="off" enterkeyhint="search"><button class="btn ghost sm">搜尋</button></form>
    <div class="adm-ach-list" id="achPbList"></div>`;
  const list = $('#achPbList'), only = latest();
  const empty = () => { if (!list.querySelector('.adm-ach-pb')) list.innerHTML = `<section class="card">${emptyState(achIc('trophy'), q ? '找不到符合的成績' : PB_EMPTY[st])}</section>`; };
  // 載入更多：按鈕會被移掉，焦點移到新的第一張卡片（VoiceOver 與鍵盤不會跳回頁首）
  const load = async (more) => {
    const r = await only(api(`/admin/pb?${new URLSearchParams({ status: st, ...(q ? { q } : {}), ...(more && next ? { before: next } : {}) })}`));
    next = r.next || null;
    const n0 = list.querySelectorAll('.adm-ach-pb').length;
    list.querySelector('.adm-ach-more')?.remove();
    if (!more) achDropUrls();
    if (!more) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', (r.items || []).map((x) => achPbCard(x, st)).join(''));
    empty();
    if (next) list.insertAdjacentHTML('beforeend', '<button type="button" class="btn ghost sm block adm-ach-more">載入更多</button>');
    achThumbs(list);
    if (more) focusEl(list.querySelectorAll('.adm-ach-pb')[n0] || list.querySelector('.adm-ach-more') || [...list.querySelectorAll('.adm-ach-pb')].pop());
  };
  for (const b of panel.querySelectorAll('[data-pbst]')) b.onclick = () => {
    st = b.dataset.pbst;
    for (const x of panel.querySelectorAll('[data-pbst]')) x.setAttribute('aria-pressed', String(x === b));
    load(false).catch((e) => toast(e.message));
  };
  $('#achPbQ').onsubmit = (e) => { e.preventDefault(); q = e.target.q.value.trim(); load(false).catch((err) => toast(err.message)); };
  // 處理完：卡片淡出（減少動態時直接移除），焦點移到下一筆
  const drop = (card) => {
    const nb = [card.nextElementSibling, card.previousElementSibling].find((x) => x?.matches('.adm-ach-pb'));
    achFade(card, () => { card.remove(); empty(); focusEl(nb || list.querySelector('.empty') || view.querySelector('h1')); });
  };
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || !list.contains(b)) return;
    if (b.classList.contains('adm-ach-more')) { load(true).catch((err) => toast(err.message)); return; }
    if (b.dataset.proof) { achProof(b); return; }
    const card = b.closest('[data-pb]'), act = b.dataset.pbact; if (!card || !act) return;
    const pid = card.dataset.pb, who = card.dataset.name;
    let body;
    if (act === 'reject' || act === 'revoke') {
      const r = await askReason(act === 'reject' ? '婉拒這筆成績' : '撤銷這筆成績', act === 'reject' ? { who, chips: PB_REJECT, max: ACH_NOTE_MAX }
        : { who, chips: ACH_REVOKE, ok: '撤銷', max: ACH_NOTE_MAX, lines: ['用這筆成績完成的挑戰會重新判定；有別筆符合的成績就維持達成。已發放的團服保留發放紀錄'] });
      if (!r) return;
      body = { note: r.note, code: achReason(r.note) };
      if (act === 'reject') body.approve = false;
    } else body = { approve: true };
    await once(b, async () => {
      try {
        const r = await api(`/admin/pb/${encodeURIComponent(pid)}/${act === 'revoke' ? 'revoke' : 'review'}`, { method: 'POST', body });
        if (act === 'approve' && (r.achieved || []).length) {
          const n = document.createElement('span');
          n.innerHTML = `<span>已核准，同時完成挑戰：</span><span translate="no">${r.achieved.map((a) => esc(a.title)).join('、')}</span>`;
          toast(n);
        } else toast(act === 'approve' ? '已核准' : act === 'reject' ? '已婉拒' : '已撤銷');
        if (st === 'pending') ctx.count('queue', -1);
        drop(card);
      } catch (err) { toast(err.message); }
    })();
  });
  await load(false).catch((e) => { list.innerHTML = `<section class="card"><p class="muted">${esc(e.message)}</p></section>`; });
}

// ---- 待確認（里程挑戰，以及挑戰發布後刪過開始前成績的跑友；榮譽制體重直接達成、不進這裡）----
const ACH_BASE_DEL = '本人在挑戰發布後刪除過挑戰開始前的成績，比較基準可能變慢了。請跟本人確認以前的成績後再確認。';
const ACH_NOTE_MAX = 100;   // 婉拒、撤銷、退回、取消的原因：伺服器存 100 字
const achPbLine = (p) => `<p class="adm-ach-res"><span class="pill">${esc(AR.distLabel(p.dist_key, p.km))}</span> <b class="num adm-ach-time">${AR.fmtTime(p.seconds)}</b></p>
  <p class="adm-ach-race"><span translate="no">${esc(p.race_name)}</span>・<span class="num">${achYMD(p.race_date)}</span></p>`;
function achMetCard(x) {
  const self = x.member?.id === me.id;
  return `<article class="card adm-ach-met" data-eid="${esc(x.eid)}" data-cid="${esc(x.cid)}" data-name="${esc(x.member?.name || '')}">
    <div class="adm-ach-who">${avatar(x.member || {})}<span>${achNm(x.member)} ${achTeam(x.member?.team)}
      <a class="tiny tlink" style="display:block" href="#/admin/ach/c/${esc(x.cid)}" translate="no">${esc(x.title)}</a></span></div>
    ${x.pb ? achPbLine(x.pb) : x.evidence ? `<p class="adm-ach-res"><span>累積</span> <b class="num adm-ach-time">${esc(x.evidence)}</b> <span>公里</span></p>` : ''}
    ${x.base_del ? `<p class="tiny adm-ach-warn"><span>${ACH_BASE_DEL}</span></p>` : ''}
    <p class="tiny"><span>系統判定達成：</span><span class="num">${achMD(x.met_at)}</span></p>
    <button type="button" class="linkbtn" data-src>${x.kind === 'km' ? '查看紀錄來源 ›' : '細節 ›'}</button>
    <div class="row adm-ach-acts">${self ? '<p class="tiny">這是你自己的達成，要由另一位審核者確認</p>'
      : '<button type="button" class="btn sm" data-metact="ok">確認達成</button><button type="button" class="btn ghost sm" data-metact="no">退回這筆</button>'}</div>
  </article>`;
}
function achMetPanel(panel, ctx) {
  const rows = ctx.data.met || [];
  const empty = () => `<section class="card">${emptyState(achIc('calcheck'), '目前沒有待確認的達成')}</section>`;
  panel.innerHTML = `<p class="tiny">里程挑戰由系統判定達成後，要幹部看過紀錄來源再確認；挑戰發布後刪過開始前成績的跑友也要確認（比較基準可能變了）。確認前名額先保留。</p>
    <div class="adm-ach-list" id="achMetList">${rows.length ? rows.map(achMetCard).join('') : empty()}</div>`;
  const list = $('#achMetList');
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const card = b.closest('[data-eid]'); if (!card) return;
    const { eid, cid, name } = card.dataset;
    if (b.hasAttribute('data-src')) { achSourceSheet(cid, eid, b); return; }
    const ok = b.dataset.metact === 'ok';
    let body = { approve: true };
    if (!ok) {
      const r = await askReason('退回這筆達成', { who: name, chips: ACH_REJECT, ok: '退回這筆', max: ACH_NOTE_MAX });
      if (!r) return;
      body = { approve: false, note: r.note, code: achReason(r.note) };
    }
    await once(b, async () => {
      try {
        await api(`/admin/ach/${encodeURIComponent(cid)}/entries/${encodeURIComponent(eid)}/confirm`, { method: 'POST', body });
        toast(ok ? '已確認達成' : '已退回');
        ctx.data.met = (ctx.data.met || []).filter((x) => x.eid !== eid);
        ctx.count('met', -1);
        const nb = [card.nextElementSibling, card.previousElementSibling].find((x) => x?.matches('.adm-ach-met'));
        achFade(card, () => { card.remove(); if (!list.querySelector('.adm-ach-met')) list.innerHTML = empty(); focusEl(nb || list.querySelector('.empty')); });
      } catch (err) { toast(err.message); }
    })();
  });
}
// 達成的細節（A11）：里程的紀錄來源與可疑訊號、出席的場次、成績、體重只有見證時間（不含數字、不含有沒有達成）
const ACH_SRC = { gps: 'GPS 跑步', health: 'Apple 健康', file: 'GPX 檔', manual: '手動' };
async function achSourceSheet(cid, eid, opener) {
  let r;
  try { r = await api(`/admin/ach/${encodeURIComponent(cid)}/entries/${encodeURIComponent(eid)}`); } catch (e) { toast(e.message); return; }
  const d = r.detail || {}, itr = (label, v, warn = false) => `<div class="itr${warn ? ' adm-ach-warn' : ''}"><span>${label}</span><b class="num">${v}</b></div>`;
  let body = '';
  if (d.total != null || d.by_source) {
    const src = d.by_source || {};
    body = `<div class="itemtable">${itr('期間累積', `${esc(d.total ?? 0)} 公里`)}${itr('紀錄筆數', Number(d.logs) || 0)}${itr('單筆最多', `${esc(d.max ?? 0)} 公里`, Number(d.max) > 60)}
        ${itr('結束後才補記（不算）', Number(d.late) || 0, Number(d.late) > 0)}${itr('補記超過 7 天前的', Number(d.backfilled) || 0, Number(d.backfilled) > 0)}</div>
      <table class="adm-ach-tbl"><caption>紀錄來源</caption><thead><tr><th scope="col">來源</th><th scope="col">筆數</th><th scope="col">公里</th></tr></thead>
        <tbody>${Object.entries(ACH_SRC).map(([k, v]) => `<tr><th scope="row">${v}</th><td class="num">${Number(src[k]?.n) || 0}</td><td class="num">${esc(src[k]?.km ?? 0)}</td></tr>`).join('')}</tbody></table>
      <p class="tiny">單筆超過 60 公里、補記很久以前的紀錄，可以先請本人說明再確認。</p>`;
  } else if (d.events) {
    body = d.events.length ? `<div class="itemtable">${d.events.map((ev) => `<div class="itr"><span translate="no">${esc(ev.title)}</span><b class="num">${achYMD(ev.date)}</b></div>`).join('')}</div>`
      : '<p class="tiny">沒有出席紀錄</p>';
  } else if ('pb' in d) {
    const p = d.pb;
    body = `${p ? `${achPbLine(p)}
      ${achUrlOk(p.result_url) ? `<a class="adm-ach-link" href="${esc(p.result_url)}" target="_blank" rel="noopener noreferrer"><b translate="no">${esc(achHost(p.result_url))}</b><span>開官方成績 ›</span></a>` : ''}`
      : '<p class="tiny">找不到這筆成績</p>'}
      ${d.base_del ? `<p class="tiny adm-ach-warn"><span>${ACH_BASE_DEL}</span></p>` : ''}`;
  } else if (d.verify) {
    body = `<div class="itemtable">${itr('起始量測', d.w_base_at ? '已見證' : '還沒見證')}${itr('結束量測', d.w_last_at ? '已見證' : '還沒見證')}</div>
      <p class="tiny">體重不會顯示在這裡，也看不到有沒有達成。</p>`;
  }
  openSheet('達成的細節', `<div class="row spread"><h3 id="achSrcT">達成的細節</h3><button type="button" class="btn ghost sm" data-close>關閉</button></div>
    <p style="margin:0">${achNm(r.member)}</p>${body || '<p class="tiny">沒有細節</p>'}`, opener, 'achSrcT');
}

// ---- 挑戰清單 ----
function achCampCard(c) {
  const s = c.stats || {}, shirt = c.rewards?.shirt;
  return `<a class="card adm-ach-camp" href="#/admin/ach/c/${esc(c.id)}">${achTile(c)}
    <span class="adm-ach-cbody"><b translate="no">${esc(c.title)}</b>
      <span class="tiny"><span>${esc(AR.KIND_ZH[c.kind] || '')}</span>・${achPeriod(c)}</span>
      <span class="adm-ach-pills">${achPhasePill(c)}${achWho(c)}</span>
      ${c.status === 'draft' ? '' : `<span class="adm-ach-stats">${achN('參加', s.joined)}${achN('達成', (s.done || 0) - (s.met || 0))}${s.met ? achN('待確認', s.met) : ''}</span>`}
      ${shirt && c.status !== 'draft' ? `<span class="adm-ach-stats"><span>團服</span>${achN('已給', s.granted)}${achN('候補', s.waitlist)}${achN('已發', s.issued)}</span>` : ''}</span>
    <span class="chev" aria-hidden="true"></span></a>`;
}
function achCampsPanel(panel, ctx) {
  const cs = ctx.data.campaigns || [];
  const groups = [['進行中', (c) => c.status === 'open'], ['草稿', (c) => c.status === 'draft'], ['已結算', (c) => c.status === 'settled'], ['已取消', (c) => c.status === 'cancelled']];
  // 功能開關關著：伺服器不讓新增與發布（進行中的照樣結算），按鈕先拿掉、說明原因
  const add = !achApprover() ? '' : featOn('achieve') ? '<div class="row"><a class="btn" href="#/admin/ach/new">新增挑戰</a></div>'
    : '<p class="notice">「成績與挑戰」的功能開關關著：不能新增或發布挑戰；進行中的挑戰照樣結算，團服照樣發放</p>';
  panel.innerHTML = `${add}
    ${groups.map(([g, f]) => { const xs = cs.filter(f); return xs.length ? `<section class="adm-ach-group"><h2 class="sgt">${g}</h2>${xs.map(achCampCard).join('')}</section>` : ''; }).join('')
      || `<section class="card">${emptyState(achIc('trophy'), '還沒有挑戰')}</section>`}`;
}

// ---- 團服：有團服的挑戰、尺寸統計、兩種 CSV、提醒選尺寸 ----
const achSizes = (sizes, order) => {
  const keys = [...new Set([...(order || []), ...Object.keys(sizes || {})])].filter((z) => (sizes || {})[z]);
  return keys.length ? keys.map((z) => `<span class="adm-ach-size"><span translate="no">${esc(z)}</span> <b class="num">${Number(sizes[z]) || 0}</b></span>`).join('') : '<span class="tiny">還沒有人選尺寸</span>';
};
const achCsv = (c) => `<div class="row adm-ach-csv"><a class="btn ghost sm" href="/api/admin/ach/${esc(c.id)}/shirts.csv?view=order" download>下載訂製統計（CSV）</a>
    <a class="btn ghost sm" href="/api/admin/ach/${esc(c.id)}/shirts.csv?view=list" download>下載發放名單（CSV）</a></div>
  <p class="tiny">訂製統計只有尺寸與件數，可以給廠商；發放名單是協會內部用，不要轉給廠商</p>`;
async function achShirtsPanel(panel, ctx) {
  const cs = (ctx.data.campaigns || []).filter((c) => c.rewards?.shirt && ['open', 'settled'].includes(c.status));
  if (!cs.length) { panel.innerHTML = `<section class="card">${emptyState(achIc('shirt'), '還沒有送團服的挑戰')}</section>`; return; }
  panel.innerHTML = cs.map((c, i) => { const s = c.stats || {};
    return `<section class="card adm-ach-shirt" data-cid="${esc(c.id)}">
      <div class="row spread"><a class="tlink" href="#/admin/ach/c/${esc(c.id)}"><b translate="no">${esc(c.title)}</b></a>${achPhasePill(c)}</div>
      <div class="adm-ach-sizes" data-sizes>${i < 8 ? '<span class="tiny">載入中…</span>' : `<a class="tiny tlink" href="#/admin/ach/c/${esc(c.id)}">點進挑戰看尺寸統計 ›</a>`}</div>
      <p class="adm-ach-stats">${achN('已給', s.granted)}${achN('候補', s.waitlist)}${achN('已發', s.issued)}${achN('未選尺寸', s.unsized)}</p>
      ${achCsv(c)}
      ${c.status === 'settled' ? `<button type="button" class="btn ghost sm" data-remind ${s.unsized ? '' : 'disabled'}>提醒還沒選尺寸的人</button>` : '<p class="tiny">挑戰結算後才分配名額</p>'}
    </section>`; }).join('');
  for (const b of panel.querySelectorAll('[data-remind]')) b.onclick = once(b, async () => {
    try { const r = await api(`/admin/ach/${encodeURIComponent(b.closest('[data-cid]').dataset.cid)}/remind-size`, { method: 'POST', body: {} }); toast(`已提醒 ${Number(r.n) || 0} 人`); }
    catch (e) { toast(e.message); }
  });
  // 尺寸統計：每場讀一次團服名單（最多 8 場，其他的連到挑戰頁看；名單本身不畫在這裡）
  await Promise.all(cs.slice(0, 8).map(async (c) => {
    const r = await api(`/admin/ach/${encodeURIComponent(c.id)}/entries?state=shirt`).catch(() => null);
    const box = panel.querySelector(`[data-cid="${CSS.escape(c.id)}"] [data-sizes]`);
    if (box) box.innerHTML = r ? achSizes(r.sizes, c.rewards.shirt.sizes) : '<span class="tiny">讀不到尺寸統計</span>';
  }));
}

// ---- 一行文字的面板（取消原因、領取方式）：askReason 的說明是「原因只有本人看得到」，這兩個是給所有人看的，另外做 ----
function achAskText(title, { lines = [], label, max, ok, required = false, hint = '' }) {
  return new Promise((done) => {
    let val = null;
    const s = openSheet(title, `<h3 id="achAskT">${esc(title)}</h3>${lines.map((x) => `<p class="muted" style="margin:0">${esc(x)}</p>`).join('')}
      <form id="achAskF"><label>${esc(label)}<textarea name="t" rows="2" maxlength="${max}" ${required ? 'required' : ''}${hint ? ' aria-describedby="achAskH"' : ''}></textarea></label>
      ${hint ? `<p class="tiny" id="achAskH" style="margin:0">${esc(hint)}</p>` : ''}
      <div class="sheetacts"><button type="button" class="btn ghost" data-close>取消</button><button class="btn">${esc(ok)}</button></div></form>`,
    document.activeElement, 'achAskT', { onClose: () => done(val) });
    s.host.querySelector('textarea').focus();
    s.host.querySelector('#achAskF').onsubmit = (e) => { e.preventDefault(); const t = e.target.t.value.trim(); if (required && !t) return; val = t.slice(0, max); s.close(); };
  });
}

// ---- 挑戰管理：名單、確認與撤銷、團服發放（就地更新）、CSV、提醒與通知、見證體重 ----
let achCampState = { id: '', f: 'all', q: '' };   // 重畫（確認、撤銷後）保留篩選與搜尋
const ACH_FILTERS = { all: '全部', met: '待確認', achieved: '達成', not_met: '沒有達成', shirt: '團服' };
async function achCampView(id) {
  const my = ++achSeq, appr = achApprover(), viewer = achViewer();
  if (achCampState.id !== id) achCampState = { id, f: 'all', q: '' };
  let list = null, ent = null;
  try {
    [list, ent] = await Promise.all([viewer ? api('/admin/ach') : null,
      appr || !viewer ? api(`/admin/ach/${encodeURIComponent(id)}/entries?state=all`) : null]);
  } catch (e) { if (my === achSeq) achFail(view, '挑戰管理', e.message); return; }
  if (my !== achSeq || location.hash.split('?')[0] !== `#/admin/ach/c/${id}`) return;
  const c = ent?.campaign || (list?.campaigns || []).find((x) => x.id === id);
  if (!c) { achFail(view, '挑戰管理', '找不到這個挑戰'); return; }
  const stats = (list?.campaigns || []).find((x) => x.id === id)?.stats || null;
  const limited = !!ent?.limited, weight = c.kind === 'weight', shirt = c.rewards?.shirt || null;
  const rows = ent?.entries || [];
  const today = achToday();
  const canIssue = !!shirt && (appr || limited);
  const witness = weight && c.opts?.verify === 'witness' && c.status === 'open' && (appr || limited);
  const filters = limited ? [] : Object.keys(ACH_FILTERS).filter((k) => (k === 'shirt' ? !!shirt : !weight || k === 'all'));
  if (!filters.includes(achCampState.f)) achCampState.f = 'all';
  const s = stats || {};
  const kpis = stats ? `<div class="adm-ach-stats adm-ach-kpis">${achN('參加', s.joined, 'joined')}${achN('達成', (s.done || 0) - (s.met || 0), 'done')}${weight ? '' : achN('待確認', s.met, 'met') + achN('沒有達成', s.not_met, 'not_met')}</div>
      ${shirt ? `<div class="adm-ach-stats adm-ach-kpis"><span>團服</span>${achN('已給', s.granted, 'granted')}${achN('候補', s.waitlist, 'waitlist')}${achN('已發', s.issued, 'issued')}</div>` : ''}` : '';
  const acts = !appr ? '' : c.status === 'draft' ? `<a class="btn sm" href="#/admin/ach/c/${esc(id)}/edit">編輯</a><button type="button" class="btn sm" id="achOpen">發布</button><button type="button" class="btn ghost sm" id="achDel">刪除草稿</button>`
    : c.status === 'open' ? `<a class="btn ghost sm" href="#/admin/ach/c/${esc(id)}/edit">編輯</a><button type="button" class="btn ghost sm" id="achCancel">取消挑戰</button>`
    : c.status === 'settled' ? `<a class="btn ghost sm" href="#/admin/ach/c/${esc(id)}/edit">編輯</a>` : '';
  view.innerHTML = `${largeTitle('挑戰管理')}
    <section class="card adm-ach-head">
      <div class="adm-ach-htop">${achTile(c)}<div><h2 class="h3" translate="no">${esc(c.title)}</h2><div class="adm-ach-pills">${achPhasePill(c)}${achWho(c)}<span class="pill">${esc(AR.KIND_ZH[c.kind] || '')}</span></div></div></div>
      ${achRulesHtml(c)}
      <p class="tiny">${achPeriod(c)}・<span>報名截止</span> <span class="num">${achMD(c.join_by)}</span></p>
      ${c.status === 'cancelled' && c.cancel_note ? `<p class="tiny"><span>取消原因：</span><span translate="no">${esc(c.cancel_note)}</span></p>` : ''}
      ${acts ? `<div class="row adm-ach-acts">${acts}</div>` : ''}
    </section>
    ${kpis}
    ${limited ? '<p class="tiny">分團幹部只看得到有團服名額的團員：可以勾「已發放」、掃會籍卡找人、通知領取。</p>' : ''}
    ${weight ? `<p class="tiny">${limited ? '體重挑戰只列出有團服名額的人。' : '體重挑戰不顯示誰有沒有達成，只看得到見證進度與團服；體重數字只有本人看得到。'}</p>` : ''}
    ${witness ? '<button type="button" class="btn ghost sm" id="achWit">見證體重量測</button>' : ''}
    ${shirt ? achShirtBox(c, ent, appr, limited, today) : ''}
    ${ent ? `<section class="card adm-ach-roster">
      <div class="row spread"><h3>名單</h3>${canIssue && c.status === 'settled' ? '<button type="button" class="btn ghost sm" id="achScanCard">掃會籍卡</button>' : ''}</div>
      ${filters.length > 1 ? `<div class="seg adm-ach-filter" role="group" aria-label="名單篩選">${filters.map((k) => `<button type="button" data-ef="${k}" aria-pressed="${k === achCampState.f}">${ACH_FILTERS[k]}</button>`).join('')}</div>` : ''}
      <input type="search" class="adm-ach-q" id="achEq" maxlength="20" placeholder="搜尋姓名" aria-label="搜尋姓名" autocomplete="off" value="${esc(achCampState.q)}">
      <div class="roster" id="achRoster">${rows.map((x) => achEntryRow(x, c, { appr, limited, canIssue })).join('')}</div>
      <p class="tiny" id="achNone" hidden>沒有符合的跑友</p>
    </section>` : viewer ? '<p class="tiny">監事看不到名單。</p>' : ''}`;
  bindAchCamp(c, { appr, limited, rows, stats });
}
function achShirtBox(c, ent, appr, limited, today) {
  const sh = c.rewards.shirt, settled = c.status === 'settled';
  return `<section class="card adm-ach-shirtbox"><h3>團服</h3>
    <p class="tiny">${sh.quota ? `<span>名額</span> <b class="num">${Number(sh.quota)}</b>` : '<span>不限量</span>'}${sh.size_by ? `・<span>尺寸選到</span> <span class="num">${achMD(sh.size_by)}</span>` : ''}${sh.pool ? `・<span>同款團服</span> <span translate="no">${esc(sh.pool)}</span>` : ''}</p>
    ${ent ? `<div class="adm-ach-sizes">${achSizes(ent.sizes, sh.sizes)}</div><p class="adm-ach-stats">${achN('未選尺寸', ent.unsized)}</p>` : ''}
    ${c.pickup ? `<p class="tiny"><span>領取方式：</span><span translate="no">${esc(c.pickup)}</span></p>` : ''}
    ${appr ? achCsv(c) : ''}
    ${!settled ? '<p class="tiny">挑戰結算後依達成先後分配名額，才能提醒選尺寸與通知領取。</p>' : appr || limited ? `<div class="row adm-ach-acts">
      ${appr ? `<button type="button" class="btn ghost sm" id="achRemind" ${ent?.unsized ? '' : 'disabled'}>提醒還沒選尺寸的人</button>` : ''}
      <button type="button" class="btn ghost sm" id="achPickup">通知領取</button>
      ${appr && sh.size_by && today > sh.size_by ? '<button type="button" class="btn ghost sm" id="achRelease">把還沒選尺寸的名額讓給候補</button>' : ''}</div>` : ''}
  </section>`;
}
function achEntryRow(x, c, { appr, limited, canIssue }) {
  const m = x.member, weight = c.kind === 'weight', self = m?.id === me.id;
  const stName = weight && x.status === 'joined' ? '參加中' : ACH_ENTRY[x.status] || x.status;
  const pills = [`<span class="${ACH_ENTRY_PILL[x.status] || 'pill'}">${stName}</span>`,
    weight && x.w_base_at ? '<span class="pill">起始已見證</span>' : '', weight && x.w_last_at ? '<span class="pill">結束已見證</span>' : '',
    x.reward_state ? `<span class="pill${x.reward_state === 'granted' ? ' wait' : ''}" data-rw>${ACH_REWARD[x.reward_state] || ''}${x.reward_state === 'waitlist' && x.reward_rank ? ` <b class="num">${Number(x.reward_rank)}</b>` : ''}</span>` : '',
    x.late_size ? '<span class="pill">補訂</span>' : '', x.pool_dup ? '<span class="pill wait">同款重複</span>' : ''].filter(Boolean).join('');
  const when = !weight && (x.achieved_at || x.met_at) ? `<span>達成</span> <span class="num">${achMD(x.achieved_at || x.met_at)}</span>` : '';
  const ev = appr && !limited && x.evidence && ['km', 'attend'].includes(c.kind) ? `<span>${c.kind === 'km' ? '累積' : '出席'}</span> <span class="num">${esc(x.evidence)}</span> <span>${c.kind === 'km' ? '公里' : '次'}</span>` : '';
  const meta = [when, ev, x.shirt_size ? `<span>尺寸</span> <b translate="no">${esc(x.shirt_size)}</b>` : x.reward_state === 'granted' ? '<span>還沒選尺寸</span>' : ''].filter(Boolean).join('・');
  const btns = !appr || limited || self ? '' : [
    x.status === 'met' ? '<button type="button" class="btn sm" data-eact="ok">確認</button><button type="button" class="btn ghost sm" data-eact="no">退回這筆</button>' : '',
    x.status === 'achieved' && !weight ? '<button type="button" class="btn ghost sm" data-eact="revoke">撤銷達成</button>' : '',
    !weight && ['met', 'achieved', 'not_met', 'revoked', 'rejected'].includes(x.status) ? '<button type="button" class="linkbtn" data-eact="detail">細節 ›</button>' : '',
  ].join('');
  const issuable = canIssue && ['granted', 'issued'].includes(x.reward_state) && (weight || x.status === 'achieved');
  const issue = !issuable ? '<span></span>' : self ? '<span class="tiny">由其他幹部發放</span>'
    : `<label class="adm-ach-issue"><input type="checkbox" data-issue aria-label="已發放：${esc(m?.name || '')}" ${x.reward_state === 'issued' ? 'checked' : ''}><span>已發放</span></label>`;
  return `<div class="r adm-ach-erow" data-eid="${esc(x.id)}" data-mid="${esc(m?.id || '')}" data-st="${esc(x.status)}" data-rws="${esc(x.reward_state || '')}" data-q="${esc(`${m?.name || ''} ${m?.nickname || ''}`.toLowerCase())}" data-name="${esc(m?.name || '')}">
    ${avatar(m || {})}<span>${achNm(m)} ${achTeam(m?.team)}<span class="adm-ach-pills">${pills}</span>${meta ? `<span class="tiny" style="display:block">${meta}</span>` : ''}
      ${canIssue && x.status === 'met' && ['granted', 'issued'].includes(x.reward_state) ? '<span class="tiny" style="display:block">確認達成後才能發放</span>' : ''}
      ${btns ? `<span class="row adm-ach-acts">${btns}</span>` : ''}</span>
    ${issue}</div>`;
}
function bindAchCamp(c, { appr, limited, stats }) {
  const id = c.id, roster = $('#achRoster');
  const rerender = () => achCampView(id);
  const fail = (e) => toast(e.message);
  // 篩選與搜尋：只在畫面上藏起來（名單已經整份讀進來），焦點與勾選都不動
  const apply = () => {
    if (!roster) return;
    const f = achCampState.f, q = achCampState.q.trim().toLowerCase();
    let shown = 0;
    for (const r of roster.querySelectorAll('.adm-ach-erow')) {
      const st = r.dataset.st, rw = r.dataset.rws;
      const ok = (f === 'all' || (f === 'shirt' ? !!rw : st === f)) && (!q || r.dataset.q.includes(q));
      r.hidden = !ok; if (ok) shown++;
    }
    $('#achNone').hidden = !!shown;
  };
  for (const b of view.querySelectorAll('[data-ef]')) b.onclick = () => {
    achCampState.f = b.dataset.ef;
    for (const x of view.querySelectorAll('[data-ef]')) x.setAttribute('aria-pressed', String(x === b));
    apply();
  };
  $('#achEq')?.addEventListener('input', (e) => { achCampState.q = e.target.value; apply(); });
  apply();
  // 已發放：就地更新（不重畫：搜尋、篩選與焦點都留著，現場可以一路勾下去）；勾選中不停用核取方塊（停用會讓焦點跑掉）
  const bump = (k, d) => { const b = view.querySelector(`[data-n="${k}"] b`); if (b) b.textContent = Math.max(0, Number(b.textContent) + d); };
  roster?.addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-issue]'); if (!cb) return;
    const row = cb.closest('[data-eid]'), on = cb.checked;
    if (cb.dataset.busy) { cb.checked = !on; return; }
    cb.dataset.busy = '1';
    try {
      const r = await api(`/admin/ach/${encodeURIComponent(id)}/entries/${encodeURIComponent(row.dataset.eid)}/issue`, { method: 'POST', body: { issued: on } });
      toast(on ? '已標記發放' : '已取消發放');
      if (r.changed !== false) {
        row.dataset.rws = on ? 'issued' : 'granted';
        const p = row.querySelector('[data-rw]');
        if (p) { p.textContent = on ? '已發放' : '待發放'; p.classList.toggle('wait', !on); }
        bump('issued', on ? 1 : -1);
      }
    } catch (err) { cb.checked = !on; fail(err); }
    finally { delete cb.dataset.busy; }
  });
  roster?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-eact]'); if (!b) return;
    const row = b.closest('[data-eid]'), eid = row.dataset.eid, who = row.dataset.name, act = b.dataset.eact;
    const base = `/admin/ach/${encodeURIComponent(id)}/entries/${encodeURIComponent(eid)}`;
    if (act === 'detail') { achSourceSheet(id, eid, b); return; }
    let path = `${base}/confirm`, body = { approve: true }, msg = '已確認達成';
    if (act === 'no') {
      const r = await askReason('退回這筆達成', { who, chips: ACH_REJECT, ok: '退回這筆', max: ACH_NOTE_MAX }); if (!r) return;
      body = { approve: false, note: r.note, code: achReason(r.note) }; msg = '已退回';
    } else if (act === 'revoke') {
      const r = await askReason('撤銷這筆達成', { who, chips: ACH_REVOKE, ok: '撤銷', max: ACH_NOTE_MAX, lines: ['還沒發放的團服名額會讓給候補'] }); if (!r) return;
      path = `${base}/revoke`; body = { note: r.note, code: achReason(r.note) }; msg = '已撤銷達成';
    }
    await once(b, async () => { try { await api(path, { method: 'POST', body }); toast(msg); rerender(); } catch (err) { fail(err); } })();
  });
  // 頁首動作
  $('#achOpen')?.addEventListener('click', (e) => achPublish(id, e.currentTarget).then((ok) => ok && rerender()));
  $('#achDel')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (await choose('刪除草稿', '刪除這個挑戰草稿？', [{ label: '刪除草稿', value: 'del', danger: true }]) !== 'del') return;
    await once(b, async () => { try { await api(`/admin/ach/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('已刪除草稿'); location.hash = '#/admin/ach?tab=campaigns'; } catch (err) { fail(err); } })();
  });
  $('#achCancel')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const note = await achAskText('取消這個挑戰', { lines: [c.kind === 'weight' ? '參加者會收到通知；體重資料會立即刪除' : '參加者會收到通知'], label: '取消原因', max: ACH_NOTE_MAX, ok: '取消挑戰', required: true, hint: '原因會出現在參加者收到的通知裡' });
    if (note == null) return;
    await once(b, async () => { try { await api(`/admin/ach/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { note } }); toast('已取消挑戰'); rerender(); } catch (err) { fail(err); } })();
  });
  // 團服
  $('#achRemind')?.addEventListener('click', (e) => once(e.currentTarget, async () => {
    try { const r = await api(`/admin/ach/${encodeURIComponent(id)}/remind-size`, { method: 'POST', body: {} }); toast(`已提醒 ${Number(r.n) || 0} 人`); } catch (err) { fail(err); }
  })());
  $('#achPickup')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const note = await achAskText('通知領取團服', { lines: ['通知有名額、還沒領的跑友；同一個挑戰一天通知一次'], label: '領取方式', max: AR.LIMITS.pickupNote, ok: '通知', required: true, hint: '例如「週四團練在田徑場入口領」；會顯示在跑友的團服卡上' });
    if (note == null) return;
    await once(b, async () => { try { const r = await api(`/admin/ach/${encodeURIComponent(id)}/notify-pickup`, { method: 'POST', body: { note } }); toast(`已通知 ${Number(r.n) || 0} 人`); rerender(); } catch (err) { fail(err); } })();
  });
  $('#achRelease')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (await choose('讓出名額', '把尺寸截止後還沒選尺寸的名額讓給候補？被讓出的跑友會收到通知，還想要可以重新排隊。', [{ label: '讓給候補', value: 'go', primary: true }]) !== 'go') return;
    await once(b, async () => { try { const r = await api(`/admin/ach/${encodeURIComponent(id)}/release-unsized`, { method: 'POST', body: {} }); toast(`已讓出 ${Number(r.released) || 0} 個名額`); rerender(); } catch (err) { fail(err); } })();
  });
  // 發放現場找人：掃會籍卡（CILM:<id>.<簽章>）只拿 id 在已載入的名單裡找，不打 API、不驗簽章
  $('#achScanCard')?.addEventListener('click', () => {
    const close = scanSheet({ title: '掃會籍卡', hint: '把跑友 App 裡的會籍卡 QR 對準框內', placeholder: '或貼上 QR 內容', onCode: async (raw) => {
      const mid = /^CILM:([\w-]{1,32})\./i.exec(raw.trim())?.[1];
      const row = mid && roster?.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
      if (!row) return '這位跑友不在名單上';
      close();
      achCampState.f = 'all'; achCampState.q = ''; if ($('#achEq')) $('#achEq').value = '';
      for (const x of view.querySelectorAll('[data-ef]')) x.setAttribute('aria-pressed', String(x.dataset.ef === 'all'));
      apply();
      row.scrollIntoView({ block: 'center' });
      focusEl(row.querySelector('[data-issue]') || row);
      return '';
    } });
  });
  $('#achWit')?.addEventListener('click', () => achWitness());
}
// 見證體重量測：掃跑友手機上的見證碼（或手動輸入），看著體重計輸入讀數；伺服器不回傳任何數字，也不說有沒有達成
//   先掃碼再填數字、或先填數字再掃碼都可以。鏡頭一直開著、碼還在畫面裡時大約每 1.8 秒會再讀到一次：同一個碼只在第一次讀到時送
//   （那時已經填好數字的話），之後的重讀只回上一次的訊息；數字打錯或還沒打完都不會被重讀送出去（一個碼錯 3 次就作廢）。
//   要重送（例如改了數字）就按「送出見證」。成功訊息分成幾段（名字不翻譯），英文介面才換得過去
function achWitness() {
  let pending = '', seen = '', lastMsg = '';
  const norm = (s) => String(s || '').trim().replace(/^cil-wit:/i, '').replace(/[\s-]/g, '').toLowerCase();   // 畫面上分成 4 組顯示，手動輸入時空白與減號不算
  let kgIn = null, msgEl = null, busy = false;
  const okMsg = (r) => {
    const el = document.createElement('span');
    el.innerHTML = `<span>已見證</span> <b translate="no">${esc(r.name || '')}</b><span>${/^b/.test(r.which || '') ? '的起始量測' : '的結束量測'}</span>`;
    return el;
  };
  const show = (m) => { if (m instanceof Node) msgEl.replaceChildren(m); else msgEl.textContent = m; };
  const send = async (code) => {
    pending = code;
    const kg = Number(String(kgIn?.value || '').trim().replace(',', '.'));
    if (!AR.kgOk(kg)) { kgIn?.focus(); lastMsg = '已讀到見證碼，請輸入體重計上的數字'; return lastMsg; }
    if (busy) return lastMsg;
    busy = true;
    try {
      const r = await api('/ach/witness', { method: 'POST', body: { code, kg: Math.round(kg * 10) / 10 } });
      pending = ''; kgIn.value = '';
      lastMsg = okMsg(r);
    } catch (err) {
      lastMsg = err.message;
      // 作廢、過期、不能見證：這個碼不能再用（要跑友重新產生）；數字對不上：改好按「送出見證」；太頻繁或連不上：稍後按「送出見證」重送
      if ([400, 403, 404].includes(err.status) && !/數字|體重請填/.test(err.message)) pending = '';
      else kgIn?.select();
    } finally { busy = false; }
    return lastMsg;
  };
  scanSheet({ title: '見證體重量測', hint: '掃跑友手機上的見證碼，數字以體重計為準', placeholder: '手動輸入見證碼', onCode: async (raw) => {
    const code = norm(raw); if (!code) return '';
    if (code === seen) return lastMsg;   // 鏡頭重讀同一個碼：不再送
    seen = code;
    return send(code);
  } });
  const host = document.getElementById('scanT')?.closest('.sheet'); if (!host) return;
  msgEl = host.querySelector('.scanmsg');
  msgEl.insertAdjacentHTML('beforebegin', `<form class="row adm-ach-kgf" id="achKgF"><label>體重計讀數（公斤）<input name="kg" inputmode="decimal" autocomplete="off" maxlength="5" placeholder="例如 72.4" enterkeyhint="send"></label>
    <button class="btn sm">送出見證</button></form>`);
  kgIn = host.querySelector('#achKgF [name=kg]');
  host.querySelector('#achKgF').onsubmit = async (e) => {
    e.preventDefault();
    if (!pending) { show('請先掃跑友手機上的見證碼，或在下面輸入代碼'); return; }
    show(await send(pending));
  };
}
// 發布：先問要不要通知可以參加的人
async function achPublish(id, opener) {
  const v = await choose('發布挑戰', '發布後條件就不能再改，確定嗎？', [{ label: '發布並通知可以參加的人', value: 'notify', primary: true }, { label: '發布，不通知', value: 'quiet' }]);
  if (!v) return false;
  try {
    await api(`/admin/ach/${encodeURIComponent(id)}/open`, { method: 'POST', body: { announce: v === 'notify' } });
    toast(v === 'notify' ? '已發布並通知可以參加的人' : '已發布');
    return true;
  } catch (e) { toast(e.message); opener?.focus(); return false; }
}

// ---- 挑戰編輯（新增、草稿、發布後的有限修改）----
const ACH_KIND_DESC = { pb: '期間內跑出比之前更快的成績', time: '例如全馬破 4、半馬破 2', pace: '成績比之前的 PB 快一定比例', weight: '現場見證或自主聲明，體重不上榜', km: '用訓練紀錄累積公里數', attend: '以現場報到為準' };
const ACH_ATT_NAME = { track: '田徑場團練', core: '核心日', long: '長跑團練', race: '賽事', other: '活動' };
const ACH_BADGE_NAME = { trophy: '獎盃', medal: '獎牌', stopwatch: '碼錶', flame: '火焰', mountain: '山', heart: '愛心', star: '星星', shirt: '團服' };
const achR1 = (v) => Math.round(Number(v) * 10) / 10;
async function achEditView(id) {
  const my = ++achSeq, title = id ? '修改挑戰' : '新增挑戰';
  if (!achApprover()) { achFail(view, title, '只有理事長與行政人員可以管理挑戰'); return; }
  let data;
  try { data = await api('/admin/ach'); } catch (e) { if (my === achSeq) achFail(view, title, e.message); return; }
  if (my !== achSeq || !location.hash.startsWith('#/admin/ach/')) return;
  const old = id ? (data.campaigns || []).find((c) => c.id === id) : null;
  if (id && !old) { achFail(view, title, '找不到這個挑戰'); return; }
  if (old?.status === 'cancelled') { achFail(view, title, '挑戰已經取消，不能再修改'); return; }
  const meta = data.meta || {}, today = achToday(), locked = !!old && old.status !== 'draft';
  const o = old || { kind: 'time', dist_key: 'fm', target: 14400, opts: {}, confirm: false, team_id: null, members_only: false,
    rewards: { badge: 'medal', board: 1 }, start_date: today, end_date: AR.addDays(today, 60), join_by: AR.addDays(today, 60), title: '', intro: '' };
  const sh = o.rewards?.shirt || null, dis = locked ? 'disabled' : '';
  const t0 = o.kind === 'time' && o.target ? o.target : 0;
  const aud = o.team_id ? 'team' : o.members_only ? 'members' : 'all';
  const sizes = [...new Set([...AR.SIZES, ...(sh?.sizes || [])])];
  const chk = (b) => (b ? 'checked' : '');
  const lockNote = locked ? '<p class="tiny adm-ach-lock">挑戰開始後不能改條件</p>' : '';
  view.innerHTML = `${largeTitle(title)}
    <form id="achForm" class="adm-ach-form" novalidate>
      <p class="notice" id="achErr" role="alert" tabindex="-1" hidden></p>
      <section class="card"><fieldset class="qset" ${dis}><legend>挑戰類型</legend>${lockNote}
        <div class="adm-ach-kinds">${AR.KINDS.map((k) => `<label class="adm-ach-kind"><input type="radio" name="kind" value="${k}" ${chk(o.kind === k)}>
          <span>${achTile({ kind: k })}<b>${esc(AR.KIND_ZH[k])}</b><span class="tiny">${ACH_KIND_DESC[k]}</span></span></label>`).join('')}</div></fieldset></section>
      <section class="card"><fieldset class="qset adm-ach-cond" ${dis}><legend>條件</legend>${lockNote}
        <div data-for="pb time pace"><span class="tiny">距離</span><div class="chips" role="radiogroup" aria-label="距離">
          <label class="chip" data-for="pb pace"><input type="radio" name="dist" value="" ${chk(!o.dist_key)}><span>任一距離</span></label>
          ${AR.STD.map((d) => `<label class="chip"><input type="radio" name="dist" value="${d}" ${chk(o.dist_key === d)}><span>${esc(AR.DISTS[d].zh)}</span></label>`).join('')}</div></div>
        <div data-for="time" class="adm-ach-tbox">
          <span class="tiny">常用目標（跑進這個時間才算）</span><div class="chips" id="achPresets"></div>
          <div class="adm-ach-hms" role="group" aria-label="目標時間"><label>小時<input name="th" inputmode="numeric" maxlength="2" value="${t0 ? Math.floor(t0 / 3600) : ''}"></label>
            <label>分鐘<input name="tm" inputmode="numeric" maxlength="2" value="${t0 ? Math.floor((t0 % 3600) / 60) : ''}"></label>
            <label>秒<input name="ts" inputmode="numeric" maxlength="2" value="${t0 ? t0 % 60 : ''}"></label></div>
          <label id="achGrpBox">用分組目標<select name="grp"></select></label>
          <label class="switch"><span>限第一次跑進<span class="tiny" style="display:block">挑戰開始前已經跑進過的不算</span></span><input type="checkbox" name="first_time" ${chk(o.opts?.first_time)}><i></i></label></div>
        <label class="switch" data-for="pb"><span>之前沒有成績的人，完賽就算<span class="tiny" style="display:block">鼓勵第一次完賽；挑戰發布後才補登的舊成績不算</span></span><input type="checkbox" name="first_ok" ${chk(o.opts?.first_ok)}><i></i></label>
        <label data-for="pace">進步幅度（%）<input name="pace_pct" type="number" inputmode="decimal" min="0.5" max="20" step="0.1" value="${o.kind === 'pace' ? esc(o.target) : 3}"></label>
        <p class="tiny" data-for="pace">建議在功能開放幾週、大家登錄過以前的成績之後再辦：基準只算挑戰發布前就登錄的成績</p>
        <label data-for="weight">減少幅度（%）<input name="weight_pct" type="number" inputmode="decimal" min="1" max="10" step="0.1" value="${o.kind === 'weight' ? esc(o.target) : 3}"></label>
        <fieldset class="qset" data-for="weight"><legend>確認方式</legend>
          <label class="chip"><input type="radio" name="verify" value="honor" ${chk(o.opts?.verify !== 'witness')}><span>自主聲明（榮譽制，不收體重）</span></label>
          <label class="chip"><input type="radio" name="verify" value="witness" ${chk(o.opts?.verify === 'witness')} ${meta.raceKey ? '' : 'disabled'}><span>現場見證（加密保存體重）</span></label>
          ${meta.raceKey ? '' : '<p class="tiny">伺服器還沒有設定加密金鑰，暫時不能用現場見證</p>'}
          <p class="tiny" id="achWitNote">見證就是確認，不需要另外確認</p>
          <p class="tiny">健康的減重大約每週不超過體重的 1%，所以幅度最多 10%、期間至少 4 週。</p></fieldset>
        <label data-for="km">目標里程（公里）<input name="km" type="number" inputmode="decimal" min="10" max="5000" step="0.1" value="${o.kind === 'km' ? esc(o.target) : 300}"></label>
        <label class="switch" data-for="km"><span>達成後要幹部確認<span class="tiny" style="display:block">有團服時建議打開：幹部看過紀錄來源再確認</span></span><input type="checkbox" name="confirm" ${chk(o.kind === 'km' && o.confirm)}><i></i></label>
        <label data-for="attend">出席次數<input name="att" type="number" inputmode="numeric" min="1" max="200" step="1" value="${o.kind === 'attend' ? esc(o.target) : 12}"></label>
        <fieldset class="qset" data-for="attend"><legend>要算哪些團練</legend><div class="chips">${AR.ATTEND_KINDS.map((k) => `<label class="chip"><input type="checkbox" name="akinds" value="${k}" ${chk((o.kind === 'attend' ? o.opts?.kinds || [] : AR.ATTEND_DEFAULT).includes(k))}><span>${ACH_ATT_NAME[k]}</span></label>`).join('')}</div></fieldset>
      </fieldset></section>
      <section class="card"><h2 class="h3">期間與對象</h2>
        <div class="grid3"><label>開始<input type="date" name="start" value="${esc(o.start_date)}" ${dis}></label><label>結束<input type="date" name="end" value="${esc(o.end_date)}"></label>
          <label>報名截止<input type="date" name="join_by" value="${esc(o.join_by)}" aria-describedby="achJoinHint"></label></div>
        <p class="tiny" id="achJoinHint"></p>
        ${locked ? '<p class="tiny">結束日只能延長，而且要在原本的結束日以前延長。</p>' : ''}
        <fieldset class="qset" ${dis}><legend>對象</legend><div class="chips">
          <label class="chip"><input type="radio" name="aud" value="all" ${chk(aud === 'all')}><span>全協會</span></label>
          <label class="chip"><input type="radio" name="aud" value="members" ${chk(aud === 'members')}><span>只限協會會員</span></label>
          <label class="chip"><input type="radio" name="aud" value="team" ${chk(aud === 'team')} ${(meta.teams || []).length ? '' : 'disabled'}><span>某個分團</span></label></div>
          <select name="team_id" aria-label="分團">${(meta.teams || []).map((t) => `<option value="${esc(t.id)}" ${o.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></fieldset>
      </section>
      <section class="card"><h2 class="h3">獎勵</h2>${lockNote}
        <fieldset class="qset" ${dis}><legend>徽章</legend><div class="adm-ach-badges">
          ${['', ...AR.BADGES].map((b) => `<label class="adm-ach-bdg"><input type="radio" name="badge" value="${b}" ${chk((o.rewards?.badge || '') === b)} aria-label="${b ? ACH_BADGE_NAME[b] : '不要徽章'}"><span aria-hidden="true">${b ? achIc(b) : '<span class="tiny">不要</span>'}</span></label>`).join('')}</div></fieldset>
        <label class="switch"><span>上恭喜榜<span class="tiny" style="display:block" id="achBoardHint"></span></span><input type="checkbox" name="board" ${chk(o.rewards?.board)} ${dis}><i></i></label>
        <label class="switch"><span>團服<span class="tiny" style="display:block" id="achShirtHint"></span></span><input type="checkbox" name="shirt" ${chk(sh)} ${dis}><i></i></label>
        <div id="achShirtBox" class="adm-ach-shirtform">
          <fieldset class="qset"><legend>尺寸</legend><div class="chips" id="achSizes">${sizes.map((z) => `<label class="chip"><input type="checkbox" name="sizes" value="${esc(z)}" ${chk(sh ? sh.sizes.includes(z) : AR.SIZES.includes(z))} ${locked && sh?.sizes.includes(z) ? 'disabled' : ''}><span translate="no">${esc(z)}</span></label>`).join('')}</div>
            <div class="row adm-ach-addsz"><input id="achSizeAdd" maxlength="${AR.LIMITS.sizeLen}" placeholder="自訂尺寸" aria-label="自訂尺寸"><button type="button" class="btn ghost sm" id="achSizeAddBtn">加入</button></div>
            ${locked ? '<p class="tiny">尺寸只能增加</p>' : ''}</fieldset>
          <div class="grid2"><label>名額<input name="quota" type="number" inputmode="numeric" min="1" max="2000" step="1" placeholder="不限量" value="${sh?.quota ?? ''}" aria-describedby="achQuotaHint"></label>
            <label>尺寸選到<input name="size_by" type="date" value="${esc(sh?.size_by || '')}" aria-describedby="achSizeByHint"></label></div>
          <p class="tiny" id="achQuotaHint">${locked ? '名額只能增加，留空就是不限量；依達成先後分配，挑戰結算時才確定' : '名額留空就是不限量；依達成先後分配，挑戰結算時才確定'}</p>
          <p class="tiny" id="achSizeByHint">${locked ? '尺寸截止只能延後；留空就照原本的日期' : '沒填的話是結束後 14 天'}</p>
          <label>尺寸表連結（選填）<input name="chart" type="url" inputmode="url" placeholder="https://" value="${esc(sh?.chart || '')}"></label>
          <label>同款團服的名稱（選填）<input name="pool" maxlength="${AR.LIMITS.pool}" list="achPools" placeholder="例如 2026 團服" value="${esc(sh?.pool || '')}" aria-describedby="achPoolHint" ${dis}></label>
          <datalist id="achPools">${(meta.pools || []).map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>
          <p class="tiny" id="achPoolHint">好幾個挑戰送同一款團服時填同一個名稱，一位跑友只會拿到一件</p>
        </div>
      </section>
      <section class="card"><h2 class="h3">名稱與說明</h2>
        <label>名稱<input name="title" maxlength="${AR.LIMITS.title}" value="${esc(o.title || '')}" required></label>
        <p class="tiny" data-for="weight">建議用中性的名稱（例如「秋季體態挑戰」）</p>
        <label>說明（選填）<textarea name="intro" maxlength="${AR.LIMITS.intro}" rows="4">${esc(o.intro || '')}</textarea></label>
      </section>
      <section class="card adm-ach-preview"><h2 class="h3">預覽</h2><p class="tiny">跑友在挑戰頁看到的條件與獎勵：</p><div id="achPrev"></div></section>
      ${locked ? `<label class="switch" id="achAnnBox" hidden><span>通知參加者<span class="tiny" style="display:block">延長結束日或增加名額時，通知已經參加的人</span></span><input type="checkbox" name="announce"><i></i></label>
        <div class="sheetacts"><a class="btn ghost" href="#/admin/ach/c/${esc(id)}">取消</a><button class="btn" id="achSave">儲存</button></div>`
      : '<div class="sheetacts"><button type="button" class="btn ghost" id="achDraft">存草稿</button><button class="btn" id="achPub">發布</button></div>'}
    </form>`;
  bindAchEdit({ id, old, o, meta, locked, today });
}
function bindAchEdit({ id: id0, old, o, meta, locked, today }) {
  const f = $('#achForm'), err = $('#achErr');
  let id = id0;   // 新增時第一次存好草稿後就有 id：之後再按是修改同一份草稿，不會多一份
  const val = (n) => f.querySelector(`[name="${n}"]:checked`)?.value ?? '';
  const kind = () => val('kind') || o.kind;
  let joinAuto = !old, confirmTouched = !!old;
  const hms = () => {
    const [h, m, s] = ['th', 'tm', 'ts'].map((n) => f[n].value.trim());
    if (!h && !m && !s) return null;
    const n = [h, m, s].map((x) => Number(x || 0));
    return n.every((x) => Number.isInteger(x) && x >= 0) && n[1] < 60 && n[2] < 60 ? n[0] * 3600 + n[1] * 60 + n[2] : NaN;
  };
  const setHms = (sec) => { f.th.value = Math.floor(sec / 3600); f.tm.value = Math.floor((sec % 3600) / 60); f.ts.value = sec % 60; };
  // 依目前的表單組出挑戰（型別整理好，給 checkCampaign、預覽與送出共用）
  const read = () => {
    const k = kind(), dist = val('dist') || null, verify = val('verify') || 'honor';
    let target = null; const opts = {};
    if (k === 'time') { target = hms(); if (f.first_time.checked) opts.first_time = 1; }
    if (k === 'pb' && f.first_ok.checked) opts.first_ok = 1;
    if (k === 'pace') target = achR1(f.pace_pct.value);
    if (k === 'weight') { target = achR1(f.weight_pct.value); opts.verify = verify; }
    if (k === 'km') target = achR1(f.km.value);
    if (k === 'attend') { target = Number(f.att.value); opts.kinds = [...f.querySelectorAll('[name=akinds]:checked')].map((x) => x.value); }
    const honor = k === 'weight' && verify === 'honor';
    const aud = val('aud');
    const rewards = {};
    const badge = val('badge'); if (badge) rewards.badge = badge;
    if (f.board.checked && k !== 'weight') rewards.board = 1;
    if (f.shirt.checked && !honor) {
      const q = f.quota.value.trim();
      rewards.shirt = { sizes: [...f.querySelectorAll('[name=sizes]:checked')].map((x) => x.value), quota: q === '' ? null : Number(q),
        size_by: f.size_by.value || null, chart: f.chart.value.trim() || null, pool: f.pool.value.trim() || null };
    }
    return { title: f.title.value.trim(), intro: f.intro.value.trim() || null, team_id: aud === 'team' ? f.team_id.value || null : null, members_only: aud === 'members',
      kind: k, dist_key: ['pb', 'time', 'pace'].includes(k) ? dist : null, target, opts, confirm: k === 'km' && f.confirm.checked,
      rewards, start_date: f.start.value, end_date: f.end.value, join_by: f.join_by.value };
  };
  // 發布後：鎖住的欄位一律用原本的值（伺服器比對的是同一份），只換可以改的
  const next = () => {
    if (!locked) return read();
    const r = read(), so = old.rewards?.shirt;
    const rewards = { ...(old.rewards || {}) };
    if (so) rewards.shirt = { ...so, sizes: r.rewards.shirt?.sizes || so.sizes, quota: r.rewards.shirt ? r.rewards.shirt.quota : so.quota,
      size_by: r.rewards.shirt?.size_by || so.size_by, chart: r.rewards.shirt ? r.rewards.shirt.chart : so.chart };
    return { title: r.title, intro: r.intro, team_id: old.team_id, members_only: old.members_only, kind: old.kind, dist_key: old.dist_key, target: old.target,
      opts: old.opts, confirm: old.confirm, rewards, start_date: old.start_date, end_date: r.end_date, join_by: r.join_by };
  };
  const joinDefault = (c) => (c.kind === 'weight' && AR.isDay(c.start_date) && AR.isDay(c.end_date)
    ? [AR.addDays(c.start_date, 14), AR.addDays(c.end_date, -AR.GRACE.weighJoinGap)].sort()[0] : c.end_date);
  const presets = () => {
    const d = val('dist'), box = $('#achPresets'), cur = hms();
    box.innerHTML = (AR.TIME_PRESETS[d] || []).map((s) => `<button type="button" class="chip" data-preset="${s}" aria-pressed="${s === cur}"><span class="num">${AR.fmtTime(s)}</span></button>`).join('');
    const groups = d === 'fm' ? FM : d === 'hm' ? HM : null;
    $('#achGrpBox').hidden = !groups;
    f.grp.innerHTML = groups ? `<option value="">選一組</option>${Object.entries(groups).map(([g, v]) => `<option value="${v[2] * 60}">${g} 組 ${AR.fmtTime(v[2] * 60)}</option>`).join('')}` : '';
  };
  const paint = () => {
    const k = kind(), c = locked ? next() : read(), verify = val('verify') || 'honor', honor = k === 'weight' && verify === 'honor';
    for (const el of f.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(k);
    $('#achWitNote').hidden = verify !== 'witness';
    // 上恭喜榜：體重一律不上榜；團服：榮譽制體重不能送
    if (!locked) {
      f.board.disabled = k === 'weight';
      f.shirt.disabled = honor;
      if (honor) f.shirt.checked = false;
    }
    $('#achBoardHint').textContent = k === 'weight' ? '體重挑戰一律不上榜，避免讓人知道誰參加了減重' : '完成的跑友會出現在恭喜榜（要本人在隱私設定打開）';
    $('#achShirtHint').textContent = honor ? '自主聲明的體重挑戰不能送團服（沒辦法驗證）' : '選尺寸、限量、依達成先後分配，有候補遞補';
    $('#achShirtBox').hidden = !f.shirt.checked;
    f.team_id.hidden = val('aud') !== 'team';
    $('#achJoinHint').textContent = k === 'weight' ? '體重挑戰的報名截止預設是開始後 14 天與結束前 18 天較早的那天，最晚結束前 18 天' : '報名截止預設是結束日';
    // 預覽：跑友看到的條件句與獎勵
    const rw = c.rewards || {}, s = rw.shirt;
    $('#achPrev').innerHTML = `${achRulesHtml(c)}<p class="adm-ach-rw">${rw.badge ? `<span class="adm-ach-rwi">${achIc(rw.badge)}<span>完成徽章</span></span>` : ''}
      ${s ? `<span class="adm-ach-rwi">${achIc('shirt')}${s.quota ? `<span>團服名額</span> <b class="num">${Number(s.quota) || 0}</b>` : '<span>團服不限量</span>'}</span>` : ''}
      ${rw.board ? `<span class="adm-ach-rwi">${achIc('sparkle')}<span>完成後上恭喜榜</span></span>` : ''}
      ${k === 'weight' ? '<span class="adm-ach-rwi"><span>這個挑戰不上恭喜榜</span></span>' : ''}</p>`;
    if (locked) {
      const so = old.rewards?.shirt;
      const more = c.end_date > old.end_date || (so && (so.quota !== null && (c.rewards.shirt?.quota === null || c.rewards.shirt?.quota > so.quota)));
      $('#achAnnBox').hidden = !more;
      if (!more) f.announce.checked = false;
    }
  };
  f.addEventListener('change', (e) => {
    const n = e.target.name;
    if (n === 'join_by') joinAuto = false;
    if (n === 'confirm') confirmTouched = true;
    if ((n === 'shirt' || n === 'kind') && !confirmTouched) f.confirm.checked = f.shirt.checked;   // 里程挑戰：有團服時預設要幹部確認
    // 時間門檻一定要選距離：從「任一距離」換過來時先選全馬
    if (n === 'kind' && kind() === 'time' && !val('dist')) { const fm = f.querySelector('[name=dist][value="fm"]'); if (fm) fm.checked = true; }
    if (n === 'dist' || n === 'kind') presets();
    if (n === 'grp' && f.grp.value) setHms(Number(f.grp.value));
    if (joinAuto && ['kind', 'start', 'end'].includes(n)) f.join_by.value = joinDefault(read());
    paint();
  });
  f.addEventListener('input', (e) => { if (['th', 'tm', 'ts'].includes(e.target.name)) for (const b of f.querySelectorAll('[data-preset]')) b.setAttribute('aria-pressed', String(Number(b.dataset.preset) === hms())); paint(); });
  f.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]'); if (!p) return;
    setHms(Number(p.dataset.preset)); for (const b of f.querySelectorAll('[data-preset]')) b.setAttribute('aria-pressed', String(b === p)); f.grp.value = ''; paint();
  });
  $('#achSizeAddBtn').onclick = () => {
    const inp = $('#achSizeAdd'), z = inp.value.trim().slice(0, AR.LIMITS.sizeLen);
    if (!z) { inp.focus(); return; }
    const have = [...f.querySelectorAll('[name=sizes]')].find((x) => x.value.toLowerCase() === z.toLowerCase());
    if (have) have.checked = true;
    else $('#achSizes').insertAdjacentHTML('beforeend', `<label class="chip"><input type="checkbox" name="sizes" value="${esc(z)}" checked><span translate="no">${esc(z)}</span></label>`);
    inp.value = ''; inp.focus(); paint();
  };
  $('#achSizeAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#achSizeAddBtn').click(); } });
  presets();
  paint();
  // 檢查：前後端同一份規則；錯誤顯示在表單最上面並把焦點移過去
  const showErr = (m) => { err.textContent = m; err.hidden = !m; if (m) focusEl(err); };
  const check = () => {
    const c = next();
    if (c.rewards.shirt && c.rewards.shirt.chart && !/^https:\/\/\S+$/.test(c.rewards.shirt.chart)) return '尺寸表連結要是 https:// 開頭的網址';
    return AR.checkCampaign(c) || (locked ? AR.checkEdit(old, c, today) : null);
  };
  const save = async () => {
    const m = check(); if (m) { showErr(m); return null; }
    showErr('');
    const body = next();
    if (locked) return api(`/admin/ach/${encodeURIComponent(id)}`, { method: 'PUT', body: { ...body, announce: !!f.announce?.checked } }).then(() => id);
    if (id) return api(`/admin/ach/${encodeURIComponent(id)}`, { method: 'PUT', body }).then(() => id);
    id = (await api('/admin/ach', { method: 'POST', body })).id;
    return id;
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (locked) { try { if (await save()) { toast('已儲存'); location.hash = `#/admin/ach/c/${id}`; } } catch (er) { showErr(er.message); } return; }
    // 發布：先檢查、再問通知，最後才存（取消就什麼都不動）
    const m = check(); if (m) { showErr(m); return; }
    const v = await choose('發布挑戰', '發布後條件就不能再改，確定嗎？', [{ label: '發布並通知可以參加的人', value: 'notify', primary: true }, { label: '發布，不通知', value: 'quiet' }]);
    if (!v) return;
    try {
      const cid = await save(); if (!cid) return;
      await api(`/admin/ach/${encodeURIComponent(cid)}/open`, { method: 'POST', body: { announce: v === 'notify' } });
      toast(v === 'notify' ? '已發布並通知可以參加的人' : '已發布');
      location.hash = `#/admin/ach/c/${cid}`;
    } catch (er) {
      showErr(er.message);
      if (id && !id0) history.replaceState(null, '', `#/admin/ach/c/${id}/edit`);   // 草稿已經存了：網址換成修改這份草稿
    }
  };
  $('#achDraft')?.addEventListener('click', (e) => once(e.currentTarget, async () => {
    try { const cid = await save(); if (cid) { toast('已存草稿'); location.hash = `#/admin/ach/c/${cid}`; } } catch (er) { showErr(er.message); }
  })());
}

export { adminView, rosterView, weeklyView, settingsPage, treeView, achAdminView };
