// Brain Part C: the model check. Catches what Part B's patterns miss: a reply
// in a new thread, a forwarded email, a person writing from a new address.
// Code picks the candidates; Muse Spark answers one question per candidate;
// code checks the answer. The result can only send a claim to REVIEW, never OUT.
import { z } from "zod";
import type { Claim, Event } from "../contract.js";
import { MUSE_SPARK } from "../meta/client.js";
import { explainModelCheck } from "./explain.js";
import { loadPrompt, type JsonModel } from "./extract.js";
import { normalizeAddress, type BrainState } from "./invalidate.js";

export const CHECK_PROMPT = "check.v3";
const MAX_CANDIDATES = 8;
const PARALLEL = 4;
const QUOTE_MAX = 200;

// Common words that say nothing about which claim an event is about.
const STOP = new Set(
  "the a an and or but of to in on for with from about at by is are was were be been it this that these those re fwd fw your you our we i me my he she they them his her their not no yes just has have had will would can could should do does did any some all more most new update hi hello thanks thank regards".split(" "),
);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

/** Name parts of a sender: "Matt Jones <mj@new.com>" gives matt and jones; "matt.jones@x" gives matt and jones. */
export function senderNames(from: string): string[] {
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? "";
  const local = normalizeAddress(from).split("@")[0] ?? "";
  return [...new Set([...words(display), ...words(local.replace(/[._-]+/g, " "))])];
}

export interface Candidate {
  claim: Claim;
  score: number;
  signals: string[]; // why it was picked, for logs and evals
}

/**
 * IN claims this event might touch, best first. Signals: the same thread,
 * sender or source as one of the claim's patterns, the sender's name in the
 * claim, or shared words with a text_hint or the claim. Clock ticks never
 * reach the model.
 */
export function selectCandidates(state: BrainState, event: Event, max = MAX_CANDIDATES): Candidate[] {
  if (event.kind === "clock") return [];
  const from = event.from ? normalizeAddress(event.from) : undefined;
  const names = event.from ? senderNames(event.from) : [];
  const eventWords = words(event.summary);

  const out: Candidate[] = [];
  const eventAt = Date.parse(event.occurred_at);
  for (const claim of state.claims.values()) {
    if (claim.status !== "IN") continue;
    // The claim was written knowing about anything before it: a late-seen old email is not news.
    if (eventAt <= Date.parse(claim.valid_from)) continue;
    const signals: string[] = [];
    let score = 0;
    const hints: string[] = [];
    for (const r of state.reasons) {
      if (r.claim_id !== claim.id || r.type !== "absence") continue;
      const p = r.pattern;
      if (p.thread_id && p.thread_id === event.thread_id) (score += 3), signals.push("same thread");
      if (p.from && from && normalizeAddress(p.from) === from) (score += 3), signals.push("same sender");
      if (p.source_id && p.source_id === event.source_id) (score += 3), signals.push("same source");
      if (p.text_hint) hints.push(p.text_hint);
    }
    if (claim.source_id === event.source_id) (score += 2), signals.push("claim came from this source");
    const claimWords = words(claim.text);
    const named = names.filter((n) => claimWords.has(n));
    if (named.length) (score += 2), signals.push(`sender named in claim (${named.join(", ")})`);
    const shared = [...words([claim.text, ...hints].join(" "))].filter((w) => eventWords.has(w));
    // Two shared words are enough on their own: session notes and doc edits have no sender or thread to match.
    if (shared.length >= 2) (score += shared.length), signals.push(`shared words (${shared.join(", ")})`);
    // One weak signal is not enough; two shared words or any strong one is.
    if (score >= 2) out.push({ claim, score, signals: [...new Set(signals)] });
  }
  return out.sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id)).slice(0, max);
}

const Verdict = z.object({
  verdict: z.enum(["yes", "no", "unsure"]),
  quote: z.string().nullable(),
  why: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["yes", "no", "unsure"] },
    quote: { anyOf: [{ type: "string" }, { type: "null" }] },
    why: { type: "string" },
  },
  required: ["verdict", "quote", "why"],
  additionalProperties: false,
};

export function buildCheckMessage(claim: Claim, event: Event): string {
  return [
    `Claim (${claim.kind}, recorded ${claim.recorded_at}): ${claim.text}`,
    "",
    `Event: ${event.kind} at ${event.occurred_at}`,
    ...(event.from ? [`From: ${event.from}`] : []),
    ...(event.thread_id ? [`Thread: ${event.thread_id}`] : []),
    "<<<",
    event.summary,
    ">>>",
  ].join("\n");
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The quote shown to Usman must be words the event really contains; otherwise show the start of the event. */
export function checkedQuote(quote: string | null, event: Event): string {
  const q = quote?.trim();
  if (q && squash(event.summary).includes(squash(q))) return q.slice(0, QUOTE_MAX);
  return event.summary.slice(0, QUOTE_MAX);
}

export interface ReviewFlag {
  claim_id: string;
  event_id: string;
  verdict: "yes" | "unsure";
  quote: string;
  explanation: string;
}

export interface CheckResult {
  flags: ReviewFlag[]; // claims to send to REVIEW
  checked: { claim_id: string; verdict: Verdict["verdict"] | "error"; signals: string[] }[];
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

/**
 * Ask the model about each candidate. A failed call counts as "no" and is
 * reported: the check is a safety net, so it must never block an event.
 */
export async function modelCheck(
  model: JsonModel,
  event: Event,
  candidates: Candidate[],
  modelId = MUSE_SPARK,
): Promise<CheckResult> {
  const developer = await loadPrompt(CHECK_PROMPT);
  const answers = await inBatches(candidates, PARALLEL, async (c) => {
    try {
      const v = await model.json({
        job: "model_check",
        developer,
        user: buildCheckMessage(c.claim, event),
        schemaName: "verdict",
        jsonSchema: VERDICT_SCHEMA,
        parse: Verdict,
        effort: "low",
        model: modelId,
      });
      return { c, v };
    } catch {
      return { c, v: undefined };
    }
  });

  const result: CheckResult = { flags: [], checked: [] };
  for (const { c, v } of answers) {
    result.checked.push({ claim_id: c.claim.id, verdict: v?.verdict ?? "error", signals: c.signals });
    if (!v || v.verdict === "no") continue;
    const quote = checkedQuote(v.quote, event);
    result.flags.push({
      claim_id: c.claim.id,
      event_id: event.id,
      verdict: v.verdict,
      quote,
      explanation: explainModelCheck(event, v.verdict, quote),
    });
  }
  return result;
}
