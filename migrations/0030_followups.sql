-- 跑步體驗與社群：壞天氣提醒、跑完接續、團購到貨領取、常跑地點、會籍卡
ALTER TABLE events ADD COLUMN wx_alert_at TEXT;     -- 前一晚壞天氣提醒送出時間
ALTER TABLE events ADD COLUMN followup_at TEXT;     -- 跑完提醒「記錄訓練」送出時間
ALTER TABLE events ADD COLUMN arrived_at TEXT;      -- 團購到貨通知時間
ALTER TABLE events ADD COLUMN pickup_note TEXT;     -- 領取地點與時間
ALTER TABLE signups ADD COLUMN pick_code TEXT;      -- 團購領取 QR 的代碼
CREATE UNIQUE INDEX idx_signups_pick_code ON signups(pick_code);
ALTER TABLE members ADD COLUMN home_spot TEXT;      -- 常跑地點（首頁顯示天氣）
ALTER TABLE members ADD COLUMN renew_notice TEXT;   -- 已送出的續費提醒（到期日:天數）
