#!/usr/bin/env node
/**
 * stop / sessionEnd backup: ingest under conversation_id from transcript or cache.
 * Always runs (not gated on PLUMB_CURSOR_STOP_INGEST). Throttled to 15 minutes
 * per conversation when only mid-session; always tries on completed/aborted end.
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";
import { hookLog } from "../../lib/hook-log.mjs";
import {
  cursorConversationId,
  labeledTurnsFromCursorTranscript,
  loadSessionSaveState,
  writeSessionSaveState,
  nativeTitle,
} from "../../lib/transcript.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const out = {};
const session = cursorConversationId(input);
const status = input.status || input.hook_event_name || "stop";

hookLog("stop", {
  event: "start",
  conversation_id: session || "(missing)",
  status: String(status),
  keys: Object.keys(input).sort().join(","),
});

const MIN_MS = 15 * 60 * 1000;

try {
  if (!session) {
    hookLog("stop", { event: "skip", reason: "no_conversation_id" });
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  let body = "";
  const tp =
    typeof input.transcript_path === "string" ? input.transcript_path : "";
  let transcriptPath = tp;
  if (!transcriptPath || !existsSync(transcriptPath)) {
    const cached = resolve(
      process.env.TMPDIR || "/tmp",
      "plumb-cursor/last-transcript-path.txt",
    );
    if (existsSync(cached)) transcriptPath = readFileSync(cached, "utf8").trim();
  }
  if (transcriptPath && existsSync(transcriptPath)) {
    const turns = labeledTurnsFromCursorTranscript(transcriptPath);
    if (turns.length) body = turns.join("\n\n");
  }
  if (!body.trim()) {
    const cacheFile = resolve(
      process.env.TMPDIR || "/tmp",
      "plumb-cursor/last-response.txt",
    );
    if (existsSync(cacheFile)) {
      const text = readFileSync(cacheFile, "utf8").trim();
      if (text) body = `Cursor:\n${text}`;
      try {
        unlinkSync(cacheFile);
      } catch {
        /* ignore */
      }
    }
  }

  if (!body.trim()) {
    hookLog("stop", {
      event: "skip",
      reason: "empty",
      conversation_id: session,
    });
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  const state = loadSessionSaveState(`cursor-${session}`);
  const now = Date.now();
  const isFinal =
    status === "completed" ||
    status === "aborted" ||
    status === "error" ||
    input.hook_event_name === "sessionEnd";
  if (!isFinal && state.lastSaveAt && now - state.lastSaveAt < MIN_MS) {
    hookLog("stop", {
      event: "skip",
      reason: "throttle",
      conversation_id: session,
    });
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  const token = process.env.PLUMB_TOKEN_CURSOR || process.env.PLUMB_INGEST_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CURSOR is not set");
  const title = nativeTitle(input);
  await ingestText({
    text: body,
    sourceKind: "cursor",
    externalId: session,
    ...(title ? { title } : {}),
    token,
  });
  writeSessionSaveState(`cursor-${session}`, {
    lastSaveAt: now,
    savedCount: (state.savedCount || 0) + 1,
  });
  hookLog("stop", {
    event: "ok",
    conversation_id: session,
    chars: String(body.length),
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  hookLog("stop", {
    event: "error",
    conversation_id: session || "(missing)",
    err: msg,
  });
  console.error("plumb stop:", msg);
}

process.stdout.write(JSON.stringify(out));
process.exit(0);
