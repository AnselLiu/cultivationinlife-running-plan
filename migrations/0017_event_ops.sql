-- 活動營運：繳費狀態、出席點名、行事曆訂閱

-- 繳費（只記錄，不串金流）：unpaid 未繳｜paid 已繳｜waived 免繳｜refunded 已退費
ALTER TABLE signups ADD COLUMN paid TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE signups ADD COLUMN paid_at TEXT;
ALTER TABLE signups ADD COLUMN paid_note TEXT;
-- 出席（一般團練點名；春酒用入場券報到，不用這欄）
ALTER TABLE signups ADD COLUMN attended_at TEXT;
-- 現場自助報到 QR 的代碼；NULL＝沒開
ALTER TABLE events ADD COLUMN attend_token TEXT;
-- 個人行事曆訂閱網址的代碼（行事曆 App 不會帶登入 cookie，所以用代碼）；只存雜湊
ALTER TABLE members ADD COLUMN cal_token_hash TEXT;
CREATE UNIQUE INDEX members_cal ON members(cal_token_hash) WHERE cal_token_hash IS NOT NULL;
