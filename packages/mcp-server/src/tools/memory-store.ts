// In-memory Store for tests. Returns copies, like a database would, so a
// handler mutating what it loaded never changes stored rows by accident.
import { randomUUID } from "node:crypto";
import type { Claim, Event, LinkSuggestionRow, Project, Reason, Source, Transition } from "@plumb/core";
import {
  ConflictError,
  type BrainWrite,
  type ClaimFilter,
  type EventFilter,
  type NewLinkSuggestion,
  type ProjectWithCounts,
  type ApiToken,
  type AuthStore,
  type DeviceLogin,
  type ReasonFilter,
  type SourceHit,
  type SourceListFilter,
  type SourceSearchFilter,
  type Store,
  type TransitionFilter,
} from "./store.js";

const copy = <T>(x: T): T => structuredClone(x);
const HIDDEN = (s: Source) => s.external_id === "clock" || s.external_id === "usman-links" || s.external_id.startsWith("smoke-");
const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
/** The user rows belong to when a test uses MemoryStore directly. */
export const MEMORY_USER = "00000000-0000-4000-8000-000000000001";

export class MemoryStore implements Store, AuthStore {
  projects: Project[] = [];
  sources: Source[] = [];
  claims = new Map<string, Claim>();
  reasons: Reason[] = [];
  events: Event[] = [];
  transitions: Transition[] = [];
  cursors = new Map<string, string>();
  links: LinkSuggestionRow[] = [];
  tokens: (ApiToken & { token_hash: string; last_used_at?: string })[] = [];
  devices: (DeviceLogin & { device_code_hash: string })[] = [];

  addProject(name: string, user_id = MEMORY_USER, workspace?: string): Project {
    if (workspace && this.projects.some((p) => p.user_id === user_id && p.workspace === workspace)) throw new Error("duplicate key: projects_user_workspace_key");
    const project = { id: randomUUID(), name, created_at: new Date().toISOString(), user_id, ...(workspace && { workspace }) };
    this.projects.push(project);
    return copy(project);
  }

  async createProject(name: string, user_id: string, workspace?: string) {
    return this.addProject(name, user_id || MEMORY_USER, workspace);
  }

  async deleteUser(user_id: string) {
    const projects = new Set(this.projects.filter((p) => p.user_id === user_id).map((p) => p.id));
    const sources = new Set(this.sources.filter((s) => s.user_id === user_id).map((s) => s.id));
    const claims = new Set([...this.claims.values()].filter((c) => projects.has(c.project_id) || sources.has(c.source_id)).map((c) => c.id));
    const counts = { projects: projects.size, sources: sources.size, claims: claims.size };
    this.links = this.links.filter((l) => !projects.has(l.project_id));
    this.transitions = this.transitions.filter((t) => !claims.has(t.claim_id));
    this.reasons = this.reasons.filter((r) => !claims.has(r.claim_id));
    for (const id of claims) this.claims.delete(id);
    this.events = this.events.filter((e) => !sources.has(e.source_id));
    this.sources = this.sources.filter((s) => !sources.has(s.id));
    this.projects = this.projects.filter((p) => !projects.has(p.id));
    this.tokens = this.tokens.filter((t) => t.user_id !== user_id);
    this.devices = this.devices.filter((d) => d.user_id !== user_id);
    return counts;
  }

  async findToken(token_hash: string) {
    const t = this.tokens.find((x) => x.token_hash === token_hash);
    return t && { id: t.id, user_id: t.user_id, tool: t.tool, ...(t.revoked_at && { revoked_at: t.revoked_at }) };
  }

  async createToken(row: { user_id: string; tool: string; token_hash: string }) {
    const t = { id: randomUUID(), ...row };
    this.tokens.push(t);
    return { id: t.id, user_id: t.user_id, tool: t.tool };
  }

  async touchToken(id: string, at: string) {
    const t = this.tokens.find((x) => x.id === id);
    if (t) t.last_used_at = at;
  }

  async createDeviceLogin(row: { device_code_hash: string; user_code: string; tool: string; expires_at: string }) {
    const d = { id: randomUUID(), ...row };
    this.devices.push(d);
    const { device_code_hash: _, ...out } = d;
    return copy(out);
  }

  async findDeviceLogin(by: { device_code_hash: string } | { user_code: string }) {
    const d = this.devices.find((x) => ("user_code" in by ? x.user_code === by.user_code : x.device_code_hash === by.device_code_hash));
    if (!d) return undefined;
    const { device_code_hash: _, ...out } = d;
    return copy(out);
  }

  async approveDeviceLogin(id: string, user_id: string, at: string) {
    const d = this.devices.find((x) => x.id === id);
    if (!d || d.approved_at) return false;
    Object.assign(d, { user_id, approved_at: at });
    return true;
  }

  async markDeviceTokenIssued(id: string, at: string) {
    const d = this.devices.find((x) => x.id === id);
    if (!d || d.token_issued_at) return false;
    d.token_issued_at = at;
    return true;
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
    const user_id = source.user_id ?? MEMORY_USER; // tests that skip ScopedStore act as one user
    const found = this.sources.find((s) => s.user_id === user_id && s.kind === source.kind && s.external_id === source.external_id);
    if (found) {
      Object.assign(found, source);
      return copy(found);
    }
    const created = { id: randomUUID(), ...source, user_id };
    this.sources.push(created);
    return copy(created);
  }

  async getSource(id: string) {
    return copy(this.sources.find((s) => s.id === id));
  }

  async findSource(user_id: string, kind: Source["kind"], external_id: string) {
    return copy(this.sources.find((s) => s.user_id === user_id && s.kind === kind && s.external_id === external_id));
  }

  private listed(filter: SourceListFilter): Source[] {
    return this.sources
      .filter((s) => s.user_id === filter.user_id && !HIDDEN(s) && s.last_at)
      .filter((s) => !filter.since || Date.parse(s.last_at!) >= Date.parse(filter.since))
      .filter((s) => !filter.kinds?.length || filter.kinds.includes(s.kind))
      .filter((s) => !filter.project_id || s.project_id === filter.project_id || s.kind === "doc")
      .sort((a, b) => Date.parse(b.last_at!) - Date.parse(a.last_at!));
  }

  async listSources(filter: SourceListFilter): Promise<Source[]> {
    return this.listed(filter)
      .slice(0, filter.limit ?? 30)
      .map(({ digest: _digest, ...s }) => copy(s));
  }

  // Stand-in for plumb_search_sources: any word matches, title counts most.
  async searchSources(filter: SourceSearchFilter): Promise<SourceHit[]> {
    const wanted = [...words(filter.words.join(" "))];
    if (!wanted.length) return [];
    return this.listed(filter)
      .map((s) => {
        const [t, sm, d] = [words(s.title ?? ""), words(s.summary ?? ""), words(s.digest ?? "")];
        const score = wanted.reduce((n, w) => n + (t.has(w) ? 3 : 0) + (sm.has(w) ? 2 : 0) + (d.has(w) ? 1 : 0), 0);
        const all = wanted.every((w) => t.has(w) || sm.has(w) || d.has(w));
        return { s, rank: score && (all ? 1 : 0) + score / 100 }; // like the SQL: every word first
      })
      .filter((x) => x.rank > 0)
      .sort((a, b) => b.rank - a.rank || Date.parse(b.s.last_at!) - Date.parse(a.s.last_at!))
      .slice(0, filter.limit ?? 10)
      .map(({ s: { digest: _digest, ...s }, rank }) => ({ ...copy(s), rank }));
  }

  async loadSources(ids: string[]) {
    return this.sources.filter((s) => ids.includes(s.id)).map(copy);
  }

  async loadClaims(filter: ClaimFilter = {}) {
    return [...this.claims.values()]
      .filter((c) => !filter.ids || filter.ids.includes(c.id))
      .filter((c) => !filter.project_id || c.project_id === filter.project_id)
      .filter((c) => !filter.source_ids || filter.source_ids.includes(c.source_id))
      .filter((c) => !filter.recorded_after || Date.parse(c.recorded_at) > Date.parse(filter.recorded_after))
      .map(copy);
  }

  async loadReasons(filter: ReasonFilter = {}) {
    return this.reasons
      .filter((r) => !filter.claim_ids || filter.claim_ids.includes(r.claim_id))
      .filter((r) => !filter.depends_on || (r.type === "depends_on" && filter.depends_on.includes(r.claim)))
      .map(copy);
  }

  async loadEvents(filter: EventFilter) {
    return this.events
      .filter((e) => filter.kinds.includes(e.kind))
      .filter((e) => !filter.after || Date.parse(e.occurred_at) > Date.parse(filter.after))
      .filter((e) => !filter.observed_after || Date.parse(e.observed_at) > Date.parse(filter.observed_after))
      .filter((e) => !filter.source_ids || filter.source_ids.includes(e.source_id))
      .map(copy);
  }

  async getCursor(name: string) {
    return this.cursors.get(name);
  }

  async setCursor(name: string, value: string) {
    this.cursors.set(name, value);
  }

  async loadLinkSuggestions(filter: { project_id?: string; status?: LinkSuggestionRow["status"] } = {}) {
    return this.links
      .filter((l) => !filter.project_id || l.project_id === filter.project_id)
      .filter((l) => !filter.status || l.status === filter.status)
      .reverse()
      .map(copy);
  }

  async addLinkSuggestions(rows: NewLinkSuggestion[]) {
    for (const r of rows) {
      const found = this.links.find((l) => l.claim_id === r.claim_id && l.depends_on === r.depends_on);
      if (!found) {
        this.links.push({ ...r, id: randomUUID(), status: "pending", created_at: new Date().toISOString() });
      } else if (found.status === "expired" && found.expired_because === "claim_left_in") {
        Object.assign(found, { status: "pending", why: r.why, created_at: new Date().toISOString() });
        delete found.resolved_at;
        delete found.expired_because;
        delete found.expired_note;
      }
    }
  }

  async expireLinkSuggestion(id: string, note: string, at: string) {
    const l = this.links.find((x) => x.id === id);
    if (!l || l.status !== "pending") return false;
    Object.assign(l, { status: "expired", expired_because: "no_longer_relevant", expired_note: note, resolved_at: at });
    return true;
  }

  async resolveLinkSuggestion(id: string, status: "accepted" | "dismissed", at: string) {
    const l = this.links.find((x) => x.id === id);
    if (!l || l.status !== "pending") return false;
    l.status = status;
    l.resolved_at = at;
    return true;
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
    if (write.event) {
      this.events.push(copy(write.event));
      // Same as the events trigger in Supabase: keep the source's summary and last_at current.
      const e = write.event;
      const src = this.sources.find((s) => s.id === e.source_id);
      if (src && e.kind !== "clock") {
        const newer = !src.last_at || Date.parse(e.occurred_at) >= Date.parse(src.last_at);
        if (newer && !e.summary.startsWith("...")) src.summary = e.summary;
        if (newer) src.last_at = e.occurred_at;
      }
    }
    for (const c of write.claims ?? []) this.claims.set(c.id, copy(c));
    this.reasons.push(...(write.reasons ?? []).map(copy));
    for (const u of write.updates) {
      // Same as the DB trigger: pending suggestions on a claim that leaves IN expire.
      if (u.expected_status === "IN" && u.claim.status !== "IN") {
        for (const l of this.links) {
          if (l.status !== "pending" || (l.claim_id !== u.claim.id && l.depends_on !== u.claim.id)) continue;
          Object.assign(l, { status: "expired", expired_because: "claim_left_in", expired_note: `"${u.claim.text}" went ${u.claim.status}.`, resolved_at: new Date().toISOString() });
        }
      }
      this.claims.set(u.claim.id, copy(u.claim));
    }
    this.transitions.push(...write.transitions.map(copy));
  }
}
