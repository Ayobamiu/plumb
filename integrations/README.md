# integrations

Owned by Cursor. Write-back hooks and MCP client configs so Claude Code and Cursor read/write Plumb.

## Layout

| Path | Role |
| --- | --- |
| `lib/ingest.mjs` | Shared POST `/ingest` and `get_project_state` helpers. Sends **text**, never a file path. |
| `cursor/hooks/` | Cursor `sessionStart`, `afterAgentResponse`, `stop` scripts |
| `claude-code/hooks/` | Claude Code `SessionStart`, `Stop`, `SessionEnd` scripts |
| `claude-chat/` | Claude.ai custom connector setup (live MCP URL + chat token) |
| `.cursor/hooks.json` | Wired at repo root (points at `integrations/cursor/hooks`) |
| `.claude/settings.json` | Claude Code project hooks |
| `mcp.example.json` | Template for remote MCP (no secrets) |

Local files with bearer tokens (gitignored): `.cursor/mcp.json`, `.mcp.json`.

## Env

From repo-root `.env`:

- `PLUMB_PROJECT_ID` (Meta hackathon project id)
- `PLUMB_INGEST_URL` / `PLUMB_MCP_URL`
- `PLUMB_TOKEN_CURSOR`, `PLUMB_TOKEN_CLAUDE_CODE`, `PLUMB_TOKEN_CLAUDE_CHAT`

## Notes

- Cursor hooks only send data out. Do not rely on hook stdout reaching the model except `sessionStart.additional_context`.
- Claude Code: Stop mid-session saves at most every 15 minutes (new turns only, same session id). SessionEnd sends the final new turns. No generic titles.
- Cursor: afterAgentResponse / stop / sessionEnd ingest under `conversation_id` only (never a shared `cursor-session` id). Prefer `transcript_path` labeled Usman:/Cursor: turns. One-line debug log: `logs/cursor-hooks.log`.
- Cursor Agent / Cloud Agents often do not fire project hooks. Backfill local Agent chats with `node integrations/cursor/sync-transcripts.mjs --project plumb` (index mode by default; `--full` for claim extraction). There is no Cursor API to list every chat.
- Claude.ai history: download the export zip while signed in, then `node integrations/claude-chat/import-export.mjs <zip>` (index mode). The email download link does not work without sign-in, so Gmail cannot fetch it alone.
- SessionStart (Claude Code and Cursor) writes `PROJECT_STATE.md` from `get_project_state.markdown`.
- @ sessions (phase 1): MCP resources list/read contexts once Claude Code exports `listContexts` / `readContext`; tools `find_context` / `get_context` register via the existing tool loop.
- Muse Code can be a fourth tool: MCP via `mcp_servers` in `~/.config/muse/settings.json` (`streamable_http` to the same `/mcp` URL), project rules via `AGENTS.md` (or `CLAUDE.md` fallback).
- Reload Cursor / Claude Code after changing hook configs.
