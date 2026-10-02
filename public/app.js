// 耕跑團 PWA — 畫面：團練列表、活動詳情與報名、我的課表、課表教練、幹部的新增活動與公告產生器
import * as P from './plan.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = async (path, opt = {}) => {
  const res = await fetch(`/api${path}`, {
    method: opt.method || 'GET',
    headers: opt.body ? { 'content-type': 'application/json' } : undefined,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
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

const KIND_NAME = { track: '田徑場團練', core: '核心日', long: '長跑團練', race: '賽事', other: '活動' };
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
    ${events.length > 1 || me.role === 'admin' ? `<div class="row spread" style="padding:4px 4px 0">
      <h3>接下來</h3>
      ${me.role === 'admin' ? '<a class="btn ghost sm" href="#/new">＋ 新增活動</a>' : ''}
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
  const admin = me.role === 'admin';
  const ins = ev.signups.filter((s) => s.status === 'in');
  const waits = ev.signups.filter((s) => s.status === 'wait');
  const mine = ev.signups.find((s) => s.member_id === me.id);
  const closed = !ev.signup_open || ev.status !== 'open' || (ev.deadline && new Date(ev.deadline) < new Date());
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
    </section>

    ${myDay ? `<section class="card">
      <div class="row spread"><h3>你這天的課表</h3><span class="pill">${me.dist === 'hm' ? '半馬' : '全馬'} ${me.grp} 組</span></div>
      <div class="day ${myDay.kind}">
        <span class="dl"><span>${esc(myDay.d)}</span><span class="k">${P.KIND_LABEL[myDay.kind]}</span></span>
        <span class="t">${esc(myDay.t)} <span class="hint">${P.paceHint(myDay.t, me.dist, me.grp)}</span></span>
      </div></section>` : ''}
    ${ev.plan_text ? `<section class="card"><h3>課表</h3><pre class="out">${esc(ev.plan_text)}</pre></section>` : ''}

    <section class="card">
      <div class="row spread">
        <h3>報名 ${ins.length}${ev.capacity ? ` / ${ev.capacity}` : ''} 人</h3>
        ${mine && mine.status !== 'cancel'
          ? '<button class="btn danger sm" id="cancel">取消報名</button>'
          : closed ? '<span class="tiny">未開放報名</span>' : '<button class="btn sm" id="signup">我要報名</button>'}
      </div>
      ${mine?.status === 'wait' ? '<p class="notice" style="margin:0">你在候補名單，有人取消會自動遞補並通知你。</p>' : ''}
      <div class="roster">
        ${ins.map((s) => `<div class="r">${avatar(s)}<span>${esc(s.name)}${s.note ? ` <span class="tiny">${esc(s.note)}</span>` : ''}</span><span class="pill">${esc(s.grp)}</span></div>`).join('')
          || '<p class="muted" style="margin:0">還沒有人報名，當第一個吧。</p>'}
        ${waits.map((s) => `<div class="r">${avatar(s)}<span>${esc(s.name)}</span><span class="pill wait">候補</span></div>`).join('')}
      </div>
      ${admin ? '<button class="btn ghost sm" id="copyRoster">複製名單</button>' : ''}
    </section>

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
  if (ev.signup_open) L.push('', `報名：${location.origin}/#/e/${ev.id}`);
  return L.join('\n');
}
const dayPattern = (date) => { const w = d2(date).getDay(); return w === 0 || w === 6 ? '週末|週日' : `週${WD[w]}`; };

// ---------- 我的課表 ----------
async function planView(n) {
  const week = n || P.currentWeek();
  const info = await P.weekInfo(week);
  const days = await P.weekPlan(week, me.dist, me.grp);
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
      ${info?.src?.startsWith('推估') ? '<p class="notice" style="margin:0">這週教練還沒發課表，內容是照 2025 臺北馬同一階段推估的，實際以教練公告為準。</p>' : ''}
    </section>
    <div class="days">${days ? days.map((d) => `
      <div class="day ${d.kind}">
        <span class="dl"><span>${esc(d.d)}</span><span class="k">${P.KIND_LABEL[d.kind]}</span></span>
        <span class="t">${esc(d.t)} <span class="hint">${P.paceHint(d.t, me.dist, me.grp)}</span></span>
      </div>`).join('') : '<div class="card"><p class="muted">這週沒有課表資料。</p></div>'}</div>`;
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
          <div class="tiny">${me.role === 'admin' ? '幹部・可建立活動與公告' : '團員'}${me.line ? '・LINE 登入' : ''}</div></div>
      </div>
      <form id="mf">
        <label>姓名<input name="name" value="${esc(me.name)}" maxlength="20"></label>
        <div class="grid2">
          <label>項目<select name="dist"><option value="fm" ${me.dist === 'fm' ? 'selected' : ''}>全馬</option><option value="hm" ${me.dist === 'hm' ? 'selected' : ''}>半馬</option></select></label>
          <label>組別<select name="grp"></select></label>
        </div>
        <button class="btn block">儲存</button>
      </form>
    </section>

    <section class="card">
      <h3>通知</h3>
      ${cfg.vapid
        ? `<p class="muted" style="margin:0">新團練公告、候補遞補都會通知你。${standalone ? '' : '在 iPhone 上要先用「分享 → 加到主畫面」，再從主畫面打開才收得到。'}</p>
           <div class="row"><button class="btn sm" id="pushBtn">${sub ? '關閉通知' : '開啟通知'}</button>
           ${sub ? '<button class="btn ghost sm" id="pushTest">發測試通知</button>' : ''}</div>`
        : '<p class="muted" style="margin:0">還沒設定推播金鑰，通知功能尚未啟用。</p>'}
    </section>

    ${me.role === 'admin' ? '' : `<section class="card">
      <h3>我是幹部</h3>
      <form id="af" class="row" style="gap:8px">
        <input name="code" placeholder="幹部碼" style="flex:1;min-width:140px" autocomplete="off">
        <button class="btn sm">升級</button>
      </form>
    </section>`}

    <section class="card">
      <h3>台灣耕跑團協會</h3>
      <p class="muted" style="margin:0">入會申請使用協會的 Google 表單，網站不存身分證字號等資料。</p>
      <a class="btn ghost block" href="https://docs.google.com/forms/d/1QVo9rHK6nUmm0vQgFSV9HYzMd5L5pDSnLuZV69-yMHY/viewform" target="_blank" rel="noopener">開啟入會表單</a>
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
    try { me = (await api('/me', { method: 'PUT', body: { name: f.name.value, dist: f.dist.value, grp: f.grp.value } })).member; toast('已儲存'); }
    catch (err) { toast(err.message); }
  };
  $('#af')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { me = (await api('/me/admin', { method: 'POST', body: { code: e.target.code.value } })).member; toast('已升級為幹部'); render(); }
    catch (err) { toast(err.message); }
  });
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
  try {
    if (hash === '/') return await listView();
    if (hash === '/past') return await pastView();
    if (hash === '/coach') return coachView();
    if (hash === '/me') return await meView();
    if (hash === '/new') return await formView(null);
    const edit = hash.match(/^\/edit\/([\w-]+)$/);
    if (edit) return await formView(edit[1]);
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
addEventListener('hashchange', () => (document.startViewTransition ? document.startViewTransition(go) : go()));
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
