import { NextResponse } from "next/server";
import type {
  AbsencePattern,
  Claim,
  ClaimKind,
  ClaimStatus,
  Reason,
  Source,
  Transition,
} from "@plumb/core";
import { hasServerDb } from "@/lib/env";
import { getServerSupabase } from "@/lib/supabase-server";

function asClaim(row: Record<string, unknown>): Claim {
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

function asSource(row: Record<string, unknown>): Source {
  return {
    id: String(row.id),
    kind: row.kind as Source["kind"],
    external_id: String(row.external_id),
    uri: row.uri ? String(row.uri) : undefined,
    title: row.title ? String(row.title) : undefined,
  };
}

function asTransition(row: Record<string, unknown>): Transition {
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

function asReason(row: Record<string, unknown>): Reason {
  const id = String(row.id);
  const claim_id = String(row.claim_id);
  const type = row.type as Reason["type"];
  const data = row.data as Record<string, unknown>;
  if (type === "depends_on") {
    return { id, claim_id, type, claim: String(data.claim) };
  }
  if (type === "evidence") {
    return { id, claim_id, type, event_id: String(data.event_id) };
  }
  if (type === "absence") {
    return {
      id,
      claim_id,
      type,
      pattern: data.pattern as AbsencePattern,
      since: String(data.since),
    };
  }
  return { id, claim_id, type: "until", at: String(data.at) };
}

export async function GET(request: Request) {
  if (!hasServerDb()) {
    return NextResponse.json(
      { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      { status: 503 },
    );
  }
  const claimId = new URL(request.url).searchParams.get("claim_id");
  if (!claimId) {
    return NextResponse.json({ error: "claim_id is required" }, { status: 400 });
  }

  try {
    const db = getServerSupabase();
    const { data: claimRow, error: claimError } = await db
      .from("claims")
      .select("*")
      .eq("id", claimId)
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimRow) {
      return NextResponse.json({ error: "claim not found" }, { status: 404 });
    }
    const claim = asClaim(claimRow as Record<string, unknown>);

    const { data: sourceRow, error: sourceError } = await db
      .from("sources")
      .select("*")
      .eq("id", claim.source_id)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!sourceRow) {
      return NextResponse.json({ error: "source not found" }, { status: 404 });
    }

    const { data: reasonRows, error: reasonsError } = await db
      .from("reasons")
      .select("*")
      .eq("claim_id", claimId);
    if (reasonsError) throw reasonsError;
    const reasons = (reasonRows ?? []).map((r) => asReason(r as Record<string, unknown>));

    const dependsIds = reasons
      .filter((r): r is Extract<Reason, { type: "depends_on" }> => r.type === "depends_on")
      .map((r) => r.claim);

    let depends_on: Claim[] = [];
    if (dependsIds.length > 0) {
      const { data, error } = await db.from("claims").select("*").in("id", dependsIds);
      if (error) throw error;
      depends_on = (data ?? []).map((r) => asClaim(r as Record<string, unknown>));
    }

    const { data: depReasonRows, error: depError } = await db
      .from("reasons")
      .select("claim_id")
      .eq("type", "depends_on")
      .eq("data->>claim", claimId);
    if (depError) throw depError;
    const dependentIds = [...new Set((depReasonRows ?? []).map((r) => String(r.claim_id)))];

    let dependents: Claim[] = [];
    if (dependentIds.length > 0) {
      const { data, error } = await db.from("claims").select("*").in("id", dependentIds);
      if (error) throw error;
      dependents = (data ?? []).map((r) => asClaim(r as Record<string, unknown>));
    }

    const { data: historyRows, error: historyError } = await db
      .from("transitions")
      .select("*")
      .eq("claim_id", claimId)
      .order("at", { ascending: true });
    if (historyError) throw historyError;

    return NextResponse.json({
      claim,
      source: asSource(sourceRow as Record<string, unknown>),
      reasons,
      depends_on,
      dependents,
      history: (historyRows ?? []).map((r) => asTransition(r as Record<string, unknown>)),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
