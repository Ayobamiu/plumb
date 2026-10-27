// Scenario files in evals/scenarios. Format from tab 5, with three additions:
// - `claims`: hand-written claims, so Part B is tested without extraction.
// - `texts` plus `find`: text goes through extraction (Brain Part A); `find`
//   says which extracted claim each key means, by words it must contain.
// - `actions`: Usman's decisions (confirm OUT, restore IN), replayed in order.
// Texts, events and actions run as one timeline, ordered by time.
import { ClaimStatus, EventKind, NewClaim, SourceKind } from "@plumb/core";
import { z } from "zod";

const Timestamp = z.string().datetime({ offset: true });

export const ScenarioEvent = z.object({
  key: z.string(),
  kind: EventKind,
  occurred_at: Timestamp,
  from: z.string().optional(),
  thread_id: z.string().optional(),
  summary: z.string(),
});

export const ScenarioText = z.object({
  key: z.string(),
  source: z.object({ kind: SourceKind, external_id: z.string(), title: z.string().optional() }),
  at: Timestamp,
  text: z.string(),
});

export const ScenarioAction = z.object({
  key: z.string(),
  at: Timestamp,
  action: z.enum(["confirm_out", "restore_in"]),
  claim: z.string(), // claim key
});

export const Checkpoint = z.object({
  after: z.string(), // event, text or action key
  // Only claims whose expected status changes need listing; others carry
  // forward from the previous checkpoint, starting at IN.
  status: z.record(z.string(), ClaimStatus),
  chain: z.array(z.string()).default([]), // claim keys that should fall by the chain here
});

export const Scenario = z
  .object({
    id: z.string(),
    title: z.string(),
    split: z.enum(["dev", "heldout"]),
    recorded_at: Timestamp,
    claims: z.array(NewClaim.extend({ temp_id: z.string() })).default([]),
    texts: z.array(ScenarioText).default([]),
    // claim key -> words (lowercase stems) an extracted claim must all contain
    find: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
    events: z.array(ScenarioEvent).default([]),
    actions: z.array(ScenarioAction).default([]),
    expected: z.array(Checkpoint).min(1),
  })
  .superRefine((s, ctx) => {
    const claimKeys = new Set([...s.claims.map((c) => c.temp_id), ...Object.keys(s.find)]);
    const stepKeys = new Set([...s.events, ...s.texts, ...s.actions].map((x) => x.key));
    if (s.texts.length === 0 && Object.keys(s.find).length > 0) {
      ctx.addIssue({ code: "custom", message: "find needs texts" });
    }
    for (const a of s.actions) {
      if (!claimKeys.has(a.claim)) ctx.addIssue({ code: "custom", message: `action ${a.key}: unknown claim key ${a.claim}` });
    }
    for (const cp of s.expected) {
      if (!stepKeys.has(cp.after)) ctx.addIssue({ code: "custom", message: `unknown step key ${cp.after}` });
      for (const k of [...Object.keys(cp.status), ...cp.chain]) {
        if (!claimKeys.has(k)) ctx.addIssue({ code: "custom", message: `unknown claim key ${k}` });
      }
    }
  });
export type Scenario = z.infer<typeof Scenario>;

/** Every claim key the scenario scores: hand-written ones and the ones found in extracted text. */
export const claimKeys = (s: Scenario) => [...s.claims.map((c) => c.temp_id), ...Object.keys(s.find)];

export type Step =
  | { type: "event"; key: string; at: string; event: z.infer<typeof ScenarioEvent> }
  | { type: "text"; key: string; at: string; text: z.infer<typeof ScenarioText> }
  | { type: "action"; key: string; at: string; action: z.infer<typeof ScenarioAction> };

/** One timeline in time order. Ties keep file order: texts, then events, then actions. */
export function timeline(s: Scenario): Step[] {
  const steps: Step[] = [
    ...s.texts.map((text) => ({ type: "text" as const, key: text.key, at: text.at, text })),
    ...s.events.map((event) => ({ type: "event" as const, key: event.key, at: event.occurred_at, event })),
    ...s.actions.map((action) => ({ type: "action" as const, key: action.key, at: action.at, action })),
  ];
  return steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); // stable
}
