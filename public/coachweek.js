// 耕跑團 PWA — coachweek.js：單週課表頁的加強功能（課表畫好、閒下來才載入；全季、賽事準備等完整的課表教練在 coach.js）
//   課表用語可以點、每一列的「詳細內容」、全部展開、每週天數與跑量的提醒、左右滑動換週、?hl=用語 標示本週用到的課
//   身體資料（年齡、安靜心率）只從這台裝置的 cil-coach 讀，不會送到伺服器
import { coachPrefs, esc, fixText, me, setCoachPrefs } from './app.js';
import * as P from './plan.js';
import { createCoach, EST_LINE, GL, termSpans, termsIn, xdRows } from './coachcalc.js';

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

export async function weekExtras(root, { week, cycle, other, rows, venue = '', hl = null, wi, alive = () => true }) {
  const coach = await coachOf(cycle, venue);
  // 等模組與課表資料的這段時間已經換週或換頁：不碰新畫面（不然會把上一週的內容寫到這一週）
  if (!alive()) return () => {};
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
      ${x.zone ? '<a class="tiny xdlink" href="#/plan/setup?go=body">到課表設定填年齡就會顯示心率 ›</a>' : ''}</dd></div>`).join('')}</dl>
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
      <a class="btn ghost block" href="#/plan/guide?term=${key}">看配速與用語 ›</a>
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

  days.dataset.extras = String(week);   // 加強功能已經接上（測試等這個）
  return () => { close(); off.splice(0).forEach((f) => f()); };
}
