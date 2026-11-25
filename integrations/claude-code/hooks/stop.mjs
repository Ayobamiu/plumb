#!/usr/bin/env node
/**
 * Stop: ask the in-session Claude (plan usage) to index this session in Plumb
 * via MCP record_event. No Muse, no Anthropic API.
 *
 * At most every 15 minutes when there are new labeled turns. When
 * stop_hook_active, allow stop (Claude already continued for our ask).
 * SessionEnd still runs a local no-model /ingest fallback.
 * Always exit 0.
 */
import { loadRootEnv } from "../../lib/plumb-env.mjs";
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

function allowStop() {
  process.exit(0);
}

function askIndex(sessionId) {
  const reason = [
    "Index this Claude Code session in Plumb before stopping.",
    "Use this conversation (your plan), not Muse and not a separate API.",
    `Call the Plumb tool record_event with:`,
    `- kind: "session_note"`,
    `- source: { kind: "claude_code", external_id: "${sessionId}", title: "<at most 60 chars naming the topic>" }`,
    `- occurred_at: current ISO time`,
    `- summary: 2 to 4 plain sentences on what this session covered, decided, or produced (words someone would search with later)`,
    `Set source.label to "personal" only if this is personal life (health, family, job search, etc.).`,
    "Then you may stop. Do not narrate the tool call.",
  ].join(" ");
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: reason,
      },
    }),
  );
  process.exit(0);
}

if (input.stop_hook_active) {
  allowStop();
}

try {
  const sessionId = String(input.session_id || "claude-code-session").slice(0, 120);
  const state = loadSessionSaveState(sessionId);
  const now = Date.now();
  if (state.lastSaveAt && now - state.lastSaveAt < INTERVAL_MS) {
    allowStop();
  }

  const turns = labeledTurnsFromTranscript(input.transcript_path);
  const fresh = turns.slice(state.savedCount);
  const text = fresh.join("\n\n").trim();
  if (!text) {
    allowStop();
  }

  // Mark that we asked, so SessionEnd / the next window know progress.
  // savedCount advances only after SessionEnd local ingest (or a later ask).
  writeSessionSaveState(sessionId, {
    lastSaveAt: now,
    savedCount: state.savedCount || 0,
    askedIndexAt: now,
  });
  askIndex(sessionId);
} catch (err) {
  console.error("plumb Stop:", err instanceof Error ? err.message : err);
  allowStop();
}
