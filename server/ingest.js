// 中間層：sources 出嚟嘅 rows → 新舊 diff → 抵買判斷 → 寫 DB → 派通知。
// sources/* 係純抓取（唔掂 DB），呢度先係唯一會寫嘢同 send 嘢嘅地方。
import {
  isNewItem, seenAnyItem, insertListing, updateListingPrice, reportSourceHealth,
  insertComp, compsForQuery, compCount, reportCompRun,
  watchTouchRun, watchTouchComp, watchMarkPrimed,
} from './db.js';
import { LISTING_SOURCES, SOLD_SOURCES, byId } from './sources/index.js';
import { judge, WINDOW_DAYS, WIDE_WINDOW_DAYS } from './pricing/verdict.js';
import { normalizeTitle, canonicalQuery, excluded } from './pricing/normalize.js';
import { notifyListing, alertSystem } from './notify.js';

// 條 watch 收成交價用邊條 query（可以同搜新貨嗰條唔同：
// 新貨想窄啲準啲，成交價想闊啲夠樣本）
export const compQueryOf = w => canonicalQuery(w.comp_keyword?.trim() || w.keyword);

// 條 watch 開咗邊幾個新貨來源
export function sourcesFor(watch) {
  let want = null;
  try { want = watch.sources ? JSON.parse(watch.sources) : null; } catch { want = null; }
  return LISTING_SOURCES.filter(s => !want?.length || want.includes(s.id));
}

// ── 成交價收集 ──
// 12 個鐘一條 query，慢慢嚟。回傳收到幾多件新紀錄。
export async function harvestComps(watch) {
  const query = compQueryOf(watch);
  const searchWord = watch.comp_keyword?.trim() || watch.keyword;
  let added = 0, seen = 0;
  const errors = [];

  for (const src of SOLD_SOURCES) {
    let result;
    try {
      result = await src.search(searchWord);
    } catch (err) {
      errors.push(`${src.id}: ${err.message}`);
      continue;
    }
    seen += result.rows.length;

    if (result.status === 'login') {
      errors.push(`${src.id}: 要登入`);
    } else if (result.status === 'blocked') {
      errors.push(`${src.id}: 被擋`);
    } else if (result.status === 'error') {
      errors.push(`${src.id}: ${result.diag?.[0] || '失敗'}`);
    }

    for (const row of result.rows) {
      if (row.price == null) continue;
      if (excluded(row.title, watch.exclude)) continue;
      const res = insertComp.run({
        query,
        source: src.id,
        item_key: row.itemKey,
        title: row.title,
        norm_title: normalizeTitle(row.title),
        price: row.price,
        // Mercari SOLD 冇日期 → 用「而家」頂。因為 INSERT OR IGNORE，
        // 呢個日期只會喺首次見到嗰陣寫一次，之後重複 harvest 唔會刷新，
        // 所以件貨會正常老化出 90 日窗（見 db.js sold_comps 註解）。
        sold_at: row.soldAt || new Date().toISOString(),
        sold_at_exact: row.soldAtExact ?? 0,
        url: row.url,
      });
      if (res.changes > 0) added++;
    }
    // 來源健康以「來源」為單位記帳，唔係 per-watch（見 db.js 註解）
    reportSourceHealth(src.id, result.rows.length,
      result.status === 'ok' || result.status === 'empty' ? null : (result.diag?.[0] || result.status));
  }

  reportCompRun.run({
    query, now: new Date().toISOString(),
    ok: seen > 0 ? 1 : 0, rows: seen,
    error: errors.length ? errors.join('；') : null,
  });
  watchTouchComp.run(watch.id);

  console.log(`[comps] 「${searchWord}」收到 ${seen} 件（新 ${added} 件）${errors.length ? '｜' + errors.join('；') : ''}`);
  return { added, seen, errors };
}

// 攞比價用嘅成交紀錄。90 日樣本唔夠就放寬到 180 日。
export function compsFor(watch) {
  const query = compQueryOf(watch);
  const n90 = compCount.get({ query, since: `-${WINDOW_DAYS} days` })?.n ?? 0;
  const windowDays = n90 >= 5 ? WINDOW_DAYS : WIDE_WINDOW_DAYS;
  const rows = compsForQuery.all({ query, since: `-${windowDays} days` });
  return { rows, windowDays };
}

// 成交資料幾耐冇更新過——通知會標明，唔好扮個中位數好新鮮
function staleNote(watch) {
  if (!watch.last_comp_at) return '成交資料未收過，判斷僅供參考';
  const ageH = (Date.now() - Date.parse(watch.last_comp_at + 'Z')) / 3600_000;
  if (!Number.isFinite(ageH) || ageH < 36) return null;
  return `成交資料 ${Math.round(ageH / 24)} 日前更新`;
}

// ── 巡一條 watch 嘅新貨 ──
// primed=0（啱啱開）嗰一輪：只收錄唔通知，否則三個站 × 30 件會即刻洗你版。
export async function sweepWatch(watch) {
  const { rows: comps, windowDays } = compsFor(watch);
  const priming = !watch.primed;
  const note = staleNote(watch);
  let found = 0, notified = 0;
  const perSource = [];
  // 今轉有邊啲來源係第一次見（靜靜雞收錄咗，冇通知）——用嚟出返個交代
  const primedSources = [];

  for (const src of sourcesFor(watch)) {
    let result;
    try {
      result = await src.search(watch.keyword);
    } catch (err) {
      perSource.push({ id: src.id, n: 0, status: 'error', reason: err.message });
      continue;
    }
    perSource.push({ id: src.id, n: result.rows.length, status: result.status, reason: result.diag?.[0] || null });

    const snapKey = `w${watch.id}:${src.id}`;
    // ★ 靜默收錄要按「來源」計，唔可以淨係睇 watch.primed：
    //   條 watch 跑咗一排（primed=1）之後先加多個來源，嗰個來源成頁貨
    //   對 snapshots 嚟講全部係「未見過」，照推就即刻幾十條洗你版——
    //   同開新 watch 嗰個情況一模一樣，所以一樣要先靜靜雞收錄一輪。
    //   ⚠️ 一定要喺 row loop 之前 check，isNewItem() 會即刻寫低 snapshot。
    const srcPriming = priming || !seenAnyItem(snapKey);
    let srcAbsorbed = 0;

    for (const row of result.rows) {
      if (!row.url || row.price == null) continue;
      if (excluded(row.title, watch.exclude)) continue;

      if (!isNewItem(snapKey, row.itemKey)) {
        // 見過嘅貨：拍賣價會升，同步返個現價（feed 顯示用），但唔再通知
        if (row.price != null) updateListingPrice.run(row.price, watch.id, src.id, row.itemKey);
        continue;
      }
      found++;
      if (srcPriming) srcAbsorbed++;

      const listing = {
        source: src.id,
        listing_kind: row.listingKind,
        title: row.title,
        price: row.price,
        buyout_price: row.buyoutPrice ?? null,
      };
      const v = judge(listing, comps, watch, { windowDays });

      const res = insertListing.run({
        watch_id: watch.id,
        source: src.id,
        item_key: row.itemKey,
        listing_kind: row.listingKind,
        title: row.title,
        url: row.url,
        price: row.price ?? null,
        buyout_price: row.buyoutPrice ?? null,
        judged_price: v.judged_price ?? null,
        bids: row.bids ?? null,
        ends_at: row.endsAt ?? null,
        condition: row.condition ?? null,
        verdict: v.verdict,
        ratio: v.ratio ?? null,
        comp_n: v.n ?? null,
        comp_p25: v.p25 ?? null,
        comp_p50: v.p50 ?? null,
        comp_p75: v.p75 ?? null,
        comp_basis: v.basis ?? null,
        comp_window: v.window ?? null,
        notified: srcPriming ? 0 : 1,
      });

      if (res.changes > 0 && !srcPriming) {
        notified++;
        // 唔 await：通知隊列自己逐條慢慢送，唔好拖住抓取
        notifyListing({
          ...listing, ...row,
          keyword: watch.keyword,
          url: row.url,
          verdict: v.verdict,
          verdictLines: v.lines,
          staleNote: note,
          buyout_price: row.buyoutPrice ?? null,
          ends_at: row.endsAt ?? null,
        });
      }
    }

    // 淨係「事後加來源」先報——開新 watch 嗰個 case 下面有得講，唔好報兩次
    if (srcPriming && !priming && srcAbsorbed > 0) {
      primedSources.push({ id: src.id, n: srcAbsorbed });
    }
  }

  watchTouchRun.run(watch.id);
  if (priming) {
    watchMarkPrimed.run(watch.id);
    console.log(`[sweep] 「${watch.keyword}」首輪收錄 ${found} 件現有貨（唔通知），之後先算新上架`);
    if (found > 0) {
      alertSystem(`「${watch.keyword}」已開始監察：首輪收錄咗 ${found} 件現有貨（唔會補推），之後有新上架先通知你。`);
    }
  } else if (found) {
    console.log(`[sweep] 「${watch.keyword}」新貨 ${found} 件，推咗 ${notified} 條通知`);
  }

  for (const p of primedSources) {
    console.log(`[sweep] 「${watch.keyword}」新加來源 ${p.id}：收錄 ${p.n} 件現有貨（唔通知）`);
    alertSystem(`「${watch.keyword}」加咗來源 ${p.id}：收錄咗 ${p.n} 件現有貨（唔會補推），之後有新上架先通知你。`);
  }
  return { found, notified, priming, perSource };
}

// 一輪掃晒所有 enabled watch 之後，先以「來源」為單位記健康。
// ★ 唔可以 per-watch 記——一條冷門關鍵字搵到 0 件係天經地義，
//   per-watch 記帳會日日誤報「來源死咗」。
export function reportSweepHealth(perSourceTotals) {
  for (const [srcId, agg] of Object.entries(perSourceTotals)) {
    reportSourceHealth(srcId, agg.n, agg.n > 0 ? null : agg.reason);
  }
}
