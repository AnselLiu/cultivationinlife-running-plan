-- 推播佇列：通知寫進通知中心的同時排進來，之後分批送出（免費方案一次執行只能送大約 10 台）
CREATE TABLE push_queue (
  id          INTEGER PRIMARY KEY,
  endpoint    TEXT NOT NULL REFERENCES push_subs(endpoint) ON DELETE CASCADE,   -- 取消訂閱或刪帳號時一起刪掉
  notif_id    TEXT,                       -- 收件人那一列通知的 id（推播 payload 的 id）
  payload     TEXT NOT NULL,              -- 不含 id 的推播內容 JSON（標題、內文、網址、tag）
  urgency     TEXT NOT NULL DEFAULT 'normal',
  expires_at  TEXT NOT NULL,              -- 建立時間＋TTL；過期就不送
  lease_until TEXT,                       -- 正在送的那次執行的租約
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX push_queue_ready ON push_queue(lease_until, id);
