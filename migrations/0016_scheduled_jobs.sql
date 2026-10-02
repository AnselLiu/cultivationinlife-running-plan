-- 排程工作（每小時一次）：活動提醒、會費到期提醒、每季權限檢視提醒、資料保存期限清理

ALTER TABLE events ADD COLUMN remind_day_at TEXT;    -- 前一晚提醒送出的時間（避免重複）
ALTER TABLE events ADD COLUMN remind_hour_at TEXT;   -- 集合前約兩小時提醒送出的時間
ALTER TABLE members ADD COLUMN renew_notified TEXT;  -- 已經針對哪一個「會費繳至」日期提醒過

-- 每個排程工作最後一次執行（每天／每季只做一次的工作用）
CREATE TABLE job_runs (
  job       TEXT PRIMARY KEY,
  last_run  TEXT NOT NULL
);
