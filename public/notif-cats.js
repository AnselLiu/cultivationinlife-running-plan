// 耕跑團 — 通知分類登記表（worker 與 app 共用；純資料，不碰 DOM）
// locked：會員不能關推播；chip：通知中心的篩選分組；urgency／ttl：Web Push 標頭
export const CATS = {
  security:   { zh: '帳號安全',   chip: 'security',   locked: true,  urgency: 'high',   ttl: 86400 },
  change:     { zh: '活動異動',   chip: 'mine',       locked: true,  urgency: 'high',   ttl: 43200 },
  signup:     { zh: '我的報名',   chip: 'mine',       locked: false, urgency: 'normal', ttl: 43200 },
  event:      { zh: '活動與邀請', chip: 'event',      locked: false, urgency: 'normal', ttl: 86400 },
  training:   { zh: '訓練與課表', chip: 'training',   locked: false, urgency: 'low',    ttl: 86400 },
  membership: { zh: '會籍與分團', chip: 'membership', locked: false, urgency: 'normal', ttl: 86400 },
  announce:   { zh: '公告',       chip: 'announce',   locked: false, urgency: 'normal', ttl: 86400 },
  todo:       { zh: '幹部待辦',   chip: 'todo',       locked: false, urgency: 'normal', ttl: 86400 },
};
export const CHIPS = [
  { key: 'all', zh: '全部' }, { key: 'unread', zh: '未讀', q: 'unread' },
  { key: 'todo', zh: '待辦', q: 'todo', tc: 'var(--yellow)' },
  { key: 'mine', zh: '我的報名', q: 'signup,change', tc: 'var(--tile-teal)' },
  { key: 'event', zh: '活動', q: 'event', tc: 'var(--tile-blue)' },
  { key: 'training', zh: '訓練', q: 'training', tc: 'var(--tile-green)' },
  { key: 'membership', zh: '會籍', q: 'membership', tc: 'var(--tile-indigo)' },
  { key: 'announce', zh: '公告', q: 'announce', tc: 'var(--tile-purple)' },
  { key: 'security', zh: '安全', q: 'security', tc: 'var(--tile-red)' },
];
export const isCat = (c) => typeof c === 'string' && Object.hasOwn(CATS, c);
export const MUTABLE = Object.keys(CATS).filter((k) => !CATS[k].locked);
