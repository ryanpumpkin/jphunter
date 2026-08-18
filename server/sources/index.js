// 來源註冊表。加新站＝寫多個檔（export id/label/kind/search）再喺呢度登記。
import * as yahooAuction from './yahoo-auction.js';
import * as yahooClosed from './yahoo-closed.js';
import * as mercari from './mercari.js';
import * as surugaya from './surugaya.js';

// 新上架來源（推通知嗰啲）
export const LISTING_SOURCES = [yahooAuction, mercari, surugaya];

// 成交價來源（比價基準）
export const SOLD_SOURCES = [yahooClosed, mercari.sold];

export const ALL_SOURCES = [...LISTING_SOURCES, ...SOLD_SOURCES];

export const byId = Object.fromEntries(ALL_SOURCES.map(s => [s.id, s]));

// watches.sources 入面用嘅短名 → 實際 listing source id
export const SOURCE_IDS = LISTING_SOURCES.map(s => s.id);
