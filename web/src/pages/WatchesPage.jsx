import { useEffect, useState } from 'react';
import * as api from '../api.js';
import VerdictBadge from '../components/VerdictBadge.jsx';

const yen = n => n == null ? '—' : `¥${Math.round(n).toLocaleString('en-US')}`;
const SOURCE_LABEL = { 'yahoo-auction': 'Yahoo!拍賣', mercari: 'Mercari', surugaya: '駿河屋' };

// 見到「直筆」就提你加排除字——印刷／複製版同真簽名差成十倍價，
// 唔剔走就會將一批印刷版嘅成交價當成基準，個判斷會歪到冇譜。
const SUGGEST = [
  [/直筆|サイン|autograph/i, 'レプリカ 複製 コピー 印刷 プリント'],
  [/生写真|チェキ/, 'まとめ 大量 セット'],
];
function suggestExclude(kw) {
  for (const [re, ex] of SUGGEST) if (re.test(kw)) return ex;
  return '';
}

export default function WatchesPage({ nav }) {
  const [watches, setWatches] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const [keyword, setKeyword] = useState('');
  const [exclude, setExclude] = useState('');
  const [compKeyword, setCompKeyword] = useState('');
  const [interval, setInterval_] = useState(900);
  const [prev, setPrev] = useState(null);
  const [previewing, setPreviewing] = useState(false);

  const load = () => api.fetchWatches().then(d => setWatches(d.watches)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const onKeyword = v => {
    setKeyword(v);
    if (!exclude) setExclude(suggestExclude(v));
  };

  const doPreview = async () => {
    setPreviewing(true); setErr(null); setPrev(null);
    try {
      setPrev(await api.preview({ keyword, exclude: exclude || null, comp_keyword: compKeyword || null }));
    } catch (e) { setErr(e.message); }
    finally { setPreviewing(false); }
  };

  const doCreate = async () => {
    setBusy(true); setErr(null);
    try {
      await api.createWatch({
        keyword, exclude: exclude || null,
        comp_keyword: compKeyword || null, interval_s: Number(interval),
      });
      setKeyword(''); setExclude(''); setCompKeyword(''); setPrev(null);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const act = async fn => { setBusy(true); setErr(null); try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-ink-800 p-4">
        <h2 className="font-bold">加一條關鍵字</h2>
        <p className="mt-1 text-xs text-white/45">
          打你想追嘅日文關鍵字（例：<button className="underline" onClick={() => onKeyword('青木陽菜 直筆')}>青木陽菜 直筆</button>）。
          撳「試搜」即場睇下撈到啲乜先再存——關鍵字太闊會成日俾雜貨嘈親你。
        </p>

        <div className="mt-3 space-y-2">
          <input value={keyword} onChange={e => onKeyword(e.target.value)} placeholder="青木陽菜 直筆"
            className="w-full rounded-lg border border-white/15 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-jp-red" />

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-white/50">
              排除字（空格分隔）
              <input value={exclude} onChange={e => setExclude(e.target.value)} placeholder="レプリカ 複製 印刷"
                className="mt-1 w-full rounded-lg border border-white/15 bg-ink-900 px-3 py-2 text-sm text-white outline-none focus:border-jp-red" />
            </label>
            <label className="text-xs text-white/50">
              成交價用另一條關鍵字（唔填＝同上面一樣）
              <input value={compKeyword} onChange={e => setCompKeyword(e.target.value)} placeholder="闊啲，等樣本夠"
                className="mt-1 w-full rounded-lg border border-white/15 bg-ink-900 px-3 py-2 text-sm text-white outline-none focus:border-jp-red" />
            </label>
          </div>

          <label className="block text-xs text-white/50">
            幾耐巡一次：{Math.round(interval / 60)} 分鐘
            <input type="range" min="300" max="7200" step="300" value={interval}
              onChange={e => setInterval_(e.target.value)} className="mt-1 w-full accent-jp-red" />
          </label>

          <div className="flex gap-2">
            <button onClick={doPreview} disabled={!keyword.trim() || previewing}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold disabled:opacity-40">
              {previewing ? '搵緊…' : '試搜'}
            </button>
            <button onClick={doCreate} disabled={!keyword.trim() || busy}
              className="rounded-lg bg-jp-red px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
              開始監察
            </button>
          </div>
        </div>

        {err && <p className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{err}</p>}

        {prev && <Preview prev={prev} />}
      </section>

      <section>
        <h2 className="mb-2 font-bold">監察緊（{watches.length}）</h2>
        {watches.length === 0 && <p className="text-sm text-white/40">仲未有。上面加一條先。</p>}
        <div className="space-y-2">
          {watches.map(w => (
            <div key={w.id} className="rounded-xl border border-white/10 bg-ink-800 p-3">
              <div className="flex items-center gap-2">
                <button onClick={() => nav({ name: 'watch', id: w.id })}
                  className="text-left font-bold hover:text-jp-gold">{w.keyword}</button>
                {!w.enabled && <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-white/50">停咗</span>}
                {!w.primed && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">首輪收錄中</span>}
                <div className="ml-auto flex gap-1 text-xs">
                  <button onClick={() => act(() => api.runWatch(w.id))} disabled={busy}
                    className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-40">即刻巡</button>
                  <button onClick={() => act(() => api.refreshComps(w.id))} disabled={busy}
                    className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-40">重收成交價</button>
                  <button onClick={() => act(() => api.patchWatch(w.id, { enabled: !w.enabled }))} disabled={busy}
                    className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-40">
                    {w.enabled ? '停' : '開'}
                  </button>
                  <button onClick={() => confirm(`刪咗「${w.keyword}」？（成交價紀錄會留返）`) && act(() => api.deleteWatch(w.id))}
                    disabled={busy} className="rounded bg-red-500/15 px-2 py-1 text-red-300 hover:bg-red-500/25 disabled:opacity-40">刪</button>
                </div>
              </div>
              <div className="mt-1 text-xs text-white/45">
                近 24 小時 <b className="text-white/70">{w.hits_24h}</b> 件新貨
                {' '}· 成交樣本 <b className={w.comp_n >= 5 ? 'text-white/70' : 'text-amber-300'}>{w.comp_n}</b> 件
                {' '}· 每 {Math.round(w.interval_s / 60)} 分鐘巡一次
                {w.exclude && <> · 排除：{w.exclude}</>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Preview({ prev }) {
  const s = prev.comps?.stats;
  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-ink-900 p-3">
      <h3 className="text-sm font-bold">試搜結果</h3>

      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {prev.sources.map(src => (
          <span key={src.id} className={`rounded px-2 py-1 ${src.n ? 'bg-green-500/15 text-green-300' : 'bg-red-500/15 text-red-300'}`}>
            {SOURCE_LABEL[src.id] || src.id}：{src.n} 件
            {src.status !== 'ok' && ` (${src.status})`}
          </span>
        ))}
      </div>

      <p className="mt-2 text-xs text-white/50">
        成交樣本 <b className={prev.comps.n >= 5 ? 'text-white/80' : 'text-amber-300'}>{prev.comps.n}</b> 件
        {s && <> · 中位 <b className="text-jp-gold">{yen(s.p50)}</b> · P25–P75 {yen(s.p25)}–{yen(s.p75)}</>}
        {prev.comps.n < 5 && <span className="text-amber-300"> — 少過 5 件，所有判斷都會係「樣本不足」。試下放寬「成交價關鍵字」。</span>}
      </p>

      <div className="mt-2 space-y-1.5">
        {prev.items.length === 0 && <p className="text-xs text-white/40">而家冇貨賣緊（或者全部俾排除字剔走咗）。</p>}
        {prev.items.map((it, i) => (
          <a key={i} href={it.url} target="_blank" rel="noreferrer"
            className="block rounded border border-white/10 p-2 text-xs hover:border-white/25">
            <div className="flex items-center gap-2">
              <VerdictBadge verdict={it.verdict} ratio={it.ratio} />
              <span className="text-white/50">{SOURCE_LABEL[it.source] || it.source}</span>
              <span className="ml-auto font-bold text-jp-gold">{yen(it.buyout_price || it.price)}</span>
            </div>
            <p className="mt-1 text-white/80">{it.title.slice(0, 70)}</p>
          </a>
        ))}
      </div>
      <p className="mt-2 text-xs text-white/30">呢個試搜唔會存嘢，亦唔會推通知。</p>
    </div>
  );
}
