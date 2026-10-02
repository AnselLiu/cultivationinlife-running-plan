-- 角色分層、通知中心、教練發布課表、春酒（報到與抽獎）

-- members.role 可用值：member 團員｜coach 教練｜staff 行政人員｜director 理事｜supervisor 監事｜chair 理事長
-- （原本的 'admin' 視同 staff，由程式相容處理）
ALTER TABLE members ADD COLUMN title TEXT;        -- 顯示用職稱，例如「副理事長」「活動組長」

-- 通知中心：推播送不送得出去都會留一份在這裡
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                        -- event 活動／plan 課表／signup 報名／lottery 抽獎／system
  title      TEXT NOT NULL,
  body       TEXT,
  url        TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX notif_member ON notifications(member_id, read_at);

-- 教練發布的課表（優先於內建的 season-2026.json）
CREATE TABLE plan_posts (
  id         TEXT PRIMARY KEY,
  week_no    INTEGER,
  title      TEXT NOT NULL,
  phase      TEXT,
  body       TEXT NOT NULL,                        -- 課表原文（照 LINE 記事本格式貼上）
  author_id  TEXT REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX plan_week ON plan_posts(week_no);

-- 春酒等活動的入場券與報到
CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,                     -- 入場代碼（報到時核對）
  guests        INTEGER NOT NULL DEFAULT 0,        -- 攜伴人數
  meal          TEXT,                              -- 葷食／素食
  seat          TEXT,                              -- 桌次
  checked_in_at TEXT,
  UNIQUE (event_id, member_id)
);
CREATE UNIQUE INDEX tickets_code ON tickets(code);

-- 抽獎獎項與中獎紀錄
CREATE TABLE prizes (
  id       TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  qty      INTEGER NOT NULL DEFAULT 1,
  sponsor  TEXT,
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE draws (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  prize_id   TEXT NOT NULL REFERENCES prizes(id) ON DELETE CASCADE,
  member_id  TEXT REFERENCES members(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX draws_event ON draws(event_id);

-- 活動加上春酒需要的欄位
ALTER TABLE events ADD COLUMN fee INTEGER;          -- 費用（元）
ALTER TABLE events ADD COLUMN guest_max INTEGER;    -- 每人可攜伴上限，NULL 表示不開放
ALTER TABLE events ADD COLUMN meal_options TEXT;    -- 餐點選項，逗號分隔，例如「葷食,素食」
