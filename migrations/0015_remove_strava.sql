-- 移除 Strava 串接（協會沒有訂閱，改用 Apple 健康捷徑與 GPX／TCX 檔匯入）

DROP TABLE IF EXISTS strava_links;
UPDATE settings SET value = json_remove(value, '$.strava') WHERE key = 'features';
