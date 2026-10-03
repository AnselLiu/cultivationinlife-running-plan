// 耕跑團 PWA — manage.js：從 app.js 拆出來、用到才載入的畫面（第一次開 App 不用下載）
import { $, allow, api, bars, copy, dstr, emptyState, esc, feat, group, IC, KIND_NAME, largeTitle, me, money, PAID_NAME, row, teamAllow, teams, toast, view } from './app.js';

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

export { formView, statsView };
