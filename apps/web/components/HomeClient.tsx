"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Claim, ClaimKind } from "@plumb/core";
import type { FeedItem, ProjectWithCounts } from "@/lib/data";
import { kindLabel, KIND_ORDER } from "@/lib/kinds";
import { AddNotes } from "./AddNotes";
import { ClaimPanel } from "./ClaimPanel";
import { ReviewActions } from "./ReviewActions";

type Props = {
  projects: ProjectWithCounts[];
  feed: FeedItem[];
  since: string;
  error?: string;
  realtimeReady: boolean;
};

function sourceLabel(item: FeedItem): string {
  if (!item.source) return "unknown source";
  const title = item.source.title ?? item.source.external_id;
  return `${item.source.kind} · ${title}`;
}

function FeedBlock({
  item,
  onOpen,
}: {
  item: FeedItem;
  onOpen: (id: string) => void;
}) {
  return (
    <article className="feed-item">
      <div>
        <span className={`status ${item.transition.to_status}`}>
          {item.transition.to_status}
        </span>
        <span className="meta">{new Date(item.transition.at).toLocaleString()}</span>
      </div>
      <p className="claim-text">
        <button type="button" onClick={() => onOpen(item.claim.id)}>
          {item.claim.text}
        </button>
      </p>
      <p className="explanation">{item.transition.explanation}</p>
      <p className="source-line">
        From {sourceLabel(item)}
        {item.event ? ` · broke on: ${item.event.summary}` : ""}
      </p>
      {item.transition.to_status === "REVIEW" ? (
        <ReviewActions claimId={item.claim.id} />
      ) : null}
      {item.children.length > 0 ? (
        <div className="children">
          {item.children.map((child) => (
            <FeedBlock key={child.transition.id} item={child} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function HomeClient({ projects, feed, since, error, realtimeReady }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(
    projects[0]?.id ?? null,
  );
  const [inClaims, setInClaims] = useState<Partial<Record<ClaimKind, Claim[]>>>({});
  const [claimsError, setClaimsError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    if (!realtimeReady) return;
    let cancelled = false;
    let channel: { unsubscribe: () => void } | null = null;

    void (async () => {
      const { getBrowserSupabase } = await import("@/lib/supabase-browser");
      const client = getBrowserSupabase();
      if (!client || cancelled) return;
      channel = client
        .channel("transitions-feed")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "transitions" },
          () => refresh(),
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      channel?.unsubscribe();
    };
  }, [realtimeReady, refresh]);

  useEffect(() => {
    if (!expandedProjectId) {
      setInClaims({});
      return;
    }
    let cancelled = false;
    setClaimsError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/project-claims?project_id=${encodeURIComponent(expandedProjectId)}`,
        );
        const body = (await res.json()) as {
          claims?: Partial<Record<ClaimKind, Claim[]>>;
          error?: string;
        };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) setInClaims(body.claims ?? {});
      } catch (err) {
        if (!cancelled) setClaimsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandedProjectId]);

  const firstProjectId = projects[0]?.id ?? null;

  return (
    <>
      {error ? (
        <div className="banner error" role="alert">
          Could not read Supabase: {error}
        </div>
      ) : null}
      {!realtimeReady && !error ? (
        <div className="banner">
          Live updates need NEXT_PUBLIC_SUPABASE_ANON_KEY and a read policy on transitions.
          The page still loads over the service role.
        </div>
      ) : null}

      <section>
        <h2>Changed since you last looked</h2>
        <p className="meta">Transitions to OUT or REVIEW since {new Date(since).toLocaleString()}.</p>
        {feed.length === 0 ? (
          <p className="empty">Nothing changed in this window yet.</p>
        ) : (
          <div className="feed">
            {feed.map((item) => (
              <FeedBlock key={item.transition.id} item={item} onOpen={setSelectedClaimId} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>Projects</h2>
        {projects.length === 0 ? (
          <p className="empty">No projects yet.</p>
        ) : (
          projects.map((project) => {
            const open = expandedProjectId === project.id;
            return (
              <div key={project.id} className="project">
                <div className="project-header">
                  <button
                    type="button"
                    className="project-name"
                    onClick={() =>
                      setExpandedProjectId(open ? null : project.id)
                    }
                  >
                    {project.name}
                  </button>
                  <span className="counts">
                    IN {project.counts.IN} · OUT {project.counts.OUT} · REVIEW{" "}
                    {project.counts.REVIEW}
                  </span>
                </div>
                {open ? (
                  <div>
                    {claimsError ? <p className="banner error">{claimsError}</p> : null}
                    {KIND_ORDER.map((kind) => {
                      const list = inClaims[kind] ?? [];
                      if (list.length === 0) return null;
                      return (
                        <div key={kind} className="kind-block">
                          <h3>{kindLabel(kind)}</h3>
                          <ul>
                            {list.map((claim) => (
                              <li key={claim.id}>
                                <button
                                  type="button"
                                  onClick={() => setSelectedClaimId(claim.id)}
                                >
                                  {claim.text}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                    {!claimsError &&
                    KIND_ORDER.every((k) => (inClaims[k] ?? []).length === 0) ? (
                      <p className="empty">No IN claims.</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </section>

      <section>
        <h2>Add notes</h2>
        <p className="meta">Paste text. It goes to /ingest when that endpoint is live.</p>
        <AddNotes projectId={expandedProjectId ?? firstProjectId} />
      </section>

      <ClaimPanel claimId={selectedClaimId} onClose={() => setSelectedClaimId(null)} />
    </>
  );
}
