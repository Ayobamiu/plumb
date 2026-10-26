// What the tool handlers need from storage. SupabaseStore is the real one;
// MemoryStore backs the tests. Handlers never talk to Supabase directly.
import type { Claim, ClaimStatus, Event, EventKind, Project, Reason, Source, Transition } from "@plumb/core";

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

export interface ClaimFilter {
  ids?: string[];
  project_id?: string;
}

export interface ReasonFilter {
  claim_ids?: string[];
  depends_on?: string[]; // depends_on reasons that point at these claims
}

export interface TransitionFilter {
  claim_ids?: string[];
  since?: string; // at after this time
  to_statuses?: ClaimStatus[];
}

export interface Store {
  listProjects(): Promise<ProjectWithCounts[]>;
  getProject(id: string): Promise<Project | undefined>;
  upsertSource(source: Omit<Source, "id">): Promise<Source>;
  getSource(id: string): Promise<Source | undefined>;
  loadClaims(filter?: ClaimFilter): Promise<Claim[]>;
  loadReasons(filter?: ReasonFilter): Promise<Reason[]>;
  /** Events of these kinds that happened after `after`. */
  loadEvents(filter: { kinds: EventKind[]; after: string }): Promise<Event[]>;
  /** Oldest first. */
  loadTransitions(filter?: TransitionFilter): Promise<Transition[]>;
  /** Throws ConflictError if a claim's status is no longer expected_status. */
  apply(write: BrainWrite): Promise<void>;
}

/** Another run changed a claim between our read and our write. Safe to retry. */
export class ConflictError extends Error {}
