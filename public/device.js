// 耕跑團 — 這台裝置上的個人資料屬於哪個帳號（共用裝置換人時清掉上一位的資料，A.5.34／A.8.12）
//   登入狀態過期、被撤銷時不會經過「登出」，所以不能只靠登出時的 CLEAR_DATA：
//   換另一個人登入就清掉上一位的離線暫存（localStorage、Service Worker 的 API 暫存與分享暫存），並取消這台的推播訂閱
//   （訂閱在伺服器還綁著上一位，不取消的話上一位的通知標題會出現在新使用者的鎖定畫面）
//   依賴（storage、caches、dropPush）由呼叫端傳入，純邏輯可以在 node 測試
export const OWNER_KEY = 'cil-device-owner';
export const LOCAL_KEYS = ['cil-log-queue', 'cil-coach'];
export const API_CACHE = 'cil-api';
export const SHARE_CACHE = 'cil-share';

const quiet = (p) => Promise.resolve(p).catch(() => {});
const read = (storage) => { try { return { ok: true, v: storage.getItem(OWNER_KEY) }; } catch { return { ok: false, v: null }; } };

// 登入後綁定這台裝置的主人；回傳 'same'｜'bound'（第一次綁定）｜'switched'（換人，已清掉上一位）｜'none'
export async function bindOwner(id, { storage, caches, dropPush } = {}) {
  if (!id || !storage) return 'none';
  const cur = read(storage);
  if (!cur.ok) return 'none';                     // 無痕模式等讀不到：不知道主人是誰，維持原狀
  if (cur.v === id) return 'same';
  const tasks = [];
  if (cur.v) {
    try { for (const k of LOCAL_KEYS) storage.removeItem(k); } catch {}
    tasks.push(caches?.delete(API_CACHE), caches?.delete(SHARE_CACHE), dropPush?.());
  } else {
    // 第一次綁定（舊版升級、登出後）：API 暫存不確定是誰的，先清掉（分享暫存可能是登入前剛分享進來的檔案，保留）
    tasks.push(caches?.delete(API_CACHE));
  }
  try { storage.setItem(OWNER_KEY, id); } catch {}
  await Promise.all(tasks.map(quiet));
  return cur.v ? 'switched' : 'bound';
}

// 先畫後抓用的上次資料：只有屬於這台裝置目前主人的才用（不會用上一位的首頁先畫出來）
export function bootFor(stale, storage) {
  const id = stale?.member?.id;
  if (!id) return null;
  const cur = read(storage);
  return cur.ok && cur.v === id ? stale : null;
}

// 伺服器說沒有登入（過期、被撤銷）：離線時不再拿上一位的 API 暫存出來顯示
//   主人標記與未送出的訓練紀錄保留：同一個人重新登入時接著用，換人時由 bindOwner 清掉
export async function sessionEnded({ caches } = {}) {
  await quiet(caches?.delete(API_CACHE));
}
