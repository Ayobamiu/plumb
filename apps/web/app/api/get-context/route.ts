import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-server";
import { plumbApiBase } from "@/lib/plumb-api";

/** Proxies to remote POST /tools/get_context. */
export async function POST(request: Request) {
  const signed = await requireUser(request);
  if (signed instanceof Response) return signed;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const uri =
    raw && typeof raw === "object" && typeof (raw as { uri?: unknown }).uri === "string"
      ? (raw as { uri: string }).uri.trim()
      : "";
  if (!uri) {
    return NextResponse.json({ error: "uri is required" }, { status: 400 });
  }

  const base = plumbApiBase();
  if (!base) {
    return NextResponse.json(
      { error: "Set PLUMB_INGEST_URL or PLUMB_MCP_URL for search." },
      { status: 501 },
    );
  }

  const token = signed.authorization.replace(/^Bearer\s+/i, "");
  try {
    const res = await fetch(`${base}/tools/get_context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ uri }),
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
