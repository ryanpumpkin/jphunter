# ── Stage 1: 起前端 (Vite build) ──
FROM node:20-bookworm-slim AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ── Stage 2: 執行階段 ──
# 用 Playwright 官方 image：已內置所有 Chromium 要嘅系統依賴（noble 底），
# Mercari 兩個 adapter 靠佢跑。
#
# ★ base image 個版本同 npm 個 playwright 唔一定夾——image 淨係帶當時嗰版
#   Chromium binary，npm 一升版就會去搵一個唔存在嘅 chromium_headless_shell-xxxx，
#   兩個 Mercari adapter 即刻全死（實測過：^1.61.1 飄到 1.62.1 就係咁）。
#   所以下面明確再 install 一次 chromium，用 npm 裝咗嗰版嚟定，
#   唔靠 base image 附送嗰個。package.json 亦都釘死咗版本唔用 caret。
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS runtime
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# 只拉 browser binary（~170MB），唔使換成個 2GB base image。
# 系統依賴 base image 已經有，所以唔加 --with-deps（加咗會 apt-get update 吊死，見 CI 註解）。
RUN npx playwright install chromium

COPY server/ ./server/
COPY --from=web-builder /app/web/dist ./web/dist

ENV NODE_ENV=production
ENV PORT=3000
# 持久化資料（SQLite DB）走呢個路徑，記得掛 volume
ENV DB_PATH=/app/data/jphunter.db
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
