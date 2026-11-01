/**
 * Sleep-time sweep: POST /sweep on the MCP server every few hours.
 * The server owns Meta + Supabase; this worker only schedules the call.
 */
import { plumbApiBase, watcherToken } from "./lib/env.js";

const INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

async function runOnce(): Promise<void> {
  const res = await fetch(`${plumbApiBase()}/sweep`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${watcherToken()}`,
    },
    body: "{}",
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
        : text;
    throw new Error(`sweep HTTP ${res.status}: ${detail}`);
  }
  const r = json as {
    rechecked?: number;
    events?: number;
    transitions?: unknown[];
    links?: number;
  };
  console.log(
    `sweep: rechecked=${r.rechecked ?? "?"} events=${r.events ?? "?"} ` +
      `REVIEW=${r.transitions?.length ?? "?"} links=${r.links ?? "?"}`,
  );
}

export async function startSweep(): Promise<void> {
  console.log(`sleep-time sweep every ${INTERVAL_MS / 3600_000}h`);
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      console.error("sweep failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}
