-- 推播摘要：可以延後的通知只寫通知中心，每天在本人選的整點推一則摘要（見 src/ops.js 的 holdable 與 worker.js 的 digest 工作）
--   ALTER TABLE ADD COLUMN 不重寫 notifications（最大的表）；部分索引只收等摘要的列，很小
ALTER TABLE members ADD COLUMN notif_digest INTEGER;        -- NULL＝即時；7–22＝每日摘要的台北整點
ALTER TABLE members ADD COLUMN notif_digest_sent TEXT;      -- 最近一次送出摘要的台北日期（一天一則）
ALTER TABLE members ADD COLUMN notif_team_report INTEGER NOT NULL DEFAULT 0;  -- 分團團長：每週一收到分團週報（1＝開）
ALTER TABLE notifications ADD COLUMN push_held INTEGER;     -- 1＝推播延到每日摘要；送出或作廢後設回 NULL
CREATE INDEX notif_held ON notifications(member_id) WHERE push_held = 1;
