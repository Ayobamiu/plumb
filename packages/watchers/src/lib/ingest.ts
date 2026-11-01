/** POST /ingest on the remote MCP server. Watchers send text, never a file path. */
import { plumbApiBase, requireEnv, watcherToken } from "./env.js";

const MAX_CHARS = 180_000;

export type IngestBody = {
  text: string;
  sourceKind:
    | "doc"
    | "manual"
    | "claude_code"
    | "cursor"
    | "claude_chat"
    | "muse_code"
    | "gmail_thread";
  externalId: string;
  title?: string;
  /** Cheap title+summary only (Oct 28). No claims. */
  indexOnly?: boolean;
  label?: "personal";
};

export async function ingestText(input: IngestBody): Promise<unknown> {
  const trimmed = input.text.trim();
  if (!trimmed) return { skipped: true, reason: "empty" };

  const source: Record<string, string> = {
    kind: input.sourceKind,
    external_id: input.externalId.slice(0, 200),
  };
  if (input.title?.trim()) source.title = input.title.trim().slice(0, 200);
  if (input.label === "personal") source.label = "personal";

  const body: Record<string, unknown> = {
    source,
    text: trimmed.length > MAX_CHARS ? trimmed.slice(-MAX_CHARS) : trimmed,
  };
  if (input.indexOnly) {
    body.index_only = true;
    const projectId = process.env.PLUMB_PROJECT_ID?.trim();
    if (projectId) body.project_id = projectId;
  } else {
    body.project_id = requireEnv("PLUMB_PROJECT_ID");
  }

  const res = await fetch(`${plumbApiBase()}/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${watcherToken()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const detail =
      typeof json === "object" && json && "error" in json
        ? String((json as { error: unknown }).error)
        : text.slice(0, 300);
    throw new Error(`ingest HTTP ${res.status}: ${detail}`);
  }
  return json;
}
