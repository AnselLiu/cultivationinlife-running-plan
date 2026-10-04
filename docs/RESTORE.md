# D1 Time Travel 還原清單

資料庫要回到某個時間點（例如誤刪、錯誤的批次修改）時，優先用 D1 Time Travel（免費方案 7 天）。每日加密備份的還原步驟寫在 `tools/restore-backup.mjs` 的開頭。

Time Travel 會把整個資料庫倒回去，**連 `audit_log` 也一起倒回**。還原時間點之後本人做的撤回（刪除帳號、刪除賽事報名資料、停止分享訓練、退出排行榜、通知分類、取消推播、移除通行金鑰、登出所有裝置），以及身分變更造成的登入失效，都會跟著消失。還原後如果沒有重做，被刪掉的帳號與資料會回來，關掉的分享也會重新打開（PDPA，ISO 27001 A.5.34）。所以撤回紀錄**一定要在還原之前抓下來**，還原後再用工具產生的 SQL 重做。

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

照印出來的指令執行，存成 `withdrawals.json`。它只有一句 `SELECT`：

```sh
npx wrangler d1 execute cil-run --remote --json --command "SELECT id, at, actor_id, actor_name, actor_role, action, target_type, target_id, detail, ip_hash, mac FROM audit_log WHERE action IN ('privacy.delete', 'privacy.race_profile_delete', 'privacy.share_logs', 'privacy.show_rank', 'notif.prefs', 'push.unsubscribe', 'session.revoke_all', 'passkey.remove', 'role.change', 'role.handover', 'bootstrap.chair') AND at >= '<T 減 10 分鐘>' ORDER BY at, id" > withdrawals.json
```

- 打開檔案確認 `"success": true`，筆數合理。
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

工具只印人數摘要（不印帳號 id），輸出 `withdrawals-replay.sql`。內容依序是：

1. 重做刪除帳號（跟 `DELETE /api/me` 同一份 SQL，`src/erase.js`）。
2. 刪掉賽事報名資料（`member_private`），並清掉報名上的代報名同意。
3. 停止分享訓練、退出排行榜：最後一次是「關閉」就關掉；同一秒有開有關，以關閉為準。
4. 通知分類：照最後一次的設定。
5. 取消推播、登出所有裝置的人：刪掉他的推播訂閱（之後他在「通知設定」會重新連上）。
6. 移除的通行金鑰：用稽核記下的金鑰 id 前綴刪掉那一把。舊版紀錄沒有前綴時，工具會讓他的登入失效，並印出人數，請通知本人到「帳號與安全」確認通行金鑰。
7. 登入失效：登出所有裝置、身分變更、理事長移交（雙方）、初始理事長的人，刪掉他們的工作階段。
8. 清空倒回來的推播佇列（`push_queue`），舊推播不會重送；通知中心的內容不受影響。
9. 抓到的稽核紀錄原樣補回 `audit_log`（`INSERT OR IGNORE`，簽章照原本的）。之後再從更舊的備份還原時，也查得到這些撤回。

檢查檔案內容後匯入：

```sh
npx wrangler d1 execute cil-run --remote --file withdrawals-replay.sql
```

## 5. 確認（唯讀）

```sh
# 補回的稽核紀錄筆數，應該等於 withdrawals.json 的筆數
npx wrangler d1 execute cil-run --remote --command "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('privacy.delete', 'privacy.race_profile_delete', 'privacy.share_logs', 'privacy.show_rank', 'notif.prefs', 'push.unsubscribe', 'session.revoke_all', 'passkey.remove', 'role.change', 'role.handover', 'bootstrap.chair') AND at >= '<T 減 10 分鐘>'"
# 刪除帳號的人不在了（應該是 0）
npx wrangler d1 execute cil-run --remote --command "SELECT COUNT(*) AS n FROM members WHERE id IN (SELECT target_id FROM audit_log WHERE action = 'privacy.delete' AND at >= '<T 減 10 分鐘>')"
# 刪除賽事報名資料的人，資料不在了（應該是 0）
npx wrangler d1 execute cil-run --remote --command "SELECT COUNT(*) AS n FROM member_private WHERE member_id IN (SELECT target_id FROM audit_log WHERE action = 'privacy.race_profile_delete' AND at >= '<T 減 10 分鐘>')"
```

## 6. 收尾

- 刪掉 `withdrawals.json` 與 `withdrawals-replay.sql`。
- 寫下變更紀錄：誰執行、什麼時候、還原到哪個時間點、為什麼（ISO 27001 A.8.32 變更管理）。
- 之後幾天的稽核摘要（`audit_digests`）會從還原後的 `audit_log` 重新計算，跟還原前的摘要不同是正常的。
- 附近即時影像、跑者休息站等可以重新同步的資料，照 `tools/restore-backup.mjs` 開頭「還原後」的步驟補回。
