// Store backed by the six Contract tables. Reads go through PostgREST; every
// brain write goes through the plumb_apply function so it lands in one
// transaction (supabase/migrations/20261026000002_vault_and_apply.sql).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Claim, Event, LinkSuggestionRow, Project, Reason, Source, Transition } from "@plumb/core";
import {
  ConflictError,
  type BrainWrite,
  type ClaimFilter,
  type EventFilter,
  type NewLinkSuggestion,
  type ProjectWithCounts,
  type ReasonFilter,
  type Store,
  type TransitionFilter,
} from "./store.js";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null };

const PAGE = 1000; // PostgREST's default row cap
const CHUNK = 100; // ids per in() filter, to keep URLs short
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres nulls become missing fields, matching the optional fields in the Contract.
const clean = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
const toClaim = (row: Row) => clean(row) as unknown as Claim;
const toSource = (row: Row) => clean(row) as unknown as Source;
const toEvent = (row: Row) => clean(row) as unknown as Event;
const toTransition = (row: Row) => clean(row) as unknown as Transition;
const toProject = (row: Row) => clean(row) as unknown as Project;
function toReason(row: Row): Reason {
  const { data, ...rest } = row;
  return { ...rest, ...(data as Row) } as Reason;
}
function fromReason(reason: Reason): Row {
  const { id, claim_id, type, ...data } = reason;
  return { id, claim_id, type, data };
}

function check(result: Result): Row[] {
  if (result.error) throw new Error(`supabase: ${result.error.message}`);
  return (result.data as Row[] | null) ?? [];
}

/** Read every page of a query. `build` must order by a unique column. */
async function pages(build: (from: number, to: number) => PromiseLike<Result>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = check(await build(from, from + PAGE - 1));
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** Run a query once per chunk of ids. Ids that aren't uuids can't match anything. */
async function byIds(ids: string[], run: (chunk: string[]) => Promise<Row[]>): Promise<Row[]> {
  const valid = ids.filter((id) => UUID.test(id));
  const rows: Row[] = [];
  for (let i = 0; i < valid.length; i += CHUNK) rows.push(...(await run(valid.slice(i, i + CHUNK))));
  return rows;
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient) {}

  /** Service role client from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Server side only. */
  static fromEnv(): SupabaseStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  }

  async listProjects(): Promise<ProjectWithCounts[]> {
    const projects = check(await this.db.from("projects").select("*").order("created_at"));
    const statuses = await pages((a, b) => this.db.from("claims").select("id, project_id, status").order("id").range(a, b));
    return projects.map((row) => {
      const counts = { IN: 0, OUT: 0, REVIEW: 0 };
      for (const c of statuses) if (c.project_id === row.id) counts[c.status as keyof typeof counts]++;
      return { ...toProject(row), counts };
    });
  }

  async getProject(id: string) {
    if (!UUID.test(id)) return undefined;
    const [row] = check(await this.db.from("projects").select("*").eq("id", id));
    return row && toProject(row);
  }

  async upsertSource(source: Omit<Source, "id">): Promise<Source> {
    const rows = check(
      await this.db.from("sources").upsert(source, { onConflict: "kind,external_id" }).select("*"),
    );
    return toSource(rows[0]!);
  }

  async getSource(id: string) {
    if (!UUID.test(id)) return undefined;
    const [row] = check(await this.db.from("sources").select("*").eq("id", id));
    return row && toSource(row);
  }

  async loadSources(ids: string[]) {
    const rows = await byIds(ids, (chunk) => pages((a, b) => this.db.from("sources").select("*").in("id", chunk).order("id").range(a, b)));
    return rows.map(toSource);
  }

  async loadClaims(filter: ClaimFilter = {}) {
    if (filter.project_id && !UUID.test(filter.project_id)) return [];
    const run = (ids?: string[], sourceIds?: string[]) =>
      pages((a, b) => {
        let q = this.db.from("claims").select("*");
        if (filter.project_id) q = q.eq("project_id", filter.project_id);
        if (filter.recorded_after) q = q.gt("recorded_at", filter.recorded_after);
        if (ids) q = q.in("id", ids);
        if (sourceIds) q = q.in("source_id", sourceIds);
        return q.order("id").range(a, b);
      });
    const rows = filter.ids
      ? await byIds(filter.ids, (ids) => run(ids))
      : filter.source_ids
        ? await byIds(filter.source_ids, (ids) => run(undefined, ids))
        : await run();
    return rows.map(toClaim);
  }

  async loadReasons(filter: ReasonFilter = {}) {
    let rows: Row[];
    if (filter.claim_ids) {
      rows = await byIds(filter.claim_ids, (ids) =>
        pages((a, b) => this.db.from("reasons").select("*").in("claim_id", ids).order("id").range(a, b)),
      );
    } else if (filter.depends_on) {
      rows = await byIds(filter.depends_on, (ids) =>
        pages((a, b) =>
          this.db.from("reasons").select("*").eq("type", "depends_on").in("data->>claim", ids).order("id").range(a, b),
        ),
      );
    } else {
      rows = await pages((a, b) => this.db.from("reasons").select("*").order("id").range(a, b));
    }
    return rows.map(toReason);
  }

  async loadEvents(filter: EventFilter) {
    const rows = await pages((a, b) => {
      let q = this.db.from("events").select("*").in("kind", filter.kinds);
      if (filter.after) q = q.gt("occurred_at", filter.after);
      if (filter.observed_after) q = q.gt("observed_at", filter.observed_after);
      if (filter.source_ids) q = q.in("source_id", filter.source_ids.filter((id) => UUID.test(id)).slice(0, CHUNK));
      return q.order("id").range(a, b);
    });
    return rows.map(toEvent);
  }

  async loadLinkSuggestions(filter: { project_id?: string; status?: LinkSuggestionRow["status"] } = {}) {
    if (filter.project_id && !UUID.test(filter.project_id)) return [];
    const rows = await pages((a, b) => {
      let q = this.db.from("link_suggestions").select("*");
      if (filter.project_id) q = q.eq("project_id", filter.project_id);
      if (filter.status) q = q.eq("status", filter.status);
      return q.order("created_at", { ascending: false }).order("id").range(a, b);
    });
    return rows.map((r) => clean(r) as unknown as LinkSuggestionRow);
  }

  async addLinkSuggestions(rows: NewLinkSuggestion[]) {
    if (rows.length === 0) return;
    // New pairs only; a pair already there (any status) is skipped, not an error.
    const { error } = await this.db.from("link_suggestions").upsert(rows, { onConflict: "claim_id,depends_on", ignoreDuplicates: true });
    if (error) throw new Error(`supabase: ${error.message}`);
    // A pair that expired only because a claim left IN can come back.
    for (const r of rows) {
      check(
        await this.db
          .from("link_suggestions")
          .update({ status: "pending", why: r.why, created_at: new Date().toISOString(), resolved_at: null, expired_because: null, expired_note: null })
          .eq("claim_id", r.claim_id)
          .eq("depends_on", r.depends_on)
          .eq("status", "expired")
          .eq("expired_because", "claim_left_in")
          .select("id"),
      );
    }
  }

  async expireLinkSuggestion(id: string, note: string, at: string) {
    if (!UUID.test(id)) return false;
    const rows = check(
      await this.db
        .from("link_suggestions")
        .update({ status: "expired", expired_because: "no_longer_relevant", expired_note: note, resolved_at: at })
        .eq("id", id)
        .eq("status", "pending")
        .select("id"),
    );
    return rows.length === 1;
  }

  async resolveLinkSuggestion(id: string, status: "accepted" | "dismissed", at: string) {
    if (!UUID.test(id)) return false;
    const rows = check(
      await this.db.from("link_suggestions").update({ status, resolved_at: at }).eq("id", id).eq("status", "pending").select("id"),
    );
    return rows.length === 1;
  }

  async getCursor(name: string) {
    const [row] = check(await this.db.from("watcher_cursors").select("value").eq("name", name));
    return row ? String(row.value) : undefined;
  }

  async setCursor(name: string, value: string) {
    const { error } = await this.db.rpc("plumb_set_cursor", { p_name: name, p_value: value });
    if (error) throw new Error(`supabase: ${error.message}`);
  }

  async loadTransitions(filter: TransitionFilter = {}) {
    const run = (ids?: string[]) =>
      pages((a, b) => {
        let q = this.db.from("transitions").select("*");
        if (filter.since) q = q.gt("at", filter.since);
        if (filter.to_statuses) q = q.in("to_status", filter.to_statuses);
        if (ids) q = q.in("claim_id", ids);
        return q.order("at").order("id").range(a, b);
      });
    const rows = filter.claim_ids ? await byIds(filter.claim_ids, run) : await run();
    const transitions = rows.map(toTransition);
    // Chunks come back one after another; restore the overall order.
    return transitions.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || x.id.localeCompare(y.id));
  }

  async apply(write: BrainWrite) {
    const { error } = await this.db.rpc("plumb_apply", {
      p_event: write.event ?? null,
      p_claims: write.claims ?? [],
      p_reasons: (write.reasons ?? []).map(fromReason),
      p_updates: write.updates.map(({ claim, expected_status }) => ({
        id: claim.id,
        expected_status,
        status: claim.status,
        valid_to: claim.valid_to ?? null,
        retracted_at: claim.retracted_at ?? null,
        text: claim.text,
        last_mentioned_at: claim.last_mentioned_at ?? null,
      })),
      p_transitions: write.transitions,
    });
    if (error?.code === "40001") throw new ConflictError(error.message);
    if (error) throw new Error(`supabase: ${error.message}`);
  }
}
