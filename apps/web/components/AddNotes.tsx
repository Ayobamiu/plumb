"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  projectId: string | null;
};

export function AddNotes({ projectId }: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          text: text.trim(),
        }),
      });
      const body = (await res.json()) as { error?: string; ok?: boolean };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setText("");
      setMessage("Sent. Claims will show once /ingest is live.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="notes" onSubmit={(e) => void submit(e)}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste notes. They go to /ingest as claims with reasons."
        disabled={!projectId || busy}
      />
      <div className="actions">
        <button type="submit" className="primary" disabled={!projectId || busy || !text.trim()}>
          {busy ? "Sending…" : "Add notes"}
        </button>
        {!projectId ? <span className="meta">Create a project first.</span> : null}
        {message ? <span className="meta">{message}</span> : null}
      </div>
    </form>
  );
}
