import { useState } from 'react';
import Header from './components/Header.jsx';
import WatchesPage from './pages/WatchesPage.jsx';
import FeedPage from './pages/FeedPage.jsx';
import WatchPage from './pages/WatchPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';

// page: {name:'watches'} | {name:'feed'} | {name:'watch', id} | {name:'settings'}
// 手寫 state routing，唔加 react-router（得四版，唔值得多個 dep）
export default function App() {
  const [page, setPage] = useState({ name: 'watches' });
  const nav = p => { setPage(p); window.scrollTo(0, 0); };

  return (
    <div className="min-h-screen">
      <Header page={page} nav={nav} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-6">
        {page.name === 'watches' && <WatchesPage nav={nav} />}
        {page.name === 'feed' && <FeedPage nav={nav} />}
        {page.name === 'watch' && <WatchPage id={page.id} nav={nav} />}
        {page.name === 'settings' && <SettingsPage />}
      </main>
      <footer className="border-t border-white/10 py-6 text-center text-xs text-white/35">
        JPHunter — 情報聚合自公開頁面，個人自用。成交價統計僅供參考，落單前自己核實賣家。
      </footer>
    </div>
  );
}
