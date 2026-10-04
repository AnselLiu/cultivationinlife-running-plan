// 相機掃描：用 Chrome 的假相機播放一張 QR Code，確認
//   1. 沒有 BarcodeDetector 的瀏覽器（iPhone Safari）會改用 jsQR 解析相機畫面
//   2. 解析出來的內容真的送到伺服器（會籍卡驗證回「這不是有效的會籍卡」）
//   3. 拒絕相機權限時，告訴使用者去哪裡打開
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login, acceptPrivacyIfAsked } from './helpers.mjs';

// 用專案自帶的 qrcode-generator 產生 QR，畫成 640×480 的 Y4M 影片（假相機的來源）
function qrVideo(text) {
  const mod = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../../public/vendor/qrcode.js', import.meta.url), 'utf8'))(mod, mod.exports);
  const q = mod.exports(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), W = 640, H = 480, cell = Math.floor(360 / (n + 8)), size = cell * (n + 8);
  const x0 = Math.floor((W - size) / 2), y0 = Math.floor((H - size) / 2);
  const Y = Buffer.alloc(W * H, 235), UV = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) {
    for (let dy = 0; dy < cell; dy++) Y.fill(16, (y0 + (r + 4) * cell + dy) * W + x0 + (c + 4) * cell, (y0 + (r + 4) * cell + dy) * W + x0 + (c + 5) * cell);
  }
  const file = join(tmpdir(), `cil-qr-${process.pid}.y4m`);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\nFRAME\n`), Y, UV]));
  return file;
}
const VIDEO = qrVideo('CILM:t_other.0123456789abcdef');

// 假相機（整個檔案共用）：播放上面那張 QR；自動按下「允許」
test.use({ permissions: ['camera'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO}`] } });

test('沒有 BarcodeDetector（像 iPhone）也能用相機掃會籍卡', async ({ page }) => {
  await page.addInitScript(() => { delete window.BarcodeDetector; });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/admin?tab=members');
  await page.locator('#verifyCard').click();
  await expect(page.locator('.sheet video.cam')).toBeVisible();
  // 掃到假相機裡的 QR，送去驗證：簽章是假的，伺服器回「這不是有效的會籍卡」
  await expect(page.locator('.sheet .scanmsg')).toContainText('這不是有效的會籍卡', { timeout: 15000 });
  expect(await page.evaluate(() => typeof window.jsQR)).toBe('function');
  // 關掉面板後相機也要關掉
  await page.locator('.sheet button[data-close]').click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('video').length)).toBe(0);
});

test('拒絕相機權限：說明去哪裡打開，還可以手動輸入', async ({ page }) => {
  // 跟使用者在系統詢問時按「不允許」一樣：getUserMedia 回 NotAllowedError
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await login(page, 't_chair'); await acceptPrivacyIfAsked(page);
  await page.goto('/#/admin?tab=members');
  await page.locator('#verifyCard').click();
  await expect(page.locator('.sheet .scanmsg')).toContainText('沒有相機權限', { timeout: 15000 });
  await expect(page.locator('.sheet video.cam')).toHaveCount(0);
  await expect(page.locator('.sheet input[name=code]')).toBeVisible();
});
