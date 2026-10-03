-- 開啟速度與前端錯誤：不存身分（沒有 member_id、沒有 IP），只有裝置類型與頁面路徑；保留 90 天
CREATE TABLE client_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,              -- 台北日期
  metric TEXT NOT NULL,           -- ready｜fcp｜lcp｜inp｜cls｜ttfb
  value REAL NOT NULL,            -- 毫秒；cls 是分數
  page TEXT,                      -- 只有路徑，不含參數
  device TEXT,                    -- 例如 iPhone・Safari
  standalone INTEGER NOT NULL DEFAULT 0,
  warm INTEGER NOT NULL DEFAULT 0 -- 有上次的暫存可以先畫
);
CREATE INDEX idx_client_metrics_day ON client_metrics(day, metric);
CREATE TABLE client_errors (
  day TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT 0,
  page TEXT,
  device TEXT,
  n INTEGER NOT NULL DEFAULT 1,
  last_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, message, source, line)
);
