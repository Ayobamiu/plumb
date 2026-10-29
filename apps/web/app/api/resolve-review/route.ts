import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-server";
import { plumbApiBase } from "@/lib/plumb-api";

type ResolveBody = {
  claim_id: string;
  action: "confirm_out" | "restore_in" | "edit";
  text?: string;
  note?: string;
};

function parseBody(raw: unknown): ResolveBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid JSON body" };
  const o = raw as Record<string, unknown>;
  const claimId = typeof o.claim_id === "string" ? o.claim_id.trim() : "";
  const action = o.action;
  if (!claimId) return { error: "claim_id is required" };
  if (action !== "confirm_out" && action !== "restore_in" && action !== "edit") {
    return { error: "action must be confirm_out, restore_in, or edit" };
  }
  const text = typeof o.text === "string" ? o.text.trim() : undefined;
  const note = typeof o.note === "string" ? o.note : undefined;
  if (action === "edit" && !text) return { error: "text is required when action is edit" };
  return { claim_id: claimId, action, text, note };
}

/** Proxies to remote POST /tools/resolve_review. */
export async function POST(request: Request) {
  const signed = await requireUser(request);
  if (signed instanceof Response) return signed;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const base = plumbApiBase();
  if (!base) {
    return NextResponse.json(
      { error: "Set PLUMB_INGEST_URL or PLUMB_MCP_URL for resolve_review." },
      { status: 501 },
    );
  }

  const token = signed.authorization.replace(/^Bearer\s+/i, "");
  try {
    const res = await fetch(`${base}/tools/resolve_review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(parsed),
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
