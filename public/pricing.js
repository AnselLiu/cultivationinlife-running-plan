// 費用計算：伺服器（src/worker.js）與畫面共用同一份，畫面上的金額只是預覽，存進資料庫的以伺服器算的為準
//   報名費：選的組別價格，沒有組別就用活動費用；春酒攜伴每位同價
//   優惠：早鳥（報名日在截止日前）與協會會員，只折報名費、折到 0 為止
//   加購／團購：每項價格 × 數量
export function quote(ev, { option = null, guests = 0, items = [], membership = '', signedOn = '' } = {}) {
  const lines = [];
  const opt = (ev.options || []).find((o) => o.name === option);
  const unit = opt ? opt.price || 0 : ev.fee || 0;
  const people = 1 + Math.max(0, guests | 0);
  if (unit) lines.push({ label: opt ? opt.name : '報名費', qty: people, amount: unit * people });
  const pr = ev.pricing || {};
  let off = 0;
  const discount = (label, v) => { const d = Math.min(v, unit - off); if (d > 0) { off += d; lines.push({ label, amount: -d }); } };
  if (unit && pr.early_off && pr.early_until && signedOn && signedOn <= pr.early_until) discount('早鳥優惠', pr.early_off);
  if (unit && pr.member_off && membership === 'active') discount('協會會員優惠', pr.member_off);
  for (const it of items) {
    const def = (ev.items || []).find((x) => x.id === it.id);
    if (!def || !(it.qty > 0)) continue;
    lines.push({ label: def.name + (it.size ? `（${it.size}）` : ''), qty: it.qty, amount: (def.price || 0) * it.qty, item: true });
  }
  return { lines, total: Math.max(0, lines.reduce((n, l) => n + l.amount, 0)) };
}
// 這個活動有沒有要收錢（決定要不要顯示繳費相關的畫面）
export const charges = (ev) => !!(ev.fee || (ev.options || []).some((o) => o.price) || (ev.items || []).some((i) => i.price));
