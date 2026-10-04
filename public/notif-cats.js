// 耕跑團 — 通知分類登記表（worker 與 app 共用；純資料，不碰 DOM）
// locked：會員不能關推播；chip：通知中心的篩選分組；urgency／ttl：Web Push 標頭
// digest：選「每日摘要」的人，這一類的推播能不能延到摘要（判斷在 src/ops.js 的 holdable）
//   false＝一律即時｜true＝可以延後｜'timed'＝帶了活動時間（latest）而且來得及才延後
export const CATS = {
  security:   { zh: '帳號安全',   chip: 'security',   locked: true,  urgency: 'high',   ttl: 86400, digest: false },
  change:     { zh: '活動異動',   chip: 'mine',       locked: true,  urgency: 'high',   ttl: 43200, digest: 'timed' },
  signup:     { zh: '我的報名',   chip: 'mine',       locked: false, urgency: 'normal', ttl: 43200, digest: 'timed' },
  event:      { zh: '活動與邀請', chip: 'event',      locked: false, urgency: 'normal', ttl: 86400, digest: true },
  training:   { zh: '訓練與課表', chip: 'training',   locked: false, urgency: 'low',    ttl: 86400, digest: true },
  membership: { zh: '會籍與分團', chip: 'membership', locked: false, urgency: 'normal', ttl: 86400, digest: true },
  announce:   { zh: '公告',       chip: 'announce',   locked: false, urgency: 'normal', ttl: 86400, digest: true },
  todo:       { zh: '幹部待辦',   chip: 'todo',       locked: false, urgency: 'normal', ttl: 86400, digest: false },
  ops:        { zh: '系統狀態',   chip: 'todo',       locked: true,  urgency: 'high',   ttl: 43200, digest: false },
  report:     { zh: '幹部週報',   chip: 'todo',       locked: false, urgency: 'low',    ttl: 86400, digest: true },
};
export const CHIPS = [
  { key: 'all', zh: '全部' }, { key: 'unread', zh: '未讀', q: 'unread' },
  { key: 'todo', zh: '待辦', q: 'todo,ops,report', tc: 'var(--yellow)' },
  { key: 'mine', zh: '我的報名', q: 'signup,change', tc: 'var(--tile-teal)' },
  { key: 'event', zh: '活動', q: 'event', tc: 'var(--tile-blue)' },
  { key: 'training', zh: '訓練', q: 'training', tc: 'var(--tile-green)' },
  { key: 'membership', zh: '會籍', q: 'membership', tc: 'var(--tile-indigo)' },
  { key: 'announce', zh: '公告', q: 'announce', tc: 'var(--tile-purple)' },
  { key: 'security', zh: '安全', q: 'security', tc: 'var(--tile-red)' },
];
export const isCat = (c) => typeof c === 'string' && Object.hasOwn(CATS, c);
export const MUTABLE = Object.keys(CATS).filter((k) => !CATS[k].locked);
