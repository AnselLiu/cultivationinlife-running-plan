-- 0055 先 Google、再通行金鑰：已經有通行金鑰的帳號綁 Google 時，Google 回來先記下「待確認」，再用通行金鑰按一下確認才綁上
--   只新增資料表與欄位（ALTER TABLE ADD COLUMN 不重寫整張表）

-- 待確認的 Google 綁定：每人最多一筆（UPSERT），10 分鐘後失效；不備份（BACKUP_SKIP），刪除帳號靠 ON DELETE CASCADE
--   只存 Google 的 sub、名稱（最多 40 字，確認卡上給本人看是哪個帳號）、大頭貼網址與算好的查詢碼（email_h），不存 Email
--   pid：這一筆的隨機代碼。確認卡顯示時拿到，按「用通行金鑰確認」時送回；中途被換成別的 Google 帳號（重新綁定蓋掉）就對不上，要本人重新看過再確認
--   h_set：0 不動查詢碼｜1 照 email_h 改（null＝Email 沒驗證，清掉）｜2 綁的時候還沒同意新版隱私權政策（沒有算查詢碼）
--   mode：L 帳號與安全｜R 推薦人頁（確認後回傳的結果照原本的綁定）
--   session_th：發起綁定的工作階段（sessions.token_hash）。只有同一個工作階段看得到、確認得了（在別台裝置另外登入的工作階段記下的不算）。
--     偷到 cookie 的人跟本人是同一個工作階段，這一點擋不了：靠確認卡上的 Google 名稱與大頭貼讓本人看出不是自己的帳號，按「取消」
CREATE TABLE google_pending (
  member_id  TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  session_th TEXT NOT NULL,
  pid        TEXT NOT NULL,
  sub        TEXT NOT NULL,
  name       TEXT,
  pic        TEXT,
  email_h    TEXT,
  h_set      INTEGER NOT NULL DEFAULT 0,
  mode       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- 這個工作階段最近一次用 Google 登入或重新確認（同一個已綁定的 Google 帳號）的時間：15 分鐘內一般跑友（不是協會或分團幹部）可以不用舊的通行金鑰就新增一把
ALTER TABLE sessions ADD COLUMN google_at TEXT;

-- 通行金鑰挑戰值：這次新增為什麼不用現有的通行金鑰驗證（'google'＝剛用 Google 登入或重新確認），驗證時照這個寫稽核（不是驗證當下再判斷一次）
ALTER TABLE webauthn_challenges ADD COLUMN via TEXT;
