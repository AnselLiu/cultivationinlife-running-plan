-- 登入改用 Google（OpenID Connect）：取代 LINE 登入

-- Google 帳號的唯一識別碼（sub）；只存這個，不存 Email
ALTER TABLE members ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX members_google ON members(google_sub) WHERE google_sub IS NOT NULL;

-- 隱私權政策的「蒐集的資料」從 LINE 名稱與大頭貼改成 Google 名稱與大頭貼：沒有自訂內容的話升版，大家下次開啟要重新同意
UPDATE settings SET value = json_set(value, '$.version', '2026-10-03.2')
  WHERE key = 'privacy' AND COALESCE(json_extract(value, '$.body'), '') = '';
