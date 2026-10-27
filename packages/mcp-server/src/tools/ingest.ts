// POST /ingest: text in, claims out. Extraction (Brain Part A) reads the text
// next to the project's IN claims and the email threads we know about, so it
// can point at real claim ids, addresses and thread ids. Then, in order:
// 1. The text is recorded as an event (doc_edited for a doc, session_note for
//    anything else) with a short summary, never the full text. Parts B and C
//    run on it, and the sweep re-reads it later, the same as an email.
// 2. record_claims writes the new claims. They come after the event, so a
//    claim is never flagged by the text that created it.
// 3. Current claims the text contradicts go to REVIEW.
import type { z } from "zod";
import {
  explainContradicted,
  extractClaims,
  knownThreads,
  type IngestInput,
  type IngestOutput,
  type JsonModel,
} from "@plumb/core";
import { createHandlers, ToolError } from "./handlers.js";
import type { Store } from "./store.js";

const MAX_CHARS = 200_000; // about 50k tokens; longer text keeps its end, the most recent part
const FALLBACK_SUMMARY = 600; // if extraction failed: the end of the text, the most recent part
const MAX_IN_CLAIMS = 200;
const THREAD_DAYS = 30;

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

  const handlers = createHandlers(store, { model });
  const text = input.text.trim();
  const summary = result.summary || (text.length > FALLBACK_SUMMARY ? `...${text.slice(-FALLBACK_SUMMARY)}` : text);
  const recordedEvent = await handlers.record_event({
    kind: input.source.kind === "doc" ? "doc_edited" : "session_note",
    source: input.source,
    occurred_at: input.at ?? now,
    summary: summary.slice(0, 1000),
  });

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

  return {
    ...recorded,
    extracted_by: result.extracted_by,
    review,
    event: recordedEvent.event,
    event_transitions: recordedEvent.transitions,
    dropped: result.dropped,
    truncated,
  };
}
