-- 索票、時間暫定、異動重新確認：只加欄位（ALTER TABLE ADD COLUMN 不重寫整張表）
--   索票（kind 'claim'）沿用 signups.guests 與 events.count_guests：每筆登記的張數＝1＋guests、總張數上限＝capacity，不加欄位

-- 時間暫定（待確認）：1＝集合／開始時間還沒定案；活動頁、卡片、分享、行事曆與提醒都標「暫定」，發布「改時間」時預設清掉
ALTER TABLE events ADD COLUMN time_tbd INTEGER NOT NULL DEFAULT 0;
-- 最近一次「請已報名的人重新確認」的時間（UTC，datetime('now')）；NULL＝沒有要確認
--   有效報名（in／wait／pending）的 MAX(confirmed_at, created_at) 早於這個時間＝未確認（之後才報名或取消後重報的自動算已確認）
ALTER TABLE events ADD COLUMN reconfirm_at TEXT;
-- 本人按「仍參加」的時間（UTC）；不動 created_at，候補順位不變
ALTER TABLE signups ADD COLUMN confirmed_at TEXT;
