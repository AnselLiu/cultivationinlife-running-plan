// 成績與挑戰（PB 登錄、目標挑戰、團服、恭喜榜）的 SQL 積木：worker.js 的路由與排程 achSettle 共用；
//   ${scope} 一律是這裡寫死的字串（不是使用者輸入），參數都用 ? 綁定；tests/achieve-sql.test.mjs 用 node:sqlite 跑全部 migrations 實際執行每一句
//   規則見 docs（規格 §4、§10）：達成判斷一律整數運算；團服名額在結算時才依 rank_key 分配；同款團服（pool）一人一件

// 範圍（${scope}）：只用這幾種固定字串
export const SCOPE = {
  member: 'e.member_id = ?1',
  campaign: 'e.campaign_id = ?1',
  memberCampaigns: 'e.campaign_id IN (SELECT campaign_id FROM ach_entries WHERE member_id = ?1)',
  campaigns: 'e.campaign_id IN (SELECT value FROM json_each(?1))',
  all: '1',
};

// 核准成績（A2）：核准當下的快照（比賽日以前同距離最好的成績、是不是刷新 PB）；不能審自己的（?2＝審核者）
export const APPROVE = `UPDATE pb_records SET status = 'approved', review_by = ?2, review_at = datetime('now'), review_note = NULL, updated_at = datetime('now'),
  prev_seconds = (SELECT MIN(b.seconds) FROM pb_records b WHERE b.member_id = pb_records.member_id AND b.dist_key = pb_records.dist_key
                  AND b.km = pb_records.km AND b.status = 'approved' AND b.race_date < pb_records.race_date),
  pb_kind = CASE
    WHEN NOT EXISTS (SELECT 1 FROM pb_records b WHERE b.member_id = pb_records.member_id AND b.dist_key = pb_records.dist_key
                     AND b.km = pb_records.km AND b.status = 'approved' AND b.race_date < pb_records.race_date) THEN 'first'
    WHEN pb_records.seconds < (SELECT MIN(b.seconds) FROM pb_records b WHERE b.member_id = pb_records.member_id AND b.dist_key = pb_records.dist_key
                     AND b.km = pb_records.km AND b.status = 'approved' AND b.race_date < pb_records.race_date) THEN 'break'
    ELSE 'none' END
WHERE id = ?1 AND status IN ('pending', 'rejected') AND member_id != ?2
RETURNING id, member_id, dist_key, km, seconds, race_name, pb_kind`;

// pb／time／pace 的達成判定（參加、核准、撤銷改用別筆、結算）：證據＝符合條件、比賽日最早的那一筆
//   pb／pace 的「有基準」：至少一筆開始前的已核准成績是在挑戰發布前登錄的；基準數值是全部開始前已核准成績的 MIN（補登只會更難）
//   本人刪過會影響基準的成績（ach_base_del，見 BASE_DEL）：判定達成時改成待確認（met），由審核者確認；RETURNING 帶 status
export const PB_EVAL = (scope) => `UPDATE ach_entries AS x SET status = CASE WHEN q.review THEN 'met' ELSE 'achieved' END, met_at = datetime('now'),
  achieved_at = CASE WHEN q.review THEN NULL ELSE datetime('now') END, evidence = q.pb_id,
  rank_key = (SELECT p.race_date || ' ' || p.created_at FROM pb_records p WHERE p.id = q.pb_id), updated_at = datetime('now')
FROM (
  SELECT e.id AS eid, EXISTS (SELECT 1 FROM ach_base_del f WHERE f.campaign_id = e.campaign_id AND f.member_id = e.member_id) AS review, (
    SELECT p.id FROM pb_records p
    WHERE p.member_id = e.member_id AND p.status = 'approved' AND p.race_date BETWEEN c.start_date AND c.end_date
      AND (CASE WHEN c.dist_key IS NULL THEN p.dist_key IN ('5k', '10k', 'hm', 'fm') ELSE p.dist_key = c.dist_key END)
      AND (
        (c.kind = 'time' AND p.seconds < c.target
          AND (COALESCE(json_extract(c.opts, '$.first_time'), 0) != 1 OR NOT EXISTS (SELECT 1 FROM pb_records b WHERE b.member_id = p.member_id
               AND b.dist_key = p.dist_key AND b.status = 'approved' AND b.race_date < c.start_date AND b.seconds < c.target)))
        OR (c.kind = 'pb' AND (
          (EXISTS (SELECT 1 FROM pb_records b WHERE b.member_id = p.member_id AND b.dist_key = p.dist_key
                   AND b.status = 'approved' AND b.race_date < c.start_date AND b.created_at < c.opened_at)
           AND p.seconds < (SELECT MIN(b.seconds) FROM pb_records b WHERE b.member_id = p.member_id AND b.dist_key = p.dist_key
                       AND b.status = 'approved' AND b.race_date < c.start_date))
          OR (COALESCE(json_extract(c.opts, '$.first_ok'), 0) = 1 AND NOT EXISTS (SELECT 1 FROM pb_records b WHERE b.member_id = p.member_id
               AND b.dist_key = p.dist_key AND b.status = 'approved' AND b.race_date < c.start_date))))
        OR (c.kind = 'pace' AND EXISTS (SELECT 1 FROM pb_records b WHERE b.member_id = p.member_id AND b.dist_key = p.dist_key
                   AND b.status = 'approved' AND b.race_date < c.start_date AND b.created_at < c.opened_at)
          AND (SELECT (MIN(b.seconds) - p.seconds) * 1000 >= MIN(b.seconds) * CAST(ROUND(c.target * 10) AS INTEGER)
               FROM pb_records b WHERE b.member_id = p.member_id AND b.dist_key = p.dist_key AND b.status = 'approved' AND b.race_date < c.start_date) = 1)
      )
    ORDER BY p.race_date, p.created_at, p.id LIMIT 1) AS pb_id
  FROM ach_entries e JOIN ach_campaigns c ON c.id = e.campaign_id
  WHERE c.kind IN ('pb', 'time', 'pace') AND e.member_id IS NOT NULL
    AND ((c.status = 'open' AND e.status = 'joined')
      OR (c.status = 'settled' AND e.status IN ('joined', 'not_met') AND c.settled_at >= datetime('now', '-60 days')))
    AND ${scope}
) q
WHERE x.id = q.eid AND q.pb_id IS NOT NULL
RETURNING id, campaign_id, member_id, status`;

// 本人刪除成績（M4，同一個 batch、在 DELETE 前面）：這筆是「比賽日在開始前、同距離、挑戰發布前就登錄」的已核准成績，而且刪掉會讓比較變容易——
//   破 PB／速度上升：它比剩下的開始前成績都快（基準會變慢），或是 first_ok 挑戰裡唯一一筆開始前的成績（會變成「第一次」）；
//   首次跑進：它是唯一一筆開始前就跑進目標的。→ 記下「這位跑友、這個挑戰」（不記成績本身），之後 PB_EVAL 判定達成改成待確認。
//   進行中、或已結算 60 天內（PB_EVAL 還會補算）的挑戰，參加了沒有都記（先刪再參加也一樣）。?1 成績 id、?2 本人
export const BASE_DEL = `INSERT OR IGNORE INTO ach_base_del (campaign_id, member_id)
SELECT c.id, d.member_id FROM pb_records d JOIN ach_campaigns c ON c.kind IN ('pb', 'time', 'pace') AND d.race_date < c.start_date AND d.created_at < c.opened_at
  AND (c.status = 'open' OR (c.status = 'settled' AND c.settled_at >= datetime('now', '-60 days')))
  AND (CASE WHEN c.dist_key IS NULL THEN d.dist_key IN ('5k', '10k', 'hm', 'fm') ELSE d.dist_key = c.dist_key END)
WHERE d.id = ?1 AND d.member_id = ?2 AND d.status = 'approved'
  AND (CASE c.kind
    WHEN 'time' THEN COALESCE(json_extract(c.opts, '$.first_time'), 0) = 1 AND d.seconds < c.target
      AND NOT EXISTS (SELECT 1 FROM pb_records b WHERE b.member_id = d.member_id AND b.dist_key = d.dist_key AND b.status = 'approved'
        AND b.race_date < c.start_date AND b.seconds < c.target AND b.id != d.id)
    ELSE COALESCE(d.seconds < (SELECT MIN(b.seconds) FROM pb_records b WHERE b.member_id = d.member_id AND b.dist_key = d.dist_key AND b.status = 'approved'
        AND b.race_date < c.start_date AND b.id != d.id),
      c.kind = 'pb' AND COALESCE(json_extract(c.opts, '$.first_ok'), 0) = 1) END)`;

// 結算：累積里程與團練出席（?1 挑戰 id）；里程凍結在結束後第 4 天 00:00（台北）＝ datetime(end_date, '+4 days', '-8 hours')（UTC）
//   training_logs.updated_at 新增時是 NULL，凍結條件一定要 COALESCE(updated_at, created_at)；單筆最多算 100 公里
const FREEZE = "datetime(c.end_date, '+4 days', '-8 hours')";
const ATT_KINDS = `(SELECT value FROM json_each(COALESCE(json_extract(c.opts, '$.kinds'), '["track","core","long"]')))`;
export const KMA_EVAL = `UPDATE ach_entries AS x SET evidence = CASE WHEN q.kind = 'km' THEN printf('%.1f', q.v) ELSE CAST(q.v AS TEXT) END,
  status = CASE WHEN q.v >= q.target THEN (CASE WHEN q.confirm = 1 THEN 'met' ELSE 'achieved' END) ELSE 'not_met' END,
  met_at = CASE WHEN q.v >= q.target THEN datetime('now') END,
  achieved_at = CASE WHEN q.v >= q.target AND q.confirm = 0 THEN datetime('now') END,
  rank_key = CASE WHEN q.v >= q.target THEN q.hit || ' 00:00:00' END, updated_at = datetime('now')
FROM (
  SELECT e.id, c.kind, c.target, c.confirm,
    CASE c.kind
      WHEN 'km' THEN ROUND(COALESCE((SELECT SUM(MIN(l.km, 100)) FROM training_logs l WHERE l.member_id = e.member_id
          AND l.date BETWEEN c.start_date AND c.end_date AND l.status != 'skip' AND l.created_at < ${FREEZE} AND COALESCE(l.updated_at, l.created_at) < ${FREEZE}), 0), 1)
      ELSE (SELECT COUNT(DISTINCT s.event_id) FROM signups s JOIN events ev ON ev.id = s.event_id
          WHERE s.member_id = e.member_id AND s.status = 'in' AND s.attended_at IS NOT NULL AND ev.status = 'open'
            AND ev.kind IN ${ATT_KINDS}
            AND ev.date BETWEEN c.start_date AND c.end_date AND (c.team_id IS NULL OR ev.team_id = c.team_id)) END AS v,
    CASE c.kind
      WHEN 'km' THEN (SELECT d FROM (SELECT l.date AS d, SUM(MIN(l.km, 100)) OVER (ORDER BY l.date, l.id) AS run FROM training_logs l
          WHERE l.member_id = e.member_id AND l.date BETWEEN c.start_date AND c.end_date AND l.status != 'skip' AND l.created_at < ${FREEZE} AND COALESCE(l.updated_at, l.created_at) < ${FREEZE})
          WHERE ROUND(run, 1) >= c.target ORDER BY d LIMIT 1)
      ELSE (SELECT d FROM (SELECT ev.date AS d, ROW_NUMBER() OVER (ORDER BY ev.date, ev.id) AS n FROM signups s JOIN events ev ON ev.id = s.event_id
          WHERE s.member_id = e.member_id AND s.status = 'in' AND s.attended_at IS NOT NULL AND ev.status = 'open'
            AND ev.kind IN ${ATT_KINDS}
            AND ev.date BETWEEN c.start_date AND c.end_date AND (c.team_id IS NULL OR ev.team_id = c.team_id) GROUP BY ev.id)
          WHERE n = c.target) END AS hit
  FROM ach_entries e JOIN ach_campaigns c ON c.id = e.campaign_id
  WHERE e.campaign_id = ?1 AND e.status = 'joined' AND e.member_id IS NOT NULL AND c.kind IN ('km', 'attend')
) q
WHERE x.id = q.id`;

// 同款團服（pool）：這位跑友已經在同款的其他挑戰拿到名額（e＝參加列、c＝它的挑戰）；RANK、PROMOTE、DUPMARK、A10 共用
export const POOL_HELD = `(json_extract(c.rewards, '$.shirt.pool') IS NOT NULL AND EXISTS (SELECT 1 FROM ach_entries z JOIN ach_campaigns zc ON zc.id = z.campaign_id
  WHERE z.member_id = e.member_id AND z.campaign_id != e.campaign_id AND z.reward_state IN ('granted', 'issued')
    AND json_extract(zc.rewards, '$.shirt.pool') = json_extract(c.rewards, '$.shirt.pool')))`;

// 團服分配（結算、結算後才達成、重新排隊）：依 rank_key, joined_at, id；已結算才分配；之後才排的接在最後（base＝目前最大順位）
//   有人在候補（waiting > 0）時新排進來的一律候補，不插隊；同款已拿過的標 dup（不佔名額，但保留排隊位置）
export const RANK = (scope) => `UPDATE ach_entries AS x SET reward_rank = q.base + q.rk,
  reward_state = CASE WHEN q.dup = 1 THEN 'dup'
    WHEN q.quota IS NULL OR (q.waiting = 0 AND q.held + q.rk_nd <= q.quota) THEN 'granted' ELSE 'waitlist' END,
  updated_at = datetime('now')
FROM (
  SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d.campaign_id ORDER BY d.rank_key, d.joined_at, d.id) AS rk,
    ROW_NUMBER() OVER (PARTITION BY d.campaign_id, d.dup ORDER BY d.rank_key, d.joined_at, d.id) AS rk_nd
  FROM (
    SELECT e.id, e.campaign_id, e.rank_key, e.joined_at,
      (SELECT COALESCE(MAX(y.reward_rank), 0) FROM ach_entries y WHERE y.campaign_id = e.campaign_id) AS base,
      (SELECT COUNT(*) FROM ach_entries y WHERE y.campaign_id = e.campaign_id AND y.reward_state IN ('granted', 'issued')) AS held,
      (SELECT COUNT(*) FROM ach_entries y WHERE y.campaign_id = e.campaign_id AND y.reward_state = 'waitlist') AS waiting,
      json_extract(c.rewards, '$.shirt.quota') AS quota,
      CASE WHEN ${POOL_HELD} THEN 1 ELSE 0 END AS dup
    FROM ach_entries e JOIN ach_campaigns c ON c.id = e.campaign_id
    WHERE c.status = 'settled' AND json_extract(c.rewards, '$.shirt') IS NOT NULL
      AND e.status IN ('met', 'achieved') AND e.reward_rank IS NULL AND e.reward_state IS NULL AND e.member_id IS NOT NULL
      AND ${scope}
  ) d
) q
WHERE x.id = q.id`;

// 遞補：已結算挑戰的候補依順位補上空出來的名額；同款已拿過的跳過（由 DUPMARK 改成 dup）
//   同一句裡 POOL_HELD 看到的是更新前的資料：同一位跑友在兩個同款挑戰都輪到時，這一句只補一邊（結算早的那一場），
//   另一邊的名額留著，下一次 DUPMARK 把他改成 dup、PROMOTE 再補給下一位
export const PROMOTE = (scope) => `UPDATE ach_entries SET reward_state = 'granted', updated_at = datetime('now')
WHERE id IN (
  SELECT id FROM (
    SELECT id, pool, ROW_NUMBER() OVER (PARTITION BY member_id, pool ORDER BY settled_at, reward_rank, id) AS pn FROM (
      SELECT e.id, e.member_id, e.reward_rank, c.settled_at, json_extract(c.rewards, '$.shirt.pool') AS pool,
        ROW_NUMBER() OVER (PARTITION BY e.campaign_id ORDER BY e.reward_rank) AS rk,
        COALESCE(json_extract(c.rewards, '$.shirt.quota'), 1000000)
          - (SELECT COUNT(*) FROM ach_entries y WHERE y.campaign_id = e.campaign_id AND y.reward_state IN ('granted', 'issued')) AS free
      FROM ach_entries e JOIN ach_campaigns c ON c.id = e.campaign_id
      WHERE e.reward_state = 'waitlist' AND c.status = 'settled' AND NOT ${POOL_HELD} AND ${scope}
    ) WHERE rk <= free
  ) WHERE pool IS NULL OR pn = 1)
RETURNING id, member_id, campaign_id`;

// 候補裡後來在同款團服別的挑戰拿到名額的人改成 dup（排程每次跑、讓出名額時）
export const DUPMARK = (scope = SCOPE.all) => `UPDATE ach_entries SET reward_state = 'dup', updated_at = datetime('now')
WHERE id IN (SELECT e.id FROM ach_entries e JOIN ach_campaigns c ON c.id = e.campaign_id
             WHERE e.reward_state = 'waitlist' AND c.status = 'settled' AND ${POOL_HELD} AND ${scope})`;

// 我的挑戰清單（M6）與單一挑戰（M7）：一句；統計每場只掃一次參加列（GROUP BY）
//   體重挑戰進行中不給達成人數（s_done＝NULL）：見證的幹部比對見證前後的人數，就知道那位跑友有沒有達成
//   ?1 我的 id、?2 今天（台北）；單一挑戰另外 ?3 挑戰 id（不套清單的日期與資格條件，由 JS 判斷看不看得到）
const KINDS_SQL = ATT_KINDS;
export const MY_LIST = (single = false) => `SELECT c.*, t.name AS team_name, t.color AS team_color, t.private AS team_private,
  e.id AS eid, e.status AS estatus, e.joined_at, e.consent_at, e.met_at, e.achieved_at, e.evidence, e.review_note, e.rank_key,
  e.w_base_at, e.w_last_at, CASE WHEN e.w_token IS NOT NULL AND e.w_token_exp > datetime('now') THEN substr(e.w_token, 1, 1) END AS w_pending,
  e.shirt_size, e.size_at, e.reward_state, e.reward_rank, e.issued_at,
  CASE WHEN c.kind = 'km' THEN (SELECT ROUND(SUM(MIN(l.km, 100)), 1) FROM training_logs l WHERE l.member_id = ?1
      AND l.date BETWEEN c.start_date AND c.end_date AND l.status != 'skip') END AS p_km,
  CASE WHEN c.kind = 'attend' THEN (SELECT COUNT(DISTINCT s.event_id) FROM signups s JOIN events ev ON ev.id = s.event_id
      WHERE s.member_id = ?1 AND s.status = 'in' AND s.attended_at IS NOT NULL AND ev.status = 'open'
        AND ev.kind IN ${KINDS_SQL}
        AND ev.date BETWEEN c.start_date AND c.end_date AND (c.team_id IS NULL OR ev.team_id = c.team_id)) END AS p_att,
  CASE WHEN c.kind IN ('pb', 'time', 'pace') AND c.dist_key IS NOT NULL THEN (SELECT MIN(p.seconds) FROM pb_records p
      WHERE p.member_id = ?1 AND p.dist_key = c.dist_key AND p.status = 'approved' AND p.race_date BETWEEN c.start_date AND c.end_date) END AS p_best,
  CASE WHEN c.kind IN ('pb', 'pace') AND c.dist_key IS NOT NULL THEN (SELECT CASE WHEN MIN(p.created_at) < c.opened_at THEN MIN(p.seconds) END FROM pb_records p
      WHERE p.member_id = ?1 AND p.dist_key = c.dist_key AND p.status = 'approved' AND p.race_date < c.start_date) END AS p_base,
  CASE WHEN c.kind IN ('pb', 'pace') AND c.dist_key IS NOT NULL THEN (SELECT MIN(p.created_at) >= c.opened_at FROM pb_records p
      WHERE p.member_id = ?1 AND p.dist_key = c.dist_key AND p.status = 'approved' AND p.race_date < c.start_date) END AS p_base_late,
  (SELECT COUNT(*) FROM pb_records p WHERE p.member_id = ?1 AND p.status = 'pending') AS p_pending,
  COALESCE(st.s_joined, 0) AS s_joined, CASE WHEN c.kind = 'weight' AND c.status = 'open' THEN NULL ELSE COALESCE(st.s_done, 0) END AS s_done, COALESCE(st.s_held, 0) AS s_held,
  COALESCE(st.s_wait, 0) AS s_wait, COALESCE(st.s_issued, 0) AS s_issued,
  CASE WHEN e.status IN ('met', 'achieved') AND c.status = 'open' THEN (SELECT COUNT(*) + 1 FROM ach_entries y WHERE y.campaign_id = c.id
      AND y.status IN ('met', 'achieved') AND y.reward_state IS NOT 'declined' AND (y.rank_key, y.joined_at, y.id) < (e.rank_key, e.joined_at, e.id)) END AS position
FROM ach_campaigns c LEFT JOIN teams t ON t.id = c.team_id LEFT JOIN ach_entries e ON e.campaign_id = c.id AND e.member_id = ?1
LEFT JOIN (
  SELECT y.campaign_id AS cid, COUNT(CASE WHEN y.status != 'left' THEN 1 END) AS s_joined,
    COUNT(CASE WHEN y.status IN ('met', 'achieved') THEN 1 END) AS s_done,
    COUNT(CASE WHEN y.reward_state IN ('granted', 'issued') THEN 1 END) AS s_held,
    COUNT(CASE WHEN y.reward_state = 'waitlist' THEN 1 END) AS s_wait,
    COUNT(CASE WHEN y.reward_state = 'issued' THEN 1 END) AS s_issued
  FROM ach_entries y ${single ? 'WHERE y.campaign_id = ?3' : `JOIN ach_campaigns yc ON yc.id = y.campaign_id
  WHERE yc.status IN ('open', 'settled') AND yc.end_date >= date(?2, '-60 days')`}
  GROUP BY y.campaign_id) st ON st.cid = c.id
WHERE ${single ? 'c.id = ?3 AND ?2 IS NOT NULL' : `c.status IN ('open', 'settled') AND c.end_date >= date(?2, '-60 days')
  AND (e.id IS NOT NULL OR c.team_id IS NULL OR c.team_id IN (SELECT team_id FROM team_members WHERE member_id = ?1 AND status = 'active'))`}
ORDER BY c.status = 'settled', c.end_date
LIMIT 30`;

// 恭喜榜：只列打開恭喜榜的人；私密分團的主團只回給同團的人（id 本身就會洩漏）
//   ${teamFilter}：?4 是分團 id（NULL＝全部），主團或有效的分團成員
const TEAM_FILTER = `(?4 IS NULL OR m.main_team = ?4 OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.member_id = m.id AND tm.team_id = ?4 AND tm.status = 'active'))`;
const MAIN_TEAM = (me) => `CASE WHEN mt.private = 0 OR m.main_team IN (SELECT team_id FROM team_members WHERE member_id = ${me} AND status = 'active') THEN m.main_team END`;
// 看得到的項目（恭喜榜與按恭喜共用）：成績＝通過審核的刷新 PB 或第一筆、90 天內審核、比賽日在審核前 60 天內；
//   挑戰＝完成、90 天內、不是體重、上恭喜榜；私密分團的挑戰只有團員看得到
const PB_SEEN = `p.status = 'approved' AND p.pb_kind IN ('break', 'first') AND p.review_at >= datetime('now', '-90 days')
      AND p.race_date >= date(p.review_at, '-60 days') AND m.cheer_board = 1`;
const ACH_SEEN = `e.status = 'achieved' AND e.achieved_at >= datetime('now', '-90 days') AND c.kind != 'weight' AND json_extract(c.rewards, '$.board') = 1
      AND m.cheer_board = 1 AND (c.team_id IS NULL OR t.private = 0 OR c.team_id IN (SELECT team_id FROM team_members WHERE member_id = ?1 AND status = 'active'))`;
// 最新（M13 recent）：先挑出這一頁的 30 筆，再算恭喜數；?1 我、?2／?3 游標（at, item）、?4 分團
export const BOARD_RECENT = `SELECT b.*,
  CASE b.type WHEN 'pb' THEN (SELECT COUNT(*) FROM cheers h WHERE h.pb_id = b.ref) ELSE (SELECT COUNT(*) FROM cheers h WHERE h.entry_id = b.ref) END AS cheers,
  CASE b.type WHEN 'pb' THEN EXISTS (SELECT 1 FROM cheers h WHERE h.pb_id = b.ref AND h.member_id = ?1)
    ELSE EXISTS (SELECT 1 FROM cheers h WHERE h.entry_id = b.ref AND h.member_id = ?1) END AS cheered
FROM (
  SELECT * FROM (
    SELECT 'pb:' || p.id AS item, 'pb' AS type, p.id AS ref, p.review_at AS at, m.id AS mid, COALESCE(NULLIF(m.nickname, ''), m.name) AS mname, m.avatar,
      ${MAIN_TEAM('?1')} AS main_team,
      p.dist_key, p.km, p.seconds, p.prev_seconds, p.pb_kind, p.race_name, p.race_date, NULL AS cid, NULL AS title, NULL AS kind, NULL AS badge
    FROM pb_records p JOIN members m ON m.id = p.member_id LEFT JOIN teams mt ON mt.id = m.main_team
    WHERE ${PB_SEEN} AND ${TEAM_FILTER}
    UNION ALL
    SELECT 'ach:' || e.id, 'ach', e.id, e.achieved_at, m.id, COALESCE(NULLIF(m.nickname, ''), m.name), m.avatar,
      ${MAIN_TEAM('?1')},
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, c.id, c.title, c.kind, json_extract(c.rewards, '$.badge')
    FROM ach_entries e JOIN ach_campaigns c ON c.id = e.campaign_id JOIN members m ON m.id = e.member_id
      LEFT JOIN teams t ON t.id = c.team_id LEFT JOIN teams mt ON mt.id = m.main_team
    WHERE ${ACH_SEEN} AND ${TEAM_FILTER}
  ) WHERE (?2 IS NULL OR (at, item) < (?2, ?3)) ORDER BY at DESC, item DESC LIMIT 30
) b ORDER BY b.at DESC, b.item DESC`;

// PB 排行（M13 rank）：只列同時打開恭喜榜與 PB 排行的人；每人近三年最佳一筆；同秒同日並列；前 50＋自己（?2）
//   ?1 距離、?2 我、?4 分團（?3 不用，綁 NULL）
export const BOARD_RANK = `SELECT * FROM (
  SELECT r.*, RANK() OVER (ORDER BY r.seconds, r.race_date) AS rk FROM (
    SELECT p.member_id, p.seconds, p.race_name, p.race_date, m.avatar, COALESCE(NULLIF(m.nickname, ''), m.name) AS mname,
      ${MAIN_TEAM('?2')} AS main_team,
      ROW_NUMBER() OVER (PARTITION BY p.member_id ORDER BY p.seconds, p.race_date, p.review_at) AS n
    FROM pb_records p JOIN members m ON m.id = p.member_id LEFT JOIN teams mt ON mt.id = m.main_team
    WHERE p.status = 'approved' AND p.dist_key = ?1 AND p.race_date >= date('now', '-3 years') AND m.cheer_board = 1 AND m.cheer_rank = 1 AND ${TEAM_FILTER}
  ) r WHERE r.n = 1
) WHERE rk <= 50 OR member_id = ?2 ORDER BY rk LIMIT 51`;

// 按恭喜之前：這一則是誰的、現在看不看得到（?1 我、?2 成績或參加列 id）
export const CHEER_PB = `SELECT p.member_id AS owner, (${PB_SEEN}) AS seen FROM pb_records p JOIN members m ON m.id = p.member_id WHERE p.id = ?2`;
export const CHEER_ACH = `SELECT e.member_id AS owner, (${ACH_SEEN}) AS seen FROM ach_entries e JOIN ach_campaigns c ON c.id = e.campaign_id
  JOIN members m ON m.id = e.member_id LEFT JOIN teams t ON t.id = c.team_id WHERE e.id = ?2`;

// 成績與挑戰待辦（pb:queue、ach:queue）：清空時把所有審核者的那一則待辦標成已讀（一句、條件式）
export const SETTLE_PB_QUEUE = `UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE category = 'todo' AND ref = 'pb:queue'
  AND NOT EXISTS (SELECT 1 FROM pb_records WHERE status = 'pending')`;
export const SETTLE_ACH_QUEUE = `UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE category = 'todo' AND ref = 'ach:queue'
  AND NOT EXISTS (SELECT 1 FROM ach_entries WHERE status = 'met')`;
// 審核者（PERMS 有 achieve 的角色：理事長、行政人員；舊的 admin 算行政人員）
export const APPROVER_IDS = "SELECT id FROM members WHERE role IN ('chair', 'staff', 'admin')";

// 排程：還沒結算、結束超過 7 天的挑戰（一次一場；放棄 3 次的那一場跳過）
export const SETTLE_PICK = `SELECT * FROM ach_campaigns WHERE status = 'open' AND end_date < date(?1, '-7 days')
  AND id IS NOT (SELECT claim_key FROM job_runs WHERE job = 'ach_settle' AND attempts >= 3) ORDER BY end_date LIMIT 1`;
// 每小時那一句（CRON_PROBE）的一欄：有要結算的挑戰，或已結算的挑戰有候補而且名額還有空
export const PROBE_COL = `(EXISTS (SELECT 1 FROM ach_campaigns WHERE status = 'open' AND end_date < date(?1, '-7 days'))
   OR EXISTS (SELECT 1 FROM ach_entries w JOIN ach_campaigns c ON c.id = w.campaign_id
              WHERE w.reward_state = 'waitlist' AND c.status = 'settled'
                AND (SELECT COUNT(*) FROM ach_entries g WHERE g.campaign_id = w.campaign_id AND g.reward_state IN ('granted', 'issued'))
                    < COALESCE(json_extract(c.rewards, '$.shirt.quota'), 1000000)))`;

// 每日清理（retention）多 4 句：見證制體重挑戰結束 30 天後刪體重（取消的立刻刪，這裡是保險）；截圖審核完成 7 天後刪、一直沒審的 180 天後刪；
//   給審核的說明審核完成 7 天後清空（目的已達成）；婉拒、撤銷的成績 180 天後刪
//   每一句的條件也做成 EXISTS，放進每小時那一句（CRON_PROBE 的 ach_ret 欄，位元 1、2、4、8）：沒東西要清的那幾句不送，
//   清理的子請求跟原本一樣（同一個整點的跑者休息站同步、每日備份不會因此被擠到下個整點）
const R_PRIVATE = "campaign_id IN (SELECT id FROM ach_campaigns WHERE status = 'cancelled' OR end_date < date('now', '+8 hours', '-30 days'))";
const R_PROOFS = "pb_id IN (SELECT id FROM pb_records WHERE (status IN ('approved', 'rejected', 'revoked') AND review_at < datetime('now', '-7 days')) OR (status = 'pending' AND updated_at < datetime('now', '-180 days')))";
const R_NOTE = "note IS NOT NULL AND status IN ('approved', 'rejected', 'revoked') AND review_at < datetime('now', '-7 days')";
const R_REJECTED = "status IN ('rejected', 'revoked') AND review_at < datetime('now', '-180 days')";
export const RETENTION = [
  ['ach_private', `DELETE FROM ach_private WHERE ${R_PRIVATE}`],
  ['pb_proofs', `DELETE FROM pb_proofs WHERE ${R_PROOFS}`],
  ['pb_note', `UPDATE pb_records SET note = NULL WHERE ${R_NOTE}`],
  ['pb_rejected', `DELETE FROM pb_records WHERE ${R_REJECTED}`],
];
export const RETENTION_PROBE = `((EXISTS (SELECT 1 FROM ach_private WHERE ${R_PRIVATE}))
  | (EXISTS (SELECT 1 FROM pb_proofs WHERE ${R_PROOFS}) << 1)
  | (EXISTS (SELECT 1 FROM pb_records WHERE ${R_NOTE}) << 2)
  | (EXISTS (SELECT 1 FROM pb_records WHERE ${R_REJECTED}) << 3))`;
