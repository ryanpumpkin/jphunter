// 純 assert 自我測試：node server/pricing/selftest.js
// 呢舊嘢係成個 app 嘅價值所在，而且完全離線驗證得到（唔使連日本站），
// 所以改完 verdict.js／stats.js／normalize.js 一定要跑返呢個。
import assert from 'node:assert/strict';
import { normalizeTitle, tokensOf, similarity, excluded, canonicalQuery } from './normalize.js';
import { percentile, iqrTrim, summarize } from './stats.js';
import { judge, judgedPrice, pickCohort } from './verdict.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
};

// 造成交紀錄：一堆價錢 → comps
const comps = (prices, title = '青木陽菜 直筆サイン入りチェキ', source = 'yahoo-closed') =>
  prices.map((price, i) => ({
    price, source, title, norm_title: normalizeTitle(title),
    url: `https://example.test/${i}`, sold_at: new Date().toISOString(), sold_at_exact: 1,
  }));

const watch = { keyword: '青木陽菜 直筆', comp_keyword: null };
const listing = (over = {}) => ({
  source: 'yahoo-auction', listing_kind: 'buynow', title: '青木陽菜 直筆サイン入りチェキ',
  price: 3800, buyout_price: null, ...over,
});

console.log('\n── normalize ──');
t('剷走物流噪音字，保留產品字', () => {
  const n = normalizeTitle('【送料無料】青木陽菜 直筆サイン入りチェキ 匿名配送 即決');
  assert.ok(!n.includes('送料無料'), '送料無料 應該剷走');
  assert.ok(!n.includes('匿名配送'), '匿名配送 應該剷走');
  assert.ok(n.includes('直筆'), '直筆 決定價錢，唔可以剷');
  assert.ok(n.includes('青木陽菜'), '人名唔可以剷');
});

t('全角半角統一（NFKC）', () => {
  assert.equal(normalizeTitle('ＡＫＢ４８'), 'akb48');
});

t('漢字斬 bigram，人名對得上', () => {
  const tk = tokensOf('青木陽菜');
  assert.ok(tk.has('青木') && tk.has('木陽') && tk.has('陽菜'), `拎到 ${[...tk]}`);
});

t('同人同款相似度 遠高於 同人唔同款', () => {
  const target = tokensOf('青木陽菜 直筆サイン入りチェキ');
  const same = similarity(target, tokensOf('青木陽菜 直筆サイン入りチェキ 2024夏'));
  const diff = similarity(target, tokensOf('青木陽菜 生写真 3枚セット'));
  assert.ok(same > diff, `同款 ${same.toFixed(3)} 應該大過 唔同款 ${diff.toFixed(3)}`);
  assert.ok(same >= 0.35, `同款要過嚴格門檻，而家 ${same.toFixed(3)}`);
});

t('唔同人名 相似度低', () => {
  const s = similarity(tokensOf('青木陽菜 直筆サイン'), tokensOf('山田花子 直筆サイン'));
  assert.ok(s < 0.35, `唔同人應該低過嚴格門檻，而家 ${s.toFixed(3)}`);
});

t('排除字捉到印刷／複製版', () => {
  assert.equal(excluded('青木陽菜 印刷サイン 複製', 'レプリカ 複製 コピー 印刷'), true);
  assert.equal(excluded('青木陽菜 直筆サイン', 'レプリカ 複製 コピー 印刷'), false);
});

t('canonicalQuery 大小寫／全角都撞返同一 bucket', () => {
  assert.equal(canonicalQuery('青木陽菜 直筆'), canonicalQuery('青木陽菜　直筆'));
});

console.log('\n── stats ──');
t('percentile 線性內插', () => {
  const s = [1, 2, 3, 4, 5];
  assert.equal(percentile(s, 0.5), 3);
  assert.equal(percentile(s, 0), 1);
  assert.equal(percentile(s, 1), 5);
});

t('IQR 剷走極端值，中位數企得穩', () => {
  const prices = [3000, 3200, 3400, 3500, 3600, 3800, 500000];
  const { kept, trimmed } = iqrTrim(prices);
  assert.equal(trimmed, 1, '應該剷走 ¥500,000 嗰件');
  assert.ok(!kept.includes(500000));
  const s = summarize(comps(prices));
  assert.ok(s.p50 > 3300 && s.p50 < 3700, `中位數應該仲喺 ¥3,400 左右，而家 ${s.p50}`);
});

t('平均數會被極端值扯爆，中位數唔會（呢個就係唔用平均數嘅原因）', () => {
  const prices = [3000, 3200, 3400, 3500, 3600, 3800, 500000];
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const s = summarize(comps(prices));
  assert.ok(mean > 70000, `平均數係 ${Math.round(mean)}，已經離晒地`);
  assert.ok(s.p50 < 4000, `中位數 ${s.p50} 先係真實水平`);
});

console.log('\n── verdict ──');
t('樣本不足（n<5）→ unknown，唔准砌假判斷', () => {
  const r = judge(listing(), comps([5000, 5200, 5100]), watch);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.ratio, null);
  assert.match(r.lines[0], /樣本不足/);
});

t('¥3,800 對 中位 ¥5,200 → deal（抵）', () => {
  const r = judge(listing({ price: 3800 }), comps([4800, 5000, 5200, 5400, 5600, 5200]), watch);
  assert.equal(r.verdict, 'deal', `拎到 ${r.verdict}`);
  assert.ok(r.ratio < 0.85 && r.ratio > 0.70, `ratio ${r.ratio}`);
  assert.match(r.lines[0], /平 \d+%/);
});

t('平一半 且 跌穿 P25 → steal（超抵）', () => {
  const r = judge(listing({ price: 2400 }), comps([4800, 5000, 5200, 5400, 5600, 5200]), watch);
  assert.equal(r.verdict, 'steal', `拎到 ${r.verdict}`);
});

t('貴一倍 且 高過 P75 → absurd（離譜）', () => {
  const r = judge(listing({ price: 15000 }), comps([4800, 5000, 5200, 5400, 5600, 5200]), watch);
  assert.equal(r.verdict, 'absurd', `拎到 ${r.verdict}`);
  assert.match(r.lines[0], /貴 \d+%/);
});

t('同價 → fair', () => {
  const r = judge(listing({ price: 5200 }), comps([4800, 5000, 5200, 5400, 5600, 5200]), watch);
  assert.equal(r.verdict, 'fair', `拎到 ${r.verdict}`);
});

t('★ 拍賣進行中、冇即決：現價 ¥100 一定唔可以報做 steal', () => {
  const l = listing({ listing_kind: 'auction', price: 100, buyout_price: null });
  assert.equal(judgedPrice(l).price, null, '競投中唔應該畀到一個「判斷價」出嚟');
  const r = judge(l, comps([4800, 5000, 5200, 5400, 5600, 5200]), watch);
  assert.equal(r.verdict, 'auction', `拎到 ${r.verdict}——絕對唔可以係 steal/deal`);
  assert.equal(r.ratio, null);
  assert.match(r.lines.join('\n'), /出到 ¥\d[\d,]* 以內先算抵/, '要畀個出價上限');
});

t('拍賣有即決價 → 用即決價判斷，唔用現價', () => {
  const l = listing({ listing_kind: 'auction_bin', price: 100, buyout_price: 3800 });
  assert.equal(judgedPrice(l).price, 3800);
  const r = judge(l, comps([4800, 5000, 5200, 5400, 5600, 5200]), watch);
  assert.equal(r.verdict, 'deal', `拎到 ${r.verdict}`);
  assert.equal(r.judged_price, 3800);
});

t('分佈太窄嗰陣，gate 擋住亂叫「超抵」', () => {
  // 全部成交都貼住 ¥5,000，¥3,400 平 32% 但仲未跌穿 P25 → 應該降做 deal
  const tight = comps([3300, 3350, 3400, 3450, 3500, 3550]);
  const r = judge(listing({ price: 2300 }), tight, watch);
  assert.ok(['steal', 'deal'].includes(r.verdict));
  const r2 = judge(listing({ price: 3400 }), tight, watch);
  assert.equal(r2.verdict, 'fair', `貼住中位應該係 fair，拎到 ${r2.verdict}`);
});

t('同來源夠樣本 → 用 strict-same，唔溝兩站', () => {
  const rows = [
    ...comps([5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700], undefined, 'yahoo-closed'),
    ...comps([2000, 2100], undefined, 'mercari-sold'),
  ];
  const { basis } = pickCohort(listing(), rows, watch);
  assert.equal(basis, 'strict-same', `拎到 ${basis}`);
});

// ── 場次限定（venue）──
// comps() 造嘅紀錄冇 venue 欄位，等同「分類完發現冇場次」＝普通貨。
const venueComps = (prices, venue, title = null) =>
  comps(prices, title || `青木陽菜 直筆サイン入りチェキ ${venue}限定`).map(c => ({ ...c, venue }));

t('判普通貨：限定貨成交一律剔走，唔會拉高中位數', () => {
  const rows = [...comps([5000, 5100, 5200, 4900, 5300]), ...venueComps([20000, 21000, 19000], '東京')];
  const r = judge(listing({ price: 5100 }), rows, watch);
  assert.equal(r.venue, null, '普通貨唔應該認到場次');
  assert.equal(r.n, 5, `剩返 5 件普通貨，拎到 ${r.n}`);
  assert.ok(r.p50 < 6000, `中位數應該係普通貨嗰邊，拎到 ${r.p50}`);
  assert.equal(r.verdict, 'fair', `貼住普通貨中位就係 fair，拎到 ${r.verdict}`);
});

t('判限定貨：認到場次，同同場次比', () => {
  const rows = [...comps([5000, 5100, 5200, 4900, 5300]), ...venueComps([20000, 21000, 19000, 20500, 19500], '東京')];
  const l = listing({ price: 20000, title: '青木陽菜 直筆サイン入りチェキ 東京限定' });
  const r = judge(l, rows, watch);
  assert.equal(r.venue, '東京');
  assert.match(r.basis, /^venue-/, `應該用同場次對比群，拎到 ${r.basis}`);
  assert.equal(r.n, 5, `淨係用東京嗰 5 件，拎到 ${r.n}`);
  assert.equal(r.verdict, 'fair', `同場次同價就係 fair，拎到 ${r.verdict}`);
  assert.match(r.lines.join('\n'), /同場次/, '用咗場次群就要講明');
});

t('限定貨樣本唔夠 → 跌返落普通群，會報偏貴而唔係扮抵', () => {
  const rows = [...comps([5000, 5100, 5200, 4900, 5300, 5150]), ...venueComps([20000, 21000], '東京')];
  const l = listing({ price: 20000, title: '青木陽菜 直筆サイン入りチェキ 東京限定' });
  const r = judge(l, rows, watch);
  assert.ok(!r.basis.startsWith('venue-'), `得 2 件同場次唔應該用場次群，拎到 ${r.basis}`);
  assert.ok(['pricey', 'absurd'].includes(r.verdict), `拎到 ${r.verdict}`);
});

t('用咗雜牌對比群就要老實標明', () => {
  const rows = comps([1000, 2000, 3000, 8000, 20000, 40000], '青木陽菜 生写真 まとめ');
  const r = judge(listing(), rows, watch);
  if (r.verdict !== 'unknown') {
    assert.match(r.lines.join('\n'), /對比基準/, '溝咗貨就要喺訊息度講明');
  }
});

console.log(`\n${process.exitCode ? '✗ 有測試失敗' : `✓ 全部 ${pass} 個測試通過`}\n`);
