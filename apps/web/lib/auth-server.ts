// Per user (Oct 28): every homepage API route needs the signed-in user's
// Supabase session as a bearer token. Data routes filter by the user; routes
// that call the Plumb server forward the same token, which the server checks.
import { NextResponse } from "next/server";
import { getServerSupabase } from "./supabase-server";

export type Signed = { userId: string; authorization: string };

export async function requireUser(request: Request): Promise<Signed | NextResponse> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (!token) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const { data, error } = await getServerSupabase().auth.getUser(token);
  if (error || !data.user) return NextResponse.json({ error: "sign in again" }, { status: 401 });
  return { userId: data.user.id, authorization };
}
