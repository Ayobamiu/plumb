#!/usr/bin/env node
/**
 * SessionStart: write PROJECT_STATE.md from state.markdown, then print it so
 * Claude Code adds it to context (stdout on SessionStart becomes context).
 */
import { loadRootEnv, repoRoot } from "../../lib/plumb-env.mjs";
import {
  formatProjectState,
  getProjectState,
  writeProjectStateFile,
} from "../../lib/ingest.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

try {
  const token = process.env.PLUMB_TOKEN_CLAUDE_CODE || process.env.PLUMB_MCP_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CLAUDE_CODE is not set");
  const state = await getProjectState(token);
  const dir = process.env.CLAUDE_PROJECT_DIR || repoRoot();
  try {
    writeProjectStateFile(state, dir);
  } catch (err) {
    console.error(
      "plumb SessionStart: could not write PROJECT_STATE.md:",
      err instanceof Error ? err.message : err,
    );
  }
  process.stdout.write(formatProjectState(state));
} catch (err) {
  process.stdout.write(
    `Plumb get_project_state failed: ${err instanceof Error ? err.message : err}`,
  );
}
process.exit(0);
