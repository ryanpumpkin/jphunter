// Parser 測試：用人手砌嘅假 HTML 餵入去，驗證每層 selector 抽得啱嘢。
//   node server/sources/parsers.test.js
//
// ⚠️ 呢個測試證明「parser 邏輯啱」，唔證明「selector 對得上真網站」——
//    真網站嗰邊要用 probe.js 喺通網嘅機器度驗（見 README）。
//    但佢至少保證改 parser 嗰陣唔會靜靜雞整爛咗抽價／抽即決／抽日期嘅邏輯。
import assert from 'node:assert/strict';
import * as yahooAuction from './yahoo-auction.js';
import * as yahooClosed from './yahoo-closed.js';
import * as surugaya from './surugaya.js';
import { EXTRACT } from './mercari.js';
import { withPage, closeBrowser } from './browser.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
};

console.log('\n── Yahoo!拍賣（在賣）──');

t('tier2：.Product 抽到標題／現價／即決價', () => {
  const html = `<ul>
    <li class="Product">
      <a class="Product__titleLink" href="https://page.auctions.yahoo.co.jp/jp/auction/x1111?foo=1">青木陽菜 直筆サイン入りチェキ</a>
      <span class="Product__priceValue">3,800円</span>
      <span class="Product__priceValue--buyPrice">即決 5,000円</span>
      <span class="Product__bid">3</span>
      <span class="Product__time">2日</span>
    </li>
    <li class="Product">
      <a class="Product__titleLink" href="https://page.auctions.yahoo.co.jp/jp/auction/x2222">青木陽菜 生写真</a>
      <span class="Product__priceValue">1,200円</span>
    </li>
  </ul>`;
  const { rows, tier } = yahooAuction.parseHtml(html);
  assert.equal(rows.length, 2, `拎到 ${rows.length} 件`);
  assert.match(tier, /tier2/);
  assert.equal(rows[0].title, '青木陽菜 直筆サイン入りチェキ');
  assert.equal(rows[0].price, 3800);
  assert.equal(rows[0].buyoutPrice, 5000);
  assert.equal(rows[0].listingKind, 'auction_bin', '有即決價就係 auction_bin');
  assert.ok(!rows[0].url.includes('foo=1'), 'tracking/query 應該剷走');
});

t('★ 冇即決價 → listingKind=auction（判斷時唔可以當成交價）', () => {
  const html = `<li class="Product">
    <a class="Product__titleLink" href="https://page.auctions.yahoo.co.jp/jp/auction/y1">青木陽菜 直筆サイン</a>
    <span class="Product__priceValue">100円</span>
  </li>`;
  const { rows } = yahooAuction.parseHtml(html);
  assert.equal(rows[0].listingKind, 'auction');
  assert.equal(rows[0].buyoutPrice, null);
});

t('tier1：__NEXT_DATA__ 內嵌 JSON 優先', () => {
  const data = { props: { pageProps: { items: [
    { auctionId: 'k1123456789', title: '青木陽菜 直筆色紙', price: '4500', bidorbuy: '8000', bids: 2 },
  ] } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
  const { rows, tier } = yahooAuction.parseHtml(html);
  assert.match(tier, /tier1/);
  assert.equal(rows[0].title, '青木陽菜 直筆色紙');
  assert.equal(rows[0].price, 4500);
  assert.equal(rows[0].buyoutPrice, 8000);
  assert.ok(rows[0].url.endsWith('/k1123456789'));
});

t('tier4：class 全部改晒都仲捉到（掃街後備）', () => {
  const html = `<div><div class="totally-new-layout">
    <a href="https://page.auctions.yahoo.co.jp/jp/auction/z777">青木陽菜 直筆サイン</a>
    <span>2,500円</span>
  </div></div>`;
  const { rows, tier } = yahooAuction.parseHtml(html);
  assert.ok(rows.length >= 1, '掃街層應該捉到');
  assert.match(tier, /tier4/);
  assert.equal(rows[0].price, 2500);
});

t('完全唔啱嘅 HTML → 0 件 + 逐層診斷', () => {
  const { rows, tier, diag } = yahooAuction.parseHtml('<html><body>冇貨</body></html>');
  assert.equal(rows.length, 0);
  assert.equal(tier, null);
  assert.equal(diag.length, 4, '四層都要留低診斷俾人睇');
});

console.log('\n── Yahoo!落札相場（成交價）──');

t('抽到落札価格同落札日期', () => {
  const html = `<li class="Product">
    <a class="Product__titleLink" href="https://page.auctions.yahoo.co.jp/jp/auction/c555">青木陽菜 直筆サイン入りチェキ</a>
    <span class="Product__priceValue">5,200円</span>
    <span class="Product__time">7/15 22:05</span>
  </li>`;
  const { rows } = yahooClosed.parseHtml(html);
  assert.equal(rows[0].price, 5200);
  assert.equal(rows[0].soldAtExact, 1, '有日期就要標明係準確嘅');
  assert.ok(rows[0].soldAt.startsWith('20'), `拎到 ${rows[0].soldAt}`);
});

t('冇價嘅成交紀錄唔要（冇價嘅 comp 冇用）', () => {
  const html = `<li class="Product">
    <a class="Product__titleLink" href="https://page.auctions.yahoo.co.jp/jp/auction/c666">青木陽菜</a>
    <span class="Product__time">7/15 22:05</span>
  </li>`;
  const { rows } = yahooClosed.parseHtml(html);
  assert.equal(rows.length, 0);
});

console.log('\n── 駿河屋 ──');

t('中古／新品兩個價 → 取有貨嗰個較平者，兼記低 condition', () => {
  const html = `<div class="item_box">
    <a href="/product/detail/123456" title="青木陽菜 直筆サイン色紙">青木陽菜 直筆サイン色紙</a>
    <p>新品：￥8,000　中古：￥5,500</p>
  </div>`;
  const { rows } = surugaya.parseHtml(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 5500);
  assert.equal(rows[0].condition, '中古');
  assert.equal(rows[0].listingKind, 'buynow', '駿河屋係定價舖，冇拍賣陷阱');
  assert.ok(rows[0].url.startsWith('https://www.suruga-ya.jp/'), `相對路徑要補返 host，拎到 ${rows[0].url}`);
});

t('品切れ（冇貨）要跳過——買唔到就唔好推', () => {
  const html = `<div class="item_box">
    <a href="/product/detail/999" title="青木陽菜 直筆">青木陽菜 直筆</a>
    <p>中古：￥5,500 品切れ</p>
  </div>`;
  const { rows } = surugaya.parseHtml(html);
  assert.equal(rows.length, 0);
});

console.log('\n── Mercari（喺真 Chromium 度跑）──');

await ta('shadow DOM 攞唔到字時，靠 aria-label 後備抽到標題同價', async () => {
  const html = `<ul>
    <li data-testid="item-cell">
      <a href="https://jp.mercari.com/item/m111?afid=9" aria-label="青木陽菜 直筆サイン入りチェキ ¥3,800">
        <mer-item-thumbnail></mer-item-thumbnail>
      </a>
    </li>
    <li data-testid="item-cell">
      <a href="https://jp.mercari.com/item/m222" aria-label="青木陽菜 生写真 3枚 ¥1,200"></a>
    </li>
  </ul>`;
  const out = await withPage(async page => {
    await page.setContent(html);
    return page.evaluate(EXTRACT);
  });
  assert.equal(out.rows.length, 2, `拎到 ${out.rows.length} 件：${JSON.stringify(out.diag)}`);
  assert.match(out.tier, /tier1/);
  assert.equal(out.rows[0].title, '青木陽菜 直筆サイン入りチェキ', '個價要由標題尾剷走');
  assert.equal(out.rows[0].price, 3800);
});

await ta('有 data-testid=price 就用返個 element 個價', async () => {
  const html = `<li data-testid="item-cell">
    <a href="https://jp.mercari.com/item/m333" aria-label="青木陽菜 直筆サイン"></a>
    <span data-testid="price">4,500</span>
  </li>`;
  const out = await withPage(async page => {
    await page.setContent(html);
    return page.evaluate(EXTRACT);
  });
  assert.equal(out.rows[0].price, 4500);
});

await ta('item-cell 全部消失 → 跌落 tier3 掃 a[href*=/item/]', async () => {
  const html = `<div><div class="brand-new-class">
    <a href="https://jp.mercari.com/item/m444">青木陽菜 直筆サイン</a>
    <span>2,900円</span>
  </div></div>`;
  const out = await withPage(async page => {
    await page.setContent(html);
    return page.evaluate(EXTRACT);
  });
  assert.ok(out.rows.length >= 1, `掃街層應該捉到：${JSON.stringify(out.diag)}`);
  assert.match(out.tier, /tier3/);
});

await closeBrowser();
console.log(`\n${process.exitCode ? '✗ 有測試失敗' : `✓ 全部 ${pass} 個測試通過`}\n`);
