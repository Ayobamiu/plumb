// Muse Code history: ~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl.
// An event log (record_type, payload_type, payload):
// - user text: runtime.user_intent.accepted, payload.model_messages[].content[] text.
// - assistant text: runtime.session, kind run, event assistant_message_committed, text.
// - working folder: session.workspace_branch.observed, record.workspace_root.
// Tool calls, reasoning and deltas are skipped: labeled turns only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type LocalSession, type SessionText, joinTurns } from "./types.js";

export const TOOL = "muse_code" as const;

function listSessionFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) listSessionFiles(p, out);
    else if (name === "session.jsonl") out.push(p);
  }
  return out;
}

export function listMuseSessions(sessionsRoot: string): LocalSession[] {
  return listSessionFiles(sessionsRoot)
    .map((file) => ({ tool: TOOL, externalId: basename(dirname(file)), file }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
}

interface MuseRow {
  payload_type?: unknown;
  payload?: {
    kind?: unknown;
    event?: { kind?: unknown; text?: unknown };
    model_messages?: { content?: { kind?: unknown; text?: unknown }[] }[];
    record?: { workspace_root?: unknown };
  };
}

export function readMuseSession(file: string): SessionText {
  const turns: string[] = [];
  let workdir: string | undefined;
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return { turns };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: MuseRow;
    try {
      row = JSON.parse(line) as MuseRow;
    } catch {
      continue;
    }
    const payload = row.payload;
    if (!payload || typeof payload !== "object") continue;
    if (row.payload_type === "runtime.user_intent.accepted") {
      for (const msg of payload.model_messages ?? []) {
        for (const c of msg?.content ?? []) {
          if ((c.kind === undefined || c.kind === "text") && typeof c.text === "string" && c.text.trim()) {
            turns.push(`Usman:\n${c.text.trim()}`);
          }
        }
      }
    } else if (
      row.payload_type === "runtime.session" &&
      payload.kind === "run" &&
      payload.event?.kind === "assistant_message_committed" &&
      typeof payload.event.text === "string" &&
      payload.event.text.trim()
    ) {
      turns.push(`Muse Code:\n${payload.event.text.trim()}`);
    } else if (row.payload_type === "session.workspace_branch.observed" && !workdir) {
      const root = payload.record?.workspace_root;
      if (typeof root === "string" && root.trim()) workdir = root.trim();
    }
  }
  return { turns, ...(workdir && { workdir }) };
}

export function museSessionText(file: string): string {
  return joinTurns(readMuseSession(file).turns);
}
