// 耕跑團 PWA — 活動頁（用到才載入，首頁、課表、我的、地圖開機時不用下載）
//   活動詳情與報名、邀請制、繳費、入場券、現場報到 QR、掃碼報到、春酒座位與抽獎、LINE 公告
//   共用的工具與狀態從 app.js 拿（app.js 已經載入，不會重複下載）
import {
  $, addrField, ago, allow, api, apiAll, applyCounts, avatar, bellState, bindAddrField, canScan, choose, copy, dayPattern, downloadAuthed, dstr,
  emptyState, esc, fixText, IC, isOffline, KIND_NAME, largeTitle, latest, mapsUrl, me, money, myCycle, nowTp, once, qrSVG, render, routeSvg, scan,
  scanSheet, setStopScan, submitLabel, teamAllow, teams, toast, view, ymd, fieldError, focusAfterRender, announce
} from './app.js';
import * as P from './plan.js';
import * as Party from './party.js';
import { quote, charges } from './pricing.js';
import { evStart, signupEnd, signupState, STATE_LABEL, tpShort, tpText } from './signup-window.js';

// 報名送出後的提示
function signupToast(r, ev) {
  if (ev.kind === 'survey') return '已送出，謝謝你的回覆';
  if (r.status === 'pending') return r.full ? '已送出申請，目前額滿，核准後會排入候補' : '已送出申請，等主辦幹部審核，結果會通知你';
  if (r.status === 'wait') return `人數已滿，已排入候補第 ${r.position || 1} 位，有人取消會自動遞補並通知你`;
  if (r.amount) return `報名完成，應繳 ${money(r.amount)}`;
  return ev.kind === 'party' ? '報名完成，入場券在上方' : `報名完成，${dstr(ev.date)} 見`;
}
// 報名成功的提示卡（報名送出後那一次重畫）：主辦自訂的「報名成功訊息」（正取才顯示），
//   正取、候補可以「分享到 LINE 群組」跟大家說一聲（本人自己選群組，App 不代發）；一般的提示照樣用 toast
let justSigned = null;
function signedCard(ev, done, link) {
  const msg = done.status === 'in' && ev.success_msg;
  const share = (done.status === 'in' || done.status === 'wait') && link && ev.kind !== 'survey';
  if (!msg && !share) return '';
  const text = [`我報名了【${ev.title}】${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}` : ''}${ev.place ? `・${ev.place}` : ''}`, `一起來：${share ? forLine(link) : ''}`].join('\n');
  return `<div class="notice signedcard" id="signedCard">
    ${msg ? `<p style="margin:0;white-space:pre-wrap"><span translate="no">${esc(msg)}</span></p>` : ''}
    ${share ? `<div class="row" style="gap:8px"><a class="btn sm" id="tellLine" href="https://line.me/R/share?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">分享到 LINE 群組</a>
      <span class="tiny">告訴大家你報名了，連結點了就能報名</span></div>` : ''}
  </div>`;
}
// 攜伴：人數選單＋每位的姓名（選填，只有主辦看得到）；餐敘或有開「可攜伴人數」的活動
const guestFields = (ev) => {
  const n = ev.myGuests || 0, names = ev.myGuestNames || [];
  const left = ev.capacity && ev.count_guests ? Math.max(0, ev.capacity - (ev.seatsIn || 0) + (ev.myStatus === 'in' ? 1 + n : 0)) : null;
  return `<fieldset class="qset guests"><legend>攜伴</legend>
    <label>人數<select name="guests">${Array.from({ length: ev.guest_max + 1 }, (_, i) => `<option value="${i}" ${i === n ? 'selected' : ''}>${i ? `${i} 位` : '不帶'}</option>`).join('')}</select></label>
    <div class="guestnames">${Array.from({ length: ev.guest_max }, (_, i) => `<label data-g="${i}" ${i < n ? '' : 'hidden'}>攜伴 ${i + 1} 姓名（選填）<input name="guest_name" maxlength="20" value="${esc(names[i] || '')}" autocomplete="off"></label>`).join('')}</div>
    <span class="tiny">姓名只有主辦看得到，名單上只顯示「＋人數」${ev.count_guests ? `；攜伴也佔名額${left != null ? `，目前還有 ${left} 位` : ''}` : ''}</span>
  </fieldset>`;
};
// 給主辦的備註：每次打開換一個例子（團員常寫的事），讓人知道可以寫什麼；只有主辦看得到
const NOTE_HINTS = {
  track: ['會晚 10 分鐘到', '想跟阿明同一組', '間歇想跑慢一組', '第一次來，請多指教'],
  core: ['膝蓋有點緊，強度會放低', '會晚 10 分鐘到', '想借一張瑜珈墊', '第一次來，請多指教'],
  long: ['只跑前 15 公里', '想跟 6 分速的一起跑', '會自己帶補給', '會晚 10 分鐘到'],
  race: ['想一起搭車到會場', '這場想破四', '需要幫忙寄物', '會直接到起點'],
  party: ['素食', '想跟阿明同桌', '會晚半小時到', '不吃牛'],
  buy: ['週四團練現場領', '想跟阿明一起領', '尺寸還在猶豫'],
  other: ['會晚 10 分鐘到', '第一次來，請多指教', '想跟阿明同一組'],
};
const noteHint = (kind) => { const l = NOTE_HINTS[kind] || NOTE_HINTS.other; return `例如：${l[Math.floor(Math.random() * l.length)]}`; };
const noteField = (ev, value, id = '') => `<label>給主辦的備註（選填）<span class="tiny" style="display:block">只有主辦看得到，不會出現在名單上</span>
  <input name="note"${id ? ` id="${id}"` : ''} maxlength="100" value="${esc(value || '')}" placeholder="${esc(noteHint(ev.kind))}" autocomplete="off"></label>`;
// 分享與公告用的報名期間文字；只有開放或即將開放時才附連結
const windowLine = (ev) => `報名期間：${ev.signup_start ? tpShort(ev.signup_start) : '即日起'} – ${tpShort(signupEnd(ev))}${ev.require_approval ? '（需主辦審核）' : ''}`;
const shareable = (ev) => ['open', 'soon'].includes(signupState(ev, nowTp()));
// 名單上的攜伴：只顯示人數（姓名只有主辦看得到）
const plusN = (s) => (s.guests ? ` <span class="tiny num">＋${s.guests}</span>` : '');
// 分享活動：手機跳出分享選單（LINE、訊息…），不支援就複製文字＋連結
// 分享連結用 /e/:id：伺服器幫 LINE 等的連結預覽加上活動摘要（標題、日期時間、地點、報名狀態），打開後前端轉成 /#/e/:id
const eventUrl = (id) => `${location.origin}/e/${id}`;
// 貼到 LINE 的連結：openExternalBrowser=1 讓 LINE 直接用 Safari／Chrome 打開（LINE 內建瀏覽器不能用 Google 登入，也沒有主畫面 App 的登入狀態）
const forLine = (u) => `${u}${u.includes('?') ? '&' : '?'}openExternalBrowser=1`;
// 能分享的連結：邀請制一定要帶邀請代碼，只有主辦（開了邀請連結）拿得到；其他人分享不了邀請制活動（回傳 null）
const shareLink = (ev) => (ev.visibility === 'invite' ? (ev.manage && ev.invite?.token ? `${eventUrl(ev.id)}?t=${ev.invite.token}` : null) : eventUrl(ev.id));
async function shareEvent(ev, link = eventUrl(ev.id)) {
  const text = `${ev.title}｜${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}` : ''}${ev.place ? `・${ev.place}` : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: ev.title, text, url: link }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(`${text}\n${ev.kind === 'survey' ? '填寫' : '報名'}：${link}`);
}
// ---------- 活動詳情 ----------
export async function eventView(id) {
  // 從邀請連結進來：先把自己加進受邀名單
  const tok = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  if (tok) {
    try { await api(`/events/${id}/accept`, { method: 'POST', body: { t: tok } }); } catch (e) { toast(e.message); }
    history.replaceState(null, '', `#/e/${id}`);
  }
  const ev = await api(`/events/${id}`);
  // 打開活動頁＝這個活動的通知都看過了（伺服器會排除幹部待辦與帳號安全）
  if (bellState.unread > 0) api('/notifications/read', { method: 'POST', body: { ref: `e:${id}` } }).then(applyCounts).catch(() => {});
  const inviteOnly = ev.visibility === 'invite';
  const admin = ev.manage;
  const survey = ev.kind === 'survey', qs = ev.questions || [];
  const useForm = ev.kind === 'party' || ev.guest_max > 0 || qs.length > 0 || (ev.options || []).length > 0 || !!ev.group_reg || (ev.items || []).length > 0 || charges(ev);
  const ins = ev.signups.filter((s) => s.status === 'in'), waits = ev.signups.filter((s) => s.status === 'wait');
  // 自己的狀態一律從 myStatus 取（待審核、未通過不在公開的 signups 裡）
  const myStatus = ev.myStatus, live = ['in', 'wait', 'pending'].includes(myStatus);
  // 名額算位子：勾了「攜伴也佔名額」的活動，正取的本人＋攜伴都算
  ev.seatsIn = ins.reduce((n, s) => n + (ev.count_guests ? 1 + (s.guests || 0) : 1), 0);
  const now = nowTp(), st = signupState(ev, now), full = !!ev.capacity && ev.seatsIn >= ev.capacity;
  const done = justSigned?.id === id ? justSigned : null;
  justSigned = null;
  const canSubmit = st === 'open' && myStatus !== 'rejected', started = now >= evStart(ev);
  const party = ev.kind === 'party';
  // 入場券、座位、當週課表同時載入
  const [myTicket, seatInfo, plan] = await Promise.all([
    party ? api('/my/tickets').then((r) => r.tickets.find((t) => t.event_id === ev.id)) : null,
    party ? api(`/events/${id}/seats`) : { seats: [], layout: null },
    ev.week_no ? P.weekPlan(ev.week_no, me.dist, me.grp) : null]);
  const seatData = seatInfo.seats;
  const myDay = plan?.find((d) => new RegExp(dayPattern(ev.date)).test(d.d));
  // 個人週期：團練是協會的課，另外列出自己課表這天要練什麼
  const cyc = myCycle(), cw = cyc.kind !== 'club' && P.inCycle(ev.date, cyc) ? P.weekIndexOf(ev.date, cyc) : null;
  const myOwn = cw ? (await P.weekPlan(cw, me.dist, me.grp))?.find((d) => P.dayDates(cw, d.d, cyc, d).includes(ev.date)) : null;

  view.innerHTML = `
    <section class="card hero">
      <div class="row spread">
        <span class="row" style="gap:6px"><span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${KIND_NAME[ev.kind]}</span>${ev.team ? `<a class="pill" style="background:rgba(255,255,255,.14);color:#fff" href="#/t/${esc(ev.team.id)}"><span translate="no">${esc(ev.team.name)}</span></a>` : ''}${inviteOnly ? `<span class="pill" style="background:rgba(255,255,255,.14);color:#fff">${IC.lock}邀請制</span>` : ''}</span>
        <span class="tiny">${survey ? `${dstr(ev.date)} 前` : dstr(ev.date)}</span>
      </div>
      <h1 class="evtitle"><span translate="no">${esc(ev.title)}</span></h1>
      <p class="muted" style="margin:0">${ev.gather_time ? `${ev.gather_time} ${party ? '開始' : '集合'}` : ''}${ev.end_time ? `－${ev.end_time}` : ''}${ev.place ? `　<span translate="no">${esc(ev.place)}</span>` : ''}${ev.lead ? `　帶團：<span translate="no">${esc(ev.lead)}</span>` : ''}</p>
      ${ev.address || (ev.place && !ev.spot) ? `<a class="navlink" href="${mapsUrl(ev.address || ev.place)}" target="_blank" rel="noopener">${IC.pin}<span>${ev.address ? `${ev.address_zip ? `<span class="num">${esc(ev.address_zip)}</span> ` : ''}<span translate="no">${esc(ev.address)}</span>` : '在地圖上查看'}</span><b>導航</b></a>` : ''}
      ${(ev.options || []).length || (ev.items || []).length ? `<div class="pricechips">${[...(ev.options || []), ...(ev.items || [])].map((o) => `<span><b><span translate="no">${esc(o.name)}</span></b>${o.price ? `<span class="num">${money(o.price)}</span>` : ''}</span>`).join('')}</div>`
        : ev.fee ? `<div class="pricechips"><span><b>費用</b><span class="num">${money(ev.fee)}</span></span></div>` : ''}
      ${ev.pricing?.early_off && ev.pricing.early_until >= ymd(new Date()) ? `<p class="tiny" style="margin:0;color:rgba(255,255,255,.9)">早鳥 ${esc(ev.pricing.early_until.slice(5).replace('-', '/'))} 前報名折 ${money(ev.pricing.early_off)}${ev.pricing.member_off ? `・協會會員再折 ${money(ev.pricing.member_off)}` : ''}</p>`
        : ev.pricing?.member_off ? `<p class="tiny" style="margin:0;color:rgba(255,255,255,.9)">協會會員折 ${money(ev.pricing.member_off)}</p>` : ''}
      ${ev.cancelled ? '<p class="cancelled">這場已取消</p>' : `<p class="tiny" id="evWindow" style="margin:0;color:rgba(255,255,255,.9)">${survey ? `回覆截止 ${tpText(signupEnd(ev))}`
        : `報名期間 ${ev.signup_start ? tpText(ev.signup_start) : '即日起'} – ${tpText(signupEnd(ev))}${ev.require_approval ? '・需主辦審核' : ''}`}</p>`}
      ${ev.group_reg ? '<p class="tiny" style="margin:0;color:rgba(255,255,255,.85)">由幹部代為團體報名</p>' : ''}
      ${(ev.series || []).length > 1 ? `<div class="serieschips" aria-label="定期揪跑的其他場次">${ev.series.filter((x) => x.date >= ymd(new Date())).slice(0, 8).map((x) => `<a class="${x.id === ev.id ? 'on' : ''}" href="#/e/${esc(x.id)}">${esc(dstr(x.date))}</a>`).join('')}</div>` : ''}
      ${ev.note ? `<p class="muted" style="margin:0;white-space:pre-wrap"><span translate="no">${esc(ev.note)}</span></p>` : ''}
      ${ev.link_url ? `<a class="btn block" style="background:#fff;color:#1C4698" href="${esc(ev.link_url)}" target="_blank" rel="noopener">${ev.link_label ? `<span translate="no">${esc(ev.link_label)}</span>` : '前往登記'} ${IC.external}</a>` : ''}
      ${inviteOnly && !admin ? '' : `<div class="row sharebar">
        <button class="btn sm glassbtn" id="shareEv"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/></svg>分享</button>
        <a class="btn sm glassbtn" id="shareLine" href="#" rel="noopener">分享到 LINE</a>
        <button class="btn sm glassbtn" id="copyLink">${inviteOnly ? '複製邀請連結' : '複製報名連結'}</button>
      </div>`}
    </section>
    ${inviteOnly && admin ? inviteCard(ev) : ''}

    ${myDay ? `<section class="card">
      <div class="row spread"><h3>${cyc.kind !== 'club' ? `協會 W${ev.week_no} 課表` : '你這天的課表'}</h3><span class="pill">${me.dist === 'hm' ? '半馬' : '全馬'} ${me.grp} 組</span></div>
      <div class="day ${myDay.kind}">
        <span class="dl"><span>${esc(myDay.d)}</span><span class="k">${P.KIND_LABEL[myDay.kind]}</span></span>
        <span class="t">${esc(myDay.t)} <span class="hint">${P.paceHint(myDay.t, me.dist, me.grp)}</span></span>
      </div>${cyc.kind !== 'club' ? `<p class="tiny" style="margin:0">你的課表這天：${myOwn ? (P.isRaceDay(myOwn, cw) ? `比賽日：<span translate="no">${esc(cyc.name)}</span>` : esc(fixText(myOwn.t))) : '沒有排課'}</p>` : ''}</section>` : ''}
    ${ev.plan_text ? `<section class="card"><h3>課表</h3><pre class="out">${esc(ev.plan_text)}</pre></section>` : ''}
    ${ev.spot ? `<section class="card"><div class="row spread"><h3>場地天氣</h3><a class="tiny" href="#/map?spot=${esc(ev.spot.id)}"><span translate="no">${esc(ev.spot.name)}</span> ›</a></div><div id="evWx"><p class="tiny" style="margin:0">載入中…</p></div></section>` : ''}
    ${ev.route ? `<section class="card"><div class="row spread"><h3>路線・${(ev.route.distance / 1000).toFixed(1)} 公里</h3><a class="tiny" href="#/map?route=${esc(ev.route.id)}">在地圖上看 ›</a></div>
      ${routeSvg(ev.route.points)}<div class="row" style="gap:8px"><button class="btn ghost sm" id="evGpx">下載 GPX</button></div></section>` : ''}

    ${party && myTicket ? ticketCard(myTicket, ev) : ''}
    ${myStatus === 'in' && (ev.myAmount || (ev.myAmount == null && charges(ev))) ? payCard(ev) : ''}

    <section class="card" id="myStatus" aria-labelledby="myStatusH">
      <div class="row spread">
        <h2 class="h3" id="myStatusH">${survey ? '已回覆' : '報名'} ${ev.seatsIn}${ev.capacity ? ` / ${ev.capacity}` : ''} 人</h2>
        ${live
          ? `<span class="row" style="gap:6px">${myStatus === 'in' && started ? '<span class="tiny">活動已開始</span>' : ''}<button class="btn danger sm" id="cancel" ${myStatus === 'in' && started ? 'disabled' : ''}>${myStatus === 'pending' ? '撤回申請' : survey ? '撤回回覆' : '取消報名'}</button></span>`
          : myStatus === 'rejected' ? '<span class="tiny">未通過審核</span>'
          : !canSubmit ? `<span class="tiny">${STATE_LABEL[st](ev)}</span>` : (useForm ? '' : `<button class="btn sm" id="signup">${submitLabel(ev, null, full)}</button>`)}
      </div>
      ${done ? signedCard(ev, done, shareLink(ev)) : ''}
      ${useForm && canSubmit ? signupForm(ev, myStatus, full) : ''}
      ${!useForm && !survey && canSubmit && !live ? `${noteField(ev, '', 'quickNote')}` : ''}
      ${!useForm && live && ev.myNote ? `<p class="tiny" style="margin:0">給主辦的備註：<span translate="no">${esc(ev.myNote)}</span></p>` : ''}
      ${isOffline() && (canSubmit || live) ? '<p class="tiny" style="margin:0">目前離線，連上網路後再報名</p>' : ''}
      ${(party && (ev.fee || ev.meal_options)) || ev.guest_max ? `<p class="tiny">${party && ev.fee ? `費用 ${ev.fee} 元　` : ''}${ev.guest_max ? `可攜伴 ${ev.guest_max} 位${ev.count_guests && ev.capacity ? '（攜伴也佔名額）' : ''}　` : ''}${party && ev.meal_options ? `餐點：${esc(ev.meal_options)}` : ''}</p>` : ''}
      ${myStatus === 'in' ? `<p class="tiny mystat" id="myStatusMsg" style="margin:0">${IC.check}${survey ? '你已回覆' : '你已報名'}</p>` : ''}
      ${myStatus === 'pending' ? `<p class="notice" id="myStatusMsg" style="margin:0">你的報名在等主辦幹部審核，結果會通知你${charges(ev) ? '；核准後再繳費' : ''}。</p>`
        : myStatus === 'rejected' ? `<p class="notice" id="myStatusMsg" style="margin:0">主辦未通過這筆報名${ev.myReviewNote ? `：<span translate="no">${esc(ev.myReviewNote)}</span>` : ''}。有疑問請聯絡主辦人。</p>`
        : myStatus === 'wait' ? `<p class="notice" id="myStatusMsg" style="margin:0">你在候補第 ${ev.myPosition || 1} 位，有人取消會自動遞補並通知你。</p>`
        : st === 'soon' && !myStatus ? '<p class="notice" id="openCountdown" style="margin:0"></p>' : ''}
      ${!myStatus && canSubmit && ev.require_approval && !admin && (ev.capacity || (ev.items || []).some((i) => i.stock)) ? '<p class="tiny" id="evHold" style="margin:0">審核期間不保留名額與庫存</p>' : ''}
      ${live && ev.myAttended ? `<div class="row" style="gap:6px"><span class="pill solid">${IC.check}已出席</span></div>` : ''}
      <div class="roster">
        ${ins.map((s) => `<div class="r">${avatar(s)}<span><span translate="no">${esc(s.name)}</span>${plusN(s)}</span><span class="pill">${esc(s.grp)}</span></div>`).join('')
          || '<p class="muted" style="margin:0">還沒有人報名，當第一個吧。</p>'}
        ${waits.map((s) => `<div class="r">${avatar(s)}<span><span translate="no">${esc(s.name)}</span>${plusN(s)}</span><span class="pill wait">候補</span></div>`).join('')}
      </div>
      ${admin ? '<button class="btn ghost sm" id="copyRoster">複製名單</button>' : ''}
    </section>

    ${party ? Party.seatSection(seatData, seatInfo.layout) : ''}
    ${party && ev.checkin ? await partyAdmin(ev) : ''}

    ${admin ? `<section class="card">
      <div class="row spread"><h3>管理</h3><span class="tiny">${ev.team ? `<span translate="no">${esc(ev.team.name)}</span>的活動` : '全協會的活動'}</span></div>
      <div class="row">
        ${ev.pendingCount > 0 ? `<a class="btn sm" href="#/e/${ev.id}/stats?f=pending">待審核 ${ev.pendingCount} ›</a>` : ''}
        <a class="btn sm" href="#/e/${ev.id}/stats">報名統計${qs.length ? '與問卷' : ''}</a>
        ${ev.cancelled ? `<a class="btn sm" href="#/edit/${ev.id}?reopen=1">恢復這場活動</a>` : ''}
        <a class="btn ghost sm" href="#/edit/${ev.id}">編輯</a>
        <a class="btn ghost sm" href="#/new?from=${ev.id}">複製成新活動</a>
        ${ev.group_reg ? `<button class="btn ghost sm" data-regcsv="${ev.id}">下載團體報名資料</button>` : ''}
        ${ev.arrived ? '<button class="btn ghost sm" id="pickScanEv" type="button">掃描領取</button>' : ''}
        <button class="btn danger sm" id="del">刪除</button>
      </div>
      ${ev.cancelled ? '' : `<details id="noticeWrap"><summary class="tiny" style="cursor:pointer">發布通知或異動（改時間、改地點、取消）</summary>
        <form id="noticeForm" class="noticeform">
          <div class="chips">${[['time', '改時間'], ['place', '改地點'], ['other', '提醒或通知'], ['cancel', '取消活動']].map(([k, v], i) => `<label class="chip"><input type="radio" name="type" value="${k}" ${i ? '' : 'checked'}><span>${v}</span></label>`).join('')}</div>
          <div class="grid2" data-nt="time"><label>新的日期<input type="date" name="date" value="${esc(ev.date)}"></label><label>${party ? '新的開始時間' : '新的集合時間'}<input type="time" name="gather_time" value="${esc(ev.gather_time || '')}"></label></div>
          <div data-nt="place" hidden style="display:grid;gap:12px"><label>新的地點<input name="place" maxlength="120" placeholder="例如 改到大佳河濱公園"></label>${addrField('address', '地址', '選填・送郵局核對')}</div>
          <label>說明（會一起推播）<textarea name="message" maxlength="300" placeholder="例如 下雨改室內，帶瑜珈墊"></textarea></label>
          <fieldset class="qset"><legend>通知誰</legend><div class="chips">
            <label class="chip"><input type="radio" name="audience" value="signed" ${ev.signups.length + (ev.pendingCount || 0) ? 'checked' : ''}><span>已報名的人（${ev.signups.length + (ev.pendingCount || 0)}）</span></label>
            <label class="chip"><input type="radio" name="audience" value="all" ${ev.signups.length + (ev.pendingCount || 0) ? '' : 'checked'}><span>${inviteOnly ? '所有受邀的人' : ev.team ? '整個分團' : '全協會'}</span></label></div>
            <span class="tiny">用外部表單登記的活動（例如慶功宴）沒有人在 App 報名，要選第二個。</span></fieldset>
          <button class="btn sm">送出並通知</button>
        </form></details>`}
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
  const shareUrl = () => shareLink(ev);
  const attendLink = ev.attendToken ? `${location.origin}/#/e/${ev.id}/attend?t=${ev.attendToken}` : '';
  if (attendLink && $('#attendQR')) qrSVG(attendLink, { size: 220, dark: '#0B1B33', light: '#fff' }).then((svg) => { $('#attendQR').innerHTML = svg; }).catch(() => {});
  const setAttend = async (on) => { try { await api(`/events/${ev.id}/attend-token`, { method: 'POST', body: { on } }); eventView(ev.id); } catch (e) { toast(e.message); } };
  $('#attendOn')?.addEventListener('click', () => setAttend(true));
  $('#attendRotate')?.addEventListener('click', () => setAttend(true));
  $('#attendOff')?.addEventListener('click', () => setAttend(false));
  $('#bulkForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await apiAll(`/events/${ev.id}/bulk`, { method: 'POST', body: { names: f.names.value, action: f.action.value } }, ['added']);
      // 名字標 translate="no"：英文模式只翻固定的字，不會因為名字是中文就整句保留中文
      const nm = (list) => list.map((x) => `<bdi translate="no">${esc(x)}</bdi>`).join('、');
      $('#bulkOut').innerHTML = `完成 ${r.added} 人。${r.more ? `<br>還有 ${r.more.names.length} 人沒處理完，請再按一次` : ''}${r.unmatched.length ? `<br>找不到：${nm(r.unmatched)}` : ''}${r.ambiguous.length ? `<br>同名需要手動處理：${nm(r.ambiguous)}` : ''}${r.failed.length ? `<br>沒報成：${nm(r.failed)}` : ''}${r.already?.length ? `<br>已經在名單上，沒有改動：${nm(r.already)}` : ''}`;
      if (r.added) { toast(`已處理 ${r.added} 人`); setTimeout(() => eventView(id), 1200); }
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
      price ? `費用：${price}` : '', ev.cancelled ? '' : windowLine(ev), shareable(ev) ? `${ev.kind === 'survey' ? '填寫' : '報名'}：${forLine(shareUrl())}` : ''].filter(Boolean).join('\n');
    open(`https://line.me/R/share?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });
  if (inviteOnly && admin) bindInviteCard(ev);

  // 離線：報名、取消都不排進離線佇列，按鈕直接停用
  if (isOffline()) for (const b of [$('#signup'), $('#cancel'), $('#pform button:not([type=button])')]) if (b) b.disabled = true;
  // 報名按鈕的補充說明：報名期間、需要審核、審核期間不保留名額（VoiceOver 停在按鈕上就唸得到）
  const desc = ['evWindow', 'evHold'].filter((x) => document.getElementById(x)).join(' ');
  for (const b of [$('#signup'), $('#pform > button.btn:last-of-type')]) if (b && desc) b.setAttribute('aria-describedby', desc);
  // 報名、撤回之後整頁重畫，按下的按鈕不見了：焦點移到「我的報名狀態」（已報名／候補第幾位／審核中），不會掉回頁首
  const settled = (msg) => { toast(msg); focusAfterRender(['#myStatusMsg', '#myStatus']); render(); };
  // 報名成功：一樣 toast＋焦點到報名狀態；重畫後多一張提示卡（主辦的成功訊息、分享到 LINE 群組）
  const signedUp = (r) => { justSigned = { id, status: r.status }; settled(signupToast(r, ev)); };
  const sb = $('#signup');
  sb?.addEventListener('click', once(sb, async () => {
    try {
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: { grp: me.grp, dist: me.dist, note: $('#quickNote')?.value.trim() || '' } });
      signedUp(r);
    } catch (e) { toast(e.message); }
  }));
  $('#cancel')?.addEventListener('click', async () => {
    const paidMsg = ev.myPaid === 'paid' ? '你已經繳費，取消後的退費由主辦幹部處理。' : ev.myPayReported ? '你已經回報繳費，取消後請跟主辦幹部聯絡退費。' : '';
    const lateMsg = myStatus === 'in' && now > signupEnd(ev) ? '截止後取消請先聯絡主辦，費用依主辦規定。' : '';
    // 危險操作用選擇面板（不用 confirm）：選項寫清楚是「取消報名」還是「保留報名」
    const [title, yes, keepIt] = myStatus === 'pending' ? ['撤回這筆申請？', '撤回申請', '保留申請'] : survey ? ['撤回回覆？', '撤回回覆', '保留回覆'] : ['取消報名？', '取消報名', '保留報名'];
    if (await choose(title, esc(`${lateMsg}${paidMsg}`), [{ value: 'yes', label: yes, danger: true }], { cancel: keepIt }) !== 'yes') return;
    try { await api(`/events/${id}/signup`, { method: 'DELETE' }); settled(myStatus === 'pending' ? '已撤回申請' : survey ? '已撤回回覆' : '已取消報名'); } catch (e) { toast(e.message); }
  });
  // 尚未開放：倒數；剩不到 6 小時改成時間到再向伺服器重新讀取（按鈕由伺服器的狀態決定，前端不自己打開）
  const cd = $('#openCountdown');   // #countdown 是上方的賽事倒數，不能重複
  if (cd && ev.signup_start) {
    const left = () => Math.max(0, Date.parse(`${ev.signup_start}:00Z`) - Date.parse(`${nowTp()}:00Z`));
    const paint = () => { const m = Math.ceil(left() / 60e3), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
      cd.textContent = d || h ? `${d ? `${d} 天 ` : ''}${h} 小時後開放報名` : `${m % 60} 分鐘後開放報名`; };
    // 頁面開著跨過 6 小時門檻也要排上重新讀取（每分鐘檢查一次，只排一次）
    let armed = false;
    const arm = () => { if (armed || left() >= 6 * 3600e3) return; armed = true; setTimeout(() => { if (cd.isConnected) { announce('已開放報名'); render(); } }, left() + 1500); };
    paint(); arm();
    const t = setInterval(() => { if (!cd.isConnected) return clearInterval(t); paint(); arm(); }, 60e3);
  }
  if (ev.spot) import('./weather.js').then((W) => W.load(ev.spot.lat, ev.spot.lng).then((w) => { if ($('#evWx')) $('#evWx').innerHTML = W.forEvent(w, ev.date, ev.gather_time); }))
    .catch((e) => { if ($('#evWx')) $('#evWx').innerHTML = `<p class="tiny" style="margin:0">${esc(e.message)}</p>`; });
  $('#evGpx')?.addEventListener('click', async () => (await import('./map.js')).downloadGpx(ev.route.name, ev.route.points));
  if ($('#pform')) bindQuote($('#pform'), ev);
  bindPayCard(ev);
  $('#pickScanEv')?.addEventListener('click', () => scanSheet({ title: '掃描領取 QR', hint: '把團員的領取 QR 對準框內', placeholder: '或輸入 6 碼領取代碼',
    onCode: async (code) => { const r = await api(`/events/${id}/pickup`, { method: 'POST', body: { code: code.toUpperCase() } }); return `${r.already ? '已經領過：' : '領取完成：'}${r.name}・${(r.items || []).map((x) => `${(ev.items.find((d) => d.id === x.id) || {}).name || ''}${x.size ? ` ${x.size}` : ''}×${x.qty}`).join('、')}`; } }));
  for (const b of document.querySelectorAll('[data-regcsv]')) b.onclick = () => downloadAuthed(`/api/events/${b.dataset.regcsv}/registrations.csv`, `${ev.title}-團體報名資料.csv`).catch((e) => toast(e.message));
  const nf = $('#noticeForm');
  if (nf) {
    const sync = () => { const t = nf.querySelector('[name=type]:checked').value; for (const el of nf.querySelectorAll('[data-nt]')) el.hidden = el.dataset.nt !== t; };
    nf.addEventListener('change', sync); sync();
    bindAddrField(nf, 'address');
    nf.onsubmit = async (e) => {
      e.preventDefault();
      const t = nf.querySelector('[name=type]:checked').value;
      if (t === 'cancel' && !confirm('確定取消這場活動？選的通知對象都會收到通知。')) return;
      try {
        const r = await api(`/events/${ev.id}/notice`, { method: 'POST', body: { type: t, date: nf.date.value, gather_time: nf.gather_time.value, place: nf.place.value.trim(), address: nf.address.value.trim(), message: nf.message.value.trim(), audience: nf.querySelector('[name=audience]:checked')?.value } });
        toast(r.count ? `已通知 ${r.count} 人` : '已更新，沒有需要通知的人'); render();
      }
      catch (err) { toast(err.message); }
    };
  }
  // 要先填賽事報名資料：記住填到一半的報名（組別、商品、備註），填完會帶回來（按連結或按報名都一樣）
  const goReg = () => {
    const f = $('#pform');
    try { sessionStorage.setItem('cil-after-reg', JSON.stringify({ ev: id, option: f?.querySelector('[name=option]:checked')?.value || null, items: f ? readItems(f) : [], note: f?.note?.value || '' })); } catch {}
    location.hash = '#/me/reg'; toast('先填好團體報名資料，填完會帶你回來報名');
  };
  $('#goReg')?.addEventListener('click', (e) => { e.preventDefault(); goReg(); });
  $('#pform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const answers = readQuestionFields(f, qs);
      const miss = qs.find((q) => q.required && (Array.isArray(answers[q.id]) ? !answers[q.id].length : !answers[q.id]));
      // 必答題沒填：錯誤寫在那一題旁邊（aria-describedby）、標 aria-invalid、焦點移過去
      if (miss) return fieldError(miss.type === 'text' ? f.querySelector(`[data-q="${CSS.escape(miss.id)}"]`) : f.querySelector(`input[name="q_${CSS.escape(miss.id)}"]`), `請回答「${miss.label}」`, { also: miss.type === 'text' ? [] : [...f.querySelectorAll(`input[name="q_${CSS.escape(miss.id)}"]`)].slice(1) });
      if (ev.group_reg && ev.regProfile !== 'ok') { goReg(); return; }
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: {
        grp: me.grp, dist: me.dist, note: f.note?.value.trim() || '', answers,
        option: f.querySelector('[name=option]:checked')?.value || null, reg_consent: !!f.reg_consent?.checked,
        guests: Number(f.guests?.value || 0), guest_names: readGuestNames(f), meal: f.meal?.value || '', items: readItems(f) } });
      signedUp(r);
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
    const later = (ev.series || []).filter((x) => x.date > ev.date).length;
    const n = ev.signups.length + (ev.pendingCount || 0);
    const pick = await choose('刪除活動', `${later ? `這是定期揪跑，之後還有 ${later} 場。` : ''}刪除後無法復原${n ? `，已報名的 ${n} 人會收到通知` : ''}。`,
      later ? [{ value: 'one', label: '只刪這一場', danger: true }, { value: 'after', label: `連同之後 ${later} 場一起刪`, danger: true }] : [{ value: 'one', label: '刪除', danger: true }]);
    if (!pick) return;
    try { const r = await api(`/events/${id}${pick === 'after' ? '?series=after' : ''}`, { method: 'DELETE' }); toast(`已刪除 ${r.count || 1} 場`); location.hash = '#/'; } catch (e) { toast(e.message); }
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
  if (!ev.cancelled) L.push(windowLine(ev));
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
  if (shareable(ev) && ev.visibility !== 'invite') L.push('', `報名：${forLine(eventUrl(ev.id))}`);
  if (shareable(ev) && ev.visibility === 'invite' && ev.invite?.token) L.push('', `報名（邀請連結）：${forLine(`${eventUrl(ev.id)}?t=${ev.invite.token}`)}`);
  return L.join('\n');
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
    <form id="invSearch" class="row" style="gap:8px" role="search" data-live><input name="q" placeholder="搜尋姓名或暱稱邀請" aria-label="搜尋要邀請的人" style="flex:1" autocomplete="off"><button class="btn ghost sm">搜尋</button></form>
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
  const invOnly = latest();
  $('#invSearch').onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return toast('請輸入姓名');
    // 協會幹部從全體名冊找；分團幹部從自己分團找
    const r = await invOnly(allow('roster') ? api(`/members?q=${encodeURIComponent(q)}`)
      : ev.team_id ? api(`/teams/${ev.team_id}/members?q=${encodeURIComponent(q)}`) : Promise.resolve({ members: [] }));
    $('#invHits').innerHTML = r.members.map((m) => `<div class="r">${avatar(m)}<span><span translate="no">${esc(m.name)}</span>${m.nickname ? ` <span class="tiny"><span translate="no">${esc(m.nickname)}</span></span>` : ''}</span>
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
      <span><span translate="no">${esc(m.name)}</span><span class="tiny" style="display:block">${VIA_NAME[m.via] || ''}${m.status === 'in' ? '・已報名' : m.status === 'wait' ? '・候補' : ''}</span></span>
      <button class="btn danger sm" data-uninv="${m.id}" data-name="${esc(m.name)}">移出</button></div>`).join('') || '<p class="muted" style="margin:0">還沒有邀請任何人</p>';
    for (const b of document.querySelectorAll('[data-uninv]')) b.onclick = async () => {
      if (!confirm(`把 ${b.dataset.name} 移出受邀名單？他的報名與入場券也會取消。`)) return;
      try { await api(`/events/${ev.id}/invites/${b.dataset.uninv}`, { method: 'DELETE' }); toast('已移出'); reload(); } catch (err) { toast(err.message); }
    };
  };
}

// 報名表：春酒的攜伴與餐點、活動自訂問卷；基本資料一律帶入「我的」設定
function signupForm(ev, myStatus, full) {
  // 從「先填賽事報名資料」回來：把剛才選的組別、商品、備註帶回來
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem('cil-after-reg') || 'null'); if (draft?.ev === ev.id) sessionStorage.removeItem('cil-after-reg'); else draft = null; } catch {}
  if (draft) { ev = { ...ev, myOption: draft.option || ev.myOption, myItems: draft.items?.length ? draft.items : ev.myItems, draftNote: draft.note }; }
  const party = ev.kind === 'party', survey = ev.kind === 'survey';
  const meals = party ? (ev.meal_options || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  return `<form id="pform" class="signup">
    ${!survey ? `<p class="tiny" style="margin:0">以 <span translate="no">${esc(me.name)}</span>${me.nickname ? `（<span translate="no">${esc(me.nickname)}</span>）` : ''}・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組報名，<a href="#/me/profile">修改個人資料</a></p>` : ''}
    ${ev.guest_max && !survey ? guestFields(ev) : ''}
    ${meals.length ? `<label>餐點<select name="meal">${meals.map((m) => `<option ${m === me.meal_pref ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : ''}
    ${(ev.options || []).length ? `<fieldset class="qset"><legend>報名組別 <span class="req">必填</span></legend><div class="chips">${ev.options.map((o) => `<label class="chip"><input type="radio" name="option" value="${esc(o.name)}" ${ev.myOption === o.name ? 'checked' : ''} required><span><span translate="no">${esc(o.name)}</span>${o.price ? `<small class="num">　${money(o.price)}</small>` : ''}</span></label>`).join('')}</div></fieldset>` : ''}
    ${ev.group_reg ? (ev.regProfile === 'ok'
      ? `<label class="inline consent"><input type="checkbox" name="reg_consent" ${ev.myRegConsent ? 'checked' : ''} required> 同意把我的賽事報名資料（含身分證字號）提供給主辦幹部，只用於這場的團體報名</label>`
      : `<p class="notice" style="margin:0">這場由幹部代為團體報名，需要你的報名資料（姓名、身分證字號、生日、緊急聯絡人等）。填一次之後每場都能用。<a href="#/me/reg" id="goReg">去填寫 ›</a></p>`) : ''}
    ${(ev.items || []).length ? `<fieldset class="qset items"><legend>${ev.kind === 'buy' ? '要訂的商品' : '加購（選填）'}</legend>${ev.items.map((it) => itemPicker(it, ev)).join('')}</fieldset>` : ''}
    ${charges(ev) ? '<div class="quote" id="quote" aria-live="polite"></div>' : ''}
    ${questionFields(ev.questions || [], ev.myAnswers || {})}
    ${draft ? '<p class="notice" style="margin:0">已帶回你剛才選的內容，確認後送出報名。</p>' : ''}
    ${survey ? '' : noteField(ev, ev.draftNote ?? ev.myNote)}
    <button class="btn block">${submitLabel(ev, myStatus, full)}</button>
  </form>`;
}
// 團購／加購：每個尺寸一列，數量用 − ＋ 調整；顯示剩餘庫存
function itemPicker(it, ev) {
  const mineQ = (size) => (ev.myItems || []).find((x) => x.id === it.id && (x.size || '') === size)?.qty || 0;
  const left = it.stock ? Math.max(0, it.stock - (ev.sold?.[it.id] || 0) + (ev.myItems || []).filter((x) => x.id === it.id).reduce((n, x) => n + x.qty, 0)) : null;
  const rows = (it.sizes.length ? it.sizes : ['']).map((z) => `<div class="stepper" data-item="${esc(it.id)}" data-size="${esc(z)}">
      <span>${z ? esc(z) : '數量'}</span><button type="button" data-step="-1" aria-label="${esc(it.name)} ${esc(z)} 減一">−</button>
      <output class="num">${mineQ(z)}</output><button type="button" data-step="1" aria-label="${esc(it.name)} ${esc(z)} 加一">＋</button></div>`).join('');
  return `<div class="itempick" data-max="${it.max}" data-left="${left ?? ''}"><div class="row spread"><b><span translate="no">${esc(it.name)}</span></b><span class="tiny"><span class="num">${money(it.price)}</span>${left != null ? `・剩 ${left}` : ''}${it.max < 10 ? `・每人最多 ${it.max}` : ''}</span></div>
    <div class="steppers">${rows}</div></div>`;
}
// 攜伴姓名：只送選了的人數那幾格
const readGuestNames = (f) => [...f.querySelectorAll('[name=guest_name]')].slice(0, Number(f.guests?.value || 0)).map((x) => x.value.trim());
const readItems = (f) => [...f.querySelectorAll('.stepper')].map((s) => ({ id: s.dataset.item, size: s.dataset.size, qty: Number(s.querySelector('output').value || s.querySelector('output').textContent) || 0 })).filter((x) => x.qty > 0);
// 報名表即時算金額（預覽；實際以伺服器算的為準）
function bindQuote(f, ev) {
  const box = f.querySelector('#quote');
  const paint = () => {
    if (!box) return;
    const signedOn = ev.mySignedOn || nowTp().slice(0, 10);   // 早鳥看這次報名的日期（台北時間）
    const q = quote(ev, { option: f.querySelector('[name=option]:checked')?.value || null, guests: Number(f.guests?.value || 0), items: readItems(f), membership: ev.myMembership, signedOn });
    box.innerHTML = q.lines.length ? `${q.lines.map((l) => `<div class="ql ${l.amount < 0 ? 'off' : ''}"><span>${lineLabel(l)}${l.qty > 1 ? ` × ${l.qty}` : ''}</span><span class="num">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</span></div>`).join('')}
      <div class="ql total"><span>合計</span><b class="num">${money(q.total)}</b></div>` : '';
  };
  for (const st of f.querySelectorAll('.stepper')) for (const b of st.querySelectorAll('[data-step]')) b.onclick = () => {
    const out = st.querySelector('output'), pick = st.closest('.itempick'), max = Number(pick.dataset.max) || 10, left = pick.dataset.left === '' ? Infinity : Number(pick.dataset.left);
    const inItem = [...pick.querySelectorAll('output')].reduce((n, o) => n + Number(o.textContent), 0);
    const next = Number(out.textContent) + Number(b.dataset.step);
    if (next < 0) return;
    if (Number(b.dataset.step) > 0 && inItem >= Math.min(max, left)) return toast(left < max ? `只剩 ${left} 件` : `每人最多 ${max} 件`);
    out.textContent = String(next); navigator.vibrate?.(8); paint();
  };
  f.addEventListener('change', paint);
  // 攜伴人數改了：顯示對應的姓名欄
  f.guests?.addEventListener('change', () => { for (const el of f.querySelectorAll('[data-g]')) el.hidden = Number(el.dataset.g) >= Number(f.guests.value); });
  paint();
}
// 我的繳費：金額明細、收款帳戶、回報轉帳後五碼；幹部確認後顯示已繳
function payCard(ev) {
  const pi = ev.payInfo || {}, amount = ev.myAmount ?? 0, paid = ev.myPaid === 'paid' || ev.myPaid === 'waived';
  const methods = (pi.methods && pi.methods.length ? pi.methods : ['transfer']);
  const M = { transfer: '銀行轉帳', cash: '現金', linepay: 'LINE Pay' };
  return `<section class="card paycard ${paid ? 'paid' : ev.myPayReported ? 'reported' : ''}" id="payCard">
    <div class="row spread"><h3>${paid ? '已完成繳費' : ev.myPayReported ? '已回報，等幹部確認' : '繳費'}</h3><b class="num amount">${money(amount)}</b></div>
    ${(ev.myLines || []).length ? `<div class="quote">${ev.myLines.map((l) => `<div class="ql ${l.amount < 0 ? 'off' : ''}"><span>${lineLabel(l)}${l.qty > 1 ? ` × ${l.qty}` : ''}</span><span class="num">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</span></div>`).join('')}</div>` : ''}
    ${ev.myPaidNote && !paid ? `<p class="notice" style="margin:0"><span translate="no">${esc(ev.myPaidNote)}</span></p>` : ''}
    ${ev.myPickCode && !ev.myPicked ? `<div class="pickbox"><div class="qrbox" id="pickQR" data-code="${esc(ev.myPickCode)}"></div><div><b>領取 QR</b><span class="tiny" style="display:block">${ev.pickupNote ? `<span translate="no">${esc(ev.pickupNote)}</span>・` : ''}領取時出示給幹部掃描</span><span class="code num">${esc(ev.myPickCode)}</span></div></div>` : ''}
    ${paid ? `<p class="tiny" style="margin:0">${ev.myPaid === 'waived' ? '這筆免繳。' : '幹部已經確認收到款項，謝謝。'}${ev.myPicked ? '商品已領取。' : (ev.items || []).length && !ev.arrived ? '商品到貨後幹部會通知領取。' : ''}</p>`
      : ev.myPayReported ? `<p class="tiny" style="margin:0">${M[ev.myPayMethod] || ''}${ev.myPayRef ? `・後五碼 ${esc(ev.myPayRef)}` : ''}・${ago(ev.myPayReported)}回報</p><button class="btn ghost sm" id="payUndo">回報錯了，重新填</button>`
      : `${pi.account ? `<div class="acct"><span class="tiny">收款帳戶</span><pre>${esc(pi.account)}</pre><button type="button" class="btn ghost sm" id="copyAcct">複製</button></div>` : ''}
        ${pi.due ? `<p class="tiny" style="margin:0">請在 ${esc(pi.due)} 前完成繳費${pi.note ? `・<span translate="no">${esc(pi.note)}</span>` : ''}</p>` : pi.note ? `<p class="tiny" style="margin:0"><span translate="no">${esc(pi.note)}</span></p>` : ''}
        <form id="payForm" class="row" style="gap:8px;align-items:end">
          ${methods.length > 1 ? `<label style="flex:1;min-width:110px">方式<select name="method">${methods.map((m) => `<option value="${m}">${M[m]}</option>`).join('')}</select></label>` : `<input type="hidden" name="method" value="${methods[0]}">`}
          <label style="flex:1;min-width:120px" data-ref>轉帳後五碼<input name="ref" inputmode="numeric" maxlength="6" pattern="\\d{4,6}" autocomplete="off" placeholder="12345"></label>
          <button class="btn sm">我已繳費</button></form>`}
  </section>`;
}
function bindPayCard(ev) {
  $('#copyAcct')?.addEventListener('click', () => copy(ev.payInfo.account));
  const pq = $('#pickQR');
  if (pq) qrSVG(pq.dataset.code).then((svg) => { pq.innerHTML = svg; }).catch(() => {});
  const f = $('#payForm');
  if (f) {
    const sync = () => { const t = f.method.value === 'transfer'; f.querySelector('[data-ref]').hidden = !t; f.ref.required = t; };
    f.method.onchange = sync; sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/events/${ev.id}/pay-report`, { method: 'POST', body: { method: f.method.value, ref: f.ref.value.trim() } }); toast('已回報，幹部確認後會更新'); render(); }
      catch (err) { toast(err.message); }
    };
  }
  $('#payUndo')?.addEventListener('click', async () => { try { await api(`/events/${ev.id}/pay-report`, { method: 'POST', body: { cancel: true } }); render(); } catch (err) { toast(err.message); } });
}
function questionFields(qs, ans) {
  return qs.map((q) => {
    const v = ans[q.id], req = q.required ? '<span class="req">必填</span>' : '';
    if (q.type === 'text') return `<label><span translate="no">${esc(q.label)}</span> ${req}<input data-q="${esc(q.id)}" maxlength="300" value="${esc(v || '')}" ${q.required ? 'required' : ''}></label>`;
    const multi = q.type === 'multi';
    return `<fieldset class="qset"><legend><span translate="no">${esc(q.label)}</span> ${req}${multi ? '<span class="tiny">可複選</span>' : ''}</legend>
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
    <div class="row spread"><h3>${title === '我的入場券' ? title : `<span translate="no">${esc(title)}</span>`}</h3>${t.checked_in_at ? '<span class="pill solid">已報到</span>' : '<span class="pill">未報到</span>'}</div>
    <div class="qrbox" ${title === '我的入場券' ? 'id="qrBox"' : ''} data-code="${esc(t.code)}" data-ev="${esc(ev.id)}"></div>
    <div class="code num"><span translate="no">${esc(t.code)}</span></div>
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
export async function attendView(id) {
  const t = new URLSearchParams(location.hash.split('?')[1] || '').get('t');
  view.innerHTML = '<p class="loading">報到中…</p>';
  try {
    const r = await api(`/events/${id}/attend`, { method: 'POST', body: { t } });
    history.replaceState(null, '', `#/e/${id}/attend`);
    view.innerHTML = `<section class="card ok attendok"><span class="big">${IC.checkCircle}</span><h2>報到完成</h2>
      <p class="muted" style="margin:0">${r.walkIn ? '你原本沒有報名，已經幫你加入名單。' : '今天也辛苦了，練完記得記錄訓練。'}</p>
      <a class="btn block" href="#/e/${esc(id)}">回活動頁</a><a class="btn ghost block" href="#/log?event=${esc(id)}">記錄今天的訓練</a></section>`;
  } catch (e) {
    view.innerHTML = `<section class="card"><h2>報到沒有成功</h2><p class="muted">${esc(e.message)}</p><a class="btn ghost block" href="#/e/${esc(id)}">回活動頁</a></section>`;
  }
}

// 我的入場券：所有即將到來的入場券集中在一頁（主畫面捷徑直達，離線也能出示）
export async function ticketsView() {
  const [{ tickets }, { pickups = [] }, { prizes = [] }] = await Promise.all([api('/my/tickets'), api('/my/pickups').catch(() => ({})), api('/my/prizes').catch(() => ({}))]);
  view.innerHTML = `${largeTitle('入場券與領取', tickets.length || pickups.length ? '把 QR Code 給工作人員掃描' : '')}
    ${pickups.map((p) => `<section class="card"><div class="row spread"><h3><span translate="no">${esc(p.title)}</span></h3><span class="pill solid">待領取</span></div>
      <div class="pickbox"><div class="qrbox" data-pick="${esc(p.code)}"></div><div><b>領取 QR</b><span class="tiny" style="display:block">${p.note ? `<span translate="no">${esc(p.note)}</span>` : '領取時出示給幹部掃描'}</span><span class="code num">${esc(p.code)}</span></div></div>
      <a class="tiny" href="#/e/${esc(p.event_id)}">活動頁 ›</a></section>`).join('')}
    ${tickets.map((t) => `${ticketCard(t, { id: t.event_id }, t.title)}<p class="tiny center" style="margin:-6px 0 8px">${dstr(t.date)}${t.gather_time ? ` ${t.gather_time}` : ''}${t.place ? `・<span translate="no">${esc(t.place)}</span>` : ''}　<a href="#/e/${esc(t.event_id)}">活動頁 ›</a></p>`).join('')}
    ${!tickets.length && !pickups.length ? `<div class="card">${emptyState('calendar', '目前沒有入場券或待領取的團購。')}<a class="btn ghost sm" href="#/" style="justify-self:center">看接下來的活動</a></div>` : ''}
    ${prizes.length ? `<section class="card"><h3>中獎紀錄</h3><div class="roster">${prizes.map((x) => `<a class="r" href="#/e/${esc(x.event_id)}"><span class="av">${IC.gift}</span><span><b><span translate="no">${esc(x.prize)}</span></b><span class="tiny" style="display:block"><span translate="no">${esc(x.title)}</span>${x.sponsor ? `・<span translate="no">${esc(x.sponsor)}</span> 贊助` : ''}${x.claimed_at ? '・已領取' : ''}</span></span><span class="tiny">›</span></a>`).join('')}</div></section>` : ''}`;
  for (const box of document.querySelectorAll('.qrbox[data-pick]')) qrSVG(box.dataset.pick).then((svg) => { box.innerHTML = svg; }).catch(() => {});
  for (const box of document.querySelectorAll('.qrbox[data-code]')) {
    try { box.innerHTML = await qrSVG(`${location.origin}/#/e/${box.dataset.ev}/in/${box.dataset.code}`, { size: 200, dark: '#0B1B33', light: '#fff' }); }
    catch { box.innerHTML = '<p class="tiny">QR 產生失敗，請用下方代碼報到</p>'; }
  }
}

// 掃碼／連結報到：/#/e/<id>/in/<code>
export async function checkinView(eventId, code) {
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
      <p style="font-size:30px;font-weight:700;margin:4px 0"><span translate="no">${esc(r.name)}</span></p>
      <p class="muted" style="margin:0">${r.table_no ? `第 ${r.table_no} 桌・` : ''}${r.guests ? `攜伴 ${r.guests} 位・` : ''}${r.meal ? esc(r.meal) : ''}</p>
      <a class="btn block" href="#/e/${esc(eventId)}/scan">繼續掃下一位</a>
      <a class="btn ghost block" href="#/e/${esc(eventId)}">回活動頁</a></section>`;
  } catch (e) {
    view.innerHTML = `<section class="card"><h2>報到失敗</h2><p class="muted">${esc(e.message)}</p>
      <a class="btn block" href="#/e/${esc(eventId)}/scan">再掃一次</a></section>`;
  }
}

export async function scanView(eventId) {
  if (!allow('checkin') && !(await api(`/events/${eventId}`).catch(() => ({}))).checkin) { view.innerHTML = '<div class="card"><p class="muted">只有幹部可以掃碼報到。</p></div>'; return; }
  view.innerHTML = `<section class="card">
    <div class="row spread"><h2>掃碼報到</h2><a class="tiny" href="#/e/${esc(eventId)}">完成</a></div>
    ${canScan() ? '<video id="cam" playsinline muted class="cam" aria-label="相機畫面"></video><p class="tiny center" id="scanMsg" aria-live="polite">正在打開相機…</p>'
      : '<p class="notice">這台裝置沒有可以用的相機。請在報到台手動輸入代碼，或用手機內建相機 App 掃 QR 開啟報到頁。</p>'}
    <form id="manual" class="row" style="gap:8px">
      <input name="code" placeholder="手動輸入代碼" style="flex:1;text-transform:uppercase" autocomplete="off">
      <button class="btn sm">報到</button>
    </form>
  </section>`;
  $('#manual').onsubmit = (e) => { e.preventDefault(); location.hash = `#/e/${eventId}/in/${e.target.code.value.trim().toUpperCase()}`; };
  if (!canScan()) return;
  try {
    let busy = false;
    const stopper = await scan($('#cam'), async (value) => {
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
    // 等相機的時候已經離開這頁：直接關掉相機
    if (!$('#cam')) { stopper(); return; }
    setStopScan(stopper);
    $('#scanMsg').textContent = '把入場券的 QR 對準框內';
  } catch (e) { if ($('#scanMsg')) { $('#scanMsg').textContent = e.message; $('#cam')?.remove(); } }
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
          <span><span translate="no">${esc(t.name)}</span>${t.nickname ? ` <span class="tiny"><span translate="no">${esc(t.nickname)}</span></span>` : ''}<span class="tiny" style="display:block"><span translate="no">${esc(t.code)}</span>${t.table_no ? `・第 ${t.table_no} 桌` : ''}${t.guests ? `・攜伴 ${t.guests}` : ''}${t.meal ? `・${esc(t.meal)}` : ''}</span></span>
          ${t.checked_in_at ? '<span class="pill solid">到</span>' : `<button class="btn ghost sm" data-ci="${esc(t.code)}">報到</button>`}
        </div>`).join('') || '<p class="muted">還沒有人報名。</p>'}</div>
    </section>

    <section class="card">
      <h3>抽獎</h3>
      ${prizes.map((p) => {
        const w = draws.filter((d) => d.prize_id === p.id);
        return `<div class="prize">
          <div class="row spread"><b>${p.stage ? `<span class="pill">${esc(p.stage)}</span> ` : ''}<span translate="no">${esc(p.name)}</span></b><span class="tiny">${w.length}/${p.qty}${p.sponsor ? `・${esc(p.sponsor)}` : ''}</span></div>
          ${w.length ? `<div class="winners">${w.map((d) => `<button class="pill ${d.claimed_at ? 'solid' : 'wait'}" data-claim="${d.id}" title="${d.claimed_at ? '已領獎' : '點一下確認領獎'}"><span translate="no">${esc(d.name)}</span>${d.claimed_at ? IC.check : ''}</button>`).join('')}</div>` : ''}
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
      $('#lLog').insertAdjacentHTML('afterbegin', `<div class="lrow"><span><span translate="no">${esc(w.name)}</span></span><span class="tiny">${esc(r.prize)}</span></div>`);
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


// 費用明細的項目名稱：系統產生的照翻，組別與商品名稱是幹部自填的內容，標 translate="no"
const SYS_LINE = new Set(['報名費', '早鳥優惠', '協會會員優惠']);
const lineLabel = (l) => (SYS_LINE.has(l.label) ? l.label : `<span translate="no">${esc(l.label)}</span>`);
