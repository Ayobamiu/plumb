#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const text = typeof input.text === "string" ? input.text : "";

const cacheDir = resolve(process.env.TMPDIR || "/tmp", "plumb-cursor");
mkdirSync(cacheDir, { recursive: true });
const cacheFile = resolve(cacheDir, "last-response.txt");
if (text.trim()) writeFileSync(cacheFile, text, "utf8");

try {
  if (!text.trim()) {
    console.error("plumb afterAgentResponse: empty text, skip");
    process.exit(0);
  }
  const token = process.env.PLUMB_TOKEN_CURSOR || process.env.PLUMB_INGEST_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CURSOR is not set");
  const session = input.conversation_id || input.session_id || "cursor-session";
  await ingestText({
    text,
    sourceKind: "cursor",
    externalId: String(session).slice(0, 120),
    title: "Cursor agent response",
    token,
  });
  console.error("plumb afterAgentResponse: ingested");
} catch (err) {
  console.error("plumb afterAgentResponse:", err instanceof Error ? err.message : err);
}
process.exit(0);
