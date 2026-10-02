-- 資安強化：通行金鑰、幹部兩步驟驗證、防竄改稽核、新裝置登入提醒

-- 通行金鑰（只存公鑰；私鑰永遠留在使用者的裝置裡）
CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,               -- 憑證 ID（base64url）
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  public_jwk    TEXT NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  name          TEXT,                           -- 例如「iPhone」，方便本人辨認
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX passkeys_member ON passkeys(member_id);

-- 一次性挑戰值（5 分鐘內有效，用過即刪）
CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  member_id   TEXT,
  purpose     TEXT NOT NULL,                    -- register｜login｜stepup
  expires_at  TEXT NOT NULL
);

-- 工作階段：通過兩步驟驗證的時間（幹部開啟強制驗證後，要有這個才有管理權限）
ALTER TABLE sessions ADD COLUMN mfa_at TEXT;

-- 稽核紀錄防竄改：每筆用 AUDIT_KEY 算 HMAC；每天再把當天所有 HMAC 串成一條鏈
ALTER TABLE audit_log ADD COLUMN mac TEXT;
CREATE TABLE audit_digests (
  day       TEXT PRIMARY KEY,                   -- YYYY-MM-DD（UTC）
  rows      INTEGER NOT NULL,
  digest    TEXT NOT NULL,                      -- HMAC(前一天 digest ＋ 當天所有 mac)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 登入過的裝置（只存「裝置類型＋瀏覽器」的雜湊），新裝置登入時通知本人
CREATE TABLE login_devices (
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  label       TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (member_id, device_hash)
);
