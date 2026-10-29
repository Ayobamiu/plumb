"use client";

// Per user (Oct 28): sign in, then load this user's projects and feed from
// /api/home. Refreshes every 15 seconds (realtime needs per-user database
// policies, which come later).
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { HomeClient } from "./HomeClient";
import { SignIn } from "./SignIn";
import { authFetch } from "@/lib/auth-fetch";
import type { HomeData } from "@/lib/data";
import { getBrowserSupabase } from "@/lib/supabase-browser";

export function Home() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [data, setData] = useState<HomeData | null>(null);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return setSession(null);
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    const res = await authFetch("/api/home");
    const body = (await res.json().catch(() => ({}))) as HomeData & { error?: string };
    setData(res.ok ? body : { projects: [], feed: [], since: new Date().toISOString(), error: body.error ?? `HTTP ${res.status}` });
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  if (session === undefined) return <p>Loading...</p>;
  if (!session) return <SignIn prompt="Sign in with your email to see your Plumb. We'll send you a link." />;
  if (!data) return <p>Loading your projects...</p>;
  return (
    <>
      <p style={{ color: "var(--muted)", fontSize: 14 }}>
        Signed in as {session.user.email}.{" "}
        <a href="#" onClick={(e) => (e.preventDefault(), void getBrowserSupabase()?.auth.signOut())}>
          Sign out
        </a>
      </p>
      <HomeClient projects={data.projects} feed={data.feed} since={data.since} error={data.error} realtimeReady={false} onRefresh={load} />
    </>
  );
}
