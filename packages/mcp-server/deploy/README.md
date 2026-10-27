# Deploy the Plumb MCP server

Public HTTPS URL with one bearer token per tool. Claude chat and remote clients need this.

## Local

From the repo root, with Supabase and Meta keys already in `.env`:

```bash
# generate tokens once (do not commit them)
openssl rand -hex 24   # paste into each PLUMB_TOKEN_* in .env

pnpm --filter @plumb/mcp-server dev
# http://127.0.0.1:8787/health
# Authorization: Bearer <PLUMB_TOKEN_...>
```

## Railway

1. `railway login` then `railway init -n plumb` and `railway add -s mcp` (or create in the UI).
2. Repo-root `railway.toml` points at `packages/mcp-server/deploy/Dockerfile`. Also set service var `RAILWAY_DOCKERFILE_PATH=packages/mcp-server/deploy/Dockerfile` so Railpack does not win.
3. Variables (same names as `.env`):

   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `META_MODEL_API_KEY`
   - `PLUMB_TOKEN_CLAUDE_CODE`
   - `PLUMB_TOKEN_CURSOR`
   - `PLUMB_TOKEN_CLAUDE_CHAT`
   - `PLUMB_TOKEN_WATCHERS`
   - `PLUMB_TOKEN_WEB`
   - optional: `PLUMB_PROMPTS_DIR=/app/prompts` (Dockerfile already sets this)

4. Generate a public domain. Health check: `GET /health`.
5. Point local tools at it:

   - `PLUMB_MCP_URL=https://<host>/mcp`
   - `PLUMB_INGEST_URL=https://<host>/ingest`
   - `PLUMB_MCP_TOKEN` / `PLUMB_INGEST_TOKEN` = the matching tool token (web uses `PLUMB_TOKEN_WEB`)

## Client snippets

Cursor `.cursor/mcp.json` (after deploy):

```json
{
  "mcpServers": {
    "plumb": {
      "url": "https://<host>/mcp",
      "headers": {
        "Authorization": "Bearer <PLUMB_TOKEN_CURSOR>"
      }
    }
  }
}
```

REST (watchers, homepage proxy):

```bash
curl -sS -H "Authorization: Bearer $PLUMB_TOKEN_WATCHERS" \
  -H "content-type: application/json" \
  -d '{"kind":"clock","source":{"kind":"manual","external_id":"clock"},"occurred_at":"2026-10-26T12:00:00.000Z","summary":"tick"}' \
  https://<host>/tools/record_event
```
