# The Plumb homepage (Next.js). Build from the repo root:
#   docker build -f apps/web/deploy/Dockerfile -t plumb-web .
# NEXT_PUBLIC_* values are baked in at build time; Railway passes service
# variables to the build as these ARGs. Never set the Google OAuth variables
# here: Gmail connect stays a local-only flow.
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @plumb/web...

FROM deps AS build
COPY packages/core packages/core
COPY apps/web apps/web
RUN rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @plumb/web build

FROM build AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["sh", "-c", "pnpm exec next start --hostname 0.0.0.0 --port ${PORT:-3000}"]
