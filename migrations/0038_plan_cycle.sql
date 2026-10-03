-- 課表週期：預設跟協會賽季；也可以跟自己的一場比賽排 20 週
ALTER TABLE members ADD COLUMN plan_cycle   TEXT NOT NULL DEFAULT 'club';  -- club 協會賽季｜race 跟自己的比賽
ALTER TABLE members ADD COLUMN plan_race_id TEXT;                          -- plan_cycle = 'race' 時是 races.id（刪比賽時由程式改回 club）
-- 訓練紀錄記下當時是哪個週期：NULL＝協會賽季（所有舊資料）
ALTER TABLE training_logs ADD COLUMN cycle_anchor TEXT;     -- 個人週期的比賽日 YYYY-MM-DD（記錄當時的快照）
ALTER TABLE training_logs ADD COLUMN cycle_week   INTEGER;  -- 個人週期的第幾週 1–21
CREATE INDEX training_member_cycle ON training_logs(member_id, cycle_anchor, cycle_week);
