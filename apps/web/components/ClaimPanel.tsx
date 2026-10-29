"use client";

import { authFetch } from "@/lib/auth-fetch";
import { useEffect, useState } from "react";
import type { Claim, Reason, Source, Transition } from "@plumb/core";

type ExplainPayload = {
  claim: Claim;
  source: Source;
  reasons: Reason[];
  depends_on: Claim[];
  dependents: Claim[];
  history: Transition[];
};

type Props = {
  claimId: string | null;
  onClose: () => void;
};

function reasonLine(reason: Reason): string {
  switch (reason.type) {
    case "depends_on":
      return `depends on claim ${reason.claim}`;
    case "evidence":
      return `evidence from event ${reason.event_id}`;
    case "absence": {
      const p = reason.pattern;
      const bits: string[] = [p.event_kind];
      if (p.from) bits.push(`from ${p.from}`);
      if (p.thread_id) bits.push(`thread ${p.thread_id}`);
      return `absence of ${bits.join(", ")} since ${reason.since}`;
    }
    case "until":
      return `until ${reason.at}`;
  }
}

export function ClaimPanel({ claimId, onClose }: Props) {
  const [data, setData] = useState<ExplainPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!claimId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await authFetch(`/api/explain-claim?claim_id=${encodeURIComponent(claimId)}`);
        const body = (await res.json()) as ExplainPayload & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [claimId]);

  if (!claimId) return null;

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} aria-hidden />
      <aside className="panel" role="dialog" aria-label="Claim detail">
        <header>
          <h2>Claim</h2>
          <button type="button" className="close" onClick={onClose}>
            Close
          </button>
        </header>
        {loading ? <p className="empty">Loading…</p> : null}
        {error ? <p className="banner error">{error}</p> : null}
        {data ? (
          <dl>
            <dt>Text</dt>
            <dd>
              <span className={`status ${data.claim.status}`}>{data.claim.status}</span>
              {data.claim.text}
            </dd>
            <dt>Kind</dt>
            <dd>{data.claim.kind.replace(/_/g, " ")}</dd>
            <dt>Source</dt>
            <dd>
              {data.source.kind}
              {data.source.label === "personal" ? " (personal)" : ""}
              {data.source.title ? ` · ${data.source.title}` : ""}
            </dd>
            <dt>Reasons</dt>
            <dd>
              <ul>
                {data.reasons.map((r) => (
                  <li key={r.id}>{reasonLine(r)}</li>
                ))}
              </ul>
            </dd>
            <dt>Depends on</dt>
            <dd>
              {data.depends_on.length === 0 ? (
                <span className="empty">None</span>
              ) : (
                <ul>
                  {data.depends_on.map((c) => (
                    <li key={c.id}>{c.text}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Dependents</dt>
            <dd>
              {data.dependents.length === 0 ? (
                <span className="empty">None</span>
              ) : (
                <ul>
                  {data.dependents.map((c) => (
                    <li key={c.id}>{c.text}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>History</dt>
            <dd>
              <ul>
                {data.history.map((t) => (
                  <li key={t.id}>
                    {t.from_status} → {t.to_status}: {t.explanation}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        ) : null}
      </aside>
    </>
  );
}
