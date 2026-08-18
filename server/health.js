// 來源健康監察：每輪 sweep 完會 reportSourceHealth(sourceId, 總件數)。
// 呢度定時掃 source_health，發現「連續 N 輪抓到 0 件」或者「太耐冇成功過」
// 就推一條系統警報。每個來源只警一次（alerted flag），復原會自動 reset。
import { healthRows, markAlerted } from './db.js';
import { alertSystem } from './notify.js';

const ZERO_STREAK_THRESHOLD = 4;          // 連續 4 輪 0 件 → 警報
const STALE_MS = 6 * 60 * 60 * 1000;      // 6 個鐘冇成功過 → 警報
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 半個鐘檢查一次

export function checkSourceHealth() {
  const now = Date.now();
  for (const row of healthRows.all()) {
    if (row.alerted) continue;
    const lastOkAge = row.last_ok ? now - Date.parse(row.last_ok) : Infinity;
    // 死因：真係 fetch 失敗（HTTP error / timeout / 被封）先有 last_error；
    // 「站正常但抓到 0 件」last_error 係 null，當改版講。
    const cause = row.last_error ? `\n死因：${row.last_error}` : '';
    let msg = null;
    if (row.zero_streak >= ZERO_STREAK_THRESHOLD) {
      msg = row.last_error
        ? `來源「${row.adapter}」連續 ${row.zero_streak} 輪抓唔到嘢，去 check 下。${cause}`
        : `來源「${row.adapter}」連續 ${row.zero_streak} 輪抓到 0 件——可能改咗版或者被封。\n`
          + `喺部機跑 node server/probe.js ${row.adapter} "你條關鍵字" 睇下邊層 selector 死咗。`;
    } else if (row.last_run && lastOkAge > STALE_MS) {
      const hrs = Math.round(lastOkAge / 3600000);
      msg = `來源「${row.adapter}」已經 ${hrs} 小時冇成功抓到嘢（最後成功：${row.last_ok || '從未'}）。${cause}`;
    }
    if (msg) {
      console.warn('[health]', msg);
      markAlerted.run(row.adapter);
      alertSystem(msg);
    }
  }
}

export function startHealthMonitor() {
  // 開機唔即刻查（俾來源先跑一輪），半個鐘後開始
  const t = setInterval(checkSourceHealth, CHECK_INTERVAL_MS);
  t.unref?.();
  return t;
}
