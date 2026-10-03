// 耕跑團 PWA — i18n.js：中英文切換
//   介面文字寫在程式裡是中文；選英文時，這裡把畫面上的介面文字換成英文（字典在 i18n-en.js，用到才載入）
//   團員自己寫的內容（活動標題、姓名、地點、備註）標了 translate="no"，不會被翻
//   做法：整句對照 → 動態句型（人數、日期、倒數…）→ 句子裡的已知片段；新畫上的內容由 MutationObserver 自動處理
const KEY = 'cil-lang';
export const lang = (() => { try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; } })();
export function setLang(l) {
  try { l === 'en' ? localStorage.setItem(KEY, 'en') : localStorage.removeItem(KEY); } catch {}
  location.reload();
}

const CJK = /[㐀-鿿（-？、-】]/;
const WD = { 日: 'Sun', 一: 'Mon', 二: 'Tue', 三: 'Wed', 四: 'Thu', 五: 'Fri', 六: 'Sat' };
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MO3 = MON.map((m) => m.slice(0, 3));
// 動態句型：數字、日期、倒數等（先於片段替換）
const PATTERNS = [
  [/^(\d{4}) 年 (\d{1,2}) 月$/, (_, y, m) => `${MON[m - 1]} ${y}`],
  [/^(\d{1,2}) 月 (\d{1,2}) 日・週(.)$/, (_, m, d, w) => `${WD[w]}, ${MO3[m - 1]} ${d}`],
  [/^(\d{1,2})月(\d{1,2})日 星期(.)$/, (_, m, d, w) => `${WD[w]}, ${MON[m - 1]} ${d}`],
  [/(\d{1,2})\/(\d{1,2})（([日一二三四五六])）/g, (_, m, d, w) => `${WD[w]} ${m}/${d}`],
  [/^(\d{1,2})月$/, (_, m) => MO3[m - 1]], [/(\d{1,2})月/g, (_, m) => MO3[m - 1] || `${m}`],
  [/(\d{1,2}) 月 (\d{1,2}) 日/g, (_, m, d) => `${MO3[m - 1]} ${d}`],
  [/^週([日一二三四五六])$/, (_, w) => WD[w]],
  [/週([日一二三四五六])/g, (_, w) => WD[w]],
  [/^天到(.+)$/, (_, r) => `days to ${r}`],
  ['FRAG'],
  [/還有 (\d+) 天/g, '$1 days to go'],
  [/(\d+) 分鐘前/g, '$1 min ago'], [/(\d+) 小時前/g, '$1 h ago'], [/(\d+) 天前/g, '$1 d ago'],
  [/NT\$([\d,]+) 起/g, 'from NT$$$1'],
  [/([\d.]+) 公里/g, '$1 km'], [/([\d.]+) 公尺/g, '$1 m'], [/([\d.]+) 毫秒/g, '$1 ms'], [/([\d.]+) 秒/g, '$1 s'],
  [/(\d+) 人/g, '$1 people'], [/(\d+) 位/g, '$1'], [/(\d+) 堂/g, '$1 sessions'], [/(\d+) 次/g, '$1×'], [/(\d+) 筆/g, '$1'],
  [/(\d+) 件/g, '$1 pcs'], [/(\d+) 場/g, '$1 events'], [/(\d+) 週/g, '$1 wk'], [/(\d+) 天/g, '$1 days'], [/(\d+) 則/g, '$1'], [/(\d+) 個/g, '$1'],
  [/(?:^|\s)([A-Z]) 組/g, ' group $1'], [/推估：(\d{4}) W(\d+)/g, 'Estimated from $1 W$2'],
  [/([A-Za-z])\s*或\s*([A-Za-z])/g, '$1 or $2'],
  [/第 (\d+) 桌/g, 'Table $1'], [/(\d+) 時/g, '$1:00'], [/(\d+) 年/g, '$1 yr'], [/(\d+) 組/g, 'group $1'],
];
let dict = null, frag = null, inner = {};
const tr = (s) => {
  if (!CJK.test(s)) return s;
  const lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0], core = s.trim();
  if (dict[core] != null) return lead + dict[core] + tail;
  let out = core;
  // 先換已知片段（含數字的片段如「・30 天內到期」要先比對），再套數字與日期句型
  // 日期、星期、月份句型先換（避免被片段拆開），再換已知片段（含數字的片段如「・30 天內到期」），最後換數量單位
  for (const [re, to] of PATTERNS) {
    if (!CJK.test(out)) break;
    out = re === 'FRAG' ? out.replace(frag, (m) => ` ${inner[m] ?? dict[m]} `) : out.replace(re, to);
  }
  out = out
    .replace(/，/g, ', ').replace(/。/g, '. ').replace(/：/g, ': ').replace(/；/g, '; ').replace(/（/g, ' (').replace(/）/g, ') ').replace(/、/g, ', ')
    .replace(/[「『]/g, ' “').replace(/[」』]/g, '” ').replace(/・/g, ' · ').replace(/？/g, '? ').replace(/！/g, '! ')
    .replace(/\s{2,}/g, ' ').replace(/ ([,.;:!?)”])/g, '$1').replace(/([(“]) /g, '$1');
  return lead + out.trim() + tail;
};
const SKIP = 'script,style,textarea,code,[translate="no"],[contenteditable]';
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
function walk(root) {
  if (!root) return;
  if (root.nodeType === 3) { if (!root.parentElement?.closest(SKIP)) { const t = tr(root.nodeValue); if (t !== root.nodeValue) root.nodeValue = t; } return; }
  if (root.nodeType !== 1 || root.closest?.(SKIP)) return;
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest(SKIP) || !CJK.test(n.nodeValue) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes = []; while (it.nextNode()) nodes.push(it.currentNode);
  for (const n of nodes) { const t = tr(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; }
  for (const el of [root, ...root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))]) {
    if (el.closest(SKIP)) continue;
    for (const a of ATTRS) { const v = el.getAttribute?.(a); if (v && CJK.test(v)) el.setAttribute(a, tr(v)); }
    if (el.tagName === 'INPUT' && /^(button|submit)$/.test(el.type) && CJK.test(el.value)) el.value = tr(el.value);
  }
}
export const t = (s) => (dict ? tr(String(s)) : String(s));
export async function init() {
  if (lang !== 'en') return;
  const mod = await import('./i18n-en.js');
  dict = mod.default; inner = mod.inner || {};
  // 句子裡的片段：至少兩個字才替換（單字只做整句對照，避免誤翻）；同一個詞在句中用小寫的說法（inner）
  const keys = [...new Set([...Object.keys(dict), ...Object.keys(inner)])].filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
  frag = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  document.documentElement.lang = 'en';
  walk(document.body);
  document.title = tr(document.title);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) walk(n); }).observe(document.body, { childList: true, subtree: true });
  const c = window.confirm.bind(window), a = window.alert.bind(window);
  window.confirm = (msg) => c(tr(String(msg)));
  window.alert = (msg) => a(tr(String(msg)));
}
