// 成交價散點圖：X = 成交日期，Y = 成交價。手寫 SVG，唔用 chart library。
// 黃點 = Yahoo 落札（有準確日期）；藍點 = Mercari 已售出（日期係估算，畫空心）。
// 打橫三條線 = P25 / 中位 / P75。撳一點開返個 listing。
import { useMemo, useState } from 'react';

const W = 640, H = 240, PAD = { l: 54, r: 12, t: 12, b: 24 };
const yen = n => `¥${Math.round(n).toLocaleString('en-US')}`;

// 取一個「靚」嘅刻度間距（1 / 2 / 2.5 / 5 × 10^n）
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

export default function SoldChart({ points, stats }) {
  const [tip, setTip] = useState(null);

  const model = useMemo(() => {
    const pts = points
      .map(p => ({ ...p, t: Date.parse(p.t), y: p.price }))
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.y));
    if (pts.length < 2) return null;

    const ts = pts.map(p => p.t), ys = pts.map(p => p.y);
    const t0 = Math.min(...ts), t1 = Math.max(...ts) || t0 + 1;
    // Y 軸上限用 P75 × 2.2 封頂，唔好俾一件離譜貨壓扁晒其他點
    const cap = stats?.p75 ? Math.min(Math.max(...ys), stats.p75 * 2.2) : Math.max(...ys);
    const y1 = Math.max(cap, stats?.p75 || 0) * 1.1 || 1;

    const sx = t => PAD.l + ((t - t0) / Math.max(t1 - t0, 1)) * (W - PAD.l - PAD.r);
    const sy = y => H - PAD.b - (Math.min(y, y1) / y1) * (H - PAD.t - PAD.b);
    const fmtD = t => new Date(t).toLocaleDateString('zh-HK', { month: 'numeric', day: 'numeric' });

    // Y 軸刻度取「靚數」（1000/2500/5000 咁跳），唔好出「7018」呢啲怪數
    const step = niceStep(y1 / 2);
    const yTicks = [];
    for (let v = 0; v <= y1 + 1; v += step) yTicks.push({ v, y: sy(v) });

    return {
      pts, sx, sy, y1, yTicks,
      x0: fmtD(t0), x1: fmtD(t1),
      overflow: ys.filter(y => y > y1).length,
    };
  }, [points, stats]);

  if (!model) return <p className="mt-3 text-sm text-white/40">成交紀錄唔夠畫圖（至少要 2 件）。</p>;
  const { pts, sx, sy, yTicks, x0, x1, overflow } = model;

  // 三條線嘅字錯開擺（左／中／右）——分佈窄嗰陣三個價好接近，
  // 全部貼右邊會疊到睇唔到。
  const bands = stats ? [
    { v: stats.p25, label: 'P25', color: '#4ade80', at: 0.30 },
    { v: stats.p50, label: '中位', color: '#f6c453', at: 0.62 },
    { v: stats.p75, label: 'P75', color: '#fb923c', at: 0.92 },
  ] : [];

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-ink-800 p-4">
      <div className="flex flex-wrap gap-4 text-xs text-white/50">
        <span><span className="inline-block h-2 w-2 rounded-full bg-jp-gold align-middle" /> Yahoo 落札</span>
        <span><span className="inline-block h-2 w-2 rounded-full border border-sky-400 align-middle" /> Mercari 已售出（日期估算）</span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" onMouseLeave={() => setTip(null)}>
          {yTicks.map(t => (
            <g key={t.v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.07)" />
              <text x={PAD.l - 6} y={t.y + 3} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.4)">
                {t.v >= 1000 ? `${+(t.v / 1000).toFixed(1)}k` : t.v}
              </text>
            </g>
          ))}
          {bands.map(b => (
            <g key={b.label}>
              <line x1={PAD.l} x2={W - PAD.r} y1={sy(b.v)} y2={sy(b.v)}
                stroke={b.color} strokeOpacity="0.5" strokeWidth="1"
                strokeDasharray={b.label === '中位' ? '' : '4 3'} />
              <text x={PAD.l + (W - PAD.l - PAD.r) * b.at} y={sy(b.v) - 4}
                textAnchor="middle" fontSize="9" fill={b.color} fillOpacity="0.9"
                stroke="#161b26" strokeWidth="3" paintOrder="stroke">
                {b.label} {yen(b.v)}
              </text>
            </g>
          ))}
          <text x={PAD.l} y={H - 6} fontSize="10" fill="rgba(255,255,255,0.4)">{x0}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.4)">{x1}</text>
          {pts.map((p, i) => (
            <circle key={i} cx={sx(p.t)} cy={sy(p.y)} r="4"
              fill={p.exact ? '#f6c453' : 'none'}
              stroke={p.exact ? 'none' : '#38bdf8'} strokeWidth="1.5"
              fillOpacity="0.85" className="cursor-pointer"
              onMouseEnter={() => setTip({ x: sx(p.t), y: sy(p.y), p })}
              onClick={() => p.url && window.open(p.url, '_blank')} />
          ))}
        </svg>
        {tip && (
          <div className="pointer-events-none absolute z-10 max-w-[260px] rounded bg-black/90 px-2 py-1 text-xs"
            style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%`, transform: 'translate(-50%, -115%)' }}>
            <div className="font-bold text-jp-gold">{yen(tip.p.price)}</div>
            <div className="text-white/70">{tip.p.title?.slice(0, 40)}</div>
            <div className="text-white/40">
              {new Date(tip.p.t).toLocaleDateString('zh-HK')}{tip.p.exact ? '' : '（估算日期）'}
            </div>
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-white/30">
        撳一點開返件貨。{overflow > 0 && `有 ${overflow} 件價錢高過圖頂，已經壓喺頂線。`}
        {' '}Mercari 已售出頁冇顯示賣出日期，用「首次見到」估算。
      </p>
    </div>
  );
}
