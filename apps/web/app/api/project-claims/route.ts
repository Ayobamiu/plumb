import { NextResponse } from "next/server";
import { loadProjectInClaims } from "@/lib/data";
import { hasServerDb } from "@/lib/env";

export async function GET(request: Request) {
  if (!hasServerDb()) {
    return NextResponse.json(
      { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      { status: 503 },
    );
  }
  const projectId = new URL(request.url).searchParams.get("project_id");
  if (!projectId) {
    return NextResponse.json({ error: "project_id is required" }, { status: 400 });
  }
  try {
    const claims = await loadProjectInClaims(projectId);
    return NextResponse.json({ claims });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
