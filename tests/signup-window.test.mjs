// 報名期間共用模組的單元測試：純函式，不需要伺服器
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStamp, tpNow, tpToday, shiftDays, daysBetween, evStart, signupEnd, signupState, defaultWindow, windowError, tpText, tpShort, STATE_TEXT, STATE_LABEL, evEnd, evPhase, PHASE_LABEL } from '../public/signup-window.js';

test('isStamp：只接受存在的台北牆上時間', () => {
  assert.equal(isStamp('2026-02-30T10:00'), false);
  assert.equal(isStamp('2026-10-05 20:00'), false);
  assert.equal(isStamp('2026-10-05T20:00'), true);
  assert.equal(isStamp('2026-10-05T24:00'), false);
  assert.equal(isStamp(''), false);
  assert.equal(isStamp(null), false);
});

test('tpNow：UTC 加 8 小時，跨日正確', () => {
  assert.equal(tpNow(Date.UTC(2026, 9, 3, 16, 30)), '2026-10-04T00:30');
  assert.equal(tpToday(Date.UTC(2026, 9, 3, 16, 30)), '2026-10-04');
  assert.equal(shiftDays('2026-10-31T20:00', 1), '2026-11-01T20:00');
  assert.equal(shiftDays('2026-10-05T07:00', 135 / 1440), '2026-10-05T09:15');
  assert.equal(daysBetween('2026-10-05', '2026-10-12'), 7);
});

test('signupEnd：沒有截止時是活動開始；沒有集合時間或問卷是當天 23:59', () => {
  assert.equal(signupEnd({ date: '2026-10-10', gather_time: '07:00' }), '2026-10-10T07:00');
  assert.equal(signupEnd({ date: '2026-10-10', gather_time: '' }), '2026-10-10T23:59');
  assert.equal(signupEnd({ date: '2026-10-10', gather_time: '07:00', kind: 'survey' }), '2026-10-10T23:59');
  assert.equal(signupEnd({ date: '2026-10-10', gather_time: '07:00', deadline: '2026-10-08T22:00' }), '2026-10-08T22:00');
  assert.equal(evStart({ date: '2026-10-10', gather_time: '7:00' }), '2026-10-10T23:59', '格式不對的集合時間當作沒有');
});

test('signupState：截止那一分鐘仍開放；優先順序 已取消 > 關閉 > 尚未開放 > 已截止', () => {
  const ev = { date: '2026-10-10', gather_time: '07:00', signup_open: 1, status: 'open', signup_start: '2026-10-05T20:00', deadline: '2026-10-08T22:00' };
  assert.equal(signupState(ev, '2026-10-08T22:00'), 'open');
  assert.equal(signupState(ev, '2026-10-08T22:01'), 'ended');
  assert.equal(signupState(ev, '2026-10-05T19:59'), 'soon');
  assert.equal(signupState(ev, '2026-10-05T20:00'), 'open');
  assert.equal(signupState({ ...ev, status: 'cancelled', signup_open: 0 }, '2026-10-05T19:59'), 'cancelled');
  assert.equal(signupState({ ...ev, signup_open: 0 }, '2026-10-05T19:59'), 'off');
  assert.equal(signupState({ ...ev, deadline: null }, '2026-10-10T07:01'), 'ended');
  assert.match(STATE_TEXT.soon(ev), /報名將於 10\/5（一）20:00 開始/);
  assert.equal(STATE_LABEL.ended({ kind: 'survey' }), '問卷已截止');
});

test('defaultWindow：相對規則、已過去的清空並說明', () => {
  const d = { approval: false, notify: true, open_days: 3, open_time: '20:00', close_days: 1, close_time: '22:00' };
  const ev = { date: '2026-10-10', gather_time: '07:00' };
  assert.deepEqual(defaultWindow(ev, d, '2026-10-01T10:00'), { start: '2026-10-07T20:00', end: '2026-10-09T22:00', notes: [] });
  const late = defaultWindow(ev, d, '2026-10-09T23:00');
  assert.equal(late.end, '');
  assert.equal(late.start, '');
  assert.match(late.notes.join(), /截止時間已經過了/);
  const started = defaultWindow(ev, d, '2026-10-08T10:00');
  assert.equal(started.start, '');
  assert.equal(started.end, '2026-10-09T22:00');
  const inverted = defaultWindow(ev, { ...d, open_days: 1, close_days: 3 }, '2026-10-01T10:00');
  assert.equal(inverted.start, '');
  assert.match(inverted.notes.join(), /開始時間晚於截止/);
  assert.deepEqual(defaultWindow(ev, { ...d, open_days: null, close_days: null }, '2026-10-01T10:00'), { start: '', end: '', notes: [] });
  assert.equal(defaultWindow(ev, { ...d, close_days: 0, close_time: '22:00' }, '2026-10-01T10:00').end, '', '當天 22:00 晚於活動開始，改成活動開始時截止');
});

test('windowError：格式、截止晚於活動、開始晚於截止、建立時截止已過', () => {
  const ev = { date: '2026-10-10', gather_time: '07:00' };
  assert.match(windowError({ ...ev, signup_start: 'tomorrow' }), /報名開始時間格式不正確/);
  assert.match(windowError({ ...ev, deadline: '2026-10-08 22:00' }), /報名截止時間格式不正確/);
  assert.match(windowError({ ...ev, deadline: '2026-10-10T08:00' }), /不能晚於活動開始/);
  assert.match(windowError({ ...ev, signup_start: '2026-10-09T22:00', deadline: '2026-10-09T22:00' }), /報名開始要早於/);
  assert.match(windowError({ ...ev, deadline: '2026-10-01T09:00' }, { now: '2026-10-02T00:00', create: true }), /已經過了/);
  assert.equal(windowError({ ...ev, deadline: '2026-10-01T09:00' }, { now: '2026-10-02T00:00' }), null, '編輯可以改到過去');
  assert.equal(windowError({ ...ev, signup_start: '2026-10-05T20:00', deadline: '2026-10-09T22:00' }), null);
  assert.equal(tpShort('2026-10-05T20:00'), '10/5 20:00');
  assert.equal(tpText(''), '');
});

test('windowError：結束時間（選填）要晚於集合時間、有結束時間就要有集合時間；問卷不檢查', () => {
  const ev = { date: '2026-10-10', gather_time: '07:00' };
  assert.match(windowError({ ...ev, end_time: '06:30' }), /結束時間要在開始之後/);
  assert.match(windowError({ ...ev, end_time: '07:00' }), /結束時間要在開始之後/);
  assert.equal(windowError({ ...ev, end_time: '09:00' }), null);
  assert.equal(windowError({ ...ev, end_time: '' }), null);
  assert.match(windowError({ date: '2026-10-10', gather_time: '', end_time: '09:00' }), /也要填集合（開始）時間/, '只有結束時間，活動頁會變成「－09:00」');
  assert.equal(windowError({ date: '2026-10-10', gather_time: '', end_time: '' }), null);
  assert.equal(windowError({ ...ev, kind: 'survey', end_time: '06:00' }), null);
});

test('evPhase：卡片與分享預覽的狀態（取消 > 已結束 > 關閉／即將開放／截止 > 額滿 > 報名中）', () => {
  const ev = { kind: 'track', date: '2026-10-10', gather_time: '19:30', end_time: '21:00', signup_open: 1, signup_start: '2026-10-05T20:00', deadline: '2026-10-09T22:00' };
  assert.equal(evEnd(ev), '2026-10-10T21:00');
  assert.equal(evEnd({ ...ev, end_time: '' }), '2026-10-10T23:59', '沒有結束時間：當天結束');
  assert.equal(evPhase(ev, '2026-10-05T19:59'), 'soon');
  assert.equal(PHASE_LABEL.soon(ev), '即將開放 10/5 20:00');
  assert.equal(evPhase(ev, '2026-10-05T20:00'), 'open');
  assert.equal(evPhase(ev, '2026-10-06T08:00', true), 'full');
  assert.equal(evPhase(ev, '2026-10-09T22:01', true), 'closed', '截止後不管滿不滿都是報名已截止');
  assert.equal(evPhase(ev, '2026-10-10T20:00'), 'closed', '活動進行中');
  assert.equal(evPhase(ev, '2026-10-10T21:01'), 'over');
  assert.equal(evPhase({ ...ev, end_time: null }, '2026-10-10T23:00'), 'closed');
  assert.equal(evPhase({ ...ev, end_time: null }, '2026-10-11T00:00'), 'over');
  assert.equal(evPhase({ ...ev, status: 'cancelled' }, '2026-10-11T00:00'), 'cancelled', '取消優先');
  assert.equal(evPhase({ ...ev, signup_open: 0 }, '2026-10-06T08:00'), 'off');
  // 用外部連結登記（App 裡不開放報名）：不說「未開放報名」；沒登入的預覽只給 ext（有沒有連結）
  assert.equal(evPhase({ ...ev, signup_open: 0, link_url: 'https://forms.example/x' }, '2026-10-06T08:00'), 'ext');
  assert.equal(evPhase({ ...ev, signup_open: 0, ext: true }, '2026-10-06T08:00'), 'ext');
  assert.equal(evPhase({ ...ev, signup_open: 1, link_url: 'https://forms.example/x' }, '2026-10-06T08:00'), 'open', 'App 裡也開放報名的照舊');
  assert.equal(evPhase({ ...ev, signup_open: 0, link_url: 'https://forms.example/x' }, '2026-10-11T00:00'), 'over');
  assert.equal(PHASE_LABEL.ext(ev), '外部登記');
  assert.equal(PHASE_LABEL.open({ kind: 'survey' }), '填寫中');
  assert.equal(PHASE_LABEL.closed({ kind: 'survey' }), '問卷已截止');
  for (const k of ['cancelled', 'over', 'off', 'ext', 'soon', 'closed', 'full', 'open']) assert.equal(typeof PHASE_LABEL[k](ev), 'string');
});
