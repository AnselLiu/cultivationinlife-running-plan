-- 附近即時影像：政府公開攝影機的清單（每天同步一次）與來源開關
--   影像本身不存：只存鏡頭位置與來源網址，畫面由 Worker 即時轉送（/api/cams/:id/frame），最多暫存 60 秒
--   src_url 只在伺服器端使用，不回傳給前端；來源主機白名單寫在 src/cams.js（跟資安有關，不放資料庫）
CREATE TABLE cams (
  id TEXT PRIMARY KEY,                       -- 來源:原始代碼，例如 wra:189、thb:CCTV-14-0620-009-002、heo:PB243、link:ab12cd
  source TEXT NOT NULL,                      -- wra 水利署｜thb 公路局｜heo 臺北市水利處｜link 幹部手動新增的官方直播連結
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'road',         -- river 河川水利｜park 公園｜road 道路｜sky 天空市景｜coast 海岸
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  city TEXT,
  basin TEXT,
  media TEXT NOT NULL DEFAULT 'snapshot',    -- snapshot 由 Worker 轉送單張畫面｜link 只做外連，不嵌入
  src_url TEXT NOT NULL DEFAULT '',          -- 原始影像網址（link 類是空字串）
  page_url TEXT,                             -- 官方頁面（外連用）
  label TEXT,                                -- link 類的來源名稱（例如「臺北市觀光傳播局」）
  min_interval INTEGER NOT NULL DEFAULT 60,  -- 同一支鏡頭向來源抓取的最短間隔（秒）；公路局規定至少 60 秒
  manual INTEGER NOT NULL DEFAULT 0,         -- 幹部手動新增，同步時不會停用
  enabled INTEGER NOT NULL DEFAULT 1,        -- 來源清單不再出現 → 0（不刪除）
  health TEXT NOT NULL DEFAULT 'ok',         -- ok｜down（連續 3 次抓不到；每天同步後重新嘗試）
  fails INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  hash TEXT NOT NULL DEFAULT '',             -- 來源欄位的雜湊；沒變就不寫，省 D1 寫入
  created_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cams_geo ON cams(lat, lng) WHERE enabled = 1;
CREATE INDEX idx_cams_source ON cams(source, enabled);

-- 來源開關與同步狀態（管理後台「系統設定 → 附近即時影像」）
--   臺北市水利處（heo）預設關閉：要先取得水利處的書面同意；關閉時不會對它發出任何連線
CREATE TABLE cam_sources (
  source TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,                         -- 最後一次嘗試同步（含失敗）；link 類是最後一次增刪的時間
  last_ok_at TEXT,                           -- 最後一次同步成功
  last_count INTEGER,                        -- 上次成功時清單的筆數（完整性檢查：少於 70% 就不更新）
  last_error TEXT,
  rev INTEGER NOT NULL DEFAULT 0             -- 每次同步成功、開關或手動連結增刪就加 1（地點附近鏡頭的快取 key 跟著換）
);
INSERT INTO cam_sources (source, enabled) VALUES ('wra', 1), ('thb', 1), ('heo', 0), ('link', 1);
