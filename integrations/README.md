# integrations

Owned by Cursor. Write-back hooks and MCP client configs so Claude Code and Cursor read/write Plumb.

## Layout

| Path | Role |
| --- | --- |
| `lib/ingest.mjs` | Shared POST `/ingest` and `get_project_state` helpers. Sends **text**, never a file path. |
| `cursor/hooks/` | Cursor `sessionStart`, `afterAgentResponse`, `stop` scripts |
| `claude-code/hooks/` | Claude Code `SessionStart`, `Stop`, `SessionEnd` scripts |
| `.cursor/hooks.json` | Wired at repo root (points at `integrations/cursor/hooks`) |
| `.claude/settings.json` | Claude Code project hooks |
| `mcp.example.json` | Template for remote MCP (no secrets) |

Local files with bearer tokens (gitignored): `.cursor/mcp.json`, `.mcp.json`.

## Env

From repo-root `.env`:

- `PLUMB_PROJECT_ID` (Meta hackathon project id)
- `PLUMB_INGEST_URL` / `PLUMB_MCP_URL`
- `PLUMB_TOKEN_CURSOR`, `PLUMB_TOKEN_CLAUDE_CODE`

## Notes

- Cursor hooks only send data out. Do not rely on hook stdout reaching the model except `sessionStart.additional_context`.
- Claude Code `Stop` uses `last_assistant_message` and always exits 0 (no stop loops). `SessionEnd` ingest is off unless `PLUMB_CLAUDE_SESSION_END_INGEST=1`.
- Reload Cursor / Claude Code after changing hook configs.
