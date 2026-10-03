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
const DN = { 全馬: 'marathon', 半馬: 'half' };
// 動態句型：數字、日期、倒數等（先於片段替換）
const PATTERNS = [
  // 課表與課表週期（整句，要在日期句型之前）
  [/^你的 W1 從 (\d{1,2})\/(\d{1,2})（([日一二三四五六])）開始，還有 (\d+) 天$/, (_, m, d, w, n) => `Your W1 starts ${WD[w]} ${m}/${d} — ${n} days to go`],
  [/^W1 (\d{1,2})\/(\d{1,2})（([日一二三四五六])）開始，還有 (\d+) 天$/, (_, m, d, w, n) => `W1 starts ${WD[w]} ${m}/${d} — ${n} days to go`],
  [/^這是協會賽季 W(\d+)，只能看$/, 'This is club season W$1 — view only'],
  [/^協會 W(\d+) 公告（你的課表照個人週期排，內容可能不同）$/, 'Club W$1 posts (your plan follows your personal cycle, so the content may differ)'],
  [/^賽前 (\d+) 天$/, '$1 days to race'],
  [/^每週 (\d+) 天$/, '$1 days/week'],
  [/^(\d+) 分鐘$/, '$1 min'],
  [/^離比賽只剩 (\d+) 週左右，課表從 W(\d+) 接著跑；前面的週次可以參考，不用回頭補。$/, 'About $1 weeks to go — pick up the plan at W$2. Earlier weeks are for reference; don’t try to make them up.'],
  [/^目前每週跑量偏低，([A-Z]) 組的課表大約需要每週 (\d+)K 以上的基礎。可以考慮先選慢一組，練幾週再調整。$/, 'Your weekly mileage is on the low side — Group $1 assumes a base of about $2K/week. Consider starting one group slower and moving up after a few weeks.'],
  [/^([A-Z]) 組的跑量較大，每週 4 天以下比較難完成，建議至少 5 天。$/, 'Group $1 carries high volume — 4 days or fewer a week makes it hard to complete. At least 5 days is recommended.'],
  [/^現在是 W(\d+)，從這週接著跑$/, 'You are in W$1 now — pick up the plan from this week'],
  [/^已改成跟 (.+) 排課$/, 'Your plan now follows $1'],
  [/^本週 (\d+) 堂用到 ›$/, '$1 sessions this week ›'],
  [/^已選 ([A-Z]) 組，按儲存才會生效$/, 'Group $1 selected — tap Save to apply'],
  [/^本週 (\d+) 堂用到$/, '$1 sessions this week use it'],
  [/^W(\d+) 課表還沒公告$/, 'W$1 plan not posted yet'],
  [/^年齡分級：目標 ([\d.]+)%(?:，目前 ([\d.]+)%)?$/, (_, a, b) => `Age grade: goal ${a}%${b ? `, current ${b}%` : ''}`],
  [/^已上傳 (\d+) 筆離線時的訓練紀錄$/, 'Uploaded $1 training logs saved while offline'],
  // 舊版課表教練資料搬移
  [/^已上傳 (\d+) 筆・已存在 (\d+) 筆・其他週期 (\d+) 筆・對不到 (\d+) 筆$/, 'Uploaded $1 · already there $2 · other cycles $3 · no match $4'],
  [/^・略過 (\d+) 筆（每天最多 5 筆）$/, ' · skipped $1 (at most 5 a day)'],
  [/^另外 (\d+) 筆是跟「(\d{1,2})\/(\d{1,2})（([日一二三四五六])） 的比賽」排的課表，也一起上傳$/, (_, n, m, d, w) => `Also upload ${n} check-ins planned for the ${WD[w]} ${m}/${d} race`],
  [/^上傳 (\d+) 筆完成紀錄到我的訓練紀錄$/, 'Upload $1 check-ins to my training log'], [/^正在上傳 (\d+)\/(\d+)$/, 'Uploading $1/$2'],
  [/^已上傳 (\d+) 筆完成紀錄$/, 'Uploaded $1 check-ins'], [/^網路中斷，已上傳 (\d+) 筆$/, 'Connection lost — $1 uploaded'],
  [/^已套用 (\d+) 項設定$/, 'Applied $1 settings'], [/^已加入 (\d+) 個倒數$/, 'Added $1 countdowns'],
  [/^還有 (\d+) 筆完成紀錄沒有上傳$/, '$1 check-ins not uploaded yet'], [/^我的賽事最多 30 場，還能加 (\d+) 場$/, 'My races holds up to 30 — you can add $1 more'],
  [/^舊版是(全馬|半馬) ([A-Z]) 組，現在是(全馬|半馬) ([A-Z]) 組$/, (_, a, b, c, d) => `The old version had ${DN[a]} group ${b}; now it's ${DN[c]} group ${d}`],
  [/^(已?)改成(全馬|半馬)? ?([A-Z]) 組$/, (_, done, a, b) => `${done ? 'Changed' : 'Switch'} to ${a ? `${DN[a]} ` : ''}group ${b}`],
  // 分享與匯出、全季
  [/^複製 (W\d+|R) 課表$/, 'Copy $1 plan'], [/^已複製 (W\d+|R) 課表$/, '$1 plan copied'],
  [/^已產生 (\d+) 個行程$/, '$1 events created'], [/^(W\d+|R) 完成 (\d+)%$/, '$1 $2% done'],
  // 詳細內容的主課：「2 km × 3 趟，再 400 m × 4 趟」
  [/ × ([\d–~-]+) 趟/g, ' × $1'], [/，再 /g, ', then '],
  [/\+(\d+) 加練/g, '+$1 extra'],
  [/個人 ?W(\d+)/g, 'Personal W$1'], [/協會 W(\d+)/g, 'Club W$1'],
  // 整句的確認訊息要排在最前面：後面的通用句型（N 筆待審核、剩 N 名額）會把句子拆碎
  [/^還有 (\d+) 筆待審核，關閉審核會依報名順序直接錄取（額滿排候補）並通知他們。確定嗎？$/, '$1 pending requests. Turning off approval admits them in signup order (waitlisted when full) and notifies them. Continue?'],
  [/^只剩 (\d+) 個名額，核准後依報名先後排正取，其餘 (\d+) 人排候補。確定？$/, 'Only $1 spots left. Approved people are confirmed in signup order and the other $2 go to the waitlist. Continue?'],
  [/^其中 (\d+) 人已繳費，會標記待退費。$/, '$1 of them have paid and will be marked for refund.'],
  [/^還有 (\d+) 筆待審核$/, '$1 pending requests'], [/^還有 (\d+) 筆待審核：/, '$1 pending: '],
  [/^已選 (\d+) 人$/, '$1 selected'], [/^活動前 (\d+) 天$/, '$1 days before the event'], [/^選取 (.+)$/, 'Select $1'],
  // 報名期間：台北時間 10/5（日）20:00 → Sun 10/5 20:00（要在一般日期句型之前，避免時間黏在日期後面）
  [/(\d{1,2})\/(\d{1,2})（([日一二三四五六])）(\d\d:\d\d)/g, (_, m, d, w, hm) => `${WD[w]} ${m}/${d} ${hm}`],
  [/^報名將於 (.+) 開始$/, 'Signup opens $1'], [/^尚未開放報名・(.+) 開始$/, 'Signup not open yet · opens $1'],
  [/^報名期間 (.+?) – (.+?)(・需主辦審核)?$/, (_, a, b, c) => `Signup ${a === '即日起' ? 'now' : a} – ${b}${c ? ' · organizer approval required' : ''}`],
  [/^報名期間：(.+?) – (.+?)(（需主辦審核）)?$/, (_, a, b, c) => `Signup period: ${a === '即日起' ? 'now' : a} – ${b}${c ? ' (organizer approval required)' : ''}`],
  [/^回覆截止 (.+)$/, 'Responses close $1'],
  [/^(?:(\d+) 天 )?(\d+) 小時後開放報名$/, (_, d, h) => `Signup opens in ${d ? `${d} d ` : ''}${h} h`], [/^(\d+) 分鐘後開放報名$/, 'Signup opens in $1 min'],
  [/(\d{1,2}\/\d{1,2} \d\d:\d\d) 開放/g, 'opens $1'],
  [/^你在候補第 (\d+) 位，有人取消會自動遞補並通知你。$/, "You're number $1 on the waitlist and will be moved up automatically if someone cancels."],
  [/^人數已滿，已排入候補第 (\d+) 位，有人取消會自動遞補並通知你$/, "Event is full. You're number $1 on the waitlist and will be moved up automatically if someone cancels."],
  [/候補第 (\d+) 位/g, 'waitlist #$1'], [/^待審核 (\d+)( ›)?$/, 'Pending $1$2'], [/(\d+) 筆待審核/g, '$1 pending'],
  [/剩 (\d+) 個?名額/g, '$1 spots left'], [/^尚有 (\d+) 個名額可核准$/, '$1 spots can still be approved'],
  [/^已核准 (\d+) 人（正取 (\d+)、候補 (\d+)）/, 'Approved $1 (confirmed $2, waitlist $3)'], [/^已選 (\d+) 筆$/, '$1 selected'], [/^全部核准（(\d+)）$/, 'Approve all ($1)'],
  [/^(\d+) 則未讀$/, '$1 unread'], [/^通知，(\d+) 則新通知$/, 'Notifications, $1 new'], [/^(\d{1,2}) 月$/, (_, m) => MON[m - 1]],
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
