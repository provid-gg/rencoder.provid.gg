# ─── Build stage ──────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm i

COPY . .
RUN npm run build:ts && npm run build:css

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm i

COPY --from=builder /app/dist    ./dist
COPY --from=builder /app/public  ./public
COPY --from=builder /app/scripts ./scripts
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

CMD ["./entrypoint.sh"]
