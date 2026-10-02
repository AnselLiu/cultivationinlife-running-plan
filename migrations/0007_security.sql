-- 資安強化（對應 ISO/IEC 27001:2022 附錄 A 的技術控制）
-- A.8.15 日誌：特權操作一律留下稽核紀錄（不可由應用程式修改或刪除）
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id    TEXT,
  actor_name  TEXT,                       -- 快照：帳號刪除後仍看得出是誰操作
  actor_role  TEXT,
  action      TEXT NOT NULL,              -- 例如 role.change、membership.update、checkin、draw、event.delete
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,                       -- 不放個資原文，只放必要的摘要
  ip_hash     TEXT                        -- IP 只存雜湊（A.5.34 個資保護）
);
CREATE INDEX audit_at ON audit_log(at);
CREATE INDEX audit_actor ON audit_log(actor_id);

-- A.8.5 安全鑑別：工作階段閒置逾時、綁定簽發時的身分，身分變更就失效
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN role_at_issue TEXT;
ALTER TABLE sessions ADD COLUMN ip_hash TEXT;
ALTER TABLE sessions ADD COLUMN ua TEXT;

-- A.8.5／A.8.16：嘗試次數限制（防止邀請碼、報到代碼被暴力猜測）
CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,            -- 例如 join:<ip_hash>
  count      INTEGER NOT NULL,
  window_end TEXT NOT NULL
);
