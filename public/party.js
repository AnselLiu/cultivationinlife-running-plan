// 春酒：座位查詢、座位圖、抽獎舞台
// 座位圖佈局照現場平面圖：舞台在上、入口在下，右側 6/12/18/24 是靠牆單獨桌。
export const SEAT_ROWS = [
  [1, 2, 3, null, 4, 5, null],
  [7, 8, 9, null, 10, 11, 6],
  [13, 14, 15, null, 16, 17, 12],
  [19, 20, 21, null, 22, 23, 18],
  [25, null, 26, null, 27, 28, 24],
  [29, null, 30, null, 31, null, null],
];
export const CLUBS = ['耕跑團', '小耕跑', '耕跑核心團', '耕青團', '耕跑團購群', '台大EMBA', '台大EMBA(北大)',
  '小耕跑(北大)', '小蜜蜂智利桌', 'SUPERACE X 耕跑團', '永和慢跑團', '蘆洲慢跑委員會', '汐止慢跑社',
  '宜蘭饗食天團', 'STR運動癒防平台', '動感旅行社', '其他夥伴桌'];
export const STAGES = ['暖身', 'R1', 'R1(大)', 'R1中', 'R2', 'R2(大)', '加碼', '卓越(中)', '每桌', '志工獎'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- 座位查詢（團員）----
export function seatSection(seats, layout) {
  const seated = seats.filter((s) => s.table_no);
  if (!seated.length) return `<section class="card party">
    <h3>座位查詢</h3><p class="muted" style="margin:0">還沒有排桌，排好之後可以在這裡查自己的桌次。</p></section>`;
  const people = seated.length + seated.reduce((n, s) => n + (s.guests || 0), 0);
  return `<section class="card party" id="seatCard">
    <div class="row spread"><h3>座位查詢</h3><span class="tiny">${new Set(seated.map((s) => s.table_no)).size} 桌・${people} 人</span></div>
    <div class="seg" role="tablist">
      <button id="tabSearch" aria-pressed="true">搜尋</button>
      <button id="tabMap" aria-pressed="false">座位圖</button>
    </div>
    <div id="seatSearch">
      <input id="seatQ" placeholder="輸入姓名、暱稱或跑團" autocomplete="off" inputmode="search">
      <div id="seatResult" class="seatlist"></div>
    </div>
    <div id="seatMapWrap" hidden>${seatMap(seated, layout)}</div>
    <div id="tableDetail"></div>
  </section>`;
}
export function seatMap(seats, layout) {
  const rows = layout?.rows?.length ? layout.rows : SEAT_ROWS;
  const cols = Math.max(...rows.map((r) => r.length));
  const count = {};
  for (const s of seats) count[s.table_no] = (count[s.table_no] || 0) + 1 + (s.guests || 0);
  return `<div class="seatmap">
    <div class="stage">${esc(layout?.stage || '舞台')}</div>
    <div class="grid" style="grid-template-columns:repeat(${cols},1fr)">${rows.map((row) => row.map((t) => t
      ? `<button class="tbl" data-table="${t}"><b class="num">${t}</b><span class="num">${count[t] || 0}</span></button>`
      : '<span class="gap"></span>').join('')).join('')}</div>
    ${layout?.foot || !layout ? `<div class="ibm">${esc(layout?.foot || 'IBM 產品體驗區 ×7')}</div>` : ''}
    <div class="entry">${esc(layout?.entry || '↑ 入口')}</div>
  </div>`;
}
export function tableList(seats, table) {
  const list = seats.filter((s) => s.table_no === table);
  return `<div class="card tight tabledetail">
    <div class="row spread"><h3>第 ${table} 桌</h3><span class="tiny">${list.length} 位${list.some((s) => s.guests) ? `・含攜伴 ${list.reduce((n, s) => n + (s.guests || 0), 0)}` : ''}</span></div>
    <div class="seatlist">${list.map((s, i) => `
      <div class="seatrow"><span class="num tiny">${i + 1}</span>
        <span><b>${esc(s.name)}</b>${s.nickname ? ` <span class="tiny">${esc(s.nickname)}</span>` : ''}
          <span class="tiny" style="display:block">${esc(s.club || '')}${s.guests ? `・攜伴 ${s.guests}` : ''}${s.note ? `・${esc(s.note)}` : ''}</span></span>
      </div>`).join('')}</div>
  </div>`;
}
export function seatResults(seats, q) {
  const key = q.trim().toLowerCase();
  if (!key) return '<p class="tiny">輸入關鍵字就會即時顯示，點結果可以看整桌名單。</p>';
  const hit = seats.filter((s) => [s.name, s.nickname, s.club].some((v) => (v || '').toLowerCase().includes(key))).slice(0, 30);
  if (!hit.length) return '<p class="muted">找不到，換個關鍵字或問工作人員。</p>';
  return hit.map((s) => `<button class="seatrow hit" data-table="${s.table_no}">
      <span class="tblbadge num">${s.table_no}</span>
      <span><b>${esc(s.name)}</b>${s.nickname ? ` <span class="tiny">${esc(s.nickname)}</span>` : ''}
        <span class="tiny" style="display:block">${esc(s.club || '')}${s.note ? `・${esc(s.note)}` : ''}</span></span>
    </button>`).join('');
}

// ---- 抽獎舞台（投影用）----
export function stageHTML(prizes, draws) {
  const left = (p) => p.qty - draws.filter((d) => d.prize_id === p.id).length;
  const avail = prizes.filter((p) => left(p) > 0);
  return `<div class="lottery" id="lottery">
    <div class="lhead">
      <select id="lPrize">${prizes.map((p) => `<option value="${p.id}" ${left(p) ? '' : 'disabled'}>${p.stage ? `[${esc(p.stage)}] ` : ''}${esc(p.name)}（剩 ${left(p)}／${p.qty}）</option>`).join('')}</select>
      <label class="inline tiny"><input type="checkbox" id="lCheckedIn" checked> 只抽已報到</label>
      <label class="inline tiny"><input type="checkbox" id="lRepeat"> 允許重複中獎</label>
      <button class="btn ghost sm" id="lClose">離開</button>
    </div>
    <div class="lbody">
      <div class="lmain">
        <p class="lstage" id="lStage">${avail[0]?.stage ? `[${esc(avail[0].stage)}]` : '抽獎'}</p>
        <h2 class="lname" id="lName">準備開始</h2>
        <p class="lsub" id="lSub">按下按鈕抽出得獎者</p>
        <button class="btn lbtn" id="lGo">開始抽獎</button>
      </div>
      <aside class="lside">
        <div class="row spread"><b>得獎紀錄</b><button class="btn ghost sm" id="lCsv">匯出 CSV</button></div>
        <div id="lLog">${draws.slice().reverse().map((d) => `<div class="lrow"><span>${esc(d.name)}</span></div>`).join('')}</div>
      </aside>
    </div>
  </div>`;
}
// 老虎機：先快後慢，最後停在得獎者
export async function spin(nameEl, pool, winner) {
  const names = pool.length ? pool : [winner];
  let delay = 40;
  for (let i = 0; i < 28; i++) {
    nameEl.textContent = names[Math.floor(Math.random() * names.length)];
    await new Promise((r) => setTimeout(r, delay));
    delay *= 1.14;
  }
  nameEl.textContent = winner;
  nameEl.classList.remove('pop'); void nameEl.offsetWidth; nameEl.classList.add('pop');
}
