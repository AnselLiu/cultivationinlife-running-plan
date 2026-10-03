-- 賽事代報名：團員填一次報名資料，幹部幫忙送團體報名；活動可以設定組別與價格

-- 賽事報名資料（身分證字號、生日、地址、緊急聯絡人…）：整包用 RACE_KEY 以 AES-GCM 加密後才存
CREATE TABLE member_private (
  member_id   TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enc         TEXT NOT NULL,
  complete    INTEGER NOT NULL DEFAULT 0,      -- 必填欄位是否都填了（不用解密就能判斷）
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 活動的組別與價格（例如 全馬 1200、半馬 1000、10K 800）；group_reg＝幹部代為團體報名
ALTER TABLE events ADD COLUMN options TEXT;
ALTER TABLE events ADD COLUMN group_reg INTEGER NOT NULL DEFAULT 0;
-- 報名時選的組別、同意把報名資料提供給這場代報名的時間
ALTER TABLE signups ADD COLUMN option TEXT;
ALTER TABLE signups ADD COLUMN reg_consent_at TEXT;

-- 隱私權政策新增「賽事代報名資料」：沒有自訂內容的話升版，大家下次開啟要重新同意
UPDATE settings SET value = json_set(value, '$.version', '2026-10-03.3')
  WHERE key = 'privacy' AND COALESCE(json_extract(value, '$.body'), '') = '';
