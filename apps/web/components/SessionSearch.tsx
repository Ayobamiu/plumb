"use client";

import { authFetch } from "@/lib/auth-fetch";
import { useState } from "react";

type ContextHit = {
  uri: string;
  name: string;
  tool?: string;
  title?: string;
  last_at?: string;
  why?: string;
};

type Props = {
  projectId?: string | null;
};

export function SessionSearch({ projectId }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContextHit[]>([]);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setMarkdown(null);
    setActiveName(null);
    setHits([]);
    try {
      const res = await authFetch("/api/find-context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: q,
          ...(projectId ? { project_id: projectId } : {}),
        }),
      });
      const body = (await res.json()) as {
        contexts?: ContextHit[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const list = body.contexts ?? [];
      setHits(list);
      const first = list[0];
      if (first && !(first.why ?? "").startsWith("Not a clear match")) {
        await openHit(first);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openHit(hit: ContextHit) {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch("/api/get-context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: hit.uri }),
      });
      const body = (await res.json()) as {
        markdown?: string;
        name?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMarkdown(body.markdown ?? "");
      setActiveName(body.name ?? hit.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Find a past session</h2>
      <p className="meta">
        Same search as /plumb. Describe it in your own words.
      </p>
      <form className="session-search" onSubmit={search}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. gym plan from Claude last week"
          aria-label="Search past sessions"
        />
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error ? <p className="banner error">{error}</p> : null}
      {hits.length > 0 ? (
        <ul className="session-hits">
          {hits.map((hit) => {
            const unclear = (hit.why ?? "").startsWith("Not a clear match");
            return (
              <li key={hit.uri}>
                <button
                  type="button"
                  className="session-hit"
                  disabled={unclear}
                  onClick={() => void openHit(hit)}
                >
                  <span className="session-hit-name">{hit.name}</span>
                  {hit.why ? <span className="meta">{hit.why}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {markdown ? (
        <article className="session-context">
          {activeName ? <h3>{activeName}</h3> : null}
          <pre className="session-markdown">{markdown}</pre>
        </article>
      ) : null}
    </section>
  );
}
