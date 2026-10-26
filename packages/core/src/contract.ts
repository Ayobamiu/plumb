// Contract shapes from tab 1 of the spec doc. Field names are final:
// add fields if needed, never rename or remove them.
import { z } from "zod";

const Timestamp = z.string().datetime({ offset: true });

export const ClaimStatus = z.enum(["IN", "OUT", "REVIEW"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const ClaimKind = z.enum(["status", "decision", "fact", "next_step", "open_question", "goal"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const SourceKind = z.enum(["gmail_thread", "doc", "claude_code", "cursor", "claude_chat", "manual"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const EventKind = z.enum(["email_received", "email_sent", "doc_edited", "session_note", "clock"]);
export type EventKind = z.infer<typeof EventKind>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  created_at: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const Source = z.object({
  id: z.string(),
  kind: SourceKind,
  external_id: z.string(), // Gmail thread id, doc id, session id
  uri: z.string().optional(),
  title: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const Claim = z.object({
  id: z.string(),
  project_id: z.string(),
  text: z.string().min(1), // plain sentence
  kind: ClaimKind,
  status: ClaimStatus,
  source_id: z.string(), // where it was written
  valid_from: Timestamp, // when it became true in the world
  valid_to: Timestamp.optional(), // when it stopped being true in the world
  recorded_at: Timestamp, // when we learned it
  retracted_at: Timestamp.optional(), // when we marked it OUT
  extracted_by: z.string(), // model id or tool name
  confidence: z.number().min(0).max(1).optional(), // 0 to 1, from extraction
});
export type Claim = z.infer<typeof Claim>;

export const AbsencePattern = z.object({
  event_kind: EventKind,
  from: z.string().optional(), // email address
  thread_id: z.string().optional(),
  source_id: z.string().optional(),
  text_hint: z.string().optional(), // used only by the model check, never by code matching
});
export type AbsencePattern = z.infer<typeof AbsencePattern>;

const ReasonBase = { id: z.string(), claim_id: z.string() };

export const DependsOnReason = z.object({ ...ReasonBase, type: z.literal("depends_on"), claim: z.string() });
export const EvidenceReason = z.object({ ...ReasonBase, type: z.literal("evidence"), event_id: z.string() });
export const AbsenceReason = z.object({
  ...ReasonBase,
  type: z.literal("absence"),
  pattern: AbsencePattern,
  since: Timestamp,
});
export const UntilReason = z.object({ ...ReasonBase, type: z.literal("until"), at: Timestamp });

export const Reason = z.discriminatedUnion("type", [DependsOnReason, EvidenceReason, AbsenceReason, UntilReason]);
export type Reason = z.infer<typeof Reason>;
export type ReasonType = Reason["type"];

export const Event = z.object({
  id: z.string(),
  kind: EventKind,
  source_id: z.string(),
  occurred_at: Timestamp, // when it happened
  observed_at: Timestamp, // when we saw it
  from: z.string().optional(),
  thread_id: z.string().optional(),
  summary: z.string(), // short, no full email bodies stored
});
export type Event = z.infer<typeof Event>;

export const Transition = z.object({
  id: z.string(),
  claim_id: z.string(),
  from_status: ClaimStatus,
  to_status: ClaimStatus,
  event_id: z.string().optional(),
  reason_id: z.string().optional(),
  cause_claim_id: z.string().optional(), // set when this came from the chain (cascade)
  depth: z.number().int().min(0), // 0 = directly broken, 1+ = knocked down by the chain
  explanation: z.string().min(1), // one human sentence
  at: Timestamp,
});
export type Transition = z.infer<typeof Transition>;
