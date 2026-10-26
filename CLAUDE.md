# Plumb: handoff for Claude Code

Plumb keeps one shared set of truths that all of Usman's AI tools (Claude Code, Cursor, Claude chat) read from and write to, and keeps it correct on its own. Every claim is stored with the reasons it holds. When new evidence (an email, a doc edit, time passing) breaks a reason, plain code marks the claim OUT and follows the chain to every claim built on it, with a one-sentence explanation.

Built for the Meta Global AI Developer Hackathon. Submission due Nov 4, 2026, 9 PM ET.

## Source of truth

The spec lives in Usman's Docs app, read through the docs MCP:

- Document: "Context Tool, Meta Hack" (id ede34f81-56d6-46e1-8189-691d8803f9eb)
- At the start of every session, read Overview, 1. Contract, the tabs you own, and 7. Progress log.
- The Contract tab is confirmed and final. You may add fields. Never rename or remove them. Any change needs Usman's OK and a Progress log entry.

If the doc and this file disagree, the doc wins.

## Your role

You own the parts that need the most careful thinking:

- Contract guardian: TypeScript types and zod schemas that match tab 1 exactly.
- Brain (tab 2): extraction, invalidation, model check, restoring, sleep-time sweep.
- Meta models (tab 3): the Muse Spark client, prompts, cost logging.
- /ingest endpoint and the MCP tool handlers.
- Evals (tab 5): scenarios, runner, baselines, metrics.
- Supabase schema and migrations.

Cursor owns the UI, watchers, per-tool integrations, auth and deployment. Don't edit its folders.

## Repo layout (ownership)

| Path | Owner |
| --- | --- |
| packages/core (types, brain, Meta client) | Claude Code |
| packages/mcp-server/src/tools | Claude Code |
| packages/mcp-server/deploy and auth middleware | Cursor |
| supabase/migrations | Claude Code |
| prompts/ | Claude Code |
| evals/ | Claude Code |
| apps/web (homepage) | Cursor |
| packages/watchers (Gmail, doc, clock) | Cursor |
| integrations/ (Claude Code hooks, Cursor hooks and rules) | Cursor |

Stack: TypeScript, pnpm workspaces, Supabase (Postgres).

## You go first today (day 1)

Cursor waits for your first Progress log entry, so do these in order:

1. git init, pnpm workspace, the folder layout above. .gitignore and .env.example already exist.
2. packages/core: Contract types plus zod schemas, exported for everyone.
3. Supabase: ask Usman whether to create a new project named plumb, then write migrations for the six tables in tab 1.
4. Meta client smoke test: one call using META_MODEL_API_KEY from .env. Confirm the current Muse Spark model id first.
5. Log a Progress log entry so Cursor can start.
6. Then Brain Part B (invalidation) with hand-written claims, passing eval scenarios 1 to 5.

Ask Usman to check the hackathon's Official Rules (questions in tab 3) and log the answers.

## Rules

- Never print, log or commit .env or any key. The key's variable name is META_MODEL_API_KEY.
- Only Meta models run inside the product. You and Cursor are how it gets built, not part of it.
- Code decides status changes. A model may only send a claim to REVIEW, never straight to OUT.
- Nothing is ever deleted from the database.
- End every session with a short Progress log entry: done, decisions, blocked or needs, contract changes.
- Writing for Usman: short, plain, honest. Never use em dashes in docs, UI text or messages.
