// 端到端測試的共用工具：用開發登入切換帳號、用 API 準備測試資料
import { test } from '@playwright/test';
export const BASE = 'http://localhost:8796';
const base = () => { try { return test.info().project.use.baseURL || BASE; } catch { return BASE; } };
const plus = (d) => new Date(Date.now() + 8 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
export { plus };
export async function login(page, id, { start = false } = {}) {
  // 「開始使用」卡（加到主畫面、推播、組別）在首頁與「我的」最上面：測試裡先標成收起，不影響其他版面（卡片本身另外測：start: true）
  if (!start) await page.addInitScript(() => { try { localStorage.setItem('cil-start', JSON.stringify({ v: 1, dismissed: 1 })); } catch {} });
  await page.goto(`/api/dev/login?id=${id}`);
  await page.waitForURL(/#\//);
}
// 以某個帳號呼叫 API（測試資料準備用）
export async function apiAs(request, id, path, { method = 'GET', body } = {}) {
  const r = await request.get(`/api/dev/login?id=${id}`, { maxRedirects: 0 });
  const cookie = r.headers()['set-cookie'].split(';')[0];
  const res = await request.fetch(`/api${path}`, { method, headers: { cookie, origin: base(), 'content-type': 'application/json' }, data: body ? JSON.stringify(body) : undefined });
  return res.json();
}
// 第一次進來要同意隱私權政策（測試帳號的同意版本較舊）
export async function acceptPrivacyIfAsked(page) {
  // 等畫面畫好（要同意的話會出現「同意並繼續」，否則是一般頁面的標題）
  await page.waitForSelector('#consentBtn, #view h1:not(:has-text("隱私權政策"))', { timeout: 10000 });
  if (await page.locator('#consentBtn').count()) { await page.locator('#consentBtn').click(); await page.waitForSelector('#consentBtn', { state: 'detached' }); }
}
