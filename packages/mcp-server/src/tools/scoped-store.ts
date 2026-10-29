// Per user (Oct 28, Usman OK'd): one user's view of a Store. Projects and
// sources carry user_id; claims, reasons, events, transitions and link
// suggestions belong to a user through them. Every read is filtered here and
// every write is checked, so a handler can't see or touch another user's rows
// whatever ids it is given. Works over any Store (Supabase or memory).
import type { Claim, Event, LinkSuggestionRow, Project, Reason, Source, Transition } from "@plumb/core";
import type {
  BrainWrite,
  ClaimFilter,
  EventFilter,
  NewLinkSuggestion,
  ProjectWithCounts,
  ReasonFilter,
  Store,
  TransitionFilter,
} from "./store.js";

export class ScopedStore implements Store {
  private projectIds?: Promise<Set<string>>;

  constructor(
    private inner: Store,
    readonly userId: string,
  ) {}

  private ownProjects(): Promise<Set<string>> {
    this.projectIds ??= this.inner.listProjects().then((ps) => new Set(ps.filter((p) => p.user_id === this.userId).map((p) => p.id)));
    return this.projectIds;
  }

  private async ownClaimIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    return new Set((await this.loadClaims({ ids: [...new Set(ids)] })).map((c) => c.id));
  }

  private async ownSourceIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    return new Set((await this.loadSources([...new Set(ids)])).map((s) => s.id));
  }

  async listProjects(): Promise<ProjectWithCounts[]> {
    return (await this.inner.listProjects()).filter((p) => p.user_id === this.userId);
  }

  async getProject(id: string): Promise<Project | undefined> {
    const p = await this.inner.getProject(id);
    return p?.user_id === this.userId ? p : undefined;
  }

  async createProject(name: string, _userId?: string, workspace?: string): Promise<Project> {
    this.projectIds = undefined;
    return this.inner.createProject(name, this.userId, workspace);
  }

  // A caller-sent user_id never wins.
  upsertSource(source: Omit<Source, "id">): Promise<Source> {
    return this.inner.upsertSource({ ...source, user_id: this.userId });
  }

  async getSource(id: string): Promise<Source | undefined> {
    const s = await this.inner.getSource(id);
    return s?.user_id === this.userId ? s : undefined;
  }

  async loadSources(ids: string[]): Promise<Source[]> {
    return (await this.inner.loadSources(ids)).filter((s) => s.user_id === this.userId);
  }

  async loadClaims(filter: ClaimFilter = {}): Promise<Claim[]> {
    const own = await this.ownProjects();
    if (filter.project_id && !own.has(filter.project_id)) return [];
    return (await this.inner.loadClaims(filter)).filter((c) => own.has(c.project_id));
  }

  async loadReasons(filter: ReasonFilter = {}): Promise<Reason[]> {
    const rows = await this.inner.loadReasons(filter);
    const own = await this.ownClaimIds(rows.map((r) => r.claim_id));
    return rows.filter((r) => own.has(r.claim_id));
  }

  async loadEvents(filter: EventFilter): Promise<Event[]> {
    const rows = await this.inner.loadEvents(filter);
    const own = await this.ownSourceIds(rows.map((e) => e.source_id));
    return rows.filter((e) => own.has(e.source_id));
  }

  async loadTransitions(filter: TransitionFilter = {}): Promise<Transition[]> {
    const rows = await this.inner.loadTransitions(filter);
    const own = await this.ownClaimIds(rows.map((t) => t.claim_id));
    return rows.filter((t) => own.has(t.claim_id));
  }

  // Watcher place markers are the system's, not a user's.
  getCursor(name: string) {
    return this.inner.getCursor(name);
  }

  setCursor(name: string, value: string) {
    return this.inner.setCursor(name, value);
  }

  async loadLinkSuggestions(filter: { project_id?: string; status?: LinkSuggestionRow["status"] } = {}): Promise<LinkSuggestionRow[]> {
    const own = await this.ownProjects();
    if (filter.project_id && !own.has(filter.project_id)) return [];
    return (await this.inner.loadLinkSuggestions(filter)).filter((l) => own.has(l.project_id));
  }

  async addLinkSuggestions(rows: NewLinkSuggestion[]): Promise<void> {
    const own = await this.ownProjects();
    if (rows.some((r) => !own.has(r.project_id))) throw new Error("link suggestion for another user's project");
    return this.inner.addLinkSuggestions(rows);
  }

  private async ownSuggestion(id: string): Promise<boolean> {
    return (await this.loadLinkSuggestions()).some((l) => l.id === id);
  }

  async expireLinkSuggestion(id: string, note: string, at: string): Promise<boolean> {
    return (await this.ownSuggestion(id)) && this.inner.expireLinkSuggestion(id, note, at);
  }

  async resolveLinkSuggestion(id: string, status: "accepted" | "dismissed", at: string): Promise<boolean> {
    return (await this.ownSuggestion(id)) && this.inner.resolveLinkSuggestion(id, status, at);
  }

  async apply(write: BrainWrite): Promise<void> {
    const own = await this.ownProjects();
    const claims = [...(write.claims ?? []), ...write.updates.map((u) => u.claim)];
    if (claims.some((c) => !own.has(c.project_id))) throw new Error("write touches another user's project");
    if (write.event && (await this.ownSourceIds([write.event.source_id])).size === 0) throw new Error("event for another user's source");
    // Reasons and transitions must hang off claims this write creates or this user already owns.
    const fresh = new Set((write.claims ?? []).map((c) => c.id));
    const others = [...(write.reasons ?? []).map((r) => r.claim_id), ...write.transitions.map((t) => t.claim_id)].filter((id) => !fresh.has(id));
    const owned = await this.ownClaimIds(others);
    if (others.some((id) => !owned.has(id))) throw new Error("write touches another user's claims");
    return this.inner.apply(write);
  }
}
