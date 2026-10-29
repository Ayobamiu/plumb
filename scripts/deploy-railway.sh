#!/usr/bin/env bash
# Deploy Plumb to Railway: the mcp server (per user) and the homepage (web).
# Reads values from the repo-root .env and never prints them. Safe to rerun.
# Run from the repo root: bash scripts/deploy-railway.sh
set -euo pipefail
cd "$(dirname "$0")/.."

val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
need() { [ -n "$(val "$1")" ] || { echo "Missing $1 in .env"; exit 1; }; }
for k in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY PLUMB_OWNER_USER_ID; do need "$k"; done
MCP_URL="https://mcp-production-a566.up.railway.app"

echo "1/4 mcp: owner variable, then deploy"
railway variables --service mcp --skip-deploys --set "PLUMB_OWNER_USER_ID=$(val PLUMB_OWNER_USER_ID)" >/dev/null
railway up --service mcp --detach

echo "2/4 web: create the service if it isn't there"
railway add --service web >/dev/null 2>&1 || true

echo "3/4 web: variables, then deploy"
railway variables --service web --skip-deploys \
  --set "SUPABASE_URL=$(val SUPABASE_URL)" \
  --set "SUPABASE_SERVICE_ROLE_KEY=$(val SUPABASE_SERVICE_ROLE_KEY)" \
  --set "NEXT_PUBLIC_SUPABASE_URL=$(val NEXT_PUBLIC_SUPABASE_URL)" \
  --set "NEXT_PUBLIC_SUPABASE_ANON_KEY=$(val NEXT_PUBLIC_SUPABASE_ANON_KEY)" \
  --set "PLUMB_API_URL=$MCP_URL" \
  --set "RAILWAY_DOCKERFILE_PATH=apps/web/deploy/Dockerfile" >/dev/null
railway up --service web --detach

echo "4/4 web: public URL"
railway domain --service web || true
echo
echo "Next: set PLUMB_WEB_URL on mcp to that URL (railway variables --service mcp --set PLUMB_WEB_URL=https://...),"
echo "and add it to Supabase > Authentication > URL Configuration (Site URL and Redirect URLs)."
