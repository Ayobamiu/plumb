# Muse Code → Plumb (optional fourth tool)

Muse Code supports MCP and project rules, so it can read/write Plumb like Cursor and Claude Code.

## MCP

In `~/.config/muse/settings.json` (`schema_version` must be 1):

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "plumb": {
      "transport": "streamable_http",
      "url": "https://mcp-production-a566.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer <PLUMB_TOKEN_MUSE_CODE>"
      },
      "enabled": true,
      "mode": "optional"
    }
  }
}
```

Use `PLUMB_TOKEN_MUSE_CODE` (in repo `.env` and on the Railway mcp service). Muse expands `${VAR}` if you prefer that over pasting the bearer.

Docs: https://dev.meta.ai/docs/muse-code/extending

## Rules

`muse init` writes `AGENTS.md`. Muse also accepts `CLAUDE.md`. Point the file at Plumb: call `get_project_state` at session start; keep claims honest when decisions change.

## Write-back

Muse has hooks in settings. Wire a SessionEnd-style hook to POST transcript text to `/ingest` the same way Claude Code does, when you want automatic write-back. Until then, call MCP tools or paste notes on the homepage.
