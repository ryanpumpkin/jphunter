import VerdictBadge from './VerdictBadge.jsx';

const SOURCE_LABEL = { 'yahoo-auction': 'Yahoo!拍賣', mercari: 'Mercari', surugaya: '駿河屋' };
const yen = n => n == null ? '—' : `¥${Math.round(n).toLocaleString('en-US')}`;

function ago(t) {
  if (!t) return '';
  const ms = Date.now() - Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
  const m = Math.round(ms / 60000);
  if (!Number.isFinite(m)) return '';
  if (m < 60) return `${Math.max(m, 0)} 分鐘前`;
  if (m < 1440) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 1440)} 日前`;
}

export default function ListingCard({ item }) {
  const live = item.listing_kind === 'auction' && !item.buyout_price;
  return (
    <a href={item.url} target="_blank" rel="noreferrer"
      className="block rounded-xl border border-white/10 bg-ink-800 p-3 transition hover:border-white/25">
      <div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
        <VerdictBadge verdict={item.verdict} ratio={item.ratio} />
        <span className="font-semibold text-white/70">{SOURCE_LABEL[item.source] || item.source}</span>
        {item.condition && <span>· {item.condition}</span>}
        {live && <span className="text-sky-300">· 競投中{item.ends_at ? ` 剩 ${item.ends_at}` : ''}</span>}
        {item.keyword && <span className="ml-auto">🔍 {item.keyword}</span>}
      </div>

      <p className="mt-1.5 text-sm leading-snug text-white/90">{item.title}</p>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-lg font-bold text-jp-gold">
          {yen(item.buyout_price || item.price)}
        </span>
        {item.buyout_price && <span className="text-xs text-white/40">即決（現價 {yen(item.price)}）</span>}
        {live && <span className="text-xs text-sky-300/80">現價，唔算成交價</span>}
      </div>

      {/* 判斷嘅底：中位數同樣本數。冇呢行個 badge 就係空口講白話。 */}
      <div className="mt-1 text-xs text-white/45">
        {item.comp_n >= 5 ? (
          <>
            近 {item.comp_window || 90} 日成交中位 <b className="text-white/70">{yen(item.comp_p50)}</b>
            {' '}· P25–P75 {yen(item.comp_p25)}–{yen(item.comp_p75)} · {item.comp_n} 件
            {live && <> · 出到 <b className="text-sky-300">{yen(item.comp_p25)}</b> 以內先算抵</>}
          </>
        ) : (
          <>成交樣本不足（{item.comp_n ?? 0} 件），判斷唔到抵唔抵</>
        )}
        <span className="float-right">{ago(item.found_at)}</span>
      </div>
    </a>
  );
}
