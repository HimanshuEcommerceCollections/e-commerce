# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies in their own layer so source edits don't reinstall them. The
# schema comes first: npm ci's postinstall runs `prisma generate`, which picks
# the query engine for this (Alpine/musl) platform.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
# Prisma's query engine links against OpenSSL.
RUN apk add --no-cache openssl

ENV NODE_ENV=production \
    SERVER_PORT=8080

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- "http://localhost:${SERVER_PORT}/actuator/health/readiness" || exit 1

# Migrate (or adopt a Flyway-built database), then serve.
CMD ["sh", "-c", "node dist/scripts/migrate.js && exec node dist/server.js"]
