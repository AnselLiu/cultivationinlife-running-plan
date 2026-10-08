// 刪除帳號（本人刪除，PDPA／A.5.34）要做的每一句 SQL：Worker 的 DELETE /api/me 與還原工具（tools/restore-backup.mjs）共用，
//   還原備份後重做備份之後的刪除，被刪掉的帳號不會跟著備份回來。參數一律是 ?1＝會員 id
//   得獎紀錄要留給協會對帳，所以只匿名化，不刪除；其他跟會員有關的表靠 members 的 ON DELETE CASCADE
export const ERASE_MEMBER = [
  "UPDATE draws SET name = '已刪除帳號', member_id = NULL WHERE member_id = ?1",
  'DELETE FROM member_private WHERE member_id = ?1',
  // 團員揪團的「發起」欄位是開團人的暱稱，跟著匿名（幹部開的活動，帶團欄位是幹部自己填的，不動）
  'UPDATE events SET lead = CASE WHEN owner_managed = 1 THEN NULL ELSE lead END, created_by = NULL WHERE created_by = ?1',
  'UPDATE plan_posts SET author_id = NULL WHERE author_id = ?1',
  "UPDATE log_comments SET author_name = '已刪除帳號' WHERE author_id = ?1",
  "UPDATE team_posts SET author_name = '已刪除帳號' WHERE author_id = ?1",
  'DELETE FROM routes WHERE created_by = ?1',
  'DELETE FROM spot_reports WHERE member_id = ?1',
  'UPDATE spots SET created_by = NULL WHERE created_by = ?1',
  'UPDATE cams SET created_by = NULL WHERE created_by = ?1',
  'UPDATE rest_stops SET created_by = NULL WHERE created_by = ?1',
  'UPDATE rest_stops SET updated_by = NULL WHERE updated_by = ?1',
  'UPDATE rest_reports SET member_id = NULL WHERE member_id = ?1',
  'UPDATE calendar_items SET created_by = NULL WHERE created_by = ?1',
  // 推薦人：被我推薦的人標成「推薦人已刪除帳號」（不留名字）；要在刪除之前做，刪掉後外鍵已經把 referrer_id 清掉、找不到人了
  'UPDATE members SET referrer_id = NULL, referrer_ack = NULL, referrer_gone = 1 WHERE referrer_id = ?1',
  // 別人通知中心裡提到我的推薦通知（ref＝rf:<我的 id>）一起刪掉
  "DELETE FROM notifications WHERE category = 'membership' AND ref = 'rf:' || ?1",
  // 成績與挑戰：已發放團服的參加列匿名化保留（協會對帳：尺寸與發放），它收到的恭喜刪掉；其他參加、成績、截圖、體重、恭喜靠 ON DELETE CASCADE；
  //   空出的團服名額由排程 achSettle 每小時遞補（不在這裡做）
  "DELETE FROM cheers WHERE entry_id IN (SELECT id FROM ach_entries WHERE member_id = ?1 AND reward_state = 'issued')",
  "UPDATE ach_entries SET member_id = NULL, consent_at = NULL, evidence = NULL, review_note = NULL, rank_key = NULL, met_at = NULL, w_token = NULL, w_token_exp = NULL, w_tries = 0, w_base_at = NULL, w_last_at = NULL WHERE member_id = ?1 AND reward_state = 'issued'",
  // 我審核、確認、發放過的紀錄：清掉審核人（別人的成績照樣在）
  'UPDATE pb_records SET review_by = NULL WHERE review_by = ?1',
  'UPDATE ach_entries SET review_by = NULL WHERE review_by = ?1',
  'UPDATE ach_entries SET issued_by = NULL WHERE issued_by = ?1',
  'DELETE FROM members WHERE id = ?1',
];
// 稽核紀錄裡代表「帳號已刪除」的動作（target_id＝會員 id）
export const ERASE_ACTIONS = ['privacy.delete'];
