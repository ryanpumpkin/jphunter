// 禮貌層：每個來源一條序列 chain，兩次請求之間強制隔一段時間 + jitter。
// 兼管反爬蟲冷卻——俾人擋咗就指數式退避，唔好死撐落去搞到 IP 俾人封死。
// 呢個 app 係個人自用，寧願慢，唔好狼。

const MIN_GAP_MS = {
  'yahoo-auction': 3000,
  'yahoo-closed': 3000,
  surugaya: 4000,
  mercari: 8000,        // Playwright + 反爬蟲最勁，行最鬆
  'mercari-sold': 8000,
};
const DEFAULT_GAP_MS = 4000;

// 被擋之後嘅冷卻階梯，封頂 4 個鐘。成功一次即刻 reset。
const BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3600_000, 4 * 3600_000];

const chains = new Map();   // sourceId -> Promise
const lastAt = new Map();   // sourceId -> timestamp
const blocked = new Map();  // sourceId -> { until, level }

const jitter = ms => ms * (0.85 + Math.random() * 0.3);

// 呢個來源而家係咪喺冷卻期？回傳剩低幾多毫秒（0 = 可以行）
export function cooldownLeft(sourceId) {
  const b = blocked.get(sourceId);
  if (!b) return 0;
  const left = b.until - Date.now();
  if (left <= 0) { blocked.delete(sourceId); return 0; }
  return left;
}

// 俾反爬蟲擋咗／連續失敗 → 退避一級。回傳今次冷卻幾耐（毫秒）。
export function noteBlocked(sourceId) {
  const prev = blocked.get(sourceId);
  const level = Math.min((prev?.level ?? -1) + 1, BACKOFF_MS.length - 1);
  const ms = BACKOFF_MS[level];
  blocked.set(sourceId, { until: Date.now() + ms, level });
  return ms;
}

// 成功抓到嘢 → 清冷卻
export function noteOk(sourceId) {
  blocked.delete(sourceId);
}

// 排隊行一個抓取動作：同一來源永遠唔會並行，兩次之間至少隔 MIN_GAP_MS。
export function paced(sourceId, fn) {
  const gap = MIN_GAP_MS[sourceId] ?? DEFAULT_GAP_MS;
  const prev = chains.get(sourceId) || Promise.resolve();
  const next = prev.then(async () => {
    const since = Date.now() - (lastAt.get(sourceId) || 0);
    const wait = jitter(gap) - since;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt.set(sourceId, Date.now());
    return fn();
  });
  // 唔好俾一次失敗炸爆條 chain（之後全部排隊嘅都會 reject）
  chains.set(sourceId, next.then(() => {}, () => {}));
  return next;
}
