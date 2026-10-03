-- 團購、加購與收費：活動可以設商品（尺寸、庫存、每人上限）、早鳥與會員優惠、收款資訊、成團門檻
-- 報名時由伺服器算好金額存起來；團員回報轉帳後五碼，幹部確認收款；團購到貨後記錄領取
ALTER TABLE events ADD COLUMN items TEXT;
ALTER TABLE events ADD COLUMN pricing TEXT;
ALTER TABLE events ADD COLUMN pay_info TEXT;
ALTER TABLE events ADD COLUMN min_qty INTEGER;
ALTER TABLE signups ADD COLUMN items TEXT;
ALTER TABLE signups ADD COLUMN amount INTEGER;
ALTER TABLE signups ADD COLUMN amount_detail TEXT;
ALTER TABLE signups ADD COLUMN pay_ref TEXT;
ALTER TABLE signups ADD COLUMN pay_method TEXT;
ALTER TABLE signups ADD COLUMN pay_reported_at TEXT;
ALTER TABLE signups ADD COLUMN picked_at TEXT;
