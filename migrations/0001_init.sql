-- 耕跑團 — 第一版資料表：團員、工作階段、活動、報名、推播訂閱

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  dist        TEXT NOT NULL DEFAULT 'fm',   -- fm 全馬／hm 半馬
  grp         TEXT NOT NULL DEFAULT 'D',    -- 全馬 S–I／半馬 A–E
  role        TEXT NOT NULL DEFAULT 'member', -- member／admin
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,             -- SHA-256(token)，cookie 只放隨機權杖
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_member ON sessions(member_id);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                -- track 田徑場／core 核心／long 長跑／race 賽事／other
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,                -- YYYY-MM-DD
  gather_time TEXT,                         -- 集合時間 HH:MM
  end_time    TEXT,
  place       TEXT,
  lead        TEXT,                         -- 帶團
  note        TEXT,                         -- 注意事項（攜帶物品、補給桌…）
  week_no     INTEGER,                      -- 對應 2026 臺北馬第幾週；有值時自動帶出各組課表
  plan_text   TEXT,                         -- 自訂課表（week_no 沒填時用）
  capacity    INTEGER,                      -- 人數上限，NULL 表示不限
  signup_open INTEGER NOT NULL DEFAULT 1,
  deadline    TEXT,                         -- 報名截止 YYYY-MM-DDTHH:MM
  status      TEXT NOT NULL DEFAULT 'open', -- open／cancelled
  created_by  TEXT REFERENCES members(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX events_date ON events(date);

CREATE TABLE signups (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  grp         TEXT NOT NULL,
  dist        TEXT NOT NULL DEFAULT 'fm',
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'in',   -- in 已報名／wait 候補／cancel 取消
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, member_id)
);
CREATE INDEX signups_event ON signups(event_id, status);

CREATE TABLE push_subs (
  endpoint    TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX push_member ON push_subs(member_id);
