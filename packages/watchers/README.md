# watchers

Owned by Cursor. Gmail (60s poll), clock (60s), later doc editor. Each calls `record_event` on the remote MCP server.

## Run

Needs `.env`: Supabase service role, Google OAuth client, `PLUMB_TOKEN_WATCHERS`, and `PLUMB_INGEST_URL` or `PLUMB_MCP_URL` pointing at the deployed server.

1. Connect Gmail once (homepage running): open http://localhost:3000/api/gmail/auth
2. Gmail poller:

```bash
pnpm --filter @plumb/watchers gmail
```

3. Clock (until reasons):

```bash
pnpm --filter @plumb/watchers clock
```

## Cursors

`watcher_cursors` row `gmail` holds the last Gmail `historyId`. First run stores the current profile historyId and does not replay old mail. The cursor advances only after every message on a history page is recorded.
