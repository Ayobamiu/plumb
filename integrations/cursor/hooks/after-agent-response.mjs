#!/usr/bin/env node
/**
 * afterAgentResponse: send this conversation to /ingest under conversation_id.
 * One conversation_id = one @plumb:cursor:// entry. Never use a shared fallback id.
 * Prefer transcript_path (full labeled turns) when Cursor provides it.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";
import { hookLog } from "../../lib/hook-log.mjs";
import {
  cursorConversationId,
  labeledTurnsFromCursorTranscript,
  nativeTitle,
} from "../../lib/transcript.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const text = typeof input.text === "string" ? input.text : "";
const session = cursorConversationId(input);
const keys = Object.keys(input).sort().join(",");

hookLog("afterAgentResponse", {
  event: "start",
  conversation_id: session || "(missing)",
  cursor_version: input.cursor_version || "",
  has_text: text.trim() ? "1" : "0",
  transcript: input.transcript_path ? "1" : "0",
  keys,
});

const cacheDir = resolve(process.env.TMPDIR || "/tmp", "plumb-cursor");
mkdirSync(cacheDir, { recursive: true });
if (text.trim()) {
  writeFileSync(resolve(cacheDir, "last-response.txt"), text, "utf8");
}
if (session) {
  writeFileSync(resolve(cacheDir, "last-conversation-id.txt"), session, "utf8");
  if (input.transcript_path) {
    writeFileSync(
      resolve(cacheDir, "last-transcript-path.txt"),
      String(input.transcript_path),
      "utf8",
    );
  }
}

try {
  if (!session) {
    hookLog("afterAgentResponse", {
      event: "skip",
      reason: "no_conversation_id",
      keys,
    });
    process.exit(0);
  }

  let body = "";
  const tp =
    typeof input.transcript_path === "string" ? input.transcript_path : "";
  if (tp && existsSync(tp)) {
    const turns = labeledTurnsFromCursorTranscript(tp);
    if (turns.length) body = turns.join("\n\n");
  }
  if (!body.trim() && text.trim()) body = `Cursor:\n${text.trim()}`;
  if (!body.trim()) {
    hookLog("afterAgentResponse", {
      event: "skip",
      reason: "empty_text",
      conversation_id: session,
    });
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
  hookLog("afterAgentResponse", {
    event: "ok",
    conversation_id: session,
    chars: String(body.length),
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  hookLog("afterAgentResponse", {
    event: "error",
    conversation_id: session || "(missing)",
    err: msg,
  });
  console.error("plumb afterAgentResponse:", msg);
}
process.exit(0);
