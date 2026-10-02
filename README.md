# 耕跑團 Cultivation in Life Run

台灣耕跑團協會的團練 PWA：把原本散在 LINE 群組的團練公告、接龍報名和每週課表收在一個網站，並支援推播通知。原本的「課表教練」單頁保留在 `/coach.html`。

- **團練**：週四田徑場、週五核心日、週日長跑等活動，列出時間、地點、帶團與注意事項。
- **報名**：取代 LINE 接龍。可設人數上限與報名截止，額滿自動排候補，有人取消時候補遞補並推播通知。
- **課表**：全馬 S–I、半馬 A–E 分組課表，`MP+20''` 這種寫法會自動換算成該組的實際配速。
- **公告產生器**：幹部建立活動後，依週次帶出各組課表，產生可直接貼回 LINE 的公告文字。
- **春酒**：報名（攜伴人數、葷素）、入場券代碼、現場報到（含桌次）、抽獎（預設只抽已報到的人，一人只中一次，中獎自動通知）。
- **通知中心**：活動、課表、報名與中獎都會留一則通知，右上角鈴鐺顯示未讀數；有設推播金鑰時同時推播。
- **教練發布課表**：教練把 LINE 記事本的原文貼上就能發布，團員在「課表」頁看到該週課表並收到通知。
- **登入與身分**：LINE 登入（帶名稱與大頭貼），或用邀請碼加入。

## 架構

| 部分 | 內容 |
|---|---|
| `public/` | PWA 前端（純 HTML／CSS／JS，沒有框架，不用 build） |
| `public/app.js` | 畫面：登入、團練列表、活動詳情與報名、我的課表、新增活動、設定 |
| `public/plan.js` | 課表讀取與配速換算（畫面與公告產生器共用） |
| `public/coach.html` | 原本的課表教練單頁（整季課表、年齡分級、補給試算） |
| `public/data/season-2026.json` | 2026 臺北馬 W1–W20＋賽後恢復週的分組課表 |
| `src/worker.js` | API（Cloudflare Worker）：LINE 登入、工作階段、活動、報名、推播 |
| `src/push.js` | Web Push（RFC 8291 加密＋RFC 8292 VAPID），只用 WebCrypto |
| `migrations/` | D1 資料表 |
| `docs/` | GitHub Pages 的轉址頁（App 本體在 Cloudflare） |

**設計**：品牌色沿用課表教練頁（深藍 `#0B1B33`、藍 `#1C4698`、黃 `#FDF36D`、萊姆 `#B9D04C`），介面走 macOS／iOS 的毛玻璃風格：背景極光＋`backdrop-filter` 玻璃卡片，支援深淺色切換與 `prefers-reduced-motion`。

**角色分層**（參考人民團體組織）：

| 角色 | 權限 |
|---|---|
| `chair` 理事長 | 全部，含指派角色與職稱 |
| `director` 理事 | 建立活動、報到、抽獎、看名冊 |
| `supervisor` 監事 | 看名冊 |
| `staff` 行政人員 | 建立活動、報到、抽獎、看名冊 |
| `coach` 教練 | 建立活動、**發布課表**、報到 |
| `member` 團員 | 報名、看課表與通知 |

職稱（例如「副理事長」「活動組長」）另外用 `title` 欄位顯示，不影響權限。三組邀請碼分別對應理事長、幹部與團員：`CHAIR_CODE`、`ADMIN_CODE`、`JOIN_CODE`。

**身分與安全**：工作階段權杖放 HttpOnly cookie，資料庫只存 SHA-256；寫入類 API 只收同源 JSON 請求（擋 CSRF）；LINE 登入用 state cookie 防 CSRF。

**個資**：網站只存姓名、組別、LINE 顯示名稱與大頭貼網址、報名紀錄。協會入會申請（含身分證字號、地址）仍走官方 Google 表單，網站只放連結。

## 本機開發

```bash
npm install
cp .dev.vars.example .dev.vars     # 設邀請碼（之後可加 LINE 與推播金鑰）
npm run db:migrate:local
npm run dev                        # http://localhost:8790
```

## 部署

```bash
npx wrangler d1 create cil-run          # 把回傳的 database_id 貼進 wrangler.jsonc
npx wrangler secret put JOIN_CODE       # 團員邀請碼
npx wrangler secret put ADMIN_CODE      # 幹部碼（行政人員）
npx wrangler secret put CHAIR_CODE      # 理事長碼（之後由理事長在名冊指派其他角色）
npm run deploy
```

### LINE 登入

1. 到 [LINE Developers](https://developers.line.biz/console/) 建立 Provider → **LINE Login** channel。
2. Callback URL 填 `https://你的網域/api/line/callback`（本機測試再加一組 `http://localhost:8790/api/line/callback`）。
3. 設定 secrets：

```bash
npx wrangler secret put LINE_CHANNEL_ID
npx wrangler secret put LINE_CHANNEL_SECRET
```

沒設定時，登入畫面只顯示邀請碼，其他功能不受影響。

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
