-- 跑者休息站：地點附近與詳情只讀範圍內的列（D1 依讀到的列數計費，免費方案每天 500 萬列）
--   以前的索引只有格子：附近休息站一次讀周圍 9 格全部的列（市區約 800 列）。
--   新索引是（格子, 修正後緯度, 修正後經度），查詢用同樣的運算式，SQLite 用「格子＋緯度範圍」找，只讀範圍內的列；
--   一格的清單（cell = ?）用同一個索引的前綴。舊索引拿掉，寫入時少更新一個索引
CREATE INDEX IF NOT EXISTS idx_rest_cell_pos ON rest_stops(cell, COALESCE(json_extract(fix, '$.lat'), lat), COALESCE(json_extract(fix, '$.lng'), lng)) WHERE enabled = 1 AND hidden = 0;
DROP INDEX IF EXISTS idx_rest_cell;
