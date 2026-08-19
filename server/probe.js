#!/usr/bin/env node
// ★ Dry-run CLI：抓一次、印出解析結果，唔寫 DB、唔推通知。
//
// 點解要有呢個：五個站嘅 selector 係會壞嘅（改版／被封），而開發環境
// 未必連得到日本站。呢個工具行喺你部機／NAS，一眼睇到邊層 selector 死咗。
//
//   node server/probe.js --all "青木陽菜 直筆"
//   node server/probe.js yahoo-auction "青木陽菜 直筆"
//   node server/probe.js yahoo-closed "青木陽菜 直筆" --json
//   node server/probe.js --verdict "青木陽菜 直筆"      ← 抓成交＋抓新貨，印判斷
//   node server/probe.js mercari "青木陽菜" --save-html /tmp/m.html
//
// ★ 呢個檔刻意唔 import db.js 同 notify.js——從結構上保證佢寫唔到嘢、
//   send 唔到嘢。改嘢嗰陣唔好破壞呢個約束。
import { ALL_SOURCES, LISTING_SOURCES, SOLD_SOURCES, byId } from './sources/index.js';
import { judge, WINDOW_DAYS } from './pricing/verdict.js';
import { normalizeTitle } from './pricing/normalize.js';
import { summarize } from './pricing/stats.js';
import { closeBrowser } from './sources/browser.js';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const saveHtmlIdx = args.indexOf('--save-html');
const saveHtmlPath = saveHtmlIdx >= 0 ? args[saveHtmlIdx + 1] : null;
// ★ positional 要剔走 --save-html 後面嗰個路徑，唔係佢會冚埋落嚟，
//   等陣 keyword = positional[positional.length-1] 就會攞咗個檔案路徑做關鍵字。
//   但要記住冇 --save-html 嗰陣 saveHtmlIdx 係 -1，-1+1=0 就會誤刪 index 0，
//   即係來源名——`probe.js mercari "關鍵字"` 會變成「唔識來源」。
const skipIdx = saveHtmlIdx >= 0 ? saveHtmlIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== skipIdx);

const yen = n => n == null ? '—' : `¥${Math.round(n).toLocaleString('en-US')}`;
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

function usage() {
  console.log(`
用法：
  node server/probe.js --all "<關鍵字>"            五個來源逐個試
  node server/probe.js <來源> "<關鍵字>"           單一來源
  node server/probe.js --verdict "<關鍵字>"        抓成交價＋新貨，印抵買判斷（唔寫 DB）
  可加 --json（出 JSON）、--save-html <路徑>（存原始 HTML 自己開嚟睇）

來源：${ALL_SOURCES.map(s => s.id).join('、')}
`);
}

// 抓到 0 件時嘅逐層診斷——呢個先係 probe 最有價值嘅輸出
function printDiag(src, result) {
  console.log(`\n[probe] ${src.id} 抓到 0 件。逐層檢查：`);
  for (const line of result.diag || []) console.log(`  ${line}`);
  if (result.status === 'login') {
    console.log(`\n→ 呢個來源要登入，唔係改版。成交價會淨靠另一個來源頂住。`);
  } else if (result.status === 'blocked') {
    console.log(`\n→ 俾人擋咗（唔係改版）。等冷卻完再試，或者換個網絡出口。`);
  } else if (result.status === 'error') {
    console.log(`\n→ 連都連唔到，睇下係咪冇網／被防火牆擋。`);
  } else {
    console.log(`
→ 個站好可能改咗版。做法：
   1. node server/probe.js ${src.id} "<關鍵字>" --save-html /tmp/x.html
   2. 開 /tmp/x.html，睇下搜尋結果卡而家用咩 class／structure
   3. 改 server/sources/${src.id.replace('mercari-sold', 'mercari')}.js 個 TIERS 階梯
      （每層都係獨立 function，改一層唔會影響其他層）`);
  }
}

async function probeOne(src, keyword, opts = {}) {
  const t0 = Date.now();
  process.stdout.write(`\n━━ ${src.id}（${src.label}）`);
  const result = await src.search(keyword, opts);
  const ms = Date.now() - t0;
  console.log(` — ${result.rows.length} 件・${(ms / 1000).toFixed(1)}s・${result.tier || '冇一層中'}・status=${result.status}`);

  if (!result.rows.length) { printDiag(src, result); return result; }

  if (flags.has('--json')) {
    console.log(JSON.stringify(result.rows, null, 2));
    return result;
  }

  const isSold = src.kind === 'sold';
  console.log(`  ${pad('價錢', 10)} ${pad(isSold ? '成交日期' : '賣法', 20)} 標題`);
  console.log('  ' + '─'.repeat(76));
  for (const r of result.rows.slice(0, 20)) {
    const mid = isSold
      ? (r.soldAt ? r.soldAt.slice(0, 10) + (r.soldAtExact ? '' : '（估）') : '冇日期（估）')
      : (r.listingKind === 'auction' ? `競投中${r.endsAt ? ' ' + r.endsAt : ''}`
        : r.listingKind === 'auction_bin' ? `即決 ${yen(r.buyoutPrice)}` : (r.condition || '定價'));
    console.log(`  ${pad(yen(r.price), 10)} ${pad(mid, 20)} ${String(r.title).slice(0, 44)}`);
  }
  if (result.rows.length > 20) console.log(`  …仲有 ${result.rows.length - 20} 件`);

  if (isSold) {
    const s = summarize(result.rows.filter(r => r.price != null));
    if (s) {
      console.log(`\n  📊 統計（IQR 剪走 ${s.trimmed} 件極端值後）：`);
      console.log(`     n=${s.n}　P25 ${yen(s.p25)}　中位 ${yen(s.p50)}　P75 ${yen(s.p75)}　範圍 ${yen(s.min)}–${yen(s.max)}`);
      console.log(`     ↳ 自己去個站睇下呢個中位數合唔合理，唔合理即係 selector 撈錯咗嘢。`);
    }
  }
  return result;
}

// --verdict：抓成交 + 抓新貨 → 行真正嘅判斷邏輯，全程唔寫 DB
async function probeVerdict(keyword) {
  console.log(`\n═══ 成交價收集（比價基準）═══`);
  const comps = [];
  for (const src of SOLD_SOURCES) {
    const r = await probeOne(src, keyword);
    for (const row of r.rows) {
      if (row.price == null) continue;
      comps.push({
        price: row.price, source: src.id, title: row.title,
        norm_title: normalizeTitle(row.title),
        sold_at: row.soldAt || new Date().toISOString(),
      });
    }
  }
  console.log(`\n→ 一共收到 ${comps.length} 件成交紀錄`);
  if (comps.length < 5) {
    console.log('   ⚠️ 少過 5 件，所有判斷都會係「樣本不足」。放寬啲關鍵字再試。');
  }

  console.log(`\n═══ 新上架 + 抵買判斷 ═══`);
  const watch = { keyword, comp_keyword: null };
  for (const src of LISTING_SOURCES) {
    const r = await probeOne(src, keyword, { limit: 10 });
    for (const row of r.rows.slice(0, 5)) {
      const listing = {
        source: src.id, listing_kind: row.listingKind, title: row.title,
        price: row.price, buyout_price: row.buyoutPrice,
      };
      const v = judge(listing, comps, watch, { windowDays: WINDOW_DAYS });
      console.log(`\n  ▸ ${String(row.title).slice(0, 56)}`);
      console.log(`    ${yen(row.price)}${row.buyoutPrice ? ` / 即決 ${yen(row.buyoutPrice)}` : ''}  → [${v.verdict}] basis=${v.basis}`);
      for (const line of v.lines) console.log(`    ${line}`);
    }
  }
}

async function main() {
  if (!positional.length && !flags.has('--all') && !flags.has('--verdict')) { usage(); process.exit(1); }

  const keyword = positional[positional.length - 1];
  if (!keyword) { usage(); process.exit(1); }

  // --save-html：純粹幫你手動 debug，直接落 fetch 唔經 source 模組
  if (saveHtmlPath) {
    const srcId = positional[0];
    const { fetchWithUA } = await import('./sources/util.js');
    const urls = {
      'yahoo-auction': `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(keyword)}&s1=new&o1=d&n=50`,
      'yahoo-closed': `https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=${encodeURIComponent(keyword)}&n=50`,
      surugaya: `https://www.suruga-ya.jp/search?search_word=${encodeURIComponent(keyword)}&inStock=On`,
    };
    if (urls[srcId]) {
      const res = await fetchWithUA(urls[srcId]);
      const html = await res.text();
      fs.writeFileSync(saveHtmlPath, html);
      console.log(`[probe] HTTP ${res.status}・${html.length} bytes → 存咗落 ${saveHtmlPath}`);
    } else if (srcId?.startsWith('mercari')) {
      const { withPage } = await import('./sources/browser.js');
      const status = srcId === 'mercari-sold' ? 'sold_out' : 'on_sale';
      const html = await withPage(async page => {
        await page.goto(`https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&status=${status}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        return page.content();
      });
      fs.writeFileSync(saveHtmlPath, html);
      console.log(`[probe] ${html.length} bytes → 存咗落 ${saveHtmlPath}`);
    } else {
      console.log(`[probe] --save-html 要指定來源：${Object.keys(urls).join('、')}、mercari、mercari-sold`);
    }
    return;
  }

  if (flags.has('--verdict')) return probeVerdict(keyword);

  if (flags.has('--all')) {
    for (const src of ALL_SOURCES) await probeOne(src, keyword);
    return;
  }

  const src = byId[positional[0]];
  if (!src) { console.error(`唔識來源「${positional[0]}」`); usage(); process.exit(1); }
  await probeOne(src, keyword);
}

main()
  .catch(err => { console.error('[probe] 出錯：', err); process.exitCode = 1; })
  .finally(() => closeBrowser());
