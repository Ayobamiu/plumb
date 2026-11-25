// Pull-first (Nov 24): keep every tool session findable with a cheap index
// (title + summary). Full Muse claim extraction is opt-in, not the default.
// Docs and Gmail stay on the full path (rare, and invalidation still helps there).
import type { z } from "zod";
import type { IngestInput } from "@plumb/core";

const SESSION_KINDS = new Set([
  "claude_code",
  "cursor",
  "claude_chat",
  "muse_code",
  "manual",
]);

/** True when this ingest should run index-only under pull-first defaults. */
export function shouldIndexOnly(
  input: z.infer<typeof IngestInput>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.index_only) return false; // already index; caller decided
  if (!SESSION_KINDS.has(input.source.kind)) return false;
  if (env.PLUMB_FULL_EXTRACT === "1") return false;
  const allow = (env.PLUMB_FULL_EXTRACT_PROJECTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (input.project_id && allow.includes(input.project_id)) return false;
  return true;
}

/** Sleep-time sweep (what changed) stays off unless explicitly enabled. */
export function sweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLUMB_ENABLE_SWEEP === "1";
}
