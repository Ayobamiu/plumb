#!/usr/bin/env node
/**
 * Backfill / sync Cursor agent transcripts into Plumb (index mode by default).
 * Cursor has no public "list all chats" API. Local Agent transcripts live under
 * ~/.cursor/projects/<slug>/agent-transcripts/<conversation_id>/*.jsonl
 *
 * Usage (from repo root):
 *   node integrations/cursor/sync-transcripts.mjs
 *   node integrations/cursor/sync-transcripts.mjs --project plumb
 *   node integrations/cursor/sync-transcripts.mjs --id 7c0a323d-...
 *   node integrations/cursor/sync-transcripts.mjs --full   # extract claims (costly)
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { loadRootEnv } from "../lib/plumb-env.mjs";
import { ingestText } from "../lib/ingest.mjs";
import { labeledTurnsFromCursorTranscript } from "../lib/transcript.mjs";
import { hookLog } from "../lib/hook-log.mjs";

loadRootEnv();

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const onlyId = flag("--id");
const projectFilter = (flag("--project") || "plumb").toLowerCase();
const dry = args.includes("--dry");
const indexOnly = !args.includes("--full");

const projectsRoot = resolve(homedir(), ".cursor/projects");
if (!existsSync(projectsRoot)) {
  console.error("No ~/.cursor/projects directory");
  process.exit(1);
}

function listJsonl(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "compaction" || name === "subagents") continue;
      listJsonl(p, out);
    } else if (name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

const token = process.env.PLUMB_TOKEN_CURSOR || process.env.PLUMB_INGEST_TOKEN;
if (!token && !dry) {
  console.error("PLUMB_TOKEN_CURSOR is not set");
  process.exit(1);
}

const projectDirs = readdirSync(projectsRoot)
  .map((n) => resolve(projectsRoot, n))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  })
  .filter((p) => basename(p).toLowerCase().includes(projectFilter));

const files = [];
for (const pd of projectDirs) {
  files.push(...listJsonl(resolve(pd, "agent-transcripts")));
}

let ok = 0;
let skip = 0;
let fail = 0;

for (const file of files) {
  const id = basename(file, ".jsonl");
  if (onlyId && id !== onlyId) continue;
  const turns = labeledTurnsFromCursorTranscript(file);
  if (!turns.length) {
    skip++;
    console.log("skip empty", id);
    continue;
  }
  const text = turns.join("\n\n");
  console.log(
    dry ? "dry" : indexOnly ? "index" : "ingest",
    id,
    `${turns.length} turns`,
    `${text.length} chars`,
    dirname(file),
  );
  if (dry) {
    skip++;
    continue;
  }
  try {
    await ingestText({
      text,
      sourceKind: "cursor",
      externalId: id.slice(0, 120),
      token,
      indexOnly,
    });
    hookLog("sync-transcripts", {
      event: "ok",
      mode: indexOnly ? "index" : "full",
      conversation_id: id,
      chars: String(text.length),
    });
    ok++;
  } catch (err) {
    fail++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("fail", id, msg);
    hookLog("sync-transcripts", {
      event: "error",
      conversation_id: id,
      err: msg,
    });
  }
}

console.log(
  JSON.stringify({ ok, skip, fail, scanned: files.length, mode: indexOnly ? "index" : "full" }),
);
process.exit(fail ? 1 : 0);
