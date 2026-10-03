// 耕跑團 PWA — challenge.js：每月里程挑戰（用到才載入）
//   個人：這個月的里程、次數、每週有沒有練、徽章；分團：每人平均里程（不顯示個人）；排行：只列同意上排行榜的人
import { api, esc, IC, largeTitle, view } from './app.js';

const ic = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
// 徽章圖示：一律線條，跟系統圖示同一個風格
const ICON = {
  km50: ic('<circle cx="12" cy="12" r="8"/><path d="M9 12.5l2 2 4-4.5"/>'),
  km100: ic('<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z"/>'),
  km200: ic('<path d="M7 4h10v4a5 5 0 0 1-10 0Z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 3M17 6h2.5a2.5 2.5 0 0 1-2.6 3M12 13v4M8.5 20h7M10 17h4"/>'),
  km300: ic('<path d="M12 3l3 6 6 .9-4.5 4.3 1.1 6.3L12 17.6l-5.6 2.9 1.1-6.3L3 9.9 9 9Z"/><path d="M12 8.5v5"/>'),
  steady: ic('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M7.5 14.5l2 2 3.5-4"/>'),
  runs16: ic('<path d="M13 3 5 13.5h6L10 21l8-10.5h-6Z"/>'),
};
const shift = (mo, n) => { const d = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

async function challengeView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const d = await api(`/challenge${/^\d{4}-\d{2}$/.test(q.get('m') || '') ? `?month=${q.get('m')}` : ''}`);
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7), m = Number(d.month.slice(5));
  const next = [50, 100, 200, 300].find((x) => x > d.me.km);
  const maxTeam = Math.max(1, ...d.teams.map((t) => t.avg));
  view.innerHTML = `${largeTitle('里程挑戰', `${d.month.slice(0, 4)} 年 ${m} 月`)}
    <div class="row spread monthnav"><a class="btn ghost sm" href="#/challenge?m=${shift(d.month, -1)}" aria-label="上個月">‹</a>
      <span class="tiny">${d.month === now ? '這個月' : `${m} 月`}</span>
      ${d.month < now ? `<a class="btn ghost sm" href="#/challenge?m=${shift(d.month, 1)}" aria-label="下個月">›</a>` : '<span class="btn ghost sm" aria-hidden="true" style="visibility:hidden">›</span>'}</div>
    <section class="card chme">
      <div class="chring" style="--p:${Math.min(100, Math.round((d.me.km / (next || 300)) * 100))}"><b class="num">${d.me.km}</b><small>公里</small></div>
      <div class="chstats"><span><b class="num">${d.me.runs}</b> 次訓練</span>${d.me.rank ? `<span>排行第 <b class="num">${d.me.rank}</b></span>` : ''}
        <span class="tiny">${next ? `再 ${(next - d.me.km).toFixed(1)} 公里達到 ${next} 公里` : '已經達到最高的 300 公里'}</span>
        <div class="weeks" aria-label="每週有沒有練">${d.me.weeks.map((w, i) => `<i class="${w ? 'on' : ''}" title="第 ${i + 1} 週${w ? '有練' : '還沒練'}"></i>`).join('')}</div></div>
    </section>
    <section class="card"><h3>徽章</h3><div class="badges">${d.badges.map((b) => { const got = d.me.badges.includes(b.id);
      return `<div class="badge ${got ? 'got' : ''}"><span class="bi">${ICON[b.id] || ICON.km50}</span><b>${esc(b.name)}</b><span class="tiny">${esc(b.desc)}</span></div>`; }).join('')}</div></section>
    <section class="card"><div class="row spread"><h3>分團對抗</h3><span class="tiny">每人平均里程</span></div>
      <div class="teamrace">${d.teams.sort((a, b) => b.avg - a.avg).map((t, i) => `<div class="tr"><span class="num rk">${i + 1}</span><span class="nm"><span translate="no">${esc(t.name)}</span><span class="tiny"> ${t.members} 人・${t.active} 人有練</span></span>
        <span class="bar"><i style="width:${Math.round((t.avg / maxTeam) * 100)}%;background:${esc(t.color || 'var(--accent)')}"></i></span><b class="num">${t.avg}</b></div>`).join('') || '<p class="muted" style="margin:0">還沒有分團資料。</p>'}</div>
      <p class="tiny" style="margin:0">用全部團員的紀錄算平均，不顯示個人。月底自動結算，1 號早上推播結果。</p></section>
    <section class="card"><div class="row spread"><h3>排行榜</h3>${d.showRank ? '' : '<a class="tiny" href="#/me/privacy">我也要上榜 ›</a>'}</div>
      ${d.top.length ? `<ol class="toplist">${d.top.map((x) => `<li class="${x.me ? 'me' : ''}"><span translate="no">${esc(x.name)}</span><span class="tiny">${x.runs} 次</span><b class="num">${x.km}</b></li>`).join('')}</ol>`
        : '<p class="muted" style="margin:0">這個月還沒有人上榜。排行榜只列在「我的 → 隱私」同意上榜的人。</p>'}</section>
    <a class="btn block iconbtn" href="#/log">${IC.plus}記錄一次訓練</a>`;
}

export { challengeView };
