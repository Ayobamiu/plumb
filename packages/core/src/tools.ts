// Input and output shapes for the six MCP tools in tab 1. Handlers live in
// packages/mcp-server/src/tools; these schemas are shared so the UI and
// watchers can call the same tools with the same shapes.
import { z } from "zod";
import {
  AbsencePattern,
  Claim,
  ClaimKind,
  Event,
  EventKind,
  Project,
  Reason,
  Source,
  SourceKind,
  Transition,
} from "./contract.js";

const Timestamp = z.string().datetime({ offset: true });

// list_projects
export const ListProjectsInput = z.object({});
export const ProjectWithCounts = Project.extend({
  counts: z.object({ IN: z.number().int(), OUT: z.number().int(), REVIEW: z.number().int() }),
});
export const ListProjectsOutput = z.object({ projects: z.array(ProjectWithCounts) });

// get_project_state
export const GetProjectStateInput = z.object({
  project_id: z.string(),
  since: Timestamp.optional(), // changes after this time; default is the last 24 hours
  // Quiet rule (added Oct 27): IN claims with no activity (recorded, mentioned
  // or status change) for this many days move to quiet_claims. Goals and
  // decisions never go quiet. Default 7.
  quiet_after_days: z.number().int().min(1).max(365).optional(),
});
export const ChangedClaim = z.object({ claim: Claim, transition: Transition });
// Coverage (added Oct 28, Usman OK'd): per tool, when Plumb last saved
// something from it, across all projects. stale: it has saved before, but not
// lately (2 days for session tools and email; docs and notes never go stale).
export const ToolCoverage = z.object({
  kind: SourceKind,
  tool: z.string(), // "Claude Code", "Cursor", ...
  last_saved_at: Timestamp.optional(), // none if nothing was saved in the last 90 days
  sources_7d: z.number().int(), // sessions, threads or docs saved in the last 7 days
  stale: z.boolean(),
});
export type ToolCoverage = z.infer<typeof ToolCoverage>;
export const GetProjectStateOutput = z.object({
  project: Project,
  in_claims: z.record(ClaimKind, z.array(Claim)),
  changed_since: z.array(ChangedClaim), // went OUT or REVIEW after `since`
  summary: z.string().optional(), // optional Muse Spark handoff summary
  markdown: z.string().optional(), // the same state as PROJECT_STATE.md text (tab 1, generated state file)
  quiet_claims: z.array(Claim).optional(), // still IN, just not shown by default (added Oct 27)
  coverage: z.array(ToolCoverage).optional(), // per tool, across all projects (added Oct 28)
});

// record_claims
// A reason as the caller writes it: ids are assigned by the server.
// depends_on may point at an existing claim id or at another new claim's temp_id.
export const NewReason = z.discriminatedUnion("type", [
  z.object({ type: z.literal("depends_on"), claim: z.string() }),
  z.object({ type: z.literal("evidence"), event_id: z.string() }),
  z.object({ type: z.literal("absence"), pattern: AbsencePattern, since: Timestamp }),
  z.object({ type: z.literal("until"), at: Timestamp }),
]);
export type NewReason = z.infer<typeof NewReason>;

export const NewClaim = z.object({
  temp_id: z.string().optional(),
  text: z.string().min(1),
  kind: ClaimKind,
  valid_from: Timestamp,
  confidence: z.number().min(0).max(1).optional(),
  same_as: z.string().optional(), // existing IN claim id: add reasons to it instead of creating a copy
  reasons: z.array(NewReason).min(1, "every claim needs at least one reason"),
});
export type NewClaim = z.infer<typeof NewClaim>;

export const RecordClaimsInput = z.object({
  project_id: z.string(),
  source: z.object({
    kind: SourceKind,
    external_id: z.string(),
    uri: z.string().optional(),
    title: z.string().optional(),
  }),
  extracted_by: z.string(),
  claims: z.array(NewClaim).min(1),
});
export const RecordClaimsOutput = z.object({
  claims: z.array(Claim),
  reasons: z.array(Reason),
  id_map: z.record(z.string(), z.string()), // temp_id to real id
});

// record_event
export const RecordEventInput = z.object({
  kind: EventKind,
  source: Source.omit({ id: true }),
  occurred_at: Timestamp,
  from: z.string().optional(),
  thread_id: z.string().optional(),
  summary: z.string().max(1000),
});
export const RecordEventOutput = z.object({ event: Event, transitions: z.array(Transition) });

// explain_claim
export const ExplainClaimInput = z.object({ claim_id: z.string() });
export const ExplainClaimOutput = z.object({
  claim: Claim,
  source: Source,
  reasons: z.array(Reason),
  depends_on: z.array(Claim),
  dependents: z.array(Claim),
  history: z.array(Transition),
});

// resolve_review
export const ResolveReviewInput = z.object({
  claim_id: z.string(),
  action: z.enum(["confirm_out", "restore_in", "edit"]),
  text: z.string().min(1).optional(), // required when action is "edit"
  note: z.string().optional(),
});
export const ResolveReviewOutput = z.object({ transitions: z.array(Transition) });

// ingest (POST /ingest, not an MCP tool): text in, claims out via extraction
// (Brain Part A), then record_claims. Every write-back path ends here.
export const IngestInput = z.object({
  project_id: z.string().optional(), // or workspace; required for full mode unless workspace is given
  // The folder the session ran in (a repo path), or "chats". Without project_id,
  // the session goes to the user's project for it, created on first use (Oct 29).
  workspace: z.string().min(1).max(500).optional(),
  source: z.object({
    kind: SourceKind,
    external_id: z.string(),
    uri: z.string().optional(),
    title: z.string().optional(),
    label: z.enum(["personal"]).optional(), // set by the caller when it knows; index mode also decides
  }),
  // Index mode (Oct 28, Usman OK'd): one low-effort call writes a title and a
  // summary so search can find the session; no claims, no model check.
  index_only: z.boolean().optional(),
  text: z.string().min(1),
  at: Timestamp.optional(), // when the text was written; default now
});
export const IngestOutput = RecordClaimsOutput.extend({
  indexed_only: z.boolean().optional(), // true when index_only ran: claims, review and dropped are empty
  extracted_by: z.string(),
  review: z.array(Transition), // current claims the text contradicts, sent to REVIEW
  event: Event, // the text as a doc_edited or session_note event, with a short summary
  event_transitions: z.array(Transition), // what that event changed (Part B, and Part C REVIEWs)
  dropped: z.array(z.object({ text: z.string(), why: z.string() })),
  truncated: z.boolean(), // text was longer than the limit; only the end was read
});

// Link suggestions (not MCP tools; the homepage lists them, Usman accepts or
// dismisses). The sleep-time sweep writes them; accepting adds the depends_on
// reason through record_claims, so the Contract tables are unchanged.
// expired: the system retired it, never Usman. claim_left_in (a trigger, when
// either claim leaves IN; may be suggested again later) or no_longer_relevant
// (the sweep's relevance pass; not suggested again).
export const LinkSuggestionStatus = z.enum(["pending", "accepted", "dismissed", "expired"]);
export const LinkSuggestionRow = z.object({
  id: z.string(),
  project_id: z.string(),
  claim_id: z.string(), // would depend on ...
  depends_on: z.string(), // ... this claim
  why: z.string(),
  status: LinkSuggestionStatus,
  created_at: Timestamp,
  resolved_at: Timestamp.optional(),
  expired_because: z.enum(["claim_left_in", "no_longer_relevant"]).optional(),
  expired_note: z.string().optional(),
});
export type LinkSuggestionRow = z.infer<typeof LinkSuggestionRow>;

export const ListLinkSuggestionsInput = z.object({ project_id: z.string() });
export const ListLinkSuggestionsOutput = z.object({
  suggestions: z.array(LinkSuggestionRow.extend({ claim: Claim, depends_on_claim: Claim })), // pending, newest first
});

export const ResolveLinkSuggestionInput = z.object({ id: z.string(), action: z.enum(["accept", "dismiss"]) });
export const ResolveLinkSuggestionOutput = z.object({ suggestion: LinkSuggestionRow });

// find_context / get_context and the MCP resources (added Oct 27, Usman OK'd):
// "@ a session from any tool". Each recent source is one entry.
export const ContextEntry = z.object({
  uri: z.string(), // cursor://auth-refactor-3f9a1c2d
  name: z.string(), // "Cursor: Auth refactor, login page next (Oct 27)"
  description: z.string(), // the latest summary, short
  source_id: z.string(),
  project_id: z.string().optional(), // from the claims it produced; none for e.g. email threads
  tool: z.string(), // "Cursor", "Claude Code", ...
  title: z.string().optional(),
  last_at: Timestamp,
  // find_context only, when searched by description: one line on why this
  // session fits. Starts "Not a clear match" when nothing fit and these are
  // only near misses (added Oct 28, Usman OK'd).
  why: z.string().optional(),
});
export type ContextEntry = z.infer<typeof ContextEntry>;

export const FindContextInput = z.object({
  query: z.string().min(1), // the user's own words, e.g. "gym plan from Claude last week"; without a model, every word must match the tool, title or summary
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const FindContextOutput = z.object({ contexts: z.array(ContextEntry) });

// recent_work (added Oct 30, Usman OK'd): "what did I build this week" spans
// sessions, so it lists them by time instead of picking one. Plain code.
export const RecentWorkInput = z.object({
  tool: z.string().optional(), // "Claude Code", "cursor", ...; every tool if left out
  days: z.number().int().min(1).max(90).optional(), // default 7
  project_id: z.string().optional(),
});
export const RecentWorkOutput = z.object({ since: Timestamp, sessions: z.array(ContextEntry) });

// A plain object (no .refine): MCP clients only see inputs they can describe,
// and a refined schema showed up with no inputs at all. "One of the two" is
// checked in the handler.
export const GetContextInput = z.object({
  uri: z.string().optional(), // from find_context or an @ mention, e.g. cursor://auth-refactor-3f9a1c2d
  source_id: z.string().optional(),
});
export const GetContextOutput = z.object({ uri: z.string(), name: z.string(), markdown: z.string() });
