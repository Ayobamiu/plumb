// "@ a session from any tool" (Oct 27): list recent sources and read one as the
// distilled, current view. Backs the find_context and get_context tools and
// the MCP resources Cursor registers in create-mcp.ts.
import type { z } from "zod";
import {
  contextName,
  contextUri,
  displayTitle,
  EventKind,
  matchesQuery,
  parseContextUri,
  renderContext,
  toolLabel,
  type Claim,
  type ContextEntry,
  type Event,
  type FindContextInput,
  type GetContextInput,
  type GetContextOutput,
  type Source,
  type Transition,
} from "@plumb/core";
import { ToolError } from "./handlers.js";
import type { Store } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_DAYS = 14;
const RESOLVE_DAYS = 90; // an @ link stays readable a while after it drops off the list
const NEWS_KINDS = EventKind.options.filter((k) => k !== "clock");
const MAX_CHANGED = 10;

// Plumbing sources, not work anyone would @.
const HIDDEN = (s: Source) => s.external_id === "clock" || s.external_id === "usman-links" || s.external_id.startsWith("smoke-");

// A source's project comes from the claims it produced (sources don't store one).
// - An email thread only counts if it matters: it produced claims, or a current
//   claim is waiting on it (an absence reason names its thread). Newsletters don't.
// - Docs are only the ones Usman chose to watch, so they're shared across projects.
// - A tool session that produced no claims can't be placed, so it's left out of
//   project lists (known limit: it only has a summary to offer anyway).
function inProject(source: Source, project: string | undefined, wanted: string | undefined, watchedThreads: Set<string>): boolean {
  if (source.kind === "gmail_thread") return (project !== undefined && (!wanted || project === wanted)) || watchedThreads.has(source.external_id);
  if (project) return !wanted || project === wanted;
  return source.kind === "doc" || !wanted;
}

const later = (a: string | undefined, b: string) => (!a || Date.parse(b) > Date.parse(a) ? b : a);

export async function listContexts(
  store: Store,
  input: { project_id?: string; query?: string; limit?: number; days?: number },
): Promise<ContextEntry[]> {
  const since = new Date(Date.now() - (input.days ?? LIST_DAYS) * DAY_MS).toISOString();
  const [events, claims] = await Promise.all([
    store.loadEvents({ kinds: NEWS_KINDS, observed_after: since }),
    store.loadClaims({ recorded_after: since }),
  ]);
  const last = new Map<string, string>();
  const summary = new Map<string, { at: string; text: string }>();
  for (const e of events) {
    last.set(e.source_id, later(last.get(e.source_id), e.occurred_at)!);
    const s = summary.get(e.source_id);
    if (!s || Date.parse(e.occurred_at) > Date.parse(s.at)) summary.set(e.source_id, { at: e.occurred_at, text: e.summary });
  }
  for (const c of claims) last.set(c.source_id, later(last.get(c.source_id), c.recorded_at)!);
  if (last.size === 0) return [];

  const sourceIds = [...last.keys()];
  const [sources, owned, live] = await Promise.all([
    store.loadSources(sourceIds),
    store.loadClaims({ source_ids: sourceIds }),
    store.loadClaims(input.project_id ? { project_id: input.project_id } : {}),
  ]);
  const projectOf = new Map<string, string>();
  const latestClaim = new Map<string, Claim>(); // for older sessions with no summary to name them by
  for (const c of owned) {
    if (!projectOf.has(c.source_id)) projectOf.set(c.source_id, c.project_id);
    const seen = latestClaim.get(c.source_id);
    if (!seen || Date.parse(c.recorded_at) > Date.parse(seen.recorded_at)) latestClaim.set(c.source_id, c);
  }
  // Threads that current claims are waiting on.
  const liveIds = live.filter((c) => c.status !== "OUT").map((c) => c.id);
  const watchedThreads = new Set(
    (liveIds.length ? await store.loadReasons({ claim_ids: liveIds }) : []).flatMap((r) =>
      r.type === "absence" && r.pattern.thread_id ? [r.pattern.thread_id] : [],
    ),
  );

  return sources
    .filter((s) => !HIDDEN(s))
    .filter((s) => inProject(s, projectOf.get(s.id), input.project_id, watchedThreads))
    .filter((s) => !input.query || matchesQuery(s, summary.get(s.id)?.text ?? "", input.query))
    .map((raw): ContextEntry => {
      const title = displayTitle(raw.title, summary.get(raw.id)?.text ?? latestClaim.get(raw.id)?.text ?? "");
      const s: Source = { ...raw, ...(title ? { title } : {}) };
      const lastAt = last.get(s.id)!;
      const project_id = projectOf.get(s.id);
      return {
        uri: contextUri(s),
        name: contextName(s, lastAt),
        description: (summary.get(s.id)?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
        source_id: s.id,
        ...(project_id && { project_id }),
        tool: toolLabel(s.kind),
        ...(s.title && { title: s.title }),
        last_at: lastAt,
      };
    })
    .sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
    .slice(0, input.limit ?? 30);
}

async function resolve(store: Store, input: z.infer<typeof GetContextInput>): Promise<Source> {
  if (input.source_id) {
    const [s] = await store.loadSources([input.source_id]);
    if (!s) throw new ToolError("not_found", `unknown source ${input.source_id}`);
    return s;
  }
  const parsed = parseContextUri(input.uri!);
  if (!parsed) throw new ToolError("bad_input", `not a Plumb context: ${input.uri}`);
  const hits = (await listContexts(store, { days: RESOLVE_DAYS, limit: 1000 })).filter((e) => e.source_id.startsWith(parsed.idPrefix));
  if (hits.length !== 1) throw new ToolError("not_found", hits.length ? `ambiguous context ${input.uri}` : `no recent context ${input.uri}`);
  const [s] = await store.loadSources([hits[0]!.source_id]);
  return s!;
}

export async function readContext(store: Store, input: z.infer<typeof GetContextInput>): Promise<z.infer<typeof GetContextOutput>> {
  const source = await resolve(store, input);
  const [events, claims] = await Promise.all([
    store.loadEvents({ kinds: NEWS_KINDS, source_ids: [source.id] }) as Promise<Event[]>,
    store.loadClaims({ source_ids: [source.id] }),
  ]);
  let lastAt = "1970-01-01T00:00:00.000Z";
  for (const e of events) lastAt = later(lastAt, e.occurred_at)!;
  for (const c of claims) lastAt = later(lastAt, c.recorded_at)!;

  const ownIds = claims.map((c) => c.id);
  const latestTransition = new Map<string, Transition>();
  let changedSince: { claim: Claim; transition: Transition }[] = [];
  if (ownIds.length) {
    const [history, rests, restOn] = await Promise.all([
      store.loadTransitions({ claim_ids: ownIds }),
      store.loadReasons({ claim_ids: ownIds }),
      store.loadReasons({ depends_on: ownIds }),
    ]);
    for (const t of history) latestTransition.set(t.claim_id, t); // oldest first, so the last one wins

    // Linked claims from elsewhere (what these rest on, and what rests on these) that changed after this session.
    const own = new Set(ownIds);
    const related = [
      ...new Set([
        ...rests.flatMap((r) => (r.type === "depends_on" && !own.has(r.claim) ? [r.claim] : [])),
        ...restOn.map((r) => r.claim_id).filter((id) => !own.has(id)),
      ]),
    ];
    if (related.length) {
      const [relatedClaims, relatedChanges] = await Promise.all([
        store.loadClaims({ ids: related }),
        store.loadTransitions({ claim_ids: related, since: lastAt, to_statuses: ["OUT", "REVIEW"] }),
      ]);
      const byId = new Map(relatedClaims.map((c) => [c.id, c]));
      changedSince = relatedChanges
        .filter((t) => byId.has(t.claim_id))
        .slice(-MAX_CHANGED)
        .map((transition) => ({ claim: byId.get(transition.claim_id)!, transition }));
    }
  }

  return {
    uri: contextUri(source),
    name: contextName(source, lastAt),
    markdown: renderContext({ source, lastAt, events, claims, latestTransition, changedSince }),
  };
}

export async function findContext(store: Store, input: z.infer<typeof FindContextInput>) {
  return {
    contexts: await listContexts(store, {
      query: input.query,
      ...(input.project_id && { project_id: input.project_id }),
      ...(input.limit && { limit: input.limit }),
    }),
  };
}
