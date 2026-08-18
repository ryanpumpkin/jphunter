// 排程器。兩個完全分開嘅節奏：
//   1. 新貨——每條 watch 自己一個遞歸 setTimeout（唔用 setInterval：
//      一次跑得慢過個間隔就會疊，越疊越多最後一齊轟個站）
//   2. 成交價——一條慢隊列，5 分鐘先處理一條 stale query，
//      永遠唔會同新貨巡邏爭頻寬
import { watchListEnabled, watchGet, compRunGet, pruneOld } from './db.js';
import { sweepWatch, harvestComps, compQueryOf, reportSweepHealth } from './ingest.js';
import { checkSourceHealth } from './health.js';

const COMP_STALE_MS = 12 * 60 * 60 * 1000;  // 成交價 12 個鐘重收一次
const COMP_TICK_MS = 5 * 60 * 1000;         // 每 5 分鐘至多處理一條
const HEALTH_TICK_MS = 30 * 60 * 1000;
const PRUNE_TICK_MS = 24 * 60 * 60 * 1000;

const timers = new Map();   // watchId -> Timeout
const running = new Set();  // watchId，防同一條 watch 疊住跑
const compQueue = [];       // 插隊用（新開 watch 即刻收一次成交價）
let stopped = false;

const jitter = ms => ms * (0.9 + Math.random() * 0.2);

async function runWatch(id) {
  if (stopped || running.has(id)) return;
  const watch = watchGet.get(id);
  if (!watch || !watch.enabled) return;
  running.add(id);
  try {
    const { perSource } = await sweepWatch(watch);
    // 以來源為單位滾埋一齊記健康（見 ingest.js 註解點解唔 per-watch）
    const totals = {};
    for (const p of perSource) {
      totals[p.id] ??= { n: 0, reason: null };
      totals[p.id].n += p.n;
      if (p.reason && !totals[p.id].reason) totals[p.id].reason = p.reason;
    }
    reportSweepHealth(totals);
  } catch (err) {
    console.error(`[scheduler] 巡「${watch.keyword}」出錯：`, err.message);
  } finally {
    running.delete(id);
  }
}

function scheduleWatch(watch, { immediate = false } = {}) {
  clearTimeout(timers.get(watch.id));
  const ms = jitter(Math.max(60, watch.interval_s) * 1000);
  const tick = async () => {
    await runWatch(watch.id);
    const fresh = watchGet.get(watch.id);
    if (!stopped && fresh?.enabled) scheduleWatch(fresh);
  };
  timers.set(watch.id, setTimeout(tick, immediate ? 0 : ms));
}

// 加/改/刪 watch 之後叫一次，唔使重啟 server
export function rebuildWatchTimers({ immediateFor = null } = {}) {
  for (const [id, t] of timers) { clearTimeout(t); timers.delete(id); }
  const watches = watchListEnabled.all();
  watches.forEach((w, i) => {
    if (w.id === immediateFor) return scheduleWatch(w, { immediate: true });
    // 錯開起步，唔好成打 watch 同一秒衝去同一個站
    clearTimeout(timers.get(w.id));
    timers.set(w.id, setTimeout(() => scheduleWatch(w, { immediate: true }), i * 20_000 + 5_000));
  });
  console.log(`[scheduler] ${watches.length} 條追蹤已排程`);
  return watches.length;
}

// 新開一條 watch：插隊即刻收成交價，唔使等 12 個鐘先判斷到嘢
export function primeComps(watchId) {
  if (!compQueue.includes(watchId)) compQueue.unshift(watchId);
}

// 揀下一條要收成交價嘅 watch：插隊優先，否則揀最耐冇收過嗰條
function nextCompWatch() {
  while (compQueue.length) {
    const id = compQueue.shift();
    const w = watchGet.get(id);
    if (w) return w;
  }
  let oldest = null, oldestAt = Infinity;
  for (const w of watchListEnabled.all()) {
    const run = compRunGet.get(compQueryOf(w));
    const at = run?.last_ok ? Date.parse(run.last_ok + 'Z') : 0;
    if (Date.now() - at < COMP_STALE_MS) continue;
    if (at < oldestAt) { oldest = w; oldestAt = at; }
  }
  return oldest;
}

let compBusy = false;
async function compTick() {
  if (stopped || compBusy) return;
  const w = nextCompWatch();
  if (!w) return;
  compBusy = true;
  try {
    await harvestComps(w);
  } catch (err) {
    console.error(`[scheduler] 收「${w.keyword}」成交價出錯：`, err.message);
  } finally {
    compBusy = false;
  }
}

export function startScheduler() {
  stopped = false;
  rebuildWatchTimers();

  const compTimer = setInterval(compTick, COMP_TICK_MS);
  setTimeout(compTick, 30_000);   // 起機半分鐘後開頭一條
  const healthTimer = setInterval(checkSourceHealth, HEALTH_TICK_MS);
  const pruneTimer = setInterval(pruneOld, PRUNE_TICK_MS);
  for (const t of [compTimer, healthTimer, pruneTimer]) t.unref?.();

  console.log('[scheduler] 起咗：新貨按每條追蹤自己嘅間隔，成交價 5 分鐘一格慢慢收');
}

export function stopScheduler() {
  stopped = true;
  for (const [id, t] of timers) { clearTimeout(t); timers.delete(id); }
}

// 手動即跑（API 用）
export async function runWatchNow(id) {
  await runWatch(id);
  return true;
}
export async function harvestNow(id) {
  const w = watchGet.get(id);
  if (!w) throw new Error('搵唔到呢條追蹤');
  return harvestComps(w);
}
