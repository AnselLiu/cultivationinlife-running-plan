-- 推薦人（推薦族譜）與「用 Gmail 找到推薦人」：只加欄位與部分索引（ALTER TABLE ADD COLUMN 不重寫整張表）
--   Email 本身一律不存；email_h 是 HMAC-SHA256（金鑰由 AUDIT_KEY 經 HKDF 導出，info 'email-lookup-v1'）對正規化 Email 的結果，64 位小寫十六進位
--   同一個查詢碼可能暫時在兩個帳號（Google 換了 Email、還原備份）：不設 UNIQUE，登入時把別人身上相同的查詢碼清掉，查詢遇到兩筆以上當成找不到

ALTER TABLE members ADD COLUMN email_h TEXT;
-- 讓推薦的跑友用 Gmail 找到我：1 開（預設）｜0 關（關掉時 email_h 一起清掉，之後登入也不再產生）
ALTER TABLE members ADD COLUMN email_findable INTEGER NOT NULL DEFAULT 1;

-- 推薦人：跑友帳號（referrer_id）或只填名字（referrer_name，最多 20 字）擇一
--   ON DELETE SET NULL 只是保險；刪除帳號（src/erase.js）會先把 referrer_gone 標起來再刪
ALTER TABLE members ADD COLUMN referrer_id TEXT REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE members ADD COLUMN referrer_name TEXT;
ALTER TABLE members ADD COLUMN referrer_at TEXT;                         -- UTC datetime('now')
ALTER TABLE members ADD COLUMN referrer_by TEXT;                         -- self 本人｜admin 協會幹部
ALTER TABLE members ADD COLUMN referrer_ack TEXT;                        -- NULL 等推薦人確認｜ok 推薦人確認｜denied 推薦人按了「不是我」（referrer_id 已清掉）
ALTER TABLE members ADD COLUMN referrer_gone INTEGER NOT NULL DEFAULT 0; -- 1＝推薦人刪除了帳號（referrer_id 已清掉，不留名字）
-- 首頁推薦人卡片收起（跟著帳號，不是裝置）：位元 1＝「填推薦人」那一列、2＝「用 Google 確認」那一列
ALTER TABLE members ADD COLUMN referral_hide INTEGER NOT NULL DEFAULT 0;

CREATE INDEX members_email_h ON members(email_h) WHERE email_h IS NOT NULL;
-- 往下找（族譜、待確認數、刪除帳號時 SQLite 檢查自我外鍵）都靠這個索引，沒有它每次都要掃整張 members
CREATE INDEX members_referrer ON members(referrer_id) WHERE referrer_id IS NOT NULL;
CREATE INDEX members_referrer_name ON members(referrer_name) WHERE referrer_id IS NULL AND referrer_name IS NOT NULL;
-- 刪除帳號時清掉別人通知中心裡提到這個人的推薦通知（ref＝'rf:<會員 id>'）
CREATE INDEX notif_rf ON notifications(ref) WHERE category = 'membership';
