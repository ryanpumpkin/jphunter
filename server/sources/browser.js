// Playwright 單例。Mercari 係 SPA，普通 fetch 攞唔到貨，要開真瀏覽器。
// 全 app 共用一個 browser instance（開一個 Chromium 食 ~300MB，唔好開多個），
// 每次抓取開一個 fresh context 再閂——context 平，browser 貴。
import { chromium } from 'playwright';

let browser = null;
let launching = null;

export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  // CHROMIUM_PATH：畀你指定部機上面現成嘅 Chromium。
  // 用途係環境已經裝咗 Chromium，但版本同 package.json 個 playwright 唔夾
  // （Playwright 會死撐要搵佢自己嗰個 build），咁就唔使再裝多份。
  // 平時唔使理——Docker image 已經內置啱版本嘅。
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  launching = chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  }).then(b => {
    browser = b;
    launching = null;
    b.on('disconnected', () => { browser = null; });
    return b;
  }).catch(err => {
    launching = null;
    console.warn('[browser] Chromium 起唔到：', err.message,
      '\n  → 未裝過就跑 npx playwright install chromium'
      + '\n  → 部機已經有 Chromium 但版本唔夾，可以設 CHROMIUM_PATH=/路徑/去/chrome');
    return null;
  });
  return launching;
}

// 開一個乾淨 context，image/media/font 一律 abort（慳頻寬兼快好多）
// hardMs：包住成個操作嘅硬性總時限。★ 唔可以淨係靠 page.setDefaultTimeout()／
// goto 個 timeout——實測駿河屋嘅 Cloudflare 驗證頁永遠唔會 fire domcontentloaded，
// 撞到嗰陣 goto 連自己個 60s timeout 都唔會觸發，成個 call 卡足 9 分鐘要人手剷。
// 一條 sweep 咁樣吊死係靜靜雞死：冇 error、冇警報，你淨係會覺得「好耐冇通知」。
export async function withPage(fn, { timeoutMs = 45000, hardMs = timeoutMs * 2 } = {}) {
  const b = await getBrowser();
  if (!b) throw new Error('Chromium 未裝／起唔到');
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
    });
    let hardTimer;
    try {
      return await Promise.race([
        fn(page),
        new Promise((_, reject) => {
          hardTimer = setTimeout(
            () => reject(new Error(`成個抓取行咗 ${Math.round(hardMs / 1000)}s 都未完，強制放棄（個頁可能永遠唔會載完）`)),
            hardMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(hardTimer);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
  browser = null;
}
