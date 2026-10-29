# Claude chat → Plumb

Custom connector to the live MCP server. One bearer token: `PLUMB_TOKEN_CLAUDE_CHAT`.

## Setup (Claude.ai)

1. Open Claude → Settings → Connectors (or Custom connectors).
2. Add a remote MCP server:
   - URL: `https://mcp-production-a566.up.railway.app/mcp`
   - Auth header: `Authorization: Bearer <PLUMB_TOKEN_CLAUDE_CHAT>`
3. Enable the Plumb tools for the project or chat you care about.
4. In project instructions (or the first message of a chat): call `get_project_state` before acting on this repo, and call `record_claims` (or rely on tools that write claims) before finishing a task that changed decisions.

Do not put the bearer token in git. Copy it from `.env` or Railway `mcp` variables.

## /plumb (shared phrasing)

Claude chat has no custom slash commands, so `/plumb` is a convention here, not a real command. Paste `plumb-instructions.md` into the project's custom instructions. After that, typing `/plumb <query>` behaves the same as the Cursor command and the Muse skill: `find_context` then `get_context`, or `get_project_state` when the query is empty.

## Check

```bash
curl -sS -X POST https://mcp-production-a566.up.railway.app/tools/get_project_state \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $PLUMB_TOKEN_CLAUDE_CHAT" \
  -d '{}'
```

A JSON project state (or a clear tool error) means the token and URL work. HTTP 401 means the token is wrong or missing on Railway.
