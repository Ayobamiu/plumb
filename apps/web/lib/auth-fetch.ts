"use client";

// fetch for the homepage's own API: adds the signed-in user's session.
import { getBrowserSupabase } from "./supabase-browser";

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const session = (await getBrowserSupabase()?.auth.getSession())?.data.session;
  const headers = new Headers(init.headers);
  if (session) headers.set("authorization", `Bearer ${session.access_token}`);
  return fetch(input, { ...init, headers });
}
