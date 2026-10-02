// 耕跑團 PWA — 畫面：團練列表、活動詳情與報名、我的課表、課表教練、幹部的新增活動與公告產生器
import * as P from './plan.js';
import * as Party from './party.js';
import { qrSVG, canScan, scan } from './qr.js';

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
  if (!res.ok) throw new Error(data.error || `錯誤 ${res.status}`);
  return data;
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

const KIND_NAME = { track: '田徑場團練', core: '核心日', long: '長跑團練', race: '賽事', party: '春酒餐敘', other: '活動' };
const ROLE_NAME = { chair: '理事長', director: '理事', supervisor: '監事', staff: '行政人員', coach: '教練', member: '團員' };
const allow = (p) => !!me?.can?.includes(p);
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const d2 = (d) => new Date(`${d}T00:00:00`);
const dstr = (d) => { const x = d2(d); return `${x.getMonth() + 1}/${x.getDate()}（${WD[x.getDay()]}）`; };
const avatar = (s) => s.avatar
  ? `<img class="av" src="${esc(s.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="av" aria-hidden="true">${esc((s.name || '?').slice(0, 1))}</span>`;

let me = null, cfg = {};

// ---------- 登入 ----------
function loginView() {
  const err = new URLSearchParams(location.hash.split('?')[1] || '').get('err');
  view.innerHTML = `
    <section class="card hero">
      <h2>一起練，跑得更遠</h2>
      <p class="muted" style="margin:0">團練公告、報名接龍和每週課表，都收在這裡。用 LINE 登入就會記得你的組別，報名不用再打名字。</p>
    </section>
    ${err ? `<div class="notice">${esc(err)}</div>` : ''}
    <section class="card">
      ${cfg.lineLogin ? `<a class="btn line block" href="/api/line/start">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.5 2 2 5.6 2 10c0 3.9 3.5 7.2 8.2 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c-.1.3-.3 1.1 1 .6s7-4.1 9.5-7c1.7-1.9 2.5-3.8 2.5-5.9C24 5.6 19.5 2 12 2z"/></svg>
        用 LINE 登入</a>
      <p class="tiny center">只取得你的 LINE 名稱和大頭貼，不會讀取聊天內容，也不會替你發訊息。</p>` : ''}
      <details ${cfg.lineLogin ? '' : 'open'}>
        <summary class="muted" style="cursor:pointer">用邀請碼加入</summary>
        <form id="joinForm" style="margin-top:12px">
          <label>邀請碼<input name="code" required autocomplete="one-time-code" placeholder="LINE 群公告的代碼"></label>
          <label>姓名<input name="name" required maxlength="20" autocomplete="name" placeholder="報名時顯示的名字"></label>
          <div class="grid2">
            <label>項目<select name="dist"><option value="fm">全馬</option><option value="hm">半馬</option></select></label>
            <label>組別<select name="grp"></select></label>
          </div>
          <button class="btn block">加入</button>
        </form>
      </details>
    </section>
    <section class="card">
      <h3>台灣耕跑團協會</h3>
      <p class="muted" style="margin:0">個人入會申請使用協會的 Google 表單，網站不會存身分證字號等資料。</p>
      <a class="btn ghost block" href="https://docs.google.com/forms/d/1QVo9rHK6nUmm0vQgFSV9HYzMd5L5pDSnLuZV69-yMHY/viewform" target="_blank" rel="noopener">開啟入會表單</a>
    </section>`;
  const f = $('#joinForm');
  if (!f) return;
  const sync = () => {
    f.grp.innerHTML = Object.entries(P.groups(f.dist.value)).map(([g, v]) => `<option value="${g}">${g}　SUB ${v[0]}</option>`).join('');
    f.grp.value = f.dist.value === 'hm' ? 'C' : 'D';
  };
  f.dist.onchange = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = (await api('/join', { method: 'POST', body: { code: f.code.value, name: f.name.value, dist: f.dist.value, grp: f.grp.value } })).member;
      location.hash = '#/'; render();
    } catch (err) { toast(err.message); }
  };
}

// ---------- 團練列表 ----------
async function listView() {
  const { events } = await api('/events');
  const next = events[0];
  view.innerHTML = `
    ${await weekStrip()}
    ${next ? heroCard(next) : `<section class="card hero"><h2>還沒有排定的團練</h2><p class="muted" style="margin:0">幹部發布後，這裡就會出現，也會推播通知你。</p></section>`}
    ${events.length > 1 || allow('event') ? `<div class="row spread" style="padding:4px 4px 0">
      <h3>接下來</h3>
      ${allow('event') ? '<a class="btn ghost sm" href="#/new">＋ 新增活動</a>' : ''}
    </div>` : ''}
    <div class="evgrid">${events.slice(1).map(eventCard).join('')}</div>
    <a class="tiny center" href="#/past" style="padding:4px">看過去的團練 ›</a>`;
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
    <div class="keys">${key.map((d) => `<div><span class="d">${esc(d.d)}</span><span>${esc(d.t)} <span class="hint">${P.paceHint(d.t, me.dist, me.grp)}</span></span></div>`).join('')
      || '<div class="muted">這週沒有重點課。</div>'}</div>
  </section>`;
}

function heroCard(e) {
  const d = d2(e.date), days = Math.round((d - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return `<a class="card hero" href="#/e/${e.id}">
    <div class="row spread">
      <span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${KIND_NAME[e.kind]}</span>
      <span class="tiny">${days === 0 ? '就是今天' : days === 1 ? '明天' : `${days} 天後`}</span>
    </div>
    <span class="big num" aria-hidden="true">${days === 0 ? '今日' : days}</span>
    <h2>${esc(e.title)}</h2>
    <p class="muted" style="margin:0">${dstr(e.date)}${e.gather_time ? ` ${e.gather_time} 集合` : ''}${e.place ? `・${esc(e.place)}` : ''}</p>
    <div class="row spread">
      <span class="tiny">${e.signed} 人報名${e.waiting ? `・候補 ${e.waiting}` : ''}${e.capacity ? `　上限 ${e.capacity}` : ''}</span>
      ${e.mine === 'in' ? '<span class="pill" style="background:#fff;color:#1C4698">已報名</span>'
        : e.mine === 'wait' ? '<span class="pill wait">候補中</span>' : '<span class="pill" style="background:rgba(255,255,255,.22);color:#fff">去報名 ›</span>'}
    </div>
  </a>`;
}
function eventCard(e) {
  const pct = e.capacity ? Math.min(100, Math.round(e.signed / e.capacity * 100)) : 0;
  return `<a class="card" href="#/e/${e.id}">
    <div class="ev">
      <span class="cal"><u>${d2(e.date).getMonth() + 1}月</u><b class="num">${e.date.slice(8)}</b><span>週${WD[d2(e.date).getDay()]}</span></span>
      <span class="body">
        <span class="row" style="gap:6px"><span class="pill ${e.kind}">${KIND_NAME[e.kind]}</span>
          ${e.mine === 'in' ? '<span class="pill solid">已報名</span>' : e.mine === 'wait' ? '<span class="pill wait">候補</span>' : ''}</span>
        <span class="t">${esc(e.title)}</span>
        <span class="tiny">${e.gather_time ? `${e.gather_time}　` : ''}${esc(e.place || '')}</span>
        ${e.capacity ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}
      </span>
      <span class="count">${e.signed ? `<b class="num">${e.signed}</b>${e.capacity ? `/${e.capacity}` : ' 人'}` : '<b class="num">—</b>還沒人'}</span>
    </div>
  </a>`;
}
async function pastView() {
  const { events } = await api('/events?past=1');
  view.innerHTML = `<h2 style="padding:4px">過去的團練</h2>${events.map(eventCard).join('') || '<div class="card"><p class="muted">沒有紀錄。</p></div>'}`;
}

// ---------- 活動詳情 ----------
async function eventView(id) {
  const ev = await api(`/events/${id}`);
  const admin = allow('event');
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
        <span class="pill" style="background:rgba(255,255,255,.22);color:#fff">${KIND_NAME[ev.kind]}</span>
        <span class="tiny">${dstr(ev.date)}</span>
      </div>
      <h2>${esc(ev.title)}</h2>
      <p class="muted" style="margin:0">${ev.gather_time ? `${ev.gather_time} 集合` : ''}${ev.end_time ? `－${ev.end_time}` : ''}${ev.place ? `　${esc(ev.place)}` : ''}${ev.lead ? `　帶團：${esc(ev.lead)}` : ''}</p>
      ${ev.note ? `<p class="muted" style="margin:0;white-space:pre-wrap">${esc(ev.note)}</p>` : ''}
      ${ev.link_url ? `<a class="btn block" style="background:#fff;color:#1C4698" href="${esc(ev.link_url)}" target="_blank" rel="noopener">${esc(ev.link_label || '前往登記')} ↗</a>` : ''}
    </section>

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
        <h3>報名 ${ins.length}${ev.capacity ? ` / ${ev.capacity}` : ''} 人</h3>
        ${mine && mine.status !== 'cancel'
          ? '<button class="btn danger sm" id="cancel">取消報名</button>'
          : closed ? '<span class="tiny">未開放報名</span>' : (party ? '' : `<button class="btn sm" id="signup">我要報名</button>`)}
      </div>
      ${party && !closed ? partySignupForm(ev, mine && mine.status !== 'cancel') : ''}
      ${party && (ev.fee || ev.guest_max || ev.meal_options) ? `<p class="tiny">${ev.fee ? `費用 ${ev.fee} 元　` : ''}${ev.guest_max ? `可攜伴 ${ev.guest_max} 位　` : ''}${ev.meal_options ? `餐點：${esc(ev.meal_options)}` : ''}</p>` : ''}
      ${mine?.status === 'wait' ? '<p class="notice" style="margin:0">你在候補名單，有人取消會自動遞補並通知你。</p>' : ''}
      ${!party && !mine && !closed ? `<p class="tiny">會用你的基本資料報名：${esc(me.name)}${me.nickname ? `（${esc(me.nickname)}）` : ''}・${me.dist === 'hm' ? '半馬' : '全馬'} ${esc(me.grp)} 組。要改去「我的」。</p>` : ''}
      <div class="roster">
        ${ins.map((s) => `<div class="r">${avatar(s)}<span>${esc(s.name)}${s.note ? ` <span class="tiny">${esc(s.note)}</span>` : ''}</span><span class="pill">${esc(s.grp)}</span></div>`).join('')
          || '<p class="muted" style="margin:0">還沒有人報名，當第一個吧。</p>'}
        ${waits.map((s) => `<div class="r">${avatar(s)}<span>${esc(s.name)}</span><span class="pill wait">候補</span></div>`).join('')}
      </div>
      ${admin ? '<button class="btn ghost sm" id="copyRoster">複製名單</button>' : ''}
    </section>

    ${party ? Party.seatSection(seatData, seatInfo.layout) : ''}
    ${party && allow('checkin') ? await partyAdmin(ev) : ''}

    ${admin ? `<section class="card">
      <h3>LINE 公告文字</h3>
      <pre class="out" id="announce">產生中…</pre>
      <div class="row">
        <button class="btn sm" id="copyAnn">複製公告</button>
        <a class="btn ghost sm" href="#/edit/${ev.id}">編輯</a>
        <button class="btn danger sm" id="del">刪除</button>
      </div>
    </section>` : ''}`;

  $('#signup')?.addEventListener('click', async () => {
    try {
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: { name: me.name, grp: me.grp, dist: me.dist } });
      toast(r.status === 'wait' ? '人數已滿，已排入候補' : '報名完成，週四見！'); render();
    } catch (e) { toast(e.message); }
  });
  $('#cancel')?.addEventListener('click', async () => {
    if (!confirm('確定取消報名？')) return;
    try { await api(`/events/${id}/signup`, { method: 'DELETE' }); toast('已取消報名'); render(); } catch (e) { toast(e.message); }
  });
  $('#pform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api(`/events/${id}/signup`, { method: 'POST', body: {
        name: me.name, grp: me.grp, dist: me.dist, note: f.note?.value || '',
        guests: Number(f.guests?.value || 0), meal: f.meal?.value || '' } });
      toast(r.status === 'wait' ? '人數已滿，已排入候補' : '報名完成，入場券在上方'); render();
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
      toast(`🎉 ${r.prize}：${r.winners.join('、')}`); render();
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
  const L = [`🏃 ${/\d{1,2}\/\d{1,2}/.test(ev.title) ? '' : `${dstr(ev.date)} `}${ev.title}`];
  L.push(`時間：${dstr(ev.date)}${ev.gather_time ? ` ${ev.gather_time}${ev.end_time ? `–${ev.end_time}` : ''} 集合` : ''}`);
  if (ev.place) L.push(`地點：${ev.place}`);
  if (ev.lead) L.push(`帶團：${ev.lead}`);
  if (ev.week_no) {
    const info = await P.weekInfo(ev.week_no);
    L.push('', `【全馬組】W${ev.week_no}・${info?.phase || ''}`);
    for (const r of await P.dayByGroup(ev.week_no, 'fm', dayPattern(ev.date))) L.push(`${r.grp}：${r.text}${r.hint ? `　${r.hint}` : ''}`);
    const hm = await P.dayByGroup(ev.week_no, 'hm', dayPattern(ev.date));
    if (hm.length) { L.push('', '【半馬組】'); for (const r of hm) L.push(`${r.grp}：${r.text}${r.hint ? `　${r.hint}` : ''}`); }
    if (info?.src?.startsWith('推估')) L.push('', '（本週課表為系統依去年同期推估，實際以教練公告為準）');
  } else if (ev.plan_text) { L.push('', ev.plan_text); }
  if (ev.note) L.push('', ev.note);
  if (ev.link_url) L.push('', `${ev.link_label || '登記'}：${ev.link_url}`);
  if (ev.signup_open) L.push('', `報名：${location.origin}/#/e/${ev.id}`);
  return L.join('\n');
}
const dayPattern = (date) => { const w = d2(date).getDay(); return w === 0 || w === 6 ? '週末|週日' : `週${WD[w]}`; };


// ---------- 通知中心 ----------
async function notificationsView() {
  const { items } = await api('/notifications');
  const ICON = { event: '📣', plan: '📅', signup: '✅', lottery: '🎁', system: '⚙️' };
  view.innerHTML = `
    <div class="row spread" style="padding:4px">
      <h2>通知</h2>
      ${items.some((x) => !x.read_at) ? '<button class="btn ghost sm" id="readAll">全部標為已讀</button>' : ''}
    </div>
    ${items.length ? items.map((n) => `
      <a class="card tight notif ${n.read_at ? '' : 'unread'}" href="${esc(n.url || '#/')}">
        <div class="row" style="gap:12px;align-items:flex-start">
          <span class="nicon" aria-hidden="true">${ICON[n.kind] || '•'}</span>
          <span style="flex:1;min-width:0">
            <b>${esc(n.title)}</b>
            ${n.body ? `<span class="muted" style="display:block">${esc(n.body)}</span>` : ''}
            <span class="tiny">${ago(n.created_at)}</span>
          </span>
        </div>
      </a>`).join('') : '<div class="card"><p class="muted">還沒有通知。</p></div>'}`;
  $('#readAll')?.addEventListener('click', async () => { await api('/notifications/read', { method: 'POST' }); bell(); render(); });
  // 進到通知頁就當作看過了
  if (items.some((x) => !x.read_at)) setTimeout(async () => { await api('/notifications/read', { method: 'POST' }); bell(); }, 1200);
}
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
  } catch {}
}

// ---------- 教練發布課表 ----------
async function planNewView() {
  if (!allow('plan')) { view.innerHTML = '<div class="card"><p class="muted">只有教練可以發布課表。</p></div>'; return; }
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
      <label class="inline"><input type="checkbox" name="notify" checked> 發布後通知全團</label>
      <button class="btn block">發布</button>
    </form>
  </section>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/plans', { method: 'POST', body: {
        title: f.title.value, body: f.body.value, phase: f.phase.value,
        link_url: f.link_url.value, link_label: f.link_label.value,
      week_no: f.week_no.value ? Number(f.week_no.value) : null, notify: f.notify.checked } });
      toast('已發布'); location.hash = '#/plan';
    } catch (err) { toast(err.message); }
  };
}


// ---------- 管理介面（RBAC、會籍、座位圖）----------
const MEMBERSHIP_NAME = { none: '跑友', applied: '申請中', active: '協會會員', expired: '會籍到期' };
async function adminView(tab = 'members') {
  if (!allow('members') && !allow('roles')) { view.innerHTML = '<div class="card"><p class="muted">沒有管理權限。</p></div>'; return; }
  const data = await api('/members');
  const tabs = [['members', '會員管理'], ['roles', '身分與權限'], ['events', '活動設定'], ...(allow('audit') ? [['audit', '稽核紀錄']] : [])];
  const list = data.members;
  const counts = list.reduce((m, x) => { m[x.membership] = (m[x.membership] || 0) + 1; return m; }, {});
  view.innerHTML = `
    <div class="row spread" style="padding:4px"><h2>管理後台</h2><span class="tiny">${list.length} 位跑友</span></div>
    <div class="seg">${tabs.map(([k, v]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${v}</button>`).join('')}</div>
    ${tab === 'members' ? membersPanel(list, counts)
      : tab === 'roles' ? rolesPanel(data)
      : tab === 'audit' ? await auditPanel()
      : await eventsPanel()}`;
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => adminView(b.dataset.tab);
  if (tab === 'members') bindMembers();
  if (tab === 'events') bindEventsPanel();
}
function membersPanel(list, counts) {
  const chips = Object.entries(MEMBERSHIP_NAME).map(([k, v]) => `<span class="pill ${k === 'active' ? 'solid' : k === 'applied' ? 'wait' : ''}">${v} ${counts[k] || 0}</span>`).join('');
  const row = (m) => `<div class="r">
      ${avatar(m)}
      <span><b>${esc(m.name)}</b>${m.nickname ? ` <span class="tiny">${esc(m.nickname)}</span>` : ''}
        <span class="tiny" style="display:block">${esc(m.club || '未填跑團')}・${m.roleName}${m.member_no ? `・編號 ${esc(m.member_no)}` : ''}${m.paid_until ? `・繳費至 ${esc(m.paid_until)}` : ''}</span></span>
      <button class="btn ghost sm" data-ms="${m.id}">${MEMBERSHIP_NAME[m.membership]}</button>
    </div>`;
  const applied = list.filter((m) => m.membership === 'applied');
  return `
    <section class="card"><div class="row" style="gap:6px">${chips}</div>
      <p class="tiny">跑友只要加入就能報名團練；協會會員要另外申請與繳費，兩者分開管理。</p></section>
    ${applied.length ? `<section class="card"><h3>待審核（${applied.length}）</h3><div class="roster">${applied.map(row).join('')}</div></section>` : ''}
    <section class="card"><h3>全部跑友</h3>
      <input id="mq" placeholder="搜尋姓名、暱稱或跑團" autocomplete="off">
      <div class="roster" id="mlist">${list.map(row).join('')}</div>
    </section>`;
}
function bindMembers() {
  const bind = () => { for (const b of document.querySelectorAll('[data-ms]')) b.onclick = () => membershipDialog(b.dataset.ms); };
  bind();
  const q = $('#mq');
  if (q) q.oninput = async () => {
    const key = q.value.trim().toLowerCase();
    const { members } = await api('/members');
    const hit = members.filter((m) => [m.name, m.nickname, m.club].some((v) => (v || '').toLowerCase().includes(key)));
    $('#mlist').innerHTML = hit.map((m) => `<div class="r">${avatar(m)}
      <span><b>${esc(m.name)}</b><span class="tiny" style="display:block">${esc(m.club || '')}・${m.roleName}</span></span>
      <button class="btn ghost sm" data-ms="${m.id}">${MEMBERSHIP_NAME[m.membership]}</button></div>`).join('');
    bind();
  };
}
async function membershipDialog(id) {
  const { members, memberTypes } = await api('/members');
  const m = members.find((x) => x.id === id);
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
  'bootstrap.denied': '初始設定被拒', 'privacy.export': '下載個資', 'privacy.delete': '刪除帳號',
};
async function auditPanel() {
  const { items } = await api('/audit');
  return `<section class="card">
    <div class="row spread"><h3>稽核紀錄</h3><span class="tiny">最近 ${items.length} 筆</span></div>
    <p class="tiny">所有特權操作都會留下紀錄，應用程式內無法修改或刪除。IP 只存雜湊值。</p>
    <div class="audit">${items.map((x) => `<div class="arow">
      <span class="num tiny">${esc(x.at.slice(5, 16))}</span>
      <span><b>${esc(AUDIT_NAME[x.action] || x.action)}</b>
        <span class="tiny" style="display:block">${esc(x.actor_name || '未登入')}${x.actor_role ? `（${esc(ROLE_NAME[x.actor_role] || x.actor_role)}）` : ''}${x.detail ? `・${esc(x.detail)}` : ''}</span></span>
    </div>`).join('') || '<p class="muted">沒有紀錄。</p>'}</div>
  </section>`;
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

// ---------- 名冊與角色 ----------
async function rosterView() {
  const { members } = await api('/members');
  const byRole = {};
  for (const m of members) (byRole[m.role] ||= []).push(m);
  const order = ['chair', 'director', 'supervisor', 'staff', 'coach', 'member'];
  view.innerHTML = `
    <div class="row spread" style="padding:4px"><h2>團員名冊</h2><span class="tiny">${members.length} 人</span></div>
    ${order.filter((r) => byRole[r]?.length).map((r) => `
      <section class="card">
        <div class="row spread"><h3>${ROLE_NAME[r]}</h3><span class="tiny">${byRole[r].length} 人</span></div>
        <div class="roster">${byRole[r].map((m) => `
          <div class="r">
            ${avatar(m)}
            <span>${esc(m.name)}${m.title ? ` <span class="tiny">${esc(m.title)}</span>` : ''}
              <span class="tiny" style="display:block">${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)} 組</span></span>
            ${allow('roles') ? `<button class="btn ghost sm" data-role="${m.id}" data-name="${esc(m.name)}" data-cur="${m.role}">變更</button>` : ''}
          </div>`).join('')}</div>
      </section>`).join('')}`;
  for (const b of document.querySelectorAll('[data-role]')) b.onclick = () => roleDialog(b.dataset.role, b.dataset.name, b.dataset.cur);
}
function roleDialog(id, name, cur) {
  const opts = Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
  view.insertAdjacentHTML('afterbegin', `<section class="card" id="rd">
    <h3>變更 ${esc(name)} 的身分</h3>
    <form id="rf">
      <label>身分<select name="role">${opts}</select></label>
      <label>職稱（選填）<input name="title" maxlength="12" placeholder="例如 副理事長、活動組長"></label>
      <div class="row"><button class="btn sm">儲存</button><button type="button" class="btn ghost sm" id="rc">取消</button></div>
    </form>
  </section>`);
  $('#rc').onclick = () => $('#rd').remove();
  $('#rf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/members/${id}/role`, { method: 'POST', body: { role: e.target.role.value, title: e.target.title.value } }); toast('已更新'); render(); }
    catch (err) { toast(err.message); }
  };
}

// ---------- 春酒：入場券、報到、抽獎 ----------
function partySignupForm(ev, mine) {
  const meals = (ev.meal_options || '').split(',').map((s) => s.trim()).filter(Boolean);
  return `<form id="pform">
    ${ev.guest_max ? `<label>攜伴人數<select name="guests">${Array.from({ length: ev.guest_max + 1 }, (_, i) => `<option value="${i}">${i ? `${i} 位` : '不帶'}</option>`).join('')}</select></label>` : ''}
    ${meals.length ? `<label>餐點<select name="meal">${meals.map((m) => `<option ${m === me.meal_pref ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : ''}
    <label>備註（選填）<input name="note" maxlength="40" placeholder="素食、座位需求…"></label>
    <button class="btn block">${mine ? '更新報名' : '我要報名'}</button>
  </form>`;
}
function ticketCard(t, ev) {
  return `<section class="card ticket">
    <div class="row spread"><h3>我的入場券</h3>${t.checked_in_at ? '<span class="pill solid">已報到</span>' : '<span class="pill">未報到</span>'}</div>
    <div class="qrbox" id="qrBox" data-code="${esc(t.code)}" data-ev="${esc(ev.id)}"></div>
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

// 掃碼／連結報到：/#/e/<id>/in/<code>
async function checkinView(eventId, code) {
  if (!allow('checkin')) {
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
  if (!allow('checkin')) { view.innerHTML = '<div class="card"><p class="muted">只有幹部可以掃碼報到。</p></div>'; return; }
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
        $('#scanMsg').textContent = `${r.already ? '已報到過：' : '✅ '}${r.name}${r.table_no ? `・第 ${r.table_no} 桌` : ''}`;
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
      <a class="btn sm" href="#/e/${ev.id}/scan">📷 掃碼報到</a>
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
          ${w.length ? `<div class="winners">${w.map((d) => `<button class="pill ${d.claimed_at ? 'solid' : 'wait'}" data-claim="${d.id}" title="${d.claimed_at ? '已領獎' : '點一下確認領獎'}">${esc(d.name)}${d.claimed_at ? ' ✓' : ''}</button>`).join('')}</div>` : ''}
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

// ---------- 我的課表 ----------
async function planView(n) {
  const week = n || P.currentWeek();
  const info = await P.weekInfo(week);
  const days = await P.weekPlan(week, me.dist, me.grp);
  const posts = (await api(`/plans?week=${week}`).catch(() => ({ plans: [] }))).plans;
  const s = P.weekStart(week), e = new Date(s.getTime() + 6 * 864e5);
  const isNow = week === P.currentWeek();
  view.innerHTML = `
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
      <div class="row spread">
        <span class="muted">${me.dist === 'hm' ? '半馬' : '全馬'} ${me.grp} 組</span>
        <span class="pill">${me.dist === 'hm' ? 'HMP' : 'MP'} ${P.fmtPace(P.goalPace(me.dist, me.grp))}/km</span>
      </div>
      ${posts.length ? '' : info?.src?.startsWith('推估') ? '<p class="notice" style="margin:0">這週教練還沒發課表，內容是照 2025 臺北馬同一階段推估的，實際以教練公告為準。</p>' : ''}
      ${allow('plan') ? '<a class="btn ghost sm" href="#/plan/new">發布這週課表</a>' : ''}
    </section>
    ${posts.map((po) => `<section class="card">
      <div class="row spread"><h3>${esc(po.title)}</h3><span class="pill">教練發布</span></div>
      <p class="tiny">${esc(po.author || '')}・${ago(po.created_at)}</p>
      <pre class="out">${esc(po.body)}</pre>
      ${allow('plan') ? `<button class="btn danger sm" data-delplan="${po.id}">刪除</button>` : ''}
    </section>`).join('')}
    <div class="days">${days ? days.map((d) => `
      <div class="day ${d.kind}">
        <span class="dl"><span>${esc(d.d)}</span><span class="k">${P.KIND_LABEL[d.kind]}</span></span>
        <span class="t">${esc(d.t)} <span class="hint">${P.paceHint(d.t, me.dist, me.grp)}</span></span>
      </div>`).join('') : '<div class="card"><p class="muted">這週沒有課表資料。</p></div>'}</div>`;
  for (const b of document.querySelectorAll('[data-delplan]')) b.onclick = async () => {
    if (!confirm('確定刪除這則課表？')) return;
    await api(`/plans/${b.dataset.delplan}`, { method: 'DELETE' }); toast('已刪除'); render();
  };
  $('#prev').onclick = () => { location.hash = `#/plan/${week - 1}`; };
  $('#next').onclick = () => { location.hash = `#/plan/${week + 1}`; };
}

// ---------- 課表教練（原本的 GitHub Pages 頁面）----------
function coachView() {
  view.innerHTML = `
    <section class="card hero">
      <h2>課表教練</h2>
      <p class="muted" style="margin:0">回答幾個選擇題，產生整季逐週課表、配速換算、年齡分級與比賽補給試算。</p>
      <a class="btn ghost block" href="/coach.html" style="background:#fff;color:#1C4698;border:0">開啟課表教練</a>
    </section>
    <section class="card">
      <h3>課表來源</h3>
      <p class="muted" style="margin:0">耕跑團記事本：2026 台北馬 W2–W8 是教練發布的原文；W9 以後依 2025 同期推估，實際以教練每週公告為準。</p>
    </section>`;
}

// ---------- 幹部：新增／編輯活動 ----------
async function formView(id) {
  const ev = id ? await api(`/events/${id}`) : null;
  const d = ev || { kind: 'track', date: new Date().toISOString().slice(0, 10), signup_open: 1 };
  view.innerHTML = `<section class="card">
    <h2>${id ? '編輯活動' : '新增活動'}</h2>
    <form id="ef">
      <label>類型<select name="kind">${Object.entries(KIND_NAME).map(([k, v]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>標題<input name="title" required maxlength="40" value="${esc(d.title || '')}" placeholder="10/8（四）耕跑團練"></label>
      <div class="grid2">
        <label>日期<input type="date" name="date" required value="${esc(d.date)}"></label>
        <label>集合時間<input type="time" name="gather_time" value="${esc(d.gather_time || '')}"></label>
      </div>
      <label>地點<input name="place" maxlength="60" value="${esc(d.place || '')}" placeholder="臺北田徑場 400 場"></label>
      <label>帶團<input name="lead" maxlength="30" value="${esc(d.lead || '')}" placeholder="教練或領跑員"></label>
      <div class="grid2">
        <label>課表週次<input type="number" name="week_no" min="1" max="21" value="${d.week_no || ''}" placeholder="自動帶課表"></label>
        <label>人數上限<input type="number" name="capacity" min="1" max="999" value="${d.capacity || ''}" placeholder="不限"></label>
      </div>
      <div class="grid2">
        <label>外部報名連結（選填）<input name="link_url" type="url" value="${esc(d.link_url || '')}" placeholder="https://forms.gle/…"></label>
        <label>按鈕文字<input name="link_label" maxlength="12" value="${esc(d.link_label || '')}" placeholder="索票登記"></label>
      </div>
      <label>自填課表（沒填週次時使用）<textarea name="plan_text" placeholder="S：…">${esc(d.plan_text || '')}</textarea></label>
      <label>注意事項<textarea name="note" placeholder="攜帶瑜珈墊、水、彈力帶、毛巾">${esc(d.note || '')}</textarea></label>
      <label class="inline"><input type="checkbox" name="signup_open" ${d.signup_open ? 'checked' : ''}> 開放報名</label>
      <button class="btn block">${id ? '儲存' : '建立並通知團員'}</button>
    </form>
    <p class="tiny">填了週次，公告就會自動帶出各組課表；也可以在自填課表貼教練原文。</p>
  </section>`;
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      kind: f.kind.value, title: f.title.value, date: f.date.value, gather_time: f.gather_time.value,
      place: f.place.value, lead: f.lead.value, note: f.note.value, plan_text: f.plan_text.value,
      link_url: f.link_url.value, link_label: f.link_label.value,
      week_no: f.week_no.value ? Number(f.week_no.value) : null,
      capacity: f.capacity.value ? Number(f.capacity.value) : null,
      signup_open: f.signup_open.checked,
    };
    try {
      if (id) { await api(`/events/${id}`, { method: 'PUT', body }); location.hash = `#/e/${id}`; }
      else { location.hash = `#/e/${(await api('/events', { method: 'POST', body })).id}`; }
      toast('已儲存');
    } catch (err) { toast(err.message); }
  };
}

// ---------- 我的 ----------
async function meView() {
  const sub = await (await navigator.serviceWorker?.ready.catch(() => null))?.pushManager.getSubscription().catch(() => null);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const welcome = new URLSearchParams(location.hash.split('?')[1] || '').get('welcome');
  view.innerHTML = `
    ${welcome ? '<div class="notice">歡迎加入！先確認你的項目和組別，課表和報名都會照這個設定。</div>' : ''}
    <section class="card">
      <div class="row">
        ${avatar(me)}
        <div style="flex:1"><b>${esc(me.name)}</b>
          <div class="tiny">${esc(me.title || me.roleName || ROLE_NAME[me.role] || '團員')}${me.line ? '・LINE 登入' : ''}</div></div>
      </div>
      <form id="mf">
        <div class="grid2">
          <label>姓名<input name="name" value="${esc(me.name)}" maxlength="20"></label>
          <label>暱稱<input name="nickname" value="${esc(me.nickname || '')}" maxlength="20" placeholder="團裡怎麼叫你"></label>
        </div>
        <div class="grid2">
          <label>項目<select name="dist"><option value="fm" ${me.dist === 'fm' ? 'selected' : ''}>全馬</option><option value="hm" ${me.dist === 'hm' ? 'selected' : ''}>半馬</option></select></label>
          <label>組別<select name="grp"></select></label>
        </div>
        <label>所屬跑團<input name="club" list="clubs" value="${esc(me.club || '')}" maxlength="30" placeholder="耕跑團">
          <datalist id="clubs">${Party.CLUBS.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <div class="grid2">
          <label>餐點偏好<select name="meal_pref">
            <option value="" ${!me.meal_pref ? 'selected' : ''}>未指定</option>
            <option ${me.meal_pref === '葷食' ? 'selected' : ''}>葷食</option>
            <option ${me.meal_pref === '素食' ? 'selected' : ''}>素食</option></select></label>
          <label>電話（選填）<input name="phone" value="${esc(me.phone || '')}" maxlength="20" inputmode="tel" placeholder="餐會聯絡用"></label>
        </div>
        <button class="btn block">儲存</button>
      </form>
      <p class="tiny">填好之後，報名任何活動都會直接帶入這些資料，不用再填一次。</p>
    </section>

    <section class="card">
      <h3>通知</h3>
      ${cfg.vapid
        ? `<p class="muted" style="margin:0">新團練公告、候補遞補都會通知你。${standalone ? '' : '在 iPhone 上要先用「分享 → 加到主畫面」，再從主畫面打開才收得到。'}</p>
           <div class="row"><button class="btn sm" id="pushBtn">${sub ? '關閉通知' : '開啟通知'}</button>
           ${sub ? '<button class="btn ghost sm" id="pushTest">發測試通知</button>' : ''}</div>`
        : '<p class="muted" style="margin:0">還沒設定推播金鑰，通知功能尚未啟用。</p>'}
    </section>

    ${(allow('members') || allow('roles')) ? '<a class="card" href="#/admin"><div class="row spread"><h3>管理後台</h3><span class="tiny">會員・身分・座位圖 ›</span></div></a>' : ''}
    ${allow('roster') ? `<a class="card" href="#/roster"><div class="row spread"><h3>團員名冊</h3><span class="tiny">${allow('roles') ? '可指派幹部角色' : '查看'} ›</span></div></a>` : ''}
    ${allow('plan') ? '<a class="card" href="#/plan/new"><div class="row spread"><h3>發布課表</h3><span class="tiny">教練 ›</span></div></a>' : ''}
    ${me.role !== 'member' ? '' : `<details class="card tight">
      <summary class="tiny" style="cursor:pointer">系統初始設定（只限第一位理事長）</summary>
      <p class="tiny">幹部身分一律由理事長在後台指派。這裡只用在系統剛建立、還沒有理事長的時候。</p>
      <form id="af" class="row" style="gap:8px">
        <input name="code" placeholder="初始設定碼" style="flex:1;min-width:140px" autocomplete="off">
        <button class="btn sm">設定</button>
      </form>
    </details>`}

    <section class="card">
      <div class="row spread"><h3>台灣耕跑團協會</h3>
        <span class="pill ${me.membership === 'active' ? 'solid' : me.membership === 'applied' ? 'wait' : ''}">${esc(me.membershipName || '跑友')}</span></div>
      ${me.membership === 'active'
        ? `<p class="muted" style="margin:0">${esc(me.member_type || '會員')}${me.member_no ? `・編號 ${esc(me.member_no)}` : ''}${me.paid_until ? `・會費繳至 ${esc(me.paid_until)}` : ''}</p>`
        : `<p class="muted" style="margin:0">跑友可以報名所有團練；想加入協會的話，先填官方表單（含身分證字號等資料，不存在這個網站），再按下方按鈕通知行政人員。</p>
           <a class="btn ghost block" href="https://docs.google.com/forms/d/1QVo9rHK6nUmm0vQgFSV9HYzMd5L5pDSnLuZV69-yMHY/viewform" target="_blank" rel="noopener">開啟入會表單</a>
           ${me.membership === 'applied' ? '<p class="notice" style="margin:0">已送出申請，等行政人員確認。</p>' : '<button class="btn block" id="applyBtn">我已填表，送出申請</button>'}`}
    </section>
    <section class="card" id="myPrizes"></section>

    <section class="card">
      <h3>隱私與帳號</h3>
      <p class="tiny" style="margin:0">我們只存姓名、暱稱、組別、跑團、餐點偏好與報名紀錄；電話只有行政人員看得到完整號碼。你可以隨時下載或刪除自己的資料。</p>
      <div class="row">
        <a class="btn ghost sm" href="/api/me/export" download>下載我的資料</a>
        <button class="btn ghost sm" id="logoutAll">登出所有裝置</button>
        <button class="btn danger sm" id="delAcct">刪除帳號</button>
      </div>
    </section>
    <button class="btn ghost block" id="logout">登出</button>
    <p class="tiny center">課表來源：耕跑團記事本。W9 以後為系統推估，以教練公告為準。</p>`;

  const f = $('#mf');
  const sync = () => {
    f.grp.innerHTML = Object.entries(P.groups(f.dist.value)).map(([g, v]) => `<option value="${g}">${g}　SUB ${v[0]}</option>`).join('');
    f.grp.value = Object.keys(P.groups(f.dist.value)).includes(me.grp) ? me.grp : (f.dist.value === 'hm' ? 'C' : 'D');
  };
  f.dist.onchange = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = (await api('/me', { method: 'PUT', body: {
        name: f.name.value, dist: f.dist.value, grp: f.grp.value,
        nickname: f.nickname.value, club: f.club.value, meal_pref: f.meal_pref.value, phone: f.phone.value } })).member;
      toast('已儲存');
    }
    catch (err) { toast(err.message); }
  };
  $('#af')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { me = (await api('/me/admin', { method: 'POST', body: { code: e.target.code.value } })).member; toast('已設定為理事長'); render(); }
    catch (err) { toast(err.message); }
  });
  $('#applyBtn')?.addEventListener('click', async () => {
    try { me = (await api('/me/apply', { method: 'POST' })).member; toast('已送出申請'); render(); } catch (e) { toast(e.message); }
  });
  api('/my/prizes').then(({ prizes }) => {
    const box = $('#myPrizes');
    if (!box) return;
    box.innerHTML = prizes.length
      ? `<h3>我的中獎紀錄</h3>${prizes.map((p) => `<div class="r"><span>🎁</span>
          <span><b>${esc(p.prize)}</b>${p.stage ? ` <span class="tiny">${esc(p.stage)}</span>` : ''}
            <span class="tiny" style="display:block">${esc(p.title)}${p.sponsor ? `・${esc(p.sponsor)}` : ''}</span></span>
          <span class="pill ${p.claimed_at ? 'solid' : 'wait'}">${p.claimed_at ? '已領獎' : '待領獎'}</span></div>`).join('')}`
      : '';
    box.hidden = !prizes.length;
  }).catch(() => {});
  $('#logoutAll').onclick = async () => {
    if (!confirm('要登出所有裝置嗎？包含這一台。')) return;
    await api('/logout', { method: 'POST', body: { all: true } }); me = null; location.hash = '#/'; render();
  };
  $('#delAcct').onclick = async () => {
    if (!confirm('刪除後無法復原：報名、入場券與通知都會刪除，中獎紀錄會匿名保留給協會對帳。確定刪除？')) return;
    try { await api('/me', { method: 'DELETE' }); me = null; toast('帳號已刪除'); location.hash = '#/'; render(); }
    catch (e) { toast(e.message); }
  };
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; location.hash = '#/'; render(); };
  $('#pushBtn')?.addEventListener('click', () => togglePush(sub));
  $('#pushTest')?.addEventListener('click', async () => {
    try { await api('/push/test', { method: 'POST' }); toast('已送出測試通知'); } catch (e) { toast(e.message); }
  });
}

async function togglePush(sub) {
  try {
    const reg = await navigator.serviceWorker.ready;
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
async function render() {
  if (stopScan) { stopScan(); stopScan = null; }
  const raw = location.hash.replace(/^#/, '') || '/';
  const hash = raw.split('?')[0];
  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === '/' ? hash === '/' : hash.startsWith(a.dataset.tab);
    a.toggleAttribute('aria-current', on);
  }
  const days = Math.ceil((P.RACE - new Date()) / 864e5);
  $('#countdown').innerHTML = days > 0 ? `<b class="num">${days}</b>天到臺北馬` : '';
  if (!me) {
    try { const r = await api('/me'); me = r.member; cfg = r; } catch { me = null; }
  }
  if (!me) return loginView();
  bell();
  try {
    if (hash === '/') return await listView();
    if (hash === '/past') return await pastView();
    if (hash === '/coach') return coachView();
    if (hash === '/notifications') return await notificationsView();
    if (hash === '/roster') return await rosterView();
    if (hash === '/admin') return await adminView();
    if (hash === '/plan/new') return planNewView();
    if (hash === '/me') return await meView();
    if (hash === '/new') return await formView(null);
    const edit = hash.match(/^\/edit\/([\w-]+)$/);
    if (edit) return await formView(edit[1]);
    const ci = hash.match(/^\/e\/([\w-]+)\/in\/([\w-]+)$/);
    if (ci) return await checkinView(ci[1], ci[2].toUpperCase());
    const sc = hash.match(/^\/e\/([\w-]+)\/scan$/);
    if (sc) return await scanView(sc[1]);
    const ev = hash.match(/^\/e\/([\w-]+)$/);
    if (ev) return await eventView(ev[1]);
    const pl = hash.match(/^\/plan(?:\/(\d+))?$/);
    if (pl) return await planView(pl[1] ? Number(pl[1]) : 0);
    view.innerHTML = '<div class="card"><p class="muted">找不到這個頁面。</p></div>';
  } catch (e) {
    view.innerHTML = `<div class="card"><p class="muted">${esc(e.message)}</p></div>`;
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

// 換頁用 View Transition（支援的瀏覽器才有）
const go = () => { render(); scrollTo({ top: 0, behavior: 'instant' }); };
addEventListener('hashchange', () => {
  if (!document.startViewTransition) return go();
  // 連續換頁時前一個轉場會被中斷，忽略那個 rejection
  document.startViewTransition(go).finished.catch(() => {});
});
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
