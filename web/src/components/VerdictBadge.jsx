// 抵買判斷 badge。顏色同 emoji 全 app 統一由呢度出。
export const VERDICT_META = {
  steal:   { emoji: '🔥', word: '超抵',     cls: 'bg-emerald-500/20 text-emerald-300 ring-emerald-500/40' },
  deal:    { emoji: '✅', word: '抵',       cls: 'bg-green-500/15 text-green-300 ring-green-500/30' },
  fair:    { emoji: '😐', word: '合理',     cls: 'bg-slate-500/15 text-slate-300 ring-slate-500/30' },
  pricey:  { emoji: '⚠️', word: '偏貴',     cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  absurd:  { emoji: '🚫', word: '離譜',     cls: 'bg-red-500/15 text-red-300 ring-red-500/30' },
  auction: { emoji: '🔨', word: '競投中',   cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  unknown: { emoji: '❓', word: '樣本不足', cls: 'bg-white/5 text-white/50 ring-white/15' },
};

export default function VerdictBadge({ verdict, ratio, className = '' }) {
  const m = VERDICT_META[verdict] || VERDICT_META.unknown;
  const pct = ratio != null && verdict !== 'auction' && verdict !== 'unknown'
    ? (ratio < 1 ? `平 ${Math.round((1 - ratio) * 100)}%` : ratio > 1 ? `貴 ${Math.round((ratio - 1) * 100)}%` : '同價')
    : null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ring-1 ${m.cls} ${className}`}>
      <span>{m.emoji}</span>{m.word}{pct && <span className="font-normal opacity-80">· {pct}</span>}
    </span>
  );
}
