// 場地開放時間解析（public/hours.js）：常見寫法判斷正確；看不懂的寫法不判斷（回傳 null），寧可不反灰也不要判斷錯
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHours, hoursNow } from '../public/hours.js';

const at = (s) => new Date(`${s}+08:00`);   // 台北時間
const check = (txt, when, open, next) => {
  const r = hoursNow(txt, at(when));
  if (open === null) return assert.equal(r, null, `${txt} @ ${when} 應該不判斷，卻得到 ${JSON.stringify(r)}`);
  assert.equal(r?.open, open, `${txt} @ ${when} → ${JSON.stringify(r)}`);
  if (next) assert.equal(r.next, next, `${txt} @ ${when} 下次開放 → ${JSON.stringify(r)}`);
};

test('平日／假日、每日、全日、月份與休園', () => {
  const ntue = '平日 05:30–07:00、17:40–21:30；假日 05:30–21:30（依民國 101 年校內辦法，以最新公告為準）';
  check(ntue, '2026-10-05T06:00:00', true);            // 週一早上
  check(ntue, '2026-10-05T12:00:00', false, '17:40');
  check(ntue, '2026-10-04T12:00:00', true);             // 週日中午
  check('每日 05:00–22:00', '2026-10-05T23:00:00', false, '05:00');
  check('每日 05:00–22:00', '2026-10-05T21:59:00', true);
  check('全日開放（依新北市運動場館使用管理要點）', '2026-10-05T03:00:00', true);
  check('24H', '2026-10-05T03:00:00', true);
  check('06:00–21:00', '2026-10-05T05:59:00', false, '06:00');
  const lake = '4–9 月 06:00–18:00，10–3 月 06:00–17:30；晨間運動 04:00–06:00（週一休園）';
  check(lake, '2026-10-05T07:00:00', false);            // 週一休園
  check(lake, '2026-10-06T17:45:00', false);            // 10 月 17:30 關
  check(lake, '2026-09-08T17:45:00', true);             // 9 月到 18:00
  check(lake, '2026-10-06T04:30:00', true);             // 晨間運動
});

test('星期區間、星期清單、國定假日休館', () => {
  const lib = '週二至週六：08:30~21:00；週日、週一：09:00~17:00';
  check(lib, '2026-10-06T10:00:00', true);              // 週二
  check(lib, '2026-10-06T20:00:00', true);              // 週二晚上
  check(lib, '2026-10-05T18:00:00', false);             // 週一 17:00 關
  check(lib, '2026-10-04T16:00:00', true);              // 週日
  check(lib, '2026-10-04T17:30:00', false, '09:00');    // 週日 17:00 後，明天週一 09:00
  check('星期二至星期六 08:30-21:00；星期日、星期一 09:00-17:00', '2026-10-05T18:00:00', false);
  check('08:30~21:00（週一及國定假日休館）', '2026-10-05T10:00:00', false);   // 週一
  check('08:30~21:00（週一及國定假日休館）', '2026-10-06T10:00:00', true);    // 週二
  check('週日、週一:\n09:00-17:00', '2026-10-05T10:00:00', true);             // 標籤跟時間分兩行
});

test('看不懂的寫法不判斷', () => {
  check('有，到 22:00', '2026-10-05T23:00:00', null);
  check('', '2026-10-05T23:00:00', null);
  check('未公告校外固定時段；上課與校隊訓練時段優先', '2026-10-05T10:00:00', null);
  check('06:00–23:00（學期中平日 08:00–17:30 不開放）', '2026-10-05T10:00:00', null);   // 只寫「平日」不開放，看不出哪幾天開
});

test('練跑地點的開放時間：每一筆不是正確判斷就是不判斷（不會丟錯）', () => {
  const sql = ['0033_seed_spots.sql', '0037_seed_spots_more.sql'].map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')).join('\n');
  let n = 0;
  for (const m of sql.matchAll(/'(\{[^']*\})', 'approved'\);/g)) {
    const info = JSON.parse(m[1].replace(/''/g, "'"));
    if (!info.hours) continue;
    n++;
    const h = parseHours(info.hours);
    if (h) for (const d of ['2026-10-05T06:00:00', '2026-10-07T12:00:00', '2026-10-10T20:00:00']) assert.equal(typeof hoursNow(h, at(d)).open, 'boolean');
  }
  assert.ok(n >= 60, `至少要有 60 筆開放時間，實際 ${n}`);
});
