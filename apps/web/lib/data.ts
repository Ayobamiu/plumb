import type { Claim, ClaimKind, ClaimStatus, Event, Project, Source, Transition } from "@plumb/core";
import { KIND_ORDER } from "./kinds";
import { getServerSupabase } from "./supabase-server";

export type ProjectWithCounts = Project & {
  counts: { IN: number; OUT: number; REVIEW: number };
};

export type FeedItem = {
  transition: Transition;
  claim: Claim;
  source: Source | null;
  event: Event | null;
  children: FeedItem[];
};

export type HomeData = {
  projects: ProjectWithCounts[];
  feed: FeedItem[];
  since: string;
  error?: string;
};

export { KIND_ORDER, kindLabel } from "./kinds";

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    created_at: String(row.created_at),
  };
}

function rowToClaim(row: Record<string, unknown>): Claim {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    text: String(row.text),
    kind: row.kind as ClaimKind,
    status: row.status as ClaimStatus,
    source_id: String(row.source_id),
    valid_from: String(row.valid_from),
    valid_to: row.valid_to ? String(row.valid_to) : undefined,
    recorded_at: String(row.recorded_at),
    retracted_at: row.retracted_at ? String(row.retracted_at) : undefined,
    extracted_by: String(row.extracted_by),
    confidence: typeof row.confidence === "number" ? row.confidence : undefined,
  };
}

function rowToTransition(row: Record<string, unknown>): Transition {
  return {
    id: String(row.id),
    claim_id: String(row.claim_id),
    from_status: row.from_status as ClaimStatus,
    to_status: row.to_status as ClaimStatus,
    event_id: row.event_id ? String(row.event_id) : undefined,
    reason_id: row.reason_id ? String(row.reason_id) : undefined,
    cause_claim_id: row.cause_claim_id ? String(row.cause_claim_id) : undefined,
    depth: Number(row.depth),
    explanation: String(row.explanation),
    at: String(row.at),
  };
}

function rowToSource(row: Record<string, unknown>): Source {
  return {
    id: String(row.id),
    kind: row.kind as Source["kind"],
    external_id: String(row.external_id),
    uri: row.uri ? String(row.uri) : undefined,
    title: row.title ? String(row.title) : undefined,
  };
}

function rowToEvent(row: Record<string, unknown>): Event {
  return {
    id: String(row.id),
    kind: row.kind as Event["kind"],
    source_id: String(row.source_id),
    occurred_at: String(row.occurred_at),
    observed_at: String(row.observed_at),
    from: row.from ? String(row.from) : undefined,
    thread_id: row.thread_id ? String(row.thread_id) : undefined,
    summary: String(row.summary),
  };
}

/** Default lookback: 24 hours, matching get_project_state. */
export function defaultSince(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

export async function loadHomeData(since = defaultSince()): Promise<HomeData> {
  try {
    const db = getServerSupabase();

    const { data: projectsRaw, error: projectsError } = await db
      .from("projects")
      .select("id, name, created_at")
      .order("created_at", { ascending: true });
    if (projectsError) throw projectsError;

    const projects: ProjectWithCounts[] = [];
    for (const row of projectsRaw ?? []) {
      const project = rowToProject(row as Record<string, unknown>);
      // Internal DB smoke project; hide from the homepage.
      if (project.name === "Smoke test") continue;
      const { data: statusRows, error: countError } = await db
        .from("claims")
        .select("status")
        .eq("project_id", project.id);
      if (countError) throw countError;
      const counts = { IN: 0, OUT: 0, REVIEW: 0 };
      for (const c of statusRows ?? []) {
        const s = (c as { status: ClaimStatus }).status;
        if (s === "IN" || s === "OUT" || s === "REVIEW") counts[s] += 1;
      }
      projects.push({ ...project, counts });
    }

    const { data: transitionsRaw, error: transitionsError } = await db
      .from("transitions")
      .select("*")
      .in("to_status", ["OUT", "REVIEW"])
      .gte("at", since)
      .order("at", { ascending: false })
      .limit(100);
    if (transitionsError) throw transitionsError;

    const transitions = (transitionsRaw ?? []).map((r) =>
      rowToTransition(r as Record<string, unknown>),
    );

    const claimIds = [...new Set(transitions.map((t) => t.claim_id))];
    const eventIds = [...new Set(transitions.map((t) => t.event_id).filter(Boolean))] as string[];

    const claimsById = new Map<string, Claim>();
    const sourcesById = new Map<string, Source>();
    const eventsById = new Map<string, Event>();

    if (claimIds.length > 0) {
      const { data: claimsRaw, error: claimsError } = await db
        .from("claims")
        .select("*")
        .in("id", claimIds);
      if (claimsError) throw claimsError;
      const sourceIds: string[] = [];
      for (const row of claimsRaw ?? []) {
        const claim = rowToClaim(row as Record<string, unknown>);
        claimsById.set(claim.id, claim);
        sourceIds.push(claim.source_id);
      }
      if (sourceIds.length > 0) {
        const { data: sourcesRaw, error: sourcesError } = await db
          .from("sources")
          .select("*")
          .in("id", [...new Set(sourceIds)]);
        if (sourcesError) throw sourcesError;
        for (const row of sourcesRaw ?? []) {
          const source = rowToSource(row as Record<string, unknown>);
          sourcesById.set(source.id, source);
        }
      }
    }

    if (eventIds.length > 0) {
      const { data: eventsRaw, error: eventsError } = await db
        .from("events")
        .select("*")
        .in("id", eventIds);
      if (eventsError) throw eventsError;
      for (const row of eventsRaw ?? []) {
        const event = rowToEvent(row as Record<string, unknown>);
        eventsById.set(event.id, event);
      }
    }

    const items: FeedItem[] = transitions.map((transition) => {
      const claim = claimsById.get(transition.claim_id);
      if (!claim) {
        // Should not happen; keep a placeholder so the feed still renders.
        return {
          transition,
          claim: {
            id: transition.claim_id,
            project_id: "",
            text: "(missing claim)",
            kind: "fact",
            status: transition.to_status,
            source_id: "",
            valid_from: transition.at,
            recorded_at: transition.at,
            extracted_by: "unknown",
          },
          source: null,
          event: transition.event_id ? (eventsById.get(transition.event_id) ?? null) : null,
          children: [],
        };
      }
      return {
        transition,
        claim,
        source: sourcesById.get(claim.source_id) ?? null,
        event: transition.event_id ? (eventsById.get(transition.event_id) ?? null) : null,
        children: [],
      };
    });

    // Group chain falls (depth > 0) under the depth-0 transition that shares the same event.
    const roots: FeedItem[] = [];
    const byEventRoot = new Map<string, FeedItem>();
    for (const item of items) {
      if (item.transition.depth === 0) {
        roots.push(item);
        if (item.transition.event_id) {
          byEventRoot.set(item.transition.event_id, item);
        }
      }
    }
    for (const item of items) {
      if (item.transition.depth === 0) continue;
      const parent =
        (item.transition.event_id && byEventRoot.get(item.transition.event_id)) || null;
      if (parent) parent.children.push(item);
      else roots.push(item);
    }

    return { projects, feed: roots, since };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { projects: [], feed: [], since, error: message };
  }
}

export async function loadProjectInClaims(
  projectId: string,
): Promise<Partial<Record<ClaimKind, Claim[]>>> {
  const db = getServerSupabase();
  const { data, error } = await db
    .from("claims")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "IN")
    .order("recorded_at", { ascending: false });
  if (error) throw error;

  const grouped: Partial<Record<ClaimKind, Claim[]>> = {};
  for (const kind of KIND_ORDER) grouped[kind] = [];
  for (const row of data ?? []) {
    const claim = rowToClaim(row as Record<string, unknown>);
    const bucket = grouped[claim.kind] ?? (grouped[claim.kind] = []);
    bucket.push(claim);
  }
  return grouped;
}
