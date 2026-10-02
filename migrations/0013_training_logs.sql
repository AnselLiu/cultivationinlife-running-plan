-- 訓練紀錄：照課表打卡（完成／部分完成／沒練／自主加練），記距離、時間、RPE 與感覺

CREATE TABLE training_logs (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,                 -- 實際練的日期 YYYY-MM-DD
  week_no     INTEGER,                       -- 課表週次 W1–W21（自主加練可以是空的）
  plan_day    TEXT,                          -- 課表上的那一天，例如「週二」「週五或週六」
  kind        TEXT,                          -- easy 輕鬆｜quality 質量｜long 長跑｜strength 肌力｜race 比賽｜rest 休息
  plan_text   TEXT,                          -- 當天課表原文（快照，課表之後改了也看得出當時練什麼）
  status      TEXT NOT NULL DEFAULT 'done',  -- done 完成｜partial 部分完成｜skip 沒練｜extra 自主加練
  km          REAL,
  seconds     INTEGER,
  hr          INTEGER,                       -- 平均心率
  rpe         INTEGER,                       -- 自覺強度 1–10
  feel        INTEGER,                       -- 身體感覺 1–5
  note        TEXT,
  source      TEXT,                          -- manual｜health｜file｜strava
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);
CREATE INDEX training_member_date ON training_logs(member_id, date);
CREATE INDEX training_date ON training_logs(date);

-- 分團小圖：後台上傳，前端先縮成 256px WebP 再存（base64，最多約 60KB）；icon_v 當快取版本
ALTER TABLE teams ADD COLUMN icon TEXT;
ALTER TABLE teams ADD COLUMN icon_v INTEGER;

-- 訓練紀錄預設只有自己看得到；打開才讓教練與分團幹部看到完成率與里程（看不到備註）
ALTER TABLE members ADD COLUMN share_logs INTEGER NOT NULL DEFAULT 0;

-- 預設隱私權政策新增「分團、問卷回答、訓練紀錄」：沒有自訂內容的話升版，大家下次開啟要重新同意
UPDATE settings SET value = json_set(value, '$.version', '2026-10-03.1')
  WHERE key = 'privacy' AND COALESCE(json_extract(value, '$.body'), '') = '';
