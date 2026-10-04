// 耕跑團 PWA — 「我的」的子頁（用到才載入；「我的」第一層在 app.js）
//   個人資料、我的賽事與倒數、賽事報名資料、主團與分團、通知設定、行事曆訂閱、外觀與語言、帳號與安全、隱私、協會、會籍卡、分享 App
//   共用的工具與狀態從 app.js 拿；改登入狀態用 setMe（import 進來的 me、cfg 不能直接改）
import {
  $, addrField, ago, api, applyTabs, applyTheme, askLegacyOnLeave, avatar, bindAddrField, bindInstall, bindStepup, btnRow, camLazy, cfg, choose,
  clearDeviceData, copy, countdownPicker, dropPush, esc, feat, GOOGLE_G, googleHref, group, IC, iconsOnly, installCard, isStandalone, lsOrNull, me,
  mfaBanner, MI, myCycle, NICON, openSheet, org, paintCountdown, passkey, pkSupported, qrSVG, reduceMotion, refreshMe, render, ROLE_NAME, row, setMe, subTitle,
  TEAM_ROLE_NAME, teamIcon, teamOf, teams, theme, toast, togglePush, view, ymd
} from './app.js';
import * as I18N from './i18n.js';
import * as Device from './device.js';
import { CATS } from './notif-cats.js';

function meProfile() {
  view.innerHTML = `${subTitle('個人資料', '報名時會直接帶入，不用每次重填')}
    <section class="card">
      <div class="row">${avatar(me)}<div style="flex:1"><b><span translate="no">${esc(me.name)}</span></b><div class="tiny">${me.title ? `<span translate="no">${esc(me.title)}</span>` : esc(me.roleName || ROLE_NAME[me.role] || '團員')}</div></div></div>
      <form id="mf">
        <div class="grid2"><label>姓名<input name="name" value="${esc(me.name)}" maxlength="20"></label>
          <label>暱稱<input name="nickname" value="${esc(me.nickname || '')}" maxlength="20" placeholder="團裡怎麼叫你"></label></div>
        <div class="field"><span class="flabel">所屬跑團</span><span class="fvalue"><span translate="no">${esc(teamOf(me.main_team)?.name || '等待管理員設定')}</span></span><span class="tiny">跟著主團，由管理員設定</span></div>
        <div class="grid2"><label>餐點偏好<select name="meal_pref"><option value="" ${!me.meal_pref ? 'selected' : ''}>未指定</option>
            <option ${me.meal_pref === '葷食' ? 'selected' : ''}>葷食</option><option ${me.meal_pref === '素食' ? 'selected' : ''}>素食</option></select></label>
          <label>電話（選填）<input name="phone" value="${esc(me.phone || '')}" maxlength="20" inputmode="tel" placeholder="餐會聯絡用"></label></div>
        <label>常跑地點（首頁顯示這裡的天氣）<select name="home_spot"><option value="">（不指定）</option></select></label>
        <button class="btn block">儲存</button>
      </form>
    </section>
    ${group('', [row('#/plan/setup?go=grp', MI.flag, `項目與組別：${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組`, '課表的配速照組別換算；只在課表設定改')])}
    ${feat('plan_cycle') || cfg.planCycle?.suspended ? group('', [row('#/plan/setup?go=cycle', MI.cal, myCycle().kind === 'race' ? `課表週期：<span translate="no">${esc(myCycle().name)}</span>` : '課表週期：協會賽季',
      cfg.planCycle?.suspended ? '個人週期目前暫停，課表先照協會賽季' : '跟協會賽季，或跟自己的一場比賽排 20 週')]) : ''}`;
  const f = $('#mf');
  api('/spots').then(({ spots }) => { f.home_spot.innerHTML += spots.filter((x) => x.status === 'approved').map((x) => `<option value="${esc(x.id)}" ${me.home_spot === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join(''); }).catch(() => {});
  f.onsubmit = async (e) => {
    e.preventDefault();
    // 項目與組別只在課表設定改（不送，伺服器保留原值）
    try { setMe((await api('/me', { method: 'PUT', body: { name: f.name.value, nickname: f.nickname.value, meal_pref: f.meal_pref.value, phone: f.phone.value, home_spot: f.home_spot.value || null } })).member);
      refreshMe().catch(() => {}); toast('已儲存'); }
    catch (err) { toast(err.message); }
  };
}
async function meRaces() {
  view.innerHTML = `${subTitle('我的賽事與倒數', '右上角倒數主要賽事；點右上角倒數也能直接換')}
    <section class="card"><div id="raceList" class="roster"></div></section>
    <section class="card"><h2 class="h3">加一場比賽</h2>
      <form id="raceForm">
        <div class="grid2"><label>賽事名稱<input name="name" maxlength="30" placeholder="2026 臺北馬拉松" required></label><label>日期<input type="date" name="date" required></label></div>
        <div class="grid2"><label>距離<select name="dist"><option>全馬</option><option>半馬</option><option>10K</option><option>5K</option><option>超馬</option><option>其他</option></select></label>
          <label>目標成績<input name="goal" maxlength="10" placeholder="3:39:59"></label></div>
        <button class="btn block">加入賽事</button>
      </form></section>
    <button class="btn ghost block" id="pickCd">從常用賽事挑，或改成協會預設／不顯示</button>`;
  const refreshCfg = async () => { const r = await api('/me'); setMe(r.member, r); paintCountdown(); };
  const load = async () => {
    const { races } = await api('/races');
    if (!$('#raceList')) return;
    $('#raceList').innerHTML = races.map((r) => {
      const d = Math.round((new Date(`${r.date}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
      return `<div class="r"><span class="av num" style="font-size:11px">${d >= 0 ? d : IC.check}</span>
        <span><b><span translate="no">${esc(r.name)}</span></b>${r.is_primary ? ' <span class="pill solid">倒數中</span>' : ''}
          <span class="tiny" style="display:block">${esc(r.date)}・${esc(r.dist || '')}${r.goal ? `・目標 ${esc(r.goal)}` : ''}${d >= 0 ? `・還有 ${d} 天` : '・已完賽'}</span></span>
        <span class="row" style="gap:6px">${r.is_primary ? '' : `<button class="btn ghost sm" data-prim="${r.id}">倒數這場</button>`}<button class="btn danger sm" data-delrace="${r.id}" aria-label="刪除">刪除</button></span></div>`;
    }).join('') || '<p class="tiny" style="margin:0">還沒有賽事，加一場吧。</p>';
    for (const b of document.querySelectorAll('[data-prim]')) b.onclick = async () => { await api(`/races/${b.dataset.prim}/primary`, { method: 'POST' }); await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } }); await load(); await refreshCfg(); toast('右上角改成倒數這場'); };
    for (const b of document.querySelectorAll('[data-delrace]')) b.onclick = async () => {
      // 這場是課表週期：先說清楚刪掉後課表會改回協會賽季
      if (myCycle().kind === 'race' && myCycle().raceId === b.dataset.delrace) {
        if (await choose('刪除這場賽事？', '這場是你的課表週期。刪掉後課表改回協會賽季，以前的紀錄不會改。', [{ value: 'del', label: '刪除', danger: true }]) !== 'del') return;
      } else if (!confirm('刪除這場賽事？')) return;
      try {
        const r = await api(`/races/${b.dataset.delrace}`, { method: 'DELETE' });
        await load(); await refreshCfg();
        if (r?.cycleReset) toast('已刪除，課表改回協會賽季');
      } catch (err) { toast(err.message); }
    };
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
  const lt = (k, label) => `<span class="lbl">${label || F[k].label}${F[k].req ? '<span class="req">必填</span>' : ''}</span>`;
  const input = (k, type = 'text', extra = '', label = '') => `<label>${lt(k, label)}<input name="${k}" type="${type}" maxlength="${F[k].max}" value="${esc(p[k] || '')}" ${extra}></label>`;
  const select = (k, opts) => `<label>${lt(k)}<select name="${k}"><option value="">請選擇</option>${opts.map((g) => `<option ${p[k] === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>`;
  view.innerHTML = `${subTitle('團體報名資料', '填一次，之後幹部代為團體報名馬拉松都用這份')}
    <section class="card notice-card"><b>${IC.lock} 這份資料怎麼保護</b>
      <ul class="steps"><li>加密後才存進資料庫，只有你自己看得到完整內容</li>
        <li>只有在你報名「由幹部代為團體報名」的活動、並勾選同意時，那一場的主辦幹部才能下載</li>
        <li>每次下載都會留下稽核紀錄；你可以隨時修改或刪除</li>
        <li>通訊地址會送到中華郵政的郵遞區號服務核對，補上 6 碼郵遞區號（只送地址，不含姓名）</li></ul></section>
    <form id="regForm" class="card regform">
      <div class="grid2">${input('name_zh')}${input('name_en', 'text', 'autocapitalize="characters" placeholder="WANG DA-MING"')}</div>
      <p class="tiny" style="margin:0">身分證字號與護照號碼至少填一個；外籍跑友填居留證號或護照號碼。</p>
      <label><span class="lbl">${F.id_no.label}</span><span class="idwrap"><input name="id_no" maxlength="${F.id_no.max}" value="${esc(p.id_no || '')}" autocomplete="off" autocapitalize="characters" spellcheck="false" type="password" placeholder="A123456789"><button type="button" class="btn ghost sm" id="idShow" aria-label="顯示身分證字號">顯示</button></span></label>
      <label><span class="lbl">${F.passport_no.label}</span><input name="passport_no" maxlength="${F.passport_no.max}" value="${esc(p.passport_no || '')}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="臺灣護照 9 碼數字"></label>
      <div class="grid2">${input('birthday', 'date')}${select('gender', ['男', '女', '其他'])}</div>
      <div class="grid2">${input('phone', 'tel', 'inputmode="tel" autocomplete="tel"')}${select('shirt', ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'])}</div>
      ${input('email', 'email', 'autocomplete="email"')}
      ${addrField('address', '通訊地址', '選填・送郵局核對')}
      <fieldset class="group"><legend>緊急聯絡人</legend>
        <div class="grid2">${input('emergency_name', 'text', '', '姓名')}${input('emergency_phone', 'tel', 'inputmode="tel"', '電話')}</div>
        ${input('emergency_rel', 'text', 'placeholder="配偶、父母…"', '關係')}</fieldset>
      ${input('note', 'text', 'placeholder="外籍、身障組、其他需求"')}
      <button class="btn block">儲存</button>
      ${d.profile ? '<button type="button" class="btn danger block" id="regDel">刪除我的團體報名資料</button>' : ''}
      ${d.updated_at ? `<p class="tiny center" style="margin:0">上次更新：${ago(d.updated_at)}</p>` : ''}
    </form>`;
  bindAddrField($('#regForm'), 'address', p.address, p.address_zip);
  $('#idShow').onclick = () => { const i = $('#regForm').id_no; i.type = i.type === 'password' ? 'text' : 'password'; $('#idShow').textContent = i.type === 'password' ? '顯示' : '隱藏'; };
  $('#regForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, String(v).trim()]));
    if (!body.id_no && !body.passport_no) return toast('身分證字號或護照號碼至少填一個');
    try {
      const r = await api('/me/race-profile', { method: 'PUT', body });
      let back = null; try { back = JSON.parse(sessionStorage.getItem('cil-after-reg') || 'null'); } catch {}
      if (r.complete && back?.ev) { toast('已儲存，回到報名'); location.hash = `#/e/${back.ev}`; return; }
      toast(r.complete ? '已儲存，可以報名代為團體報名的活動了' : '已儲存，還有必填欄位沒填'); meReg();
    } catch (err) { toast(err.message); }
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
      <h2 class="h3">主團</h2>
      ${main ? `<a class="teamchip active" href="#/t/${esc(main.id)}" style="--tc:${esc(main.color)}">${teamIcon(main, 'xs')}<span><span translate="no">${esc(main.name)}</span></span><span class="tiny">主團</span></a>`
        : '<p class="notice" style="margin:0">管理員還沒幫你設定主團，設定好之後就會收到分團的活動與公告。</p>'}
      ${led.length ? `<h2 class="h3">其他分團</h2><div class="teamrow">${led.map((t) => `<a class="teamchip ${t.my_status}" href="#/t/${esc(t.id)}" style="--tc:${esc(t.color)}">${teamIcon(t, 'xs')}<span><span translate="no">${esc(t.name)}</span></span><span class="tiny">${t.my_status === 'pending' ? '申請中' : esc(t.my_title || TEAM_ROLE_NAME[t.my_role])}</span></a>`).join('')}</div>` : ''}
    </section>
    <a class="btn ghost block" href="#/teams">看全部分團</a>`;
}
// 推播哪些通知：每個類別一列；帳號安全與活動異動一律推播
const NPREF = [
  ['security', '新裝置登入、通行金鑰、身分變更'], ['change', '已報名的活動取消、改時間、改地點、候補轉正'],
  ['signup', '前一晚與集合前提醒、天氣、到貨、中獎'], ['event', '新團練、揪跑、問卷、邀請與賽事提醒'],
  ['training', '新課表、教練回饋、跑後記錄提醒、每月里程'], ['membership', '入團結果、主團、入會與會費到期'],
  ['announce', '協會與分團公告'], ['todo', '入團入會申請、繳費確認、地點審核、天氣調整'],
];
const prefRows = (p) => NPREF.filter(([k]) => k !== 'todo' || p.officer).map(([k, desc]) => {
  const locked = p.locked.includes(k);
  return `<label class="setrow nprefrow" id="pref-${k}"><span class="ntile n-${k}" aria-hidden="true">${NICON[k]}</span>
    <span class="st"><b>${CATS[k].zh}</b><span class="tiny">${desc}</span>${locked ? '<span class="tiny">一律推播</span>' : ''}${k === 'todo' && p.reviewForced ? '<span class="tiny">每季權限檢視一律推播</span>' : ''}</span>
    <span class="switch"><input type="checkbox" data-pref="${k}" ${locked || !p.mute.includes(k) ? 'checked' : ''}${locked ? ' disabled' : ''}><i></i></span></label>`;
});
async function meNotify() {
  // 換人時正在取消上一位的推播訂閱：等它做完再讀，不會把上一位的訂閱當成這個人的
  await Device.pushReady();
  const reg = await Promise.race([navigator.serviceWorker?.ready.catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  const [sub, prefs] = await Promise.all([reg?.pushManager?.getSubscription().catch(() => null), api('/me/notify-prefs').catch(() => null)]);
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  view.innerHTML = `${subTitle('通知設定', '推播類別、加到主畫面')}
    <section class="card">
      <div class="row spread"><h3>這支手機的推播</h3>${cfg.vapid ? `<span class="pill${sub ? ' solid' : ''}">${sub ? '已開啟' : denied ? '已被封鎖' : '未開啟'}</span>` : ''}</div>
      ${cfg.vapid ? `<p class="muted" style="margin:0">依照下方類別推播到這支手機，通知中心一律保留紀錄。${isStandalone() ? '' : '在 iPhone 上要先「加到主畫面」，再從主畫面打開才收得到。'}</p>
        ${denied && !sub ? `<p class="notice" style="margin:0">${ios ? '到 iPhone 設定 → 通知 → 耕跑團，打開「允許通知」' : '長按主畫面的耕跑團圖示 → 應用程式資訊 → 通知'}</p>` : ''}
        <p class="notice" id="pushStale" style="margin:0" hidden>這支手機的推播已失效，請重新開啟</p>
        <div class="row"><button class="btn sm" id="pushBtn">${sub ? '關閉通知' : '開啟通知'}</button>${sub ? '<button class="btn ghost sm" id="pushTest">發測試通知</button>' : ''}</div>`
        : '<p class="muted" style="margin:0">推播功能尚未啟用。</p>'}
    </section>
    ${prefs ? `${!sub && cfg.vapid ? '<p class="tiny" style="margin:0 6px">這支手機還沒開啟推播，設定會在開啟後生效</p>' : ''}
      ${group('推播哪些通知', prefRows(prefs))}
      <p class="tiny" style="margin:-4px 6px 0">關掉的類別仍會留在通知中心，只是不推播到手機。設定跟著帳號，換手機也一樣。</p>` : ''}
    ${installCard('me')}`;
  $('#pushBtn')?.addEventListener('click', () => togglePush(sub));
  $('#pushTest')?.addEventListener('click', async () => { try { await api('/push/test', { method: 'POST' }); toast('已送出測試通知'); } catch (e) { toast(e.message); } });
  // 切換時先改畫面再存；失敗就切回去
  for (const inp of document.querySelectorAll('[data-pref]')) inp.onchange = async () => {
    const mute = [...document.querySelectorAll('[data-pref]:not(:checked):not(:disabled)')].map((x) => x.dataset.pref);
    try { await api('/me/notify-prefs', { method: 'PUT', body: { mute } }); }
    catch { inp.checked = !inp.checked; toast('設定沒有存成功'); }
  };
  // 從通知的「關閉這一類推播」過來：捲到那一列並亮一下
  const focusCat = new URLSearchParams(location.hash.split('?')[1] || '').get('cat');
  const pr = focusCat && /^\w+$/.test(focusCat) && $(`#pref-${focusCat}`);
  if (pr) { pr.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); pr.classList.add('flash'); setTimeout(() => pr.classList.remove('flash'), 1200); }
  // 伺服器已經刪掉這支手機的訂閱（推播服務回 404／410）：權限還在、而且這個訂閱是目前登入的人開的，才悄悄重新訂閱
  //   （不知道是誰開的就請本人自己重新開啟，不把上一位的 endpoint 綁到這個帳號）
  if (sub && cfg.vapid) api('/push/check', { method: 'POST', body: { endpoint: sub.endpoint } }).then(async ({ known }) => {
    if (known) { Device.markPush(lsOrNull(), me?.id); return; }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && Device.mayRebind(lsOrNull(), me?.id)) {
      try { const j = sub.toJSON(); await api('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } }); toast('已重新連上推播'); return; } catch {}
    }
    const el = $('#pushStale'); if (el) el.hidden = false;
  }).catch(() => {});
  bindInstall();
}
// 行事曆訂閱：從「通知設定」搬出來的子頁（行事曆頁的「訂閱到手機行事曆」也連到這裡）
function meCalendar() {
  view.innerHTML = `${subTitle('行事曆訂閱', '團練與賽事自動出現在手機行事曆')}
    <section class="card" id="calCard">
      <div class="row spread"><h2 class="h3">訂閱到手機行事曆</h2>${cfg.calendarOn ? '<span class="pill solid">已開啟</span>' : ''}</div>
      <p class="tiny" style="margin:0">團練、揪跑與幹部設定的賽事提醒會自動出現在 iPhone、Google 行事曆，有變動也會跟著更新。訂閱網址等同你的個人鑰匙，不要分享給別人。</p>
      <label class="switch"><span>包含所有開團活動與賽事提醒<span class="tiny" style="display:block">關掉就只有自己報名的</span></span><input type="checkbox" id="calScope" ${cfg.calScope !== 'mine' ? 'checked' : ''}><i></i></label>
      <div id="calBox" class="row" style="gap:8px">${cfg.calendarOn ? '<button class="btn ghost sm" id="calNew">重新產生網址</button><button class="btn ghost sm" id="calOff">停用</button>' : '<button class="btn sm" id="calNew">產生訂閱網址</button>'}</div>
    </section>`;
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
  $('#calScope').onchange = async (e) => { try { const r = await api('/me/calendar-scope', { method: 'POST', body: { scope: e.target.checked ? 'all' : 'mine' } }); cfg.calScope = r.scope; toast(e.target.checked ? '行事曆會包含所有活動' : '行事曆只放自己報名的'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#calOff')?.addEventListener('click', async () => { await api('/me/calendar', { method: 'DELETE' }); cfg.calendarOn = false; toast('已停用行事曆訂閱'); meCalendar(); });
}
// 外觀與語言：只存在這台裝置（深淺色、分頁列只顯示圖示、語言、省流量）
function meDisplay() {
  const t = theme.get() || 'auto';
  view.innerHTML = `${subTitle('外觀與語言', '只影響這台裝置')}
    <section class="card dispcard"><h2 class="h3">外觀</h2>
      <div class="seg themeseg" role="group" aria-label="外觀">${[['auto', '自動'], ['light', '淺色'], ['dark', '深色']].map(([k, v]) => `<button type="button" data-pick-theme="${k}" aria-pressed="${t === k}">${v}</button>`).join('')}</div>
      <p class="tiny" style="margin:0">自動會跟著手機的深淺色設定切換</p>
      <label class="switch"><span>分頁列只顯示圖示<span class="tiny" style="display:block">預設顯示文字；往下捲時也會自動收起文字</span></span><input type="checkbox" id="iconsOnly" ${iconsOnly.get() ? 'checked' : ''}><i></i></label>
    </section>
    <section class="card"><div class="row spread"><span>語言${I18N.lang === 'en' ? '' : '<span class="tiny" style="display:block" translate="no">Language</span>'}</span>
      <div class="seg themeseg" role="group" aria-label="Language" translate="no"><button data-lang="zh" aria-pressed="${I18N.lang === 'zh'}">中文</button><button data-lang="en" aria-pressed="${I18N.lang === 'en'}">English</button></div></div></section>
    ${cfg.settings?.features?.cams === true ? `<section class="card"><label class="switch"><span>省流量：影像不自動載入<span class="tiny" style="display:block">地點卡的附近即時影像點了才載入、不自動更新</span></span><input type="checkbox" id="camLazy" ${camLazy.get() ? 'checked' : ''}><i></i></label></section>` : ''}`;
  for (const b of document.querySelectorAll('[data-pick-theme]')) b.onclick = () => {
    theme.set(b.dataset.pickTheme === 'auto' ? null : b.dataset.pickTheme); applyTheme();
    for (const x of document.querySelectorAll('[data-pick-theme]')) x.setAttribute('aria-pressed', String(x === b));
  };
  $('#iconsOnly').onchange = (e) => { iconsOnly.set(e.target.checked); applyTabs(); };
  $('#camLazy')?.addEventListener('change', (e) => camLazy.set(e.target.checked));
  for (const b of document.querySelectorAll('[data-lang]')) b.onclick = () => { if (b.dataset.lang !== I18N.lang) I18N.setLang(b.dataset.lang); };
}
async function meSecurity(googleMsg) {
  view.innerHTML = `${subTitle('帳號與安全')}
    ${googleMsg === 'linked' ? '<div class="notice">已綁定 Google，之後可以直接用 Google 登入。</div>' : googleMsg === 'taken' ? '<div class="notice">這個 Google 帳號已經綁定另一個帳號了。如果那個帳號也是你的，請聯絡行政人員合併。</div>'
      : googleMsg === 'stepup' ? '<div class="notice">綁定 Google 前，請先按下方「驗證一次」用通行金鑰確認是你本人，再重新綁定。</div>' : ''}
    ${mfaBanner()}
    ${cfg.googleLogin ? `<section class="card"><div class="row spread"><div><h2 class="h3">Google 帳號</h2><span class="tiny">${me.google ? '已綁定，可以用 Google 登入' : '綁定後換手機或清掉瀏覽器資料，也能用 Google 回到同一個帳號'}</span></div>
      ${me.google ? '<span class="pill solid">已綁定</span>' : `<a class="btn google sm" href="${googleHref(true)}">${GOOGLE_G}<span>綁定</span></a>`}</div></section>` : ''}
    <section class="card" id="pkCard">
      <div class="row spread"><h2 class="h3">通行金鑰</h2>${me.mfa ? `<span class="pill solid">${IC.check}這次已驗證</span>` : ''}</div>
      <p class="tiny" style="margin:0">用 Face ID、Touch ID 或手機指紋登入，不用密碼。${['chair', 'director', 'supervisor', 'staff', 'coach'].includes(me.realRole || me.role) ? '幹部建議至少新增一把，協會開啟兩步驟驗證後要用它驗證。' : ''}</p>
      <div id="pkList" class="roster"></div>
      <div class="row" style="gap:8px">${pkSupported() ? `<button class="btn sm" id="pkAdd">${IC.plus}新增通行金鑰</button>` : '<span class="tiny">這個瀏覽器不支援通行金鑰</span>'}
        <button class="btn ghost sm" data-stepup id="pkTest" hidden>驗證一次</button></div>
    </section>
    ${me.role !== 'member' || !cfg.bootstrapOpen ? '' : `<details class="card tight"><summary class="tiny">系統初始設定（只限第一位理事長）</summary>
      <p class="tiny">幹部身分一律由理事長在後台指派。這裡只用在系統剛建立、還沒有理事長的時候。</p>
      <form id="af" class="row" style="gap:8px"><input name="code" placeholder="初始設定碼" autocapitalize="none" autocorrect="off" spellcheck="false" type="password" aria-label="初始設定碼" style="flex:1;min-width:140px" autocomplete="off"><button class="btn sm">設定</button></form></details>`}
    ${group('', [btnRow('logout', MI.out, '登出'), btnRow('logoutAll', MI.lock, '登出所有裝置', '手機掉了或懷疑被別人登入時')])}`;
  bindStepup();
  const loadPk = async () => {
    const { passkeys } = await api('/passkeys');
    if (!$('#pkList')) return;
    $('#pkList').innerHTML = passkeys.map((p) => `<div class="r">${IC.lock}<span><span translate="no">${esc(p.name || '通行金鑰')}</span><span class="tiny" style="display:block">新增於 ${esc(p.created_at.slice(0, 10))}${p.last_used_at ? `・上次使用 ${ago(p.last_used_at)}` : ''}</span></span>
      <button class="btn ghost sm" data-pkdel="${esc(p.id)}">移除</button></div>`).join('');
    $('#pkTest').hidden = !passkeys.length || (me.mfa && googleMsg !== 'stepup');
    for (const b of document.querySelectorAll('[data-pkdel]')) b.onclick = async () => { if (!confirm('移除這把通行金鑰？之後這台裝置就不能用它登入。')) return; await api(`/passkeys/${encodeURIComponent(b.dataset.pkdel)}`, { method: 'DELETE' }); toast('已移除'); loadPk(); };
  };
  loadPk().catch(() => {});
  $('#pkAdd')?.addEventListener('click', async () => {
    try { await passkey('register'); toast('已新增通行金鑰'); try { await passkey('stepup'); setMe(null); render(); return; } catch {} loadPk(); }
    catch (e) { if (e.message !== '已取消') toast(e.message); }
  });
  $('#af')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { setMe((await api('/me/admin', { method: 'POST', body: { code: e.target.code.value } })).member); toast('已設定為理事長'); render(); } catch (err) { toast(err.message); }
  });
  $('#logout').onclick = async () => { if (!await askLegacyOnLeave()) return; await dropPush(); await api('/logout', { method: 'POST' }); clearDeviceData(); setMe(null); location.hash = '#/'; render(); };
  $('#logoutAll').onclick = async () => { if (!confirm('要登出所有裝置嗎？包含這一台。') || !await askLegacyOnLeave()) return; await api('/logout', { method: 'POST', body: { all: true } }); await dropPush(false); clearDeviceData(); setMe(null); location.hash = '#/'; render(); };
}
function mePrivacy() {
  view.innerHTML = `${subTitle('隱私')}
    <section class="card">
      <label class="switch"><span>把訓練完成率、里程與平均強度分享給教練與分團幹部<span class="tiny" style="display:block">每次的時間、心率、強度、感覺與備註永遠只有你看得到</span></span><input type="checkbox" id="shareLogs" ${me.share_logs ? 'checked' : ''}><i></i></label>
      <label class="switch"><span>出現在分團里程排行榜<span class="tiny" style="display:block">只有同分團的人看得到你的名字與里程</span></span><input type="checkbox" id="showRank" ${me.show_rank ? 'checked' : ''}><i></i></label>
    </section>
    <section class="card"><h2 class="h3">我們存了什麼</h2>
      <p class="tiny" style="margin:0">姓名、暱稱、組別、主團、餐點偏好、報名與訓練紀錄；賽事報名資料加密保存；電話只有行政人員看得到完整號碼。</p>
      <div class="row"><a class="btn ghost sm" href="#/privacy">隱私權政策</a><a class="btn ghost sm" href="/api/me/export" download>下載我的資料</a></div></section>
    ${feat('coach') ? group('', [row('#/plan/setup?go=device', MI.phone, '這台裝置上的課表設定與身體資料', '只存在這台裝置，不會上傳；登出時清除')]) : ''}
    <section class="card"><h2 class="h3">刪除帳號</h2><p class="tiny" style="margin:0">報名、入場券、通知與訓練紀錄都會刪除，中獎紀錄只留獎項給協會對帳。</p>
      <button class="btn danger block" id="delAcct">刪除我的帳號</button></section>`;
  $('#showRank').onchange = async (e) => { try { await api('/me/show-rank', { method: 'POST', body: { on: e.target.checked } }); me.show_rank = e.target.checked; toast(e.target.checked ? '已加入排行榜' : '已退出排行榜'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#shareLogs').onchange = async (e) => { try { await api('/me/share-logs', { method: 'POST', body: { share: e.target.checked } }); me.share_logs = e.target.checked; toast(e.target.checked ? '已分享給教練' : '已停止分享'); } catch (err) { e.target.checked = !e.target.checked; toast(err.message); } };
  $('#delAcct').onclick = async () => {
    if (!confirm('刪除後無法復原。確定刪除帳號？') || !await askLegacyOnLeave()) return;
    try { await api('/me', { method: 'DELETE' }); clearDeviceData(); setMe(null); toast('帳號已刪除'); location.hash = '#/'; render(); } catch (e) { toast(e.message); }
  };
}
// 分享 App：當面掃 QR、手機分享選單、LINE、複製連結。只分享網址（用 Google 登入加入），不帶邀請碼
export function shareApp() {
  const url = `${location.origin}/`, name = org().short || '耕跑團';
  const text = `一起加入${name}！團練報名、分組課表、GPS 跑步記錄和拍照分享都在這裡。用 Google 帳號登入，加到主畫面就像 App 一樣：${url}`;
  // 共用 openSheet：焦點移進面板、Tab 不跑出去、Esc 關閉，關掉後焦點回到「分享耕跑團 App」
  const { host } = openSheet('分享 App', `<div class="row spread"><h3 id="saT">分享${esc(name)} App</h3><button type="button" class="btn ghost sm" data-close>完成</button></div>
    <div class="shareqr"><div class="qrbox" id="appQR" role="img" aria-label="App 網址的 QR Code"></div><span class="tiny">請朋友用手機相機掃描</span></div>
    <div class="${navigator.share ? 'grid2' : 'grid1'}">${navigator.share ? `<button type="button" class="btn iconbtn" id="saNative">${MI.share}分享…</button>` : ''}
      <a class="btn ${navigator.share ? 'ghost ' : ''}iconbtn" href="https://line.me/R/share?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">分享到 LINE</a></div>
    <button type="button" class="btn ghost block" id="saCopy">複製連結</button>
    <p class="tiny" style="margin:0">朋友打開後用 Google 帳號登入就能加入成為跑友；要成為協會會員另外申請。</p>`, document.activeElement, 'saT');
  host.querySelector('.sheet-card').classList.add('shareapp');
  qrSVG(url, { size: 220, dark: '#0B1B33', light: '#fff' }).then((svg) => { const q = host.querySelector('#appQR'); if (q) q.innerHTML = svg; }).catch(() => {});
  host.querySelector('#saNative')?.addEventListener('click', async () => { try { await navigator.share({ title: name, text, url }); } catch {} });
  host.querySelector('#saCopy').onclick = () => copy(text);
}
// 會籍卡：協會會員的電子卡，QR 有簽章，幹部掃了看得到會籍狀態
async function meCard() {
  const c = await api('/me/card');
  const member = c.membership === 'active', valid = member && (!c.paid_until || c.paid_until >= ymd(new Date()));
  const state = valid ? '有效' : member ? '已到期' : '尚未入會';
  view.innerHTML = `${subTitle('會籍卡', '活動報到或優惠時出示給幹部掃描')}
    <section class="membercard ${valid ? '' : 'expired'}">
      <div class="mc-top"><img src="/icons/icon-192.png" alt="" width="44" height="44"><span><b translate="no">${esc(c.org)}</b><small translate="no">CULTIVATION IN LIFE RUN</small></span></div>
      <div class="mc-mid"><div><span class="tiny">會員</span><b translate="no">${esc(c.name)}</b>${c.member_no ? `<span class="num">No. <span translate="no">${esc(c.member_no)}</span></span>` : ''}</div><div class="qrbox" id="cardQR"></div></div>
      <div class="mc-foot"><span>${esc(member ? c.member_type || '會員' : '跑友')}</span>${member ? `<span>${c.paid_until ? `有效至 ${esc(c.paid_until)}` : '長期有效'}</span>` : ''}<span class="pill ${valid ? 'solid' : 'wait'}">${state}</span></div>
    </section>
    ${valid ? '' : member ? '<p class="notice">會費已到期，續繳後行政人員更新會籍，卡片就會恢復有效。</p>' : '<p class="notice">你還不是協會會員。想加入協會，到「我的 → 協會」填入會表單。<a href="#/me/assoc">前往 ›</a></p>'}
    <p class="tiny center">卡上的 QR 有防偽簽章，截圖分享給別人也只會顯示你的名字。</p>`;
  qrSVG(c.qr, { size: 180, dark: '#0B1B33', light: '#fff' }).then((svg) => { if ($('#cardQR')) $('#cardQR').innerHTML = svg; }).catch(() => {});
}
function meAssoc() {
  view.innerHTML = `${subTitle(esc(org().name || '台灣耕跑團協會'))}
    <section class="card">
      <div class="row spread"><h2 class="h3">會籍</h2><span class="pill ${me.membership === 'active' ? 'solid' : me.membership === 'applied' ? 'wait' : ''}">${esc(me.membershipName || '跑友')}</span></div>
      ${me.membership === 'active'
        ? `<p class="muted" style="margin:0">${esc(me.member_type || '會員')}${me.member_no ? `・編號 ${esc(me.member_no)}` : ''}${me.paid_until ? `・會費繳至 ${esc(me.paid_until)}` : ''}</p>`
        : `<p class="muted" style="margin:0">跑友可以報名所有團練；想加入協會，先填官方入會表單，再按下方按鈕通知行政人員。</p>
           ${org().join_form ? `<a class="btn ghost block" href="${esc(org().join_form)}" target="_blank" rel="noopener">開啟入會表單 ${IC.external}</a>` : ''}
           ${me.membership === 'applied' ? '<p class="notice" style="margin:0">已送出申請，等行政人員確認。</p>' : '<button class="btn block" id="applyBtn">我已填表，送出申請</button>'}`}
    </section>
    ${(cfg.settings?.docs || []).length || org().contact || org().parent ? `<section class="card"><h2 class="h3">協會資訊</h2>
      ${org().parent ? `<p class="tiny" style="margin:0">所屬企業：${org().parent_url ? `<a href="${esc(org().parent_url)}" target="_blank" rel="noopener">${esc(org().parent)} ${IC.external}</a>` : esc(org().parent)}${org().parent_note ? `・${esc(org().parent_note)}` : ''}</p>` : ''}
      ${org().contact ? `<p class="tiny" style="margin:0">聯絡方式：${esc(org().contact)}</p>` : ''}
      <div class="doclist">${(cfg.settings?.docs || []).map((d) => `<a class="docrow" href="${esc(d.url)}" target="_blank" rel="noopener"><span class="docic">${IC.doc}</span><span><b><span translate="no">${esc(d.title)}</span></b>${d.note ? `<span class="tiny" style="display:block"><span translate="no">${esc(d.note)}</span></span>` : ''}</span><span class="tiny">${IC.external}</span></a>`).join('')}</div>
    </section>` : ''}`;
  $('#applyBtn')?.addEventListener('click', async () => { try { setMe((await api('/me/apply', { method: 'POST' })).member); toast('已送出申請'); meAssoc(); } catch (e) { toast(e.message); } });
}

// 子頁對照（app.js 的 meView 依網址呼叫）
export function meSection(section, googleMsg) {
  return ({ profile: meProfile, races: meRaces, reg: meReg, teams: meTeams, notify: meNotify, calendar: meCalendar, display: meDisplay, security: meSecurity, privacy: mePrivacy, assoc: meAssoc, card: meCard })[section](googleMsg);
}
