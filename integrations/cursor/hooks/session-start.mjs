#!/usr/bin/env node
import { loadRootEnv, repoRoot } from "../../lib/plumb-env.mjs";
import {
  formatProjectState,
  getProjectState,
  writeProjectStateFile,
} from "../../lib/ingest.mjs";
import { hookLog } from "../../lib/hook-log.mjs";
import { cursorConversationId } from "../../lib/transcript.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const session = cursorConversationId(input);

hookLog("sessionStart", {
  event: "start",
  conversation_id: session || "(missing)",
  cursor_version: input.cursor_version || "",
  composer_mode: input.composer_mode || "",
  keys: Object.keys(input).sort().join(","),
});

const out = {};
try {
  const token = process.env.PLUMB_TOKEN_CURSOR || process.env.PLUMB_MCP_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CURSOR is not set");
  const state = await getProjectState(token);
  const dir = process.env.CURSOR_PROJECT_DIR || repoRoot();
  try {
    writeProjectStateFile(state, dir);
  } catch (err) {
    console.error(
      "plumb sessionStart: could not write PROJECT_STATE.md:",
      err instanceof Error ? err.message : err,
    );
  }
  out.additional_context = formatProjectState(state);
  hookLog("sessionStart", { event: "ok", conversation_id: session || "(missing)" });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  out.additional_context = `Plumb get_project_state failed: ${msg}`;
  hookLog("sessionStart", { event: "error", err: msg });
}

process.stdout.write(JSON.stringify(out));
process.exit(0);
