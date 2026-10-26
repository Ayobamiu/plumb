"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  claimId: string;
};

export function ReviewActions({ claimId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "confirm_out" | "restore_in") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/resolve-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim_id: claimId, action }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="actions">
      <button
        type="button"
        className="primary"
        disabled={busy !== null}
        onClick={() => void act("confirm_out")}
      >
        {busy === "confirm_out" ? "Working…" : "Confirm OUT"}
      </button>
      <button type="button" disabled={busy !== null} onClick={() => void act("restore_in")}>
        {busy === "restore_in" ? "Working…" : "Still true"}
      </button>
      <button
        type="button"
        disabled
        title="Edit lands when resolve_review edit is wired"
      >
        Edit
      </button>
      {error ? <span className="meta">{error}</span> : null}
    </div>
  );
}
