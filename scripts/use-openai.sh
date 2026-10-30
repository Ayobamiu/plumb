#!/usr/bin/env bash
# Point the mcp server at OpenAI while Meta's models are unreachable from Railway,
# and turn the contributor fallback off. Reads the key from .env; never prints it.
# Back to Meta: remove PLUMB_MODEL_BASE_URL, PLUMB_MODEL_API_KEY and PLUMB_MODEL_ID on mcp.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=$(grep -E "^OPENAI_API_KEY=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
[ -n "$KEY" ] || { echo "Missing OPENAI_API_KEY in .env"; exit 1; }
railway variables --service mcp --skip-deploys \
  --set "PLUMB_MODEL_BASE_URL=https://api.openai.com/v1" \
  --set "PLUMB_MODEL_API_KEY=$KEY" \
  --set "PLUMB_MODEL_ID=gpt-5.4-mini" \
  --set "PLUMB_ALLOW_CONTRIBUTOR=0" >/dev/null
echo "mcp variables set; deploying"
railway up --service mcp --detach
railway up --service web --detach
