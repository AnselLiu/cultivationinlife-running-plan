-- 測試用固定帳號（只在測試專用的本機資料庫使用）
INSERT OR REPLACE INTO members (id, name, nickname, dist, grp, role, membership, consent_at, consent_version) VALUES
  ('t_chair',  '測試理事長', '理事長', 'fm', 'D', 'chair',      'active', datetime('now'), '2026-10-03.1'),
  ('t_staff',  '測試行政',   '行政',   'fm', 'D', 'staff',      'none',   datetime('now'), '2026-10-03.1'),
  ('t_super',  '測試監事',   '監事',   'fm', 'D', 'supervisor', 'none',   datetime('now'), '2026-10-03.1'),
  ('t_coach',  '測試教練',   '教練',   'fm', 'D', 'coach',      'none',   datetime('now'), '2026-10-03.1'),
  ('t_lead',   '測試團長',   '團長',   'fm', 'D', 'member',     'none',   datetime('now'), '2026-10-03.1'),
  ('t_runner', '測試跑友',   '跑友',   'hm', 'C', 'member',     'none',   datetime('now'), '2026-10-03.1'),
  ('t_other',  '路人跑友',   '路人',   'fm', 'E', 'member',     'none',   datetime('now'), '2026-10-03.1');
INSERT OR REPLACE INTO team_members (team_id, member_id, role, status) VALUES
  ('geng', 't_coach', 'officer', 'active'),
  ('youth', 't_lead', 'lead', 'active'),
  ('youth', 't_runner', 'member', 'active'),
  ('main', 't_other', 'member', 'active');
UPDATE settings SET value = json_set(value, '$.version', '2026-10-03.1') WHERE key = 'privacy';
UPDATE members SET main_team = 'main', club = '耕跑團' WHERE id IN ('t_other', 't_chair', 't_staff', 't_super');
UPDATE members SET main_team = 'youth', club = '耕跑青年' WHERE id IN ('t_runner', 't_lead');
UPDATE members SET main_team = 'geng', club = '耕建築' WHERE id = 't_coach';
-- 通知中心：同一秒的 35 則（測複合游標），加上一則未讀的安全通知、同一個 ref 的待辦（依活動已讀不能標掉）
WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 35)
INSERT INTO notifications (id, member_id, kind, category, ref, title, url, created_at)
  SELECT printf('nseed%011d', i), 't_other', 'event', 'event', 'e:seed', printf('測試活動 %d', i), '/#/', datetime('now', '-2 days') FROM k;
INSERT INTO notifications (id, member_id, kind, category, title, url, created_at)
  VALUES ('nseedsec00000001', 't_other', 'system', 'security', '新裝置登入', '/#/me/security', datetime('now', '-1 hour'));
INSERT INTO notifications (id, member_id, kind, category, ref, title, url, created_at) VALUES
  ('nseedtodo0000001', 't_other', 'event', 'todo', 'e:seed', '要不要調整：測試活動', '/#/e/seed', datetime('now', '-3 days')),
  ('nseedtodo0000002', 't_lead', 'event', 'todo', 'wx:seed', '要不要調整：測試活動', '/#/e/seed', datetime('now', '-3 days'));
