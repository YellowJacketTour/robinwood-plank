# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS tools
COPY scripts/migrate-postgres.mjs ./scripts/migrate-postgres.mjs
COPY deploy/inmotion/postgres ./deploy/inmotion/postgres
CMD ["node", "scripts/migrate-postgres.mjs"]

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are intentionally build-time inputs: Next.js inlines
# them into browser bundles. Server secrets are never accepted as build args.
ARG DEPLOYMENT_VERSION=local
ARG NEXT_PUBLIC_MARKET_ENABLED=false
ARG NEXT_PUBLIC_MARKET_VAULT_ADDRESS
ARG NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS
# Preferred: comma-separated list of ALL legacy vaults (V1,V2,...). The singular
# above is still read as a one-release fallback when this is unset.
ARG NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES
ARG NEXT_PUBLIC_MINT_START_AT
ARG NEXT_PUBLIC_ROBINHOOD_RPC_URL
ARG NEXT_PUBLIC_RULES_RELAXED=false
ARG NEXT_PUBLIC_SITE_URL=https://plank.love
ARG NEXT_PUBLIC_TRADE_OPENS_AT
ARG NEXT_PUBLIC_TRADE_PAUSED=false
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
ENV NEXT_PUBLIC_MARKET_ENABLED=$NEXT_PUBLIC_MARKET_ENABLED
ENV NEXT_PUBLIC_MARKET_VAULT_ADDRESS=$NEXT_PUBLIC_MARKET_VAULT_ADDRESS
ENV NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS=$NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS
ENV NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES=$NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES
ENV NEXT_PUBLIC_MINT_START_AT=$NEXT_PUBLIC_MINT_START_AT
ENV NEXT_PUBLIC_ROBINHOOD_RPC_URL=$NEXT_PUBLIC_ROBINHOOD_RPC_URL
ENV NEXT_PUBLIC_RULES_RELAXED=$NEXT_PUBLIC_RULES_RELAXED
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_TRADE_OPENS_AT=$NEXT_PUBLIC_TRADE_OPENS_AT
ENV NEXT_PUBLIC_TRADE_PAUSED=$NEXT_PUBLIC_TRADE_PAUSED
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ARG DEPLOYMENT_VERSION=local
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /app/.next/cache /app/data /app/.data \
  && chown -R nextjs:nodejs /app

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
