# ═══════════════════════════════════════════════════════════════
#  YPN Backend — Dockerfile
#  Node 20 Alpine · Two-stage · Non-root · Local server
# ═══════════════════════════════════════════════════════════════

# ── Stage 1: install deps ──────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: lean runtime image ───────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup -S ypn && adduser -S ypn -G ypn

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN chown -R ypn:ypn /app
USER ypn

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]