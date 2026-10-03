-- 練跑地圖：地點（幹部新增；團員提議要審核）、現場回報（24 小時內顯示、不顯示是誰）、畫的路線（存 GPX、開揪跑）
CREATE TABLE spots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',      -- track 田徑場｜river 河濱｜park 公園｜trail 山徑｜road 道路｜other
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  intro TEXT,
  info TEXT,                               -- JSON：surface 路面、lap 一圈距離、light 夜間照明、water 飲水、toilet 廁所、parking 停車、hours 開放時間
  status TEXT NOT NULL DEFAULT 'approved', -- approved｜pending｜rejected
  created_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_spots_status ON spots(status);
CREATE TABLE spot_reports (
  id TEXT PRIMARY KEY,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  data TEXT NOT NULL,                      -- JSON：crowd 人潮、surface 路況、light 照明、note
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_spot_reports ON spot_reports(spot_id, created_at);
CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  points TEXT NOT NULL,                    -- JSON [[lat,lng],…]
  distance INTEGER NOT NULL,               -- 公尺
  spot_id TEXT REFERENCES spots(id) ON DELETE SET NULL,
  shared INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_routes_created ON routes(created_at);
ALTER TABLE events ADD COLUMN spot_id TEXT;
ALTER TABLE events ADD COLUMN route_id TEXT;
