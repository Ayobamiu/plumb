// POST /ingest: text in, claims out. Extraction (Brain Part A) reads the text
// next to the project's IN claims and the email threads we know about, so it
// can point at real claim ids, addresses and thread ids. Then, in order:
// 1. The text is recorded as an event (doc_edited for a doc, session_note for
//    anything else) with a short summary, never the full text. Parts B and C
//    run on it, and the sweep re-reads it later, the same as an email.
// 2. record_claims writes the new claims. They come after the event, so a
//    claim is never flagged by the text that created it.
// 3. Current claims the text contradicts go to REVIEW.
// 4. Current claims the text talks about get last_mentioned_at, for the quiet rule.
// With index_only (Oct 28), only a title and summary are written: see indexOnly.
import type { z } from "zod";
import {
  claimPlace,
  explainContradicted,
  explainReplaced,
  extractClaims,
  indexSession,
  isGenericTitle,
  knownThreads,
  placeLabel,
  type IngestInput,
  type IngestOutput,
  type JsonModel,
  type Project,
} from "@plumb/core";
import { basename } from "node:path";
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
  if (input.index_only) return indexOnly(store, model, input);
  const project = await resolveProject(store, input);
  if (!project) throw new ToolError("bad_input", "give project_id or workspace (or set index_only)");

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
  const started = Date.now();
  const result = await extractClaims(model, {
    text: truncated ? input.text.slice(-MAX_CHARS) : input.text,
    source: input.source,
    at: input.at ?? now,
    now,
    in_claims,
    threads: knownThreads(emails),
  });

  // If extraction failed outright, write nothing and say so: the caller keeps its
  // place (doc watcher cursor, hook save state) and sends the text again later.
  // Saving the raw text as the summary would hide the failure and show raw text
  // wherever the session is @'d.
  const failed = result.dropped.find((d) => d.text === "(whole text)");
  if (failed) {
    console.log(JSON.stringify({ ingest: input.source.kind, external_id: input.source.external_id, ok: false, error: failed.why.slice(0, 300), chars: input.text.length, ms: Date.now() - started }));
    throw new ToolError("unavailable", `extraction failed, nothing was saved; send the text again later (${failed.why})`);
  }

  // The tool's own title wins (e.g. a Cursor conversation title); otherwise the one extraction wrote.
  const nativeTitle = input.source.title?.trim();
  const title = nativeTitle && !isGenericTitle(nativeTitle) ? nativeTitle : result.title || nativeTitle;
  const label = input.source.label ?? (result.personal ? "personal" : undefined);
  // Docs are shared across projects (see contexts.ts), so they never take one.
  const project_id = input.source.kind === "doc" ? undefined : project.id;
  const source = { ...input.source, ...(title && { title }), ...(label && { label }), ...(project_id && { project_id }) };

  const handlers = createHandlers(store, { model });
  const text = input.text.trim();
  // Extraction worked but wrote no summary: fall back to the end of the text.
  const summary = result.summary || (text.length > FALLBACK_SUMMARY ? `...${text.slice(-FALLBACK_SUMMARY)}` : text);
  const recordedEvent = await handlers.record_event({
    kind: source.kind === "doc" ? "doc_edited" : "session_note",
    source,
    occurred_at: input.at ?? now,
    summary: summary.slice(0, 1000),
  });

  // A claim from a doc keeps its place ("Slide 3: ..."), so a flag can point at it.
  const placed = source.kind !== "doc" ? result.claims : result.claims.map((c) => {
    const place = placeLabel(c.text, input.text);
    return place ? { ...c, text: `${place}: ${c.text}` } : c;
  });
  const recorded = placed.length
    ? await handlers.record_claims({
        project_id: project.id,
        source,
        extracted_by: result.extracted_by,
        claims: placed,
      })
    : { claims: [], reasons: [], id_map: {} };
  const sourceTitle = source.title ? `"${source.title}"` : `a ${source.kind.replace("_", " ")} note`;
  // Same rule as the model check: a claim was written knowing about anything
  // before it, so an old session saved late can't flag a newer claim.
  const textAt = Date.parse(input.at ?? now);
  const validFrom = new Map(claims.map((c) => [c.id, Date.parse(c.valid_from)]));
  const review = await handlers.review(
    result.contradicts
      .filter((c) => !(textAt <= (validFrom.get(c.claim_id) ?? -Infinity)))
      .map((c) => ({ claim_id: c.claim_id, explanation: explainContradicted(sourceTitle, c.quote) })),
  );

  // Claims the text talked about, or added a reason to, are still in use.
  const sameAs = result.claims.flatMap((c) => (c.same_as ? [c.same_as] : []));

  // A rewritten slide closes its old claims (Oct 31), so a fixed slide stops being
  // flagged. Plain code: same doc, same "Slide 3" label, and the text didn't repeat it.
  if (source.kind === "doc") {
    const kept = new Set([...sameAs, ...result.mentions]);
    const fresh = new Map(recorded.claims.flatMap((c) => { const p = claimPlace(c.text); return p ? [[p.toLowerCase(), c] as const] : []; }));
    const older = claims.filter((c) => c.source_id === recordedEvent.event.source_id && c.status !== "OUT" && !kept.has(c.id));
    await handlers.retire(older.flatMap((c) => {
      const place = claimPlace(c.text);
      const next = place && fresh.get(place.toLowerCase());
      return next ? [{ claim_id: c.id, explanation: explainReplaced(place, next.text) }] : [];
    }));
  }
  await handlers.mention([...result.mentions, ...sameAs], input.at ?? now);

  // One line per ingest in the server log.
  console.log(
    JSON.stringify({
      ingest: source.kind,
      external_id: source.external_id,
      ok: true,
      chars: input.text.length,
      ms: Date.now() - started,
      claims: recorded.claims.length,
      review: review.length,
      title: source.title ?? null,
    }),
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

// Workspaces (Oct 29): users never pick projects. A session names the folder it
// ran in (or "chats"), and lands in the user's project for that folder, made on
// first use. An explicit project_id still wins.
export const CHATS_WORKSPACE = "chats";

export async function workspaceProject(store: Store, workspace: string): Promise<Project> {
  const ws = workspace.trim().replace(/[\\/]+$/, "") || CHATS_WORKSPACE;
  const find = async () => (await store.listProjects()).find((p) => p.workspace === ws);
  const found = await find();
  if (found) return found;
  const name = ws === CHATS_WORKSPACE ? "Chats" : basename(ws) || ws;
  try {
    return await store.createProject(name, "", ws);
  } catch (err) {
    const raced = await find(); // two saves from the same new folder at once
    if (raced) return raced;
    throw err;
  }
}

async function resolveProject(store: Store, input: z.infer<typeof IngestInput>): Promise<Project | undefined> {
  if (input.project_id) {
    const project = await store.getProject(input.project_id);
    if (!project) throw new ToolError("not_found", `unknown project ${input.project_id}`);
    return project;
  }
  return input.workspace ? workspaceProject(store, input.workspace) : undefined;
}

// Index mode: one low-effort call for a title, a summary and whether it's
// personal, then the summary is recorded as an event so search can find the
// session. No claims and no Part C model check, which keeps it cheap enough to
// run on every session from every tool. Part B still runs (plain code).
async function indexOnly(store: Store, model: JsonModel, input: z.infer<typeof IngestInput>): Promise<z.infer<typeof IngestOutput>> {
  const project = await resolveProject(store, input);
  const now = new Date().toISOString();
  const started = Date.now();
  let indexed;
  try {
    indexed = await indexSession(model, { text: input.text, source: input.source });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ingest: input.source.kind, external_id: input.source.external_id, index_only: true, ok: false, error: why.slice(0, 300), chars: input.text.length, ms: Date.now() - started }));
    throw new ToolError("unavailable", `indexing failed, nothing was saved; send the text again later (${why})`);
  }

  const nativeTitle = input.source.title?.trim();
  const title = nativeTitle && !isGenericTitle(nativeTitle) ? nativeTitle : indexed.title || nativeTitle;
  const label = input.source.label ?? (indexed.personal ? "personal" : undefined);
  // Docs are shared across projects (see contexts.ts), so they never take one.
  const project_id = input.source.kind === "doc" ? undefined : project?.id;
  const source = { ...input.source, ...(title && { title }), ...(label && { label }), ...(project_id && { project_id }) };

  const recorded = await createHandlers(store, {}).record_event({
    kind: source.kind === "doc" ? "doc_edited" : "session_note",
    source,
    occurred_at: input.at ?? now,
    summary: indexed.summary || title || "(no summary)",
  });
  console.log(JSON.stringify({ ingest: source.kind, external_id: source.external_id, index_only: true, ok: true, chars: input.text.length, ms: Date.now() - started, label: label ?? null, title: source.title ?? null }));

  return {
    claims: [],
    reasons: [],
    id_map: {},
    extracted_by: indexed.indexed_by,
    review: [],
    event: recorded.event,
    event_transitions: recorded.transitions,
    dropped: [],
    truncated: false,
    indexed_only: true,
  };
}
