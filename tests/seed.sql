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
