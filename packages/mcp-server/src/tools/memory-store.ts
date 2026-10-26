// In-memory Store for tests. Returns copies, like a database would, so a
// handler mutating what it loaded never changes stored rows by accident.
import { randomUUID } from "node:crypto";
import type { Claim, Event, EventKind, Project, Reason, Source, Transition } from "@plumb/core";
import {
  ConflictError,
  type BrainWrite,
  type ClaimFilter,
  type ProjectWithCounts,
  type ReasonFilter,
  type Store,
  type TransitionFilter,
} from "./store.js";

const copy = <T>(x: T): T => structuredClone(x);

export class MemoryStore implements Store {
  projects: Project[] = [];
  sources: Source[] = [];
  claims = new Map<string, Claim>();
  reasons: Reason[] = [];
  events: Event[] = [];
  transitions: Transition[] = [];

  addProject(name: string): Project {
    const project = { id: randomUUID(), name, created_at: new Date().toISOString() };
    this.projects.push(project);
    return copy(project);
  }

  async listProjects(): Promise<ProjectWithCounts[]> {
    return this.projects.map((p) => {
      const counts = { IN: 0, OUT: 0, REVIEW: 0 };
      for (const c of this.claims.values()) if (c.project_id === p.id) counts[c.status]++;
      return { ...copy(p), counts };
    });
  }

  async getProject(id: string) {
    return copy(this.projects.find((p) => p.id === id));
  }

  async upsertSource(source: Omit<Source, "id">): Promise<Source> {
    const found = this.sources.find((s) => s.kind === source.kind && s.external_id === source.external_id);
    if (found) {
      Object.assign(found, source);
      return copy(found);
    }
    const created = { id: randomUUID(), ...source };
    this.sources.push(created);
    return copy(created);
  }

  async getSource(id: string) {
    return copy(this.sources.find((s) => s.id === id));
  }

  async loadClaims(filter: ClaimFilter = {}) {
    return [...this.claims.values()]
      .filter((c) => !filter.ids || filter.ids.includes(c.id))
      .filter((c) => !filter.project_id || c.project_id === filter.project_id)
      .map(copy);
  }

  async loadReasons(filter: ReasonFilter = {}) {
    return this.reasons
      .filter((r) => !filter.claim_ids || filter.claim_ids.includes(r.claim_id))
      .filter((r) => !filter.depends_on || (r.type === "depends_on" && filter.depends_on.includes(r.claim)))
      .map(copy);
  }

  async loadEvents(filter: { kinds: EventKind[]; after: string }) {
    return this.events
      .filter((e) => filter.kinds.includes(e.kind) && Date.parse(e.occurred_at) > Date.parse(filter.after))
      .map(copy);
  }

  async loadTransitions(filter: TransitionFilter = {}) {
    return this.transitions
      .filter((t) => !filter.claim_ids || filter.claim_ids.includes(t.claim_id))
      .filter((t) => !filter.since || Date.parse(t.at) > Date.parse(filter.since))
      .filter((t) => !filter.to_statuses || filter.to_statuses.includes(t.to_status))
      .map(copy);
  }

  async apply(write: BrainWrite) {
    for (const u of write.updates) {
      if (this.claims.get(u.claim.id)?.status !== u.expected_status) {
        throw new ConflictError(`claim ${u.claim.id} changed during this run, retry`);
      }
    }
    if (write.event) this.events.push(copy(write.event));
    for (const c of write.claims ?? []) this.claims.set(c.id, copy(c));
    this.reasons.push(...(write.reasons ?? []).map(copy));
    for (const u of write.updates) this.claims.set(u.claim.id, copy(u.claim));
    this.transitions.push(...write.transitions.map(copy));
  }
}
