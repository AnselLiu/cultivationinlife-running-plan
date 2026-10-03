# 耕跑團 Cultivation in Life Run

台灣耕跑團協會的團練 PWA：把原本散在 LINE 群組的團練公告、接龍報名和每週課表收在一個網站，並支援推播通知。原本的「課表教練」單頁保留在 `/coach.html`。

- **團練**：週四田徑場、週五核心日、週日長跑等活動，列出時間、地點、帶團與注意事項。
- **報名**：取代 LINE 接龍。可設人數上限與報名截止，額滿自動排候補，有人取消時候補遞補並推播通知。
- **課表**：全馬 S–I、半馬 A–E 分組課表，`MP+20''` 這種寫法會自動換算成該組的實際配速。
- **公告產生器**：幹部建立活動後，依週次帶出各組課表，產生可直接貼回 LINE 的公告文字。
- **春酒**：報名（攜伴、葷素，自動帶入基本資料）、**入場 QR Code**（含桌次、餐點、攜伴，掃描即報到）、現場報到台與掃碼報到、排桌與座位查詢（搜尋姓名／暱稱／跑團＋互動座位圖，佈局每年可自訂）、抽獎舞台（全螢幕投影、老虎機動畫、彩帶、階段標記、只抽已報到／允許重複中獎、領獎確認、得獎 CSV 匯出、獎項批次匯入）。
- **其他活動**：電影索票、誓師大會這類用 Google 表單報名的活動，可以在活動上掛外部連結按鈕，公告文字也會帶上。
- **管理後台**：會員管理（跑友與協會會員分開，會籍、會員類別、編號、繳費年限）、身分與權限對照表、座位圖設定。
- **通知中心**：活動、課表、報名與中獎都會留一則通知，右上角鈴鐺顯示未讀數；有設推播金鑰時同時推播。
- **教練發布課表**：教練把 LINE 記事本的原文貼上就能發布，團員在「課表」頁看到該週課表並收到通知。
- **我的賽事倒數**：每個人可以加自己的賽事（名稱、日期、距離、目標），標題列倒數主要賽事；沒設定時倒數協會預設賽事（幹部可改）。
- **跑步記錄**：手機計時＋GPS，自動暫停、課表目標提醒、停太久會問「跑完了嗎」；跑完算出距離、配速、每公里分段與計圈，一鍵存到訓練紀錄或拍照分享；軌跡只留在手機上，可下載 GPX。
- **拍照分享**：資料來源有手動輸入、Apple 健康捷徑、GPX／TCX 檔（Garmin Connect、Apple 健康都能匯出）；照片可選圖、拍照或用 **AR 相機**（鏡頭畫面即時疊數據）；三種版型（極簡、路線、號碼布）× 三種比例（限時動態／Reels 9:16、貼文 4:5、方形 1:1）；輸出圖片或 6 秒 Reels 短片，用手機分享選單送到 Instagram。照片不上傳。
- **登入與身分**：Google 登入（只取名稱與大頭貼，不取 Email）、通行金鑰（Face ID／指紋），或用邀請碼加入。

## 架構

| 部分 | 內容 |
|---|---|
| `public/` | PWA 前端（純 HTML／CSS／JS，沒有框架，不用 build） |
| `public/app.js` | 畫面：登入、團練列表、活動詳情與報名、我的課表、新增活動、設定 |
| `public/plan.js` | 課表讀取與配速換算（畫面與公告產生器共用） |
| `public/party.js` | 春酒：座位查詢、座位圖、抽獎舞台 |
| `public/qr.js` | 入場 QR 產生與掃描（包裝 `vendor/qrcode.js`，MIT，自架不走 CDN） |
| `public/coach.html` | 原本的課表教練單頁（整季課表、年齡分級、補給試算） |
| `public/data/season-2026.json` | 2026 臺北馬 W1–W20＋賽後恢復週的分組課表 |
| `src/worker.js` | API（Cloudflare Worker）：Google 登入、工作階段、活動、報名、推播 |
| `src/push.js` | Web Push（RFC 8291 加密＋RFC 8292 VAPID），只用 WebCrypto |
| `migrations/` | D1 資料表 |
| `docs/` | GitHub Pages 的轉址頁（App 本體在 Cloudflare） |

**設計**：品牌色沿用課表教練頁（深藍 `#0B1B33`、藍 `#1C4698`、黃 `#FDF36D`、萊姆 `#B9D04C`），介面走 macOS／iOS 的毛玻璃風格：背景極光＋`backdrop-filter` 玻璃卡片，支援深淺色切換與 `prefers-reduced-motion`。

**角色分層**（參考人民團體組織）：

| 角色 | 權限 |
|---|---|
| `chair` 理事長 | 全部，含指派身分與職稱、座位圖設定 |
| `director` 理事 | 建立活動、報到、抽獎、看名冊、會員管理 |
| `supervisor` 監事 | 看名冊與會籍（唯讀） |
| `staff` 行政人員 | 建立活動、報到、抽獎、看名冊、會員管理、座位圖設定 |
| `coach` 教練 | 建立活動、**發布課表**、報到 |
| `member` 跑友 | 報名、看課表與通知 |

**跑友 ≠ 協會會員**：任何人用邀請碼或 Google 登入都是跑友，可以報名團練；協會會籍（`membership`：跑友／申請中／會員／到期）另外由行政人員在後台管理，含會員類別、編號、入會日期與繳費年限。入會申請仍走官方 Google 表單，網站只記狀態。

職稱（例如「副理事長」「活動組長」）另外用 `title` 欄位顯示，不影響權限。邀請碼 `JOIN_CODE` 只能成為跑友；`CHAIR_CODE` 只在系統還沒有理事長時有效一次，之後所有幹部身分都由理事長在後台指派，沒有共用的幹部碼。

**身分與安全**：工作階段權杖放 HttpOnly cookie，資料庫只存 SHA-256；寫入類 API 只收同源 JSON 請求（擋 CSRF）；Google 登入用 state＋nonce cookie 防 CSRF 與重放，並以 Google 公鑰驗證 ID Token。

**個資**：網站只存姓名、組別、Google 顯示名稱與大頭貼網址（不存 Email）、報名紀錄。協會入會申請仍走官方 Google 表單，網站只放連結。

**賽事報名資料**（代為團體報名馬拉松用，選填）：身分證字號、生日、地址、緊急聯絡人等，用 `RACE_KEY` 以 AES-GCM 加密後存在 `member_private`，只有本人看得到完整內容；本人報名「代為團體報名」的活動並勾選同意後，該活動的主辦幹部才能下載 CSV，每次下載都寫稽核。本人刪除資料時，已給的同意一併撤回。`RACE_KEY` 遺失就無法解密，只能請大家重填。

## 操作流程

每個角色的主要操作步驟、設計原則與對應的測試，見 [docs/FLOWS.md](docs/FLOWS.md)。

## 本機開發

```bash
npm install
cp .dev.vars.example .dev.vars     # 設邀請碼（之後可加 Google 登入與推播金鑰）
npm run db:migrate:local
npm run dev                        # http://localhost:8790
```

## 部署

```bash
npx wrangler d1 create cil-run          # 把回傳的 database_id 貼進 wrangler.jsonc
npx wrangler secret put JOIN_CODE       # 團員邀請碼
npx wrangler secret put CHAIR_CODE      # 初始理事長碼（只在還沒有理事長時有效一次）
npx wrangler secret put HASH_SALT       # IP 雜湊用的鹽（長亂數）
npx wrangler secret put AUDIT_KEY       # 稽核簽章金鑰（長亂數）
openssl rand -base64 32 | npx wrangler secret put RACE_KEY   # 賽事報名資料加密金鑰（不要顯示、不要換）
npm run deploy
```

### Google 登入

已設定完成（2026-10-03）：Google Cloud 專案 `cultivation-in-life-run`、OAuth 用戶端「cil-run web」（網頁應用程式，正式站與測試環境兩個重新導向 URI），同意畫面已發布為「實際運作中」，隱私權政策連結 `https://cil-run.anselliu7.workers.dev/privacy`。

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案 → 「API 和服務」→「OAuth 同意畫面」：使用者類型選「外部」，應用程式名稱「耕跑團」，範圍只要 `openid`、`profile`（非敏感範圍，不需要 Google 審查），最後按「發布應用程式」。
2. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」→ 類型「網頁應用程式」，已授權的重新導向 URI：
   - `https://cil-run.anselliu7.workers.dev/api/google/callback`
   - （選用）`https://cil-run-staging.anselliu7.workers.dev/api/google/callback`、`http://localhost:8790/api/google/callback`
3. 設定 secrets：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --name cil-run
npx wrangler secret put GOOGLE_CLIENT_SECRET --name cil-run
```

沒設定時，登入畫面只顯示邀請碼與通行金鑰。Google 不允許在 LINE、Facebook、Instagram 的內建瀏覽器登入；在 LINE 裡打開時，登入按鈕會改用 `openExternalBrowser=1` 跳到 Safari／Chrome。

### 跑步數據匯入

不串接任何付費或需要訂閱的服務：手動輸入、iPhone 捷徑讀取 Apple 健康，或匯入 GPX／TCX 檔（Garmin Connect、Apple 健康、各家手錶都能匯出）。

### 推播通知（選用）

```bash
node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(async k=>{
  const pub=Buffer.from(await crypto.subtle.exportKey('raw',k.publicKey)).toString('base64url');
  console.log('VAPID_PUBLIC_KEY=',pub);
  console.log('VAPID_PRIVATE_JWK=',JSON.stringify(await crypto.subtle.exportKey('jwk',k.privateKey)));})"
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_JWK
npx wrangler secret put VAPID_SUBJECT     # 例如 mailto:you@example.com
```

iPhone 要先用 Safari 的「分享 → 加到主畫面」，再從主畫面開啟才收得到通知。

## 課表資料怎麼更新

教練每週發新課表後，在 `gengpao-running-coach` skill 更新原文並重建 `season-2026.json`，再覆蓋 `public/data/season-2026.json`。W9 以後目前是依 2025 臺北馬同期推估，畫面與公告都會標示「以教練公告為準」。

## 待辦

- 活動前一天自動提醒（Cron Trigger）
- 幹部後台：團員名冊、出席統計
- 協會公益活動與繳費狀態
- LINE 官方帳號推播（把公告直接送進群組）

## 測試、測試環境與自動部署

```bash
npm run test:ci        # 啟動獨立的本機資料庫與伺服器，跑全部 API 測試（權限、邀請制、問卷、訓練紀錄、排程、通行金鑰）
npm run deploy:staging # 部署到測試環境 https://cil-run-staging.anselliu7.workers.dev（獨立資料庫）
npm run deploy         # 部署正式站
```

- 測試帳號在 `tests/seed.sql`，測試用資料庫在 `.wrangler/test-state`，不會動到開發或正式資料。
- GitHub Actions（`.github/workflows/ci.yml`）：每次 push／PR 都跑測試；push 到 `main` 而且測試通過就部署正式站，push 到 `staging` 分支就部署測試環境。
  要啟用自動部署，到 GitHub repo 的 Settings → Secrets and variables → Actions 新增 `CLOUDFLARE_API_TOKEN`（Cloudflare 後台 → My Profile → API Tokens，用「Edit Cloudflare Workers」範本，再加上 D1 Edit 權限）與 `CLOUDFLARE_ACCOUNT_ID`。沒設定的話只跑測試、不部署。
- 測試環境的邀請碼與初始理事長碼要另外設：`npx wrangler secret put JOIN_CODE --env staging`。
- 錯誤監控：Cloudflare 後台 → Workers → cil-run → Logs，可以看到伺服器錯誤、排程結果與前端回報的錯誤（`client-error`）。
