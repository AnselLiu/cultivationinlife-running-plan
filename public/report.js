// 耕跑團 PWA — report.js：從 app.js 拆出來、用到才載入的畫面（第一次開 App 不用下載）
import * as P from './plan.js';
import * as S from './studio.js';
import { $, allow, api, avatar, barChart, bindComments, dayLabel, dstr, esc, FEEL, fixText, group, largeTitle, LOG_STATUS_NAME, me, row, teamAllow, teams, view, ymd } from './app.js';

// ---------- 訓練報表：週里程、完成率、強度趨勢、個人最佳 ----------
// 圖表一律用 SVG 自己畫（不載外部套件），寬度跟著容器縮放
function lineChart(items, { h = 120, min = 1, max = 10 } = {}) {
  const pts = items.filter((x) => x.v != null);
  if (pts.length < 2) return '<p class="muted" style="margin:0">紀錄兩週以上才看得出趨勢</p>';
  const W = 600, pad = 24, step = (W - pad) / Math.max(1, items.length - 1), y = (v) => h - ((v - min) / (max - min)) * h * 0.9;
  const d = items.map((x, i) => (x.v == null ? null : `${pad + i * step},${y(x.v)}`)).filter(Boolean).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${h + 30}" role="img" aria-label="自覺強度趨勢">
    ${[4, 7].map((v) => `<line x1="${pad}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="0" y="${y(v) + 4}" class="axis">${v}</text>`).join('')}
    <polyline points="${d}" class="line"/>
    ${items.map((x, i) => (x.v == null ? '' : `<circle cx="${pad + i * step}" cy="${y(x.v)}" r="5" class="dot"><title>${esc(x.l)}：RPE ${x.v.toFixed(1)}</title></circle>`)).join('')}
  </svg>`;
}
const mondayOf = (ds) => { const d = new Date(`${ds}T00:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
// 個人最佳：距離落在區間內、用時最短的一筆
const PR_BUCKETS = [['5K', 4.9, 5.3], ['10K', 9.8, 10.5], ['半馬', 20.9, 21.6], ['全馬', 41.9, 42.8]];
async function reportView(range = '12w') {
  const days = { '12w': 84, '6m': 183, '1y': 365 }[range] || 84;
  const to = ymd(new Date()), from = ymd(new Date(Date.now() - (days - 1) * 864e5));
  const { logs } = await api(`/logs?from=${from}&to=${to}`);
  const runs = logs.filter((l) => l.status !== 'skip');
  // 每週
  const weeks = [];
  for (let d = new Date(`${mondayOf(from)}T00:00:00`); ymd(d) <= to; d.setDate(d.getDate() + 7)) weeks.push(ymd(d));
  const byWeek = Object.fromEntries(weeks.map((w) => [w, []]));
  for (const l of runs) (byWeek[mondayOf(l.date)] ||= []).push(l);
  const wkLabel = (w) => `${Number(w.slice(5, 7))}/${Number(w.slice(8))}`;
  const kmItems = weeks.map((w) => ({ l: wkLabel(w), v: Math.round(byWeek[w].reduce((n, l) => n + (l.km || 0), 0) * 10) / 10 }));
  const rpeItems = weeks.map((w) => { const r = byWeek[w].filter((l) => l.rpe); return { l: wkLabel(w), v: r.length ? r.reduce((n, l) => n + l.rpe, 0) / r.length : null }; });
  // 課表完成率（照課表週次）
  const planWeeks = [...new Set(logs.filter((l) => l.week_no).map((l) => l.week_no))].sort((a, b) => a - b);
  const done = [];
  for (const w of planWeeks) {
    const plan = (await P.weekPlan(w, me.dist, me.grp)) || [];
    const planned = plan.filter((d) => d.kind !== 'rest');
    const L = logs.filter((l) => l.week_no === w);
    const ok = planned.filter((d) => L.some((l) => l.plan_day === d.d && l.status === 'done')).length;
    const half = planned.filter((d) => !L.some((l) => l.plan_day === d.d && l.status === 'done') && L.some((l) => l.plan_day === d.d && l.status === 'partial')).length;
    done.push({ l: `W${w}`, v: planned.length ? Math.round((ok + half * 0.5) / planned.length * 100) : 0, c: '#34C759' });
  }
  // 每月
  const months = {};
  for (const l of runs) { const k = l.date.slice(0, 7); (months[k] ||= { km: 0, n: 0, sec: 0 }); months[k].km += l.km || 0; months[k].n += 1; months[k].sec += l.seconds || 0; }
  // 個人最佳（這段期間）
  const prs = PR_BUCKETS.map(([name, lo, hi]) => {
    const best = runs.filter((l) => l.km >= lo && l.km <= hi && l.seconds).sort((a, b) => a.seconds / a.km - b.seconds / b.km)[0];
    return { name, best };
  });
  const totalKm = runs.reduce((n, l) => n + (l.km || 0), 0), totalSec = runs.reduce((n, l) => n + (l.seconds || 0), 0);
  view.innerHTML = `
    ${largeTitle('訓練報表', `${from.slice(5).replace('-', '/')}–${to.slice(5).replace('-', '/')}`)}
    <div class="seg" role="group" aria-label="期間">${[['12w', '12 週'], ['6m', '6 個月'], ['1y', '1 年']].map(([k, v]) => `<button data-range="${k}" aria-pressed="${range === k}">${v}</button>`).join('')}</div>
    <section class="kpis">
      <div class="card kpi"><span class="tiny">總里程</span><b class="num">${totalKm.toFixed(1)}<small> km</small></b></div>
      <div class="card kpi"><span class="tiny">訓練次數</span><b class="num">${runs.length}</b></div>
      <div class="card kpi"><span class="tiny">總時間</span><b class="num">${S.fmtDuration(totalSec) || '0:00'}</b></div>
      <div class="card kpi"><span class="tiny">平均配速</span><b class="num">${totalKm && totalSec ? S.fmtPace(totalKm * 1000, totalSec) : '—'}</b></div>
    </section>
    <div class="statgrid">
    <section class="card"><h3>每週里程</h3>${barChart(kmItems, { unit: ' km' })}</section>
    ${done.length ? `<section class="card"><h3>課表完成率</h3>${barChart(done, { unit: '%', h: 120, max: 100 })}<p class="tiny" style="margin:0">完成算 1 堂、部分完成算半堂，休息日不算。</p></section>` : ''}
    <section class="card"><h3>自覺強度（RPE）</h3>${lineChart(rpeItems)}<p class="tiny" style="margin:0">一般來說，輕鬆跑 3–4、質量課 7–8；長期都在 7 以上要注意恢復。</p></section>
    <section class="card"><h3>個人最佳</h3><div class="prs">${prs.map((x) => `<div class="pr"><span class="tiny">${x.name}</span>
      ${x.best ? `<b class="num">${S.fmtDuration(Math.round(x.best.seconds / x.best.km * ({ '5K': 5, '10K': 10, 半馬: 21.0975, 全馬: 42.195 }[x.name])))}</b><span class="tiny">${esc(x.best.date)}・${S.fmtPace(x.best.km * 1000, x.best.seconds)}</span>` : '<b class="num muted">—</b>'}</div>`).join('')}</div>
      <p class="tiny" style="margin:0">依距離接近的紀錄換算，比賽成績以官方為準。</p></section>
    </div>
    <section class="card"><h3>每月</h3><div class="mtable">${Object.entries(months).sort().reverse().map(([k, m]) => `<div><span>${k.replace('-', ' 年 ')} 月</span><span class="num">${m.km.toFixed(1)} km</span><span class="num">${m.n} 次</span><span class="num">${S.fmtDuration(m.sec) || '—'}</span></div>`).join('') || '<p class="muted" style="margin:0">這段期間沒有紀錄</p>'}</div></section>`;
  for (const b of document.querySelectorAll('[data-range]')) b.onclick = () => reportView(b.dataset.range);
}

// 教練看單一團員的紀錄並留言（本人要有打開分享）
async function memberLogsView(mid) {
  const to = ymd(new Date()), from = ymd(new Date(Date.now() - 41 * 864e5));
  const r = await api(`/logs/member/${mid}?from=${from}&to=${to}`);
  const m = r.member;
  view.innerHTML = `${largeTitle(m.nickname || m.name, `${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)} 組・最近 6 週`)}
    <section class="card"><div class="roster">${r.logs.map((l) => `<div class="mlog">
      <div class="row spread"><b>${dstr(l.date)}${l.week_no ? ` <span class="tiny">W${l.week_no} ${esc(dayLabel(l.plan_day || ''))}</span>` : ''}</b>
        <span class="pill ${l.status === 'done' ? 'solid' : l.status === 'skip' ? '' : 'wait'}">${LOG_STATUS_NAME[l.status]}</span></div>
      ${l.plan_text ? `<span class="tiny">課表：<span translate="no">${esc(fixText(l.plan_text))}</span></span>` : ''}
      <span>${l.km ? `${l.km} km` : ''}${l.seconds ? `・${S.fmtDuration(l.seconds)}` : ''}${l.km && l.seconds ? `・${S.fmtPace(l.km * 1000, l.seconds)}` : ''}${l.hr ? `・心率 ${l.hr}` : ''}${l.rpe ? `・RPE ${l.rpe}` : ''}${l.feel ? `・${FEEL[l.feel]}` : ''}</span>
      <details data-cm="${l.id}"><summary class="tiny" style="cursor:pointer">回饋${l.comments ? `（${l.comments}）` : ''}</summary><div class="cmts"></div>
        <form class="row cmform" style="gap:8px"><input name="body" maxlength="500" placeholder="給這次訓練一點回饋" style="flex:1"><button class="btn sm">送出</button></form></details>
    </div>`).join('') || '<p class="muted" style="margin:0">這段期間沒有紀錄。</p>'}</div>
    <p class="tiny" style="margin:0">看不到團員的備註；你的回饋只有本人看得到，送出後會通知他。</p></section>`;
  bindComments();
}

// 教練與分團幹部：有開分享的團員，一週的完成次數與里程
async function logsTeamView(week, team) {
  week ||= P.currentWeek();
  const lead = teams().filter((t) => teamAllow(t.id, 'roster'));
  if (!allow('plan') && !team) team = lead[0]?.id || '';
  const s = P.weekStart(week), e = new Date(s.getTime() + 6 * 864e5);
  const r = await api(`/logs/team?from=${ymd(s)}&to=${ymd(e)}${team ? `&team=${team}` : ''}`);
  const days = await P.weekPlan(week, 'fm', 'D'), planned = (days || []).filter((d) => d.kind !== 'rest').length || 1;
  view.innerHTML = `
    ${largeTitle('團員訓練', `W${week}・${s.getMonth() + 1}/${s.getDate()}–${e.getMonth() + 1}/${e.getDate()}`)}
    <section class="card filters">
      <div class="row spread"><div class="row" style="gap:6px"><button class="btn ghost sm" id="wprev" ${week === 1 ? 'disabled' : ''}>‹</button><b>W${week}</b><button class="btn ghost sm" id="wnext" ${week === 21 ? 'disabled' : ''}>›</button></div>
        <select id="tsel" style="width:auto">${allow('plan') ? '<option value="">全部（有分享的人）</option>' : ''}${(allow('plan') ? teams() : lead).map((t) => `<option value="${esc(t.id)}" ${team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <p class="tiny" style="margin:0">只列出自己打開「分享給教練」的團員，看不到備註。完成率以每週 ${planned} 堂課計算。</p>
    </section>
    <section class="card"><div class="roster">${r.members.map((m) => {
      const p = Math.min(100, Math.round(((m.done || 0) + (m.partial || 0) * 0.5) / planned * 100));
      return `<a class="r tlog" href="#/logs/m/${esc(m.id)}">${avatar(m)}<span><b><span translate="no">${esc(m.nickname || m.name)}</span></b> <span class="tiny">${m.dist === 'hm' ? '半馬' : '全馬'} ${esc(m.grp)}</span>
        <span class="bar"><i style="width:${p}%"></i></span></span>
        <span class="num tiny" style="text-align:right"><b>${p}%</b><br>${m.km || 0} km${m.rpe ? `・RPE ${m.rpe}` : ''}</span></a>`; }).join('') || '<p class="muted" style="margin:0">這週還沒有分享的紀錄。</p>'}</div></section>`;
  $('#wprev').onclick = () => logsTeamView(week - 1, team);
  $('#wnext').onclick = () => logsTeamView(week + 1, team);
  $('#tsel').onchange = (ev) => logsTeamView(week, ev.target.value);
}

export { logsTeamView, memberLogsView, reportView };
