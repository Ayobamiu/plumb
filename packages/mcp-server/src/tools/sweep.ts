// Sleep-time sweep, run every few hours by a scheduler (not an MCP tool):
//   const result = await sweep(SupabaseStore.fromEnv(), new MetaClient());
// Re-checks hint-only claims against events seen since the last sweep, and
// flags repeats: those go to REVIEW, never OUT. It also suggests missing
// depends_on links, which go to link_suggestions for Usman to accept or dismiss.
import {
  EventKind,
  findDuplicates,
  recheckClaims,
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
  links: number; // new link suggestions waiting for Usman
}

export async function sweep(store: Store, model: JsonModel): Promise<SweepResult> {
  const until = new Date().toISOString();
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
  const known = new Set(suggested.map((l) => `${l.claim_id}>${l.depends_on}`));
  const links = await suggestLinks(model, state, known);
  await store.addLinkSuggestions(
    links.map((l) => ({ ...l, project_id: state.claims.get(l.claim_id)!.project_id })),
  );

  // Move the cursor only after the writes, so a failed sweep is retried next time.
  await store.setCursor(CURSOR, until);
  return { since, until, rechecked: recheck.checked, events: events.length, transitions, links: links.length };
}
