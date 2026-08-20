// 用本地 LLM 抽標題入面嘅「場次限定」同「件數」。
//
// 點解要呢個：同一個關鍵字入面，場次限定貨同普通貨價差可以幾倍——
// 實測「青木陽菜 直筆」普通單張中位 ¥5,000，但東京／福岡限定去到 ¥12,000–20,999。
// 唔分開就會攞限定價去判普通貨（報你超抵），或者反過來。
//
// 點解唔用 regex 做 venue：地名唔係封閉詞表（ブルトリ24所沢、福岡兵庫最大幸福度…），
// 而且要分「地名」同「活動名」（最大幸福度）同「買家代號」（ワ*ミ様）。
// 反之 qty／set 用 regex 反而準過 LLM，所以嗰兩樣唔靠佢。
//
// ⚠️ 實測落嚟嘅三個坑，下面每個都有對應防禦：
//   1. 模型會靜靜雞跳行——輸入 20 條淨係回 19 條，跟住 index 全部錯位，
//      每個 venue 單獨睇都合理但配錯咗貨。所以一定要叫佢回顯標題做 key，
//      唔可以靠陣列位置。
//   2. 邊緣 case 唔穩定——同一批數據兩次跑，「最大幸福度」一次 null 一次當場次。
//      所以只當佢係輔助訊號，配唔到就當「唔知」，唔猜。
//   3. 服務可能唔喺度——.68 熄咗／行緊第二樣嘢。預設關閉，開咗都要 fail-soft。
import { compsNeedingClassify, compSetClassification, compMarkClassified } from '../db.js';

const enabled = () => process.env.AI_CLASSIFY === '1' && !!process.env.AI_URL && !!process.env.AI_KEY;

// 20 條一批。實測 27B + <|think_off|> 喺呢個 size 下 20/20 零跳行、23 秒。
// （細模型 7B 喺同一個 batch 必跳行，要縮到 5；27B 唔使。）
const BATCH = 20;
const TIMEOUT_MS = 180000;

// ★ <|think_off|> 係 froggeric v22.2 chat template 提供嘅逐個 request 開關。
//   冇佢嘅話 Qwen3.8 官方 template hardcode reasoning=xhigh，一個抽取任務
//   都會燒五千幾字 thinking，同一批標題由 23 秒變 85 秒，而且答案唔會好啲。
//   要求：.68 個 llama-server 要行緊 --chat-template-file qwen_v22.jinja。
const THINK_OFF = '<|think_off|>';

const SYSTEM = `You extract structured data from Japanese secondhand listing titles.

Output ONLY a JSON array. One element per input line, same order, never skip a line.
Each element: {"t":"<echo the title EXACTLY as given>","venue":string|null}

venue = event/location-limited marker: a PLACE name tied to a limited edition.
  東京限定→"東京"　沖縄公演→"沖縄"　ブルトリ24所沢→"所沢"　大阪会場→"大阪"
NOT venues (return null): event/song names (最大幸福度、衝動ROCK、BLUE TRIP),
  buyer handles (ワ*ミ様、と*ー様), edition names (通常盤、生産限定盤).
If unsure, return null. Never invent a place that is not in the title.`;

async function askBatch(titles) {
  // 行 Anthropic /v1/messages（ccr 個 OpenAI route 會回 "Provider 'undefined'"）
  const res = await fetch(`${process.env.AI_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.AI_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'qwythos',
      max_tokens: 3000,
      // system prompt 併埋落 user message：<|think_off|> 要喺 user turn 先 strip 到
      messages: [{ role: 'user', content: `${THINK_OFF}${SYSTEM}\n\nTITLES:\n${titles.join('\n')}` }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AI ${res.status} ${(await res.text()).slice(0, 120)}`);
  const body = await res.json();
  // 回應係 block 陣列，thinking 同 text 分開。think_off 生效嘅話 thinking 應該係空。
  const text = (body?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`AI 冇回 JSON array：${text.slice(0, 120)}`);
  return JSON.parse(m[0]);
}

// 回傳 Map<原標題, venue|null>。配唔返輸入嘅一律唔要——
// 寧願當「未分類」都好過將 A 貨嘅場次貼咗落 B 貨度。
async function classifyTitles(titles) {
  const out = new Map();
  let rows;
  try {
    rows = await askBatch(titles);
  } catch (err) {
    console.warn('[classify] 呢批失敗：', err.message);
    return out;
  }
  const want = new Set(titles);
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = typeof r?.t === 'string' ? r.t.trim() : '';
    if (!want.has(t) || out.has(t)) continue;      // 配唔到／重複 → 丟
    const v = typeof r.venue === 'string' ? r.venue.trim() : '';
    // 模型間中會回一個唔喺標題入面嘅地名（幻覺）。標題度搵唔到就唔要。
    out.set(t, v && t.includes(v) ? v : null);
  }
  return out;
}

// 跑一輪：攞未分類嘅 comps，分批問，寫返落 DB。
// 回傳 { done, venues, skipped }。
export async function classifyPending({ limit = 60 } = {}) {
  if (!enabled()) return { done: 0, venues: 0, skipped: 0, off: true };

  const pending = compsNeedingClassify.all({ limit });
  if (!pending.length) return { done: 0, venues: 0, skipped: 0 };

  let done = 0, venues = 0, skipped = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    const got = await classifyTitles(chunk.map(r => r.title));
    for (const row of chunk) {
      if (got.has(row.title)) {
        const venue = got.get(row.title);
        compSetClassification.run({ id: row.id, venue, qty: null });
        done++;
        if (venue) venues++;
      } else {
        // 配唔到（跳咗行／回顯唔一致）。照樣印 cls_at，唔係下轉又揀返同一批，
        // 永遠卡喺度重試。當「分類過但冇結果」處理。
        compMarkClassified.run({ id: row.id });
        skipped++;
      }
    }
  }
  console.log(`[classify] 處理 ${done + skipped} 件：${venues} 件有場次、${skipped} 件配唔到`);
  return { done, venues, skipped };
}
