// Yahoo!オークション 落札相場（★ 成交價主力來源）。
// closedsearch 保留過去約 120 日嘅真實落札紀錄——有價、有落札日期，
// 係成個「抵唔抵」判斷最硬淨嘅數據。
//
// ⚠️ 已知風險：Yahoo 幾次改過 closedsearch 嘅存取限制，有機會要登入／Premium。
//    如果 probe 見到被 redirect 去登入頁，會回 status:'login'，
//    ingest 嗰邊會照跑 Mercari SOLD 頂住（樣本會少啲兼冇準確日期）。
import * as cheerio from 'cheerio';
import { fetchWithUA, httpReason, errReason, cleanText, parseYen, parseJpDate, normalizeKey } from './util.js';
import { paced, noteOk, noteBlocked, cooldownLeft } from './pace.js';

export const id = 'yahoo-closed';
export const label = 'Yahoo!落札相場';
export const kind = 'sold';
export const needsBrowser = false;

const searchUrl = (kw, page = 1) =>
  'https://auctions.yahoo.co.jp/closedsearch/closedsearch'
  + `?p=${encodeURIComponent(kw)}&va=${encodeURIComponent(kw)}`
  + `&n=50&b=${(page - 1) * 50 + 1}`;

// 落札頁同在賣頁結構好似，但個價係「落札価格」，兼多咗個「終了日時」。
function domTier($, rootSel, linkSel) {
  const out = [];
  $(rootSel).each((_, el) => {
    const $p = $(el);
    const $link = $p.find(linkSel).first();
    const title = cleanText($link.text());
    const href = ($link.attr('href') || '').split('?')[0];
    if (!title || !href || !/\/auction\//.test(href)) return;

    const price = parseYen($p.find('.Product__priceValue').first().text())
      ?? parseYen($p.find('[class*=priceValue]').first().text())
      ?? parseYen(cleanText($p.text()));
    if (price == null) return;   // 冇價嘅成交紀錄冇用

    // 終了日時：可能係 .Product__time / [class*=Time]，格式「1/23 22:05」（冇年份！）
    const dateText = cleanText($p.find('.Product__time, [class*=Time], [class*=time], .Product__otherInfo').first().text());
    const soldAt = parseJpDate(dateText);

    out.push({
      itemKey: normalizeKey(href),
      title,
      url: normalizeKey(href),
      price,
      soldAt,                     // null = parse 唔到日期，ingest 會用「而家」頂
      soldAtExact: soldAt ? 1 : 0,
      rawDate: dateText || null,
    });
  });
  return out.length ? out : null;
}

// 由一段自由文字入面抽出「似落札日期」嗰嚿。
// Yahoo 落札相場個終了日時多數係「1/23 22:05」（冇年份），亦見過「2025年1月23日」。
// ★ 剪返一小段畀 parseJpDate，唔好成段長文字掉俾佢——否則佢會撈到標題入面
//   啲無關數字（例如「MyGO!!!!! 2024夏」）當日期。
const JP_DATE_RE = /(\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?(\s*\d{1,2}:\d{2})?|\d{1,2}[月/]\d{1,2}日?\s*\d{1,2}:\d{2})/;
function matchJpDateText(text) {
  return (text.match(JP_DATE_RE) || [])[0] || null;
}

function tier4($) {
  const out = [];
  const seen = new Set();
  $('a[href*="/jp/auction/"]').each((_, a) => {
    const $a = $(a);
    const href = ($a.attr('href') || '').split('?')[0];
    const title = cleanText($a.text());
    if (!href || title.length < 4 || seen.has(href)) return;
    // 爬上去搵價，順手喺同一段文字度搵埋落札日期。
    // ★ 以前呢層寫死 soldAt: null——但落札相場最大價值就係佢有真實成交日期，
    //   冇咗就全部 fallback 做「首次見到」，個 90 日窗頭三個月係假嘅。
    //   個日期同個價通常喺同一張卡入面，所以爬到邊搵到邊。
    let price = null, rawDate = null, $node = $a;
    for (let i = 0; i < 5 && (price == null || rawDate == null); i++) {
      $node = $node.parent();
      if (!$node.length) break;
      const text = cleanText($node.text());
      if (price == null) price = parseYen(text);
      if (rawDate == null) rawDate = matchJpDateText(text);
    }
    if (price == null) return;
    const soldAt = parseJpDate(rawDate);
    seen.add(href);
    out.push({
      itemKey: normalizeKey(href), title, url: normalizeKey(href), price,
      soldAt, soldAtExact: soldAt ? 1 : 0, rawDate,
    });
  });
  return out.length ? out : null;
}

const TIERS = [
  ['tier1 li.Product + .Product__titleLink', $ => domTier($, 'li.Product, .Product', '.Product__titleLink')],
  ['tier2 [class*=Product] + a[href*=/auction/]', $ => domTier($, '[class*="Product"]', 'a[href*="/auction/"]')],
  ['tier3 a[href*=/jp/auction/] 掃街', $ => tier4($)],
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

// 落札相場一次攞多幾頁——成交紀錄係比價基準，樣本越多個中位數越穩。
// 12 個鐘先跑一次，3 頁 × 50 件唔算狼。
export async function search(keyword, { limit = 150, pages = 3 } = {}) {
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

    // 被踢去登入頁：唔算「改咗版」，要分開講清楚，否則你會白白改半日 selector
    if (/login\.yahoo\.co\.jp|ログイン(が必要|してください)|Yahoo! JAPAN ID でログイン/.test(html)) {
      return {
        rows, tier, status: 'login',
        diag: ['落札相場要求登入 Yahoo! JAPAN ID——呢個來源暫時用唔到，成交價會淨靠 Mercari SOLD'],
      };
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
