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
});
export const ChangedClaim = z.object({ claim: Claim, transition: Transition });
export const GetProjectStateOutput = z.object({
  project: Project,
  in_claims: z.record(ClaimKind, z.array(Claim)),
  changed_since: z.array(ChangedClaim), // went OUT or REVIEW after `since`
  summary: z.string().optional(), // optional Muse Spark handoff summary
  markdown: z.string().optional(), // the same state as PROJECT_STATE.md text (tab 1, generated state file)
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
  project_id: z.string(),
  source: z.object({
    kind: SourceKind,
    external_id: z.string(),
    uri: z.string().optional(),
    title: z.string().optional(),
  }),
  text: z.string().min(1),
  at: Timestamp.optional(), // when the text was written; default now
});
export const IngestOutput = RecordClaimsOutput.extend({
  extracted_by: z.string(),
  review: z.array(Transition), // current claims the text contradicts, sent to REVIEW
  dropped: z.array(z.object({ text: z.string(), why: z.string() })),
  truncated: z.boolean(), // text was longer than the limit; only the end was read
});
