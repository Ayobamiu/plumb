// Brain Part A: extraction. Muse Spark turns text into claims plus reasons;
// code checks every field before anything reaches record_claims. A bad reason
// is dropped, a claim left with no reason is dropped, and every drop is
// reported so nothing disappears silently.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ClaimKind, type AbsencePattern, type Claim, type Event, type SourceKind } from "../contract.js";
import { MUSE_SPARK, type JsonCallOptions } from "../meta/client.js";
import type { NewClaim, NewReason } from "../tools.js";
import { normalizeAddress } from "./invalidate.js";

export const EXTRACT_PROMPT = "extract.v6";
const MAX_CLAIMS = 20;
const QUOTE_MAX = 200;
const MAX_THREADS = 50;
const SUMMARY_MAX = 600;
const TITLE_MAX = 80; // the prompt asks for 60; leave room before cutting
const SUBJECT_MAX = 120;

/** What extraction needs from a model client. MetaClient fits; tests pass a fake. */
export interface JsonModel {
  json<T>(opts: JsonCallOptions<T>): Promise<T>;
}

export interface KnownThread {
  thread_id: string;
  subject: string;
  participants: string[]; // email addresses that wrote in this thread
}

export interface ExtractInput {
  text: string;
  source: { kind: SourceKind; title?: string };
  at: string; // when the text was written
  now: string;
  in_claims: Pick<Claim, "id" | "text" | "kind">[];
  threads: KnownThread[];
}

export interface Dropped {
  text: string;
  why: string;
}

export interface Contradiction {
  claim_id: string;
  quote: string;
}

export interface ExtractResult {
  claims: NewClaim[];
  contradicts: Contradiction[];
  dropped: Dropped[];
  summary: string; // what the text reports happened; empty if the model call failed
  mentions: string[]; // ids of current claims the text talks about without changing them
  title: string; // a short name for the session or doc; empty if the model call failed
  extracted_by: string; // model id plus prompt version
}

/** Email threads seen recently, newest first, with who wrote in each. */
export function knownThreads(events: Event[]): KnownThread[] {
  const byThread = new Map<string, { thread: KnownThread; last: number }>();
  for (const e of events) {
    if (!e.thread_id) continue;
    const at = Date.parse(e.occurred_at);
    const entry = byThread.get(e.thread_id) ?? { thread: { thread_id: e.thread_id, subject: "", participants: [] }, last: 0 };
    if (at >= entry.last) {
      entry.last = at;
      entry.thread.subject = e.summary.slice(0, SUBJECT_MAX);
    }
    // Sent mail is from Usman; the model never needs his address in a pattern.
    if (e.kind === "email_received" && e.from) {
      const from = normalizeAddress(e.from);
      if (!entry.thread.participants.includes(from)) entry.thread.participants.push(from);
    }
    byThread.set(e.thread_id, entry);
  }
  return [...byThread.values()]
    .sort((a, b) => b.last - a.last)
    .slice(0, MAX_THREADS)
    .map((x) => x.thread);
}

// ---- What the model returns. Flat and nullable, as strict JSON schema needs.

const ModelReason = z.object({
  type: z.enum(["absence", "until", "depends_on"]),
  event_kind: z.enum(["email_received", "email_sent", "doc_edited"]).nullable(),
  from: z.string().nullable(),
  thread_id: z.string().nullable(),
  text_hint: z.string().nullable(),
  since: z.string().nullable(),
  at: z.string().nullable(),
  claim_ref: z.string().nullable(),
});
const ModelClaim = z.object({
  ref: z.string(),
  text: z.string(),
  kind: ClaimKind,
  valid_from: z.string().nullable(),
  confidence: z.number(),
  same_as: z.string().nullable(),
  reasons: z.array(ModelReason),
});
const ModelOutput = z.object({
  claims: z.array(ModelClaim),
  contradicts: z.array(z.object({ ref: z.string(), quote: z.string() })),
  summary: z.string().catch(""), // older answers and test fakes may leave it out
  mentions: z.array(z.string()).catch([]),
  title: z.string().catch(""),
});
type ModelOutput = z.infer<typeof ModelOutput>;
type ModelReason = z.infer<typeof ModelReason>;

const str = { type: "string" };
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const EXTRACT_JSON_SCHEMA = object({
  claims: {
    type: "array",
    items: object({
      ref: str,
      text: str,
      kind: { type: "string", enum: ClaimKind.options },
      valid_from: nullable(str),
      confidence: { type: "number" },
      same_as: nullable(str),
      reasons: {
        type: "array",
        items: object({
          type: { type: "string", enum: ["absence", "until", "depends_on"] },
          event_kind: nullable({ type: "string", enum: ["email_received", "email_sent", "doc_edited"] }),
          from: nullable(str),
          thread_id: nullable(str),
          text_hint: nullable(str),
          since: nullable(str),
          at: nullable(str),
          claim_ref: nullable(str),
        }),
      },
    }),
  },
  contradicts: { type: "array", items: object({ ref: str, quote: str }) },
  summary: str,
  mentions: { type: "array", items: str },
  title: str,
});

// ---- Prompt files live in /prompts, versioned, so evals can compare them.

const PROMPTS_DIR = process.env.PLUMB_PROMPTS_DIR ?? fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const prompts = new Map<string, Promise<string>>();

export function loadPrompt(name: string): Promise<string> {
  if (!prompts.has(name)) prompts.set(name, readFile(join(PROMPTS_DIR, `${name}.md`), "utf8"));
  return prompts.get(name)!;
}

export function buildExtractMessage(input: ExtractInput): string {
  const claims = input.in_claims.length
    ? input.in_claims.map((c, i) => `c${i + 1} [${c.kind}] ${c.text}`).join("\n")
    : "(none)";
  const threads = input.threads.length
    ? input.threads.map((t) => `- thread_id ${t.thread_id}: "${t.subject}" with ${t.participants.join(", ") || "(only Usman)"}`).join("\n")
    : "(none)";
  return [
    `Now: ${input.now}. Usman's time zone: America/New_York.`,
    `Text written at: ${input.at}`,
    `Source: ${input.source.kind}${input.source.title ? ` "${input.source.title}"` : ""}`,
    "",
    "Current claims:",
    claims,
    "",
    "Known email threads (copy ids and addresses exactly):",
    threads,
    "",
    "Text:",
    "<<<",
    input.text,
    ">>>",
  ].join("\n");
}

// ---- Checks: model output to record_claims input.

const Iso = z.string().datetime({ offset: true });
const isIso = (s: string | null): s is string => s !== null && Iso.safeParse(s).success;
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

interface Context {
  input: ExtractInput;
  existing: Map<string, string>; // c ref to claim id
  threads: Set<string>;
}

function toAbsence(r: ModelReason, claimText: string, ctx: Context): NewReason | string {
  if (!r.event_kind) return "absence without event_kind";
  const pattern: AbsencePattern = { event_kind: r.event_kind };
  const from = r.from ? normalizeAddress(r.from) : undefined;
  if (from && EMAIL.test(from)) pattern.from = from;
  // An unknown thread id is a guess. Dropping it widens the pattern to the
  // sender, which still means "no word from them"; keeping it would never match.
  if (r.thread_id && ctx.threads.has(r.thread_id)) pattern.thread_id = r.thread_id;
  if (!pattern.from && !pattern.thread_id) pattern.text_hint = r.text_hint?.trim() || claimText;
  else if (r.text_hint?.trim()) pattern.text_hint = r.text_hint.trim();
  return { type: "absence", pattern, since: isIso(r.since) ? r.since : ctx.input.at };
}

function toReason(r: ModelReason, claimText: string, ref: string, refs: Set<string>, ctx: Context): NewReason | string {
  switch (r.type) {
    case "absence":
      return toAbsence(r, claimText, ctx);
    case "until":
      return isIso(r.at) ? { type: "until", at: r.at } : `until with a bad time: ${r.at}`;
    case "depends_on": {
      const target = r.claim_ref ? (ctx.existing.get(r.claim_ref) ?? (refs.has(r.claim_ref) ? r.claim_ref : undefined)) : undefined;
      if (!target) return `depends_on points at unknown ref ${r.claim_ref}`;
      if (target === ref) return "depends_on points at itself";
      return { type: "depends_on", claim: target };
    }
  }
}

export function checkExtraction(out: ModelOutput, input: ExtractInput): Omit<ExtractResult, "extracted_by"> {
  const ctx: Context = {
    input,
    existing: new Map(input.in_claims.map((c, i) => [`c${i + 1}`, c.id])),
    threads: new Set(input.threads.map((t) => t.thread_id)),
  };
  const dropped: Dropped[] = [];

  // Refs must be new and unique; a repeated ref would make depends_on ambiguous.
  const seen = new Set<string>();
  const candidates = out.claims.slice(0, MAX_CLAIMS).filter((c) => {
    const ok = c.ref.trim() !== "" && !seen.has(c.ref) && !ctx.existing.has(c.ref) && c.text.trim() !== "";
    if (!ok) dropped.push({ text: c.text, why: `bad or repeated ref ${c.ref}` });
    seen.add(c.ref);
    return ok;
  });
  for (const c of out.claims.slice(MAX_CLAIMS)) dropped.push({ text: c.text, why: `over the ${MAX_CLAIMS} claim limit` });

  // Drop claims with no valid reason, then any reason pointing at a dropped
  // claim, until nothing changes.
  let claims: NewClaim[] = [];
  let refs = new Set(candidates.map((c) => c.ref));
  for (let changed = true; changed; ) {
    changed = false;
    claims = [];
    for (const c of candidates.filter((c) => refs.has(c.ref))) {
      const problems: string[] = [];
      const reasons: NewReason[] = [];
      for (const r of c.reasons) {
        const reason = toReason(r, c.text.trim(), c.ref, refs, ctx);
        if (typeof reason === "string") problems.push(reason);
        else reasons.push(reason);
      }
      if (reasons.length === 0) {
        dropped.push({ text: c.text, why: problems.join("; ") || "no reason given" });
        refs.delete(c.ref);
        changed = true;
        break;
      }
      const same_as = c.same_as ? ctx.existing.get(c.same_as) : undefined;
      claims.push({
        temp_id: c.ref,
        text: c.text.trim(),
        kind: c.kind,
        valid_from: isIso(c.valid_from) ? c.valid_from : input.at,
        confidence: Math.min(1, Math.max(0, c.confidence)),
        ...(same_as && { same_as }),
        reasons,
      });
    }
  }

  const contradicts: Contradiction[] = [];
  for (const c of out.contradicts) {
    const claim_id = ctx.existing.get(c.ref);
    if (!claim_id || !c.quote.trim()) {
      dropped.push({ text: `contradicts ${c.ref}`, why: "unknown claim ref or empty quote" });
      continue;
    }
    if (!contradicts.some((x) => x.claim_id === claim_id)) {
      contradicts.push({ claim_id, quote: c.quote.trim().slice(0, QUOTE_MAX) });
    }
  }
  // Mentioned claims are still in use; contradicted and same_as claims are handled already.
  const handled = new Set([...contradicts.map((c) => c.claim_id), ...claims.flatMap((c) => (c.same_as ? [c.same_as] : []))]);
  const mentions = [...new Set((out.mentions ?? []).map((r) => ctx.existing.get(r)).filter((id): id is string => !!id && !handled.has(id)))];
  const title = (out.title ?? "").replace(/["\u201c\u201d]/g, "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  return { claims, contradicts, dropped, summary: (out.summary ?? "").trim().slice(0, SUMMARY_MAX), mentions, title };
}

/** Extract claims from one chunk of text. Retries the model call once, then gives up and reports it. */
export async function extractClaims(model: JsonModel, input: ExtractInput, modelId = MUSE_SPARK): Promise<ExtractResult> {
  const extracted_by = `${modelId}/${EXTRACT_PROMPT}`;
  const developer = await loadPrompt(EXTRACT_PROMPT);
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await model.json({
        job: "extraction",
        developer,
        user: buildExtractMessage(input),
        schemaName: "claims",
        jsonSchema: EXTRACT_JSON_SCHEMA,
        parse: ModelOutput,
        effort: "medium",
        model: modelId,
      });
      return { ...checkExtraction(out, input), extracted_by };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    claims: [],
    contradicts: [],
    dropped: [{ text: "(whole text)", why: `extraction failed twice: ${lastError}` }],
    summary: "",
    mentions: [],
    title: "",
    extracted_by,
  };
}
