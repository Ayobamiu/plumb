import type { EventKind, Source } from "@plumb/core";
import { plumbApiBase, watcherToken } from "./env.js";

export type RecordEventBody = {
  kind: EventKind;
  source: Omit<Source, "id">;
  occurred_at: string;
  from?: string;
  thread_id?: string;
  summary: string;
};

/** POST /tools/record_event on the remote MCP server. */
export async function recordEvent(body: RecordEventBody): Promise<unknown> {
  const res = await fetch(`${plumbApiBase()}/tools/record_event`, {
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
    const detail = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : text;
    throw new Error(`record_event HTTP ${res.status}: ${detail}`);
  }
  return json;
}
