-- 右上角倒數：每個人自己選要倒數哪一場（自己的賽事／協會預設／不顯示），以及後台維護的常用賽事清單

ALTER TABLE members ADD COLUMN countdown_mode TEXT NOT NULL DEFAULT 'mine';   -- mine 自己的主要賽事｜club 協會預設｜off 不顯示

-- 常用賽事清單（後台「系統設定 → 倒數與捷徑」維護），團員可以從清單直接挑，不用自己打
INSERT OR IGNORE INTO settings (key, value) VALUES ('race_presets', '[]');
