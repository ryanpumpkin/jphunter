#!/usr/bin/env node
// 一次過手動跑：巡晒所有 enabled watch 嘅新貨，跑完就收工。
//   node server/sweep.js            巡新貨
//   node server/sweep.js --comps    順手收埋成交價（慢好多）
//   node server/sweep.js --comps-only
//
// 平時唔使用——server 起咗就有排程器自己跑。呢個係俾你手動催一次，
// 或者想用 crontab 唔想長開 server 嗰陣用。
import { watchListEnabled } from './db.js';
import { sweepWatch, harvestComps } from './ingest.js';
import { closeBrowser } from './sources/browser.js';

const args = process.argv.slice(2);
const withComps = args.includes('--comps') || args.includes('--comps-only');
const compsOnly = args.includes('--comps-only');

const watches = watchListEnabled.all();
if (!watches.length) {
  console.log('冇 enabled 嘅追蹤。先去 web 加一條關鍵字。');
  process.exit(0);
}

let newItems = 0;
for (const w of watches) {
  if (withComps) {
    try { await harvestComps(w); }
    catch (err) { console.error(`[sweep] 收「${w.keyword}」成交價出錯：`, err.message); }
  }
  if (compsOnly) continue;
  try {
    const r = await sweepWatch(w);
    newItems += r.found;
  } catch (err) {
    console.error(`[sweep] 巡「${w.keyword}」出錯：`, err.message);
  }
}

console.log(`[sweep] 完成：${watches.length} 條追蹤${compsOnly ? '' : `，新貨 ${newItems} 件`}`);
// 通知隊列係非同步嘅，畀幾秒佢送晒先閂
await new Promise(r => setTimeout(r, 5000));
await closeBrowser();
process.exit(0);
