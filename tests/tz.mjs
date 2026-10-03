// 單元測試的時區固定在臺北：要在 plan.js 之前載入（import 會先於檔案本身的程式執行，
//   所以不能在測試檔裡直接寫 process.env.TZ = …，那時 plan.js 的 W1、RACE 已經用主機時區算好了）
process.env.TZ = 'Asia/Taipei';
