import { NextResponse } from "next/server";
import { ResolveReviewInput } from "@plumb/core";

/**
 * Proxies to the MCP resolve_review handler once Claude Code wires it.
 * Until then, return 501 so the UI can show a clear message.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ResolveReviewInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const base = process.env.PLUMB_MCP_URL;
  if (!base) {
    return NextResponse.json(
      {
        error:
          "resolve_review is not wired yet. Needs MCP handlers (Claude Code) and PLUMB_MCP_URL.",
      },
      { status: 501 },
    );
  }

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/tools/resolve_review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.PLUMB_MCP_TOKEN
          ? { authorization: `Bearer ${process.env.PLUMB_MCP_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(parsed.data),
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
