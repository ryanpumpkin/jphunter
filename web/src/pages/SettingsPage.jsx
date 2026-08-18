import { useEffect, useState } from 'react';
import * as api from '../api.js';

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [health, setHealth] = useState(null);
  const [notify, setNotify] = useState(null);
  const [token, setTokenState] = useState(localStorage.getItem('jphunter_token') || '');
  const [tgToken, setTgToken] = useState('');
  const [tgChat, setTgChat] = useState('');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const load = () => {
    api.fetchSettings().then(s => { setSettings(s); setTgChat(s.telegram.chatId || ''); }).catch(e => setErr(e.message));
    api.fetchHealth().then(setHealth).catch(() => {});
    api.fetchNotifyFailures().then(setNotify).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const saveToken = () => { api.setToken(token); setMsg('管理員 token 存咗落瀏覽器'); load(); };

  const saveTg = async () => {
    setErr(null); setMsg(null);
    try {
      await api.saveTelegram({ ...(tgToken ? { token: tgToken } : {}), chatId: tgChat });
      setTgToken(''); setMsg('Telegram 設定已儲存'); load();
    } catch (e) { setErr(e.message); }
  };

  const test = async () => {
    setErr(null); setMsg(null);
    try {
      const r = await api.testNotify();
      setMsg(r.ok ? '測試訊息已經送出——去 Telegram 睇下收唔收到' : '送唔出，睇下下面嘅失敗記錄');
      setTimeout(load, 1500);
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="space-y-4">
      {msg && <p className="rounded-lg bg-green-500/15 px-3 py-2 text-sm text-green-300">{msg}</p>}
      {err && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{err}</p>}

      <Section title="管理員 token">
        <p className="text-xs text-white/45">
          server 設咗 ADMIN_TOKEN 嘅話，改設定／加關鍵字要喺呢度入返同一個 token。
        </p>
        <div className="mt-2 flex gap-2">
          <input type="password" value={token} onChange={e => setTokenState(e.target.value)} placeholder="ADMIN_TOKEN"
            className="flex-1 rounded-lg border border-white/15 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-jp-red" />
          <button onClick={saveToken} className="rounded-lg bg-white/10 px-4 text-sm font-semibold">存</button>
        </div>
      </Section>

      <Section title="Telegram 通知">
        <p className="text-xs text-white/45">
          Telegram 搵 @BotFather → /newbot 攞 token；同個 bot 傾一句偈，再開
          {' '}<code className="text-white/60">api.telegram.org/bot&lt;token&gt;/getUpdates</code> 攞 chat id。
        </p>
        <div className="mt-2 space-y-2">
          <label className="block text-xs text-white/50">
            Bot token {settings?.telegram.hasToken && <span className="text-green-300">（已設定 ✓{settings.telegram.fromEnv ? '，由 .env 嚟' : ''}）</span>}
            <input type="password" value={tgToken} onChange={e => setTgToken(e.target.value)}
              placeholder={settings?.telegram.hasToken ? '已設定，要改先入新嘅' : '123456:AA...'}
              className="mt-1 w-full rounded-lg border border-white/15 bg-ink-900 px-3 py-2 text-sm text-white outline-none focus:border-jp-red" />
          </label>
          <label className="block text-xs text-white/50">
            Chat ID
            <input value={tgChat} onChange={e => setTgChat(e.target.value)} placeholder="123456789"
              className="mt-1 w-full rounded-lg border border-white/15 bg-ink-900 px-3 py-2 text-sm text-white outline-none focus:border-jp-red" />
          </label>
          <div className="flex gap-2">
            <button onClick={saveTg} className="rounded-lg bg-jp-red px-4 py-2 text-sm font-bold">儲存</button>
            <button onClick={test} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold">發測試訊息</button>
          </div>
        </div>
      </Section>

      <Section title="來源健康">
        {!health?.sources?.length && <p className="text-xs text-white/40">仲未跑過。</p>}
        <div className="space-y-1">
          {health?.sources?.map(s => {
            const ok = s.zero_streak === 0 && !s.last_error;
            return (
              <div key={s.adapter} className="flex items-center gap-2 rounded bg-ink-900 px-2 py-1.5 text-xs">
                <span className={ok ? 'text-green-400' : 'text-red-400'}>{ok ? '●' : '●'}</span>
                <span className="font-semibold">{s.adapter}</span>
                <span className="text-white/40">
                  {ok ? `最後成功 ${s.last_ok?.slice(5, 16) || '—'}` : `連續 ${s.zero_streak} 次 0 件${s.last_error ? `｜${s.last_error}` : ''}`}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-white/30">
          有來源長期 0 件＝個站好可能改咗版。喺部機跑
          {' '}<code className="text-white/50">node server/probe.js --all "你條關鍵字"</code>{' '}
          睇下邊層 selector 死咗。
        </p>
      </Section>

      <Section title="通知送遞">
        <div className="flex flex-wrap gap-2 text-xs">
          {notify?.stats?.length ? notify.stats.map((s, i) => (
            <span key={i} className={`rounded px-2 py-1 ${s.status === 'ok' ? 'bg-green-500/15 text-green-300' : 'bg-red-500/15 text-red-300'}`}>
              {s.channel} {s.status}：{s.n}
            </span>
          )) : <span className="text-white/40">近 24 小時冇送過嘢。</span>}
        </div>
        {notify?.failures?.length > 0 && (
          <div className="mt-2 space-y-1">
            {notify.failures.slice(0, 8).map(f => (
              <div key={f.id} className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-200">
                {f.created_at} · {f.channel} · {f.title} — {f.error}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="rounded-xl border border-white/10 bg-ink-800 p-4">
      <h2 className="mb-2 font-bold">{title}</h2>
      {children}
    </section>
  );
}
