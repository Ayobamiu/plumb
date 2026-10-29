"use client";

import { authFetch } from "@/lib/auth-fetch";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  claimId: string;
  claimText?: string;
};

export function ReviewActions({ claimId, claimText }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(claimText ?? "");

  async function post(body: Record<string, unknown>) {
    setError(null);
    const res = await authFetch("/api/resolve-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    router.refresh();
  }

  async function act(action: "confirm_out" | "restore_in") {
    setBusy(action);
    try {
      await post({ claim_id: claimId, action });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    const text = editText.trim();
    if (!text) {
      setError("Edited text cannot be empty");
      return;
    }
    setBusy("edit");
    try {
      await post({ claim_id: claimId, action: "edit", text });
      setEditing(false);
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
        disabled={busy !== null}
        onClick={() => {
          setEditing((v) => !v);
          setEditText(claimText ?? "");
        }}
      >
        Edit
      </button>
      {editing ? (
        <div className="edit-row">
          <input
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            disabled={busy !== null}
            aria-label="Edited claim text"
          />
          <button type="button" className="primary" disabled={busy !== null} onClick={() => void saveEdit()}>
            {busy === "edit" ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}
      {error ? <span className="meta">{error}</span> : null}
    </div>
  );
}
