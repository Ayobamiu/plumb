#!/usr/bin/env node
/**
 * Stop: send last_assistant_message text to /ingest (not a file path).
 * Always exit 0 so we never block stop / create a loop. Check stop_hook_active
 * and skip ingest on continuations.
 */
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

if (input.stop_hook_active) {
  process.exit(0);
}

const text =
  typeof input.last_assistant_message === "string"
    ? input.last_assistant_message
    : "";

try {
  if (!text.trim()) {
    console.error("plumb Stop: no last_assistant_message, skip");
    process.exit(0);
  }
  const token = process.env.PLUMB_TOKEN_CLAUDE_CODE || process.env.PLUMB_INGEST_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CLAUDE_CODE is not set");
  const session = input.session_id || "claude-code-session";
  await ingestText({
    text,
    sourceKind: "claude_code",
    externalId: String(session).slice(0, 120),
    title: "Claude Code turn",
    token,
  });
  console.error("plumb Stop: ingested");
} catch (err) {
  console.error("plumb Stop:", err instanceof Error ? err.message : err);
}
process.exit(0);
