import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-server";
import { plumbApiBase } from "@/lib/plumb-api";

/** Proxies to remote POST /tools/find_context. */
export async function POST(request: Request) {
  const signed = await requireUser(request);
  if (signed instanceof Response) return signed;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const query =
    raw && typeof raw === "object" && typeof (raw as { query?: unknown }).query === "string"
      ? (raw as { query: string }).query.trim()
      : "";
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const projectId =
    raw && typeof raw === "object" && typeof (raw as { project_id?: unknown }).project_id === "string"
      ? (raw as { project_id: string }).project_id.trim()
      : undefined;

  const base = plumbApiBase();
  if (!base) {
    return NextResponse.json(
      { error: "Set PLUMB_INGEST_URL or PLUMB_MCP_URL for search." },
      { status: 501 },
    );
  }

  const token = signed.authorization.replace(/^Bearer\s+/i, "");
  const body: { query: string; project_id?: string; limit?: number } = { query, limit: 8 };
  if (projectId) body.project_id = projectId;

  try {
    const res = await fetch(`${base}/tools/find_context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
