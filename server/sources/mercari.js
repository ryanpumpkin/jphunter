// Mercari 煤爐（日本最大二手平台）：SPA + 反爬蟲勁，要 Playwright。
// 呢個檔同時 export 「在賣」同「已售出」兩個 mode——兩者頁面結構一模一樣，
// 只係 status query 唔同，冇理由抄兩次 parser。
//
// ⚠️ 刻意唔用 Mercari 內部 API（api.mercari.jp/v2/entities:search）：
//    要 DPoP 簽名、條款風險高、一改就死。寧願用公開頁面慢慢爬。
import { withPage } from './browser.js';
import { normalizeKey, cleanText, errReason } from './util.js';
import { paced, noteOk, noteBlocked, cooldownLeft } from './pace.js';

const BASE = 'https://jp.mercari.com/search';

// 頁面入面攞貨嘅 evaluate function（在賣／已售出共用）。
// ★ Mercari 用 web component（mer-item-thumbnail）有 shadow DOM，
//   普通 querySelectorAll 攞唔到入面啲字——所以後備要讀 a 嘅 aria-label，
//   佢歷來放住完整標題連價錢。
// export 出嚟俾 parsers.test.js 用（喺真 Chromium 度餵假 HTML 跑一次）
export const EXTRACT = () => {
  const tiers = [
    ['tier1 li[data-testid=item-cell]', 'li[data-testid="item-cell"]'],
    ['tier2 [data-testid=item-cell]', '[data-testid="item-cell"]'],
    ['tier3 a[href*="/item/"] 掃街', 'a[href*="/item/"]'],
  ];
  // bare=true：專用價格 element 入面淨係得個數字（冇 ¥ 冇 円）都當價收。
  // 喺自由文字度就唔可以咁——會將「3枚セット」嘅 3 當成 ¥3。
  const yen = (s, bare = false) => {
    if (!s) return null;
    const norm = String(s).replace(/[０-９，]/g, c => c === '，' ? ',' : String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    let m = norm.match(/([\d,]+)\s*円|[¥￥]\s*([\d,]+)/);
    if (!m && bare) m = norm.match(/^\s*([\d,]{2,})\s*$/);
    if (!m) return null;
    const n = parseInt((m[1] || m[2] || '').replace(/,/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const diag = [];
  for (const [name, sel] of tiers) {
    const nodes = [...document.querySelectorAll(sel)];
    if (!nodes.length) { diag.push(`${name}：0 個節點`); continue; }
    const rows = [];
    const seen = new Set();
    for (const node of nodes) {
      const a = node.matches('a') ? node : node.querySelector('a[href*="/item/"]');
      if (!a) continue;
      const href = a.href.split('?')[0];
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const aria = a.getAttribute('aria-label') || '';
      const cell = node.textContent.replace(/\s+/g, ' ').trim();
      // ★ 帶價嗰個 aria-label 唔喺 <a> 身上，喺入面嗰個 thumbnail div：
      //     <a href="/item/xxx"><div class="merItemThumbnail" role="img"
      //        aria-label="<標題>の画像 2,222円 HK$115.21">
      //   IP 喺日本以外，Mercari 會喺日圓後面補個換算幣值（HK$／US$…），
      //   但日圓一直都喺度。淨係讀 <a> 就會攞到隔籬個「…のサムネイル」——
      //   冇價，標題仲拖住條尾。所以優先搵含「円」嗰個。
      const thumbAria = node.querySelector('[aria-label*="円"]')?.getAttribute('aria-label') || '';
      // 標題：優先 aria-label（shadow DOM 都攞到），冇就用 cell 文字
      const priceEl = node.querySelector('[data-testid="price"], .merPrice, [class*="price"]');
      const price = yen(priceEl?.textContent, true) ?? yen(aria) ?? yen(thumbAria) ?? yen(cell);
      let title = aria || thumbAria || cell;
      // thumbnail 個 aria-label 係「<標題>の画像 2,222円 HK$115.21」，由「の画像」起斬走。
      // 已售出頁會喺中間多個「売り切れ」：「…の画像 売り切れ 2,580円 HK$…」。
      // 要求「の画像」之後跟住價錢先斬，唔係淨係見到「の画像」就斬——
      // 貨品標題本身係有可能出現呢三個字嘅。
      title = title.replace(/の画像\s*(?:売り切れ\s*)?[\d,]+\s*円.*$/, '').trim();
      // cell 後備嗰陣會撈到「<標題>のサムネイル…」，一樣斬走
      title = title.replace(/のサムネイル.*$/, '').trim();
      // aria-label 通常係「<標題> ¥1,234」，剷走尾嗰個價
      title = title.replace(/[¥￥]?\s*[\d,]+\s*円?\s*$/, '').trim().slice(0, 160);
      if (!title) continue;
      rows.push({ href, title, price });
    }
    if (rows.length) return { rows, tier: name, diag };
    diag.push(`${name}：搵到 ${nodes.length} 個節點但 parse 唔到嘢`);
  }
  return { rows: [], tier: null, diag };
};

// 反爬蟲／人機驗證嘅招牌字眼
const BLOCK_RE = /Access Denied|ご迷惑をおかけ|しばらく時間をおいて|アクセスが制限|captcha|セキュリティ上の理由/i;

async function run(sourceId, keyword, { limit, status }) {
  const cd = cooldownLeft(sourceId);
  if (cd > 0) return { rows: [], tier: null, status: 'cooldown', diag: [`冷卻中，仲有 ${Math.round(cd / 60000)} 分鐘`] };

  const url = `${BASE}?keyword=${encodeURIComponent(keyword)}&status=${status}&sort=created_time&order=desc`;

  try {
    // hardMs 要留夠位：最壞情況 goto 45s + waitForSelector 40s + waitForTimeout 2s
    // ＝ 87s，用 withPage 預設嘅 90s 會啱啱好撞穿條硬牆，變成明明就快撈到都畀
    // 強制放棄。留到 120s。
    const result = await paced(sourceId, () => withPage(async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // ★ 20s 唔夠——Mercari 間歇性 render 得慢，實測 22.9s 嗰次就撞穿咗，
      //   三層 selector 全部 0 個節點，但個站根本冇改版（前後幾次 8–14s 就撈到）。
      //   撞穿之後要記住，唔好靜靜雞當「個站冇貨」——真‧冇貨同等唔切
      //   要分開報，唔係 probe 會叫你去改一啲根本冇壞嘅 selector。
      let waitedOut = false;
      await page.waitForSelector('li[data-testid="item-cell"], [data-testid="item-cell"], a[href*="/item/"]', { timeout: 40000 })
        .catch(() => { waitedOut = true; });
      await page.waitForTimeout(2000);
      const body = await page.evaluate(() => document.body.innerText.slice(0, 3000));
      const extracted = await page.evaluate(EXTRACT);
      return { ...extracted, body, waitedOut };
    }, { hardMs: 120000 }));

    if (!result.rows.length && BLOCK_RE.test(result.body || '')) {
      const ms = noteBlocked(sourceId);
      return { rows: [], tier: null, status: 'blocked', diag: [`Mercari 反爬蟲擋咗，冷卻 ${Math.round(ms / 60000)} 分鐘`, ...result.diag] };
    }

    const rows = result.rows.slice(0, limit).map(r => ({
      itemKey: normalizeKey(r.href),
      title: cleanText(r.title),
      url: normalizeKey(r.href),
      price: r.price,
      // Mercari 全部一口價，冇拍賣
      listingKind: 'buynow',
      buyoutPrice: null, bids: null, endsAt: null,
      // ★ SOLD 頁完全冇顯示賣出日期。soldAt 交畀 ingest 用「首次見到」頂，
      //   配合 DB 嗰邊 INSERT OR IGNORE，重複 harvest 唔會刷新日期，
      //   件貨會自然老化出 90 日窗，唔會永遠賴住喺「最近成交」度。
      soldAt: null,
      soldAtExact: 0,
    }));

    if (rows.length) noteOk(sourceId);
    // 等唔切 → 'timeout'（個站慢／SPA 未 render 完），唔係 'empty'（真係搵唔到貨）
    const emptyStatus = result.waitedOut ? 'timeout' : 'empty';
    return { rows, tier: result.tier, status: rows.length ? 'ok' : emptyStatus, diag: result.diag };
  } catch (err) {
    return { rows: [], tier: null, status: 'error', diag: [errReason(err)] };
  }
}

// ── 在賣（新上架）──
export const id = 'mercari';
export const label = 'Mercari';
export const kind = 'listing';
export const needsBrowser = true;
export const search = (keyword, { limit = 30 } = {}) => run(id, keyword, { limit, status: 'on_sale' });

// ── 已售出（成交價）──
export const sold = {
  id: 'mercari-sold',
  label: 'Mercari 已售出',
  kind: 'sold',
  needsBrowser: true,
  search: (keyword, { limit = 120 } = {}) => run('mercari-sold', keyword, { limit, status: 'sold_out' }),
};
