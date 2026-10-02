-- 查詢效能：所有清單都改成「有條件＋分頁」，這裡補上對應的索引

-- 稽核紀錄：依時間區間、操作類型、操作者、對象查詢
CREATE INDEX IF NOT EXISTS audit_action_at ON audit_log(action, at);
CREATE INDEX IF NOT EXISTS audit_actor_at ON audit_log(actor_id, at);
CREATE INDEX IF NOT EXISTS audit_target ON audit_log(target_id);

-- 通知中心：每人依時間往回翻
CREATE INDEX IF NOT EXISTS notif_member_at ON notifications(member_id, created_at);

-- 會員搜尋與篩選
CREATE INDEX IF NOT EXISTS members_role ON members(role);
CREATE INDEX IF NOT EXISTS members_name ON members(name);
CREATE INDEX IF NOT EXISTS members_created ON members(created_at);

-- 分團
CREATE INDEX IF NOT EXISTS team_members_team ON team_members(team_id, status, role);
CREATE INDEX IF NOT EXISTS events_team_date ON events(team_id, date);
CREATE INDEX IF NOT EXISTS plan_team ON plan_posts(team_id, created_at);

-- 個人資料查詢（匯出、我的入場券、刪除帳號）
CREATE INDEX IF NOT EXISTS signups_member ON signups(member_id);
CREATE INDEX IF NOT EXISTS tickets_member ON tickets(member_id);
CREATE INDEX IF NOT EXISTS draws_member ON draws(member_id);
