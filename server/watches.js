// 追蹤 CRUD ＋ 驗證。系統邊界，驗嚴啲。
import { watchList, watchGet, watchInsert, watchUpdate, watchSummary, deleteWatchCascade, watchByKeyword, compCount } from './db.js';
import { SOURCE_IDS } from './sources/index.js';
import { canonicalQuery } from './pricing/normalize.js';

const MAX_WATCHES = 50;

function clean(body, { partial = false, current = null } = {}) {
  const out = {};
  const take = (k, fallback) => (body[k] === undefined ? (partial ? current?.[k] : fallback) : body[k]);

  const keyword = String(take('keyword', '') ?? '').trim();
  if (!keyword || keyword.length > 80) throw new Error('關鍵字必填，1–80 字');
  out.keyword = keyword;

  const compKw = take('comp_keyword', null);
  const c = compKw == null ? null : String(compKw).trim();
  if (c && c.length > 80) throw new Error('成交價關鍵字最多 80 字');
  out.comp_keyword = c || null;

  const exclude = take('exclude', null);
  const e = exclude == null ? null : String(exclude).trim();
  if (e && e.length > 200) throw new Error('排除字最多 200 字');
  out.exclude = e || null;

  let sources = take('sources', null);
  if (sources != null && !Array.isArray(sources)) throw new Error('sources 要係 array');
  if (Array.isArray(sources)) {
    sources = [...new Set(sources.map(String))];
    const bad = sources.filter(s => !SOURCE_IDS.includes(s));
    if (bad.length) throw new Error(`唔識呢啲來源：${bad.join('、')}（可選：${SOURCE_IDS.join('、')}）`);
  }
  // 空 array 當「全部」（唔好搞到一個來源都冇，永遠搵唔到嘢）
  out.sources = sources?.length ? JSON.stringify(sources) : null;

  const enabled = take('enabled', 1);
  out.enabled = enabled === false || enabled === 0 ? 0 : 1;

  const iv = Number(take('interval_s', 900));
  if (!Number.isFinite(iv) || iv < 60 || iv > 86400) throw new Error('巡查間隔要喺 60–86400 秒之間');
  out.interval_s = Math.round(iv);

  return out;
}

export function listWatches() {
  return watchSummary.all().map(w => ({
    ...w,
    sources: w.sources ? JSON.parse(w.sources) : null,
    // 要用同 harvestComps／compsFor 一模一樣嘅 canonical query，唔係就對唔到數
    comp_n: compCount.get({
      query: canonicalQuery(w.comp_keyword?.trim() || w.keyword),
      since: '-90 days',
    })?.n ?? 0,
  }));
}

export function getWatch(id) {
  const w = watchGet.get(id);
  if (!w) return null;
  return { ...w, sources: w.sources ? JSON.parse(w.sources) : null };
}

export function createWatch(body) {
  if (watchList.all().length >= MAX_WATCHES) throw new Error(`最多得 ${MAX_WATCHES} 條追蹤`);
  const data = clean(body || {});
  if (watchByKeyword.get(data.keyword)) throw new Error(`「${data.keyword}」已經追緊`);
  const res = watchInsert.run(data);
  return getWatch(res.lastInsertRowid);
}

export function updateWatch(id, body) {
  const current = watchGet.get(id);
  if (!current) throw new Error('搵唔到呢條追蹤');
  const data = clean(body || {}, { partial: true, current });
  const dup = watchByKeyword.get(data.keyword);
  if (dup && dup.id !== current.id) throw new Error(`「${data.keyword}」已經追緊`);
  watchUpdate.run({ ...data, id: current.id });
  return getWatch(current.id);
}

export function removeWatch(id) {
  if (!watchGet.get(id)) throw new Error('搵唔到呢條追蹤');
  deleteWatchCascade(id);
  return true;
}
