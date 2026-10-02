-- 個人賽事倒數、協會預設賽事、Strava 連結

CREATE TABLE races (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                 -- 例如 2026 臺北馬拉松
  date         TEXT NOT NULL,                 -- YYYY-MM-DD
  dist         TEXT,                          -- 全馬／半馬／10K／其他
  goal         TEXT,                          -- 目標成績，例如 3:39:59
  is_primary   INTEGER NOT NULL DEFAULT 0,    -- 標題列倒數用哪一場
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX races_member ON races(member_id, date);

-- 協會層級設定（例如沒設定個人賽事時的預設倒數）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('club_race', '{"name":"2026 臺北馬拉松","date":"2026-12-20"}');

-- Strava 授權：權杖用 AES-GCM 加密後才存（A.8.24），解除連結就刪除
CREATE TABLE strava_links (
  member_id    TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  athlete_id   TEXT NOT NULL,
  enc_refresh  TEXT NOT NULL,
  enc_access   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,              -- 存取權杖到期（秒）
  scope        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
