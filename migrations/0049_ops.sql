-- 幹部週報與系統健康告警（見 src/ops.js、worker.js 的 weeklyReport 與 opsAlerts）

-- 幹部週報：每週一產生上週（週一到週日）的聚合數字，協會一份、每個分團一份；只有數字，沒有姓名與金額；保存 104 週
CREATE TABLE ops_reports (
  week       TEXT NOT NULL,              -- 涵蓋那週的週一（台北日期）
  scope      TEXT NOT NULL,              -- assoc｜team:<分團 id>
  data       TEXT NOT NULL,              -- JSON，只有聚合數字（< 8 KB）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (week, scope)
);
-- 週報的「上週新增報名」不整張掃
CREATE INDEX signups_created ON signups(created_at);
-- 週報的「候補轉正」：只看活動異動的通知（遞補成功），不整張通知中心掃
CREATE INDEX notif_change_at ON notifications(created_at) WHERE category = 'change';

-- 每日用量估計（UTC 日，Cloudflare 每日額度 00:00 UTC 重置）：各 isolate 累加後每 10 分鐘最多寫一次；不含身分；保存 90 天
--   這是下限估計：isolate 被回收時最多掉 10 分鐘的計數，電腦上用 wrangler 直接寫 D1 的也不算
CREATE TABLE ops_daily (
  day TEXT PRIMARY KEY,
  req INTEGER NOT NULL DEFAULT 0, d1_q INTEGER NOT NULL DEFAULT 0, d1_read INTEGER NOT NULL DEFAULT 0, d1_write INTEGER NOT NULL DEFAULT 0,
  kv_read INTEGER NOT NULL DEFAULT 0, kv_write INTEGER NOT NULL DEFAULT 0, kv_list INTEGER NOT NULL DEFAULT 0, kv_del INTEGER NOT NULL DEFAULT 0,
  push_sent INTEGER NOT NULL DEFAULT 0, push_err INTEGER NOT NULL DEFAULT 0, push_gone INTEGER NOT NULL DEFAULT 0, push_drop INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
-- 系統告警：同一個條件一天（台北）最多一則；主鍵就是防重送的閘門；保存 180 天
CREATE TABLE ops_alerts (
  cond   TEXT NOT NULL,                 -- backup｜quota｜stops｜errors｜push｜cron
  day    TEXT NOT NULL,                 -- 台北日期
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  detail TEXT,                          -- 例如 d1Read 83%；不含個資與錯誤原文
  PRIMARY KEY (cond, day)
);
