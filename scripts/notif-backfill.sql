-- 通知分類回填：部署後再跑一次，補上舊版 worker 在空窗期寫入、category 是 NULL 的資料列（可重複執行）
-- 用法：wrangler d1 execute cil-run --remote --file scripts/notif-backfill.sql
-- ===== 與 migrations/0035_notification_categories.sql 分隔線以下完全相同，兩邊要一起改 =====
-- 每一步都有 category IS NULL，先比對到的規則優先，重跑也安全

-- 1) 協會群發（kind 是 system、標題自訂，所以最先處理）。時間範圍讓查詢走 audit_action_at(action, at) 索引；標題用 substr 比對，不用 LIKE，因為標題裡可能有 % 或 _
UPDATE notifications SET category = 'announce' WHERE category IS NULL AND kind = 'system' AND (url = '/#/notifications' OR EXISTS (
  SELECT 1 FROM audit_log a WHERE a.action = 'broadcast'
    AND a.at BETWEEN datetime(notifications.created_at, '-2 minutes') AND datetime(notifications.created_at, '+2 minutes')
    AND substr(a.detail, 1, length(notifications.title) + 1) = notifications.title || '｜'));
-- 2) 帳號安全（只認伺服器範本的標題，加上對應的 url）
UPDATE notifications SET category = 'security' WHERE category IS NULL AND kind = 'system' AND (
  (title = '新裝置登入' AND url = '/#/me') OR (title = '新增了一把通行金鑰' AND url = '/#/me/security')
  OR (title = '你已成為理事長' AND url = '/#/admin') OR (title = '身分更新' AND url = '/#/me')
  OR (title LIKE '%：身分更新' AND url LIKE '/#/t/%'));
-- 3) 幹部待辦
UPDATE notifications SET category = 'todo' WHERE category IS NULL AND (
  (kind = 'system' AND title = '練跑地圖：有新的地點提議' AND url LIKE '/#/map?spot=%')
  OR (kind = 'system' AND title LIKE '%：有人申請加入' AND url = '/#/admin?tab=teams')
  OR (kind = 'system' AND title = '有人申請入會' AND url = '/#/admin')
  OR (kind = 'system' AND title = '每季權限檢視' AND url = '/#/admin?tab=roles')
  OR (kind = 'event' AND title LIKE '%：有人回報繳費' AND url LIKE '/#/e/%/stats')
  OR (kind = 'event' AND title LIKE '要不要調整：%'));
-- 4) 會籍與分團
UPDATE notifications SET category = 'membership' WHERE category IS NULL AND kind = 'system' AND (
  (title LIKE '你已加入%' AND url LIKE '/#/t/%') OR (title LIKE '%：申請通過' AND url LIKE '/#/t/%')
  OR (title LIKE '你的主團：%' AND url LIKE '/#/t/%') OR (title = '入會完成' AND url = '/#/me')
  OR (url = '/#/me/card' AND (title = '會費今天到期' OR title GLOB '會費 * 天後到期'))
  OR (url LIKE '/#/map?spot=%' AND (title GLOB '「*」已加到練跑地圖' OR title GLOB '「*」沒有通過')));
-- 5) 訓練與課表
UPDATE notifications SET category = 'training' WHERE category IS NULL AND (kind IN ('log', 'plan')
  OR (kind = 'event' AND title = '跑完了嗎？' AND url LIKE '/#/log?event=%')
  OR (kind = 'system' AND url LIKE '/#/challenge?m=%' AND title GLOB '* 月跑了 * 公里'));
-- 6) 活動異動（含候補遞補成功）
UPDATE notifications SET category = 'change' WHERE category IS NULL AND (
  (kind = 'event' AND (title LIKE '活動取消：%' OR title LIKE '改地點：%' OR title LIKE '改時間：%' OR title LIKE '活動通知：%'))
  OR (kind = 'signup' AND title = '候補遞補成功'));
-- 7) 我的報名
UPDATE notifications SET category = 'signup' WHERE category IS NULL AND (kind IN ('signup', 'lottery')
  OR (kind = 'event' AND (title LIKE '明天：%' OR title GLOB '[0-2][0-9]:[0-5][0-9] 集合：*'
    OR title LIKE '明天天氣不佳：%' OR title LIKE '明天天氣提醒：%' OR title LIKE '到貨了：%')));
-- 8) 分團公告
UPDATE notifications SET category = 'announce' WHERE category IS NULL AND kind = 'event' AND url LIKE '/#/t/%' AND title LIKE '%公告：%';
-- 9) 其餘 event：新活動、定期揪跑、新問卷、你受邀參加、行事曆
UPDATE notifications SET category = 'event' WHERE category IS NULL AND kind = 'event';
-- 10) 兜底：剩下的只可能是沒比對到的群發。絕不歸到 security
UPDATE notifications SET category = 'announce' WHERE category IS NULL;

-- ref 回填（id 後面遇到 / ? & 就截斷）
UPDATE notifications SET ref = 'e:' || substr(replace(substr(url, 6), '?', '/') || '/', 1, instr(replace(substr(url, 6), '?', '/') || '/', '/') - 1)
  WHERE ref IS NULL AND url LIKE '/#/e/%' AND category NOT IN ('todo', 'security');
UPDATE notifications SET ref = 'wx:' || substr(replace(substr(url, 6), '?', '/') || '/', 1, instr(replace(substr(url, 6), '?', '/') || '/', '/') - 1)
  WHERE ref IS NULL AND category = 'todo' AND title LIKE '要不要調整：%' AND url LIKE '/#/e/%';
UPDATE notifications SET ref = 'e:' || substr(replace(substr(url, 14), '&', '/') || '/', 1, instr(replace(substr(url, 14), '&', '/') || '/', '/') - 1)
  WHERE ref IS NULL AND url LIKE '/#/log?event=%';        -- '/#/log?event=' 是 13 個字
UPDATE notifications SET ref = 'spot:' || substr(replace(substr(url, 13), '&', '/') || '/', 1, instr(replace(substr(url, 13), '&', '/') || '/', '/') - 1)
  WHERE ref IS NULL AND url LIKE '/#/map?spot=%';          -- '/#/map?spot=' 是 12 個字，所以從第 13 字開始
UPDATE notifications SET ref = 't:' || substr(replace(substr(url, 6), '?', '/') || '/', 1, instr(replace(substr(url, 6), '?', '/') || '/', '/') - 1)
  WHERE ref IS NULL AND url LIKE '/#/t/%' AND category IN ('announce', 'membership');

-- 清除舊資料裡的個資：本名、金額、轉帳帳號後五碼
UPDATE notifications SET body = '有一筆繳費回報待確認，請到活動統計查看' WHERE category = 'todo' AND title LIKE '%：有人回報繳費';
UPDATE notifications SET body = '有人' || substr(body, instr(body, '提議「')) WHERE category = 'todo' AND title = '練跑地圖：有新的地點提議' AND instr(body, '提議「') > 1;
UPDATE notifications SET body = '有人申請加入，點開審核' WHERE category = 'todo' AND title LIKE '%：有人申請加入';
UPDATE notifications SET body = '有人送出入會申請' WHERE category = 'todo' AND title = '有人申請入會';
-- 其他會員的本名：課表發布者、教練回饋、理事長移交（新資料已不放本名，舊資料一起清掉，匯出也不會帶出去）
UPDATE notifications SET body = '教練發布了' || substr(body, instr(body, ' 發布了') + 4) WHERE kind = 'plan' AND title LIKE '新課表：%' AND instr(body, ' 發布了') > 1;
UPDATE notifications SET title = '教練回饋了你的訓練' WHERE kind = 'log' AND title LIKE '% 回饋了你的訓練';
UPDATE notifications SET body = '理事長已移交給你，請重新登入後到管理後台確認幹部名單' WHERE title = '你已成為理事長' AND instr(body, ' 把理事長移交給你') > 1;
