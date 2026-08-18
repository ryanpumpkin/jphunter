// 抵買判斷——成個 app 嘅心臟。
// 輸入：一件新上架 + 一批成交紀錄 → 輸出判斷 + 一段人睇得明嘅解釋。
// 呢個模組係純函數，唔掂 DB 唔掂網絡，所以 selftest.js 喺離線環境都驗證到。
import { normalizeTitle, tokenize, tokensOf, similarity, canonicalQuery } from './normalize.js';
import { summarize, pctRank, percentile, MIN_SAMPLES } from './stats.js';

// 預設比價窗 90 日；樣本唔夠 MIN_SAMPLES 就放寬到 180 日（放寬邏輯喺 ingest.js compsFor）。
// 我哋自己張 sold_comps 表會累積超過 Yahoo 落札相場本身嘅 ~120 日視窗，所以跑得耐咗，
// 180 日窗會有 Yahoo 官網而家都睇唔返嘅數據——呢個係長期優勢。
export const WINDOW_DAYS = 90;
export const WIDE_WINDOW_DAYS = 180;
const SAME_SOURCE_MIN = 8;             // 要用「同來源專屬」對比，樣本要更多先信得過
const STRICT_SIM = 0.35;
const LOOSE_SIM = 0.18;

// 同一件事喺唔同站嘅名：判斷一件 Yahoo 拍賣貨時，優先同 Yahoo 落札價比。
// 理由係運費慣例唔同——Yahoo 拍賣通常運費另計，Mercari 幾乎一定係送料込，
// 溝埋一齊有 ¥300–800 嘅系統性偏差。夠樣本就分開比，唔夠先溝，並且要講明。
const SAME_SOURCE = { 'yahoo-auction': 'yahoo-closed', mercari: 'mercari-sold' };

export const VERDICTS = {
  steal:   { emoji: '🔥', word: '超抵', tone: 'good' },
  deal:    { emoji: '✅', word: '抵',   tone: 'good' },
  fair:    { emoji: '😐', word: '合理', tone: 'neutral' },
  pricey:  { emoji: '⚠️', word: '偏貴', tone: 'warn' },
  absurd:  { emoji: '🚫', word: '離譜', tone: 'bad' },
  auction: { emoji: '🔨', word: '競投中', tone: 'info' },
  unknown: { emoji: '❓', word: '樣本不足', tone: 'muted' },
};

// r = judged_price / p50。
// gate = 極端評級嘅額外閘：叫得「超抵」就要真係跌穿 P25、叫得「離譜」就要真係
// 高過 P75。冇呢個閘，遇著分佈好窄（例如全部成交都喺 ¥5,000±200）嗰陣，
// 差 30% 都仲喺 P25–P75 之間，唔應該大驚小怪叫人衝。
const BANDS = [
  { max: 0.70,     verdict: 'steal',  gate: (p, s) => p <= s.p25 },
  { max: 0.85,     verdict: 'deal' },
  { max: 1.15,     verdict: 'fair' },
  { max: 1.45,     verdict: 'pricey' },
  { max: Infinity, verdict: 'absurd', gate: (p, s) => p >= s.p75 },
];

// ── 攞邊個價去判斷 —— ★ 拍賣陷阱就係喺呢度處理 ──
// 定價站（Mercari／駿河屋）：售價，直接可比，冇伏。
// Yahoo 拍賣有「即決価格」：用即決價，因為佢即刻買得走，性質同定價一樣。
// Yahoo 拍賣冇即決：現在価格 ≠ 成交價。啱啱開嘅拍賣企喺 ¥100 唔係「平 98%」，
//   係「仲未有人叫價」。呢種一律唔畀出抵／貴嘅判斷，改為出一個建議出價上限。
export function judgedPrice(listing) {
  if (listing.listing_kind === 'buynow') return { price: listing.price ?? null, label: '售價' };
  if (listing.buyout_price) return { price: listing.buyout_price, label: '即決價' };
  return { price: null, label: '現價（競投中）' };
}

// ── 揀對比群 ──
// 由最窄試到最闊，第一層夠樣本就用，並記低用咗邊層（comp_basis），
// 通知同 UI 都會照實講——唔可以偷偷用一堆唔同款嘅貨砌個中位數出嚟呃自己。
export function pickCohort(listing, comps, watch) {
  const lt = tokensOf(listing.title);
  const kwTokens = tokensOf(watch?.comp_keyword || watch?.keyword || '');
  const sameSrc = SAME_SOURCE[listing.source];

  const scored = comps.map(c => {
    const norm = c.norm_title || normalizeTitle(c.title);
    return {
      ...c,
      sim: similarity(lt, tokenize(norm)),
      // 關鍵字全中：防止「青木陽菜」條 query 撈到嘅雜貨溝入嚴格群
      hasKw: kwTokens.size === 0 || [...kwTokens].every(t => norm.includes(t)),
    };
  });

  const strict = scored.filter(c => c.sim >= STRICT_SIM && c.hasKw);
  const loose = scored.filter(c => c.sim >= LOOSE_SIM);

  const tiers = [
    sameSrc && ['strict-same', strict.filter(c => c.source === sameSrc), SAME_SOURCE_MIN],
    ['strict-pooled', strict, MIN_SAMPLES],
    sameSrc && ['loose-same', loose.filter(c => c.source === sameSrc), SAME_SOURCE_MIN],
    ['loose-pooled', loose, MIN_SAMPLES],
    ['query', scored, MIN_SAMPLES],
  ].filter(Boolean);

  for (const [basis, rows, need] of tiers) {
    if (rows.length >= need) return { basis, rows };
  }
  return { basis: 'none', rows: scored };
}

const BASIS_NOTE = {
  'strict-same': null,                                        // 最靚嘅情況，唔使解釋
  'strict-pooled': '對比基準：Yahoo＋Mercari 成交溝埋計（運費慣例唔同，有少少偏差）',
  'loose-same': '對比基準：同款判斷放寬咗，可能溝咗其他版本',
  'loose-pooled': '對比基準：同款判斷放寬咗兼兩站溝埋，僅供參考',
  query: '對比基準：成條關鍵字全部成交（非同款）——個中位數可能溝咗唔同貨',
};

const yen = n => `¥${Math.round(n).toLocaleString('en-US')}`;

// ── 主判斷 ──
// 回傳 { verdict, ratio, n, p25, p50, p75, basis, window, judged_price, lines[] }
// lines 係通知／UI 直接用嘅解釋，已經寫好廣東話。
export function judge(listing, comps, watch, { windowDays = WINDOW_DAYS } = {}) {
  const { basis, rows } = pickCohort(listing, comps, watch);
  const { price, label } = judgedPrice(listing);

  if (basis === 'none' || rows.length < MIN_SAMPLES) {
    return {
      verdict: 'unknown', ratio: null, basis: 'none', window: windowDays,
      n: rows.length, p25: null, p50: null, p75: null, judged_price: price,
      lines: [`❓ 樣本不足（近 ${windowDays} 日只搵到 ${rows.length} 件成交）——暫時判斷唔到抵唔抵`],
    };
  }

  const s = summarize(rows);
  const base = {
    basis, window: windowDays, n: s.n, p25: s.p25, p50: s.p50, p75: s.p75, judged_price: price,
  };
  const note = BASIS_NOTE[basis];

  // 競投中、冇即決：唔比，改為畀個出價上限
  if (price == null) {
    const lines = [
      `📊 近 ${windowDays} 日成交中位數 ${yen(s.p50)}（${s.n} 件）`,
      `👉 現價 ${listing.price != null ? yen(listing.price) : '—'} 係競投中，唔算成交價；出到 ${yen(s.p25)} 以內先算抵`,
    ];
    if (note) lines.push(`　（${note}）`);
    return { ...base, verdict: 'auction', ratio: null, lines };
  }

  const r = price / s.p50;
  let idx = BANDS.findIndex(b => r <= b.max);
  const band = BANDS[idx];
  // 閘唔過就降返落隔離嗰格（低價側往上一格，高價側往落一格）
  if (band.gate && !band.gate(price, s)) idx += r < 1 ? 1 : -1;
  const verdict = BANDS[idx].verdict;

  const v = VERDICTS[verdict];
  const diff = Math.round(Math.abs(1 - r) * 100);
  const cmp = diff === 0 ? '同價' : r < 1 ? `平 ${diff}%` : `貴 ${diff}%`;
  const rank = pctRank(rows.map(c => c.price), price);

  const lines = [
    `${v.emoji} ${v.word}｜${label} ${yen(price)} — 比近 ${windowDays} 日成交中位數 ${yen(s.p50)} ${cmp}`,
    `　 P25 ${yen(s.p25)}・P75 ${yen(s.p75)}・${s.n} 件成交・平過 ${100 - rank}% 成交`,
  ];
  if (note) lines.push(`　（${note}）`);

  return { ...base, verdict, ratio: r, lines };
}

export { canonicalQuery, MIN_SAMPLES };
