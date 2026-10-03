// 端到端測試：用真的瀏覽器走過團員與幹部的主要流程，並用 axe 檢查無障礙（npm run test:e2e）
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '.wrangler/e2e-report' }]] : 'list',
  use: { baseURL: 'http://localhost:8796', serviceWorkers: 'block', reducedMotion: 'reduce', locale: 'zh-TW', timezoneId: 'Asia/Taipei', trace: 'retain-on-failure' },
  projects: [
    { name: 'iPhone', use: { ...devices['iPhone 13'], browserName: 'chromium' }, testIgnore: /sweep\.spec/ },
    // iPhone Safari 用的 WebKit：逐頁檢查版面（日期欄位等 iOS 才有的跑版）
    { name: 'iPhone Safari', use: { ...devices['iPhone 13'], baseURL: 'https://localhost:8795', ignoreHTTPSErrors: true }, testMatch: /sweep\.spec/ },
  ],
  webServer: [
    { command: 'node tests/e2e/server.mjs 8796', url: 'http://localhost:8796/api/me', timeout: 300000, reuseExistingServer: !process.env.CI },
    { command: 'node tests/e2e/server.mjs 8795 https', url: 'https://localhost:8795/api/me', ignoreHTTPSErrors: true, timeout: 300000, reuseExistingServer: !process.env.CI },
  ],
});
