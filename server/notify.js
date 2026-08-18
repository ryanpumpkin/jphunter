// 通知 dispatcher：格式化一條訊息 → 派去所有啟用咗嘅 channel。
// 骨架照搬 BeyHunter：全局序列隊列 + 重試 + 每次派送寫低。
import * as telegram from './channels/telegram.js';
import { insertNotifyLog } from './db.js';
import { VERDICTS } from './pricing/verdict.js';

// 加 WhatsApp 就喺呢度 push 多個 module 落嚟（介面：name/enabled()/send()/init?()）
const CHANNELS = [telegram];

export function initChannels() {
  for (const ch of CHANNELS) ch.init?.();
}

const SOURCE_LABEL = {
  'yahoo-auction': 'Yahoo!拍賣',
  mercari: 'Mercari',
  surugaya: '駿河屋',
};

const yen = n => `¥${Math.round(n).toLocaleString('en-US')}`;

// 一條新上架 → 通知文字。verdict 嘅解釋行由 pricing/verdict.js 出，
// 呢度只負責砌埋出處、標題、價、連結。
export function formatListing(ev) {
  const v = VERDICTS[ev.verdict] || VERDICTS.unknown;
  const src = SOURCE_LABEL[ev.source] || ev.source;

  // 標題行：出處 + 賣法（即決／競投中剩幾耐／定價）+ 關鍵字
  const bits = [];
  if (ev.listing_kind === 'auction_bin') bits.push('即決');
  else if (ev.listing_kind === 'auction') {
    bits.push('競投中');
    if (ev.ends_at) bits.push(`剩 ${ev.ends_at}`);
    if (ev.bids != null) bits.push(`${ev.bids} 次出價`);
  }
  if (ev.condition) bits.push(ev.condition);
  const suffix = bits.length ? `（${bits.join('・')}）` : '';

  const lines = [
    `${v.emoji} 🇯🇵 ${src}${suffix}｜${ev.keyword}`,
    ev.title,
  ];

  // 價：競投中要明寫「唔算成交價」，唔好俾人誤會
  if (ev.listing_kind === 'auction' && !ev.buyout_price) {
    if (ev.price != null) lines.push(`💴 現價 ${yen(ev.price)}（競投中，唔算成交價）`);
  } else if (ev.buyout_price) {
    lines.push(`💴 即決價 ${yen(ev.buyout_price)}`);
  } else if (ev.price != null) {
    lines.push(`💴 ${yen(ev.price)}`);
  }

  if (ev.verdictLines?.length) lines.push(...ev.verdictLines);
  if (ev.staleNote) lines.push(`　（${ev.staleNote}）`);
  if (ev.url) lines.push(`🔗 ${ev.url}`);

  return lines.join('\n');
}

// 全局序列隊列：唔理幾多條 watch 並行觸發通知，實際發送一律逐條、
// 相隔幾秒先送（Telegram 對同一個 chat 有 ~30 msg/s 上限，狂發會 429）。
const SEND_DELAY_MS = 1200;
let sendChain = Promise.resolve();

// 一條通知喺一個 channel 試幾多次。短暫斷線好常見，試多兩次通常就過到。
const RETRY_DELAYS_MS = [5_000, 20_000];

function logDelivery(row) {
  try { insertNotifyLog.run(row); } catch (err) { console.warn('[notify] 寫 notify_log 失敗：', err.message); }
}

// 派一條去單一 channel，失敗自動重試。回傳 true = 最終送到。唔會 throw。
async function deliver(ch, text, ev) {
  const meta = {
    channel: ch.name,
    kind: ev?.kind === 'system' ? 'system' : (ev?.verdict || null),
    title: (ev?.title || text).split('\n')[0].slice(0, 120),
    url: ev?.url || null,
  };
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      await ch.send(text, ev);
      logDelivery({ ...meta, status: 'ok', attempts: attempt, error: null });
      return true;
    } catch (err) {
      lastErr = err;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      if (delay == null) break;
      console.warn(`[notify:${ch.name}] 第 ${attempt} 次失敗（${err.message}），${delay / 1000}s 後再試`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.warn(`[notify:${ch.name}] 試晒都送唔出：`, lastErr?.message);
  logDelivery({ ...meta, status: 'failed', attempts: RETRY_DELAYS_MS.length + 1, error: lastErr?.message || String(lastErr) });
  return false;
}

function enqueue(text, ev) {
  const active = CHANNELS.filter(ch => ch.enabled());
  if (active.length === 0) {
    console.log(`[notify] (未設定通知渠道) ${text.replace(/\n/g, ' | ')}`);
    return Promise.resolve(false);
  }
  sendChain = sendChain
    .then(async () => {
      let anyOk = false;
      for (const ch of active) {
        if (await deliver(ch, text, ev)) anyOk = true;
      }
      await new Promise(r => setTimeout(r, SEND_DELAY_MS));
      return anyOk;
    })
    .catch(err => { console.warn('[notify] 隊列處理出錯：', err.message); return false; });
  return sendChain;
}

export function notifyListing(ev) {
  return enqueue(formatListing(ev), ev);
}

// 系統警報（來源壞咗、被反爬蟲擋、成交價收唔到）
export function alertSystem(text) {
  return enqueue(`⚠️ ${text}`, { kind: 'system', title: text });
}

export function notifyTest() {
  return enqueue('🧪 JPHunter 測試訊息——通知已駁通！之後有新上架會即刻推到呢度。',
    { kind: 'system', title: '測試訊息' });
}

export { CHANNELS };
