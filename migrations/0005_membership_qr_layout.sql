-- 跑友與協會會員分開、座位佈局每年可設定、領獎紀錄

-- 跑友（member）不一定是協會會員：會籍另外記
ALTER TABLE members ADD COLUMN membership      TEXT NOT NULL DEFAULT 'none';  -- none 跑友｜applied 申請中｜active 會員｜expired 已到期
ALTER TABLE members ADD COLUMN member_type     TEXT;        -- 一般會員／永久會員／贊助會員
ALTER TABLE members ADD COLUMN member_no       TEXT;        -- 會員編號
ALTER TABLE members ADD COLUMN joined_on       TEXT;        -- 入會日期
ALTER TABLE members ADD COLUMN paid_until      TEXT;        -- 會費繳到哪一年
ALTER TABLE members ADD COLUMN membership_note TEXT;
CREATE INDEX members_membership ON members(membership);

-- 每年的座位佈局由行政人員設定（JSON：{"rows":[[1,2,3,null,4,5,null],…],"stage":"舞台","foot":"IBM 產品體驗區 ×7","entry":"↑ 入口"}）
ALTER TABLE events ADD COLUMN seat_layout TEXT;

-- 領獎：抽到之後現場領取要蓋章
ALTER TABLE draws ADD COLUMN claimed_at TEXT;
