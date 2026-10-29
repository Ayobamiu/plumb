import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-server";
import { plumbApiBase } from "@/lib/plumb-api";

/** Proxies to remote POST /links (list pending link suggestions). */
export async function POST(request: Request) {
  const signed = await requireUser(request);
  if (signed instanceof Response) return signed;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const projectId =
    raw && typeof raw === "object" && typeof (raw as { project_id?: unknown }).project_id === "string"
      ? (raw as { project_id: string }).project_id.trim()
      : "";
  if (!projectId) {
    return NextResponse.json({ error: "project_id is required" }, { status: 400 });
  }

  const base = plumbApiBase();
  if (!base) {
    return NextResponse.json(
      { error: "Set PLUMB_INGEST_URL or PLUMB_MCP_URL for links." },
      { status: 501 },
    );
  }

  const token = signed.authorization.replace(/^Bearer\s+/i, "");
  try {
    const res = await fetch(`${base}/links`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ project_id: projectId }),
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
