-- 練跑地圖的初始地點：從網路公開資訊（運動筆記、新聞、各地政府與場館公告）整理的 36 個常見跑步地點，
--   座標以 OpenStreetMap 核對；說明是自己整理的文字。用固定代碼 INSERT OR IGNORE，重跑不會重複，幹部之後可以在地圖上修改
--   部分地點標在入口或停車場（例如河濱的出入口），不是跑道本身
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed01', '臺北田徑場', 'track', 25.04958, 121.55173, '位於松山區敦化北路的市立田徑場，2024 年跑道翻修後重新開放民眾使用，是市區做 400 公尺間歇與節奏跑的首選。大型賽事或活動期間可能不開放，出發前先看體育局公告。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"lap": "400 公尺", "surface": "PU 跑道（取得 WA 一級跑道認證）", "light": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed02', '國立臺北教育大學田徑場', 'track', 25.02345, 121.54525, '和平東路上的校園田徑場，依校方辦法於清晨與晚間開放社區民眾使用，是大安區跑者下班後練操場的選項。開放時段以校方最新公告為準，校內活動時可能關閉。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"hours": "平日 05:30–07:00、17:40–21:30；假日 05:30–21:30（依民國 101 年校內辦法，以最新公告為準）"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed03', '臺北市立大學天母校區田徑場', 'track', 25.1146, 121.53702, '天母地區少見的標準田徑場，在地跑團常在此練間歇與繞圈。屬校園場地，開放時段依學校規定，賽事或校隊練習期間可能限制使用。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"lap": "400 公尺"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed04', '大安森林公園', 'park', 25.03356, 121.53528, '市中心最熱門的繞圈跑點，外圈約 2 公里多，平坦又有樹蔭，晚上照明充足。假日與傍晚人多，跑快課表要注意閃避行人。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"lap": "外圈約 2.2–2.5 公里", "surface": "柏油／紅磚步道", "light": "有", "toilet": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed05', '青年公園', 'park', 25.02319, 121.50559, '萬華區的大型公園，前身是南機場，腹地寬闊，外圍步道適合輕鬆跑與恢復跑。周邊住宅密集，清晨與傍晚運動人潮多。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed06', '中正紀念堂', 'park', 25.0337, 121.51755, '沿園區外圍紅磚道繞圈，一圈約 2 公里，夜間燈光明亮，常有跑團辦晨跑活動。路線上有出入口與行人，速度課表較不適合。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"lap": "外圍一圈約 2 公里", "surface": "紅磚步道", "light": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed07', '大佳河濱公園（9 號水門）', 'river', 25.07358, 121.54011, '基隆河畔最常辦路跑賽的河濱公園，地勢平坦、視野開闊，可往上下游延伸接成 10 公里以上長距離。河濱自行車多，要靠邊跑並注意會車；颱風或大雨後可能因淹水封閉。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道", "light": "有", "water": "有", "toilet": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed08', '迎風河濱公園', 'river', 25.07319, 121.56819, '位於大直橋與中山高之間的基隆河段，球場與運動設施多，可和大佳、彩虹河濱串成長距離。自行車流量大，夜跑記得穿亮色衣物。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed09', '彩虹河濱公園（彩虹橋）', 'river', 25.05222, 121.57666, '從饒河夜市旁的彩虹橋下到基隆河畔，夜間橋身點燈、跑者多，適合下班後輕鬆跑或往觀山、迎風方向拉長距離。橋上與河濱行人和自行車多，注意速度。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道", "light": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed10', '古亭河濱公園', 'river', 25.01651, 121.52422, '新店溪右岸、靠近古亭與公館，自行車道寬又平，往下游可接華中河濱、往上游可到福和橋，適合配速跑與長距離。春季花海期間遊客較多。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油／紅磚"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed11', '華中河濱公園', 'river', 25.01993, 121.49153, '萬華華中橋旁的大型河濱公園，有露營場與多種球場，常與古亭河濱串成來回約 8 公里的平路路線。河濱自行車道會車多，颱風後注意封園公告。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道", "toilet": "有", "parking": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed12', '福和河濱公園（國手之道・文山側）', 'river', 25.00488, 121.5346, '公館一帶跑者口中的「國手之道」，永福橋到景美橋之間約 3 公里，路寬、遮蔭多，常見選手與跑團練間歇和長距離。永福橋往福和橋有一段陡下坡，速度要放慢。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油", "water": "有", "toilet": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed13', '大稻埕碼頭', 'river', 25.0567, 121.50729, '淡水河畔的經典起跑點，可往北經社子島、關渡拉長距離，全程平坦。夏季煙火與活動期間人潮與交管多，河邊風大。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed14', '關渡碼頭', 'river', 25.12069, 121.4612, '淡水河與基隆河交會處，可從關渡宮一帶沿河濱自行車道往上游或大稻埕方向跑長距離，風景開闊。沿途補給點較少，夏天要自備水。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed15', '象山步道（捷運象山站）', 'trail', 25.03287, 121.56976, '從捷運象山站步行約 5–10 分鐘即到登山口，石階密集，適合做爬坡重複與肌力訓練，不適合配速跑。觀景台常擁擠，雨後石階濕滑。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "石階／土徑"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed16', '虎山步道（松山慈惠堂登山口）', 'trail', 25.03665, 121.58767, '四獸山之一，從福德街慈惠堂上山，可串連象山、豹山、獅山做越野跑，短距離就有可觀爬升。步道有石階與泥土路段，雨天溼滑。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "石階／泥土步道"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed17', '劍潭山步道（劍潭站登山口）', 'trail', 25.08092, 121.52545, '捷運劍潭站附近上山，有木棧階梯也有陡柏油坡，能練腿力，約半小時可到老地方觀景台。雨天石階濕滑要放慢。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "石階／柏油坡"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed18', '仁愛路林蔭大道', 'road', 25.03785, 121.5469, '市中心最寬的林蔭大道，分隔島綠帶遮蔭好，元旦等路跑活動常使用。日常練跑要沿人行道並遵守路口號誌，紅綠燈多，適合輕鬆跑而非配速跑。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed19', '板橋第一運動場', 'track', 25.01017, 121.46838, '板橋體育場的田徑場，晨跑、夜跑與跑團練習都很熱門，新北市也在此開設免費跑步課。依市府規定每日清晨到晚間開放。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"hours": "每日 05:00–22:00"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed20', '新莊田徑場', 'track', 25.04219, 121.45122, '新莊體育園區內的田徑場，依市府規定全日開放，適合不想受時段限制的操場訓練。賽事或活動借用期間會封場。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"hours": "全日開放（依新北市運動場館使用管理要點）"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed21', '新北大都會公園（幸福水漾公園）', 'river', 25.0576, 121.47858, '二重疏洪道改建的超大型綠地，市府沿途設有 5K、10K、半馬、全馬里程指標，往八里方向可跑超長距離。部分路段要穿越路口，夏天幾乎無遮蔭。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed22', '八里左岸（八里渡船頭）', 'river', 25.15929, 121.43589, '淡水河左岸自行車道，一側觀音山、一側河景，屬新北慢跑里程標示系統的一段，適合週末長距離。假日遊客與自行車很多，河口風大。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed23', '新店陽光運動公園（陽光橋）', 'river', 24.97835, 121.52199, '新店溪左岸的河濱運動公園，自行車道可一路連到碧潭，適合平路長距離或碧潭來回。假日野餐與騎車人潮多。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "柏油自行車道"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed24', '新月橋河濱（板橋／新莊）', 'river', 25.02869, 121.4521, '橫跨大漢溪、連接板橋與新莊的人行景觀橋，夜間有燈光，常有跑團在此集合夜跑，再接兩岸河濱自行車道。橋上散步人潮多，起跑前先下到河濱再加速。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"light": "有（橋體光雕與河濱路燈）"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed25', '桃園市立田徑場', 'track', 24.99353, 121.32455, '桃園區的市立田徑場，翻修後於 2026 年 1 月重新對外開放，後續仍有為全運會進行的二期工程。施工或賽事期間開放範圍可能調整。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed26', '虎頭山公園', 'trail', 25.0003, 121.32931, '桃園市區旁的「後花園」，環山步道與多條支線適合越野跑與爬坡訓練，也有無障礙步道可輕鬆跑。假日登山人潮多，烤肉區附近較擁擠。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "步道／石階／泥土"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed27', '老街溪河川步道（河川教育中心）', 'river', 24.95368, 121.21804, '中壢老街溪整治後的河濱步道，全長約 10 公里，是在地人散步、慢跑與騎車的路線。部分鋪面曾有不平整的反映，夜跑注意腳下。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed28', '臺中都會公園', 'park', 24.20761, 120.59945, '大肚山台地上的 88 公頃公園，西側步道是附近居民晨跑與傍晚運動最常用的區段，路線起伏可練坡。開放時間外不能入園。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"hours": "06:00–21:00"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed29', '臺中中央公園（水湳）', 'park', 24.17987, 120.65571, '水湳經貿園區內約 67 公頃的帶狀公園，設有適合慢跑的步道，保留部分舊機場跑道，空間大可自由規劃距離。白天遮蔭有限，夏季宜清晨或傍晚跑。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed30', '秋紅谷景觀生態公園', 'park', 24.16854, 120.63949, '七期重劃區的下凹式湖畔公園，可與市政府周邊綠廊串成 3–4 公里環線，夜間燈光好，適合新手夜跑。周邊店家多，路口與行人需留意。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"lap": "串連綠廊約 3–4 公里", "light": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed31', '臺南市立永華田徑場', 'track', 22.9783, 120.20644, '南區體育公園內的市立田徑場，配合全運會翻新後，自 2023 年 11 月起恢復開放民眾健走、慢跑，每月使用人次約上萬。賽事期間會暫停開放。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed32', '臺南都會公園', 'park', 22.93732, 120.22319, '仁德區的大型公園，是台灣國際馬拉松的起終點，園區道路平坦開闊，適合長距離與比賽模擬。夏天日照強，宜清晨跑。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed33', '澄清湖風景區', 'park', 22.66209, 120.34913, '高雄最大湖泊，環湖步道約 7 公里，清晨另有不開放車輛的晨運時段，是南部熱門長距離環湖跑點。週一休園，一般開放時間傍晚就關園。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"lap": "環湖約 7 公里", "hours": "4–9 月 06:00–18:00，10–3 月 06:00–17:30；晨間運動 04:00–06:00（週一休園）", "parking": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed34', '蓮池潭（龍虎塔）', 'park', 22.68051, 120.29238, '左營環潭步道，平坦易跑，西岸已完成步道與自行車道改善。東岸部分路段鋪面老舊、照明不足，夜跑建議留在西岸。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "人行道／自行車道", "light": "部分（東岸照明不足）"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed35', '愛河（真愛碼頭）', 'river', 22.61849, 120.2897, '沿愛河兩岸的步道與自行車道，夜間景觀燈亮、路面平整，是高雄最具代表性的夜跑路線，可往上游延伸到中都濕地。觀光人潮多時注意閃避。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"surface": "河岸步道／自行車道", "light": "有"}', 'approved');
INSERT OR IGNORE INTO spots (id, name, kind, lat, lng, intro, info, status) VALUES ('seed36', '苓雅運動園區（原中正運動場）', 'track', 22.62544, 120.33483, '舊中正運動場改造的運動園區，保留國際級 400 公尺田徑場，另有 600 公尺高架空中步道，晚上有景觀照明，捷運可達。

資料整理自網路公開資訊，開放時間與路況以現場為準。', '{"lap": "400 公尺", "light": "有"}', 'approved');
