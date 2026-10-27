import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";

let cached: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export async function getGmailRefreshToken(): Promise<string | null> {
  const { data, error } = await supabase().rpc("plumb_get_gmail_refresh_token");
  if (error) throw new Error(`plumb_get_gmail_refresh_token: ${error.message}`);
  return typeof data === "string" && data.length > 0 ? data : null;
}

export async function getCursor(name: string): Promise<string | null> {
  const { data, error } = await supabase()
    .from("watcher_cursors")
    .select("value")
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`watcher_cursors read: ${error.message}`);
  return data?.value ?? null;
}

export async function setCursor(name: string, value: string): Promise<void> {
  const { error } = await supabase().rpc("plumb_set_cursor", { p_name: name, p_value: value });
  if (error) throw new Error(`plumb_set_cursor: ${error.message}`);
}
