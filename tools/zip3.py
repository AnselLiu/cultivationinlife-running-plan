#!/usr/bin/env python3
# 重新產生 public/data/zip3.json（縣市 → [鄉鎮市區, 3 碼郵遞區號]）
#   資料來源：中華郵政 3+3 郵遞區號 Web Service 的 GetCityArea（逐一查 100–983，每次間隔 0.1 秒）
#   不收釣魚臺與南海諸島（沒有住址會用到）。用法：python3 tools/zip3.py
import json, re, time, urllib.request
WS = 'https://33wsp.post.gov.tw/LZWZIP/TZIP33.asmx'
ORDER = ['臺北市', '基隆市', '新北市', '連江縣', '宜蘭縣', '新竹市', '新竹縣', '桃園市', '苗栗縣', '臺中市', '彰化縣', '南投縣',
         '嘉義市', '嘉義縣', '雲林縣', '臺南市', '高雄市', '澎湖縣', '金門縣', '屏東縣', '臺東縣', '花蓮縣']
def city_area(z):
    body = f'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetCityArea xmlns="http://tempuri.org/"><zip3>{z}</zip3></GetCityArea></soap:Body></soap:Envelope>'
    req = urllib.request.Request(WS, body.encode(), {'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"http://tempuri.org/GetCityArea"'})
    m = re.search(r'<GetCityAreaResult>([^<]*)', urllib.request.urlopen(req, timeout=20).read().decode())
    return m.group(1) if m else ''
out = {}
for z in range(100, 984):
    name = city_area(z)
    if name and name[:3] in ORDER and name[3:] != '釣魚臺':
        out.setdefault(name[:3], []).append([name[3:], str(z)])
    time.sleep(0.1)
res = {c: out[c] for c in ORDER if c in out}
json.dump(res, open('public/data/zip3.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(res), '個縣市，', sum(len(v) for v in res.values()), '個鄉鎮市區')
