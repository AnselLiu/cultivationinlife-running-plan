// 耕跑團 — 這台裝置上的個人資料屬於哪個帳號（共用裝置換人時清掉上一位的資料，A.5.34／A.8.12）
//   登入狀態過期、被撤銷時不會經過「登出」，所以不能只靠登出時的 CLEAR_DATA：
//   換另一個人登入就清掉上一位的離線暫存（localStorage、Service Worker 的 API 暫存與分享暫存），並取消這台的推播訂閱
//   （訂閱在伺服器還綁著上一位，不取消的話上一位的通知標題會出現在新使用者的鎖定畫面）
//   依賴（storage、session、caches、dropPush、reset、priorOwner、ask）由呼叫端傳入，純邏輯可以在 node 測試
export const OWNER_KEY = 'cil-device-owner';
// 這台裝置上屬於某個帳號的 localStorage：
//   cil-log-queue 未送出的訓練紀錄、cil-coach 課表設定與身體資料、cil-run-session 跑步中的 GPS 軌跡（位置資料）、
//   cil-team 首頁的分團篩選、cil-map-view 地圖上次看的位置、cil-push-owner 推播訂閱是誰開的、
//   cil-push-resume 登入狀態過期時關掉的推播是誰的（同一個人重新登入時自動重新開啟）
//   （語言、主題、底圖、看過使用說明等裝置偏好不清；舊版課表教練的資料不屬於任何帳號，登出時另外問）
export const LOCAL_KEYS = ['cil-log-queue', 'cil-coach', 'cil-run-session', 'cil-team', 'cil-map-view', 'cil-push-owner', 'cil-push-resume'];
// 換人時一定不能留給下一位的資料：有這些、又不知道主人是誰，就先確認是誰的
export const DATA_KEYS = ['cil-log-queue', 'cil-coach', 'cil-run-session'];
// sessionStorage：填到一半的活動表單、報名草稿（同一個分頁換人登入時清掉；登入後要回去的頁面 cil-after-login 保留）
export const SESSION_KEYS = ['cil-ev-draft', 'cil-after-reg'];
export const PUSH_OWNER_KEY = 'cil-push-owner';
export const PUSH_RESUME_KEY = 'cil-push-resume';
export const API_CACHE = 'cil-api';
export const SHARE_CACHE = 'cil-share';

const quiet = (p) => Promise.resolve(p).catch(() => {});
const read = (storage, k = OWNER_KEY) => { try { return { ok: true, v: storage.getItem(k) }; } catch { return { ok: false, v: null }; } };
const has = (storage, k) => { const r = read(storage, k); return r.ok && r.v != null && r.v !== '' && r.v !== '[]' && r.v !== 'null'; };
const put = (storage, k, v) => { try { if (v) storage.setItem(k, v); else storage.removeItem(k); } catch {} };
export const ownerOf = (storage) => (storage ? read(storage).v : null);

// 取消推播訂閱還沒做完之前，通知設定不能讀到舊的訂閱（否則會把上一位的 endpoint 重新綁到新的人）
let pushGate = Promise.resolve();
export const pushReady = () => pushGate;
const gate = (p) => { const g = quiet(p); pushGate = Promise.all([pushGate, g]).then(() => {}); return g; };

// 清掉這台裝置上所有屬於某個帳號的資料（同步完成：flushLogQueue 緊接著讀暫存區，不能等非同步）
export function clearLocal({ storage, session, reset } = {}, { owner = true } = {}) {
  try { for (const k of LOCAL_KEYS) storage?.removeItem(k); } catch {}
  try { if (owner) storage?.removeItem(OWNER_KEY); } catch {}
  try { for (const k of SESSION_KEYS) session?.removeItem(k); } catch {}
  try { reset?.(); } catch {}   // 已經讀進記憶體的資料（跑步中的這次跑步）也丟掉
}

// 登入後綁定這台裝置的主人；回傳
//   'same'（本來就是他的）｜'adopted'（主人不明，但確認是他的：認領，不清任何資料）｜'bound'（第一次綁定，沒有別人的資料）｜
//   'switched'（換人，或主人不明而且不是他的：已清掉）｜'none'
//   主人不明（登出後、這個版本之前的裝置還沒記主人）卻有未送出的訓練紀錄、課表設定或跑步軌跡時：
//   1. 上次的 /api/me?boot=1 暫存（priorOwner）是同一個人 → 認領（升級後第一次開啟不會清掉只存在手機裡的身體資料、跑到一半的軌跡）
//   2. 不然問本人（ask：回 true＝是我的，保留）；沒辦法問或回答不是 → 當成別人的清掉，不會用新帳號把別人的紀錄送出去
//   同一個帳號同時呼叫多次（首頁與離線補傳）共用同一個結果，不會問兩次
let inflight = null;
export function bindOwner(id, deps = {}) {
  if (inflight && inflight.id === id) return inflight.p;
  const p = bind(id, deps);
  const mine = { id, p };
  inflight = mine;
  p.then(() => { if (inflight === mine) inflight = null; }, () => { if (inflight === mine) inflight = null; });
  return p;
}
async function bind(id, deps) {
  const { storage, caches, dropPush, priorOwner, ask } = deps;
  if (!id || !storage) return 'none';
  const cur = read(storage);
  if (!cur.ok) return 'none';                     // 無痕模式等讀不到：不知道主人是誰，維持原狀
  if (cur.v === id) return 'same';
  if (!cur.v && (priorOwner || ask)) {   // 沒有給認主人的方法（priorOwner、ask）：照舊同步清掉
    const prior = await quiet(priorOwner?.());
    const now = read(storage).v;
    if (now === id) return 'same';
    if (!now && prior === id) { put(storage, OWNER_KEY, id); return 'adopted'; }
    if (!now && DATA_KEYS.some((k) => has(storage, k)) && (await quiet(ask?.())) === true && !read(storage).v) {
      put(storage, OWNER_KEY, id);
      return 'adopted';
    }
  }
  const owner = read(storage).v;
  if (owner === id) return 'same';
  const other = !!owner || DATA_KEYS.some((k) => has(storage, k));
  const tasks = [];
  if (other) {
    clearLocal(deps, { owner: false });
    tasks.push(caches?.delete(API_CACHE), caches?.delete(SHARE_CACHE), gate(dropPush?.()));
  } else {
    // 第一次綁定、沒有任何人的資料：API 暫存不確定是誰的，先清掉（分享暫存可能是登入前剛分享進來的檔案，保留）
    tasks.push(caches?.delete(API_CACHE));
  }
  put(storage, OWNER_KEY, id);
  await Promise.all(tasks.map(quiet));
  return other ? 'switched' : 'bound';
}

// 先畫後抓用的上次資料：只有屬於這台裝置目前主人的才用（不會用上一位的首頁先畫出來）
export function bootFor(stale, storage) {
  const id = stale?.member?.id;
  if (!id) return null;
  const cur = read(storage);
  return cur.ok && cur.v === id ? stale : null;
}

// 伺服器說沒有登入（過期、被撤銷）：離線時不再拿上一位的 API 暫存出來顯示，並取消這台的推播訂閱
//   （伺服器上的訂閱還綁著那個帳號；瀏覽器端取消後推播服務回 410，伺服器就刪掉）
//   主人標記與未送出的訓練紀錄保留：同一個人重新登入時接著用，換人時由 bindOwner 清掉
//   主人不明（這個版本之前的裝置）：API 暫存刪掉之前，先用它認出主人（priorOwner），之後換人才清得掉、同一個人才接得回去
//   推播：記下是誰的（cil-push-resume），同一個人重新登入時自動重新開啟（takeResume），不用自己發現再去開
export async function sessionEnded({ storage, caches, dropPush, priorOwner } = {}) {
  if (storage && read(storage).ok && !read(storage).v) {
    const prior = await quiet(priorOwner?.());
    if (prior && !read(storage).v) put(storage, OWNER_KEY, prior);
  }
  const who = storage ? read(storage, PUSH_OWNER_KEY).v || read(storage).v : null;
  const drop = Promise.resolve().then(() => dropPush?.()).then((had) => { if (had && who && storage) put(storage, PUSH_RESUME_KEY, who); });
  await Promise.all([quiet(caches?.delete(API_CACHE)), gate(drop)]);
}

// 推播訂閱是誰開的：開啟推播時記下；伺服器說不認得這台的訂閱時，只有開的人就是目前登入的人才悄悄重新綁定
export function markPush(storage, id) { put(storage, PUSH_OWNER_KEY, id || null); if (id) put(storage, PUSH_RESUME_KEY, null); }
export function mayRebind(storage, id) { const r = read(storage, PUSH_OWNER_KEY); return !!id && r.ok && r.v === id; }
// 登入狀態過期時關掉的推播：是這個人的才回 true，並且只回一次（不管重新開啟成不成功，都不會一直提醒）
export function takeResume(storage, id) {
  if (!storage || !id) return false;
  const r = read(storage, PUSH_RESUME_KEY);
  if (!r.ok || !r.v) return false;
  put(storage, PUSH_RESUME_KEY, null);
  return r.v === id;
}
