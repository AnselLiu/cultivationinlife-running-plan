-- 每日備份分段做（免費方案一次執行 CPU 10 ms）：做到哪裡的游標（JSON：日期、表名清單、第幾張表、rowid、第幾段、每張表筆數）
--   完成標記（doneStmt）會清掉；只有 backup 與 backup_manual 用到
ALTER TABLE job_runs ADD COLUMN cursor TEXT;
