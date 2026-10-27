/**
 * POST text to Plumb /ingest. Hooks must send text, never a local file path
 * (the server runs remotely and cannot read your disk).
 */
import { apiBase, projectId } from "./plumb-env.mjs";

const MAX_CHARS = 180_000;

export async function ingestText({
  text,
  sourceKind,
  externalId,
  title,
  token,
}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { skipped: true, reason: "empty" };

  const body = {
    project_id: projectId(),
    source: {
      kind: sourceKind,
      external_id: String(externalId).slice(0, 200),
      title: title ? String(title).slice(0, 200) : undefined,
    },
    text: trimmed.length > MAX_CHARS ? trimmed.slice(-MAX_CHARS) : trimmed,
  };

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

/** Plain text summary for SessionStart / additional_context. */
export function formatProjectState(state) {
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
  return lines.join("\n");
}
