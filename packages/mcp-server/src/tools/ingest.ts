// POST /ingest: text in, claims out. Extraction (Brain Part A) reads the text
// next to the project's IN claims and the email threads we know about, so it
// can point at real claim ids, addresses and thread ids. Then record_claims
// writes what passed the checks, and contradicted claims go to REVIEW.
import type { z } from "zod";
import {
  explainContradicted,
  extractClaims,
  normalizeAddress,
  type Event,
  type IngestInput,
  type IngestOutput,
  type JsonModel,
  type KnownThread,
} from "@plumb/core";
import { createHandlers, ToolError } from "./handlers.js";
import type { Store } from "./store.js";

const MAX_CHARS = 200_000; // about 50k tokens; longer text keeps its end, the most recent part
const MAX_IN_CLAIMS = 200;
const MAX_THREADS = 50;
const THREAD_DAYS = 30;
const SUBJECT_MAX = 120;

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

export async function ingest(
  store: Store,
  model: JsonModel,
  input: z.infer<typeof IngestInput>,
): Promise<z.infer<typeof IngestOutput>> {
  const project = await store.getProject(input.project_id);
  if (!project) throw new ToolError("not_found", `unknown project ${input.project_id}`);

  const now = new Date().toISOString();
  const after = new Date(Date.now() - THREAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [claims, emails] = await Promise.all([
    store.loadClaims({ project_id: project.id }),
    store.loadEvents({ kinds: ["email_received", "email_sent"], after }),
  ]);
  const in_claims = claims
    .filter((c) => c.status === "IN")
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .slice(0, MAX_IN_CLAIMS);

  const truncated = input.text.length > MAX_CHARS;
  const result = await extractClaims(model, {
    text: truncated ? input.text.slice(-MAX_CHARS) : input.text,
    source: input.source,
    at: input.at ?? now,
    now,
    in_claims,
    threads: knownThreads(emails),
  });

  const handlers = createHandlers(store);
  const recorded = result.claims.length
    ? await handlers.record_claims({
        project_id: project.id,
        source: input.source,
        extracted_by: result.extracted_by,
        claims: result.claims,
      })
    : { claims: [], reasons: [], id_map: {} };
  const sourceTitle = input.source.title ? `"${input.source.title}"` : `a ${input.source.kind.replace("_", " ")} note`;
  const review = await handlers.review(
    result.contradicts.map((c) => ({ claim_id: c.claim_id, explanation: explainContradicted(sourceTitle, c.quote) })),
  );

  return { ...recorded, extracted_by: result.extracted_by, review, dropped: result.dropped, truncated };
}
