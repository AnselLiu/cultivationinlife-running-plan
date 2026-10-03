// 把課表教練原本寫在程式裡的英文（L('中文','English')、['中文','English']、用語表的 zh/en）收進 public/i18n-en.js
// 只補字典裡還沒有的中文；樣板字串（含 ${…}）照片段一一對應。跑完再用 python3 tools/i18n-missing.py 檢查。
// 用法：mise exec node@22.23.2 -- node tools/harvest-coach-en.mjs [--dry]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = ['public/coachcalc.js'];
const CJK = /[一-鿿]/;

// 讀一個字串或樣板字面值；回傳 { parts, end }（parts：樣板依 ${…} 切開的片段）
function readLit(s, i) {
  const q = s[i];
  if (!'\'"`'.includes(q)) return null;
  const parts = []; let buf = '', j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { buf += s[j + 1] === 'n' ? '\n' : s[j + 1]; j += 2; continue; }
    if (c === q) { parts.push(buf); return { parts, end: j + 1 }; }
    if (q === '`' && c === '$' && s[j + 1] === '{') {
      parts.push(buf); buf = '';
      let depth = 1; j += 2;
      while (j < s.length && depth) {
        const d = s[j];
        if ('\'"`'.includes(d)) { const r = readLit(s, j); j = r ? r.end : j + 1; continue; }
        if (d === '{') depth++; else if (d === '}') depth--;
        j++;
      }
      continue;
    }
    buf += c; j++;
  }
  return null;
}
const skipWs = (s, i) => { while (/\s/.test(s[i])) i++; return i; };

const pairs = [];
for (const f of SRC) {
  const s = fs.readFileSync(`${ROOT}${f}`, 'utf8');
  // L('zh','en') 與 ['zh','en']
  for (const re of [/\bL\(/g, /\[(?=\s*['"`])/g]) {
    let m;
    while ((m = re.exec(s))) {
      let i = skipWs(s, m.index + m[0].length);
      const a = readLit(s, i); if (!a) continue;
      i = skipWs(s, a.end); if (s[i] !== ',') continue;
      i = skipWs(s, i + 1);
      const b = readLit(s, i); if (!b) continue;
      const close = skipWs(s, b.end);
      if (re.source.startsWith('\\[') && s[close] !== ']') continue;
      pairs.push([a.parts, b.parts]);
    }
  }
  // 用語表：zh:'…',en:'…'
  for (const m of s.matchAll(/zh:(['"])((?:\\.|(?!\1).)*)\1,en:(['"])((?:\\.|(?!\3).)*)\3/g)) pairs.push([[m[2].replace(/\\(.)/g, '$1')], [m[4].replace(/\\(.)/g, '$1')]]);
}

const file = `${ROOT}public/i18n-en.js`, text = fs.readFileSync(file, 'utf8');
const [head, rest] = text.split('export default ');
const [dictSrc, tail] = rest.split(/;\nexport const inner/);
const dict = JSON.parse(dictSrc);
const add = {}, skipped = [];
for (const [zh, en] of pairs) {
  if (!zh.some((p) => CJK.test(p)) || en.some((p) => CJK.test(p))) continue;
  if (zh.length !== en.length) { skipped.push(zh.join('…')); continue; }
  zh.forEach((p, k) => {
    const key = p.trim(), val = en[k].trim();
    if (!key || !CJK.test(key) || key in dict || key in add) return;
    add[key] = val;
  });
}
console.log(`新增 ${Object.keys(add).length} 筆；片段數對不上、要手動補的 ${skipped.length} 筆`);
for (const s of skipped) console.log('  手動：', JSON.stringify(s));
if (!process.argv.includes('--dry')) {
  const merged = { ...dict, ...add };
  const body = '{\n' + Object.entries(merged).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n}';
  fs.writeFileSync(file, `${head}export default ${body};\nexport const inner${tail}`);
}
