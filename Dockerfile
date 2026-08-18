# ── Stage 1: 起前端 (Vite build) ──
FROM node:20-bookworm-slim AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ── Stage 2: 執行階段 ──
# 用 Playwright 官方 image（版本要同 package.json 嘅 playwright 一致），
# 已內置 Chromium + 所有系統依賴——Mercari 兩個 adapter 靠佢跑。
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS runtime
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

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
