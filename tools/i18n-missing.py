#!/usr/bin/env python3
# 列出還沒有英文翻譯的介面字串：掃 public/*.js 的字串與樣板字面值、src/*.js（worker.js、cams.js…，測試用的 *-mock.js 除外）給使用者看的訊息，
# 跟 public/i18n-en.js 的字典比對。新增介面文字後跑一次，把列出來的字串補進字典。
# 用法：python3 tools/i18n-missing.py（-a 連同「句型處理」「不是介面文字」的也列出來，附上分類）
#   句型處理：拆開的片段（「・太早」「個」）出現在 public/i18n.js 的 PATTERNS 裡，或去掉前後標點後就是字典的詞；整句由句型換
#   不是介面文字：SQL、正規表示式、下面 NOT_UI 列的開發與紀錄用字串（新增前先確認真的不會出現在畫面上）
import re,glob,json,sys
def literals(src):
    out=[]; i=0; n=len(src); prev=''
    def code(i, stop_brace=False):
        nonlocal prev
        depth=0
        while i<n:
            c=src[i]
            if c=='/' and src[i+1:i+2]=='/':
                j=src.find('\n',i); i=n if j<0 else j; continue
            if c=='/' and src[i+1:i+2]=='*':
                j=src.find('*/',i+2); i=n if j<0 else j+2; continue
            if c in '\'"':
                j=i+1; buf=''
                while j<n and src[j]!=c:
                    if src[j]=='\\': buf+=src[j:j+2]; j+=2; continue
                    if src[j]=='\n': break
                    buf+=src[j]; j+=1
                out.append(buf); i=j+1; prev='a'; continue
            if c=='`':
                i=template(i+1); prev='a'; continue
            if c=='/' and prev in ('', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '\n', 'return'):
                # regex literal
                j=i+1; cls=False
                while j<n:
                    if src[j]=='\\': j+=2; continue
                    if src[j]=='[': cls=True
                    elif src[j]==']': cls=False
                    elif src[j]=='/' and not cls: break
                    elif src[j]=='\n': break
                    j+=1
                i=j+1; prev='a'; continue
            if stop_brace:
                if c=='{': depth+=1
                elif c=='}':
                    if depth==0: return i+1
                    depth-=1
            if not c.isspace():
                prev=c
                if src[i:i+6]=='return' and not src[i+6:i+7].isalnum(): prev='return'; i+=6; continue
            i+=1
        return i
    def template(i):
        buf=''
        while i<n:
            c=src[i]
            if c=='\\': buf+=src[i:i+2]; i+=2; continue
            if c=='`': out.append(buf); return i+1
            if c=='$' and src[i+1:i+2]=='{':
                out.append(buf); buf='\u0001'; i=code(i+2, True); continue
            buf+=c; i+=1
        out.append(buf); return i
    code(0)
    return out
segs={}
for f in sorted(glob.glob('public/*.js'))+['public/index.html']:
    if any(x in f for x in ['i18n-en','vendor']): continue
    src=open(f).read()
    lits=literals(src) if f.endswith('.js') else [src]
    for L in lits:
        if not re.search(r'[一-鿿]',L): continue
        for v in re.findall(r'(?:placeholder|aria-label|title|alt)="([^"\u0001]*[\u4e00-\u9fff][^"\u0001]*)"',L): segs[v.strip()]=1
        for part in re.split(r'<[^<>]*>|\u0001',L):
            if '>' in part and ('<' not in part or part.index('>') < part.index('<')): part=part[part.index('>')+1:]
            if '<' in part: part=part[:part.index('<')]
            part=part.strip(' \n\t')
            if part and '="' not in part and re.search(r'[\u4e00-\u9fff]',part) and len(part)<=240: segs[part]=1
for f in sorted(glob.glob('src/*.js')):
  if f.endswith('-mock.js'): continue
  for L in literals(open(f).read()):
    if re.search(r'[一-鿿]',L):
          for part in L.split('\u0001'):
              part=part.strip()
              if part and re.search(r'[一-鿿]',part) and len(part)<=240: segs[part]=1
have=json.loads(open('public/i18n-en.js').read().split('export default ',1)[1].split(';\nexport const inner')[0])
missing=[k for k in segs if k not in have and not re.search(r'(?<!:)//|\bif \(|[|]', k)]
# 不是介面文字：使用者看不到，或不經過 i18n.js（例如行事曆訂閱檔給外部 App 讀）
NOT_UI={
  '快取失敗：',                                                # sw.js 安裝時丟的錯誤，只進主控台
  '執行額度超過上限：', 'DB.exec 沒有計入執行額度，請改用 prepare',  # src/budget.js：開發與測試的額度檢查
  '木柵站', '站', '臺',                                         # src/rest.js 等：名稱正規化（台→臺、加油站→站）
  '開國紀念日', '星期六、星期日', '放假之紀念日及節日',              # NTPC_MOCK 的假日假資料（只有本機測試）
  '已報名\\n', '候補中\\n', '還沒報名，點連結報名\\n', 'X-WR-CALNAME:耕跑團',  # 行事曆訂閱 .ics：外部行事曆讀，沒有介面語言
  '層', '成功',                                                 # /api/admin/selftest 的稽核說明：診斷用，沒有畫面
  '格式不對', '沒有這份備份', '段落對不上', '缺 key', '測試：佔用之後失敗', '測試：佔用之前失敗',  # 備份解密與 /api/dev/*（只有 DEV_LOGIN=1 的本機）
}
pat=open('public/i18n.js').read().split('const PATTERNS = [',1)[1].split('\n];',1)[0]
P='\u3000 \t\n・，。：；、（）「」'
def kind(k):
  if k in NOT_UI or re.match(r'(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b', k) or re.search(r'\\\\[sd]|\(\?:|^\[.*\]$|\($|^\)', k): return '不是介面文字'
  c=k.replace('\\n','').strip(P)
  # 句型裡要是獨立的片段（前後不是中文字）：短的詞只出現在較長句型的中間（「週次」在別的句子裡）不算處理過
  if c and (c in have or (len(c) == 1 and c in pat) or re.search(r'(?<![\u3400-\u9fff])' + re.escape(c) + r'(?![\u3400-\u9fff])', pat)): return '句型處理'
  return ''
real=[k for k in missing if not kind(k)]
print(f'介面字串 {len(segs)} 個，沒有英文的 {len(real)} 個（另有句型處理 {sum(kind(k)=="句型處理" for k in missing)} 個、不是介面文字 {sum(kind(k)=="不是介面文字" for k in missing)} 個）')
for k in (missing if '-a' in sys.argv else real): print(json.dumps(k, ensure_ascii=False) + (f'  # {kind(k)}' if kind(k) else ''))
