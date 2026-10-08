-- 0055 先 Google、再通行金鑰：已經有通行金鑰的帳號綁 Google 時，Google 回來先記下「待確認」，再用通行金鑰按一下確認才綁上
--   只新增資料表與欄位（ALTER TABLE ADD COLUMN 不重寫整張表）

-- 待確認的 Google 綁定：每人最多一筆（UPSERT），10 分鐘後失效；不備份（BACKUP_SKIP），刪除帳號靠 ON DELETE CASCADE
--   只存 Google 的 sub、大頭貼網址與算好的查詢碼（email_h），不存 Email
--   h_set：0 不動查詢碼｜1 照 email_h 改（null＝Email 沒驗證，清掉）｜2 綁的時候還沒同意新版隱私權政策（沒有算查詢碼）
--   mode：L 帳號與安全｜R 推薦人頁（確認後回傳的結果照原本的綁定）
--   session_th：發起綁定的工作階段（sessions.token_hash）。只有同一個工作階段可以確認：偷到登入狀態的人記下自己的 Google 帳號後，
--     傳「確認」頁的連結騙本人按通行金鑰，本人的工作階段也確認不了
CREATE TABLE google_pending (
  member_id  TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  session_th TEXT NOT NULL,
  sub        TEXT NOT NULL,
  pic        TEXT,
  email_h    TEXT,
  h_set      INTEGER NOT NULL DEFAULT 0,
  mode       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- 這個工作階段最近一次用 Google 登入或重新確認（同一個已綁定的 Google 帳號）的時間：15 分鐘內不是強制兩步驟的幹部，可以不用舊的通行金鑰就新增一把
ALTER TABLE sessions ADD COLUMN google_at TEXT;
