// 刪除帳號（本人刪除，PDPA／A.5.34）要做的每一句 SQL：Worker 的 DELETE /api/me 與還原工具（tools/restore-backup.mjs）共用，
//   還原備份後重做備份之後的刪除，被刪掉的帳號不會跟著備份回來。參數一律是 ?1＝會員 id
//   得獎紀錄要留給協會對帳，所以只匿名化，不刪除；其他跟會員有關的表靠 members 的 ON DELETE CASCADE
export const ERASE_MEMBER = [
  "UPDATE draws SET name = '已刪除帳號', member_id = NULL WHERE member_id = ?1",
  'DELETE FROM member_private WHERE member_id = ?1',
  'UPDATE events SET created_by = NULL WHERE created_by = ?1',
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
  'DELETE FROM members WHERE id = ?1',
];
// 稽核紀錄裡代表「帳號已刪除」的動作（target_id＝會員 id）
export const ERASE_ACTIONS = ['privacy.delete'];
