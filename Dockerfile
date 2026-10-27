# Build from the repo root:
#   docker build -f packages/mcp-server/deploy/Dockerfile -t plumb-mcp .
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN pnpm install --frozen-lockfile --filter @plumb/mcp-server...

FROM deps AS runner
COPY packages/core packages/core
COPY packages/mcp-server packages/mcp-server
COPY prompts prompts
ENV NODE_ENV=production
ENV PLUMB_PROMPTS_DIR=/app/prompts
ENV HOST=0.0.0.0
EXPOSE 8787
WORKDIR /app/packages/mcp-server
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
