#!/usr/bin/env node
/**
 * Backup write-back if afterAgentResponse did not fire. Reads last response
 * text from a temp file (hooks only send data out; we never block the stop).
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { ingestText } from "../../lib/ingest.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

// Never auto-follow-up; avoid stop loops.
const out = {};

try {
  if (input.status && input.status !== "completed") {
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  const cacheFile = resolve(process.env.TMPDIR || "/tmp", "plumb-cursor/last-response.txt");
  if (!existsSync(cacheFile)) {
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  const text = readFileSync(cacheFile, "utf8");
  unlinkSync(cacheFile);
  // afterAgentResponse usually already ingested; only use stop if marked pending.
  if (process.env.PLUMB_CURSOR_STOP_INGEST === "1" && text.trim()) {
    const token = process.env.PLUMB_TOKEN_CURSOR || process.env.PLUMB_INGEST_TOKEN;
    if (!token) throw new Error("PLUMB_TOKEN_CURSOR is not set");
    await ingestText({
      text,
      sourceKind: "cursor",
      externalId: `cursor-stop-${Date.now()}`,
      title: "Cursor stop backup",
      token,
    });
    console.error("plumb stop: ingested backup");
  }
} catch (err) {
  console.error("plumb stop:", err instanceof Error ? err.message : err);
}

process.stdout.write(JSON.stringify(out));
process.exit(0);
