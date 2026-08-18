// 來源模組共用工具。
// ★ 呢層（sources/*）係純粹抓＋parse：唔掂 DB、唔通知、唔判斷。
//   咁樣 probe.js 同「試搜」先至做得到 dry-run，pricing 亦都測試得到。
//   寫 DB／派通知係 ingest.js 嘅事。

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchWithUA(url, opts = {}) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs || 20000),
    ...opts,
  });
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

// 死因格式化，畀失敗分支傳去 reportSourceHealth(id, 0, reason)
export function httpReason(res) {
  return `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
}
export function errReason(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout（20s 冇回應）';
  return err?.cause?.code || err?.code || err?.message || String(err);
}

// dedupe key 用 URL 做底，但 tracking 參數（utm、fbclid 呢啲）會令同一件貨
// 睇落係新 URL → 重複通知。淨係剷已知 tracking 參數＋hash，唔郁其他 query
// （有啲站件貨 id 就係喺 query 度，全剷會炒車）。
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|yclid$|msclkid$|ref$|ref_|srsltid$|_gl$)/i;
export function normalizeKey(key) {
  if (!key || !/^https?:\/\//i.test(key)) return key;
  try {
    const u = new URL(key);
    for (const p of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(p)) u.searchParams.delete(p);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return key;
  }
}

// 「¥3,800」「3,800円」「3800 円」→ 3800。攞唔到回 null。
export function parseYen(text) {
  if (text == null) return null;
  const m = String(text).replace(/[０-９，]/g, c =>
    c === '，' ? ',' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  ).match(/([\d,]+)\s*(?:円|¥)|(?:¥|￥)\s*([\d,]+)/);
  if (!m) return null;
  const n = parseInt((m[1] || m[2] || '').replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Yahoo 落札相場個「終了日時」冇年份（例：「1/23 22:05」）。
// 陷阱：直接當今年會令 12 月嘅成交喺 1 月變成「11 個月後」——即係未來，
// 直接飛出 90 日窗。做法：當今年，若果算出嚟喺未來就減一年。
// 時間一律當 JST（+09:00）再轉 ISO UTC。
export function parseJpDate(text, now = new Date()) {
  if (!text) return null;
  const s = String(text).normalize('NFKC');
  // 完整年份：2025年1月23日 / 2025/1/23
  let m = s.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
  if (m) return jstIso(+m[1], +m[2], +m[3], s);
  // 冇年份：1/23 22:05 或 1月23日
  m = s.match(/(\d{1,2})[月/](\d{1,2})/);
  if (!m) return null;
  const month = +m[1], day = +m[2];
  let year = now.getUTCFullYear();
  let iso = jstIso(year, month, day, s);
  if (iso && Date.parse(iso) > now.getTime() + 86400_000) iso = jstIso(year - 1, month, day, s);
  return iso;
}

function jstIso(y, mo, d, src) {
  if (!(y > 1990 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const t = src.match(/(\d{1,2}):(\d{2})/);
  const hh = t ? +t[1] : 0, mm = t ? +t[2] : 0;
  const p = n => String(n).padStart(2, '0');
  const dt = new Date(`${y}-${p(mo)}-${p(d)}T${p(hh)}:${p(mm)}:00+09:00`);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

// 相對時間（Yahoo 拍賣列表個「残り 2日」）原樣留返做顯示用字串，唔試住當日期解
export const cleanText = s => String(s ?? '').replace(/\s+/g, ' ').trim();
