-- 分團只是群組：每位成員的「主團」由管理員在後台設定，成員不能自己加入或退出

ALTER TABLE members ADD COLUMN main_team TEXT;   -- 主團（teams.id）；NULL＝還沒設定
CREATE INDEX members_main_team ON members(main_team);

-- 既有資料：只在一個分團當團員的人，直接把那團設成主團；在多個分團的優先用「耕跑團」
UPDATE members SET main_team = (
  SELECT tm.team_id FROM team_members tm WHERE tm.member_id = members.id AND tm.status = 'active'
  ORDER BY CASE tm.team_id WHEN 'main' THEN 0 ELSE 1 END, tm.created_at LIMIT 1
) WHERE main_team IS NULL;

-- 待審核的入團申請不再使用
DELETE FROM team_members WHERE status = 'pending';
