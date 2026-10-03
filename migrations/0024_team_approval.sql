-- 每個分團都要由該團幹部核准入團；耕建築是公司團，成員只由耕建築自己的團長與幹部（公司人員）處理

-- 只由本團幹部管理成員：協會幹部不能代為加入、核准或設成主團（理事長仍可指派團長）
ALTER TABLE teams ADD COLUMN self_managed INTEGER NOT NULL DEFAULT 0;
UPDATE teams SET self_managed = 1 WHERE id = 'geng';

-- 入團一律要幹部核准
UPDATE teams SET join_policy = 'approve';

-- 核心團是練核心肌群的團，不是私密團
UPDATE teams SET private = 0 WHERE id = 'core';

-- 所屬跑團只會是耕跑團系列：跟著主團走（名冊、春酒座位、匯出都用這個）
UPDATE members SET club = (SELECT name FROM teams WHERE teams.id = members.main_team) WHERE main_team IS NOT NULL;
