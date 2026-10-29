import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-server";
import { plumbApiBase } from "@/lib/plumb-api";

/** Proxies to remote POST /links/resolve (accept or dismiss). */
export async function POST(request: Request) {
  const signed = await requireUser(request);
  if (signed instanceof Response) return signed;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const action = o.action;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (action !== "accept" && action !== "dismiss") {
    return NextResponse.json({ error: "action must be accept or dismiss" }, { status: 400 });
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
    const res = await fetch(`${base}/links/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ id, action }),
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
