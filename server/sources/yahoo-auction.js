// Yahoo!オークション 新上架（SSR HTML，普通 fetch + cheerio 就得，唔使 Playwright）。
//
// ★ selector 分層（tier）：由最穩試到最土炮，中咗邊層 probe.js 會印出嚟。
//   改版嗰陣你唔使睇成個檔——睇 probe 話你知邊層死咗，改嗰層就得。
//   tier1 內嵌 JSON：改版通常都會留返個 __NEXT_DATA__，最耐用
//   tier2 結構化 class：正常情況下用緊呢層
//   tier3 鬆啲嘅 class 前綴：Yahoo 改 class 名（加 hash 後綴）都仲捉到
//   tier4 錨點掃街：淨係靠 /auction/ 連結，最後防線
import * as cheerio from 'cheerio';
import { fetchWithUA, httpReason, errReason, cleanText, parseYen, normalizeKey } from './util.js';
import { paced, noteOk, noteBlocked, cooldownLeft } from './pace.js';

export const id = 'yahoo-auction';
export const label = 'Yahoo!拍賣';
export const kind = 'listing';
export const needsBrowser = false;

// s1=new&o1=d = 新着順（新上架排先）
const searchUrl = (kw, page = 1) =>
  'https://auctions.yahoo.co.jp/search/search'
  + `?p=${encodeURIComponent(kw)}&va=${encodeURIComponent(kw)}`
  + `&s1=new&o1=d&n=50&b=${(page - 1) * 50 + 1}`;

// ── tier 1：內嵌 JSON ──
function tier1($, html) {
  const raw = $('#__NEXT_DATA__').html()
    || (html.match(/<script[^>]*>\s*window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/) || [])[1];
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  // 唔知佢擺喺 JSON 邊一層（改版會搬），所以遞歸搵「似係商品」嘅 object
  const out = [];
  const seen = new Set();
  (function walk(node, depth) {
    if (!node || depth > 12 || out.length > 200) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node !== 'object') return;
    const aucId = node.auctionId || node.aID || node.id;
    const title = node.title || node.name;
    if (typeof aucId === 'string' && /^[a-z]\d{4,}$/i.test(aucId) && typeof title === 'string' && title) {
      if (!seen.has(aucId)) {
        seen.add(aucId);
        out.push({
          itemKey: `https://page.auctions.yahoo.co.jp/jp/auction/${aucId}`,
          title: cleanText(title),
          url: `https://page.auctions.yahoo.co.jp/jp/auction/${aucId}`,
          price: num(node.price ?? node.currentPrice ?? node.bidOrBuy?.current),
          buyoutPrice: num(node.bidorbuy ?? node.buyNowPrice ?? node.bidOrBuyPrice),
          bids: num(node.bids ?? node.bidCount),
          endsAt: node.endTime || node.endDate || null,
        });
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  })(data, 0);
  return out.length ? out : null;
}
const num = v => {
  const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : v;
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ── tier 2/3：DOM class ──
function domTier($, rootSel, linkSel) {
  const out = [];
  $(rootSel).each((_, el) => {
    const $p = $(el);
    const $link = $p.find(linkSel).first();
    const title = cleanText($link.text());
    const href = $link.attr('href');
    if (!title || !href || !/\/auction\//.test(href)) return;

    // 現価 vs 即決価：Yahoo 兩個價都喺同一格，靠 class 或者「即決」字樣分
    const price = parseYen($p.find('.Product__priceValue').not('[class*=buy]').first().text())
      ?? parseYen($p.find('[class*=priceValue]').first().text());
    let buyout = parseYen($p.find('[class*=priceValue][class*=buy], .Product__priceValue--buyPrice').first().text());
    if (buyout == null) {
      // 後備：搵含「即決」嘅價格文字
      $p.find('*').each((_, n) => {
        const txt = cleanText($(n).text());
        if (buyout == null && /即決/.test(txt) && txt.length < 40) buyout = parseYen(txt);
      });
    }
    const bids = num(cleanText($p.find('[class*=bid]').first().text()).replace(/[^\d]/g, ''));
    const endsAt = cleanText($p.find('[class*=Time], [class*=time]').first().text()) || null;

    out.push({
      itemKey: href.split('?')[0], title, url: href.split('?')[0],
      price, buyoutPrice: buyout, bids, endsAt,
    });
  });
  return out.length ? out : null;
}

// ── tier 4：錨點掃街 ──
function tier4($) {
  const out = [];
  const seen = new Set();
  $('a[href*="page.auctions.yahoo.co.jp/jp/auction/"], a[href*="/jp/auction/"]').each((_, a) => {
    const $a = $(a);
    const href = ($a.attr('href') || '').split('?')[0];
    const title = cleanText($a.text());
    if (!href || title.length < 4 || seen.has(href)) return;
    seen.add(href);
    // 喺最近嘅祖先入面搵個價
    let price = null;
    let $node = $a;
    for (let i = 0; i < 5 && price == null; i++) {
      $node = $node.parent();
      if (!$node.length) break;
      price = parseYen(cleanText($node.text()));
    }
    out.push({ itemKey: href, title, url: href, price, buyoutPrice: null, bids: null, endsAt: null });
  });
  return out.length ? out : null;
}

const TIERS = [
  ['tier1 __NEXT_DATA__ / PRELOADED_STATE', ($, html) => tier1($, html)],
  ['tier2 li.Product + .Product__titleLink', $ => domTier($, 'li.Product, .Product', '.Product__titleLink')],
  ['tier3 [class*=Product] + a[href*=/auction/]', $ => domTier($, '[class*="Product"]', 'a[href*="/auction/"]')],
  ['tier4 a[href*=/jp/auction/] 掃街', $ => tier4($)],
];

// 淨係 parse（唔使網絡）——俾 parsers.test.js 同 probe --save-html 用。
// 回傳 { rows, tier, diag }
export function parseHtml(html) {
  const $ = cheerio.load(html);
  const diag = [];
  for (const [name, fn] of TIERS) {
    let rows = null;
    try { rows = fn($, html); } catch (err) { diag.push(`${name}：拋錯 ${err.message}`); continue; }
    if (rows?.length) return { rows: finish(rows), tier: name, diag };
    diag.push(`${name}：0 件`);
  }
  return { rows: [], tier: null, diag };
}

// 收尾：正規化 key／URL，兼定 listingKind（有即決＝買得走，性質同定價一樣；
// 冇即決就係純競投，判斷時唔可以當佢個現價係成交價）
function finish(rows) {
  return rows
    .filter(r => r.title && r.url)
    .map(r => ({
      ...r,
      itemKey: normalizeKey(r.itemKey || r.url),
      url: normalizeKey(r.url),
      listingKind: r.buyoutPrice ? 'auction_bin' : 'auction',
    }));
}

// 純抓＋parse，唔掂 DB。回傳 { rows, tier, status, diag }
export async function search(keyword, { limit = 30, pages = 1 } = {}) {
  const cd = cooldownLeft(id);
  if (cd > 0) return { rows: [], tier: null, status: 'cooldown', diag: [`冷卻中，仲有 ${Math.round(cd / 60000)} 分鐘`] };

  const rows = [];
  const diag = [];
  let tier = null;
  let status = 'ok';

  for (let p = 1; p <= pages && rows.length < limit; p++) {
    const url = searchUrl(keyword, p);
    let html;
    try {
      const res = await paced(id, () => fetchWithUA(url));
      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          const ms = noteBlocked(id);
          return { rows, tier, status: 'blocked', diag: [`${httpReason(res)}——疑似俾人擋，冷卻 ${Math.round(ms / 60000)} 分鐘`] };
        }
        return { rows, tier, status: 'error', diag: [httpReason(res)] };
      }
      html = await res.text();
    } catch (err) {
      return { rows, tier, status: 'error', diag: [errReason(err)] };
    }

    const parsed = parseHtml(html);
    diag.push(...parsed.diag);
    if (!parsed.rows.length) { status = rows.length ? 'ok' : 'empty'; break; }
    tier = tier || parsed.tier;
    rows.push(...parsed.rows);
  }

  const out = rows.slice(0, limit);

  if (out.length) noteOk(id);
  return { rows: out, tier, status: out.length ? 'ok' : status, diag };
}
