-- 邀請制活動：只有被邀請的人看得到（另外建立者、該分團團長與幹部、協會幹部可以管理）

ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';  -- public 公開｜invite 邀請制
ALTER TABLE events ADD COLUMN invite_token TEXT;                          -- 邀請連結的代碼；NULL＝沒開邀請連結

CREATE TABLE event_invites (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  invited_by  TEXT,                          -- 誰邀請的（用邀請連結加入的是 NULL）
  via         TEXT NOT NULL DEFAULT 'manual', -- manual 個別邀請｜team 整個分團｜link 邀請連結
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX event_invites_member ON event_invites(member_id);

-- 分團顏色對齊正式的分團小圖（只改還是預設色的，管理者改過的不動）
UPDATE teams SET color = '#2B9C6B' WHERE id = 'youth' AND color = '#2E9D6A';
UPDATE teams SET color = '#E76316' WHERE id = 'kids'  AND color = '#E8691A';
UPDATE teams SET color = '#7547D1' WHERE id = 'core'  AND color = '#7A4BD1';
UPDATE teams SET color = '#4E5B20' WHERE id = 'geng'  AND color = '#8A6A3B';
