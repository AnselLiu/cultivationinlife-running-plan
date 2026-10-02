-- LINE 登入：把 LINE 使用者對應到團員
ALTER TABLE members ADD COLUMN line_id TEXT;
ALTER TABLE members ADD COLUMN avatar TEXT;
CREATE UNIQUE INDEX members_line ON members(line_id) WHERE line_id IS NOT NULL;
