// What the tool handlers need from storage. SupabaseStore is the real one;
// MemoryStore backs the tests. Handlers never talk to Supabase directly.
import type { Claim, ClaimStatus, Event, EventKind, LinkSuggestionRow, Project, Reason, Source, Transition } from "@plumb/core";

export type ProjectWithCounts = Project & { counts: Record<ClaimStatus, number> };

/** A status change, with the status the brain computed it from. */
export interface ClaimUpdate {
  claim: Claim; // the claim after the change
  expected_status: ClaimStatus;
}

/** Everything one brain run writes. Applied all or nothing. */
export interface BrainWrite {
  event?: Event;
  claims?: Claim[]; // new claims, in their final state
  reasons?: Reason[];
  updates: ClaimUpdate[];
  transitions: Transition[];
}

export type NewLinkSuggestion = Pick<LinkSuggestionRow, "project_id" | "claim_id" | "depends_on" | "why">;

export interface ClaimFilter {
  ids?: string[];
  project_id?: string;
  source_ids?: string[]; // claims written from these sources
  recorded_after?: string;
}

export interface ReasonFilter {
  claim_ids?: string[];
  depends_on?: string[]; // depends_on reasons that point at these claims
}

export interface EventFilter {
  kinds: EventKind[];
  after?: string; // occurred_at after this time
  observed_after?: string; // observed_at after this time
  source_ids?: string[];
}

export interface TransitionFilter {
  claim_ids?: string[];
  since?: string; // at after this time
  to_statuses?: ClaimStatus[];
}

export interface Store {
  listProjects(): Promise<ProjectWithCounts[]>;
  getProject(id: string): Promise<Project | undefined>;
  /** A new project for a user (Oct 28: each new user gets one at sign-in). */
  createProject(name: string, user_id: string, workspace?: string): Promise<Project>;
  upsertSource(source: Omit<Source, "id">): Promise<Source>;
  getSource(id: string): Promise<Source | undefined>;
  loadSources(ids: string[]): Promise<Source[]>;
  loadClaims(filter?: ClaimFilter): Promise<Claim[]>;
  loadReasons(filter?: ReasonFilter): Promise<Reason[]>;
  /** Events of these kinds that happened after `after`, and/or that we saw after `observed_after`. */
  loadEvents(filter: EventFilter): Promise<Event[]>;
  /** Oldest first. */
  loadTransitions(filter?: TransitionFilter): Promise<Transition[]>;
  /** A named place marker in watcher_cursors (e.g. "sweep"), or undefined if never set. */
  getCursor(name: string): Promise<string | undefined>;
  setCursor(name: string, value: string): Promise<void>;
  /** Link suggestions from the sweep (link_suggestions), newest first. */
  loadLinkSuggestions(filter?: { project_id?: string; status?: LinkSuggestionRow["status"] }): Promise<LinkSuggestionRow[]>;
  /** New pairs are added; a pair that expired because a claim left IN comes back as pending; others are skipped. */
  addLinkSuggestions(rows: NewLinkSuggestion[]): Promise<void>;
  /** The relevance pass: a pending suggestion is moot. False if it wasn't pending. */
  expireLinkSuggestion(id: string, note: string, at: string): Promise<boolean>;
  /** Move a pending suggestion to accepted or dismissed. False if it wasn't pending. */
  resolveLinkSuggestion(id: string, status: "accepted" | "dismissed", at: string): Promise<boolean>;
  /** Throws ConflictError if a claim's status is no longer expected_status. */
  apply(write: BrainWrite): Promise<void>;
}

/** Another run changed a claim between our read and our write. Safe to retry. */
export class ConflictError extends Error {}

// Per user (Oct 28). Tokens and device sign-ins. Only hashes of secrets are stored.
export interface ApiToken {
  id: string;
  user_id: string;
  tool: string;
  revoked_at?: string;
}

export interface DeviceLogin {
  id: string;
  user_code: string;
  tool: string;
  user_id?: string;
  expires_at: string;
  approved_at?: string;
  token_issued_at?: string;
}

export interface AuthStore {
  findToken(token_hash: string): Promise<ApiToken | undefined>;
  createToken(row: { user_id: string; tool: string; token_hash: string }): Promise<ApiToken>;
  touchToken(id: string, at: string): Promise<void>;
  createDeviceLogin(row: { device_code_hash: string; user_code: string; tool: string; expires_at: string }): Promise<DeviceLogin>;
  findDeviceLogin(by: { device_code_hash: string } | { user_code: string }): Promise<DeviceLogin | undefined>;
  /** Sets user_id and approved_at if still unapproved. False otherwise. */
  approveDeviceLogin(id: string, user_id: string, at: string): Promise<boolean>;
  /** Sets token_issued_at if not set yet. False if a token was already issued. */
  markDeviceTokenIssued(id: string, at: string): Promise<boolean>;
}
