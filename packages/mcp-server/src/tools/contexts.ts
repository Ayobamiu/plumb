// "@ a session from any tool" (Oct 27): list recent sources and read one as the
// distilled, current view. Backs the find_context and get_context tools and
// the MCP resources Cursor registers in create-mcp.ts.
import type { z } from "zod";
import {
  contextName,
  contextUri,
  displayTitle,
  EventKind,
  gatherCandidates,
  matchesQuery,
  parseContextUri,
  renderContext,
  searchByDescription,
  sharedWords,
  toolLabel,
  type Claim,
  type ContextEntry,
  type Event,
  type FindContextInput,
  type GetContextInput,
  type GetContextOutput,
  type JsonModel,
  type RecentWorkInput,
  type SearchCandidate,
  type Source,
  type Transition,
} from "@plumb/core";
import { ToolError } from "./handlers.js";
import type { Store } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_DAYS = 14;
const SEARCH_DAYS = 90; // search by description looks further back than the @ list
const RESOLVE_DAYS = 90; // an @ link stays readable a while after it drops off the list
const NEWS_KINDS = EventKind.options.filter((k) => k !== "clock");
const MAX_CHANGED = 10;
export const NO_MATCH = "Not a clear match";
export const BASIC_SEARCH = "Basic search";
const BASIC_RESULTS = 5;

// Plumbing sources, not work anyone would @.
const HIDDEN = (s: Source) => s.external_id === "clock" || s.external_id === "usman-links" || s.external_id.startsWith("smoke-");

// A source's project comes from the claims it produced (sources don't store one).
// - An email thread only counts if it matters: it produced claims, or a current
//   claim is waiting on it (an absence reason names its thread). Newsletters don't.
// - Docs are only the ones Usman chose to watch, so they're shared across projects.
// - A tool session is placed by its claims, or by the project it was indexed
//   under (Source.project_id, Oct 28). One with neither is left out of project
//   lists; unscoped search still finds it.
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
    // Raw-text fallbacks (start with "...") from failed extractions aren't shown.
    const s = summary.get(e.source_id);
    if (!e.summary.startsWith("...") && (!s || Date.parse(e.occurred_at) > Date.parse(s.at))) summary.set(e.source_id, { at: e.occurred_at, text: e.summary });
  }
  // When it happened, not when it was saved: an old chat imported today is still
  // old. Claims only date a source that has no events (Oct 30).
  for (const c of claims) if (!last.has(c.source_id)) last.set(c.source_id, c.recorded_at);
  if (last.size === 0) return [];

  const sourceIds = [...last.keys()];
  const [sources, owned, live] = await Promise.all([
    store.loadSources(sourceIds),
    store.loadClaims({ source_ids: sourceIds }),
    store.loadClaims(input.project_id ? { project_id: input.project_id } : {}),
  ]);
  const projectOf = new Map<string, string>();
  const latestClaim = new Map<string, Claim>(); // for older sessions with no summary to name them by
  for (const s of sources) if (s.project_id) projectOf.set(s.id, s.project_id); // indexed sessions name their project
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
  if (!input.uri) throw new ToolError("bad_input", "give uri or source_id");
  const parsed = parseContextUri(input.uri);
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
    markdown: renderContext({ source, lastAt, events, claims, latestTransition, changedSince, related: await relatedFor(store, ownIds) }),
  };
}

const MAX_RELATED = 5;

/** Claims elsewhere that the sweep linked to these (Oct 29: links are context, never asked about). */
async function relatedFor(store: Store, ownIds: string[]) {
  if (!ownIds.length) return [];
  const own = new Set(ownIds);
  const links = (await store.loadLinkSuggestions())
    .filter((l) => l.status !== "dismissed" && (own.has(l.claim_id) || own.has(l.depends_on)))
    .slice(0, MAX_RELATED);
  const otherIds = links.map((l) => (own.has(l.claim_id) ? l.depends_on : l.claim_id));
  if (!otherIds.length) return [];
  const others = await store.loadClaims({ ids: otherIds });
  const sources = new Map((await store.loadSources([...new Set(others.map((c) => c.source_id))])).map((x) => [x.id, x]));
  return links.flatMap((l, i) => {
    const c = others.find((x) => x.id === otherIds[i]);
    if (!c || c.status === "OUT") return [];
    const src = sources.get(c.source_id);
    return [{ text: c.text, from: src ? `${toolLabel(src.kind)}: ${src.title ?? "untitled"}` : "another session", why: l.why }];
  });
}

// find_context. With a model (Oct 28), the query is a description in the
// user's own words: the model picks the session they mean from recent ones,
// and contexts come back best first, then up to 3 alternatives, each with a
// why. When nothing fits, only the near misses come back, each why starting
// "Not a clear match". Without a model, or if the call fails (Oct 30), the
// sessions sharing the most words come back, each why starting "Basic search",
// so a failed model never looks like "nothing saved".
export async function findContext(store: Store, input: z.infer<typeof FindContextInput>, model?: JsonModel) {
  const scope = { ...(input.project_id && { project_id: input.project_id }) };
  const all = await listContexts(store, { ...scope, days: SEARCH_DAYS, limit: 1000 });
  const ids = all.map((e) => e.source_id);
  const [claims, sources] = ids.length ? await Promise.all([store.loadClaims({ source_ids: ids }), store.loadSources(ids)]) : [[], []];
  const personal = new Set(sources.filter((src) => src.label === "personal").map((src) => src.id));
  const said = new Map<string, Claim[]>();
  for (const c of claims) said.set(c.source_id, [...(said.get(c.source_id) ?? []), c]);
  const candidates: SearchCandidate[] = all.map((e) => ({
    id: e.source_id,
    tool: personal.has(e.source_id) ? `${e.tool} (personal)` : e.tool,
    last_at: e.last_at,
    ...(e.title && { title: e.title }),
    summary: e.description,
    claims: (said.get(e.source_id) ?? []).sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at)).map((c) => c.text),
  }));
  const byId = new Map(all.map((e) => [e.source_id, e]));
  if (model) {
    try {
      const found = await searchByDescription(model, input.query, candidates, new Date().toISOString());
      const picked = found.best
        ? [found.best, ...found.alternatives]
        : found.alternatives.map((a) => ({ id: a.id, why: `${NO_MATCH}: ${a.why}` }));
      return { contexts: picked.map((m) => ({ ...byId.get(m.id)!, why: m.why })).slice(0, input.limit ?? 30) };
    } catch {
      // fall through to basic search: a failed model call must not look like "nothing saved"
    }
  }
  const matched = gatherCandidates(candidates, input.query).filter((c) => sharedWords(c, input.query) > 0).slice(0, input.limit ?? BASIC_RESULTS);
  return { contexts: matched.map((c) => ({ ...byId.get(c.id)!, why: `${BASIC_SEARCH}: shares ${sharedWords(c, input.query)} word(s) with your request` })) };
}

const RECENT_DAYS = 7;
const RECENT_LIMIT = 30;

/** Sessions active in the last few days, newest first: what "this week" spans. Saved earlier work isn't counted by when it was saved. */
export async function recentWork(store: Store, input: z.infer<typeof RecentWorkInput>) {
  const days = input.days ?? RECENT_DAYS;
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const wanted = input.tool?.toLowerCase().replace(/[^a-z]/g, "");
  const all = await listContexts(store, { ...(input.project_id && { project_id: input.project_id }), days, limit: 10_000 });
  const matched = all
    .filter((e) => Date.parse(e.last_at) >= Date.parse(since))
    .filter((e) => e.tool !== "Email")
    .filter((e) => !wanted || e.tool.toLowerCase().replace(/[^a-z]/g, "").includes(wanted));
  return { since, sessions: matched.slice(0, input.limit ?? RECENT_LIMIT), total: matched.length };
}
