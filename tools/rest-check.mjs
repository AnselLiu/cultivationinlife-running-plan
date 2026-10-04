// 跑者休息站來源的實地檢查：在這台電腦（不是 Worker）用 src/rest.js 的解析程式抓真的來源網址，印出
//   各來源筆數、開放時間解析得出的比例、座標不在臺灣而丟掉的筆數、輸出欄位有沒有超出白名單或夾帶電話、管理人資料有沒有被讀進來，
//   以及 171 個跑點（migrations 0033、0037）300 m／500 m／1 km 內有飲水、廁所、淋浴置物、補給的點數（含 0041 的整理清單）。
//   第二批（cool、moenv）要環境部的 API 金鑰：有設定環境變數 MOENV_KEY 才抓（只放進網址，不印），沒有就略過；覆蓋率另外印「加入第二批之前／之後」
//   用法：node tools/rest-check.mjs [來源代碼…]（例如 node tools/rest-check.mjs twd tpt）；依序抓取、每個網址之間停 1 秒
//     --mock：用測試假資料（不連外），檢查工具本身
//   結束碼：任何來源抓取或解析失敗、或（檢查全部來源時）任何一類 500 m 內的點數比基準少超過 10% → 1；都正常 → 0（沒有金鑰而略過不算失敗）
import { readFileSync } from 'node:fs';
import { SOURCES, ROW_KEYS, collect, collectPage, hasPhone, parseCsv, inTaiwan, cellOf } from '../src/rest.js';
import { parseHours } from '../public/hours.js';
import { seedSpots, coverage, keyEnv, GROUP_LABEL, KEY_HELP } from './rest-sync.mjs';

const args = process.argv.slice(2), mock = args.includes('--mock');
const only = args.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, mock ? 0 : ms));
const env = mock ? { REST_MOCK: '1', DEV_LOGIN: '1' } : {};   // 沒有 REST_MOCK：真的連線
const spots = seedSpots();
// ver.checks（2026-10-03 研究時實測）的筆數，拿來對照
// 覆蓋率基準：171 個跑點 500 m 內有該類的點數（2026-10-03 第一批來源＋0041 整理清單，不含暫停的直飲臺）；少超過 10% 就算失敗
//   資料真的變了（例如來源下架）而且確認過，才更新這裡的數字
const BASELINE_500 = { water: 60, toilet: 100, shower: 54, supply: 11 };
const EXPECT = { twd: '739（正常 726、暫停 13）', tpt: '1,537', tprv: '334 間（研究時依位置描述 182 處，現在依距離分群）', ntrv: '63', tpbk: '9', cpct: '574', tbk: '481', sav: '約 489（運動中心 46＋游泳池）',
  cool: '—（第二批，跑點 1 公里內）', moenv: '—（第二批，跑點 1 公里內）' };

const all = [];
const report = [];
for (const [k, S] of Object.entries(SOURCES)) {
  if (S.manual || (only.length && !only.includes(k))) continue;
  if (S.key && !mock && !keyEnv(k)) { report.push({ k, name: S.name, skip: `沒有設定環境變數 ${S.key}，略過。${KEY_HELP}` }); continue; }
  const t0 = Date.now();
  let rows = [], bad = { skipped: 0, coord: 0, other: 0 }, texts = null, err = null, date = null;
  try {
    if (S.pages) {
      const byId = new Map();
      for (let p = 0, pages = 1; p < pages; p++) {
        const g = await collectPage(env, k, p);
        pages = g.pages; date = g.date;
        for (const key of Object.keys(bad)) bad[key] += g.bad[key];
        for (const r of g.rows) { const prev = byId.get(r.id); if (prev) prev.svc |= r.svc; else byId.set(r.id, r); }
        await sleep(1000);
      }
      rows = [...byId.values()];
    } else {
      const g = await collect(mock ? env : { ...env, ...keyEnv(k) }, k, null, { raw: k === 'sav', spots });
      rows = g.rows; bad = g.bad; texts = g.texts; date = g.date;
    }
  } catch (e) { err = String(e?.message || e); }
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  const extra = [...keys].filter((x) => !ROW_KEYS.includes(x));
  const phones = rows.filter((r) => ['name', 'place', 'address', 'hours_raw'].some((f) => hasPhone(r[f])));
  const withHours = rows.filter((r) => r.hours).length, unparsed = rows.filter((r) => r.hours && !parseHours(r.hours)).length;
  const outside = rows.filter((r) => !inTaiwan(r.lat, r.lng) || r.cell !== cellOf(r.lat, r.lng)).length;
  // 運動場館：把 CSV 的管理人姓名與電話找出來，確認沒有出現在任何輸出欄位裡
  let mgr = '';
  if (k === 'sav' && texts) {
    const csv = parseCsv(texts[0]), head = csv.shift();
    const iName = head.findIndex((h) => h.trim().endsWith('管理人姓名')), iTel = head.findIndex((h) => h.trim().endsWith('管理人電話'));
    // 姓名欄有時填的是單位（例如「士林國小」「體育室」），跟場館名稱重疊不算外洩；只檢查看起來像人名（2–4 個字、不含單位用字）或電話的值
    const ORG = /國小|國中|高中|大學|學校|學院|中心|公所|政府|局|處|室|課|科|組|股|會|館|所|部|隊|公司|園|場|社/;
    const vals = csv.flatMap((r) => [[r[iName], 'n'], [r[iTel], 't']]).map(([s, t]) => [String(s || '').trim(), t]).filter(([s]) => s && s !== 'NULL');
    const secrets = new Set(vals.filter(([s, t]) => (t === 't' ? /\d{3,}/.test(s) && s.replace(/\D/g, '').length >= 7 : /^[\u4e00-\u9fff]{2,4}$/.test(s) && !ORG.test(s))).map(([s]) => s));
    const blob = JSON.stringify(rows);
    const leaked = [...secrets].filter((s) => blob.includes(s) || blob.includes(s.replace(/\D/g, '')) && /\d{7,}/.test(s.replace(/\D/g, '')));
    mgr = `管理人欄位 ${iName >= 0 && iTel >= 0 ? '有找到' : '找不到'}；像人名或電話的值 ${secrets.size} 個，輸出中出現 ${leaked.length} 個${leaked.length ? `（${leaked.slice(0, 3).join('、')}…）` : ''}`;
  }
  const by = (f) => Object.entries(rows.reduce((o, r) => ((o[r[f]] = (o[r[f]] || 0) + 1), o), {})).map(([a, n]) => `${a} ${n}`).join('、');
  report.push({ k, name: S.name, err, n: rows.length, expect: EXPECT[k], bad, withHours, unparsed, outside, extra, phones: phones.length, mgr, date, ms: Date.now() - t0,
    subtype: by('subtype'), access: by('access'), status: by('status') });
  // 覆蓋率只算地圖上看得到的列（暫停的直飲臺不算）
  all.push(...rows.filter((r) => r.status !== 'paused').map((r) => ({ ...r, source: k, batch: S.batch || 1 })));
  await sleep(1000);
}

console.log('\n## 各來源');
for (const r of report) {
  if (r.skip) { console.log(`\n${r.k}（${r.name}）  ${r.skip}`); continue; }
  console.log(`\n${r.k}（${r.name}）${r.err ? `  錯誤：${r.err}` : ''}`);
  console.log(`  筆數 ${r.n}（研究時 ${r.expect}）  資料日期 ${r.date || '—'}  ${Math.round(r.ms / 100) / 10} 秒`);
  console.log(`  丟掉：來源條件不收 ${r.bad.skipped}、座標不在臺灣 ${r.bad.coord}、代碼或名稱不合格 ${r.bad.other}${r.bad.far != null ? `、離跑點超過 1 公里 ${r.bad.far}` : ''}`);
  console.log(`  開放時間解析得出 ${r.withHours}／${r.n}（${r.n ? Math.round((r.withHours / r.n) * 100) : 0}%），存了卻解析不出 ${r.unparsed}`);
  console.log(`  細項：${r.subtype}｜使用方式：${r.access}｜狀態：${r.status}`);
  console.log(`  檢查：座標或格子不對 ${r.outside}、白名單外欄位 ${r.extra.length ? r.extra.join(',') : '無'}、看起來像電話 ${r.phones}${r.mgr ? `、${r.mgr}` : ''}`);
}

// ---- 覆蓋率：171 個跑點 ----
// 整理清單（0041）也算進去
for (const m of readFileSync('migrations/0041_seed_rest_curated.sql', 'utf8').matchAll(/\('(cur:[\w-]+)', 'cur', '(\w+)', '(\w+)', (\d+), '(\w+)', '([^']*)',[^\n]*\n\s*([\d.]+), ([\d.]+)/g)) {
  all.push({ id: m[1], source: 'cur', batch: 1, type: m[2], subtype: m[3], svc: Number(m[4]), access: m[5], name: m[6], lat: Number(m[7]), lng: Number(m[8]) });
}
const two = all.some((r) => r.batch === 2);
const before = coverage(spots, all.filter((r) => r.batch !== 2)), after = coverage(spots, all);
console.log(`\n## 覆蓋率（${spots.length} 個跑點、${all.length} 處；直線距離，不做跨來源合併）`);
if (two) console.log('「加入第二批之前 → 之後」；第二批是 Cool map 涼適點與環境部全國公廁（只收跑點 1 公里內）');
console.log('類型          300 m          500 m          1 km           最近距離中位數');
const med = (ds) => { const s = [...ds].sort((a, b) => a - b), v = s[Math.floor(s.length / 2)]; return Number.isFinite(v) ? `${Math.round(v)} m` : '3 km 以上'; };
const cell = (g, m) => (two ? `${before[g][m]} → ${after[g][m]}` : String(after[g][m])).padStart(12);
const drops = [];
for (const g of Object.keys(GROUP_LABEL)) {
  if (!only.length && !mock && after[g][500] < BASELINE_500[g] * 0.9) drops.push(`${GROUP_LABEL[g]} 500 m 內 ${after[g][500]} 點，基準 ${BASELINE_500[g]} 點`);
  console.log(`${GROUP_LABEL[g].padEnd(10, '　')}  ${cell(g, 300)}  ${cell(g, 500)}  ${cell(g, 1000)}  ${two ? `${med(before[g].dists)} → ` : ''}${med(after[g].dists)}`);
}
const both = (c) => spots.filter((_, i) => c.water.dists[i] <= 500 && c.toilet.dists[i] <= 500).length;
const none = spots.filter((_, i) => after.water.dists[i] > 500 && after.toilet.dists[i] > 500);
console.log(`\n飲水和廁所 500 m 內都有：${two ? `${both(before)} → ` : ''}${both(after)} 點；兩者 500 m 內都沒有：${none.length} 點`);
console.log(`  ${none.map((s) => s.name).join('、')}`);

// ---- 結果 ----
const errs = report.filter((r) => r.err);
if (errs.length || drops.length) {
  console.error(`\n檢查失敗：${[...errs.map((r) => `${r.k} ${r.err}`), ...drops].join('；')}`);
  process.exitCode = 1;
} else console.log('\n檢查通過：每個來源都抓得到、覆蓋率沒有比基準少超過 10%');
