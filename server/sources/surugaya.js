// 駿河屋（すルガヤ）：中古連鎖店，SSR HTML，定價貨——冇拍賣陷阱，直接可比。
//
// 注意：駿河屋同一件貨會列「新品：￥x」同「中古：￥y」兩個價。
// 攞有貨嗰個較平者，兼記低 condition——攞中古價去比一批新品成交價
// 會系統性偏平，所以要標明係邊個狀態，唔好靜靜雞當同一回事。
import * as cheerio from 'cheerio';
import { fetchWithUA, httpReason, errReason, cleanText, parseYen, normalizeKey } from './util.js';
import { paced, noteOk, noteBlocked, cooldownLeft } from './pace.js';

export const id = 'surugaya';
export const label = '駿河屋';
export const kind = 'listing';
export const needsBrowser = false;

const BASE = 'https://www.suruga-ya.jp';
// inStock=On = 只出有貨嘅；冇貨嘅列出嚟冇意思（買唔到，個價亦唔係成交價）
const searchUrl = kw =>
  `${BASE}/search?search_word=${encodeURIComponent(kw)}&searchbox=1&inStock=On`;

function domTier($, rootSel) {
  const out = [];
  const seen = new Set();
  $(rootSel).each((_, el) => {
    const $p = $(el);
    const $link = $p.find('a[href*="/product/detail/"], .title a, p.title a').first();
    let href = $link.attr('href');
    const title = cleanText($link.attr('title') || $link.text());
    if (!href || !title) return;
    if (href.startsWith('/')) href = BASE + href;
    href = normalizeKey(href.split('?')[0]);
    if (seen.has(href)) return;

    const text = cleanText($p.text());
    if (OUT_OF_STOCK_RE.test(text)) return;   // 買唔到就唔好推

    // 中古／新品兩個價
    const usedPrice = parseYen((text.match(/中古[^\d¥￥]{0,6}([\d,]+\s*円|[¥￥]\s*[\d,]+)/) || [])[1]);
    const newPrice = parseYen((text.match(/新品[^\d¥￥]{0,6}([\d,]+\s*円|[¥￥]\s*[\d,]+)/) || [])[1]);
    const generic = parseYen($p.find('.text-price, .price, [class*=price]').first().text()) ?? parseYen(text);

    let price = null, condition = null;
    const candidates = [[usedPrice, '中古'], [newPrice, '新品']].filter(([p]) => p != null);
    if (candidates.length) {
      candidates.sort((a, b) => a[0] - b[0]);      // 有得揀就取平嗰個
      [price, condition] = candidates[0];
    } else {
      price = generic;
    }
    if (price == null) return;

    seen.add(href);
    out.push({
      itemKey: href, title, url: href, price,
      listingKind: 'buynow', buyoutPrice: null, bids: null, endsAt: null, condition,
    });
  });
  return out.length ? out : null;
}

// 冇貨嘅唔好推（買唔到，個叫價亦唔代表咩）。
// ★ 呢個 check 三層都要做——之前淨係喺卡片層做，結果卡片層剔走咗之後
//   跌落掃街層又原封不動撈返出嚟，等於冇剔過。
const OUT_OF_STOCK_RE = /品切れ|在庫なし|品切|売切/;

function tierAnchors($) {
  const out = [];
  const seen = new Set();
  $('a[href*="/product/detail/"]').each((_, a) => {
    const $a = $(a);
    let href = $a.attr('href') || '';
    if (href.startsWith('/')) href = BASE + href;
    href = normalizeKey(href.split('?')[0]);
    const title = cleanText($a.attr('title') || $a.text());
    if (!href || title.length < 3 || seen.has(href)) return;
    // 喺就近祖先度睇有冇「品切れ」字樣
    const around = cleanText($a.closest('div, li, td, article').text() || $a.parent().text());
    if (OUT_OF_STOCK_RE.test(around)) return;
    let price = null, $node = $a;
    for (let i = 0; i < 5 && price == null; i++) {
      $node = $node.parent();
      if (!$node.length) break;
      price = parseYen(cleanText($node.text()));
    }
    seen.add(href);
    out.push({ itemKey: href, title, url: href, price, listingKind: 'buynow', buyoutPrice: null, bids: null, endsAt: null, condition: null });
  });
  return out.length ? out : null;
}

const TIERS = [
  ['tier1 .item_box', $ => domTier($, '.item_box')],
  ['tier2 .item / .search_result_item', $ => domTier($, '.item, .search_result_item, [class*=item_]')],
  ['tier3 a[href*=/product/detail/] 掃街', $ => tierAnchors($)],
];

// 淨係 parse（唔使網絡）——俾 parsers.test.js 同 probe --save-html 用
export function parseHtml(html) {
  const $ = cheerio.load(html);
  const diag = [];
  for (const [name, fn] of TIERS) {
    let rows = null;
    try { rows = fn($); } catch (err) { diag.push(`${name}：拋錯 ${err.message}`); continue; }
    if (rows?.length) return { rows, tier: name, diag };
    diag.push(`${name}：0 件`);
  }
  return { rows: [], tier: null, diag };
}

export async function search(keyword, { limit = 30 } = {}) {
  const cd = cooldownLeft(id);
  if (cd > 0) return { rows: [], tier: null, status: 'cooldown', diag: [`冷卻中，仲有 ${Math.round(cd / 60000)} 分鐘`] };

  let html;
  try {
    const res = await paced(id, () => fetchWithUA(searchUrl(keyword)));
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        const ms = noteBlocked(id);
        return { rows: [], tier: null, status: 'blocked', diag: [`${httpReason(res)}——疑似俾人擋，冷卻 ${Math.round(ms / 60000)} 分鐘`] };
      }
      return { rows: [], tier: null, status: 'error', diag: [httpReason(res)] };
    }
    html = await res.text();
  } catch (err) {
    return { rows: [], tier: null, status: 'error', diag: [errReason(err)] };
  }

  const { rows, tier, diag } = parseHtml(html);
  const out = rows.slice(0, limit);
  if (out.length) noteOk(id);
  return { rows: out, tier, status: out.length ? 'ok' : 'empty', diag };
}
