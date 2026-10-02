-- 基本資料（報名時自動帶入，不用每次重填）、座位查詢、抽獎階段

ALTER TABLE members ADD COLUMN nickname  TEXT;   -- 耕跑團暱稱
ALTER TABLE members ADD COLUMN club      TEXT;   -- 所屬跑團（耕跑團、小耕跑、台大EMBA…）
ALTER TABLE members ADD COLUMN meal_pref TEXT;   -- 餐點偏好：葷食／素食
ALTER TABLE members ADD COLUMN phone     TEXT;   -- 聯絡電話（選填，報名餐會用）

ALTER TABLE tickets ADD COLUMN table_no INTEGER; -- 桌次（1–31）
ALTER TABLE tickets ADD COLUMN note     TEXT;    -- 備註：補識別證、中途報到…
CREATE INDEX tickets_table ON tickets(event_id, table_no);

ALTER TABLE prizes ADD COLUMN stage TEXT;        -- 階段：暖身／R1／R1(大)／R2／加碼／卓越(中)／每桌／志工獎
ALTER TABLE prizes ADD COLUMN note  TEXT;
