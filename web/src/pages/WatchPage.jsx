import { useEffect, useState } from 'react';
import * as api from '../api.js';
import SoldChart from '../components/SoldChart.jsx';
import ListingCard from '../components/ListingCard.jsx';

const yen = n => n == null ? '—' : `¥${Math.round(n).toLocaleString('en-US')}`;

export default function WatchPage({ id, nav }) {
  const [watch, setWatch] = useState(null);
  const [comps, setComps] = useState(null);
  const [items, setItems] = useState([]);
  const [days, setDays] = useState(90);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.fetchWatches().then(d => setWatch(d.watches.find(w => w.id === id))).catch(e => setErr(e.message));
    api.fetchListings({ watch_id: id }).then(d => setItems(d.items)).catch(() => {});
  }, [id]);

  useEffect(() => {
    api.fetchComps(id, days).then(setComps).catch(e => setErr(e.message));
  }, [id, days]);

  const s = comps?.stats;

  return (
    <div className="space-y-4">
      <button onClick={() => nav({ name: 'watches' })} className="text-sm text-white/50 hover:text-white">← 返關鍵字清單</button>
      <h1 className="text-xl font-black">{watch?.keyword || '…'}</h1>
      {err && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{err}</p>}

      <section className="rounded-xl border border-white/10 bg-ink-800 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold">成交價分佈</h2>
          <span className="text-xs text-white/40">query：{comps?.query}</span>
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="ml-auto rounded border border-white/15 bg-ink-900 px-2 py-1 text-xs outline-none">
            {[30, 90, 180, 365].map(d => <option key={d} value={d}>近 {d} 日</option>)}
          </select>
        </div>

        {s ? (
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="成交件數" value={s.n} note={s.trimmed ? `剷咗 ${s.trimmed} 件極端值` : null} />
            <Stat label="中位數" value={yen(s.p50)} highlight />
            <Stat label="P25（抵嘅界）" value={yen(s.p25)} />
            <Stat label="P75（貴嘅界）" value={yen(s.p75)} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-amber-300">
            仲未收到成交價。撳關鍵字清單嗰邊嘅「重收成交價」，或者等排程自己收（12 個鐘一次）。
          </p>
        )}

        {comps?.run?.last_error && (
          <p className="mt-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
            上次收成交價有問題：{comps.run.last_error}
          </p>
        )}

        {comps && <SoldChart points={comps.points} stats={s} />}
      </section>

      <section>
        <h2 className="mb-2 font-bold">搵到嘅上架（{items.length}）</h2>
        <div className="space-y-2">
          {items.length === 0 && <p className="text-sm text-white/40">仲未搵到嘢。</p>}
          {items.map(it => <ListingCard key={it.id} item={it} />)}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, note, highlight }) {
  return (
    <div className="rounded-lg bg-ink-900 p-2">
      <div className="text-xs text-white/45">{label}</div>
      <div className={`text-lg font-bold ${highlight ? 'text-jp-gold' : 'text-white/85'}`}>{value}</div>
      {note && <div className="text-xs text-white/30">{note}</div>}
    </div>
  );
}
