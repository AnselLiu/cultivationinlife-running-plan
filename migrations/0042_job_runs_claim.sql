-- 排程工作改成兩段式：開始時先佔用，做完才標成完成；中途被終止的話，下個整點會重跑（最多 3 次）
--   last_run 的意思不變：最後一次「完成」的 key（日期、季別等），現有資料不用轉換
ALTER TABLE job_runs ADD COLUMN claim_key TEXT;     -- 目前佔用中的 key（日期、季別等）
ALTER TABLE job_runs ADD COLUMN claim_at TEXT;      -- 佔用時間（超過 15 分鐘就當作中斷了；NULL＝已釋放，可以接著做）
ALTER TABLE job_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN last_error TEXT;
ALTER TABLE job_runs ADD COLUMN done_at TEXT;
