# D1 Time Travel 還原清單

資料庫要回到某個時間點（例如誤刪、錯誤的批次修改）時，優先用 D1 Time Travel（免費方案 7 天）。每日加密備份的還原步驟寫在 `tools/restore-backup.mjs` 的開頭。

Time Travel 會把整個資料庫倒回去，**連 `audit_log` 也一起倒回**。還原時間點之後本人做的撤回（刪除帳號、刪除賽事報名資料、停止分享訓練、退出排行榜、通知分類、取消推播、移除通行金鑰、登出所有裝置、退出分團、停用行事曆訂閱、刪除自己的訓練紀錄、路線與分團公告）、幹部做的移出分團，以及身分與分團身分的變更，都會跟著消失。還原後如果沒有重做，被刪掉的帳號與資料會回來，關掉的分享會重新打開，退出的分團的幹部又看得到他分享的訓練，被降級的人重新登入就拿回原本的權限（PDPA，ISO 27001 A.5.34、A.5.18）。所以撤回紀錄**一定要在還原之前抓下來**，還原後再用工具產生的 SQL 重做。

重做什麼、怎麼判斷，寫在 `tools/restore-sql.mjs` 開頭的說明；測試在 `tests/restore.test.mjs`。

## 0. 先決定時間點

- 時間一律帶時區，例如 `2026-10-04T03:00:00Z` 或 `2026-10-04T11:00:00+08:00`（`audit_log.at` 是 UTC）。下面用 `$T` 代表這個時間。
- 先在 staging 演練一次：把下面指令的 `cil-run` 換成 `cil-run-staging --env staging`，工具加 `--staging`。
- 還原期間新寫入的資料會遺失：先在團員群組公告維護時間，並在「抓撤回紀錄」與「還原」之間不要停下來（第 2、3 步連著做）。

## 1. 查要還原到哪一個 bookmark（唯讀）

```sh
npx wrangler d1 time-travel info cil-run --timestamp "$T"
```

記下輸出的 bookmark，確認時間點是對的。

## 2. 抓撤回紀錄（唯讀，一定要在還原之前）

讓工具印出查詢指令（不需要備份金鑰；時間會自動往前多抓 10 分鐘，重做是冪等的，多抓不會錯）：

```sh
node tools/restore-backup.mjs --query "$T"
```

照印出來的兩個指令執行：第一個存成 `withdrawals.json`（只有一句 `SELECT … FROM audit_log WHERE action IN (…) AND at >= '<T 減 10 分鐘>' ORDER BY at, id`，動作清單以工具印出來的為準），第二個是同一個條件的筆數（`SELECT COUNT(*)`），記下來。

- 打開檔案確認 `"success": true`。wrangler 出錯時（例如 `{"error": …}`）第 4 步的工具會整份擋下，不會當成「沒有撤回」；這時重新查，**不要繼續還原**。
- 這個檔案有會員 id 與幹部姓名：放在自己的電腦上（例如 `~/.config/cil-run/restore/`），不要放進 git、不要貼到聊天裡，用完刪掉。

## 3. 還原（緊接著第 2 步）

```sh
npx wrangler d1 time-travel restore cil-run --timestamp "$T"
```

（或用第 1 步的 `--bookmark <bookmark>`。）輸出會列出**還原前**的 bookmark，記下來：發現還原錯了，可以用它再 restore 回去。

## 4. 產生並匯入重做 SQL

```sh
node tools/restore-backup.mjs --replay withdrawals.json --since "$T"
```

工具先印「讀到幾筆撤回紀錄」：要跟第 2 步的筆數一樣，對不上就停下來重抓（還原後正式資料庫的稽核紀錄已經倒回去，只剩這個檔案）。接著只印人數摘要（不印帳號 id），輸出 `withdrawals-replay.sql`。內容依序是：

1. 重做刪除帳號（跟 `DELETE /api/me` 同一份 SQL，`src/erase.js`）。
2. 刪掉賽事報名資料（`member_private`），並清掉報名上的代報名同意。
3. 停止分享訓練、退出排行榜：最後一次是「關閉」就關掉；同一秒有開有關，以關閉為準。
4. 通知分類：照最後一次的設定。
5. 取消推播、登出所有裝置的人：刪掉他的推播訂閱（之後他在「通知設定」會重新連上）。
6. 移除的通行金鑰：用稽核記下的金鑰 id 前綴刪掉那一把。舊版紀錄沒有前綴時，工具會讓他的登入失效，並印出人數，請通知本人到「帳號與安全」確認通行金鑰。
7. 登入失效：登出所有裝置、身分變更、理事長移交（雙方）、初始理事長的人，刪掉他們的工作階段。
8. 身分與分團成員，照時間順序做到最後一次：
   - 退出分團（`team.leave`）、被移出或婉拒（`team.remove`、`team.reject`）：刪掉 `team_members` 那一列。之後又重新加入的，還原後要再加入一次（隱私優先）。
   - 身分變更（`role.change`）、理事長移交（`role.handover`，雙方）、初始理事長（`bootstrap.chair`）、分團身分（`team.role`）：重設成最後一次的身分，降級的人重新登入不會拿回原本的權限。分團身分降為團員時職稱一起清掉，其他身分的職稱保留還原時的。
   - 新紀錄的 detail 結尾有 `｜role=代碼`、`｜team=分團 id`；舊紀錄照中文名稱與分團名稱。看不懂的（被改過或格式不對）不自動做，工具印出筆數。
9. 停用或重新產生行事曆訂閱（`calendar.off`、`calendar.on`）：清掉訂閱網址的雜湊，倒回來的舊網址（可能外流過）失效；本人到「我的」重新產生。
10. 刪除自己的訓練紀錄（`log.delete`）、路線（`route.delete`）、分團公告（`team.post_delete`）：照 id 再刪一次，備註、心率、強度不會跟著回來。
11. 清空倒回來的推播佇列（`push_queue`），舊推播不會重送；通知中心的內容不受影響。
12. 抓到的稽核紀錄原樣補回 `audit_log`（`INSERT OR IGNORE`，簽章照原本的）。之後再從更舊的備份還原時，也查得到這些撤回。

檢查檔案內容後匯入：

```sh
npx wrangler d1 execute cil-run --remote --file withdrawals-replay.sql
```

## 5. 確認（唯讀）

```sh
# 補回的稽核紀錄筆數：重新執行第 2 步印出來的 COUNT 指令，應該等於第 2 步記下的筆數
# 刪除帳號的人不在了（應該是 0）
npx wrangler d1 execute cil-run --remote --command "SELECT COUNT(*) AS n FROM members WHERE id IN (SELECT target_id FROM audit_log WHERE action = 'privacy.delete' AND at >= '<T 減 10 分鐘>')"
# 刪除賽事報名資料的人，資料不在了（應該是 0）
npx wrangler d1 execute cil-run --remote --command "SELECT COUNT(*) AS n FROM member_private WHERE member_id IN (SELECT target_id FROM audit_log WHERE action = 'privacy.race_profile_delete' AND at >= '<T 減 10 分鐘>')"
# 退出分團的人不在那個分團了（應該是 0）
npx wrangler d1 execute cil-run --remote --command "SELECT COUNT(*) AS n FROM team_members t JOIN audit_log a ON a.action = 'team.leave' AND a.actor_id = t.member_id AND a.target_id = t.team_id WHERE a.at >= '<T 減 10 分鐘>'"
```

- **身分與幹部（一定要做，再公告維護結束）**：到管理後台「稽核紀錄」篩選還原時間點之後的「變更身分」「變更分團身分」「移交理事長」「移出分團」，逐筆對照名冊與各分團的幹部名單。工具印出「看不懂、要人工確認」的筆數不是 0 時，照稽核紀錄手動調整。
- **已知不會重做的**：還原時間點之後的新增與修改（新的報名、新的訓練紀錄、重新加入分團、重新產生的行事曆訂閱網址）都會消失，請在公告裡提醒團員檢查；只有撤回與權限變更會重做。
- **推播時間與分團週報開關不重做**：「每日摘要」的時間（稽核 `notif.digest`）與團長的「每週一收到分團週報」（`notif.team_report`）是便利設定，不是隱私撤回，不在重做清單裡，還原後回到備份當時的設定（通知分類 `notif.prefs` 照樣重做）。等摘要的推播（`push_held`）跟著通知中心從空的開始；每日用量估計與系統告警（`ops_daily`、`ops_alerts`）不在備份裡，還原後從空的開始，同一天的告警可能再發一次；幹部週報（`ops_reports`）在備份裡。

## 6. 收尾

- 刪掉 `withdrawals.json` 與 `withdrawals-replay.sql`。
- 寫下變更紀錄：誰執行、什麼時候、還原到哪個時間點、為什麼（ISO 27001 A.8.32 變更管理）。
- 之後幾天的稽核摘要（`audit_digests`）會從還原後的 `audit_log` 重新計算，跟還原前的摘要不同是正常的。
- 附近即時影像、跑者休息站等可以重新同步的資料，照 `tools/restore-backup.mjs` 開頭「還原後」的步驟補回。
