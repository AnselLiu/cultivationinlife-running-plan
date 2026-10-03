-- 0036 報名期間、審核與報名通知（0035 是通知中心 notification_categories）
--   events.signup_start：報名開始（台北時間 YYYY-MM-DDTHH:MM），NULL＝建立後立即開放
--   events.require_approval：1＝報名要主辦幹部核准（signups.status = 'pending'）
--   events.notify_signup：1＝報名成功、候補、送出申請、確認收款時通知本人；既有活動 0，維持原本行為
--   events.review_notified_at：最近一次通知主辦「有新的待審核」的時間（一小時內不重複推）
--   events.open_notified_at：已推播「開放報名」的時間；NULL＝到 signup_start 時要推
ALTER TABLE events ADD COLUMN signup_start TEXT;
ALTER TABLE events ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN notify_signup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN review_notified_at TEXT;
ALTER TABLE events ADD COLUMN open_notified_at TEXT;

-- signups.status 多一個 'pending'（status 沒有 CHECK，不用重建資料表）；婉拒＝status 'cancel' 且 review = 'rejected'
ALTER TABLE signups ADD COLUMN review TEXT;                                       -- NULL／approved／rejected
ALTER TABLE signups ADD COLUMN reviewed_by TEXT;                                  -- 審核的幹部（不設外鍵，刪帳號後紀錄仍在）
ALTER TABLE signups ADD COLUMN reviewed_at TEXT;
ALTER TABLE signups ADD COLUMN review_note TEXT;                                  -- 婉拒原因：只給本人與主辦看，不進推播、不進稽核
ALTER TABLE signups ADD COLUMN guests INTEGER;                                    -- 餐敘攜伴與餐點：待審核、候補時先記著，正取才開入場券
ALTER TABLE signups ADD COLUMN meal TEXT;
ALTER TABLE signups ADD COLUMN edited_after_review INTEGER NOT NULL DEFAULT 0;    -- 核准後又改過報名內容

-- 既有活動都沒有「之後才開放」的時間，不需要補推開放通知
UPDATE events SET open_notified_at = created_at WHERE open_notified_at IS NULL;

-- 既有餐敘：把入場券上的攜伴與餐點補回報名
UPDATE signups SET
  guests = (SELECT t.guests FROM tickets t WHERE t.event_id = signups.event_id AND t.member_id = signups.member_id),
  meal   = (SELECT t.meal   FROM tickets t WHERE t.event_id = signups.event_id AND t.member_id = signups.member_id)
WHERE EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = signups.event_id AND t.member_id = signups.member_id);

-- 入場券只給正取（不變式 1）：舊版取消報名不會刪入場券，還沒到的活動把不是正取、也還沒入場的券清掉
--   （要在上面補回攜伴與餐點之後；已經入場的保留當紀錄）
DELETE FROM tickets WHERE checked_in_at IS NULL
  AND event_id IN (SELECT id FROM events WHERE date >= date('now', '+8 hours'))
  AND NOT EXISTS (SELECT 1 FROM signups s WHERE s.event_id = tickets.event_id AND s.member_id = tickets.member_id AND s.status = 'in');

-- 報名截止以前沒檢查格式：空字串改 NULL、空白改 T、多的秒數去掉，其餘不合格式的清掉（改成活動開始時截止）
--   D1 的 GLOB 樣式最多 50 個字元（超過整個遷移會失敗）：用 ? 比對形狀，數字與範圍另外檢查
--   （測試站已用舊寫法套用過，當時沒有任何活動有截止時間，結果相同）
UPDATE events SET deadline = NULL WHERE deadline = '';
UPDATE events SET deadline = replace(deadline, ' ', 'T') WHERE deadline GLOB '????-??-?? ??:??*';
UPDATE events SET deadline = substr(deadline, 1, 16) WHERE deadline GLOB '????-??-??T??:???*';
UPDATE events SET deadline = NULL
  WHERE deadline IS NOT NULL AND (deadline NOT GLOB '????-??-??T??:??'
    OR replace(replace(replace(deadline, '-', ''), 'T', ''), ':', '') GLOB '*[^0-9]*'
    OR substr(deadline, 6, 2) NOT BETWEEN '01' AND '12' OR substr(deadline, 9, 2) NOT BETWEEN '01' AND '31'
    OR substr(deadline, 12, 2) > '23' OR substr(deadline, 15, 2) > '59');

-- 候補、待審核的排隊順序與統計
CREATE INDEX IF NOT EXISTS signups_queue ON signups(event_id, status, created_at);
-- 排程找「到了開放時間、還沒推播」的活動
CREATE INDEX IF NOT EXISTS events_open_due ON events(signup_start) WHERE open_notified_at IS NULL;
