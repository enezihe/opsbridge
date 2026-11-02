# Build context is the repo root: docker build -f services/gateway/Dockerfile .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/gateway/package.json services/gateway/
RUN npm ci --omit=dev --workspace @opsbridge/gateway --include-workspace-root=false

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY packages/common packages/common
COPY services/gateway services/gateway
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "services/gateway/src/server.js"]
