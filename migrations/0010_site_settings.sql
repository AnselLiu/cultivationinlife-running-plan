-- 系統設定：協會資訊、入會表單、隱私權政策內容與版本、功能開關、協會文件
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('org', '{"name":"台灣耕跑團協會","short":"耕跑團","contact":"請透過 LINE 群組聯絡協會行政人員","join_form":"https://docs.google.com/forms/d/1QVo9rHK6nUmm0vQgFSV9HYzMd5L5pDSnLuZV69-yMHY/viewform","retention":"帳號存續期間；帳號刪除後立即刪除，惟中獎紀錄匿名化後保留 3 年供贊助對帳"}'),
  ('features', '{"studio":true,"health":true,"file":true,"strava":true,"coach":true,"party":true}'),
  ('docs', '[]'),
  ('privacy', '{"version":"2026-10-02.2","body":""}');
