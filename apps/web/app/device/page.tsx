"use client";

// Device sign-in (Oct 28): `npx plumb init` opens /device?code=ABCD-EFGH. The
// user signs in with GitHub (Supabase Auth, Oct 30), checks the code matches
// their terminal, and approves. The terminal then gets its own token.
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getBrowserSupabase } from "@/lib/supabase-browser";

type State = "loading" | "signed_out" | "ready" | "approving" | "done" | "error";

export default function DevicePage() {
  const supabase = getBrowserSupabase();
  const [code, setCode] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<State>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setCode(new URLSearchParams(window.location.search).get("code")?.toUpperCase() ?? "");
    if (!supabase) {
      setState("error");
      setMessage("Sign-in isn't set up on this site yet. Please try again later.");
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setState(data.session ? "ready" : "signed_out");
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) setState((prev) => (prev === "done" ? prev : "ready"));
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  async function signIn() {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: window.location.href } });
    if (error) {
      setState("error");
      setMessage(error.message);
    }
  }

  async function approve() {
    if (!session) return;
    setState("approving");
    const res = await fetch("/api/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ user_code: code }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) setState("done");
    else {
      setState("error");
      setMessage(body.error ?? "Something went wrong. Run `npx plumb init` again.");
    }
  }

  return (
    <main style={{ maxWidth: 440, margin: "12vh auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>Connect your terminal to Plumb</h1>
      <p style={{ color: "var(--muted)", margin: "0 0 24px" }}>
        Approve this code only if it matches the one in your terminal.
      </p>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 28, letterSpacing: 2, padding: "12px 16px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-elevated)", textAlign: "center", marginBottom: 24 }}>
        {code || "no code"}
      </div>

      {state === "loading" && <p>Checking sign-in...</p>}

      {state === "signed_out" && (
        <button onClick={signIn} style={button}>
          Continue with GitHub
        </button>
      )}

      {(state === "ready" || state === "approving") && (
        <>
          <p style={{ marginBottom: 12 }}>Signed in as {session?.user.user_metadata?.user_name ?? session?.user.email}.</p>
          <button onClick={approve} disabled={!code || state === "approving"} style={button}>
            {state === "approving" ? "Approving..." : "Approve"}
          </button>
        </>
      )}

      {state === "done" && <p>Done. Go back to your terminal; it will finish on its own.</p>}
      {state === "error" && <p style={{ color: "var(--out)" }}>{message}</p>}
    </main>
  );
}

const button: React.CSSProperties = { width: "100%", padding: 12, fontSize: 16, border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", cursor: "pointer" };
