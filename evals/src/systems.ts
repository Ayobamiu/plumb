// Systems under test. Each takes a scenario and returns every claim's status
// after each event. Later: the LLM-only baseline (tab 5) goes here too.
import { randomUUID } from "node:crypto";
import { materializeClaims, onEvent, sortEvents, type BrainState, type ClaimStatus, type Event } from "@plumb/core";
import type { Scenario } from "./scenario.js";

export interface SystemRun {
  statusAfter: Map<string, Map<string, ClaimStatus>>; // event key -> claim key -> status
}

type System = (s: Scenario) => Promise<SystemRun>;

const SOURCE_ID = "eval-source";

function toEvents(s: Scenario): { key: string; event: Event }[] {
  // sortEvents breaks ties on id, so ids follow file order to keep same-second events in file order.
  const withIds = s.events.map((e, i) => ({
    key: e.key,
    event: {
      id: `e${String(i).padStart(3, "0")}`,
      kind: e.kind,
      source_id: SOURCE_ID,
      occurred_at: e.occurred_at,
      observed_at: e.occurred_at,
      summary: e.summary,
      ...(e.from && { from: e.from }),
      ...(e.thread_id && { thread_id: e.thread_id }),
    } satisfies Event,
  }));
  const order = sortEvents(withIds.map((w) => w.event)).map((e) => e.id);
  return order.map((id) => withIds.find((w) => w.event.id === id)!);
}

/** Plumb's invalidation engine (Brain Part B) on hand-written claims. */
const plumb: System = async (s) => {
  const m = materializeClaims({
    project_id: s.id,
    source_id: SOURCE_ID,
    extracted_by: "hand-written",
    recorded_at: s.recorded_at,
    claims: s.claims,
    existing: new Map(),
    newId: randomUUID,
  });
  const state: BrainState = {
    claims: new Map(m.claims.map((c) => [c.id, c])),
    reasons: m.reasons,
    events: [],
    transitions: [],
  };
  const statusAfter = new Map<string, Map<string, ClaimStatus>>();
  for (const { key, event } of toEvents(s)) {
    onEvent(state, event, { now: event.occurred_at, newId: randomUUID });
    statusAfter.set(
      key,
      new Map(Object.entries(m.id_map).map(([k, id]) => [k, state.claims.get(id)!.status])),
    );
  }
  return { statusAfter };
};

/** Baseline 1: claims stay IN forever. */
const doNothing: System = async (s) => ({
  statusAfter: new Map(s.events.map((e) => [e.key, new Map(s.claims.map((c) => [c.temp_id, "IN" as const]))])),
});

export const systems: Record<string, System> = { plumb, do_nothing: doNothing };
