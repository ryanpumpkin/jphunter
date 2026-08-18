// 設定 store（設定頁改得到，存 JSON 檔）。
// DATA_DIR 指定位置（Docker 掛 volume 先持久化），預設放 server/ 隔離。
// Telegram token 存喺呢度嘅好處：唔使入 container 改 .env 再重啟。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(process.env.DATA_DIR || __dirname, 'jphunter-settings.json');

const DEFAULTS = { telegram: { token: '', chatId: '' } };

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(next) {
  cache = next;
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return cache;
}

// 驗證＋寫入（系統邊界，嚴格啲）。token 只會寫入，唔會經 API 讀返出去。
export function setTelegram({ token, chatId }) {
  const s = getSettings();
  const next = { ...s, telegram: { ...s.telegram } };
  if (token != null) {
    const t = String(token).trim();
    if (t && !/^\d{6,}:[\w-]{20,}$/.test(t)) throw new Error('Bot token 格式唔似樣（應該係 123456:AA...）');
    next.telegram.token = t;
  }
  if (chatId != null) {
    const c = String(chatId).trim();
    if (c && !/^-?\d{1,20}$/.test(c)) throw new Error('Chat ID 要係數字（群組會係負數）');
    next.telegram.chatId = c;
  }
  return saveSettings(next);
}

// 出街版本：唔會漏 token 出去，只講設定咗未
export function publicSettings() {
  const s = getSettings();
  return {
    telegram: {
      hasToken: !!s.telegram?.token,
      chatId: s.telegram?.chatId || '',
      fromEnv: !!(process.env.TELEGRAM_BOT_TOKEN && !s.telegram?.token),
    },
  };
}
