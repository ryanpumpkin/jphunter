// SQLite（better-sqlite3，同步 API，冇 ORM——prepared statement 直接 export 出去用）。
// 表：watches（你打嘅關鍵字）、listings（搵到嘅新上架）、sold_comps（真成交紀錄，
// 比價基準）、comp_runs（成交價收集進度）、加三張底層表（snapshots / source_health / notify_log）。
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH 可用環境變數指定（Docker 部署掛一個 volume 落嚟，資料先會持久化）
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'jphunter.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS watches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT NOT NULL UNIQUE,          -- 原樣送去各站搜尋，例：青木陽菜 直筆
  comp_keyword TEXT,                          -- 收成交價用另一條 query（唔填＝同 keyword）
  exclude      TEXT,                          -- 排除字，空格分隔（例：レプリカ 複製 コピー 印刷）
  sources      TEXT,                          -- JSON array ['yahoo','mercari','surugaya']；null = 全部
  enabled      INTEGER NOT NULL DEFAULT 1,
  interval_s   INTEGER NOT NULL DEFAULT 900,  -- 巡新貨頻率
  -- 首輪只收錄唔通知：新開一條 watch，第一次巡三個站 × 30 件 = 90 條「新貨」
  -- 會即刻洗你版。首輪淨係寫低（當睇過），primed=1 之後先算真‧新上架。
  primed       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at  TEXT,                          -- 上次巡新貨
  last_comp_at TEXT                           -- 上次收成交價（12 個鐘一次）
);

-- 新上架。judge() 嘅判斷結果一齊寫低（發通知嗰刻嘅 snapshot），feed 同通知共用。
CREATE TABLE IF NOT EXISTS listings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id     INTEGER NOT NULL,
  source       TEXT NOT NULL,                 -- yahoo-auction | mercari | surugaya
  item_key     TEXT NOT NULL,                 -- normalizeKey(url)
  listing_kind TEXT NOT NULL,                 -- auction（競投中）| auction_bin（有即決）| buynow（定價）
  title        TEXT NOT NULL,
  url          TEXT,
  price        INTEGER,                       -- 拍賣＝現在価格（唔係成交價！）；定價＝售價
  buyout_price INTEGER,                       -- 即決価格，冇就 null
  judged_price INTEGER,                       -- 真正攞去判斷嗰個價（見 pricing/verdict.js 拍賣陷阱）
  bids         INTEGER,
  ends_at      TEXT,                          -- 拍賣結束時間（原文字串）
  condition    TEXT,                          -- 新品 | 中古（駿河屋用）
  verdict      TEXT NOT NULL DEFAULT 'unknown', -- steal|deal|fair|pricey|absurd|auction|unknown
  ratio        REAL,                          -- judged_price / p50
  comp_n       INTEGER,
  comp_p25     INTEGER,
  comp_p50     INTEGER,
  comp_p75     INTEGER,
  comp_basis   TEXT,                          -- 用咗邊層對比群：strict-same/strict-pooled/loose-*/query/none
  comp_window  INTEGER,                       -- 實際用咗幾多日窗（90 唔夠會放寬到 180）
  notified     INTEGER NOT NULL DEFAULT 0,
  found_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(watch_id, source, item_key)
);
CREATE INDEX IF NOT EXISTS idx_listings_feed  ON listings (found_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_watch ON listings (watch_id, found_at DESC);

-- 成交價觀測。★ 用 query 字串做 key，唔用 watch_id，理由：
--  1) 刪咗個 watch 唔會連幾個月辛苦抓返嚟嘅成交歷史一齊冇（呢啲數據補唔返，
--     Yahoo 落札相場本身只留約 120 日）
--  2) 兩條 watch 用同一 keyword 就共用一次 harvest，慳一半流量
--  3) 重開返個同名 watch 即刻有歷史，唔使等 12 個鐘先判斷到嘢
CREATE TABLE IF NOT EXISTS sold_comps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  query         TEXT NOT NULL,                -- canonicalQuery(comp_keyword ?? keyword)
  source        TEXT NOT NULL,                -- yahoo-closed | mercari-sold
  item_key      TEXT NOT NULL,
  title         TEXT NOT NULL,
  norm_title    TEXT NOT NULL,                -- normalizeTitle 結果，存低唔使每次重算
  price         INTEGER NOT NULL,
  -- Yahoo 落札相場有真落札日期（sold_at_exact=1）；Mercari SOLD 頁冇日期，
  -- 用「首次見到」頂（sold_at_exact=0）。下面個 UNIQUE + INSERT OR IGNORE
  -- 保證重複 harvest 唔會刷新呢個日期 → 佢會自然老化出 90 日窗，
  -- 唔會永遠賴喺「最近成交」度扭曲個中位數。
  sold_at       TEXT NOT NULL,
  sold_at_exact INTEGER NOT NULL DEFAULT 0,
  url           TEXT,
  harvested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, item_key)
);
CREATE INDEX IF NOT EXISTS idx_comps_q ON sold_comps (query, sold_at DESC);

-- 成交價收集進度（staleness 判斷 + 排隊揀下一條去 harvest）
CREATE TABLE IF NOT EXISTS comp_runs (
  query      TEXT PRIMARY KEY,
  last_run   TEXT,
  last_ok    TEXT,
  rows_seen  INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- 「見過未」嘅底：新／舊就係睇呢張，決定使唔使推通知。
-- adapter 格式 "w<watch_id>:<source>"——同一件貨中兩條 watch 要各自通知一次。
CREATE TABLE IF NOT EXISTS snapshots (
  adapter    TEXT NOT NULL,
  item_key   TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (adapter, item_key)
);

-- 來源健康：連續抓到 0 件＝可能改咗版／被封，health.js 會警報。
-- ★ 記帳單位係「來源」唔係「來源×watch」——一條冷門關鍵字搵到 0 件係天經地義，
--   per-watch 記健康會日日誤報。要成輪掃完全部 watch 加埋都 0 件先算來源死咗。
CREATE TABLE IF NOT EXISTS source_health (
  adapter     TEXT PRIMARY KEY,
  last_run    TEXT,
  last_ok     TEXT,
  zero_streak INTEGER NOT NULL DEFAULT 0,
  alerted     INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- 通知送遞留底：送失敗淨係 console.warn 嘅話，container 一重啟就查無可查
CREATE TABLE IF NOT EXISTS notify_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,
  status     TEXT NOT NULL,                   -- ok | failed
  attempts   INTEGER NOT NULL DEFAULT 1,
  kind       TEXT,                            -- verdict，system = 系統警報
  title      TEXT,
  url        TEXT,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notify_log ON notify_log (created_at DESC);
`);

// migration：舊 DB 加欄位（已存在會 throw，照吞）——同 BeyHunter 一樣嘅土炮做法
try { db.exec(`ALTER TABLE watches ADD COLUMN comp_keyword TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE watches ADD COLUMN primed INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

// ── watches ──
export const watchList = db.prepare(`SELECT * FROM watches ORDER BY id`);
export const watchListEnabled = db.prepare(`SELECT * FROM watches WHERE enabled = 1 ORDER BY id`);
export const watchGet = db.prepare(`SELECT * FROM watches WHERE id = ?`);
export const watchByKeyword = db.prepare(`SELECT * FROM watches WHERE keyword = ?`);
export const watchInsert = db.prepare(`
  INSERT INTO watches (keyword, comp_keyword, exclude, sources, enabled, interval_s)
  VALUES (@keyword, @comp_keyword, @exclude, @sources, @enabled, @interval_s)
`);
export const watchUpdate = db.prepare(`
  UPDATE watches SET keyword=@keyword, comp_keyword=@comp_keyword, exclude=@exclude,
                     sources=@sources, enabled=@enabled, interval_s=@interval_s
  WHERE id = @id
`);
export const watchTouchRun = db.prepare(`UPDATE watches SET last_run_at = datetime('now') WHERE id = ?`);
export const watchTouchComp = db.prepare(`UPDATE watches SET last_comp_at = datetime('now') WHERE id = ?`);
export const watchMarkPrimed = db.prepare(`UPDATE watches SET primed = 1 WHERE id = ?`);

// 刪 watch：連 listings 同 snapshots 一齊清（唔清 snapshots 嘅話，日後重開
// 同名 watch 會當晒啲貨「見過」，永遠唔通知）。
// ★ 但 sold_comps 唔刪——佢係 by query 嘅共用資產，補唔返（見上面建表註解）。
const listingsDeleteByWatch = db.prepare(`DELETE FROM listings WHERE watch_id = ?`);
const snapshotsDeleteByWatch = db.prepare(`DELETE FROM snapshots WHERE adapter LIKE ?`);
const watchDelete = db.prepare(`DELETE FROM watches WHERE id = ?`);
export const deleteWatchCascade = db.transaction(id => {
  listingsDeleteByWatch.run(id);
  snapshotsDeleteByWatch.run(`w${id}:%`);
  watchDelete.run(id);
});

// 清單頁摘要：每條 watch 帶埋近 24 小時命中同成交樣本數
export const watchSummary = db.prepare(`
  SELECT w.*,
    (SELECT COUNT(*) FROM listings l
      WHERE l.watch_id = w.id AND l.found_at > datetime('now','-24 hours')) AS hits_24h,
    (SELECT COUNT(*) FROM listings l WHERE l.watch_id = w.id) AS hits_total
    -- ★ comp_n 唔喺呢度計。sold_comps.query 存嘅係 canonicalQuery() 正規化後
    --   （細楷／NFKC／剷符號）嘅字串，但 w.keyword 係原文——「BX-09」對唔到
    --   「bx-09」，個 UI 就會喺明明有 29 件成交紀錄嗰陣話你「仲未收到成交價」。
    --   SQLite 呢邊做唔到同一套正規化，所以交返畀 listWatches() 用 JS 計。
  FROM watches w ORDER BY w.id
`);

// ── listings ──
export const insertListing = db.prepare(`
  INSERT INTO listings (watch_id, source, item_key, listing_kind, title, url, price, buyout_price,
                        judged_price, bids, ends_at, condition, verdict, ratio,
                        comp_n, comp_p25, comp_p50, comp_p75, comp_basis, comp_window, notified)
  VALUES (@watch_id, @source, @item_key, @listing_kind, @title, @url, @price, @buyout_price,
          @judged_price, @bids, @ends_at, @condition, @verdict, @ratio,
          @comp_n, @comp_p25, @comp_p50, @comp_p75, @comp_basis, @comp_window, @notified)
  ON CONFLICT(watch_id, source, item_key) DO NOTHING
`);
export const listingGet = db.prepare(`
  SELECT l.*, w.keyword FROM listings l LEFT JOIN watches w ON w.id = l.watch_id WHERE l.id = ?
`);
export const updateListingPrice = db.prepare(`
  UPDATE listings SET price = ? WHERE watch_id = ? AND source = ? AND item_key = ?
`);

// feed：watch_id / verdict 兩個都係 optional filter（傳 null 就唔篩）
export const feedQuery = db.prepare(`
  SELECT l.*, w.keyword FROM listings l
  LEFT JOIN watches w ON w.id = l.watch_id
  WHERE (@watch_id IS NULL OR l.watch_id = @watch_id)
    AND (@verdict  IS NULL OR l.verdict  = @verdict)
  ORDER BY l.found_at DESC LIMIT @limit OFFSET @offset
`);
export const verdictCounts = db.prepare(`
  SELECT verdict, COUNT(*) AS n FROM listings
  WHERE (@watch_id IS NULL OR watch_id = @watch_id) GROUP BY verdict
`);

// ── sold_comps ──
// INSERT OR IGNORE 語意好重要：同一件貨再 harvest 唔會刷新 sold_at，
// 所以 Mercari 嗰啲「估算日期」會老化，唔會永遠賴住喺最近 90 日窗入面。
export const insertComp = db.prepare(`
  INSERT INTO sold_comps (query, source, item_key, title, norm_title, price, sold_at, sold_at_exact, url)
  VALUES (@query, @source, @item_key, @title, @norm_title, @price, @sold_at, @sold_at_exact, @url)
  ON CONFLICT(source, item_key) DO NOTHING
`);
export const compsForQuery = db.prepare(`
  SELECT title, norm_title, url, price, source, sold_at, sold_at_exact
  FROM sold_comps
  WHERE query = @query AND sold_at > datetime('now', @since)
  ORDER BY sold_at DESC
`);
export const compCount = db.prepare(`
  SELECT COUNT(*) AS n FROM sold_comps WHERE query = @query AND sold_at > datetime('now', @since)
`);

// ── comp_runs（成交價收集排隊）──
export const reportCompRun = db.prepare(`
  INSERT INTO comp_runs (query, last_run, last_ok, rows_seen, last_error)
  VALUES (@query, @now, CASE WHEN @ok THEN @now ELSE NULL END, @rows, @error)
  ON CONFLICT(query) DO UPDATE SET
    last_run   = @now,
    last_ok    = CASE WHEN @ok THEN @now ELSE last_ok END,
    rows_seen  = @rows,
    last_error = CASE WHEN @ok THEN NULL ELSE @error END
`);
export const compRunGet = db.prepare(`SELECT * FROM comp_runs WHERE query = ?`);
export const compRunsAll = db.prepare(`SELECT * FROM comp_runs ORDER BY query`);

// ── snapshot diff：回傳 true = 新見到（用嚟觸發通知）──
const snapshotHas = db.prepare(`SELECT 1 FROM snapshots WHERE adapter=? AND item_key=?`);
const snapshotAnyFor = db.prepare(`SELECT 1 FROM snapshots WHERE adapter=? LIMIT 1`);
// 呢個 adapter（w<id>:<來源>）有冇見過任何嘢。用嚟分辨「條 watch 第一次跑」
// 同「條 watch 跑咗好耐，但呢個來源啱啱先加入」——後者一樣要靜靜雞收錄先。
export const seenAnyItem = adapter => !!snapshotAnyFor.get(adapter);
const snapshotAdd = db.prepare(`INSERT OR IGNORE INTO snapshots (adapter, item_key) VALUES (?, ?)`);
export function isNewItem(adapter, itemKey) {
  const seen = snapshotHas.get(adapter, itemKey);
  snapshotAdd.run(adapter, itemKey);
  return !seen;
}

// ── 來源健康 ──
// itemsSeen 係「呢輪成個來源掃到幾多件」，唔係「幾多件新」——dedupe 後 0 新係正常。
// reason 只喺真係 fetch 失敗（HTTP error / timeout / DNS / 被封）先傳；
// 「站正常但 0 件」唔應該傳 reason（唔係死機，係改版或者真係搜唔到嘢）。
const upsertHealth = db.prepare(`
  INSERT INTO source_health (adapter, last_run, last_ok, zero_streak, alerted, last_error)
  VALUES (@adapter, @now, CASE WHEN @ok THEN @now ELSE NULL END, CASE WHEN @ok THEN 0 ELSE 1 END, 0,
          CASE WHEN @ok THEN NULL ELSE @reason END)
  ON CONFLICT(adapter) DO UPDATE SET
    last_run    = @now,
    last_ok     = CASE WHEN @ok THEN @now ELSE last_ok END,
    zero_streak = CASE WHEN @ok THEN 0 ELSE zero_streak + 1 END,
    alerted     = CASE WHEN @ok THEN 0 ELSE alerted END,
    last_error  = CASE WHEN @ok THEN NULL ELSE @reason END
`);
export function reportSourceHealth(adapter, itemsSeen, reason = null) {
  upsertHealth.run({ adapter, now: new Date().toISOString(), ok: itemsSeen > 0 ? 1 : 0, reason });
}
export const healthRows = db.prepare(`SELECT * FROM source_health ORDER BY adapter`);
export const markAlerted = db.prepare(`UPDATE source_health SET alerted = 1 WHERE adapter = ?`);

// ── 通知留底 ──
export const insertNotifyLog = db.prepare(`
  INSERT INTO notify_log (channel, status, attempts, kind, title, url, error)
  VALUES (@channel, @status, @attempts, @kind, @title, @url, @error)
`);
export const notifyFailures = db.prepare(`
  SELECT * FROM notify_log WHERE status = 'failed' ORDER BY created_at DESC LIMIT @limit
`);
export const notifyStats = db.prepare(`
  SELECT channel, status, COUNT(*) AS n, MAX(created_at) AS last_at
  FROM notify_log WHERE created_at > datetime('now', '-24 hours')
  GROUP BY channel, status
`);

// ── 定期清理 ──
// 注意：唔好因為「太舊」而剷 snapshots——剷完啲仲喺度賣緊嘅舊貨會當新貨再彈一次。
const pruneListings = db.prepare(`DELETE FROM listings WHERE found_at < datetime('now','-365 days')`);
const pruneComps = db.prepare(`DELETE FROM sold_comps WHERE harvested_at < datetime('now','-400 days')`);
const pruneNotifyLog = db.prepare(`DELETE FROM notify_log WHERE created_at < datetime('now','-90 days')`);
export function pruneOld() {
  const a = pruneListings.run().changes;
  const b = pruneComps.run().changes;
  const c = pruneNotifyLog.run().changes;
  if (a || b || c) console.log(`[db] 清走舊資料：listings ${a}、sold_comps ${b}、notify_log ${c}`);
}

export default db;
