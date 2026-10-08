-- 0056 一次性恢復連結：理事長「重設並登出」勾了解除 Google（或這個帳號本來就沒綁 Google）後沒有登入方式，
--   理事長私訊一個連結（https://網域/r/<代碼>）給本人，本人用 Google（可以是新的 Google 帳號）或通行金鑰接回原本的帳號
--   只新增資料表與索引（不改舊表）
-- token_hash：連結裡的代碼（32 bytes 隨機、base64url）算 SHA-256 的十六進位；代碼與網址本身不存、不寫稽核、不寫日誌
-- 24 小時內有效（expires_at，UTC）、只能用一次（used_at）；同一位跑友產生新的連結時，還沒用掉的舊連結一起刪掉；理事長重設時也刪
-- created_by：產生的理事長（會員 id，不設外鍵；理事長刪除帳號後連結照樣到期才失效）
-- 不備份（BACKUP_SKIP）；Time Travel 還原後 tools/restore-sql.mjs 全部刪掉（倒回來的列可能是已經用過的連結）；
--   刪除帳號靠 ON DELETE CASCADE；每日清理刪掉過期的
CREATE TABLE recovery_links (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX recovery_links_member ON recovery_links(member_id);
