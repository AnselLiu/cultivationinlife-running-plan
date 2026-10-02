-- 個資法第 8 條告知後的同意紀錄
ALTER TABLE members ADD COLUMN consent_at TEXT;
ALTER TABLE members ADD COLUMN consent_version TEXT;
