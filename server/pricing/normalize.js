// 日文標題正規化 + 相似度。
// 冇用分詞器（kuromoji 成 20MB 兼要載字典），改用 CJK bigram——
// 呢個係人名／商品名比對嘅標準平價替代品，對「青木陽菜」呢類專有名詞夠準。

// 噪音字：出現喺一半標題度，完全冇分辨力，剷咗佢先比。
// ★ 唔可以剷嘅：直筆・サイン・生写真・チェキ・色紙・複製・印刷——
//   呢啲字直接決定件貨值幾錢，剷咗就會將 ¥300 印刷版當 ¥40,000 直筆版比。
const NOISE = /送料無料|送料込|匿名配送|らくらく|ゆうパケット|ネコポス|即決|新品|未開封|未使用|中古|美品|良品|激安|特価|大特価|セール|人気|限定品|まとめ売り|セット販売|プロフ必読|値下げ|値下|最安|即購入可|即購入OK|24時間以内発送|当日発送|翌日発送|匿名/g;
const BRACKETS = /[【】〔〕［］\[\]（）()「」『』《》〈〉]/g;
const SYMBOLS = /[★☆◆◇■□●○▲△▼※→←↑↓♪♡♥＊*!！?？~〜_＿|｜/／\\、,，.。:：;；'"“”‘’]/g;

export function normalizeTitle(s) {
  return String(s ?? '')
    .normalize('NFKC')            // 全角→半角、半角片假名→全角，統一先做
    .toLowerCase()
    .replace(BRACKETS, ' ')
    .replace(NOISE, ' ')
    .replace(SYMBOLS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// tokenize：ASCII/數字整段、片假名整段、平假名整段、漢字用 bigram。
// 漢字行 bigram 係因為日文冇空格：「青木陽菜直筆」要斬到
// 青木/木陽/陽菜/菜直/直筆，先至同「青木陽菜のサイン」對得上。
export function tokenize(norm) {
  const t = new Set();
  for (const m of norm.matchAll(/[a-z0-9]+/g)) t.add(m[0]);
  for (const m of norm.matchAll(/[ァ-ヶーｰ]{2,}/g)) t.add(m[0]);
  for (const m of norm.matchAll(/[぀-ゟ]{2,}/g)) t.add(m[0]);
  for (const m of norm.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    if (run.length <= 2) { t.add(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) t.add(run.slice(i, i + 2));
  }
  return t;
}

export const tokensOf = s => tokenize(normalizeTitle(s));

// Jaccard + containment 混合。
// 純 Jaccard 對「長標題 vs 短標題」罰得太重（賣家鍾意打一大堆 hashtag，
// 一件貨嘅標題可以係另一件嘅五倍長）；純 containment 又會令短標題咩都 match。
// 6:4 溝埋，兩邊嘅毛病都收得住。
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  if (!inter) return 0;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = inter / Math.min(a.size, b.size);
  return 0.6 * jaccard + 0.4 * containment;
}

// 排除字：空格／、／, 分隔，對 normalizeTitle 後嘅字串做 substring 比對。
// 回傳 true = 呢件貨要剔走。
export function excluded(title, excludeStr) {
  if (!excludeStr) return false;
  const hay = normalizeTitle(title);
  return String(excludeStr)
    .split(/[\s、,]+/)
    .map(w => normalizeTitle(w))
    .filter(Boolean)
    .some(w => hay.includes(w));
}

// 成交價 query 嘅 key（sold_comps.query）：同一條關鍵字唔同大小寫／全半角
// 都要撞返同一個 bucket，否則收咗嘅成交紀錄會散晒。
export const canonicalQuery = kw => normalizeTitle(kw).replace(/\s+/g, ' ');
