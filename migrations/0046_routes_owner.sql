-- 每人最多存 100 條路線（POST /api/routes 寫入前數自己的路線）與刪除帳號時刪自己的路線：用建立者查，不用整張表掃過
CREATE INDEX IF NOT EXISTS idx_routes_owner ON routes(created_by);
