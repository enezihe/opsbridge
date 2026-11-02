# Build context is the repo root: docker build -f services/worker/Dockerfile .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/worker/package.json services/worker/
RUN npm ci --omit=dev --workspace @opsbridge/worker --include-workspace-root=false

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY packages/common packages/common
COPY services/worker services/worker
USER node
EXPOSE 9100
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:9100/ || exit 1
CMD ["node", "services/worker/src/server.js"]
