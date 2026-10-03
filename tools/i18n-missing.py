#!/usr/bin/env python3
# 列出還沒有英文翻譯的介面字串：掃 public/*.js 的字串與樣板字面值、src/*.js（worker.js、cams.js…，測試用的 *-mock.js 除外）給使用者看的訊息，
# 跟 public/i18n-en.js 的字典比對。新增介面文字後跑一次，把列出來的字串補進字典。
# 用法：python3 tools/i18n-missing.py
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
missing=[k for k in segs if k not in have and not re.search(r'//|\bif \(|[|]', k)]
print(f'介面字串 {len(segs)} 個，沒有英文的 {len(missing)} 個')
for k in missing: print(json.dumps(k, ensure_ascii=False))
