// Sleep-time sweep (tab 2, "the plus"): a background job every few hours.
// Main updates stay event-driven (Parts B and C); the sweep catches what they
// can't. Like Part C, it can only send claims to REVIEW, never OUT.
//
// 1. Re-check: claims whose only breakable reasons are text_hint absences.
//    Code can never break them, and Part C only sees events that share words
//    with them. The sweep re-reads every new event against each one, at high effort.
// 2. Duplicates: claims in a project that say the same thing. The newer copy
//    goes to REVIEW; code keeps the older one and never flags a claim that
//    others depend on, so confirming it OUT can't knock anything down.
import { z } from "zod";
import type { Claim, Event } from "../contract.js";
import { MUSE_SPARK } from "../meta/client.js";
import { checkedQuote } from "./check.js";
import { DUPLICATE_PREFIX, explainDuplicate, explainSweep } from "./explain.js";
import { loadPrompt, type JsonModel } from "./extract.js";
import { hasCodePattern, type BrainState } from "./invalidate.js";

export const RECHECK_PROMPT = "sweep-recheck.v2";
export const DUPLICATES_PROMPT = "sweep-duplicates.v1";
const MAX_RECHECK = 30; // claims per sweep
const MAX_EVENTS = 30; // newest events shown per claim
const MAX_DUP_CLAIMS = 200; // newest IN claims per project
const PARALLEL = 4;

/** A claim the sweep sends to REVIEW. */
export interface SweepFlag {
  claim_id: string;
  explanation: string;
  event_id?: string;
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

/** IN claims code can never break by itself: they have absences, and every one is a text_hint. */
export function hintOnlyClaims(state: BrainState): Claim[] {
  return [...state.claims.values()].filter((claim) => {
    if (claim.status !== "IN") return false;
    const absences = state.reasons.filter((r) => r.claim_id === claim.id && r.type === "absence");
    return absences.length > 0 && absences.every((r) => r.type === "absence" && !hasCodePattern(r.pattern));
  });
}

const Recheck = z.object({
  verdict: z.enum(["yes", "no", "unsure"]),
  event: z.number().int().nullable(),
  quote: z.string().nullable(),
  why: z.string(),
});
const RECHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["yes", "no", "unsure"] },
    event: { anyOf: [{ type: "integer" }, { type: "null" }] },
    quote: { anyOf: [{ type: "string" }, { type: "null" }] },
    why: { type: "string" },
  },
  required: ["verdict", "event", "quote", "why"],
  additionalProperties: false,
};

function recheckMessage(claim: Claim, hints: string[], events: Event[]): string {
  return [
    `Claim (${claim.kind}, written ${claim.valid_from}): ${claim.text}`,
    `News that would break it: ${hints.join("; ")}`,
    "",
    "Events since then, oldest first:",
    ...events.map(
      (e, i) =>
        `${i + 1}. ${e.occurred_at} ${e.kind}${e.from ? ` from ${e.from}` : ""}${e.thread_id ? ` (thread ${e.thread_id})` : ""}:\n<<<\n${e.summary}\n>>>`,
    ),
  ].join("\n");
}

/**
 * Re-check hint-only claims against `events` (the events new since the last
 * sweep). Each claim only sees events after it became true. A failed call
 * counts as no: the sweep is a safety net and must never block anything.
 */
export async function recheckClaims(
  model: JsonModel,
  state: BrainState,
  events: Event[],
  modelId = MUSE_SPARK,
): Promise<{ flags: SweepFlag[]; checked: number }> {
  const news = events
    .filter((e) => e.kind !== "clock")
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id));
  const work = hintOnlyClaims(state)
    .map((claim) => ({
      claim,
      events: news.filter((e) => Date.parse(e.occurred_at) > Date.parse(claim.valid_from)).slice(-MAX_EVENTS),
    }))
    .filter((w) => w.events.length > 0)
    .slice(0, MAX_RECHECK);
  if (work.length === 0) return { flags: [], checked: 0 };

  const developer = await loadPrompt(RECHECK_PROMPT);
  const results = await inBatches(work, PARALLEL, async ({ claim, events: evs }) => {
    const hints = state.reasons.flatMap((r) =>
      r.claim_id === claim.id && r.type === "absence" && r.pattern.text_hint ? [r.pattern.text_hint] : [],
    );
    try {
      const v = await model.json({
        job: "sweep_recheck",
        developer,
        user: recheckMessage(claim, hints, evs),
        schemaName: "recheck",
        jsonSchema: RECHECK_SCHEMA,
        parse: Recheck,
        effort: "high",
        model: modelId,
      });
      const event = v.event !== null ? evs[v.event - 1] : undefined;
      if (v.verdict === "no" || !event) return undefined;
      const quote = checkedQuote(v.quote, event);
      return { claim_id: claim.id, event_id: event.id, explanation: explainSweep(event, v.verdict, quote) };
    } catch {
      return undefined;
    }
  });
  return { flags: results.filter((f): f is NonNullable<typeof f> => f !== undefined), checked: work.length };
}

const Duplicates = z.object({ groups: z.array(z.object({ refs: z.array(z.string()), why: z.string() })) });
const DUPLICATES_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: { refs: { type: "array", items: { type: "string" } }, why: { type: "string" } },
        required: ["refs", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

const older = (a: Claim, b: Claim) =>
  Date.parse(a.valid_from) - Date.parse(b.valid_from) || Date.parse(a.recorded_at) - Date.parse(b.recorded_at) || a.id.localeCompare(b.id);

/**
 * Find repeats among each project's IN claims. In each group code keeps the
 * oldest claim and flags the rest, except claims others depend on and claims
 * Usman already saw flagged as a repeat (so a "still true" isn't asked again).
 */
export async function findDuplicates(model: JsonModel, state: BrainState, modelId = MUSE_SPARK): Promise<SweepFlag[]> {
  const byProject = new Map<string, Claim[]>();
  for (const c of state.claims.values()) {
    if (c.status !== "IN") continue;
    byProject.set(c.project_id, [...(byProject.get(c.project_id) ?? []), c]);
  }
  const dependedOn = new Set(state.reasons.flatMap((r) => (r.type === "depends_on" ? [r.claim] : [])));
  const flaggedBefore = new Set(
    state.transitions.filter((t) => t.explanation.startsWith(DUPLICATE_PREFIX)).map((t) => t.claim_id),
  );

  const developer = await loadPrompt(DUPLICATES_PROMPT);
  const flags: SweepFlag[] = [];
  for (const all of byProject.values()) {
    const claims = [...all].sort(older).slice(-MAX_DUP_CLAIMS);
    if (claims.length < 2) continue;
    const refs = new Map(claims.map((c, i) => [`c${i + 1}`, c]));
    let out: z.infer<typeof Duplicates>;
    try {
      out = await model.json({
        job: "sweep_duplicates",
        developer,
        user: claims.map((c, i) => `c${i + 1} [${c.kind}] ${c.text}`).join("\n"),
        schemaName: "duplicates",
        jsonSchema: DUPLICATES_SCHEMA,
        parse: Duplicates,
        effort: "high",
        model: modelId,
      });
    } catch {
      continue;
    }
    const used = new Set<string>();
    for (const g of out.groups) {
      const group = [...new Set(g.refs)]
        .map((r) => refs.get(r))
        .filter((c): c is Claim => c !== undefined && !used.has(c.id))
        .sort(older);
      if (group.length < 2) continue;
      group.forEach((c) => used.add(c.id));
      const [kept, ...repeats] = group;
      for (const c of repeats) {
        if (dependedOn.has(c.id) || flaggedBefore.has(c.id)) continue;
        flags.push({ claim_id: c.id, explanation: explainDuplicate(kept!) });
      }
    }
  }
  return flags;
}
