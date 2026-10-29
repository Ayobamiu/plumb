import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-server";
import { plumbApiBase } from "@/lib/plumb-api";

type Body = {
  project_id?: unknown;
  text?: unknown;
  source_title?: unknown;
};

/**
 * Proxies to Claude Code's POST /ingest when PLUMB_INGEST_URL is set.
 * Until extraction lands, this returns 501.
 */
export async function POST(request: Request) {
  const signed = await requireUser(request);
  if (signed instanceof Response) return signed;
  let raw: Body;
  try {
    raw = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const projectId = typeof raw.project_id === "string" ? raw.project_id.trim() : "";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!projectId || !text) {
    return NextResponse.json(
      { error: "project_id and text are required" },
      { status: 400 },
    );
  }

  const api = plumbApiBase();
  const base = api ? `${api}/ingest` : undefined;
  if (!base) {
    return NextResponse.json(
      {
        error:
          "Saving notes isn't available right now. Nothing was stored.",
      },
      { status: 501 },
    );
  }

  try {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: signed.authorization, // saved as this user's note
      },
      body: JSON.stringify({
        project_id: projectId,
        source: {
          kind: "manual",
          external_id: `notes-${Date.now()}`,
          title:
            typeof raw.source_title === "string" && raw.source_title.trim()
              ? raw.source_title.trim()
              : "Homepage notes",
        },
        text,
      }),
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
