-- 訓練紀錄延伸：教練留言、疲勞提醒

-- 教練或分團幹部對某一筆訓練的留言（只有紀錄本人、留言者看得到；本人必須有打開分享）
CREATE TABLE log_comments (
  id          TEXT PRIMARY KEY,
  log_id      TEXT NOT NULL REFERENCES training_logs(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES members(id) ON DELETE SET NULL,
  author_name TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  read_at     TEXT
);
CREATE INDEX log_comments_log ON log_comments(log_id);

-- 疲勞提醒：同一週只提醒一次（存提醒當天的日期）
ALTER TABLE members ADD COLUMN fatigue_notified TEXT;
