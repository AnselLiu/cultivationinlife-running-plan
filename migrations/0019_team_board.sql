-- 分團公告欄、排行榜（要本人同意才顯示）

CREATE TABLE team_posts (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES members(id) ON DELETE SET NULL,
  author_name TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX team_posts_team ON team_posts(team_id, pinned, created_at);

-- 出現在分團里程排行榜（預設不顯示，本人在「我的」打開）
ALTER TABLE members ADD COLUMN show_rank INTEGER NOT NULL DEFAULT 0;
