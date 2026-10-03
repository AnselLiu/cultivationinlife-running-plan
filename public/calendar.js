// 耕跑團 PWA — calendar.js：月曆（用到才載入）
//   一個月一次查完：看得到的活動、國定假日與補班（管理員匯入的新北市資料）、幹部設定的賽事提醒、自己的賽事
//   點一天看當天的內容；幹部可以新增賽事提醒，團員訂閱行事曆時會一起帶到手機
import { $, allow, api, esc, IC, KIND_NAME, largeTitle, me, teamAllow, teamOf, teams, toast, view, ymd } from './app.js';
import { lang, t } from './i18n.js';

const WD = lang === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '一', '二', '三', '四', '五', '六'];
const ITEM_KIND = { race: '賽事', signup: '報名', note: '提醒' };
let picked = null;

async function calendarView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : (picked || ymd(new Date())).slice(0, 7);
  if (!picked || picked.slice(0, 7) !== month) picked = month === ymd(new Date()).slice(0, 7) ? ymd(new Date()) : `${month}-01`;
  const d = await api(`/calendar?month=${month}`);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  const shift = (n) => { const x = new Date(y, m - 1 + n, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };
  const at = (k) => (date) => d[k].filter((x) => x.date === date);
  const evOn = at('events'), holOn = at('holidays'), itOn = at('items'), raceOn = at('races');
  const today = ymd(new Date());
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<span class="cd pad" aria-hidden="true"></span>');
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`, wd = (first.getDay() + day - 1) % 7;
    const hol = holOn(date), off = hol.some((h) => h.is_holiday && h.name), work = hol.some((h) => !h.is_holiday);
    const evs = evOn(date), its = itOn(date), races = raceOn(date);
    const dots = [...evs.map((e) => `<i class="dot ${e.mine === 'in' ? 'mine' : ''}" style="--tc:${esc(teamOf(e.team_id)?.color || 'var(--accent)')}"></i>`),
      ...its.map(() => '<i class="dot item"></i>'), ...races.map(() => '<i class="dot race"></i>')].slice(0, 4).join('');
    cells.push(`<button class="cd ${(wd === 0 || wd === 6 || off) && !work ? 'off' : ''} ${date === today ? 'today' : ''} ${date === picked ? 'sel' : ''}" data-day="${date}"
      aria-label="${m} 月 ${day} 日${hol.find((h) => h.name) ? `，${esc(hol.find((h) => h.name).name)}` : ''}${evs.length ? `，${evs.length} 個活動` : ''}${its.length ? `，${its.length} 個提醒` : ''}" aria-pressed="${date === picked}">
      <b class="num">${day}</b>${hol.find((h) => h.name) ? `<small>${esc(t(hol.find((h) => h.name).name).slice(0, lang === 'en' ? 12 : 4))}</small>` : work ? '<small>補班</small>' : ''}<span class="dots">${dots}</span></button>`);
  }
  const needHol = !d.holidaysLoaded;
  view.innerHTML = `${largeTitle('行事曆', '團練、揪跑、賽事提醒與國定假日')}
    <section class="card calcard">
      <div class="row spread calhead">
        <button class="btn ghost sm" data-m="${shift(-1)}" aria-label="上個月">‹</button>
        <h2>${y} 年 ${m} 月</h2>
        <button class="btn ghost sm" data-m="${shift(1)}" aria-label="下個月">›</button>
      </div>
      <div class="calgrid" role="group" aria-label="${y} 年 ${m} 月">${WD.map((w, i) => `<span class="wd ${i === 0 || i === 6 ? 'off' : ''}">${w}</span>`).join('')}${cells.join('')}</div>
      <div class="legend tiny"><span><i class="dot"></i>活動</span><span><i class="dot mine"></i>已報名</span><span><i class="dot item"></i>賽事提醒</span><span><i class="dot race"></i>我的賽事</span></div>
      ${needHol ? `<p class="tiny" style="margin:0">${allow('settings') ? `還沒匯入 ${y} 年的國定假日，<a href="#/admin?tab=settings">到系統設定匯入</a>。` : `${y} 年的國定假日還沒匯入。`}</p>` : ''}
    </section>
    <section class="card" id="dayBox"></section>
    <div class="row" style="gap:8px">${d.canAdd ? `<button class="btn sm iconbtn" id="addItem">${IC.plus}新增賽事提醒</button>` : ''}<a class="btn ghost sm" href="#/me/notify">訂閱到手機行事曆</a></div>
    <div id="itemForm"></div>`;
  const paintDay = () => {
    const date = picked, hol = holOn(date), evs = evOn(date), its = itOn(date), races = raceOn(date);
    const x = new Date(`${date}T00:00:00`);
    $('#dayBox').innerHTML = `<div class="row spread"><h3>${x.getMonth() + 1} 月 ${x.getDate()} 日・週${'日一二三四五六'[x.getDay()]}</h3>${hol.filter((h) => h.name || !h.is_holiday).map((h) => `<span class="pill ${h.is_holiday ? 'race' : ''}"><span translate="no">${esc(h.name || '補行上班')}</span></span>`).join('')}</div>
      ${evs.map((e) => `<a class="todayev" href="#/e/${esc(e.id)}">${IC.calendar}<span><b><span translate="no">${esc(e.title)}</span></b><span class="tiny" style="display:block">${KIND_NAME[e.kind] || '活動'}${e.gather_time ? `・${esc(e.gather_time)} 集合` : ''}${e.place ? `・<span translate="no">${esc(e.place)}</span>` : ''}・${e.signed} 人${e.mine === 'in' ? '・你已報名' : e.mine === 'wait' ? '・候補中' : e.mine === 'pending' ? '・審核中' : ''}${e.series_id ? '・定期' : ''}</span></span><span class="tiny">›</span></a>`).join('')}
      ${its.map((it) => `<div class="todayev">${IC.megaphone}<span><b>【${ITEM_KIND[it.kind] || '提醒'}】<span translate="no">${esc(it.title)}</span></b>${it.note ? `<span class="tiny" style="display:block"><span translate="no">${esc(it.note)}</span></span>` : ''}${it.url ? `<a class="tiny" href="${esc(it.url)}" target="_blank" rel="noopener">開啟連結 ${IC.external}</a>` : ''}</span>
        ${it.canEdit ? `<button class="btn ghost sm" data-delit="${esc(it.id)}">刪除</button>` : ''}</div>`).join('')}
      ${races.map((r) => `<a class="todayev" href="#/me/races">${IC.runner}<span><b><span translate="no">${esc(r.name)}</span></b><span class="tiny" style="display:block">我的賽事・${esc(r.dist || '')}</span></span><span class="tiny">›</span></a>`).join('')}
      ${!evs.length && !its.length && !races.length ? `<p class="muted" style="margin:0">這天沒有安排。${allow('event') || teams().some((t) => teamAllow(t.id, 'event')) ? `<a href="#/new?date=${date}">在這天開團 ›</a>` : ''}</p>` : ''}`;
    for (const b of document.querySelectorAll('[data-delit]')) b.onclick = async () => {
      if (!confirm('刪除這筆提醒？')) return;
      try { await api(`/calendar/items/${b.dataset.delit}`, { method: 'DELETE' }); toast('已刪除'); calendarView(); } catch (e) { toast(e.message); }
    };
  };
  paintDay();
  for (const b of document.querySelectorAll('[data-day]')) b.onclick = () => {
    picked = b.dataset.day;
    for (const c of document.querySelectorAll('[data-day]')) { c.classList.toggle('sel', c === b); c.setAttribute('aria-pressed', String(c === b)); }
    paintDay();
  };
  for (const b of document.querySelectorAll('[data-m]')) b.onclick = () => { picked = null; history.replaceState(null, '', `#/calendar?m=${b.dataset.m}`); calendarView(); };
  $('#addItem')?.addEventListener('click', () => itemForm());
}

// 幹部新增賽事提醒：賽事當天、報名開始或截止、其他提醒；可以只給某個分團
function itemForm() {
  const teamOpts = [...(allow('event') ? [['', '全協會']] : []), ...teams().filter((t) => teamAllow(t.id, 'event')).map((t) => [t.id, t.name])];
  $('#itemForm').innerHTML = `<form class="card" id="itf">
    <h3>新增賽事提醒</h3>
    <div class="grid2"><label>日期<input type="date" name="date" required value="${esc(picked)}"></label>
      <label>類型<select name="kind">${Object.entries({ race: '賽事當天', signup: '報名開始或截止', note: '其他提醒' }).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label></div>
    <label>標題<input name="title" maxlength="60" required placeholder="例如 2026 臺北馬拉松 報名開始"></label>
    <label>連結（選填）<input name="url" type="url" placeholder="https://"></label>
    <label>說明（選填）<input name="note" maxlength="300" placeholder="例如 早上 10 點開放，名額有限"></label>
    <div class="grid2"><label>給誰看<select name="team_id">${teamOpts.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></label>
      <label class="inline" style="align-self:end"><input type="checkbox" name="notify"> 同時推播通知</label></div>
    <p class="tiny" style="margin:0">「報名開始或截止」會在訂閱的手機行事曆前一天提醒。</p>
    <div class="row"><button class="btn sm">新增</button><button type="button" class="btn ghost sm" id="itCancel">取消</button></div></form>`;
  const f = $('#itf');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#itCancel').onclick = () => { $('#itemForm').innerHTML = ''; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/calendar/items', { method: 'POST', body: { date: f.date.value, kind: f.kind.value, title: f.title.value, url: f.url.value.trim(), note: f.note.value, team_id: f.team_id.value || null, notify: f.notify.checked } });
      picked = f.date.value; toast('已新增'); history.replaceState(null, '', `#/calendar?m=${f.date.value.slice(0, 7)}`); calendarView();
    } catch (err) { toast(err.message); }
  };
}

export { calendarView };
