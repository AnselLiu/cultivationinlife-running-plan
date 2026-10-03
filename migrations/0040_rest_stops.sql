-- 跑者休息站：飲水、廁所、淋浴置物、補給。政府開放資料每天、每週或每月同步，加上幹部整理的清單
--   整個功能由 settings.features 的 rest 控制，沒設就是關閉：套用這個 migration 不會讓功能上線，排程也不會同步
--   來源登錄表（網址、授權、顯名、主機白名單）寫在 src/rest.js；顯名文字不存在每一列
--   不存電話與個人姓名（運動場館的管理人欄位在解析階段就丟掉）
CREATE TABLE rest_stops (
  id TEXT PRIMARY KEY,                   -- 來源:原始代碼，例如 twd:0131h、tpt:<名稱雜湊>、cpct:D2041、cur:runbase-daan、man:ab12cd
  source TEXT NOT NULL,                  -- twd 直飲臺｜tpt 臺北公廁｜tprv 臺北河濱廁所｜ntrv 新北河濱廁所｜tpbk 河濱租借站｜cpct 中油公廁｜tbk 臺灣騎跡｜sav 運動場館｜cur 整理清單｜man 幹部新增
  type TEXT NOT NULL,                    -- water｜toilet｜shower｜supply（主要類型，決定圖示）
  subtype TEXT NOT NULL,                 -- water：fountain indoor cool refill shop｜toilet：public river station store｜shower：center pool runbase shop locker｜supply：store vending kiosk bike station
  svc INTEGER NOT NULL DEFAULT 0,        -- 服務旗標：1 飲水 2 廁所 4 淋浴 8 置物 16 補給 32 無障礙廁所 64 親子 128 座位遮蔭 256 打氣維修 512 24 小時
  access TEXT NOT NULL DEFAULT 'public', -- public 免費公共｜paid 付費入場｜customer 店家（建議先詢問）｜unverified 待確認
  name TEXT NOT NULL,
  place TEXT,                            -- 位置描述：「近 3 號門」「9號水門」
  address TEXT,
  city TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  cell TEXT NOT NULL,                    -- 0.02 度格子：floor(lat/0.02)_floor(lng/0.02)，例如 1252_6077（幹部修正位置時跟著修正後的位置）
  hours TEXT,                            -- 標準寫法（public/hours.js 解析得出來才填）
  hours_raw TEXT,                        -- 來源原文，只顯示（最多 120 字）
  fee TEXT,                              -- 收費說明（自己的話）
  note TEXT,                             -- 補充說明（自己的話；同步不會動）
  ref_url TEXT,                          -- 詳細資訊（水質頁、官網），只外連，限 https
  status TEXT NOT NULL DEFAULT 'ok',     -- ok｜paused 來源標示暫停（不出現在地圖上）｜reported 跑友回報有問題（第二批）
  enabled INTEGER NOT NULL DEFAULT 1,    -- 來源清單不再出現 → 0（不刪除）
  hidden INTEGER NOT NULL DEFAULT 0,     -- 幹部隱藏（同步不會改回來）
  fix TEXT,                              -- 幹部修正（JSON：lat lng name place hours hours_raw note access），讀取時蓋過來源值；同步不會動
  manual INTEGER NOT NULL DEFAULT 0,     -- 整理清單或幹部新增（同步不會更新或停用）
  checked_at TEXT,                       -- 整理清單最後查證日（YYYY-MM-DD）
  seen_gen INTEGER NOT NULL DEFAULT 0,   -- 分頁來源：哪一輪同步看過這列（整輪跑完才停用沒看到的列）
  hash TEXT NOT NULL DEFAULT '',         -- 來源欄位雜湊，沒變就不寫，省 D1 寫入
  created_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rest_cell ON rest_stops(cell) WHERE enabled = 1 AND hidden = 0;
CREATE INDEX idx_rest_source ON rest_stops(source, enabled);

-- 來源開關與同步狀態（管理後台）
CREATE TABLE rest_sources (
  source TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,                     -- 最後一次嘗試同步（含失敗）；開始同步時 last_error 先寫「同步中」，執行被中斷時看得出來
  last_ok_at TEXT,
  last_count INTEGER,                    -- 上次成功時的筆數（完整性檢查：少於 70% 就不寫入也不停用）
  last_error TEXT,
  data_date TEXT,                        -- 來源自己標的資料日期（顯示「資料日期」）
  etag TEXT,                             -- JSON：ETag、Last-Modified 與內容雜湊；沒變就不解析、不寫
  cursor INTEGER,                        -- 分頁來源的下一頁；NULL 表示不在同步中
  gen INTEGER NOT NULL DEFAULT 0,        -- 分頁來源的輪次
  due_now INTEGER NOT NULL DEFAULT 0,    -- 有半徑篩選的來源（第二批）：新跑點上架或搬移 → 1，下一次排程立刻跑
  rev INTEGER NOT NULL DEFAULT 0         -- 有變動就加 1；格子與地點卡快取的 key 跟著換
);
-- 第一批：不需要金鑰的來源；第二批（環境部、Cool map 等）上線時再加列
INSERT INTO rest_sources (source, enabled) VALUES ('twd', 1), ('tpt', 1), ('tprv', 1), ('ntrv', 1), ('tpbk', 1), ('cpct', 1), ('tbk', 1), ('sav', 1), ('cur', 1), ('man', 1);

-- 跑友回報（第二批才有畫面）：只顯示有幾則，不顯示是誰；30 天後刪除
CREATE TABLE rest_reports (
  id TEXT PRIMARY KEY,
  stop_id TEXT NOT NULL REFERENCES rest_stops(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  issue TEXT NOT NULL,                   -- broken 壞了｜closed 沒開｜missing 找不到｜moved 位置不對｜ok 正常可用
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rest_reports ON rest_reports(stop_id, created_at);
