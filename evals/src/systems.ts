// Systems under test. Each takes a scenario and returns every claim's status
// after each event. `systems` are plain code and free to run; `modelSystems`
// call Muse Spark (pnpm eval:model).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  loadPrompt,
  materializeClaims,
  modelCheck,
  MUSE_SPARK,
  onEvent,
  selectCandidates,
  sendToReview,
  sortEvents,
  type BrainState,
  type ClaimStatus,
  type Event,
  type JsonModel,
} from "@plumb/core";
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
const plumb: System = (s) => runPlumb(s);

/** Plumb on hand-written claims: Part B, plus the Part C model check when a model is given. */
async function runPlumb(s: Scenario, model?: JsonModel): Promise<SystemRun> {
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
    const ctx = { now: event.occurred_at, newId: randomUUID };
    onEvent(state, event, ctx);
    if (model) {
      const checked = await modelCheck(model, event, selectCandidates(state, event));
      for (const f of checked.flags) sendToReview(state, f.claim_id, ctx, { explanation: f.explanation, event_id: f.event_id });
    }
    statusAfter.set(
      key,
      new Map(Object.entries(m.id_map).map(([k, id]) => [k, state.claims.get(id)!.status])),
    );
  }
  return { statusAfter };
}

// Baseline 2 (tab 5): give Muse Spark the claims and the events so far, and
// ask which claims are now false. One call per event, so it sees what we see.
const BaselineOutput = z.object({ claims: z.array(z.object({ id: z.string(), status: z.enum(["IN", "OUT"]) })) });
const BASELINE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string", enum: ["IN", "OUT"] } },
        required: ["id", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

async function runLlmOnly(s: Scenario, model: JsonModel): Promise<SystemRun> {
  const developer = await loadPrompt("baseline.v1");
  // Neutral ids, so the model can't read hints from our keys.
  const ids = new Map(s.claims.map((c, i) => [`c${i + 1}`, c.temp_id]));
  const claimLines = s.claims.map((c, i) => `c${i + 1} [${c.kind}, written ${c.valid_from}] ${c.text}`).join("\n");
  const events = toEvents(s);
  const statusAfter = new Map<string, Map<string, ClaimStatus>>();
  for (let i = 0; i < events.length; i++) {
    const { key, event } = events[i]!;
    const eventLines = events
      .slice(0, i + 1)
      .map(({ event: e }) => `- ${e.occurred_at} ${e.kind}${e.from ? ` from ${e.from}` : ""}${e.thread_id ? ` (thread ${e.thread_id})` : ""}: ${e.summary}`)
      .join("\n");
    const statuses = new Map(s.claims.map((c) => [c.temp_id, "IN" as ClaimStatus]));
    try {
      const out = await model.json({
        job: "eval_llm_only",
        developer,
        user: `Now: ${event.occurred_at}\n\nClaims:\n${claimLines}\n\nEvents:\n${eventLines}`,
        schemaName: "statuses",
        jsonSchema: BASELINE_SCHEMA,
        parse: BaselineOutput,
        effort: "medium",
        model: MUSE_SPARK,
      });
      for (const c of out.claims) {
        const k = ids.get(c.id);
        if (k) statuses.set(k, c.status);
      }
    } catch {
      // A failed call leaves everything IN, the same as doing nothing.
    }
    statusAfter.set(key, statuses);
  }
  return { statusAfter };
}

export const modelSystems = (model: JsonModel): Record<string, System> => ({
  plumb_with_check: (s) => runPlumb(s, model),
  llm_only: (s) => runLlmOnly(s, model),
});

/** Baseline 1: claims stay IN forever. */
const doNothing: System = async (s) => ({
  statusAfter: new Map(s.events.map((e) => [e.key, new Map(s.claims.map((c) => [c.temp_id, "IN" as const]))])),
});

export const systems: Record<string, System> = { plumb, do_nothing: doNothing };
