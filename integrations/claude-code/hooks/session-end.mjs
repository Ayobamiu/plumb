#!/usr/bin/env node
/**
 * SessionEnd: observational only. Prefer Stop for write-back (has
 * last_assistant_message). If PLUMB_CLAUDE_SESSION_END_INGEST=1 and a
 * transcript_path is present, read recent assistant text from the JSONL and
 * POST that text (never send the path to the server).
 */
import { readFileSync, existsSync } from "node:fs";
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

if (process.env.PLUMB_CLAUDE_SESSION_END_INGEST !== "1") {
  process.exit(0);
}

try {
  const path = input.transcript_path;
  if (!path || !existsSync(path)) process.exit(0);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const texts = [];
  for (const line of lines.slice(-80)) {
    try {
      const row = JSON.parse(line);
      const msg = row.message ?? row;
      if (msg?.role === "assistant" && typeof msg.content === "string") {
        texts.push(msg.content);
      } else if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === "text" && part.text) texts.push(part.text);
        }
      }
    } catch {
      /* skip bad line */
    }
  }
  const text = texts.slice(-3).join("\n\n").trim();
  if (!text) process.exit(0);
  const token = process.env.PLUMB_TOKEN_CLAUDE_CODE || process.env.PLUMB_INGEST_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CLAUDE_CODE is not set");
  await ingestText({
    text,
    sourceKind: "claude_code",
    externalId: String(input.session_id || "claude-session-end").slice(0, 120),
    title: "Claude Code session end",
    token,
  });
  console.error("plumb SessionEnd: ingested");
} catch (err) {
  console.error("plumb SessionEnd:", err instanceof Error ? err.message : err);
}
process.exit(0);
