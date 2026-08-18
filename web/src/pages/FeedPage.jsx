import { useEffect, useState } from 'react';
import * as api from '../api.js';
import ListingCard from '../components/ListingCard.jsx';
import { VERDICT_META } from '../components/VerdictBadge.jsx';

const ORDER = ['steal', 'deal', 'fair', 'pricey', 'absurd', 'auction', 'unknown'];

export default function FeedPage() {
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState([]);
  const [watches, setWatches] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [watchId, setWatchId] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { api.fetchWatches().then(d => setWatches(d.watches)).catch(() => {}); }, []);

  useEffect(() => {
    let alive = true;
    const load = () => api.fetchListings({ watch_id: watchId, verdict })
      .then(d => { if (alive) { setItems(d.items); setCounts(d.counts); setErr(null); } })
      .catch(e => alive && setErr(e.message));
    load();
    const t = setInterval(load, 60_000);   // 一分鐘刷新一次
    return () => { alive = false; clearInterval(t); };
  }, [verdict, watchId]);

  const countOf = v => counts.find(c => c.verdict === v)?.n ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={watchId ?? ''} onChange={e => setWatchId(e.target.value ? Number(e.target.value) : null)}
          className="rounded-lg border border-white/15 bg-ink-800 px-3 py-1.5 text-sm outline-none">
          <option value="">全部關鍵字</option>
          {watches.map(w => <option key={w.id} value={w.id}>{w.keyword}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Chip active={!verdict} onClick={() => setVerdict(null)}>全部</Chip>
        {ORDER.map(v => (
          <Chip key={v} active={verdict === v} onClick={() => setVerdict(verdict === v ? null : v)}>
            {VERDICT_META[v].emoji} {VERDICT_META[v].word}
            <span className="ml-1 opacity-50">{countOf(v)}</span>
          </Chip>
        ))}
      </div>

      {err && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{err}</p>}

      {items.length === 0 && !err && (
        <p className="py-8 text-center text-sm text-white/40">
          仲未有新上架。<br />
          新開嘅關鍵字第一輪只會靜靜雞收錄現有嘅貨（唔通知），之後真係有新貨先推你。
        </p>
      )}

      <div className="space-y-2">
        {items.map(it => <ListingCard key={it.id} item={it} />)}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
        active ? 'bg-jp-red text-white' : 'bg-white/8 text-white/60 hover:bg-white/15'
      }`}>
      {children}
    </button>
  );
}
