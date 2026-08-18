// API client。管理員 token 存 localStorage，寫入類 request 自動帶埋。
const token = () => localStorage.getItem('jphunter_token') || '';
export const setToken = t => localStorage.setItem('jphunter_token', t || '');
export const hasToken = () => !!token();

async function req(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token() ? { 'X-Admin-Token': token() } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const fetchWatches = () => req('/watches');
export const createWatch = body => req('/watches', { method: 'POST', body: JSON.stringify(body) });
export const patchWatch = (id, body) => req(`/watches/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteWatch = id => req(`/watches/${id}`, { method: 'DELETE' });
export const runWatch = id => req(`/watches/${id}/run`, { method: 'POST' });
export const refreshComps = id => req(`/watches/${id}/comps/refresh`, { method: 'POST' });
export const fetchComps = (id, days = 90) => req(`/watches/${id}/comps?days=${days}`);
export const preview = body => req('/preview', { method: 'POST', body: JSON.stringify(body) });

export const fetchListings = ({ watch_id, verdict, limit = 50 } = {}) => {
  const q = new URLSearchParams();
  if (watch_id) q.set('watch_id', watch_id);
  if (verdict) q.set('verdict', verdict);
  q.set('limit', limit);
  return req(`/listings?${q}`);
};

export const fetchSources = () => req('/sources');
export const fetchHealth = () => req('/sources/health');
export const fetchNotifyFailures = () => req('/notify/failures');
export const testNotify = () => req('/notify/test', { method: 'POST' });
export const fetchSettings = () => req('/settings');
export const saveTelegram = body => req('/settings/telegram', { method: 'PUT', body: JSON.stringify(body) });
