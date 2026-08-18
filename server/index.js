import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import {
  feedQuery, verdictCounts, listingGet, healthRows, notifyFailures, notifyStats,
  compsForQuery, compRunsAll,
} from './db.js';
import { listWatches, getWatch, createWatch, updateWatch, removeWatch } from './watches.js';
import { compQueryOf, compsFor } from './ingest.js';
import { startScheduler, rebuildWatchTimers, primeComps, runWatchNow, harvestNow } from './scheduler.js';
import { initChannels, notifyTest } from './notify.js';
import { startHealthMonitor } from './health.js';
import { LISTING_SOURCES, SOLD_SOURCES } from './sources/index.js';
import { judge, VERDICTS, WINDOW_DAYS } from './pricing/verdict.js';
import { summarize } from './pricing/stats.js';
import { normalizeTitle, excluded } from './pricing/normalize.js';
import { publicSettings, setTelegram } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '32kb' }));

// ── 管理員保護 ──
// 冇呢個，出咗街任何人都改到你嘅追蹤、借你個 bot 發訊息、兼叫個 server
// 狂咁去打日本站（幫你搵封 IP）。.env 未設 ADMIN_TOKEN = 本機開發模式唔限制。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const rateBuckets = new Map();
function rateLimit(key, max) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now > b.resetAt) { rateBuckets.set(key, { count: 1, resetAt: now + 60_000 }); return true; }
  return ++b.count <= max;
}
setInterval(() => {   // 唔好俾個 Map 無限膨脹
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(k);
}, 5 * 60_000).unref();

function tokenMatches(got) {
  if (typeof got !== 'string' || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (!rateLimit(`admin:${req.ip}`, 30)) return res.status(429).json({ ok: false, error: '太密，遲下再試' });
  const got = req.get('X-Admin-Token') || req.query.token;
  if (!tokenMatches(got)) return res.status(401).json({ ok: false, error: '需要管理員 token' });
  next();
}
// 會打外站嘅 endpoint 額外限流——唔好俾人（或者自己撳快兩下）借個 server 去洗人版
function throttle(name, max) {
  return (req, res, next) =>
    rateLimit(`${name}:${req.ip}`, max) ? next() : res.status(429).json({ ok: false, error: '太密，抖一抖先' });
}

const asInt = (v, d = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const fail = (res, err, code = 400) => res.status(code).json({ ok: false, error: err.message || String(err) });

// ── 健康檢查（Docker healthcheck 用，唔使 auth）──
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── 追蹤 CRUD ──
app.get('/api/watches', (_req, res) => res.json({ watches: listWatches() }));

app.post('/api/watches', requireAdmin, (req, res) => {
  try {
    const w = createWatch(req.body);
    primeComps(w.id);                                   // 即刻插隊收成交價
    rebuildWatchTimers({ immediateFor: w.id });         // 即刻巡一次（首輪只收錄唔通知）
    res.json({ ok: true, watch: w });
  } catch (err) { fail(res, err); }
});

app.patch('/api/watches/:id', requireAdmin, (req, res) => {
  try {
    const w = updateWatch(asInt(req.params.id), req.body);
    rebuildWatchTimers();
    res.json({ ok: true, watch: w });
  } catch (err) { fail(res, err); }
});

app.delete('/api/watches/:id', requireAdmin, (req, res) => {
  try {
    removeWatch(asInt(req.params.id));
    rebuildWatchTimers();
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// 手動即跑一次
app.post('/api/watches/:id/run', requireAdmin, throttle('run', 3), async (req, res) => {
  try {
    await runWatchNow(asInt(req.params.id));
    res.json({ ok: true });
  } catch (err) { fail(res, err, 500); }
});

// 手動重收成交價
app.post('/api/watches/:id/comps/refresh', requireAdmin, throttle('comps', 2), async (req, res) => {
  try {
    res.json({ ok: true, ...(await harvestNow(asInt(req.params.id))) });
  } catch (err) { fail(res, err, 500); }
});

// 成交價分佈（chart 用）＋統計摘要
app.get('/api/watches/:id/comps', (req, res) => {
  const w = getWatch(asInt(req.params.id));
  if (!w) return res.status(404).json({ error: '搵唔到呢條追蹤' });
  const days = Math.min(Math.max(asInt(req.query.days, 90), 7), 400);
  const rows = compsForQuery.all({ query: compQueryOf(w), since: `-${days} days` });
  res.json({
    query: compQueryOf(w),
    days,
    points: rows.map(r => ({
      t: r.sold_at, price: r.price, source: r.source,
      title: r.title, url: r.url, exact: !!r.sold_at_exact,
    })),
    stats: summarize(rows) || null,
    run: compRunsAll.all().find(r => r.query === compQueryOf(w)) || null,
  });
});

// ── feed ──
app.get('/api/listings', (req, res) => {
  const watch_id = asInt(req.query.watch_id);
  const verdict = VERDICTS[req.query.verdict] ? req.query.verdict : null;
  const limit = Math.min(asInt(req.query.limit, 50), 100);
  const offset = Math.max(asInt(req.query.offset, 0), 0);
  res.json({
    items: feedQuery.all({ watch_id, verdict, limit, offset }),
    counts: verdictCounts.all({ watch_id }),
  });
});

app.get('/api/listings/:id', (req, res) => {
  const row = listingGet.get(asInt(req.params.id));
  if (!row) return res.status(404).json({ error: '搵唔到' });
  res.json({ listing: row });
});

// ── 試搜：即場抓一次 + 判斷，唔寫 DB、唔通知 ──
// 呢個係「打完關鍵字之前先睇下撈到啲乜」嘅位——條 keyword 太闊定太窄，
// 存之前就知，唔使等一日先發現全部通知都係垃圾。
app.post('/api/preview', requireAdmin, throttle('preview', 5), async (req, res) => {
  const keyword = String(req.body?.keyword || '').trim();
  if (!keyword || keyword.length > 80) return res.status(400).json({ ok: false, error: '關鍵字必填，1–80 字' });
  const exclude = req.body?.exclude ? String(req.body.exclude).slice(0, 200) : null;
  const want = Array.isArray(req.body?.sources) && req.body.sources.length ? req.body.sources : null;
  const watch = { keyword, comp_keyword: req.body?.comp_keyword || null, exclude };

  try {
    // 1) 成交價：優先用 DB 已經收埋嘅（快兼唔使再打人哋個站）；
    //    冇先至真係去抓一次。
    const fake = { ...watch, id: -1 };
    let comps = compsFor(fake).rows;
    let windowDays = compsFor(fake).windowDays;
    let compLive = false;
    if (comps.length < 5) {
      compLive = true;
      comps = [];
      for (const src of SOLD_SOURCES) {
        const r = await src.search(watch.comp_keyword?.trim() || keyword, { limit: 80 });
        for (const row of r.rows) {
          if (row.price == null || excluded(row.title, exclude)) continue;
          comps.push({
            price: row.price, source: src.id, title: row.title,
            norm_title: normalizeTitle(row.title),
            sold_at: row.soldAt || new Date().toISOString(),
          });
        }
      }
      windowDays = WINDOW_DAYS;
    }

    // 2) 新貨：每個來源抓少少就夠睇
    const sources = [];
    const items = [];
    for (const src of LISTING_SOURCES) {
      if (want && !want.includes(src.id)) continue;
      const r = await src.search(keyword, { limit: 10 });
      sources.push({ id: src.id, label: src.label, n: r.rows.length, status: r.status, tier: r.tier, diag: r.diag });
      for (const row of r.rows.slice(0, 6)) {
        if (excluded(row.title, exclude)) continue;
        const listing = {
          source: src.id, listing_kind: row.listingKind, title: row.title,
          price: row.price, buyout_price: row.buyoutPrice ?? null,
        };
        const v = judge(listing, comps, watch, { windowDays });
        items.push({
          ...listing, url: row.url, ends_at: row.endsAt ?? null, bids: row.bids ?? null,
          condition: row.condition ?? null, buyout_price: row.buyoutPrice ?? null,
          verdict: v.verdict, ratio: v.ratio, lines: v.lines,
          comp_n: v.n, comp_p50: v.p50, comp_basis: v.basis,
        });
      }
    }

    res.json({
      ok: true, keyword, sources, items,
      comps: { n: comps.length, live: compLive, windowDays, stats: summarize(comps) || null },
    });
  } catch (err) { fail(res, err, 500); }
});

// ── 來源／通知狀況 ──
app.get('/api/sources', (_req, res) => res.json({
  listing: LISTING_SOURCES.map(s => ({ id: s.id, label: s.label, needsBrowser: !!s.needsBrowser })),
  sold: SOLD_SOURCES.map(s => ({ id: s.id, label: s.label, needsBrowser: !!s.needsBrowser })),
}));
app.get('/api/sources/health', (_req, res) => res.json({ sources: healthRows.all(), comps: compRunsAll.all() }));
app.get('/api/notify/failures', requireAdmin, (req, res) => {
  const limit = Math.min(asInt(req.query.limit, 50), 200);
  res.json({ stats: notifyStats.all(), failures: notifyFailures.all({ limit }) });
});
app.post('/api/notify/test', requireAdmin, throttle('nt', 5), async (_req, res) => {
  try { res.json({ ok: await notifyTest() }); } catch (err) { fail(res, err, 500); }
});

// ── 設定 ──
app.get('/api/settings', requireAdmin, (_req, res) => res.json(publicSettings()));
app.put('/api/settings/telegram', requireAdmin, (req, res) => {
  try {
    setTelegram(req.body || {});
    res.json({ ok: true, ...publicSettings() });
  } catch (err) { fail(res, err); }
});

// ── production：serve 埋 build 好嘅前端 ──
const dist = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(dist));
app.get(/^\/(?!api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(dist, 'index.html'), err => err && next());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] JPHunter 起咗喺 http://localhost:${PORT}`);
  if (!ADMIN_TOKEN) console.warn('[server] ⚠️ 未設 ADMIN_TOKEN——本機開發模式，出街之前記得設。');
  initChannels();
  startScheduler();
  startHealthMonitor();
});
