-- 報名歷程與活動報名頁（參考活動小醬）：取消時間與方式、第一次報名時間、攜伴姓名；
--   活動的報名成功訊息、攜伴算名額、會員揪團的開團人可管理。只加欄位（ALTER TABLE ADD COLUMN 不重寫整張表）

-- 取消：最近一次取消的時間（UTC，datetime('now')）與方式；重新報名時兩欄清掉
ALTER TABLE signups ADD COLUMN cancelled_at TEXT;
ALTER TABLE signups ADD COLUMN cancel_by TEXT;          -- self 本人｜organizer 主辦移出或婉拒｜uninvite 取消邀請｜expired 申請逾期
-- 第一次報名時間：取消後重報 created_at 會重設成現在（排到最後），這欄不變
ALTER TABLE signups ADD COLUMN first_at TEXT;
UPDATE signups SET first_at = created_at WHERE first_at IS NULL;
-- 攜伴姓名：JSON 陣列，最多 guest_max 位、每位 20 字；只有主辦看得到
ALTER TABLE signups ADD COLUMN guest_names TEXT;

-- 報名成功後顯示的訊息（主辦自訂，100 字內）
ALTER TABLE events ADD COLUMN success_msg TEXT;
-- 攜伴也佔名額：1＝名額算「本人＋攜伴」；新活動表單預設勾選，舊活動維持 0（行為不變）
ALTER TABLE events ADD COLUMN count_guests INTEGER NOT NULL DEFAULT 0;
-- 會員揪團（功能開關 meetup）：1＝開團的會員本人可以編輯、刪除、看統計與名單
ALTER TABLE events ADD COLUMN owner_managed INTEGER NOT NULL DEFAULT 0;
