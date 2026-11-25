/**
 * POST text to Plumb /ingest. Hooks must send text, never a local file path
 * (the server runs remotely and cannot read your disk).
 *
 * Preferred: the in-session model indexes via MCP record_event (plan usage).
 * This helper is the hook/backfill path: a local no-model index is attached so
 * /ingest never needs Muse Spark for index_only.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiBase, projectId } from "./plumb-env.mjs";
import { wantFullExtract } from "./full-extract.mjs";
import { hostIndex, indexExcerpt } from "./host-index.mjs";

const MAX_CHARS = 180_000;

export async function ingestText({
  text,
  sourceKind,
  externalId,
  title,
  token,
  indexOnly,
  label,
  projectId: projectIdOverride,
  at,
  /** Precomputed index; when set, hostIndex is skipped. */
  summary,
  personal,
  indexedBy,
}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { skipped: true, reason: "empty" };

  const pid =
    projectIdOverride !== undefined
      ? projectIdOverride
      : (() => {
          try {
            return projectId();
          } catch {
            return undefined;
          }
        })();
  // Pull-first: index by default; full extract only when opted in.
  const useIndex = indexOnly !== undefined ? indexOnly : !wantFullExtract(pid);

  const source = {
    kind: sourceKind,
    external_id: String(externalId).slice(0, 200),
  };
  if (title && String(title).trim()) {
    source.title = String(title).trim().slice(0, 200);
  }
  if (label === "personal") source.label = "personal";
  const body = {
    source,
    text: useIndex
      ? indexExcerpt(trimmed)
      : trimmed.length > MAX_CHARS
        ? trimmed.slice(-MAX_CHARS)
        : trimmed,
  };
  // When the text was written, for past sessions. Without it the server uses now.
  if (at) body.at = at;
  // Full extraction needs a project. Index mode may omit it (personal / unknown).
  if (useIndex) {
    body.index_only = true;
    if (pid) body.project_id = pid;
    // Host indexes here so Railway mcp never needs Muse for sessions.
    const indexed =
      summary && String(summary).trim()
        ? {
            title: source.title,
            summary: String(summary).trim(),
            personal: personal ?? false,
            indexed_by: indexedBy || `client/${sourceKind}`,
          }
        : await hostIndex(trimmed, {
            title: source.title,
            sourceKind,
          });
    if (indexed.title && !source.title) {
      source.title = indexed.title.slice(0, 200);
      body.source = source;
    }
    body.summary = indexed.summary;
    body.personal = indexed.personal;
    body.indexed_by = indexed.indexed_by;
    if (indexed.personal && !source.label) {
      source.label = "personal";
      body.source = source;
    }
  } else {
    body.project_id = pid !== undefined ? pid : projectId();
  }

  const res = await fetch(`${apiBase()}/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { raw };
  }
  if (!res.ok) {
    const err =
      json && typeof json === "object" && "error" in json
        ? String(json.error)
        : raw.slice(0, 300);
    throw new Error(`ingest HTTP ${res.status}: ${err}`);
  }
  return json;
}

export async function getProjectState(token, since) {
  const body = { project_id: projectId() };
  if (since) body.since = since;
  const res = await fetch(`${apiBase()}/tools/get_project_state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`get_project_state bad JSON: ${raw.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `get_project_state HTTP ${res.status}: ${json?.error ?? raw.slice(0, 200)}`,
    );
  }
  return json;
}

/** Plain text summary for SessionStart / additional_context (fallback). */
export function formatProjectState(state) {
  if (typeof state?.markdown === "string" && state.markdown.trim()) {
    return state.markdown.trimEnd() + "\n";
  }
  const lines = [`# Plumb project state: ${state.project?.name ?? "?"}`];
  const inClaims = state.in_claims ?? {};
  for (const kind of Object.keys(inClaims).sort()) {
    const claims = inClaims[kind] ?? [];
    if (!claims.length) continue;
    lines.push(`## ${kind}`);
    for (const c of claims) lines.push(`- [${c.status}] ${c.text}`);
  }
  const changed = state.changed_since ?? [];
  if (changed.length) {
    lines.push("## changed since last day");
    for (const row of changed) {
      const t = row.transition;
      lines.push(
        `- ${row.claim?.text ?? "?"} → ${t?.to_status}: ${t?.explanation ?? ""}`,
      );
    }
  }
  if (state.summary) lines.push(`## summary\n${state.summary}`);
  return lines.join("\n") + "\n";
}

/** Write get_project_state.markdown (or the fallback) to PROJECT_STATE.md. */
export function writeProjectStateFile(state, dir) {
  const md = formatProjectState(state);
  const path = resolve(dir, "PROJECT_STATE.md");
  writeFileSync(path, md, "utf8");
  return path;
}
