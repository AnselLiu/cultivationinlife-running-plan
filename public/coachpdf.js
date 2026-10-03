// 耕跑團 PWA — coachpdf.js：課表 PDF（只在分享面板選 PDF 時才載入）
//   搬自 coach.html 2179-2354：畫在 canvas（A4、系統字型）→ JPEG → 自己組 PDF；不用外部套件，也不連到別的網站
//   logo 用 App 自己的 /icons/icon-192.png；品牌改成「耕跑團」
//   個人數字（肝醣超補、比賽早餐與咖啡因的克數、個人心率）只有分享面板打開「包含我的補給與心率數字」時才會出現：
//     呼叫端決定傳進來的 coach 有沒有身體資料；體重本身從不印出
//   英文介面：每一段文字先經過 i18n.js 的 t() 再量寬度、換行
import { KIND_LABEL as KIND, addDays, fmtP } from './plan.js';
import { EST_LINE, xdRows } from './coachcalc.js';
import { lang, t } from './i18n.js';

const EN = () => lang === 'en';
const T = (s) => t(String(s));
const PDF_C = { ink: '#0B1B33', ink2: '#5B6678', ink3: '#A7B0BF', line: '#E3E7EF', accent: '#1C4698', page: '#FFFFFF',
  kind: { easy: ['#4F7A12', '#F2F4F8', '#9CC23A'], quality: ['#B64400', '#F2F4F8', '#FF9500'], long: ['#1C4698', '#F2F4F8', '#1C4698'], rest: ['#5B6678', '#F2F4F8', '#C3CAD6'], strength: ['#6D45B0', '#F2F4F8', '#9B6FE0'], race: ['#FFFFFF', '#E63946', '#E63946'] },
  phase: { 準備期: '#EDE030', 基礎期: '#B9D04C', 強化期: '#5E9A6B', 巔峰期: '#2F6DB5', 比賽期: '#1C4698', 賽事週: '#E63946', 賽後恢復: '#C3CAD6' } };
const PDF_FF = '-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang TC","Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei",Arial,sans-serif';
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function wrapText(ctx, text, maxW) {
  const out = []; let line = '';
  for (const ch of String(text)) {
    const tt = line + ch;
    if (ctx.measureText(tt).width > maxW && line) {
      const cut = Math.max(line.lastIndexOf(' '), line.lastIndexOf('/'), line.lastIndexOf('+'));
      if (cut > line.length * 0.55 && cut < line.length - 1) { out.push(line.slice(0, cut + 1).trimEnd()); line = line.slice(cut + 1) + ch; }
      else { out.push(line); line = ch; }
    } else line = tt;
  }
  if (line) out.push(line); return out.length ? out : [''];
}
async function logo() {
  const img = new Image();
  img.src = '/icons/icon-192.png';
  try { await img.decode(); return img; } catch { return null; }
}

// coach：createCoach(...) 的結果；opts：{ detail, personal, weeks }；回傳 application/pdf 的 Blob
export async function buildPlanPdf(coach, opts = {}) {
  const DET = !!opts.detail, WEEKS = opts.weeks || [], S = coach.S;
  const { planTitle, grpName, grpInfo, goalPace, w1Monday, raceDay, paceRows, planDays, dispText, dispDay, paceNotes, kindLabel, weekLabel, weekStart, wkName, mdw, raceDayPlan, raceName } = coach;
  try { if (document.fonts?.ready) await document.fonts.ready; } catch {}
  const LOGO = await logo();
  const W = 595.28, H = 841.89, M = 36, SC = 2.5, CW = W - 2 * M, TOP = M + 22, BOT = H - M - 16;
  const pages = []; let ctx, y;
  const font = (sz, wt) => `${wt || 400} ${sz}px ${PDF_FF}`;
  function newPage() {
    const c = document.createElement('canvas'); c.width = Math.round(W * SC); c.height = Math.round(H * SC);
    ctx = c.getContext('2d'); ctx.scale(SC, SC); ctx.fillStyle = PDF_C.page; ctx.fillRect(0, 0, W, H); ctx.textBaseline = 'alphabetic';
    pages.push({ c, ctx }); y = TOP;
  }
  const txt = (s, x, yy, sz, col, wt, align) => { s = String(s).replace(/[’‘]/g, "'").replace(/[“”]/g, '"'); ctx.font = font(sz, wt); ctx.fillStyle = col; ctx.textAlign = align || 'left'; ctx.fillText(s, x, yy); ctx.textAlign = 'left'; };
  const pill = (s, x, yy, sz, fg, bg) => { ctx.font = font(sz, 600); const w = ctx.measureText(s).width + sz * 1.1; rr(ctx, x, yy - sz * 1.05, w, sz * 1.55, sz * 0.77); ctx.fillStyle = bg; ctx.fill(); txt(s, x + sz * 0.55, yy, sz, fg, 600); return w; };
  // 跑者與比賽名稱不翻譯（英文介面只翻「課表」兩個字）
  const g = grpInfo(), fm = S.dist === 'fm', mp = goalPace(), title = EN() ? `${coach.runnerName()}@${raceName()} ${T('課表')}` : planTitle(), grp = T(grpName(g[0]));
  const LIST_SEP = EN() ? ', ' : '、';

  /* 封面區：品牌、標題、組別、W1 與比賽日、目標配速 */
  newPage();
  const hh = 118; const grd = ctx.createLinearGradient(M + CW * 0.45, y - 40, M + CW, y + hh + 60);
  [[0, '#FFFFFF'], [0.38, '#FFFFFF'], [0.5, '#FBF6A5'], [0.58, '#F2EC4A'], [0.68, '#B9D04C'], [0.76, '#5E9A6B'], [0.84, '#1E5AA0'], [0.93, '#0C4177'], [1, '#041525']].forEach(([o, c]) => grd.addColorStop(o, c));
  rr(ctx, M, y, CW, hh, 14); ctx.fillStyle = grd; ctx.fill(); ctx.strokeStyle = PDF_C.line; ctx.lineWidth = 0.8; ctx.stroke();
  if (LOGO) {
    const ar = LOGO.naturalHeight / LOGO.naturalWidth;
    ctx.save(); rr(ctx, M, y, CW, hh, 14); ctx.clip(); ctx.globalAlpha = 0.08; ctx.drawImage(LOGO, M + CW * 0.3, y - 18, 150, 150 * ar); ctx.restore();
    ctx.drawImage(LOGO, M + 16, y + 16, 50, 50 * ar);
  }
  txt(`${T('耕跑團 課表')}・${grp}${DET ? `・${T('詳細版')}` : ''}`, M + 78, y + 28, 10, PDF_C.accent, 700);
  const fit = (s, max, sz, min, wt) => { while (sz > min) { ctx.font = font(sz, wt); if (ctx.measureText(s).width <= max) break; sz -= 0.5; } return sz; }; const TWD = CW - 78 - 140;
  { const sz = fit(title, TWD, 22, 13, 800); ctx.font = font(sz, 800); txt(wrapText(ctx, title, TWD)[0], M + 78, y + 56, sz, PDF_C.ink, 800); }
  { const t1 = `${grp}${EN() ? ` (SUB ${g[1]}) · ` : `（SUB ${g[1]}）・`}${T(`每週 ${S.days} 天`)}${EN() ? ' · ' : '・'}${T(S.club ? '參加週四團練' : '週四自己練')}`; txt(t1, M + 78, y + 80, fit(t1, TWD, 10.5, 7.5, 500), PDF_C.ink2, 500); }
  { const t2 = `${T(`W1 ${mdw(w1Monday())} 開始`)}　｜　${T(`比賽日 ${mdw(raceDay())}`)}${S.start ? ` ${T(`${S.start} 起跑`)}` : ''}`; txt(t2, M + 78, y + 98, fit(t2, TWD, 10.5, 7.5, 500), PDF_C.ink2, 500); }
  rr(ctx, M + CW - 128, y + 18, 112, 82, 12); ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill();
  txt(T(fm ? 'MP 全馬配速' : 'HMP 半馬配速'), M + CW - 72, y + 38, 9.5, PDF_C.ink2, 600, 'center');
  txt(fmtP(mp), M + CW - 72, y + 74, 32, PDF_C.accent, 800, 'center');
  txt(T('/km（區間中點）'), M + CW - 72, y + 91, 8.5, PDF_C.ink2, 500, 'center');
  y += hh + 14;
  const pr = paceRows(), cw = (CW - 4 * 6) / 5;
  pr.forEach((p, i) => { const x = M + i * (cw + 6); rr(ctx, x, y, cw, 40, 8); ctx.fillStyle = '#F2F4F8'; ctx.fill(); ctx.font = font(8.5, 500); txt(wrapText(ctx, T(p[0]), cw - 14)[0], x + 9, y + 15, 8.5, PDF_C.ink2, 500); txt(`${fmtP(p[2])} /km`, x + 9, y + 32, 13, PDF_C.ink, 700); });
  y += 52;
  let lx = M; for (const k of ['easy', 'quality', 'long', 'rest', 'strength', 'race']) { const c = PDF_C.kind[k]; lx += pill(T(KIND[k]), lx, y + 8, 8.5, c[0], c[1]) + 6; }
  pill(T('可省略'), lx, y + 8, 8.5, '#AEAEB2', '#F2F4F8');
  txt(T('配速後的「≈」是依你的組別換算的實際配速'), M + CW, y + 8, 8.5, PDF_C.ink3, 400, 'right');
  y += 22;

  /* 每一週 */
  const X1 = M + 10, X2 = M + (EN() ? 92 : 84), X3 = M + (EN() ? 152 : 136), TW = M + CW - X3 - 6;
  let anyEst = false;
  for (const w of WEEKS) {
    const list = planDays(w) || [];
    const rows = list.map((x) => {
      ctx.font = font(10, 400); const lines = wrapText(ctx, T(dispText(x)), TW);
      const p = paceNotes(x.t); const sub = []; if (p.length) sub.push([`≈ ${p.join(LIST_SEP)}/km`, PDF_C.accent, 600]);
      x.notes.forEach((n) => sub.push([T(n), PDF_C.ink3, 400]));
      ctx.font = font(8.5, 400); const subL = sub.flatMap((s) => wrapText(ctx, s[0], TW).map((l) => [l, s[1], s[2]]));
      ctx.font = font(9.5, 600); const dl = wrapText(ctx, T(dispDay(x)), X2 - X1 - 8);
      const det = []; let detH = 0;
      if (DET) {
        const LW = EN() ? 64 : 52;
        for (const r of xdRows(coach, x)) {
          if (r.label === '類型' || r.label === '你的配速') continue;
          if (r.est) anyEst = true;
          ctx.font = font(8.5, 400);
          wrapText(ctx, T(r.value) + (r.est ? T('〔估算〕') : ''), TW - LW - 16).forEach((l, j) => det.push([j ? '' : T(r.label), l]));
        }
        if (det.length) detH = 8 + det.length * 11.5 + 4;
      }
      return { x, lines, subL, dl, det, detH, h: Math.max(19, 7 + Math.max(lines.length * 13 + subL.length * 11.5 + detH, dl.length * 11.5 + 2)) };
    });
    const pc = PDF_C.phase[w.phase] || '#A9B8B2';
    if (!rows.length) {
      // 還沒公告的週次（W1）：只畫一行說明
      if (y + 50 > BOT) newPage();
      rr(ctx, M, y, CW, 40, 10); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.strokeStyle = PDF_C.line; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.fillStyle = pc; rr(ctx, M + 10, y + 15, 4, 9, 2); ctx.fill();
      txt(wkName(w.n), M + 20, y + 23.5, 12, PDF_C.ink, 700);
      txt(T(`${wkName(w.n)} 課表還沒公告`), M + 64, y + 23.5, 10, PDF_C.ink2, 500);
      txt(`${T(mdw(weekStart(w.n)))} – ${T(mdw(addDays(weekStart(w.n), 6)))}`, M + CW - 10, y + 23.5, 9.5, PDF_C.ink2, 500, 'right');
      y += 47; continue;
    }
    let ri = 0, part = 0;
    while (ri < rows.length) {
      const avail = BOT - y - 34; let take = 0, hsum = 0;
      while (ri + take < rows.length && hsum + rows[ri + take].h <= avail) { hsum += rows[ri + take].h; take++; }
      const remainAll = rows.slice(ri).reduce((a, r) => a + r.h, 0);
      if (take === 0 || (part === 0 && take < rows.length && remainAll <= BOT - TOP - 34 && !DET)) { if (y > TOP + 1) { newPage(); continue; } take = Math.max(1, take); hsum = rows.slice(ri, ri + take).reduce((a, r) => a + r.h, 0); }
      const bh = 28 + hsum + 6;
      rr(ctx, M, y, CW, bh, 10); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.strokeStyle = PDF_C.line; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.save(); rr(ctx, M, y, CW, 24, 10); ctx.clip(); ctx.fillStyle = '#F2F4F8'; ctx.fillRect(M, y, CW, 24); ctx.restore();
      ctx.fillStyle = pc; rr(ctx, M + 10, y + 8, 4, 9, 2); ctx.fill();
      txt(wkName(w.n), M + 20, y + 16.5, 12, PDF_C.ink, 700);
      ctx.font = font(12, 700); const wx = M + 20 + ctx.measureText(wkName(w.n)).width + 8;
      txt(T(weekLabel(w)) + (part ? T('（續）') : ''), wx, y + 16.5, 10, PDF_C.ink, 600);
      txt(`${T(mdw(weekStart(w.n)))} – ${T(mdw(addDays(weekStart(w.n), 6)))}`, M + CW - 10, y + 16.5, 9.5, PDF_C.ink2, 500, 'right');
      let ry = y + 28;
      rows.slice(ri, ri + take).forEach((r, i) => {
        const k = r.x.opt ? ['#AEAEB2', '#F2F4F8', '#D2D2D7'] : PDF_C.kind[r.x.k];
        if (i) { ctx.strokeStyle = PDF_C.line; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(X1, ry); ctx.lineTo(M + CW - 8, ry); ctx.stroke(); }
        ctx.fillStyle = k[2]; rr(ctx, X1 - 4, ry + 5, 3, r.h - 10, 1.5); ctx.fill();
        r.dl.forEach((l, j) => txt(l, X1 + 4, ry + 14 + j * 11.5, 9.5, r.x.opt ? PDF_C.ink3 : PDF_C.ink, 600));
        pill(T(kindLabel(r.x)), X2, ry + 14, 8, k[0], k[1]);
        let ty = ry + 14;
        r.lines.forEach((l) => {
          txt(l, X3, ty, 10, r.x.opt ? PDF_C.ink3 : PDF_C.ink, 400);
          if (r.x.opt) { ctx.font = font(10, 400); const lw = ctx.measureText(l).width; ctx.strokeStyle = PDF_C.ink3; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(X3, ty - 3.4); ctx.lineTo(X3 + lw, ty - 3.4); ctx.stroke(); }
          ty += 13;
        });
        r.subL.forEach((s) => { txt(s[0], X3, ty - 1.5, 8.5, s[1], s[2]); ty += 11.5; });
        if (r.det.length) {
          const LW = EN() ? 64 : 52, bx = X3 - 4, by = ty - 6; rr(ctx, bx, by, M + CW - 8 - bx, r.detH - 2, 6); ctx.fillStyle = '#F6F8FB'; ctx.fill();
          let dy = by + 13; r.det.forEach(([kk, v]) => { if (kk) txt(kk, bx + 8, dy, 8, PDF_C.ink2, 700); txt(v, bx + 8 + LW, dy, 8.5, PDF_C.ink, 400); dy += 11.5; });
        }
        ry += r.h;
      });
      y += bh + 7; ri += take; part++;
      if (ri < rows.length) newPage();
    }
  }

  /* 比賽日建議頁 */
  {
    const rp = raceDayPlan(); newPage();
    rr(ctx, M, y, CW, 56, 12); const gr = ctx.createLinearGradient(M, y, M + CW, y); gr.addColorStop(0, '#1C4698'); gr.addColorStop(1, '#0B1B33'); ctx.fillStyle = gr; ctx.fill();
    ctx.fillStyle = '#FDF36D'; rr(ctx, M, y, 6, 56, 3); ctx.fill();
    txt(T('比賽日計劃'), M + 18, y + 22, 10, '#FDF36D', 700);
    { const tt = `${raceName()} · ${T(mdw(raceDay()))}${S.start ? ` ${S.start}` : ''}`; ctx.font = font(17, 800); let sz = 17; while (sz > 11 && ctx.measureText(tt).width > CW - 150) { sz -= 0.5; ctx.font = font(sz, 800); } txt(tt, M + 18, y + 44, sz, '#FFFFFF', 800); }
    txt(`${fmtP(mp)}/km`, M + CW - 14, y + 36, 20, '#FDF36D', 800, 'right'); txt(T('目標配速'), M + CW - 14, y + 49, 8, '#D9E2F5', 500, 'right');
    y += 70;
    const sec = (s) => { txt(T(s), M, y + 10, 11, PDF_C.accent, 800); y += 18; };
    sec('當天時間表');
    const DX = EN() ? 186 : 160;
    rp.timeline.forEach(([tm, a, b], i) => {
      ctx.font = font(9.5, 400); const bl = wrapText(ctx, T(b).replace(/[’‘]/g, "'"), CW - DX - 10); const h = Math.max(20, 6 + bl.length * 12.5);
      if (i % 2 === 0) { ctx.fillStyle = '#F6F8FB'; ctx.fillRect(M, y, CW, h); }
      txt(T(tm), M + 8, y + 14, 10.5, PDF_C.accent, 800); txt(T(a), M + 70, y + 14, 9.5, PDF_C.ink, 700); bl.forEach((l, j) => txt(l, M + DX, y + 14 + j * 12.5, 9.5, PDF_C.ink2, 400)); y += h;
    });
    y += 12;
    const colW = (CW - 16) / 2;
    txt(T('配速分段（平均配速）'), M, y + 10, 11, PDF_C.accent, 800);
    let yy = y + 30; rp.splits.forEach((s, i) => { if (i % 2 === 0) { ctx.fillStyle = '#F6F8FB'; ctx.fillRect(M, yy - 12, colW, 17); } txt(T(s[0]), M + 8, yy, 9.5, PDF_C.ink, 600); txt(s[1], M + colW * 0.55, yy, 9.5, PDF_C.ink, 700, 'right'); if (s[2]) txt(s[2], M + colW - 8, yy, 9, PDF_C.ink3, 500, 'right'); yy += 17; });
    const xg = M + colW + 16; txt(T('能量膠時間表'), xg, y + 10, 11, PDF_C.accent, 800);
    ctx.font = font(8.5, 400); let yg = y + 28; wrapText(ctx, T(rp.gelNote), colW).forEach((l) => { txt(l, xg, yg, 8.5, PDF_C.ink2, 400); yg += 11; }); yg += 4;
    rp.gels.forEach((gq) => { ctx.fillStyle = '#FDF36D'; rr(ctx, xg, yg - 9, 9, 12, 3); ctx.fill(); txt(`${gq[0]}′`, xg + 16, yg, 9.5, PDF_C.ink, 700); txt(`≈ ${gq[1]} km`, xg + 56, yg, 9.5, PDF_C.ink2, 500); if (gq[2]) txt(gq[2], xg + colW - 8, yg, 9, PDF_C.ink3, 500, 'right'); yg += 16; });
    y = Math.max(yy, yg) + 10;
    sec('提醒');
    [...rp.night, ...rp.tips].forEach((s) => { ctx.font = font(9.5, 400); const tl = wrapText(ctx, T(s), CW - 16); if (y + tl.length * 12.5 + 5 > BOT) newPage(); ctx.fillStyle = PDF_C.accent; ctx.beginPath(); ctx.arc(M + 4, y + 10.5, 1.8, 0, 7); ctx.fill(); tl.forEach((l, j) => txt(l, M + 12, y + 14 + j * 12.5, 9.5, PDF_C.ink, 400)); y += tl.length * 12.5 + 5; });
    y += 6; txt(T('一般運動營養與比賽建議，請依個人狀況和教練指示調整。'), M, y + 8, 8.5, PDF_C.ink3, 400); y += 22;
  }

  /* 說明 */
  const notes = ['課表來源：耕跑團記事本，依比賽日期往回套用 20 週；實際以教練每週公告為準。',
    '「可省略」是每週天數不夠時優先省略的輕鬆跑；質量課、長跑和比賽都不省略。錯過的課不要擠到同一天補。',
    '配速換算：目標配速＝組別區間中點 ÷ 距離；「≈」後的數字由慢到快。',
    ...(anyEst || (opts.personal && S.age != null) ? [EST_LINE] : []),
    '這份課表只負責整理和換算，不是醫療建議。身體不適、受傷或生病時，請先休息，並跟教練討論。'];
  ctx.font = font(8.5, 400); const nl = notes.flatMap((n) => wrapText(ctx, `・${T(n)}`, CW - 24));
  const nh = 26 + nl.length * 12; if (y + nh > BOT) newPage();
  rr(ctx, M, y, CW, nh, 10); ctx.fillStyle = '#F2F4F8'; ctx.fill(); txt(T('說明'), M + 12, y + 17, 10, PDF_C.ink, 700);
  nl.forEach((l, i) => txt(l, M + 12, y + 32 + i * 12, 8.5, PDF_C.ink2, 400));

  /* 每頁頁首、頁碼 */
  const N = pages.length, today = new Date();
  pages.forEach((p, i) => {
    ctx = p.ctx;
    ctx.font = font(8.5, 500);
    txt(wrapText(ctx, `${T('耕跑團 課表')}・${grp}　${title}`, CW - 110)[0], M, M + 6, 8.5, PDF_C.ink3, 500);
    txt(`${T('製表')} ${T(mdw(today))}`, M + CW, M + 6, 8.5, PDF_C.ink3, 500, 'right');
    ctx.strokeStyle = PDF_C.line; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(M, M + 11); ctx.lineTo(M + CW, M + 11); ctx.stroke();
    txt(`${i + 1} / ${N}`, W / 2, H - M + 4, 8.5, PDF_C.ink3, 500, 'center');
  });
  const imgs = [];
  for (const p of pages) {
    const blob = await new Promise((r) => p.c.toBlob(r, 'image/jpeg', 0.9));
    imgs.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: p.c.width, h: p.c.height });
    p.c.width = p.c.height = 0;   // 釋放記憶體（iPhone 上整季 PDF 有十幾頁）
  }
  return pdfFromJpegs(imgs, W, H, title);
}

// 把每一頁的 JPEG 包成 PDF 1.4（每頁一張圖）
export function pdfFromJpegs(imgs, W, H, title) {
  const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (id, fn) => { offs[id] = len; push(`${id} 0 obj\n`); fn(); push('\nendobj\n'); };
  const hex = (s) => `<FEFF${Array.from(s).map((c) => { const cp = c.codePointAt(0); if (cp > 0xFFFF) { const v = cp - 0x10000; return ((0xD800 + (v >> 10)).toString(16) + (0xDC00 + (v & 0x3FF)).toString(16)).toUpperCase(); } return cp.toString(16).padStart(4, '0').toUpperCase(); }).join('')}>`;
  push('%PDF-1.4\n'); push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  const n = imgs.length, total = 4 + 3 * n;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${imgs.map((_, i) => `${4 + 3 * i} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title ${hex(title)} /Producer ${hex('耕跑團')} >>`));
  imgs.forEach((im, i) => {
    const p = 4 + 3 * i, cs = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
    obj(p + 1, () => push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
    obj(p + 2, () => { push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`); push(im.bytes); push('\nendstream'); });
  });
  const xref = len; let x = `xref\n0 ${total}\n0000000000 65535 f \n`; for (let i = 1; i < total; i++) x += `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  push(`${x}trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
