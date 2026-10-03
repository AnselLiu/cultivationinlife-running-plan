-- 執行額度紀錄：一次執行因為額度停下（stopped）或超過計數（over）時寫一列；保存 90 天（retention 清理）
CREATE TABLE budget_log (
  day TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,   -- name：路由樣板（例如 POST /api/events/:id/review）或排程工作名稱
  n INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0, over INTEGER NOT NULL DEFAULT 0,
  max_sub INTEGER NOT NULL DEFAULT 0, last_at TEXT NOT NULL,
  PRIMARY KEY (day, name)
);
