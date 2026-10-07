// 耕跑團 PWA — manage.js：從 app.js 拆出來、用到才載入的畫面（第一次開 App 不用下載）
import { $, apiAll, addrField, bindAddrField, ago, askReason, downloadAuthed, isOffline, nowTp, scanSheet, signupDefaults, allow, api, bars, copy, dstr, emptyState, esc, feat, group, IC, KIND_NAME, largeTitle, me, money, PAID_NAME, row, teamAllow, teams, toast, rich, keep, names, view } from './app.js';
import { defaultWindow, windowError, shiftDays, daysBetween, evStart, tpText, tpShort } from './signup-window.js';

// ---------- 幹部：新增／編輯活動 ----------
const DRAFT = 'cil-ev-draft';
async function formView(id) {
  const qp = new URLSearchParams(location.hash.split('?')[1] || '');
  const from = !id && qp.get('from');
  const src = id ? await api(`/events/${id}`) : from ? await api(`/events/${from}`) : null;
  // 複製活動：沿用內容、問卷與座位圖，日期往後推一年（每年的春酒）或清空
  const d = src ? { ...src, ...(from ? { title: src.title.replace(/20\d\d/, (y) => String(Number(y) + 1)), date: nextYear(src.date) } : {}) }
    : { kind: 'track', date: /^\d{4}-\d{2}-\d{2}$/.test(qp.get('date') || '') ? qp.get('date') : nowTp().slice(0, 10), signup_open: 1, team_id: qp.get('team') || null };
  // 報名期間：新增活動依後台的「活動報名預設」推算；複製活動依日期差位移（已經過去或空白的改用預設）；編輯用原本存的值
  let winNotes = [];
  if (!id) {
    const def = signupDefaults(), w = defaultWindow(d, def, nowTp());
    if (from) {
      const off = daysBetween(src.date, d.date), mv = (x) => { const y = x ? shiftDays(x, off) : ''; return y && y > nowTp() ? y : ''; };
      d.signup_start = mv(src.signup_start) || w.start; d.deadline = mv(src.deadline) || w.end;
      if (windowError(d, { now: nowTp(), create: true })) { d.signup_start = w.start; d.deadline = w.end; }
    } else {
      d.signup_start = w.start; d.deadline = w.end; d.require_approval = def.approval ? 1 : 0; d.notify_signup = def.notify ? 1 : 0;
    }
    winNotes = w.notes;
  }
  // 分團選項：協會幹部可以選全協會與任何分團；分團幹部只能選自己帶的分團
  // 練跑地圖的地點與路線：選了地點，活動頁會顯示場地天氣；選了路線，大家可以下載 GPX
  const [{ spots = [] }, { routes = [] }] = await Promise.all([api('/spots').catch(() => ({})), api('/routes').catch(() => ({}))]);
  d.spot_id ||= qp.get('spot') || null; d.route_id ||= qp.get('route') || null;
  if (!id && !d.place && d.spot_id) d.place = spots.find((x) => x.id === d.spot_id)?.name || '';
  const teamOpts = [...(allow('event') ? [['', '全協會']] : []), ...teams().filter((t) => teamAllow(t.id, 'event')).map((t) => [t.id, t.name])];
  if (!teamOpts.length) { view.innerHTML = `<div class="card">${emptyState('calendar', '只有幹部與分團幹部可以建立活動')}</div>`; return; }
  view.innerHTML = `${largeTitle(id ? '編輯活動' : from ? '複製活動' : '新增活動', from ? `從「<span translate="no">${esc(src.title)}</span>」複製，座位圖也會一起帶過來` : '')}
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
        <label data-when="!survey"><span data-when="!party">集合時間</span><span data-when="party">開始時間</span><input type="time" name="gather_time" value="${esc(d.gather_time || '')}"></label>
      </div>
      <div data-when="!survey">
        <label>地點<input name="place" maxlength="60" value="${esc(d.place || '')}" placeholder="臺北田徑場 400 場"></label>
        ${addrField('address', '地址', '選填・餐廳或場館，送郵局核對')}
        <div class="grid2">
          <label>練跑地圖的地點<select name="spot_id"><option value="">（不指定）</option>${spots.filter((x) => x.status === 'approved').map((x) => `<option value="${esc(x.id)}" translate="no" ${d.spot_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
          <label>路線<select name="route_id"><option value="">（不指定）</option>${routes.map((r) => `<option value="${esc(r.id)}" ${d.route_id === r.id ? 'selected' : ''}>${esc(r.name)}・${(r.distance / 1000).toFixed(1)} 公里</option>`).join('')}</select></label>
        </div>
        <p class="tiny" style="margin:0">選了地點，活動頁會顯示當天的場地天氣與跑步建議；選了路線，大家可以下載 GPX。<a href="#/map">到練跑地圖新增 ›</a></p>
        <div class="grid2">
          <label>帶團<input name="lead" maxlength="30" value="${esc(d.lead || '')}" placeholder="教練或領跑員"></label>
          <label>人數上限<input type="number" name="capacity" min="1" max="999" value="${d.capacity || ''}" placeholder="不限"></label>
        </div>
      </div>
      <fieldset class="group" data-when="party">
        <legend>餐敘（春酒、慶功宴、尾牙）</legend>
        <label>可攜伴人數<input type="number" name="guest_max" min="0" max="9" value="${d.guest_max || ''}" placeholder="不開放"></label>
        <p class="tiny" style="margin:0">攜伴每位跟報名費同價，費用在下方「費用與收款」設定。</p>
        <label>餐點選項（逗號分隔）<input name="meal_options" maxlength="60" value="${esc(d.meal_options || '')}" placeholder="葷食,素食"></label>
      </fieldset>
      <fieldset class="group" id="signupBox"><legend>報名設定</legend>
        <label class="switch"><span>開放報名<span class="tiny" style="display:block">關掉後誰都不能報名（幹部代為報名不受影響）</span></span><input type="checkbox" name="signup_open" ${d.signup_open ? 'checked' : ''}><i></i></label>
        <div class="grid2 dt">
          <label>報名開始<input type="datetime-local" name="signup_start" value="${esc(d.signup_start || '')}" data-auto="${id ? 0 : 1}"></label>
          <label><span data-when="!survey">報名截止</span><span data-when="survey">回覆截止</span><input type="datetime-local" name="deadline" value="${esc(d.deadline || '')}" data-auto="${id ? 0 : 1}"></label>
        </div>
        <p class="tiny" id="winHint" aria-live="polite" style="margin:0"></p>
        <label class="switch" data-when="!survey"><span>需要審核<span class="tiny" style="display:block">報名後由主辦幹部核准才算數；核准前不佔名額、不用繳費</span></span><input type="checkbox" name="require_approval" ${d.require_approval ? 'checked' : ''}><i></i></label>
        <label class="switch" data-when="!survey"><span>通知報名者<span class="tiny" style="display:block">報名成功、排入候補、確認收款時推播給本人；審核結果一律會通知</span></span><input type="checkbox" name="notify_signup" ${d.notify_signup ? 'checked' : ''}><i></i></label>
        ${id && d.cancelled ? `<label class="switch"><span>恢復這場活動<span class="tiny" style="display:block">這場已取消；打開後儲存會重新開放</span></span><input type="checkbox" name="reopen" ${qp.get('reopen') === '1' ? 'checked' : ''}><i></i></label>` : ''}
        ${allow('settings') ? '<a class="tiny" href="#/admin/settings/signup">預設值在後台「活動報名預設」設定 ›</a>' : ''}
      </fieldset>
      ${id ? ((d.series || []).length > 1 ? `<p class="tiny" style="margin:0">這是定期揪跑的其中一場，這裡只會改這一場。</p>` : '') : `<details class="group" data-when="!survey" id="repBox">
        <summary>重複（定期揪跑）</summary>
        <fieldset class="qset"><legend>每週的哪幾天</legend><div class="chips">${['日', '一', '二', '三', '四', '五', '六'].map((w, i) => `<label class="chip"><input type="checkbox" name="rep_wd" value="${i}"><span>週${w}</span></label>`).join('')}</div></fieldset>
        <div class="grid2"><label>到哪一天為止<input type="date" name="rep_until"></label>
          <label class="inline" style="align-self:end"><input type="checkbox" name="rep_skip" checked> 遇到國定假日不開</label></div>
        <p class="tiny" style="margin:0" id="repHint">每一場都是獨立的活動，各自報名與點名；最多一次建立 60 場。</p>
      </details>`}

      <fieldset class="group">
        <legend>組別與價格</legend>
        <p class="tiny" style="margin:0">例如 全馬 1200、半馬 1000、10K 800。有設定的話，報名時要選一組，統計頁會算好應收金額。</p>
        <div id="optRows" class="qedit">${(d.options || []).map(optRow).join('')}</div>
        <button type="button" class="btn ghost sm" id="addOpt">${IC.plus}新增一組</button>
        <label class="switch"><span>由幹部代為團體報名<span class="tiny" style="display:block">報名的人要先填好賽事報名資料並同意提供，幹部再下載整理送出</span></span><input type="checkbox" name="group_reg" ${d.group_reg ? 'checked' : ''}><i></i></label>
      </fieldset>
      <details class="group" data-when="!survey" id="itemBox" ${(d.items || []).length || d.kind === 'buy' ? 'open' : ''}>
        <summary>加購與團購商品${(d.items || []).length ? `・${d.items.length} 項` : ''}</summary>
        <p class="tiny" style="margin:0">團服、毛巾、號碼布扣…報名時一起訂。尺寸用逗號分隔；有庫存就填，賣完會自動擋下。類型選「團購」時，報名的人至少要選一項。</p>
        <div id="itemRows" class="qedit">${(d.items || []).map(itemRow).join('')}</div>
        <button type="button" class="btn ghost sm" id="addItem">${IC.plus}新增商品</button>
        <label>成團門檻（選填）<input type="number" name="min_qty" min="1" max="99999" inputmode="numeric" value="${d.min_qty || ''}" placeholder="例如 20 件以上才下單"></label>
      </details>
      <details class="group" data-when="!survey" ${d.fee || d.pricing || d.payInfo ? 'open' : ''}>
        <summary>費用與收款</summary>
        <label>報名費（元，沒有分組別時使用）<input type="number" name="fee" min="0" value="${d.fee ?? ''}" placeholder="0"></label>
        <div class="grid3">
          <label>早鳥截止日<input type="date" name="early_until" value="${esc(d.pricing?.early_until || '')}"></label>
          <label>早鳥折扣（元）<input type="number" name="early_off" min="0" inputmode="numeric" value="${d.pricing?.early_off || ''}"></label>
          <label>協會會員折扣（元）<input type="number" name="member_off" min="0" inputmode="numeric" value="${d.pricing?.member_off || ''}"></label>
        </div>
        <p class="tiny" style="margin:0">優惠只折報名費，不折加購商品；早鳥看第一次報名的日期。</p>
        <label>收款帳戶<textarea name="pay_account" maxlength="200" placeholder="銀行名稱與代碼、帳號、戶名">${esc(d.payInfo?.account || '')}</textarea></label>
        <label>繳費期限<input type="date" name="pay_due" value="${esc(d.payInfo?.due || '')}"></label>
          <fieldset class="qset"><legend>收款方式</legend><div class="chips">${Object.entries(PAY_METHOD).map(([k, v]) => `<label class="chip"><input type="checkbox" name="pay_methods" value="${k}" ${(d.payInfo?.methods || ['transfer']).includes(k) ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></fieldset>
        <label>繳費說明（選填）<input name="pay_note" maxlength="200" value="${esc(d.payInfo?.note || '')}" placeholder="例如：轉帳後在 App 回報後五碼"></label>
        <p class="tiny" style="margin:0">App 只做紀錄與對帳，不經手金流。團員回報後五碼，你在統計頁確認收款。</p>
      </details>
      <fieldset class="group">
        <legend>報名問卷</legend>
        <p class="tiny" style="margin:0">想知道大家的尺寸、交通方式、要不要參加慶功宴…都可以加題目。報名時一起填，統計頁會自動算好。</p>
        <div id="qRows" class="qedit">${(d.questions || []).map(qRow).join('')}</div>
        <div class="row" style="gap:8px">
          <button type="button" class="btn ghost sm" data-addq="single">${IC.plus}單選</button>
          <button type="button" class="btn ghost sm" data-addq="multi">${IC.plus}複選</button>
          <button type="button" class="btn ghost sm" data-addq="text">${IC.plus}簡答</button>
        </div>
      </fieldset>

      <details class="group" data-when="!survey" ${d.week_no || d.plan_text || d.link_url ? 'open' : ''}>
        <summary>課表與外部連結</summary>
        <label>課表週次<input type="number" name="week_no" min="1" max="21" value="${d.week_no || ''}" placeholder="自動帶課表"></label>
        <div class="grid2">
          <label>外部報名連結<input name="link_url" type="url" value="${esc(d.link_url || '')}" placeholder="https://forms.gle/…"></label>
          <label>按鈕文字<input name="link_label" maxlength="12" value="${esc(d.link_label || '')}" placeholder="索票登記"></label>
        </div>
        <label>自填課表（沒填週次時使用）<textarea name="plan_text" placeholder="S：…">${esc(d.plan_text || '')}</textarea></label>
      </details>
      <label>說明與注意事項<textarea name="note" placeholder="攜帶瑜珈墊、水、彈力帶、毛巾">${esc(d.note || '')}</textarea></label>
      ${id ? '' : '<label class="inline"><input type="checkbox" name="notify" checked> 建立後通知（選了分團就只通知那個分團；邀請制只通知受邀的人）</label>'}
      <div class="grid2 formactions"><a class="btn ghost block" href="${id ? `#/e/${esc(id)}` : '#/'}">取消</a><button class="btn block">${id ? '儲存' : '建立'}</button></div>
    </form>
  </section>`;
  const f = $('#ef');
  // 報名期間：日期、集合時間、類型改了，沒手動改過的欄位（data-auto=1）依預設重算；說明即時更新
  const evOf = () => ({ date: f.date.value, gather_time: f.gather_time.value, kind: f.kind.value });
  function recalcWindow(force = false) {
    const autoS = f.signup_start.dataset.auto === '1', autoE = f.deadline.dataset.auto === '1';
    if ((autoS || autoE) && f.date.value) {
      const w = defaultWindow(evOf(), signupDefaults(), nowTp());
      if (autoS) f.signup_start.value = w.start;
      if (autoE) f.deadline.value = w.end;
      winNotes = w.notes;
    } else if (force) winNotes = [];
    winHint();
  }
  function winHint() {
    const box = $('#winHint'); if (!box) return;
    const start = f.signup_start.value, end = f.deadline.value, survey = f.kind.value === 'survey';
    const approval = !survey && f.require_approval.checked, signed = (d.signups || []).length + (d.pendingCount || 0);
    const parts = [`${survey ? '回覆期間' : '報名期間'}：${start ? tpText(start) : id ? '立即開放' : '建立後立即開放'} → ${f.date.value ? tpText(end || evStart(evOf())) : '—'} 截止${end ? '' : survey ? '（截止日當天）' : '（活動開始）'}${approval ? '・需要審核' : ''}`, ...winNotes];
    if (id && end && end <= nowTp()) parts.push('儲存後立即截止');
    if (id && signed && start && start > nowTp() && start > (d.signup_start || '')) parts.push('有人報名後再延後開始，已報名的人不受影響');
    if (id && !d.require_approval && approval) parts.push('開啟後只有新的報名需要審核，已報名的人不受影響');
    if (approval && f.visibility.value === 'invite') parts.push('邀請制已經限制誰能報名，通常不需要再審核');
    box.textContent = parts.join('。');
  }
  for (const k of ['signup_start', 'deadline']) f[k].addEventListener('input', () => { f[k].dataset.auto = '0'; winNotes = []; winHint(); });
  for (const k of ['date', 'gather_time', 'kind']) f[k].addEventListener('change', () => recalcWindow());
  f.require_approval.addEventListener('change', () => { f.require_approval.dataset.touched = '1'; winHint(); });
  // 切換成邀請制：審核沒被手動動過就自動取消（邀請制已經限制誰能報名）
  for (const r of f.querySelectorAll('[name=visibility]')) r.addEventListener('change', () => {
    if (f.visibility.value === 'invite' && !f.require_approval.dataset.touched) f.require_approval.checked = false;
    winHint();
  });
  // 新增活動時自動暫存一般欄位（例如先去地圖新增地點再回來，不用重填）；建立成功就清掉
  if (!id && !from) {
    const keyOf = (el) => el.name + (el.type === 'checkbox' || el.type === 'radio' ? `=${el.value}` : '');
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null');
      if (d) {
        for (const el of f.elements) { if (!el.name || !(keyOf(el) in d)) continue; if (el.type === 'checkbox' || el.type === 'radio') el.checked = d[keyOf(el)]; else el.value = d[keyOf(el)]; }
        // 報名時間：草稿帶回來的值當成手動填的；已經過去的改用預設重算
        let stale = false;
        for (const k of ['signup_start', 'deadline']) {
          if (f[k].value && f[k].value <= nowTp()) { stale = true; f[k].dataset.auto = '1'; }
          else f[k].dataset.auto = f[k].value ? '0' : '1';
        }
        if (stale) recalcWindow(true);
        f.insertAdjacentHTML('afterbegin', `<p class="notice row spread" style="margin:0" id="draftNote"><span>${stale ? '草稿的報名時間已過，已重新套用預設。' : ''}已帶回剛才填到一半的內容</span><button type="button" class="btn ghost sm" id="draftClear">清除重填</button></p>`);
        $('#draftClear').onclick = () => { try { sessionStorage.removeItem(DRAFT); } catch {} formView(); };
      }
    } catch {}
    f.addEventListener('input', () => {
      const o = {};
      for (const el of f.elements) if (el.name && el.type !== 'file') o[keyOf(el)] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
      try { sessionStorage.setItem(DRAFT, JSON.stringify(o)); } catch {}
    });
  }
  // 依類型顯示欄位：data-when="party"、"survey"、"!survey"
  const sync = () => {
    for (const el of f.querySelectorAll('[data-when]')) {
      const w = el.dataset.when, neg = w.startsWith('!'), k = w.replace('!', '');
      el.hidden = neg ? f.kind.value === k : f.kind.value !== k;
    }
  };
  f.kind.onchange = sync; sync(); winHint();
  bindAddrField(f, 'address', f.address.value || d.address, f.address.value && f.address.value !== d.address ? '' : d.address_zip);
  const visHint = () => { $('#visHint').textContent = f.visibility.value === 'invite'
    ? '只有受邀的人看得到，不會出現在其他人的列表，也不會通知其他人。建立後在活動頁邀請人或開邀請連結。'
    : '選了分團就是分團的人看得到（私密分團只有團員），沒選就是全協會。'; };
  for (const r of f.querySelectorAll('[name=visibility]')) r.onchange = visHint;
  visHint();
  const bindQ = () => { for (const b of f.querySelectorAll('[data-rmq]')) b.onclick = () => b.closest('.qrow').remove(); };
  const bindO = () => { for (const b of f.querySelectorAll('[data-rmo]')) b.onclick = () => b.closest('.optrow').remove(); };
  bindO();
  const bindI = () => { for (const b of f.querySelectorAll('[data-rmi]')) b.onclick = () => b.closest('.itemrow').remove(); };
  bindI();
  const addItem = (focus) => { $('#itemRows').insertAdjacentHTML('beforeend', itemRow()); bindI(); if (focus) $('#itemRows').lastElementChild.querySelector('input').focus(); };
  $('#addItem').onclick = () => addItem(true);
  f.spot_id.addEventListener('change', () => { const sp = spots.find((x) => x.id === f.spot_id.value); if (sp && (!f.place.value || spots.some((x) => x.name === f.place.value))) f.place.value = sp.name; });
  f.kind.addEventListener('change', () => { if (f.kind.value === 'buy') { $('#itemBox').open = true; if (!f.querySelector('.itemrow')) addItem(false); } });
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
    if (f.rep_until && f.querySelector('[name=rep_wd]:checked') && !f.rep_until.value) return toast('定期揪跑要填結束日期');
    const bad = questions.find((q) => q.type !== 'text' && !q.options.length);
    if (bad) return toast(`「${bad.label}」要有選項`);
    const body = {
      kind: f.kind.value, team_id: f.team_id.value || null, title: f.title.value, date: f.date.value, gather_time: f.gather_time.value,
      place: f.place.value, address: f.address.value.trim(), lead: f.lead.value, note: f.note.value, plan_text: f.plan_text.value,
      link_url: f.link_url.value, link_label: f.link_label.value, deadline: f.deadline.value, signup_start: f.signup_start.value,
      require_approval: f.kind.value !== 'survey' && f.require_approval.checked, notify_signup: f.notify_signup.checked, reopen: f.reopen?.checked || undefined,
      week_no: num(f.week_no), capacity: num(f.capacity), fee: num(f.fee), guest_max: num(f.guest_max), meal_options: f.meal_options.value,
      signup_open: f.signup_open.checked, questions, visibility: f.visibility.value, group_reg: f.group_reg.checked,
      options: [...f.querySelectorAll('.optrow')].map((r) => ({ name: r.querySelector('[data-k=name]').value.trim(), price: Number(r.querySelector('[data-k=price]').value) || 0 })).filter((o) => o.name),
      items: [...f.querySelectorAll('.itemrow')].map((r) => { const v = (k) => r.querySelector(`[data-k=${k}]`).value.trim();
        return { id: r.dataset.id || undefined, name: v('name'), price: Number(v('price')) || 0, sizes: v('sizes'), stock: v('stock') ? Number(v('stock')) : null, max: v('max') ? Number(v('max')) : 10 }; }).filter((x) => x.name),
      min_qty: num(f.min_qty), spot_id: f.spot_id.value || null, route_id: f.route_id.value || null,
      pricing: { early_until: f.early_until.value, early_off: Number(f.early_off.value) || 0, member_off: Number(f.member_off.value) || 0 },
      pay_info: { account: f.pay_account.value.trim(), due: f.pay_due.value, note: f.pay_note.value.trim(), methods: [...f.querySelectorAll('[name=pay_methods]:checked')].map((c) => c.value) },
      notify: f.notify ? f.notify.checked : undefined, copy_from: from || undefined,
      repeat: f.rep_until && [...f.querySelectorAll('[name=rep_wd]:checked')].length ? { weekdays: [...f.querySelectorAll('[name=rep_wd]:checked')].map((c) => Number(c.value)), until: f.rep_until.value, skip_holidays: f.rep_skip.checked } : undefined,
    };
    // 報名期間先在前端檢查一次（伺服器還會再檢查）
    const werr = windowError(body, { now: nowTp(), create: !id });
    if (werr) return toast(werr);
    if (id) {
      if (body.deadline && body.deadline <= nowTp() && body.deadline !== d.deadline && !confirm('儲存後立即截止報名，確定嗎？')) return;
      const n = (d.signups || []).filter((x) => x.status === 'in').length;
      if (body.capacity && body.capacity < n && body.capacity !== d.capacity
        && !confirm(`目前正取 ${n} 人已超過新的上限。已報名的人不會被取消，有人取消也不會遞補，直到人數低於上限。確定嗎？`)) return;
      const admitAsk = (k) => confirm(`還有 ${k} 筆待審核，關閉審核會依報名順序直接錄取（額滿排候補）並通知他們。確定嗎？`);
      if (d.require_approval && !body.require_approval && d.pendingCount > 0) { if (!admitAsk(d.pendingCount)) return; body.pending_action = 'admit'; }
      try {
        try { await api(`/events/${id}`, { method: 'PUT', body }); }
        catch (err) {
          // 編輯期間又有人送出申請：伺服器要求確認，走同一個確認流程再送一次
          const k = (err.message.match(/還有 (\d+) 筆待審核/) || [])[1];
          if (!k || body.pending_action || !admitAsk(k)) throw err;
          await api(`/events/${id}`, { method: 'PUT', body: { ...body, pending_action: 'admit' } });
        }
        location.hash = `#/e/${id}`; toast('已儲存');
      } catch (err) { toast(err.message); }
      return;
    }
    try {
      const r = await api('/events', { method: 'POST', body });
      try { sessionStorage.removeItem(DRAFT); } catch {}
      location.hash = `#/e/${r.id}`;
      // 建好後告訴幹部發生了什麼、下一步做什麼
      const opens = body.signup_start && body.signup_start > nowTp() ? `，${tpShort(body.signup_start)} 開放報名` : '';
      toast(r.invite ? `已建立邀請制活動${opens}，下一步：在活動頁邀請人或開邀請連結` : `已建立${r.count > 1 ? ` ${r.count} 場定期揪跑` : ''}${r.notified ? `，已通知 ${r.notified} 人` : ''}${opens}`);
    } catch (err) { toast(err.message); }
  };
}
const optRow = (o = {}) => `<div class="optrow"><input data-k="name" maxlength="20" placeholder="組別，例如 全馬" aria-label="組別名稱" value="${esc(o.name || '')}">
  <input data-k="price" type="number" min="0" max="100000" inputmode="numeric" placeholder="價格" aria-label="價格（元）" value="${o.price ?? ''}"><button type="button" class="iconx rm" data-rmo aria-label="移除">${IC.minus}</button></div>`;
// 網路銀行入帳明細：各家格式不同，只取「正的金額」與「明細裡 4 位以上的數字（取後五碼）」，日期有就帶上
const readText = async (f) => { const buf = await f.arrayBuffer(); try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('big5').decode(buf); } };
function parseBank(text) {
  const lines = text.split(/\r?\n/).map((l) => l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, '').trim()));
  const head = lines.findIndex((r) => r.some((c) => /存入|轉入|入帳|收入|金額|Deposit|Credit/i.test(c)));
  const cols = head >= 0 ? lines[head] : [];
  const amtIdx = cols.findIndex((c) => /存入|轉入|入帳|收入|Deposit|Credit/i.test(c));
  const amountCol = amtIdx >= 0 ? amtIdx : cols.findIndex((c) => /金額/.test(c));
  const out = [];
  for (const r of lines.slice(head + 1)) {
    const num = (c) => Number(String(c || '').replace(/[,\s$NT]/g, ''));
    const amount = amountCol >= 0 ? num(r[amountCol]) : Math.max(...r.map(num).filter((x) => Number.isFinite(x) && x > 0 && x < 1e6));
    if (!(amount > 0)) continue;
    const refs = [...new Set(r.filter((_, i) => i !== amountCol).join(' ').match(/\d{4,}/g) || [])].map((d) => d.slice(-5)).filter((d) => d.length >= 4);
    const date = (r.join(' ').match(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/) || []).slice(1).map((x) => x.padStart(2, '0')).join('-');
    if (refs.length) out.push({ amount: Math.round(amount), refs: refs.slice(0, 10), date });
  }
  return out.slice(0, 2000);
}
const money2 = (n) => `NT$${Number(n || 0).toLocaleString('zh-TW')}`;
// 訂購明細：一項一段，最後由呼叫的地方用「・」接起來（不會在行尾留下孤單的「・」）
const itemText = (items, defs) => (items || []).map((x) => { const d = (defs || []).find((y) => y.id === x.id); return d ? `${d.name}${x.size ? ` ${x.size}` : ''}×${x.qty}` : ''; }).filter(Boolean);
const PAY_METHOD = { transfer: '銀行轉帳', cash: '現金', linepay: 'LINE Pay' };
// 商品列：名稱拿整行（右邊是移除），下面兩行是 單價｜尺寸、庫存｜每人上限
const itemRow = (it = {}) => `<div class="itemrow" data-id="${esc(it.id || '')}">
  <div class="itemhead"><input data-k="name" maxlength="30" placeholder="商品，例如 團服" aria-label="商品名稱" value="${esc(it.name || '')}"><button type="button" class="iconx rm" data-rmi aria-label="移除">${IC.minus}</button></div>
  <input data-k="price" type="number" min="0" max="100000" inputmode="numeric" placeholder="單價" aria-label="單價（元）" value="${it.price ?? ''}">
  <input data-k="sizes" maxlength="80" placeholder="尺寸 S,M,L" aria-label="尺寸（逗號分隔，沒有就空白）" value="${esc((it.sizes || []).join(','))}">
  <input data-k="stock" type="number" min="1" inputmode="numeric" placeholder="庫存（不限）" aria-label="庫存" value="${it.stock ?? ''}">
  <input data-k="max" type="number" min="1" max="99" inputmode="numeric" placeholder="每人上限 10" aria-label="每人上限" value="${it.max && it.max !== 10 ? it.max : ''}"></div>`;
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
// 名單篩選：預設「全部」＝正取、候補、待審核
const FILTERS = [['all', '全部'], ['in', '正取'], ['wait', '候補'], ['pending', '待審核'], ['rejected', '未通過'], ['cancel', '已取消']];
async function statsView(id) {
  const st = await api(`/events/${id}/stats`);
  const t = st.total, survey = st.kind === 'survey';
  // 篩選的初始值從網址的 ?f= 自己解析（router 會把 query 拿掉）
  const f0 = new URLSearchParams(location.hash.split('?')[1] || '').get('f');
  let filt = st.canReview && FILTERS.some(([k]) => k === f0) ? f0 : 'all';
  const inFilter = (status, k) => (k === 'all' ? ['in', 'wait', 'pending'].includes(status) : status === k);
  const countOf = (k) => st.people.filter((x) => inFilter(x.status, k)).length;
  const STATUS_PILL = { wait: '<span class="pill wait">候補</span>', pending: '<span class="pill wait">待審核</span>', rejected: '<span class="pill no">未通過</span>', cancel: '<span class="pill">已取消</span>' };
  const off = isOffline() ? 'disabled' : '';
  // 已繳費後取消、婉拒或移出的人（待退費）也要能改繳費狀態，主辦才能標記已退費、結掉待辦
  const prow = (x) => { const live = x.status === 'in', refund = !live && ['paid', 'refunded'].includes(x.paid);
    return `<div class="r prow ${st.canReview ? 'rv' : ''} ${x.payReported && x.paid !== 'paid' ? 'reported' : ''}" data-st="${x.status}" data-mid="${esc(x.member_id)}" data-name="${esc(`${x.name} ${x.nickname || ''}`)}">
      ${st.canReview ? `<label class="selhit"><input type="checkbox" class="sel" data-sel aria-label="選取 ${esc(x.name)}" ${off}></label>` : ''}
      ${live && st.kind !== 'party' ? `<label class="attend" title="出席"><input type="checkbox" data-att="${esc(x.member_id)}" aria-label="出席：${esc(x.name)}" ${x.attended ? 'checked' : ''}><i>${IC.check}</i></label>` : '<span aria-hidden="true"></span>'}
      <span><b><span translate="no">${esc(x.name)}</span></b>${x.nickname ? ` <span class="tiny"><span translate="no">${esc(x.nickname)}</span></span>` : ''}${x.amount ? ` <span class="num tiny">${money2(x.amount)}</span>` : ''} ${STATUS_PILL[x.status] || ''}
        <span class="tiny" style="display:block">${[x.option && esc(x.option), ...itemText(x.items, st.items).map(esc), st.groupReg && (x.regOk ? '報名資料 OK' : '報名資料未提供'), x.guests && `攜伴 ${x.guests}`, x.paid_note && `<span translate="no">${esc(x.paid_note)}</span>`].filter(Boolean).join('・')}</span>
        ${st.canReview ? `<span class="tiny" style="display:block">${ago(x.created_at)}報名${x.reviewedAt ? `・<span translate="no">${esc(x.reviewerName || '')}</span> ${x.status === 'rejected' ? '婉拒' : x.review === 'approved' ? '核准' : '處理'}・${ago(x.reviewedAt)}` : ''}${x.edited ? '・核准後有修改' : ''}${st.groupReg && !x.regComplete ? '・報名資料不完整' : ''}</span>` : ''}
        ${x.note ? `<span class="tiny" style="display:block">備註：<span translate="no">${esc(x.note)}</span></span>` : ''}
        ${x.status === 'rejected' && x.reviewNote ? `<span class="tiny" style="display:block">原因：<span translate="no">${esc(x.reviewNote)}</span></span>` : ''}
        ${live && x.payReported && x.paid !== 'paid' ? `<span class="payrep">${PAY_METHOD[x.payMethod] || '已回報'}${x.payRef ? ` 後五碼 <b class="num"><span translate="no">${esc(x.payRef)}</span></b>` : ''}・${ago(x.payReported)} <button type="button" class="btn sm" data-confirm="${esc(x.member_id)}">確認收款</button></span>` : ''}
        ${(st.items || []).length && live ? `<label class="inline picked"><input type="checkbox" data-pick="${esc(x.member_id)}" ${x.picked ? 'checked' : ''}> 已領取</label>` : ''}
        ${st.canReview ? `<span class="row rvbtns" style="gap:6px">${x.status === 'pending' ? `<button type="button" class="btn sm" data-rv="approve" ${off}>核准</button><button type="button" class="btn ghost sm" data-rv="reject" ${off}>婉拒</button>`
          : x.status === 'in' || x.status === 'wait' ? `<button type="button" class="btn ghost sm" data-rv="revoke" ${off}>移出名單</button>`
          : x.status === 'rejected' ? `<button type="button" class="btn ghost sm" data-rv="reopen" ${off}>重新審核</button>` : ''}</span>` : ''}</span>
      ${money && (live || refund) ? `<select data-pay="${esc(x.member_id)}" aria-label="繳費狀態" class="paysel ${x.paid}">${Object.entries(PAID_NAME).map(([k, v]) => `<option value="${k}" ${x.paid === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : '<span></span>'}
    </div>`; };
  const kpi = [[survey ? '回覆' : '正取', t.in], ...(survey ? [] : [['候補', t.wait]]),
    ...(st.canReview && (t.pending || st.requireApproval) ? [['待審核', `${t.pending}${t.pendingGuests ? `＋攜伴 ${t.pendingGuests}` : ''}`]] : []),
    ...(t.rejected ? [['未通過', t.rejected]] : []), ['已取消', t.cancel],
    ...(st.kind === 'party' ? [['攜伴', t.guests], ['已報到', `${t.checkedIn}/${t.in}`]] : survey ? [] : st.kind === 'buy' ? [['已領取', `${st.picked}/${t.in}`]] : [['出席', `${t.attended}/${t.in}`]]), ['協會會員數', t.members]];
  const money = st.money, nf = (n) => n.toLocaleString('zh-TW');
  view.innerHTML = `
    ${largeTitle('統計', `<span translate="no">${esc(st.title)}</span>・${dstr(st.date)}`)}
    <section class="kpis">${kpi.map(([k, v]) => `<div class="card kpi"><span class="tiny">${k}</span><b class="num">${v}</b></div>`).join('')}</section>
    ${st.capacity ? `<section class="card"><div class="row spread"><h2 class="h3">名額</h2><span class="tiny num">${t.in}/${st.capacity}・剩 ${st.seatsLeft} 名額</span></div>
      <span class="bar big"><i style="width:${Math.min(100, Math.round(t.in / st.capacity * 100))}%"></i></span>
      ${t.pending && st.seatsLeft ? `<p class="tiny" style="margin:0">尚有 ${st.seatsLeft} 個名額可核准</p>` : ''}</section>` : ''}
    ${st.payDuePassed && t.pending ? '<p class="notice">繳費期限已過，核准的人可能來不及繳費，請另外告知期限</p>' : ''}
    ${money ? `<section class="card"><div class="row spread"><h2 class="h3">收款</h2>${money.payInfo?.due ? `<span class="tiny">繳費期限 ${esc(money.payInfo.due)}</span>` : ''}</div>
      <div class="moneygrid">
        <div><span class="tiny">應收</span><b class="num">${money2(money.expected)}</b></div>
        <div class="ok"><span class="tiny">已收</span><b class="num">${money2(money.collected)}</b></div>
        <div class="wait"><span class="tiny">已回報待確認</span><b class="num">${money2(money.reported)}</b><span class="tiny">${money.reportedN} 筆</span></div>
        <div class="due"><span class="tiny">還沒收</span><b class="num">${money2(Math.max(0, money.expected - money.collected - money.reported))}</b></div>
      </div>
      <span class="bar big"><i style="width:${money.expected ? Math.round(money.collected / money.expected * 100) : 0}%"></i></span>
      <div class="lstats">${Object.entries(PAID_NAME).map(([k, v]) => `<span>${v} <b class="num">${money.counts[k] || 0}</b></span>`).join('')}</div>
      <div class="row" style="gap:8px">${money.reportedN ? '<button type="button" class="btn ghost sm" id="showReported">只看待確認的</button>' : ''}
        <label class="btn ghost sm filebtn">匯入銀行明細對帳<input type="file" accept=".csv,text/csv,.txt" id="bankCsv" hidden></label></div>
      <div id="reconOut"></div>
      <p class="tiny" style="margin:0">從網路銀行下載入帳明細（CSV），系統用「金額＋轉帳後五碼」比對團員回報的資料，先預覽再確認標記已繳。檔案只在你的手機裡讀取，只送出金額與數字。</p></section>` : ''}
    ${(st.items || []).length ? `<section class="card"><div class="row spread"><h2 class="h3">團購數量</h2>${st.minQty ? `<span class="tiny">成團門檻 ${st.minQty} 件</span>` : ''}</div>
      ${st.minQty ? (() => { const sum = st.items.reduce((n, i) => n + i.total, 0); return `<div class="row spread"><span>${sum >= st.minQty ? `${IC.check} 已成團` : `還差 ${st.minQty - sum} 件成團`}</span><span class="tiny num">${sum}/${st.minQty}</span></div>
        <span class="bar big"><i style="width:${Math.min(100, Math.round(sum / st.minQty * 100))}%"></i></span>`; })() : ''}
      <div class="itemtable">${st.items.map((i) => `<div class="itr"><b><span translate="no">${esc(i.name)}</span></b><span class="tiny">${money2(i.price)}${i.stock ? `・庫存 ${i.stock}，剩 ${Math.max(0, i.stock - i.total)}` : ''}</span>
        <span class="sizes">${Object.entries(i.by).map(([z, n]) => `<span class="pill">${z === '—' ? '數量' : esc(z)} <b class="num">${n}</b></span>`).join('') || '<span class="tiny">還沒有人訂</span>'}</span><b class="num">${i.total}</b></div>`).join('')}</div>
      <div class="row"><a class="btn ghost sm" href="/api/events/${id}/orders.csv" download>下載訂購單</a><span class="tiny">已領取 ${st.picked}/${t.in}</span></div>
      <details class="group"><summary>到貨與領取</summary>
        <form id="arrForm" class="row" style="gap:8px"><input name="note" maxlength="120" placeholder="領取地點與時間，例如 週四團練現場 19:00" aria-label="領取地點與時間" style="flex:1;min-width:200px"><button class="btn sm">通知到貨</button></form>
        <p class="tiny" style="margin:0">通知後，每位訂購的人會有自己的領取 QR；現場用下面的按鈕掃描就會記錄已領取。</p>
        <button class="btn ghost sm iconbtn" id="pickScan" type="button">${IC.check}掃描領取 QR</button>
      </details></section>` : ''}
    ${st.groupReg ? `<section class="card"><div class="row spread"><h2 class="h3">團體報名資料</h2><span class="tiny">${st.regReady}/${t.in} 人已同意提供</span></div>
      <span class="bar big"><i style="width:${t.in ? Math.round(st.regReady / t.in * 100) : 0}%"></i></span>
      <button class="btn ghost sm" id="regCsv">下載團體報名資料（含身分證字號）</button>
      <p class="tiny" style="margin:0">只包含已同意提供的人。檔案含身分證字號等個資，送出報名後請立刻刪除，下載紀錄會寫進稽核。</p></section>` : ''}
    <div class="statgrid">
      ${st.byOption ? `<section class="card"><h2 class="h3">報名組別</h2>${bars(Object.entries(st.byOption), t.in, true)}</section>` : ''}
      <section class="card"><h2 class="h3">各分團</h2>${bars(st.byTeam.map((x) => [x.k, x.n]).sort((a, b) => b[1] - a[1]), t.in, true)}
        <p class="tiny" style="margin:0">同時在兩個分團的人，兩邊都會算到。</p></section>
      ${st.byMeal ? `<section class="card"><h2 class="h3">餐點</h2>${bars(Object.entries(st.byMeal), t.in, true)}</section>` : ''}
      ${survey ? '' : `<section class="card"><h2 class="h3">組別</h2>${bars(Object.entries(st.byGroup).sort(), t.in)}</section>`}
      <section class="card"><h2 class="h3">每天新增${survey ? '回覆' : '報名'}</h2>${bars(st.byDay.slice(-14).map(([d, n]) => [d.slice(5).replace('-', '/'), n]))}</section>
    </div>
    ${st.questions.map((q) => `<section class="card">
      <div class="row spread"><h2 class="h3"><span translate="no">${esc(q.label)}</span></h2><span class="tiny">${Q_TYPE_NAME[q.type]}${q.type === 'text' ? `・${q.answers.length} 則` : `・${q.answered}/${t.in} 人回答`}</span></div>
      ${q.type === 'text'
        ? `<div class="answers">${q.answers.map((a) => `<div><b><span translate="no">${esc(a.name)}</span></b><span>${esc(a.text)}</span></div>`).join('') || '<p class="muted" style="margin:0">還沒有回答</p>'}</div>`
        : bars(q.counts.map((c) => [c.o, c.n]), q.answered, true)}
    </section>`).join('')}
    ${survey ? '' : `<section class="card">
      <div class="row spread"><h2 class="h3">名單</h2><span class="tiny" id="pcount">${st.people.length} 人</span></div>
      ${st.canReview ? `<div class="chips" role="group" aria-label="名單篩選">${FILTERS.map(([k, v]) => `<button type="button" class="chip" data-f="${k}" aria-pressed="${k === filt}">${v} <span class="num">${countOf(k)}</span></button>`).join('')}</div>` : ''}
      <input id="pq" placeholder="搜尋姓名" aria-label="搜尋名單" autocomplete="off">
      <div class="roster" id="plist">${st.people.map(prow).join('')}</div>
      <p class="tiny" style="margin:0">${st.kind === 'party' ? '出席以入場券報到為準' : st.canReview ? '方框是整批審核的選取；圓圈是點名出席' : '左邊圓圈是點名出席'}${money ? '；右邊切換繳費狀態，只做紀錄，不串金流' : ''}。點名、繳費、領取只適用正取；已繳費後取消或移出的人，可在右邊改成已退費。</p>
      ${st.canReview ? `<div class="rvbar" role="toolbar" aria-label="整批審核" hidden><span id="selN" aria-live="polite"></span>
        <button type="button" class="btn sm" data-bulk="approve">核准</button><button type="button" class="btn ghost sm" data-bulk="reject">婉拒</button>
        <button type="button" class="btn ghost sm" data-bulk="clear">取消選取</button></div>
        <div class="row" id="allPendingRow" hidden><button type="button" class="btn sm" id="approveAll"></button></div>` : ''}
    </section>`}
    <section class="card">
      <h2 class="h3">匯出</h2>
      <p class="tiny" style="margin:0">Excel 可以直接開啟的 CSV，含每個人的問卷回答${allow('members') && me.role !== 'supervisor' ? '與電話' : ''}。匯出會留下稽核紀錄，檔案請妥善保管、用完刪除。</p>
      <div class="row"><a class="btn ghost sm" href="/api/events/${id}/export.csv" download>下載 CSV</a>
        <button class="btn ghost sm" id="copyRoster2">複製名單（貼 LINE）</button></div>
    </section>`;
  $('#copyRoster2').onclick = async () => { try { copy((await api(`/events/${id}/roster`)).text); } catch (e) { toast(e.message); } };
  // 搜尋與篩選同時生效；被藏起來的列取消勾選，整批操作列跟著更新（不會默默少處理幾筆）
  let repaint = null;
  const applyFilter = () => {
    const q = ($('#pq')?.value || '').trim(); let n = 0;
    for (const r of document.querySelectorAll('.prow')) {
      r.hidden = (!!q && !r.dataset.name.includes(q)) || (st.canReview && !inFilter(r.dataset.st, filt)); if (!r.hidden) n++;
      const c = r.hidden && r.querySelector('[data-sel]'); if (c) c.checked = false;
    }
    repaint?.();
    if ($('#pcount')) $('#pcount').textContent = `${n} 人`;
    const pend = st.people.filter((x) => x.status === 'pending').length;
    if ($('#allPendingRow')) { $('#allPendingRow').hidden = !(filt === 'pending' && pend); $('#approveAll').textContent = `全部核准（${pend}）`; }
  };
  $('#pq')?.addEventListener('input', applyFilter);
  for (const c of document.querySelectorAll('[data-f]')) c.onclick = () => {
    filt = c.dataset.f;
    for (const x of document.querySelectorAll('[data-f]')) x.setAttribute('aria-pressed', String(x === c));
    history.replaceState(null, '', `#/e/${id}/stats${filt === 'all' ? '' : `?f=${filt}`}`);
    applyFilter();
  };
  applyFilter();
  if (st.canReview) repaint = bindReview(id, st);
  for (const c of document.querySelectorAll('[data-att]')) c.onchange = async () => {
    try { await api(`/events/${id}/attendance`, { method: 'POST', body: { member_id: c.dataset.att, present: c.checked } }); } catch (e) { c.checked = !c.checked; toast(e.message); }
  };
  for (const b of document.querySelectorAll('[data-confirm]')) b.onclick = async () => {
    b.disabled = true;
    try { await api(`/events/${id}/payments`, { method: 'POST', body: { member_ids: [b.dataset.confirm], paid: 'paid' } }); toast('已確認收款'); statsView(id); }
    catch (e) { b.disabled = false; toast(e.message); }
  };
  for (const c of document.querySelectorAll('[data-pick]')) c.onchange = async () => {
    try { await api(`/events/${id}/pickup`, { method: 'POST', body: { member_id: c.dataset.pick, picked: c.checked } }); toast(c.checked ? '已標記領取' : '已取消領取'); }
    catch (e) { c.checked = !c.checked; toast(e.message); }
  };
  $('#regCsv')?.addEventListener('click', () => downloadAuthed(`/api/events/${id}/registrations.csv`, `${st.title}-團體報名資料.csv`).catch((e) => toast(e.message)));
  $('#arrForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm('通知所有訂購的人到貨了？')) return;
    try { const r = await api(`/events/${id}/arrived`, { method: 'POST', body: { note: e.target.note.value.trim() } }); toast(`已通知 ${r.count} 人`); } catch (err) { toast(err.message); }
  });
  $('#pickScan')?.addEventListener('click', () => scanSheet({ title: '掃描領取 QR', hint: '把團員的領取 QR 對準框內', placeholder: '或輸入 6 碼領取代碼',
    onCode: async (code) => { const r = await api(`/events/${id}/pickup`, { method: 'POST', body: { code: code.toUpperCase() } }); return `${r.already ? '已經領過：' : '領取完成：'}${r.name}・${(r.items || []).map((x) => `${(st.items.find((d) => d.id === x.id) || {}).name || ''}${x.size ? ` ${x.size}` : ''}×${x.qty}`).join('、')}`; } }));
  $('#bankCsv')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rows = parseBank(await readText(f));
    if (!rows.length) return toast('讀不到入帳資料，請確認是網路銀行的入帳明細 CSV');
    const show = async (apply) => {
      const r = await api(`/events/${id}/reconcile`, { method: 'POST', body: { rows, apply } });
      $('#reconOut').innerHTML = `<div class="notice" style="margin:0;display:grid;gap:8px">
        <b>${apply ? `已標記 ${r.matched.length} 筆為已繳` : `讀到 ${rows.length} 筆入帳，對上 ${r.matched.length} 筆`}</b>
        ${r.matched.length ? `<span class="tiny">${r.matched.map((m) => `<span translate="no">${esc(m.name)}</span> ${money2(m.amount)}`).join('、')}</span>` : ''}
        ${r.unpaid.length ? `<span class="tiny">還沒對上：${r.unpaid.map((u) => `<span translate="no">${esc(u.name)}</span> ${money2(u.amount)}${u.pay_ref ? `（後五碼 ${esc(u.pay_ref)}）` : '（沒回報）'}`).join('、')}</span>` : ''}
        ${!apply && r.matched.length ? '<button class="btn sm" id="reconApply">確認，標記為已繳</button>' : ''}</div>`;
      $('#reconApply')?.addEventListener('click', async () => { await show(true); setTimeout(() => statsView(id), 1200); });
    };
    try { await show(false); } catch (err) { toast(err.message); }
    e.target.value = '';
  });
  $('#showReported')?.addEventListener('click', () => { for (const r of document.querySelectorAll('.prow')) r.hidden = !r.classList.contains('reported'); $('#plist').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  // 改繳費狀態：失敗就退回原本的選項；成功後重畫（收款金額跟著更新），保留捲動位置
  for (const sel of document.querySelectorAll('[data-pay]')) { sel.dataset.was = sel.value; sel.onchange = async () => {
    try { await api(`/events/${id}/payments`, { method: 'POST', body: { member_ids: [sel.dataset.pay], paid: sel.value } }); toast(`已標記為${PAID_NAME[sel.value]}`); const y = scrollY; await statsView(id); scrollTo(0, y); }
    catch (e) { sel.value = sel.dataset.was; toast(e.message); }
  }; }
}

// 統計頁的審核：單筆按鈕、勾選整批、全部核准；送出期間按鈕停用，失敗還原
function bindReview(id, st) {
  const bar = document.querySelector('.rvbar');
  const picked = () => [...document.querySelectorAll('.prow:not([hidden]) [data-sel]:checked')].map((c) => c.closest('.prow'));
  const paintBar = () => { const n = picked().length; bar.hidden = !n; $('#selN').textContent = `已選 ${n} 筆`; };
  for (const c of document.querySelectorAll('[data-sel]')) c.onchange = paintBar;
  const nameOf = (mid) => st.people.find((x) => x.member_id === mid)?.name || '';
  const send = async (btns, action, rows) => {
    const ids = rows.map((r) => r.dataset.mid);
    if (!ids.length) return;
    let body = { action, member_ids: ids };
    if (action === 'approve') {
      const free = st.seatsLeft, n = ids.length;
      if (free != null && n > free && !confirm(`只剩 ${free} 個名額，核准後依報名先後排正取，其餘 ${n - free} 人排候補。確定？`)) return;
    }
    if (action === 'reject' || action === 'revoke') {
      const listed = rows.filter((r) => r.dataset.st === 'in' || r.dataset.st === 'wait');
      const paidN = listed.filter((r) => st.people.find((x) => x.member_id === r.dataset.mid)?.paid === 'paid').length;
      // 姓名是團員自己填的：交給 askReason 當純文字顯示（不翻譯），說明句各自是一整句，方便翻譯
      const r = await askReason(listed.length ? '移出名單' : '婉拒報名', {
        who: ids.length === 1 ? nameOf(ids[0]) : '', lines: [ids.length === 1 ? '' : `已選 ${ids.length} 人`,
          listed.length ? '移出後，空出的名額會由候補遞補。' : '婉拒後會通知本人。', paidN ? `其中 ${paidN} 人已繳費，會標記待退費。` : ''],
        chips: ['名額已滿', '資格不符', '資料不完整', '其他'], ok: listed.length ? '移出名單' : '婉拒' });
      if (!r) return;
      body = { action: 'reject', member_ids: ids, note: r.note, revoke: listed.length > 0 };
    }
    const all = [...btns, ...document.querySelectorAll('[data-rv], [data-bulk], #approveAll')];
    const was = all.map((b) => b.disabled);
    all.forEach((b) => { b.disabled = true; });
    try {
      // 人多時伺服器分段處理（apiAll 會接著送剩下的人）
      const out = await apiAll(`/events/${id}/review`, { method: 'POST', body });
      // 名字用 keep() 標成不翻譯：英文模式只翻固定的字，不會因為名字是中文就整句保留中文
      const skipped = [out.skipped.length ? [`，${out.skipped.length} 筆沒處理：`, names(out.skipped, '、', (x) => [keep(x.name), `（${x.reason}）`])] : '', out.more ? `，還有 ${out.more.member_ids.length} 人沒處理完，請再按一次` : ''];
      if (action === 'approve') toast(rich(`已核准 ${out.in.length + out.wait.length} 人（正取 ${out.in.length}、候補 ${out.wait.length}）`, skipped, out.notes.length ? ['。', names(out.notes, '、', (x) => { const q = /^「(.+)」(.*)$/.exec(x.reason); return [keep(x.name), ...(q ? ['：「', keep(q[1]), `」${q[2]}`] : [`：${x.reason}`])]; })] : ''));
      else if (action === 'reopen') toast(rich(`已重新審核 ${out.reopened.length} 人`, skipped));
      else if (body.revoke) toast(rich(`已移出 ${out.rejected.length} 人`, out.refund.length ? ['，待退費：', names(out.refund)] : '', skipped));
      else toast(rich(`已婉拒 ${out.rejected.length} 人`, skipped));
      const y = scrollY; await statsView(id); scrollTo(0, y);
    } catch (e) { all.forEach((b, i) => { if (b.isConnected) b.disabled = was[i]; }); toast(e.message); }
  };
  for (const b of document.querySelectorAll('[data-rv]')) b.onclick = () => send([b], b.dataset.rv, [b.closest('.prow')]);
  for (const b of document.querySelectorAll('[data-bulk]')) b.onclick = () => {
    if (b.dataset.bulk === 'clear') { for (const c of document.querySelectorAll('[data-sel]')) c.checked = false; paintBar(); return; }
    const rows = picked();
    if (b.dataset.bulk === 'approve') {
      const ok = rows.filter((r) => r.dataset.st === 'pending');
      if (ok.length < rows.length) toast('只有待審核的報名可以核准，其他的略過');
      send([b], 'approve', ok);
    } else send([b], 'reject', rows.filter((r) => ['pending', 'in', 'wait'].includes(r.dataset.st)));
  };
  $('#approveAll')?.addEventListener('click', (e) => send([e.currentTarget], 'approve', [...document.querySelectorAll('.prow[data-st=pending]')]));
  if (isOffline()) for (const b of document.querySelectorAll('[data-bulk], #approveAll')) b.disabled = true;
  return paintBar;
}

export { formView, statsView };
