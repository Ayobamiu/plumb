#!/usr/bin/env node
/**
 * SessionEnd: final ingest for a Claude Code session.
 * Only turns since the last mid-session Stop save (same session id).
 * Usman + Claude Code labeled turns. No generic title. Always exit 0.
 */
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";
import {
  labeledTurnsFromTranscript,
  loadSessionSaveState,
  writeSessionSaveState,
} from "../../lib/transcript.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

try {
  const sessionId = String(input.session_id || "claude-session-end").slice(0, 120);
  const state = loadSessionSaveState(sessionId);
  const turns = labeledTurnsFromTranscript(input.transcript_path);
  const fresh = turns.slice(state.savedCount);
  const text = fresh.join("\n\n").trim().slice(0, 48_000);
  if (!text) {
    console.error("plumb SessionEnd: nothing new since last save, skip");
    process.exit(0);
  }
  const token = process.env.PLUMB_TOKEN_CLAUDE_CODE || process.env.PLUMB_INGEST_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CLAUDE_CODE is not set");
  // Only advance after 2xx; failed SessionEnd leaves state so a later save can retry.
  await ingestText({
    text,
    sourceKind: "claude_code",
    externalId: sessionId,
    token,
  });
  writeSessionSaveState(sessionId, {
    lastSaveAt: Date.now(),
    savedCount: turns.length,
  });
  console.error(`plumb SessionEnd: ingested (${fresh.length} turn(s))`);
} catch (err) {
  console.error("plumb SessionEnd:", err instanceof Error ? err.message : err);
}
process.exit(0);
