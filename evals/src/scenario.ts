// Scenario files in evals/scenarios. Format from tab 5, with one addition for
// day 2: `claims` holds hand-written claims so Part B can be tested before
// extraction exists. Later scenarios use `texts` and run extraction instead.
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
  source: z.object({ kind: SourceKind, external_id: z.string(), title: z.string().optional() }),
  at: Timestamp,
  text: z.string(),
});

export const Checkpoint = z.object({
  after: z.string(), // event key
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
    events: z.array(ScenarioEvent).min(1),
    expected: z.array(Checkpoint).min(1),
  })
  .superRefine((s, ctx) => {
    const claimKeys = new Set(s.claims.map((c) => c.temp_id));
    const eventKeys = new Set(s.events.map((e) => e.key));
    for (const cp of s.expected) {
      if (!eventKeys.has(cp.after)) ctx.addIssue({ code: "custom", message: `unknown event key ${cp.after}` });
      for (const k of [...Object.keys(cp.status), ...cp.chain]) {
        if (s.claims.length && !claimKeys.has(k)) ctx.addIssue({ code: "custom", message: `unknown claim key ${k}` });
      }
    }
  });
export type Scenario = z.infer<typeof Scenario>;
