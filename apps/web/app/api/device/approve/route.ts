// Device sign-in (Oct 28): the /device page sends the signed-in user's Supabase
// session token and the code from `npx plumb init`; the mcp server checks the
// session and approves the code. Proxied so the browser never needs CORS.
import { NextResponse } from "next/server";
import { plumbApiBase } from "@/lib/plumb-api";

export async function POST(req: Request) {
  const base = plumbApiBase();
  if (!base) return NextResponse.json({ error: "Plumb API URL is not set" }, { status: 503 });
  const session = req.headers.get("authorization") ?? "";
  const body = await req.text();
  const res = await fetch(`${base}/auth/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: session },
    body,
  });
  return NextResponse.json(await res.json().catch(() => ({ error: "bad answer from Plumb" })), { status: res.status });
}
