// 行事曆（.ics）的折行：每行最多 75 個位元組（RFC 5545 3.1），這裡用 73 留點餘裕；續行以一個空白開頭
//   用算術算 UTF-8 位元組數，不再每個字元 new TextEncoder().encode（30 場活動從 10–15 ms 降到 0.5 ms 以下）
//   輸出和舊版逐位元組相同（tests/ics.test.mjs 比對）
const u8 = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);   // 單獨的代理字元 TextEncoder 會換成 U+FFFD，也是 3 個位元組
export function fold(line) {
  if (line.length <= 24) return line;   // 24 個 UTF-16 單位最多 72 個位元組，一定不用折
  const out = [];
  let cur = '', n = 0;
  for (const ch of line) {
    const b = u8(ch.codePointAt(0));
    if (n + b > 73) { out.push(cur); cur = ` ${ch}`; n = 1 + b; } else { cur += ch; n += b; }
  }
  out.push(cur);
  return out.join('\r\n');
}
// base64 → 位元組（一般 for 迴圈；Uint8Array.from(atob(), fn) 每個字元呼叫一次函式，大圖要好幾 ms）
export function b64bytes(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
