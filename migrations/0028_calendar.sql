-- 行事曆：國定假日（管理員每年從新北市政府資料開放平台匯入）、幹部設定的賽事提醒、定期揪跑（同一系列）、訂閱範圍
CREATE TABLE holidays (
  date TEXT PRIMARY KEY,           -- YYYY-MM-DD
  year INTEGER NOT NULL,
  name TEXT,                       -- 節日名稱；一般週末是 NULL
  is_holiday INTEGER NOT NULL,     -- 1 放假、0 補行上班
  category TEXT,
  description TEXT
);
CREATE INDEX idx_holidays_year ON holidays(year);
CREATE TABLE calendar_items (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'race',   -- race 賽事｜signup 報名開始／截止｜note 其他
  url TEXT,
  note TEXT,
  team_id TEXT,                        -- NULL＝全協會
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_calendar_items_date ON calendar_items(date);
ALTER TABLE events ADD COLUMN series_id TEXT;
CREATE INDEX idx_events_series ON events(series_id, date);
-- 行事曆訂閱：all＝看得到的所有活動＋賽事提醒；mine＝只有自己報名的
ALTER TABLE members ADD COLUMN cal_scope TEXT NOT NULL DEFAULT 'all';
