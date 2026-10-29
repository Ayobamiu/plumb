"use client";

import { authFetch } from "@/lib/auth-fetch";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Claim } from "@plumb/core";

type LinkSuggestion = {
  id: string;
  project_id: string;
  why: string;
  claim: Claim;
  depends_on_claim: Claim;
};

type Props = {
  projectIds: string[];
  onOpen: (claimId: string) => void;
};

export function SuggestedLinks({ projectIds, onOpen }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<LinkSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (projectIds.length === 0) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const lists = await Promise.all(
          projectIds.map(async (project_id) => {
            const res = await authFetch("/api/links", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ project_id }),
            });
            const body = (await res.json()) as {
              suggestions?: LinkSuggestion[];
              error?: string;
            };
            if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
            return body.suggestions ?? [];
          }),
        );
        if (!cancelled) setItems(lists.flat());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectIds.join("|")]);

  async function resolve(id: string, action: "accept" | "dismiss") {
    setBusyId(id);
    setError(null);
    try {
      const res = await authFetch("/api/links/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setItems((prev) => prev.filter((s) => s.id !== id));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (projectIds.length === 0) return null;

  return (
    <section>
      <h2>Suggested links</h2>
      <p className="meta">
        The sleep-time sweep thinks one claim rests on another. Accept to add the
        link; dismiss to skip it.
      </p>
      {error ? <p className="banner error">{error}</p> : null}
      {items.length === 0 && !error ? (
        <p className="empty">No pending link suggestions.</p>
      ) : (
        <div className="feed">
          {items.map((s) => (
            <article key={s.id} className="feed-item">
              <p className="claim-text">
                <button type="button" onClick={() => onOpen(s.claim.id)}>
                  {s.claim.text}
                </button>
                {" rests on "}
                <button type="button" onClick={() => onOpen(s.depends_on_claim.id)}>
                  {s.depends_on_claim.text}
                </button>
              </p>
              <p className="explanation">{s.why}</p>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busyId !== null}
                  onClick={() => void resolve(s.id, "accept")}
                >
                  {busyId === s.id ? "Working…" : "Accept"}
                </button>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void resolve(s.id, "dismiss")}
                >
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
