// 成交價統計。★ 一律用中位數同四分位，唔用平均數——
// 拍賣數據係重尾嘅：一件 ¥120,000 嘅簽名色紙可以將一堆 ¥3,000 生写真嘅平均數
// 扯到 ¥15,000，之後咩都變「好抵」。中位數對呢種極端值免疫。

export const MIN_SAMPLES = 5;   // 少過呢個數就唔落判斷，老實講「樣本不足」

// 線性內插版 percentile（p 由 0 到 1）。sorted 要事先排好。
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// IQR 剪枝：剷走 [Q1 - 1.5·IQR, Q3 + 1.5·IQR] 以外嘅。
// 拍賣特別需要——有 ¥1 起標流拍收場，亦有兩個人鬥氣鬥到癲價。
// 剪完少過 MIN_SAMPLES 就唔剪（寧願用原數據，都好過樣本得兩件）。
export function iqrTrim(prices) {
  const s = [...prices].sort((a, b) => a - b);
  if (s.length < 4) return { kept: s, trimmed: 0 };
  const q1 = percentile(s, 0.25), q3 = percentile(s, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  const kept = s.filter(v => v >= lo && v <= hi);
  return kept.length >= MIN_SAMPLES ? { kept, trimmed: s.length - kept.length } : { kept: s, trimmed: 0 };
}

// comps: [{ price, source, sold_at, ... }] → 統計摘要
export function summarize(comps) {
  const { kept, trimmed } = iqrTrim(comps.map(c => c.price));
  if (!kept.length) return null;
  const bySource = {};
  for (const c of comps) bySource[c.source] = (bySource[c.source] || 0) + 1;
  return {
    n: kept.length,
    trimmed,
    p25: Math.round(percentile(kept, 0.25)),
    p50: Math.round(percentile(kept, 0.50)),
    p75: Math.round(percentile(kept, 0.75)),
    min: kept[0],
    max: kept[kept.length - 1],
    bySource,
  };
}

// 一個價喺分佈入面企喺第幾個百分位（0–100）——通知講「平過 89% 成交」用
export function pctRank(prices, value) {
  if (!prices.length) return null;
  const below = prices.filter(p => p < value).length;
  return Math.round((below / prices.length) * 100);
}
