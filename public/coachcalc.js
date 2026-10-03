// 課表教練的計算（純函式，用到才載入）：年齡分級、心率、補給、比賽日流程、詳細內容、複製文字、行事曆
// 第一步：逐字搬自 public/coach.html（行號見各段註解），只加墊片，不整理程式：
//   L(zh, en) 先只回傳中文（英文已收進 i18n-en.js，由 i18n.js 在執行時翻譯）；S 由 createCoach(ctx) 重建
// 純函式規則：不碰 document、window、localStorage、fetch、navigator（node 測試與 worker 都能 import）
import * as P from './plan.js';
import { addDays, mondayOf, parseISO, dayDiff, kind, fmtP, fmtT, fmtHMS, KIND_LABEL } from './plan.js';

/* ---------- 墊片 ---------- */
const L = (zh) => zh;
const EN = () => false;
const KIND = KIND_LABEL;
const LIST_SEP = () => L('、', ', ');
const trDay = (d) => d;             // 英文介面由 i18n.js 翻譯，這裡保留原文
const trPlan = (t) => t;

/* ---------- 常數（coach.html 1098-1107） ---------- */
const FM = [
 ['S','2:55–3:00',175,180],['A','3:05–3:10',185,190],['B','3:15–3:20',195,200],['C','3:25–3:30',205,210],
 ['D','3:35–3:40',215,220],['E','3:45–3:50',225,230],['F','3:55–4:00',235,240],['G','4:10–4:15',250,255],
 ['H','4:20–4:30',260,270],['I','4:40–4:45',280,285]];
const HM = [['A','1:30',85,90],['B','1:40',95,100],['C','1:50',105,110],['D','2:00',115,120],['E','2:10',125,130]];
export const VOL = [['lt30',['30K 以下','Under 30K'],0],['30',['30–50K','30–50K'],30],['50',['50–70K','50–70K'],50],['70',['70K 以上','70K+'],70]];
const WD = ['日','一','二','三','四','五','六'];
const md=d=>(d.getMonth()+1)+'/'+d.getDate();
const mdw=d=>md(d)+'（'+WD[d.getDay()]+'）';
const phaseName=p=>p;
function weekLabel(w){ return w.n===21?L('賽後恢復週','Post-race recovery'):phaseName(w.phase)+(w.recovery?L('・恢復週',' · recovery week'):''); }
const wkName=n=>n===21?'R':'W'+n;

/* ---------- 課表備註（1224-1227）；週四團練地點由協會設定 ---------- */
export const NOTE_TXT={club:['週四團練','Thursday club session'],
  self:['自己練時，團體動態熱身可改成 10 分鐘自主熱身','Training alone: swap the group warm-up for a 10-min self warm-up'],
  opt:['每週天數不夠時優先省略；時間允許就照跑','Dropped first when you have fewer days; run it if you have time'],
  rd:['當天流程、配速分段、補給時間表見「比賽日建議」','Timeline, splits and gel schedule: see the race-day plan']};
export const noteText=(k,venue='')=>k==='club'?`週四團練${venue?'・'+venue:''}`:L(...NOTE_TXT[k]);

/* ---------- 成績推算（1277-1282） ---------- */
export function parseTime(s){
  const p=String(s||'').trim().split(/[:：]/);
  if(!p.length||p.some(x=>x===''||isNaN(+x))) return null;
  let sec=0;for(const x of p)sec=sec*60+(+x);
  return sec>0?sec/60:null;
}
// 賽事目標「h:mm」或「h:mm:ss」→ 分鐘；看不懂回傳 null
export function parseGoal(str){
  const m=/^\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?\s*$/.exec(String(str||''));
  if(!m||+m[2]>59||(m[3]&&+m[3]>59)) return null;
  const min=+m[1]*60+ +m[2]+(m[3]?+m[3]/60:0);
  return min>0?min:null;
}

/* ---------- 年齡分級、心率（1478-1490、1516-1520） ---------- */
export const AG90={M:{30:133.983,40:136.95,50:149.483,60:164.533,70:182.967},F:{30:144.617,40:149.15,50:160.45,60:181.25,70:210.483}};
export function std100(age,sex){
  const t=AG90[sex], ks=[30,40,50,60,70], a=Math.min(70,Math.max(30,age));
  for(let i=0;i<4;i++){const lo=ks[i],hi=ks[i+1];if(a<=hi)return (t[lo]+(t[hi]-t[lo])*(a-lo)/(hi-lo))*0.9;}
}
export const ageGrade=(age,sex,min)=>std100(age,sex)/min*100;
export const lvl=p=>p>=90?L('世界級','World class'):p>=80?L('國家級','National class'):p>=70?L('區域級','Regional class'):p>=60?L('地方級','Local class'):L('休閒','Recreational');
export function verdict(gap){
  if(gap<=0) return ['ok',L('目標比你現在推算的能力還保守，可以考慮往上一組。','Your goal is more conservative than your predicted fitness — consider moving up a group.')];
  if(gap<=3) return ['ok',L('目標和現在的能力相近，照課表完整練一季，有機會達成。','Goal and current fitness are close — complete the full cycle and it’s within reach.')];
  if(gap<=6) return ['mid',L('有挑戰性，需要完整練完一季，而且長跑和週四團練都不能少。','Challenging — you’ll need the whole cycle, without missing long runs or Thursday sessions.')];
  return ['hi',L('差距偏大，建議先選慢一組，練 4–6 週後再用新成績評估。','Big gap — start one group slower and reassess with a new result after 4–6 weeks.')];
}
export function hrCalc(age,rest){
  const tan=208-0.7*age, fox=220-age, r=rest||null;
  const zones=[['Z1',.5,.6],['Z2',.6,.7],['Z3',.7,.8],['Z4',.8,.9],['Z5',.9,1]].map(([n,lo,hi])=>[n,Math.round(r?r+(tan-r)*lo:tan*lo),Math.round(r?r+(tan-r)*hi:tan*hi),lo,hi]);
  return {tan,fox,zones,p130:r?(130-r)/(tan-r)*100:130/tan*100,karvonen:!!r};
}

/* ---------- 比賽補給試算（1532-1537）；汗量 低／中／高 是內部代號，畫面顯示 少／一般／多 ---------- */
export function fuelCalc(kg,min,dist,sweat){
  const h=min/60, hi=h>2.5?90:h>1.25?60:30, lo=h>2.5?60:30;
  const ml={'低':[400,500],'中':[500,650],'高':[650,800]}[sweat], na={'低':300,'中':450,'高':600}[sweat];
  return {h,lo,hi,totLo:lo*h,totHi:hi*h,gLo:Math.round(lo*h/25),gHi:Math.round(hi*h/25),
    gap:Math.max(15,Math.round(60/(hi/25)/5)*5),ml,na,load:dist==='fm'?[10*kg,12*kg]:[7*kg,10*kg]};
}
export function clockAdd(hhmm,min){const m=/^(\d{1,2}):(\d{2})$/.exec(hhmm||'');if(!m)return null;let t=((+m[1]*60+ +m[2]+min)%1440+1440)%1440;return String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');}

/* ---------- 詳細內容用到的說明（1586-1589） ---------- */
export function fmtRest(m,s){m=+m||0;s=+s||0;return EN()?[m?m+' min':'',s?s+' s':''].filter(Boolean).join(' '):[m?m+' 分鐘':'',s?s+' 秒':''].filter(Boolean).join(' ');}
export const KIND_PURPOSE={easy:['幫助恢復、累積有氧基礎','Recovery and aerobic base'],quality:['提升速度、配速感或乳酸閾值','Builds speed, pace feel or threshold'],
  long:['建立耐力，順便練習補給與配速','Builds endurance; practise fueling and pacing'],strength:['預防受傷、穩定跑姿','Injury prevention and stable form'],
  rest:['讓身體吸收前面的訓練','Lets your body absorb the training'],race:['比賽','Race']};

/* ---------- 課表用語（1695-1721） ---------- */
export const GL={
  easy:{name:'E／easyjog',zh:'輕鬆跑，能邊跑邊聊天，約 zone 2',en:'Easy run — conversational, about zone 2',re:/(?<![A-Za-z])[EＥ](?![A-Za-z])|easy\s?jog/gi},
  freejog:{name:'freejog',zh:'自由跑，不看配速，憑感覺跑',en:'Free run — ignore pace, run by feel',re:/free\s?jog|Free Run/gi},
  lr:{name:'LR／LSD',zh:'長距離慢跑',en:'Long slow distance',re:/(?<![A-Za-z])(?:LR|LSD)(?![A-Za-z])/g},
  hlsd:{name:'HLSD',zh:'高品質長距離，比一般長跑快；課表寫「LR or HLSD」時二選一',en:'High-quality long run, faster than a regular long run; “LR or HLSD” means pick one',re:/HLSD/g},
  mp:{name:'MP／HMP',zh:"全馬／半馬目標配速；MP+20'' 表示每公里慢 20 秒",en:"Marathon / half goal pace; MP+20'' means 20 s/km slower",re:/H?MP(?:\s*[+-]\s*\d+(?:'\d+)?(?:''|"|')?(?:\s*~\s*[+-]?\s*\d+(?:'\d+)?(?:''|"|')?)?)?/g},
  lt:{name:'LT／Tempo',zh:'乳酸閾值跑、節奏跑，「舒適但吃力」',en:'Lactate-threshold / tempo run — “comfortably hard”',re:/(?<![A-Za-z])LT(?![A-Za-z])|[Tt]empo/g},
  st:{name:'ST',zh:'加速跑，20 秒或 100m 左右，逐漸加速到約九成速度',en:'Strides — about 20 s or 100 m, building to ~90% speed',re:/ST(?=\s*[xX])/g},
  r:{name:'R:／r:',zh:'每趟之間的休息時間',en:'Recovery between reps',re:/[rR]\s*:\s*\d+(?:'\d+(?:''|")?|''|"|')?(?:\s*\/\s*\d+(?:'\d+(?:''|")?|''|"|')?)?/g},
  p12:{name:'A+B @p1/p2',zh:'前段用 p1 配速、後段用 p2 配速',en:'First part at pace p1, second part at pace p2',re:/@\s*\d{1,2}:\d{2}(?:\s*[~-]\s*\d{1,2}:\d{2})?\s*\/\s*\d{1,2}:\d{2}(?:\s*[~-]\s*\d{1,2}:\d{2})?/g},
  rpe:{name:'rpe',zh:'自覺強度（1–10 分）',en:'Perceived effort (1–10)',re:/[Rr]pe\s*\d+(?:\s*~\s*\d+)?/g},
  zone:{name:'zone／low HR',zh:'心率區間',en:'Heart-rate zones',re:/zone\s*\d(?:\s*~\s*\d)?|low HR|HR\s?\d{3}(?:\s*~\s*\d{3})?/gi}
};
export const GL_ORDER=['easy','freejog','lr','hlsd','mp','lt','st','r','p12','rpe','zone'];
export function termSpans(text){
  const hits=[];
  for(const k of GL_ORDER){const re=new RegExp(GL[k].re.source,GL[k].re.flags);let m;while((m=re.exec(text))){if(!m[0])break;hits.push([m.index,m.index+m[0].length,k]);}}
  hits.sort((a,b)=>a[0]-b[0]||(b[1]-b[0])-(a[1]-a[0]));
  const keep=[];let end=-1;for(const h of hits){if(h[0]>=end){keep.push(h);end=h[1];}}
  return keep;
}
export function termsIn(t){return [...new Set(termSpans(t).map(h=>h[2]))];}

/* ---------- 課表每一列的「詳細內容」（課表頁 details.xd 用；純函式） ---------- */
// 個人心率是一般公式算的：有 bpm 的地方一律標「估算」，並附上這句說明
export const EST_LINE='估算：一般公式（Tanaka／Karvonen），個人誤差約 ±10 bpm；不是教練規定，課表上的 zone、HR130、RPE 以教練說明為準。';
// coach.explain(row) → [{ label, value, est, zone }]；est＝含個人心率（bpm），zone＝心率這一列只有 zone 名稱（還沒填年齡）
export function xdRows(coach,row){
  const x={d:row.d,t:row.t,k:row.k??row.kind,race:row.race};
  return coach.explain(x).map(([label,value])=>{
    const hr=label==='心率', est=hr&&/（你約 \d+–\d+ 下）/.test(value);
    return {label,value:String(value),est,zone:hr&&!est&&/^zone /.test(value)};
  });
}

/* ---------- 行事曆（2412-2424） ---------- */
const WD_IDX={'一':0,'二':1,'三':2,'四':3,'五':4,'六':5,'日':6,'末':6};
export const icsDate=d=>`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
export const icsEsc=s=>String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
export function icsFold(line){                                  // 每行最多 75 bytes（UTF-8）
  const enc=new TextEncoder();if(enc.encode(line).length<=75)return line;
  const out=[];let cur='',n=0;
  for(const ch of line){const b=enc.encode(ch).length;if(n+b>(out.length?74:75)){out.push(cur);cur='';n=0;}cur+=ch;n+=b;}
  out.push(cur);return out.join('\r\n ');
}
// 英文介面：.ics 給人看的欄位（標題、說明、分類、行事曆名稱）逐行翻譯後重新跳脫、折行；tr 由呼叫端傳入（i18n.js 的 t）
export function icsTranslate(text,tr){
  const un=s=>s.replace(/\\([\\n,;])/g,(_,c)=>c==='n'?'\n':c);
  return text.replace(/\r\n /g,'').split('\r\n').map(l=>{
    const m=/^(SUMMARY|DESCRIPTION|CATEGORIES|X-WR-CALNAME):(.*)$/.exec(l);
    return m?icsFold(`${m[1]}:${icsEsc(un(m[2]).split('\n').map(x=>tr(x)).join('\n'))}`):l;
  }).join('\r\n');
}

/* ---------- 個人化的計算：照課表教練的 S 重建 ---------- */
// ctx：{ dist, grp, nickname, venue, prefs:{days,club,vol}, pb:{dist,time}, body:{age,sex,kg,rest,sweat},
//        start:'06:30'|null, goalMin:number|null, weeks, now:()=>Date, cycle:{kind,anchor,name}, zoneBpm? }
// 週期預設是協會賽季（2026-12-20 臺北馬拉松）；個人週期時 raceDate＝那場比賽的日期
export function createCoach(ctx = {}) {
  const prefs = ctx.prefs || {}, pb = ctx.pb || {}, body = ctx.body || {}, cyc = ctx.cycle || P.CLUB;
  const S = { dist: ctx.dist === 'hm' ? 'hm' : 'fm', grp: ctx.grp || (ctx.dist === 'hm' ? 'C' : 'D'),
    days: Number(prefs.days) || 6, club: prefs.club !== false, vol: prefs.vol ?? null,
    age: body.age ?? null, sex: body.sex ?? null, kg: body.kg ?? null, rest: body.rest ?? null, sweat: body.sweat ?? null,
    pbDist: pb.dist ?? '10', pbTime: pb.time ?? '', start: ctx.start || '', name: ctx.nickname || '',
    race: cyc.name || '', raceDate: cyc.anchor || P.RACE_ISO, week: null, view: 'week' };
  const DEFAULTS = { raceDate: P.RACE_ISO };
  const WEEKS = ctx.weeks || [];
  const now = ctx.now || (() => new Date());
  const zoneBpm = ctx.zoneBpm ?? (S.age != null);
  const venue = ctx.venue || '';
  function today0(){const t=new Date(now());t.setHours(0,0,0,0);return t;}
  const noteText_=k=>noteText(k,venue);

  /* 週次（1152-1172） */
  const raceDay=()=>parseISO(S.raceDate)||parseISO(DEFAULTS.raceDate);
  const raceName=()=>String(S.race||'').trim()||L('目標賽事','Target Race');
  const runnerName=()=>String(S.name||'').trim()||L('跑者','Runner');
  const planTitle=()=>L(`${runnerName()}@${raceName()}課表`,`${runnerName()}@${raceName()} Plan`);
  const w1Monday=()=>addDays(mondayOf(raceDay()),-19*7);
  const weekStart=n=>addDays(w1Monday(),(n-1)*7);
  function weekIndex(){return Math.floor(dayDiff(today0(),w1Monday())/7)+1;}
  function currentWeek(){return Math.min(21,Math.max(1,weekIndex()));}
  const distName=()=>S.dist==='fm'?L('全馬','Marathon'):L('半馬','Half');
  const grpName=g=>L(`${distName()} ${g} 組`,`${distName()} Group ${g}`);
  const groups=()=>S.dist==='fm'?FM:HM;
  const grpInfo=()=>groups().find(g=>g[0]===S.grp)||groups()[0];
  const raceKm=()=>S.dist==='fm'?42.195:21.0975;
  const targetMin=()=>{if(ctx.goalMin!=null)return ctx.goalMin;const g=grpInfo();return (g[2]+g[3])/2;};
  const goalPace=()=>targetMin()*60/raceKm();

  /* 配速換算（1206-1218） */
  function paceNotes(t){
    const mp=goalPace(), out=[];
    for(const x of P.mpMatches(t)){
      if(x.base==='HMP'&&S.dist==='fm') continue;
      const p=[mp+x.a]; if(x.b!=null) p.push(mp+x.b); p.sort((a,b)=>b-a);
      out.push([...new Set(p.map(fmtP))].join('–'));
    }
    if(!out.length){
      const plain=/(H?MP)(?!\s*[+-]\s*\d)/.exec(t);
      if(plain && !(plain[1]==='HMP'&&S.dist==='fm')) out.push(fmtP(mp));
    }
    return [...new Set(out)];
  }
  // 比賽那一列：planDays 依週次標好 race（W20 週末的「臺北馬拉松」也算）；其他照原本的「比賽日」
  const isRaceDay=x=>x.race??(x.k==='race'&&x.t==='比賽日');
  const dispText=x=>isRaceDay(x)?L(`比賽日：${raceName()}`,`Race day: ${raceName()}`):trPlan(x.t);
  const dispDay=x=>trDay(x.d);
  const kindLabel=x=>x.opt?L('可省略','Optional'):KIND[x.k];

  /* 某人某週的課表（1231-1252）：可省略的課用 plan.js 的同一套規則 */
  function daysFor(w){
    if(!w.plan) return null;
    if(w.plan.fmAll) return S.dist==='fm'?w.plan.fmAll:w.plan.hmAll;
    return (w.plan[S.dist]||{})[S.grp]||null;
  }
  function planDays(w){
    const raw=daysFor(w); if(!raw) return null;
    const list=P.markOptional(raw.map(([d,t])=>({d,t,k:kind(d,t)})),{days:S.days,club:S.club},w.n);
    for(const x of list){x.race=P.isRaceDay(x,w.n);x.notes=x.noteKeys.map(noteText_);}
    return list;
  }
  // 複製文字與 PDF 用：跟 App 一樣，W20 比賽當天與之後的課不列（P.dayDates 同一套規則）；
  //   「週五或週六」遇到週六比賽只留週五，「週末」遇到週日比賽只留週六
  const WD_CH=['一','二','三','四','五','六','日'];
  function exportDays(w){
    const list=planDays(w); if(!list||w.n!==20) return list;
    const ws=weekStart(20), rd=raceDay();
    return list.flatMap(x=>{
      if(isRaceDay(x)){const wd=(rd.getDay()+6)%7; return [wd===6?x:{...x,d:`週${WD_CH[wd]}`}];}   // 比賽列寫比賽那天（週日比賽照原本的「週末」）
      const idx=[...String(x.d).matchAll(/[週周]([一二三四五六日末])/g)].flatMap(m=>P.WD_IDX[m[1]]);
      const all=idx.length?idx:[0], keep=all.filter(i=>dayDiff(addDays(ws,i),rd)<0);
      if(!keep.length) return [];
      return keep.length<all.length?[{...x,d:keep.map(i=>`週${WD_CH[i]}`).join('或')}]:[x];
    });
  }

  /* 成績推算、提醒（1283-1284、1296-1308） */
  function predictedMin(){const t=parseTime(S.pbTime),d=+S.pbDist;if(!t||!d)return null;return t*Math.pow(raceKm()/d,1.06);}
  function suggestGroup(pred){const gs=groups();return gs.find(x=>x[3]>=pred)||gs[gs.length-1];}
  function volTier(g){return S.dist==='fm'?('SAB'.includes(g)?60:'CDE'.includes(g)?45:30):('AB'.includes(g)?40:25);}
  function warnings(){
    const g=grpInfo()[0], warn=[], tier=volTier(g), volMin=(VOL.find(v=>v[0]===S.vol)||VOL[1])[2], wi=weekIndex();
    if(wi>1&&wi<=20) warn.push({key:'mid',text:L(`離比賽只剩 ${21-wi} 週左右，課表從 W${wi} 接著跑；前面的週次可以參考，不用回頭補。`,
      `About ${21-wi} weeks to go — pick up the plan at W${wi}. Earlier weeks are for reference; don’t try to make them up.`)});
    if(tier-volMin>=10 || (S.vol==='lt30'&&tier>=30)) warn.push({key:'vol',text:L(`目前每週跑量偏低，${g} 組的課表大約需要每週 ${tier}K 以上的基礎。可以考慮先選慢一組，練幾週再調整。`,
      `Your weekly mileage is on the low side — Group ${g} assumes a base of about ${tier}K/week. Consider starting one group slower and moving up after a few weeks.`)});
    if(S.days===3) warn.push({key:'days3',text:L('只保留週二、週四和週末三堂重點課。長跑前後請確實休息，不要把省略的課擠到同一天補。',
      'Only the three key sessions stay: Tuesday, Thursday and the weekend. Rest properly around the long run and don’t cram skipped runs into one day.')});
    if(S.dist==='fm'&&'SAB'.includes(g)&&S.days<=4) warn.push({key:'days4',text:L(`${g} 組的跑量較大，每週 4 天以下比較難完成，建議至少 5 天。`,
      `Group ${g} carries high volume — 4 days or fewer a week makes it hard to complete. At least 5 days is recommended.`)});
    return warn;
  }

  /* 複製成文字（1414-1442） */
  function headerText(){
    const g=grpInfo();
    return [`【${planTitle()}】`,
      L(`比賽日 ${mdw(raceDay())}${S.start?' '+S.start+' 起跑':''}｜耕跑團 20 週週期`,`Race day ${mdw(raceDay())}${S.start?' · start '+S.start:''} | cultivationinlife.run 20-week cycle`),
      L(`${grpName(g[0])}（SUB ${g[1]}）｜${S.dist==='fm'?'MP':'HMP'} ${fmtP(goalPace())}/km｜每週 ${S.days} 天｜${S.club?'參加週四團練':'週四自己練'}`,
        `${grpName(g[0])} (SUB ${g[1]}) | ${S.dist==='fm'?'MP':'HMP'} ${fmtP(goalPace())}/km | ${S.days} days/week | ${S.club?'Thursday club run':'Thursday solo'}`)];
  }
  function weekText(w){
    const st=weekStart(w.n), list=exportDays(w);
    const lines=[`■ ${wkName(w.n)} ${weekLabel(w)}${L('（',' (')}${mdw(st)}–${mdw(addDays(st,6))}${L('）',')')}`];
    if(!list){lines.push(L('（沒有課表資料）','(no sessions)'));return lines;}
    for(const x of list){
      const p=paceNotes(x.t);
      const sp=L('｜',' | ');
      let s=`${dispDay(x)}${sp}${kindLabel(x)}${sp}${dispText(x)}${p.length?L(`（≈ ${p.join('、')}/km）`,` (≈ ${p.join(', ')}/km)`):''}`;
      const extra=x.noteKeys.filter(k=>k!=='opt').map(noteText_); if(extra.length) s+=L(`〔${extra.join('；')}〕`,` [${extra.join('; ')}]`);
      lines.push(s);
    }
    return lines;
  }
  function copyPayload(mode,week){
    if(week) S.week=week; else if(S.week==null) S.week=currentWeek();
    mode=mode||(S.view==='all'?'all':'week');
    const lines=headerText();
    if(mode==='all'){lines.push('');WEEKS.forEach(w=>{lines.push(...weekText(w),'');});}
    else {lines.push('',...weekText(WEEKS[S.week-1]));}
    lines.push('',L('※ 課表模型整理自耕跑團教練課表，實際以教練每週發布為準；「可省略」是每週天數不夠時優先省略的輕鬆跑。',
      '※ Based on cultivationinlife.run coaches’ periodized plans — the coach’s weekly post always takes priority. “Optional” marks easy runs dropped first when you have fewer days.'));
    return lines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  }

  /* 你的配速（1467-1472） */
  function paceRows(){
    const mp=goalPace();
    return S.dist==='fm'?[
      ['MP',L('全馬目標配速','Marathon goal pace'),mp],['MP+20"',L('週二中長距離的下限','Tuesday medium-long, slow end'),mp+20],['MP−10"',L('賽前短間歇','Pre-race short reps'),mp-10],['MP−30"',L('600m 短間歇','600m reps'),mp-30],[L('輕鬆跑參考約 MP+75"','Easy ≈ MP+75"'),L('約 MP+60~90"，以心率為準','≈ MP+60–90"; go by heart rate'),mp+75]]
     :[['HMP',L('半馬目標配速','Half goal pace'),mp],['HMP+20"',L('週末長跑','Weekend long run'),mp+20],['HMP−12.5"',L('1.6K 間歇，約 HMP−10~15"','1.6K reps, ≈ HMP−10–15"'),mp-12.5],['HMP−20"',L('800m 間歇','800m reps'),mp-20],[L('輕鬆跑參考約 HMP+90"','Easy ≈ HMP+90"'),L('以心率為準','Go by heart rate'),mp+90]];
  }

  /* 比賽早餐時間（1538-1541） */
  function breakfastAt(){
    const m=/^(\d{1,2}):(\d{2})$/.exec(S.start||''); if(!m) return '';
    let t=(+m[1]*60+ +m[2]-180+1440)%1440; return String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');
  }

  /* 課表詳細內容（1590-1644）；個人心率（bpm）只在填了年齡時才顯示 */
  function explain(x){
    const t=x.t, P=[], add=(zh,en,val)=>P.push([L(zh,en),val]);
    add('類型','Type',`${KIND[x.k]} — ${L(...KIND_PURPOSE[x.k])}`);
    if(isRaceDay(x)){add('流程','Plan',L('照「比賽日建議」的時間表、配速分段與補給執行','Follow the timeline, splits and fueling in the race-day plan'));return P;}
    if(x.k==='strength'){add('內容','What',L('任選：核心訓練、肌力訓練、活動度（伸展、滾筒）或交叉訓練（騎車、游泳）','Pick one: core, strength, mobility (stretching, foam roller) or cross-training (bike, swim)'));return P;}
    if(x.k==='rest'){add('內容','What',L('完全休息，或散步、伸展等很輕的活動','Full rest, or very light activity such as walking and stretching'));return P;}
    let m;
    if((m=/(\d+)H(\d+)M/.exec(t))) add('時間','Duration',L(`${m[1]} 小時 ${m[2]} 分鐘`,`${m[1]} h ${m[2]} min`));
    else if((m=/(\d+)\s*mins/.exec(t))) add('暖身跑','Easy start',L(`先輕鬆跑 ${m[1]} 分鐘`,`${m[1]} min easy first`));
    else if((m=/^\s*(\d+)'(?:\s*~\s*(\d+)')?(?!')/.exec(t))&&!/warm up/i.test(t)) add('時間','Duration',L(`${m[1]}${m[2]?'–'+m[2]:''} 分鐘`,`${m[1]}${m[2]?'–'+m[2]:''} min`));
    if(/warm up/i.test(t)){
      const w=/(\d+(?:\.\d+)?(?:~\d+(?:\.\d+)?)?)\s*(K|')\s*warm up/i.exec(t);
      const q=w?w[1].replace('~','–'):'';const amt=w?(w[2]==='K'?L(`${q} 公里`,`${q} km`):L(`${q} 分鐘`,`${q} min`)):'';
      const extra=/團體/.test(t)?L('＋團體動態熱身',' + group dynamic warm-up'):/熱身/.test(t)?L('＋動態熱身',' + dynamic warm-up'):'';
      add('熱身','Warm-up',L(`慢跑 ${amt}${extra}`.trim(),`${amt} easy jog${extra}`.trim()));
    }
    const noST=t.replace(/\d+(?:\.\d+)?(?:~\d+)?\s*(?:M|m|''|")?\s*ST\s*[xX]\s*\d+(?:~\d+)?/g,'');
    const main=/warm up/i.test(noST)?noST.replace(/^.*?warm up[^/]*\//i,''):noST;
    const reps=[...main.matchAll(/(\d+(?:\.\d+)?K|\d{3,4}M?)\s*[xX*]\s*(\d+(?:\s*[~-]\s*\d+)?)/g)];
    const tr=/\(\s*(\d+)'(?:(\d+)'')?\s*H?MP[^)]*\)\s*[xX]\s*(\d+(?:~\d+)?)/.exec(main);
    if(tr){add('主課','Main set',L(`${tr[1]} 分${tr[2]?' '+tr[2]+' 秒':'鐘'} × ${tr[3].replace('~','–')} 趟（目標配速）`,`${tr[3].replace('~','–')} × ${tr[1]} min${tr[2]?' '+tr[2]+' s':''} at goal pace`));
      const jg=/\)\s*[xX]\s*[\d~]+\s*@\s*(\d+)'(?:(\d+)'')?/.exec(t);if(jg) add('每趟休息','Rest',L(`慢跑 ${fmtRest(jg[1],jg[2])}`,`jog ${fmtRest(jg[1],jg[2])}`));}
    else if(reps.length) add('主課','Main set',(reps.map(r=>{const d=/K$/.test(r[1])?r[1].replace('K',' km'):r[1].replace(/M$/,'')+' m';const n=r[2].replace(/\s/g,'');return L(`${d} × ${n} 趟`,`${n} × ${d}`);})).join(L('，再 ',', then ')));
    else{
      const stg=/\(([\d.]+(?:\/[\d.]+)+)K\s*(?:漸進)?\)/.exec(main);
      if(stg){add('距離','Distance',L(`${(/(\d+(?:\.\d+)?)K/.exec(main)||[,'?'])[1]} 公里`,`${(/(\d+(?:\.\d+)?)K/.exec(main)||[,'?'])[1]} km`));add('分段','Stages',L(`${stg[1].split('/').join(' ＋ ')} 公里，每段換下一個配速`,`${stg[1].split('/').join(' + ')} km, next pace for each stage`));}
      else{
      const ds=[...main.matchAll(/(?:^|[\s/+(])(\d+(?:\.\d+)?)\s*K?(?:\s*~\s*(\d+(?:\.\d+)?))?\s*K(?![a-z])/gi)].filter(d=>!/^[^@]{0,3}[xX*]/.test(main.slice(d.index+d[0].length))).map(d=>d[1]+(d[2]?'–'+d[2]:''));
      if(ds.length>1) add('分段','Segments',L(`${ds.join(' 公里 ＋ ')} 公里`,`${ds.join(' km + ')} km`));
      else if(ds.length) add('距離','Distance',L(`${ds[0]} 公里`,`${ds[0]} km`));
      }
    }
    if((m=/\)\s*[xX]\s*(\d+)\s*$/.exec(main))) add('組數','Sets',L(`整組重複 ${m[1]} 次`,`Repeat the whole set ${m[1]} times`));
    if((m=/(\d+(?:~\d+)?)\s*(M|''|")\s*ST\s*[xX]\s*(\d+(?:~\d+)?)/.exec(t))) add('加速跑','Strides',L(`${m[3]} 趟，每趟 ${m[1]}${m[2]==='M'?' 公尺':' 秒'}，逐漸加速到約九成速度`,`${m[3]} × ${m[1]}${m[2]==='M'?' m':' s'}, building to ~90% speed`));
    const pm=[...t.matchAll(/@\s*(\d{1,2}:\d{2})(?:\s*[~-]\s*(\d{1,2}:\d{2}))?(?:\s*[~-]\s*(\d{1,2}:\d{2}))?(?:\s*\/\s*(\d{1,2}:\d{2})(?:\s*[~-]\s*(\d{1,2}:\d{2}))?)?/g)];
    const pv=pm.map(p=>{const a=[p[1],p[2],p[3]].filter(Boolean).map(s=>s.replace(/^0/,'')), b=[p[4],p[5]].filter(Boolean).map(s=>s.replace(/^0/,''));
      if(b.length) return L(`前段 ${a.join('–')}，後段 ${b.join('–')}（每公里）`,`${a.join('–')}, then ${b.join('–')} per km`);
      if(a.length===3) return L(`由慢到快 ${a.join(' → ')}（每公里）`,`Progressive ${a.join(' → ')} per km`);
      return L(`每公里 ${a.join('–')}`,`${a.join('–')} per km`);});
    if(pv.length) add('配速','Pace',pv.join(L('；','; ')));
    const pn=paceNotes(t); if(pn.length) add('你的配速','Your pace',`≈ ${pn.join(LIST_SEP())}/km`);
    if((m=/[rR]\s*:\s*(?:(\d+)(?:''|")|(\d+)'(?:(\d+)(?:''|"))?)(?:\s*\/\s*(\d+)'(?:(\d+)(?:''|"))?)?/.exec(t))){
      let s=m[1]?fmtRest(0,m[1]):fmtRest(m[2],m[3]); if(m[4]) s+=L(`（後段 ${fmtRest(m[4],m[5])}）`,` (second part ${fmtRest(m[4],m[5])})`);
      const j=/\/\s*(\d+)m\s*jog/.exec(t); add('每趟休息','Rest',`${s}${j?L(`，慢跑 ${j[1]} 公尺`,`, jog ${j[1]} m`):''}`);
    }
    if((m=/rpe\s*(\d+)(?:\s*~\s*(\d+))?/i.exec(t))) add('強度','Effort',L(`自覺強度 ${m[1]}${m[2]?'–'+m[2]:''}/10（${+m[1]<=3?'很輕鬆，可以聊天':+m[1]<=5?'輕鬆到中等':'中等偏難'}）`,`${m[1]}${m[2]?'–'+m[2]:''}/10 (${+m[1]<=3?'very easy, conversational':+m[1]<=5?'easy to moderate':'moderately hard'})`));
    if((m=/zone\s*(\d)(?:\s*~\s*(\d))?/i.exec(t))) add('心率','Heart rate',`zone ${m[1]}${m[2]?'–'+m[2]:''}`+(zoneBpm&&S.age?hrZoneText(+m[1],m[2]?+m[2]:+m[1]):''));
    else if((m=/HR\s?(\d{3})(?:\s*~\s*(\d{3}))?/.exec(t))) add('心率','Heart rate',L(`${m[1]}${m[2]?'–'+m[2]:''} 下以內`,`up to ${m[2]||m[1]} bpm`));
    else if(/low HR/i.test(t)) add('心率','Heart rate',L('刻意壓低心率，慢一點沒關係','Keep HR low — slow is fine'));
    if(/漸進|progress/i.test(t)&&!pv.some(v=>/→/.test(v))) add('跑法','How',L('由慢到快，分段逐步加速','Start easy and speed up in stages'));
    if(/\bor\b/.test(t)&&/HLSD/.test(t)) add('選擇','Option',L('一般長跑；狀況好時可改成高品質長距離（HLSD）','Regular long run, or a high-quality long run (HLSD) if you feel good'));
    if(/or 賽事/.test(t)) add('選擇','Option',L('這週有比賽的話，用比賽取代長跑','If you race this week, the race replaces the long run'));
    return P;
  }
  function hrZoneText(z1,z2){const x=hrCalc(S.age,S.rest),a=x.zones[z1-1],b=x.zones[z2-1];return a&&b?L(`（你約 ${a[1]}–${b[2]} 下）`,` (≈ ${a[1]}–${b[2]} bpm for you)`):'';}

  /* 比賽日建議（1652-1680）；沒有起跑時間時 offsets 給「起跑前幾分鐘」 */
  function raceDayPlan(){
    const fm=S.dist==='fm', kg=S.kg, st=S.start||'', m=targetMin(), pace=goalPace(), R=Math.round, g=grpInfo()[0];
    const f=kg?fuelCalc(kg,m,S.dist,S.sweat||'中'):fuelCalc(60,m,S.dist,S.sweat||'中');
    const fast=fm?'SABC'.includes(g):'AB'.includes(g);
    const at=(off,alt)=>st?clockAdd(st,off):alt;
    const timeline=[
      [at(-240,L('起跑前 4 小時','Start −4 h')),L('起床','Wake up'),L('喝一杯水，上廁所，確認天氣與交通','Drink a glass of water, use the toilet, check weather and transport')],
      [at(-180,L('起跑前 3 小時','Start −3 h')),L('比賽早餐','Breakfast'),kg?L(`碳水 ${R(2*kg)}–${R(3*kg)} g、水 ${R(5*kg)}–${R(7*kg)} ml；選熟悉、低纖低脂的食物`,`Carbs ${R(2*kg)}–${R(3*kg)} g, water ${R(5*kg)}–${R(7*kg)} ml; familiar, low-fibre, low-fat foods`):L('碳水 2–3 g/kg、水 5–7 ml/kg；選熟悉的食物','Carbs 2–3 g/kg, water 5–7 ml/kg; familiar foods')],
      [at(-90,L('起跑前 90 分','Start −90 min')),L('咖啡因（選用）','Caffeine (optional)'),kg?L(`${R(3*kg)}–${R(6*kg)} mg，起跑前 30–90 分鐘；練習時試過才用`,`${R(3*kg)}–${R(6*kg)} mg, 30–90 min before; only if tried in training`):L('3–6 mg/kg，練習時試過才用','3–6 mg/kg; only if tried in training')],
      [at(-60,L('起跑前 60 分','Start −60 min')),L('抵達會場','Arrive'),L('寄物、上廁所、別號碼布與晶片；小口喝水 150–250 ml','Bag drop, toilets, pin bib and chip; sip 150–250 ml of water')],
      [at(-25,L('起跑前 25 分','Start −25 min')),L('熱身',"Warm-up"),fast?L('慢跑 10 分鐘＋動態伸展＋3–4 趟加速跑','10-min easy jog + dynamic drills + 3–4 strides'):L('快走或慢跑 5–10 分鐘＋動態伸展，保留體力','5–10 min brisk walk or easy jog + dynamic drills; save energy')],
      [at(-15,L('起跑前 15 分','Start −15 min')),L('進起跑區','Enter your corral'),L('按目標成績站位；可含一小口能量膠或運動飲料','Line up by target time; a small sip of sports drink or a bit of gel is fine')],
      [st||L('起跑','Start'),L('起跑','Start'),L(`前 5K 比目標配速慢 5–10 秒/km，之後穩定在 ${fmtP(pace)}/km`,`Run the first 5K 5–10 s/km slower than goal, then settle at ${fmtP(pace)}/km`)]
    ];
    const pts=fm?[5,10,15,21.0975,25,30,35,40,42.195]:[5,10,15,20,21.0975];
    const splits=pts.map(k=>[k===21.0975?L('半程','Half'):k===42.195?L('終點','Finish'):k+'K',fmtHMS(k*pace/60),st?clockAdd(st,Math.round(k*pace/60)):null]);
    const gels=[];const step=f.gap+5;for(let t=35;t<=m-15;t+=step)gels.push([t,+(t*60/pace).toFixed(1),st?clockAdd(st,t):null]);
    const tips=[
      L(`補水：每小時約 ${f.ml[0]}–${f.ml[1]} ml，每個補給站喝幾口，不要喝到體重比賽前還重`,`Fluids: about ${f.ml[0]}–${f.ml[1]} ml/h — a few sips per station; don’t gain weight during the race`),
      L(`鈉：每小時約 ${f.na} mg（運動飲料、鹽錠、含鈉能量膠）`,`Sodium: about ${f.na} mg/h (sports drink, salt tabs, gels with sodium)`),
      L('天氣熱（>25°C）或濕度高：每公里放慢 10–20 秒、多補水，別硬追目標','Hot (>25°C) or humid: slow by 10–20 s/km and drink more — don’t chase the goal'),
      L('不要在比賽日嘗試新鞋、新衣、新補給；凡士林或防磨膏先擦好','Nothing new on race day — shoes, kit or fuel; apply anti-chafe beforehand'),
      L('頭暈、胸悶、抽筋到無法跑：立即減速或停下，找醫護站','Dizziness, chest tightness or severe cramps: slow down or stop and find medical staff'),
      kg?L(`賽後 4 小時：每小時碳水 ${R(kg)}–${R(1.2*kg)} g＋蛋白質 ${R(0.3*kg)} g；喝回流失體重的 125–150%`,`First 4 h after: ${R(kg)}–${R(1.2*kg)} g carbs + ${R(0.3*kg)} g protein per hour; drink back 125–150% of weight lost`):L('賽後：盡快補充碳水和蛋白質，喝回流失的水分','After: refuel with carbs and protein soon, and rehydrate')
    ];
    const night=[L('前一晚：準備號碼布、晶片、衣物、能量膠、別針，設好兩個鬧鐘','Night before: lay out bib, chip, kit, gels and pins; set two alarms'),
      fm?L(`前 36–48 小時：肝醣超補${kg?`，每天碳水 ${R(10*kg)}–${R(12*kg)} g`:''}`,`36–48 h before: carb-load${kg?`, ${R(10*kg)}–${R(12*kg)} g carbs per day`:''}`):L(`前 24–36 小時：輕度超補${kg?`，每天碳水 ${R(7*kg)}–${R(10*kg)} g`:''}`,`24–36 h before: light carb-load${kg?`, ${R(7*kg)}–${R(10*kg)} g carbs per day`:''}`)];
    return {timeline,splits,gels,gelNote:L(`能量膠：第 35 分鐘第一包，之後約每 ${step} 分鐘一包（每小時 ${f.lo===f.hi?f.lo:f.lo+'–'+f.hi} g 碳水）`,`Gels: first at 35 min, then about every ${step} min (${f.lo===f.hi?f.lo:f.lo+'–'+f.hi} g carbs per hour)`),tips,night,needKg:!kg,
      offsets:[-240,-180,-90,-60,-25,-15,0]};
  }

  /* 完成率與全季統計（1933-1945）：statusOf(n, row, i) 回傳 'done'｜'partial'｜null；部分完成算 0.5 */
  function weekStat(n,statusOf){
    const list=planDays(WEEKS[n-1])||[];let req=0,done=0,extra=0;
    list.forEach((x,i)=>{if(x.k==='rest')return;const s=statusOf(n,x,i);const d=s==='done'?1:s==='partial'?0.5:0;if(x.opt){if(s)extra++;return;}req++;done+=d;});
    return {list,req,done,extra};
  }
  function seasonStat(statusOf){
    const wi=weekIndex(), upto=Math.min(21,Math.max(0,wi));
    let req=0,done=0,total=0,all=0;
    for(let n=1;n<=21;n++){const s=weekStat(n,statusOf);all+=s.req;total+=s.done+s.extra;if(n<=upto){req+=s.req;done+=s.done;}}
    let streak=0;
    for(let n=Math.min(upto,21);n>=1;n--){const s=weekStat(n,statusOf);if(s.req&&s.done>=s.req)streak++;else if(n===upto)continue;else break;}
    return {req,done,total,all,rate:req?Math.round(done/req*100):0,streak,left:Math.max(0,all-total)};
  }

  /* 加入行事曆（2413-2462）；DTSTAMP 用 ctx.now */
  function dayOffset(label,isRace){
    if(isRace) return (raceDay().getDay()+6)%7;
    const m=/週([一二三四五六日末])/.exec(label); return m?WD_IDX[m[1]]:0;
  }
  function buildIcs(){
    const g=grpInfo(), nowD=new Date(now());
    const stamp=nowD.toISOString().replace(/[-:]/g,'').replace(/\.\d+/,'');
    const out=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Gengpao//Coach//'+(EN()?'EN':'ZH-TW'),'CALSCALE:GREGORIAN','METHOD:PUBLISH',`X-WR-CALNAME:${icsEsc(planTitle())}`];
    let count=0;
    const key=`${S.raceDate}-${S.dist}${g[0]}`;
    for(const w of WEEKS){
      const list=planDays(w); if(!list) continue;
      const ws=weekStart(w.n);
      list.forEach((x,i)=>{
        if(x.k==='rest') return;
        const isRace=isRaceDay(x);
        const d=addDays(ws,dayOffset(x.d,isRace));
        if(w.n===20&&!isRace&&dayDiff(d,raceDay())>=0) return;   // 平日比賽：賽事週比賽當天以後的課不排（不自己發明減量）
        const p=paceNotes(x.t);
        const desc=[`${wkName(w.n)} ${weekLabel(w)} | ${grpName(g[0])}`,`${dispDay(x)} | ${kindLabel(x)}`, dispText(x)];
        if(p.length) desc.push(L(`配速 ≈ ${p.join('、')}/km`,`Pace ≈ ${p.join(', ')}/km`));
        if(/或/.test(x.d)) desc.push(L(`可在${x.d}擇一天執行`,`Do it on any one of: ${dispDay(x)}`));
        x.notes.forEach(n=>desc.push(n));
        if(isRace){const rp=raceDayPlan();desc.push('',L('— 比賽日流程 —','— Race-day plan —'),...rp.timeline.map(([t,a,b])=>`${t} ${a}：${b}`.replace('：',L('：',': '))),rp.gelNote,'');}
        desc.push(L('課表以教練每週發布的為準','The coach’s weekly post takes priority'));
        const title=isRace?`${raceName()}`:`${x.opt?L('（可省略）','(Optional) '):''}${KIND[x.k]} | ${trPlan(x.t)}${p.length?` (≈${p.join(LIST_SEP())})`:''}`;
        out.push('BEGIN:VEVENT',`UID:gengpao-${key}-w${w.n}-${i}@gengpao-coach`,`DTSTAMP:${stamp}`);
        const st=/^(\d{1,2}):(\d{2})$/.exec(S.start||'');
        if(isRace&&st){
          const s0=new Date(d);s0.setHours(+st[1],+st[2],0,0);const e0=new Date(s0.getTime()+Math.round(targetMin()+30)*60000);
          const f=t=>`${icsDate(t)}T${String(t.getHours()).padStart(2,'0')}${String(t.getMinutes()).padStart(2,'0')}00`;
          out.push(`DTSTART:${f(s0)}`,`DTEND:${f(e0)}`,'TRANSP:OPAQUE',
            'BEGIN:VALARM','ACTION:DISPLAY',`DESCRIPTION:${icsEsc(L(raceName()+' 明天起跑',raceName()+' starts tomorrow'))}`,'TRIGGER:-PT12H','END:VALARM');
        }else{
          out.push(`DTSTART;VALUE=DATE:${icsDate(d)}`,`DTEND;VALUE=DATE:${icsDate(addDays(d,1))}`,'TRANSP:TRANSPARENT');
        }
        out.push(`SUMMARY:${icsEsc(title)}`,`DESCRIPTION:${icsEsc(desc.join('\n'))}`,`CATEGORIES:${icsEsc(isRace?L('比賽','Race'):KIND[x.k])}`,'END:VEVENT');
        count++;
      });
    }
    out.push('END:VCALENDAR');
    return {text:out.map(icsFold).join('\r\n')+'\r\n',count};
  }

  return { S, raceDay, raceName, runnerName, planTitle, distName, grpName, grpInfo, raceKm, targetMin, goalPace,
    w1Monday, weekStart, weekIndex, currentWeek, weekLabel, wkName, md, mdw, planDays, exportDays, paceNotes, isRaceDay, dispText, dispDay, kindLabel,
    predictedMin, suggestGroup, volTier, warnings, breakfastAt, raceDayPlan, explain, hrZoneText,
    headerText, weekText, copyPayload, paceRows, dayOffset, buildIcs, weekStat, seasonStat, noteText: noteText_, weeks: WEEKS };
}

/* ======================================================================
   舊版課表教練（/coach）的資料搬進 App：純函式，畫面在 coach.js 的課表設定
   gengCoachModel：舊版設定（組別、每週天數、身體資料、起跑時間…）
   gengCoachDash：打卡紀錄 log（鍵「比賽日|週次|第幾列」→ 打勾的時間）、我的倒數 cds、圖示徽章 badge（不搬）
   規則：只搬勾選的項目；組別以帳號為準；日期不會是未來；同一個週期、同一週、同一天已經有紀錄就略過；每天最多 5 筆
   ====================================================================== */
export const LEGACY_KEYS = ['gengCoachModel', 'gengCoachDash'];
export const LEGACY_NOTE = '從舊版課表教練匯入';
// 舊版的預設值：跟預設一樣的欄位可能從來沒改過，預設不勾、標「可能是預設值」
export const LEGACY_DEFAULTS = { vol: '30', days: 6, club: true, start: '06:30', age: 45, sex: 'M', kg: 62, sweat: '中', pbDist: '10', pbTime: '0:48:30' };
const PB_NAME = { 5: '5K', 10: '10K', 21.0975: '半馬', 42.195: '全馬' };
const SWEAT_NAME = { 低: '少', 中: '一般', 高: '多' };
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const numIn = (v, lo, hi, dec = 0) => { if (v === '' || v == null || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10 ** dec) / 10 ** dec : null; };
const distName2 = (d) => (d === 'hm' ? '半馬' : '全馬');
// 日期要真的存在（2026-13-01 這種不算）
const okISO = (s) => { const d = P.parseISO(s); return !!d && P.iso(d) === s; };

// 舊版的項目與組別（看不懂就用舊版的預設：全馬 D 組）
export function legacyGroup(model) {
  const m = obj(model), dist = m.dist === 'hm' ? 'hm' : 'fm';
  const grp = typeof m.grp === 'string' && P.groups(dist)[m.grp.toUpperCase()] ? m.grp.toUpperCase() : dist === 'hm' ? 'C' : 'D';
  return { dist, grp, name: `${distName2(dist)} ${grp} 組` };
}

// 可以搬的設定：每一欄一列，def＝跟舊版預設一樣（預設不勾）；patch 是 setCoachPrefs 用的部分設定
// startKey：起跑時間要存在哪一場比賽（沒有目標賽事就不搬起跑時間）
export function legacyPrefs(model, { startKey = null } = {}) {
  const m = obj(model), D = LEGACY_DEFAULTS, out = [];
  const add = (key, label, value, patch, def) => out.push({ key, label, value, patch, def: !!def });
  const days = numIn(m.days, 3, 6);
  if (days != null && Number.isInteger(days)) add('days', '每週能跑', `${days} 天`, { plan: { days } }, days === D.days);
  if (typeof m.club === 'boolean') add('club', '週四團練', m.club ? '參加團練' : '自己練', { plan: { club: m.club } }, m.club === D.club);
  const vol = VOL.find((v) => v[0] === String(m.vol ?? ''));
  if (vol) add('vol', '每週跑量', vol[1][0], { plan: { vol: vol[0] } }, vol[0] === D.vol);
  const st = /^(\d{1,2}):(\d{2})$/.exec(String(m.start || ''));
  if (startKey && st && +st[1] < 24 && +st[2] < 60) {
    const v = `${st[1].padStart(2, '0')}:${st[2]}`;
    add('start', '起跑時間', v, { start: { [startKey]: v } }, v === D.start);
  }
  const pbDist = String(m.pbDist ?? ''), pbTime = String(m.pbTime ?? '').trim();
  if (PB_NAME[pbDist] && parseTime(pbTime) && /^[\d:：]+$/.test(pbTime))
    add('pb', '成績推算', `${PB_NAME[pbDist]} ${pbTime}`, { pb: { dist: pbDist, time: pbTime } }, pbDist === D.pbDist && pbTime === D.pbTime);
  const age = numIn(m.age, 10, 100);
  if (age != null) add('age', '年齡', `${age}`, { body: { age } }, age === D.age);
  if (m.sex === 'M' || m.sex === 'F') add('sex', '性別', m.sex === 'M' ? '男' : '女', { body: { sex: m.sex } }, m.sex === D.sex);
  const kg = numIn(m.kg, 25, 200, 1);
  if (kg != null) add('kg', '體重', `${kg} kg`, { body: { kg } }, kg === D.kg);
  const rest = numIn(m.rest, 30, 120);
  if (rest != null) add('rest', '安靜心率', `${rest}`, { body: { rest } }, false);
  if (SWEAT_NAME[m.sweat]) add('sweat', '流汗程度', SWEAT_NAME[m.sweat], { body: { sweat: m.sweat } }, m.sweat === D.sweat);
  if (m.explain === true) add('explain', '詳細內容全部展開', '開', { ui: { explain: true } }, false);
  return out;
}
// 勾選的設定合成一個 patch（物件欄位逐鍵合併）
export function legacyPatch(fields, keys) {
  const pick = new Set(keys), out = {};
  for (const f of fields) {
    if (!pick.has(f.key)) continue;
    for (const [k, v] of Object.entries(f.patch)) out[k] = { ...(out[k] || {}), ...v };
  }
  return out;
}

// 舊版的目標賽事：今天以後、不是協會賽季那天、我的賽事裡還沒有同一天的，才建議加到我的賽事
export function legacyRace(model, { today, races = [] }) {
  const m = obj(model), date = String(m.raceDate || '');
  if (!okISO(date) || date < today || date === P.RACE_ISO) return null;
  if (races.some((r) => r.date === date)) return null;
  const name = String(m.race || '').trim().slice(0, 40);
  return { name: name || '目標賽事', date, dist: m.dist === 'hm' ? '半馬' : '全馬', unnamed: !name };
}

// 我的倒數：今天以後的才列（照日期排）；exists＝我的賽事已經有同名同日的
export function legacyCountdowns(dash, { today, races = [] }) {
  const cds = Array.isArray(obj(dash).cds) ? dash.cds : [];
  const seen = new Set(), out = [];
  for (const c of cds) {
    const name = String(c?.name || '').trim().slice(0, 40), date = String(c?.date || '');
    if (!name || !okISO(date) || date < today || seen.has(`${date}|${name}`)) continue;
    seen.add(`${date}|${name}`);
    out.push({ name, date, exists: races.some((r) => r.date === date && r.name === name) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : 1));
}

// 打卡紀錄對到課表：鍵「比賽日|週次|第幾列」，列號是那一組原始課表的位置（W1 舊版內容不同，不搬）
//   比賽日是 2026-12-20 → 協會賽季；其他日期 → 那場比賽的個人週期（include 有勾那個日期才上傳）
//   日期：打勾那天是這一列的日期就用它；不是就用打勾那天（含）以前最近的一天；再不行用今天以前的第一天；都沒有就略過
//   existing：伺服器上已經有的紀錄（同一個週期、同一週、同一天就算已存在）
export function legacyLogs({ model, dash, weeks, today, existing = [], include = [] }) {
  const { dist, grp } = legacyGroup(model), log = obj(obj(dash).log);
  const keys = Object.keys(log).map((k) => {
    const m = /^(\d{4}-\d{2}-\d{2})\|(\d{1,2})\|(\d{1,2})$/.exec(k);
    return m ? { k, anchor: m[1], n: +m[2], i: +m[3] } : { k, bad: true };
  }).sort((a, b) => (a.bad || b.bad ? (a.bad ? 1 : -1) : a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : a.n - b.n || a.i - b.i));
  const perDay = {}, seen = new Set(), others = {}, mapped = {};
  for (const l of existing) perDay[l.date] = (perDay[l.date] || 0) + 1;
  const out = { upload: [], existed: 0, unmatched: 0, capped: 0, other: [], otherLeft: 0, total: keys.length };
  for (const x of keys) {
    if (x.bad || !okISO(x.anchor) || x.n < 2 || x.n > 21) { out.unmatched++; continue; }
    const w = weeks?.[x.n - 1], plan = w?.plan;
    const raw = !plan ? null : plan.fmAll ? (dist === 'hm' ? plan.hmAll : plan.fmAll) : plan[dist]?.[grp];
    const r = raw?.[x.i];
    if (!r) { out.unmatched++; continue; }
    const [d, t] = r, k = kind(d, t), row = { d, t, kind: k };
    if (k === 'rest') { out.unmatched++; continue; }
    const club = x.anchor === P.RACE_ISO, cyc = club ? P.CLUB : P.cycleOf(x.anchor);
    const cands = P.dayDates(x.n, d, cyc, row).filter((v) => v <= today);
    const ts = Number(log[x.k]), tick = Number.isFinite(ts) && ts > 0 ? P.iso(new Date(ts)) : null;
    const date = (tick && cands.includes(tick) && tick) || (tick && cands.filter((v) => v <= tick).pop()) || cands[0] || null;
    if (!date) { out.unmatched++; continue; }
    if (!club) mapped[x.anchor] = (mapped[x.anchor] || 0) + 1;
    if (!club && !include.includes(x.anchor)) { others[x.anchor] = (others[x.anchor] || 0) + 1; out.otherLeft++; continue; }
    const dup = `${P.cycleKey(cyc, x.n)}|${d}`;
    if (seen.has(dup) || existing.some((l) => P.logMatches(l, cyc, x.n, row))) { out.existed++; continue; }
    if ((perDay[date] || 0) >= 5) { out.capped++; continue; }
    seen.add(dup); perDay[date] = (perDay[date] || 0) + 1;
    out.upload.push({ date, status: 'done', plan_day: d, kind: k, plan_text: !club && P.isRaceDay(row, x.n) ? '比賽日' : t,
      source: 'manual', note: LEGACY_NOTE, if_absent: true, ...P.cycleFields(cyc, x.n), key: x.k });
  }
  // 其他週期（每一場比賽日一個勾選框）：count＝對得到課表的筆數，left＝沒勾所以沒上傳的筆數
  out.other = Object.keys(mapped).sort().map((anchor) => ({ anchor, count: mapped[anchor], left: others[anchor] || 0 }));
  return out;
}
// 去伺服器查已有紀錄的範圍：協會賽季與每個個人週期的 W1 起（最多往回 365 天，查詢上限一年）到今天
export function legacyRange(dash, today) {
  const t = P.parseISO(today), floor = P.iso(P.addDays(t, -365));
  let from = P.CLUB.w1ISO;
  for (const k of Object.keys(obj(obj(dash).log))) {
    const a = /^(\d{4}-\d{2}-\d{2})\|/.exec(k)?.[1];
    if (a && okISO(a)) { const w = P.cycleOf(a).w1ISO; if (w < from) from = w; }
  }
  if (from < floor) from = floor;
  if (from > today) from = today;
  return { from, to: today };
}
// 全部合在一起（畫面一次拿）
export function planLegacyImport({ model, dash, weeks, today, races = [], existing = [], include = [], startKey = null, me = null }) {
  const m = obj(model), g = legacyGroup(m);
  return {
    who: { name: String(m.name || '').trim().slice(0, 40), group: g },
    groupDiff: me && (me.dist !== g.dist || me.grp !== g.grp) ? { from: g, to: { dist: me.dist, grp: me.grp, name: `${distName2(me.dist)} ${me.grp} 組` } } : null,
    prefs: legacyPrefs(m, { startKey }),
    race: legacyRace(m, { today, races }),
    cds: legacyCountdowns(dash, { today, races }),
    logs: legacyLogs({ model: m, dash, weeks, today, existing, include }),
  };
}
// 只有完成紀錄的備份（上傳結果旁的「下載這些紀錄的備份」）：不含姓名、年齡、性別、體重、安靜心率與倒數
export function legacyLogBackup(dash, now = new Date()) {
  return JSON.stringify({ app: 'gengpao-coach', v: 1, exported: new Date(now).toISOString(), dash: { log: obj(obj(dash).log) } }, null, 2);
}
// 舊版格式的備份（跟舊版「匯出備份」一樣，舊版頁面可以還原）
export function legacyBackup(model, dash, now = new Date()) {
  return JSON.stringify({ app: 'gengpao-coach', v: 1, exported: new Date(now).toISOString(), settings: obj(model), dash: obj(dash) }, null, 2);
}
