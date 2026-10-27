// Sleep-time sweep, run every few hours by a scheduler (not an MCP tool):
//   const result = await sweep(SupabaseStore.fromEnv(), new MetaClient());
// Re-checks hint-only claims against events seen since the last sweep, and
// flags repeats. Everything it finds goes to REVIEW; nothing goes OUT.
import {
  EventKind,
  findDuplicates,
  recheckClaims,
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
}

export async function sweep(store: Store, model: JsonModel): Promise<SweepResult> {
  const until = new Date().toISOString();
  const since =
    (await store.getCursor(CURSOR)) ?? new Date(Date.now() - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // By when we saw it, not when it happened: an email seen late still counts.
  const [claims, reasons, events, reviews] = await Promise.all([
    store.loadClaims(),
    store.loadReasons(),
    store.loadEvents({ kinds: EventKind.options.filter((k) => k !== "clock"), observed_after: since }),
    store.loadTransitions({ to_statuses: ["REVIEW"] }),
  ]);
  const state: BrainState = { claims: new Map(claims.map((c) => [c.id, c])), reasons, events, transitions: reviews };

  const recheck = await recheckClaims(model, state, events);
  const duplicates = await findDuplicates(model, state);

  // One REVIEW per claim, even if both jobs flag it.
  const flags = new Map<string, SweepFlag>();
  for (const f of [...recheck.flags, ...duplicates]) if (!flags.has(f.claim_id)) flags.set(f.claim_id, f);
  const transitions = await createHandlers(store).review([...flags.values()]);

  // Move the cursor only after the writes, so a failed sweep is retried next time.
  await store.setCursor(CURSOR, until);
  return { since, until, rechecked: recheck.checked, events: events.length, transitions };
}
