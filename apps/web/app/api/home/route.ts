// The homepage's data for the signed-in user (per user, Oct 28).
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth-server";
import { loadHomeData } from "@/lib/data";

export async function GET(request: Request) {
  const signed = await requireUser(request);
  if (signed instanceof Response) return signed;
  return NextResponse.json(await loadHomeData(signed.userId));
}
