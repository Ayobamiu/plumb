# Plumb: handoff for Muse Code

Plumb keeps one shared set of truths that all of Usman's AI tools (Claude Code, Cursor, Muse Code, Claude chat) read from and write to, and keeps it correct on its own. Every claim is stored with the reasons it holds. When new evidence (an email, a doc edit, time passing) breaks a reason, plain code marks the claim OUT and follows the chain to every claim built on it, with a one-sentence explanation.

Built for the Meta Global AI Developer Hackathon. Submission due Nov 4, 2026, 9 PM ET.

Three agents build it: Claude Code, Cursor and you. Usman splits the work so no one runs out of usage. Stay in your lane; the Progress log is how we talk.

## Source of truth

The spec lives in Usman's Docs app, read through the docs MCP:

- Document: "Context Tool, Meta Hack" (id ede34f81-56d6-46e1-8189-691d8803f9eb)
- At the start of every session, read Overview, 1. Contract, 7. Progress log (newest entries at the end), and the tabs your task touches.
- Also call the Plumb MCP tool `get_project_state` (project id b22fab5f-d621-47d0-88e2-a16da13bf42e) for the live state.
- The Contract tab is final. Never rename or remove a field. If you need a new one, write the request in the Progress log for Claude Code; Usman OKs it.

If the doc and this file disagree, the doc wins.

## Your lane

| Path | What |
| --- | --- |
| packages/local-sync (new) | The laptop helper: reads local AI tool history and sends it to /ingest |
| integrations/muse-code | Muse Code's own write-back (hooks, /plumb skill checks) |
| .agents/skills/plumb | The /plumb skill for Muse (text is shared with the other tools: keep the help line as is) |

Don't edit anything else. Others own:

| Path | Owner |
| --- | --- |
| packages/core, packages/mcp-server/src/tools, prompts/, evals/, supabase/migrations | Claude Code |
| apps/web, packages/watchers, packages/mcp-server deploy and auth, integrations/claude-code, integrations/cursor, integrations/lib, integrations/claude-chat | Cursor |

You may import from `@plumb/core` and `integrations/lib/ingest.mjs` (ingestText). If they need a change, ask the owner in the Progress log.

## Task 1: packages/local-sync

Goal: every session from every AI tool on this laptop is findable in Plumb, even when a tool's hooks didn't fire. Today Plumb holds only 4 Cursor and 2 Claude Code sessions in total.

- Read local history:
  - Claude Code: `~/.claude/projects/<folder>/<session-id>.jsonl`.
  - Cursor Agent: the local agent-transcripts. `integrations/cursor/sync-transcripts.mjs` already does this; move the logic into local-sync and leave Cursor's script calling it, after telling Cursor in the log.
  - Muse Code: `~/.local/share/muse/sessions/YYYY/MM/DD/<session-uuid>/session.jsonl`, an event log (`record_type`, `payload_type`, `payload`; turns are in events like `runtime.user_intent.*` and the model output events). There is also `~/.local/share/muse/session-index.db`. Work out which payload types hold the user and assistant text, and log what you found.
- For each session that changed since the last run, build plain labeled text (`User:` and `<Tool>:` turns; no tool call dumps) and send it with `ingestText`:
  - Use the same `external_id` the hooks use for that tool (the session or conversation id), so a session is never saved twice. Check the hooks in integrations/ before choosing.
  - Sessions whose working folder is the plumb repo: full mode with the Meta hackathon project id.
  - Everything else: `indexOnly: true` (one cheap Muse Spark call: title, summary, personal or work). Don't set `label`; the server decides, unless the tool says so.
- Keep sync state outside the repo (for example `~/.plumb/local-sync.json`): last sent time and a hash per session. Only advance it after a 2xx. On 503, stop and retry next run.
- Print one coverage line per tool at the end: sessions found, sent, skipped, last saved.
- Run it with `pnpm --filter @plumb/local-sync sync`. Add `--dry-run` that sends nothing and prints what it would send (titles and sizes only, never the text).
- Tests with fake history folders. Never read or send real history in tests.
- Start with a dry run on real history and show Usman the counts before the first real send.

## Task 2: Muse Code write-back

Wire a Muse Code `SessionEnd` hook (see dev.meta.ai/docs/muse-code/extending) to send the session the same way (integrations/muse-code). Use source kind `muse_code` (added Oct 28) with the Muse session UUID as `external_id`, the same id local-sync uses. The Plumb token for Muse is `PLUMB_TOKEN_MUSE_CODE`.

## Rules

- Never print, log or commit .env or any key or token. Never send file contents that look like secrets.
- Only Meta models run inside the product (Muse Spark through /ingest). You are how it gets built, not part of it.
- Nothing is ever deleted from the database. Don't call the database directly; go through /ingest or the MCP tools.
- Don't commit, push or deploy unless Usman asks in the session.
- End every session with a short Progress log entry headed "### Muse Code, <date> (<topic>)": done, decisions, blocked or needs, contract changes.
- Writing for Usman: short, plain, honest. Never use em dashes in docs, UI text or messages.
