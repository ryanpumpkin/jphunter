# JPHunter

[![CI](https://github.com/ryanpumpkin/jphunter/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanpumpkin/jphunter/actions/workflows/ci.yml)

日本二手市場**關鍵字追蹤 + 成交價比價**通知器。

打一個日文關鍵字（例：`青木陽菜 直筆`），佢會定時巡日本幾個二手平台，
一有**新上架**就推 Telegram，兼**夾埋真實成交價話你知抵唔抵**：

```
✅ 🇯🇵 Yahoo!拍賣（即決）｜青木陽菜 直筆
青木陽菜 直筆サイン入りチェキ 2025 生誕祭 限定
💴 即決價 ¥3,800
✅ 抵｜即決價 ¥3,800 — 比近 90 日成交中位數 ¥5,250 平 28%
　 P25 ¥4,950・P75 ¥5,575・8 件成交・平過 100% 成交
🔗 https://page.auctions.yahoo.co.jp/jp/auction/...
```

## 監察邊幾個站

| 用途 | 來源 |
|---|---|
| 新上架（推通知） | Yahoo!オークション、Mercari、~~駿河屋~~（見下） |
| 成交價（比價基準） | Yahoo!落札相場、Mercari 已售出 |

「成交價」係**真係賣咗出去嘅價**，唔係而家喺度叫緊嘅價——呢個先係判斷貴唔貴嘅底。

> **駿河屋暫時用唔到**（2026-08-19 實測）。站方開咗 Cloudflare Managed Challenge，
> 所有請求連首頁都回 403 `cf-mitigated: challenge`。試過加齊真瀏覽器 header、
> 用 Playwright 開真 Chromium 等足 60 秒，都一直卡喺「しばらくお待ちください...」，
> 一件貨都攞唔到。**唔係改版、唔係你條線有問題、換 IP 都冇用。**
> 要過就得靠偽造瀏覽器指紋嗰類手段，條款風險高，本專案唔行呢條路——
> 同刻意唔用 Mercari 內部 API 係同一把尺。
> 佢日站方收返個驗證就會自動恢復，`probe.js surugaya "<關鍵字>"` 一試就知。

## 點跑

```bash
npm install
npx playwright install chromium      # Mercari 要真瀏覽器
cp .env.example .env                 # 填 Telegram token / chat id
npm run dev                          # server :3000 + web :5174
```

開 http://localhost:5174 → 「關鍵字」→ 打關鍵字 → 撳**試搜**睇下撈到啲乜 → 滿意先「開始監察」。

Docker：

```bash
docker compose up --build            # http://localhost:8101
```

## 抵買判斷點計

1. 攞呢條關鍵字近 **90 日**嘅成交紀錄（唔夠 5 件就放寬到 180 日）。
2. 用**日文標題相似度**（字元 bigram + Jaccard）篩走唔同款嘅貨——
   唔想 ¥300 嘅生写真同 ¥40,000 嘅直筆チェキ撈埋一齊計。
3. **IQR 剪枝**剷走極端值，再計 **P25 / 中位數 / P75**。
   一律用中位數，唔用平均數——拍賣數據重尾，一件癲價貨可以將平均數扯高幾倍。
4. 同「攞嚟比嘅價」比，出判斷：

   | 比中位數 | 判斷 |
   |---|---|
   | ≤ 60%（且跌穿 P25） | 🔥 超抵 |
   | 60–85% | ✅ 抵 |
   | 85–115% | 😐 合理 |
   | 115–145% | ⚠️ 偏貴 |
   | > 145%（且高過 P75） | 🚫 離譜 |

   成交樣本少過 5 件 → ❓ **樣本不足**，唔會砌個假判斷出嚟呃你。

### ★ 拍賣陷阱（呢個要特別講）

Yahoo 拍賣個「現在価格」**唔係成交價**。啱啱開嘅拍賣企喺 ¥100，
唔代表「平 98%」，只係代表**仲未有人叫價**。所以：

| 情況 | 點處理 |
|---|---|
| Mercari／駿河屋（定價） | 直接用個售價比 |
| Yahoo 拍賣**有即決価格** | 用即決價比（即刻買得走，性質同定價一樣） |
| Yahoo 拍賣**冇即決** | 🔨 **唔出抵/貴判斷**，改為畀個「出到 ¥X 以內先算抵」嘅上限 |

### 場次限定貨（AI 分類，可選）

同一個關鍵字入面，場次限定貨可以貴普通貨 2–3 倍（實測東京 avg ¥10,575 vs 千葉 ¥5,024）。
溝埋一齊計就兩邊都錯：判限定貨會報「超抵」，判普通貨個中位數會俾限定貨扯高。

開咗 `AI_CLASSIFY=1`（見 `.env.example`）之後：

- 本機／內網 LLM 會逐件成交抽個場次出嚟，寫落 `sold_comps.venue`（每件只跑一次，之後永久重用）
- 判**普通貨**：所有有場次嘅成交紀錄一律剔走
- 判**限定貨**：認到場次就淨係同同場次比（`venue-same`／`venue-loose`），
  唔夠 5 件同場次就跌返落普通群——嗰陣會顯得偏貴，方向係安全嘅

新上架冇經過 LLM：係攞成交紀錄學返嚟嘅地名做詞表去對，所以判斷本身唔使等 LLM，離線都行到。
唔開呢個功能，行為同以前一模一樣。

## 頭一日會點

新開一條關鍵字，**第一輪只會靜靜雞收錄現有嘅貨，唔推通知**——
唔係咁嘅話三個站 × 30 件即刻洗你版。之後真係有新上架先會推你。

成交價會喺開新關鍵字時即刻收一次（插隊），之後 12 個鐘自動更新一次。

## 邊個站壞咗點知 / 點修

呢類 scraper 一定會壞（人哋改版、封 IP）。兩重保險：

**1. 自動警報**——連續 4 輪抓到 0 件，Telegram 會收到系統警報。

**2. `probe.js` 逐層診斷**——喺你部機（網絡通到日本站嗰部）跑：

```bash
node server/probe.js --all "青木陽菜 直筆"        # 五個來源逐個試
node server/probe.js --verdict "青木陽菜 直筆"    # 埋埋判斷一齊睇，唔寫 DB
node server/probe.js yahoo-auction "..." --save-html /tmp/x.html
```

抓到 0 件佢會話你知**邊層 selector 死咗**：

```
[probe] yahoo-auction 抓到 0 件。逐層檢查：
  tier1 __NEXT_DATA__ / PRELOADED_STATE：0 件
  tier2 li.Product + .Product__titleLink：0 件
  tier3 [class*=Product] + a[href*=/auction/]：0 件
  tier4 a[href*=/jp/auction/] 掃街：0 件
→ 個站好可能改咗版。做法：…
```

每個來源嘅 selector 都分咗 3–4 層（內嵌 JSON → class → 鬆啲嘅 class → 掃街後備），
改一層唔會影響其他層。`probe.js` 刻意**唔 import `db.js` 同 `notify.js`**，
結構上保證佢寫唔到嘢、send 唔到嘢——改嘢嗰陣唔好破壞呢個約束。

## 測試

```bash
npm test                  # 判斷邏輯 + parser，離線都跑到
npm run test:pricing      # 只跑抵買判斷（23 個 case）
npm run test:parsers      # 只跑 parser（用假 HTML，要 Chromium）
```

`test:pricing` 係最重要嗰個——佢驗緊呢個 app 嘅核心價值，
包括「競投中嘅 ¥100 拍賣**唔可以**報做超抵」呢條 regression。

## 其他

```bash
npm run fetch                    # 手動巡一次（唔使長開 server）
npm run fetch -- --comps         # 順手收埋成交價
CHROMIUM_PATH=/path/to/chrome    # 部機有 Chromium 但版本唔夾嗰陣用
```

**出街之前記得設 `ADMIN_TOKEN`**——冇嘅話任何人都改到你嘅追蹤、
借你個 bot 發訊息、兼叫你個 server 狂咁去打日本站（幫你搵封 IP）。

## 禮貌 / 條款

全部係公開頁面、個人自用、低頻率（每個來源 3–8 秒隔一次，Mercari 最鬆）。
俾人擋咗會自動退避（15 分鐘起，封頂 4 個鐘）。
**唔好**為咗快而調高頻率或者加 concurrency——三個站嘅 ToS 都唔鼓勵自動化存取。

刻意冇用 Mercari 內部 API（要 DPoP 簽名、條款風險高、一改就死），寧願慢啲爬公開頁。
