// 耕跑團 PWA — teams.js：從 app.js 拆出來、用到才載入的畫面（第一次開 App 不用下載）
import { $, ago, allow, api, avatar, emptyState, esc, eventCard, largeTitle, me, refreshMe, row, squareIcon, TEAM_ROLE_NAME, teamAllow, teamIcon, teamOf, teams, toast, view } from './app.js';

// ---------- 分團 ----------
const POLICY_NAME = { open: '直接加入', approve: '需團長或幹部審核' };
async function teamsView() {
  await refreshMe();
  const list = teams();
  view.innerHTML = `
    ${largeTitle('分團', '主團由管理員設定；想加入其他分團，申請後由該團幹部核准')}
    <div class="teamgrid">${list.map((t) => `<a class="card lit teamcard" href="#/t/${esc(t.id)}" style="--tc:${esc(t.color)}">
      <span class="dot" aria-hidden="true"></span>
      <span class="row spread"><span class="row" style="gap:10px">${teamIcon(t, 'md')}<b><span translate="no">${esc(t.name)}</span></b></span>${t.id === me.main_team ? '<span class="pill solid">我的主團</span>' : t.my_status === 'active' ? `<span class="pill solid">${esc(t.my_title || TEAM_ROLE_NAME[t.my_role])}</span>` : t.my_status === 'pending' ? '<span class="pill wait">申請中</span>' : t.private ? '<span class="pill">私密</span>' : ''}</span>
      ${t.intro ? `<span class="tiny"><span translate="no">${esc(t.intro)}</span></span>` : ''}
      <span class="row spread"><span class="tiny num">${t.count} 人</span><span class="tiny">${t.leaders.filter((l) => l.role === 'lead').map((l) => `團長 <span translate="no">${esc(l.nickname || l.name)}</span>`).join('、')}</span></span>
    </a>`).join('') || `<div class="card">${emptyState('runner', '還沒有分團')}</div>`}</div>
    ${allow('settings') ? '<a class="tiny center" href="#/admin?tab=teams" style="padding:6px">管理分團 ›</a>' : ''}`;
}
async function teamView(tid, q = '') {
  await refreshMe();
  const t = teamOf(tid);
  if (!t) { view.innerHTML = `<div class="card">${emptyState('runner', '找不到這個分團')}</div>`; return; }
  const inTeam = t.my_status === 'active', manage = teamAllow(tid, 'roster');
  const [{ events }, roster] = await Promise.all([api('/events'), manage ? api(`/teams/${tid}/members?q=${encodeURIComponent(q)}`) : null]);
  const evs = events.filter((e) => e.team_id === tid);
  const canEdit = allow('settings') || teamAllow(tid, 'appoint');
  view.innerHTML = `
    <section class="card hero teamhero" style="--tc:${esc(t.color)}">
      <div class="row spread"><span class="pill" style="background:rgba(255,255,255,.2);color:#fff">${t.private ? '私密分團' : '分團'}・${t.count} 人</span>
        ${inTeam ? `<span class="pill" style="background:#fff;color:${esc(t.color)}">${esc(t.my_title || TEAM_ROLE_NAME[t.my_role])}</span>` : ''}</div>
      <div class="row" style="gap:14px">${teamIcon(t, 'lg')}<h2 style="margin:0"><span translate="no">${esc(t.name)}</span></h2></div>
      ${t.intro ? `<p class="muted" style="margin:0;white-space:pre-wrap"><span translate="no">${esc(t.intro)}</span></p>` : ''}
      <div class="leaders">${t.leaders.map((l) => `<span class="ldr">${avatar(l)}<span><b><span translate="no">${esc(l.nickname || l.name)}</span></b><span class="tiny"><span translate="no">${esc(l.title || TEAM_ROLE_NAME[l.role])}</span></span></span></span>`).join('')}</div>
      <div class="row">
        ${inTeam ? (t.line_url ? `<a class="btn line sm" href="${esc(t.line_url)}" target="_blank" rel="noopener">加入 LINE 群組</a>` : '')
          : t.my_status === 'pending' ? '<span class="pill" style="background:rgba(255,255,255,.2);color:#fff">已申請，等幹部核准</span>'
          : `<button class="btn sm" id="joinTeam" style="background:#fff;color:${esc(t.color)}">申請加入</button>`}
        ${(inTeam && t.id !== me.main_team && t.my_role !== 'lead') || t.my_status === 'pending' ? `<button class="btn sm glassbtn" id="leaveTeam">${inTeam ? '退出' : '取消申請'}</button>` : ''}
      </div>
      ${t.self_managed ? `<p class="tiny" style="margin:0"><span translate="no">${esc(t.name)}</span>的成員由<span translate="no">${esc(t.name)}</span>的團長與幹部處理。</p>` : ''}
    </section>

    <div class="section-h"><h2>分團活動</h2>${teamAllow(tid, 'event') ? `<a class="btn ghost sm" href="#/new?team=${esc(tid)}">＋ 新增</a>` : ''}</div>
    <div class="evgrid">${evs.map(eventCard).join('') || `<div class="card">${emptyState('calendar', '近期沒有分團活動')}</div>`}</div>

    ${canEdit ? `<section class="card">
      <h3>分團資料</h3>
      <form id="teamEdit">
        ${allow('settings') ? `<div class="grid2"><label>名稱<input name="name" maxlength="20" value="${esc(t.name)}" required></label>
          <label>顏色<input name="color" type="color" value="${esc(t.color)}"></label></div>` : ''}
        <div class="iconedit">${teamIcon(t, 'lg')}<div class="row" style="gap:8px">
          <label class="btn ghost sm filebtn">換分團圖示<input type="file" accept="image/png,image/jpeg,image/webp" id="iconIn" hidden></label>
          ${t.icon?.startsWith('/api/') ? '<button type="button" class="btn ghost sm" id="iconRm">改回預設</button>' : ''}</div>
          <span class="tiny">正方形圖，會自動縮成小圖。生圖指令見 docs/team-icons-prompt.md。</span></div>
        <label>介紹<textarea name="intro" maxlength="300" placeholder="練什麼、什麼時候練、適合誰">${esc(t.intro)}</textarea></label>
        <label>LINE 群組邀請連結<input name="line_url" type="url" value="${esc(t.line_url)}" placeholder="https://line.me/ti/g/…"></label>
        ${allow('settings') ? `<label>排序<input name="sort" type="number" min="0" max="99" value="${t.sort}"></label>
          <label class="switch"><span>私密分團（活動與 LINE 連結只給團員看）</span><input type="checkbox" name="private" ${t.private ? 'checked' : ''}><i></i></label>
          <label class="switch"><span>只由本團幹部管理成員<span class="tiny" style="display:block">例如公司團：協會幹部不能代為加入、核准或設成主團</span></span><input type="checkbox" name="self_managed" ${t.self_managed ? 'checked' : ''}><i></i></label>` : ''}
        <div class="row"><button class="btn sm">儲存</button>${allow('settings') ? '<button type="button" class="btn danger sm" id="delTeam">刪除分團</button>' : ''}</div>
      </form>
      ${allow('settings') ? '' : '<p class="tiny" style="margin:0">名稱、顏色與加入方式由行政人員設定。</p>'}
    </section>` : ''}

    <div class="statgrid">
    ${!t.private || inTeam || manage ? `<section class="card" id="boardCard"><div class="row spread"><h3>公告欄</h3>
      ${teamAllow(tid, 'event') ? '<button class="btn ghost sm" id="newPost">發公告</button>' : ''}</div><div id="board" class="board"><p class="muted" style="margin:0">載入中…</p></div></section>` : ''}
    ${inTeam || manage ? `<section class="card"><div class="row spread"><h3>里程排行榜</h3>
      <div class="seg" style="width:auto"><button data-lb="week" aria-pressed="true">本週</button><button data-lb="month" aria-pressed="false">本月</button></div></div>
      <div id="lb" class="roster"></div>
      <p class="tiny" style="margin:0" id="lbHint"></p></section>` : ''}
    </div>
    <a class="card" href="#/plan/new?team=${esc(tid)}" ${teamAllow(tid, 'appoint') ? '' : 'hidden'}><div class="row spread"><h3>發布分團課表</h3><span class="tiny">團長 ›</span></div></a>
    ${manage ? teamRosterCard(t, roster, q) : ''}`;
  loadBoard(t); if (inTeam || manage) loadBoardRank(tid, 'week');

  $('#joinTeam')?.addEventListener('click', async () => {
    try { await api(`/teams/${tid}/join`, { method: 'POST' }); toast('已送出申請，等幹部核准'); teamView(tid); } catch (e) { toast(e.message); }
  });
  $('#leaveTeam')?.addEventListener('click', async () => {
    if (!confirm(`確定${inTeam ? '退出' : '取消申請'}${t.name}？`)) return;
    try { await api(`/teams/${tid}/leave`, { method: 'POST' }); toast(inTeam ? '已退出' : '已取消申請'); teamView(tid); } catch (e) { toast(e.message); }
  });
  $('#teamEdit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { intro: f.intro.value, line_url: f.line_url.value.trim(),
      ...(f.name ? { name: f.name.value, color: f.color.value, join_policy: 'approve', private: f.private.checked, self_managed: f.self_managed.checked, sort: Number(f.sort.value) || 0 } : {}) };
    try { await api(`/teams/${tid}`, { method: 'PUT', body }); toast('已儲存'); teamView(tid); } catch (err) { toast(err.message); }
  });
  $('#iconIn')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { await api(`/teams/${tid}/icon`, { method: 'PUT', body: { icon: await squareIcon(file) } }); toast('已更新分團圖示'); teamView(tid); }
    catch (err) { toast(err.message || '這張圖讀不出來'); }
  });
  $('#iconRm')?.addEventListener('click', async () => {
    try { await api(`/teams/${tid}/icon`, { method: 'PUT', body: { icon: null } }); toast('已移除'); teamView(tid); } catch (err) { toast(err.message); }
  });
  $('#delTeam')?.addEventListener('click', async () => {
    if (!confirm(`刪除「${t.name}」？分團的活動會改成全協會活動，成員名單會清除。`)) return;
    try { await api(`/teams/${tid}`, { method: 'DELETE' }); toast('已刪除'); location.hash = '#/teams'; } catch (e) { toast(e.message); }
  });
  if (manage) bindTeamRoster(t, roster, q);
}
const teamMemberRow = (r) => (m) => `<div class="r">${avatar(m)}
    <span><b><span translate="no">${esc(m.name)}</span></b>${m.nickname ? ` <span class="tiny"><span translate="no">${esc(m.nickname)}</span></span>` : ''}
      <span class="tiny" style="display:block"><span translate="no">${esc(m.title || TEAM_ROLE_NAME[m.role])}</span>・${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)} 組${m.membership === 'active' ? '・協會會員' : ''}</span></span>
    ${m.status === 'pending'
      ? (r.can.approve ? `<span class="row" style="gap:6px"><button class="btn sm" data-tm="approve" data-id="${m.id}">通過</button><button class="btn ghost sm" data-tm="remove" data-id="${m.id}">婉拒</button></span>` : '')
      : (r.can.appoint && (m.role !== 'lead' || r.can.lead)) || (r.can.approve && m.role === 'member')
        ? `<button class="btn ghost sm" data-tmrole="${m.id}" data-name="${esc(m.name)}" data-role="${m.role}" data-title="${esc(m.title || '')}">管理</button>` : ''}
  </div>`;
// 分團公告欄：置頂在前，一次 20 則
async function loadBoard(t) {
  const box = $('#board'); if (!box) return;
  const { posts, canPost } = await api(`/teams/${t.id}/posts`).catch(() => ({ posts: [] }));
  box.innerHTML = posts.map((p) => `<article class="post ${p.pinned ? 'pinned' : ''}">
    <div class="row spread"><b>${p.pinned ? '<span class="pill">置頂</span> ' : ''}<span translate="no">${esc(p.title)}</span></b>
      ${p.author_id === me.id || teamAllow(t.id, 'appoint') ? `<button class="btn ghost sm" data-delpost="${p.id}" aria-label="刪除公告">刪除</button>` : ''}</div>
    ${p.body ? `<p style="margin:0;white-space:pre-wrap"><span translate="no">${esc(p.body)}</span></p>` : ''}
    <span class="tiny">${esc(p.author_name || '')}・${ago(p.created_at)}</span></article>`).join('') || '<p class="muted" style="margin:0">還沒有公告</p>';
  for (const b of box.querySelectorAll('[data-delpost]')) b.onclick = async () => {
    if (!confirm('刪除這則公告？')) return;
    try { await api(`/teams/${t.id}/posts/${b.dataset.delpost}`, { method: 'DELETE' }); loadBoard(t); } catch (e) { toast(e.message); }
  };
  $('#newPost')?.addEventListener('click', () => {
    if ($('#postForm')) return;
    box.insertAdjacentHTML('beforebegin', `<form id="postForm" class="filters">
      <input name="title" maxlength="60" placeholder="標題" required>
      <textarea name="body" maxlength="3000" placeholder="內容（選填）"></textarea>
      <label class="inline"><input type="checkbox" name="pinned"> 置頂</label>
      <label class="inline"><input type="checkbox" name="notify" checked> 通知分團成員</label>
      <div class="row"><button class="btn sm">發布</button><button type="button" class="btn ghost sm" id="postX">取消</button></div></form>`);
    $('#postX').onclick = () => $('#postForm').remove();
    $('#postForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api(`/teams/${t.id}/posts`, { method: 'POST', body: { title: f.title.value, body: f.body.value, pinned: f.pinned.checked, notify: f.notify.checked } });
        f.remove(); toast('已發布'); loadBoard(t); } catch (err) { toast(err.message); }
    };
  }, { once: true });
  void canPost;
}
async function loadBoardRank(tid, period) {
  const box = $('#lb'); if (!box) return;
  for (const b of document.querySelectorAll('[data-lb]')) { b.setAttribute('aria-pressed', String(b.dataset.lb === period)); b.onclick = () => loadBoardRank(tid, b.dataset.lb); }
  try {
    const r = await api(`/teams/${tid}/leaderboard?period=${period}`);
    box.innerHTML = r.rows.map((x, i) => `<div class="r rank"><span class="no num">${i + 1}</span>${avatar(x)}<span><span translate="no">${esc(x.nickname || x.name)}</span><span class="tiny" style="display:block">${x.n} 次</span></span><b class="num">${x.km} km</b></div>`).join('')
      || '<p class="muted" style="margin:0">還沒有人上榜</p>';
    $('#lbHint').textContent = r.me ? '你有出現在排行榜上，可以在「我的 → 隱私」關掉。' : '排行榜只顯示自己同意上榜的人；想參加到「我的 → 隱私」打開。';
  } catch (e) { box.innerHTML = `<p class="muted" style="margin:0">${esc(e.message)}</p>`; }
}
function teamRosterCard(t, r, q) {
  const pending = r.pending, active = r.members, row = teamMemberRow(r);
  return `
    ${pending.length ? `<section class="card"><h3>待審核（${pending.length}）</h3><div class="roster">${pending.map(row).join('')}</div></section>` : ''}
    <section class="card">
      <div class="row spread"><h3>分團名冊</h3><span class="tiny">${q ? `符合 ${r.total} 人` : `${r.total} 人`}</span></div>
      <form id="tmq" class="row" style="gap:8px" role="search"><input name="q" value="${esc(q)}" placeholder="搜尋姓名或暱稱" aria-label="搜尋分團名冊" style="flex:1" autocomplete="off"><button class="btn ghost sm">搜尋</button></form>
      <div class="roster" id="tmList">${active.map(row).join('') || '<p class="muted" style="margin:0">沒有符合的團員</p>'}</div>
      ${r.next ? '<button class="btn ghost sm block" id="tmMore">載入更多</button>' : ''}
      <p class="tiny" style="margin:0">團長由理事長指派；團長可以指派分團幹部。分團名冊不顯示電話。</p>
    </section>
    ${r.can.add ? `<section class="card"><h3>把跑友加進<span translate="no">${esc(t.name)}</span></h3>
      <form id="tmAdd" class="row" style="gap:8px" role="search"><input name="q" placeholder="輸入姓名搜尋（至少 1 個字）" aria-label="搜尋要加入的跑友" style="flex:1" autocomplete="off"><button class="btn ghost sm">搜尋</button></form>
      <div id="tmAddList" class="roster"></div></section>` : ''}`;
}
function bindTeamRoster(t, r, q) {
  const act = async (body, msg) => { try { await api(`/teams/${t.id}/members`, { method: 'POST', body }); toast(msg); teamView(t.id, q); } catch (e) { toast(e.message); } };
  for (const b of document.querySelectorAll('[data-tm]')) b.onclick = () => act({ member_id: b.dataset.id, action: b.dataset.tm }, b.dataset.tm === 'approve' ? '已通過' : '已婉拒');
  $('#tmq').onsubmit = (e) => { e.preventDefault(); teamView(t.id, e.target.q.value.trim()); };
  // 分頁：一次 50 人，往下接
  $('#tmMore')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const more = await api(`/teams/${t.id}/members?q=${encodeURIComponent(q)}&after=${r.next}`);
      $('#tmList').insertAdjacentHTML('beforeend', more.members.map(teamMemberRow(r)).join(''));
      r.next = more.next; bindRoles();
      if (r.next) e.target.disabled = false; else e.target.remove();
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });
  const bindRoles = () => { for (const b of document.querySelectorAll('[data-tmrole]')) b.onclick = () => {
    $('#tmDlg')?.remove();
    const opts = Object.entries(TEAM_ROLE_NAME).filter(([k]) => k !== 'lead' || r.can.lead).filter(([k]) => r.can.appoint || k === 'member');
    b.closest('.r').insertAdjacentHTML('afterend', `<form class="card tight" id="tmDlg">
      <div class="grid2"><label>分團身分<select name="role">${opts.map(([k, v]) => `<option value="${k}" ${b.dataset.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>職稱（選填）<input name="title" maxlength="12" value="${esc(b.dataset.title || '')}" placeholder="副團長、活動組"></label></div>
      <div class="row"><button class="btn sm">儲存</button><button type="button" class="btn danger sm" id="tmRm">移出分團</button><button type="button" class="btn ghost sm" id="tmX">取消</button></div></form>`);
    $('#tmX').onclick = () => $('#tmDlg').remove();
    $('#tmRm').onclick = () => confirm(`把 ${b.dataset.name} 移出${t.name}？`) && act({ member_id: b.dataset.tmrole, action: 'remove' }, '已移出');
    $('#tmDlg').onsubmit = (e) => { e.preventDefault(); act({ member_id: b.dataset.tmrole, action: 'role', role: e.target.role.value, title: e.target.title.value }, '已更新'); };
  }; };
  bindRoles();
  $('#tmAdd')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const qq = e.target.q.value.trim();
    if (!qq) return toast('請輸入姓名');
    const { members } = await api(`/members?q=${encodeURIComponent(qq)}`);
    $('#tmAddList').innerHTML = members.map((m) => `<div class="r">${avatar(m)}<span><span translate="no">${esc(m.name)}</span>${m.nickname ? ` <span class="tiny"><span translate="no">${esc(m.nickname)}</span></span>` : ''}</span>
      ${m.teams.some((x) => x.t === t.id && x.s === 'active') ? '<span class="tiny">已在團內</span>' : `<button class="btn ghost sm" data-addm="${m.id}">加入</button>`}</div>`).join('') || '<p class="muted" style="margin:0">找不到</p>';
    for (const x of document.querySelectorAll('[data-addm]')) x.onclick = () => act({ member_id: x.dataset.addm, action: 'add' }, '已加入');
  });
}

export { teamView, teamsView };
