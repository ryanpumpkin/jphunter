const TABS = [
  ['watches', '關鍵字'],
  ['feed', '新上架'],
  ['settings', '設定'],
];

export default function Header({ page, nav }) {
  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-ink-900/90 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
        <button onClick={() => nav({ name: 'watches' })} className="text-lg font-black tracking-tight">
          <span className="text-jp-red">JP</span>Hunter
        </button>
        <nav className="ml-auto flex gap-1">
          {TABS.map(([name, label]) => (
            <button key={name} onClick={() => nav({ name })}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                page.name === name || (name === 'watches' && page.name === 'watch')
                  ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'
              }`}>
              {label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}
