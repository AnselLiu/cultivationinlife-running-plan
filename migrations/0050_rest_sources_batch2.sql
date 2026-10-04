-- 跑者休息站第二批來源：Cool map 涼適點（cool）、環境部全國公廁（moenv）
--   兩個都要環境部環境資料開放平臺的 API 金鑰（MOENV_KEY），只由維護工具 tools/rest-sync.mjs 在電腦上同步，Worker 不跑
--   先關著：維護工具第一次同步成功時才開啟（之前地圖上本來就沒有這兩個來源的列）；沒有金鑰時工具跳過，這裡維持關閉
--   之後在管理後台關掉，同步就不再寫
INSERT INTO rest_sources (source, enabled) VALUES ('cool', 0), ('moenv', 0) ON CONFLICT(source) DO NOTHING;
