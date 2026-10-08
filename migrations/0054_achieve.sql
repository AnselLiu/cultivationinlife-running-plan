-- 0054 成績與挑戰：PB 登錄與審核、目標挑戰（團服、徽章、恭喜榜）、恭喜
--   只新增資料表與欄位（ALTER TABLE ADD COLUMN 不重寫整張表）；功能開關 achieve 預設關閉（後台「功能開關」打開）
--   體重只有「現場見證」的體重挑戰才存，整包用 RACE_KEY 以 AES-GCM 加密（ach_private），挑戰結束 30 天後由每日清理刪除

-- 恭喜榜：1＝登入的跑友看得到我的名字、通過審核的 PB 與完成的挑戰（體重挑戰一律不上榜）；預設 0，跟 show_rank 一樣本人打開才算
ALTER TABLE members ADD COLUMN cheer_board INTEGER NOT NULL DEFAULT 0;
-- PB 排行：1＝也列入各距離 PB 排行（要同時 cheer_board = 1 才有效）；預設 0，跟恭喜榜分開同意
ALTER TABLE members ADD COLUMN cheer_rank INTEGER NOT NULL DEFAULT 0;

-- 比賽成績：本人登錄，理事長或行政人員審核；撤回＝整列刪除（不留 withdrawn）
CREATE TABLE pb_records (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  dist_key     TEXT NOT NULL,                     -- 5k｜10k｜hm｜fm｜other
  km           REAL NOT NULL,                     -- 5k 5｜10k 10｜hm 21.0975｜fm 42.195｜other 1–250（一位小數）
  seconds      INTEGER NOT NULL,                  -- 晶片時間（淨時間），秒
  race_name    TEXT NOT NULL,                     -- 最多 40 字
  race_date    TEXT NOT NULL,                     -- YYYY-MM-DD（台北日期，不能晚於今天）
  bib          TEXT,                              -- 號碼布（選填，最多 10 字；方便審核者在成績網站查）
  result_url   TEXT,                              -- 官方成績連結（https）
  note         TEXT,                              -- 給審核的說明，最多 100 字；審核完成 7 天後由每日清理清空（目的已達成）
  race_id      TEXT,                              -- 從「我的賽事」帶入時的 races.id（只是提示，不設外鍵）
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending｜approved｜rejected｜revoked
  pb_kind      TEXT,                              -- 核准當下的快照：break 刷新 PB｜first 這個距離比賽日以前沒有成績｜none
  prev_seconds INTEGER,                           -- 核准當下、比賽日以前同距離最好的成績（first＝NULL）
  edited       INTEGER NOT NULL DEFAULT 0,        -- 送出後本人改過（婉拒後重送也算）
  review_by    TEXT,                              -- 審核的幹部（不設外鍵；刪帳號時清空，見 src/erase.js）
  review_at    TEXT,
  review_note  TEXT,                              -- 婉拒或撤銷原因：只給本人與審核者，不進推播、不進稽核
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX pb_member ON pb_records(member_id, dist_key, status, race_date);
CREATE INDEX pb_pending ON pb_records(created_at) WHERE status = 'pending';
CREATE INDEX pb_board ON pb_records(review_at) WHERE status = 'approved' AND pb_kind IN ('break', 'first');
CREATE INDEX pb_rank ON pb_records(dist_key, seconds) WHERE status = 'approved';
CREATE INDEX pb_reviewed ON pb_records(review_at) WHERE status IN ('rejected', 'revoked');
CREATE INDEX pb_note ON pb_records(review_at) WHERE note IS NOT NULL;   -- 每日清理：審核完成 7 天後清空給審核的說明
-- 同一場比賽的同一個距離只能有一筆有效的（待審核或已核准）；婉拒、撤銷的可以重送
CREATE UNIQUE INDEX pb_once ON pb_records(member_id, dist_key, km, race_date) WHERE status IN ('pending', 'approved');

-- 成績截圖：data URI（image/webp 或 image/jpeg，最多 200,000 字元；前端用 canvas 重新編碼，EXIF 與定位已去掉）
--   不進每日備份（worker.js BACKUP_SKIP）；審核完成 7 天後由每日清理刪除，只留成績連結；一直沒審的 180 天後也刪
CREATE TABLE pb_proofs (
  pb_id      TEXT PRIMARY KEY REFERENCES pb_records(id) ON DELETE CASCADE,
  img        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 目標挑戰：理事長或行政人員建立
CREATE TABLE ach_campaigns (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,                     -- 最多 30 字
  intro        TEXT,                              -- 最多 300 字
  team_id      TEXT REFERENCES teams(id) ON DELETE CASCADE,   -- NULL＝全協會；有值＝只限這個分團的團員（出席只算這個分團的團練）
  members_only INTEGER NOT NULL DEFAULT 0,        -- 1＝只限協會會員（members.membership＝'active'）
  kind         TEXT NOT NULL,                     -- pb 破 PB｜time 時間門檻｜pace 速度上升｜weight 體重降低｜km 累積里程｜attend 團練出席
  dist_key     TEXT,                              -- pb／time／pace：5k｜10k｜hm｜fm；pb、pace 可以 NULL＝任一標準距離
  target       REAL,                              -- time 秒｜pace 進步 %｜weight 減少 %｜km 公里｜attend 次；pb 不用
  opts         TEXT NOT NULL DEFAULT '{}',        -- pb {"first_ok":1}｜time {"first_time":1}｜weight {"verify":"honor"|"witness"}｜attend {"kinds":["track","core","long"]}
  confirm      INTEGER NOT NULL DEFAULT 0,        -- 1＝只有 km：系統判定達成後要幹部確認（其他類型一律 0）
  rewards      TEXT NOT NULL DEFAULT '{}',        -- {"badge":"medal","board":1,"shirt":{"sizes":[...],"quota":50,"size_by":"YYYY-MM-DD","chart":"https://…","pool":"2026 團服"}}（榮譽制體重不能有 shirt）
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  join_by      TEXT NOT NULL,                     -- 報名截止（台北日期，含當天）
  status       TEXT NOT NULL DEFAULT 'draft',     -- draft｜open｜settled｜cancelled
  cancel_note  TEXT,
  pickup       TEXT,                              -- 團服領取方式（最多 60 字；「通知領取」時填，挑戰頁的團服卡顯示）
  created_by   TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  opened_at    TEXT,                              -- 發布時間（UTC）；pb／pace 的基準只認這之前登錄的成績（規格 §4.1）
  settled_at   TEXT
);
CREATE INDEX ach_c_status ON ach_campaigns(status, end_date);

-- 參加：一人一個挑戰一列；member_id NULL＝刪除帳號後只留團服發放紀錄（匿名，協會對帳用）
CREATE TABLE ach_entries (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES ach_campaigns(id) ON DELETE CASCADE,
  member_id    TEXT REFERENCES members(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'joined',    -- joined｜met 達成待確認｜achieved｜not_met｜rejected｜revoked｜left
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  consent_at   TEXT,                              -- 見證制體重挑戰：本人同意加密保存體重的時間（逐場）
  met_at       TEXT,                              -- 系統判定達成的時間（UTC）
  rank_key     TEXT,                              -- 團服名額排序用的達成日期（見規格 §4.8）
  achieved_at  TEXT,                              -- 確定達成的時間（自動或幹部確認；恭喜榜排序）
  evidence     TEXT,                              -- pb 類：pb_records.id｜km：公里（一位小數）｜attend：次數｜weight：witness 或 honor（不放數字）
  review_by    TEXT,                              -- 確認、退回或撤銷的幹部（不設外鍵；刪帳號時清空）
  review_at    TEXT,
  review_note  TEXT,                              -- 退回或撤銷原因：只給本人與幹部
  w_base_at    TEXT,                              -- 見證制體重：起始量測「已見證」的時間（NULL＝還沒有；數字在 ach_private）
  w_last_at    TEXT,                              -- 結束量測已見證的時間
  w_token      TEXT,                              -- 'b:' 或 'l:'（起始／結束）＋見證碼的 SHA-256（用過、作廢或重新產生就清掉）
  w_token_exp  TEXT,                              -- 見證碼期限（UTC）
  w_tries      INTEGER NOT NULL DEFAULT 0,        -- 這個見證碼比對不符的次數（3 次作廢）
  shirt_size   TEXT,
  size_at      TEXT,                              -- 第一次選尺寸的時間（UTC）；晚於 size_by（台北日期）＝「補訂」
  reward_state TEXT,                              -- NULL 未分配｜granted 有名額｜waitlist 候補｜issued 已發放｜declined 不需要｜dup 同款團服已在別的挑戰拿到
  reward_rank  INTEGER,                           -- 結算時依 rank_key 排的順位；之後才達成的接在後面
  issued_at    TEXT,
  issued_by    TEXT,                              -- 發放的幹部（不設外鍵；刪帳號時清空）
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ach_e_once ON ach_entries(campaign_id, member_id);
CREATE INDEX ach_e_member ON ach_entries(member_id, status);
CREATE INDEX ach_e_met ON ach_entries(campaign_id) WHERE status = 'met';
CREATE INDEX ach_e_board ON ach_entries(achieved_at) WHERE status = 'achieved';
CREATE INDEX ach_e_wait ON ach_entries(campaign_id, reward_rank) WHERE reward_state = 'waitlist';
CREATE INDEX ach_e_held ON ach_entries(campaign_id) WHERE reward_state IN ('granted', 'issued');
CREATE UNIQUE INDEX ach_e_token ON ach_entries(w_token) WHERE w_token IS NOT NULL;

-- 見證制體重挑戰的體重：v1.<iv>.<密文>（RACE_KEY、AES-GCM、AAD＝'<member_id>|ach:<campaign_id>'），
--   內容 {"b":{"kg10":724,"at":"…"},"l":{…},"p":{"w":"b","kg10":725,"at":"…"}}（b／l＝已見證、存幹部輸入的體重計讀數；p＝跑友輸入、等見證的暫存，見證後移除）
--   系統裡只有本人看得到數字；挑戰結束 30 天後、取消、退出、本人刪除或刪除帳號時刪除；金鑰遺失就解不開（短期資料，可接受）
CREATE TABLE ach_private (
  campaign_id TEXT NOT NULL REFERENCES ach_campaigns(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  enc         TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (campaign_id, member_id)
);
CREATE INDEX ach_p_member ON ach_private(member_id);

-- 恭喜：一則成績或一個達成，一人一次；只顯示人數
CREATE TABLE cheers (
  pb_id      TEXT REFERENCES pb_records(id) ON DELETE CASCADE,
  entry_id   TEXT REFERENCES ach_entries(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((pb_id IS NULL) <> (entry_id IS NULL))
);
CREATE UNIQUE INDEX cheers_pb ON cheers(pb_id, member_id) WHERE pb_id IS NOT NULL;
CREATE UNIQUE INDEX cheers_entry ON cheers(entry_id, member_id) WHERE entry_id IS NOT NULL;
CREATE INDEX cheers_member ON cheers(member_id);
