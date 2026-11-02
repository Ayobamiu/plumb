# Plumb

Context from your other AI tools, already corrected.

If you work across Claude Code, Cursor and Claude Desktop, none of them knows what the others did, and what they remember goes stale. Plumb keeps one shared memory of where your work stands, and keeps it true on its own.

Built with Meta's Muse Spark for the Meta Global AI Developer Hackathon, Oct 26 to Nov 4, 2026.

- Homepage: https://web-production-842f7.up.railway.app
- Install: `npx plumb-ai init`
- Ask from any tool: `/plumb where did we land on pricing?`

## How it works

Every claim is stored with the reasons it holds. When new evidence breaks a reason, Plumb marks the claim false, follows the chain to everything built on it, and says why in one sentence.

1. **Listen.** Hooks and local history bring in sessions from your tools. Watchers bring in Gmail, doc edits and the clock. Secrets are stripped before anything leaves your computer.
2. **Update.** Muse Spark reads each session and writes down its claims and the reasons behind them. Plain code checks every field.
3. **Check.** When an event arrives, plain code decides what it breaks. Muse Spark catches what patterns can't, like a reply in a new thread.

The next tool you open gets the corrected state, not the stale one.

## The rule that matters

**A model can never mark a claim false.** Code decides status changes. A model may only flag a claim as "may be out of date", and it has to quote the evidence. Nothing is ever deleted: claims move between IN, OUT and REVIEW, and each move is recorded with its reason.

That rule is why Plumb can correct your memory without quietly damaging it. The evals below measure it.

## How Muse Spark is used

| Job | What Muse Spark does | Effort |
| --- | --- | --- |
| Extraction | Turns a session or doc into claims with reasons | medium |
| Model check | Decides whether an event makes a claim false, with an exact quote | low |
| Sleep-time sweep | Re-checks old claims, finds duplicates, suggests links | medium to high |
| Search | Finds the right session from a description in your own words | low |
| Indexing | Writes a title and short summary for each past session | low |

Prompts are versioned files in [`prompts/`](prompts), so evals can compare versions. Muse Code connects as a tool too, through MCP and `AGENTS.md`, and it helped build the local history sync.

## Results

Measured on made-up scenarios, on the dev set. A held-out set is kept for one final run.

**Keeping claims true** (24 scenarios, 2 runs, muse-spark-1.3)

| System | Detection recall | Chain recall | False retraction |
| --- | --- | --- | --- |
| Do nothing | 0% (0/28) | 0% (0/11) | 0% (0/84) |
| Plumb, code only | 61% (11/18) | 90% (9/10) | 0% (0/52) |
| Muse Spark alone, sees all claims and events | 81% (21/26) | 71% (10/14) | 5.9% (4/68) |
| **Plumb: code plus Muse Spark** | **96% (54/56)** | **100% (22/22)** | **0% (0/166)** |

False retraction is how often a true claim gets marked false. It's the number that kills trust. Muse Spark alone can't run 11 of the 24 scenarios, so its numbers cover 13. Code only skips 7.

**Finding a session from a description** (37 queries, muse-spark-1.3)

| System | Right session first | Says "not found" when right |
| --- | --- | --- |
| Keyword match | 23% (7/30) | 100% (7/7) |
| Any shared word | 83% (25/30) | 14% (1/7) |
| **Muse Spark ranks candidates** | **100% (30/30)** | **100% (7/7)** |

Full tables, method and costs: [`evals/RESULTS.md`](evals/RESULTS.md). All scenarios use made-up people and data.

## Try it

```
npx plumb-ai init      # sign in and connect Claude Code, Cursor and Claude Desktop
npx plumb-ai backfill  # bring in your past sessions
npx plumb-ai status    # see what's connected
```

Then type `/plumb` in any connected tool. `npx plumb-ai uninstall` removes everything Plumb added, and `npx plumb-ai delete-account` removes your data.

## Repo layout

| Path | What's there |
| --- | --- |
| `packages/core` | Data contract, the brain (extraction, invalidation, model check, sweep), Muse Spark client |
| `packages/mcp-server` | MCP tools and the `/ingest` endpoint |
| `packages/cli` | The `plumb-ai` installer and hooks |
| `packages/local-sync` | Reads local history from Claude Code, Cursor and Muse Code |
| `packages/watchers` | Gmail, doc and clock watchers |
| `apps/web` | Homepage |
| `integrations` | Hooks and rules for each tool |
| `prompts` | Versioned prompts |
| `evals` | Scenarios, runner, baselines, results |
| `supabase/migrations` | Database schema |

## Run it yourself

Needs Node 22, pnpm, a Supabase project and a Meta Model API key. Copy `.env.example` to `.env` and fill it in.

```
pnpm install
pnpm typecheck
pnpm test
pnpm eval                # brain evals, code only, no key needed
pnpm eval:model --split dev --runs 2
pnpm dev:mcp
pnpm dev:web
```

## Known limits

- Flags appear at session start or when you ask with `/plumb`. There are no pop-ups.
- Slides are read as text.
- Claude chats aren't saved automatically: export them, then run `npx plumb-ai import`.
- Cursor doesn't always fire its hooks, so a background sync catches what they miss.
- Meta's API has had outages. If its standard models are down, the hosted service can fall back to the contributor tier, which lets Meta train on what it receives. The homepage says so.
