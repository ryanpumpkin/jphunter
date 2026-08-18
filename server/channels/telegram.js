// Telegram 推播 channel。設 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID（BotFather 免費開）。
// Channel 介面：name / enabled() / send(text, ev) / init?()——
// 日後加 WhatsApp 就照呢個 shape 寫多個檔，再 push 落 notify.js 個 CHANNELS array。
import { getSettings } from '../settings.js';

export const name = 'telegram';

// 設定可以由 .env 或者設定頁改（設定頁優先，改完唔使重啟）
function creds() {
  const s = getSettings().telegram || {};
  return {
    token: s.token || process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: s.chatId || process.env.TELEGRAM_CHAT_ID || '',
  };
}

export const enabled = () => {
  const { token, chatId } = creds();
  return !!(token && chatId);
};

export async function send(text) {
  const { token, chatId } = creds();
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status} ${await res.text()}`);
}
