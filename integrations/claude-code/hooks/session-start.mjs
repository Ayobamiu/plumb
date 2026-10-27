#!/usr/bin/env node
/**
 * SessionStart: print get_project_state as plain text so Claude Code adds it
 * to context (stdout on SessionStart becomes context).
 */
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { formatProjectState, getProjectState } from "../../lib/ingest.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

try {
  const token = process.env.PLUMB_TOKEN_CLAUDE_CODE || process.env.PLUMB_MCP_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CLAUDE_CODE is not set");
  const state = await getProjectState(token);
  process.stdout.write(formatProjectState(state));
} catch (err) {
  process.stdout.write(
    `Plumb get_project_state failed: ${err instanceof Error ? err.message : err}`,
  );
}
process.exit(0);
