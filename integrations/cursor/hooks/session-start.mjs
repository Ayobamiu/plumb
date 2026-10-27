#!/usr/bin/env node
import { loadRootEnv } from "../../lib/plumb-env.mjs";
import { formatProjectState, getProjectState } from "../../lib/ingest.mjs";

loadRootEnv();

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
// input available if needed later
JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

const out = {};
try {
  const token = process.env.PLUMB_TOKEN_CURSOR || process.env.PLUMB_MCP_TOKEN;
  if (!token) throw new Error("PLUMB_TOKEN_CURSOR is not set");
  const state = await getProjectState(token);
  out.additional_context = formatProjectState(state);
} catch (err) {
  out.additional_context = `Plumb get_project_state failed: ${err instanceof Error ? err.message : err}`;
}

process.stdout.write(JSON.stringify(out));
process.exit(0);
