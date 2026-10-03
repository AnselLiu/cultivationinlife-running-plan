-- 跑者休息站：幹部整理清單（source='cur'、manual=1），2026-10-03 查證
--   每筆都對照官方網站，再用第二個來源核對；說明是自己的話，不抄介紹文字；品牌名稱只當名稱，不代表有合作
--   座標：RunBase 用官網地圖連結的店家點位（與 OpenStreetMap 門牌點相差約 25 公尺）；馬拉松世界用 OpenStreetMap 門牌點（與官網街景點位相差約 20 公尺）；
--   中正紀念堂用主堂體位置（官網交通頁的步行導航終點與 OpenStreetMap 相差約 6 公尺），服務台在一樓中央通廊（官網堂內平面圖）
--   沒有查到的不寫：RunBase 板橋館、單次票價、馬拉松世界可補水；馬拉松世界的寄物規定官網沒寫，標成待確認
INSERT OR IGNORE INTO rest_stops (id, source, type, subtype, svc, access, name, place, address, city, lat, lng, cell, hours, hours_raw, fee, note, ref_url, status, manual, checked_at, hash) VALUES
  ('cur:runbase-daan', 'cur', 'shower', 'runbase', 156, 'paid', '森林跑站 RunBase 大安館', '新生南路二段 60 號 1 樓', '臺北市大安區新生南路二段60號1樓', '臺北市',
    25.028465, 121.534133, '1251_6076', '週一至週五 13:30–22:00；週六、週日 07:00–15:30', NULL,
    '淋浴與寄物要付費，金額以現場公告為準', '男女分區的淋浴間與密碼鎖寄物櫃，另有可掛衣服的大型櫃；毛巾要自己帶', 'https://www.runbase.com.tw/facility/', 'ok', 1, '2026-10-03', ''),
  ('cur:marathonsworld-taipei', 'cur', 'shower', 'shop', 8, 'unverified', '馬拉松世界 台北門市', '愛國東路上，與中正紀念堂隔街相對', '臺北市中正區愛國東路70號', '臺北市',
    25.033577, 121.519506, '1251_6075', '12:00–21:00', NULL,
    NULL, '跑步用品店。第三方整理寫跑者可以免費寄物，官網沒有公告寄物規定，請先向門市確認', 'https://www.marathonsworld.com/artapp/store.html', 'ok', 1, '2026-10-03', ''),
  ('cur:cksmh-desk', 'cur', 'shower', 'locker', 8, 'public', '中正紀念堂 服務台寄物', '主堂體一樓服務台', '臺北市中正區中山南路21號', '臺北市',
    25.034576, 121.521781, '1251_6076', '每日 09:00–18:00', NULL,
    NULL, '開館時間可以在服務台寄放隨身物品；費用與大小限制官網沒有寫，休館日以官網公告為準', 'https://www.cksmh.gov.tw/News_Toggle.aspx?n=6042&sms=14473', 'ok', 1, '2026-10-03', '');
