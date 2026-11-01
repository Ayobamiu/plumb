# Build from the repo root:
#   docker build -f packages/watchers/deploy/Dockerfile -t plumb-watchers .
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/watchers/package.json packages/watchers/
RUN pnpm install --frozen-lockfile --filter @plumb/watchers...

FROM deps AS runner
COPY packages/core packages/core
COPY packages/watchers packages/watchers
ENV NODE_ENV=production
WORKDIR /app/packages/watchers
CMD ["pnpm", "exec", "tsx", "src/worker.ts"]
