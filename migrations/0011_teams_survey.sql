-- 分團（耕跑團、耕跑青年、小耕跑、核心團…）與活動問卷

-- 分團：協會底下的子團，各自有團長與幹部；名稱、介紹、LINE 群組連結都由後台設定
CREATE TABLE teams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  intro        TEXT,
  color        TEXT,                          -- #RRGGBB，分團標籤用
  line_url     TEXT,                          -- LINE 群組邀請連結；私密分團只給團員看
  join_policy  TEXT NOT NULL DEFAULT 'open',  -- open 直接加入｜approve 團長或幹部審核
  private      INTEGER NOT NULL DEFAULT 0,    -- 1：這個分團的活動只有團員看得到
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 分團成員：團長由理事長指派；幹部由團長指派；團員自己加入或申請
CREATE TABLE team_members (
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member', -- lead 團長｜officer 幹部｜member 團員
  title        TEXT,                           -- 職稱，例如 副團長、活動組
  status       TEXT NOT NULL DEFAULT 'active', -- active｜pending 待審核
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, member_id)
);
CREATE INDEX team_members_member ON team_members(member_id);

-- 活動與課表可以只屬於某個分團（NULL＝全協會）
ALTER TABLE events ADD COLUMN team_id TEXT;
ALTER TABLE plan_posts ADD COLUMN team_id TEXT;

-- 報名問卷：每個活動自訂題目（JSON），每筆報名的回答（JSON）
ALTER TABLE events ADD COLUMN questions TEXT;
ALTER TABLE signups ADD COLUMN answers TEXT;

INSERT INTO teams (id, name, color, join_policy, private, sort) VALUES
  ('main',  '耕跑團',   '#1C4698', 'open',    0, 1),
  ('youth', '耕跑青年', '#2E9D6A', 'open',    0, 2),
  ('kids',  '小耕跑',   '#E8691A', 'open',    0, 3),
  ('core',  '核心團',   '#7A4BD1', 'approve', 1, 4),
  ('geng',  '耕建築',   '#8A6A3B', 'approve', 0, 5);   -- 耕建築企業同仁

-- 跑團的所屬企業：耕建築（後台「系統設定 → 協會資訊」可以改）
UPDATE settings SET value = json_set(value, '$.parent', '耕建築', '$.parent_note', '耕建築企業支持的跑團')
  WHERE key = 'org' AND json_extract(value, '$.parent') IS NULL;

-- 既有跑友先放進耕跑團，之後各自到「我的 → 分團」加入其他團
INSERT OR IGNORE INTO team_members (team_id, member_id) SELECT 'main', id FROM members;
