#!/usr/bin/env node
/**
 * Stop: mid-session save so a running Claude Code session can be @'d.
 * At most every 15 minutes per session_id; only turns since the last save.
 * Sends Usman + Claude Code labeled turns (not assistant-only). No generic title.
 * Always exit 0. Skip when stop_hook_active (continuation).
 */
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";
import {
  labeledTurnsFromTranscript,
  loadSessionSaveState,
  writeSessionSaveState,
} from "../../lib/transcript.mjs";

loadRootEnv();

const INTERVAL_MS = 15 * 60 * 1000;

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

if (input.stop_hook_active) {
  process.exit(0);
}

try {
  const sessionId = String(input.session_id || "claude-code-session").slice(0, 120);
  const state = loadSessionSaveState(sessionId);
  const now = Date.now();
  if (state.lastSaveAt && now - state.lastSaveAt < INTERVAL_MS) {
    process.exit(0);
  }

  const turns = labeledTurnsFromTranscript(input.transcript_path);
  const fresh = turns.slice(state.savedCount);
  const text = fresh.join("\n\n").trim().slice(0, 48_000);
  if (!text) {
    process.exit(0);
  }

  const token = process.env.PLUMB_TOKEN_CLAUDE_CODE || process.env.PLUMB_INGEST_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CLAUDE_CODE is not set");

  // Only advance savedCount after a 2xx ingest; on 503/etc the next Stop retries.
  await ingestText({
    text,
    sourceKind: "claude_code",
    externalId: sessionId,
    token,
  });
  writeSessionSaveState(sessionId, {
    lastSaveAt: now,
    savedCount: turns.length,
  });
  console.error(`plumb Stop: mid-session save (${fresh.length} new turn(s))`);
} catch (err) {
  console.error("plumb Stop:", err instanceof Error ? err.message : err);
}
process.exit(0);
