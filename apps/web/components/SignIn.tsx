"use client";

// Email sign-in (Supabase Auth magic link). The link brings the user back to
// the page they started on.
import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase-browser";

export function SignIn({ prompt }: { prompt: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setState("error");
      setMessage("Sign-in isn't set up on this site yet (NEXT_PUBLIC_SUPABASE_ANON_KEY).");
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.href } });
    if (error) {
      setState("error");
      setMessage(error.message);
    } else setState("sent");
  }

  if (state === "sent") return <p>Check your email and open the link. It brings you back here.</p>;
  return (
    <form onSubmit={send}>
      <label style={{ display: "block", marginBottom: 8 }}>{prompt}</label>
      <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={{ width: "100%", maxWidth: 360, padding: 10, fontSize: 16, border: "1px solid var(--line)", borderRadius: 6, marginBottom: 12, display: "block" }} />
      <button type="submit" style={{ padding: "10px 16px", fontSize: 16, border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", cursor: "pointer" }}>
        Send sign-in link
      </button>
      {state === "error" && <p style={{ color: "var(--out)" }}>{message}</p>}
    </form>
  );
}
