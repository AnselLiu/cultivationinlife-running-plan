-- 外部報名連結（Google 表單索票、合作活動報名）
ALTER TABLE events ADD COLUMN link_url   TEXT;   -- 例如 https://forms.gle/xxxx
ALTER TABLE events ADD COLUMN link_label TEXT;   -- 按鈕文字，例如「索票登記」
