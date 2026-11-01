// Cursor Agent history: ~/.cursor/projects/<slug>/agent-transcripts/**/*.jsonl.
// Same layout rules as integrations/cursor/sync-transcripts.mjs (skip
// compaction and subagents; the jsonl basename is the conversation id), so the
// script can call this instead. Rows carry role plus message content parts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type LocalSession, type SessionText, joinTurns, textFromContent } from "./types.js";

export const TOOL = "cursor" as const;

const SKIP_DIRS = new Set(["compaction", "subagents"]);

function listJsonl(dir: string, out: string[] = []): string[] {
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
      if (SKIP_DIRS.has(name)) continue;
      listJsonl(p, out);
    } else if (name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

export function listCursorSessions(projectsRoot: string): LocalSession[] {
  if (!existsSync(projectsRoot)) return [];
  const out: LocalSession[] = [];
  for (const slug of readdirSync(projectsRoot)) {
    const dir = resolve(projectsRoot, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of listJsonl(resolve(dir, "agent-transcripts"))) {
      out.push({ tool: TOOL, externalId: basename(file, ".jsonl"), file, slug });
    }
  }
  return out.sort((a, b) => a.externalId.localeCompare(b.externalId));
}

interface CursorRow {
  role?: unknown;
  message?: { role?: unknown; content?: unknown };
  content?: unknown;
}

export function readCursorSession(file: string): SessionText {
  const turns: string[] = [];
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return { turns };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: CursorRow;
    try {
      row = JSON.parse(line) as CursorRow;
    } catch {
      continue;
    }
    const msg = row.message ?? row;
    const role = (row.role ?? (msg as CursorRow).role) as unknown;
    const text = textFromContent((msg as CursorRow).content ?? row.content);
    if (!text) continue;
    if (role === "user") turns.push(`Usman:\n${text}`);
    else if (role === "assistant") turns.push(`Cursor:\n${text}`);
  }
  return { turns };
}

export function cursorSessionText(file: string): string {
  return joinTurns(readCursorSession(file).turns);
}

/**
 * The slug encodes the workspace path with dashes for slashes
 * (Users-usmanayobami-Documents-plumb). Match when the decoded path ends with
 * the repo path's last two segments, so other checkouts of plumb match too.
 */
export function isPlumbSlug(slug: string, repoRoot: string): boolean {
  const segs = repoRoot.split("/").filter(Boolean).slice(-2).join("/");
  if (!segs) return false;
  const decoded = `/${slug.replace(/-/g, "/")}`;
  return decoded.endsWith(`/${segs}`);
}
