// 耕跑團 PWA — coach.js：課表教練（用到才載入，首頁不會下載）
//   coachView：課表的全季、賽事準備、配速與用語、課表設定（#/plan/season｜race｜guide｜setup）
//   課表頁畫好、閒下來才呼叫 weekExtras：課表用語可以點、每一列的「詳細內容」、全部展開、
//   每週天數與跑量的提醒、左右滑動換週、?hl=用語 標示本週用到的課
//   身體資料（年齡、安靜心率）只從這台裝置的 cil-coach 讀，不會送到伺服器
import { $, api, cfg, choose, coachPrefs, dayLabel, dstr, emptyState, esc, feat, fixText, group, IC, ic, largeTitle, me, MI, myCycle, paintCountdown, planSeg,
  raceTarget, refreshMe, render, row, setCoachPrefs, startKey, subTitle, toast, view } from './app.js';
import * as P from './plan.js';
import { ageGrade, createCoach, EST_LINE, fuelCalc, GL, GL_ORDER, hrCalc, lvl, parseGoal, std100, termSpans, termsIn, verdict, VOL, xdRows } from './coachcalc.js';

// 這個人的課表教練計算（組別、每週天數、身體資料、課表週期）
async function coachOf(cycle, venue) {
  const p = coachPrefs();
  return createCoach({ dist: me.dist, grp: me.grp, nickname: me.nickname || me.name, venue, prefs: p.plan, pb: p.pb, body: p.body,
    weeks: await P.weeks(), cycle: { kind: cycle.kind, anchor: cycle.anchor, name: cycle.name } });
}
// 課表文字裡的用語變成可以點的按鈕（MP、LT、ST、rpe…）；其餘文字照原樣
function termHTML(text) {
  let out = '', at = 0;
  for (const [a, b, k] of termSpans(text)) {
    out += esc(text.slice(at, a)) + `<button type="button" class="term" data-term="${k}" aria-haspopup="dialog">${esc(text.slice(a, b))}</button>`;
    at = b;
  }
  return out + esc(text.slice(at));
}
// 有設定過每週天數、週四團練或跑量才顯示提醒（預設值不提醒）
const prefsSet = (p) => Number(p.days) !== 6 || p.club === false || p.vol != null;

export async function weekExtras(root, { week, cycle, other, rows, venue = '', hl = null, wi }) {
  const coach = await coachOf(cycle, venue);
  const days = root.querySelector('.days');
  if (!days || !rows) return () => {};
  const personal = cycle.kind !== 'club';
  const today = P.iso(new Date());
  const rowOf = (el) => rows[Number(el.closest('[data-i]')?.dataset.i)];
  const termsOf = rows.map((r) => (P.isRaceDay(r, week) && personal ? [] : termsIn(fixText(r.t))));
  const off = [];   // 離開頁面時要拿掉的監聽
  const on = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); off.push(() => el.removeEventListener(type, fn, opt)); };

  // 1. 用語按鈕（個人週期的比賽那一列顯示比賽名稱，不加）
  for (const el of days.querySelectorAll('.day[data-i] .tx')) {
    const i = Number(el.closest('[data-i]').dataset.i), r = rows[i];
    if (!termsOf[i].length) continue;
    el.innerHTML = termHTML(fixText(r.t));
  }

  // 2. 詳細內容：第一次打開才算；有個人心率的地方一律標「估算」
  const fill = (det) => {
    if (det.dataset.filled) return;
    det.dataset.filled = '1';
    const r = rowOf(det), list = xdRows(coach, { ...r, race: P.isRaceDay(r, week) });
    det.querySelector('.xdb').innerHTML = `<dl>${list.map((x) => `<div><dt>${esc(x.label)}</dt><dd>${esc(x.value)}${x.est ? ' <span class="pill est">估算</span>' : ''}
      ${x.zone ? '<span class="tiny" style="display:block">到課表設定填年齡就會顯示心率</span>' : ''}</dd></div>`).join('')}</dl>
      ${list.some((x) => x.est) ? `<p class="tiny" style="margin:0">${EST_LINE}</p>` : ''}`;
  };
  const dets = [...days.querySelectorAll('details.xd')];
  for (const d of dets) on(d, 'toggle', () => { if (d.open) fill(d); });
  // 全部展開（記在這台裝置）
  const xall = root.querySelector('#xall');
  const setAll = (open) => { for (const d of dets) { if (open) fill(d); d.open = open; } if (xall) xall.setAttribute('aria-pressed', String(open)); };
  if (xall) {
    xall.hidden = !dets.length;
    on(xall, 'click', () => { const v = xall.getAttribute('aria-pressed') !== 'true'; setAll(v); setCoachPrefs({ ui: { explain: v } }); });
  }
  if (coachPrefs().ui.explain === true) setAll(true);

  // 3. 提醒：每週天數、跑量（設定過才顯示）；個人週期剛換、從中間接著跑的頭兩週也提醒
  const slot = root.querySelector('.warnslot');
  if (slot && !other) {
    const p = coachPrefs(), seen = p.cycleSeen;
    const fresh = personal && seen?.anchor === cycle.anchor && P.dayDiff(P.parseISO(today), P.parseISO(seen.at)) <= 14 && wi > 1 && wi <= 20;
    const lines = coach.warnings().filter((w) => (w.key === 'mid' ? fresh : prefsSet(p.plan))).slice(0, 3);
    if (lines.length) { slot.innerHTML = `<p class="notice" style="margin:0">${lines.map((w) => `<span>${esc(w.text)}</span>`).join('<br>')}</p>`; slot.hidden = false; }
  }

  // 4. 標示本週用到某個用語的課（?hl=mp）
  const mark = (key) => {
    days.querySelectorAll('.day[data-i]').forEach((el) => el.classList.toggle('term-hl', !!key && termsOf[Number(el.dataset.i)].includes(key)));
    days.querySelectorAll('button.term').forEach((b) => b.classList.toggle('on', !!key && b.dataset.term === key));
  };
  const setHl = (key) => {
    const [path, qs = ''] = location.hash.split('?'), q = new URLSearchParams(qs);
    if (key) q.set('hl', key); else q.delete('hl');
    history.replaceState(history.state, '', `${path}${q.toString() ? `?${q}` : ''}`);
    mark(key);
  };
  let hlNow = GL[hl] ? hl : null;
  if (hlNow) mark(hlNow);

  // 5. 用語說明：手機是底部面板，寬螢幕是貼在按鈕旁的小視窗
  let pop = null, back = null;
  const close = () => { if (!pop) return; pop.remove(); pop = null; back?.focus?.(); back = null; };
  const open = (btn) => {
    close();
    const key = btn.dataset.term, n = termsOf.filter((t) => t.includes(key)).length;
    const body = `<h3><span translate="no">${esc(GL[key].name)}</span></h3><p style="margin:0">${esc(GL[key].zh)}</p>
      <p class="tiny" style="margin:0">本週 ${n} 堂用到</p>
      <div class="choices"><button type="button" class="btn block" data-hl="${hlNow === key ? '' : key}">${hlNow === key ? '取消標示' : '標示本週全部'}</button>
      <button type="button" class="btn ghost block" data-close>關閉</button></div>`;
    back = btn;
    if (matchMedia('(min-width:820px)').matches) {
      pop = document.createElement('div');
      pop.className = 'card termpop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', GL[key].name);
      pop.innerHTML = body;
      document.body.append(pop);
      const r = btn.getBoundingClientRect(), w = pop.offsetWidth;
      pop.style.top = `${r.bottom + scrollY + 8}px`;
      pop.style.left = `${Math.max(16, Math.min(innerWidth - w - 16, r.left + scrollX - 12))}px`;
    } else {
      pop = document.createElement('div');
      pop.className = 'sheet'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'true'); pop.setAttribute('aria-label', GL[key].name);
      pop.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-card card">${body}</div>`;
      document.body.append(pop);
    }
    pop.querySelector('[data-hl]')?.focus();
    pop.addEventListener('click', (e) => {
      const h = e.target.closest('[data-hl]');
      if (h) { hlNow = h.dataset.hl || null; setHl(hlNow); close(); return; }
      if (e.target.closest('[data-close]')) close();
    });
  };
  on(days, 'click', (e) => { const b = e.target.closest('button.term'); if (b) { e.preventDefault(); open(b); } });
  on(document, 'keydown', (e) => { if (e.key === 'Escape') close(); });
  on(document, 'pointerdown', (e) => { if (pop?.classList.contains('termpop') && !pop.contains(e.target) && !e.target.closest('button.term')) close(); });

  // 6. 左右滑動換週：至少 60px、水平為主；從螢幕邊緣 24px 內開始的不算（iPhone 返回手勢），週次列與詳細內容上不算
  let sx = 0, sy = 0, ok = false;
  on(days, 'touchstart', (e) => {
    const t = e.touches[0];
    ok = e.touches.length === 1 && t.clientX >= 24 && t.clientX <= innerWidth - 24 && !e.target.closest('.wkline, details, button.term, .tick');
    sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  on(days, 'touchend', (e) => {
    if (!ok) return;
    ok = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 60 || Math.abs(dx) <= 1.5 * Math.abs(dy)) return;
    const n = week + (dx < 0 ? 1 : -1);
    if (n >= 1 && n <= 21) location.hash = `#/plan/${n}${other ? '?c=club' : ''}`;
  });

  return () => { close(); off.splice(0).forEach((f) => f()); };
}

/* ======================================================================
   課表的全季、賽事準備、配速與用語、課表設定
   身體資料、成績、起跑時間只存在這台裝置（cil-coach），不會送到伺服器
   ====================================================================== */
const CI = {
  clock: ic('<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3 2"/>'),
  droplet: ic('<path d="M12 3.6s-6 6.5-6 10.5a6 6 0 0 0 12 0c0-4-6-10.5-6-10.5Z"/>'),
  heart: ic('<path d="M12 19.6s-7.6-4.6-7.6-10.1A4.2 4.2 0 0 1 12 7.1a4.2 4.2 0 0 1 7.6 2.4c0 5.5-7.6 10.1-7.6 10.1Z"/>'),
  book: ic('<path d="M12 6.4C10.4 5 8.2 4.4 4.5 4.6v13.6c3.7-.2 5.9.4 7.5 1.8 1.6-1.4 3.8-2 7.5-1.8V4.6C15.8 4.4 13.6 5 12 6.4ZM12 6.4V20"/>'),
  gauge: ic('<path d="M4.6 17.6a8.6 8.6 0 1 1 14.8 0"/><path d="M12 13.2l3.4-4"/><circle cx="12" cy="13.6" r="1.2"/>'),
  person: ic('<circle cx="12" cy="7.6" r="3.4"/><path d="M5.2 20c.8-3.8 3.4-6 6.8-6s6 2.2 6.8 6"/>'),
};
const WDN = ['日', '一', '二', '三', '四', '五', '六'];
const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
const mdw = (d) => `${md(d)}（${WDN[d.getDay()]}）`;
const distName = (d) => (d === 'hm' ? '半馬' : '全馬');
const wkName = (n) => (n === 21 ? 'R' : `W${n}`);
const todayISO = () => P.iso(new Date());
const BODY_KEYS = ['age', 'sex', 'kg', 'rest', 'sweat'];
const hasBody = (b) => BODY_KEYS.some((k) => b?.[k] != null && b[k] !== '');
// 賽事的距離欄（全馬、半馬、10K…）→ fm／hm；其他距離回傳 null
const raceDist = (r) => (/全馬|^42/.test(r?.dist || '') ? 'fm' : /半馬|^21/.test(r?.dist || '') ? 'hm' : null);
const isWeekend = (iso) => { const d = P.parseISO(iso); return !!d && (d.getDay() === 0 || d.getDay() === 6); };
const notice = (html) => `<p class="notice" style="margin:0">${html}</p>`;
// 頁面裡跳到某一段（?go=cycle、?go=hr…）
const goTo = (id) => { const el = id && document.getElementById(id); if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })); };

// 回傳離開頁面時要做的清理（賽事倒數的計時器）
export async function coachView(section) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (section === 'race') return raceView(q);
  if (section === 'setup') return setupView(q);
  if (section === 'season') return seasonView();
  return guideView(q);
}

/* ---------- 賽事準備 #/plan/race ---------- */
async function raceView(q) {
  const t0 = todayISO(), tgt = await raceTarget();
  const mine = (tgt.data.races || []).filter((r) => r.date >= t0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const club = tgt.data.club?.date >= t0 ? { ...tgt.data.club, club: true } : P.RACE_ISO >= t0 ? { name: P.CLUB.name, date: P.RACE_ISO, club: true } : null;
  let race = tgt.race, src = tgt.src;
  // 換一場：?race=<id> 看我的另一場比賽、?race=club 看協會賽季（只換這一頁，不改右上角倒數）
  const pick = q.get('race');
  if (pick === 'club' && club) { race = club; src = 'club'; }
  else if (pick) { const r = mine.find((x) => x.id === pick); if (r) { race = r; src = 'pick'; } }
  const cyc = myCycle();
  const head = `${largeTitle('課表', `${distName(me.dist)} ${esc(me.grp)} 組・賽事準備`)}${planSeg('/plan/race')}`;
  if (!race) {
    view.innerHTML = `${head}<section class="card">${emptyState(MI.flag, '還沒有要準備的比賽')}<a class="btn block" href="#/me/races">加一場比賽</a></section>`;
    return () => {};
  }
  const p = coachPrefs(), body = p.body, key = startKey(race), start = p.start[key] || null;
  const goalMin = parseGoal(race.goal), useGoal = goalMin != null && p.ui.goal?.[key] === true;
  const coach = createCoach({ dist: me.dist, grp: me.grp, nickname: me.nickname || me.name, prefs: p.plan, pb: p.pb, body, start,
    goalMin: useGoal ? goalMin : null, cycle: { kind: 'race', anchor: race.date, name: race.name } });
  const fm = me.dist !== 'hm', g = coach.grpInfo(), mid = (g[2] + g[3]) / 2, tMin = coach.targetMin();
  const left = P.dayDiff(P.parseISO(race.date), P.parseISO(t0));
  const srcName = { cycle: '課表週期', club: '協會賽季', countdown: '右上角倒數', primary: '我的主要賽事', nearest: '最近的一場', pick: '我的賽事' }[src];

  // 提醒：項目不同、要不要讓課表跟著這場排、平日比賽
  const notes = [], rk = raceDist(race), max = P.iso(P.addDays(P.parseISO(t0), 400));
  if (rk && rk !== me.dist) notes.push(`<span>這場是${distName(rk)}，你的課表是${distName(me.dist)}</span><span>；配速與補給照你的課表項目計算。</span>`);
  if (feat('plan_cycle') && race.id && race.id !== cyc.raceId && race.date !== P.RACE_ISO && race.date <= max)
    notes.push(`<span>要讓課表跟著這場排嗎？</span><span>W1 會是 ${dstr(P.cycleOf(race.date).w1ISO)}</span> <a href="#/plan/setup?go=cycle&race=${encodeURIComponent(race.id)}">改成跟這場排課 ›</a>`);
  else if (!feat('plan_cycle') && cyc.kind === 'club' && race.date !== P.RACE_ISO)
    notes.push('課表週期跟著協會賽季（W20＝12/14–12/20），賽前兩週請跟教練確認');
  if (!isWeekend(race.date)) notes.push('你的比賽不在週末，賽事週的課請跟教練確認');

  const subTime = g[1].split('–').pop();
  const chips = [`${esc(g[0])} 組 SUB ${esc(subTime)}`, `${fm ? 'MP' : 'HMP'} ${P.fmtP(coach.goalPace())}/km`, `每週 ${coach.S.days} 天`];
  const srcLine = useGoal ? `<span>目標時間用我的目標 </span><b class="num">${P.fmtHMS(goalMin)}</b>` : `<span>目標時間依 ${esc(g[0])} 組中間值 </span><b class="num">${P.fmtHMS(mid)}</b>`;
  const goalCtl = goalMin != null ? `<button type="button" class="btn ghost sm" id="goalBtn" aria-pressed="${useGoal}">${useGoal ? '改用組別中間值' : `改用我的目標 ${P.fmtHMS(goalMin)}`}</button>`
    : race.goal ? `<span class="tiny">目標成績「<span translate="no">${esc(race.goal)}</span>」看不懂，先用組別中間值（格式：時:分:秒）</span>` : '';

  const rp = coach.raceDayPlan();
  const kg = body.kg, sweat = body.sweat || '中', R = Math.round;
  const f = fuelCalc(kg || 60, tMin, me.dist, sweat);
  const perH = f.lo === f.hi ? f.lo : `${f.lo}–${f.hi}`, tot = `${R(f.totLo)}${f.lo === f.hi ? '' : `–${R(f.totHi)}`}`, gels = f.gLo === f.gHi ? f.gLo : `${f.gLo}–${f.gHi}`;
  const toSetup = (go, text) => `<a class="btn ghost sm" href="#/plan/setup?go=${go}">${text}</a>`;
  const fuelRow = (k, v, sub = '') => `<div class="fuelrow"><span class="tiny">${k}</span><span>${v}${sub ? `<span class="tiny" style="display:block">${sub}</span>` : ''}</span></div>`;

  view.innerHTML = `${head}
    <section class="card bib">
      <div class="row spread"><span class="pill">${srcName}</span><button type="button" class="btn ghost sm" id="raceSwitch">換一場</button></div>
      <h2 class="bibrace"><span translate="no">${esc(race.name)}</span></h2>
      <div class="bibmeta"><span>${dstr(race.date)}</span><label class="bibstart">起跑<input type="time" id="raceStart" step="300" value="${esc(start || '')}"></label></div>
      <div class="bibcount">${left > 0 ? `<b class="num">${left}</b><span>天</span>` : left === 0 ? '<b>今天比賽</b>' : '<b>已完賽</b>'}<span class="tiny" id="raceClock"></span></div>
      <p class="bibrunner"><span translate="no">${esc(me.nickname || me.name)}</span></p>
      <div class="chips">${chips.map((c) => `<span class="pill">${c}</span>`).join('')}</div>
      <div class="bibsrc"><span class="tiny">${srcLine}</span>${goalCtl}</div>
    </section>
    ${notes.map(notice).join('')}

    <section class="card" id="plan"><h3>${CI.clock}比賽日計劃</h3>
      ${start ? '' : '<p class="tiny" style="margin:0">填上起跑時間，時間表就會換成時鐘時間。</p>'}
      <ol class="tl">${rp.timeline.map(([t, a, b]) => `<li><span class="num">${esc(t)}</span><b>${esc(a)}</b><span>${esc(b)}</span></li>`).join('')}</ol>
      <h4>配速分段（平均配速）</h4>
      <table class="splits"><thead><tr><th>距離</th><th>累計時間</th>${start ? '<th>時鐘</th>' : ''}</tr></thead>
        <tbody>${rp.splits.map((x) => `<tr><td>${esc(x[0])}</td><td class="num">${x[1]}</td>${start ? `<td class="num">${x[2] || ''}</td>` : ''}</tr>`).join('')}</tbody></table>
      <h4>能量膠時間表</h4>
      <p class="tiny" style="margin:0">${esc(rp.gelNote)}</p>
      <table class="splits"><thead><tr><th>時間</th><th>約在</th>${start ? '<th>時鐘</th>' : ''}</tr></thead>
        <tbody>${rp.gels.map((x) => `<tr><td class="num">${x[0]} 分鐘</td><td class="num">${x[1]} 公里</td>${start ? `<td class="num">${x[2] || ''}</td>` : ''}</tr>`).join('')}</tbody></table>
      ${rp.needKg ? `<div class="row spread"><span class="tiny">填體重可以算出早餐、咖啡因的克數。</span>${toSetup('body', '填體重')}</div>` : ''}
    </section>

    <section class="card" id="fuel"><h3>${CI.droplet}補給試算</h3>
      <p class="tiny" style="margin:0"><span>預估完賽時間</span> <b class="num">${P.fmtT(tMin)}</b></p>
      <div class="field"><span class="flabel">流汗程度</span><div class="seg" role="group" aria-label="流汗程度">${[['低', '少'], ['中', '一般'], ['高', '多']].map(([v, l]) =>
        `<button type="button" data-sweat="${v}" aria-pressed="${sweat === v}">${l}</button>`).join('')}</div></div>
      <div class="fuel">
        ${fuelRow('比賽中碳水', `每小時 <b class="num">${perH} g</b>，全程約 ${tot} g`)}
        ${fuelRow('能量膠', `<b class="num">${gels}</b> 包`, `全程碳水 ÷ 25 g；第 30–45 分鐘第一包，之後每 ${f.gap}–${f.gap + 10} 分鐘一包`)}
        ${fuelRow('水分', `每小時 <b class="num">${f.ml[0]}–${f.ml[1]} ml</b>`, '每站喝幾口，不要喝到體重比賽前還重')}
        ${fuelRow('鈉', `每小時 <b class="num">${f.na} mg</b>`)}
        ${kg ? `${fuelRow('肝醣超補', `每天碳水 <b class="num">${R(f.load[0])}–${R(f.load[1])} g</b>`, fm ? '賽前 36–48 小時，每天碳水 10–12 g/kg' : '賽前 24–36 小時輕度超補，7–10 g/kg')}
          ${fuelRow('比賽早餐', `碳水 <b class="num">${R(2 * kg)}–${R(3 * kg)} g</b>、水 ${R(5 * kg)}–${R(7 * kg)} ml`, `起跑前約 3 小時${coach.breakfastAt() ? `（約 ${coach.breakfastAt()} 吃）` : ''}`)}
          ${fuelRow('咖啡因（選用）', `<b class="num">${R(3 * kg)}–${R(6 * kg)} mg</b>`, '起跑前 30–90 分鐘，練習時先試過')}
          ${fuelRow('賽後 4 小時', `每小時碳水 ${R(kg)}–${R(1.2 * kg)} g＋蛋白質 ${R(0.3 * kg)} g`, '喝回流失體重的 125–150%')}`
          : `<div class="row spread"><span class="tiny">肝醣超補、比賽早餐與咖啡因的克數要用體重算：到課表設定填體重就會顯示。</span>${toSetup('body', '填體重')}</div>`}
      </div>
      <p class="tiny" style="margin:0">建議在 W13 以後的長跑課，用比賽配速照這個計畫演練一次。一般運動營養建議（ACSM 等），不是醫療建議。</p>
    </section>

    ${ageCard(coach, body, fm, g, tMin)}
    ${hrCard(body)}

    <section class="card"><h3>${CI.book}賽前提醒</h3>
      <ul class="steps">${[...rp.night, ...rp.tips].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
    <section class="card"><h3>聲明</h3>
      <p class="tiny" style="margin:0">這一頁是一般運動研究與營養建議的估算，不是醫療建議，也不是教練規定；課表以教練每週公告為準。懷孕、有慢性病或正在服藥，請先問醫師或營養師。</p>
      <p class="tiny" style="margin:0">資料來源：ACSM 運動營養建議、WMA 2025 路跑年齡分級、Tanaka 最大心率公式。</p></section>`;

  // 換一場：我今天以後的比賽、協會賽季，或到「我的賽事與倒數」
  $('#raceSwitch').onclick = async () => {
    const opts = [...mine.filter((r) => r.id !== race.id).map((r) => ({ value: r.id, label: `${r.name}・${dstr(r.date)}` })),
      ...(club && !race.club ? [{ value: 'club', label: `協會賽季・${club.name}` }] : []), { value: '__races', label: '管理我的賽事與倒數' }];
    const v = await choose('換一場', '只換這一頁要準備的比賽，不會改右上角倒數。', opts);
    if (v === '__races') location.hash = '#/me/races';
    else if (v) location.replace(`#/plan/race?race=${encodeURIComponent(v)}`);
  };
  $('#raceStart').onchange = (e) => { setCoachPrefs({ start: { [key]: e.target.value || null } }); toast('已儲存'); render(); };
  $('#goalBtn')?.addEventListener('click', () => { setCoachPrefs({ ui: { goal: { ...(p.ui.goal || {}), [key]: !useGoal } } }); render(); });
  for (const b of view.querySelectorAll('[data-sweat]')) b.onclick = () => { setCoachPrefs({ body: { sweat: b.dataset.sweat } }); render(); };
  goTo(q.get('go'));

  // 比賽前 48 小時：每 30 秒更新「還有 h:mm」，只在畫面看得到的時候跑
  const target = new Date(`${race.date}T${start || '00:00'}:00`);
  let timer = 0;
  const paint = () => {
    const el = document.getElementById('raceClock');
    if (!el) { stop(); return; }
    const ms = target - Date.now();
    if (ms <= 0 || ms > 48 * 36e5) { el.textContent = ''; return; }
    const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    el.innerHTML = `<span>${start ? '距離起跑' : '距離比賽日'}</span> <b class="num">${h}:${String(m).padStart(2, '0')}</b>`;
  };
  const onVis = () => {
    clearInterval(timer); timer = 0;
    if (document.visibilityState === 'visible') { paint(); timer = setInterval(paint, 30000); }
  };
  const stop = () => { clearInterval(timer); timer = 0; document.removeEventListener('visibilitychange', onVis); };
  if (target - Date.now() > 0 && target - Date.now() <= 48 * 36e5) { onVis(); document.addEventListener('visibilitychange', onVis); }
  return stop;
}

// 目標難度・年齡分級（全馬；要年齡與性別）。等級用文字寫出來，不只靠顏色
function ageCard(coach, body, fm, g, tMin) {
  const head = `<section class="card" id="age"><h3>${CI.gauge}目標難度・年齡分級</h3>`;
  const age = body.age, sex = body.sex === 'F' ? 'F' : body.sex === 'M' ? 'M' : null;
  const ageNote = age >= 50 ? '<p class="tiny" style="margin:0">重點課後通常需要 48–72 小時恢復。週二很累時可以改成輕鬆跑，週四團練和週末長跑盡量保留，肌力課不要省略（一般研究建議，請和教練確認）。</p>'
    : age >= 40 ? '<p class="tiny" style="margin:0">注意重點課之間的恢復，每週 1–2 次肌力訓練有助延緩肌肉流失。</p>' : '';
  if (!fm) return `${head}<p style="margin:0">目標 <b class="num">SUB ${esc(g[1])}</b>（半馬 ${esc(g[0])} 組）</p><p class="tiny" style="margin:0">半馬沒有年齡分級，年齡分級表只有全馬。</p>${ageNote}</section>`;
  if (!age || !sex) return `${head}<div class="row spread"><span class="tiny">到課表設定填年齡與性別，就會顯示同一個目標對你有多難。</span><a class="btn ghost sm" href="#/plan/setup?go=body">填年齡</a></div></section>`;
  const std = std100(age, sex), tp = ageGrade(age, sex, tMin), pMin = coach.predictedMin(), pp = pMin ? ageGrade(age, sex, pMin) : null, gap = pp != null ? tp - pp : null;
  const pos = (x) => Math.min(100, Math.max(0, ((x - 40) / 60) * 100));
  const scale = [[40, '40%'], [60, '60 地方級'], [70, '70 區域級'], [80, '80 國家級'], [90, '90 世界級'], [100, '100']];
  const v = gap != null ? verdict(gap) : null;
  return `${head}
    <div class="agemeter" role="img" aria-label="年齡分級：目標 ${tp.toFixed(1)}%${pp != null ? `，目前 ${pp.toFixed(1)}%` : ''}">
      <div class="bar">${pp != null ? `<span class="mk now" style="left:${pos(pp)}%"></span>` : ''}<span class="mk goal" style="left:${pos(tp)}%"></span></div>
      <div class="scale num">${scale.map(([x, l]) => `<span style="left:${pos(x)}%">${l}</span>`).join('')}</div></div>
    <dl class="kv">
      <dt>目標</dt><dd><b class="num">${tp.toFixed(1)}%</b> <span class="num">${P.fmtHMS(tMin)}</span>・<span>${lvl(tp)}</span><span>（深色標記）</span></dd>
      ${pp != null ? `<dt>目前能力</dt><dd><b class="num">${pp.toFixed(1)}%</b> <span>依成績推算全馬</span> <span class="num">${P.fmtT(pMin)}</span>・<span>${lvl(pp)}</span><span>（淺色標記）</span></dd>` : `<dt>目前能力</dt><dd><a href="#/plan/setup?go=pb">填一場最近的成績就能比較 ›</a></dd>`}
      <dt>換成 30 歲</dt><dd><b class="num">${P.fmtHMS((tMin * std100(30, sex)) / std)}</b> <span>${sex === 'M' ? '同等水準的 30 歲男性成績' : '同等水準的 30 歲女性成績'}</span></dd>
    </dl>
    ${v ? notice(`<b class="num">差距 ${gap > 0 ? '+' : ''}${gap.toFixed(1)}%</b>　${esc(v[1])}`) : ''}
    <p class="tiny" style="margin:0">一般研究（WMA 2025），不是教練規定；3%／6% 是經驗值。從短距離推算全馬偏樂觀，跑量少或初馬請多留 3–8%。</p>
    ${ageNote}</section>`;
}
// 心率區間（要年齡）：一般公式估算，標「估算」
function hrCard(body) {
  const head = `<section class="card" id="hr"><h3>${CI.heart}心率區間</h3>`;
  if (!body.age) return `${head}<div class="row spread"><span class="tiny">到課表設定填年齡就會顯示心率</span><a class="btn ghost sm" href="#/plan/setup?go=body">填年齡</a></div></section>`;
  const x = hrCalc(body.age, body.rest);
  return `${head}
    <table class="hz"><thead><tr><th>區間</th><th>心率（bpm）</th><th>${x.karvonen ? '儲備心率' : '最大心率'}</th></tr></thead>
      <tbody>${x.zones.map((z) => `<tr><td>${z[0]}</td><td class="num">${z[1]}–${z[2]}</td><td class="num">${Math.round(z[3] * 100)}–${Math.round(z[4] * 100)}%</td></tr>`).join('')}</tbody></table>
    <dl class="kv">
      <dt>最大心率</dt><dd><b class="num">${Math.round(x.tan)}</b> <span>Tanaka 208−0.7×年齡</span>・<span>對照 220−年齡：</span><span class="num">${x.fox}</span></dd>
      <dt>算法</dt><dd>${x.karvonen ? `<span>Karvonen 儲備心率法・安靜心率</span> <span class="num">${esc(body.rest)}</span>` : '最大心率 %（填安靜心率會改用 Karvonen）'}</dd>
    </dl>
    <p style="margin:0"><span>${x.karvonen ? '課表 HR130 約是你儲備心率的' : '課表 HR130 約是你最大心率的'}</span> <b class="num">${Math.round(x.p130)}%</b> <span class="pill est">估算</span></p>
    <table class="hz rpe"><thead><tr><th>自覺強度（RPE）</th><th>感覺</th></tr></thead>
      <tbody><tr><td class="num">1–3</td><td>很輕鬆，可以聊天</td></tr><tr><td class="num">4–5</td><td>輕鬆到中等</td></tr><tr><td class="num">6 以上</td><td>中等偏難</td></tr></tbody></table>
    <p class="tiny" style="margin:0">${EST_LINE}</p></section>`;
}

/* ---------- 課表設定 #/plan/setup ---------- */
async function setupView(q) {
  const coachOn = feat('coach'), cycOn = feat('plan_cycle'), t0 = todayISO(), p = coachPrefs(), b = p.body;
  const data = await api('/races').catch(() => ({ races: [] }));
  const max = P.iso(P.addDays(P.parseISO(t0), 400));
  const future = (data.races || []).filter((r) => r.date >= t0 && r.date <= max).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const cyc = myCycle();
  const tgt = coachOn ? await raceTarget(data) : null;
  const tiles = (d, sel) => Object.entries(P.groups(d)).map(([k, v]) => `<label class="chip gtile"><input type="radio" name="grp" value="${k}" ${k === sel ? 'checked' : ''}><span><b>${k} 組</b><small class="num">${v[0]}</small></span></label>`).join('');
  const seg = (name, label, opts, cur) => `<div class="seg" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;
  const sec = (id, title, inner, cls = '') => `<section class="setgroup" id="${id}"><h2 class="sgt">${title}</h2><div class="card ${cls}">${inner}</div></section>`;

  // 1. 項目與組別（存在帳號：PUT /api/me/plan，只改這兩個欄位）
  const secGrp = sec('grp', '項目與組別', `
    <div class="chips" role="radiogroup" aria-label="項目">${[['fm', '全馬', '42.195K'], ['hm', '半馬', '21.0975K']].map(([k, l, s]) =>
      `<label class="chip"><input type="radio" name="dist" value="${k}" ${k === (me.dist === 'hm' ? 'hm' : 'fm') ? 'checked' : ''}><span>${l} <small class="num">${s}</small></span></label>`).join('')}</div>
    <div class="chips gtiles" role="radiogroup" aria-label="組別" id="gtiles">${tiles(me.dist === 'hm' ? 'hm' : 'fm', me.grp)}</div>
    <button type="button" class="btn block" id="grpSave">儲存</button>
    <p class="tiny" style="margin:0">跟「我的 → 個人資料」是同一個設定</p>`);

  // 2. 課表週期：跟協會賽季，或跟自己的一場比賽排 20 週
  const pickId = future.some((r) => r.id === q.get('race')) ? q.get('race') : null;
  const sel = pickId || (cyc.kind === 'race' ? cyc.raceId : null), mode = pickId ? 'race' : cyc.kind === 'race' ? 'race' : 'club';
  const preview = (r) => {
    const c = P.cycleOf(r.date), wi = P.weekIndexOf(t0, c), w20 = P.weekStart(20, c);
    return `<span class="tiny" style="display:block">${wi < 1 ? `W1 ${mdw(c.w1)}開始，還有 ${P.dayDiff(c.w1, P.parseISO(t0))} 天` : `現在是 W${wi}，從這週接著跑`}</span>
      <span class="tiny" style="display:block">W20 ${md(w20)}–${md(P.addDays(w20, 6))}</span>`;
  };
  const raceRows = future.map((r) => {
    const same = r.date === P.RACE_ISO;
    return `<label class="r cycrace${same ? ' off' : ''}"><input type="radio" name="cycrace" value="${esc(r.id)}" ${r.id === sel ? 'checked' : ''} ${same ? 'disabled' : ''}>
      <span><b><span translate="no">${esc(r.name)}</span></b><span class="tiny" style="display:block">${dstr(r.date)}${r.dist ? `・${esc(r.dist)}` : ''}</span>
        ${same ? '<span class="tiny" style="display:block">這場跟協會賽季同一天，選「跟協會賽季」就好</span>' : preview(r)}</span></label>`;
  }).join('');
  const w20c = P.weekStart(20);
  const secCyc = cycOn ? sec('cycle', '課表週期', `
    <div class="cycopts" role="radiogroup" aria-label="課表週期">
      <label class="cycopt"><input type="radio" name="cyc" value="club" ${mode === 'club' ? 'checked' : ''}><span><b>跟協會賽季</b>
        <span class="tiny" style="display:block">W1 ${md(P.CLUB.w1)} → W20 ${md(w20c)}–${md(P.addDays(w20c, 6))} <span translate="no">${esc(P.CLUB.name)}</span></span></span></label>
      <label class="cycopt"><input type="radio" name="cyc" value="race" ${mode === 'race' ? 'checked' : ''} ${future.length ? '' : 'disabled'}><span><b>跟我的比賽排 20 週</b>
        <span class="tiny" style="display:block">選一場今天以後、一年內的比賽</span></span></label>
    </div>
    ${future.length ? `<div class="roster cycraces" role="radiogroup" aria-label="選一場比賽" ${mode === 'race' ? '' : 'hidden'}>${raceRows}</div><a class="tiny" href="#/me/races">新增比賽 ›</a>`
      : '<p class="tiny" style="margin:0"><a href="#/me/races">先在「我的賽事與倒數」加一場比賽 ›</a></p>'}
    <div id="cycWarn" class="warnslot"></div>
    <p class="tiny" style="margin:0">週四團練、教練每週公告、團員訓練看板仍照協會週次；你的課表、今天的課、完成率、報表改照個人週期。以前的紀錄不會改。</p>
    <button type="button" class="btn block" id="cycSave">儲存</button>`)
    : cfg.planCycle?.suspended ? sec('cycle', '課表週期', notice('個人週期目前暫停，課表先照協會賽季')) : '';

  // 3. 用成績推算
  const secPb = sec('pb', '用成績推算', `
    <div class="grid2"><label>最近一場成績<select id="pbDist">${[['5', '5K'], ['10', '10K'], ['21.0975', '半馬'], ['42.195', '全馬']].map(([v, l]) =>
      `<option value="${v}" ${String(p.pb.dist) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>完賽時間<input id="pbTime" value="${esc(p.pb.time || '')}" placeholder="0:48:30" inputmode="numeric" autocomplete="off"></label></div>
    <p class="tiny" id="pbRes" aria-live="polite" style="margin:0"></p>`);

  // 4. 訓練安排（只存在這台裝置，改了就存）
  const secTrain = sec('train', '訓練安排', `
    <div class="field"><span class="flabel">每週能跑</span>${seg('days', '每週能跑', [[6, '6 天'], [5, '5 天'], [4, '4 天'], [3, '3 天']], p.plan.days)}</div>
    <div class="field"><span class="flabel">週四團練</span>${seg('club', '週四團練', [['1', '參加團練'], ['0', '自己練']], p.plan.club === false ? '0' : '1')}</div>
    <div class="field"><span class="flabel">每週跑量</span>${seg('vol', '每週跑量', VOL.map((v) => [v[0], v[1][0]]), p.plan.vol ?? '')}</div>
    <div id="trainWarn" class="warnslot"></div>
    <p class="tiny" style="margin:0">每週天數不夠時，課表會把輕鬆跑標成「可省略」。</p>`);

  // 5. 比賽
  const r0 = tgt?.race;
  const secRace = sec('race', '比賽', `
    ${r0 ? `<a class="setrow" href="#/plan/race"><span class="sic">${MI.flag}</span><span class="st"><b><span translate="no">${esc(r0.name)}</span></b><span class="tiny">${dstr(r0.date)}・賽事準備</span></span><span class="chev" aria-hidden="true"></span></a>
      <label class="setrow"><span class="sic">${CI.clock}</span><span class="st"><b>起跑時間</b><span class="tiny">比賽日計劃會換成時鐘時間</span></span><input type="time" step="300" id="setStart" value="${esc(p.start[startKey(r0)] || '')}"></label>` : ''}
    ${row('#/me/races', MI.cal, '管理我的賽事與倒數', '右上角倒數哪一場')}`, 'setcard');

  // 6. 身體資料（選填）
  const secBody = sec('body', '身體資料（選填）', `
    <form id="bodyForm" class="bodyform" autocomplete="off">
      <div class="grid2"><label>年齡<input name="age" type="number" inputmode="numeric" min="10" max="100" value="${esc(b.age ?? '')}"></label>
        <label>體重（kg）<input name="kg" type="number" inputmode="decimal" min="25" max="200" step="0.1" value="${esc(b.kg ?? '')}"></label></div>
      <fieldset class="qset"><legend>性別</legend><div class="chips">${[['M', '男'], ['F', '女']].map(([v, l]) =>
        `<label class="chip"><input type="radio" name="sex" value="${v}" ${b.sex === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <div class="grid2"><label>安靜心率<input name="rest" type="number" inputmode="numeric" min="30" max="120" value="${esc(b.rest ?? '')}" placeholder="早上醒來量"></label><span></span></div>
      <fieldset class="qset"><legend>流汗程度</legend><div class="chips">${[['低', '少'], ['中', '一般'], ['高', '多']].map(([v, l]) =>
        `<label class="chip"><input type="radio" name="sweat" value="${v}" ${b.sweat === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
    </form>
    <p class="tiny lockline" style="margin:0">${IC.lock}<span>只存在這台裝置，不會上傳；登出時清除</span></p>
    <p class="tiny" style="margin:0">用在賽事準備的年齡分級、心率區間與補給克數；體重不會出現在任何分享或匯出的內容。</p>
    <button type="button" class="btn danger block" id="bodyClear" ${hasBody(b) ? '' : 'disabled'}>清除身體資料</button>`);

  // 7. 這台裝置上的資料（改了任何一項就重算）
  const devList = (x = coachPrefs()) => {
    const volName = (VOL.find((v) => v[0] === x.plan.vol) || [])[1]?.[0], starts = Object.values(x.start || {}).filter(Boolean).length;
    return `<li>訓練安排：每週 ${x.plan.days} 天・週四${x.plan.club === false ? '自己練' : '團練'}${volName ? `・跑量 ${volName}` : ''}</li>
      <li>成績推算：${x.pb.time ? `${{ 5: '5K', 10: '10K', 21.0975: '半馬', 42.195: '全馬' }[x.pb.dist] || ''} ${esc(x.pb.time)}` : '沒有'}</li>
      <li>身體資料：${hasBody(x.body) ? '有填' : '沒有'}</li>
      <li>起跑時間：${starts} 場</li>`;
  };
  const secDev = sec('device', '這台裝置上的資料', `
    <ul class="steps" id="devList">${devList(p)}</ul>
    <p class="tiny" style="margin:0">這些只存在這台裝置，換手機或清除瀏覽器資料就不見了，登出時也會清除。項目、組別與課表週期存在你的帳號。</p>
    <button type="button" class="btn danger block" id="devClear">全部清除</button>`);

  view.innerHTML = `${subTitle('課表設定', '課表、賽事準備用到的設定')}
    ${coachOn ? secGrp : ''}${secCyc}${coachOn ? secPb + secTrain + secRace + secBody + secDev : ''}`;

  // #view 是共用的節點：這裡加的監聽在離開頁面時拿掉（回傳的清理函式）
  const devPaint = () => { const el = $('#devList'); if (el) el.innerHTML = devList(); };
  const onClick = (e) => { if (e.target.closest('[data-days],[data-club],[data-vol]')) devPaint(); };
  const onInput = (e) => { if (e.target.id === 'pbTime') devPaint(); };
  view.addEventListener('change', devPaint); view.addEventListener('click', onClick); view.addEventListener('input', onInput);
  const cleanup = () => { view.removeEventListener('change', devPaint); view.removeEventListener('click', onClick); view.removeEventListener('input', onInput); };
  const distNow = () => view.querySelector('[name=dist]:checked')?.value || me.dist;
  const grpNow = () => view.querySelector('[name=grp]:checked')?.value || me.grp;

  // 用成績推算：建議組別；「套用」只選好組別，按儲存才生效
  const pbPaint = () => {
    const box = $('#pbRes'), time = $('#pbTime')?.value.trim();
    if (!box) return;
    if (!time) { box.textContent = '填最近一場比賽的成績，推算你適合哪一組。'; return; }
    const c = createCoach({ dist: distNow(), grp: grpNow(), pb: { dist: $('#pbDist').value, time } }), pred = c.predictedMin();
    if (!pred) { box.textContent = '請用「時:分:秒」格式，例如 0:48:30'; return; }
    const sg = c.suggestGroup(pred), gs = Object.values(P.groups(distNow())), slow = pred > gs[gs.length - 1][2];
    box.innerHTML = `<span>${distNow() === 'hm' ? '預估半馬' : '預估全馬'}</span> <b class="num">${P.fmtHMS(pred)}</b><span>，建議 </span><b>${sg[0]} 組</b>${slow ? '<span>（比最慢組還慢，先選最慢組）</span>' : ''}
      <button type="button" class="btn ghost sm" id="pbUse" data-g="${sg[0]}">套用</button>`;
    $('#pbUse').onclick = () => {
      const r = view.querySelector(`[name=grp][value="${sg[0]}"]`);
      if (r) { r.checked = true; toast(`已選 ${sg[0]} 組，按儲存才會生效`); goTo('grp'); }
    };
  };
  // 每週天數、跑量的提醒（含「從中間接著跑」）
  const trainPaint = () => {
    const box = $('#trainWarn');
    if (!box) return;
    const plan = coachPrefs().plan;
    const w = createCoach({ dist: me.dist, grp: me.grp, prefs: plan, cycle: myCycle() }).warnings().filter((x) => x.key !== 'vol' || plan.vol != null);
    box.innerHTML = w.length ? notice(w.map((x) => `<span>${esc(x.text)}</span>`).join('<br>')) : '';
  };
  // 課表週期：選到的比賽有什麼要注意
  const cycWarn = () => {
    const box = $('#cycWarn');
    if (!box) return;
    const m = view.querySelector('[name=cyc]:checked')?.value, id = view.querySelector('[name=cycrace]:checked')?.value, r = future.find((x) => x.id === id);
    const list = view.querySelector('.cycraces');
    if (list) list.hidden = m !== 'race';
    const out = [];
    if (m === 'race' && r) {
      const rk = raceDist(r);
      if (!rk) out.push(`這場不是全馬或半馬，課表仍照你的${distName(me.dist)} ${esc(me.grp)} 組排`);
      else if (rk !== me.dist) out.push(`<span>這場是${distName(rk)}，你的課表是${distName(me.dist)}</span> <button type="button" class="btn ghost sm" id="toDist" data-d="${rk}">改成${distName(rk)}</button>`);
      if (!isWeekend(r.date)) out.push('你的比賽不在週末，賽事週的課請跟教練確認');
      if (P.weekIndexOf(t0, P.cycleOf(r.date)) < 1) out.push('W1 還沒開始：這段時間照平常的量跑，或先看協會課表。');
    }
    box.innerHTML = out.map(notice).join('');
    $('#toDist')?.addEventListener('click', async (e) => {
      try { await api('/me/plan', { method: 'PUT', body: { dist: e.currentTarget.dataset.d } }); await refreshMe(); toast('已儲存'); render(); } catch (err) { toast(err.message); }
    });
  };

  if (coachOn) {
    for (const r of view.querySelectorAll('[name=dist]')) r.onchange = () => {
      const d = distNow(), keep = Object.keys(P.groups(d)).includes(grpNow()) ? grpNow() : d === 'hm' ? 'C' : 'D';
      $('#gtiles').innerHTML = tiles(d, keep);
      pbPaint();
    };
    $('#grpSave').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await api('/me/plan', { method: 'PUT', body: { dist: distNow(), grp: grpNow() } }); await refreshMe(); toast('已儲存'); trainPaint(); }
      catch (err) { toast(err.message); }
      btn.disabled = false;
    };
    $('#pbTime').oninput = $('#pbDist').onchange = () => { setCoachPrefs({ pb: { dist: $('#pbDist').value, time: $('#pbTime').value.trim() } }); pbPaint(); };
    pbPaint();
    for (const k of ['days', 'club', 'vol']) for (const btn of view.querySelectorAll(`[data-${k}]`)) btn.onclick = () => {
      const v = btn.dataset[k];
      setCoachPrefs({ plan: { [k]: k === 'days' ? Number(v) : k === 'club' ? v === '1' : v } });
      for (const x of view.querySelectorAll(`[data-${k}]`)) x.setAttribute('aria-pressed', String(x === btn));
      toast('已儲存'); trainPaint();
    };
    trainPaint();
    $('#setStart')?.addEventListener('change', (e) => { setCoachPrefs({ start: { [startKey(r0)]: e.target.value || null } }); toast('已儲存'); });
    // 身體資料：改了就存在這台裝置；第一次存的時候請瀏覽器不要自動清掉
    const bf = $('#bodyForm');
    bf.onsubmit = (e) => e.preventDefault();
    bf.addEventListener('change', (e) => {
      const num = (v, lo, hi, dec = 0) => { const n = parseFloat(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10 ** dec) / 10 ** dec : null; };
      const before = hasBody(coachPrefs().body);
      const nb = { age: num(bf.age.value, 10, 100), sex: bf.querySelector('[name=sex]:checked')?.value || null, kg: num(bf.kg.value, 25, 200, 1),
        rest: num(bf.rest.value, 30, 120), sweat: bf.querySelector('[name=sweat]:checked')?.value || null };
      const bad = e.target.type === 'number' && e.target.value !== '' && nb[e.target.name] == null;
      setCoachPrefs({ body: nb });
      if (!before && hasBody(nb)) navigator.storage?.persist?.().catch(() => {});
      $('#bodyClear').disabled = !hasBody(nb);
      toast(bad ? '這個數字不太對，這一欄沒有存' : '已儲存');
    });
    $('#bodyClear').onclick = async () => {
      if (await choose('清除身體資料？', '年齡、性別、體重、安靜心率與流汗程度會從這台裝置刪除。', [{ value: 'y', label: '清除', danger: true }]) !== 'y') return;
      setCoachPrefs({ body: Object.fromEntries(BODY_KEYS.map((k) => [k, null])) });
      toast('已清除身體資料'); render();
    };
    $('#devClear').onclick = async () => {
      if (await choose('清除這台裝置上的課表設定？', '訓練安排、成績、身體資料與起跑時間都會刪除；項目、組別與課表週期不受影響。', [{ value: 'y', label: '全部清除', danger: true }]) !== 'y') return;
      try { localStorage.removeItem('cil-coach'); } catch {}
      toast('已清除'); render();
    };
  }
  if (cycOn && $('#cycSave')) {
    for (const r of view.querySelectorAll('[name=cyc], [name=cycrace]')) r.addEventListener('change', (e) => {
      if (e.target.name === 'cycrace') { const o = view.querySelector('[name=cyc][value=race]'); if (o) o.checked = true; }
      cycWarn();
    });
    cycWarn();
    $('#cycSave').onclick = async (e) => {
      const btn = e.currentTarget, m = view.querySelector('[name=cyc]:checked')?.value || 'club', id = view.querySelector('[name=cycrace]:checked')?.value;
      const r = future.find((x) => x.id === id);
      if (m === 'race' && !r) { toast('請選一場比賽'); return; }
      btn.disabled = true;
      try {
        const res = await api('/me/plan', { method: 'PUT', body: m === 'race' ? { cycle: 'race', race_id: r.id } : { cycle: 'club' } });
        await refreshMe(); paintCountdown();
        toast(res.note === 'same_as_club' ? '這場跟協會賽季同一天，課表照協會賽季' : m === 'race' ? `已改成跟 ${r.name} 排課` : '已改回協會賽季');
        // 右上角倒數是另一場：問要不要一起換
        if (res.planCycle?.kind === 'race' && !(cfg.race?.date === r.date && cfg.race?.name === r.name)) {
          if (await choose('也把右上角倒數改成這場？', `<span translate="no">${esc(r.name)}</span>`, [{ value: 'y', label: '改成倒數這場', primary: true }]) === 'y') {
            await api(`/races/${encodeURIComponent(r.id)}/primary`, { method: 'POST' });
            await api('/me/countdown', { method: 'POST', body: { mode: 'mine' } });
            await refreshMe(); paintCountdown(); toast('右上角改成倒數這場');
          }
        }
        render();
      } catch (err) { toast(err.message); btn.disabled = false; }
    };
  }
  goTo(q.get('go'));
  return cleanup;
}

/* ---------- 全季課表 #/plan/season（照我的課表週期） ---------- */
async function seasonView() {
  const c = myCycle(), all = await P.weeks(), wi = P.weekIndexOf(todayISO(), c), personal = c.kind !== 'club';
  const rows = await Promise.all(all.slice(0, 21).map(async (w, i) => {
    const n = i + 1, s = P.weekStart(n, c), e = P.addDays(s, 6), plan = w.missing ? null : await P.weekPlan(n, me.dist, me.grp);
    const key = (plan || []).filter((d) => /週二|週四|週末|週日/.test(d.d)).slice(0, 3);
    return `<a class="r wkrow" href="#/plan/${n}" data-ph="${P.PHASES[w.phase] || 'base'}"${n === wi ? ' aria-current="date"' : ''}>
      <span class="wkn"><i aria-hidden="true"></i><b>${n === 21 ? 'R' : `W${n}`}</b></span>
      <span class="wkb"><span class="tiny">${esc(w.phase || '')}${w.recovery && n !== 21 ? '・恢復週' : ''}・${md(s)}–${md(e)}${n === wi ? '・本週' : ''}</span>
        ${plan ? key.map((d) => `<span class="wkl"><span class="d">${esc(dayLabel(d.d))}</span> ${P.isRaceDay(d, n) && personal ? `比賽日：<span translate="no">${esc(c.name)}</span>` : esc(fixText(d.t))} <span class="hint">${P.isRaceDay(d, n) && personal ? '' : P.paceHint(d.t, me.dist, me.grp)}</span></span>`).join('')
          : `<span class="tiny muted">W${n} 課表還沒公告</span>`}</span>
      ${String(w.src || '').startsWith('推估') ? '<span class="pill">推估</span>' : '<span></span>'}</a>`;
  }));
  view.innerHTML = `${largeTitle('課表', `${distName(me.dist)} ${esc(me.grp)} 組・全季${personal ? `・個人週期・<span translate="no">${esc(c.name)}</span>` : ''}`)}
    ${planSeg('/plan/season')}
    <div class="chips phlegend">${[...new Set(all.map((w) => w.phase).filter(Boolean))].map((ph) => `<span class="pill" data-ph="${P.PHASES[ph] || 'base'}"><i aria-hidden="true"></i>${esc(ph)}</span>`).join('')}</div>
    <section class="card"><div class="roster">${rows.join('')}</div></section>
    <p class="tiny center">實際以教練每週公告為準；標「推估」的週次是依 2025 同期推估。</p>`;
  return () => {};
}

/* ---------- 配速與用語 #/plan/guide ---------- */
async function guideView(q) {
  const c = myCycle(), coach = createCoach({ dist: me.dist, grp: me.grp, cycle: c }), all = await P.weeks();
  const wk = P.currentWeek(new Date(), c), rows = (await P.weekPlan(wk, me.dist, me.grp)) || [];
  const used = (k) => rows.filter((r) => termsIn(fixText(r.t)).includes(k)).length;
  // 階段：連續同一階段的週次併成一段，日期照我的課表週期
  const phases = [];
  all.slice(0, 21).forEach((w, i) => { const last = phases[phases.length - 1]; if (last && last.ph === w.phase) last.to = i + 1; else phases.push({ ph: w.phase, from: i + 1, to: i + 1 }); });
  const open = GL[q.get('term')] ? q.get('term') : null;
  view.innerHTML = `${largeTitle('課表', `${distName(me.dist)} ${esc(me.grp)} 組・配速與用語`)}
    ${planSeg('/plan/guide')}
    <section class="setgroup"><h2 class="sgt">你的配速</h2><div class="card setcard">
      ${coach.paceRows().map(([k, note, sec]) => `<div class="setrow pacerow"><span class="sic">${CI.clock}</span><span class="st"><b>${esc(k)}</b><span class="tiny">${esc(note)}</span></span><b class="num">${P.fmtP(sec)}<small> /km</small></b></div>`).join('')}
    </div></section>
    <section class="setgroup"><h2 class="sgt">課表用語</h2><div class="card glist">
      ${GL_ORDER.map((k) => `<details id="t-${k}"${k === open ? ' open' : ''}><summary><b translate="no">${esc(GL[k].name)}</b></summary>
        <p style="margin:0">${esc(GL[k].zh)}</p>${used(k) ? `<a class="pill" href="#/plan?hl=${k}">本週 ${used(k)} 堂用到 ›</a>` : ''}</details>`).join('')}
    </div></section>
    <section class="setgroup"><h2 class="sgt">階段</h2><div class="card">
      <div class="roster">${phases.map((x) => `<div class="r phrow" data-ph="${P.PHASES[x.ph] || 'base'}"><i aria-hidden="true"></i><span><b>${esc(x.ph || '')}</b><span class="tiny" style="display:block">${x.from === x.to ? wkName(x.from) : `${wkName(x.from)}–${wkName(x.to)}`}・${md(P.weekStart(x.from, c))}–${md(P.addDays(P.weekStart(x.to, c), 6))}</span></span><span></span></div>`).join('')}</div>
    </div></section>
    ${group('', [row('#/plan/race?go=hr', CI.heart, '心率區間', '依年齡與安靜心率估算')])}
    <section class="card"><h3>來源與聲明</h3>
      <ul class="steps"><li>課表來源：耕跑團記事本，實際以教練每週公告為準。</li><li>標「推估」的週次是依 2025 同期推估，教練公告後會更新。</li>
        <li>心率、年齡分級、補給是一般研究（WMA、Tanaka、ACSM）的估算，不是教練規定，也不是醫療建議。</li></ul></section>`;
  if (open) goTo(`t-${open}`);
  return () => {};
}
