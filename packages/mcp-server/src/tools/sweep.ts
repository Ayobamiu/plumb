// Sleep-time sweep, run every few hours by a scheduler (not an MCP tool):
//   const result = await sweep(SupabaseStore.fromEnv(), new MetaClient());
// Re-checks hint-only claims against events seen since the last sweep, and
// flags repeats: those go to REVIEW, never OUT. REVIEWs nothing confirmed for 7
// days go back IN (Oct 29). It also finds likely depends_on links; since Oct 29
// they are never shown for approval, only listed as related context.
import {
  EventKind,
  findDuplicates,
  recheckClaims,
  reviewSuggestions,
  suggestLinks,
  type BrainState,
  type JsonModel,
  type SweepFlag,
  type Transition,
} from "@plumb/core";
import { createHandlers } from "./handlers.js";
import type { Store } from "./store.js";

const CURSOR = "sweep";
const FIRST_RUN_DAYS = 7; // with no cursor yet, look back this far

export interface SweepResult {
  since: string;
  until: string;
  rechecked: number; // claims the re-check asked the model about
  events: number; // events new since the last sweep
  transitions: Transition[]; // claims sent to REVIEW
  faded: Transition[]; // REVIEWs back IN after 7 days with nothing confirming them
  links: number; // new link suggestions waiting for the user
  expired: number; // pending suggestions retired as no longer relevant
}

export async function sweep(store: Store, model: JsonModel): Promise<SweepResult> {
  const until = new Date().toISOString();
  const faded = await createHandlers(store).fade();
  const since =
    (await store.getCursor(CURSOR)) ?? new Date(Date.now() - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // By when we saw it, not when it happened: an email seen late still counts.
  const [claims, reasons, events, reviews, suggested] = await Promise.all([
    store.loadClaims(),
    store.loadReasons(),
    store.loadEvents({ kinds: EventKind.options.filter((k) => k !== "clock"), observed_after: since }),
    store.loadTransitions({ to_statuses: ["REVIEW"] }),
    store.loadLinkSuggestions(),
  ]);
  const state: BrainState = { claims: new Map(claims.map((c) => [c.id, c])), reasons, events, transitions: reviews };

  const recheck = await recheckClaims(model, state, events);
  const duplicates = await findDuplicates(model, state);

  // One REVIEW per claim, even if both jobs flag it.
  const flags = new Map<string, SweepFlag>();
  for (const f of [...recheck.flags, ...duplicates]) if (!flags.has(f.claim_id)) flags.set(f.claim_id, f);
  const transitions = await createHandlers(store).review([...flags.values()]);

  // Links are suggested against the state after this sweep's REVIEWs, so a
  // claim just sent to REVIEW isn't linked to.
  for (const t of transitions) {
    const c = state.claims.get(t.claim_id);
    if (c) state.claims.set(c.id, { ...c, status: t.to_status });
  }
  // A pair that expired only because a claim left IN may be suggested again once both are IN.
  const known = new Set(
    suggested.filter((l) => l.expired_because !== "claim_left_in").map((l) => `${l.claim_id}>${l.depends_on}`),
  );
  const links = await suggestLinks(model, state, known);
  await store.addLinkSuggestions(
    links.map((l) => ({ ...l, project_id: state.claims.get(l.claim_id)!.project_id })),
  );

  // Retire pending suggestions (from earlier sweeps) that no longer deserve attention.
  // The relevance check sees every status change, so it needs all transitions here.
  const pending = suggested.filter((l) => l.status === "pending");
  let expired = 0;
  if (pending.length) {
    state.transitions = await store.loadTransitions({ claim_ids: [...new Set(pending.flatMap((p) => [p.claim_id, p.depends_on]))] });
    const allEvents = await store.loadEvents({
      kinds: EventKind.options.filter((k) => k !== "clock"),
      after: pending.reduce((min, p) => (p.created_at < min ? p.created_at : min), until),
    });
    for (const e of await reviewSuggestions(model, { ...state, events: allEvents }, pending, until)) {
      if (await store.expireLinkSuggestion(e.id, e.note, until)) expired++;
    }
  }

  // Move the cursor only after the writes, so a failed sweep is retried next time.
  await store.setCursor(CURSOR, until);
  return { since, until, rechecked: recheck.checked, events: events.length, transitions, faded, links: links.length, expired };
}
